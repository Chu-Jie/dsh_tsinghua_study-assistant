import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  backfillLectureTrace,
  isLectureDateText,
} from '../tools/analysis.mjs';
import { validateDoc } from '../lib/core.js';

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

test('analysis：章讲义按 no 合并，统计章数与风格份数，重复章号报 error', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_digital',
    lectures: [{
      no: '1', title: '数制和码制', styles: [{ key: 'A', file: '数电/讲义/a.md' }],
      variants: [{ key: 'C2', file: '数电/讲义/c2.md', parent: 'C' }],
    }],
  });
  const next = mergeAnalysis(doc, {
    courseId: 'c_digital',
    lectures: [{ no: 1, styles: [{ key: 'B', file: '数电/讲义/b.md' }] }],
  });
  assert.equal(next.courses[0].lectures.length, 1);
  assert.deepEqual(next.courses[0].lectures[0].styles.map((item) => item.key), ['A', 'B']);
  assert.equal(analysisStats(next).lectures, 1);
  assert.equal(analysisStats(next).lectureStyles, 3);
  const bad = validateAnalysis({ version: 1, courses: [{ courseId: 'c_digital', lectures: [{ no: '1' }, { no: 1 }] }], runs: [] });
  assert.ok(bad.issues.some((item) => item.code === 'lecture-duplicate-no'));
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

// ---------------------------------------------------------------------------
// W4：讲义可追溯（model / version / supersededBy / applicability）
// ---------------------------------------------------------------------------

const lecturePatch = (styles, extra = {}) => ({
  courseId: 'c_digital',
  lectures: [{ no: '1', title: '数制和码制', source: 'notebooklm', styles, ...extra }],
});

test('analysis：新讲义首版合并后 variants 为空，且不与 styles 同引用（别名 bug 防回归）', () => {
  // index-keeper 2026-10-30 报过：base 为空时 target 与 history 都是 undefined，
  // `history === target` 误判成「同一数组」，于是 styles 被同时推进 variants。
  const doc = mergeAnalysis(emptyAnalysisDoc(), lecturePatch([{ key: 'A', label: '严谨体系式', file: '数电/讲义/a.md', chars: 1 }]));
  const lecture = doc.courses[0].lectures[0];
  assert.deepEqual(lecture.styles.map((item) => item.key), ['A']);
  assert.deepEqual(lecture.variants, [], '首版不该凭空多出一条历史');
  assert.notEqual(lecture.styles, lecture.variants, 'styles 与 variants 不能是同一个数组');
  lecture.styles.push({ key: 'ZZZ' });
  assert.deepEqual(lecture.variants, [], '改 styles 不能串到 variants');
});

test('analysis：同 key 同 file 重跑版本号不涨；同 key 换 file 才升版本并把旧版搬进 variants', () => {
  const first = mergeAnalysis(emptyAnalysisDoc(), lecturePatch([{ key: 'A', file: '数电/讲义/第01章-A.md' }]));
  const style = first.courses[0].lectures[0].styles[0];
  assert.equal(style.version, 1);
  assert.equal(style.model, 'notebooklm', 'model 缺省沿用讲义级 source');
  assert.equal(style.modelSource, 'lecture-source');

  // 同一份文件再同步一次：只刷元数据，版本还是 1，历史仍空
  const again = mergeAnalysis(first, lecturePatch([{ key: 'A', file: '数电/讲义/第01章-A.md', chars: 99 }]));
  const sameStyle = again.courses[0].lectures[0].styles[0];
  assert.equal(sameStyle.version, 1);
  assert.equal(sameStyle.chars, 99);
  assert.deepEqual(again.courses[0].lectures[0].variants, []);

  // 换了文件 = 新版本：旧版留在 variants 里，标 supersededBy 指向新版
  const next = mergeAnalysis(again, lecturePatch([{ key: 'A', file: '数电/讲义/第01章-A-重写.md' }]), { now: '2026-10-30T12:00:00+08:00' });
  const lecture = next.courses[0].lectures[0];
  assert.equal(lecture.styles[0].version, 2);
  assert.equal(lecture.styles[0].file, '数电/讲义/第01章-A-重写.md');
  assert.equal(lecture.variants.length, 1, '旧版必须留痕');
  assert.equal(lecture.variants[0].file, '数电/讲义/第01章-A.md');
  assert.equal(lecture.variants[0].version, 1);
  assert.equal(lecture.variants[0].supersededBy, 2);
  assert.equal(lecture.variants[0].supersededAt, '2026-10-30T12:00:00+08:00');

  // 再跑一次同样的 patch：历史不叠加、版本不涨（幂等）
  const repeat = mergeAnalysis(next, lecturePatch([{ key: 'A', file: '数电/讲义/第01章-A-重写.md' }]), { now: '2026-10-30T13:00:00+08:00' });
  const repeatLecture = repeat.courses[0].lectures[0];
  assert.equal(repeatLecture.styles[0].version, 2);
  assert.equal(repeatLecture.variants.length, 1);
  assert.equal(repeatLecture.variants[0].supersededAt, '2026-10-30T12:00:00+08:00', '重跑不能改写归档时刻');
});

