/**
 * 批注锚点（纯函数，零依赖、零磁盘、零模型）
 *
 * 参照 `lib/knowledge-explain.js` 的分层范式：与模型、文件系统无关的逻辑全部集中在这里，
 * 便于单元测试。HTTP 层只负责「读完整原文 → 调这里的函数 → 落盘」。
 *
 * 设计（决策纪要 B 组 + 契约 §2.2）：
 *   - 主锚 = 文件 + 原文片段指纹（首 24 字 + 尾 24 字）+ 前后各 12 字上下文；
 *   - 定位三态：`found`（精确命中）/ `fuzzy`（多义，取离旧偏移最近的一处）/ `lost`（找不到，进待处理，不删不猜）；
 *   - 选中不足 8 字自动扩到整段（到空行或下一个标题为止），并置 `expanded: true`；
 *   - **切版本不自动迁移**：`lost`/`fuzzy` 由界面提示，绝不静默套到别的位置。
 *
 * 三种批注类型 `note | highlight | insert` 共用同一套锚点数据，区别只在 `type` 字段。
 */

/** 指纹取多长的首/尾片段（字）。 */
export const FINGERPRINT_CHARS = 24;
/** 选中内容前后各留多少字上下文，用于多义消歧（字）。 */
export const CONTEXT_CHARS = 12;
/** 小于这个长度（字）的选中会被扩到整段。 */
export const MIN_QUOTE_CHARS = 8;
/** 锚点计算允许的最大原文长度（字）。超过则拒绝批注（与 /materials/text 的 200KB 截断对齐）。 */
export const MAX_ANCHOR_CHARS = 200 * 1024;
/** 三种批注类型，共用一套锚点数据。 */
export const ANNOTATION_TYPES = ['note', 'highlight', 'insert'];

function toInt(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/** 把全文按行切成 [start, end) 的字符区间（不含换行符）。 */
function lineSpans(text) {
  const spans = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      spans.push({ start: pos, end: text.length });
      break;
    }
    spans.push({ start: pos, end: nl });
    pos = nl + 1;
  }
  return spans;
}

/** 空行或标题行（`#` 开头）是段落边界。 */
function isParagraphBreak(line) {
  const trimmed = line.trim();
  return trimmed === '' || /^#{1,6}\s/.test(trimmed);
}

/**
 * 把区间扩到所在整段（到空行或下一个标题为止）。
 * 若锚点落点本身就是空行/标题行，则不扩（返回原区间）。
 */
export function expandToParagraph(text, start, end) {
  const source = typeof text === 'string' ? text : '';
  const s = clamp(toInt(start, 0), 0, source.length);
  const e = clamp(toInt(end, s), s, source.length);
  const spans = lineSpans(source);
  if (spans.length === 0) return { start: s, end: e };
  const idxOf = (pos) => {
    for (let i = 0; i < spans.length; i += 1) {
      if (pos >= spans[i].start && pos <= spans[i].end) return i;
    }
    return spans.length - 1;
  };
  const lineText = (i) => source.slice(spans[i].start, spans[i].end);
  let first = idxOf(s);
  let last = idxOf(Math.max(s, e > s ? e - 1 : e));
  if (!isParagraphBreak(lineText(first))) {
    while (first > 0 && !isParagraphBreak(lineText(first - 1))) first -= 1;
    while (last < spans.length - 1 && !isParagraphBreak(lineText(last + 1))) last += 1;
  }
  return { start: spans[first].start, end: spans[last].end };
}

/**
 * 由「完整原文 + 起止偏移」构造一个锚点对象。
 * 选中不足 {@link MIN_QUOTE_CHARS} 字时自动扩到整段并置 `expanded: true`。
 *
 * @param {string} text 服务端完整原文
 * @param {number} start 选区起点（字符偏移）
 * @param {number} end 选区终点（字符偏移，不含）
 * @returns {{quote: string, len: number, prefix: string, suffix: string, start: number, end: number, expanded: boolean}}
 */
