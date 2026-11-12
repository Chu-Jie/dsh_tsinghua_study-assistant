#!/usr/bin/env node
/**
 * 扫描课程「讲义」目录，**一次写两处**，让「讲义在哪」只有一个真源：
 *
 *   1. `资料分析.json` 的 `courses[].lectures` patch（面板「讲义」卡片吃它）；
 *   2. `资料索引.json` 的 `kind:'lecture'` 条目（面板点开正文 / `GET /materials/text` 吃它）。
 *
 * 历史问题：这两个文件由两批不同的工具分别维护，于是会漂移——
 * 2026-10-30 实测 `数电/讲义/第05章-半导体存储电路-A/B.md` 在磁盘上存在、`资料分析.json` 没有、
 * `资料索引.json` 也没有，面板里点不到。现在两者都由本工具从磁盘**单向推导**，跑一次即对齐。
 *
 * 默认 dry-run（只打印将要发生的增/改/删，不碰磁盘）；`--apply` 才写盘，
 * 且必须经过 `lib/store.js` 的 `writeDocument`（自动备份 + 原子写 + 冲突保护），
 * **绝不允许**自己 `fs.writeFileSync` 覆盖主文档。
 *
 * ── 白名单 / 黑名单（`isLectureNoise` 与 `parseLectureFilename` 一起构成过滤规则）──
 *
 * 黑名单（命中即跳过，永不进索引）：
 *   - 以 `_` 开头的文件：`_讲义索引.md`、`_bak-xxx.md` 这类手写索引与备份副本；
 *   - 以 `README` 开头的文件（大小写不敏感）：`README-三版对比与提示词.md` 是给人看的说明；
 *   - 任何非 `.md` 文件；`*.bak` / `*~` / `*.tmp*` 之类的编辑器残留。
 * 白名单（只有命中才登记，即 `parseLectureFilename` 的 `第NN章-标题-风格-风格名.md`）：
 *   - `A` / `B` / `C` 是正文风格，`C2` / `C3` 是 C 的变体（`parent:'C'`）。
 * 两个条件都满足才进索引；只满足其一 → 记一条 warning，不登记。
 * 这样「磁盘上有 60 篇真讲义 + 5 个噪音文件」的结果是索引 60 条，而不是 65 条。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../lib/store.js';
import { DOC_FILES, DOC_VERSION } from '../lib/core.js';
import { mergeAnalysis } from './analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_DATA = path.join(ROOT, '学习台');
const STYLE_KEYS = new Set(['A', 'B', 'C', 'C2', 'C3']);
const STYLE_LABELS = { A: '严谨体系式', B: '速查对比式', C: '问题驱动式', C2: '零基础问题驱动', C3: '零基础问题驱动·术语后置' };

function parseArgs(argv) {
  const args = {
    apply: false,
    all: false,
    course: 'c_digital',
    data: DEFAULT_DATA,
    dir: path.join(ROOT, '数电', '讲义'),
    subdir: '',
    // 写哪些文档：默认两处都写（单一真源的意义就在于此）；调试/分工时可用 --index-only / --analysis-only 收窄
    writeAnalysis: true,
    writeIndex: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') args.apply = true;
    else if (token === '--all') args.all = true;
    else if (token === '--index-only') args.writeAnalysis = false;
    else if (token === '--analysis-only') args.writeIndex = false;
    else if (token === '--course') args.course = argv[++i] ?? '';
    else if (token === '--data') args.data = path.resolve(argv[++i] ?? DEFAULT_DATA);
    else if (token === '--dir') args.dir = path.resolve(argv[++i] ?? args.dir);
    else if (token === '--subdir') args.subdir = argv[++i] ?? '';
    else if (token === '--help') args.help = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

/** 统一成索引里用的正斜杠相对路径（`资料索引.json` 的 `path` 口径）。 */
function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

/** 去掉首尾多余的 `/`，得到 `数电/讲义` 这种干净的路径前缀。 */
function normalizePrefix(value) {
  return toPosix(value).replace(/^\/+|\/+$/g, '');
}

/**
 * 讲义文件在 `资料索引.json` 里的 `path` 前缀（相对工作区根目录）。
 * 工作区根＝`学习台` 的父目录（`lib/api.js:626-629` 的 `workspaceRoot` 同一口径），
 * 所以能由 `--dir` 反推；`--dir` 不在工作区里时用 `--subdir` 显式给。
 * 旧版把前缀写死成 `数电/讲义`，跑别的科目会把 file 写错、面板点开 404。
 */
export function deriveSubdir(dir, data) {
  const workspace = path.dirname(path.resolve(data));
  const rel = path.relative(workspace, path.resolve(dir));
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return '';
}

