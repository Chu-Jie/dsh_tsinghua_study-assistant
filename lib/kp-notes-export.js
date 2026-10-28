/**
 * kp-notes-export —— 把学习台的「知识点网络」镜像成 dsh-kp-notes 能直接读的笔记目录。
 *
 * 为什么要有这一层：学习台的资料页只有一个朴素 SVG 树（够看结构，不能写公式、不能画流程图），
 * 而 `dsh-kp-notes` 提供了现成的卡片画布 + 离线 KaTeX/mermaid 渲染。两边各有各的长处，
 * 与其在插件里重造渲染器，不如**把数据镜像过去**：学习台网络是唯一事实源，画布是只读视图。
 *
 * 目录约定（照 dsh-kp-notes 的 lib/util.js 的 classifyFile / notePathFor）：
 *   根目录/<章目录>/<序号>-<节点名>.md        笔记（frontmatter `type: point` 显式声明）
 *   根目录/questions/<章目录>/<同名>.md       题目（题目块用 `## 题目 N` 标题，答案用 `**答案**：`）
 *   根目录/_manifest.json                     本次生成了哪些文件（下次重跑据此清理陈旧文件）
 *
 * 用法：
 *   node tools/kp-notes-export.mjs                       # 生成到 <工作区>/学习台/知识画布
 *   node tools/kp-notes-export.mjs --out D:\某处\画布
 *   node tools/kp-notes-export.mjs --dry                 # 只打印计划，不写盘
 *   node tools/kp-notes-export.mjs --check               # 有差异就退出码 1（CI/验收用）
 *   node tools/kp-notes-export.mjs --no-prune            # 不清陈旧文件（默认清，且只清自己生成的）
 *   node tools/kp-notes-export.mjs --data <学习台目录>    # 默认 <工作区>/学习台
 *
 * 安全边界：只写 `--out` 下面、只删**上一份 manifest 里登记过**的文件；别处的东西一律不碰。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 工作区根 = 本文件上三级（tools → study-assistant → _plugins → 工作区）。 */
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');
export const DEFAULT_OUT_DIR = path.join(DEFAULT_DATA_DIR, '知识画布');
export const MANIFEST_NAME = '_manifest.json';
export const MASTERY_LABELS = ['未学', '学过', '熟练', '精通'];

