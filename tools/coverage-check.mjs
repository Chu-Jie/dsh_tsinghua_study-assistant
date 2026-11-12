/**
 * 覆盖率检查（零依赖）
 * 运行：node tools/coverage-check.mjs [--course=<id>] [--json[=文件]]
 *
 * 目的：内容线 v3 的「有没有漏」体检。读三份文档——资料分析（`资料分析.json`）、
 * 知识点大纲（`知识点大纲.json`）、知识映射（`知识映射.json`）——输出三类清单：
 *   1. noSource     —— 资料分析里「没有任何出处（sources 为空）」的知识点；
 *   2. emptySections —— 知识点大纲里声明了「章」，但资料分析里该章一个知识点都没有的章；
 *   3. pptUnmapped  —— 资料分析里有 PPT 讲次，但知识映射里没有任何点挂到该讲的讲次。
 *                      点记录的 PPT 来源在 `pptSources:[{file,slide}]` 里（无讲次号），
 *                      需用 file 去资料分析的 `ppt[].titlePoints[].source.file` 反查讲次；
 *                      查不到的文件计入 pptUnrecognizedFiles，不静默丢弃。
 *
 * 设计取向：
 *   - 纯函数 computeCoverage() 便于单测（tests/coverage-check.test.js），CLI 只负责读盘 + 打印；
 *   - 空数据不报错：缺文档按「空」处理，输出三个空数组；
 *   - 只读：绝不写 `学习台/` 下的任何文档；`--json` 只写调用方指定的输出文件。
 *
 * 用法示例：
 *   node tools/coverage-check.mjs
 *   node tools/coverage-check.mjs --course=c_digital
 *   node tools/coverage-check.mjs --json
 *   node tools/coverage-check.mjs --json=_工具\覆盖率报告.json
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 工作区 = <repo>/../.. ；数据目录 = 工作区/学习台（与 lib/store.js 的默认 dataDir 一致）
const DEFAULT_WORKSPACE = path.resolve(HERE, '..', '..', '..');
const DEFAULT_DATA_DIR = path.join(DEFAULT_WORKSPACE, '学习台');

/** 从文档的 points.groups 结构里安全取出每门课的 points 数组。 */
function coursePoints(course) {
  return Array.isArray(course?.points) ? course.points : [];
}

/** 把文件路径归一化：去空白、反斜杠转正斜杠、转小写（用于 file→讲次 反查）。 */
function normFilePath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').toLowerCase();
}

/** 取归一化路径的文件名部分（basename），作为反查的兜底键。 */
function fileBasename(p) {
  const s = normFilePath(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 按课程建「PPT 文件 → 讲次号」反查表。
 * 依据：资料分析.json 里 `ppt[].lecture`（如 "L01"）与 `ppt[].titlePoints[].source.file`
 * 配对，把每个文件映射到它所属的讲次；同时留一个 basename 兜底表防止路径前缀差异。
 * @param {object} analysisCourse 资料分析里的一门课
 * @returns {{byPath: Map<string,string>, byBase: Map<string,string>}}
 */
function buildFileToLecture(analysisCourse) {
  const byPath = new Map();
  const byBase = new Map();
  const lectures = Array.isArray(analysisCourse?.ppt) ? analysisCourse.ppt : [];
  for (const lec of lectures) {
    const lecNo = lec?.lecture === undefined || lec?.lecture === null ? '' : String(lec.lecture).trim();
    if (lecNo === '') continue;
    const titlePoints = Array.isArray(lec?.titlePoints) ? lec.titlePoints : [];
    for (const tp of titlePoints) {
      const file = tp?.source?.file;
      if (!file) continue;
      const np = normFilePath(file);
      if (!byPath.has(np)) byPath.set(np, lecNo);
      const base = fileBasename(file);
      if (!byBase.has(base)) byBase.set(base, lecNo);
    }
  }
  return { byPath, byBase };
}

/** 用反查表把某个 PPT 文件解析成讲次号；解析不到返回 null。 */
function resolveLectureFromFile(file, fileToLecture) {
  if (!file || !fileToLecture) return null;
  const np = normFilePath(file);
  if (fileToLecture.byPath.has(np)) return fileToLecture.byPath.get(np);
  const base = fileBasename(file);
  if (fileToLecture.byBase.has(base)) return fileToLecture.byBase.get(base);
  return null;
}

/**
 * 从映射记录里尽量挖出它挂到的讲次号（兼容多种写法）。
 * @param {object} record 知识映射里的一条点记录
 * @param {{byPath: Map<string,string>, byBase: Map<string,string>}} [fileToLecture]
 *        可选的「PPT 文件 → 讲次」反查表；用于解析真实在用的 `pptSources[].file`。
 * @param {Set<string>} [unrecognized] 可选；收集查不到讲次的 `pptSources[].file`（不静默丢弃）。
 */
function lectureNosOf(record, fileToLecture, unrecognized) {
  const nos = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim() !== '') nos.push(v.trim());
    else if (typeof v === 'number') nos.push(String(v));
  };
  if (record === null || typeof record !== 'object') return nos;
  push(record.lecture);
  push(record.pptLecture);
  push(record.pptNo);
  if (Array.isArray(record.ppt)) for (const item of record.ppt) {
    if (item !== null && typeof item === 'object') { push(item.lecture); push(item.no); } else push(item);
  }
  if (Array.isArray(record.lectures)) for (const item of record.lectures) push(item);
  if (Array.isArray(record.sources)) {
    for (const item of record.sources) {
      if (item !== null && typeof item === 'object') push(item.lecture);
    }
  }
  // 真实在用的 PPT 来源：pptSources:[{file, slide, importance}]，只有 file/slide、没有讲次号，
  // 必须用 file 去资料分析的 ppt[].titlePoints[].source.file 反查讲次；查不到的文件计入
  // unrecognized，交调用方打印，不静默丢弃。
  if (Array.isArray(record.pptSources)) {
    for (const item of record.pptSources) {
      if (item === null || typeof item !== 'object') continue;
      const lecture = resolveLectureFromFile(item.file, fileToLecture);
      if (lecture !== null) push(lecture);
      else if (unrecognized && typeof item.file === 'string' && item.file !== '') unrecognized.add(item.file);
    }
  }
  return nos;
}