export function buildAnchor(text, start, end) {
  const source = typeof text === 'string' ? text : '';
  let s = clamp(toInt(start, 0), 0, source.length);
  let e = clamp(toInt(end, 0), 0, source.length);
  if (e < s) [s, e] = [e, s];
  let expanded = false;
  if (e - s < MIN_QUOTE_CHARS) {
    const block = expandToParagraph(source, s, e);
    s = block.start;
    e = block.end;
    expanded = true;
  }
  const quote = source.slice(s, e);
  const prefix = source.slice(Math.max(0, s - CONTEXT_CHARS), s);
  const suffix = source.slice(e, Math.min(source.length, e + CONTEXT_CHARS));
  return { quote, len: quote.length, prefix, suffix, start: s, end: e, expanded };
}

/**
 * 精确锚点（2026-11-17 D 卡·行内格式）：任意长度选区（含 1–7 字短选）都按用户**实际选的**
 * 起止偏移出 quote，**不扩段**。低层 `buildAnchor` 的「<8 字扩到整段」旧语义保持不变，
 * 这里只在需要「精确着色短词」时另走一条路，置 `exact: true` 供 resolveAnchorFromText 识别。
 *
 * @param {string} text 服务端完整原文
 * @param {number} start 选区起点
 * @param {number} end 选区终点（不含）
 * @returns {{ok:true, anchor:object} | {ok:false, reason:string}}
 *   - 空选区（e<=s）→ `{ok:false, reason:'empty-selection'}`（调用方回退到扩展段即可）
 *   - 纯空白 quote → `{ok:false, reason:'blank-selection'}`
 */
export function buildAnchorExact(text, start, end) {
  const source = typeof text === 'string' ? text : '';
  let s = clamp(toInt(start, 0), 0, source.length);
  let e = clamp(toInt(end, 0), 0, source.length);
  if (e < s) [s, e] = [e, s];
  if (e - s <= 0) return { ok: false, reason: 'empty-selection' };
  const quote = source.slice(s, e);
  if (quote.trim() === '') return { ok: false, reason: 'blank-selection' };
  const prefix = source.slice(Math.max(0, s - CONTEXT_CHARS), s);
  const suffix = source.slice(e, Math.min(source.length, e + CONTEXT_CHARS));
  return {
    ok: true,
    anchor: { quote, len: quote.length, prefix, suffix, start: s, end: e, expanded: false, exact: true },
  };
}

/** 计算一段文本的首/尾指纹。 */
export function makeFingerprint(text) {
  const source = typeof text === 'string' ? text : '';
  const n = Math.min(FINGERPRINT_CHARS, source.length);
  return {
    head: source.slice(0, n),
    tail: n === 0 ? '' : source.slice(source.length - n),
  };
}

function located(status, start, end) {
  return { status, start, end };
}

/**
 * 在（可能已改动的）完整原文里重新定位一个锚点。
 *
 * 算法（契约 §2.2）：
 *   1. 快路径：`text.slice(start, start+quote.length) === quote` → `found`；
 *   2. 全文按 `quote` 首 24 字检索，逐处核对尾 24 字与整段 → 唯一命中即 `found`，刷新偏移；
 *   3. 多处命中 → 用 prefix/suffix 消歧；仍多义 → 取离旧 start 最近的一处，标 `fuzzy`；
 *   4. 零命中 → `lost`（不删、不猜、不套到别处）。
 *
 * @param {string} text 当前完整原文
 * @param {{quote: string, start?: number, prefix?: string, suffix?: string}} anchor
 * @returns {{status: 'found'|'fuzzy'|'lost', start: number|null, end: number|null}}
 */
