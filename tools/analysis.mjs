#!/usr/bin/env node
/**
 * analysis —— `资料分析.json`（第 11 份数据文档）的合并 / 校验 / 统计工具。
 *
 * 为什么要有这个工具：面板要「点一个知识点，秒开详解 + 例题 + 来历」。详解是**离线批量预生成**的
 * （用户 2026-10-23 拍板：提前全部生成好，不现场跑），所以需要一个能反复合并、能校验、能统计的落盘口。
 * 生成动作本身在会话里做（读 `_OCR` / `_TEXT` 文本 → 按本工具的结构写 patch JSON），
 * 工具只负责**把 patch 合并进 `学习台/资料分析.json`**，不调用任何模型。
 *
 * 文档形状（与 `_工具/学习台-知识点大改版与扫描产物分析-实施计划_20261023.md` §2.2 一致）：
 *   {
 *     version, updatedAt,
 *     courses: [{
 *       courseId, name, book,
 *       points:   [{ id, no, title, level, keywords[], explain, analogy, formulas[], pitfalls[],
 *                    examples[{prompt, steps[], answer, method}],
 *                    sources[{file, page, quote}], generatedAt, model }],
 *       chapters: [{ no, title, exercises[{ no, prompt, knowledge[], method, answer, source{file,page} }] }],
 *       ppt:      [{ lecture, title, titlePoints[{ title, kind, note, source{file,slide} }] }],
 *       homework: [{ seq, file, questions[{ no, prompt, knowledge[], method, difficulty, source{file,page} }] }]
 *     }],
 *     runs: [{ id, at, courseId, kind, unit, model, provider, points, exercises, chars, ok, note }]
 *   }
 *
 * 合并语义（可安全重跑）：
 *   - 课程按 `courseId` 合并；`points` 按 `id` 原位替换；`chapters` 按 `no` 合并、章内 `exercises` 按 `no`；
 *   - `ppt` 按 `lecture`、`homework` 按 `seq` 合并；
 *   - `runs` 按 `id` 去重后追加（同一单元重跑只留最新一条）；
 *   - patch 里没提到的字段一律保持原样（不是整份覆盖）。
 *
 * 用法：
 *   node tools/analysis.mjs --init                       # 首次创建空的 资料分析.json
 *   node tools/analysis.mjs                              # 统计（默认动作，dry）
 *   node tools/analysis.mjs --validate                   # 结构校验（含与 知识点网络.json 的 id 对照）
 *   node tools/analysis.mjs --merge <patch.json>         # 预览合并结果（不写盘）
 *   node tools/analysis.mjs --merge <patch.json> --gate  # 预览 + 质量闸门（字数/条数/出处真实性，2026-10-25 加）
 *   node tools/analysis.mjs --merge <patch.json> --apply # 真写（经 store，自动留 备份/）
 *   node tools/analysis.mjs --merge <patch.json> --create-nodes [--apply]
 *        # 顺带给 patch 里「知识点网络.json 还没有的」知识点建节点（id 由 课程+章+节+标题 决定，可重入）
 *   node tools/analysis.mjs --data <学习台目录> --json    # 机器可读输出
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { DOC_VERSION, DOC_FILES, defaultDoc } from '../lib/core.js';

/** 插图资产目录名（数据目录下的 `图片/`）；与 `lib/api.js` 的 `IMAGE_DIR_NAME` 同一个约定。 */
const IMAGE_DIR_NAME = '图片';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(HERE, '..', '..', '..', '学习台');

const str = (value) => (typeof value === 'string' ? value : '');
const arr = (value) => (Array.isArray(value) ? value : []);
const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 空文档（与 core.defaultDoc('knowledgeAnalysis') 同形）。 */
export function emptyAnalysisDoc() {
  const doc = defaultDoc('knowledgeAnalysis');
  return doc === null ? { version: DOC_VERSION, courses: [], runs: [] } : doc;
}

/** 合并用的键：字符串/数字都按文本比较（`seq: 1` 与 `seq: '1'` 视为同一项）。 */
const keyText = (value) => (value === undefined || value === null ? '' : String(value).trim());

/** 合并两个「按 key 去重」的数组：后者同 key 原位替换，其余保持前者顺序，新 key 追加。 */
function mergeByKey(baseList, patchList, keyOf) {
  const out = arr(baseList).filter(isObj).map((item) => ({ ...item }));
  for (const patch of arr(patchList).filter(isObj)) {
    const key = keyText(keyOf(patch));
    if (key === '') {
      out.push({ ...patch });
      continue;
    }
    const at = out.findIndex((item) => keyText(keyOf(item)) === key);
    if (at === -1) out.push({ ...patch });
    else out[at] = { ...out[at], ...patch };
  }
  return out;
}

