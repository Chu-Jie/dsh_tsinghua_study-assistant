import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUMMARY_SCHEMA_HINT,
  hm,
  cell,
  parseSummaryJson,
  normalizeSummary,
  isSummaryEmpty,
  renderNoteMarkdown,
  renderHandoffPrompt,
  buildRollingPrompt,
  buildSummaryPrompt,
  buildAnswerPrompt,
} from '../lib/lecture/report.js';

/**
 * 这一层值得钉死的原因：模型的回话是**不可信输入** —— 它会加代码围栏、会少给
 * 字段、会把数组写成字符串、会在表格单元格里塞一个竖线。笔记是长期资产，
 * 渲染层崩一次就等于这节课白上，所以每一处容错都值得有用例守着。
 */

const full = {
  overview: '这节课讲平衡二叉树的旋转，先复习了 AVL 的定义。',
  points: [
    { title: 'LL 型', detail: '对最小不平衡子树做一次右旋' },
    { title: 'LR 型', detail: '' },
  ],
  questions: [
    { question: '为什么删除节点要回溯到根？', answer: '因为高度变化会一路上传', status: 'answered' },
    { question: '红黑树怎么对应 2-3-4 树？', answer: '', status: 'open' },
  ],
  terms: ['balance factor：左右子树高度差'],
  todos: ['把课后第 4 题做完'],
  followups: ['删除导致的不平衡怎么处理？'],
};

test('hm：按本地时间格式化成 HH:MM', () => {
  const at = new Date(2026, 9, 9, 8, 5, 0);
  assert.equal(hm(at.toISOString()), '08:05');
  assert.equal(hm('不是时间'), '');
});

test('cell：转义竖线、压掉换行', () => {
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('a\nb'), 'a b');
  assert.equal(cell(undefined), '');
});

test('parseSummaryJson：能从代码围栏和客套话里抠出 JSON', () => {
  const wrapped = '好的，下面是结果：\n```json\n{"overview":"x"}\n```\n希望有帮助！';
  assert.deepEqual(parseSummaryJson(wrapped), { overview: 'x' });
  assert.deepEqual(parseSummaryJson('{"a":1}'), { a: 1 });
});

test('parseSummaryJson：解析不了就返回 null，绝不抛错', () => {
  assert.equal(parseSummaryJson('这节课讲了二叉树。'), null);
  assert.equal(parseSummaryJson('{不是合法 JSON}'), null);
  assert.equal(parseSummaryJson('[1,2,3]'), null);
  assert.equal(parseSummaryJson(''), null);
  assert.equal(parseSummaryJson(null), null);
});

test('normalizeSummary：字段缺失、类型给错都不该让渲染崩', () => {
  assert.equal(normalizeSummary(null), null);
  assert.equal(normalizeSummary('字符串'), null);

  const patched = normalizeSummary({
    overview: 42,
    points: '不是数组',
    questions: [{ question: '  ' }, { question: 'q', answer: 'a', status: '怪值' }, 'x'],
    terms: ['ok', '', 7],
    todos: null,
    followups: ['  f  '],
  });
  assert.equal(patched.overview, '');
  assert.deepEqual(patched.points, []);
  assert.deepEqual(patched.questions, [{ question: 'q', answer: 'a', status: 'open' }]);
  assert.deepEqual(patched.terms, ['ok']);
  assert.deepEqual(patched.todos, []);
  assert.deepEqual(patched.followups, ['f']);
});

test('isSummaryEmpty：空壳算空，有一个字段就不算', () => {
  assert.equal(isSummaryEmpty(null), true);
  assert.equal(isSummaryEmpty(normalizeSummary({})), true);
  assert.equal(isSummaryEmpty(normalizeSummary({ overview: '有内容' })), false);
  assert.equal(isSummaryEmpty(normalizeSummary({ todos: ['x'] })), false);
});

