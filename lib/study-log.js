/**
 * 学习记录（P3）：阅读位置、对话归档、时间线学习记录。
 *
 * 设计约束（见 `_工具/契约-个人编辑层与交互助手_20261030.md` §5）：
 * - 这些数据**不进** 11/12 份主文档的 DOC_KEYS、不进 `/state` 轮询、不进备份包；
 *   落点是 `学习台/学习记录/`，永远在插件仓库之外（含隐私）。
 * - 写入一律「临时文件 + rename」原子写；写前把旧文件复制到 `学习记录/_backup/`，
 *   每个目标只保留最近 10 份，避免像主文档那样能整体回滚。
 * - 这里只有纯函数 + 与磁盘打交道的薄封装，方便单测；`lib/api.js` 负责路由。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 学习记录根目录名（相对数据目录 `学习台/`）。 */
export const STUDY_LOG_DIR_NAME = '学习记录';
/** 阅读位置文件名。 */
export const READING_POSITION_FILE = '阅读位置.json';
/** 学习时长文件名（C2，2026-11-17）：正计时 + 番茄钟每段一条；与新落盘契约绑定，不进 DOC_KEYS/不进 /state/不进备份包。 */
export const LEARNING_DURATION_FILE = '学习时长.json';
/** 学习时长允许的归档粒度白名单（与 SCOPE_TYPES 同口径，去掉 free 也保留：自由阅读也算一段）。 */
export const DURATION_SCOPE_TYPES = ['node', 'material', 'chapter', 'free'];
/** 学习时长允许的计时模式。 */
export const DURATION_MODES = ['stopwatch', 'pomodoro'];
/** <5 秒的碎片不落盘（防切来切去刷数据）。 */
export const DURATION_MIN_SECONDS = 5;
/** 对话子目录名。 */
export const CHAT_DIR_NAME = '对话';
/** 对话索引文件名。 */
export const CHAT_INDEX_FILE = '对话索引.json';
/** 备份子目录名。 */
export const BACKUP_DIR_NAME = '_backup';
/** 注入上下文的硬上限（字）。与知识讲解证据预算一致，超出截断并提示「只读了前 N 字」。 */
export const CONTEXT_MAX_CHARS = 6000;
/** 每个目标文件保留的备份份数。 */
export const BACKUP_KEEP = 10;
/** 备份名唯一后缀的进程内序号：同毫秒连写不再互相覆盖（跨进程同毫秒极罕见，由 pid 兜底）。 */
let backupSeq = 0;
/** 允许的归档粒度。 */
export const SCOPE_TYPES = ['node', 'material', 'chapter', 'free'];

/** 学习记录根目录绝对路径。 */
export function studyLogRoot(dataDir) {
  return path.join(String(dataDir ?? ''), STUDY_LOG_DIR_NAME);
}

/** 阅读位置文件绝对路径。 */
export function readingPositionPath(dataDir) {
  return path.join(studyLogRoot(dataDir), READING_POSITION_FILE);
}

/** 学习时长文件绝对路径（C2）。 */
export function learningDurationPath(dataDir) {
  return path.join(studyLogRoot(dataDir), LEARNING_DURATION_FILE);
}

/** 判断是否是合法 ISO 时间串（`Date.parse` 能解析且非 NaN）。 */
function isIsoTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * 规整一条学习时长记录（C2）。
 * 校验：起止 ISO、endAt≥startAt、seconds 整数且 ≥DURATION_MIN_SECONDS、
 * scopeType 白名单 node/material/chapter/free、mode 白名单 stopwatch/pomodoro、path 禁 `..`。
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function normalizeDurationRecord(input, nowIso = new Date().toISOString()) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const startAt = String(source.startAt ?? '').trim();
  const endAt = String(source.endAt ?? '').trim();
  if (startAt === '') return { ok: false, reason: 'missing-start' };
  if (endAt === '') return { ok: false, reason: 'missing-end' };
  if (!isIsoTime(startAt) || !isIsoTime(endAt)) return { ok: false, reason: 'bad-time' };
  if (Date.parse(endAt) < Date.parse(startAt)) return { ok: false, reason: 'end-before-start' };
  const seconds = source.seconds;
  if (!Number.isInteger(seconds) || seconds < DURATION_MIN_SECONDS) return { ok: false, reason: 'bad-seconds' };
  const scopeType = String(source.scopeType ?? '').trim();
  if (!DURATION_SCOPE_TYPES.includes(scopeType)) return { ok: false, reason: 'bad-scope' };
  const mode = String(source.mode ?? '').trim();
  if (!DURATION_MODES.includes(mode)) return { ok: false, reason: 'bad-mode' };
  const pathValue = String(source.path ?? '').replace(/\\/g, '/').trim();
  if (pathValue.split('/').includes('..')) return { ok: false, reason: 'bad-path' };
  const value = {
    startAt,
    endAt,
    seconds,
    scopeType,
    courseId: String(source.courseId ?? '').trim(),
    nodeId: String(source.nodeId ?? '').trim(),
    path: pathValue,
    chapterNo: String(source.chapterNo ?? '').trim(),
    mode,
    recordedAt: typeof source.recordedAt === 'string' && source.recordedAt.trim() !== '' ? source.recordedAt.trim() : nowIso,
  };
  return { ok: true, value };
}

