/**
 * 作业原题的发现与取字
 *
 * 职责只有两件：
 *   1. 在 `<学科>/作业/` 里找出「第 N 次」的原题文件（只读，不改任何东西）；
 *   2. 把原题变成纯文本（PDF 走 pdf.js，docx/pptx 走 node:zlib 解 XML，txt/md 直读）。
 *
 * 刻意**不**复用 `lib/deliverables.js` 的归档入口：那个模块扫的是 `提交文件/`、
 * 判据是「文件名含姓名+学号」，判错了会动任务状态。这里只扫 `作业/`、只读不写，
 * 两边共用的是「课程目录 ↔ courseId 的解析」（`resolveCourseIds`）与「第 N 次」（`parseTaskSeq`）。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

import { extractPdfText } from './pdf-text.js';
import { normalizeText } from './questions.js';
import { resolveCourseIds, parseTaskSeq } from './deliverables.js';

/** 各学科的作业目录名（相对工作区根）。 */
export const HOMEWORK_DIR = '作业';

/** 认得的原题扩展名。 */
export const HOMEWORK_EXTS = ['.pdf', '.docx', '.pptx', '.txt', '.md'];

/** 目录名里出现这些就跳过（与 deliverables 的口径一致，避免扫进缓存与备份）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '$RECYCLE.BIN', 'System Volume Information']);

/** 单份文本上限（与 pdf 侧一致）。 */
const MAX_CHARS = 100000;

/** 文件名里像「原题」的标记：有它优先推荐给用户。 */
const ORIGINAL_HINT = /原题|题目|作业要求|试题|试卷/;

/**
 * 文本 sha256（十六进制前 32 位）。
 * 用途：判断同一份原题是否已经处理过；P2 里还用来防重复计权。
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 只看文件名，判断它是「第几次作业」。
 * @param {string} filename
 * @returns {number|null}
 */
export function homeworkNumber(filename) {
  const seq = parseTaskSeq(path.parse(String(filename ?? '')).name);
  return Array.isArray(seq) && seq.length > 0 ? seq[0] : null;
}

/**
 * 列出工作区里能对上课程的学科目录。
 * @param {string} workspaceRoot
 * @param {Array<{id: string, name?: string, aliases?: string[]}>} courses
 * @returns {Promise<Array<{courseId: string, dirName: string, dir: string}>>}
 */
export async function listCourseDirs(workspaceRoot, courses) {
  const root = typeof workspaceRoot === 'string' ? workspaceRoot : '';
  if (root === '') return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const byCourse = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('_')) continue;
    const hits = resolveCourseIds(entry.name, courses);
    // 目录名对上多门课（物理 / 物理实验）时不猜，交给调用方按课程名精确匹配
    if (hits.length !== 1) continue;
    const item = { courseId: hits[0], dirName: entry.name, dir: path.join(root, entry.name) };
    // 同一门课可能对上多个目录（数电 / 数电实验）。优先留「目录名 == 课程名」的那个，
    // 都不精确时留先出现的，并在返回值里标出 otherDirs 供 UI 提示。
    const existing = byCourse.get(item.courseId);
    if (existing === undefined) {
      byCourse.set(item.courseId, { ...item, otherDirs: [] });
      continue;
    }
    const exact = (candidate, dirName) => (courses.find((c) => c?.id === candidate)?.name === dirName ? 1 : 0);
    if (exact(item.courseId, item.dirName) > exact(existing.courseId, existing.dirName)) {
      existing.otherDirs.push(existing.dirName);
      byCourse.set(item.courseId, { ...item, otherDirs: existing.otherDirs });
    } else {
      existing.otherDirs.push(item.dirName);
    }
  }
  for (const item of byCourse.values()) out.push(item);
  return out;
}

/**
 * 扫某门课的 `作业/` 目录，返回候选原题。
 * @param {string} workspaceRoot
 * @param {Array} courses
 * @param {string} courseId
 * @returns {Promise<{ok: true, courseId: string, dirName: string, files: Array<object>}|{ok: false, reason: string}>}
 */
