import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyAnalysisDoc,
  mergeAnalysis,
  mergeCourse,
  analysisStats,
  buildPointIndex,
  validateAnalysis,
  validatePointQuality,
  gatePatchQuality,
  nodeIdFor,
  splitSectionNo,
  chapterLabelFromOutline,
  planNodeCreations,
  applyNodeCreations,
  ensurePointIds,
} from '../tools/analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('analysis：空文档形状与 core.defaultDoc 一致', () => {
  const doc = emptyAnalysisDoc();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.courses, []);
  assert.deepEqual(doc.runs, []);
});

test('analysis：合并单门课的知识点（同 id 原位覆盖，新 id 追加）', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    name: '数据结构',
    points: [{ id: 'p1', title: '向量', explain: '甲' }],
  });
  assert.equal(doc.courses.length, 1);
  assert.equal(doc.courses[0].courseId, 'c_ds');
  assert.equal(doc.courses[0].points.length, 1);

  const next = mergeAnalysis(doc, {
    courseId: 'c_ds',
    points: [{ id: 'p1', explain: '乙' }, { id: 'p2', title: '列表' }],
  });
  const course = next.courses[0];
  assert.equal(course.points.length, 2);
  assert.equal(course.points[0].title, '向量', '没提到的字段要保留');
  assert.equal(course.points[0].explain, '乙', '同 id 原位覆盖');
  assert.equal(next.courses.length, 1, '不能因为二次合并多出一门课');
});

test('analysis：章内习题按 no 合并、章按 no 合并、PPT 按讲次、作业按次', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    chapters: [{ no: '2', title: '向量', exercises: [{ no: '2-1', prompt: '甲' }] }],
    ppt: [{ lecture: 'L01', title: '绪论' }],
    homework: [{ seq: 1, file: 'a.pdf', questions: [{ no: '1', prompt: 'x' }] }],
  });
  const next = mergeAnalysis(doc, {
    courseId: 'c_ds',
    chapters: [
      { no: '2', exercises: [{ no: '2-2', prompt: '乙' }] },
      { no: '3', title: '列表', exercises: [{ no: '3-1', prompt: '丙' }] },
    ],
    ppt: [{ lecture: 'L02', title: '向量' }],
    homework: [{ seq: 1, questions: [{ no: '2', prompt: 'y' }] }],
  });
  const course = next.courses[0];
  assert.equal(course.chapters.length, 2);
  const ch2 = course.chapters.find((item) => item.no === '2');
  assert.equal(ch2.title, '向量', '章标题没被空值冲掉');
  assert.deepEqual(ch2.exercises.map((item) => item.no), ['2-1', '2-2']);
  assert.equal(course.ppt.length, 2);
  assert.equal(course.homework.length, 1);
  assert.equal(course.homework[0].questions.length, 1, '同一题号合并，不是追加');
});

test('analysis：runs 按 id 去重，重复跑只留最新一条', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    runs: [{ id: 'r1', at: '2026-10-24T01:00:00+08:00', points: 3, ok: true }],
  });
  const next = mergeAnalysis(doc, { runs: [{ id: 'r1', points: 5, ok: true }, { id: 'r2', points: 1, ok: true }] });
  assert.equal(next.runs.length, 2);
  assert.equal(next.runs[0].points, 5);
  assert.equal(next.runs[1].id, 'r2');
});

test('analysis：统计与索引', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    points: [
      { id: 'p1', title: '甲', explain: '有', examples: [{ prompt: 'q' }], sources: [{ file: 'f', page: 1 }] },
      { id: 'p2', title: '乙' },
    ],
    chapters: [{ no: '2', exercises: [{ no: '2-1', prompt: 'x' }, { no: '2-2', prompt: 'y' }] }],
    ppt: [{ lecture: 'L01', titlePoints: [{ title: 'a' }, { title: 'b' }] }],
    homework: [{ seq: 1, questions: [{ no: '1', prompt: 'z' }] }],
  });
  const stats = analysisStats(doc);
  assert.equal(stats.totalPoints, 2);
  assert.equal(stats.totalExercises, 2);
  assert.equal(stats.courses[0].withExplain, 1);
  assert.equal(stats.courses[0].withExample, 1);
  assert.equal(stats.courses[0].pptPoints, 2);
  assert.equal(stats.courses[0].homeworkQuestions, 1);
  const index = buildPointIndex(doc);
  assert.equal(index.get('p1').title, '甲');
  assert.equal(index.size, 2);
});

test('analysis：校验能分出错/警告/提示，并据此判 ok', () => {
  const good = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    points: [{ id: 'p1', title: '甲', explain: '正文', sources: [{ file: '数据结构/教材/x.pdf', page: 3 }] }],
  });
  const goodResult = validateAnalysis(good, { nodeIds: new Set(['p1']) });
  assert.equal(goodResult.ok, true);
  assert.deepEqual(goodResult.issues, []);

  const bad = {
    version: 1,
    courses: [
      { courseId: 'c_ds', points: [{ id: 'p1' }, { id: 'p1' }] },
      { courseId: 'c_ds', points: [] },
    ],
    runs: [],
  };
  const badResult = validateAnalysis(bad, { nodeIds: new Set() });
  assert.equal(badResult.ok, false);
  const codes = badResult.issues.map((item) => item.code);
  assert.ok(codes.includes('duplicate-course'));
  assert.ok(codes.includes('duplicate-point'));
  assert.ok(codes.includes('missing-title'));
  assert.ok(codes.includes('missing-source'));
  assert.ok(codes.includes('point-not-in-network'));

  const notObject = validateAnalysis(null);
  assert.equal(notObject.ok, false);
  assert.equal(notObject.issues[0].code, 'not-an-object');
});