/** 合并一门课程：只覆盖 patch 里出现的字段，没提到的原样保留。 */
export function mergeCourse(current, patch) {
  const base = isObj(current) ? current : {};
  const next = { ...base };
  for (const field of ['courseId', 'name', 'book']) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  if (patch.points !== undefined) next.points = mergeByKey(base.points, patch.points, (item) => item.id);
  if (patch.chapters !== undefined) {
    // 章先按 no 合并「除习题以外的字段」，习题单独二次合并——否则下方 exercises 会把旧习题整段冲掉
    const shell = arr(patch.chapters).filter(isObj).map((chapter) => {
      const copy = { ...chapter };
      delete copy.exercises;
      return copy;
    });
    next.chapters = mergeByKey(base.chapters, shell, (item) => item.no);
    for (const patchChapter of arr(patch.chapters).filter(isObj)) {
      const target = next.chapters.find((item) => str(item.no) === str(patchChapter.no));
      if (target && patchChapter.exercises !== undefined) {
        target.exercises = mergeByKey(target.exercises, patchChapter.exercises, (item) => item.no);
      }
    }
  }
  if (patch.ppt !== undefined) next.ppt = mergeByKey(base.ppt, patch.ppt, (item) => item.lecture);
  if (patch.homework !== undefined) next.homework = mergeByKey(base.homework, patch.homework, (item) => item.seq);
  return next;
}

/** 把一份 patch 合并进整份文档。patch: { courses:[{...}] , runs:[...] } 或单门课的简写 { courseId, points... }。 */
export function mergeAnalysis(doc, patch) {
  const base = isObj(doc) ? doc : emptyAnalysisDoc();
  const next = {
    version: DOC_VERSION,
    courses: arr(base.courses).filter(isObj).map((item) => ({ ...item })),
    runs: arr(base.runs).filter(isObj).map((item) => ({ ...item })),
  };
  const patchCourses = Array.isArray(patch?.courses) ? patch.courses : (patch?.courseId ? [patch] : []);
  for (const patchCourse of patchCourses.filter(isObj)) {
    const courseId = str(patchCourse.courseId);
    if (courseId === '') continue;
    const at = next.courses.findIndex((item) => str(item.courseId) === courseId);
    if (at === -1) next.courses.push(mergeCourse({ courseId }, patchCourse));
    else next.courses[at] = mergeCourse(next.courses[at], patchCourse);
  }
  if (Array.isArray(patch?.runs)) next.runs = mergeByKey(next.runs, patch.runs, (item) => item.id);
  return next;
}

/** 统计：每门课的知识点/章/习题/PPT 讲次/作业次数，以及总点数与生成记录数。 */
export function analysisStats(doc) {
  const courses = arr(doc?.courses).filter(isObj).map((course) => {
    const points = arr(course.points);
    const chapters = arr(course.chapters);
    return {
      courseId: str(course.courseId),
      name: str(course.name),
      points: points.length,
      withExplain: points.filter((point) => str(point.explain).trim() !== '').length,
      withExample: points.filter((point) => arr(point.examples).length > 0).length,
      chapters: chapters.length,
      exercises: chapters.reduce((sum, chapter) => sum + arr(chapter.exercises).length, 0),
      ppt: arr(course.ppt).length,
      pptPoints: arr(course.ppt).reduce((sum, lecture) => sum + arr(lecture.titlePoints).length, 0),
      homework: arr(course.homework).length,
      homeworkQuestions: arr(course.homework).reduce((sum, item) => sum + arr(item.questions).length, 0),
    };
  });
  return {
    courses,
    totalPoints: courses.reduce((sum, item) => sum + item.points, 0),
    totalExercises: courses.reduce((sum, item) => sum + item.exercises, 0),
    runs: arr(doc?.runs).length,
  };
}

/** 知识点 id → point 的索引（面板/校验共用）。同 id 后者覆盖前者。 */
export function buildPointIndex(doc) {
  const index = new Map();
  for (const course of arr(doc?.courses).filter(isObj)) {
    for (const point of arr(course.points).filter(isObj)) {
      const id = str(point.id);
      if (id !== '') index.set(id, point);
    }
  }
  return index;
}

