/**
 * 学习台 HTTP 接口（零依赖，Node http 风格 handler）
 *
 * 挂载在 DSH 自己的 Web 端口上，不启动任何独立服务进程。
 * 路由前缀：/api/study-assistant
 *
 * 防护（沿用已有「作业控制台」中已验证的做法）：
 *   - 只允许 GET / POST；
 *   - 请求体上限 1 MiB；
 *   - 写请求必须带 Content-Type: application/json 与自定义头 X-Study-Request: 1
 *     （自定义头天然挡住跨站表单提交）；
 *   - 拒绝 Sec-Fetch-Site: cross-site；
 *   - 文档键走白名单，天然挡住路径穿越。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DOC_KEYS,
  DOC_FILES,
  ANNOTATION_TYPES,
  ANNOTATION_STYLE_COLORS,
  ANNOTATION_STYLE_HIGHLIGHTS,
  ANNOTATION_STYLE_UNDERLINES,
  ANNOTATION_STYLE_KEYS,
  ANNOTATION_MARK_KINDS,
  SCHEDULE_CATEGORIES,
  SCHEDULE_SOURCES,
  SCHEDULE_DEFAULT_CATEGORY,
  SCHEDULE_DEFAULT_SOURCE,
  makeId,
  isValidId,
  isClockTime,
  isPlainObject,
  parseDay,
  activeTasks,
  buildOverview,
  buildDailyBrief,
  buildNewsBoard,
  formatDailyBrief,
  currentTerm,
  defaultDoc,
  parseDue,
  validateDoc,
} from './core.js';
import { MAX_ANCHOR_CHARS, resolveAnchorFromText } from './annotation-anchor.js';
import {
  buildCandidates,
  diffCandidates,
  fetchHomeworkDetail,
  fetchHomeworkForCourses,
  fetchLearnCourses,
  fetchLearnIndex,
  learnMarkOf,
  matchCourse,
  parseLearnKey,
  pickRows,
  toTaskItem,
} from './learn.js';
import { createLearnBrowser } from './learn-browser.js';
import { readDetailEntry, writeDetailEntry } from './learn-detail-cache.js';
// 一键开工自动取料（2026-11-23）：后端先把原题/附件/教材题号页截图/课程公告落到本地，
// 会话里的 agent 只读本地 —— 取料逻辑与提示词拼装分离，便于单测。
import { collectHomeworkMaterials, describeIntake } from './homework-intake.js';
import { MAX_NO, alignAnswers, confirmDraft, splitQuestions, validateAnswer, warningFor } from './questions.js';
import { copyBytes, inspectWav, wavBytesForSeconds } from './lecture/wav.js';
import { clientModulePath, readImportHtml, readPanelHtml } from './lecture/panel.js';
import { collectDeliverables, parseTaskSeq } from './deliverables.js';
// 全量导出/恢复：包格式与校验和在 backup.js（纯函数），这里只负责读盘与写盘
import { buildBundle, verifyBundle } from './backup.js';
import { SPEECH_HINT } from './lecture/asr.js';
import { createLectureSession } from './lecture/session.js';
import { writeLectureNote } from './lecture/notes.js';
import { renderHandoffPrompt, renderNoteMarkdown } from './lecture/report.js';
import { listRecordings, readRecording } from './lecture/recording.js';
import { weaveCandidates } from './knowledge.js';
import { applyExport, planExport } from './kp-notes-export.js';
// 掌握度自动计算 + 学习行为口径（v2-B 卡）：纯函数模块，这里只负责读盘/写盘/回话
import {
  applySuggestedMastery,
  behaviorOf,
  buildMasteryBatchPlan,
  clampMastery,
  describeMasteryBatchPreview,
  describeMasteryPreview,
  looksLikeInheritCommand,
  looksLikeMasteryBatchCommand,
  looksLikeMasteryCommand,
  masteryLabel,
  parseMasteryBatchScope,
  parseMasteryIntent,
  recordVisit,
  resolveInheritedCommand,
} from './mastery.js';
import {
  buildTimeline,
  normalizeDurationRecord,
  normalizeReadingPosition,
  appendLearningDuration,
  readLearningDurations,
  readReadingPosition,
  writeReadingPosition,
} from './study-log.js';
// 助手会话（v2-C 卡）：落盘 `学习台/助手会话/` + 上下文压缩（旁挂目录，不进 DOC_KEYS/不进 /state/不进备份包）
import {
  appendMessages,
  applySummary,
  archiveSession,
  buildSendMessages,
  buildSummaryPrompt,
  createSession,
  listSessions,
  planCompression,
  readIndex,
  readSession,
  renameSession,
  writeSession,
} from './assistant-session.js';
// 学习画像（v2-D 卡）：纯函数拼装，读盘与接线都在本文件；画像只进 system，不进响应/日志
// 专注学习模式人设（v2-E 卡）：纯函数按 context.studyMode 开关，同样只进 system
import { buildPersonaHint, buildStudyModePersona } from './assistant-persona.js';

/** 路由前缀。 */
export const API_PREFIX = '/api/study-assistant';
/** 写请求必须携带的自定义头。 */
export const REQUEST_HEADER = 'x-study-request';
/** 请求体上限。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/**
 * 课堂录音单片时长上限（秒）。
 *
 * 128 秒 ≈ 2.7 分钟：足够覆盖「一段连续讲解」，又不至于让一次推理把
 * 单核占太久、把后续切片全堵在队列里。
 */
export const LECTURE_MAX_SECONDS = 120;
/** 短于这个秒数就不值得送去推理（多半是误触）。 */
export const LECTURE_MIN_SECONDS = 0.3;
/**
 * 录音单片请求体上限。
 *
 * ⚠️ 不能复用 `MAX_BODY_BYTES`：16 kHz 单声道 PCM16 每秒就是 32000 字节，
 *    8 秒音频约 250 KB 尚可，60 秒就到 1.92 MB，会被 1 MiB 的通用上限
 *    直接 413 掉 —— 而错误信息里只有 `too-large`，根本看不出是「音频太长」。
 *    所以录音单独给一个按秒数算出来的上限。
 */
export const LECTURE_MAX_BODY_BYTES = wavBytesForSeconds(LECTURE_MAX_SECONDS) + 4096;
/**
 * 网络学堂同步的配置文件，放在数据目录下。
 *
 * 刻意**不放进** `DOC_FILES` 白名单：它含会话 Cookie，属于凭据而不是学习数据，
 * 不应该出现在 `/state` 的返回里，也不该被 `/reset-doc` 碰到。
 */
export const LEARN_CONFIG_FILE = '网络学堂.json';
/** 凭据文件在数据目录下的完整路径。读、写、删三处都走它，避免哪天改了文件名漏掉一处。 */
function learnConfigPath(dataDir) {
  return path.join(dataDir, LEARN_CONFIG_FILE);
}
/**
 * 统一身份认证的账号密码（用户显式同意让插件存一份，用于「一键重连」时静默填表）。
 *
 * **单独一个文件、绝不进 `网络学堂.json`、绝不进仓库**：`网络学堂.json` 是 Cookie
 * 缓存（会被 `/state`/备份碰到的地方），而这个是**真密码**，只该被极少数代码路径
 * 读到。放在数据目录下一个 0600 权限的独立文件（`学习台/.learn-credential.json`），
 * 名字以 `.` 开头，不进任何文档白名单，`/state`、备份、`reset-doc` 都不碰它。
 */
const LEARN_CREDENTIAL_FILE = '.learn-credential.json';
function learnCredentialPath(dataDir) {
  return path.join(dataDir, LEARN_CREDENTIAL_FILE);
}
/** 网络学堂请求超时（毫秒）。 */
const LEARN_TIMEOUT_MS = 15000;
/**
 * 知识点插图的资产目录（放在数据目录下，`学习台/图片/`）。
 *
 * 只读路由 `/materials/image` 的**白名单**就是这里的 `_index.json`：图上不上得去，
 * 由索引说了算，客户端传什么路径都不能绕过去。索引只登记「从哪页裁的、图是什么」，
 * 不复制教材原文——所以图片是可以随时重建的派生产物（同 `讲解缓存/`）。
 */
const IMAGE_DIR_NAME = '图片';
/** 插图文件名 → 内容类型。只认这几种，其余当二进制流下发（浏览器也不会当图片渲染）。 */
const IMAGE_CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);
/** 单张插图上限：教材扫描页裁出来的图通常 < 1 MB，超过这个数多半是裁错了整页。 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 作业详情的缓存时长（毫秒）。
 *
 * 详情页一次约 60 KB，行内展开又会频繁开合 —— 同一节课连着点同一条不该反复拉；
 * 但也不能久置，老师可能刚批改完。3 分钟是「一次浏览里不重复拉」的量级。
 * 只有**成功**的结果进缓存，失败一律现拉。
 */
const LEARN_DETAIL_TTL_MS = 3 * 60 * 1000;

/** 统一 JSON 响应。 */
function sendJson(res, status, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 统一文本响应（听课面板的 HTML 与它 import 的 JS 模块走这里）。
 *
 * 刻意**不加** `Content-Security-Policy` 之类会拦住内联脚本的头：这张页面是
 * 本机自用的工具页，脚本就是它自己。但**必须**带 `Cache-Control: no-store`，
 * 否则改了页面对应的源码、浏览器还拿旧缓存，排查时会以为改动没生效。
 */
function sendText(res, status, contentType, body) {
  const text = typeof body === 'string' ? body : String(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 统一二进制响应（目前只有「按偏移读一段录音文件」用它）。
 *
 * `extra` 里的头会被原样写出去：录音文件在被腾讯会议写长的过程中读取，页面
 * 需要知道「这一段之后还有没有、下次从哪继续」，所以把 `end / size / eof`
 * 放进响应头，比包一层 JSON 再 base64 省事得多（也省掉 4/3 的体积放大）。
 */
function sendBytes(res, status, contentType, bytes, extra = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? new Uint8Array(0));
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

/**
 * 收集请求体，超过上限则丢弃后续字节但**继续排空**请求，
 * 这样客户端能正常收到 413，而不是遇到连接被掐断。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number, binary?: boolean}} [options]
 *   `binary: true` 时返回 `{ ok: true, buffer }` 而**不做 UTF-8 解码**。
 *   录音是二进制，缺了这一条 `toString('utf8')` 会把 WAV 逐字节改坏 ——
 *   而且坏得很隐蔽：长度可能还差不多，校验只会说「不是 RIFF」。
 */
function readBody(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BODY_BYTES;
  const binary = options.binary === true;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) finish({ ok: false, reason: 'too-large' });
      else {
        const buffer = Buffer.concat(chunks);
        finish(binary ? { ok: true, buffer } : { ok: true, text: buffer.toString('utf8') });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'read-error' }));
  });
}

/** 读取并解析 JSON 请求体；返回统一结果，供各 POST 分支复用。 */
async function readJsonBody(req, res) {
  const body = await readBody(req);
  if (!body.ok) {
    sendJson(res, body.reason === 'too-large' ? 413 : 400, { ok: false, error: body.reason });
    return { ok: false };
  }
  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-json' });
    return { ok: false };
  }
  return { ok: true, payload };
}

/** 写请求的公共前置校验（自定义头 + 来源）。 */
function writePreflight(req, res, options = {}) {
  if (options.skipContentType !== true) {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().includes('application/json')) {
      sendJson(res, 415, { ok: false, error: 'need-json-content-type' });
      return false;
    }
  }
  if (String(req.headers[REQUEST_HEADER] ?? '') !== '1') {
    sendJson(res, 403, { ok: false, error: 'need-request-header' });
    return false;
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-site-rejected' });
    return false;
  }
  return true;
}

/** 请求来源是否可接受。 */
function originAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
  return true;
}

/** 文档键白名单校验。 */
function checkDocKey(value) {
  if (value === undefined || value === null || value === '') return { ok: true, key: null };
  if (DOC_KEYS.includes(value)) return { ok: true, key: value };
  return { ok: false, reason: 'unknown-doc' };
}

function normalizeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text === '' ? fallback : text.slice(0, 120);
}

function normalizeWeeks(value) {
  if (value === undefined || value === null || value === '') return '1-16';
  return String(value).trim().slice(0, 60);
}

function normalizePeriod(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 20) return fallback;
  return num;
}

/** 别名列表规范化：去空、去重、限长，最多 12 条。 */
function normalizeAliases(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim().slice(0, 60);
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 各文档的条目规范化与增改删
// ---------------------------------------------------------------------------

const TASK_KINDS = ['homework', 'lab', 'report', 'paper', 'exam', 'group', 'other'];
const TASK_STATUS = ['todo', 'doing', 'done', 'dropped'];

function normalizeCourse(input, existing) {
  const base = existing ?? {};
  const name = normalizeName(input.name, base.name ?? '');
  if (name === '') return { ok: false, reason: 'name-required' };
  const sessionsIn = Array.isArray(input.sessions) ? input.sessions : base.sessions;
  const sessions = (Array.isArray(sessionsIn) ? sessionsIn : []).slice(0, 30).map((session) => ({
    weekday: Math.min(7, Math.max(1, Number(session?.weekday) || 1)),
    startPeriod: normalizePeriod(session?.startPeriod, 1),
    endPeriod: normalizePeriod(session?.endPeriod, normalizePeriod(session?.startPeriod, 1)),
    weeks: normalizeWeeks(session?.weeks),
    location: normalizeName(session?.location, ''),
  }));
  return {
    ok: true,
    item: {
      id: base.id ?? makeId('c'),
      name,
      // 别名：DDL 导入时可用简称匹配（例如「数电」→ 数字电子技术基础）
      aliases: normalizeAliases(input.aliases, base.aliases),
      teacher: normalizeName(input.teacher, base.teacher ?? ''),
      credits: Number.isFinite(Number(input.credits)) ? Number(input.credits) : base.credits ?? 0,
      type: normalizeName(input.type, base.type ?? '必修'),
      color: normalizeName(input.color, base.color ?? ''),
      sessions,
      note: normalizeName(input.note, base.note ?? ''),
      createdAt: base.createdAt ?? new Date().toISOString(),
    },
  };
}

function normalizeTask(input, existing) {
  const base = existing ?? {};
  const title = normalizeName(input.title, base.title ?? '');
  if (title === '') return { ok: false, reason: 'title-required' };
  const kind = TASK_KINDS.includes(input.kind) ? input.kind : base.kind ?? 'homework';
  const status = TASK_STATUS.includes(input.status) ? input.status : base.status ?? 'todo';
  const wasDone = base.status === 'done';
  const progressRaw = Number(input.progress);
  const progress = Number.isFinite(progressRaw) ? Math.min(100, Math.max(0, Math.round(progressRaw))) : base.progress ?? 0;
  return {
    ok: true,
    item: {
      id: base.id ?? makeId('t'),
      title,
      courseId: input.courseId === null ? null : (isValidId(input.courseId) ? input.courseId : base.courseId ?? null),
      kind,
      due: input.due === null ? null : normalizeName(input.due, base.due ?? ''),
      status,
      priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : base.priority ?? 'normal',
      estimateHours: Number.isFinite(Number(input.estimateHours)) ? Number(input.estimateHours) : base.estimateHours ?? 0,
      progress: status === 'done' ? 100 : progress,
      doneAt: status === 'done' ? (wasDone ? base.doneAt ?? null : new Date().toISOString()) : null,
      note: normalizeName(input.note, base.note ?? ''),
      createdAt: base.createdAt ?? new Date().toISOString(),
    },
  };
}

function normalizeGrade(input, existing) {
  const base = existing ?? {};
  if (!isValidId(input.courseId) && !isValidId(base.courseId)) return { ok: false, reason: 'courseId-required' };
  const scoreRaw = Number(input.score);
  const hasScore = input.score !== null && input.score !== undefined && input.score !== '' && Number.isFinite(scoreRaw);
  return {
    ok: true,
    item: {
      courseId: isValidId(input.courseId) ? input.courseId : base.courseId,
      score: hasScore ? Math.min(100, Math.max(0, scoreRaw)) : null,
      grade: typeof input.grade === 'string' && input.grade !== '' ? input.grade : null,
      credit: Number.isFinite(Number(input.credit)) ? Number(input.credit) : base.credit ?? 0,
      examType: normalizeName(input.examType, base.examType ?? '期末'),
    },
  };
}

function normalizeTerm(input, existing) {
  const base = existing ?? {};
  const name = normalizeName(input.name, base.name ?? '');
  if (name === '') return { ok: false, reason: 'name-required' };
  const totalWeeks = normalizePeriod(input.totalWeeks, base.totalWeeks ?? 16);
  return {
    ok: true,
    item: {
      id: base.id ?? makeId('s'),
      name,
      startDate: normalizeName(input.startDate, base.startDate ?? ''),
      endDate: normalizeName(input.endDate, base.endDate ?? ''),
      totalWeeks: totalWeeks > 30 ? 30 : totalWeeks,
      isCurrent: input.isCurrent === true ? true : base.isCurrent === true,
    },
  };
}

/**
 * 知识网络节点。掌握度是 0–3 四档（用户 2026-10-20 定：未学 / 学过 / 熟练 / 精通），
 * 与「重点」标记正交；两者都由面板点，所以这份文档有 /mutate 路由。
 * 面板改标记时只送 `{ id, mastery }`，其余字段（名称/章节/证据）从磁盘上那条继承 ——
 * 这也是 `existing` 存在的意义，别把 normalize 写成「只认入参」。
 */
const KNOWLEDGE_MASTERY_MAX = 3;
/** 等级下限（0 = 未学）。越界一律当未学，见 `lib/mastery.js` 的 clampMastery。 */
const KNOWLEDGE_MASTERY_MIN = 0;

function normalizeKnowledgeEvidence(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const type = normalizeName(raw.type, '');
    if (type === '') continue;
    const entry = { type: type.slice(0, 20) };
    if (typeof raw.id === 'string' && raw.id !== '') entry.id = raw.id.slice(0, 80);
    if (typeof raw.file === 'string' && raw.file !== '') entry.file = raw.file.slice(0, 220);
    const page = Number(raw.page);
    if (Number.isInteger(page) && page > 0) entry.page = page;
    if (typeof raw.quote === 'string' && raw.quote !== '') entry.quote = raw.quote.slice(0, 200);
    out.push(entry);
    if (out.length >= 24) break;
  }
  return out;
}

function normalizeKnowledgeNode(input, existing) {
  const base = existing ?? {};
  const name = normalizeName(input.name, base.name ?? '');
  if (name === '') return { ok: false, reason: 'name-required' };
  const masteryRaw = input.mastery === undefined ? base.mastery ?? 0 : input.mastery;
  const mastery = Number.isInteger(masteryRaw) && masteryRaw >= 0 && masteryRaw <= KNOWLEDGE_MASTERY_MAX ? masteryRaw : null;
  if (mastery === null) return { ok: false, reason: 'bad-mastery' };
  const marked = typeof input.marked === 'boolean' ? input.marked : base.marked === true;
  // 掌握度变了就记一次复习时间；没变就保留旧的（面板反复点同一档不该刷时间）
  const masteryChanged = existing !== undefined && existing !== null && mastery !== (base.mastery ?? 0);
  const reviewedAtRaw = input.reviewedAt === undefined ? null : input.reviewedAt;
  const reviewedAt = typeof reviewedAtRaw === 'string' && reviewedAtRaw !== ''
    ? reviewedAtRaw.slice(0, 40)
    : masteryChanged ? new Date().toISOString() : base.reviewedAt ?? null;
  const evidenceIn = input.evidence === undefined ? base.evidence : input.evidence;
  return {
    ok: true,
    item: {
      id: base.id ?? makeId('k'),
      name,
      courseId: input.courseId === null ? null : isValidId(input.courseId) ? input.courseId : base.courseId ?? null,
      chapter: normalizeName(input.chapter, base.chapter ?? ''),
      section: normalizeName(input.section, base.section ?? ''),
      // 小节号（如 `2.6.5`）——树按大纲挂靠时用；空串表示只精确到「节」
      subsection: normalizeName(input.subsection, base.subsection ?? ''),
      aliases: normalizeAliases(input.aliases, base.aliases),
      mastery,
      marked,
      reviewedAt,
      note: normalizeName(input.note, base.note ?? ''),
      evidence: normalizeKnowledgeEvidence(evidenceIn),
      createdAt: base.createdAt ?? new Date().toISOString(),
    },
  };
}

/**
 * 行内格式 style 的兜底剥离（2026-11-17 D 卡）：白名单外的键/值一律丢弃，不 400。
 *
 * 与既有 normalize 的「能不炸就不炸」口径一致：脏 style 不阻止批注落盘，只是不生效。
 * 返回 undefined 表示「没有任何可用的样式维度」，调用方据此不写 style 字段。
 *   - null → 表示「显式清除样式」，原样返回 null（merge 时据此 delete）
 */
function sanitizeAnnotationStyle(input) {
  if (input === null) return null;
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  if (typeof input.color === 'string' && ANNOTATION_STYLE_COLORS.includes(input.color)) out.color = input.color;
  if (typeof input.highlight === 'string' && ANNOTATION_STYLE_HIGHLIGHTS.includes(input.highlight)) out.highlight = input.highlight;
  if (typeof input.underline === 'string' && ANNOTATION_STYLE_UNDERLINES.includes(input.underline)) out.underline = input.underline;
  if (typeof input.bold === 'boolean') out.bold = input.bold;
  if (typeof input.italic === 'boolean') out.italic = input.italic;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 主观标记类型 markKind 的兜底剥离（E1，2026-11-18）：白名单外的一律丢弃，不 400。
 * 与 sanitizeAnnotationStyle 同口径：脏值不阻止批注落盘，只是不生效。
 *   - null    → 表示「显式清除标记」，原样返回 null（merge 时据此 delete）
 *   - undefined / 非法值 → 返回 undefined（不写 / 不动）
 *   - 合法键 'key'|'question'|'review'|'learned' → 原样返回
 */
function sanitizeAnnotationMarkKind(input) {
  if (input === null) return null;
  if (typeof input !== 'string' || !ANNOTATION_MARK_KINDS.includes(input)) return undefined;
  return input;
}

/**
 * 批注条目归一化（`/mutate` 的兜底通道；真正的写入口是下面按锚点重算的专用分支）。
 * 这里只做字段兜底，不读原文——锚点重算必须基于完整原文，见 handleAnnotationsMutate。
 */
function normalizeAnnotation(input, existing) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const base = existing !== null && typeof existing === 'object' ? existing : {};
  const type = typeof source.type === 'string' && ANNOTATION_TYPES.includes(source.type)
    ? source.type
    : base.type;
  if (!ANNOTATION_TYPES.includes(type)) return { ok: false, reason: 'bad-type' };
  const file = normalizeName(source.file, base.file ?? '');
  if (file === '') return { ok: false, reason: 'missing-file' };
  const anchor = source.anchor !== null && typeof source.anchor === 'object' ? source.anchor : base.anchor;
  if (anchor === null || typeof anchor !== 'object') return { ok: false, reason: 'missing-anchor' };
  const page = source.page === undefined ? (base.page ?? null) : source.page;
  const item = {
    id: base.id ?? makeId('a'),
    file,
    type,
    content: typeof source.content === 'string' ? source.content : base.content ?? '',
    page,
    anchor,
    createdAt: base.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (source.weak !== undefined) item.weak = source.weak;
  else if (base.weak !== undefined) item.weak = base.weak;
  const style = sanitizeAnnotationStyle(source.style !== undefined ? source.style : base.style);
  if (style !== undefined && style !== null) item.style = style;
  const markKind = sanitizeAnnotationMarkKind(source.markKind !== undefined ? source.markKind : base.markKind);
  if (markKind !== undefined && markKind !== null) item.markKind = markKind;
  return { ok: true, item };
}

/**
 * 日程条目归一（2026-11-19 A 卡）：`POST /mutate doc=schedule` 的唯一写入口。
 *
 * 字段契约：`{id, title, date:'YYYY-MM-DD', time:'HH:mm'|null, note?, createdAt, updatedAt}`。
 * `time` 为 null 表示「全天」；`date` 只接受日，不接受时间（时间放 `time`，两处别混）。
 * 校验与 `lib/core.js` 的 `validateDoc('schedule')` 同一口径：面板写进来的每条都能直接渲染。
 *
 * A2 卡（2026-11-19）扩四个**可选**字段（`category` / `location` / `endTime` / `source`）：
 *   - 旧客户端不传 → 按缺省补（`work` / `''` / `null` / `manual`），旧条目照样能改、能删；
 *   - 传了非法值 → 整条拒写（`schedule-bad-category` 等），绝不落到磁盘；
 *   - **不批量回填**用户已有的 `日程.json`：缺省只在读/渲染时补，磁盘上的旧条目原样不动。
 */
function normalizeScheduleEntry(input, existing) {
  const base = existing ?? {};
  const title = normalizeName(input.title, base.title ?? '');
  if (title === '') return { ok: false, reason: 'schedule-title-required' };

  const date = normalizeName(input.date, base.date ?? '');
  if (date === '' || parseDay(date) === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: 'schedule-bad-date' };
  }

  const timeRaw = input.time === undefined ? (base.time ?? null) : input.time;
  let time = null;
  if (timeRaw !== null && timeRaw !== undefined && String(timeRaw).trim() !== '') {
    if (!isClockTime(timeRaw)) return { ok: false, reason: 'schedule-bad-time' };
    time = String(timeRaw).trim();
  }

  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return { ok: false, reason: 'schedule-bad-note' };
  }

  // ---- A2 卡新增的四个可选字段：undefined = 「没动」，沿用已有值 / 缺省值 ----
  const categoryRaw = input.category === undefined ? (base.category ?? SCHEDULE_DEFAULT_CATEGORY) : input.category;
  let category = SCHEDULE_DEFAULT_CATEGORY;
  if (categoryRaw !== undefined && categoryRaw !== null && String(categoryRaw).trim() !== '') {
    const picked = String(categoryRaw).trim();
    if (!SCHEDULE_CATEGORIES.includes(picked)) return { ok: false, reason: 'schedule-bad-category' };
    category = picked;
  }

  const locationRaw = input.location === undefined ? (base.location ?? '') : input.location;
  if (locationRaw !== undefined && locationRaw !== null && typeof locationRaw !== 'string') {
    return { ok: false, reason: 'schedule-bad-location' };
  }
  // 地点不是标题：长度只做防脏（120 字），不做「必填」
  const location = typeof locationRaw === 'string' ? locationRaw.trim().slice(0, 120) : '';

  const endTimeRaw = input.endTime === undefined ? (base.endTime ?? null) : input.endTime;
  let endTime = null;
  if (endTimeRaw !== undefined && endTimeRaw !== null && String(endTimeRaw).trim() !== '') {
    if (!isClockTime(endTimeRaw)) return { ok: false, reason: 'schedule-bad-end-time' };
    endTime = String(endTimeRaw).trim();
  }

  const sourceRaw = input.source === undefined ? (base.source ?? SCHEDULE_DEFAULT_SOURCE) : input.source;
  let source = SCHEDULE_DEFAULT_SOURCE;
  if (sourceRaw !== undefined && sourceRaw !== null && String(sourceRaw).trim() !== '') {
    const picked = String(sourceRaw).trim();
    if (!SCHEDULE_SOURCES.includes(picked)) return { ok: false, reason: 'schedule-bad-source' };
    source = picked;
  }

  const nowIso = new Date().toISOString();
  return {
    ok: true,
    item: {
      id: base.id ?? makeId('s'),
      title,
      date,
      time,
      note: normalizeName(input.note, base.note ?? ''),
      category,
      location,
      endTime,
      source,
      createdAt: base.createdAt ?? nowIso,
      updatedAt: nowIso,
    },
  };
}

/** listKey / normalize 的文档路由表。 */
const DOC_ROUTES = {
  term: { listKey: 'terms', normalize: normalizeTerm },
  courses: { listKey: 'courses', normalize: normalizeCourse },
  tasks: { listKey: 'tasks', normalize: normalizeTask },
  grades: { listKey: 'courses', normalize: normalizeGrade },
  knowledgeNetwork: { listKey: 'nodes', normalize: normalizeKnowledgeNode },
  annotations: { listKey: 'notes', normalize: normalizeAnnotation },
  // 今日日程（第 14 份主文档）：一次性条目，增删改都走通用 mutate，不另写 handler
  schedule: { listKey: 'entries', normalize: normalizeScheduleEntry },
};

/** 校验 id 是否形如文档内已有条目。 */
function findIndexById(list, id) {
  return list.findIndex((item) => item !== null && typeof item === 'object' && item.id === id);
}

/** 删除课程时检查是否仍被任务或成绩引用。 */
function collectReferences(docs, courseId) {
  const tasks = Array.isArray(docs?.tasks?.tasks) ? docs.tasks.tasks : [];
  const grades = Array.isArray(docs?.grades?.courses) ? docs.grades.courses : [];
  return {
    tasks: tasks.filter((task) => task?.courseId === courseId).length,
    grades: grades.filter((item) => item?.courseId === courseId).length,
  };
}

/**
 * 读取网络学堂同步配置。
 *
 * 返回 `{ cookie, manual, courses, updatedAt }`；文件不存在时全是空值，
 * 不报错 —— 「还没连过网络学堂」是正常状态，不是错误。
 */
async function readLearnConfig(dataDir) {
  const file = learnConfigPath(dataDir);
  const empty = { cookie: '', manual: {}, courses: [], semesterId: null, semesters: [], updatedAt: null };
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-shape');
    return {
      ok: true,
      cookie: typeof parsed.cookie === 'string' ? parsed.cookie : '',
      manual: parsed.manual !== null && typeof parsed.manual === 'object' ? parsed.manual : {},
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      // 记住上次同步用的学期：跨学期后不该悄悄把新课当成旧课的补充
      semesterId: typeof parsed.semesterId === 'string' ? parsed.semesterId : null,
      // 可选学期列表也要记住，否则界面上没有「换学期」的抓手
      semesters: Array.isArray(parsed.semesters) ? parsed.semesters.filter((s) => typeof s === 'string') : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, ...empty, missing: true };
    return { ok: false, reason: error?.message === 'bad-shape' ? 'bad-learn-config' : 'learn-config-unreadable', ...empty };
  }
}

/**
 * 写入网络学堂同步配置。
 *
 * 原子写 + 0600 权限：文件含会话 Cookie，不能给同机其他用户读。
 * 先写临时文件再 rename，避免中途断电留下半截 JSON 把同步彻底弄坏。
 */
async function writeLearnConfig(dataDir, next) {
  // 2026-10-18 修：以前允许写空串，12:50 那次就把「票没了」固化进了磁盘 ——
  // 而浏览器里那张票可能还是好的。空票不是一种状态，它只是「这次没读到」的样子，
  // 绝不能变成一个持久事实。
  const cookie = typeof next.cookie === 'string' ? next.cookie.trim() : '';
  if (cookie === '') throw new Error('empty-cookie');
  await fs.mkdir(dataDir, { recursive: true });
  const file = learnConfigPath(dataDir);
  const tmp = `${file}.tmp`;
  const payload = {
    version: 1,
    cookie,
    manual: next.manual ?? {},
    courses: next.courses ?? [],
    semesterId: next.semesterId ?? null,
    semesters: Array.isArray(next.semesters) ? next.semesters : [],
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows 上 chmod 基本是空操作；失败不影响正确性，忽略。
  }
  return payload;
}

/** 配置里的 Cookie 是否够用（至少要有一个会话类 cookie）。 */
function cookieUsable(cookie) {
  const text = String(cookie ?? '');
  return text.includes('JSESSIONID') || text.trim().length >= 8;
}

/**
 * 读存好的统一身份认证账号密码。
 *
 * 返回 `{ ok:true, user, pass, present }`；`present:false` = 还没存过（正常状态）。
 * 文件损坏/读不了时 `present:false` 且带 `reason`（不抛，绝不把主流程带崩）。
 */
async function readLearnCredential(dataDir) {
  const file = learnCredentialPath(dataDir);
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-shape');
    const user = typeof parsed.user === 'string' ? parsed.user.trim() : '';
    const pass = typeof parsed.pass === 'string' ? parsed.pass : '';
    const present = user !== '' && pass !== '';
    return { ok: true, user, pass, present, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, user: '', pass: '', present: false, updatedAt: null };
    return { ok: false, user: '', pass: '', present: false, updatedAt: null, reason: error?.message === 'bad-shape' ? 'bad-credential' : 'credential-unreadable' };
  }
}

/**
 * 写（或清空）统一身份认证账号密码。原子写 + 0600。
 *
 * 传空 user 或空 pass = **删除**这份凭据（等价于「我不想让插件存密码了」）。
 * 和 `writeLearnConfig` 一样先写临时文件再 rename，别让半截 JSON 卡死下次登录。
 */