/** 某个课程的对话目录绝对路径。 */
export function chatDir(dataDir, courseId) {
  return path.join(studyLogRoot(dataDir), CHAT_DIR_NAME, safeName(courseId, 'unknown-course'));
}

/** 单条对话文件绝对路径。`name` 用会话 id 或标题，都会被 sanitize。 */
export function chatFilePath(dataDir, courseId, name) {
  return path.join(chatDir(dataDir, courseId), `${safeName(name, 'chat')}.json`);
}

/** 对话索引文件绝对路径。 */
export function chatIndexPath(dataDir) {
  return path.join(studyLogRoot(dataDir), CHAT_INDEX_FILE);
}

/** 备份目录绝对路径。 */
export function backupRoot(dataDir) {
  return path.join(studyLogRoot(dataDir), BACKUP_DIR_NAME);
}

/**
 * 文件名安全化：中文允许（数据目录在仓库外），但要挡住路径分隔符、控制字符、
 * Windows 非法字符与前后点号，防止 `safeName('../x')` 之类逃逸。
 */
export function safeName(input, fallback = 'untitled') {
  const raw = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return /^[._\s]*$/.test(raw) ? fallback : raw;
}

/** 截断注入上下文：返回截断后文本与「总字数 / 实际读入字数 / 是否截断」。 */
export function clipContext(text, maxChars = CONTEXT_MAX_CHARS) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : CONTEXT_MAX_CHARS;
  const total = raw.length;
  const truncated = total > limit;
  return {
    text: truncated ? raw.slice(0, limit) : raw,
    chars: truncated ? limit : total,
    total,
    truncated,
  };
}

/**
 * 规整阅读位置。
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function normalizeReadingPosition(input, nowIso = new Date().toISOString()) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const pathValue = String(source.path ?? '').replace(/\\/g, '/').trim();
  if (pathValue === '') return { ok: false, reason: 'missing-path' };
  if (pathValue.split('/').includes('..')) return { ok: false, reason: 'bad-path' };
  const pageRaw = source.page === undefined || source.page === null ? null : source.page;
  if (pageRaw !== null && !(Number.isInteger(pageRaw) && pageRaw >= 1)) return { ok: false, reason: 'bad-page' };
  const offsetRaw = source.offset === undefined || source.offset === null ? 0 : source.offset;
  if (!(Number.isInteger(offsetRaw) && offsetRaw >= 0)) return { ok: false, reason: 'bad-offset' };
  const value = {
    courseId: String(source.courseId ?? '').trim(),
    path: pathValue,
    page: pageRaw,
    offset: offsetRaw,
    scopeType: String(source.scopeType ?? '').trim(),
    nodeId: String(source.nodeId ?? '').trim(),
    chapterNo: String(source.chapterNo ?? '').trim(),
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt.trim() !== '' ? source.updatedAt.trim() : nowIso,
  };
  return { ok: true, value };
}

/** 规整归档范围（课程/章节/知识点/free）。 */
export function normalizeScope(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const type = String(source.type ?? '').trim();
  const safeType = SCOPE_TYPES.includes(type) ? type : 'free';
  const pageRaw = source.page === undefined || source.page === null ? null : source.page;
  return {
    type: safeType,
    nodeId: String(source.nodeId ?? '').trim(),
    path: String(source.path ?? '').replace(/\\/g, '/').trim(),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : null,
    chapterNo: String(source.chapterNo ?? '').trim(),
    courseId: String(source.courseId ?? '').trim(),
  };
}