/**
 * 给 patch 里的知识点算一个**稳定 id**：同一门课、同一节、同一标题永远得到同一个 id。
 * 这样「先分析、后建节点」与「先建节点、后分析」两条路都对得上，重跑也不会造出重复节点。
 */
export function nodeIdFor(courseId, section, title) {
  const seed = [str(courseId).trim(), str(section).trim(), str(title).trim()].join('|');
  const digest = crypto.createHash('sha1').update(seed, 'utf8').digest('hex');
  return `k_${digest.slice(0, 10)}`;
}

/** 把 `2.6.5` 拆成 `{ chapterNo:'2', section:'2.6', subsection:'2.6.5' }`；`2.6` → subsection 空；空串全空。 */
export function splitSectionNo(no) {
  const text = str(no).trim().replace(/^§/, '');
  const parts = text.split('.').filter((part) => part !== '');
  if (parts.length === 0) return { chapterNo: '', section: '', subsection: '' };
  if (parts.length === 1) return { chapterNo: parts[0], section: '', subsection: '' };
  if (parts.length === 2) return { chapterNo: parts[0], section: text, subsection: '' };
  return { chapterNo: parts[0], section: parts.slice(0, 2).join('.'), subsection: parts.slice(0, 3).join('.') };
}

/** 从《知识点大纲》里找出某门课第 N 章的标题，拼成 `第 2 章 向量`（树上按这个字符串对章）。 */
export function chapterLabelFromOutline(outline, courseId, chapterNo) {
  const want = keyText(chapterNo);
  if (want === '') return '';
  for (const course of arr(outline?.courses).filter(isObj)) {
    if (str(course.courseId) !== str(courseId)) continue;
    for (const chapter of arr(course.chapters).filter(isObj)) {
      if (keyText(chapter.no) !== want) continue;
      const title = str(chapter.title).trim();
      return title === '' ? `第${want}章` : `第${want}章 ${title}`;
    }
  }
  return want === '' ? '' : `第${want}章`;
}

/** 给缺 id 的知识点补上稳定 id（`--create-nodes` 时用，保证落盘的详解一定有 id）。 */
export function ensurePointIds(doc) {
  const base = isObj(doc) ? doc : emptyAnalysisDoc();
  const courses = arr(base.courses).filter(isObj).map((course) => {
    const courseId = str(course.courseId);
    const points = arr(course.points).filter(isObj).map((point) => {
      if (str(point.id).trim() !== '') return point;
      return { ...point, id: nodeIdFor(courseId, point.no, point.title) };
    });
    return { ...course, points };
  });
  return { ...base, courses };
}

/**
 * 规划「要给哪些知识点建节点」。已存在（同 id，或同课程+同节+同名的旧节点）的一律跳过。
 * @returns {{creations: object[], skipped: Array<{title: string, reason: string}>}}
 */
export function planNodeCreations(analysisDoc, networkDoc, outlineDoc) {
  const existing = arr(networkDoc?.nodes).filter(isObj);
  const byId = new Set(existing.map((node) => str(node.id)).filter(Boolean));
  const byName = new Set(existing.map((node) => `${str(node.courseId)}|${str(node.section)}|${str(node.name)}`));
  const creations = [];
  const skipped = [];
  for (const course of arr(analysisDoc?.courses).filter(isObj)) {
    const courseId = str(course.courseId);
    for (const point of arr(course.points).filter(isObj)) {
      const title = str(point.title).trim();
      if (title === '') { skipped.push({ title: '(无标题)', reason: 'point-without-title' }); continue; }
      const explicitId = str(point.id).trim();
      const sectionNo = str(point.no).trim();
      const id = explicitId !== '' ? explicitId : nodeIdFor(courseId, sectionNo, title);
      if (byId.has(id)) { skipped.push({ title, reason: 'id-exists' }); continue; }
      const parts = splitSectionNo(sectionNo);
      const nameKey = `${courseId}|${parts.section}|${title}`;
      if (byName.has(nameKey)) { skipped.push({ title, reason: 'same-name-node-exists' }); continue; }
      const chapter = str(point.chapter).trim() !== ''
        ? str(point.chapter).trim()
        : chapterLabelFromOutline(outlineDoc, courseId, parts.chapterNo);
      creations.push({
        id,
        name: title,
        courseId,
        chapter,
        section: str(point.section).trim() !== '' ? str(point.section).trim() : parts.section,
        subsection: str(point.subsection).trim() !== '' ? str(point.subsection).trim() : parts.subsection,
        aliases: arr(point.aliases).map(str).filter(Boolean),
        mastery: 0,
        marked: false,
        reviewedAt: '',
        note: '',
        evidence: [],
        createdAt: new Date().toISOString(),
      });
      byId.add(id);
      byName.add(nameKey);
    }
  }
  return { creations, skipped };
}