test('renderNoteMarkdown：结构化总结渲染出全部小节', () => {
  const md = renderNoteMarkdown({
    course: '数据结构',
    date: '2026-10-09',
    startedAt: new Date(2026, 9, 9, 8, 0, 0).toISOString(),
    stoppedAt: new Date(2026, 9, 9, 9, 35, 0).toISOString(),
    studentName: '示例同学',
    summary: full,
    stats: { frames: 42, chars: 1832, alerts: 3, dropped: 1 },
    alerts: [
      { at: new Date(2026, 9, 9, 8, 31, 0).toISOString(), label: '叫到你', matched: '杜浩阳', snippet: '杜浩阳同学你来回答一下' },
      { at: new Date(2026, 9, 9, 8, 52, 0).toISOString(), label: '点名 / 签到', matched: '点名', snippet: 'a|b' },
    ],
    transcriptPath: '学习台/听课记录/2026-10-09-数据结构.json',
    rolling: ['开始复习 AVL 定义', '讲 LL 型旋转'],
  });

  assert.match(md, /^# 数据结构 · 2026-10-09 听课笔记/);
  assert.match(md, /08:00–09:35/);
  assert.match(md, /42 帧 \/ 1832 字/);
  assert.match(md, /学生：示例同学/);
  assert.match(md, /逐字稿：`学习台\/听课记录\/2026-10-09-数据结构\.json`/);
  assert.match(md, /## 这节课讲了什么/);
  assert.match(md, /1\. \*\*LL 型\*\* —— 对最小不平衡子树做一次右旋/);
  assert.match(md, /2\. \*\*LR 型\*\*\n/);
  assert.match(md, /- \*\*为什么删除节点要回溯到根？\*\*\n/);
  assert.match(md, /- \*\*红黑树怎么对应 2-3-4 树？\*\*（仍未解决）/);
  assert.match(md, /## 术语 \/ 公式/);
  assert.match(md, /- \[ \] 把课后第 4 题做完/);
  assert.match(md, /## 值得追问/);
  assert.match(md, /## 点名与提问记录/);
  assert.match(md, /\| 08:31 \| 叫到你 \| 杜浩阳 \| 杜浩阳同学你来回答一下 \|/);
  assert.match(md, /\| 08:52 \| 点名 \/ 签到 \| 点名 \| a\\\|b \|/);
  assert.match(md, /## 课堂进程（滚动小结）/);
  // 有结构化总结时不该再贴逐字稿摘录
  assert.doesNotMatch(md, /## 逐字稿摘录/);
});

test('renderNoteMarkdown：模型没给出 JSON 时降级成「原文 + 摘录」，不丢信息', () => {
  const md = renderNoteMarkdown({
    course: '离散数学',
    date: '2026-10-10',
    summary: null,
    rawSummary: '这节课讲了偏序关系。',
    transcriptText: '今天我们讲偏序关系。',
    stats: { frames: 2, chars: 10, alerts: 0 },
  });
  assert.match(md, /## 自动总结（未结构化的原文）/);
  assert.match(md, /这节课讲了偏序关系。/);
  assert.match(md, /## 逐字稿摘录/);

  const bare = renderNoteMarkdown({ course: '离散数学', date: '2026-10-10', summary: null });
  assert.match(bare, /（这次没有生成结构化的总结/);
  assert.doesNotMatch(bare, /## 逐字稿摘录/);
});

test('renderNoteMarkdown：过长的逐字稿摘录要截断，并说明还剩多少', () => {
  const md = renderNoteMarkdown({
    course: '物理',
    date: '2026-10-11',
    summary: null,
    transcriptText: '字'.repeat(5000),
    note: '自动总结失败，原因是模型超时。',
  });
  assert.match(md, /^> ⚠️ 自动总结失败，原因是模型超时。$/m);
  assert.match(md, /后面还有 1000 字/);
  assert.ok(md.length < 4600);
});

test('renderNoteMarkdown：课程名与日期缺省也不该出 undefined', () => {
  const md = renderNoteMarkdown({});
  assert.match(md, /^# 未命名课程 ·  听课笔记/);
  assert.doesNotMatch(md, /undefined/);
});

test('renderHandoffPrompt：把文件路径和三个要求都写清楚', () => {
  const text = renderHandoffPrompt({
    course: '数据结构',
    date: '2026-10-09',
    summary: full,
    transcriptPath: '学习台/听课记录/2026-10-09-数据结构.json',
    notePath: '数据结构/笔记/2026-10-09-数据结构.md',
  });
  assert.match(text, /我刚上完「数据结构」这节课（2026-10-09）/);
  assert.match(text, /数据结构\/笔记\/2026-10-09-数据结构\.md/);
  assert.match(text, /## 课上没弄明白的地方/);
  assert.match(text, /① 把这节课的脉络/);
});

test('提示词：滚动小结带上上一版与新片段，课后总结带上 schema，答题带上题目', () => {
  const rolling = buildRollingPrompt({ course: '数据结构', previous: '上回讲到 AVL', window: '现在讲旋转' });
  assert.match(rolling, /上回讲到 AVL/);
  assert.match(rolling, /现在讲旋转/);
  assert.match(rolling, /不超过 200 字/);

  const summary = buildSummaryPrompt({ course: '数据结构', date: '2026-10-09', transcript: '正文内容' });
  assert.ok(summary.includes(SUMMARY_SCHEMA_HINT));
  assert.match(summary, /只写转写稿里真的出现过的内容/);
  assert.match(summary, /正文内容/);

  const answer = buildAnswerPrompt({ course: '数据结构', summary: '脉络', context: '原话', question: '这题选什么' });
  assert.match(answer, /150 字以内/);
  assert.match(answer, /这题选什么/);

  // 没有上下文时也要给出占位，不能出现 undefined
  assert.doesNotMatch(buildAnswerPrompt({}), /undefined/);
  assert.match(buildRollingPrompt({}), /（还没有，这是第一段）/);
});
