#!/usr/bin/env node
/**
 * knowledge-audit —— 只读体检：知识点网络 ↔ 教材大纲 ↔ 题目 三方对得上吗。
 *
 * 为什么要有这个工具：树是靠「节点.chapter / section / subsection」去挂大纲的，任何一处写错，
 * 节点就会静默掉进「未分节 / 未归类」——界面不报错、数据也不坏，只是怎么都找不到。等真发现时
 * 已经攒了几十个。这里把「挂不上」和「证据悬空」一次列清楚，改数据前先看它。
 *
 * 检查项（level 分 info / warn / error）：
 *   - unknown-course        课程在《知识点大纲》里没有（该课整门只能退回老树）
 *   - chapter-not-in-outline  章名在大纲里找不到 → 会掉进「未归类」
 *   - section-not-in-chapter  节号在该章下找不到 → 会掉进「未分节」
 *   - subsection-not-in-section 小节号在该节下找不到 → 挂到节级
 *   - unmounted             section 空（大纲存在但节点没挂）——info，属于待办不是错
 *   - no-evidence           没有任何题/资料页证据（info）
 *   - missing-question      证据里的题 id 在 `题目.json` 里没有（warn，题干会显示「题干缺失」）
 *   - duplicate-node-id     节点 id 重复（error，/mutate 会改错对象）
 *
 * 用法：
 *   node tools/knowledge-audit.mjs                 # 人读报告
 *   node tools/knowledge-audit.mjs --json          # 机器可读
 *   node tools/knowledge-audit.mjs --course c_ds    # 只看一门课
 *   node tools/knowledge-audit.mjs --strict        # 有 error 级问题时退出码 1
 *   node tools/knowledge-audit.mjs --data <学习台目录>
 *
 * 退出码：0 正常（--strict 下无 error）；1 --strict 且存在 error；2 参数/环境错误。
 * 本工具**只读**：不写任何文件、不碰 `学习台/`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');

const DOC_FILES = {
  network: '知识点网络.json',
  outline: '知识点大纲.json',
  questions: '题目.json',
  courses: '课程.json',
};

/** 章/节/小节号归一：去 `§`、去空白、全角数字转半角——目录与节点常在这几处写法不同。 */
export function normalizeNo(value) {
  return String(value ?? '')
    .trim()
    .replace(/^§\s*/, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

/** 从「第 2 章 向量」「2 向量」「第2章」里抠出章号；抠不到回 null。 */
export function chapterNo(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const first = /^第\s*(\d{1,2})\s*章/.exec(text);
  if (first !== null) return Number(first[1]);
  const bare = /^(\d{1,2})(?![\d.])/.exec(text);
  return bare === null ? null : Number(bare[1]);
}

/**
 * 大纲查表：`{ [courseId]: { book, chapters: Map<no, {title, sections: Map<no, {subs:Set}>}> } }`。
 * 全部按数值/归一后的编号存，节点那边同样归一后再查。
 */
export function buildOutlineIndex(outline) {
  const index = new Map();
  for (const course of Array.isArray(outline?.courses) ? outline.courses : []) {
    const courseId = String(course?.courseId ?? '').trim();
    if (courseId === '') continue;
    const chapters = new Map();
    for (const chapter of Array.isArray(course?.chapters) ? course.chapters : []) {
      const no = Number(chapter?.no);
      if (!Number.isFinite(no)) continue;
      const sections = new Map();
      for (const section of Array.isArray(chapter?.sections) ? chapter.sections : []) {
        const sectionNo = normalizeNo(section?.no);
        if (sectionNo === '') continue;
        const subs = new Set();
        for (const sub of Array.isArray(section?.subs) ? section.subs : []) {
          const subNo = normalizeNo(sub?.no);
          if (subNo !== '') subs.add(subNo);
        }
        sections.set(sectionNo, { subs });
      }
      chapters.set(no, { title: String(chapter?.title ?? ''), sections });
    }
    index.set(courseId, { book: String(course?.['book'] ?? ''), chapters });
  }
  return index;
}

/**
 * 体检主函数（纯函数，便于单测）：网络 + 大纲 + 题目 + 课程 → 统计与问题清单。
 * 不读盘、不改任何入参。
 */
export function auditKnowledge({ network = {}, outline = {}, questions = [], courses = [] } = {}) {
  const nodes = Array.isArray(network?.nodes) ? network.nodes : [];
  const questionIds = new Set(
    (Array.isArray(questions) ? questions : [])
      .map((item) => (item?.id === undefined || item?.id === null ? '' : String(item.id)))
      .filter((id) => id !== ''),
  );
  const outlineIndex = buildOutlineIndex(outline);
  const courseNames = new Map();
  for (const course of Array.isArray(courses) ? courses : []) {
    const id = String(course?.id ?? '').trim();
    if (id !== '') courseNames.set(id, String(course?.name ?? id));
  }

  const issues = [];
  const seenIds = new Set();
  const courseStats = new Map();
  const stat = (courseId) => {
    if (!courseStats.has(courseId)) {
      courseStats.set(courseId, {
        courseId,
        name: courseNames.get(courseId) ?? (outlineIndex.has(courseId) ? courseId : '（未知课程）'),
        total: 0,
        mounted: 0,
        unmounted: 0,
        noEvidence: 0,
        chapters: new Map(),
      });
    }
    return courseStats.get(courseId);
  };

  for (const node of nodes) {
    const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
    const name = String(node?.name ?? '(未命名)');
    const courseId = String(node?.courseId ?? '').trim();
    const entry = stat(courseId);
    entry.total += 1;

    if (id !== '') {
      if (seenIds.has(id)) {
        issues.push({ level: 'error', type: 'duplicate-node-id', nodeId: id, name, message: `节点 id 重复：${id}` });
      } else {
        seenIds.add(id);
      }
    }

    const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
    if (evidence.length === 0) {
      entry.noEvidence += 1;
      issues.push({ level: 'info', type: 'no-evidence', nodeId: id, name, message: '没有任何题/资料页支撑' });
    }
    for (const item of evidence) {
      if (item?.type !== 'question') continue;
      const questionId = item?.id === undefined || item?.id === null ? '' : String(item.id);
      if (questionId === '') continue;
      if (!questionIds.has(questionId)) {
        issues.push({
          level: 'warn',
          type: 'missing-question',
          nodeId: id,
          name,
          message: `证据题 ${questionId} 在 题目.json 里不存在（会显示「题干缺失」）`,
        });
      }
    }

    const courseOutline = outlineIndex.get(courseId);
    const sectionNo = normalizeNo(node?.section);
    if (sectionNo === '') entry.unmounted += 1;
    else entry.mounted += 1;

    const chapterLabel = String(node?.chapter ?? '').trim();
    if (chapterLabel === '') {
      issues.push({ level: 'info', type: 'no-chapter', nodeId: id, name, message: '节点没有章名' });
      continue;
    }
    if (courseOutline === undefined) {
      if (outlineIndex.size > 0) {
        issues.push({ level: 'info', type: 'unknown-course', nodeId: id, name, message: `课程 ${courseId} 在《知识点大纲》里没有条目（整门退回老树）` });
      }
      continue;
    }

    const no = chapterNo(chapterLabel);
    const chapter = no === null ? undefined : courseOutline.chapters.get(no);
    if (chapter === undefined) {
      issues.push({ level: 'warn', type: 'chapter-not-in-outline', nodeId: id, name, message: `章「${chapterLabel}」在大纲里找不到 → 会掉进「未归类」` });
      continue;
    }
    if (!entry.chapters.has(no)) entry.chapters.set(no, { chapter: chapterLabel, total: 0, mounted: 0 });
    const chapterEntry = entry.chapters.get(no);
    chapterEntry.total += 1;
    if (sectionNo !== '') chapterEntry.mounted += 1;

    if (sectionNo === '') continue;
    const section = chapter.sections.get(sectionNo);
    if (section === undefined) {
      issues.push({ level: 'warn', type: 'section-not-in-chapter', nodeId: id, name, message: `节 ${sectionNo} 不在「${chapterLabel}」的大纲里 → 会掉进「未分节」` });
      continue;
    }
    const subNo = normalizeNo(node?.subsection);
    if (subNo !== '' && !section.subs.has(subNo)) {
      issues.push({ level: 'info', type: 'subsection-not-in-section', nodeId: id, name, message: `小节 ${subNo} 不在节 ${sectionNo} 的大纲里 → 只挂到节级` });
    }
  }

  const coursesOut = [...courseStats.values()].map((entry) => ({
    ...entry,
    chapters: [...entry.chapters.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([no, item]) => ({ no, ...item })),
  }));
  // 每条问题挂上 courseId：`--course` 过滤才有意义（原来只按消息过滤，等于不过滤）
  const nodeCourse = new Map();
  for (const node of nodes) {
    const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
    if (id !== '') nodeCourse.set(id, String(node?.courseId ?? '').trim());
  }
  const withCourse = issues.map((issue) => ({ ...issue, courseId: nodeCourse.get(issue.nodeId) ?? '' }));
  const order = { error: 0, warn: 1, info: 2 };
  withCourse.sort((a, b) => order[a.level] - order[b.level] || a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh'));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const issue of withCourse) counts[issue.level] += 1;
  return { courses: coursesOut, issues: withCourse, counts, nodes: nodes.length };
}

export function parseArgs(argv) {
  const args = { dataDir: DEFAULT_DATA_DIR, json: false, strict: false, courseId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data') args.dataDir = path.resolve(String(argv[++index] ?? ''));
    else if (item === '--course') args.courseId = String(argv[++index] ?? '').trim();
    else if (item === '--json') args.json = true;
    else if (item === '--strict') args.strict = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  return args;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadDocuments(dataDir) {
  const read = (name) => readJson(path.join(dataDir, name));
  const network = read(DOC_FILES.network);
  if (network === null) throw new Error(`找不到 ${path.join(dataDir, DOC_FILES.network)}`);
  const outline = read(DOC_FILES.outline) ?? { courses: [] };
  const questionsDoc = read(DOC_FILES.questions);
  const questions = Array.isArray(questionsDoc?.questions) ? questionsDoc.questions : [];
  const coursesDoc = read(DOC_FILES.courses);
  const courses = Array.isArray(coursesDoc?.courses) ? coursesDoc.courses : [];
  return { network, outline, questions, courses };
}

function printReport(result, courseId) {
  console.log(`知识点体检：${result.nodes} 个节点` + (courseId === '' ? '' : `（只看 ${courseId} 的课，统计仍按全量算）`));
  for (const course of result.courses) {
    const mountedPart = course.unmounted > 0 ? `${course.mounted} 已挂节 / ${course.unmounted} 未挂` : `${course.mounted} 已挂节`;
    console.log(`  ${course.name}（${course.courseId || '无课程'}）：${course.total} 个节点，${mountedPart}` + (course.noEvidence > 0 ? `，${course.noEvidence} 个无证据` : ''));
    for (const chapter of course.chapters) {
      console.log(`    ${chapter.chapter}：${chapter.total} 个（已挂 ${chapter.mounted}）`);
    }
  }
  const filtered = courseId === '' ? result.issues : result.issues.filter((issue) => issue.courseId === courseId);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const issue of filtered) counts[issue.level] += 1;
  console.log(`\n问题 ${filtered.length} 条 —— error ${counts.error} / warn ${counts.warn} / info ${counts.info}`);
  for (const issue of filtered) {
    const tag = issue.level === 'error' ? '✗' : issue.level === 'warn' ? '!' : '·';
    console.log(`  ${tag} [${issue.type}] ${issue.name}：${issue.message}`);
  }
  if (filtered.length === 0) console.log('  没有发现问题。');
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 2;
  }
  if (args.help === true) {
    console.log('node tools/knowledge-audit.mjs [--json] [--strict] [--course <课程id>] [--data <学习台目录>]');
    return 0;
  }
  let docs;
  try {
    docs = loadDocuments(args.dataDir);
  } catch (error) {
    console.error(`读取失败：${String(error?.message ?? error)}`);
    return 2;
  }
  const result = auditKnowledge(docs);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result, args.courseId);
  return args.strict === true && result.counts.error > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
