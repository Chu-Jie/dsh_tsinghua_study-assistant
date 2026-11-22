/**
 * 助手会话（v2-C，2026-11-21）：学习助手浮层的多会话落盘 + 上下文压缩。
 *
 * 设计约束（见任务卡 `学习助手v2-C会话管理-开发卡.md` §⑤/⑥）：
 * - 落点是 `学习台/助手会话/`（**旁挂目录**，与 `学习记录/` 同类）：
 *   **不进** DOC_KEYS、不进 `/state` 轮询、不进备份包。每会话一文件 `<id>.json`。
 * - 索引可重建：目录即真源，`索引.json` 只是缓存（读坏了能扫目录重建）。
 * - 写入一律「临时文件 + rename」原子写；写前把旧文件复制到 `助手会话/_backup/`，
 *   每个目标只保留最近 `BACKUP_KEEP=10` 份（照抄 `lib/study-log.js` 的成熟范式，**不共用**其函数）。
 * - **磁盘存完整 messages**：上下文压缩只发生在「发给模型前」，绝不删磁盘早期消息。
 * - 摘要失败降级不阻塞：`buildSendMessages` 在 summary 为空时退回全量/近 N 轮，答得出来就行。
 *
 * 命名约定（避开 E2 钉子名，见 `tests/records-panel.test.js`）：
 *   本文件导出的所有函数 / 常量都用 `assistant` / `asst` / `convo` 语义，
 *   绝不出现 `readChatIndex` / `readChatSession` / `writeChatSession` 等旧对话函数名。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 常量（都可单测）
// ---------------------------------------------------------------------------

/** 会话根目录名（相对数据目录 `学习台/`）。 */
export const ASSISTANT_SESSION_DIR_NAME = '助手会话';
/** 索引文件名（缓存，目录即真源）。 */
export const ASSISTANT_INDEX_FILE = '索引.json';
/** 备份子目录名。 */
export const ASSISTANT_BACKUP_DIR_NAME = '_backup';
/** 每个会话文件保留的备份份数。 */
export const ASSISTANT_BACKUP_KEEP = 10;
/** messages 总条数 **超过** 此值触发压缩（默认 30）。 */
export const COMPRESS_TRIGGER_TURNS = 30;
/** 压缩时原样保留的最近消息条数（默认 10 条 ≈ 5 轮）。 */
export const KEEP_RECENT_TURNS = 10;
/** 自动标题取首条用户消息前多少字。 */
export const TITLE_MAX_CHARS = 20;
/** 空会话默认标题。 */
export const DEFAULT_SESSION_TITLE = '新会话';
/** 允许的消息角色。 */
export const SESSION_ROLES = ['user', 'assistant', 'system'];
/** 单条消息内容硬上限（与 api 的 ASSISTANT_MAX_MESSAGE_CHARS 同口径）。 */
const SESSION_MAX_MESSAGE_CHARS = 20000;

/** 备份名唯一后缀的进程内序号：同毫秒连写不再互相覆盖。 */
let backupSeq = 0;

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 会话根目录绝对路径。 */
export function assistantSessionRoot(dataDir) {
  return path.join(String(dataDir ?? ''), ASSISTANT_SESSION_DIR_NAME);
}

/** 备份目录绝对路径。 */
export function assistantBackupRoot(dataDir) {
  return path.join(assistantSessionRoot(dataDir), ASSISTANT_BACKUP_DIR_NAME);
}

/** 索引文件绝对路径。 */
export function assistantIndexPath(dataDir) {
  return path.join(assistantSessionRoot(dataDir), ASSISTANT_INDEX_FILE);
}

/**
 * 单个会话文件绝对路径。`id` 会被安全化，防止路径逃逸。
 * @param {string} dataDir 数据目录（学习台）
 * @param {string} id 会话 id
 */
export function assistantSessionPath(dataDir, id) {
  return path.join(assistantSessionRoot(dataDir), `${safeId(id)}.json`);
}

// ---------------------------------------------------------------------------
// 纯函数：id / 标题 / 规整
// ---------------------------------------------------------------------------

