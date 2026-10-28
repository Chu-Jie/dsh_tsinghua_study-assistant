// `tools/knowledge-outline.mjs` 的纯函数测试：目录文本 → 章/节/小节骨架。
// 只测解析与组装，不碰磁盘（--apply 的写盘由 store.writeDocument 的既有测试覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutline,
  outlineCounts,
  buildOutlineDoc,
  mergeCourse,
} from '../tools/knowledge-outline.mjs';

// 取自《数据结构（C++语言版）》第 3 版目录页的真实片段（含引导点、全角点、跨行缺口）
const BRIEF = [
  '第 1 章 绪论 1',
  '§1.1 计算机与算法 2',
  '§1.2 复杂度 8',
  '第 2 章 向量 20',
  '§2.5 无序向量 22',
  '§2.6 有序向量 26',
  '第 3 章 列表 60',
  '§3.1 从头说起 60',
];

const DETAIL = [
  '第 2 章 向量 20',
  '§2.4 位图 22',
  '2.4.1 结构 22',
  '2.4.2 实现 23',
  '§2.5 无序向量 22',
  '2.5.7 去重 25',
  '§2.6 有序向量 26',
  '2.6.3 去重 27',
  '2.6.5 二分查找 29',
  '§2.7 排序器 30',
  // 解析不出来的行（标题跨行、无页码）应当被跳过而不是猜
  '2.7.1 统一入口',
  '2.7.2 起泡排序 31',
];

test('parseOutline：简要目录给章与节，详细目录补小节', () => {
  const chapters = parseOutline({ brief: BRIEF, detail: DETAIL });
  assert.deepEqual(chapters.map((item) => item.no), [1, 2, 3]);
  assert.equal(chapters[0].title, '绪论');
  assert.equal(chapters[0].page, 1);

  const vec = chapters[1];
  assert.deepEqual(vec.sections.map((item) => item.no), ['2.4', '2.5', '2.6', '2.7']);
  const dedup = vec.sections.find((item) => item.no === '2.5');
  assert.deepEqual(dedup.subs.map((item) => item.no), ['2.5.7']);
  assert.equal(dedup.subs[0].title, '去重');
  assert.equal(dedup.subs[0].page, 25);

  const sorted = vec.sections.find((item) => item.no === '2.6');
  assert.deepEqual(sorted.subs.map((item) => item.no), ['2.6.3', '2.6.5']);

  // 只有「节」没有小节的章/节：subs 是空数组，不伪造
  const list = chapters[2];
  assert.equal(list.sections[0].no, '3.1');
  assert.deepEqual(list.sections[0].subs, []);
});

test('parseOutline：引导点/下划线先折成空格，否则整段章丢失', () => {
  const weird = ['第 8 章 高级搜索树_____204', '§8.1 伸展树..........205', '8.1.1 局部性 205'];
  const chapters = parseOutline({ brief: weird, detail: ['8.1.1 局部性 205'] });
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].no, 8);
  assert.equal(chapters[0].title, '高级搜索树');
  assert.equal(chapters[0].sections[0].no, '8.1');
  assert.deepEqual(chapters[0].sections[0].subs.map((item) => item.no), ['8.1.1']);
});

test('parseOutline：详细目录先出现、简要目录后出现时也不打乱章序', () => {
  const chapters = parseOutline({
    brief: ['第 1 章 绪论 1', '第 2 章 向量 20'],
    detail: ['第 2 章 向量 20', '§2.1 接口 20', '第 1 章 绪论 1', '§1.1 计算机与算法 2'],
  });
  assert.deepEqual(chapters.map((item) => item.no), [1, 2]);
  assert.deepEqual(chapters[1].sections.map((item) => item.no), ['2.1']);
});

test('parseOutline：空输入与乱文本不崩、不产出假章', () => {
  assert.deepEqual(parseOutline({ brief: [], detail: [] }), []);
  assert.deepEqual(parseOutline({}), []);
  assert.deepEqual(parseOutline({ brief: ['目录', '……', '第 1 章 绪论 1'], detail: ['随便一行'] }).length, 1);
});

test('outlineCounts / buildOutlineDoc：统计与落盘形状', () => {
  const chapters = parseOutline({ brief: BRIEF, detail: DETAIL });
  const counts = outlineCounts(chapters);
  assert.deepEqual(counts, { chapters: 3, sections: 7, subs: 6 });

  const doc = buildOutlineDoc(chapters, { pages: ['page0015.md'] });
  assert.equal(doc.version, 1);
  assert.equal(doc.courses.length, 1);
  assert.equal(doc.courses[0].courseId, 'c_ds');
  assert.equal(doc.courses[0].chapters.length, 3);
  assert.deepEqual(doc.sources[0].pages, ['page0015.md']);

  assert.deepEqual(outlineCounts([]), { chapters: 0, sections: 0, subs: 0 });
  assert.deepEqual(outlineCounts(null), { chapters: 0, sections: 0, subs: 0 });
});