/** 把规划出来的节点并进 知识点网络.json 文档（纯函数，不写盘）。 */
export function applyNodeCreations(networkDoc, creations) {
  const base = isObj(networkDoc) ? networkDoc : {};
  const nodes = arr(base.nodes).filter(isObj).map((node) => ({ ...node }));
  for (const node of arr(creations).filter(isObj)) nodes.push({ ...node });
  return { ...base, nodes, updatedAt: new Date().toISOString() };
}

/**
 * 结构校验。`nodeIds`（可选，通常来自 知识点网络.json）给了就顺便查「详解是否有对应节点」「节点是否缺详解」。
 * @returns {{ok: boolean, issues: Array<{level:'error'|'warn'|'info', code: string, message: string}>}}
 */
export function validateAnalysis(doc, options = {}) {
  const issues = [];
  const push = (level, code, message) => issues.push({ level, code, message });
  if (!isObj(doc)) return { ok: false, issues: [{ level: 'error', code: 'not-an-object', message: '文档不是对象' }] };
  if (doc.version !== DOC_VERSION) push('error', 'bad-version', `version 应为 ${DOC_VERSION}，实际 ${String(doc.version)}`);
  if (!Array.isArray(doc.courses)) push('error', 'bad-field', 'courses 必须是数组');
  if (!Array.isArray(doc.runs)) push('error', 'bad-field', 'runs 必须是数组');

  const nodeIds = options.nodeIds instanceof Set ? options.nodeIds : null;
  const seenCourse = new Set();
  const seenPoint = new Set();
  for (const course of arr(doc.courses).filter(isObj)) {
    const courseId = str(course.courseId);
    if (courseId === '') push('error', 'missing-course-id', '有一门课没有 courseId');
    else if (seenCourse.has(courseId)) push('error', 'duplicate-course', `课程 ${courseId} 重复`);
    else seenCourse.add(courseId);
    for (const point of arr(course.points).filter(isObj)) {
      const id = str(point.id);
      if (id === '') { push('error', 'missing-point-id', `${courseId} 有知识点没有 id`); continue; }
      if (seenPoint.has(id)) push('error', 'duplicate-point', `知识点 id 重复：${id}`);
      seenPoint.add(id);
      if (str(point.title).trim() === '') push('warn', 'missing-title', `${id} 没有标题`);
      if (str(point.explain).trim() === '') push('warn', 'missing-explain', `${id} 没有详解正文`);
      if (arr(point.sources).length === 0) push('warn', 'missing-source', `${id} 没有出处（来历要点开原文）`);
      for (const source of arr(point.sources).filter(isObj)) {
        if (str(source.file).trim() === '') push('warn', 'source-without-file', `${id} 的出处没写文件`);
      }
      if (nodeIds && !nodeIds.has(id)) push('info', 'point-not-in-network', `${id} 在详解里但不在 知识点网络.json`);
    }
    for (const chapter of arr(course.chapters).filter(isObj)) {
      for (const exercise of arr(chapter.exercises).filter(isObj)) {
        if (str(exercise.prompt).trim() === '') push('warn', 'exercise-without-prompt', `${courseId} 第 ${String(chapter.no)} 章习题 ${String(exercise.no)} 没有题干`);
        for (const knowledge of arr(exercise.knowledge)) {
          if (nodeIds && !nodeIds.has(str(knowledge))) push('info', 'exercise-knowledge-missing', `习题 ${String(exercise.no)} 指向不存在的知识点 ${str(knowledge)}`);
        }
      }
    }
  }
  return { ok: issues.every((item) => item.level !== 'error'), issues };
}