test('analysis：校验拦下静默覆盖、非法版本号、非字符串 model、坏日期与坏 applicability', () => {
  const codes = (doc) => validateAnalysis(doc).issues;
  const base = () => ({ version: 1, runs: [], courses: [{ courseId: 'c_digital' }] });

  // v2 却没有 v1 的归档 → 静默覆盖
  const overwritten = base();
  overwritten.courses[0].lectures = [{ no: '1', styles: [{ key: 'A', file: 'a.md', version: 2 }], variants: [] }];
  assert.ok(codes(overwritten).some((item) => item.code === 'lecture-silent-overwrite'));

  // 有归档就合法
  const ok = base();
  ok.courses[0].lectures = [{
    no: '1',
    styles: [{ key: 'A', file: 'a2.md', version: 2, model: 'notebooklm' }],
    variants: [{ key: 'A', file: 'a.md', version: 1, supersededBy: 2, supersededAt: '2026-10-30T12:00:00+08:00' }],
  }];
  assert.deepEqual(codes(ok).filter((item) => item.level === 'error'), []);

  const badVersion = base();
  badVersion.courses[0].lectures = [{ no: '1', styles: [{ key: 'A', file: 'a.md', version: 0 }] }];
  assert.ok(codes(badVersion).some((item) => item.code === 'lecture-style-version-invalid'));

  const badModel = base();
  badModel.courses[0].lectures = [{ no: '1', styles: [{ key: 'A', file: 'a.md', model: 42 }] }];
  assert.ok(codes(badModel).some((item) => item.code === 'lecture-style-model-invalid'));

  const badDate = base();
  badDate.courses[0].lectures = [{ no: '1', styles: [{ key: 'A', file: 'a.md', generatedAt: '昨天' }] }];
  assert.ok(codes(badDate).some((item) => item.code === 'lecture-style-generatedAt-invalid'));

  const badApplicability = base();
  badApplicability.courses[0].lectures = [{ no: '1', applicability: '第1章' }];
  assert.ok(codes(badApplicability).some((item) => item.code === 'lecture-applicability-invalid'));

  // 老数据没这些字段：只 warn，不报 error（迁移前必须能过校验）
  const legacy = base();
  legacy.courses[0].lectures = [{ no: '1', styles: [{ key: 'A', file: 'a.md' }] }];
  const legacyIssues = codes(legacy);
  assert.equal(legacyIssues.filter((item) => item.level === 'error').length, 0);
  assert.ok(legacyIssues.some((item) => item.code === 'lecture-style-without-version'));
  assert.ok(legacyIssues.some((item) => item.code === 'lecture-style-without-model'));
});

test('analysis：core.validateDoc 同步拦住非法追溯字段（面板读之前就要拒）', () => {
  const doc = (lectures) => ({ version: 1, courses: [{ courseId: 'c_digital', lectures }], runs: [] });
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md', version: 1, model: 'notebooklm' }] }])).ok, true);
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md', version: 0 }] }])).reason, 'lecture-style-version-invalid');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md', model: [] }] }])).reason, 'lecture-style-model-invalid');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md', generatedAt: 'x' }] }])).reason, 'lecture-style-generatedAt-invalid');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md', supersededBy: 'two' }] }])).reason, 'lecture-style-superseded-invalid');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', applicability: [] }])).reason, 'lecture-applicability-invalid');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md' }, { key: 'A', file: 'b.md' }] }])).reason, 'lecture-style-duplicate-key');
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a2.md', version: 2 }], variants: [] }])).reason, 'lecture-silent-overwrite');
  // 老数据（无追溯字段）仍然可写：迁移前后都能过
  assert.equal(validateDoc('knowledgeAnalysis', doc([{ no: '1', styles: [{ key: 'A', file: 'a.md' }] }])).ok, true);
});

