/**
 * 听课文本的规范化与切片（同构模块：不 import 任何 Node 内建，浏览器也能直接用）。
 *
 * 这个文件处理的是「别人识别出来的文字」，不是音频。它要吸收三类脏数据：
 *
 *   1. **汉字间被插入空格**。Windows 内置 OCR（`zh-Hans-CN`）会把一整句识别成
 *      `新 会 话` 这种样子 —— 这是它分词留下的分隔符，不是原文。实测：
 *      `啭 写 答 题 提 醒 插` 对应的是「转写答题提醒插…」。所以必须先把
 *      汉字之间的空格去掉，否则后面所有按词匹配的规则全部失效。
 *
 *   2. **字幕是滚动窗口，不是增量**。腾讯会议/任何字幕都是「每帧显示最近
 *      一两句」，相邻两帧有大段重叠。直接把每帧都追加进去，逐字稿会变成
 *      复读机。所以要算「上一帧结尾」与「这一帧开头」的最大重叠并只取新增部分。
 *
 *   3. **识别错字**。这类错误在这里**不修** —— 通用替换表会把正文改坏。
 *      错字由 `dict.js` 的按音节同音字类去吸收（`昊/浩/皓/灏` 落进同一个
 *      字符类），那是更精准的位置。
 */

/** 宽字符（CJK 汉字、CJK 标点、全角形式）。用来判断「这个空格是不是 OCR 插的」。 */
const WIDE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/** 一行里至少要有一个「有意义的字符」，否则整行丢掉。 */
const MEANINGFUL = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9]/;

/** 句末标点。中文口播常常没有标点，所以这只是「首选切分点」，不是唯一依据。 */
const SENTENCE_END = /[。！？!?；;…\n]/;

/**
 * 去掉汉字之间被 OCR 插进来的空格。
 *
 * 规则刻意保守：**只有空格两侧都是宽字符时才删**。
 * `的 CPU 很快` 里的空格两侧一宽一半，留着不会影响匹配；而
 * `新 会 话` 两侧都是宽字符，删掉正好还原成「新会话」。
 */
export function stripCjkSpaces(text) {
  const source = String(text ?? '');
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\u00A0' || ch === '\u3000') {
      const prev = out[out.length - 1] ?? '';
      const next = source[i + 1] ?? '';
      if (prev !== '' && next !== '' && WIDE.test(prev) && WIDE.test(next)) continue;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** 这行有没有实际内容（纯标点、纯空白的行不算）。 */
export function isNoise(text) {
  return !MEANINGFUL.test(String(text ?? ''));
}

/**
 * 规范化一整帧字幕文本（可能多行）。
 *
 * 保留换行：字幕的分行本身就是有意义的边界，压成一行会丢掉线索。
 */
export function normalizeFrame(raw) {
  const source = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // 零宽字符、控制字符（保留 \n 与 \t）
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const lines = source
    .split('\n')
    .map((line) => stripCjkSpaces(line))
    .filter((line) => line !== '' && !isNoise(line));
  return lines.join('\n');
}

/** 规范化后的每一行。 */
export function frameLines(raw) {
  const text = normalizeFrame(raw);
  return text === '' ? [] : text.split('\n');
}

/**
 * 切句。
 *
 * 口播没有标点时（很常见）整段会是一句 —— 这是可接受的：下游按「滑窗」
 * 匹配，不依赖句子边界。
 */
export function splitSentences(text) {
  const out = [];
  let buffer = '';
  for (const ch of String(text ?? '')) {
    if (SENTENCE_END.test(ch)) {
      const piece = buffer.trim();
      if (piece !== '' && !isNoise(piece)) out.push(piece);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  const tail = buffer.trim();
  if (tail !== '' && !isNoise(tail)) out.push(tail);
  return out;
}

/** 两个等长字符串有几个位置对不上。 */
export function countMismatch(a, b) {
  const length = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff + Math.abs(a.length - b.length);
}

/** 取末尾 n 个字符（不足则全取）。 */
export function tailOf(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(s.length - n);
}

/**
 * 「上一帧的结尾」与「这一帧的开头」的最大重叠长度。
 *
 * 从最长的候选往下试，允许若干字符对不上 —— 因为重叠区里也可能有 OCR
 * 错字，要求逐字相等会直接退化成「完全不重叠」，逐字稿就开始复读。
 *
 * @returns {number} 重叠字符数；0 表示两帧无关（字幕被清空或换了话题）。
 */
export function overlapLength(previous, incoming, options = {}) {
  const prev = String(previous ?? '');
  const next = String(incoming ?? '');
  if (prev === '' || next === '') return 0;

  const minOverlap = Number.isInteger(options.minOverlap) ? options.minOverlap : 6;
  const maxOverlap = Number.isInteger(options.maxOverlap) ? options.maxOverlap : 240;
  const max = Math.min(prev.length, next.length, maxOverlap);
  // 重叠越长越容易蒙对，允许的错字比例跟着放大一点
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 0.12;

  for (let length = max; length >= minOverlap; length -= 1) {
    const allowed = Math.max(1, Math.floor(length * tolerance));
    if (countMismatch(prev.slice(prev.length - length), next.slice(0, length)) <= allowed) {
      return length;
    }
  }
  return 0;
}

/**
 * 把新到的一帧字幕并进累积文本。
 *
 * @returns {{appended: string, overlap: number, reset: boolean, text: string}}
 *   `appended` 是这一帧真正的新增内容（可能为空字符串，表示这一帧全是旧的）；
 *   `reset` 为 true 表示字幕窗口被清空重启（重叠为 0 且新帧开头不是旧文本的延续）。
 */
export function absorbCaption(previous, incoming, options = {}) {
  const prev = String(previous ?? '');
  const next = String(incoming ?? '');
  if (next === '') return { appended: '', overlap: 0, reset: false, text: prev };
  if (prev === '') return { appended: next, overlap: 0, reset: false, text: next };

  // 整帧都已在累积文本末尾出现过 → 没有新内容
  if (prev.endsWith(next)) return { appended: '', overlap: next.length, reset: false, text: prev };

  // 帧被清空重启：新帧整段都不在旧文本的末尾窗口里
  if (prev.includes(next)) {
    // 旧文本中间出现过这一段，说明是重复帧而不是新内容
    return { appended: '', overlap: next.length, reset: false, text: prev };
  }

  const overlap = overlapLength(prev, next, options);
  const appended = next.slice(overlap).trim();
  if (appended === '') return { appended: '', overlap, reset: false, text: prev };
  // 不重叠说明字幕窗口重启了，两段之间必须有换行，否则会把无关的两句粘成一句
  const glue = overlap === 0 ? '\n' : '';
  return { appended, overlap, reset: overlap === 0, text: `${prev}${glue}${appended}` };
}

/** 累积文本只保留末尾 maxChars，避免一节课跑下来内存里堆几兆。 */
export function clampTail(text, maxChars = 200000) {
  const s = String(text ?? '');
  return s.length <= maxChars ? s : s.slice(s.length - maxChars);
}