test('analysis：--create-nodes 的 id 稳定、章号拆解、章名从大纲取', () => {
  // id 只由 课程+节+标题 决定：同输入同 id（重跑不会造重复），换标题即换 id
  const a = nodeIdFor('c_ds', '2.6', '二分查找');
  assert.equal(a, nodeIdFor('c_ds', '2.6', '二分查找'));
  assert.match(a, /^k_[0-9a-f]{10}$/);
  assert.notEqual(a, nodeIdFor('c_ds', '2.6', '二分查找（折半）'));
  assert.notEqual(a, nodeIdFor('c_ds', '2.5', '二分查找'));

  // 节号拆三层：2.6.5 → 章 2 / 节 2.6 / 小节 2.6.5
  assert.deepEqual(splitSectionNo('2.6.5'), { chapterNo: '2', section: '2.6', subsection: '2.6.5' });
  assert.deepEqual(splitSectionNo('§2.6'), { chapterNo: '2', section: '2.6', subsection: '' });
  assert.deepEqual(splitSectionNo('12'), { chapterNo: '12', section: '', subsection: '' });
  assert.deepEqual(splitSectionNo(''), { chapterNo: '', section: '', subsection: '' });

  const outline = {
    courses: [{ courseId: 'c_ds', chapters: [{ no: 2, title: '向量' }, { no: 12, title: '排序' }] }],
  };
  assert.equal(chapterLabelFromOutline(outline, 'c_ds', '2'), '第2章 向量');
  assert.equal(chapterLabelFromOutline(outline, 'c_ds', 12), '第12章 排序');
  assert.equal(chapterLabelFromOutline(outline, 'c_ds', '9'), '第9章', '大纲里没有的章只留章号');
  assert.equal(chapterLabelFromOutline(outline, 'c_xx', '2'), '第2章', '别的课程查不到章名');
  assert.equal(chapterLabelFromOutline(outline, 'c_ds', ''), '');
});

test('analysis：--create-nodes 只给缺的建节点，已存在的跳过', () => {
  const network = {
    version: 1,
    nodes: [{ id: 'k_exist0001', name: '向量', courseId: 'c_ds', section: '2.1' }],
  };
  const outline = { courses: [{ courseId: 'c_ds', chapters: [{ no: 2, title: '向量' }] }] };
  const analysis = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    points: [
      { id: 'k_exist0001', title: '向量', no: '2.1' }, // 已有节点 → 跳过
      { title: '二分查找', no: '2.6', id: nodeIdFor('c_ds', '2.6', '二分查找') }, // 新建
      { title: '向量', no: '2.1' }, // 同名同节已在网络里 → 跳过（防重复造点）
      { title: '', no: '2.7' }, // 没标题 → 跳过
    ],
  });
  const plan = planNodeCreations(analysis, network, outline);
  assert.equal(plan.creations.length, 1);
  const node = plan.creations[0];
  assert.equal(node.name, '二分查找');
  assert.equal(node.chapter, '第2章 向量');
  assert.equal(node.section, '2.6');
  assert.equal(node.subsection, '');
  assert.equal(node.mastery, 0);
  assert.equal(node.marked, false);
  assert.deepEqual(node.evidence, []);
  assert.deepEqual(plan.skipped.map((item) => item.reason).sort(), ['id-exists', 'point-without-title', 'same-name-node-exists']);

  const next = applyNodeCreations(network, plan.creations);
  assert.equal(next.nodes.length, 2);
  assert.equal(network.nodes.length, 1, '纯函数不改传入的网络文档');
  assert.ok(Array.isArray(next.nodes) && next.nodes.some((item) => item.name === '二分查找'));
});

test('analysis：--create-nodes 会给缺 id 的知识点补稳定 id', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_ds',
    points: [
      { no: '2.6', title: '二分查找', explain: '甲' },
      { id: 'k_keep000001', no: '2.1', title: '向量', explain: '乙' },
    ],
  });
  const next = ensurePointIds(doc);
  const [first, second] = next.courses[0].points;
  assert.equal(first.id, nodeIdFor('c_ds', '2.6', '二分查找'));
  assert.equal(second.id, 'k_keep000001', '已有 id 不动');
  assert.equal(doc.courses[0].points[0].id, undefined, '纯函数不改传入的文档');
  // 幂等：再跑一次结果不变
  assert.deepEqual(ensurePointIds(next).courses[0].points.map((item) => item.id), next.courses[0].points.map((item) => item.id));
});