test('mergeCourse：加新课不冲掉已存在的课，同 courseId 原位覆盖', () => {  const ds = { courseId: 'c_ds', name: '数据结构', book: '数据结构（C++语言版）第3版', chapters: [{ no: 1, title: '绪论', page: 1, sections: [] }] };
  const sourceDs = { courseId: 'c_ds', book: '数据结构（C++语言版）第3版', pages: ['page0015.md'] };
  const first = mergeCourse(null, ds, sourceDs);
  assert.equal(first.version, 1);
  assert.deepEqual(first.courses.map((item) => item.courseId), ['c_ds']);
  assert.deepEqual(first.sources.map((item) => item.courseId), ['c_ds']);

  // 空文档、坏文档都当空处理，不崩
  assert.deepEqual(mergeCourse(undefined, ds).courses.map((item) => item.courseId), ['c_ds']);
  assert.deepEqual(mergeCourse({ courses: 'nope', sources: null }, ds).courses.length, 1);

  // 追加另一门课：数据结构那门还在，顺序不变
  const digital = { courseId: 'c_digital', name: '数电', book: '数字电子技术', chapters: [{ no: 1, title: '数制与编码', page: 1, sections: [] }] };
  const two = mergeCourse(first, digital, { courseId: 'c_digital', book: '数字电子技术', pages: ['L02'] });
  assert.deepEqual(two.courses.map((item) => item.courseId), ['c_ds', 'c_digital']);
  assert.deepEqual(two.sources.map((item) => item.courseId), ['c_ds', 'c_digital']);
  assert.equal(two.courses[0].chapters[0].title, '绪论');

  // 再写一次 c_ds：原位替换（不搬家、不重复）、sources 同 courseId 只留一条且换成新的
  const renamed = { ...ds, name: '数据结构（改名）' };
  const three = mergeCourse(two, renamed, { courseId: 'c_ds', book: '数据结构（C++语言版）第3版', pages: ['page0015.md', 'page0016.md'] });
  assert.deepEqual(three.courses.map((item) => item.courseId), ['c_ds', 'c_digital']);
  assert.equal(three.courses[0].name, '数据结构（改名）');
  assert.equal(three.sources.length, 2);
  assert.deepEqual(three.sources.find((item) => item.courseId === 'c_ds').pages, ['page0015.md', 'page0016.md']);

  // 不传 source：沿用旧来源，不产生空条目
  const four = mergeCourse(two, renamed);
  assert.equal(four.sources.length, 2);
  assert.deepEqual(four.sources.find((item) => item.courseId === 'c_ds').pages, ['page0015.md']);

  // 旧文档里同一个课重复留了两条 sources：合并后只留一条
  const dup = { version: 1, courses: [two.courses[0]], sources: [sourceDs, sourceDs] };
  assert.equal(mergeCourse(dup, ds, sourceDs).sources.length, 1);
});

// 离散数学第 2 版目录是「两栏 + 全角省略号引导点 + 标题跨行」，2026-10-22 为接这门课扩了扫描器。
const DISC_TOC = [
  '# 第 8 页\n\n目 录\n\n第 1 章 命题逻辑的基本概念 …………………… 3        3.2 自然推理系统 $P$ …………………… 50',
  '    1.1 命题与联结词 ………………………… 3        3.3 消解证明法 …………………………… 56\n    1.2 命题公式及其赋值 ………………………… 9',
  '第 14 章 图的基本概念 ………………… 293        14.5 图的运算 ………………………… 311\n    14.1 图 ………………………………… 293',
  '15.3 最短路问题、中国邮递员问题与货郎\n     担问题 …………………………………………… 323',
  '第 18 章  支配集、覆盖集、独立集、\n匹配与着色 ………………………………… 356\n 18.1 支配集、点覆盖集与点独立集 ………………… 356',
];

test('parseOutline：两栏目录一行两条都要收，全角省略号引导点也算', () => {
  const chapters = parseOutline({ brief: DISC_TOC });
  // 第 3 章的节来自右栏、章标题不在样本里 ⇒ 建出空壳章后按章号补齐「第3章」
  assert.deepEqual(chapters.map((item) => item.no), [1, 3, 14, 15, 18]);
  assert.equal(chapters[0].title, '命题逻辑的基本概念');
  assert.equal(chapters[0].page, 3);
  // 一行右栏的 3.2 / 14.5 不能丢
  assert.deepEqual(chapters[0].sections.map((item) => item.no), ['1.1', '1.2']);
  assert.deepEqual(chapters[1].sections.map((item) => item.no), ['3.2', '3.3']);
  assert.deepEqual(chapters[2].sections.map((item) => item.no), ['14.1', '14.5']);
});

test('parseOutline：标题跨行时接上续行的页码，中文之间不插空格', () => {
  const chapters = parseOutline({ brief: DISC_TOC });
  const ch15 = chapters.find((item) => item.no === 15);
  // 15.3 是跨页行裁出来的半截标题，续行「担问题 … 323」要接回去
  assert.equal(ch15.sections[0].title, '最短路问题、中国邮递员问题与货郎担问题');
  assert.equal(ch15.sections[0].page, 323);
  const ch18 = chapters.find((item) => item.no === 18);
  assert.equal(ch18.title, '支配集、覆盖集、独立集、匹配与着色');
  assert.equal(ch18.page, 356);
  assert.deepEqual(ch18.sections.map((item) => item.no), ['18.1']);
});

test('parseOutline：章号乱序（右栏先出现）时按章号排，不按扫描顺序', () => {
  const chapters = parseOutline({ brief: ['第 2 章 乙 20', '2.1 甲 21        第 1 章 甲 1', '1.1 乙 2'] });
  assert.deepEqual(chapters.map((item) => item.no), [1, 2]);
});
