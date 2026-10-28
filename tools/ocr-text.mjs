// 取字工具的纯文本处理：从 `ocr-gemini.mjs` 抽出来，好让测试能直接 import。
//
// `ocr-gemini.mjs` 文件尾部是顶层 `try/finally` + `process.exit`，一 import 就跑全流程
// （会去拉 Edge、渲染 PDF），所以纯函数必须单独放一个没有副作用的模块。
//
// 这里只有字符串进出：页标记识别、模型名噪声、页拆分、质量门、单页无标记兜底。

// 取字指令要求模型每页写一行 `=== 第 N 页 ===`；模型偶尔带上 markdown 装饰（`**=== 第 1 页 ===**`、
// 行首列表符号/引用符号），所以 splitPages 的锚点允许前后带这些符号。
const PAGE_MARK_RE = /^[ \t>*`#-]*===\s*第\s*(\d+)\s*页\s*===[ \t*`]*$/m;

// Google 在每条回答末尾追加的页脚：不应进正文（早期用 'Flash\r\n' 当页脚，那是模型名标签，
// 一旦真命中会把第 1 页之后的内容全截掉，故删除）。
export const FOOTER_CUTS = [
  'Gemini 是一款 AI 工具',
  'Gemini can make mistakes',
  'Gemini 可以出错',
  'Gemini 可能会出错',
];

/** 只剔「整行就是一个模型名」的行（Flash / Gemini 2.5 Pro …），正文里出现的词一律不动。 */
export function stripModelNoise(text) {
  return String(text || '')
    .replace(/^[ \t]*(?:Flash|Gemini(?:[ \t]*[\d.]+)?(?:[ \t]+(?:Pro|Flash|Ultra|Nano))?)[ \t]*$/gmu, '')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从「整条回复 / 整页 innerText」里抠出从第 1 页标记开始的正文。没有标记回 null。 */
export function extractTranscript(raw) {
  const start = String(raw || '').search(/===\s*第\s*1\s*页\s*===/);
  if (start < 0) return null;
  let text = String(raw).slice(start);
  for (const cut of FOOTER_CUTS) {
    const i = text.indexOf(cut);
    if (i > 0) text = text.slice(0, i);
  }
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按页标记切页 → [{no, body}]。正文里后续再出现模型名行也会被剔掉。 */
export function splitPages(text) {
  const parts = String(text || '').split(PAGE_MARK_RE);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ no: Number(parts[i]), body: stripModelNoise(parts[i + 1]) });
  return out;
}

/**
 * 单页批次「模型答完但没写页标记」的兜底。
 *
 * 只上传一张图时不存在「文字对不回页」的风险，整段就是这一页；多页批次绝不能这么干
 * （没有标记无法知道哪段属于哪页），那种情况仍要报失败，由上层拆成单页重跑。
 *
 * @param {string} raw  最后一条 model-response 的 innerText（拿不到时传空串）
 * @param {string} body  退回用的整页 document.body.innerText
 * @returns {{ok: boolean, text?: string, chars: number, reason?: string}}
 */
export function acceptSinglePageText(raw, body) {
  const fromReply = !!(raw && String(raw).length > 20);
  let whole = String(fromReply ? raw : body || '');
  // 先按页脚截断再判长度：正常回复的结尾就带「Gemini 可以出错」，把这类字符串当**黑名单**会
  // 把整段的正常回复一起判掉（2026-10-21 实测白丢 p52 一页）。
  for (const cut of FOOTER_CUTS) {
    const i = whole.indexOf(cut);
    if (i > 0) whole = whole.slice(0, i);
  }
  whole = stripModelNoise(whole).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (whole.length < 40) return { ok: false, chars: whole.length, reason: 'too-short' };
  // 退回整页 innerText 时里面混着提问原文与按钮文案，这种整段落盘等于放假字。
  if (!fromReply && /你说|You said|输入消息|Ask Gemini/.test(whole)) {
    return { ok: false, chars: whole.length, reason: 'ui-noise' };
  }
  return { ok: true, text: '=== 第 1 页 ===\n' + whole, chars: whole.length };
}

/** 质量门：同一字符占比过高（数学符号被写成同一个字母）或几乎没有字母。 */
export function qualityOf(text) {
  const letters = String(text || '').replace(/[^A-Za-z]/g, '');
  const counts = new Map();
  for (const ch of letters.toUpperCase()) counts.set(ch, (counts.get(ch) || 0) + 1);
  let top = { ch: '', n: 0 };
  for (const [ch, n] of counts) if (n > top.n) top = { ch, n };
  const ratio = letters.length ? top.n / letters.length : 0;
  return { letters: letters.length, topChar: top.ch, ratio: Number(ratio.toFixed(3)), suspect: letters.length > 40 && ratio > 0.5 };
}