/** 把讲次号归一化（去掉前导 L/lec/l、讲/课 等噪声，只留可比对的数字段）。 */
function normLecture(no) {
  return String(no ?? '').trim().replace(/^[Ll]e?c(ture)?/i, '').replace(/^第/, '').replace(/讲$/, '').replace(/^0+(?=\d)/, '');
}

/**
 * 纯函数：用三份文档计算三类清单。
 * @param {object} analysisDoc 资料分析.json
 * @param {object} outlineDoc  知识点大纲.json
 * @param {object} mapDoc      知识映射.json
 * @param {{course?: string}} [options] course：只算这一门；缺省 = 全部
 * @returns {{noSource: object[], emptySections: object[], pptUnmapped: object[], pptUnrecognizedFiles: string[]}}
 */
export function computeCoverage(analysisDoc, outlineDoc, mapDoc, options = {}) {
  const onlyCourse = typeof options.course === 'string' && options.course.trim() !== '' ? options.course.trim() : null;
  const analyses = Array.isArray(analysisDoc?.courses) ? analysisDoc.courses : [];
  const outlines = Array.isArray(outlineDoc?.courses) ? outlineDoc.courses : [];
  const pointsMap = mapDoc !== null && typeof mapDoc === 'object' && mapDoc.points !== null && typeof mapDoc.points === 'object'
    ? mapDoc.points
    : {};

  const noSource = [];
  const emptySections = [];
  const pptUnmapped = [];
  // 记录 pptSources[].file 里在资料分析中反查不到讲次的文件（不静默丢弃，交调用方打印）
  const pptUnrecognized = new Set();

  const courses = new Set();
  for (const c of analyses) if (c?.courseId) courses.add(c.courseId);
  for (const c of outlines) if (c?.courseId) courses.add(c.courseId);

  for (const courseId of courses) {
    if (onlyCourse !== null && courseId !== onlyCourse) continue;
    const analysis = analyses.find((c) => c?.courseId === courseId);
    const outline = outlines.find((c) => c?.courseId === courseId);
    const points = coursePoints(analysis);

    // 1) 无出处知识点
    for (const point of points) {
      const sources = Array.isArray(point?.sources) ? point.sources : [];
      if (sources.length === 0) {
        noSource.push({ courseId, pointId: point?.id ?? null, no: point?.no ?? null, title: point?.title ?? '' });
      }
    }

    // 2) 空章节：大纲里声明的章号，在资料分析的知识点里一个都没有
    const declaredChapters = Array.isArray(outline?.chapters) ? outline.chapters : [];
    if (declaredChapters.length > 0) {
      const coveredChapters = new Set();
      for (const point of points) {
        const no = point?.no === undefined || point?.no === null ? '' : String(point.no).trim();
        const m = /^(\d+)/.exec(no);
        if (m !== null) coveredChapters.add(m[1]);
      }
      for (const chapter of declaredChapters) {
        const no = chapter?.no === undefined || chapter?.no === null ? '' : String(chapter.no).trim();
        if (no === '') continue;
        if (!coveredChapters.has(no)) {
          emptySections.push({ courseId, chapterNo: no, title: chapter?.title ?? '' });
        }
      }
    }

    // 3) PPT 漏映射：资料分析里有 PPT 讲次，但知识映射里没有点挂到该讲
    const lectures = Array.isArray(analysis?.ppt) ? analysis.ppt : [];
    if (lectures.length > 0) {
      // 先建「PPT 文件 → 讲次」反查表，用来解析点记录里真实在用的 pptSources[].file
      const fileToLecture = buildFileToLecture(analysis);
      const mappedLectures = new Set();
      for (const record of Object.values(pointsMap)) {
        // 只统计属于本课程的映射记录（记录里带 courseId 时才过滤，不带则算作全课程可见）
        if (record !== null && typeof record === 'object' && record.courseId !== undefined && record.courseId !== courseId) continue;
        for (const no of lectureNosOf(record, fileToLecture, pptUnrecognized)) mappedLectures.add(normLecture(no));
      }
      for (const lecture of lectures) {
        const lecNo = lecture?.lecture === undefined || lecture?.lecture === null ? '' : String(lecture.lecture).trim();
        if (lecNo === '') continue;
        if (!mappedLectures.has(normLecture(lecNo))) {
          pptUnmapped.push({ courseId, lecture: lecNo, title: lecture?.title ?? '' });
        }
      }
    }
  }

  return { noSource, emptySections, pptUnmapped, pptUnrecognizedFiles: [...pptUnrecognized] };
}