/** 跳步词：详解里出现这些，等于把读者挡在半路（面板只显示这一段正文，读者看不到你的屏幕）。 */
const STEP_JUMP_PATTERN = /见上文|如上文|见下表|如下表|见下图|如上图|同上|参见上/u;
/** 轻量 Markdown 标记：`**粗体**`、反引号代码、`$公式$`。面板从 2026-10-26 起能渲染，闸门只提醒不拦。 */
const MARKDOWN_PATTERN = /\*\*[^*\n]+\*\*|`[^`\n]+`|\$[^$\n]{2,}\$/u;

/**
 * 单条知识点的**质量闸门**（`--gate`）。与结构校验分工：`validateAnalysis` 保「能读」，这里保「能看」。
 * 规则照 `_工具/资料分析会话-执行命令_20261023.md` §6（explain ≥ 300 字、keywords ≥ 3、pitfalls ≥ 2、
 * examples ≥ 1、sources ≥ 1、出处文件必须在 资料索引.json 里、页码合法、不跳步），门槛可用 options 覆盖。
 * 只做纯判定，不写盘、不改文档。
 * @param {object} point 合并后的知识点（不是 patch 里的半成品——patch 只改一个字段时也要能过）
 * @param {{minExplain?: number, minKeywords?: number, minPitfalls?: number, minExamples?: number, minSources?: number, indexedPaths?: Set<string>}} [options]
 * @returns {Array<{level: 'error'|'warn', code: string, message: string}>}
 */
export function validatePointQuality(point, options = {}) {
  if (!isObj(point)) return [{ level: 'error', code: 'point-not-object', message: '知识点不是对象' }];
  const issues = [];
  const push = (level, code, message) => issues.push({ level, code, message });
  const limit = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback);
  const minExplain = limit(options.minExplain, 300);
  const minKeywords = limit(options.minKeywords, 3);
  const minPitfalls = limit(options.minPitfalls, 2);
  const minExamples = limit(options.minExamples, 1);
  const minSources = limit(options.minSources, 1);
  const indexedPaths = options.indexedPaths instanceof Set ? options.indexedPaths : null;
  const id = str(point.id).trim() || '(无 id)';

  if (str(point.title).trim() === '') push('error', 'missing-title', `${id} 没有标题`);

  const explain = str(point.explain).trim();
  const chars = explain.replace(/\s+/gu, '').length;
  if (chars < minExplain) push('error', 'explain-too-short', `${id} 详解 ${chars} 字（门槛 ${minExplain}）：先补够再落盘`);
  if (STEP_JUMP_PATTERN.test(explain)) push('error', 'step-jump', `${id} 详解里有「见上文 / 如下表」式跳步：读者看不到你的屏幕`);

  const keywords = arr(point.keywords).map((item) => str(item).trim()).filter(Boolean);
  if (keywords.length < minKeywords) push('error', 'keywords-too-few', `${id} 关键词 ${keywords.length} 个（门槛 ${minKeywords}）`);

  const pitfalls = arr(point.pitfalls).map((item) => str(item).trim()).filter(Boolean);
  if (pitfalls.length < minPitfalls) push('error', 'pitfalls-too-few', `${id} 易错点 ${pitfalls.length} 条（门槛 ${minPitfalls}）`);
  if (pitfalls.some((item) => /^注意|注意[。！!]?$/u.test(item))) push('warn', 'pitfall-vague', `${id} 易错点只写「注意」：要写错在哪 + 怎么避免`);

  const examples = arr(point.examples).filter(isObj);
  if (examples.length < minExamples) push('error', 'examples-too-few', `${id} 例题 ${examples.length} 道（门槛 ${minExamples}）`);
  examples.forEach((example, at) => {
    const label = `${id} 例题${at + 1}`;
    if (str(example.prompt).trim() === '') push('error', 'example-without-prompt', `${label} 没有题干`);
    if (arr(example.steps).map((step) => str(step).trim()).filter(Boolean).length === 0) push('error', 'example-without-steps', `${label} 没有步骤`);
    if (str(example.answer).trim() === '') push('error', 'example-without-answer', `${label} 没有答案`);
  });

  const sources = arr(point.sources).filter(isObj);
  if (sources.length < minSources) push('error', 'sources-too-few', `${id} 出处 ${sources.length} 条（门槛 ${minSources}）`);
  sources.forEach((source, at) => {
    const file = str(source.file).trim();
    if (file === '') {
      push('error', 'source-without-file', `${id} 出处${at + 1} 没写文件`);
      return;
    }
    if (indexedPaths && !indexedPaths.has(file)) push('error', 'source-file-not-indexed', `${id} 出处文件不在 资料索引.json 里：${file}`);
    if (source.page !== null && source.page !== undefined && source.page !== '') {
      const page = Number(source.page);
      if (!Number.isInteger(page) || page <= 0) push('error', 'source-page-invalid', `${id} 出处${at + 1} 页码不合法：${String(source.page)}（用 PDF 页序，不确定写 null）`);
    }
  });

  if (str(point.analogy).trim() === '') push('warn', 'missing-analogy', `${id} 没写「打个比方」`);
  arr(point.formulas).filter(isObj).forEach((formula, at) => {
    if (str(formula.tex).trim() === '' || str(formula.plain).trim() === '') push('error', 'formula-incomplete', `${id} 公式${at + 1} 要 tex + plain 双写`);
  });

  // 插图（2026-10-26 加）：`figures: [{path, caption, page}]`，path 必须是 `学习台/图片/_index.json`
  // 登记过的相对路径。只查形状与白名单，不查文件本身——那由 `/materials/image` 运行时兜底。
  const imageIndex = options.imageIndex instanceof Set ? options.imageIndex : null;
  arr(point.figures).filter(isObj).forEach((figure, at) => {
    const label = `${id} 插图${at + 1}`;
    const file = str(figure.path).trim().replace(/\\/g, '/');
    if (file === '') {
      push('error', 'figure-without-path', `${label} 没写 path`);
      return;
    }
    if (imageIndex && !imageIndex.has(file)) push('error', 'figure-not-indexed', `${label} 不在 学习台/图片/_index.json 里：${file}`);
    if (str(figure.caption).trim() === '') push('warn', 'figure-without-caption', `${label} 没写图说`);
    if (figure.page !== null && figure.page !== undefined && figure.page !== '') {
      const page = Number(figure.page);
      if (!Number.isInteger(page) || page <= 0) push('error', 'figure-page-invalid', `${label} 页码不合法：${String(figure.page)}（用 PDF 页序，不确定写 null）`);
    }
  });

  // 轻量 Markdown（`**粗体**` / `` `代码` `` / `$…$`）：面板 2026-10-26 起能渲染，所以是 info 不是 error；
  // 留这条是为了统计「还有多少正文在裸写标记」，别让它悄悄变成 HTML 注入面。
  if (MARKDOWN_PATTERN.test(explain) || MARKDOWN_PATTERN.test(str(point.analogy))) {
    push('info', 'markdown-in-text', `${id} 正文里有 **粗体** / \`代码\` / $公式$ 标记：面板能渲染，但三种混写要克制`);
  }

  return issues;
}