function countChinese(text) {
  return (String(text).match(/[\u4e00-\u9fa5]/gu) ?? []).length;
}

/** 黑名单：这类文件名永远不是一篇讲义（详见文件头的白/黑名单说明）。 */
export function isLectureNoise(name) {
  const base = String(name ?? '');
  if (base === '') return true;
  if (!base.toLowerCase().endsWith('.md')) return true;
  if (base.startsWith('_')) return true;
  if (base.toLowerCase().startsWith('readme')) return true;
  if (base.includes('.bak') || base.endsWith('~') || base.includes('.tmp')) return true;
  return false;
}

/** 白名单：`第NN章-标题-A-严谨体系式.md` 这种命名才认。 */
export function parseLectureFilename(name) {
  const match = /^(?:第)?(\d{1,2})章-(.+?)-(A|B|C2|C3|C)-(.+?)\.md$/u.exec(name);
  if (match === null) return null;
  const no = String(Number(match[1]));
  const key = match[3];
  if (!STYLE_KEYS.has(key)) return null;
  return { no, fileTitle: match[2], key, label: STYLE_LABELS[key] ?? match[4] };
}

/** 目录里所有「真讲义」文件名（已过黑名单），按名称排序保证结果稳定。 */
export function listLectureFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !isLectureNoise(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function scanLectures({ dir, courseId, outline, materials, subdir = '数电/讲义' }) {
  const prefix = normalizePrefix(subdir);
  const files = listLectureFiles(dir);
  const courseOutline = (outline?.courses ?? []).find((course) => String(course.courseId) === String(courseId));
  const chapters = new Map((courseOutline?.chapters ?? []).map((chapter) => [String(chapter.no), chapter]));
  const indexed = new Set((materials?.files ?? []).map((item) => toPosix(item?.path)));
  const lectures = new Map();
  const warnings = [];
  for (const name of files) {
    const parsed = parseLectureFilename(name);
    if (parsed === null) { warnings.push(`跳过无法解析的文件名：${name}`); continue; }
    const chapter = chapters.get(parsed.no);
    if (chapter === undefined) warnings.push(`讲义章号 ${parsed.no} 不在大纲中：${name}`);
    else if (parsed.fileTitle !== String(chapter.title ?? '').trim()) warnings.push(`章标题不一致，使用大纲标题「${chapter.title}」：${name}`);
    const file = path.posix.join(prefix, name);
    if (!indexed.has(file)) warnings.push(`资料索引没有登记：${file}`);
    const item = { key: parsed.key, label: parsed.label, file, chars: countChinese(fs.readFileSync(path.join(dir, name), 'utf8')), generatedAt: new Date().toISOString().slice(0, 10) };
    if (!lectures.has(parsed.no)) lectures.set(parsed.no, { no: parsed.no, title: String(chapter?.title ?? parsed.fileTitle).trim(), source: 'notebooklm', styles: [], variants: [] });
    const target = parsed.key === 'C2' || parsed.key === 'C3' ? lectures.get(parsed.no).variants : lectures.get(parsed.no).styles;
    const at = target.findIndex((entry) => entry.key === item.key);
    if (at === -1) target.push(item); else target[at] = item;
    if (parsed.key === 'C2' || parsed.key === 'C3') target[target.length - 1].parent = 'C';
  }
  return { lectures: [...lectures.values()].sort((a, b) => Number(a.no) - Number(b.no)), warnings };
}

/**
 * 一条 `资料索引.json` 的 lecture 条目。
 * 字段形状照抄现有 58 条（`path` / `courseId` / `kind` / `textLayer` / `title` / `text.outFile`），
 * `title` 是去掉 `.md` 的文件名——面板资料页直接显示它。
 */
export function lectureIndexEntry({ relPath, name, courseId }) {
  const file = toPosix(relPath);
  return {
    path: file,
    courseId: String(courseId ?? ''),
    kind: 'lecture',
    textLayer: true,
    title: String(name ?? path.posix.basename(file)).replace(/\.md$/iu, ''),
    text: { outFile: file },
  };
}

/**
 * 把磁盘上的讲义目录同步进 `资料索引.json`（纯函数：只返回新文档，不写盘）。
 *
 * - 新增：磁盘上有、索引里没有的真讲义 → 追加到 `files[]` 末尾（现有文件的顺序不动，diff 最小）；
 * - 更新：索引里已有但派生字段漂移（`title` / `text.outFile` / `courseId` / `textLayer`）→ 就地刷新，
 *   条目上其它人工补充的字段（例如将来加的 `ocr`）原样保留；
 * - 移除：`kind:'lecture'` 且 `path` 落在本次同步的前缀下、但磁盘上已经没有的文件 → 删除。
 *   **只清理本次前缀内的条目**，跑 `数电` 绝不会误删 `物理` 的登记。
 * - 噪音文件（`_讲义索引.md` / `README-*.md`）既不会新增，也不会因为「索引里没有」而被算成缺失。
 *
 * @returns {{doc: object, desired: string[], added: string[], updated: string[], removed: string[], warnings: string[]}}
 */
export function syncMaterialsIndex({ materials, dir, courseId, subdir }) {
  const prefix = normalizePrefix(subdir);
  const scope = `${prefix}/`;
  const entries = Array.isArray(materials?.files) ? materials.files : [];
  const warnings = [];

  // 磁盘现状：真讲义 → 相对路径
  const desired = new Map();
  for (const name of listLectureFiles(dir)) {
    const parsed = parseLectureFilename(name);
    if (parsed === null) {
      warnings.push(`磁盘文件命名不符合讲义规范（不入索引）：${scope}${name}`);
      continue;
    }
    desired.set(path.posix.join(prefix, name), { name, parsed });
  }

  const next = [];
  const seen = new Set();
  const added = [];
  const updated = [];
  const removed = [];

  for (const item of entries) {
    const file = toPosix(item?.path);
    const scoped = item?.kind === 'lecture' && file.startsWith(scope);
    if (!scoped) { next.push(item); continue; }
    const hit = desired.get(file);
    if (hit === undefined) { removed.push(file); continue; } // 失效登记：磁盘上没了
    const fresh = lectureIndexEntry({ relPath: file, name: hit.name, courseId: courseId || item?.courseId });
    // 保留条目上已有的人工字段（例如 text 里的额外键），只刷新派生字段
    const merged = { ...item, ...fresh };
    if (item?.text !== undefined && item.text !== null && typeof item.text === 'object') {
      merged.text = { ...item.text, ...fresh.text };
    }
    if (JSON.stringify(merged) !== JSON.stringify(item)) updated.push(file);
    next.push(merged);
    seen.add(file);
  }

  for (const [file, info] of desired) {
    if (seen.has(file)) continue;
    next.push(lectureIndexEntry({ relPath: file, name: info.name, courseId }));
    added.push(file);
  }

  const base = materials !== null && typeof materials === 'object' ? materials : {};
  const doc = { ...base, version: base.version ?? DOC_VERSION, files: next };
  return { doc, desired: [...desired.keys()].sort(), added, updated, removed, warnings };
}

/**
 * 从 `资料索引.json` 现有登记反推「讲义目录前缀 → courseId」。
 * 优先用已有 lecture 条目的多数票（历史数据已经在用 c_digital 等 id）；
 * 没有历史条目时退回 `课程.json` 的 `note`（`工作区目录：数电/`）。
 */
export function courseIdForSubdir(subdir, materials, courses) {
  const scope = `${normalizePrefix(subdir)}/`;
  const votes = new Map();
  for (const item of materials?.files ?? []) {
    if (item?.kind !== 'lecture') continue;
    if (!toPosix(item?.path).startsWith(scope)) continue;
    const id = String(item?.courseId ?? '');
    if (id === '') continue;
    votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  if (votes.size > 0) {
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  const subject = normalizePrefix(subdir).split('/')[0];
  for (const course of courses?.courses ?? []) {
    if (String(course?.note ?? '').includes(`工作区目录：${subject}/`)) return String(course.id ?? '');
  }
  return '';
}

/** `--all`：工作区根下所有带 `讲义/` 的一级目录（跳过 `_` 开头与隐藏目录）。 */
export function discoverLectureJobs(workspace) {
  let entries;
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const dir = path.join(workspace, entry.name, '讲义');
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    jobs.push({ subject: entry.name, dir, subdir: `${entry.name}/讲义` });
  }
  return jobs.sort((a, b) => a.subdir.localeCompare(b.subdir, 'zh'));
}

/**
 * 同步逻辑本体（不 exit，便于测试）。
 * @param {string[]} argv 命令行参数（不含 node 与脚本名）
 * @param {{log?: Function, error?: Function}} [io]
 * @returns {Promise<{code: number, apply: boolean, jobs: object[], written: string[]}>}
 */
export async function runSync(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  const args = parseArgs(argv);
  if (args.help) {
    log('用法：node tools/lectures-sync.mjs [--apply] [--all | --course <id> --dir <讲义目录>] [--data <目录>] [--subdir <索引路径前缀>] [--index-only | --analysis-only]');
    return { code: 0, apply: args.apply, jobs: [], written: [] };
  }

  const workspace = path.dirname(path.resolve(args.data));
  const materialsFile = path.join(args.data, DOC_FILES.materials);
  const analysisFile = path.join(args.data, DOC_FILES.knowledgeAnalysis);
  const outlineFile = path.join(args.data, DOC_FILES.knowledgeOutline);
  const coursesFile = path.join(args.data, DOC_FILES.courses);

  // 一次读齐、内存里累加，最后每份文档只写一次（--all 时 4 门课也不会反复覆盖）
  let materialsDoc = readJson(materialsFile, null) ?? { version: DOC_VERSION, files: [] };
  let analysisDoc = readJson(analysisFile, null) ?? { version: DOC_VERSION, courses: [], runs: [] };
  const outline = readJson(outlineFile, { courses: [] });
  const courses = readJson(coursesFile, { courses: [] });
  const materialsBefore = JSON.parse(JSON.stringify(materialsDoc));

  const planned = args.all
    ? discoverLectureJobs(workspace)
    : [{ subject: '', dir: args.dir, subdir: args.subdir !== '' ? args.subdir : deriveSubdir(args.dir, args.data) }];
  if (planned.length === 0) {
    error(`没有找到任何含「讲义」子目录的科目目录（工作区 ${workspace}）`);
    return { code: 1, apply: args.apply, jobs: [], written: [] };
  }

  const jobs = [];
  let failures = 0;
  for (const job of planned) {
    const subdir = normalizePrefix(job.subdir);
    if (subdir === '') {
      error(`无法从 --dir 推导资料索引路径前缀（${job.dir} 不在工作区 ${workspace} 内），请用 --subdir 显式指定，例如 --subdir 数电/讲义`);
      failures += 1;
      continue;
    }
    const courseId = args.all ? courseIdForSubdir(subdir, materialsBefore, courses) : args.course;
    if (String(courseId) === '') {
      error(`找不到 ${subdir} 对应的 courseId（资料索引无历史登记、课程.json 也没写「工作区目录：${subdir.split('/')[0]}/」），请用 --course 指定`);
      failures += 1;
      continue;
    }
    const scanned = scanLectures({ dir: job.dir, courseId, outline, materials: materialsDoc, subdir });
    const sync = syncMaterialsIndex({ materials: materialsDoc, dir: job.dir, courseId, subdir });
    materialsDoc = sync.doc;
    analysisDoc = mergeAnalysis(analysisDoc, { courseId, lectures: scanned.lectures });
    jobs.push({
      courseId,
      subdir,
      chapters: scanned.lectures.length,
      styles: scanned.lectures.reduce((sum, item) => sum + item.styles.length + item.variants.length, 0),
      lectures: scanned.lectures,
      index: { added: sync.added, updated: sync.updated, removed: sync.removed, total: sync.desired.length },
      warnings: [...scanned.warnings, ...sync.warnings],
    });
  }

  log(JSON.stringify({
    apply: args.apply,
    mode: args.all ? 'all' : 'single',
    write: { analysis: args.writeAnalysis, index: args.writeIndex },
    totals: {
      jobs: jobs.length,
      chapters: jobs.reduce((sum, item) => sum + item.chapters, 0),
      styles: jobs.reduce((sum, item) => sum + item.styles, 0),
      indexAdded: jobs.reduce((sum, item) => sum + item.index.added.length, 0),
      indexUpdated: jobs.reduce((sum, item) => sum + item.index.updated.length, 0),
      indexRemoved: jobs.reduce((sum, item) => sum + item.index.removed.length, 0),
    },
    jobs,
  }, null, 2));

  if (!args.apply) return { code: failures === 0 ? 0 : 1, apply: false, jobs, written: [] };

  const store = createStore(args.data);
  const written = [];
  if (args.writeIndex) {
    const result = await store.writeDocument('materials', materialsDoc, { expectedHash: await store.hashOf('materials') });
    if (!result.ok) {
      error(`写入失败（${DOC_FILES.materials}）：${result.reason}`);
      return { code: 1, apply: true, jobs, written };
    }
    written.push(DOC_FILES.materials);
  }
  if (args.writeAnalysis) {
    const result = await store.writeDocument('knowledgeAnalysis', analysisDoc, { expectedHash: await store.hashOf('knowledgeAnalysis') });
    if (!result.ok) {
      error(`写入失败（${DOC_FILES.knowledgeAnalysis}）：${result.reason}`);
      return { code: 1, apply: true, jobs, written };
    }
    written.push(DOC_FILES.knowledgeAnalysis);
  }
  log(`已写入 ${written.join(' + ')}，备份已进入 ${path.join(args.data, '备份')}`);
  return { code: failures === 0 ? 0 : 1, apply: true, jobs, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSync(process.argv.slice(2)).then((result) => { process.exitCode = result.code; }).catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; });
}