test('analysis：--backfill-trace 给老讲义补 version/model/applicability，generatedAt 只按真实 mtime 精化', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-backfill-'));
  try {
    const lectureDir = path.join(root, '数电', '讲义');
    fs.mkdirSync(lectureDir, { recursive: true });
    const file = path.join(lectureDir, '第01章-A.md');
    fs.writeFileSync(file, '# 讲义\n', 'utf8');
    const when = new Date(2026, 9, 29, 19, 21, 15); // 本地时间 2026-10-29 19:21:15
    fs.utimesSync(file, when, when);

    const doc = {
      version: 1,
      runs: [],
      courses: [{
        courseId: 'c_digital',
        name: '数字电子技术基础',
        book: '数字电子技术基础（第6版）',
        lectures: [{
          no: '1',
          title: '数制和码制',
          source: 'notebooklm',
          styles: [
            { key: 'A', label: '严谨体系式', file: '数电/讲义/第01章-A.md', generatedAt: '2026-10-29' },
            { key: 'B', label: '图示直觉式', file: '数电/讲义/第01章-B.md', generatedAt: '2026-10-20' },
          ],
          variants: [],
        }],
      }],
    };

    const result = backfillLectureTrace(doc, { root });
    const lecture = result.doc.courses[0].lectures[0];
    for (const style of lecture.styles) {
      assert.equal(style.version, 1);
      assert.equal(style.model, 'notebooklm');
      assert.equal(style.modelSource, 'lecture-source');
    }
    // 文件在、且 mtime 日期与记录日期一致 → 升级成完整时间戳
    assert.equal(new Date(lecture.styles[0].generatedAt).getTime(), when.getTime());
    assert.equal(lecture.styles[0].generatedAtSource, 'file-mtime');
    assert.equal(result.upgradedTimes, 1);
    // 文件不在 / 日期对不上 → 保留原值，标 date-only，绝不编时刻
    assert.equal(lecture.styles[1].generatedAt, '2026-10-20');
    assert.equal(lecture.styles[1].generatedAtSource, 'date-only');
    assert.deepEqual(result.missingFiles, ['数电/讲义/第01章-B.md']);
    // applicability 由文档自身字段推出来
    assert.deepEqual(lecture.applicability, { chapter: '第1章 数制和码制', textbook: '数字电子技术基础（第6版）' });

    // 幂等：再跑一次没有改动，且结果仍能过校验
    const second = backfillLectureTrace(result.doc, { root });
    assert.equal(second.changed, 0);
    assert.equal(second.upgradedTimes, 0);
    const checked = validateAnalysis(result.doc);
    assert.deepEqual(checked.issues.filter((item) => item.level === 'error'), []);
    assert.equal(validateDoc('knowledgeAnalysis', result.doc).ok, true);

    assert.equal(isLectureDateText('2026-10-29'), true);
    assert.equal(isLectureDateText('2026-10-29T19:21:15+08:00'), true);
    assert.equal(isLectureDateText('2026-13-40'), false);
    assert.equal(isLectureDateText(''), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analysis：统计里能看出讲义可追溯覆盖率', () => {
  const doc = mergeAnalysis(emptyAnalysisDoc(), {
    courseId: 'c_digital',
    book: '数字电子技术基础（第6版）',
    lectures: [{ no: '1', title: '数制和码制', source: 'notebooklm', styles: [{ key: 'A', file: '数电/讲义/a.md' }] }],
  });
  const filled = backfillLectureTrace(doc).doc;
  const stats = analysisStats(filled);
  assert.equal(stats.lectureStyles, 1);
  assert.equal(stats.lectureStylesWithModel, 1);
  assert.equal(stats.lectureStylesWithVersion, 1);
  assert.equal(stats.supersededLectureStyles, 0);
  assert.equal(stats.lecturesWithApplicability, 1);
  assert.equal(stats.courses[0].lectureStylesWithModel, 1);
});