/**
 * `--gate` 的判定核心：把 patch 里要写的点映射到「合并后文档」（建议先过 `ensurePointIds`）的最终值，
 * 再逐点过质量闸门。`issues` 里有 level==='error' 时调用方必须拒绝写盘。
 */
export function gatePatchQuality(patch, mergedDoc, options = {}) {
  const indexedPaths = options.indexedPaths ?? null;
  const patchCourses = Array.isArray(patch?.courses) ? patch.courses : (isObj(patch) && patch.courseId ? [patch] : []);
  const pointIds = [];
  for (const patchCourse of patchCourses.filter(isObj)) {
    const courseId = str(patchCourse.courseId);
    for (const point of arr(patchCourse.points).filter(isObj)) {
      const explicitId = str(point.id).trim();
      const id = explicitId !== '' ? explicitId : nodeIdFor(courseId, point.no, point.title);
      if (!pointIds.includes(id)) pointIds.push(id);
    }
  }
  const pointIndex = buildPointIndex(mergedDoc);
  const issues = [];
  for (const id of pointIds) {
    const point = pointIndex.get(id);
    if (point) issues.push(...validatePointQuality(point, { ...options, indexedPaths }));
    else issues.push({ level: 'error', code: 'gate-point-missing', message: `${id} 合并后在文档里找不到（patch 的 id/节号/标题对不上）` });
  }
  return { ok: issues.every((item) => item.level !== 'error'), issues, pointIds };
}