/** 读一份 JSON；不存在或损坏时返回 null（空数据不报错）。 */
async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * CLI 主流程。@param {string[]} argv @param {{dataDir?: string}} [io]
 * @returns {Promise<{code: number, result?: object}>}
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const dataDir = io.dataDir ?? process.env.DSH_STUDY_DATA_DIR ?? DEFAULT_DATA_DIR;

  let course = null;
  let jsonOut = null; // null = 不输出；'' = 输出到 stdout 可读 json；其他 = 写文件
  let jsonFlag = false;
  for (const arg of argv) {
    if (arg.startsWith('--course=')) {
      course = arg.slice('--course='.length);
    } else if (arg === '--json') {
      jsonFlag = true;
      jsonOut = '';
    } else if (arg.startsWith('--json=')) {
      jsonFlag = true;
      jsonOut = arg.slice('--json='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools/coverage-check.mjs [--course=<id>] [--json[=文件]]');
      return { code: 0 };
    }
  }

  const analysisDoc = await readJsonIfExists(path.join(dataDir, '资料分析.json'));
  const outlineDoc = await readJsonIfExists(path.join(dataDir, '知识点大纲.json'));
  const mapDoc = await readJsonIfExists(path.join(dataDir, '知识映射.json'));

  const result = computeCoverage(analysisDoc, outlineDoc, mapDoc, { course: course ?? undefined });

  // 人类可读尾巴
  const scope = course === null ? '全部课程' : `课程 ${course}`;
  console.log(`=== 覆盖率检查（${scope}，数据目录：${dataDir}）===`);
  console.log(`无出处知识点  noSource      : ${result.noSource.length} 条`);
  for (const item of result.noSource) console.log(`  · [${item.courseId}] ${item.no ?? '?'} ${item.title}（${item.pointId ?? '?'}）`);
  console.log(`空章节        emptySections : ${result.emptySections.length} 条`);
  for (const item of result.emptySections) console.log(`  · [${item.courseId}] 第 ${item.chapterNo} 章 ${item.title}`);
  console.log(`PPT 漏映射    pptUnmapped   : ${result.pptUnmapped.length} 条`);
  for (const item of result.pptUnmapped) console.log(`  · [${item.courseId}] ${item.lecture} ${item.title}`);
  const unrecognizedFiles = Array.isArray(result.pptUnrecognizedFiles) ? result.pptUnrecognizedFiles : [];
  console.log(`未识别 PPT 文件 pptUnrecognized : ${unrecognizedFiles.length} 个`);
  for (const file of unrecognizedFiles) console.log(`  · ${file}`);
  console.log(`合计待处理：${result.noSource.length + result.emptySections.length + result.pptUnmapped.length} 条`);

  if (jsonFlag) {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (jsonOut === '' || jsonOut === null) {
      console.log('\n--- JSON ---');
      console.log(text.trimEnd());
    } else {
      const target = path.isAbsolute(jsonOut) ? jsonOut : path.resolve(DEFAULT_WORKSPACE, jsonOut);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf8');
      console.log(`\n已写出 JSON：${target}`);
    }
  }

  return { code: 0, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(({ code }) => { if (code !== 0) process.exitCode = code; }).catch((error) => {
    console.error(`覆盖率检查异常：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
