/**
 * 点名 / 答题检测规则。
 *
 * 输入是「一段规范化后的听课文本」，输出是提醒列表。这个模块**不做 IO、
 * 不碰网络、不知道时间**（时间由调用方在 alert 上补），所以可以离线单测。
 *
 * 三档严重度：
 *   3 = 必须立刻反应（叫到你、要求作答、点名签到）
 *   2 = 值得一眼扫到（一般性提问、老师讲到某个练习）
 *   1 = 仅供参考（目前没有规则用到，留给以后加低置信度线索）
 *
 * 去重策略有两条，都很必要：
 *   - **包含去重**：`谁来回答` 里含 `谁来`，同一处只留一条，否则一个提问
 *     会弹出两个浮层。
 *   - **区间去重**：全名匹配过的区间，名字那一档不再重复报。
 * 跨帧的重复（同一句因为字幕重叠被喂两次）由 `session.js` 按时间段去重，
 * 这里只负责单帧内的自洽。
 */

import {
  ADDRESS_CUES,
  QUESTION_CUES,
  ROLLCALL_CUES,
  STRONG_QUESTION_CUES,
  SURNAME_FALSE_WORDS,
  buildNameMatcher,
} from './dict.js';
import { normalizeFrame } from './text.js';

/** 一趟检测最多产出多少条提醒（防止异常文本刷屏）。 */
export const MAX_ALERTS_PER_FRAME = 20;

/** 称呼语 / 姓氏单字之间的最大距离（字符）。 */
export const ADDRESS_WINDOW = 10;

const KIND_LABEL = {
  name: '叫到你',
  rollcall: '点名 / 签到',
  question: '提问',
  'question-strong': '要求作答',
};

/** 逐个找出 needle 出现的位置。 */
function findAll(haystack, needle) {
  const out = [];
  if (needle === '') return out;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/** 取匹配处周围的原文片段，两侧截断时加省略号。 */
export function snippetAround(text, offset, length, radius = 26) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + length + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end)}${tail}`;
}

/** 收集某个词表的所有命中。 */
function cueHits(text, words, kind, severity) {
  const out = [];
  for (const word of words) {
    for (const at of findAll(text, word)) {
      out.push({ kind, severity, matched: word, offset: at, length: word.length });
    }
  }
  return out;
}

/**
 * 某个位置是否落在「姓氏误报词」内部。
 *
 * 例：文本里出现「速度」，`度` 的偏移落在 `速度` 的区间里 → 判定误报。
 */
function insideFalseWord(text, offset, length) {
  for (const word of SURNAME_FALSE_WORDS) {
    for (const at of findAll(text, word)) {
      if (offset >= at && offset + length <= at + word.length) return true;
    }
  }
  return false;
}

/** 附近有没有称呼语。 */
function hasAddressCue(text, offset, length) {
  const start = Math.max(0, offset - ADDRESS_WINDOW);
  const end = Math.min(text.length, offset + length + ADDRESS_WINDOW);
  const window = text.slice(start, end);
  return ADDRESS_CUES.some((cue) => window.includes(cue));
}

/** 把区间列表压成「已占用」判定，供后续档位跳过。 */
function makeRangeSet() {
  const ranges = [];
  return {
    add(offset, length) {
      ranges.push([offset, offset + length]);
    },
    covers(offset, length) {
      return ranges.some(([start, end]) => offset >= start && offset + length <= end);
    },
  };
}

/** 收集姓名三档命中。 */
function nameHits(text, matcher) {
  const out = [];
  const used = makeRangeSet();
  if (matcher === null || matcher === undefined) return out;

  const scan = (regex, kindHint) => {
    if (regex === null) return [];
    regex.lastIndex = 0;
    const found = [];
    for (;;) {
      const m = regex.exec(text);
      if (m === null) break;
      found.push({ matched: m[0], offset: m.index, length: m[0].length });
      if (m[0].length === 0) regex.lastIndex += 1;
    }
    return found.map((hit) => ({ ...hit, kindHint }));
  };

  // 整名优先，占掉区间
  for (const hit of scan(matcher.full, 'full')) {
    out.push({ kind: 'name', severity: 3, matched: hit.matched, offset: hit.offset, length: hit.length });
    used.add(hit.offset, hit.length);
  }
  // 配置里的变体（同音字/绰号）：字面量命中，和整名同权重
  for (const regex of matcher.variants ?? []) {
    for (const hit of scan(regex, 'variant')) {
      if (used.covers(hit.offset, hit.length)) continue;
      out.push({ kind: 'name', severity: 3, matched: hit.matched, offset: hit.offset, length: hit.length });
      used.add(hit.offset, hit.length);
    }
  }
  // 名（不含姓）：跳过已被整名占掉的区间
  for (const hit of scan(matcher.given, 'given')) {
    if (used.covers(hit.offset, hit.length)) continue;
    out.push({ kind: 'name', severity: 3, matched: hit.matched, offset: hit.offset, length: hit.length });
    used.add(hit.offset, hit.length);
  }
  // 姓单字：两道额外闸门
  for (const hit of scan(matcher.surname, 'surname')) {
    if (used.covers(hit.offset, hit.length)) continue;
    if (insideFalseWord(text, hit.offset, hit.length)) continue;
    if (!hasAddressCue(text, hit.offset, hit.length)) continue;
    out.push({ kind: 'name', severity: 2, matched: hit.matched, offset: hit.offset, length: hit.length });
    used.add(hit.offset, hit.length);
  }
  return out;
}

/** 去掉被更长命中整段包含的候选（`谁来回答` 吃掉同位置的 `谁来`）。 */
function dropContained(hits) {
  const sorted = [...hits].sort((a, b) => a.offset - b.offset || b.length - a.length);
  const kept = [];
  for (const hit of sorted) {
    const swallowed = kept.some(
      (k) => hit.offset >= k.offset && hit.offset + hit.length <= k.offset + k.length,
    );
    if (!swallowed) kept.push(hit);
  }
  return kept;
}

/**
 * 检测一段文本里的提醒。
 *
 * @param {string} text 听课文本（未规范化也行，内部会规范化一次，幂等）
 * @param {{matcher?: object, studentName?: string, studentNameVariants?: string|string[], limit?: number}} [options]
 * @returns {Array<{kind: string, severity: number, matched: string, label: string,
 *   snippet: string, offset: number, key: string}>}
 */
export function detectAlerts(text, options = {}) {
  const body = normalizeFrame(text);
  if (body === '') return [];

  const matcher = options.matcher ?? buildNameMatcher(options.studentName, options.studentNameVariants);
  const limit = Number.isInteger(options.limit) ? options.limit : MAX_ALERTS_PER_FRAME;

  const hits = [
    ...nameHits(body, matcher),
    ...cueHits(body, ROLLCALL_CUES, 'rollcall', 3),
    ...cueHits(body, STRONG_QUESTION_CUES, 'question-strong', 3),
    ...cueHits(body, QUESTION_CUES, 'question', 2),
  ];

  const kept = dropContained(hits)
    .sort((a, b) => a.offset - b.offset)
    .slice(0, limit);

  return kept.map((hit) => {
    const snippet = snippetAround(body, hit.offset, hit.length);
    return {
      kind: hit.kind,
      severity: hit.severity,
      matched: hit.matched,
      label: KIND_LABEL[hit.kind] ?? hit.kind,
      snippet,
      offset: hit.offset,
      key: `${hit.kind}::${hit.matched}::${snippet}`,
    };
  });
}