async function writeLearnCredential(dataDir, next) {
  const file = learnCredentialPath(dataDir);
  const user = typeof next?.user === 'string' ? next.user.trim() : '';
  const pass = typeof next?.pass === 'string' ? next.pass : '';
  if (user === '' || pass === '') {
    await fs.rm(file, { force: true });
    return { ok: true, cleared: true };
  }
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = { version: 1, user, pass, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  try { await fs.chmod(file, 0o600); } catch { /* Windows 上是空操作 */ }
  return { ok: true, cleared: false, updatedAt: payload.updatedAt };
}

/**
 * 本地任务 → 该去哪些课堂号拉详情，按可信度排好序。
 *
 * 为什么是「一串」而不是「一个」：平台把「数字电子技术基础」和「数字电子技术实验」
 * 都映射到同一个本地课程 `c_digital`（一个 `how: exact`、一个 `how: alias`）。
 * 只取第一个会拿错课堂号 —— 实测拿实验课的号去拉基础课的作业，平台直接回 500。
 * 所以把 `exact` 排前面，调用方逐个试到平台肯给页面为止；拿错号只会 500，
 * 不会拉回别的课的作业，所以「试成」是安全的。
 */
function learnDetailCandidates(config, courseId, parsed) {
  const courses = Array.isArray(config?.courses) ? config.courses : [];
  const scored = courses
    .filter((item) => item?.courseId === courseId && typeof item.wlkcid === 'string' && item.wlkcid !== '')
    .map((item) => ({ wlkcid: item.wlkcid, name: item.name ?? null, rank: item.how === 'exact' ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank);
  const out = [];
  // 记号自带课堂号时先信它（`zy:<wlkcid>:<zyid>` 形状），没有再靠课程映射
  if (typeof parsed?.wlkcid === 'string' && parsed.wlkcid !== '') {
    out.push({ wlkcid: parsed.wlkcid, name: null });
  }
  for (const item of scored) {
    if (out.some((entry) => entry.wlkcid === item.wlkcid)) continue;
    out.push({ wlkcid: item.wlkcid, name: item.name });
  }
  return out.slice(0, 3);
}

/**
 * 拉课程列表 → 把每门课对到本地课程 → 得到要落盘的映射。
 *
 * 抽出来是因为「课程映射」这条数据有三个来源入口（连上、换学期、同步），
 * 之前只有前两个写它，**同步从来不写** —— 于是「连上过一次、后来自动续期、
 * 再点同步」这条最常见的路径下，映射永远是空的，所有作业详情都回
 * `course-unmapped`，界面上就变成「DDL 打不开」。三处抄同一段逻辑迟早会再走岔，
 * 所以这里只留一份。
 *
 * 返回 `{ok:true, learned, semesterId, semesters, authUsed}` 或
 * `{ok:false, error, detail?}`；只算数据，**不落盘**，由调用方决定写不写。
 */
async function learnCourseMapping({ cookie, semesterId, manual }) {
  const listed = await fetchLearnCourses(cookie, {
    timeoutMs: LEARN_TIMEOUT_MS,
    semesterId: typeof semesterId === 'string' && semesterId !== '' ? semesterId : undefined,
  });
  // `no-course` 不算失败（假期里确实可能没有课），其余算
  if (listed.error !== null && listed.error !== 'no-course') {
    return { ok: false, error: `learn-${listed.error}`, detail: listed.error };
  }
  const courses = Array.isArray(manual?.courses) ? manual.courses : [];
  const learned = listed.courses.map((course) => {
    const match = matchCourse(course.name, courses, manual?.map ?? {});
    return {
      wlkcid: course.wlkcid,
      name: course.name,
      semester: course.semester,
      matched: isMatchedHow(match.how),
      courseId: match.courseId,
      how: match.how,
      candidates: match.candidates ?? [],
    };
  });
  return {
    ok: true,
    learned,
    semesterId: listed.semesterId,
    semesters: listed.semesters,
    authUsed: listed.authUsed,
  };
}

/** 距上次「详情前补映射」多久之内不再重试：连点几条详情不该连发几次联网。 */
const LEARN_MAPPING_REPAIR_GAP_MS = 60 * 1000;

/**
 * 详情发现课程映射对不上时，就地补一次映射并**落盘**。
 *
 * 走的就是住在这里的浏览器内部状态无关的那条唯一路径（`learnCourseMapping`），
 * 所以补出来的结果和用户手动重连/换学期得到的完全一样。
 * 失败一律返回 `null` —— 详情接口的主线是「拿到原文」，补映射只是顺手救一把，
 * 它失败不该把详情错误变成另一个更难懂的错误。
 */
function createLearnCourseRepairer({ dataDir, store, logger }) {
  let lastAttemptAt = 0;
  return async function repairLearnCourses(config) {
    const now = Date.now();
    if (now - lastAttemptAt < LEARN_MAPPING_REPAIR_GAP_MS) return null;
    lastAttemptAt = now;
    try {
      const localCourses = (await store.readAll()).docs.courses?.courses;
      const mapped = await learnCourseMapping({
        cookie: config.cookie,
        semesterId: config.semesterId ?? undefined,
        manual: { map: config.manual ?? {}, courses: Array.isArray(localCourses) ? localCourses : [] },
      });
      if (!mapped.ok || mapped.learned.length === 0) {
        logger?.warn?.(`[study-assistant] 详情前补课程映射没成：${mapped.ok ? 'no-course' : mapped.error}`);
        return null;
      }
      const saved = await writeLearnConfig(dataDir, {
        cookie: config.cookie,
        manual: config.manual ?? {},
        courses: mapped.learned,
        semesterId: mapped.semesterId ?? config.semesterId ?? null,
        semesters: mapped.semesters.length > 0 ? mapped.semesters : config.semesters ?? [],
      });
      return {
        ok: true,
        courses: saved.courses,
        semesterId: saved.semesterId,
        semesters: saved.semesters,
      };
    } catch (error) {
      logger?.warn?.(`[study-assistant] 详情前补课程映射出错：${String(error?.message ?? error)}`);
      return null;
    }
  };
}

/**
 * `matchCourse` 返回的 `how` 是否算「匹配上了」。
 *
 * `ambiguous` 与 `unmatched` **不算**：把作业挂到一门猜出来的课上，
 * 比暂时不挂更难让用户发现。这里必须与 `matchCourse` 的成功分支逐一对应。
 */
function isMatchedHow(how) {
  return how === 'manual' || how === 'exact' || how === 'alias' || how === 'prefix';
}

// ---------------------------------------------------------------------------
// AI 智能识别（2026-11-19 A2 卡）：`POST /schedule/parse` 的纯函数与通道调用
// ---------------------------------------------------------------------------
//
// 通道复用 B2 卡定案的那一套（**与 B2 并行、互不依赖**，只是读同一个密钥范式）：
//   BASE_URL = https://llmapi.paratera.com/v1，MODEL = DeepSeek-V4.1-Flash-1017，
//   密钥取 `~/.dsh/.credentials.yaml` 的 `refs.PARATERA_API_KEY`。
// 铁律：密钥**不打印、不写日志、不落盘、不进前端**；AI 只负责「抽取」，
// 抽不出来就留空，绝不猜一个值填进表单、更不自动入库。

/** AI 通道的地址与模型（与 `_工具\OCR修复\batch-fix.mjs` 同一组缺省值，可用环境变量覆盖）。 */
const AI_BASE_URL = process.env.PARATERA_BASE_URL || 'https://llmapi.paratera.com/v1';
const AI_MODEL = process.env.PARATERA_MODEL || 'DeepSeek-V4.1-Flash-1017';
/** 一次识别最多吃多少字：日程这段话不会长过一张请假条，超出就截断（并回一个提示）。 */
const SCHEDULE_PARSE_MAX_CHARS = 2000;
/** 单次请求的墙钟上限。 */
const AI_TIMEOUT_MS = 30000;
/** 重试次数（429 / 5xx / 网络异常才算可重试）。 */
const AI_ATTEMPTS = 3;

/**
 * 读 Paratera 密钥。
 *
 * 只认 `refs.PARATERA_API_KEY` 那一行，返回 `{ ok, key }` 或 `{ ok:false, reason }`；
 * **任何分支都不返回文件内容本身**，日志里也不许出现 `key`。
 */
async function readParateraKey(keyPath) {
  const file = typeof keyPath === 'string' && keyPath.trim() !== ''
    ? keyPath
    : path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = await fs.readFile(file, 'utf8');
    // 与 batch-fix.mjs 同一条正则：只认缩进过的 refs 子项，别把别的键名匹配进来
    const matched = /^\s+PARATERA_API_KEY:\s*([^\s#]+)\s*$/m.exec(text);
    if (matched === null || matched[1].trim() === '') return { ok: false, reason: 'ai-key-missing' };
    return { ok: true, key: matched[1].trim() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'ai-key-missing' };
    return { ok: false, reason: 'ai-key-unreadable' };
  }
}

/** `ms` 毫秒后兑现（退避用）。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 调 Paratera 的 chat/completions。
 *
 * 与 batch-fix.mjs 的 `callModel` 同口径：429 / 5xx / 网络异常退避重试 3 次（2s、4s），
 * 其余 4xx 直接判失败（重试不会改变鉴权/参数错误）。
 * 返回 `{ ok:true, content, attempts }`；失败返回 `{ ok:false, error, detail, attempts }`，**不抛异常**。
 */
async function callParatera(options) {
  const {
    key,
    system,
    user,
    temperature = 0.2,
    maxTokens = 800,
    timeoutMs = AI_TIMEOUT_MS,
    attempts = AI_ATTEMPTS,
    fetchImpl = fetch,
    baseUrl = AI_BASE_URL,
    model = AI_MODEL,
  } = options;
  const tried = [];
  let lastError = 'ai-unavailable';
  let lastDetail = '';
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      tried.push({ attempt: index + 1, status: response.status });
      if (response.status === 429 || response.status >= 500) {
        lastError = 'ai-unavailable';
        lastDetail = `HTTP ${response.status}`;
        if (index < attempts - 1) await sleep(2000 * (index + 1));
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          ok: false,
          error: 'ai-rejected',
          detail: `HTTP ${response.status} ${String(text).slice(0, 160)}`,
          attempts: tried,
        };
      }
      const payload = await response.json().catch(() => null);
      const content = typeof payload?.choices?.[0]?.message?.content === 'string'
        ? payload.choices[0].message.content
        : '';
      if (content === '') {
        lastError = 'ai-bad-output';
        lastDetail = '模型返回空内容';
        if (index < attempts - 1) await sleep(2000 * (index + 1));
        continue;
      }
      return { ok: true, content, attempts: tried };
    } catch (error) {
      lastError = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'ai-timeout' : 'ai-unavailable';
      lastDetail = String(error?.message ?? error).slice(0, 160);
      if (index < attempts - 1) await sleep(2000 * (index + 1));
    }
  }
  return { ok: false, error: lastError, detail: lastDetail, attempts: tried };
}

/**
 * 从模型输出里抠出一个 JSON 对象。
 *
 * 模型常干两件事：套一层 ```json 围栏；或者在 JSON 前后加一句「好的，这是结果」。
 * 这里按「第一个 `{` 起、括号配平、字符串内的括号不算」扫，扫完的片段再交给 JSON.parse。
 * 找不到配平对象就返回 null（上层判 `ai-bad-output`）。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced !== null ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const ch = body[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * 宽松解析：先原样 `JSON.parse`；不成就把字符串里的裸换行/制表符转义后再试一次。
 *
 * 只在「模型把多行文本直接写进 JSON 字符串」这一步兜底，不做正则改写，避免救回一个假对象。
 */
function parseJsonLoose(fragment) {
  try {
    return { ok: true, value: JSON.parse(fragment) };
  } catch {
    // 落到下面的转义重试
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < fragment.length; index += 1) {
    const ch = fragment[index];
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === '\\') { escaped = true; out += ch; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    out += ch;
  }
  try {
    return { ok: true, value: JSON.parse(out) };
  } catch {
    return { ok: false };
  }
}

/** `YYYY-MM-DD` 且真是这一天（挡掉 2026-02-31）。 */
function isDayText(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    && parseDay(value.trim()) !== null;
}

/** 本地日期 → `YYYY-MM-DD`。 */
function dayTextOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `9:5` / `9:05` / `09:05` → `09:05`；不合法返回 null。 */
function normalizeClock(value) {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (matched === null) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 从**原文**里解析相对日期（「今天 / 明天 / 后天 / 周X / 下周X / 9月20号」）。
 *
 * 为什么放在后端：模型给不出日期时（它只回了一句话或返回空串），这一层用**当前时间**做兜底校正，
 * 比让用户自己换算靠谱；仍然算不出来的（比如「月底前找个时间」）**返回 null**，
 * 由前端把日期框留空让用户填 —— 绝不给一个猜的日期。
 *
 * @param {string} text 用户粘贴的原文
 * @param {Date} now 当前时间（可注入，供测试固定）
 * @returns {string|null} `YYYY-MM-DD`
 */
export function resolveRelativeDay(text, now = new Date()) {
  const hay = String(text ?? '');
  if (hay === '') return null;
  const base = new Date(now.getTime());
  base.setHours(0, 0, 0, 0);
  const shift = (offset) => {
    const date = new Date(base);
    date.setDate(date.getDate() + offset);
    return dayTextOf(date);
  };

  // 顺序要紧：先认「大后天 / 后天」，再认「明天」，最后「今天」（都含「天」字，不按长词优先会串）
  if (/大后天|大后日/.test(hay)) return shift(3);
  if (/后天/.test(hay)) return shift(2);
  if (/明天|明日|明早|明晚/.test(hay)) return shift(1);
  if (/今天|今日|今早|今晚/.test(hay)) return shift(0);

  const week = /(下下|下|本|这)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(hay);
  if (week !== null) {
    const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[week[2]];
    if (target !== undefined) {
      const prefix = week[1] === '下下' ? 2 : week[1] === '下' ? 1 : 0;
      const today = base.getDay() === 0 ? 7 : base.getDay();
      return shift(prefix * 7 + target - today);
    }
  }

  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(hay);
  if (monthDay !== null) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const thisYear = new Date(base.getFullYear(), month - 1, day);
      // 构造出来的日期必须与原数字一致（挡掉 2 月 31 日这种「归一化」）
      if (thisYear.getMonth() === month - 1 && thisYear.getDate() === day) {
        // 已经过去的日子按「明年的这一天」算，否则「9月20号」在 11 月会被当成半年前
        if (thisYear.getTime() < base.getTime()) {
          const nextYear = new Date(base.getFullYear() + 1, month - 1, day);
          if (nextYear.getMonth() === month - 1 && nextYear.getDate() === day) return dayTextOf(nextYear);
          return null;
        }
        return dayTextOf(thisYear);
      }
    }
  }
  return null;
}

/**
 * 把模型的 JSON 抽成一份**可预览的草稿**。
 *
 * 返回 `{ ok:true, draft }` 或 `{ ok:false, reason, detail }`：
 *   - 没有 JSON / 没有标题 → 失败（不算「识别出来了」）；
 *   - 日期缺失或模型给了个不存在的日子 → 用原文相对日期兜底，仍拿不到就留空串；
 *   - 时刻不合法 → 置 null（前端表单留空），不硬改；
 *   - 分类不在白名单 → 留空串（前端保留下拉默认值，不替模型选一个）。
 */
export function parseScheduleDraft(content, sourceText, now = new Date()) {
  const fragment = extractJsonObject(content);
  if (fragment === null) return { ok: false, reason: 'ai-bad-output', detail: '模型没给出 JSON 对象。' };
  const parsed = parseJsonLoose(fragment);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, reason: 'ai-bad-output', detail: '模型给出的 JSON 解析失败。' };
  }
  const raw = parsed.value;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
  if (title === '') return { ok: false, reason: 'ai-bad-title', detail: '模型没抽出日程标题，这次不算识别成功。' };

  let date = isDayText(raw.date) ? String(raw.date).trim() : '';
  if (date === '') date = resolveRelativeDay(sourceText, now) ?? '';

  return {
    ok: true,
    draft: {
      title,
      date,
      time: normalizeClock(raw.time),
      endTime: normalizeClock(raw.endTime),
      location: typeof raw.location === 'string' ? raw.location.trim().slice(0, 120) : '',
      category: SCHEDULE_CATEGORIES.includes(raw.category) ? raw.category : '',
      source: 'auto-ai',
    },
  };
}

/** `/schedule/parse` 的系统提示：只做抽取，不解释、不编造、不自动入库。 */
const SCHEDULE_PARSE_SYSTEM = `你是一个严谨的中文日程抽取器。用户给你一段别人说的话或随手记的文字，你只负责把里面的日程要素抽出来。
铁律（违反任何一条都算失败）：
1. 只输出一个 JSON 对象，不要输出解释、不要加代码围栏、不要输出多余字段；
2. 原文没说的字段一律留空：date 用空串，time / endTime 用 null，location 用空串，category 用空串；
3. 绝不编造时间或地点。说不准的时刻就留 null；
4. 标题只写「做什么」，不要把时间和地点重复塞进标题；
5. 相对时间（今天 / 明天 / 后天 / 周X / 下周X / 几月几号）要换算成具体日期，按下面给的「今天」为基准；
6. category 只能取 study | innovation | life | work 之一：
   学习类课程/复习/作业/考试/讲座 → study；
   比赛/竞赛/大创/挑战杯/科研/论文/路演/答辩 → innovation；
   社团/聚会/运动/电影/生日/聚餐/健身 → life；
   实习/兼职/面试/招聘/工作/会议/杂项 → work。`;

/** `/schedule/parse` 的用户提示：把「今天」与原文一起给出，减少模型自己推日期。 */
function buildScheduleParsePrompt(text, now) {
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return [
    `【今天】${dayTextOf(now)}（${weekday}）`,
    '【原文】',
    text,
    '',
    '【输出格式】{"title":"","date":"YYYY-MM-DD","time":"HH:MM"或null,"endTime":"HH:MM"或null,"location":"","category":"study|innovation|life|work"}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 学习助手浮层（2026-11-19 MVP 卡）：`POST /assistant/reply` 的通道与入参校验
// ---------------------------------------------------------------------------
//
// 这是一条**新建**接口——历史 E2 删过同名旧接口，这里不复活、不参考它的形状。
// 它只服务面板内侧的置顶浮层：前端把整段对话发过来，后端转发给本机 magpie
// 网关（`group/wb`）换一条回复，再把回复文本原样返回。
//
// 铁律（与 Paratera 那条通道同一套）：
//   - 密钥只从 `~/.dsh/.credentials.yaml` 的 `refs.MAGPIE_GATEWAY_KEY` 读，
//     **不打印、不写日志、不落盘、不进前端**；
//   - **MVP 不落盘**：入参里的 `conversationId` / `persist` 只是给下一版留的位置，
//     服务端这一版**接收但忽略**（除了类型校验），一个字节都不写；
//   - 失败一律 `ok:false`，detail 只留错误类型 / HTTP 码，绝不回传用户原文全文。

/** magpie 网关的地址（可用环境变量覆盖，与卡里的缺省值一致）。 */
const MAGPIE_BASE_URL = process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425/v1';
/** 网关上的模型名。`group/wb` 是实测可用的那一个。 */
const MAGPIE_MODEL = process.env.MAGPIE_MODEL || 'group/wb';
/**
 * 单次请求的墙钟上限（60 秒）。
 *
 * 这是 reasoning 模型：短超时会把「还在思考」直接掐成失败，用户看到的却只是
 * 「通道不通」，很难自己想到是超时。
 */
const MAGPIE_TIMEOUT_MS = 60000;
/** 重试次数（429 / 5xx / 网络异常才算可重试）。 */
const MAGPIE_ATTEMPTS = 3;
/** 退避基数（毫秒）：第 n 次失败后等 `retryDelayMs * n`。测试可注入 0 免等。 */
const MAGPIE_RETRY_DELAY_MS = 2000;
/** 回复的 max_tokens 缺省值。给小了 reasoning 会把预算吃光、content 返回 null。 */
const ASSISTANT_MAX_TOKENS = 2048;
/** 允许前端覆盖的上限（再高只是白等，网关侧也有自己的限制）。 */
const ASSISTANT_MAX_TOKENS_LIMIT = 8192;
/** 一次对话最多带多少条消息（含历史）。 */
const ASSISTANT_MAX_MESSAGES = 40;
/** 单条 content 的字符上限。 */
const ASSISTANT_MAX_MESSAGE_CHARS = 20000;
/** 整段对话的字符上限（挡住「一次贴一本书」）。 */
const ASSISTANT_MAX_TOTAL_CHARS = 80000;
/** 合法的角色白名单（与 OpenAI 兼容协议一致，多给的一律拒收）。 */
const ASSISTANT_ROLES = ['user', 'assistant', 'system'];
/** `context` 归一成的那句提示总长上限（超出截断，防长文本注入）。 */
const ASSISTANT_CONTEXT_MAX_CHARS = 300;
/** `context` 里单个字符串字段的长度上限（节点标题 / 路径 / id 都在内）。 */
const ASSISTANT_CONTEXT_FIELD_MAX = 200;
/**
 * `context.tab` → 中文页签名的白名单。
 *
 * 以面板实际页签为准（client.full.js 的 `tabDefs` 有 8 个）；任务卡 ⑤ 当时只列了
 * 4 个，是清单过时，这里按实测补全。`lecture`（听课台）是独立页面、浮层不在那里出现，
 * 与任务卡 ⑤ 的口径一致，不采集也不认识。
 */
const ASSISTANT_CONTEXT_TABS = {
  today: '今日',
  schedule: '课表',
  deadlines: 'DDL',
  grades: '成绩',
  materials: '资料',
  knowledge: '知识点',
  records: '记录',
  settings: '设置',
};

/**
 * 把外部字符串压成一行、去掉控制字符、截到字段上限。
 *
 * `context` 全部来自前端状态（节点标题、文件路径都可能被人为改过），
 * 这里做第一道清洗：非字符串一律当空，换行/制表符折叠成空格，
 * 这样它不可能在 system 消息里"另起一段"伪造指令。
 */
function contextText(value, limit = ASSISTANT_CONTEXT_FIELD_MAX) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '';
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join('') : text;
}

/** 取路径最后一段（同时认 `/` 与 `\`），并先去掉 `?`/`#` 之后的查询串。 */
function contextBaseName(value) {
  const text = contextText(value).split(/[?#]/)[0];
  const parts = text.split(/[\\/]+/).filter((item) => item !== '');
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

/**
 * `context` 的宽容归一：**只保留白名单字段，非法的一律丢弃、绝不让请求失败**。
 *
 * 它只是可选增强（任务卡 ②「缺省安全」），所以不按 `messages` 那套严格 400 处理：
 * 非对象（字符串 / 数组 / null）直接当没带；字段类型不对、页签不认识、
 * 页码不是正整数，都只是丢掉那一项。返回 `null` 或 `{}` 表示"没有可用上下文"。
 */
function normalizeAssistantContext(value) {
  if (!isPlainObject(value)) return null;
  const context = {};

  const tab = contextText(value.tab, 32).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ASSISTANT_CONTEXT_TABS, tab)) context.tab = tab;

  const nodeId = contextText(value.nodeId);
  if (nodeId !== '') context.nodeId = nodeId;
  const nodeTitle = contextText(value.nodeTitle);
  if (nodeTitle !== '') context.nodeTitle = nodeTitle;

  const materialPath = contextText(value.materialPath);
  if (materialPath !== '') context.materialPath = materialPath;
  if (Number.isInteger(value.materialPage) && value.materialPage > 0 && value.materialPage <= 100000) {
    context.materialPage = value.materialPage;
  }

  if (Number.isInteger(value.questionNo) && value.questionNo > 0 && value.questionNo <= 10000) {
    context.questionNo = value.questionNo;
  }

  const courseId = contextText(value.courseId, 64);
  if (courseId !== '') context.courseId = courseId;

  // v2-E（2026-11-22）：专注学习模式标志。只认布尔 `true`，字符串"true"之类一律不算，
  // 免得前端一个手误把普通答疑也套上「学习搭子」人设。
  if (value.studyMode === true) context.studyMode = true;

  return context;
}

/**
 * `context` → 一句 `【当前界面】…` 前置提示；拿不到任何可用信息时返回空串。
 *
 * **纯函数**：不查库、不读盘、不打网络，只做字符串拼装（任务卡 ⑥「纯函数可测」）。
 * 输出形如：
 *   `【当前界面】页签=知识点；正在看：「极限的定义」`
 *   `【当前界面】页签=资料；正在读：第3章.pdf 第 12 页`
 *   `【当前界面】页签=今日`
 *
 * 节点优先用 `nodeTitle`；没有标题就退到 `nodeId`（只带 id，不脑补标题）。
 * 总长超过 300 字时截断并加省略号，保证拼进 system 的那段不会失控。
 */
export function buildContextHint(context) {
  if (!isPlainObject(context)) return '';
  const segments = [];

  const tab = typeof context.tab === 'string' ? context.tab : '';
  const tabLabel = Object.prototype.hasOwnProperty.call(ASSISTANT_CONTEXT_TABS, tab)
    ? ASSISTANT_CONTEXT_TABS[tab]
    : '';
  if (tabLabel !== '') segments.push(`页签=${tabLabel}`);

  const nodeTitle = contextText(context.nodeTitle);
  const nodeId = contextText(context.nodeId);
  if (nodeTitle !== '') {
    segments.push(`正在看：「${nodeTitle}」`);
  } else if (nodeId !== '') {
    segments.push(`正在看：节点 ${nodeId}`);
  }

  const materialPath = contextText(context.materialPath);
  if (materialPath !== '') {
    const base = contextBaseName(materialPath);
    const page = Number.isInteger(context.materialPage) && context.materialPage > 0
      ? context.materialPage
      : null;
    segments.push(page === null ? `正在读：${base}` : `正在读：${base} 第 ${page} 页`);
  }

  if (Number.isInteger(context.questionNo) && context.questionNo > 0) {
    segments.push(`正在做：第 ${context.questionNo} 题`);
  }

  if (segments.length === 0) return '';
  const hint = `【当前界面】${segments.join('；')}`;
  const chars = Array.from(hint);
  if (chars.length <= ASSISTANT_CONTEXT_MAX_CHARS) return hint;
  return `${chars.slice(0, ASSISTANT_CONTEXT_MAX_CHARS - 1).join('')}…`;
}

/**
 * 把界面提示并进消息数组：**已有 system 就拼在该条开头，没有就在最前面加一条**。
 *
 * 返回新数组，不改入参；`hint` 为空时原样返回（保证"不带 context"与 MVP 逐字一致）。
 * 之所以在这里合并而不是在 `callMagpie` 里，是为了让注入的 `assistantChat` 桩
 * 和真实 magpie 链路看到**同一份** messages —— 测试才能直接断言 system 里有前缀。
 */
export function mergeContextHint(messages, hint) {
  const list = Array.isArray(messages)
    ? messages.map((item) => ({ role: item.role, content: item.content }))
    : [];
  if (typeof hint !== 'string' || hint === '') return list;
  if (list.length > 0 && list[0].role === 'system') {
    list[0] = { role: 'system', content: `${hint}\n${list[0].content}` };
    return list;
  }
  return [{ role: 'system', content: hint }, ...list];
}

/**
 * 读 magpie 网关密钥。
 *
 * 只认 `refs.MAGPIE_GATEWAY_KEY` 那一行，返回 `{ ok, key }` 或 `{ ok:false, reason }`；
 * **任何分支都不返回文件内容本身**，日志里也不许出现 `key`。
 * YAML 允许给值加引号，这里去掉成对引号再判空——`""` 不能被当成一个有效密钥。
 */
async function readMagpieKey(keyPath) {
  const file = typeof keyPath === 'string' && keyPath.trim() !== ''
    ? keyPath
    : path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = await fs.readFile(file, 'utf8');
    // 与 readParateraKey 同一条正则：只认缩进过的 refs 子项，别把别的键名匹配进来
    const matched = /^\s+MAGPIE_GATEWAY_KEY:\s*([^\s#]+)\s*$/m.exec(text);
    if (matched === null) return { ok: false, reason: 'assistant-key-missing' };
    let key = matched[1].trim();
    const quoted = /^(['"])(.*)\1$/.exec(key);
    if (quoted !== null) key = quoted[2].trim();
    if (key === '') return { ok: false, reason: 'assistant-key-missing' };
    return { ok: true, key };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'assistant-key-missing' };
    return { ok: false, reason: 'assistant-key-unreadable' };
  }
}

/**
 * 校验 `/assistant/reply` 的请求体。
 *
 * 返回 `{ ok:true, messages, maxTokens }`（**只留 role/content**，其余字段一律不转发）
 * 或 `{ ok:false, detail }`。校验口径与卡里的契约逐条对齐：
 *   - `messages` 必填、非空数组；每项 role ∈ {user,assistant,system}、content 非空字符串；
 *   - 末条必须是 `user`（否则模型会把「助手还没说的话」当成新一轮提问）；
 *   - `conversationId` / `persist` **只做类型校验、绝不使用**（MVP 不落盘）；
 *   - `maxTokens` 可覆盖缺省 2048，但必须在 1–8192 之间；
 *   - `context`（v2-A 界面上下文）是**可选增强**：存在时宽容归一（见 `normalizeAssistantContext`），
 *     非法字段丢弃、绝不让整个请求失败——它取不到时只留空。
 *
 * 超限一律**明确拒收**（400），不做静默截断：截断会让用户以为「历史都带上了」，
 * 而模型其实看到的是被剪过的一段，答错也查不出来。
 */
function validateAssistantMessages(payload) {
  if (!isPlainObject(payload)) return { ok: false, detail: '请求体必须是 JSON 对象。' };
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, detail: 'messages 必填，且必须是非空数组。' };
  }
  if (messages.length > ASSISTANT_MAX_MESSAGES) {
    return { ok: false, detail: `messages 最多 ${ASSISTANT_MAX_MESSAGES} 条（含历史）。` };
  }
  const contents = [];
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    const at = `第 ${index + 1} 条消息`;
    if (!isPlainObject(item)) return { ok: false, detail: `${at}不是对象。` };
    if (!ASSISTANT_ROLES.includes(item.role)) {
      return { ok: false, detail: `${at}的 role 只能是 user / assistant / system。` };
    }
    if (typeof item.content !== 'string' || item.content.trim() === '') {
      return { ok: false, detail: `${at}的 content 必须是非空字符串。` };
    }
    if (item.content.length > ASSISTANT_MAX_MESSAGE_CHARS) {
      return { ok: false, detail: `${at}超过 ${ASSISTANT_MAX_MESSAGE_CHARS} 字，请拆成几次问。` };
    }
    contents.push(item.content);
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { ok: false, detail: '最后一条消息必须是 user（助手不能自己接着往下说）。' };
  }
  const totalChars = contents.reduce((sum, text) => sum + text.length, 0);
  if (totalChars > ASSISTANT_MAX_TOTAL_CHARS) {
    return { ok: false, detail: `整段对话超过 ${ASSISTANT_MAX_TOTAL_CHARS} 字，请清空重开一段。` };
  }

  // 预留字段：校验类型，但**不读、不存、不落盘**
  if (payload.conversationId !== undefined && payload.conversationId !== null) {
    if (typeof payload.conversationId !== 'string' || payload.conversationId.length > 128) {
      return { ok: false, detail: 'conversationId 必须是长度 ≤ 128 的字符串（本版只保留字段、不落盘）。' };
    }
  }
  if (payload.persist !== undefined && payload.persist !== null && typeof payload.persist !== 'boolean') {
    return { ok: false, detail: 'persist 必须是布尔值（本版只保留字段、不落盘）。' };
  }

  let maxTokens = ASSISTANT_MAX_TOKENS;
  if (payload.maxTokens !== undefined && payload.maxTokens !== null) {
    if (!Number.isInteger(payload.maxTokens)
      || payload.maxTokens < 1
      || payload.maxTokens > ASSISTANT_MAX_TOKENS_LIMIT) {
      return { ok: false, detail: `maxTokens 必须是 1–${ASSISTANT_MAX_TOKENS_LIMIT} 的整数。` };
    }
    maxTokens = payload.maxTokens;
  }

  return {
    ok: true,
    messages: messages.map((item) => ({ role: item.role, content: item.content })),
    maxTokens,
    // 可选增强：非法 context 一律宽容丢弃（不整请求失败），见 normalizeAssistantContext
    context: normalizeAssistantContext(payload.context),
  };
}

/**
 * 调 magpie 网关的 chat/completions。
 *
 * 与 `callParatera` 同口径：429 / 5xx / 网络异常退避重试 3 次，其余 4xx 直接判失败
 * （重试不会改变鉴权/参数错误）。区别只有两处：
 *   1. `messages` 由调用方整段给（多轮对话），不做 system+user 的重新拼装；
 *   2. **绝不把上游响应体写进 detail** —— 网关报错时可能把请求内容回显出来，
 *      而请求里就是用户原文。
 *
 * 返回 `{ ok:true, content, attempts }`；失败返回 `{ ok:false, error, detail, attempts }`，**不抛异常**。
 * content 为空时回退取 `reasoning_content`（reasoning 模型偶尔把答案全写在思考段里）；
 * 两者都空才判 `assistant-bad-output`。
 */
export async function callMagpie(options) {
  const {
    key,
    messages,
    temperature = 0.3,
    maxTokens = ASSISTANT_MAX_TOKENS,
    timeoutMs = MAGPIE_TIMEOUT_MS,
    attempts = MAGPIE_ATTEMPTS,
    retryDelayMs = MAGPIE_RETRY_DELAY_MS,
    fetchImpl = fetch,
    baseUrl = MAGPIE_BASE_URL,
    model = MAGPIE_MODEL,
  } = options;
  const tried = [];
  let lastError = 'assistant-unavailable';
  let lastDetail = '通道没通（超时 / 限流 / 网络）';
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      tried.push({ attempt: index + 1, status: response.status });
      if (response.status === 429 || response.status >= 500) {
        lastError = 'assistant-unavailable';
        lastDetail = `HTTP ${response.status}`;
        if (index < attempts - 1) await sleep(retryDelayMs * (index + 1));
        continue;
      }
      if (!response.ok) {
        return {
          ok: false,
          error: 'assistant-rejected',
          detail: `HTTP ${response.status}`,
          attempts: tried,
        };
      }
      const payload = await response.json().catch(() => null);
      const message = payload?.choices?.[0]?.message ?? {};
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
      const text = content !== '' ? content : reasoning;
      if (text === '') {
        lastError = 'assistant-bad-output';
        lastDetail = '模型返回空内容';
        if (index < attempts - 1) await sleep(retryDelayMs * (index + 1));
        continue;
      }
      return { ok: true, content: text, attempts: tried };
    } catch (error) {
      const name = String(error?.name ?? 'Error');
      lastError = name === 'TimeoutError' || name === 'AbortError' ? 'assistant-timeout' : 'assistant-unavailable';
      lastDetail = lastError === 'assistant-timeout' ? '请求超时' : `网络异常（${name}）`;
      if (index < attempts - 1) await sleep(retryDelayMs * (index + 1));
    }
  }
  return { ok: false, error: lastError, detail: lastDetail, attempts: tried };
}

