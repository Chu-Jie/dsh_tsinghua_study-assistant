/**
 * 分题、答案对齐与泄题自检（零依赖纯函数，不碰 fs、不碰网络）
 *
 * 这一层只做「文本 → 结构」的判断，所有 I/O（读 PDF、写 作业.json、调模型）都在调用方。
 * 拆开的理由很实际：这些规则最容易出错（题号对不对、答案错没错位），
 * 而纯函数可以拿真实题面反复试，不用起宿主、不用连网络。
 *
 * 三条来自现场的经验：
 *   1. PDF 文字层里的数学变量是 U+1D400 区的数学斜体（`𝐀`），只有 NFKC 能把它变回 `A`；
 *      不做这一步，题面比对与题号对齐会把「明明一样」判成不一样。
 *   2. 题号只在**行首**认（`1.` / `1、` / `（1）` / `第 1 题` / `一、`）。
 *      正文里的 `32A3`、公式下标都长得像序号，按行首认能把它们排除掉。
 *   3. 编号必须**连号递增**才算题号。PDF 里页码、脚注、参考文献编号都会冒充题号，
 *      只保留「1,2,3…」这一段，跳号与重复一律进 warnings，不硬猜。
 */

/** 题号最小长度：比它还短的「题干」基本是编号本身或残行。 */
const MIN_PROMPT = 4;

/** 题号上限（两位；三是留给「第 100 题」这种罕见情况的余量）。 */
export const MAX_NO = 99;

/** 中文数字（题号只用到 99）。 */
const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 一个「像题目」的题干至少这么长；用来把「手写 / 拍照上传」这类要求条目排除在题目之外。 */
const SUBSTANTIVE_PROMPT = 12;

/** 行首阿拉伯题号：`1.` `1、` `1)` `1）` `第 1 题` `第1题`。 */
const LEAD_ARABIC = /^[ \t]*(?:第[ \t]*)?([0-9]{1,2})[ \t]*(?:题|[.．、)）])[ \t]*/;
/** 行首括号题号：`（1）` `(1)`。 */
const LEAD_PAREN = /^[ \t]*[（(][ \t]*([0-9]{1,2})[ \t]*[)）][ \t]*/;
/** 行首中文题号：`一、` `二.` `（三）` 之外的 `三、`。 */
const LEAD_CN = /^[ \t]*([一二三四五六七八九十]{1,3})[ \t]*[、.．)）][ \t]*/;

/**
 * warning 的人话解释。面板直接展示 `message`，`code` 只给测试和调用方判断用。
 *
 * 加这张表的理由：以前面板上显示的是 `skipped-number`「duplicate-number」这种原始码，
 * 用户看不懂。凡是给用户看的字符串，都集中放在这里，避免测试改了文案却漏改界面。
 */
export const WARNING_TEXT = {
  'empty-text': '没取到文字：这份文件没有文字层（多半是扫描件或图片）',
  'no-numbering': '没认出题号：整段先当成一道题，请在确认前手工改题面',
  'short-question': '有一题题面过短，可能是切错了',
  'skipped-number': '题号不连续，中间缺题',
  'duplicate-number': '题号重复',
  'suspect-symbol-font': (extra) =>
    `文字层疑似坏了：${Math.round((Number(extra?.ratio) || 0) * 100)}% 的字母都是同一个字符「${extra?.char ?? '?'}」。`
    + '这种 PDF 通常把公式字体压成了同一个码位（例如 `𝐀`），取出来的题面不可读。'
    + '建议换一份文字层正常的文件，或把题干直接粘贴进来。',
};

/**
 * 造一条 warning：`{ code, message, ...extra }`。
 * @param {string} code 见 `WARNING_TEXT`
 * @param {object} [extra] 额外字段（题号、比例等），会原样带出去
 * @returns {{code: string, message: string}}
 */
export function warningFor(code, extra = {}) {
  const template = WARNING_TEXT[code] ?? code;
  const message = typeof template === 'function' ? template(extra) : template;
  return { code, message, ...extra };
}

/**
 * 文本归一化：**所有**比对与分题前的第一步。
 *
 * NFKC（不是 NFC）是刻意的：它把 `𝐀`（U+1D400）这类数学字母、全角数字、全角括号
 * 统一成 ASCII 形式，否则题面里「看起来一模一样」的两个字符会判成不同。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 比对用的强归一化：NFKC + 去掉**全部**空白 + 小写。
 * 用于「这段答案是不是原样出现在题干里」这类包含判断。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return normalizeText(text).replace(/\s+/g, '').toLowerCase();
}

/**
 * 中文数字 → 整数（够题号用：一 … 九十九）。
 * @param {string} text
 * @returns {number|null}
 */
export function cnToInt(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return null;
  if (raw.length === 1) {
    const single = CN_DIGITS[raw];
    return typeof single === 'number' ? single : null;
  }
  const hit = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw);
  if (hit !== null) {
    const tens = hit[1] === undefined ? 1 : CN_DIGITS[hit[1]];
    const ones = hit[2] === undefined ? 0 : CN_DIGITS[hit[2]];
    return tens * 10 + ones;
  }
  return null;
}