/** 文件名安全化：挡住路径分隔符、控制字符、Windows 非法字符与前后点号。 */
export function safeId(input, fallback = 'session') {
  const raw = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return /^[._\s]*$/.test(raw) ? fallback : raw;
}

/** 生成会话 id：`asst_<时间戳>_<随机>`（避开旧的 `chat_` 前缀）。 */
export function newSessionId(now = new Date(), rand = Math.random().toString(36).slice(2, 6)) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `asst_${stamp}_${String(rand).replace(/[^a-z0-9]/gi, '').slice(0, 4) || '0000'}`;
}

/**
 * 由首条用户消息推默认标题：折叠空白，取前 `TITLE_MAX_CHARS` 字。
 * @param {string} content 首条用户消息
 * @param {number} [maxChars]
 */
export function deriveTitle(content, maxChars = TITLE_MAX_CHARS) {
  const clean = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '') return DEFAULT_SESSION_TITLE;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : TITLE_MAX_CHARS;
  return clean.slice(0, limit);
}

/**
 * 规整一条消息：role 白名单 + content 非空字符串并限长。
 * @returns {{ok:true, value:{role,content,at,action}} | {ok:false, reason:string}}
 */
export function normalizeSessionMessage(input, nowIso = new Date().toISOString()) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (!SESSION_ROLES.includes(source.role)) return { ok: false, reason: 'bad-role' };
  if (typeof source.content !== 'string' || source.content.trim() === '') {
    return { ok: false, reason: 'bad-content' };
  }
  const content = source.content.length > SESSION_MAX_MESSAGE_CHARS
    ? source.content.slice(0, SESSION_MAX_MESSAGE_CHARS)
    : source.content;
  const value = {
    role: source.role,
    content,
    at: typeof source.at === 'string' && source.at.trim() !== '' ? source.at.trim() : nowIso,
  };
  // 掌握度预览的 proposedAction（可选）也要落盘，切回会话能看到「当时提议改了什么」
  if (source.action !== undefined && source.action !== null && typeof source.action === 'object') {
    value.action = source.action;
  }
  return { ok: true, value };
}

/** 规整一个空会话骨架（新建时用）。 */
export function buildNewSession(input = {}, nowIso = new Date().toISOString()) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const id = typeof source.id === 'string' && source.id.trim() !== '' ? safeId(source.id) : newSessionId();
  const titleRaw = typeof source.title === 'string' ? source.title.replace(/\s+/g, ' ').trim() : '';
  return {
    id,
    title: titleRaw === '' ? DEFAULT_SESSION_TITLE : titleRaw.slice(0, 120),
    titleCustom: source.titleCustom === true,
    createdAt: nowIso,
    updatedAt: nowIso,
    summary: '',
    summaryUpTo: 0,
    archived: false,
    messages: [],
  };
}

/** 规整一份完整会话（读盘后 / 写盘前统一形状；缺字段补默认，坏消息丢弃）。 */
export function normalizeSessionDoc(input, nowIso = new Date().toISOString()) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const messages = [];
  const rawMessages = Array.isArray(source.messages) ? source.messages : [];
  for (const raw of rawMessages) {
    const norm = normalizeSessionMessage(raw, nowIso);
    if (norm.ok === true) messages.push(norm.value);
  }
  return {
    id: safeId(source.id),
    title: typeof source.title === 'string' && source.title !== '' ? source.title : DEFAULT_SESSION_TITLE,
    titleCustom: source.titleCustom === true,
    createdAt: typeof source.createdAt === 'string' && source.createdAt !== '' ? source.createdAt : nowIso,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt !== '' ? source.updatedAt : nowIso,
    summary: typeof source.summary === 'string' ? source.summary : '',
    summaryUpTo: Number.isInteger(source.summaryUpTo) && source.summaryUpTo >= 0 ? source.summaryUpTo : 0,
    archived: source.archived === true,
    messages,
  };
}