export async function scanCourseHomework(workspaceRoot, courses, courseId) {
  const dirs = await listCourseDirs(workspaceRoot, courses);
  const hit = dirs.find((item) => item.courseId === courseId);
  if (hit === undefined) return { ok: false, reason: 'course-dir-not-found' };

  const homeworkDir = path.join(hit.dir, HOMEWORK_DIR);
  let entries;
  try {
    entries = await readdir(homeworkDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'homework-dir-missing', dirName: hit.dirName };
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!HOMEWORK_EXTS.includes(ext)) continue;
    const full = path.join(homeworkDir, entry.name);
    let info = null;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    files.push({
      name: entry.name,
      path: full,
      ext,
      bytes: info.size,
      mtime: info.mtime.toISOString(),
      seq: homeworkNumber(entry.name),
      looksOriginal: ORIGINAL_HINT.test(entry.name),
      mayBeAnswer: /答案|解答|参考/.test(entry.name),
    });
  }

  // 原题优先，其次按第几次、文件名排序
  files.sort((a, b) => {
    if (a.looksOriginal !== b.looksOriginal) return a.looksOriginal ? -1 : 1;
    if (a.seq !== b.seq) return (a.seq ?? 999) - (b.seq ?? 999);
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  return { ok: true, courseId, dirName: hit.dirName, dir: homeworkDir, files };
}

// ---------------------------------------------------------------------------
// docx / pptx：用 node:zlib 解 ZIP，再抽 XML 文本（不引第三方库）
// ---------------------------------------------------------------------------

/**
 * 读 ZIP 中央目录。
 * @param {Buffer} buffer
 * @returns {Array<{name: string, method: number, compSize: number, localOff: number}>}
 */
function readZipEntries(buffer) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOff = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 取出一个 ZIP 条目的内容（仅 stored / deflate）。
 * @param {Buffer} buffer
 * @param {{method: number, compSize: number, localOff: number}} entry
 * @returns {Buffer|null}
 */
function readZipEntry(buffer, entry) {
  const base = entry.localOff;
  if (base + 30 > buffer.length || buffer.readUInt32LE(base) !== 0x04034b50) return null;
  const nameLen = buffer.readUInt16LE(base + 26);
  const extraLen = buffer.readUInt16LE(base + 28);
  const start = base + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(raw);
  } catch {
    return null;
  }
}

/**
 * Office XML → 纯文本：段落/换行元素变 `\n`，其余标签剥掉，实体还原。
 * @param {string} xml
 * @returns {string}
 */