/**
 * 认一行行首的题号。
 * @param {string} line
 * @returns {{no: number, rest: string}|null}
 */
function matchLead(line) {
  if (typeof line !== 'string' || line === '') return null;
  const text = line.replace(/\u3000/g, ' ');

  const paren = LEAD_PAREN.exec(text);
  if (paren !== null) return { no: Number(paren[1]), rest: text.slice(paren[0].length) };

  const arabic = LEAD_ARABIC.exec(text);
  if (arabic !== null) return { no: Number(arabic[1]), rest: text.slice(arabic[0].length) };

  const cn = LEAD_CN.exec(text);
  if (cn !== null) {
    const no = cnToInt(cn[1]);
    if (no !== null && no >= 1 && no <= MAX_NO) return { no, rest: text.slice(cn[0].length) };
  }
  return null;
}

/**
 * 从候选里挑出「连号递增」的那一串。
 *
 * 只看连号还不够：题面开头常有一段作业要求，里面也编号 1、2、3（「1. 手写 2. 拍照上传」），
 * 恰好又和后面的真题连上，于是被当成第 1、2 题。所以候选按两条打分：
 *   1. 题干够长（≥ `SUBSTANTIVE_PROMPT`）的条数越多越像题目；
 *   2. 同分时取更靠后的那一段（要求说明总在题目之前）。
 * 每个 `1` 都是一次候选起点的尝试，没有 `1` 时从第一个候选起。
 * @param {Array<{line: number, no: number, rest: string}>} marks
 * @returns {{run: Array<{line: number, no: number, rest: string}>, skipped: Array<{line: number, no: number, rest: string}>}}
 */
function pickRun(marks) {
  if (marks.length === 0) return { run: [], skipped: [] };

  const fromOne = marks.map((mark, index) => (mark.no === 1 ? index : -1)).filter((index) => index !== -1);
  const starts = fromOne.length > 0 ? fromOne : [0];

  let best = null;
  for (const start of starts) {
    const run = [marks[start]];
    let expected = marks[start].no + 1;
    for (let i = start + 1; i < marks.length; i++) {
      if (marks[i].no === expected) {
        run.push(marks[i]);
        expected += 1;
      }
    }
    const substantive = run.filter((mark) => mark.rest.trim().length >= SUBSTANTIVE_PROMPT).length;
    const score = substantive * 1000 + run.length;
    if (best === null || score >= best.score) best = { run, score };
  }

  const chosen = best === null ? [] : best.run;
  const chosenLines = new Set(chosen.map((mark) => mark.line));
  const skipped = marks.filter((mark) => !chosenLines.has(mark.line));
  return { run: chosen, skipped };
}

/**
 * 把一段题面文字切成题目列表。
 *
 * 返回的 `questions` 是**草稿**：题号与题干可用，但没有答案。
 * `warnings` 里每条形如 `{ code, ... }`，面板要原样展示——用户据此决定改哪一题。
 * @param {unknown} text 题面原文（PDF 文字层 / 粘贴文本 / docx 抽取结果）
 * @returns {{preamble: string, questions: Array<{no: number, prompt: string}>, warnings: Array<object>}}
 */
export function splitQuestions(text) {
  const body = normalizeText(text);
  if (body === '') return { preamble: '', questions: [], warnings: [warningFor('empty-text')] };

  const lines = body.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = matchLead(lines[i]);
    if (hit !== null) marks.push({ line: i, no: hit.no, rest: hit.rest });
  }

  const { run, skipped } = pickRun(marks);

  // 一个题号都没认出来（或只认出孤零零一个）：整段当一道题，让用户自己改
  if (run.length < 2) {
    return {
      preamble: '',
      questions: [{ no: 1, prompt: body }],
      warnings: [warningFor('no-numbering', { candidates: marks.length })],
    };
  }

  const warnings = [];
  const questions = [];
  for (let k = 0; k < run.length; k++) {
    const mark = run[k];
    const end = k + 1 < run.length ? run[k + 1].line : lines.length;
    const prompt = [mark.rest, ...lines.slice(mark.line + 1, end)].join('\n').trim();
    questions.push({ no: mark.no, prompt });
    if (prompt.length < MIN_PROMPT) warnings.push(warningFor('short-question', { no: mark.no, chars: prompt.length }));
  }

  for (const mark of skipped) warnings.push(warningFor('skipped-number', { no: mark.no }));
  const counts = new Map();
  for (const mark of marks) counts.set(mark.no, (counts.get(mark.no) ?? 0) + 1);
  for (const [no, times] of counts) {
    if (times > 1) warnings.push(warningFor('duplicate-number', { no, times }));
  }

  const preamble = lines.slice(0, run[0].line).join('\n').trim();
  return { preamble, questions, warnings };
}