export function relocateAnchor(text, anchor) {
  const source = typeof text === 'string' ? text : '';
  const quote = anchor && typeof anchor.quote === 'string' ? anchor.quote : '';
  if (quote === '') return { status: 'lost', start: null, end: null };
  const oldStart = Math.max(0, toInt(anchor.start, 0));

  // 1) 快路径
  if (source.slice(oldStart, oldStart + quote.length) === quote) {
    return located('found', oldStart, oldStart + quote.length);
  }

  // 2) 首尾指纹检索整段
  const fp = makeFingerprint(quote);
  const candidates = [];
  let from = 0;
  while (from <= source.length) {
    const at = source.indexOf(fp.head, from);
    if (at === -1) break;
    const end = at + quote.length;
    if (end <= source.length && source.slice(at, end) === quote) {
      candidates.push(at);
    }
    from = at + 1;
  }
  if (candidates.length === 0) return { status: 'lost', start: null, end: null };
  if (candidates.length === 1) {
    const at = candidates[0];
    return located('found', at, at + quote.length);
  }

  // 3) prefix / suffix 消歧
  const prefix = typeof anchor.prefix === 'string' ? anchor.prefix : '';
  const suffix = typeof anchor.suffix === 'string' ? anchor.suffix : '';
  const scored = candidates.map((at) => {
    let score = 0;
    if (prefix !== '') {
      const before = source.slice(Math.max(0, at - prefix.length), at);
      if (before === prefix) score += 2;
    }
    if (suffix !== '') {
      const after = source.slice(at + quote.length, at + quote.length + suffix.length);
      if (after === suffix) score += 2;
    }
    return { at, score };
  });
  const bestScore = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === bestScore);
  if (bestScore > 0 && top.length === 1) {
    const at = top[0].at;
    return located('fuzzy', at, at + quote.length);
  }

  // 仍多义：取离旧偏移最近的一处
  const nearest = candidates.reduce((a, b) => (Math.abs(a - oldStart) <= Math.abs(b - oldStart) ? a : b));
  return located('fuzzy', nearest, nearest + quote.length);
}

/**
 * 服务端「重算并确认」客户端提交的锚点：读到的完整原文为准，客户端只提供线索。
 *
 * 客户端提交 `{quote, start, end}`（可选 prefix/suffix）。服务端：
 *   - 若 `text.slice(start,end) === quote` → 用 buildAnchor 重构（含 <8 字扩段）；
 *   - 否则尝试 relocateAnchor 确认 quote 确实存在于文中；命中则在新位置重构；
 *   - 彻底找不到 → `{ok:false, reason:'anchor-not-found'}`（HTTP 400）。
 * 这同时挡住「客户端伪造偏移」。
 *
 * @param {string} text 服务端完整原文
 * @param {{quote?: string, start?: number, end?: number, prefix?: string, suffix?: string}} submitted
 * @returns {{ok: true, anchor: object, status: string} | {ok: false, reason: string}}
 */
export function resolveAnchorFromText(text, submitted) {
  const source = typeof text === 'string' ? text : '';
  if (source.length > MAX_ANCHOR_CHARS) return { ok: false, reason: 'file-too-large' };
  if (submitted === null || typeof submitted !== 'object') return { ok: false, reason: 'bad-anchor' };
  const quote = typeof submitted.quote === 'string' ? submitted.quote : '';
  if (quote === '') return { ok: false, reason: 'bad-anchor' };
  const start = toInt(submitted.start, -1);
  const end = toInt(submitted.end, -1);
  const wantsExact = submitted.exact === true;

  // 精确命中（客户端偏移可信）
  if (start >= 0 && end >= start && source.slice(start, end) === quote) {
    // exact 锚点：不扩段（短选也保持用户实际选区）；普通锚点：沿用 buildAnchor（含 <8 扩段）
    const anchor = wantsExact ? buildAnchorExact(source, start, end).anchor : buildAnchor(source, start, end);
    return { ok: true, anchor, status: 'found' };
  }

  // 偏移不可信：用指纹重定位确认 quote 是否还在文中
  const result = relocateAnchor(source, {
    quote,
    start: start >= 0 ? start : 0,
    prefix: submitted.prefix,
    suffix: submitted.suffix,
  });
  if (result.status === 'lost') return { ok: false, reason: 'anchor-not-found' };
  const anchor = wantsExact ? buildAnchorExact(source, result.start, result.end).anchor : buildAnchor(source, result.start, result.end);
  return { ok: true, anchor, status: result.status };
}