export function officeXmlToText(xml) {
  return String(xml ?? '')
    .replace(/<\/(?:w:p|a:p|w:tr)>/g, '\n')
    .replace(/<w:br\s*\/>|<a:br\s*\/>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从 docx / pptx 字节里抽文本。
 * @param {Buffer} buffer
 * @param {'.docx'|'.pptx'} ext
 * @returns {{ok: true, text: string}|{ok: false, reason: string}}
 */
export function extractOfficeText(buffer, ext) {
  const entries = readZipEntries(buffer);
  if (entries.length === 0) return { ok: false, reason: 'bad-zip' };

  if (ext === '.docx') {
    const main = entries.find((entry) => entry.name === 'word/document.xml');
    if (main === undefined) return { ok: false, reason: 'no-document-xml' };
    const xml = readZipEntry(buffer, main);
    if (xml === null) return { ok: false, reason: 'unzip-failed' };
    return { ok: true, text: officeXmlToText(xml.toString('utf8')) };
  }

  const slides = entries
    .map((entry) => {
      const hit = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name);
      return hit === null ? null : { order: Number(hit[1]), entry };
    })
    .filter((item) => item !== null)
    .sort((a, b) => a.order - b.order);
  if (slides.length === 0) return { ok: false, reason: 'no-slides' };

  const parts = [];
  for (const slide of slides) {
    const xml = readZipEntry(buffer, slide.entry);
    if (xml !== null) parts.push(officeXmlToText(xml.toString('utf8')));
  }
  return { ok: true, text: parts.join('\n\n').trim() };
}

/**
 * 按扩展名取文本，统一归一到 `normalizeText`。
 * @param {string} filePath
 * @param {{maxChars?: number}} [options]
 * @returns {Promise<{ok: true, kind: string, text: string, chars: number, truncated: boolean, pageCount?: number}
 *   | {ok: false, reason: string, detail?: string}>}
 */
export async function extractText(filePath, options = {}) {
  const target = typeof filePath === 'string' ? filePath : '';
  if (target === '') return { ok: false, reason: 'empty-path' };
  const ext = path.extname(target).toLowerCase();
  if (!HOMEWORK_EXTS.includes(ext)) return { ok: false, reason: 'unsupported-ext', detail: ext };

  let buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    return { ok: false, reason: 'read-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  if (ext === '.pdf') {
    const result = await extractPdfText(buffer, options);
    if (!result.ok) return result;
    return { ok: true, kind: 'pdf', text: result.text, chars: result.chars, truncated: result.truncated, pageCount: result.pageCount };
  }

  if (ext === '.docx' || ext === '.pptx') {
    const result = extractOfficeText(buffer, ext);
    if (!result.ok) return result;
    const text = normalizeText(result.text).slice(0, Math.max(1000, Number(options.maxChars) || MAX_CHARS));
    if (text === '') return { ok: false, reason: 'no-text' };
    return { ok: true, kind: ext.slice(1), text, chars: text.length, truncated: false };
  }

  const text = normalizeText(buffer.toString('utf8')).slice(0, Math.max(1000, Number(options.maxChars) || MAX_CHARS));
  if (text === '') return { ok: false, reason: 'no-text' };
  return { ok: true, kind: ext.slice(1), text, chars: text.length, truncated: false };
}

/** 判定「文字层疑似坏了」所需的最少字母数；太少时比例没有意义。 */
export const QUALITY_MIN_LETTERS = 40;
/** 单个字母占比达到这个值就判定为可疑（正常题面英文字母分布不会这么集中）。 */
export const QUALITY_TOP_RATIO = 0.34;

/**
 * 判断取出来的文字层是不是「被公式字体压坏了」。
 *
 * 现场依据：数据结构第 01 次作业的 PDF，数学符号在文字层里**全部**是 `U+1D400`（`𝐀`），
 * NFKC 之后一律变成 `A`，于是「设 f(n)=g(n²)」取出来是「设A(A)=A(A2)」。
 * 这类文件取字不会报错，模型却拿它当题面硬答，必须在使用前拦住。
 *
 * 判据故意做得保守：只提示、不阻断——用户可能确实想拿不全的题面先跑一版。
 * @param {unknown} text 已归一化的题面文字
 * @returns {{suspect: boolean, letters: number, char: string, ratio: number}}
 */
export function analyzeTextQuality(text) {
  // 必须先 NFKC：被压坏的公式字体在原文里是 U+1D400 区（`𝐀`），不归一化就统计不到它们，
  // 真实样本（第 01 次作业）会只剩 13 个 ASCII 字母，质量门永远不触发。
  const body = typeof text === 'string' ? normalizeText(text) : '';
  const letters = [];
  for (const ch of body) if (/[A-Za-z]/.test(ch)) letters.push(ch);
  if (letters.length < QUALITY_MIN_LETTERS) return { suspect: false, letters: letters.length, char: '', ratio: 0 };

  const counts = new Map();
  for (const ch of letters) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let char = '';
  let top = 0;
  for (const [ch, times] of counts) {
    if (times > top) { top = times; char = ch; }
  }
  const ratio = top / letters.length;
  return {
    suspect: ratio >= QUALITY_TOP_RATIO,
    letters: letters.length,
    char,
    ratio: Math.round(ratio * 1000) / 1000,
  };
}