/** 一个「能过闸门」的样板点，测试里再按需要弄坏某一项。 */
function goodPoint(extra = {}) {
  return {
    id: 'k_good000001',
    no: '2.6',
    title: '二分查找',
    explain: '二分查找只在有序序列上有效。每次拿中间那个元素跟目标比：比它小就去右半边，比它大就去左半边。'
      + '每一步都把候选区间砍掉一半，所以最多走 log2 n 步。'.repeat(12),
    keywords: ['二分查找', '有序序列', '区间收缩'],
    analogy: '像查字典：你不从第一页翻，而是直接翻到中间，看这一页的字比你要找的大还是小。',
    formulas: [{ tex: 'T(n)=O(\\log n)', plain: 'T(n)=O(log n)' }],
    pitfalls: ['忘了「序列必须有序」这个前提：无序时要先排序，否则结果错。', '区间收缩写错（例如漏掉 mid 本身没排除），会导致死循环。'],
    examples: [{
      prompt: '在 [1,3,5,7,9] 里找 7，最多比几次？',
      steps: ['取中间 5，7 > 5，去右半 [7,9]', '取中间 7，命中'],
      answer: '2 次',
      method: '每次把区间减半，直到命中或区间为空',
    }],
    sources: [{ file: '数据结构/教材/数据结构教材.pdf', page: 42, quote: '二分查找（binary search）' }],
    ...extra,
  };
}

test('analysis：--gate 质量闸门对达标的点零 error', () => {
  const indexedPaths = new Set(['数据结构/教材/数据结构教材.pdf']);
  const issues = validatePointQuality(goodPoint(), { indexedPaths });
  assert.deepEqual(issues.filter((item) => item.level === 'error'), []);
});

test('analysis：--gate 逐条拦下短详解/缺料/跳步/编造出处/残缺公式', () => {
  const indexedPaths = new Set(['数据结构/教材/数据结构教材.pdf']);
  const codes = (extra, options = { indexedPaths }) => validatePointQuality(goodPoint(extra), options).map((item) => item.code);
  assert.ok(codes({ explain: '短' }).includes('explain-too-short'));
  assert.ok(codes({ keywords: ['一个'] }).includes('keywords-too-few'));
  assert.ok(codes({ pitfalls: ['注意'] }).includes('pitfalls-too-few'));
  assert.ok(codes({ examples: [] }).includes('examples-too-few'));
  assert.ok(codes({ examples: [{ prompt: 'p', steps: [], answer: '' }] }).includes('example-without-steps'));
  assert.ok(codes({ examples: [{ prompt: 'p', steps: ['一步'], answer: '' }] }).includes('example-without-answer'));
  assert.ok(codes({ sources: [] }).includes('sources-too-few'));
  assert.ok(codes({ sources: [{ file: '编的.pdf', page: 3 }] }).includes('source-file-not-indexed'));
  assert.ok(codes({ sources: [{ file: '数据结构/教材/数据结构教材.pdf', page: -1 }] }).includes('source-page-invalid'));
  assert.ok(codes({ formulas: [{ tex: 'x' }] }).includes('formula-incomplete'));
  assert.ok(codes({ explain: `${'甲'.repeat(320)}见上文` }).includes('step-jump'));
  const warns = validatePointQuality(goodPoint({ analogy: '', pitfalls: ['注意', '小心'] }), { indexedPaths })
    .filter((item) => item.level === 'warn').map((item) => item.code);
  assert.ok(warns.includes('missing-analogy'));
  assert.ok(warns.includes('pitfall-vague'));
  // 不传 indexedPaths 时跳过「出处是否在索引里」这条（离线/单测场景）
  assert.ok(!codes({ sources: [{ file: '编的.pdf', page: 3 }] }, {}).includes('source-file-not-indexed'));
});

test('analysis：--gate 只查 patch 要写的点（旧点不连坐），缺 id 也能对上最终值', () => {
  const base = emptyAnalysisDoc();
  const patch = { courseId: 'c_ds', points: [{ no: '2.6', title: '二分查找', explain: '甲', keywords: [], pitfalls: [], examples: [], sources: [] }] };
  const merged = ensurePointIds(mergeAnalysis(base, patch));
  const result = gatePatchQuality(patch, merged, {});
  assert.equal(result.pointIds.length, 1);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === 'explain-too-short'));
  assert.ok(!result.issues.some((item) => item.code === 'gate-point-missing'), '缺 id 的点要先补 id 再比对');

  // 文档里本来就有的旧点不在 patch 里 → 它的短详解不该让本次写盘失败
  const docs = ensurePointIds(mergeAnalysis(base, { courseId: 'c_ds', points: [{ id: 'k_legacy', no: '1.1', title: '旧点', explain: '短' }] }));
  const onlyNew = gatePatchQuality(patch, docs, {});
  assert.ok(!onlyNew.issues.some((item) => item.message.includes('k_legacy')));

  const wrongId = { courseId: 'c_ds', points: [{ id: 'k_nothere', no: '9.9', title: '对不上' }] };
  const missing = gatePatchQuality(wrongId, merged, {});
  assert.ok(missing.issues.some((item) => item.code === 'gate-point-missing'));
  assert.equal(missing.ok, false);
});