/* --------------------------------------------------------------- 小工具 */

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readJson(file, fallback) {
  try {
    // 去掉 BOM：Windows 上别的工具（PowerShell 的 -Encoding UTF8）写出来的 JSON 常带 BOM，
    // JSON.parse 会直接报错；这里宽容一点，避免「文件明明在、工具却说读不到」。
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** 文件名里不能出现的东西：路径分隔符、Windows 保留字符、控制字符。 */
function safeName(text, max = 48) {
  const cleaned = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
  return trimmed === '' ? '未命名' : trimmed;
}

/** frontmatter 的值只允许单行纯文本；含冒号时加引号（kp-notes 的解析器两种都认）。 */
function fmValue(text) {
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (flat === '') return '""';
  if (/[:\[\]"']/.test(flat)) return `"${flat.replace(/"/g, "'")}"`;
  return flat;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 章目录名：`NN-课程简称-章名`（数字前缀让画布按课程与章节顺序排）。 */
function chapterDirName(index, courseName, chapter) {
  return `${pad2(index + 1)}-${safeName(courseName, 12)}-${safeName(chapter, 24)}`;
}

function courseShortName(course) {
  const aliases = Array.isArray(course?.aliases) ? course.aliases.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  if (aliases.length > 0) return aliases[0].trim();
  return String(course?.name ?? '').trim();
}

/* ------------------------------------------------------------ 渲染 markdown */

export function renderNoteFile(node, context) {
  // 掌握度：越界/非整数一律当「未学」，不往上取整——脏数据不该被渲染成「精通」。
  const rawMastery = Number(node?.mastery);
  const mastery = Number.isInteger(rawMastery) && rawMastery >= 0 && rawMastery <= 3 ? rawMastery : 0;
  const tags = [context.courseName, node?.chapter, node?.marked === true ? '重点' : '']
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => String(item).trim());
  const lines = [
    '---',
    `title: ${fmValue(node?.name)}`,
    'type: point',
    `tags: [${tags.join(', ')}]`,
    `order: ${context.order}`,
    '---',
    '',
    `# ${String(node?.name ?? '未命名')}`,
    '',
  ];
  if (typeof node?.note === 'string' && node.note.trim() !== '') {
    lines.push(node.note.trim(), '');
  }
  lines.push('## 要点', '', '（待补：一句话结论 + 原理/公式/易错点。**注意**：本文件每次导出都会被覆盖，长期内容请先写进学习台的 `知识点网络.json` 的 `note` 字段。）', '');

  lines.push('## 掌握度', '');
  const marks = [`${MASTERY_LABELS[mastery]}（${mastery}/3）`];
  if (node?.marked === true) marks.push('已标重点');
  if (typeof node?.reviewedAt === 'string' && node.reviewedAt !== '') {
    marks.push(`最近复习 ${node.reviewedAt.replace('T', ' ').slice(0, 16)}`);
  }
  lines.push(marks.join(' · '), '');

  const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
  if (evidence.length > 0) {
    lines.push('## 证据', '');
    for (const item of evidence) {
      if (item?.type === 'question') {
        lines.push(`- 题目 \`${String(item.id ?? '')}\``);
      } else {
        const page = item?.page === undefined || item.page === null ? '?' : String(item.page);
        const quote = typeof item?.quote === 'string' && item.quote !== '' ? `：「${item.quote.replace(/\s+/g, ' ').trim()}」` : '';
        lines.push(`- ${String(item?.file ?? '')} 第 ${page} 页${quote}`);
      }
    }
    lines.push('');
  }

  lines.push('---', '', `> 由学习台镜像生成：${context.sourceLine}。`, '');
  return lines.join('\n');
}

/** 题目块：kp-notes 的约定是 `## 题目 N` + 选项 + `**答案**：` + `**解析**：`。 */
export function renderQuestionBlock(question, order) {
  const lines = [`## 题目 ${order}`, ''];
  const prompt = String(question?.prompt ?? '').trim();
  lines.push(prompt === '' ? '（题干缺失）' : prompt, '');

  const options = Array.isArray(question?.options) ? question.options : [];
  for (const option of options) {
    const key = String(option?.key ?? '').trim().toUpperCase();
    const text = String(option?.text ?? '').trim();
    if (key === '' || text === '') continue;
    lines.push(`${key}. ${text}`);
  }
  if (options.length > 0) lines.push('');

  const answer = typeof question?.answer === 'string' && question.answer.trim() !== ''
    ? question.answer.trim()
    : (typeof question?.answerKey === 'string' && question.answerKey.trim() !== '' ? question.answerKey.trim() : '（见原题）');
  lines.push(`**答案**：${answer}`, '');
  const where = [question?.sourceFile, question?.page === undefined ? '' : `第 ${question.page} 页`]
    .filter((item) => typeof item === 'string' && item !== '')
    .join(' · ');
  lines.push(`**解析**：${where === '' ? '（待补）' : `来源 ${where}`}`, '');
  return lines.join('\n');
}

export function renderQuestionFile(node, questions, context) {
  const header = [
    '---',
    `title: ${fmValue(node?.name)} 题目`,
    'type: question',
    `tags: [${[context.courseName, node?.chapter].filter(Boolean).join(', ')}]`,
    '---',
    '',
    `# ${String(node?.name ?? '未命名')} · 题目`,
    '',
    `> 来自学习台题库（${questions.length} 道）· ${context.sourceLine}`,
    '',
  ];
  const blocks = questions.map((question, index) => renderQuestionBlock(question, index + 1));
  return `${header.join('\n')}${blocks.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}

/* ----------------------------------------------------------------- 生成计划 */

/**
 * 纯函数：给定三份数据，算出「应该写哪些文件、内容是什么」。
 * 不碰磁盘，测试直接拿它断言（重跑幂等、章目录命名、题目配对都在这里）。
 */
export function planExport({ network, questions, courses, sourceLine = '学习台知识网络' }) {
  const courseList = Array.isArray(courses?.courses) ? courses.courses : [];
  const courseById = new Map(courseList.map((course) => [course.id, course]));
  const nodes = Array.isArray(network?.nodes) ? network.nodes : [];
  const allQuestions = Array.isArray(questions?.questions) ? questions.questions : [];

  // 章节顺序：课程在 courses.json 里的顺序优先，然后是出现顺序；章内按 section → name。
  const courseOrder = new Map(courseList.map((course, index) => [course.id, index]));
  const chapters = new Map();
  for (const node of nodes) {
    const courseId = node?.courseId ?? null;
    const course = courseId === null ? null : courseById.get(courseId) ?? null;
    const chapter = String(node?.chapter ?? '').trim() || '未分章';
    const key = `${courseId ?? '__none__'}\u0000${chapter}`;
    if (!chapters.has(key)) {
      chapters.set(key, {
        courseId,
        courseName: course === null ? '未匹配课程' : (courseShortName(course) || String(course.name ?? '')),
        chapter,
        nodes: [],
      });
    }
    chapters.get(key).nodes.push(node);
  }

  const sortedChapters = [...chapters.values()].sort((a, b) => {
    const byCourse = (courseOrder.get(a.courseId) ?? Number.MAX_SAFE_INTEGER) - (courseOrder.get(b.courseId) ?? Number.MAX_SAFE_INTEGER);
    if (byCourse !== 0) return byCourse;
    return String(a.chapter).localeCompare(String(b.chapter), 'zh-Hans-CN', { numeric: true });
  });

  const files = {};
  const summary = { chapters: 0, notes: 0, questionFiles: 0, questions: 0, skippedQuestions: 0 };
  // 一道题可能同时被多个知识点点名（一个知识点也会挂多道题）⇒ 「配对了几道题」要按题目 id 去重，
  // 否则 summary.questions 会把同一道题重复计数，skipped 还会算成负数。
  const matchedQuestionIds = new Set();

  sortedChapters.forEach((chapter, chapterIndex) => {
    const dirName = chapterDirName(chapterIndex, chapter.courseName, chapter.chapter);
    const points = chapter.nodes
      .slice()
      .sort((a, b) => String(a.section ?? '').localeCompare(String(b.section ?? ''), 'zh-Hans-CN', { numeric: true })
        || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN', { numeric: true }));
    summary.chapters += 1;

    points.forEach((node, nodeIndex) => {
      const fileName = `${pad2(nodeIndex + 1)}-${safeName(node.name)}.md`;
      const relNote = `notes/${dirName}/${fileName}`;
      const relQuestions = `questions/${dirName}/${fileName}`;
      const context = { courseName: chapter.courseName, order: nodeIndex + 1, sourceLine };

      files[relNote] = renderNoteFile(node, context);
      summary.notes += 1;

      // 题目配对（两条路）：
      //  ① 题目自己的 knowledgeNames 点名了这个知识点（分题工具填了就用它）；
      //  ② 否则看节点的 evidence 里有没有这道题 —— 织网（tools/knowledge-weave.mjs）
      //     已经把「候选点名过的题」写成 {type:'question', id}，题目那边的 knowledgeNames
      //     还空着（任务单里它是「候选」，不强制填），所以没有 ② 的话画布上题目永远配不上。
      // 两条路都要求课程相容；不按 courseId 兜底（那样会把整门课的题全挂到每个节点上）。
      const nodeQuestionIds = new Set(
        (Array.isArray(node.evidence) ? node.evidence : [])
          .filter((item) => item && item.type === 'question' && typeof item.id === 'string')
          .map((item) => item.id),
      );
      const matched = allQuestions.filter((question) => {
        const questionCourse = question?.courseId ?? null;
        const sameCourse = questionCourse === null || chapter.courseId === null || questionCourse === chapter.courseId;
        if (!sameCourse) return false;
        const names = Array.isArray(question?.knowledgeNames) ? question.knowledgeNames : [];
        if (names.some((name) => String(name).trim() === String(node.name ?? '').trim())) return true;
        return nodeQuestionIds.has(question?.id);
      });
      if (matched.length > 0) {
        files[relQuestions] = renderQuestionFile(node, matched, context);
        summary.questionFiles += 1;
        for (const question of matched) matchedQuestionIds.add(question.id);
      }
    });
  });

  summary.questions = matchedQuestionIds.size;
  summary.skippedQuestions = allQuestions.length - matchedQuestionIds.size;
  return { files, summary, chapters: sortedChapters.length };
}

/* --------------------------------------------------------------- 落盘 / 清理 */

function writeFileIfChanged(abs, content) {
  try {
    if (fs.readFileSync(abs, 'utf8') === content) return false;
  } catch {
    // 不存在：继续写
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return true;
}

function listManifestFiles(outDir) {
  const manifest = readJson(path.join(outDir, MANIFEST_NAME), null);
  const files = manifest && typeof manifest.files === 'object' && manifest.files !== null ? Object.keys(manifest.files) : [];
  return files.filter((rel) => typeof rel === 'string' && !rel.includes('..') && (rel.startsWith('notes/') || rel.startsWith('questions/')));
}

/**
 * 把计划落到磁盘。
 * @returns {{written:string[], unchanged:number, removed:string[], kept:string[]}}
 */
export function applyExport(outDir, plan, options = {}) {
  const prune = options.prune !== false;
  const previous = new Set(listManifestFiles(outDir));
  const written = [];
  let unchanged = 0;

  for (const [rel, content] of Object.entries(plan.files)) {
    const abs = path.join(outDir, rel);
    if (path.dirname(abs) === abs) throw new Error(`拒绝写出界路径：${rel}`);
    if (writeFileIfChanged(abs, content)) written.push(rel);
    else unchanged += 1;
  }

  const removed = [];
  const kept = [];
  if (prune) {
    for (const rel of previous) {
      if (Object.prototype.hasOwnProperty.call(plan.files, rel)) continue;
      const abs = path.join(outDir, rel);
      try {
        fs.unlinkSync(abs);
        removed.push(rel);
      } catch {
        kept.push(rel);
      }
    }
    // 顺手清掉因此变空的章节目录（只清 notes/ 与 questions/ 下面那一层）
    for (const rel of removed) {
      const dir = path.dirname(path.join(outDir, rel));
      if (!dir.startsWith(outDir)) continue;
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // 目录不存在或有权限问题：忽略
      }
    }
  }

  // `generatedAt` 只在真有文件变化时更新：否则每次重跑都会因为这一行时间戳而「写了一次 manifest」，
  // 幂等就成了假的（`--check` 也会永远说有差异）。
  const previousManifest = readJson(path.join(outDir, MANIFEST_NAME), null);
  const touched = written.length > 0 || removed.length > 0;
  const manifest = {
    generator: 'study-assistant/kp-notes-export',
    generatedAt: touched
      ? new Date().toISOString()
      : (typeof previousManifest?.generatedAt === 'string' ? previousManifest.generatedAt : new Date().toISOString()),
    source: plan.source ?? null,
    summary: plan.summary,
    files: Object.fromEntries(Object.entries(plan.files).map(([rel, content]) => [rel, sha256(content)])),
  };
  if (writeFileIfChanged(path.join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)) {
    written.push(MANIFEST_NAME);
  } else {
    unchanged += 1;
  }
  return { written, unchanged, removed, kept };
}

export function diffExport(outDir, plan) {
  const changes = [];
  for (const [rel, content] of Object.entries(plan.files)) {
    const abs = path.join(outDir, rel);
    let current = null;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) changes.push({ rel, kind: current === null ? 'missing' : 'changed' });
  }
  for (const rel of listManifestFiles(outDir)) {
    if (!Object.prototype.hasOwnProperty.call(plan.files, rel)) changes.push({ rel, kind: 'stale' });
  }
  return changes;
}
