/**
 * knowledge-audit 工具测试（零依赖）
 * 运行：node tests/knowledge-audit.test.js
 *
 * 覆盖「挂不上」的每种走法：课程没大纲、章名对不上、节号对不上、小节号对不上、
 * 证据题缺失、id 重复，以及干净数据一条问题都不报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { auditKnowledge, buildOutlineIndex, chapterNo, normalizeNo } from '../tools/knowledge-audit.mjs';

const OUTLINE = {
  version: 1,
  courses: [
    {
      courseId: 'c_ds',
      name: '数据结构',
      book: '数据结构（C++语言版）第3版',
      chapters: [
        {
          no: 2,
          title: '向量',
          sections: [
            { no: '2.4', title: '无序向量', subs: [] },
            { no: '2.6', title: '有序向量', subs: [{ no: '2.6.5', title: '二分查找' }] },
          ],
        },
      ],
    },
  ],
};

const QUESTIONS = [{ id: 'q1', prompt: '题 1' }];

test('normalizeNo / chapterNo：编号写法归一', () => {
  assert.equal(normalizeNo(' §2.4 '), '2.4');
  assert.equal(normalizeNo('２.６'), '2.6', '全角数字要转半角');
  assert.equal(normalizeNo(null), '');
  assert.equal(chapterNo('第 2 章 向量'), 2);
  assert.equal(chapterNo('第2章'), 2);
  assert.equal(chapterNo('2 向量'), 2);
  assert.equal(chapterNo('2.6 有序向量'), null, '节号不能被当成章号');
  assert.equal(chapterNo(''), null);
});

test('buildOutlineIndex：按课程和章号建表', () => {
  const index = buildOutlineIndex(OUTLINE);
  assert.equal(index.size, 1);
  const chapters = index.get('c_ds').chapters;
  assert.equal(chapters.size, 1);
  assert.equal(chapters.get(2).sections.size, 2);
  assert.ok(chapters.get(2).sections.get('2.6').subs.has('2.6.5'));
  assert.equal(buildOutlineIndex(null).size, 0);
});

test('auditKnowledge：干净数据不报问题', () => {
  const result = auditKnowledge({
    network: {
      nodes: [
        { id: 'n1', name: '二分查找', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.6', subsection: '2.6.5', evidence: [{ type: 'question', id: 'q1' }] },
        { id: 'n2', name: '无序向量', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.4', evidence: [{ type: 'question', id: 'q1' }] },
      ],
    },
    outline: OUTLINE,
    questions: QUESTIONS,
    courses: [{ id: 'c_ds', name: '数据结构' }],
  });
  assert.equal(result.issues.length, 0, `不该有问题：${JSON.stringify(result.issues)}`);
  assert.equal(result.nodes, 2);
  assert.equal(result.counts.error + result.counts.warn + result.counts.info, 0);
  const course = result.courses[0];
  assert.equal(course.name, '数据结构');
  assert.equal(course.total, 2);
  assert.equal(course.mounted, 2);
  assert.equal(course.unmounted, 0);
  assert.equal(course.chapters.length, 1);
  assert.equal(course.chapters[0].mounted, 2);
});

test('auditKnowledge：章名/节号/小节号对不上各报一条，未挂节算 info 不计问题', () => {
  const result = auditKnowledge({
    network: {
      nodes: [
        { id: 'n1', name: '章错', courseId: 'c_ds', chapter: '第 9 章 消失的章', section: '9.1', evidence: [{ type: 'question', id: 'q1' }] },
        { id: 'n2', name: '节错', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.9', evidence: [{ type: 'question', id: 'q1' }] },
        { id: 'n3', name: '小节错', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.6', subsection: '2.6.9', evidence: [{ type: 'question', id: 'q1' }] },
        { id: 'n4', name: '还没挂', courseId: 'c_ds', chapter: '第 2 章 向量', section: '', evidence: [{ type: 'question', id: 'q1' }] },
      ],
    },
    outline: OUTLINE,
    questions: QUESTIONS,
    courses: [{ id: 'c_ds', name: '数据结构' }],
  });
  const types = result.issues.map((issue) => issue.type);
  assert.ok(types.includes('chapter-not-in-outline'), '章名对不上要报');
  assert.ok(types.includes('section-not-in-chapter'), '节号对不上要报');
  assert.ok(types.includes('subsection-not-in-section'), '小节号对不上要报');
  const chapterIssue = result.issues.find((issue) => issue.type === 'chapter-not-in-outline');
  assert.equal(chapterIssue.level, 'warn');
  assert.equal(chapterIssue.courseId, 'c_ds', '问题要能按课程过滤');
  assert.equal(result.courses[0].unmounted, 1, 'section 空的算未挂节');
  assert.equal(result.courses[0].mounted, 3);
});

test('auditKnowledge：没有大纲的课程整门报 unknown-course，且不误判章', () => {
  const result = auditKnowledge({
    network: { nodes: [{ id: 'p1', name: '高斯定理', courseId: 'c_phy', chapter: '第 12 章 静电场', section: '12.1', evidence: [{ type: 'question', id: 'q1' }] }] },
    outline: OUTLINE,
    questions: QUESTIONS,
    courses: [{ id: 'c_phy', name: '大学物理B(2)' }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, 'unknown-course');
  assert.equal(result.issues[0].level, 'info');
  assert.equal(result.courses[0].name, '大学物理B(2)');
});

test('auditKnowledge：证据题缺失、无证据、id 重复都报', () => {
  const result = auditKnowledge({
    network: {
      nodes: [
        { id: 'n1', name: '缺题', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.4', evidence: [{ type: 'question', id: 'q404' }] },
        { id: 'n2', name: '没证据', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.4', evidence: [] },
        { id: 'n1', name: '重复 id', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.4', evidence: [{ type: 'question', id: 'q1' }] },
      ],
    },
    outline: OUTLINE,
    questions: QUESTIONS,
    courses: [{ id: 'c_ds', name: '数据结构' }],
  });
  const types = result.issues.map((issue) => issue.type);
  assert.ok(types.includes('missing-question'));
  assert.ok(types.includes('no-evidence'));
  assert.ok(types.includes('duplicate-node-id'));
  assert.equal(result.counts.error, 1, '只有重复 id 是 error');
  // error 排最前
  assert.equal(result.issues[0].level, 'error');
});

test('auditKnowledge：空输入不崩', () => {
  const result = auditKnowledge({});
  assert.equal(result.nodes, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.courses.length, 0);
  assert.equal(JSON.stringify(auditKnowledge({ network: { nodes: null } }).issues), '[]');
});