/**
 * 确认草稿：校验用户改完的题目列表，并补齐字段。
 *
 * 只认「题号是 1–99 的整数、题干非空」；重复题号保留第一条并报 warning，
 * 不静默合并（用户改错时要看得见）。
 * @param {Array<{no?: unknown, prompt?: unknown, guide?: unknown, answer?: unknown, finalAnswer?: unknown}>} list
 * @returns {{ok: true, questions: Array<object>, warnings: Array<object>}|{ok: false, reason: string, no?: number}}
 */
export function confirmDraft(list) {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'empty' };
  const warnings = [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const no = Number(item?.no);
    const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
    if (!Number.isInteger(no) || no < 1 || no > MAX_NO) return { ok: false, reason: 'bad-number', detail: String(item?.no) };
    if (prompt === '') return { ok: false, reason: 'empty-prompt', no };
    if (seen.has(no)) {
      warnings.push(warningFor('duplicate-number', { no }));
      continue;
    }
    seen.add(no);
    out.push({
      ...item,
      no,
      prompt,
      guide: typeof item?.guide === 'string' && item.guide !== '' ? item.guide : null,
      answer: typeof item?.answer === 'string' && item.answer !== '' ? item.answer : null,
      finalAnswer: typeof item?.finalAnswer === 'string' && item.finalAnswer !== '' ? item.finalAnswer : null,
      kpIds: Array.isArray(item?.kpIds) ? item.kpIds.filter((id) => typeof id === 'string') : [],
    });
  }
  out.sort((a, b) => a.no - b.no);
  return { ok: true, questions: out, warnings };
}

/**
 * 扫出所有行首题号（**不**过滤连号），给答案对齐用。
 * @param {string} body 已归一化的文本
 * @returns {{lines: string[], marks: Array<{line: number, no: number, rest: string}>}}
 */
function scanMarks(body) {
  const lines = body.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = matchLead(lines[i]);
    if (hit !== null) marks.push({ line: i, no: hit.no, rest: hit.rest });
  }
  return { lines, marks };
}

/**
 * 按标记切块：相邻两个标记之间算一题。
 * @param {string[]} lines
 * @param {Array<{line: number, no: number, rest: string}>} marks
 * @returns {Array<{no: number, prompt: string}>}
 */
function blocksFromMarks(lines, marks) {
  const blocks = [];
  for (let k = 0; k < marks.length; k++) {
    const mark = marks[k];
    const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    blocks.push({ no: mark.no, prompt: [mark.rest, ...lines.slice(mark.line + 1, end)].join('\n').trim() });
  }
  return blocks;
}

/**
 * 把答案文本按题号切开，贴回题目列表。
 *
 * 与 `splitQuestions` 的关键差别：答案**不要求题号连号**——用户常常只答了一部分，
 * 跳号是正常的，这里按「出现的题号」逐个贴回，缺的进 `missing`。
 * 答案与题面不同源时也不猜：对不上的不写，交给调用方拒绝保存。
 * @param {Array<{no: number}>} questions
 * @param {unknown} answerText
 * @returns {{questions: Array<object>, matched: number, missing: number[], extra: number[]}}
 */
export function alignAnswers(questions, answerText) {
  const list = Array.isArray(questions) ? questions : [];
  const body = normalizeText(answerText);
  const byNo = new Map();
  const extra = [];

  if (body !== '') {
    const { lines, marks } = scanMarks(body);
    // 整段答案一个题号都没有：只有「单题」时才敢整段贴回，多题一律算缺
    const blocks = marks.length === 0
      ? (list.length === 1 ? [{ no: list[0].no, prompt: body }] : [])
      : blocksFromMarks(lines, marks);
    for (const block of blocks) {
      if (byNo.has(block.no)) {
        if (!extra.includes(block.no)) extra.push(block.no);
        continue;
      }
      byNo.set(block.no, block.prompt);
    }
  }

  const out = [];
  const missing = [];
  const qNos = new Set();
  for (const question of list) {
    qNos.add(question.no);
    const text = byNo.get(question.no);
    const answer = typeof text === 'string' && text !== '' ? text : null;
    out.push({ ...question, answer });
    if (answer === null) missing.push(question.no);
  }
  for (const no of byNo.keys()) {
    if (!qNos.has(no) && !extra.includes(no)) extra.push(no);
  }
  return { questions: out, matched: out.length - missing.length, missing, extra };
}

/**
 * 辅导版泄题自检。
 *
 * 判据（只报可能，不替用户决定）：最终答案是**实质长度**的内容（≥5 字符，去空白后）、
 * 且原样出现在辅导版里、且题干里没有它 —— 那就是把答案抄进了「只给提示」的那一版。
 * @param {{prompt?: unknown, guide?: unknown, finalAnswer?: unknown}} question
 * @returns {{risk: boolean, reasons: string[]}}
 */
export function validateAnswer(question) {
  const prompt = normalizeForMatch(question?.prompt);
  const guide = normalizeForMatch(question?.guide);
  const answer = normalizeForMatch(question?.finalAnswer);
  const reasons = [];
  if (answer.length >= 5 && !prompt.includes(answer) && guide.includes(answer)) {
    reasons.push('answer-leaked-in-guide');
  }
  return { risk: reasons.length > 0, reasons };
}