/** 对话标题：优先用节点名 / 章节号，兜底用 scope 描述。 */
export function chatTitleFor(scope, name = '') {
  const clean = String(name ?? '').trim();
  if (clean !== '') return clean.slice(0, 60);
  const s = normalizeScope(scope);
  if (s.chapterNo !== '') return `第 ${s.chapterNo} 章`;
  if (s.path !== '') return path.basename(s.path).replace(/\.[^.]+$/, '');
  return '临时对话';
}

/** 索引条目只保留 6 个字段（契约 §5.1）。 */
export function buildChatIndexEntry(session) {
  const source = session !== null && typeof session === 'object' ? session : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  return {
    id: String(source.id ?? ''),
    title: String(source.title ?? ''),
    courseId: String(source.courseId ?? ''),
    scope: normalizeScope(source.scope),
    updatedAt: String(source.updatedAt ?? ''),
    messageCount: messages.length,
  };
}

/**
 * 时间线学习记录：只用现有 JSON，不埋点、不编造时长。
 * 每条事件都带 `basis` 标明数据来源文件。
 * @returns {Array<{kind:string, at:string, title:string, detail:string, basis:string}>}
 */
export function buildTimeline({ readingPosition = null, annotations = null, knowledgeNetwork = null } = {}) {
  const events = [];
  const push = (event) => {
    if (typeof event.at === 'string' && event.at.trim() !== '') events.push(event);
  };

  // 1) 阅读位置（读过什么）——只有 record 带 updatedAt 才排进时间线
  if (readingPosition !== null && typeof readingPosition === 'object') {
    const at = String(readingPosition.updatedAt ?? '').trim();
    const rel = String(readingPosition.path ?? '').replace(/\\/g, '/').trim();
    if (rel !== '') {
      const page = Number.isInteger(readingPosition.page) ? ` 第 ${readingPosition.page} 页` : '';
      push({
        kind: 'read',
        at,
        title: `读到：${path.basename(rel)}${page}`,
        detail: rel,
        basis: '阅读位置.json',
      });
    }
  }

  // 2) 批注过什么
  const notes = Array.isArray(annotations?.notes) ? annotations.notes : [];
  for (const note of notes) {
    if (note === null || typeof note !== 'object') continue;
    const at = String(note.updatedAt ?? note.createdAt ?? '').trim();
    const file = String(note.file ?? '').replace(/\\/g, '/').trim();
    const body = String(note.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    push({
      kind: 'note',
      at,
      title: `批注：${body === '' ? '（空）' : body}`,
      detail: file,
      basis: '批注.json',
    });
  }

  // 3) 标了什么知识点（reviewedAt 是掌握度变化时由服务端补的时间）
  const nodes = Array.isArray(knowledgeNetwork?.nodes) ? knowledgeNetwork.nodes : [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const at = String(node.reviewedAt ?? '').trim();
    if (at === '') continue;
    const name = String(node.name ?? '').trim();
    const mastery = Number.isInteger(node.mastery) ? node.mastery : 0;
    const marks = [`掌握度 ${mastery}/3`];
    if (node.marked === true) marks.push('重点');
    push({
      kind: 'knowledge',
      at,
      title: `知识点：${name === '' ? '（未命名）' : name}`,
      detail: marks.join(' · '),
      basis: '知识点网络.json',
    });
  }

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return events.slice(0, 300);
}

// ---------------------------------------------------------------------------
// 磁盘层（薄封装）
// ---------------------------------------------------------------------------

/** 读 JSON，不存在/坏文件都回 fallback（不抛）。 */
export async function readJsonOr(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    return fallback;
  }
}

/** 把旧文件复制到备份目录，并只保留最近 BACKUP_KEEP 份。 */
export async function backupExisting(file, backupDir) {
  let exists = false;
  try {
    await fs.stat(file);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists || typeof backupDir !== 'string' || backupDir === '') return;
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(file);
  // 唯一后缀必须加在**时间戳之后**：下面按名字字典序 names.sort() 取最近 BACKUP_KEEP 份，
  // 时间戳定宽在最前，后缀只在同毫秒内决定先后（seq 补零定宽），不会打乱「最近 N 份」的取舍。
  const uniq = `-${process.pid}-${String(backupSeq++).padStart(4, '0')}`;
  const copyTo = path.join(backupDir, `${base}.${stamp}${uniq}.bak`);
  try {
    await fs.copyFile(file, copyTo);
  } catch {
    return;
  }
  // 只保留最近 BACKUP_KEEP 份（按名字里的时间戳倒序）
  try {
    const names = (await fs.readdir(backupDir)).filter((name) => name.startsWith(`${base}.`) && name.endsWith('.bak'));
    names.sort();
    const stale = names.slice(0, Math.max(0, names.length - BACKUP_KEEP));
    for (const name of stale) {
      await fs.rm(path.join(backupDir, name), { force: true });
    }
  } catch {
    // 清理失败不影响主写入
  }
}