function parseArgs(argv) {
  const out = {
    dataDir: DEFAULT_DATA_DIR,
    apply: false,
    json: false,
    init: false,
    validate: false,
    gate: false,
    merge: '',
    createNodes: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--init') out.init = true;
    else if (arg === '--validate') out.validate = true;
    else if (arg === '--gate') out.gate = true;
    else if (arg === '--create-nodes') out.createNodes = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--data') { i += 1; out.dataDir = path.resolve(argv[i] ?? out.dataDir); }
    else if (arg === '--merge') { i += 1; out.merge = path.resolve(argv[i] ?? ''); }
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

async function loadNodeIds(dataDir) {
  const file = path.join(dataDir, DOC_FILES.knowledgeNetwork);
  if (!fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(arr(doc?.nodes).filter(isObj).map((node) => str(node.id)).filter(Boolean));
  } catch {
    return null;
  }
}

/** 读 JSON 文件，容忍 UTF-8 BOM（Windows 记事本 / PowerShell `Set-Content -Encoding UTF8` 都会加 BOM）。 */
function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

/** 读一份 JSON（读不到/坏了返回 null，不抛）。 */
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}

/** 读 `资料索引.json` 里登记过的 path 集合（质量闸门判「出处是否真存在」用）。读不到返回 null（跳过这一条检查）。 */
async function loadIndexedPaths(dataDir) {
  const doc = readJsonIfExists(path.join(dataDir, DOC_FILES.materials));
  if (!doc) return null;
  return new Set(arr(doc.files).filter(isObj).map((file) => str(file.path).trim()).filter(Boolean));
}

/**
 * 插图白名单：`学习台/图片/_index.json` 的 `images[].path`。
 *
 * 与 `loadIndexedPaths` 同一套路：文件不存在就回 null（此时闸门跳过白名单判定），
 * 存在就只认登记过的路径。裁图与登记见 `_工具/学习台-插图裁切规范.md`。
 */
async function loadImageIndex(dataDir) {
  const doc = readJsonIfExists(path.join(dataDir, IMAGE_DIR_NAME, '_index.json'));
  if (!doc) return null;
  return new Set(arr(doc.images).filter(isObj).map((item) => str(item.path).trim().replace(/\\/g, '/')).filter(Boolean));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node tools/analysis.mjs [--init] [--validate] [--merge <patch.json> [--gate] [--create-nodes] [--apply]] [--data <目录>] [--json]');
    return 0;
  }
  const store = createStore(args.dataDir);
  const current = await store.readDocument('knowledgeAnalysis');
  const doc = current?.ok ? current.doc : emptyAnalysisDoc();
  const nodeIds = await loadNodeIds(args.dataDir);

  if (args.init) {
    const exists = fs.existsSync(path.join(args.dataDir, DOC_FILES.knowledgeAnalysis));
    if (exists) {
      console.log(`已存在：${path.join(args.dataDir, DOC_FILES.knowledgeAnalysis)}（不覆盖）`);
      return 0;
    }
    const result = await store.writeDocument('knowledgeAnalysis', emptyAnalysisDoc(), {});
    console.log(result.ok ? `已创建 ${DOC_FILES.knowledgeAnalysis}（${result.hash}）` : `创建失败：${result.reason}`);
    return result.ok ? 0 : 3;
  }

  let nextDoc = doc;
  let patchStats = null;
  let patch = null;
  if (args.merge !== '') {
    if (!fs.existsSync(args.merge)) {
      console.error(`patch 文件不存在：${args.merge}`);
      return 2;
    }
    patch = readJsonFile(args.merge);
    nextDoc = mergeAnalysis(doc, patch);
    patchStats = { before: analysisStats(doc), after: analysisStats(nextDoc) };
  }

  // --create-nodes：把 patch 里「知识点网络.json 还没有的」知识点补成节点（先规划，写盘放到校验通过之后）
  let nodePlan = null;
  let nextNetwork = null;
  const networkFile = path.join(args.dataDir, DOC_FILES.knowledgeNetwork);
  if (args.createNodes && args.merge !== '') {
    nextDoc = ensurePointIds(nextDoc);
    const networkDoc = readJsonIfExists(networkFile);
    const outlineDoc = readJsonIfExists(path.join(args.dataDir, DOC_FILES.knowledgeOutline));
    nodePlan = planNodeCreations(nextDoc, networkDoc, outlineDoc);
    if (nodePlan.creations.length > 0) {
      nextNetwork = applyNodeCreations(networkDoc, nodePlan.creations);
      if (nodeIds) for (const node of nodePlan.creations) nodeIds.add(node.id);
    }
  }

  const validation = validateAnalysis(nextDoc, { nodeIds });
  const stats = analysisStats(nextDoc);

  // --gate：质量闸门。只查「本次 patch 要写的点」，而且查**合并后**的最终值（patch 允许只改一个字段）
  let gate = null;
  if (args.gate && patch !== null) {
    // 先补 id，再按最终值查——否则「patch 不写 id、靠 --create-nodes 建点」的写法会被误判成「找不到点」
    gate = gatePatchQuality(patch, ensurePointIds(nextDoc), {
      indexedPaths: await loadIndexedPaths(args.dataDir),
      imageIndex: await loadImageIndex(args.dataDir),
    });
  }

  const summary = { dataDir: args.dataDir, applied: false, stats, validation, patch: patchStats, nodes: nodePlan, gate };

  if (args.validate && !validation.ok) summary.failed = true;
  if (gate !== null && !gate.ok) summary.failed = true;

  if (args.apply && args.merge !== '') {
    if (!validation.ok) {
      console.error('校验没过（有 error），拒绝写盘：');
      for (const issue of validation.issues.filter((item) => item.level === 'error')) console.error(`  - ${issue.code}: ${issue.message}`);
      return 1;
    }
    if (gate !== null && !gate.ok) {
      console.error('质量闸门没过（--gate），拒绝写盘：');
      for (const issue of gate.issues.filter((item) => item.level === 'error')) console.error(`  - ${issue.code}: ${issue.message}`);
      return 1;
    }
    // 先写节点（网络文档体积小），再写详解；两步都经 store（原子写 + 备份 + 冲突检测）
    if (nextNetwork !== null) {
      const nodeResult = await store.writeDocument('knowledgeNetwork', nextNetwork, {});
      summary.nodesApplied = Boolean(nodeResult.ok);
      summary.nodesHash = nodeResult.hash ?? null;
      if (!nodeResult.ok) {
        console.error(`建节点失败（${nodeResult.reason}），详解未写盘`);
        return 1;
      }
    }
    const result = await store.writeDocument('knowledgeAnalysis', nextDoc, {});
    summary.applied = Boolean(result.ok);
    summary.hash = result.hash ?? null;
    if (!result.ok) summary.reason = result.reason;
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (!args.quiet) {
    const lines = [];
    lines.push(`文档：${path.join(args.dataDir, DOC_FILES.knowledgeAnalysis)}`);
    lines.push(`合计：${stats.totalPoints} 个知识点 / ${stats.totalExercises} 道教材习题 / ${stats.runs} 条生成记录`);
    for (const course of stats.courses) {
      if (course.points === 0 && course.exercises === 0 && course.ppt === 0 && course.homework === 0) continue;
      lines.push(`  ${course.courseId} ${course.name}：知识点 ${course.points}（有详解 ${course.withExplain}、带例题 ${course.withExample}）`
        + ` / 章 ${course.chapters}（习题 ${course.exercises}）/ PPT ${course.ppt} 讲（要点 ${course.pptPoints}）/ 作业 ${course.homework} 次（题 ${course.homeworkQuestions}）`);
    }
    if (patchStats) {
      lines.push(`合并前：${patchStats.before.totalPoints} 点 / ${patchStats.before.totalExercises} 习题 / ${patchStats.before.runs} run`);
      lines.push(`合并后：${patchStats.after.totalPoints} 点 / ${patchStats.after.totalExercises} 习题 / ${patchStats.after.runs} run`);
      lines.push(args.apply ? '（已写盘；旧版在 学习台/备份/）' : '（未加 --apply，没有写盘）');
    }
    const counts = { error: 0, warn: 0, info: 0 };
    for (const issue of validation.issues) counts[issue.level] += 1;
    lines.push(`校验：error ${counts.error} / warn ${counts.warn} / info ${counts.info}`);
    if (gate !== null) {
      const gateCounts = { error: 0, warn: 0 };
      for (const issue of gate.issues) gateCounts[issue.level] += 1;
      lines.push(`质量闸门（--gate）：error ${gateCounts.error} / warn ${gateCounts.warn}`
        + (gateCounts.error > 0 ? ' —— 目前带 --apply 会被拒绝写盘' : ''));
      for (const issue of gate.issues.filter((item) => item.level === 'error').slice(0, 15)) {
        lines.push(`  [error] ${issue.code}: ${issue.message}`);
      }
      const warns = gate.issues.filter((item) => item.level === 'warn').slice(0, 5);
      for (const issue of warns) lines.push(`  [warn] ${issue.code}: ${issue.message}`);
    }
    if (!validation.ok || args.validate) {
      for (const issue of validation.issues.slice(0, 30)) lines.push(`  [${issue.level}] ${issue.code}: ${issue.message}`);
    }
    console.log(lines.filter((line) => line !== '').join('\n'));
  }
  if (summary.failed) return 1;
  return summary.applied ? 0 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(2);
  });
}