/** 创建 HTTP 处理器。
 * @param {{store: object, dataDir: string, backupKeep?: number, logger?: object, speech?: object,
 *   studentName?: string, studentNameVariants?: string, studentId?: string, workspaceRoot?: string,
 *   now?: () => Date, aiComplete?: (input: object) => Promise<object>, aiKeyPath?: string,
 *   assistantChat?: (input: object) => Promise<object>, assistantKeyPath?: string,
 *   assistantFetch?: typeof fetch}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(deps) {
  const { store } = deps;
  const dataDir = deps.dataDir;
  const log = deps.logger ?? console;
  // 提交件归档扫描用到的身份与工作区根目录。
  // 姓名或学号缺一个，扫描就整体关闭（宁可不动数据，也不要按半个条件归档）。
  const studentName = typeof deps.studentName === 'string' ? deps.studentName.trim() : '';
  const studentId = typeof deps.studentId === 'string' ? deps.studentId.trim() : '';
  const workspaceRoot = typeof deps.workspaceRoot === 'string' && deps.workspaceRoot.trim() !== ''
    ? deps.workspaceRoot
    // 默认：`学习台` 的父目录就是作业工作区根（各学科目录都在那里）
    : path.dirname(dataDir);
  /**
   * 腾讯会议「录音笔」把音频写到哪。
   *
   * 空字符串 = 没配，接口一律回「没有录音目录」，而不是去猜一个盘符 ——
   * 猜错的结果是页面列出一个不存在的目录、然后用户以为功能坏了。
   */
  const recordingDir = typeof deps.recordingDir === 'string' ? deps.recordingDir.trim() : '';

  /**
   * 作业详情缓存：`<wlkcid>|<xszyid>` → `{ at, detail }`。
   *
   * 放在 handler 闭包里而不是模块顶层：测试里可以各建各的 handler，
   * 互不串味；插件重载时也自然清空。
   */
  const learnDetailCache = new Map();

  /**
   * 详情拉不到时顺手补一次课程映射（见 `createLearnCourseRepairer`）。
   *
   * 2026-11-04 的教训：映射空着的时候，界面给的建议是「先跑一次同步」，
   * 而同步当时根本不写映射 —— 一条自我循环的假修法。现在详情自己会救一次，
   * 用户不需要知道映射这回事。
   */
  const repairLearnCourses = createLearnCourseRepairer({ dataDir, store, logger: log });

  /**
   * 网络学堂会话的「自愈」部分：心跳验证 + 专用浏览器续期。
   *
   * 会话 Cookie 是手动复制来的快照，一定会过期；过期后唯一的自动出路是让浏览器
   * 自己走一次统一身份认证（见 `learn-browser.js`）。浏览器实例在这里建一次、
   * 几个接口共用 —— 构造它**不**启动进程、不碰磁盘，真正拉起 Edge 只发生在
   * `/learn/renew`、`/learn/login-window`，以及心跳判定会话已失效的时候。
   */
  const learnBrowser = deps.learnBrowser ?? createLearnBrowser({
    profileDir: path.join(workspaceRoot, '.learn-edge'),
    logger: log,
  });

  /**
   * 会话状态（只活在内存里）。
   *
   * 不写进 `网络学堂.json`：那是凭据文件，形状越稳定越好；而且「上次验证时间」
   * 丢一次也无所谓 —— 重启后心跳会立刻重验一遍，用户看到的最坏情况是状态栏
   * 空几秒。
   */
  const learnSession = {
    alive: null,           // null = 还没验过；true / false = 最近一次的结论
    reason: 'unknown',
    checkedAt: null,
    checkedCount: 0,
    cookieUpdatedAt: null, // 最近一次「换到新 Cookie」的时间
    renewing: false,
    // 上回续期被 SSO 拦住、只能人工登录一次。**只封「自动去喂浏览器」这条路**，
    // 不代表会话死了 —— SSO 的登录态掉得快，票的寿命长得多，两者别混
    // （2026-10-12 修：以前封条一贴就直接报红，把一张好票误报成「Cookie 失效」）
    // 2026-10-12 修：以前封条一贴就直接报红，把一张好票误报成「Cookie 失效」
    manualNeeded: false,
    // 2026-10-18 修：封条曾经是**永久**的 —— 一次 SSO 表单就把自动续期锁死到
    // 用户手动点按钮为止（而 `hasPasswordField` 只要页面上有密码框就算，
    // SSO 页常驻「账号密码登录」表单，误判一次就锁死）。现在它只是一个**冷却**：
    // 过了冷却期，自动续期会再试一次，成功了封条自然就掉了。
    manualNeededAt: null,  // 最近一次贴封条的时刻（冷却从这时算起）
    browserOptOut: false,  // 用户点了「关闭后台浏览器」：别再自动拉起，直到他再动手
    // 最近一次「顺手喂 SSO」看到的结果（诊断用）：'ok' 说明登录态还活着、
    // 'login-form' 说明统一身份认证那边已经掉了 —— 事后想判断「喂没喂住」全靠它
    lastSsoTouch: null,
    // 「打开登录窗口」之后是否在盯着浏览器等用户登完（登完就自动把 Cookie 收下来）
    loginHarvesting: false,
  };

  /** 会话状态快照（给界面用），**不含 Cookie**。 */
  function learnSessionSnapshot() {
    return {
      alive: learnSession.alive,
      reason: learnSession.reason,
      checkedAt: learnSession.checkedAt,
      checkedCount: learnSession.checkedCount,
      cookieUpdatedAt: learnSession.cookieUpdatedAt,
      renewing: learnSession.renewing,
      manualNeeded: learnSession.manualNeeded,
      manualNeededAt: learnSession.manualNeededAt,
      browserOptOut: learnSession.browserOptOut,
      lastSsoTouch: learnSession.lastSsoTouch,
      loginHarvesting: learnSession.loginHarvesting,
      browser: learnBrowser.status(),
      edgeAvailable: learnBrowser.edgeAvailable === true,
    };
  }

  /**
   * 「红字挂着时自己直连复查」的节流。
   *
   * 界面每 60 秒问一次 `/learn/session`；只要红字已经挂过一分钟、又不在
   * 「等用户动手」的状态里，就顺手直连问一次票的死活 —— 票还活着就立刻恢复正常，
   * 别再让用户干等下一次心跳（2026-10-17：作业详情那条路曾把 `sso-timeout`
   * 写成 `alive = false`，好票要红二十来分钟）。
   */
  const LEARN_SELF_CHECK_MS = 60 * 1000;
  let learnSelfCheckAt = 0;

  /**
   * 「要人工登录」的冷却时长（默认 20 分钟，测试可注入 0）。
   *
   * 封条不是判决书：`hasPasswordField` 只要页面里有个密码框就算「要人工登录」，
   * 而清华 SSO 的页面上常驻着「账号密码登录」表单 —— 一次误判就足以让自动续期
   * 停摆到用户手动点按钮。冷却期一过就再试一次，误判不会变成永久故障。
   */
  const LEARN_MANUAL_COOLDOWN_MS = Number.isFinite(deps.learnManualCooldownMs)
    ? Math.max(0, deps.learnManualCooldownMs)
    : 20 * 60 * 1000;

  function manualCooldownElapsed() {
    if (learnSession.manualNeeded !== true) return true;
    const at = learnSession.manualNeededAt === null ? NaN : Date.parse(learnSession.manualNeededAt);
    if (!Number.isFinite(at)) return true; // 老状态没记时间：当作已到期，宁可多试一次
    return Date.now() - at >= LEARN_MANUAL_COOLDOWN_MS;
  }

  /**
   * 会话日志：一行一个 JSON，超过 200 KB 轮转一次（只留一份 .1）。
   *
   * 为什么要有：这张票是**会话 Cookie + 服务端空闲超时**，什么时候掉的、掉之前
   * 最后一次成功是什么时候，全靠事后能查。以前插件一行不落，出问题只能猜。
   * 只记「什么时候、什么原因、多久、票多长」，**不记票原文**。
   */
  const SESSION_LOG_MAX_BYTES = 200 * 1024;

  async function sessionLog(event, data = {}) {
    try {
      const file = path.join(workspaceRoot, '.learn-session.log');
      const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`;
      try {
        const st = await fs.stat(file);
        if (st.size > SESSION_LOG_MAX_BYTES) await fs.rename(file, `${file}.1`).catch(() => {});
      } catch {
        // 文件还不存在：第一次写就是它
      }
      await fs.appendFile(file, line, 'utf8');
    } catch {
      // 日志绝不能反过来把主流程弄挂
    }
  }

  /**
   * 从专用浏览器里取一张能用的票 —— **浏览器是凭据持有者，磁盘只是缓存**。
   *
   * 学堂那张 `JSESSIONID` 是会话 Cookie（关浏览器就没了）+ 服务端空闲超时，
   * 真正长期有效的是 SSO 那边的 `TSINGHUAUSERID`（「信任浏览器」，一年）。
   * 所以「磁盘上的票空了/旧了」根本不该等于「连不上」：先去浏览器问一句。
   * 2026-10-18 12:50 那次把空票写进磁盘，就是这么白断了九个小时。
   */
  async function adoptCookieFromBrowser(reason = 'manual', label = 'recover') {
    if (learnBrowser.edgeAvailable !== true) return { ok: false, reason: 'edge-not-found' };
    // 用户说过「别自动拉浏览器」就尊重他；他手动按的那次（manual）例外。
    // 否则「关掉后台浏览器」会变成一句空话 —— 每 8 分钟又被我们偷偷拉起来。
    if (learnSession.browserOptOut === true && reason !== 'manual') return { ok: false, reason: 'browser-opt-out' };
    if (learnSession.loginHarvesting === true && reason !== 'manual') return { ok: false, reason: 'login-harvesting' };
    if (typeof learnBrowser.readCookie !== 'function') return { ok: false, reason: 'no-reader' };
    let read = null;
    try {
      read = await learnBrowser.readCookie();
    } catch (error) {
      return { ok: false, reason: 'read-failed', detail: String(error?.message ?? error) };
    }
    if (read === null || read.ok !== true) return { ok: false, reason: read?.reason ?? 'read-failed' };
    const cookie = typeof read.cookie === 'string' ? read.cookie.trim() : '';
    if (cookie === '') return { ok: false, reason: 'empty-cookie' };
    const check = await fetchLearnIndex(cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    if (!check.alive) return { ok: false, reason: 'cookie-invalid' };
    const config = await readLearnConfig(dataDir);
    if (!config.ok) return { ok: false, reason: config.reason };
    if (cookie !== config.cookie) {
      try {
        await writeLearnConfig(dataDir, { ...config, cookie });
        learnSession.cookieUpdatedAt = new Date().toISOString();
        await sessionLog('adopt', { label, cookieLen: cookie.length });
        log.info?.('[study-assistant] 已从专用浏览器取回可用的票并落盘');
      } catch (error) {
        // 写盘失败不影响这一次的判断：浏览器里那张票是真的
        log.warn?.('[study-assistant] 取回的票写盘失败：', error);
      }
    }
    learnSession.checkedAt = new Date().toISOString();
    learnSession.alive = true;
    learnSession.reason = 'ok';
    return { ok: true, cookie };
  }

  function learnSelfCheckDue() {
    if (learnSession.alive !== false) return false;
    if (learnSession.renewing === true || learnSession.loginHarvesting === true) return false;
    // 「要人工登录」就等用户动手：他在登的时候我们每轮白问一次没有意义
    if (learnSession.manualNeeded === true) return false;
    const now = Date.now();
    if (now - learnSelfCheckAt < LEARN_SELF_CHECK_MS) return false;
    const checked = learnSession.checkedAt === null ? NaN : Date.parse(learnSession.checkedAt);
    if (Number.isFinite(checked) && now - checked < LEARN_SELF_CHECK_MS) return false;
    learnSelfCheckAt = now;
    return true;
  }

  /**
   * 静默重连：headless 打开 SSO，模拟点击登录把会话换回来（用户 2026-11-12 要的
   * 「拟人化一键重连」）。全程不弹可见窗。
   *
   * 账号密码来源：优先读插件存的那份（用户显式同意让插件存）；没存也没关系 ——
   * Edge 密码管理器可能已经自动填好了，`silentRelogin` 会先试「直接点」再试「填了再点」。
   *
   * 返回 `{ ok:true, cookie, source }` 或 `{ ok:false, reason }`。**不落盘**（由调用方
   * 验活后决定要不要写），也不碰 `manualNeeded` 封条（调用方处理）。
   */
  async function trySilentRelogin(reason = 'manual') {
    if (learnBrowser.edgeAvailable !== true) return { ok: false, reason: 'edge-not-found' };
    if (typeof learnBrowser.silentRelogin !== 'function') return { ok: false, reason: 'no-relogin' };
    if (learnSession.browserOptOut === true && reason !== 'manual') return { ok: false, reason: 'browser-opt-out' };
    let cred = { user: '', pass: '', present: false };
    try {
      cred = await readLearnCredential(dataDir);
    } catch {
      cred = { user: '', pass: '', present: false };
    }
    try {
      const result = await learnBrowser.silentRelogin({ user: cred.user, pass: cred.pass });
      if (result.ok === true) {
        void sessionLog('silent-relogin', { reason, source: result.source ?? null, clicked: result.clicked === true, hadCred: cred.present === true });
      } else {
        void sessionLog('silent-relogin-fail', { reason, why: result.reason ?? 'unknown', hadCred: cred.present === true });
      }
      return result;
    } catch (error) {
      return { ok: false, reason: 'relogin-error', detail: String(error?.message ?? error) };
    }
  }

  /**
   * 让浏览器去换一张新的会话 Cookie，验证通过才落盘。
   *
   * 「浏览器说自己登录了」不算数：真正算数的是平台认不认这张新 Cookie，
   * 所以这里再用它请求一次学生端首页，活了才写进 `网络学堂.json`。
   * 任一步失败都**不动**现有配置 —— 把还能用的旧 Cookie 覆盖成坏的，
   * 比续期失败本身糟糕得多。
   *
   * 两点值得记住：
   * ① 浏览器把 Cookie 又发回来一张**一模一样**的（心跳每 20 分钟的正常结局）时
   *    不写盘：既省一次验活请求，也不让 `网络学堂.json` 的 mtime 每 20 分钟跳一次。
   * ② 不在这里关浏览器。2026-10-12 起后台浏览器是**常驻**的 —— 它一关，清华 SSO
   *    那边的会话就没人喂，闲死之后每次续期都变成「必须人工登录」，正是用户抱怨
   *    「老提醒 Cookie 失效」的根子。要关只走「关闭后台浏览器」按钮（记 optOut）。
   */
  async function renewLearnCookie(options = {}) {
    // `busy` / `edge-not-found` 这类「根本没动手」的分支也要留痕：
    // 2026-11-04 排障时，日志里只有 check、没有 renew，唯一的线索是某次 check
    // 的耗时突然从 150ms 变成 4755ms —— 得靠猜才知道它去试过浏览器。别再让下一个人猜。
    const t0 = Date.now();
    const outcome = await renewLearnCookieInner(options);
    // 只在真的动过浏览器时才记：没装 Edge / 正忙 / 收割中是每 20 分钟一条的噪音
    if (outcome.reason !== 'edge-not-found' && outcome.reason !== 'busy' && outcome.reason !== 'login-harvesting') {
      await sessionLog('renew', {
        reason: options.reason ?? null,
        ms: Date.now() - t0,
        ok: outcome.ok === true,
        source: outcome.source ?? null,
        why: outcome.ok === true ? null : outcome.reason ?? 'unknown',
        detail: outcome.detail ?? null,
        sso: outcome.ssoTouch ?? null,
      });
    }
    return outcome;
  }

  async function renewLearnCookieInner(options = {}) {
    if (learnSession.renewing) return { ok: false, reason: 'busy' };
    if (learnBrowser.edgeAvailable !== true) return { ok: false, reason: 'edge-not-found' };
    // 用户正在可见窗口里登着（登录收割开着）时，自动的那几路都别去碰浏览器：
    // 续期一看要人工就会把窗口关掉，而那正是他在输验证码的那个窗口。
    // 「立即续期」是例外 —— 那是他自己按的。
    if (learnSession.loginHarvesting === true && options.reason !== 'manual') {
      return { ok: false, reason: 'login-harvesting', detail: null };
    }
    // 人工点的那次要把两道封条都撕掉：
    // 「得手动登录」——否则用户登完了我们还在原地踏步；
    // 「别自动拉浏览器」——他既然手动催了，就是要它重新干活
    if (options.reason === 'manual') {
      learnSession.manualNeeded = false;
      learnSession.browserOptOut = false;
    }
    learnSession.renewing = true;
    try {
      const config = await readLearnConfig(dataDir);
      if (!config.ok) return { ok: false, reason: config.reason };

      const renewed = await learnBrowser.renew({
        headless: options.headless !== false,
        touchSso: options.touchSso === true,
      });
      if (typeof renewed.ssoTouch === 'string' && renewed.ssoTouch !== 'skipped') {
        learnSession.lastSsoTouch = {
          at: new Date().toISOString(),
          state: renewed.ssoTouch,
          reason: options.reason ?? null,
          detail: renewed.ssoTouchDetail ?? null,
        };
      }
      if (!renewed.ok) {
        if (renewed.reason === 'needs-manual-login') {
          // 2026-11-12：落到「必须人工登录」时，先别急着贴封条 —— 若存了账号密码
          // （或 Edge 已自动填好），直接 headless 模拟点击把登录表单点掉，全程静默，
          // 这就是用户要的「拟人化一键重连」。点成功了票就到手，连封条都不用贴。
          const relogin = await trySilentRelogin(options.reason);
          if (relogin.ok) {
            const newCookie = typeof relogin.cookie === 'string' ? relogin.cookie.trim() : '';
            if (newCookie !== '' && newCookie !== config.cookie) {
              const verified = await fetchLearnIndex(newCookie, { timeoutMs: LEARN_TIMEOUT_MS });
              if (verified.alive) {
                await writeLearnConfig(dataDir, { ...config, cookie: newCookie });
                learnSession.cookieUpdatedAt = new Date().toISOString();
                learnSession.manualNeeded = false;
                learnSession.alive = true;
                learnSession.reason = 'renewed';
                log.info?.('[study-assistant] 一键重连成功：模拟点击登录拿回了新会话');
                return { ok: true, source: 'silent-relogin', ssoTouch: renewed.ssoTouch ?? null };
              }
            } else if (newCookie === config.cookie) {
              // 点完拿回来还是同一张且可用（极少见）：当 unchanged 处理
              learnSession.manualNeeded = false;
              return { ok: true, source: 'unchanged', ssoTouch: renewed.ssoTouch ?? null };
            }
          }
          // 静默重连没成（没存密码 / 风控弹验证码 / 点不动）：才贴封条
          learnSession.manualNeeded = true;
          learnSession.manualNeededAt = new Date().toISOString();
          // 2026-10-18 修：以前这里会把浏览器关掉。可浏览器现在是**唯一的凭据持有者**
          // （`TSINGHUAUSERID` 那张「信任浏览器」票只在它的 profile 里），关掉等于
          // 把最后一张能自救的牌扔掉 —— 而且用户点「打开登录窗口」时还得重新等它启动。
          // 所以只贴封条、不动浏览器，也不停收割轮询（他可能正要去那个窗口里登）。
        }
        return { ok: false, reason: renewed.reason ?? 'renew-failed', detail: renewed.detail ?? null };
      }
      const cookie = typeof renewed.cookie === 'string' ? renewed.cookie.trim() : '';
      if (cookie === '') return { ok: false, reason: 'empty-cookie' };

      // 一模一样：会话本来就活着，什么都没变，不必惊动磁盘
      if (cookie === config.cookie) {
        return { ok: true, source: 'unchanged', ssoTouch: renewed.ssoTouch ?? null };
      }

      const check = await fetchLearnIndex(cookie, { timeoutMs: LEARN_TIMEOUT_MS });
      if (!check.alive) return { ok: false, reason: 'cookie-invalid' };

      await writeLearnConfig(dataDir, { ...config, cookie });
      learnSession.cookieUpdatedAt = new Date().toISOString();
      learnSession.manualNeeded = false;
      log.info?.('[study-assistant] 网络学堂会话已自动续期（换到新 Cookie）');
      return { ok: true, source: renewed.source ?? 'renewed', ssoTouch: renewed.ssoTouch ?? null };
    } catch (error) {
      return { ok: false, reason: 'renew-failed', detail: String(error?.message ?? error) };
    } finally {
      learnSession.renewing = false;
    }
  }

  /**
   * 验一次会话是否还活着；失效就顺手续一次。
   *
   * **走浏览器，不再只拿 Cookie 发个请求**：浏览器跑一趟才会经过清华 SSO，
   * 学堂与统一身份认证两边的空闲计时器一起被清零 —— 这是 2026-10-12 那次
   * 「每 20 分钟真的走进登录域」改动的核心。没有 Edge、或用户明确关了后台
   * 浏览器、或浏览器这条出了别的岔子时，退回「拿 Cookie 请求一次」这条老路：
   * 它能验活，但喂不暖 SSO。
   *
   * `reason` 只用于日志与状态里的区分（`startup` / `timer` / `manual` / `detail`）。
   */
  async function checkLearnSession(reason = 'manual') {
    const t0 = Date.now();
    try {
      return await runLearnCheck(reason);
    } finally {
      await sessionLog('check', {
        reason,
        ms: Date.now() - t0,
        alive: learnSession.alive,
        why: learnSession.reason,
        count: learnSession.checkedCount,
      });
    }
  }

  /** 检查的主体（`checkLearnSession` 只负责套一层日志）。 */
  async function runLearnCheck(reason) {
    const config = await readLearnConfig(dataDir);
    learnSession.checkedAt = new Date().toISOString();
    learnSession.checkedCount += 1;

    if (!config.ok) {
      learnSession.alive = false;
      learnSession.reason = config.reason;
      return learnSessionSnapshot();
    }
    if (!cookieUsable(config.cookie)) {
      // 2026-10-18 修：票为空**不等于**「没连上」。学堂那张是会话 Cookie，
      // 真正持有它的是专用浏览器；磁盘上这张只是缓存，缓存空了先去浏览器问一句。
      const adopted = await adoptCookieFromBrowser(reason, 'empty-config');
      if (adopted.ok) return learnSessionSnapshot();
      learnSession.alive = false;
      learnSession.reason = 'not-connected';
      return learnSessionSnapshot();
    }

    // 封条（manualNeeded）只封「自动去喂浏览器」这条路，它**不**等于会话死了。
    // SSO 的登录态掉得快，票的寿命长得多；以前这里封条一贴就直接报红，
    // 于是好端端的一张票每 20 分钟被误报一次「Cookie 失效」（用户反复抱怨的那个）。
    let warmTrouble = null; // 浏览器那条没走通的原因：只影响提示，不直接等于会话失效
    if (learnSession.manualNeeded && reason !== 'manual' && !manualCooldownElapsed()) {
      // 冷却期还没过：别再弹一个浏览器白试一次，
      // 但下面照样直连验一次票 —— 票还活着就照实说活着
      warmTrouble = 'needs-manual-login';
    } else {
      if (learnSession.manualNeeded && reason !== 'manual') {
        // 冷却到期：误判不该变成永久故障，再给自动续期一次机会。
        // 2026-11-12 起**彻底静默**：以前这里会 `openLoginWindow({headless:false})`
        // 突然弹一个可见窗，是用户抱怨「经常莫名弹出登录框」的根源。现在只撕封条、
        // 走下面的自动续期（里面含「一键重连」的模拟点击），绝不再自动弹窗 ——
        // 真到点不动、只能人工时，只在小卡片静默标一句，由用户自己决定点不点。
        learnSession.manualNeeded = false;
        learnSession.manualNeededAt = null;
        await sessionLog('login-retry-silent', { reason, at: new Date().toISOString() });
      }
      // 用户自己按了「关闭后台浏览器」就别硬拉（manual 例外：他手动催了就是要它干活）；
      // 他正在可见窗口里登着的时候同理 —— 那时去续期会把登录窗口关掉。
      const canWarm = learnBrowser.edgeAvailable === true
        && !(learnSession.browserOptOut && reason !== 'manual')
        && !(learnSession.loginHarvesting === true && reason !== 'manual');
      if (canWarm) {
        const warmed = await renewLearnCookie({ reason, touchSso: true });
        if (warmed.ok) {
          learnSession.alive = true;
          // `unchanged` = 浏览器把同一张 Cookie 又发回来了，会话本来就活着
          learnSession.reason = warmed.source === 'unchanged' ? 'ok' : 'renewed';
          return learnSessionSnapshot();
        }
        if (warmed.reason === 'needs-manual-login') {
          warmTrouble = 'needs-manual-login';
          log.warn?.('[study-assistant] 后台浏览器喂不动 SSO 了（要人工登录）：改用 Cookie 直连判断会话死活');
        } else {
          // CDP 抽风、进程被杀软拦了……：别因此把一张好好的 Cookie 判死，
          // 退回直连，至少把「这张 Cookie 到底还有效吗」说准
          log.warn?.(`[study-assistant] 后台浏览器这条没走通（${warmed.reason ?? 'unknown'}），改用 Cookie 直连检查`);
        }
      }
    }

    return await bareLearnCheck(warmTrouble, reason);
  }

  /**
   * 只拿现成的那张 Cookie 直连验一次，更新 `alive` / `reason`。
   *
   * 「浏览器那条路走不通」和「这张票还能不能用」是两件事，这个函数专门回答后者：
   * 只要它说活，界面就不该报红（最多加一句「浏览器那条等你哪天顺手登一次」）。
   * 票也死了才轮到红字 —— 那时候才有必要让人去登录窗口。
   */
  async function bareLearnCheck(warmTrouble = null, reason = 'manual') {
    const config = await readLearnConfig(dataDir);
    if (!config.ok) {
      learnSession.alive = false;
      learnSession.reason = config.reason;
      return learnSessionSnapshot();
    }
    if (!cookieUsable(config.cookie)) {
      // 缓存里没票：先去浏览器问一句，问到了就当场恢复
      const adopted = await adoptCookieFromBrowser(reason, 'bare-empty');
      if (adopted.ok) return learnSessionSnapshot();
      learnSession.alive = false;
      learnSession.reason = 'not-connected';
      return learnSessionSnapshot();
    }
    let index = null;
    try {
      index = await fetchLearnIndex(config.cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    } catch (error) {
      // 断网、超时这类「不是 Cookie 的错」要区分开：别让用户以为要重新登录
      learnSession.alive = null;
      learnSession.reason = 'learn-unreachable';
      return learnSessionSnapshot();
    }
    if (index.alive !== true) {
      // 磁盘上这张过期了，但浏览器里那张可能还活着（会话 Cookie 只在它手里）。
      // 这一步把「缓存旧了」和「真的没票了」分开 —— 前者不该惊动用户。
      const adopted = await adoptCookieFromBrowser(reason, 'bare-check');
      if (adopted.ok) return learnSessionSnapshot();
    }
    learnSession.checkedAt = new Date().toISOString();
    learnSession.alive = index.alive === true;
    if (index.alive) {
      // `cookie-only` = 票是好的，只是浏览器那条要人工登录一次，会话本身没问题
      learnSession.reason = warmTrouble === null ? 'ok' : 'cookie-only';
    } else {
      learnSession.reason = warmTrouble === 'needs-manual-login' ? 'needs-manual-login' : 'cookie-invalid';
      log.warn?.('[study-assistant] 网络学堂会话失效且未能自动续期：cookie-invalid');
    }
    return learnSessionSnapshot();
  }

  async function handleHealth(res) {
    const health = await store.health();
    sendJson(res, health.healthy ? 200 : 503, { ok: health.healthy, ...health });
  }

  async function handleState(req, res, url) {
    const docParam = url.searchParams.get('doc');
    const checked = checkDocKey(docParam);
    if (!checked.ok) return sendJson(res, 400, { ok: false, error: checked.reason, allowed: DOC_KEYS });

    if (checked.key !== null) {
      const result = await store.readDocument(checked.key);
      if (result.ok) return sendJson(res, 200, { ok: true, key: checked.key, doc: result.doc, hash: result.hash });
      if (result.reason === 'missing') {
        return sendJson(res, 200, { ok: true, key: checked.key, doc: null, hash: null, missing: true });
      }
      return sendJson(res, 409, { ok: false, error: result.reason, key: checked.key, hash: result.hash ?? null });
    }

    const all = await store.readAll();
    // 每份文档的 sha256：客户端用它做乐观并发控制（写请求的 expectedHash）
    const hashes = {};
    for (const key of DOC_KEYS) {
      const read = await store.readDocument(key);
      hashes[key] = read.ok ? read.hash : null;
    }
    // ⚠️ `ok` 必须放在展开**之后**。
    //    readAll() 自带 `ok: problems.every(p => p.reason === 'missing')`，
    //    如果写 `{ ok: true, ...all }`，展开的 ok 会把它覆盖成 false ——
    //    于是一份文档损坏时客户端收到 `{ok:false}` 却没有 error 字段，
    //    面板显示「读取失败：HTTP 200」、重试永远失败，**另外三份完好的数据也被挡在门外**。
    //    语义上 HTTP 200 表示「这次请求成功」，per-document 的损坏由 problems/doc 表达。
    return sendJson(res, 200, { ...all, ok: true, hashes, files: DOC_FILES });
  }

  async function handleMutate(req, res) {
    if (!writePreflight(req, res)) return;

    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    }

    const checked = checkDocKey(payload.doc);
    if (!checked.ok || checked.key === null) {
      return sendJson(res, 400, { ok: false, error: 'unknown-doc', allowed: DOC_KEYS });
    }
    const key = checked.key;
    const action = payload.action;
    if (!['create', 'update', 'delete'].includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'unknown-action' });
    }

    // 批注是「原文只读、批注覆盖层」，写盘前必须基于**服务端完整原文**重算锚点、
    // 并核对 file 在 资料索引.json 白名单里——这两步通用 mutate 做不了，走专用分支。
    if (key === 'annotations') {
      const readNotes = await store.readDocument('annotations');
      if (!readNotes.ok && readNotes.reason !== 'missing') {
        return sendJson(res, 409, { ok: false, error: readNotes.reason, key });
      }
      const notesDoc = readNotes.ok ? readNotes.doc : defaultDoc('annotations');
      const notesExpectedHash = typeof payload.expectedHash === 'string' && payload.expectedHash !== ''
        ? payload.expectedHash
        : readNotes.ok ? readNotes.hash : null;
      return await handleAnnotationsMutate({ res, action, payload, doc: notesDoc, expectedHash: notesExpectedHash });
    }

    const route = DOC_ROUTES[key];
    if (route === undefined) {
      // 作业记录由 /homework/* 专用路由维护，通用 mutate 不认识它的字段
      return sendJson(res, 400, { ok: false, error: 'use-dedicated-route', key });
    }
    const read = await store.readDocument(key);
    if (!read.ok && read.reason !== 'missing') {
      // 损坏保护：拒绝在损坏文件上做增量修改
      return sendJson(res, 409, { ok: false, error: read.reason, key });
    }
    const doc = read.ok ? read.doc : defaultDoc(key);
    // 前置条件：客户端可传入它读取时的 hash，用于乐观并发控制；
    // 未传则用本次服务端刚读到的 hash，同样能挡住「读之后被外部改动」的情况。
    const expectedHash = typeof payload.expectedHash === 'string' && payload.expectedHash !== ''
      ? payload.expectedHash
      : read.ok ? read.hash : null;
    const list = Array.isArray(doc[route.listKey]) ? [...doc[route.listKey]] : [];

    // 批量更新：面板一次勾一片节点时只发一条请求、只落一次盘。
    // 逐个发 N 条 /mutate 会写 N 次磁盘、留 N 份备份，中途失败还会留下「改了一半」的状态。
    // 语义是「全成或全不成」：任何一条 id 不存在或字段不合法都不写盘。
    if (action === 'update' && Array.isArray(payload.items)) {
      // 超过上限直接拒绝，不静默截断：截断会让调用方以为「全都改了」，实际只改了前 500 个。
      // 2026-10-23 凌晨发现原来写的是 slice(0, 500)，面板批量改挂靠命中 >500 时会悄悄少改。
      if (payload.items.length > 500) return sendJson(res, 400, { ok: false, error: 'too-many-items', limit: 500 });
      const raws = payload.items;
      if (raws.length === 0) return sendJson(res, 400, { ok: false, error: 'empty-items' });
      const missing = [];
      for (const raw of raws) {
        if (!isValidId(raw?.id)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
        const index = findIndexById(list, raw.id);
        if (index === -1) {
          missing.push(raw.id);
          continue;
        }
        const normalized = route.normalize(raw.item ?? {}, list[index]);
        if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason, id: raw.id });
        list[index] = normalized.item;
      }
      if (missing.length > 0) return sendJson(res, 404, { ok: false, error: 'not-found', ids: missing });
      const next = { ...doc, [route.listKey]: list };
      const written = await store.writeDocument(key, next, { expectedHash, backupKeep: deps.backupKeep });
      if (!written.ok) {
        const status = written.reason === 'conflict' ? 409 : 422;
        return sendJson(res, status, { ok: false, error: written.reason, key });
      }
      return sendJson(res, 200, { ok: true, key, hash: written.hash, count: list.length, updated: raws.length });
    }

    if (action === 'create') {
      const normalized = route.normalize(payload.item ?? {}, null);
      if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason });
      list.push(normalized.item);
    } else {
      if (!isValidId(payload.id)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
      const index = findIndexById(list, payload.id);
      if (index === -1) return sendJson(res, 404, { ok: false, error: 'not-found', id: payload.id });

      if (action === 'update') {
        const normalized = route.normalize(payload.item ?? {}, list[index]);
        if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason });
        list[index] = normalized.item;
      } else {
        if (key === 'courses') {
          // 删除课程前检查是否仍被任务或成绩引用，避免留下孤儿记录
          const all = await store.readAll();
          const used = collectReferences(all.docs, payload.id);
          if (used.tasks > 0 || used.grades > 0) {
            return sendJson(res, 409, { ok: false, error: 'course-in-use', references: used });
          }
        }
        list.splice(index, 1);
      }
    }

    const next = { ...doc, [route.listKey]: list };
    const written = await store.writeDocument(key, next, { expectedHash, backupKeep: deps.backupKeep });
    if (!written.ok) {
      const status = written.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: written.reason, key });
    }
    return sendJson(res, 200, { ok: true, key, hash: written.hash, count: list.length });
  }

  // ---------------------------------------------------------------------------
  // 批注（第 12 份主文档 `annotations` / 学习台/批注.json）
  //
  // 「原文只读、批注是覆盖层」的落地点：
  //   - 写路径只有 `POST /mutate` + `doc === 'annotations'`（这里），不存在写讲义 md 的路径；
  //   - 批注的 `file` 必须是 `资料索引.json` 里登记过的 path（与 /materials/text 同一白名单）；
  //   - 锚点一律**基于服务端完整原文**重算（客户端只提交 quote/start/end 线索），
  //     偏移对不上就用指纹重定位，彻底找不到回 400 `anchor-not-found`，杜绝伪造偏移；
  //   - 「点保存才写盘」在客户端保证，服务端一次请求只落一次盘 + 一份备份。
  // ---------------------------------------------------------------------------

  /**
   * 把资料 / 批注里的 `file` 键归一成「相对工作区根的 posix 路径」。
   *
   * 面板或外部脚本可能传各种形态：反斜杠、前导斜杠、`./`、绝对路径（`D:\…` 或 `file:///…`）、
   * 以及误加的 `学习台/` 前缀。批注落盘的键必须与 `资料索引.json` 的 `path` 同一个形态，
   * 否则读写两边永远对不上——而且读接口查不到时只会静默返回 `count: 0`，很难发现。
   * 只归一「形态」不做「猜测」：不解析 `..`、不做大小写折叠，认不出来就交给白名单去拒。
   */
  function canonicalAnnotationFile(rawPath) {
    let value = String(rawPath ?? '').trim();
    if (value === '') return '';
    value = value.replace(/^file:\/{2}/i, '').replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(value) || value.startsWith('/')) {
      const comparable = value.replace(/^\/+/, '');
      const rootAbs = path.resolve(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
      const rootComparable = rootAbs.replace(/^\/+/, '');
      const lowered = comparable.toLowerCase();
      const rootLowered = rootComparable.toLowerCase();
      if (lowered === rootLowered) return '';
      value = lowered.startsWith(`${rootLowered}/`) ? comparable.slice(rootComparable.length + 1) : comparable;
    }
    value = value.replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
    if (value.startsWith('学习台/')) value = value.slice('学习台/'.length);
    return value;
  }

  /** 读一份「有文字层」的资料的完整原文（按 资料索引.json 白名单 + 越界检查）。 */
  async function readMaterialFullText(rawPath) {
    const wanted = canonicalAnnotationFile(rawPath);
    if (wanted === '') return { ok: false, reason: 'missing-file' };
    const all = await store.readAll();
    const files = Array.isArray(all.docs.materials?.files) ? all.docs.materials.files : [];
    const record = files.find((item) => canonicalAnnotationFile(item?.path) === wanted);
    if (record === undefined) return { ok: false, reason: 'file-not-indexed' };
    const outFile = typeof record?.text?.outFile === 'string' ? record.text.outFile : '';
    if (outFile === '') return { ok: false, reason: 'not-text-material' };
    const rootAbs = path.resolve(workspaceRoot);
    const clean = outFile.replace(/\\/g, '/').replace(/^\.\//, '');
    if (clean === '' || clean.split('/').includes('..')) return { ok: false, reason: 'file-unreadable' };
    const abs = path.resolve(rootAbs, clean);
    if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) return { ok: false, reason: 'file-unreadable' };
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      return { ok: false, reason: 'file-unreadable' };
    }
    if (text.length > MAX_ANCHOR_CHARS) return { ok: false, reason: 'file-too-large' };
    return { ok: true, text, file: wanted };
  }

  /** 把客户端提交的输入 + 服务端完整原文，重算出一条可落盘的批注。 */
  async function buildAnnotationFromInput(input, nowIso) {
    const source = input !== null && typeof input === 'object' ? input : {};
    const file = canonicalAnnotationFile(source.file);
    if (file === '') return { ok: false, reason: 'missing-file' };
    const type = typeof source.type === 'string' ? source.type : '';
    if (!ANNOTATION_TYPES.includes(type)) return { ok: false, reason: 'bad-type' };
    if (typeof source.content !== 'string') return { ok: false, reason: 'bad-content' };
    const page = source.page === undefined || source.page === null ? null : source.page;
    if (page !== null && !(Number.isInteger(page) && page >= 1)) return { ok: false, reason: 'bad-page' };
    if (source.weak !== undefined && (source.weak === null || typeof source.weak !== 'object' || Array.isArray(source.weak))) {
      return { ok: false, reason: 'bad-weak' };
    }
    const submitted = source.anchor !== null && typeof source.anchor === 'object' ? source.anchor : source;
    // 知识点虚拟文件 kp:<nodeId>：正文由客户端渲染（不在磁盘/索引里），用随请求带来的 kpText
    // 做锚点自洽校验。仍走 resolveAnchorFromText，保证 quote/偏移对得上才收。
    let anchorText;
    if (file.startsWith('kp:')) {
      if (typeof source.kpText !== 'string' || source.kpText === '') return { ok: false, reason: 'missing-kp-text' };
      anchorText = source.kpText;
    } else {
      const full = await readMaterialFullText(file);
      if (!full.ok) return { ok: false, reason: full.reason };
      anchorText = full.text;
    }
    const resolved = resolveAnchorFromText(anchorText, {
      quote: submitted.quote,
      start: submitted.start,
      end: submitted.end,
      prefix: submitted.prefix,
      suffix: submitted.suffix,
      exact: submitted.exact === true,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const note = {
      id: makeId('a'),
      file,
      type,
      content: source.content,
      page,
      anchor: resolved.anchor,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (source.weak !== undefined) note.weak = source.weak;
    const style = sanitizeAnnotationStyle(source.style);
    if (style !== undefined && style !== null) note.style = style;
    const markKind = sanitizeAnnotationMarkKind(source.markKind);
    if (markKind !== undefined && markKind !== null) note.markKind = markKind;
    return { ok: true, value: note, relocated: resolved.status };
  }

  /** 在已有批注上合并改动（只改正文/类型不必重算锚点；改文件或改锚点必须重算）。 */
  async function mergeAnnotationInput(existing, input, nowIso) {
    const source = input !== null && typeof input === 'object' ? input : {};
    const next = { ...existing, anchor: { ...(existing.anchor ?? {}) } };
    if (source.type !== undefined) {
      if (!ANNOTATION_TYPES.includes(source.type)) return { ok: false, reason: 'bad-type' };
      next.type = source.type;
    }
    if (source.content !== undefined) {
      if (typeof source.content !== 'string') return { ok: false, reason: 'bad-content' };
      next.content = source.content;
    }
    if (source.page !== undefined) {
      if (source.page === null) next.page = null;
      else if (Number.isInteger(source.page) && source.page >= 1) next.page = source.page;
      else return { ok: false, reason: 'bad-page' };
    }
    if (source.weak !== undefined) {
      if (source.weak === null) delete next.weak;
      else if (typeof source.weak === 'object' && !Array.isArray(source.weak)) next.weak = source.weak;
      else return { ok: false, reason: 'bad-weak' };
    }
    if (source.style !== undefined) {
      const style = sanitizeAnnotationStyle(source.style);
      if (style === null || style === undefined) delete next.style;
      else next.style = style;
    }
    // markKind：null 显式清除、undefined 不动、非法值静默丢弃（同 style 口径）
    if (source.markKind !== undefined) {
      const markKind = sanitizeAnnotationMarkKind(source.markKind);
      if (markKind === null || markKind === undefined) delete next.markKind;
      else next.markKind = markKind;
    }
    const submitted = source.anchor !== null && typeof source.anchor === 'object' ? source.anchor : source;
    const wantsReanchor = source.file !== undefined
      || submitted.quote !== undefined || submitted.start !== undefined || submitted.end !== undefined;
    if (wantsReanchor) {
      const file = canonicalAnnotationFile(source.file ?? next.file);
      if (file === '') return { ok: false, reason: 'missing-file' };
      let anchorText;
      if (file.startsWith('kp:')) {
        if (typeof source.kpText !== 'string' || source.kpText === '') return { ok: false, reason: 'missing-kp-text' };
        anchorText = source.kpText;
      } else {
        const full = await readMaterialFullText(file);
        if (!full.ok) return { ok: false, reason: full.reason };
        anchorText = full.text;
      }
      const resolved = resolveAnchorFromText(anchorText, {
        quote: submitted.quote ?? next.anchor.quote,
        start: submitted.start ?? next.anchor.start,
        end: submitted.end ?? next.anchor.end,
        prefix: submitted.prefix ?? next.anchor.prefix,
        suffix: submitted.suffix ?? next.anchor.suffix,
      });
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      next.file = file;
      next.anchor = resolved.anchor;
    }
    next.updatedAt = nowIso;
    return { ok: true, value: next };
  }

  /** `POST /mutate` + `doc === 'annotations'` 的专用处理（create / update / delete）。 */
  async function handleAnnotationsMutate({ res, action, payload, doc, expectedHash }) {
    const list = Array.isArray(doc.notes) ? [...doc.notes] : [];
    const nowIso = new Date().toISOString();

    if (action === 'create') {
      const built = await buildAnnotationFromInput(payload.item ?? {}, nowIso);
      if (!built.ok) return sendJson(res, 400, { ok: false, error: built.reason, key: 'annotations' });
      list.push(built.value);
      const written = await store.writeDocument('annotations', { ...doc, notes: list }, { expectedHash, backupKeep: deps.backupKeep });
      if (!written.ok) {
        return sendJson(res, written.reason === 'conflict' ? 409 : 422, { ok: false, error: written.reason, key: 'annotations' });
      }
      await autoWriteAnnotationsMaterial(list);
      return sendJson(res, 200, { ok: true, key: 'annotations', hash: written.hash, count: list.length, item: built.value });
    }

    if (!isValidId(payload.id)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
    const index = list.findIndex((note) => note !== null && typeof note === 'object' && note.id === payload.id);
    if (index === -1) return sendJson(res, 404, { ok: false, error: 'not-found', id: payload.id });

    if (action === 'delete') {
      list.splice(index, 1);
    } else {
      const merged = await mergeAnnotationInput(list[index], payload.item ?? {}, nowIso);
      if (!merged.ok) return sendJson(res, 400, { ok: false, error: merged.reason, key: 'annotations' });
      list[index] = merged.value;
    }
    const written = await store.writeDocument('annotations', { ...doc, notes: list }, { expectedHash, backupKeep: deps.backupKeep });
    if (!written.ok) {
      return sendJson(res, written.reason === 'conflict' ? 409 : 422, { ok: false, error: written.reason, key: 'annotations' });
    }
    await autoWriteAnnotationsMaterial(list);
    return sendJson(res, 200, { ok: true, key: 'annotations', hash: written.hash, count: list.length });
  }

  /** `GET /annotations`：列出批注（可选 `?file=` 过滤；只读）。 */
  async function handleAnnotationsList(res, url) {
    const read = await store.readDocument('annotations');
    if (!read.ok && read.reason !== 'missing') return sendJson(res, 409, { ok: false, error: read.reason, key: 'annotations' });
    const doc = read.ok ? read.doc : defaultDoc('annotations');
    const all = Array.isArray(doc.notes) ? doc.notes : [];
    const file = canonicalAnnotationFile(url.searchParams.get('file') ?? '');
    const notes = file === '' ? all : all.filter((note) => canonicalAnnotationFile(note?.file) === file);
    return sendJson(res, 200, { ok: true, key: 'annotations', file: file === '' ? null : file, count: notes.length, notes });
  }

  /** markKind 语义键 → 展示中文（导出 md / 前端徽标共用口径；无标记=普通）。 */
  const ANNOTATION_MARK_LABELS = { key: '重点', question: '疑问', review: '待复习', learned: '已学会' };

  /**
   * 把一批批注编成干净的 AI 材料 Markdown（E1，2026-11-18；纯函数、不写盘）。
   * 按 file 分组，每组每条一行：`- [标签] 批注内容 —— 原文：「quote 前 40 字」`。
   * 每条再附「标记于 <时间> · 状态」，分组标题用 nameMap 里的人读篇名（读不到退回原始 file 键）。
   * 只含讲义原文片段 + 批注内容，不含姓名/学号等身份信息（隐私红线 §⑦.4）。
   * @param {object[]} notes
   * @param {string} fileFilter  '' 表示全部
   * @param {Map<string,string>|null} nameMap  file 键 → 人读篇名（可选）
   */
  function buildAnnotationsMarkdown(notes, fileFilter, nameMap) {
    const labelOf = (file) => (nameMap instanceof Map && nameMap.has(file) ? nameMap.get(file) : file);
    const headTitle = fileFilter === '' ? '全部' : labelOf(fileFilter);
    const lines = [`# 高光与批注材料（导出：${headTitle}）`, ''];
    if (!Array.isArray(notes) || notes.length === 0) {
      lines.push('（暂无批注）');
      return `${lines.join('\n')}\n`;
    }
    // 按 file 分组，保持首次出现顺序
    const groups = [];
    const byFile = new Map();
    for (const note of notes) {
      const file = canonicalAnnotationFile(note?.file) || String(note?.file ?? '未分类');
      if (!byFile.has(file)) {
        byFile.set(file, []);
        groups.push(file);
      }
      byFile.get(file).push(note);
    }
    for (const file of groups) {
      lines.push(`## ${labelOf(file)}`);
      for (const note of byFile.get(file)) {
        const label = ANNOTATION_MARK_LABELS[note?.markKind];
        // 有主观类型用方括号 [重点]/[疑问]/[待复习]；无标记（普通）用裸 (普通)，与 Step 0 样例一致。
        const tag = label === undefined ? '(普通)' : `[${label}]`;
        const content = String(note?.content ?? '').trim();
        const quote = String(note?.anchor?.quote ?? '');
        const shortQuote = quote.length > 40 ? `${quote.slice(0, 40)}…` : quote;
        lines.push(`- ${tag} ${content} —— 原文：「${shortQuote}」`);
        // 时间维度（2026-11-18 用户要求）：标记时间为主，改过再附更新时间。
        const created = formatAnnotationTime(note?.createdAt);
        const updated = formatAnnotationTime(note?.updatedAt);
        const timeBits = [];
        if (created !== '') {
          timeBits.push(updated !== '' && updated !== created ? `标记于 ${created}（改于 ${updated}）` : `标记于 ${created}`);
        } else if (updated !== '') {
          timeBits.push(`标记于 ${updated}`);
        }
        const stateBit = label === undefined ? '普通' : label;
        if (timeBits.length > 0) {
          lines.push(`  > ${timeBits[0]} · ${stateBit}`);
        } else {
          lines.push(`  > ${stateBit}`);
        }
      }
      lines.push('');
    }
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  /** ISO 时间 → 本地「YYYY-MM-DD HH:MM」；解析不出就返回空串（不写半截时间）。 */
  function formatAnnotationTime(iso) {
    const raw = typeof iso === 'string' ? iso.trim() : '';
    if (raw === '') return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 构建 file 键 → 人读篇名映射（2026-11-18 用户要求「要说清在哪一篇」）。
   * - `kp:<nodeId>` → 「课程名 · 章 · 节点名」（拿不到课程名就省掉课程）
   * - 普通资料路径 → 去扩展名的相对路径
   * 只读 knowledgeNetwork + courses，任何异常都退回原始键（宁可不漂亮，也不报错）。
   */
  async function buildAnnotationNameMap(fileKeys) {
    const map = new Map();
    const keys = Array.isArray(fileKeys) ? fileKeys : [];
    if (keys.length === 0) return map;
    let nodeById = new Map();
    let courseById = new Map();
    try {
      const [net, courses] = await Promise.all([
        store.readDocument('knowledgeNetwork'),
        store.readDocument('courses'),
      ]);
      const nodes = net.ok && Array.isArray(net.doc?.nodes) ? net.doc.nodes : [];
      for (const node of nodes) {
        if (node !== null && typeof node === 'object' && typeof node.id === 'string') nodeById.set(node.id, node);
      }
      const list = courses.ok && Array.isArray(courses.doc?.courses) ? courses.doc.courses : [];
      for (const course of list) {
        if (course !== null && typeof course === 'object' && typeof course.id === 'string') courseById.set(course.id, course);
      }
    } catch {
      // 读不到就只用原始键，不阻断导出
    }
    for (const key of keys) {
      const k = String(key ?? '');
      if (k.startsWith('kp:')) {
        const node = nodeById.get(k.slice('kp:'.length));
        if (node) {
          const courseName = courseById.get(node.courseId)?.name ?? '';
          const parts = [courseName, node.chapter, node.name].map((s) => String(s ?? '').trim()).filter((s) => s !== '');
          if (parts.length > 0) {
            map.set(k, parts.join(' · '));
            continue;
          }
        }
      }
      // 普通资料：去扩展名、把 / 换成 · 让分组标题更可读（仍可溯源）
      const noExt = k.replace(/\.[a-zA-Z0-9]+$/, '');
      map.set(k, noExt === '' ? k : noExt);
    }
    return map;
  }

  /**
   * 自动把全部批注落成 AI 材料 md（2026-11-18 用户要求「不用手点就拿到最新」）。
   * 按「讲义」一分为多份：每份 file 键一个 md 文件，写进 `<workspaceRoot>/_工具/AI材料/`，覆盖式更新。
   * 另外写一份总目录 `_全部.md` 便于一眼看全。失败只记日志、绝不影响批注本身的写盘。
   * @param {object[]} notes 最新全量批注
   */
  async function autoWriteAnnotationsMaterial(notes) {
    try {
      const outDir = path.join(workspaceRoot, '_工具', 'AI材料');
      await fs.mkdir(outDir, { recursive: true });
      const list = Array.isArray(notes) ? notes : [];
      const fileKeys = Array.from(new Set(list.map((note) => canonicalAnnotationFile(note?.file) || String(note?.file ?? '未分类'))));
      const nameMap = await buildAnnotationNameMap(fileKeys);
      const safeName = (display, fallback) => {
        const base = String(display || fallback || '未分类').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
        return (base === '' ? '未分类' : base).slice(0, 80);
      };
      const written = [];
      for (const fileKey of fileKeys) {
        const group = list.filter((note) => (canonicalAnnotationFile(note?.file) || String(note?.file ?? '未分类')) === fileKey);
        const display = nameMap.get(fileKey) ?? fileKey;
        const md = buildAnnotationsMarkdown(group, fileKey, nameMap);
        const target = path.join(outDir, `${safeName(display, fileKey)}.md`);
        await fs.writeFile(target, md, 'utf8');
        written.push(target);
      }
      // 总目录：始终写一份（空批注也写「暂无批注」），删空后不会残留旧内容
      const allMd = buildAnnotationsMarkdown(list, '', nameMap);
      await fs.writeFile(path.join(outDir, '_全部.md'), allMd, 'utf8');
      return { ok: true, dir: outDir, files: written };
    } catch (error) {
      log.warn?.(`[annotations] 自动写 AI 材料失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** `GET /annotations/export`：个人层可导出（json / md；可选 `?file=` 过滤）。 */
  async function handleAnnotationsExport(res, url) {
    const read = await store.readDocument('annotations');
    if (!read.ok && read.reason !== 'missing') return sendJson(res, 409, { ok: false, error: read.reason, key: 'annotations' });
    const doc = read.ok ? read.doc : defaultDoc('annotations');
    const all = Array.isArray(doc.notes) ? doc.notes : [];
    const file = canonicalAnnotationFile(url.searchParams.get('file') ?? '');
    const notes = file === '' ? all : all.filter((note) => canonicalAnnotationFile(note?.file) === file);
    const format = String(url.searchParams.get('format') ?? 'json').toLowerCase();
    if (format === 'md') {
      const fileKeys = Array.from(new Set(notes.map((note) => canonicalAnnotationFile(note?.file) || String(note?.file ?? ''))));
      const nameMap = await buildAnnotationNameMap(fileKeys);
      return sendJson(res, 200, {
        ok: true,
        key: 'annotations',
        format: 'md',
        exportedAt: new Date().toISOString(),
        file: file === '' ? null : file,
        count: notes.length,
        markdown: buildAnnotationsMarkdown(notes, file, nameMap),
      });
    }
    if (format !== 'json') return sendJson(res, 400, { ok: false, error: 'unsupported-format', format });
    return sendJson(res, 200, {
      ok: true,
      key: 'annotations',
      format: 'json',
      exportedAt: new Date().toISOString(),
      file: file === '' ? null : file,
      count: notes.length,
      notes,
    });
  }

  /**
   * `GET /annotations/material`（2026-11-18 E1）：告诉前端「自动 AI 材料落在哪、有几份」，
   * 供面板显示「已自动保存到 …」并给个打开目录的提示。只读，不触发写盘。
   */
  async function handleAnnotationsMaterialInfo(res) {
    const dir = path.join(workspaceRoot, '_工具', 'AI材料');
    let files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
    } catch {
      files = [];
    }
    return sendJson(res, 200, { ok: true, key: 'annotations', dir, count: files.length, files });
  }

  // ---------------------------------------------------------------------------
  // 全量导出 / 恢复（2026-10-21 夜）
  //
  // 数据目录是纯文件：并发写有 conflict 保护，但误删、手改坏、两个宿主互相覆盖
  // 都挡不住。所以给一个「导出一个带校验和的 JSON、出事能盖回来」的兜底。
  // 写回一律走 store.writeDocument —— 它会先把旧版存进 学习台/备份/ 再原子替换。
  // ---------------------------------------------------------------------------

  /**
   * GET /backup/export：把十六份文档（按 DOC_KEYS，含批注/知识映射/日程/要闻）打成一个包（只读，不写盘）。
   *
   * 损坏/缺失的文档**不进包**（宁可少一份，也不把 null 塞进包里让恢复时写坏），
   * 由 `skipped` 明说跳了哪些，面板据此提示「这份数据当时就是坏的，先修再导」。
   */
  async function handleBackupExport(res) {
    const all = await store.readAll();
    const docs = {};
    const skipped = [];
    for (const key of DOC_KEYS) {
      const doc = all.docs[key];
      const problem = all.problems.find((item) => item.key === key);
      if (doc === null || problem !== undefined) {
        skipped.push({ key, reason: problem?.reason ?? 'corrupt' });
        continue;
      }
      docs[key] = doc;
    }
    const hashes = {};
    for (const key of Object.keys(docs)) hashes[key] = await store.hashOf(key);
    const bundle = buildBundle(docs, {
      hashes,
      app: { name: 'dsh-study-assistant', dataDir },
    });
    return sendJson(res, 200, {
      ok: true,
      count: Object.keys(docs).length,
      skipped,
      bundle,
    });
  }

  /**
   * POST /backup/restore：把包里的文档逐份写回（覆盖同名文档）。
   *
   * 顺序：先整包验校验和 → 再逐份 validateDoc（backup.js 已做）→ 再写。
   * 任何一份写失败不回滚前面已写的（不做事务：每份文档独立、且写前都有备份；
   * 回滚反而会把刚写的旧版再覆盖一次，风险更大），回包逐份说明结果，`ok` 表示至少写进一份。
   */
  async function handleBackupRestore(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    }
    // 允许两种投递：直接给包，或 `{bundle:{…}}`（面板走后者，留出扩展位）
    const checked = verifyBundle(payload.bundle ?? payload);
    if (!checked.ok) {
      return sendJson(res, 400, {
        ok: false,
        error: checked.error,
        key: checked.key ?? null,
        detail: checked.detail ?? null,
        expected: checked.expected ?? null,
        actual: checked.actual ?? null,
      });
    }
    const restored = [];
    const failed = [];
    for (const key of checked.keys) {
      const written = await store.writeDocument(key, checked.docs[key], {
        expectedHash: undefined,
        backupKeep: deps.backupKeep,
      });
      if (written.ok) restored.push({ key, hash: written.hash });
      else failed.push({ key, reason: written.reason });
    }
    return sendJson(res, restored.length > 0 ? 200 : 422, {
      ok: restored.length > 0,
      restored,
      failed,
      exportedAt: checked.exportedAt,
    });
  }

  async function handleReset(req, res) {
    // 重置是危险操作，只校验自定义头与来源，不强制 Content-Type
    if (!writePreflight(req, res, { skipContentType: true })) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    const checked = checkDocKey(payload?.doc);
    if (!checked.ok || checked.key === null) return sendJson(res, 400, { ok: false, error: 'unknown-doc' });
    if (payload?.confirm !== true) return sendJson(res, 400, { ok: false, error: 'need-confirm' });
    const result = await store.resetDocument(checked.key, { confirm: true, backupKeep: deps.backupKeep });
    return sendJson(res, result.ok ? 200 : 422, { ok: result.ok, key: checked.key, error: result.reason ?? null });
  }

  // ---------------------------------------------------------------------------
  // 作业流：一键开工（2026-10-20 起取代原来的「扫→分→确认→生成」四按钮）
  //
  // 面板不再自己生成答案：它只负责建一个新会话，把一段固定指令投进去，
  // 由 agent 用完整工具链（OCR、读文件、写盘、学习台回写）干活。
  // 好处是扫描件能走 OCR、成品直接落进 <学科>/答案/；代价是一次几分钟。
  // ---------------------------------------------------------------------------

  async function readCourses() {
    const read = await store.readDocument('courses');
    return read.ok && Array.isArray(read.doc.courses) ? read.doc.courses : [];
  }

  /**
   * 固定指令：把「干什么、按什么顺序、什么不许做」一次说清。
   *
   * 刻意写成祈使句而不是问答：agent 拿到它就像拿到一张工单，
   * 而纪律部分（不改 status、不建署名文件、原题只读）是硬约束，
   * 漏一句就会在真机上出事故，所以宁可啰嗦。
   *
   * 2026-10-27 按现行作业规范围着重写（`homework-answering` 三模式 +
   * `course-material-intake` 产线 A）：补了判模式、题目—答案映射表、
   * 誊写版口径（可直接抄的完成稿，不是答案填空表）、题号对齐 `作业.json`、
   * 数值验证脚本入库、多版本教材分别作答、嵌入位图读图、note 保留 learn 记号、
   * 收尾用 present 交付。旧口径「誊写版不带推导」已废弃。
   * 2026-10-28：产物落点改为 `<学科>/答案/第NN次/`（按次一个子目录、目录内文件名不带次号），
   * 取代 2026-10-27 的「扁平放 答案/、文件名带第NN次前缀」写法（那次改错了方向，用户当场纠正）。
   */
  function buildHomeworkSpawnPrompt(course, task, intake = null) {
    const due = typeof task.due === 'string' && task.due !== '' ? `（DDL ${task.due}）` : '';
    const materials = intake?.materials ?? null;
    const homework = materials?.homework ?? null;
    const subjectDir = typeof intake?.subjectDir === 'string' && intake.subjectDir !== '' ? intake.subjectDir : course.name;
    const mdRel = typeof homework?.mdRel === 'string' && homework.mdRel !== '' ? homework.mdRel : `${course.name}/作业/第NN次_原题与要求.md`;
    const attachRel = typeof homework?.attachRel === 'string' && homework.attachRel !== '' ? homework.attachRel : `${course.name}/作业/第NN次_附件/`;
    const shotRel = typeof homework?.shotRel === 'string' && homework.shotRel !== '' ? homework.shotRel : `${course.name}/作业/第NN次_截图/`;
    const noticeRel = typeof materials?.notice?.rel === 'string' && materials.notice.rel !== ''
      ? `${subjectDir}/${materials.notice.rel}`
      : `${course.name}/作业/第NN次_公告.md`;
    const summary = intake === null ? '- （后端没有返回取料结果，可能是没有连网络学堂）' : describeIntake(intake);
    return [
      `【作业一键开工】${course.name} 的「${task.title}」${due}。`,
      '',
      '请按工作区的 `course-material-intake` 技能（产线 A）与 `homework-answering` 技能做这次作业，按下面的顺序走，不要跳步：',
      '',
      '0. 先判模式：有题号、老师批改的提交式作业按 `homework-answering` 模式 A；实验预习报告/操作指引按模式 B；实验报告按模式 C。判不出就停下来问，不要猜。',
      `1. 原题与要求：**后端已经先从网络学堂取料并落成本地文件**，先读 \`${mdRel}\`（在 \`${course.name}/作业/\` 下）；附件在 \`${attachRel}\`；题目/教材页截图在 \`${shotRel}\`。`,
      '   后端这次的取料结果：',
      summary,
      '   - 若上面出现「未取到 / 未找到 / 原题来源不明」，或那份 md 根本不存在：**如实告诉用户缺什么并停下来等**，不要猜、不要拿别的课或校级公告凑，也不要自己跑去访问网络学堂。',
      '   - 形态②（老师只给了教材题号，如「第3版 5.12」「习题15.10」）：以 md 里「教材题号定位」表为准，逐条翻书核对参考答案的位置；表里置信度 low 的**页码不确定**，必须核对后再截图，不要照抄页码硬凑。',
      `   - 用户在对话里直接拖进来的文件（附件存放在 harness 的附件目录里，模型拿到的是只读路径），仍按老规矩先**复制**进 \`${course.name}/作业/\`，按「第NN次作业_原题.<原扩展名>」命名，再从那里读。**不要把附件留在或复制到工作区根目录**，也不要就地改附件本身。`,
      '   - 题目若按「第 X 版教材第 a 章习题 b」给出，而同一门课存了多版教材（如离散数学第 2 版与第 3 版，两版的章、题号完全不同），就要**按每版分别定位、分别作答**，答案里标明版本（如「第2版 15.10」「第3版 6.10」）；不要只答一版，也不要把两版合成一个答案。',
      '2. 取字：电子版 PDF 先用文字层；扫描件跑 `node tools/ocr-gemini.mjs "<pdf>"`（四档自动降级：Gemini 本体 → NotebookLM → 本机视觉模型 → 本机 RapidOCR，详见 `_工具/学习台-扫描件取字规范.md`）。四档都失败时用 `--render-only` 拿到页面 PNG，你自己看图转写，公式写 LaTeX。',
      '   - 文字层取到了、但**插图是一张嵌入位图**（`get_drawings()` 取不到边、PDF 里只有一张 JPEG）时，渲染那一页放大读图、逐边把结构还原出来，再用「点数/边数/度数和」交叉校验；这类重建的图要在产物里单列一节并标「需你确认」，请用户对照书上插图核一眼。',
      '3. 分题：切出题号与题干；题号切不准就说明原因，不要编号码。题号以 `学习台/作业.json` 里这次作业已切好的 `questions[].no` 为准（有就对齐，没有才用原题题号），**不得重新编号**；一题多问拆成 (a)(b)(c) 或 ①②，与设问一一对应。',
      '4. **先回一条确认**：报「第 N 次作业、M 题、取字可信度、题号列表（多版本小问的编号也要报清）」和「取料缺了什么（如有）」，等用户回「行」再往下；用户若说直接做，就继续。',
      `5. 出文件，都写进 \`${course.name}/答案/第NN次/\`（**按次一个子目录**，如「第05次」；目录内的文件名**不带次号前缀**）：`,
      '   - `引导与详解.md`：开头先给「**题目—答案映射表**」（列＝题号｜设问原文逐字｜所求量｜答案位置｜依据，一题一行，一题多问拆行）；每题再按「题面摘要 → 思路引导 → 完整推导 → 最终答案 → 易错点」写，推导要写清每一步依据，数值题写出代入过程。',
      '   - `誊写版.md`：**可直接抄的完成稿**——题号 + 题面一句话 + 完整推导/证明 + 最终答案，要有推导语句、代入过程、结论句（像学生自己写的作业）；但不写「思路引导」「易错点」两节，也不写「见详解」「如上表」这类跳步话。',
      '   - **题目截图（硬要求，每题都要有）**：两份 md 里每题都要嵌 `![题N：题面摘要](第NN次_题N截图.png)`，截图存 `答案/第NN次/` **同目录**（md2html.py 会把同目录相对路径图片带进可打印 HTML）。优先把 `' + shotRel + '` 里已经渲染好的对应页 PNG **复制**到答案目录并按题命名；一页含多题需要裁剪时，用本地 Python（PyMuPDF）单进程裁剪，**保证题干与关键公式完整、不裁掉上下文**。没有 PDF 来源的题（例如老师只在作业说明里写了几句话）如实注明「**此题无 PDF 来源，无截图**」，**绝不伪造截图**。',
      '   - 要交程序清单的题：源码另存 `题X_描述.cpp`，清单渲染成 `图_题X_程序清单N.png` 用 `![…](…)` 嵌入 md——`md2html.py` **不支持围栏代码块**，放进去会把整段代码塌成一行。',
      '6. 数值题与可枚举的题（顶点数、回路、配对、枚举计数之类）：**先跑数值验证再定稿**，脚本存成 `答案/第NN次/数值验证.py`（纯标准库、能直接跑、末行打印结论），并在详解里加「数值核验」小节说明核了什么。',
      '7. 出可打印 HTML：两份 md 各跑一次 `python _工具/md2html.py "<那份 md 的路径>" --quiet`，默认在同目录生成 `引导与详解(可打印).html` 与 `誊写版(可打印).html`（脚本自带 MathJax 3，遇到「可直接提交的答案」标题会另起一页打印）。转换失败就如实说原因，**不要手写 HTML 顶替，也不要改这个脚本**。',
      '8. 回写学习台：只把产物路径写进这条任务的 `note`（≤120 字），**保留 note 开头原有的 `[learn:xszyid:…]` 记号**（网络学堂同步靠它去重，删了会重复导入），**不要改 status**；**不要**创建含姓名学号的文件放进 `提交文件/`。',
      '9. 收尾：用 `present` 把交付文件作为卡片给出（至少两份 md）；再说清写了哪几个文件（两份 md + 两份可打印 HTML + 题目截图 + 数值验证脚本）、哪几题没把握（标「需你确认」并说清可疑点）、归档仍需要你自己放署名的提交件。',
      '',
      `教材：见 \`${subjectDir}/教材/\`（离散默认第 2 版，题号写明版本就取对应版本）；教材目录为空就如实说，不要拿课件冒充教材。`,
      `课程公告：见 \`${noticeRel}\`（后端探到 \`/b/wlxt/kcgg/**\` 课程公告才会落这份；没取到不影响作答，不必阻塞，也不要拿「学堂公告」冒充课程公告）。`,
      '',
      '纪律：`作业/` 下的原题只读；拿不准的题标注「需你确认」，不要编造；教材/任务书没有的补充必须标【补充】或【操作建议】，不擅改设问的所求量与单位；工作区根目录不落任何过程文件（中间产物放学科目录或 `_工具/` 里，收尾时清掉）。',
    ].join('\n');
  }

  /** 按 taskId 找出任务与课程；找不到时给好 HTTP 状态，两个作业接口共用。 */
  async function findHomeworkContext(taskId) {
    const tasksRead = await store.readDocument('tasks');
    const tasks = tasksRead.ok && Array.isArray(tasksRead.doc.tasks) ? tasksRead.doc.tasks : [];
    const task = tasks.find((item) => item?.id === taskId);
    if (task === undefined) return { ok: false, status: 404, error: 'unknown-task' };
    const courses = await readCourses();
    const course = courses.find((item) => item?.id === task.courseId) ?? null;
    if (course === null) return { ok: false, status: 409, error: 'course-not-found' };
    return { ok: true, task, course };
  }

  /** 取一次料（读网络学堂配置 + 落本地文件）。任何失败都体现在返回的 problems 里，不抛。 */
  async function collectMaterialsFor(course, task) {
    // 测试注入点：默认走真实取料；HTTP 用例用假实现，避免真的去打网络学堂。
    if (typeof deps.homeworkIntake === 'function') {
      return deps.homeworkIntake({ course, task, workspaceRoot, learnConfig: await readLearnConfig(dataDir) });
    }
    const learnConfig = await readLearnConfig(dataDir);
    return collectHomeworkMaterials({ course, task, workspaceRoot, learnConfig });
  }

  async function handleHomeworkSpawn(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (taskId === '') return sendJson(res, 400, { ok: false, error: 'missing-task' });
    if (!isValidId(taskId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
    if (typeof deps.handoff !== 'function') return sendJson(res, 503, { ok: false, error: 'sessions-unavailable' });

    const target = await findHomeworkContext(taskId);
    if (target.ok !== true) return sendJson(res, target.status, { ok: false, error: target.error });
    const { task, course } = target;

    // 先代取料：成功的材料已经落盘，提示词只负责告诉 agent「去哪读、缺什么要停下」。
    // 取料失败不阻断点火 —— agent 需要拿到「缺什么」的说明去问用户，而不是按钮直接报错。
    const intake = await collectMaterialsFor(course, task);

    const spawned = await deps.handoff({
      prompt: buildHomeworkSpawnPrompt(course, task, intake),
      cwd: workspaceRoot,
      title: `${course.name} ${task.title} · 一键开工`,
    });
    if (!spawned.ok) {
      return sendJson(res, spawned.error === 'sessions-unavailable' ? 503 : 502, {
        ok: false,
        error: spawned.error,
        detail: spawned.detail ?? null,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      sessionId: spawned.sessionId,
      taskId,
      course: course.name,
      intake: {
        ok: intake.ok,
        label: intake.label,
        problems: intake.problems,
        writtenFiles: intake.writtenFiles.length,
        materials: intake.materials,
      },
    });
  }

  /**
   * `POST /homework/collect-materials`：只取料、不建会话（面板可用来预览；真机验收也走它）。
   * 会写文件，所以必须过 `writePreflight`（Content-Type + X-Study-Request + 同源校验）。
   */
  async function handleHomeworkCollectMaterials(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (taskId === '') return sendJson(res, 400, { ok: false, error: 'missing-task' });
    if (!isValidId(taskId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });

    const target = await findHomeworkContext(taskId);
    if (target.ok !== true) return sendJson(res, target.status, { ok: false, error: target.error });
    const intake = await collectMaterialsFor(target.course, target.task);
    return sendJson(res, 200, {
      ok: intake.ok,
      taskId,
      course: target.course.name,
      intake,
    });
  }

  async function handleOverview(req, res, url) {
    const nowParam = url.searchParams.get('now');
    const all = await store.readAll();
    const now = nowParam === null ? new Date() : new Date(nowParam);
    const overview = buildOverview(all.docs, Number.isNaN(now.getTime()) ? new Date() : now);
    const active = activeTasks(all.docs.tasks);
    return sendJson(res, 200, {
      ok: true,
      overview,
      counts: {
        courses: Array.isArray(all.docs.courses?.courses) ? all.docs.courses.courses.length : 0,
        activeTasks: active.length,
        terms: Array.isArray(all.docs.term?.terms) ? all.docs.term.terms.length : 0,
      },
      term: currentTerm(all.docs.term),
      problems: all.problems,
    });
  }

  /**
   * GET /news —— 「今日要闻」（第 15 份文档）的只读视图。
   *
   * 面板「今日」页要闻卡调它，`?days=` 控制展示窗口（默认 7 天，也就是「今天 + 最近若干条」）。
   * 只读、不写盘：要闻由 `tools/fetch-news.mjs` 抓（Windows 计划任务每天 7:00），
   * 面板对这个文档**没有**写入口（`/mutate` 对它回 `use-dedicated-route`）。
   *
   * 三种状态都要能说清：
   *   - 文件不存在（首次部署、脚本还没跑过）→ 200 + 空列表 + `missing: true`，面板写空态；
   *   - 文件存在 → 200 + `board`（含 `fetchedAt`/`fetchedClock`，面板据此显示「抓取时间」）；
   *   - 文件坏了 → 200 但 `ok:false` + `news-unreadable`，面板显示错误而不是假装没有新闻。
   */
  async function handleNews(req, res, url) {
    const daysParam = url.searchParams.get('days');
    const parsedDays = daysParam === null ? 7 : Number(daysParam);
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(60, Math.floor(parsedDays)) : 7;
    const nowParam = url.searchParams.get('now');
    const parsedNow = nowParam === null ? new Date() : new Date(nowParam);
    const now = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;

    const read = await store.readDocument('news');
    if (read.ok !== true && read.reason !== 'missing') {
      return sendJson(res, 200, {
        ok: false,
        error: 'news-unreadable',
        reason: read.reason,
        days,
        board: null,
        items: [],
      });
    }
    const doc = read.ok === true ? read.doc : defaultDoc('news');
    const board = buildNewsBoard(doc, { days, now });
    return sendJson(res, 200, {
      ok: true,
      days,
      missing: read.reason === 'missing',
      board,
      // 顶层再摊一遍，前端不必为了拿一条要闻的日期而下钻两层的路径
      items: board.items,
    });
  }

  /**
   * 把归档标记并进任务备注。
   *
   * ⚠️ 备注在 `normalizeName` 里被截到 120 字，而 learn 导入的任务备注开头是
   * `[learn:xszyid:…]`（网络学堂同步靠它去重）。所以顺序是：
   * 能塞得下就把标记放末尾（保住 learn id），塞不下才把标记提到开头（保住归档证据）。
   */
  function withArchiveNote(oldNote, file) {
    const marker = `已提交：${file}`;
    const base = typeof oldNote === 'string' ? oldNote.trim() : '';
    if (base === '') return marker.slice(0, 120);
    const appended = `${base}｜${marker}`;
    return appended.length <= 120 ? appended : `${marker}｜${base}`.slice(0, 120);
  }

  /** 扫描结果：归档的 GET 判定与 POST 写入必须用同一份结果，否则两边会各说各话。 */
  async function deliverableScan() {
    const all = await store.readAll();
    const tasks = Array.isArray(all.docs.tasks?.tasks) ? all.docs.tasks.tasks : [];
    const courses = Array.isArray(all.docs.courses?.courses) ? all.docs.courses.courses : [];
    const report = await collectDeliverables({
      workspaceRoot,
      studentName,
      studentId,
      courses,
      tasks,
    });
    return { report, tasks };
  }

  /**
   * GET /deliverables —— 扫描 `<学科>/提交文件/` 并给出归档判定（**只读**）。
   *
   * 归档判据：文件名必须**同时**含学生姓名与学号（=用户本人放进去的提交件），
   * 且能**唯一**匹配到一条未完成任务。匹配不唯一只报 `ambiguous`，不猜。
   */
  async function handleDeliverables(res) {
    const { report } = await deliverableScan();
    return sendJson(res, 200, {
      ok: true,
      enabled: report.enabled,
      reason: report.reason ?? null,
      root: report.root,
      studentName,
      studentId,
      findings: report.findings,
    });
  }

  /**
   * POST /deliverables/archive —— 把提交件对应的任务置为已完成（归档）。
   *
   * 请求体：`{ items: [{ taskId, file }] }`；`items` 缺省时归档本次扫描里全部
   * `ready` 的命中。每一项都必须能在本次扫描结果里对上（`ready` 的命中，或
   * `ambiguous` 里列出的候选）—— 客户端**不能**凭一个 taskId 就要求归档，
   * 否则「文件放进去才归档」这条约定等于没落地。
   */
  async function handleDeliverablesArchive(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    }

    const { report } = await deliverableScan();
    if (!report.enabled) {
      return sendJson(res, 200, {
        ok: true, enabled: false, reason: report.reason ?? 'disabled', archived: [], skipped: [],
      });
    }

    // 白名单：ready 的唯一命中 + ambiguous 里列出的候选（用户手动确认用）
    const allowed = new Map();
    for (const finding of report.findings) {
      if (finding.status === 'ready' && finding.taskId) {
        allowed.set(`${finding.taskId}\u0000${finding.file}`, finding);
      }
      if (finding.status === 'ambiguous') {
        for (const candidate of finding.candidates) {
          allowed.set(`${candidate.taskId}\u0000${finding.file}`, finding);
        }
      }
    }

    const requested = Array.isArray(payload.items) && payload.items.length > 0
      ? payload.items
      : report.findings
        .filter((finding) => finding.status === 'ready' && finding.taskId)
        .map((finding) => ({ taskId: finding.taskId, file: finding.file }));
    if (requested.length > 200) return sendJson(res, 400, { ok: false, error: 'too-many-items' });

    const read = await store.readDocument('tasks');
    if (!read.ok && read.reason !== 'missing') {
      // 与 /mutate 同一条纪律：损坏文件上不做增量修改
      return sendJson(res, 409, { ok: false, error: read.reason, key: 'tasks' });
    }
    const doc = read.ok ? read.doc : defaultDoc('tasks');
    const list = Array.isArray(doc.tasks) ? [...doc.tasks] : [];

    const archived = [];
    const skipped = [];
    for (const item of requested) {
      const taskId = typeof item?.taskId === 'string' ? item.taskId : '';
      const file = typeof item?.file === 'string' ? item.file : '';
      if (!allowed.has(`${taskId}\u0000${file}`)) {
        skipped.push({ taskId, file, reason: 'not-a-candidate' });
        continue;
      }
      const index = findIndexById(list, taskId);
      if (index === -1) {
        skipped.push({ taskId, file, reason: 'task-not-found' });
        continue;
      }
      const base = list[index];
      if (base.status === 'done') {
        skipped.push({ taskId, file, reason: 'already-done' });
        continue;
      }
      // status → done 时 normalizeTask 自己会写 progress=100 与 doneAt
      const normalized = normalizeTask({
        ...base,
        status: 'done',
        note: withArchiveNote(base.note, file),
      }, base);
      if (!normalized.ok) {
        skipped.push({ taskId, file, reason: normalized.reason });
        continue;
      }
      list[index] = normalized.item;
      archived.push({ taskId, title: normalized.item.title, file, courseId: normalized.item.courseId });
    }

    if (archived.length === 0) {
      return sendJson(res, 200, {
        ok: true, enabled: true, archived, skipped, hash: read.ok ? read.hash : null,
      });
    }

    const written = await store.writeDocument('tasks', { ...doc, tasks: list }, {
      expectedHash: read.ok ? read.hash : null,
      backupKeep: deps.backupKeep,
    });
    if (!written.ok) {
      const status = written.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: written.reason, key: 'tasks' });
    }
    return sendJson(res, 200, { ok: true, enabled: true, archived, skipped, hash: written.hash });
  }

  /**
   * 网络学堂连接：验活 Cookie，并把课堂号与课程名缓存下来。
   *
   * 只要 Cookie 有效就存下来（哪怕一门课都没匹配上）—— 「连上了但还没对应课程」
   * 是用户需要看到并修的状态，不该被当成失败回滚。
   */
  async function handleLearnConnect(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    }

    const cookie = typeof payload.cookie === 'string' ? payload.cookie.trim() : '';
    if (cookie === '') return sendJson(res, 400, { ok: false, error: 'need-cookie' });
    if (!cookieUsable(cookie)) return sendJson(res, 400, { ok: false, error: 'cookie-too-short' });

    let index;
    try {
      index = await fetchLearnIndex(cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'learn-timeout' : 'learn-unreachable';
      return sendJson(res, 502, { ok: false, error: reason, detail: String(error?.message ?? error) });
    }

    if (!index.alive) {
      return sendJson(res, 401, {
        ok: false,
        error: index.status === 200 ? 'cookie-invalid' : `learn-http-${index.status}`,
        // 把 Location 带回去：被重定向到登录页是判断「cookie 过期」最直接的证据
        location: index.location ?? null,
      });
    }

    // 课程列表**不能**从首页 HTML 里扫（那是 JS 模板，真机上恒为 0 门），
    // 必须走 queryxnxq + loadCourseBySemesterId 两段式。
    const semesterWanted = typeof payload.semesterId === 'string' && payload.semesterId !== '' ? payload.semesterId : undefined;

    const manual = payload.manual !== null && typeof payload.manual === 'object' && !Array.isArray(payload.manual)
      ? payload.manual
      : {};

    const all = await store.readAll();
    const courses = Array.isArray(all.docs.courses?.courses) ? all.docs.courses.courses : [];

    const mapped = await learnCourseMapping({
      cookie,
      semesterId: semesterWanted,
      manual: { map: manual, courses },
    });
    if (!mapped.ok) {
      return sendJson(res, 502, { ok: false, error: mapped.error, detail: mapped.detail });
    }
    const learned = mapped.learned;

    const saved = await writeLearnConfig(dataDir, {
      cookie,
      manual,
      courses: learned,
      semesterId: mapped.semesterId,
      semesters: mapped.semesters,
    });
    return sendJson(res, 200, {
      ok: true,
      authUsed: mapped.authUsed !== 'cookie' ? mapped.authUsed : index.authUsed,
      semesterId: mapped.semesterId,
      semesters: mapped.semesters,
      counts: { courses: learned.length, matched: learned.filter((c) => c.matched).length },
      courses: learned,
      unmatched: learned.filter((c) => !c.matched).map((c) => ({ wlkcid: c.wlkcid, name: c.name, how: c.how, candidates: c.candidates })),
      updatedAt: saved.updatedAt,
    });
  }

  /** 读配置 + 解析远端作业，返回候选清单（**不写任何数据**）。 */
  async function gatherLearnCandidates(payload) {
    const config = await readLearnConfig(dataDir);
    if (!config.ok) return { ok: false, error: config.reason };

    const cookie = typeof payload?.cookie === 'string' && payload.cookie.trim() !== ''
      ? payload.cookie.trim()
      : config.cookie;
    if (cookie === '') return { ok: false, error: 'not-connected' };

    let index;
    try {
      index = await fetchLearnIndex(cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'learn-timeout' : 'learn-unreachable';
      return { ok: false, error: reason, detail: String(error?.message ?? error) };
    }
    if (!index.alive) {
      return { ok: false, error: index.status === 200 ? 'cookie-invalid' : `learn-http-${index.status}`, location: index.location ?? null };
    }

    let targets = [];
    let semesterId = null;
    let semesters = [];
    let listedAuthUsed = 'cookie';
    let learnedCourses = [];
    {
      // 课程来源必须是 queryxnxq + loadCourseBySemesterId：
      // 首页 HTML 里的课程列表是 JS 模板，正则扫不出真课堂号（真机实测 0 门）。
      const semesterWanted = typeof payload?.semesterId === 'string' && payload.semesterId !== ''
        ? payload.semesterId
        : config.semesterId ?? undefined;
      const allCourses = (await store.readAll()).docs.courses?.courses;
      const mapped = await learnCourseMapping({
        cookie,
        semesterId: semesterWanted,
        manual: { map: config.manual ?? {}, courses: Array.isArray(allCourses) ? allCourses : [] },
      });
      if (!mapped.ok) {
        return { ok: false, error: mapped.error, detail: mapped.detail };
      }
      learnedCourses = mapped.learned;
      targets = mapped.learned.map((course) => ({ wlkcid: course.wlkcid, name: course.name }));
      semesterId = mapped.semesterId;
      semesters = mapped.semesters;
      listedAuthUsed = mapped.authUsed;
    }

    // 允许只同步指定课堂（便于排障，也避免一次拉太多）
    const only = Array.isArray(payload?.wlkcid) ? payload.wlkcid.filter((v) => typeof v === 'string') : [];
    if (only.length > 0) targets = targets.filter((t) => only.includes(t.wlkcid));

    const all = await store.readAll();
    const courses = Array.isArray(all.docs.courses?.courses) ? all.docs.courses.courses : [];
    const manual = { ...config.manual, ...(payload?.manual !== null && typeof payload?.manual === 'object' ? payload.manual : {}) };

    const fetched = await fetchHomeworkForCourses(targets, cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    const now = new Date();
    const built = buildCandidates(fetched, courses, { manual, now });
    const tasksDoc = all.docs.tasks ?? defaultDoc('tasks');
    const existing = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
    const { created, skipped } = diffCandidates(existing, built.candidates);

    return {
      ok: true,
      cookie,
      // 只要**任何一步**动用了 XSRF 头，就如实报告，方便排障时判断认证路径
      authUsed: fetched.some((f) => f.authUsed === 'cookie+xsrf') ? 'cookie+xsrf' : listedAuthUsed,
      semesterId,
      semesters,
      candidates: built.candidates,
      ambiguous: built.ambiguous,
      created,
      skipped,
      diagnostics: fetched.map((f) => ({
        wlkcid: f.wlkcid,
        name: f.name,
        list: f.label,
        rows: f.rows.length,
        total: f.total ?? f.rows.length,
        error: f.error ?? null,
        message: f.message ?? null,
        topKeys: f.topKeys ?? [],
      })),
      courses: courses.map((c) => ({ id: c.id, name: c.name })),
      // 这次算出来的课程映射。`/learn/sync` 拿它落盘 —— 同步必须顺手把映射写好，
      // 否则「点同步」永远修不好 `course-unmapped`（2026-11-04 就是这么坏的）。
      learned: learnedCourses,
    };
  }

  /** 预览：把远端作业拉下来摊平给用户看，不落盘。 */
  async function handleLearnFetch(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const gathered = await gatherLearnCandidates(body.payload);
    if (!gathered.ok) {
      const status = gathered.error === 'not-connected' ? 400 : gathered.error === 'cookie-invalid' ? 401 : 502;
      return sendJson(res, status, { ok: false, error: gathered.error, location: gathered.location ?? null });
    }
    return sendJson(res, 200, {
      ok: true,
      authUsed: gathered.authUsed,
      semesterId: gathered.semesterId,
      semesters: gathered.semesters,
      counts: { candidates: gathered.candidates.length, fresh: gathered.created.length, known: gathered.skipped.length, ambiguous: gathered.ambiguous.length },
      candidates: gathered.candidates,
      ambiguous: gathered.ambiguous,
      diagnostics: gathered.diagnostics,
      courses: gathered.courses,
    });
  }

  /**
   * 同步：把 `created` 里的候选**一次性**写进 `任务.json`。
   *
   * 为什么不让前端逐条走 `/mutate`：
   *   - 一次同步可能有几十条，逐条会把整个写入队列拉长，中途失败还会留下半截结果；
   *   - 逐条会反复 `readAll`，而这里是**一次读、一次写**，语义上也更像一个事务。
   *
   * 写入前逐条过一遍 `normalizeTask`，保证进来的东西和用户手填的走同一套校验 ——
   * 否则 `任务.json` 里会出现绕过校验的条目。
   */
  async function handleLearnSync(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;

    const gathered = await gatherLearnCandidates(body.payload);
    if (!gathered.ok) {
      const status = gathered.error === 'not-connected' ? 400 : gathered.error === 'cookie-invalid' ? 401 : 502;
      return sendJson(res, status, { ok: false, error: gathered.error, location: gathered.location ?? null });
    }

    /**
     * 先落课程映射，再去动任务。
     *
     * 2026-11-04 的故障：课程列表和作业列表在同一段代码里算，但**只有 `/learn/connect`
     * 和 `/learn/semester` 写映射**，`/learn/sync` 不写。于是「自动续期拿到新票 →
     * 点同步」这条最常见的路径下，`网络学堂.json` 的 `courses` 一直是空的，
     * 所有作业详情都回 `course-unmapped`，界面上表现为「DDL 打不开附件和详情」，
     * 而界面上的提示「先跑一次同步」恰恰是**没用的那一步**。
     *
     * 放在最前面是故意的：同步本身要跑十几分钟，中途超时也不能让映射白拉一次。
     * 写失败不打断同步（映射是缓存性质，失败最多回到旧行为），但要如实报告。
     */
    let mapping = { saved: false, error: null, courses: 0, matched: 0 };
    if (Array.isArray(gathered.learned) && gathered.learned.length > 0) {
      try {
        const config = await readLearnConfig(dataDir);
        await writeLearnConfig(dataDir, {
          cookie: gathered.cookie,
          manual: config.ok ? config.manual ?? {} : {},
          courses: gathered.learned,
          semesterId: gathered.semesterId,
          semesters: gathered.semesters,
        });
        mapping = {
          saved: true,
          error: null,
          courses: gathered.learned.length,
          matched: gathered.learned.filter((course) => course.matched === true).length,
        };
      } catch (error) {
        mapping = {
          saved: false,
          error: String(error?.message ?? error),
          courses: gathered.learned.length,
          matched: gathered.learned.filter((course) => course.matched === true).length,
        };
        log.warn?.(`[study-assistant] 同步时写课程映射失败（详情可能回 course-unmapped）：${mapping.error}`);
      }
    }

    const read = await store.readDocument('tasks');
    if (!read.ok && read.reason !== 'missing') {
      return sendJson(res, 409, { ok: false, error: read.reason, key: 'tasks' });
    }
    const doc = read.ok ? read.doc : defaultDoc('tasks');
    const existing = Array.isArray(doc.tasks) ? [...doc.tasks] : [];
    const now = new Date();
    const priority = ['low', 'normal', 'high'].includes(body.payload?.priority) ? body.payload.priority : 'normal';

    const accepted = [];
    const rejected = [];
    for (const item of gathered.created) {
      const task = toTaskItem(item, makeId, { now, priority });
      const normalized = normalizeTask(task, null);
      if (!normalized.ok) {
        rejected.push({ title: task.title, reason: normalized.reason });
        continue;
      }
      accepted.push(normalized.item);
    }

    // 已经导入过的条目不会再次进入 `accepted`（`diffCandidates` 按远端记号跳过），
    // 所以光改导入规则修不了**历史数据** —— 早先被写成待办的已交作业会一直留在待办里。
    // 这里补一步就地修正：平台说交了、本地还挂着 `todo` 的，标成完成。
    //
    // 只做单向升级（`todo` → `done`），反过来不动：平台没交**不代表**用户没做
    // （线下交、课堂交、老师还没登记都可能），而平台说交了没有歧义。
    const submitted = new Set();
    for (const item of gathered.skipped) {
      if (item !== null && typeof item === 'object' && item.open === false && item.key !== null) submitted.add(item.key);
    }
    let completed = 0;
    const merged = existing.map((task) => {
      const mark = learnMarkOf(task);
      if (mark === null || !submitted.has(mark) || task?.status !== 'todo') return task;
      const normalized = normalizeTask({ ...task, status: 'done' }, task);
      if (!normalized.ok) return task;
      completed += 1;
      return normalized.item;
    });

    if (accepted.length > 0 || completed > 0) {
      const next = { ...doc, tasks: [...merged, ...accepted] };
      const written = await store.writeDocument('tasks', next, { backupKeep: deps.backupKeep });
      if (!written.ok) return sendJson(res, 409, { ok: false, error: written.reason, key: 'tasks' });
      return sendJson(res, 200, {
        ok: true,
        imported: accepted.length,
        completed,
        skipped: gathered.skipped.length,
        rejected,
        ambiguous: gathered.ambiguous,
        hash: written.hash,
        count: next.tasks.length,
        diagnostics: gathered.diagnostics,
        mapping,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      imported: 0,
      completed: 0,
      skipped: gathered.skipped.length,
      rejected,
      ambiguous: gathered.ambiguous,
      count: existing.length,
      diagnostics: gathered.diagnostics,
      mapping,
    });
  }

  /**
   * 「检查更新」：平台把截止时间改过、本地还留着旧值 —— 这是同步唯一的盲区。
   *
   * 同步只做两件事：新候选插入、`todo → done` 单向升级。已导入的条目按远端记号
   * 直接归进 `skipped`，`due` **永远**不会被平台纠正。2026-10-17 的「补课作业」
   * 就是这么错的：本地 10-18，平台 10-26（老师后来放宽了），界面一直显示旧日期。
   *
   * 只比**截止时间**：老师改标题是常态（没必要回灌），状态只允许单向升级
   * （平台没交不代表用户没做）。平台没给日期时**不动**本地 —— 那通常只是
   * 「老师没设截止」，不该把本地已录的日期清掉。
   */
  function dueMsOf(value) {
    const parsed = parseDue(value);
    // 截到分钟：`2026-10-26` 解析成 23:59:59、`2026-10-26 23:59` 是 23:59:00，
    // 这 59 秒的差是解析口径造成的，不是老师改了截止时间。
    return parsed === null ? null : Math.floor(parsed.getTime() / 60000);
  }

  function collectDueDiffs(existing, skipped) {
    const byMark = new Map();
    for (const task of Array.isArray(existing) ? existing : []) {
      const mark = learnMarkOf(task);
      if (mark !== null && typeof task?.id === 'string') byMark.set(mark, task);
    }
    const diffs = [];
    for (const item of Array.isArray(skipped) ? skipped : []) {
      if (item === null || typeof item !== 'object' || item.key === null) continue;
      const task = byMark.get(item.key);
      if (task === undefined) continue;
      const next = typeof item.due === 'string' && item.due.trim() !== '' ? item.due.trim() : null;
      if (next === null) continue;
      const prev = typeof task.due === 'string' && task.due.trim() !== '' ? task.due.trim() : null;
      if (prev === next) continue;
      // 只是写法不同（`2026-10-26` 与 `2026-10-26 23:59` 是同一个时刻）时不算差异
      const prevMs = dueMsOf(prev);
      const nextMs = dueMsOf(next);
      if (prevMs !== null && nextMs !== null && prevMs === nextMs) continue;
      diffs.push({
        taskId: task.id,
        title: typeof task.title === 'string' ? task.title : '',
        mark: item.key,
        from: prev,
        to: next,
      });
    }
    return diffs;
  }

  /** 拉一次平台列表 + 读本地任务，算出「截止时间被平台改过」的条目。 */
  async function gatherDueDiffs(payload) {
    const gathered = await gatherLearnCandidates(payload === undefined ? {} : payload);
    if (!gathered.ok) return gathered;
    const read = await store.readDocument('tasks');
    if (!read.ok && read.reason !== 'missing') return { ok: false, error: read.reason, key: 'tasks' };
    const doc = read.ok ? read.doc : defaultDoc('tasks');
    const existing = Array.isArray(doc.tasks) ? doc.tasks : [];
    return { ok: true, doc, existing, diffs: collectDueDiffs(existing, gathered.skipped), gathered };
  }

  /** `/learn/*` 失败码 → HTTP 状态（与 `/learn/sync` 同一口径）。 */
  function learnErrorStatus(code) {
    if (code === 'not-connected') return 400;
    if (code === 'cookie-invalid') return 401;
    return 502;
  }

  /** 只读检查：一个字节都不写，只把「本地 vs 平台」的截止时间差异列出来。 */
  async function handleLearnUpdates(res) {
    const checked = await gatherDueDiffs({});
    if (!checked.ok) {
      return sendJson(res, checked.key === 'tasks' ? 409 : learnErrorStatus(checked.error), {
        ok: false, error: checked.error, location: checked.location ?? null, key: checked.key ?? null,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      diffs: checked.diffs,
      compared: checked.gathered.skipped.length,
      count: checked.existing.length,
      diagnostics: checked.gathered.diagnostics,
    });
  }

  /**
   * 按平台更正截止时间（界面拿到差异、用户点确认之后才走这里）。
   *
   * **当场再拉一次平台列表**：落盘要以这一刻的数据为准，不能拿界面上那份可能已经
   * 过时的清单去写。一次读一次写，`due` 之外一个字段都不碰（状态、note 全部原样）。
   */
  async function handleLearnApplyUpdates(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;

    const checked = await gatherDueDiffs(body.payload ?? {});
    if (!checked.ok) {
      return sendJson(res, checked.key === 'tasks' ? 409 : learnErrorStatus(checked.error), {
        ok: false, error: checked.error, location: checked.location ?? null, key: checked.key ?? null,
      });
    }

    const wanted = Array.isArray(body.payload?.taskIds)
      ? new Set(body.payload.taskIds.filter((id) => typeof id === 'string'))
      : null;
    const byTaskId = new Map();
    for (const diff of checked.diffs) {
      if (wanted === null || wanted.has(diff.taskId)) byTaskId.set(diff.taskId, diff);
    }
    if (byTaskId.size === 0) {
      return sendJson(res, 200, {
        ok: true, updated: 0, rejected: [], applied: [], diffs: checked.diffs, count: checked.existing.length,
      });
    }

    let updated = 0;
    const rejected = [];
    const tasks = checked.existing.map((task) => {
      const diff = byTaskId.get(task?.id);
      if (diff === undefined) return task;
      const normalized = normalizeTask({ ...task, due: diff.to }, task);
      if (!normalized.ok) {
        rejected.push({ taskId: diff.taskId, reason: normalized.reason });
        return task;
      }
      updated += 1;
      return normalized.item;
    });

    if (updated === 0) {
      return sendJson(res, 409, { ok: false, error: 'nothing-updatable', rejected, count: checked.existing.length });
    }

    const written = await store.writeDocument('tasks', { ...checked.doc, tasks }, { backupKeep: deps.backupKeep });
    if (!written.ok) return sendJson(res, 409, { ok: false, error: written.reason, key: 'tasks' });
    return sendJson(res, 200, {
      ok: true,
      updated,
      rejected,
      applied: [...byTaskId.values()],
      hash: written.hash,
      count: tasks.length,
    });
  }

  /**
   * 断开连接：删掉凭据文件。
   *
   * 刻意**单独一个路由**，而不是「用空 Cookie 覆盖配置」：
   * 后者会被 `need-cookie` 校验挡下来（空 Cookie 是非法输入，不是「断开」的语义），
   * 于是界面显示「已断开」而磁盘上的旧 Cookie 还在 —— 状态与实际不符最难排查。
   * 这里删除文件，且**不动** `任务.json`：已导入的任务属于用户数据，
   * 断开的只是「以后不再自动同步」。
   */
  async function handleLearnDisconnect(req, res) {
    if (!writePreflight(req, res)) return;
    try {
      await fs.rm(learnConfigPath(dataDir), { force: true });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: 'learn-disconnect-failed', detail: String(error?.message ?? error) });
    }
    return sendJson(res, 200, { ok: true, connected: false });
  }

  /**
   * 换一个学期：用**已存下的** Cookie 重新拉课程列表并重做匹配。
   *
   * 为什么单独一条路由、而不是让界面再走一次 `/learn/connect`：
   * 界面**拿不到 Cookie**（`/learn/status` 刻意不回传），所以「换学期」这个动作
   * 只能由服务端用自己存的凭证完成。让界面重连就得让它留着 Cookie，那等于把
   * 凭据又摊在浏览器内存里 —— 得不偿失。
   */
  async function handleLearnSemester(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};

    const semesterId = typeof payload.semesterId === 'string' ? payload.semesterId.trim() : '';
    const config = await readLearnConfig(dataDir);
    if (!config.ok || config.cookie === '') return sendJson(res, 400, { ok: false, error: 'not-connected' });
    // 先校验参数再联网：给不出学期就没必要去打扰学堂
    if (semesterId === '') return sendJson(res, 400, { ok: false, error: 'need-semester' });

    const localCourses = (await store.readAll()).docs.courses?.courses;
    const listed = await learnCourseMapping({
      cookie: config.cookie,
      semesterId,
      manual: {
        map: config.manual ?? {},
        courses: Array.isArray(localCourses) ? localCourses : [],
      },
    });
    if (!listed.ok) {
      return sendJson(res, 502, { ok: false, error: listed.error, detail: listed.detail });
    }
    const learned = listed.learned;

    const saved = await writeLearnConfig(dataDir, {
      cookie: config.cookie,
      manual: config.manual ?? {},
      courses: learned,
      semesterId: listed.semesterId,
      semesters: listed.semesters.length > 0 ? listed.semesters : config.semesters,
    });
    return sendJson(res, 200, {
      ok: true,
      authUsed: listed.authUsed,
      semesterId: listed.semesterId,
      semesters: saved.semesters,
      counts: { courses: learned.length, matched: learned.filter((c) => c.matched).length },
      courses: learned,
      unmatched: learned.filter((c) => !c.matched).map((c) => ({ wlkcid: c.wlkcid, name: c.name, how: c.how, candidates: c.candidates })),
      updatedAt: saved.updatedAt,
    });
  }

  /** 当前连接状态（给界面用），**绝不返回 Cookie 本身**。 */
  async function handleLearnStatus(res) {
    const config = await readLearnConfig(dataDir);
    if (!config.ok) return sendJson(res, 200, { ok: true, connected: false, reason: config.reason });
    const courses = config.courses ?? [];
    return sendJson(res, 200, {
      ok: true,
      connected: config.cookie !== '',
      updatedAt: config.updatedAt,
      semesterId: config.semesterId ?? null,
      semesters: config.semesters ?? [],
      manualCount: Object.keys(config.manual ?? {}).length,
      courses,
      counts: { courses: courses.length, matched: courses.filter((c) => c.matched === true).length },
      // 会话状态（还有效吗、要不要人工登一次）跟着一起回，省得界面再发一次请求
      session: learnSessionSnapshot(),
      // 存了账号密码没：界面据此决定「一键重连」标签与提示
      credentialPresent: (await readLearnCredential(dataDir)).present === true,
    });
  }

  /**
   * 会话状态（只读）。
   *
   * `alive` 的三种取值都是有意义的：`true` 有效、`false` 已失效（`reason` 说明
   * 原因）、`null` 还没验过或平台连不上 —— 界面别把「没验过」画成「已失效」。
   */
  async function handleLearnSession(res) {
    // 红字挂着时顺手验一次：票其实还活着（比如详情那条路把浏览器故障写成了失效）
    // 就当场恢复正常，不必等下一次心跳
    if (learnSelfCheckDue()) {
      await bareLearnCheck(learnSession.reason === 'needs-manual-login' ? 'needs-manual-login' : null);
    }
    const config = await readLearnConfig(dataDir);
    // 是否存了账号密码：界面据此决定「一键重连」是全自动还是要顺带提示用户存密码
    const cred = await readLearnCredential(dataDir);
    return sendJson(res, 200, {
      ok: true,
      connected: config.ok && cookieUsable(config.cookie),
      configReason: config.ok ? null : config.reason,
      credentialPresent: cred.present === true,
      ...learnSessionSnapshot(),
    });
  }

  /**
   * 立刻走一次续期（界面按钮；用户在登录窗口里登完之后也点它来「收 Cookie」）。
   *
   * 不做成 5xx：续期失败是**预期内**的结果（信任浏览器登录态也会过期），
   * 界面据此显示「需要你登录一次」，而不是把它当接口挂了。
   */
  async function handleLearnRenew(req, res) {
    if (!writePreflight(req, res)) return;
    const config = await readLearnConfig(dataDir);
    if (!config.ok) {
      return sendJson(res, 200, { ok: false, error: config.reason, session: learnSessionSnapshot() });
    }
    const renewed = await renewLearnCookie({ reason: 'manual' });
    if (!renewed.ok) {
      // 续期没成，不代表票就没了：直连再问一次，别把一张好票报成红字
      // （`cookie-only` = 票是好的，只是浏览器那条得人工登一次）
      const session = await bareLearnCheck(
        renewed.reason === 'needs-manual-login' ? 'needs-manual-login' : null,
      );
      return sendJson(res, 200, {
        ok: false, error: renewed.reason ?? 'renew-failed', detail: renewed.detail ?? null, session,
      });
    }
    learnSession.alive = true;
    learnSession.reason = 'ok';
    learnSession.checkedAt = new Date().toISOString();
    return sendJson(res, 200, { ok: true, source: renewed.source ?? 'renewed', session: learnSessionSnapshot() });
  }

  /**
   * 存/清统一身份认证账号密码（用户显式同意让插件存一份，供「一键重连」静默填表）。
   *
   * POST `{ user, pass }` 保存；两者任一为空 = 删除（＝撤销授权）。
   * 返回**绝不回显密码**，只回 `present` 与 `updatedAt`。
   */
  async function handleLearnCredential(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};
    try {
      const result = await writeLearnCredential(dataDir, {
        user: typeof payload.user === 'string' ? payload.user : '',
        pass: typeof payload.pass === 'string' ? payload.pass : '',
      });
      void sessionLog('credential', { cleared: result.cleared === true });
      return sendJson(res, 200, { ok: true, present: result.cleared !== true, updatedAt: result.updatedAt ?? null });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: 'credential-write-failed', detail: String(error?.message ?? error) });
    }
  }

  /**
   * 「打开登录窗口」之后的收 Cookie 轮询。
   *
   * 用户在专用窗口里登进去之后，凭什么把新 Cookie 拿到手？让他再点一次「立即续期」
   * 太笨了。这里每 15 秒看一眼浏览器里的 Cookie —— **只读、不导航**，免得把用户
   * 正在填的登录页顶掉 —— 发现变了且验活通过就落盘，然后自己收工。
   * 20 分钟等不到就放弃（用户可能只是开了窗口又去干别的了）。
   */
  const LOGIN_HARVEST_INTERVAL_MS = 15 * 1000;
  const LOGIN_HARVEST_TIMEOUT_MS = 20 * 60 * 1000;
  let loginHarvestTimer = null;
  let loginHarvestDeadline = 0;

  function stopLoginHarvest(reason = null) {
    if (loginHarvestTimer !== null) {
      clearInterval(loginHarvestTimer);
      loginHarvestTimer = null;
    }
    if (learnSession.loginHarvesting) {
      learnSession.loginHarvesting = false;
      if (reason !== null) {
        log.info?.(`[study-assistant] 不再盯着手动登录（${reason}）`);
        // 只记开始那一笔不够 —— 到底是「收到了」「超时了」还是「用户关了浏览器」，
        // 排障时必须一眼看出来，这是下次判断「要不要人工介入」的唯一依据
        void sessionLog('harvest-stop', { why: reason });
      }
    }
  }

  /** 看一眼浏览器里的 Cookie，能用就落盘。 */
  async function harvestOnce() {
    if (learnBrowser.status?.().running !== true) return { ok: false, reason: 'browser-not-running' };
    const read = await learnBrowser.readCookie();
    if (read.ok !== true || typeof read.cookie !== 'string' || read.cookie.trim() === '') {
      return { ok: false, reason: read.reason ?? 'empty-cookie' };
    }
    const config = await readLearnConfig(dataDir);
    if (!config.ok) return { ok: false, reason: config.reason };
    // 还是那张：用户还没登完（或本来就登着），别白验一次
    if (read.cookie === config.cookie) return { ok: false, reason: 'unchanged' };

    const check = await fetchLearnIndex(read.cookie, { timeoutMs: LEARN_TIMEOUT_MS });
    if (!check.alive) return { ok: false, reason: 'cookie-invalid' };

    await writeLearnConfig(dataDir, { ...config, cookie: read.cookie });
    learnSession.cookieUpdatedAt = new Date().toISOString();
    learnSession.manualNeeded = false;
    learnSession.alive = true;
    learnSession.reason = 'renewed';
    learnSession.checkedAt = learnSession.cookieUpdatedAt;
    // 票到手就收工：不管是这一轮轮询收的，还是别处顺手收的，
    // 都不能让定时器继续空转二十分钟（每 15 秒白读一次浏览器）
    stopLoginHarvest('harvested');
    log.info?.('[study-assistant] 已收下手动登录的会话（换到新 Cookie）');
    return { ok: true, source: 'manual-login' };
  }

  function startLoginHarvest() {
    stopLoginHarvest();
    loginHarvestDeadline = Date.now() + LOGIN_HARVEST_TIMEOUT_MS;
    learnSession.loginHarvesting = true;
    // 收割期间（最长 20 分钟、每 15 秒一次）只记开始那一笔。
    // 以前每 15 秒一条日志，真出事的时候 80 条一样的噪音把有用的几行埋了；
    // 收工/超时/收到的结论由 `stopLoginHarvest` 与 `harvestOnce` 各记一笔。
    void sessionLog('harvest-start', { timeoutMs: LOGIN_HARVEST_TIMEOUT_MS });
    const tick = async () => {
      if (Date.now() > loginHarvestDeadline) {
        stopLoginHarvest('timeout');
        return;
      }
      try {
        await harvestOnce();
      } catch (error) {
        log.warn?.('[study-assistant] 收 Cookie 轮询出错：', error);
      }
    };
    // 先立刻看一眼（用户可能本来就登着，只是插件没票），之后每 15 秒一次
    void tick();
    loginHarvestTimer = setInterval(() => { void tick(); }, LOGIN_HARVEST_INTERVAL_MS);
    loginHarvestTimer.unref?.();
  }

  /**
   * 开一个可见的 Edge 窗口停在登录页。
   *
   * 「信任浏览器」的登录态也过期时的兜底：用户手动登一次（勾上「信任浏览器」），
   * 之后又能静默续期很久。窗口用专用 profile，与用户日常 Edge 完全隔离。
   */
  async function handleLearnLoginWindow(req, res) {
    if (!writePreflight(req, res)) return;
    // 用户既然要手动登了，就把「别再自动试」的封条撕掉：
    // 万一他登完忘了点「立即续期」，20 分钟后的心跳还能自己把 Cookie 收下来
    learnSession.manualNeeded = false;
    learnSession.browserOptOut = false;
    const opened = await learnBrowser.openLoginWindow();
    if (!opened.ok) {
      return sendJson(res, 200, {
        ok: false, error: opened.reason, detail: opened.detail ?? null, browser: learnBrowser.status(),
      });
    }
    // 登完不用再点任何按钮：这边自己每 15 秒看一眼，收到就落盘
    startLoginHarvest();
    return sendJson(res, 200, { ok: true, browser: learnBrowser.status(), session: learnSessionSnapshot() });
  }

  /**
   * 关掉后台浏览器（保留 profile：登录态要留着下次静默续期用）。
   *
   * 关掉的同时记一笔「用户不想要它自动起来」：否则 20 分钟后的心跳会把它又拉起来，
   * 那就等于按钮没用了。想恢复只要点「立即续期」或「打开登录窗口」。
   */
  async function handleLearnBrowserStop(req, res) {
    if (!writePreflight(req, res)) return;
    learnSession.browserOptOut = true;
    stopLoginHarvest('browser-stopped');
    const stopped = await learnBrowser.stop();
    return sendJson(res, 200, { ok: true, stopped: stopped.stopped === true, browser: learnBrowser.status(), session: learnSessionSnapshot() });
  }

  /**
   * 作业详情（只读）。
   *
   * 客户端只给 `taskId`，其余全在服务端做：从任务 note 里取出远端记号
   * （`[learn:xszyid:…]`）、把本地课程映射成课堂号、再拉平台的「查看作业」页。
   * 和归档一样，「判定」留在服务端，客户端只负责显示。
   *
   * 失败一律回 200 + `{ok:false,error}`：拉不到详情不该让界面报红，
   * 该退回本地字段并说清原因（Cookie 过期是最常见的一种）。
   */
  async function handleLearnDetail(res, url) {
    const taskId = String(url.searchParams.get('taskId') ?? '').trim();
    const all = await store.readAll();
    const tasks = Array.isArray(all.docs.tasks?.tasks) ? all.docs.tasks.tasks : [];
    const task = tasks.find((item) => item?.id === taskId) ?? null;
    if (task === null) return sendJson(res, 200, { ok: false, error: 'no-task', detail: null, local: null });

    // 本地字段：详情拉不到时界面拿它兜底，所以失败分支也要带上
    const local = {
      id: task.id,
      title: task.title ?? '',
      courseId: task.courseId ?? null,
      kind: task.kind ?? null,
      due: task.due ?? null,
      status: task.status ?? null,
    };

    /**
     * 拉不到平台原文时的收尾。
     *
     * 先看落盘缓存里有没有上一次的原文，有就当成成功回给界面（标 `stale`），
     * 没有才报错。理由：详情是「看过一次就有价值」的静态快照（老师的要求、附件名、
     * 成绩、评语），会话过期时能显示旧的总比只显示一行原因强。
     */
    async function failOrStale(error, status = null) {
      const hit = await readDetailEntry(dataDir, taskId);
      if (hit !== null) {
        return sendJson(res, 200, {
          ok: true,
          cached: true,
          stale: true,
          wlkcid: hit.wlkcid,
          xszyid: hit.xszyid,
          courseName: hit.courseName,
          fetchedAt: hit.fetchedAt,
          detail: hit.detail,
          local,
        });
      }
      return sendJson(res, 200, { ok: false, error, status, detail: null, local });
    }

    const config = await readLearnConfig(dataDir);
    if (!config.ok) return failOrStale(config.reason);
    if (!cookieUsable(config.cookie)) return failOrStale('not-connected');

    const parsed = parseLearnKey(learnMarkOf(task));
    if (parsed === null) return failOrStale('no-learn-mark');

    // 本地课程 → 课堂号。`xszyid:` 形状的记号里没有课堂号，只能靠课程映射补上；
    // 用的就是上次同步对上的那份映射，不另建一套。
    let candidates = learnDetailCandidates(config, local.courseId, parsed);
    if (candidates.length === 0) {
      /**
       * 映射是空着/没对上这门课：**当场补一次**，别让用户去点那个修不好它的按钮。
       *
       * 2026-11-04 的故障就是这里：课程映射从来没被 `/learn/sync` 写过，于是
       * 每条详情都回 `course-unmapped`，而界面的提示是「先跑一次同步」——
       * 用户照做之后映射还是空的，故障原样复现。现在改成：先自己花半秒拉一次
       * 课程列表补上映射，补上了就继续往下取详情；真补不上才把错误交回去。
       */
      const repaired = await repairLearnCourses(config);
      if (repaired !== null) {
        candidates = learnDetailCandidates(repaired, local.courseId, parsed);
        await sessionLog('detail-mapping-repaired', { taskId, courseId: local.courseId, courses: repaired.courses.length });
      }
    }
    if (candidates.length === 0) {
      return failOrStale('course-unmapped');
    }
    // 只有 `zy:<wlkcid>:<zyid>` 形状的老任务落到这里：详情页的主键是 `xszyid`，
    // 得先同步一次拿到它，这里不猜。
    if (typeof parsed.xszyid !== 'string' || parsed.xszyid === '') {
      return failOrStale('needs-sync');
    }

    /**
     * 用某张 Cookie 把详情拉回来（内部逐个候选课堂号试）。
     *
     * 抽成函数是为了「会话刚过期」时能拿续期后的新 Cookie 再走一遍：
     * 用户点一下详情，不该收到「Cookie 已失效，请重新复制」这种要他动手的消息，
     * 而这正是最容易碰上的时刻（闲置一段时间后第一次点开）。
     */
    async function tryDetail(cookie) {
      let lastError = null;
      let lastStatus = null;
      for (const candidate of candidates) {
        const cacheKey = `${candidate.wlkcid}|${parsed.xszyid}`;
        const hit = learnDetailCache.get(cacheKey);
        if (hit !== undefined && Date.now() - hit.at < LEARN_DETAIL_TTL_MS) {
          return {
            ok: true,
            payload: {
              ok: true, cached: true, wlkcid: candidate.wlkcid, xszyid: parsed.xszyid, courseName: candidate.name,
              fetchedAt: new Date(hit.at).toISOString(), detail: hit.detail, local,
            },
          };
        }

        const fetched = await fetchHomeworkDetail(candidate.wlkcid, parsed.xszyid, cookie, { timeoutMs: LEARN_TIMEOUT_MS });
        if (fetched.ok) {
          learnDetailCache.set(cacheKey, { at: Date.now(), detail: fetched.detail });
          const fetchedAt = new Date().toISOString();
          // 顺手落盘一份：下次会话过期时，界面还能看到这次抓到的原文
          const saved = await writeDetailEntry(dataDir, taskId, {
            fetchedAt,
            wlkcid: candidate.wlkcid,
            xszyid: parsed.xszyid,
            courseName: candidate.name,
            detail: fetched.detail,
          });
          if (!saved.ok) log.warn?.(`[study-assistant] 作业详情缓存没写成（${saved.reason}）：${saved.detail ?? ''}`);
          return {
            ok: true,
            payload: {
              ok: true, cached: false, wlkcid: candidate.wlkcid, xszyid: parsed.xszyid, courseName: candidate.name,
              fetchedAt, detail: fetched.detail, local,
            },
          };
        }
        lastError = fetched.error;
        lastStatus = fetched.status ?? null;
        // 换课堂号也救不了的错（Cookie 失效、根本连不上）就别再试下一个了
        if (fetched.error === 'cookie-invalid' || fetched.error === 'http-0') break;
      }
      return { ok: false, error: lastError, status: lastStatus };
    }

    let attempt = await tryDetail(config.cookie);
    if (!attempt.ok && attempt.error === 'cookie-invalid') {
      // 顺手把 SSO 也喂一次：点详情撞上过期往往就是 SSO 那边闲死的前兆
      const renewed = await renewLearnCookie({ reason: 'detail', touchSso: true });
      if (renewed.ok) {
        const fresh = await readLearnConfig(dataDir);
        attempt = await tryDetail(fresh.cookie);
      } else {
        // 2026-10-17 修：这里以前直接写全局 `alive = false`，既不更新 `checkedAt`
        // 也不排复查。可 SSO 回跳超时（`sso-timeout`）、浏览器忙（`busy`）、CDP 抽风
        // 说的都不是「这张票死了」，于是一张好票能红到下一次心跳（最长 20 分钟）。
        // 会话死活仍交给直连：票还活着就照旧算活（`cookie-only` 时由界面提一句人工登录）。
        await bareLearnCheck(renewed.reason === 'needs-manual-login' ? 'needs-manual-login' : null);
      }
    }
    if (attempt.ok) return sendJson(res, 200, attempt.payload);
    return failOrStale(attempt.error ?? 'learn-unreachable', attempt.status ?? null);
  }

  // -------------------------------------------------------------------------
  // 听课（M1：只做「录一段 → 转写一段」，用来量真实环境的识别率）
  // -------------------------------------------------------------------------

  /** 语音桥可能没被注入（比如老测试只传了 store），统一在这里取。 */
  function speechBridge() {
    return deps.speech ?? null;
  }

  /**
   * 听课会话：累积逐字稿、跑点名/答题检测、落盘。
   *
   * 文本来源有三条（腾讯会议读屏 OCR、手动粘贴、本地麦克风转写），但对这一层
   * 来说都只是「一帧文本」，所以它和输入源完全解耦 —— 也正因如此，读屏适配器
   * 还没做出来时，整条分析链路就已经可以靠手动粘贴跑通、验证。
   */
  const lecture = createLectureSession({
    dataDir,
    logger: log,
    studentName: deps.studentName,
    studentNameVariants: deps.studentNameVariants,
    // 总结引擎由宿主侧（index.js）注入：它要拿 ctx.get('llm')，这一层不认识 ctx
    summarizer: deps.summarizer ?? null,
    // 课后收尾的四个动作。写 md 这一步要现读课程表，因为笔记该落在哪个学科目录
    // 是「课程 note 里写的目录」决定的，而课程表随时可能被改。
    reporting: {
      render: renderNoteMarkdown,
      handoffPrompt: renderHandoffPrompt,
      write: async ({ courseName, date, markdown }) => {
        let courses = [];
        try {
          const all = await store.readAll();
          courses = Array.isArray(all?.docs?.courses?.courses) ? all.docs.courses.courses : [];
        } catch (error) {
          log.error?.('[study-assistant] 读课程表失败（笔记只能落到兜底目录）：', error);
        }
        return writeLectureNote({ dataDir, workspaceRoot, courses, courseName, date, markdown, logger: log });
      },
      handoff: typeof deps.handoff === 'function'
        ? (input) => deps.handoff({ ...input, cwd: workspaceRoot })
        : null,
    },
  });

  /**
   * 语音服务状态。
   *
   * 刻意**永远返回 200**：实验包没启用是「功能未就绪」，不是「接口出错」。
   * 返回 503 会让页面上的状态灯和真正的故障（比如服务抛异常）没法区分。
   */
  async function handleLectureHealth(res) {
    const bridge = speechBridge();
    const speech = bridge === null
      ? { available: false, hint: SPEECH_HINT, providers: [] }
      : await bridge.status();
    return sendJson(res, 200, {
      ok: true,
      speech,
      sampleRate: 16000,
      maxSeconds: LECTURE_MAX_SECONDS,
      panel: `${API_PREFIX}/lecture/panel`,
      lecture: { running: lecture.running(), studentName: lecture.studentName() },
    });
  }

  /** 开始一节课。已经在跑时返回 409 —— 两节课的逐字稿不能混在一起。 */
  async function handleLectureStart(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};
    const result = await lecture.start({
      course: payload.course,
      source: payload.source,
      profile: payload.profile,
    });
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  /**
   * 喂一帧文本。
   *
   * 这是整条分析管线的入口：读屏 OCR 每认出一帧就 POST 一次，手动粘贴也是
   * 走这里。返回里带 `appended`（这一帧真正新增的部分）与 `alerts`（新提醒），
   * 页面据此做浮层，不必自己算重叠。
   */
  async function handleLectureFeed(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload ?? {};
    const result = await lecture.feed({
      text: payload.text,
      source: payload.source,
      at: payload.at,
    });
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  /** 当前课堂状态：概况 + 尾部逐字稿 + 未确认的提醒。 */
  async function handleLectureState(res, url) {
    const tail = Number(url.searchParams.get('tail'));
    return sendJson(res, 200, lecture.snapshot(Number.isInteger(tail) && tail > 0 ? { tailSegments: tail } : {}));
  }

  /** 结束这节课：写最终记录并清空会话。 */
  async function handleLectureStop(req, res) {
    if (!writePreflight(req, res)) return;
    // 排空请求体即可，不解析 —— 「结束」这个动作没有参数，容忍空 body 更省事
    await readBody(req);
    const result = await lecture.stop();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  /** 关掉一条提醒（浮层上的「知道了」）。 */
  async function handleLectureAck(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const result = await lecture.ack(String(body.payload?.id ?? ''));
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  /** 往期听课记录列表。 */
  async function handleLectureSessions(res) {
    const result = await lecture.list();
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  /**
   * 课后收尾的最新进展。
   *
   * 总结 + 写笔记 + 开新会话要几十秒，`/lecture/session/stop` 不会等它，
   * 所以下课之后由面板轮询这里拿到笔记路径和新会话 id。
   */
  async function handleLectureReport(res) {
    return sendJson(res, 200, lecture.report());
  }

  /** 听课面板页面。GET 路由不校验写请求那套头，浏览器直接打开即可。 */
  async function handleLecturePanel(res) {
    let html = '';
    try {
      html = await readPanelHtml();
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: 'panel-missing', detail: String(error?.message ?? error) });
    }
    return sendText(res, 200, 'text/html; charset=utf-8', html);
  }

  /**
   * 页面 import 的客户端模块（目前只有 wav.js）。
   *
   * 直接读盘、不缓存：改完源码刷新页面就生效。
   * 文件名走 `clientModulePath` 的白名单，挡掉 `../../` 之类的路径穿越。
   */
  async function handleLectureModule(res, name) {
    const file = clientModulePath(name);
    if (file === null) return sendJson(res, 404, { ok: false, error: 'unknown-module', name });
    let source;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: 'module-unreadable', detail: String(error?.message ?? error) });
    }
    return sendText(res, 200, 'text/javascript; charset=utf-8', source);
  }

  /**
   * 转写一片录音。
   *
   * 校验顺序刻意是「先本地校验、再碰语音服务」：
   *   宿主侧 `validateWave` 抛出来的是一句英文异常，页面上没法用；
   *   而夹在中间的 `bad-audio` 能直接说清是采样率错了、还是没收到音频。
   */
  async function handleLectureChunk(req, res, url) {
    if (!writePreflight(req, res, { skipContentType: true })) return;

    const body = await readBody(req, { maxBytes: LECTURE_MAX_BODY_BYTES, binary: true });
    if (!body.ok) {
      return sendJson(res, body.reason === 'too-large' ? 413 : 400, {
        ok: false,
        error: body.reason,
        detail: body.reason === 'too-large'
          ? `单片音频上限约 ${LECTURE_MAX_SECONDS} 秒，请缩短切片`
          : '读取请求体失败',
      });
    }

    // copyBytes 复制成独立字节：Node 的 Buffer 常是分配池里的一段，
    // 直接把 `.buffer` 递出去会把无关字节一起交上去。
    const audio = copyBytes(body.buffer);
    if (audio === null) return sendJson(res, 400, { ok: false, error: 'bad-body' });

    const checked = inspectWav(audio, LECTURE_MAX_SECONDS);
    if (!checked.ok) {
      return sendJson(res, 400, {
        ok: false,
        error: 'bad-audio',
        reason: checked.reason,
        sampleRate: checked.sampleRate ?? null,
        detail: '音频必须是规范 16 kHz 单声道 PCM16 WAV',
      });
    }
    if (checked.seconds < LECTURE_MIN_SECONDS) {
      return sendJson(res, 400, { ok: false, error: 'audio-too-short', seconds: checked.seconds });
    }

    const bridge = speechBridge();
    if (bridge === null) {
      return sendJson(res, 503, { ok: false, error: 'speech-unavailable', detail: SPEECH_HINT });
    }

    const result = await bridge.transcribe(audio, {
      language: url.searchParams.get('language') ?? 'auto',
      providerId: url.searchParams.get('providerId') ?? '',
    });
    if (!result.ok) {
      return sendJson(res, result.error === 'speech-timeout' ? 504 : 502, {
        ...result,
        seconds: checked.seconds,
      });
    }
    return sendJson(res, 200, { ok: true, ...result, seconds: checked.seconds, bytes: audio.length });
  }

  /**
   * 列出腾讯会议录音笔留下的音频文件。
   *
   * **永远返回 200**，和三处同类接口（`/lecture/health`）保持一致的道理：
   * 「还没录过」不是故障。目录没配、目录不存在都用 `exists:false` 表达，
   * 让页面能明确地说出「去设置里填录音目录」，而不是显示一个红色报错。
   */
  async function handleLectureRecordingList(res, url) {
    const limit = Number(url.searchParams.get('limit'));
    const listed = await listRecordings(recordingDir, Number.isInteger(limit) && limit > 0 ? { limit } : {});
    return sendJson(res, 200, {
      ok: true,
      configured: recordingDir !== '',
      recordingDir: recordingDir === '' ? null : recordingDir,
      exists: listed.exists === true,
      dir: listed.dir ?? null,
      error: listed.ok ? null : listed.error,
      total: listed.total ?? 0,
      items: listed.items ?? [],
    });
  }

  /**
   * 按偏移读一段录音文件的原始字节。
   *
   * 为什么让浏览器自己解码：`.aac` 是 ADTS、`.wemta` 是腾讯自己的容器，宿主侧
   * 要解就得拖进解码器（本机没有 ffmpeg）；而 **Chromium 自带 AAC 解码器**，
   * 页面用 `decodeAudioData` 一句就能拿到 PCM。所以宿主只负责「原样吐字节」，
   * 音频的解读留在页面。
   *
   * 文件在课堂进行中是被腾讯会议一边写一边占用的，`readRecording` 用共享方式
   * 打开，读得到。返回头里带 `end`/`size`/`eof`，页面据此决定下次从哪继续。
   */
  async function handleLectureRecordingFile(res, url) {
    const session = url.searchParams.get('session') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const offset = Number(url.searchParams.get('offset'));
    const maxBytes = Number(url.searchParams.get('maxBytes'));
    const read = await readRecording(recordingDir, session, name, {
      offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
      ...(Number.isInteger(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
    });
    if (!read.ok) {
      const status = read.error === 'not-found' ? 404 : 400;
      return sendJson(res, status, {
        ok: false,
        error: read.error,
        detail: read.detail ?? null,
        file: read.file ?? null,
      });
    }
    return sendBytes(res, 200, 'application/octet-stream', read.bytes, {
      'X-Study-Offset': String(read.offset),
      'X-Study-End': String(read.end),
      'X-Study-Size': String(read.size),
      'X-Study-Eof': read.eof ? '1' : '0',
      'X-Study-Name': encodeURIComponent(read.name),
    });
  }

  /** 录音导入页（拿真实录音量识别率用的那一张）。 */
  async function handleLectureImport(res) {
    let html = '';
    try {
      html = await readImportHtml();
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: 'import-missing', detail: String(error?.message ?? error) });
    }
    return sendText(res, 200, 'text/html; charset=utf-8', html);
  }

  /**
   * 资料正文：面板「资料」页点开某份资料时，把取字产物（md）读出来给界面看。
   *
   * 为什么必须由宿主读：面板跑在浏览器里，读不了本地磁盘；`资料索引.json` 只登记了
   * 「取字产物落在哪」（`text.outFile` 或 `ocr.outDir`），正文得从这里吐。
   *
   * 为什么不是任意路径读取：`path` 参数**必须精确等于**索引里某条记录的 `path`，
   * 真正的 md 路径由服务端按命名规则拼出来（`tier-gemini-pageNN.md` → `gemini-pageNN.md`
   * → `pageNNNN.md` → 全文）。这样 URL 里塞不进 `../`，也不需要一份「允许目录」白名单。
   *
   * 一次只回**一页**：教材全文动辄几百页，全量塞给面板既慢又没必要；页面靠
   * 返回的 `pages` 自己翻。
   */
  async function handleMaterialText(res, url) {
    const wanted = String(url.searchParams.get('path') ?? '').trim().replace(/\\/g, '/');
    if (wanted === '') return sendJson(res, 400, { ok: false, error: 'missing-path' });
    const all = await store.readAll();
    const files = Array.isArray(all.docs.materials?.files) ? all.docs.materials.files : [];
    const record = files.find((item) => String(item?.path ?? '').replace(/\\/g, '/') === wanted);
    if (record === undefined) return sendJson(res, 404, { ok: false, error: 'not-indexed', path: wanted });

    const rootAbs = path.resolve(workspaceRoot);
    /** 读一个相对工作区的文件；越界（理论上有索引也可能被手改）与不存在都回 null。 */
    const readRel = async (rel) => {
      const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (clean === '' || clean.split('/').includes('..')) return null;
      const abs = path.resolve(rootAbs, clean);
      if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) return null;
      try {
        return { rel: clean, text: await fs.readFile(abs, 'utf8') };
      } catch {
        return null;
      }
    };

    const MAX_CHARS = 200 * 1024;
    const shape = (rel, text, extra) => ({
      ok: true,
      path: wanted,
      file: rel,
      chars: text.length,
      truncated: text.length > MAX_CHARS,
      text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text,
      ...extra,
    });

    // 1) 有文字层的资料：索引里直接给了 md 路径，一次读完。
    const outFile = typeof record?.text?.outFile === 'string' ? record.text.outFile : '';
    if (outFile !== '') {
      const read = await readRel(outFile);
      if (read === null) return sendJson(res, 404, { ok: false, error: 'missing', path: wanted, file: outFile });
      return sendJson(res, 200, shape(read.rel, read.text, { kind: 'text', page: null, pages: [] }));
    }

    // 2) 扫描件：按 outDir 里实际存在的页文件拼，命名规则见 `_工具/学习台-扫描件取字规范.md`。
    const outDir = typeof record?.ocr?.outDir === 'string' ? record.ocr.outDir : '';
    if (outDir === '') return sendJson(res, 404, { ok: false, error: 'no-text', path: wanted });
    const dirAbs = path.resolve(rootAbs, outDir);
    if (!dirAbs.startsWith(`${rootAbs}${path.sep}`)) {
      return sendJson(res, 403, { ok: false, error: 'escape', path: wanted });
    }
    let names = [];
    try {
      names = await fs.readdir(dirAbs);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'no-text', path: wanted, outDir });
    }
    // 页号 → 文件名（同一页可能有多档产物，按可信度取第一个）
    const byPage = new Map();
    const ordered = [...names].sort();
    for (const pattern of [/^tier-gemini-page(\d{1,4})\.md$/i, /^gemini-page(\d{1,4})\.md$/i, /^tier-notebook-page(\d{1,4})\.md$/i, /^page(\d{1,4})\.md$/i]) {
      for (const name of ordered) {
        const hit = pattern.exec(name);
        if (hit !== null) {
          const no = Number(hit[1]);
          if (!byPage.has(no)) byPage.set(no, name);
        }
      }
    }
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    const asked = url.searchParams.get('page');
    const wantedPage = asked === null || asked === '' ? (pages[0] ?? null) : Number(asked);
    const extra = { outDir, pages };
    if (wantedPage === null || !Number.isInteger(wantedPage) || wantedPage < 1) {
      return sendJson(res, 404, { ok: false, error: 'no-text', path: wanted, outDir, pages });
    }
    const name = byPage.get(wantedPage);
    if (name === undefined) {
      // 这一页还没取出来：把有字的页带回去，界面据此提示「第 N 页还没取字」
      return sendJson(res, 404, { ok: false, error: 'page-missing', path: wanted, page: wantedPage, ...extra });
    }
    const read = await readRel(`${outDir}/${name}`);
    if (read === null) return sendJson(res, 404, { ok: false, error: 'missing', path: wanted, page: wantedPage, ...extra });
    return sendJson(res, 200, shape(read.rel, read.text, { kind: 'ocr', page: wantedPage, ...extra }));
  }

  /**
   * 知识点插图：`GET /materials/image?path=学习台/图片/...png`。
   *
   * 为什么不直接把「文件路径」交给浏览器：浏览器拿不到本地路径，而且那样等于
   * 给面板开了一个任意读文件的洞。这里一律**先查 `学习台/图片/_index.json`**，
   * 只有登记过的路径才下发字节；索引由裁图脚本维护（见 `_工具/学习台-插图裁切规范.md`）。
   *
   * 顺带挡住两类事故：① 手改索引写出 `..` 的越界路径；② 拿索引当代理去读超大文件。
   */
  async function handleMaterialImage(res, url) {
    const wanted = String(url.searchParams.get('path') ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (wanted === '') return sendJson(res, 400, { ok: false, error: 'missing-path' });
    if (wanted.split('/').includes('..')) return sendJson(res, 403, { ok: false, error: 'escape', path: wanted });

    const rootAbs = path.resolve(workspaceRoot);
    // 索引放在**数据目录**的 `图片/` 下（`学习台/图片/_index.json`）：它是学习台数据的一部分，
    // 与 `tools/analysis.mjs` 里的 `loadImageIndex(dataDir)` 读的是同一份；图本身仍是
    // 「相对工作区根」的路径（`学习台/图片/…`），所以下发的字节和工作区根解析一致。
    const indexAbs = path.join(path.resolve(dataDir), IMAGE_DIR_NAME, '_index.json');
    let index = null;
    try {
      index = JSON.parse(await fs.readFile(indexAbs, 'utf8'));
    } catch {
      return sendJson(res, 404, { ok: false, error: 'no-index', path: wanted });
    }
    const items = Array.isArray(index?.images) ? index.images : [];
    const record = items.find((item) => String(item?.path ?? '').replace(/\\/g, '/') === wanted);
    if (record === undefined) return sendJson(res, 404, { ok: false, error: 'not-indexed', path: wanted });

    const abs = path.resolve(rootAbs, wanted);
    if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) {
      return sendJson(res, 403, { ok: false, error: 'escape', path: wanted });
    }
    const ext = path.extname(abs).toLowerCase();
    const type = IMAGE_CONTENT_TYPES.get(ext);
    if (type === undefined) return sendJson(res, 415, { ok: false, error: 'unsupported-type', path: wanted, ext });
    let bytes = null;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'missing', path: wanted });
      if (stat.size > IMAGE_MAX_BYTES) return sendJson(res, 413, { ok: false, error: 'too-large', path: wanted, bytes: stat.size });
      bytes = await fs.readFile(abs);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'missing', path: wanted });
    }
    // `immutable` 是有意的：图按「内容命名 + 索引登记」发布，同名文件不原地改，改了就是换新文件
    return sendBytes(res, 200, type, bytes, {
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Study-Image': encodeURIComponent(String(record.caption ?? '')),
    });
  }

  /**
   * 织网：把「知识点候选」合并进「知识点网络」。
   *
   * 面板上点一次就走这里；纯合并逻辑在 `lib/knowledge.js`（有单测），本函数只做「读 → 合并 → 写」。
   * 冲突（面板刚被人标记过、或另一个宿主写过）时回 409，**不硬盖**——掌握度是人手点的，丢了没法恢复。
   */
  async function handleKnowledgeWeave(req, res) {
    if (!writePreflight(req, res)) return;
    const [network, candidates, questions, courses] = await Promise.all([
      store.readDocument('knowledgeNetwork'),
      store.readDocument('knowledgeCandidates'),
      store.readDocument('questions'),
      store.readDocument('courses'),
    ]);
    if (!network.ok && network.reason !== 'missing') {
      return sendJson(res, 409, { ok: false, error: network.reason, key: 'knowledgeNetwork' });
    }
    if (!candidates.ok) {
      // 没有候选（或候选文件坏了）：一律不写盘，把原因如实带回去让面板提示
      return sendJson(res, 200, {
        ok: true,
        changed: false,
        written: false,
        reason: candidates.reason ?? 'no-candidates',
        stats: { candidates: 0, created: 0, merged: 0, unchanged: 0, skipped: 0, evidenceAdded: 0 },
      });
    }
    const result = weaveCandidates({
      network: network.ok ? network.doc : { version: 1, nodes: [], edges: [] },
      candidates: candidates.doc,
      questions: questions.ok ? questions.doc : { questions: [] },
      courses: courses.ok ? courses.doc : { courses: [] },
    });
    if (!result.changed) {
      return sendJson(res, 200, { ok: true, changed: false, written: false, stats: result.stats });
    }
    const write = await store.writeDocument('knowledgeNetwork', result.network, {
      expectedHash: network.ok ? network.hash : null,
    });
    if (!write.ok) {
      return sendJson(res, 409, { ok: false, error: write.reason ?? 'write-failed', key: 'knowledgeNetwork' });
    }
    return sendJson(res, 200, {
      ok: true,
      changed: true,
      written: true,
      stats: result.stats,
      created: result.details.created.map((item) => item.id),
    });
  }

  /**
   * 导出到 kp-notes 画布：写 `<数据目录>/知识画布`。
   *
   * 只写画布目录内部、只删上一份 `_manifest.json` 登记过的文件（见 `lib/kp-notes-export.js`），
   * 所以这个按钮点多少次都不会碰用户自己放进画布的笔记。
   */
  async function handleKnowledgeExport(req, res) {
    if (!writePreflight(req, res)) return;
    const [network, questions, courses] = await Promise.all([
      store.readDocument('knowledgeNetwork'),
      store.readDocument('questions'),
      store.readDocument('courses'),
    ]);
    if (!network.ok && network.reason !== 'missing') {
      return sendJson(res, 409, { ok: false, error: network.reason, key: 'knowledgeNetwork' });
    }
    const networkDoc = network.ok ? network.doc : { version: 1, nodes: [], edges: [] };
    const plan = planExport({
      network: networkDoc,
      questions: questions.ok ? questions.doc : { questions: [] },
      courses: courses.ok ? courses.doc : { courses: [] },
      sourceLine: `知识点网络 ${String(networkDoc.updatedAt ?? '').replace('T', ' ').slice(0, 16) || '（未标注）'}`,
    });
    const outDir = path.join(dataDir, '知识画布');
    try {
      const result = applyExport(outDir, plan, { prune: true });
      return sendJson(res, 200, {
        ok: true,
        outDir: '知识画布',
        written: result.written.length,
        unchanged: result.unchanged,
        removed: result.removed.length,
        kept: result.kept.length,
        summary: plan.summary,
      });
    } catch (error) {
      log.error?.('[study-assistant] 导出画布失败：', error);
      return sendJson(res, 500, { ok: false, error: 'export-failed', message: String(error?.message ?? error) });
    }
  }

  // -------------------------------------------------------------------------
  // 学习记录（P3）：阅读位置 / 时间线。
  // 这些都写 `学习台/学习记录/`，不进 DOC_KEYS、不进 /state、不进备份包。
  // （对话归档随「交互助手对话」一起下线，2026-11-18；磁盘旧文件保留只读。）
  // -------------------------------------------------------------------------

  /** 阅读位置写节流：客户端切页很频繁，最多 1.5 秒落一次盘。 */
  let lastReadingWriteMs = 0;

  /** GET /study-log：时间线 + 阅读位置一次取齐（对话索引随交互助手下线）。 */
  async function handleStudyLogGet(res) {
    const [annotations, network, position] = await Promise.all([
      store.readDocument('annotations'),
      store.readDocument('knowledgeNetwork'),
      readReadingPosition(dataDir),
    ]);
    const notesDoc = annotations.ok && annotations.doc !== null ? annotations.doc : { notes: [] };
    const netDoc = network.ok && network.doc !== null ? network.doc : { nodes: [] };
    const timeline = buildTimeline({ readingPosition: position, annotations: notesDoc, knowledgeNetwork: netDoc });
    return sendJson(res, 200, {
      ok: true,
      readingPosition: position,
      timeline,
      notesCount: Array.isArray(notesDoc.notes) ? notesDoc.notes.length : 0,
    });
  }

  /** POST /reading-position：记录读到哪一份资料哪一页（节流写、原子写、进 _backup）。 */
  async function handleReadingPositionPost(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const normalized = normalizeReadingPosition(body.payload ?? {}, new Date().toISOString());
    if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason });
    const now = Date.now();
    if (now - lastReadingWriteMs < 1500) {
      return sendJson(res, 200, { ok: true, written: false, throttled: true });
    }
    lastReadingWriteMs = now;
    try {
      await writeReadingPosition(dataDir, normalized.value);
    } catch (error) {
      log.error?.('[study-assistant] 写阅读位置失败：', error);
      return sendJson(res, 500, { ok: false, error: 'position-write-failed', message: String(error?.message ?? error) });
    }
    return sendJson(res, 200, { ok: true, written: true, position: normalized.value });
  }

  /**
   * GET /study-log/duration：返回全部学习时长；带 ?date=YYYY-MM-DD 时只返该日（按 startAt 本地日期）
   * 并附当日总秒数（供时钟旁「今日累计 X 分钟」轻量展示）。
   */
  async function handleStudyDurationGet(res, url) {
    const all = await readLearningDurations(dataDir);
    const date = String(url.searchParams.get('date') ?? '').trim();
    if (date === '') {
      return sendJson(res, 200, { ok: true, records: all, totalSeconds: all.reduce((sum, r) => sum + (Number.isInteger(r?.seconds) ? r.seconds : 0), 0) });
    }
    // 按本地日期过滤：startAt 的本地日期前缀等于 date
    const localDateOf = (iso) => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return '';
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const records = all.filter((r) => localDateOf(r?.startAt) === date);
    const totalSeconds = records.reduce((sum, r) => sum + (Number.isInteger(r?.seconds) ? r.seconds : 0), 0);
    return sendJson(res, 200, { ok: true, date, records, totalSeconds });
  }

  /** POST /study-log/duration：收一条学习时长，校验后追加落盘（原子写 + 备份）。<5s 拒收。 */
  async function handleStudyDurationPost(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const normalized = normalizeDurationRecord(body.payload ?? {}, new Date().toISOString());
    if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason });
    try {
      const result = await appendLearningDuration(dataDir, normalized.value);
      return sendJson(res, 200, { ok: true, written: true, record: normalized.value, total: result.total });
    } catch (error) {
      log.error?.('[study-assistant] 写学习时长失败：', error);
      return sendJson(res, 500, { ok: false, error: 'duration-write-failed', message: String(error?.message ?? error) });
    }
  }

  // ---------------------------------------------------------------------------
  // 一键提醒（2026-11-19 A 卡）：把「今日日程」推到本人微信，不通回退 QQ
  //
  // 三条设计约束（用户定案 + 卡 §⑧）：
  //   1. **只走后端**：前端只 `POST /remind`（无参数），botId / targetId / 平台路由
  //      一律由本函数在运行时从本机 dsh-im 配置读，**绝不进仓库源码**；
  //   2. **不自己换 token**：发消息交给 dsh-im 的主动投递接口
  //      `POST /api/dsh-im/delivery/messages`（同 Host 复用 Web 端口，无私钥、无 CORS），
  //      这里只在 Host 头是回环地址时才调用，避免把该接口变成对外发消息的跳板；
  //   3. **失败要能兜底**：两条通道都不通时仍把组装好的文本回给前端，
  //      前端复制到剪贴板并提示（用户 2026-11-19 选的兜底方案）。
  // ---------------------------------------------------------------------------

  /** DSH 数据根：dsh-im 的渠道配置都在 `<DSH_HOME>/integrations` 下。 */
  function dshHome() {
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    return path.join(os.homedir(), '.dsh');
  }

  /** 读 JSON；文件不存在/坏掉都当「没有」，不因为一条通道配置缺失拖垮整个提醒。 */
  async function readJsonQuiet(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 读出「本人私聊」的投递参数：先微信、后 QQ。
   *
   * 渠道目录与 dsh-im 的落盘约定一致：
   *   `integrations/dsh-weixin/{config.json,workspaces.json}`（botId 在 `accounts[]`）
   *   `integrations/dsh-qq/{config.json,workspaces.json}`（botId 在 `bots[]`）
   * 目标取 `workspaces.json → deliveryTargets[botId]` 里 `kind === 'user'` 的一项，
   * 优先别名 `owner-direct`（本机两个渠道都按这个别名保存本人私聊）。
   */
  async function resolveRemindChannels() {
    const root = path.join(dshHome(), 'integrations');
    const plan = [
      { channel: 'weixin', dir: 'dsh-weixin', listKey: 'accounts' },
      { channel: 'qq', dir: 'dsh-qq', listKey: 'bots' },
    ];
    const out = [];
    for (const item of plan) {
      const config = await readJsonQuiet(path.join(root, item.dir, 'config.json'));
      const workspaces = await readJsonQuiet(path.join(root, item.dir, 'workspaces.json'));
      const bots = Array.isArray(config?.[item.listKey]) ? config[item.listKey] : [];
      for (const bot of bots) {
        const botId = typeof bot?.botId === 'string' ? bot.botId : '';
        if (botId === '') continue;
        const targets = workspaces?.deliveryTargets?.[botId];
        if (targets === null || typeof targets !== 'object') continue;
        const entries = Object.entries(targets).filter(([, target]) => target?.kind === 'user');
        if (entries.length === 0) continue;
        const picked = entries.find(([targetId]) => targetId === 'owner-direct') ?? entries[0];
        out.push({ channel: item.channel, botId, targetId: picked[0] });
      }
    }
    return out;
  }

  /**
   * 只接受回环 authority：投递接口没有鉴权，别拿 Host 头把它当跳板。
   *
   * 统一改写成数字回环地址：`localhost` 在双栈机器上可能先解析到 `::1`，
   * 而宿主只监听 `127.0.0.1` —— 直接把主机名换掉，省掉一次可能失败的解析。
   */
  function loopbackOrigin(hostHeader) {
    const host = String(hostHeader ?? '').trim();
    const matched = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})$/.exec(host);
    if (matched === null) return null;
    const port = Number(matched[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const address = matched[1] === '[::1]' ? '[::1]' : '127.0.0.1';
    return `http://${address}:${port}`;
  }

  /** 调用 dsh-im 主动投递；返回统一结构（不抛异常，让上层决定回退）。 */
  async function postDelivery(origin, payload) {
    const response = await fetch(`${origin}/api/dsh-im/delivery/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const rawText = await response.text().catch(() => '');
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
    const sent = response.status === 200 && body?.sent === true;
    return {
      ok: sent,
      status: response.status,
      error: sent ? null : (body?.error?.code ?? `http-${response.status}`),
      detail: sent ? '' : String(body?.error?.message ?? rawText ?? '').slice(0, 200),
    };
  }

  /**
   * `POST /remind`：读全量文档 → 组「今日日程」文本 → 微信优先、QQ 回退。
   *
   * 返回 `{ ok, channel, detail, text, attempts[] }`：
   *   - 成功：`ok:true` + 实际送达的 `channel`；
   *   - 全失败：`ok:false` + `error:'remind-failed'`，但 `text` 仍在，
   *     前端据此复制到剪贴板（这是用户定的兜底）。
   */
  async function handleRemind(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;

    const all = await store.readAll();
    const docs = all?.docs ?? {};
    const promptNow = typeof deps.now === 'function' ? deps.now() : new Date();
    const brief = buildDailyBrief(docs, promptNow);
    const text = formatDailyBrief(brief);

    const origin = loopbackOrigin(req.headers?.host);
    if (origin === null) {
      return sendJson(res, 400, { ok: false, error: 'bad-host', detail: '提醒只允许从本机回环地址触发。', text });
    }

    let channels = [];
    try {
      channels = typeof deps.remindChannels === 'function' ? await deps.remindChannels() : await resolveRemindChannels();
    } catch (error) {
      log.error?.('[study-assistant] 读取提醒通道配置失败：', error);
      channels = [];
    }
    if (!Array.isArray(channels) || channels.length === 0) {
      return sendJson(res, 503, {
        ok: false,
        error: 'remind-no-channel',
        detail: '没有找到「本人私聊」投递目标：先在 DSH 的 IM 机器人设置里给微信/QQ 机器人保存一个私聊目标。',
        text,
      });
    }

    const deliver = typeof deps.remindDeliver === 'function' ? deps.remindDeliver : (payload) => postDelivery(origin, payload);
    const attempts = [];
    for (const channel of channels) {
      const payload = { botId: channel.botId, targetId: channel.targetId, text, format: 'plain' };
      let result;
      try {
        result = await deliver(payload);
      } catch (error) {
        result = { ok: false, status: 0, error: 'deliver-threw', detail: String(error?.message ?? error).slice(0, 200) };
      }
      attempts.push({ channel: channel.channel, ok: result?.ok === true, error: result?.error ?? null, detail: result?.detail ?? '' });
      if (result?.ok === true) {
        return sendJson(res, 200, {
          ok: true,
          channel: channel.channel,
          detail: attempts.length > 1 ? `前一通道失败，已回退 ${channel.channel}` : '',
          text,
          attempts,
        });
      }
    }

    return sendJson(res, 502, {
      ok: false,
      error: 'remind-failed',
      channel: null,
      detail: '微信与 QQ 都没发出去：请确认对应机器人在线、目标仍是本人私聊；提示文本已随响应返回，可复制。',
      text,
      attempts,
    });
  }

  /**
   * `POST /schedule/parse`：把一段话交给 AI 抽成日程草稿（2026-11-19 A2 卡）。
   *
   * 只做「抽取 + 校验」，**不写任何文档**：草稿回到前端表单，用户改完点「添加」
   * 才走 `POST /mutate doc=schedule`。所以这里和 `/remind` 一样要过写请求前置校验
   * （它同样是从面板触发的、会花掉一次 API 额度的动作），但磁盘一个字节都不动。
   *
   * 失败一律 `ok:false`（前端据此「表单留空 + 报错」，绝不拿半成品入库）：
   *   - 没读密钥            → 503 `ai-key-missing`
   *   - 通道不通/超时/限流  → 502 `ai-unavailable` / `ai-timeout`
   *   - 输出不是 JSON / 没标题 → 502 `ai-bad-output` / `ai-bad-title`
   *   - 入参空              → 400 `schedule-parse-empty`
   * 测试可注入 `deps.aiComplete`（`({system,user,temperature,maxTokens}) => Promise<{content}>`）
   * 与 `deps.aiKeyPath`，从而**永远不会真的打网络**。
   */
  async function handleScheduleParse(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;

    const rawText = body.payload?.text;
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      return sendJson(res, 400, {
        ok: false,
        error: 'schedule-parse-empty',
        detail: '先把要识别的那段话贴进来。',
      });
    }
    const text = rawText.trim().slice(0, SCHEDULE_PARSE_MAX_CHARS);
    const now = typeof deps.now === 'function' ? deps.now() : new Date();

    // 通道：测试注入优先；否则读密钥 + 真调 Paratera
    let complete = null;
    if (typeof deps.aiComplete === 'function') {
      complete = deps.aiComplete;
    } else {
      const key = await readParateraKey(deps.aiKeyPath);
      if (!key.ok) {
        return sendJson(res, 503, {
          ok: false,
          error: key.reason,
          detail: '没有读到 Paratera 密钥（~/.dsh/.credentials.yaml 的 refs.PARATERA_API_KEY），智能识别暂不可用；手填表单不受影响。',
        });
      }
      complete = (input) => callParatera({ ...input, key: key.key });
    }

    let answer;
    try {
      answer = await complete({
        system: SCHEDULE_PARSE_SYSTEM,
        user: buildScheduleParsePrompt(text, now),
        temperature: 0.2,
        maxTokens: 800,
      });
    } catch (error) {
      // 注入的 aiComplete 抛错也按「通道不通」处理；日志只记错误类型，不含密钥/原文
      log.error?.('[study-assistant] /schedule/parse 调用失败：', String(error?.message ?? error).slice(0, 160));
      return sendJson(res, 502, {
        ok: false,
        error: 'ai-unavailable',
        detail: 'AI 通道没通（超时 / 限流 / 网络），这次没有识别结果，表单保持空白。',
      });
    }
    if (answer === null || answer === undefined) {
      return sendJson(res, 502, { ok: false, error: 'ai-unavailable', detail: 'AI 通道没有返回内容。' });
    }
    if (answer.ok === false) {
      return sendJson(res, 502, {
        ok: false,
        error: typeof answer.error === 'string' ? answer.error : 'ai-unavailable',
        detail: typeof answer.detail === 'string' ? answer.detail : '',
      });
    }

    const content = typeof answer.content === 'string' ? answer.content : '';
    const parsed = parseScheduleDraft(content, text, now);
    if (!parsed.ok) {
      return sendJson(res, 502, { ok: false, error: parsed.reason, detail: parsed.detail });
    }
    return sendJson(res, 200, {
      ok: true,
      draft: parsed.draft,
      model: AI_MODEL,
    });
  }

  // ---------------------------------------------------------------------------
  // 学习行为 + 掌握度（v2-B 卡，2026-11-20）
  //
  // 三份数据的边界（任务卡 ② 讲了为什么，这里再钉一遍）：
  //   - `学习行为.json`（第 16 份）只存**行为**：打开几次、首次/最后时间、累计分钟（本步恒 0）、
  //     掌握度是算法算的还是人改的。**它不含等级**。
  //   - `知识点网络.json` 的 `mastery` 是**掌握等级的唯一真源**（面板、章节统计、复习提醒、导出都读它）。
  //   - 人改过的（`masterySource: 'manual'`）算法一律跳过；算法**不自动降级**。
  //
  // 两条写路由都过 `writePreflight`（Content-Type + X-Study-Request + 来源），
  // 都经 `store.writeDocument`（每文档串行队列 + 原子替换 + 写前自动进 学习台/备份/）。
  // ---------------------------------------------------------------------------

  /** 现在几点。测试可注入 `deps.now`（与 /remind、/schedule/parse 同一口径）。 */
  function clockNow() {
    return typeof deps.now === 'function' ? deps.now() : new Date();
  }

  /**
   * 读一份文档；缺文件按默认空结构（`missing` 是正常状态，不是损坏）。
   * 损坏（JSON 坏了/结构不符）不回落到默认值：**拒绝在坏文件上继续写**，与 /mutate 同口径。
   */
  async function readOrEmpty(key) {
    const read = await store.readDocument(key);
    if (!read.ok && read.reason !== 'missing') return { ok: false, reason: read.reason };
    return { ok: true, doc: read.ok ? read.doc : defaultDoc(key), hash: read.ok ? read.hash : null };
  }

  /**
   * `POST /assistant/behavior`：记一次「打开了某个知识点」（**新建接口**，v2-B 卡）。
   *
   * 入参 `{nodeId}`。做三件事，顺序不能反：
   *   1. 记访问：`visitCount + 1`、首次开始时间首次填、最后学习时间 = 现在。
   *      **同一分钟内重复上报不计数**（`recorded:false`）—— 前端一次打开可能连发几次，
   *      按分钟去重比前端节流更可靠（前端另有一层 5 秒节流，两层一起兜）。
   *   2. 算掌握度：拿**刚更新过的行为** + 现有 `learned` 批注，算建议等级（纯函数，见 lib/mastery.js）。
   *   3. 先写行为文档、再写知识网络（**只在真的变了时才写**）。顺序这么定是因为：
   *      万一第二步写冲突，最坏情况是「这个点被标成 manual」——方向安全；
   *      反过来先写网络、后写行为失败，就会留下「等级变了但保护没立起来」的坏状态。
   *
   * `totalMinutes` 本步恒 0：停留时长是第二步的埋点，这里**不造假时长**。
   *
   * 失败码：400 `bad-payload` / `bad-node-id`；404 `unknown-node`；409 冲突或文件损坏；422 结构被拒。
   */
  async function handleAssistantBehavior(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (!isPlainObject(payload)) return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    if (!isValidId(payload.nodeId)) return sendJson(res, 400, { ok: false, error: 'bad-node-id' });

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) return sendJson(res, 409, { ok: false, error: net.reason, key: 'knowledgeNetwork' });
    const nodes = Array.isArray(net.doc.nodes) ? net.doc.nodes : [];
    const node = nodes.find((item) => isPlainObject(item) && item.id === payload.nodeId);
    // 未知 nodeId 明确 404（而不是静默忽略）：静默会让前端以为「记上了」，实际一个字节都没写
    if (node === undefined) return sendJson(res, 404, { ok: false, error: 'unknown-node', nodeId: payload.nodeId });

    const nowIso = clockNow().toISOString();
    const current = clampMastery(node.mastery);

    const stored = await readOrEmpty('learningBehavior');
    if (!stored.ok) return sendJson(res, 409, { ok: false, error: stored.reason, key: 'learningBehavior' });
    const before = behaviorOf(stored.doc, payload.nodeId);
    const visit = recordVisit(before, nowIso);

    if (!visit.counted) {
      // 同一分钟内重复打开：不写盘（连备份都不留），如实回「这次没算」
      return sendJson(res, 200, {
        ok: true,
        nodeId: payload.nodeId,
        counted: false,
        reason: visit.reason,
        visitCount: before.visitCount,
        firstLearnedAt: before.firstLearnedAt,
        lastLearnedAt: before.lastLearnedAt,
        totalMinutes: before.totalMinutes,
        mastery: { from: current, to: current, changed: false },
      });
    }

    const nodesNext = { ...(isPlainObject(stored.doc.nodes) ? stored.doc.nodes : {}), [payload.nodeId]: visit.behavior };
    const behaviorNext = { ...stored.doc, nodes: nodesNext };

    // 算法：在「刚更新过的行为」上算，仅是算，还没落盘
    const annotations = await readOrEmpty('annotations');
    const applied = applySuggestedMastery(net.doc, behaviorNext, annotations.ok ? annotations.doc : { version: 1, notes: [] }, { nowIso });

    // 1) 先落行为
    const wroteBehavior = await store.writeDocument('learningBehavior', behaviorNext, {
      expectedHash: stored.hash,
      backupKeep: deps.backupKeep,
    });
    if (!wroteBehavior.ok) {
      const status = wroteBehavior.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: wroteBehavior.reason, key: 'learningBehavior' });
    }

    // 2) 有变更才落网络（没变更就一个字节都不动）
    let to = current;
    let changed = false;
    let result = null;
    let networkHash = null;
    if (applied.changes.length > 0) {
      const wroteNetwork = await store.writeDocument('knowledgeNetwork', applied.network, {
        expectedHash: net.hash,
        backupKeep: deps.backupKeep,
      });
      if (wroteNetwork.ok) {
        changed = true;
        result = applied.changes.find((item) => item.nodeId === payload.nodeId) ?? null;
        to = result?.to ?? current;
        networkHash = wroteNetwork.hash;
      } else {
        // 行为已经记上了，只是这次没推进等级；下次打开同一个点会再算一遍（算法是幂等的）
        log.warn?.(`[study-assistant] 掌握度自动推进没写成（${wroteNetwork.reason}），行为已记、下次再算`);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      nodeId: payload.nodeId,
      counted: true,
      visitCount: visit.behavior.visitCount,
      firstLearnedAt: visit.behavior.firstLearnedAt,
      lastLearnedAt: visit.behavior.lastLearnedAt,
      totalMinutes: visit.behavior.totalMinutes,
      behaviorHash: wroteBehavior.hash,
      mastery: { from: current, to, changed },
      // 掌握度真被推进时才回：前端据此丢掉旧 hash、刷新一次数据（没变就不打扰界面）
      ...(networkHash !== null ? { networkHash } : {}),
    });
  }

  /**
   * `POST /assistant/mastery`：把某个知识点的掌握度**落库**（**新建接口**，v2-B 卡）。
   *
   * ⚠️ 这是本卡最容易被违规的一处：**预览与落库必须分成两步**。
   *   1. `/assistant/reply` 只解析意图、回预览（一个字节都不写）；
   *   2. 用户点「确认修改」后，前端才带 `confirm: true` 调这里。
   * 所以：**没有 `confirm: true` 一律 400 `confirm-required`，绝不落库** ——
   * 这是机器保证，不是靠自觉。
   *
   * 落库时写两处：
   *   - `知识点网络.json` 的 `mastery`（等级唯一真源），走 `normalizeKnowledgeNode`，
   *     所以「变了才刷 reviewedAt」与面板改掌握度是**同一套口径**；
   *   - `学习行为.json` 的 `masterySource: 'manual'` —— 从此算法不再动这个点（尊重人的修改）。
   *
   * 同档（from === to）：网络一个字不写、reviewedAt 不刷（与面板同口径），但仍然记 manual，
   * 因为「人明确说了它是这一档」本身就是一条要保留的判断。
   *
   * 失败码：400 `bad-payload`/`bad-node-id`/`bad-mastery`/`confirm-required`；404 `unknown-node`；409 损坏/冲突。
   */
  async function handleAssistantMastery(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (!isPlainObject(payload)) return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    if (!isValidId(payload.nodeId)) return sendJson(res, 400, { ok: false, error: 'bad-node-id' });
    if (!Number.isInteger(payload.mastery) || payload.mastery < KNOWLEDGE_MASTERY_MIN || payload.mastery > KNOWLEDGE_MASTERY_MAX) {
      return sendJson(res, 400, {
        ok: false,
        error: 'bad-mastery',
        detail: `掌握度只能是 ${KNOWLEDGE_MASTERY_MIN}–${KNOWLEDGE_MASTERY_MAX} 的整数。`,
      });
    }
    if (payload.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: 'confirm-required',
        detail: '这是写操作：先在对话里展示预览，用户点「确认修改」后才带 confirm:true 再请求一次。',
      });
    }

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) return sendJson(res, 409, { ok: false, error: net.reason, key: 'knowledgeNetwork' });
    const list = Array.isArray(net.doc.nodes) ? [...net.doc.nodes] : [];
    const index = findIndexById(list, payload.nodeId);
    if (index === -1) return sendJson(res, 404, { ok: false, error: 'unknown-node', nodeId: payload.nodeId });

    const existing = list[index];
    const from = clampMastery(existing.mastery);
    const to = payload.mastery;
    const nodeName = typeof existing.name === 'string' ? existing.name : '';

    const nowIso = clockNow().toISOString();
    // 1) 先立「manual」这面旗：算法从此跳过这个点。哪怕下一步写网络失败，方向也是安全的。
    const stored = await readOrEmpty('learningBehavior');
    if (!stored.ok) return sendJson(res, 409, { ok: false, error: stored.reason, key: 'learningBehavior' });
    const record = { ...behaviorOf(stored.doc, payload.nodeId), masterySource: 'manual', masteryUpdatedAt: nowIso };
    const behaviorNext = {
      ...stored.doc,
      nodes: { ...(isPlainObject(stored.doc.nodes) ? stored.doc.nodes : {}), [payload.nodeId]: record },
    };
    const wroteBehavior = await store.writeDocument('learningBehavior', behaviorNext, {
      expectedHash: stored.hash,
      backupKeep: deps.backupKeep,
    });
    if (!wroteBehavior.ok) {
      const status = wroteBehavior.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: wroteBehavior.reason, key: 'learningBehavior' });
    }

    // 2) 等级有变才写网络（同档不写：沿用面板「同档不刷 reviewedAt」）
    if (from === to) {
      return sendJson(res, 200, {
        ok: true,
        nodeId: payload.nodeId,
        nodeName,
        from,
        to,
        changed: false,
        masterySource: 'manual',
        detail: '本来就是这个等级，等级与复习时间都没动；只记下了「这是人定的」。',
        behaviorHash: wroteBehavior.hash,
      });
    }

    const normalized = normalizeKnowledgeNode({ mastery: to }, existing);
    if (!normalized.ok) return sendJson(res, 400, { ok: false, error: normalized.reason });
    // `normalizeKnowledgeNode` 里「变了才刷 reviewedAt」用的是真实时钟；这里用注入的时钟覆盖，
    // 口径不变（仍然只在等级真的变了才刷），但测试/回执里的时间与其它写路由同一份。
    normalized.item.reviewedAt = nowIso;
    list[index] = normalized.item;
    const wroteNetwork = await store.writeDocument('knowledgeNetwork', { ...net.doc, nodes: list }, {
      expectedHash: net.hash,
      backupKeep: deps.backupKeep,
    });
    if (!wroteNetwork.ok) {
      const status = wroteNetwork.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: wroteNetwork.reason, key: 'knowledgeNetwork' });
    }

    return sendJson(res, 200, {
      ok: true,
      nodeId: payload.nodeId,
      nodeName,
      from,
      to,
      changed: true,
      masterySource: 'manual',
      reviewedAt: list[index].reviewedAt ?? null,
      behaviorHash: wroteBehavior.hash,
      networkHash: wroteNetwork.hash,
    });
  }

  /**
   * `POST /assistant/mastery-batch`：一批掌握度**落库**（**新建接口**，v2-B2 卡）。
   *
   * 与单点 `/assistant/mastery` 是**同一套红线**：没有 `confirm: true` 一律 400 `confirm-required`。
   * 预览已经在 `/assistant/reply` 里给过了（清单 + 每条的「从几改到几」），这里只管写。
   *
   * 一次请求只写**两次盘**（不是每条一次）：
   *   1. 先写 `学习行为.json`：把这一批的 `masterySource` **逐条**立成 `manual`（算法从此跳过）；
   *      同档也立旗 —— 与单点路由同口径（「人明确说了它是这一档」本身是要保留的判断）。
   *   2. 再写 `知识点网络.json`：只对「等级真的变了」的节点写 `mastery`（同档不写、不刷 reviewedAt）。
   * 顺序不能反：最坏情况只是「这批点被标成 manual」，方向安全；反过来会留下「等级变了但保护没立」。
   *
   * 容错：某一条 id 不合法 / 节点不存在 / 等级越界 → 那一条算**失败**，其余照常处理，
   * 回执如实给「成功 M / 失败 K」（绝不谎报全成功）。**整批取消**是前端的事：
   * 取消只是丢弃本地 `proposedAction`，不发请求 —— 到了这里就说明用户点了「确认修改」。
   *
   * 失败码：400 `bad-payload`/`confirm-required`/`no-valid-items`；409 冲突或文件损坏；422 结构被拒。
   */
  async function handleAssistantMasteryBatch(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const payload = body.payload;
    if (!isPlainObject(payload)) return sendJson(res, 400, { ok: false, error: 'bad-payload' });
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'bad-payload', detail: 'items 必须是非空数组。' });
    }
    if (payload.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: 'confirm-required',
        detail: '这是写操作：先在对话里展示清单预览，用户点「确认修改」后才带 confirm:true 再请求一次。',
      });
    }

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) return sendJson(res, 409, { ok: false, error: net.reason, key: 'knowledgeNetwork' });
    const stored = await readOrEmpty('learningBehavior');
    if (!stored.ok) return sendJson(res, 409, { ok: false, error: stored.reason, key: 'learningBehavior' });

    const list = Array.isArray(net.doc.nodes) ? [...net.doc.nodes] : [];
    const indexById = new Map();
    list.forEach((node, at) => {
      if (isPlainObject(node) && typeof node.id === 'string' && node.id !== '') indexById.set(node.id, at);
    });

    // 先逐条校验：不合法的进 failures（带上 index，前端能对应到清单第几条），合法的才进 accepted
    const failures = [];
    const accepted = [];
    const seenIds = new Set();
    payload.items.forEach((item, at) => {
      if (!isPlainObject(item)) {
        failures.push({ index: at, nodeId: null, reason: 'bad-item' });
        return;
      }
      if (!isValidId(item.nodeId)) {
        failures.push({ index: at, nodeId: item.nodeId ?? null, reason: 'bad-node-id' });
        return;
      }
      if (!Number.isInteger(item.mastery) || item.mastery < KNOWLEDGE_MASTERY_MIN || item.mastery > KNOWLEDGE_MASTERY_MAX) {
        failures.push({ index: at, nodeId: item.nodeId, reason: 'bad-mastery' });
        return;
      }
      if (!indexById.has(item.nodeId)) {
        failures.push({ index: at, nodeId: item.nodeId, reason: 'unknown-node' });
        return;
      }
      // 同一个 id 送了两遍：按第一条算，不重复写（也不当成失败）
      if (seenIds.has(item.nodeId)) return;
      seenIds.add(item.nodeId);
      accepted.push({ nodeId: item.nodeId, mastery: item.mastery });
    });

    if (accepted.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'no-valid-items', failed: failures.length, failures });
    }

    const nowIso = clockNow().toISOString();

    // 1) 先立「manual」这面旗（**一批一次写盘**；同档也立）
    const behaviorNodes = { ...(isPlainObject(stored.doc.nodes) ? stored.doc.nodes : {}) };
    for (const item of accepted) {
      behaviorNodes[item.nodeId] = {
        ...behaviorOf(stored.doc, item.nodeId),
        masterySource: 'manual',
        masteryUpdatedAt: nowIso,
      };
    }
    const wroteBehavior = await store.writeDocument('learningBehavior', { ...stored.doc, nodes: behaviorNodes }, {
      expectedHash: stored.hash,
      backupKeep: deps.backupKeep,
    });
    if (!wroteBehavior.ok) {
      const status = wroteBehavior.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, { ok: false, error: wroteBehavior.reason, key: 'learningBehavior' });
    }

    // 2) 等级真的变了的才写网络（同档不写：沿用面板「同档不刷 reviewedAt」）
    const changed = accepted.filter((item) => clampMastery(list[indexById.get(item.nodeId)].mastery) !== item.mastery);
    const skipped = accepted.length - changed.length;
    const appliedIds = new Set();
    let normalizeFailed = 0;
    let networkHash = null;
    if (changed.length > 0) {
      const nextList = [...list];
      for (const item of changed) {
        const at = indexById.get(item.nodeId);
        const normalized = normalizeKnowledgeNode({ mastery: item.mastery }, nextList[at]);
        if (normalized.ok !== true) {
          failures.push({ nodeId: item.nodeId, reason: normalized.reason });
          normalizeFailed += 1;
          continue;
        }
        // 「变了才刷 reviewedAt」用的是真实时钟；这里用注入的时钟覆盖（与单点路由同一份口径）
        normalized.item.reviewedAt = nowIso;
        nextList[at] = normalized.item;
        appliedIds.add(item.nodeId);
      }
      if (appliedIds.size > 0) {
        const wroteNetwork = await store.writeDocument('knowledgeNetwork', { ...net.doc, nodes: nextList }, {
          expectedHash: net.hash,
          backupKeep: deps.backupKeep,
        });
        if (!wroteNetwork.ok) {
          const status = wroteNetwork.reason === 'conflict' ? 409 : 422;
          return sendJson(res, status, {
            ok: false,
            error: wroteNetwork.reason,
            key: 'knowledgeNetwork',
            // 如实：manual 旗已经立上了，等级没写进去（重试一次即可，这批点不会被动回退）
            manualFlagsWritten: accepted.length,
            detail: '「人改过」的标记已立、等级没写进去；重试一次即可（这批点不会被动回退）。',
          });
        }
        networkHash = wroteNetwork.hash;
      }
    }

    // 3) 逐条结果 + 如实计数（成功 = 收到且没被拒的；失败 = failures 的条数）
    const results = accepted.map((item) => {
      const node = list[indexById.get(item.nodeId)];
      const from = clampMastery(node.mastery);
      return {
        nodeId: item.nodeId,
        nodeName: typeof node.name === 'string' ? node.name : '',
        from,
        to: item.mastery,
        changed: appliedIds.has(item.nodeId),
      };
    });

    return sendJson(res, 200, {
      ok: true,
      requested: payload.items.length,
      succeeded: accepted.length - normalizeFailed,
      changed: appliedIds.size,
      skipped,
      failed: failures.length,
      failures,
      results,
      behaviorHash: wroteBehavior.hash,
      ...(networkHash !== null ? { networkHash } : {}),
    });
  }

  /**
   * 单点预览体（`kind: 'set-mastery'`）。单点命令与「同理」继承单点时**共用这一份形状**，
   * 前端只认这一个 kind 就够了（不用为「继承来的单点」再写一套渲染）。
   *
   * @param {{level: number, nodeId: string, nodeName: string}} intent
   * @param {object} netDoc `知识点网络.json`
   * @param {string} [intro] 前置话术（「同理」继承时用来交代「接着上一条哪句」）
   */
  function buildSingleMasteryPreview(intent, netDoc, intro = '') {
    const nodes = Array.isArray(netDoc.nodes) ? netDoc.nodes : [];
    const node = nodes.find((item) => isPlainObject(item) && item.id === intent.nodeId);
    if (node === undefined) {
      return { ok: true, reply: `${intro}那个点现在不在知识点网络里了（可能被删掉了），这次没改。` };
    }
    const from = clampMastery(node.mastery);
    const name = typeof node.name === 'string' && node.name !== '' ? node.name : intent.nodeName;
    return {
      ok: true,
      reply: `${intro}${describeMasteryPreview(name, from, intent.level)}（还没改：点下面的「确认修改」才落库。）`,
      proposedAction: {
        kind: 'set-mastery',
        nodeId: intent.nodeId,
        nodeName: name,
        from,
        to: intent.level,
        fromLabel: masteryLabel(from),
        toLabel: masteryLabel(intent.level),
      },
    };
  }

  /**
   * 批量清单预览体（`kind: 'set-mastery-batch'`）：单点与批量各走各的 kind，前端分开渲染。
   *
   * `nodes` 只放**需要改**的节点（已是目标等级的在 `skipped`，不白写盘）；
   * 数组**不截断**（用户 m00484 拍板「批量不限条数」），折叠成「前 5 个 + 共 N 个」是前端的事。
   */
  function buildBatchPreview(intent, plan, intro = '') {
    if (plan.nodes.length === 0) {
      return {
        ok: true,
        reply: `${intro}「${plan.targetLabel}」里的 ${plan.total} 个知识点已经是 ${masteryLabel(plan.level)} 了，不用改（也没写盘）。`,
      };
    }
    return {
      ok: true,
      reply: `${intro}${describeMasteryBatchPreview(plan.targetLabel, plan.total, plan.skipped, plan.level)}（还没改：点下面的「确认修改」才落库。）`,
      proposedAction: {
        kind: 'set-mastery-batch',
        level: intent.level,
        toLabel: masteryLabel(intent.level),
        range: plan.scope,
        targetLabel: plan.targetLabel,
        nodes: plan.nodes,
        skipped: plan.skipped,
        total: plan.total,
      },
    };
  }

  /**
   * 「经聊天改掌握度」的**第一步**：只解析 + 只回预览，**一个字节都不写**。
   *
   * 返回 `null` = 这句话不是改掌握度的命令（交回给模型正常答疑）。
   * 命中时故意**不调用模型**：这类命令的答复必须与库里的事实严格一致，
   * 让模型「嘴上答应」很容易变成「说改了、其实没改」——那是最坏的一种谎。
   *
   * 落库只发生在 `/assistant/mastery`（用户点「确认修改」后带 `confirm:true` 再请求一次）。
   *
   * v2-B2（2026-11-21）：范围批量（今天学过的 / 某一整章）与「同理」各自有专门的一步处理，
   * 这里遇到它们就返回 `null` 让位 —— 否则单点解析会拿「今天学过的」当节点名，
   * 回一句「没找到对应那个点」把批量挡在后面（卡 ④ 要求批量排在单点预览之后，靠的就是这个让位）。
   */
  async function buildMasteryPreview(checked) {
    const lastUser = checked.messages[checked.messages.length - 1]?.content ?? '';
    if (looksLikeInheritCommand(lastUser)) return null;
    if (looksLikeMasteryBatchCommand(lastUser)) return null;
    if (!looksLikeMasteryCommand(lastUser)) return null;

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) {
      return { ok: true, reply: `知识点网络现在读不出来（${net.reason}），这次没改，稍后再试一次。` };
    }
    const intent = parseMasteryIntent(lastUser, net.doc, { nodeId: checked.context?.nodeId ?? null });

    if (intent.ok) return buildSingleMasteryPreview(intent, net.doc);
    if (intent.reason === 'ambiguous') {
      const names = (intent.candidates ?? [])
        .map((item) => `${item.name}${item.chapter ? `（${item.chapter}）` : ''}`)
        .join('、');
      return { ok: true, reply: `这句里有好几个知识点对得上：${names}。说清是哪一个我再改。` };
    }
    if (intent.reason === 'no-node') {
      return { ok: true, reply: '没在知识点网络里找到对应那个点。说全一点（带上课名或章名），或者先在知识页点开它再说一次。' };
    }
    if (intent.reason === 'network-unavailable') {
      return { ok: true, reply: '知识点网络里还没有节点，这次没改。' };
    }
    // no-level / no-command：不是命令，交回给模型正常答疑
    return null;
  }

  /**
   * 「同理 / 同上 / 也一样」的**继承**：从 `messages` 回看上一条有效掌握度命令（卡 ⑥.2）。
   *
   * 为什么要纯后端回看：前端每次发的是**全量历史**（`payload = { messages: history.map(...) }`），
   * 后端天然拿得到全部轮次；改成「前端另存一条命令快照」反而多一份会丢的状态。
   *
   * 继承的是**范围定义**（单点 nodeId，或「今天学过的」/「某一章」这种范围），
   * 批量范围会按**当前**重新筛（「今天学过的」集合会随时间变，卡 ⑧ 第 2 点）。
   *
   * 找不到上一条命令时回提示语（卡 ⑧ 第 1 点选的默认），不静默当普通提问 ——
   * 「你说了同理，但我没得可继承」必须让用户看见，否则他会以为改了。
   */
  async function buildInheritedMasteryPreview(checked) {
    const lastUser = checked.messages[checked.messages.length - 1]?.content ?? '';
    if (!looksLikeInheritCommand(lastUser)) return null;

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) {
      return { ok: true, reply: `知识点网络现在读不出来（${net.reason}），这次没改，稍后再试一次。` };
    }
    const behavior = await readOrEmpty('learningBehavior');
    if (!behavior.ok) {
      return { ok: true, reply: `学习行为现在读不出来（${behavior.reason}），这次没改，稍后再试一次。` };
    }
    const courses = await readOrEmpty('courses');

    const inherited = resolveInheritedCommand(checked.messages, net.doc, behavior.doc, {
      courses: courses.ok ? courses.doc.courses : [],
      now: clockNow(),
      timeZone: deps.timeZone,
    });

    if (inherited.ok !== true) {
      return { ok: true, reply: '上一条没有可继承的改动，请说明把哪个知识点改成什么等级。' };
    }

    // 只引用上一条的前 40 个字：让用户确认「继承的到底是哪一句」，又不把整段历史复述一遍
    const sourceText = String(inherited.sourceText).replace(/\s+/g, ' ').trim().slice(0, 40);
    const intro = `接着上一条「${sourceText}」：`;

    if (inherited.scope.kind === 'single') {
      return buildSingleMasteryPreview({
        level: inherited.level,
        nodeId: inherited.scope.nodeId,
        nodeName: inherited.scope.nodeName,
      }, net.doc, intro);
    }

    const plan = buildMasteryBatchPlan(inherited.level, inherited.scope, net.doc, behavior.doc, {
      now: clockNow(),
      timeZone: deps.timeZone,
    });
    if (plan.ok !== true) {
      return {
        ok: true,
        reply: plan.reason === 'empty-today'
          ? `${intro}今天还没有记录到学过的知识点，这次没改。`
          : `${intro}那一章没找到节点，这次没改。`,
      };
    }
    return buildBatchPreview(inherited, plan, intro);
  }

  /**
   * 「今天学过的 / 某一整章」这类**范围批量**命令的第一步：只回清单预览，一个字节都不写。
   *
   * 返回 `null` = 不是范围批量命令（交回给模型，或者前面单点那一步已经接走了）。
   * 每种「筛出 0 个 / 章节多义」都回一句人话、并明确「这次没改」，不制造「好像改了」的错觉。
   */
  async function buildMasteryBatchPreview(checked) {
    const lastUser = checked.messages[checked.messages.length - 1]?.content ?? '';
    if (!looksLikeMasteryBatchCommand(lastUser)) return null;

    const net = await readOrEmpty('knowledgeNetwork');
    if (!net.ok) {
      return { ok: true, reply: `知识点网络现在读不出来（${net.reason}），这次没改，稍后再试一次。` };
    }
    const behavior = await readOrEmpty('learningBehavior');
    if (!behavior.ok) {
      return { ok: true, reply: `学习行为现在读不出来（${behavior.reason}），这次没改，稍后再试一次。` };
    }
    const courses = await readOrEmpty('courses');

    const scope = parseMasteryBatchScope(lastUser, net.doc, { courses: courses.ok ? courses.doc.courses : [] });
    if (scope.ok !== true) {
      if (scope.reason === 'ambiguous-chapter') {
        const names = (scope.candidates ?? [])
          .map((item) => `${item.chapter}${item.courseName ? `（${item.courseName}）` : ''}·${item.nodeCount} 个`)
          .join('、');
        return {
          ok: true,
          reply: `「一整章」对得上的有好几章：${names}。说清是哪一门课的那一章（或带上章名），我再列清单。`,
        };
      }
      if (scope.reason === 'no-chapter') {
        return { ok: true, reply: '没找到你说的那一章，说清章号或章名（可以带上课名），我再列清单。' };
      }
      // no-range / no-level / no-command：不是范围批量命令，交回给模型
      return null;
    }

    const plan = buildMasteryBatchPlan(scope.level, scope.scope, net.doc, behavior.doc, {
      now: clockNow(),
      timeZone: deps.timeZone,
    });
    if (plan.ok !== true) {
      return {
        ok: true,
        reply: plan.reason === 'empty-today'
          ? '今天还没有记录到学过的知识点（学习行为里今天一条都没有），没法批量改。'
          : '这一章没找到节点，这次没改。说清章号或章名再试一次。',
      };
    }
    return buildBatchPreview(scope, plan);
  }

  /**
   * v2-D（2026-11-22）：现读 `学习台` 五份只读文档，拼一段「学习画像」。
   *
   * 只读，不写任何文档；`学习台` 数据坏了/缺了都当空处理 —— 画像只是让回答更贴合的增强，
   * 绝不能因为读盘失败把一次答疑变成 409/500。身份拿不到时**连读盘都不做**，
   * 这样「没有身份」的部署与 v2-A 的 system 逐字一致。
   */
  async function readPersonaHint(context) {
    const studentName = typeof deps.studentName === 'string' ? deps.studentName.trim() : '';
    if (studentName === '') return '';
    const keys = ['term', 'courses', 'learningBehavior', 'knowledgeNetwork', 'annotations'];
    const docs = {};
    await Promise.all(keys.map(async (key) => {
      try {
        const read = await readOrEmpty(key);
        docs[key] = read.ok === true ? read.doc : null;
      } catch {
        docs[key] = null;
      }
    }));
    try {
      return buildPersonaHint({
        studentName,
        studentId: deps.studentId,
        term: docs.term,
        courses: docs.courses,
        behavior: docs.learningBehavior,
        network: docs.knowledgeNetwork,
        annotations: docs.annotations,
        context,
      });
    } catch {
      return '';
    }
  }

  /**
   * `POST /assistant/reply`：面板浮层的多轮答疑（2026-11-19 MVP 卡，**新建接口**）。
   *
   * 与 `/schedule/parse` 同一条纪律：过写请求前置校验（它同样是从面板触发的、
   * 会花掉一次额度的动作），但**磁盘一个字节都不动** —— MVP 不落盘，
   * `conversationId` / `persist` 除了类型校验之外既不读也不存。
   *
   * 失败码（与卡里的契约一一对应）：
   *   - 入参不合法        → 400 `bad-request`
   *   - 读不到密钥        → 503 `assistant-key-missing`
   *   - 通道不通/超时/空回 → 502 `assistant-unavailable`（detail 只留错误类型 / HTTP 码）
   *
   * 测试注入两个口子，都不碰真密钥、不真打网络：
   *   `deps.assistantChat`（整体桩，`({messages,maxTokens,temperature}) => Promise<{content}>`）
   *   `deps.assistantFetch`（只换网络那层，用来验密钥读取与真实 `callMagpie` 链路）。
   *
   * v2-A（界面上下文）：请求体可带可选 `context`。它只被归一成一句 `【当前界面】…`
   * 并拼进 system（`buildContextHint` + `mergeContextHint`），**不写响应、不写日志**；
   * `context` 为空/非法时 messages 与 MVP 完全一致（连一条 system 都不会多出来）。
   */
  async function handleAssistantReply(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;

    const checked = validateAssistantMessages(body.payload);
    if (!checked.ok) {
      return sendJson(res, 400, { ok: false, error: 'bad-request', detail: checked.detail });
    }

    // v2-C（2026-11-21）：命中 conversationId 才落盘 + 走上下文压缩。
    // 不带 conversationId 维持 MVP「纯答疑、不落盘」—— 兼容现有测试与调用方。
    const rawConversationId = body.payload.conversationId;
    const conversationId = typeof rawConversationId === 'string' && rawConversationId.trim() !== ''
      ? rawConversationId.trim()
      : null;

    // 界面上下文只影响喂给模型的 system，不参与响应组装（A1 隐式）
    const contextHint = buildContextHint(checked.context);

    // v2-B（2026-11-20）：「把 X 设为精通」这类**命令**先在这里接住 —— 只回预览、不落库。
    // 命中时不调模型（省一次额度，也避免模型说出与库不一致的话）；没命中就照常答疑。
    //
    // v2-B2（2026-11-21）三步顺序（卡 ④ / ⑥.2）：
    //   1. 「同理」继承（要回看历史，必须排在解析当前这句之前）；
    //   2. 单点预览（它遇到范围批量会返回 null 让位）；
    //   3. 范围批量预览（今天学过的 / 某一整章）。
    const inheritedPreview = await buildInheritedMasteryPreview(checked);
    if (inheritedPreview !== null) return sendJson(res, 200, inheritedPreview);

    const masteryPreview = await buildMasteryPreview(checked);
    if (masteryPreview !== null) return sendJson(res, 200, masteryPreview);

    const batchPreview = await buildMasteryBatchPreview(checked);
    if (batchPreview !== null) return sendJson(res, 200, batchPreview);

    // v2-D（2026-11-22）：学习画像在三条预览都放过之后才读盘 —— 命令类回答不该白读一份画像。
    // 画像与界面提示按顺序合成**一段** system 前缀；两者都为空时 messages 与 v2-A 逐字一致。
    const personaHint = await readPersonaHint(checked.context);
    // v2-E（2026-11-22）：专注学习模式才追加「学习搭子」人设；非专注时 buildStudyModePersona 返回空串，
    // 合成结果与 v2-A / v2-D 逐字一致。画像与人设都只进这条 system，不进响应体、不进日志。
    const studyPersona = buildStudyModePersona(checked.context);
    const systemHint = [personaHint, studyPersona, contextHint].filter((item) => item !== '').join('\n');
    const messages = mergeContextHint(checked.messages, systemHint);

    // 压缩摘要也复用同一个 chat：先把 chat 取到手（注入桩优先），摘要失败可降级。
    let chat = null;
    if (typeof deps.assistantChat === 'function') {
      chat = deps.assistantChat;
    } else {
      const key = await readMagpieKey(deps.assistantKeyPath);
      if (!key.ok) {
        return sendJson(res, 503, {
          ok: false,
          error: 'assistant-key-missing',
          detail: key.reason === 'assistant-key-unreadable'
            ? '凭据文件读不出来（~/.dsh/.credentials.yaml），学习助手暂不可用。'
            : '没有读到 magpie 密钥（~/.dsh/.credentials.yaml 的 refs.MAGPIE_GATEWAY_KEY），学习助手暂不可用。',
        });
      }
      chat = (input) => callMagpie({ ...input, key: key.key, fetchImpl: deps.assistantFetch ?? fetch });
    }

    // v2-C：带 conversationId 时，历史以**磁盘会话**为准（避免前端全量和磁盘各存一份口径不一致）。
    // 只取请求里最后一条 user 消息作为「这一轮的新提问」；历史用压缩后的 [摘要 + 近 N 轮]。
    let session = null;
    let sendMessages = messages;
    let newUserContent = null;
    if (conversationId !== null) {
      session = await readSession(dataDir, conversationId);
      const lastUser = checked.messages[checked.messages.length - 1];
      newUserContent = lastUser !== null && lastUser !== undefined ? lastUser.content : null;
      if (session === null) {
        // 会话不存在（首轮带 id 或前端未先 new）：用空骨架兜底，落盘时由 appendMessages 追加并自动命名
        session = {
          id: conversationId,
          title: '新会话',
          titleCustom: false,
          createdAt: clockNow().toISOString(),
          updatedAt: clockNow().toISOString(),
          summary: '',
          summaryUpTo: 0,
          archived: false,
          messages: [],
        };
        // 送模型的就是这一条新提问（历史为空）
        const withNew = newUserContent !== null
          ? [{ role: 'user', content: newUserContent }]
          : [];
        sendMessages = mergeContextHint(withNew, systemHint);
      } else {
        // 已有会话：历史以磁盘为准，只把「新一轮 user」接到压缩视图后面
        const historyView = buildSendMessages(session);
        const withNew = newUserContent !== null
          ? historyView.concat([{ role: 'user', content: newUserContent }])
          : historyView;
        sendMessages = mergeContextHint(withNew, systemHint);
      }
    }

    let answer;
    try {
      answer = await chat({ messages: sendMessages, maxTokens: checked.maxTokens, temperature: 0.3 });
    } catch (error) {
      // 注入的桩抛错也按「通道不通」处理；日志只记错误类型，不含密钥/原文
      log.warn?.(`[study-assistant] /assistant/reply 调用失败：${String(error?.name ?? 'Error')}`);
      return sendJson(res, 502, {
        ok: false,
        error: 'assistant-unavailable',
        detail: '通道没通（超时 / 限流 / 网络），这次没有回复。',
      });
    }
    if (answer === null || answer === undefined || answer.ok === false) {
      const detail = typeof answer?.detail === 'string' && answer.detail !== ''
        ? answer.detail
        : '通道没通（超时 / 限流 / 网络），这次没有回复。';
      return sendJson(res, 502, { ok: false, error: 'assistant-unavailable', detail });
    }
    const reply = typeof answer.content === 'string' ? answer.content : '';
    if (reply.trim() === '') {
      return sendJson(res, 502, { ok: false, error: 'assistant-unavailable', detail: '模型返回空内容。' });
    }

    // v2-C：带 conversationId 才落盘。落盘失败不阻塞回答（磁盘问题不该让用户看不到答案）。
    if (conversationId !== null && session !== null) {
      try {
        const nowIso = clockNow().toISOString();
        const additions = [];
        if (newUserContent !== null) additions.push({ role: 'user', content: newUserContent });
        additions.push({ role: 'assistant', content: reply });
        let next = appendMessages(session, additions, nowIso);
        // 触发压缩：超阈值时把早期消息并入摘要（复用同一个 chat），失败降级不阻塞
        const plan = planCompression(next);
        if (plan.needCompress === true) {
          try {
            const prompt = buildSummaryPrompt(next.summary, plan.segment);
            const summaryAnswer = await chat({
              messages: [
                { role: 'system', content: '你是学习助手的对话摘要器。把下面这段对话压缩成一段简洁中文摘要，记录用户问了什么、助手答了哪些要点、涉及哪些知识点或操作。只输出摘要本身，不要加任何前缀或解释。' },
                { role: 'user', content: prompt },
              ],
              maxTokens: 800,
              temperature: 0.2,
            });
            const summaryText = summaryAnswer !== null && summaryAnswer !== undefined && summaryAnswer.ok !== false
              ? String(summaryAnswer.content ?? '').trim()
              : '';
            if (summaryText !== '') {
              next = applySummary(next, summaryText, plan.to);
            }
          } catch (error) {
            // 摘要失败降级：这次照常保存全量消息，摘要留待下次；不因摘要失败而不回答
            log.warn?.(`[study-assistant] 会话摘要生成失败（降级）：${String(error?.name ?? 'Error')}`);
          }
        }
        await writeSession(dataDir, next);
      } catch (error) {
        log.warn?.(`[study-assistant] 会话落盘失败（不影响回答）：${String(error?.name ?? 'Error')}`);
      }
    }

    return sendJson(res, 200, { ok: true, reply });
  }

  // -------------------------------------------------------------------------
  // v2-C 助手会话路由（落盘 `学习台/助手会话/`，旁挂目录，不进 DOC_KEYS/不进 /state）
  // -------------------------------------------------------------------------

  /**
   * `GET /assistant/session/list`：会话摘要列表（默认隐藏已归档），按 updatedAt 倒序。
   * 可选 `?includeArchived=1` 连归档一起列（前端「显示已归档」开关用）。
   */
  async function handleAssistantSessionList(res, url) {
    const includeArchived = String(url.searchParams.get('includeArchived') ?? '') === '1';
    const sessions = await listSessions(dataDir, { includeArchived });
    return sendJson(res, 200, { ok: true, sessions });
  }

  /** `GET /assistant/session/get?id=`：单会话完整（含 messages、summary）。 */
  async function handleAssistantSessionGet(res, url) {
    const id = String(url.searchParams.get('id') ?? '').trim();
    if (id === '') return sendJson(res, 400, { ok: false, error: 'missing-id' });
    const session = await readSession(dataDir, id);
    if (session === null) return sendJson(res, 404, { ok: false, error: 'not-found' });
    return sendJson(res, 200, { ok: true, session });
  }

  /** `POST /assistant/session/new`：建空会话（返回 id 与 title），可带 title。 */
  async function handleAssistantSessionNew(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const title = typeof body.payload?.title === 'string' ? body.payload.title : '';
    const session = await createSession(dataDir, { title }, clockNow().toISOString());
    return sendJson(res, 200, { ok: true, session: { id: session.id, title: session.title, createdAt: session.createdAt } });
  }

  /** `POST /assistant/session/rename`：`{id,title}` 改名并置 titleCustom=true。 */
  async function handleAssistantSessionRename(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const id = typeof body.payload?.id === 'string' ? body.payload.id.trim() : '';
    const title = typeof body.payload?.title === 'string' ? body.payload.title : '';
    if (id === '') return sendJson(res, 400, { ok: false, error: 'missing-id' });
    const result = await renameSession(dataDir, id, title, clockNow().toISOString());
    if (result.ok !== true) {
      return sendJson(res, result.error === 'not-found' ? 404 : 400, { ok: false, error: result.error });
    }
    return sendJson(res, 200, { ok: true, session: { id: result.session.id, title: result.session.title, titleCustom: result.session.titleCustom } });
  }

  /** `POST /assistant/session/archive`：`{id,archived}` 归档/取消归档，只加标记位不删磁盘。 */
  async function handleAssistantSessionArchive(req, res) {
    if (!writePreflight(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const id = typeof body.payload?.id === 'string' ? body.payload.id.trim() : '';
    if (id === '') return sendJson(res, 400, { ok: false, error: 'missing-id' });
    const archived = body.payload?.archived === true;
    const result = await archiveSession(dataDir, id, archived, clockNow().toISOString());
    if (result.ok !== true) {
      return sendJson(res, result.error === 'not-found' ? 404 : 400, { ok: false, error: result.error });
    }
    return sendJson(res, 200, { ok: true, session: { id: result.session.id, archived: result.session.archived } });
  }

  const handler = async function handler(req, res) {
    try {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        res.writeHead(405, { Allow: 'GET, POST' });
        return res.end();
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rest = url.pathname.slice(API_PREFIX.length);

      if (method === 'GET') {
        if (rest === '/health') return await handleHealth(res);
        if (rest === '/state') return await handleState(req, res, url);
        if (rest === '/overview') return await handleOverview(req, res, url);
        // 今日要闻（第 15 份主文档）：只读，展示窗口由 ?days= 控制（默认 7 天）
        if (rest === '/news') return await handleNews(req, res, url);
        // 批注（第 12 份主文档）：列表 / 单文件过滤 / 个人层导出（只读；写入走 POST /mutate doc=annotations）
        if (rest === '/annotations/export') return await handleAnnotationsExport(res, url);
        if (rest === '/annotations/material') return await handleAnnotationsMaterialInfo(res);
        if (rest === '/annotations') return await handleAnnotationsList(res, url);
        // 只回「连没连上」，不回 Cookie 本身，所以不需要写请求那套 preflight
        if (rest === '/learn/status') return await handleLearnStatus(res);
        // 会话自愈的状态（是否还有效、后台浏览器在不在跑），只读、不回 Cookie
        if (rest === '/learn/session') return await handleLearnSession(res);
        // 提交件扫描：只读，归档写入走下面的 POST /deliverables/archive
        if (rest === '/deliverables') return await handleDeliverables(res);
        // 全量导出：十六份文档（含批注/知识映射/日程/要闻）→ 一个带校验和的 JSON（只读；写回走下面的 POST /backup/restore）
        if (rest === '/backup/export') return await handleBackupExport(res);
        // 资料正文：面板「资料」页点开某份资料时读它的 md（只读、按索引白名单）
        if (rest === '/materials/text') return await handleMaterialText(res, url);
        // 知识点插图：详解里的图（只读、按 学习台/图片/_index.json 白名单）
        if (rest === '/materials/image') return await handleMaterialImage(res, url);
        // 学习记录（P3）：时间线 + 阅读位置（对话索引随交互助手一起下线）
        if (rest === '/study-log') return await handleStudyLogGet(res);
        // 助手会话（v2-C）：列表 / 单会话（只读；写入走下面的 POST /assistant/session/*）
        if (rest === '/assistant/session/list') return await handleAssistantSessionList(res, url);
        if (rest === '/assistant/session/get') return await handleAssistantSessionGet(res, url);
        // 学习时长（C2）：正计时 + 番茄钟每段一条；带 ?date= 时按日聚合（今日累计）
        if (rest === '/study-log/duration') return await handleStudyDurationGet(res, url);
        // 作业详情：只读，服务端去网络学堂拉「查看作业」页并解析成结构化字段
        if (rest === '/learn/detail') return await handleLearnDetail(res, url);
        // 检查更新：只读，比对「本地任务 vs 平台」的截止时间差异（写回走 POST /learn/apply-updates）
        if (rest === '/learn/updates') return await handleLearnUpdates(res);
        // 听课面板：独立页面 + 它 import 的模块，都是 GET，浏览器裸 URL 直接打开
        if (rest === '/lecture/health') return await handleLectureHealth(res);
        if (rest === '/lecture/state') return await handleLectureState(res, url);
        if (rest === '/lecture/sessions') return await handleLectureSessions(res);
        if (rest === '/lecture/report') return await handleLectureReport(res);
        if (rest === '/lecture/panel') return await handleLecturePanel(res);
        // 录音笔留下的音频：列表 + 按偏移读字节（页面自己解码）
        if (rest === '/lecture/recording/list') return await handleLectureRecordingList(res, url);
        if (rest === '/lecture/recording/file') return await handleLectureRecordingFile(res, url);
        if (rest === '/lecture/import') return await handleLectureImport(res);
        if (rest.startsWith('/lecture/') && rest.endsWith('.js')) {
          return await handleLectureModule(res, rest.slice('/lecture/'.length));
        }
        return sendJson(res, 404, { ok: false, error: 'unknown-route', path: url.pathname });
      }

      if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'cross-site-rejected' });
      if (rest === '/mutate') return await handleMutate(req, res);
      if (rest === '/reset-doc') return await handleReset(req, res);
      // 一键提醒：把今日日程推到本人微信，不通回退 QQ（文本随响应返回，便于兜底复制）
      if (rest === '/remind') return await handleRemind(req, res);
      // AI 智能识别（A2 卡）：一段话 → 日程草稿；**不写文档**，确认入库仍走 /mutate
      if (rest === '/schedule/parse') return await handleScheduleParse(req, res);
      // 学习助手浮层（MVP 卡）：多轮答疑，**不落盘**；密钥只从 refs.MAGPIE_GATEWAY_KEY 读
      if (rest === '/assistant/reply') return await handleAssistantReply(req, res);
      // 助手会话（v2-C）：新建 / 改名 / 归档（落 学习台/助手会话/，旁挂目录不进 DOC_KEYS）
      if (rest === '/assistant/session/new') return await handleAssistantSessionNew(req, res);
      if (rest === '/assistant/session/rename') return await handleAssistantSessionRename(req, res);
      if (rest === '/assistant/session/archive') return await handleAssistantSessionArchive(req, res);
      // 学习行为（v2-B 卡，第 16 份文档）：打开知识点记一次访问 + 顺带推进掌握度（写两条专用路由之一）
      if (rest === '/assistant/behavior') return await handleAssistantBehavior(req, res);
      // 改掌握度落库（v2-B 卡）：**必须带 confirm:true**，预览与落库分两次请求，不可合并
      if (rest === '/assistant/mastery') return await handleAssistantMastery(req, res);
      // 批量改掌握度落库（v2-B2 卡）：同样**必须带 confirm:true**；一批 nodeId，逐条先立 manual 旗
      if (rest === '/assistant/mastery-batch') return await handleAssistantMasteryBatch(req, res);
      // 全量恢复：校验和过了才逐份写回，每份写前自动进 学习台/备份/
      if (rest === '/backup/restore') return await handleBackupRestore(req, res);
      // 作业流：只留「一键开工」——建新会话并投固定指令，答案由会话里的 agent 产出
      if (rest === '/homework/spawn') return await handleHomeworkSpawn(req, res);
      // 一键开工的取料单独成一路：只取料落盘、不建会话（预览/验收/重试用；会写文件，走写请求校验）
      if (rest === '/homework/collect-materials') return await handleHomeworkCollectMaterials(req, res);
      if (rest === '/learn/connect') return await handleLearnConnect(req, res);
      if (rest === '/learn/fetch') return await handleLearnFetch(req, res);
      if (rest === '/learn/sync') return await handleLearnSync(req, res);
      // 平台改了截止时间：只改这些任务的 due，一次读一次写
      if (rest === '/learn/apply-updates') return await handleLearnApplyUpdates(req, res);
      if (rest === '/learn/semester') return await handleLearnSemester(req, res);
      if (rest === '/learn/disconnect') return await handleLearnDisconnect(req, res);
      // 会话自愈：立刻续期 / 弹一个可见的登录窗口 / 关掉后台浏览器。
      // 三个都只动「凭据与浏览器」，不碰学习数据。
      if (rest === '/learn/renew') return await handleLearnRenew(req, res);
      if (rest === '/learn/login-window') return await handleLearnLoginWindow(req, res);
      if (rest === '/learn/browser-stop') return await handleLearnBrowserStop(req, res);
      // 存/清统一身份认证账号密码（一键重连时静默填表用；存了才能全自动，不存就退化为「点按钮」）
      if (rest === '/learn/credential') return await handleLearnCredential(req, res);
      // 提交件归档：命中带姓名+学号的提交件才把任务置 done
      if (rest === '/deliverables/archive') return await handleDeliverablesArchive(req, res);
      // 知识网络：织网（候选 → 节点）与导出画布，两个都是「按钮点一次」的写操作
      if (rest === '/knowledge/weave') return await handleKnowledgeWeave(req, res);
      if (rest === '/knowledge/export') return await handleKnowledgeExport(req, res);
      // 阅读位置：节流 + 原子写，落 学习记录/阅读位置.json（不进 /state、不进备份）
      if (rest === '/reading-position') return await handleReadingPositionPost(req, res);
      // 学习时长（C2）：正计时 + 番茄钟每段一条，原子写 + 备份落 学习记录/学习时长.json（不进 /state、不进备份）
      if (rest === '/study-log/duration') return await handleStudyDurationPost(req, res);
      // 转写一片录音：POST 二进制 WAV，走 originAllowed + X-Study-Request 那套写请求校验
      if (rest === '/lecture/chunk') return await handleLectureChunk(req, res, url);
      // 听课分析管线：读屏 OCR / 手动粘贴都通过这些入口喂文本
      if (rest === '/lecture/session/start') return await handleLectureStart(req, res);
      if (rest === '/lecture/session/stop') return await handleLectureStop(req, res);
      if (rest === '/lecture/feed') return await handleLectureFeed(req, res);
      if (rest === '/lecture/alert/ack') return await handleLectureAck(req, res);
      return sendJson(res, 404, { ok: false, error: 'unknown-route', path: url.pathname });
    } catch (error) {
      log.error?.('[study-assistant] 接口异常：', error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
      else res.end();
    }
  };

  /**
   * 会话心跳的入口。
   *
   * 定时器**不**在这里起：`createApiHandler` 在测试里被反复调用，塞进来就会
   * 每个用例都留下一个 30 分钟的 interval。宿主入口（`index.js`）拿到这个对象
   * 后用 `ctx.effect` 起心跳，并在插件卸载时 stop()。
   */
  handler.learn = {
    checkNow: (reason) => checkLearnSession(reason ?? 'manual'),
    state: () => learnSessionSnapshot(),
    renew: () => renewLearnCookie({ reason: 'manual' }),
    browser: () => learnBrowser.status(),
    // 「手动登录后自动收 Cookie」的两个抓手：测试直接驱动 tick，不靠 sleep 等 15 秒
    harvestOnce: () => harvestOnce(),
    stopHarvest: (reason) => stopLoginHarvest(reason ?? 'manual'),
  };
  return handler;
}