/** 原子写 JSON：备份旧文件 → 写临时文件 → rename。 */
export async function atomicWriteJson(file, data, options = {}) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  if (typeof options.backupDir === 'string' && options.backupDir !== '') {
    await backupExisting(file, options.backupDir);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** 读阅读位置（不存在回 null）。 */
export async function readReadingPosition(dataDir) {
  const doc = await readJsonOr(readingPositionPath(dataDir), null);
  return doc !== null && typeof doc === 'object' ? doc : null;
}

/** 写阅读位置（原子写 + 备份）。 */
export async function writeReadingPosition(dataDir, position) {
  await atomicWriteJson(readingPositionPath(dataDir), position, { backupDir: backupRoot(dataDir) });
}

/** 读学习时长（永远数组；坏文件/不存在都回空数组）。 */
export async function readLearningDurations(dataDir) {
  const doc = await readJsonOr(learningDurationPath(dataDir), null);
  return Array.isArray(doc?.records) ? doc.records : [];
}

/**
 * 追加一条学习时长（读旧 → push → 原子写 + 备份）。
 * @returns {{ok: true, record: object, total: number}}
 */
export async function appendLearningDuration(dataDir, record) {
  const records = await readLearningDurations(dataDir);
  records.push(record);
  await atomicWriteJson(learningDurationPath(dataDir), { version: 1, records }, { backupDir: backupRoot(dataDir) });
  return { ok: true, record, total: records.length };
}

/** 读对话索引（永远是数组）。 */
export async function readChatIndex(dataDir) {
  const doc = await readJsonOr(chatIndexPath(dataDir), null);
  return Array.isArray(doc?.chats) ? doc.chats : [];
}

/** 读单条对话全文，不存在回 null。 */
export async function readChatSession(dataDir, courseId, id) {
  return readJsonOr(chatFilePath(dataDir, courseId, id), null);
}

/**
 * 写单条对话并重建所以索引（新→旧）。
 * @returns {{ok:true, entry:object}}
 */
export async function writeChatSession(dataDir, session) {
  const courseId = String(session?.courseId ?? '');
  const id = String(session?.id ?? '');
  await atomicWriteJson(chatFilePath(dataDir, courseId, id), session, { backupDir: backupRoot(dataDir) });
  const entry = buildChatIndexEntry(session);
  const index = await readChatIndex(dataDir);
  const rest = index.filter((item) => !(String(item?.id ?? '') === entry.id && String(item?.courseId ?? '') === entry.courseId));
  rest.unshift(entry);
  rest.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await atomicWriteJson(chatIndexPath(dataDir), { version: 1, chats: rest }, { backupDir: backupRoot(dataDir) });
  return { ok: true, entry };
}

/** 删除单条对话（连文件），返回是否删到。 */
export async function deleteChatSession(dataDir, courseId, id) {
  let removed = false;
  try {
    await fs.rm(chatFilePath(dataDir, courseId, id), { force: true });
    removed = true;
  } catch {
    removed = false;
  }
  const index = await readChatIndex(dataDir);
  const rest = index.filter((item) => !(String(item?.id ?? '') === String(id) && String(item?.courseId ?? '') === String(courseId)));
  if (rest.length !== index.length) {
    await atomicWriteJson(chatIndexPath(dataDir), { version: 1, chats: rest }, { backupDir: backupRoot(dataDir) });
  }
  return removed;
}

/** 生成会话 id：`chat_YYYYMMDD_HHMMSS_xxxx`。 */
export function newChatId(now = new Date(), rand = Math.random().toString(36).slice(2, 6)) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `chat_${stamp}_${String(rand).replace(/[^a-z0-9]/gi, '').slice(0, 4) || '0000'}`;
}
