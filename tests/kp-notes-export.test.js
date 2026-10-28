/**
 * kp-notes-export 的单测：只验纯函数与「落盘/清理」这两层，不启动任何服务。
 *
 * 重点钉住四件事：
 *   1. 目录与文件名符合 dsh-kp-notes 的约定（章目录带数字前缀、文件名带序号、frontmatter type: point）；
 *   2. 题目按 knowledgeNames 或节点 evidence 配对到同一门课的知识点，没配上的不硬塞；
 *   3. 重跑幂等（第二次写入 0 个文件）；
 *   4. 清理只删自己 manifest 里登记过的文件，用户自己放的文件不碰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MASTERY_LABELS,
  applyExport,
  diffExport,
  planExport,
  renderNoteFile,
  renderQuestionBlock,
} from '../lib/kp-notes-export.js';

const network = {
  version: 1,
  nodes: [
    { id: 'k1', name: '基尔霍夫定律', courseId: 'c_dg', chapter: '第 1 章', section: '1.1', mastery: 3, marked: true, reviewedAt: '2026-10-20T12:00:00.000Z', note: '电流守恒与电压守恒。', evidence: [{ type: 'ocr', file: '数电/作业/第01次_OCR文本/tier-gemini-page02.md', page: 2, quote: '节点电流代数和为零' }] },
    { id: 'k2', name: '节点电压法', courseId: 'c_dg', chapter: '第 2 章', section: '2.3', mastery: 1, marked: false, evidence: [{ type: 'question', id: 'q1' }] },
    { id: 'k3', name: '戴维南等效', courseId: 'c_dg', chapter: '第 2 章', section: '2.1', mastery: 0, marked: false, evidence: [] },
    { id: 'k4', name: '没分章的知识点', courseId: null, chapter: '', section: '', mastery: 0, marked: false, evidence: [] },
  ],
  edges: [],
};

const questions = {
  questions: [
    { id: 'q1', no: '3', prompt: '用节点电压法求图示电路的节点电压。', courseId: 'c_dg', sourceFile: '数电/作业/第02次作业_原题.pdf', page: 4, knowledgeNames: ['节点电压法'] },
    { id: 'q2', no: '4', prompt: '这道题点的是别的知识点。', courseId: 'c_dg', sourceFile: 'x.pdf', page: 1, knowledgeNames: ['叠加定理'] },
    { id: 'q3', no: '5', prompt: '跨课程同名知识点，不能配过去。', courseId: 'c_ph', sourceFile: 'y.pdf', page: 2, knowledgeNames: ['节点电压法'] },
  ],
};

const courses = { courses: [{ id: 'c_dg', name: '数字电子技术基础', aliases: ['数电'] }, { id: 'c_ph', name: '物理', aliases: [] }] };

const makePlan = () => planExport({ network, questions, courses, sourceLine: '知识点网络 2026-10-20 12:16' });

test('导出计划：章目录按课程+章排，笔记文件名带序号且 frontmatter 声明 type: point', () => {
  const plan = makePlan();
  const rels = Object.keys(plan.files);
  assert.ok(rels.includes('notes/01-数电-第 1 章/01-基尔霍夫定律.md'), `章目录名不符：${rels.join(' | ')}`);
  assert.ok(rels.includes('notes/02-数电-第 2 章/01-戴维南等效.md'));
  assert.ok(rels.includes('notes/02-数电-第 2 章/02-节点电压法.md'), '章内按 section 排序（2.1 在 2.3 前）');
  assert.ok(rels.includes('notes/03-未匹配课程-未分章/01-没分章的知识点.md'), '没有 courseId/章 的节点也要落盘，不能丢');

  const note = plan.files['notes/01-数电-第 1 章/01-基尔霍夫定律.md'];
  assert.match(note, /^---\ntitle: 基尔霍夫定律\ntype: point\n/);
  assert.match(note, /tags: \[数电, 第 1 章, 重点\]/);
  assert.match(note, /## 掌握度\n\n精通（3\/3） · 已标重点 · 最近复习 2026-10-20 12:00/);
  assert.match(note, /## 证据\n\n- 数电\/作业\/第01次_OCR文本\/tier-gemini-page02\.md 第 2 页：「节点电流代数和为零」/);
  assert.ok(note.includes('电流守恒与电压守恒。'), 'note 字段要进正文');
  assert.equal(MASTERY_LABELS.length, 4);
});

test('题目配对：只认同课同名的 knowledgeNames，跨课程与无关题不硬塞', () => {
  const plan = makePlan();
  const questionRel = 'questions/02-数电-第 2 章/02-节点电压法.md';
  assert.ok(Object.keys(plan.files).includes(questionRel), '有配对题目时应生成题目文件');
  const file = plan.files[questionRel];
  assert.match(file, /## 题目 1/);
  assert.ok(file.includes('用节点电压法求图示电路的节点电压。'), '题干要进题目块');
  assert.match(file, /\*\*答案\*\*：/);
  assert.match(file, /\*\*解析\*\*：来源 数电\/作业\/第02次作业_原题\.pdf · 第 4 页/);
  assert.ok(!file.includes('这道题点的是别的知识点'), '无关题目不应出现');
  assert.ok(!file.includes('跨课程同名知识点'), '别的课程的题不应串进来');

  // 没有题目配到的知识点不生成空的题目文件
  assert.ok(!Object.keys(plan.files).includes('questions/02-数电-第 2 章/01-戴维南等效.md'));
  assert.equal(plan.summary.questions, 1);
  assert.equal(plan.summary.skippedQuestions, 2);
});

test('题目配对：knowledgeNames 为空时按节点 evidence 里的题号配对（织网写的证据）', () => {
  // 真实数据就是这样：分题工具把 knowledgeNames 留成候选，织网把「候选点名过的题」写成节点证据。
  const net = {
    version: 1,
    nodes: [
      { id: 'k9', name: '卡诺图', courseId: 'c_dg', chapter: '第 2 章', section: '', mastery: 0, marked: false, evidence: [{ type: 'question', id: 'q3' }] },
    ],
    edges: [],
  };
  const qs = {
    questions: [
      { id: 'q3', no: '2.16', prompt: '用卡诺图化简下列函数。', courseId: 'c_dg', sourceFile: '数电/作业/第03次作业_原题.pdf', page: 5, knowledgeNames: [] },
      { id: 'q4', no: '2.17', prompt: '这道题没被任何节点点名。', courseId: 'c_dg', sourceFile: 'x.pdf', page: 6, knowledgeNames: [] },
    ],
  };
  const plan = planExport({ network: net, questions: qs, courses });
  const rel = 'questions/01-数电-第 2 章/01-卡诺图.md';
  assert.ok(Object.keys(plan.files).includes(rel), `证据配对应生成题目文件：${Object.keys(plan.files).join(' | ')}`);
  assert.ok(plan.files[rel].includes('用卡诺图化简下列函数。'));
  assert.equal(plan.summary.questions, 1, '只有被证据点到的题才配');
  assert.equal(plan.summary.skippedQuestions, 1);

  // 证据与 knowledgeNames 同时命中时只算一次
  const both = planExport({ network: net, questions: { questions: [{ ...qs.questions[0], knowledgeNames: ['卡诺图'] }] }, courses });
  assert.equal(both.summary.questions, 1);

  // 跨课程的题即使 id 被点到也不挂
  const otherCourse = planExport({ network: net, questions: { questions: [{ ...qs.questions[0], courseId: 'c_other' }] }, courses });
  assert.equal(otherCourse.summary.questions, 0);
});

test('落盘：重跑幂等，清理只删 manifest 登记过的文件', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-notes-export-'));
  try {
    const first = applyExport(outDir, makePlan());
    assert.ok(first.written.length > 0, '第一次必须写文件');
    assert.ok(fs.existsSync(path.join(outDir, 'notes/01-数电-第 1 章/01-基尔霍夫定律.md')));
    assert.ok(fs.existsSync(path.join(outDir, '_manifest.json')));

    const second = applyExport(outDir, makePlan());
    assert.equal(second.written.filter((rel) => rel !== '_manifest.json').length, 0, '内容没变时不该重写笔记');
    assert.equal(diffExport(outDir, makePlan()).length, 0, '重跑后不应有差异');

    // 用户自己放的文件：既不该被清，也不该进 manifest
    const userFile = path.join(outDir, 'notes/01-数电-第 1 章/我的批注.md');
    fs.writeFileSync(userFile, '# 我自己写的\n', 'utf8');

    // 网络里删掉一个节点 → 它那对文件应被清掉，用户文件保留
    const shrunk = {
      ...network,
      nodes: network.nodes.filter((node) => node.id !== 'k1'),
    };
    const plan = planExport({ network: shrunk, questions, courses });
    const third = applyExport(outDir, plan);
    assert.ok(third.removed.includes('notes/01-数电-第 1 章/01-基尔霍夫定律.md'), '陈旧笔记应被清掉');
    assert.ok(!fs.existsSync(path.join(outDir, 'notes/01-数电-第 1 章/01-基尔霍夫定律.md')));
    assert.ok(fs.existsSync(userFile), '用户自己的文件不能删');
    assert.ok(fs.existsSync(path.join(outDir, 'notes/01-数电-第 1 章/我的批注.md')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('题目块渲染：选项/答案/解析按 kp-notes 的约定输出', () => {
  const block = renderQuestionBlock({
    prompt: '放大电路的主要作用是什么？',
    options: [{ key: 'a', text: '放大信号' }, { key: '', text: '缺 key 应跳过' }],
    answerKey: 'A',
    sourceFile: '数电/作业/第03次作业_原题.pdf',
    page: 2,
  }, 2);
  assert.match(block, /^## 题目 2\n/);
  assert.match(block, /\nA\. 放大信号\n/);
  assert.ok(!block.includes('缺 key 应跳过'));
  assert.match(block, /\*\*答案\*\*：A/);
  assert.match(block, /\*\*解析\*\*：来源 数电\/作业\/第03次作业_原题\.pdf · 第 2 页/);
});

test('笔记渲染：空 note / 无证据 / 未知掌握度都不崩', () => {
  const text = renderNoteFile({ name: '边界: 带冒号的名字', mastery: 99, evidence: null }, { courseName: '数电', order: 1, sourceLine: 'x' });
  assert.match(text, /title: "边界: 带冒号的名字"/, '含冒号的标题要加引号');
  assert.ok(text.includes('未学（0/3）'), '越界掌握度收敛到 0 档');
  assert.ok(!text.includes('## 证据'), '没有证据时不出现空小节');
  assert.ok(!text.includes('undefined'));
});