/** 索引条目（列表接口返回的摘要头，不含整段 messages）。 */
export function buildIndexEntry(session) {
  const source = session !== null && typeof session === 'object' ? session : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  return {
    id: String(source.id ?? ''),
    title: String(source.title ?? DEFAULT_SESSION_TITLE),
    updatedAt: String(source.updatedAt ?? ''),
    createdAt: String(source.createdAt ?? ''),
    archived: source.archived === true,
    messageCount: messages.length,
    summaryHead: typeof source.summary === 'string' ? source.summary.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
  };
}

// ---------------------------------------------------------------------------
// 纯函数：追加消息 + 自动命名
// ---------------------------------------------------------------------------

/**
 * 把一轮新消息（用户 + 可选助手）追加进会话，更新 updatedAt、必要时首条自动命名。
 * 返回新会话对象（不改入参）。
 * @param {object} session 现有会话
 * @param {Array<object>} newMessages 待追加的消息（{role,content,at?,action?}）
 * @param {string} nowIso 当前时间
 */
export function appendMessages(session, newMessages, nowIso = new Date().toISOString()) {
  const doc = normalizeSessionDoc(session, nowIso);
  const incoming = Array.isArray(newMessages) ? newMessages : [];
  const hadNoUser = !doc.messages.some((item) => item.role === 'user');
  const appended = doc.messages.slice();
  let firstUserContent = null;
  for (const raw of incoming) {
    const norm = normalizeSessionMessage(raw, nowIso);
    if (norm.ok !== true) continue;
    if (firstUserContent === null && norm.value.role === 'user' && hadNoUser) {
      firstUserContent = norm.value.content;
    }
    appended.push(norm.value);
  }
  const next = { ...doc, messages: appended, updatedAt: nowIso };
  // 首条用户消息自动命名（仅当尚未自定义标题）
  if (firstUserContent !== null && doc.titleCustom !== true) {
    next.title = deriveTitle(firstUserContent);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 纯函数：上下文压缩
// ---------------------------------------------------------------------------

/**
 * 判断是否需要压缩：messages 总条数 **超过** `trigger` 才触发。
 * @param {object|Array} sessionOrMessages
 * @param {number} [trigger]
 */
export function shouldCompress(sessionOrMessages, trigger = COMPRESS_TRIGGER_TURNS) {
  const messages = Array.isArray(sessionOrMessages)
    ? sessionOrMessages
    : (Array.isArray(sessionOrMessages?.messages) ? sessionOrMessages.messages : []);
  const limit = Number.isFinite(trigger) && trigger >= 0 ? trigger : COMPRESS_TRIGGER_TURNS;
  return messages.length > limit;
}

/**
 * 算出「发给模型前」的 messages 拼装：`[summary system] + messages.slice(summaryUpTo)`。
 *
 * 规则（卡 §5.3）：
 *   - summary 非空 → 最前面加一条 `{role:'system', content:'【之前对话摘要】'+summary}`；
 *   - 正文是 `messages.slice(summaryUpTo)`（summaryUpTo 之前已被摘要覆盖，只发摘要）；
 *   - summary 为空时退回全量 messages（首次压缩前 / 摘要失败降级）。
 *
 * @param {object} session 会话（含 messages / summary / summaryUpTo）
 * @returns {Array<{role:string, content:string}>}
 */
export function buildSendMessages(session) {
  const doc = session !== null && typeof session === 'object' ? session : {};
  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  const summary = typeof doc.summary === 'string' ? doc.summary.trim() : '';
  const upTo = Number.isInteger(doc.summaryUpTo) && doc.summaryUpTo > 0
    ? Math.min(doc.summaryUpTo, messages.length)
    : 0;
  const tail = messages.slice(upTo).map((item) => ({ role: item.role, content: item.content }));
  if (summary === '') return tail;
  return [{ role: 'system', content: `【之前对话摘要】${summary}` }].concat(tail);
}

/**
 * 算出「这次要把哪些消息并入摘要」：当触发压缩时，把 `[summaryUpTo, len-KEEP_RECENT)` 段交出来。
 *
 * @param {object} session
 * @param {number} [keepRecent]
 * @returns {{needCompress: boolean, from: number, to: number, segment: Array<object>}}
 *   `segment` 是要喂给摘要模型的早期消息（从 summaryUpTo 到 len-KEEP_RECENT，不含近 N 轮）。
 */
export function planCompression(session, keepRecent = KEEP_RECENT_TURNS) {
  const doc = session !== null && typeof session === 'object' ? session : {};
  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  const keep = Number.isFinite(keepRecent) && keepRecent >= 0 ? Math.floor(keepRecent) : KEEP_RECENT_TURNS;
  if (!shouldCompress(messages)) return { needCompress: false, from: 0, to: 0, segment: [] };
  const upTo = Number.isInteger(doc.summaryUpTo) && doc.summaryUpTo > 0
    ? Math.min(doc.summaryUpTo, messages.length)
    : 0;
  const to = Math.max(upTo, messages.length - keep);
  if (to <= upTo) return { needCompress: false, from: upTo, to, segment: [] };
  return { needCompress: true, from: upTo, to, segment: messages.slice(upTo, to) };
}

/**
 * 把一段消息拼成给摘要模型的纯文本（不调网络，便于单测）。
 * @param {string} previousSummary 上次摘要（可能为空）
 * @param {Array<object>} segment 本次要并入的早期消息
 */
export function buildSummaryPrompt(previousSummary, segment) {
  const prev = typeof previousSummary === 'string' ? previousSummary.trim() : '';
  const lines = [];
  if (prev !== '') lines.push(`【更早的摘要】${prev}`);
  for (const item of Array.isArray(segment) ? segment : []) {
    const who = item?.role === 'user' ? '用户' : item?.role === 'assistant' ? '助手' : '系统';
    const text = String(item?.content ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') lines.push(`${who}：${text}`);
  }
  return lines.join('\n');
}

/**
 * 把摘要模型返回的文本套进会话（更新 summary + summaryUpTo）。
 * 纯函数：不改入参。
 * @param {object} session
 * @param {string} summaryText 模型返回的摘要
 * @param {number} upTo 覆盖到的消息下标
 */
export function applySummary(session, summaryText, upTo) {
  const doc = normalizeSessionDoc(session);
  const clean = String(summaryText ?? '').replace(/\s+/g, ' ').trim();
  const nextUpTo = Number.isInteger(upTo) && upTo >= 0 ? Math.min(upTo, doc.messages.length) : doc.summaryUpTo;
  return { ...doc, summary: clean, summaryUpTo: nextUpTo };
}

// ---------------------------------------------------------------------------
// 磁盘层（薄封装，照 study-log 范式但不共用其函数）
// ---------------------------------------------------------------------------

/** 读 JSON，不存在/坏文件都回 fallback（不抛）。 */
async function readJsonOr(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 把旧文件复制到备份目录，并只保留最近 ASSISTANT_BACKUP_KEEP 份。 */
async function backupExisting(file, backupDir) {
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
  const uniq = `-${process.pid}-${String(backupSeq++).padStart(4, '0')}`;
  const copyTo = path.join(backupDir, `${base}.${stamp}${uniq}.bak`);
  try {
    await fs.copyFile(file, copyTo);
  } catch {
    return;
  }
  try {
    const names = (await fs.readdir(backupDir))
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith('.bak'));
    names.sort();
    const stale = names.slice(0, Math.max(0, names.length - ASSISTANT_BACKUP_KEEP));
    for (const name of stale) {
      await fs.rm(path.join(backupDir, name), { force: true });
    }
  } catch {
    // 清理失败不影响主写入
  }
}

/** 原子写 JSON：备份旧文件 → 写临时文件 → rename。 */
async function atomicWriteJson(file, data, options = {}) {
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

/**
 * 目录即真源：扫描 `助手会话/` 下所有 `<id>.json`，读出来规整成会话数组。
 * 索引丢了/坏了都能靠它重建。坏文件跳过（不抛）。
 */
export async function scanSessions(dataDir) {
  const root = assistantSessionRoot(dataDir);
  let names = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === ASSISTANT_INDEX_FILE) continue;
    if (name.includes('.tmp-')) continue;
    const file = path.join(root, name);
    const doc = await readJsonOr(file, null);
    if (doc === null || typeof doc !== 'object') continue;
    const normalized = normalizeSessionDoc(doc);
    if (normalized.id === '') continue;
    out.push(normalized);
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

/**
 * 读单会话全文（不存在回 null）。
 * @param {string} dataDir
 * @param {string} id
 */
export async function readSession(dataDir, id) {
  const doc = await readJsonOr(assistantSessionPath(dataDir, id), null);
  return doc !== null && typeof doc === 'object' ? normalizeSessionDoc(doc) : null;
}

/**
 * 写单会话 + 重建索引（索引可重建，写坏了也能扫目录救回）。
 * @returns {{ok:true, entry:object}}
 */
export async function writeSession(dataDir, session) {
  const doc = normalizeSessionDoc(session);
  if (doc.id === '') return { ok: false, error: 'missing-id' };
  await atomicWriteJson(assistantSessionPath(dataDir, doc.id), doc, { backupDir: assistantBackupRoot(dataDir) });
  await rebuildIndex(dataDir);
  return { ok: true, entry: buildIndexEntry(doc) };
}

/**
 * 从目录重建索引（按 updatedAt 倒序）。
 * @returns {Array<object>} 新索引数组
 */
export async function rebuildIndex(dataDir) {
  const sessions = await scanSessions(dataDir);
  const index = sessions.map((item) => buildIndexEntry(item));
  await atomicWriteJson(assistantIndexPath(dataDir), { version: 1, sessions: index }, {
    backupDir: assistantBackupRoot(dataDir),
  });
  return index;
}

/**
 * 读索引（缓存）；缓存缺失/坏掉时自动扫目录重建，保证列表永远拿得到。
 * @returns {Array<object>}
 */
export async function readIndex(dataDir) {
  const doc = await readJsonOr(assistantIndexPath(dataDir), null);
  if (Array.isArray(doc?.sessions)) return doc.sessions;
  return rebuildIndex(dataDir);
}

/**
 * 列出会话摘要（可选按 archive 过滤：默认 `includeArchived=false` 时隐藏归档）。
 * @param {string} dataDir
 * @param {{includeArchived?: boolean}} [options]
 */
export async function listSessions(dataDir, options = {}) {
  const sessions = await scanSessions(dataDir);
  const includeArchived = options.includeArchived === true;
  return sessions
    .filter((item) => includeArchived || item.archived !== true)
    .map((item) => buildIndexEntry(item));
}

/**
 * 改名：置 titleCustom=true（此后不再自动覆盖标题）。
 * @returns {{ok:true, session:object} | {ok:false, error:string}}
 */
export async function renameSession(dataDir, id, title, nowIso = new Date().toISOString()) {
  const doc = await readSession(dataDir, id);
  if (doc === null) return { ok: false, error: 'not-found' };
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '') return { ok: false, error: 'empty-title' };
  const next = { ...doc, title: clean.slice(0, 120), titleCustom: true, updatedAt: nowIso };
  await writeSession(dataDir, next);
  return { ok: true, session: next };
}

/**
 * 归档 / 取消归档：只加标记位，**不删磁盘**。
 * @returns {{ok:true, session:object} | {ok:false, error:string}}
 */
export async function archiveSession(dataDir, id, archived, nowIso = new Date().toISOString()) {
  const doc = await readSession(dataDir, id);
  if (doc === null) return { ok: false, error: 'not-found' };
  const next = { ...doc, archived: archived === true, updatedAt: nowIso };
  await writeSession(dataDir, next);
  return { ok: true, session: next };
}

/**
 * 新建会话（空文件，返回 id）。也可带初始 title。
 * @returns {Promise<object>} 新会话对象
 */
export async function createSession(dataDir, input = {}, nowIso = new Date().toISOString()) {
  const doc = buildNewSession(input, nowIso);
  await writeSession(dataDir, doc);
  return doc;
}

/** 判断会话文件是否存在。 */
export async function sessionExists(dataDir, id) {
  try {
    await fs.stat(assistantSessionPath(dataDir, id));
    return true;
  } catch {
    return false;
  }
}
