#!/usr/bin/env node
/**
 * 面板烟测的「坏词泄漏」判据（2026-11-26 从 tools/panel-smoke.mjs 抽出成纯函数）。
 *
 * 为什么要抽：判据本身需要被单测钉住——2026-10-27 那次收紧（`NaNbO₃` 误报）和
 * 2026-11-25 那次长期红灯（正文真的在讲 IEEE-754 的 `NaN`），都是因为判据藏在
 * 烟测脚本里、没有任何负例/正例护着，只能靠人肉回归。
 *
 * 本文件不 import 任何插件内部模块，只吃一个 HTML 字符串，返回命中列表：
 *   judgeBadWords(html) -> [{ token, snippet }]，空数组 = 干净。
 *
 * v1（三条「整串 HTML 全文扫描」）已于 2026-11-26 被 v2 取代：全文扫描会把
 * HTML 属性值、`<code>` 引用的字面量、公式里的数学记号全算进去，真数据下必然误报。
 * v2 先切块、再把「像公式」的块整块跳过、最后只认结构位（整块 / 量词位 / 冒号块尾 / 日期位），
 * 只有模板渲染失败的形态才报。
 *
 * 为什么靠文本特征而不是 class：烟测的 HTML 来自面板 renderToMarkup，它只输出
 * `<tag>children</tag>`、属性全丢，真实 HTML 里既没有 class="sa-formula" 也没有 style。
 */

const TOKENS = ['NaN', 'undefined', '[object Object]'];

// —— 第 1 步：切块 ——

// 这些容器整段丢弃（连内容）。`<code>NaN</code>` 是作者引用的字面量，只剥标签会
// 在块里留下一个独立成块的 `NaN`，正好撞上「整块只有坏词」这条规则，造出假命中。
const DROP_CONTAINER = /<(code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

// 块级边界标签：出现即断块。
const BLOCK_TAG_SRC = 'p|div|li|td|th|ul|ol|h1|h2|h3|h4|h5|h6|br|tr|blockquote|pre';

// 行内标签：透明，保留内容、不断块。
const INLINE_TAG_SRC = 'span|b|i|em|strong|a|sup|sub|u|small|mark|kbd|svg';

const BLOCK_TAG_RE = new RegExp(`</?(${BLOCK_TAG_SRC})\\b[^>]*>`, 'giu');
const INLINE_TAG_RE = new RegExp(`</?(${INLINE_TAG_SRC})\\b[^>]*>`, 'giu');
// 其余标签（含未知标签）一律透明：属性永远不参与判定，只保留内容。
const ANY_TAG_RE = /<[^>]*>/gu;

// 块分隔用私有哨兵，而不是 `\n`——正文里本来就有换行，用 `\n` 会把一段话拆成多块，
// 拆出来的碎片（比如独立成块的 `NaN`）会造出新的假命中。
const SEP = '\u0000';

const ENTITY_MAP = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
};
const ENTITY_RE = /&(?:lt|gt|quot|nbsp|amp|#39);/gu;

const decodeEntities = (text) => text.replace(ENTITY_RE, (entity) => ENTITY_MAP[entity] ?? entity);
const squash = (text) => text.replace(/\s+/gu, ' ').trim();

/** 把 HTML 拆成「块」数组：已丢 code/script/style，块内是纯文本，空块丢弃。 */
function toBlocks(html) {
  let text = String(html ?? '');
  text = text.replace(DROP_CONTAINER, SEP);
  text = text.replace(BLOCK_TAG_RE, SEP);
  text = text.replace(INLINE_TAG_RE, '');
  text = text.replace(ANY_TAG_RE, '');
  text = decodeEntities(text);
  return text.split(SEP).map(squash).filter((block) => block !== '');
}

// —— 第 2 步：这块「像不像公式」 ——

// 命中任一条就整块跳过，不做坏词判定。
const FORMULA_RULES = [
  // 公式符号：关系符、运算符、集合符、LaTeX 的花括号/上下标/反斜杠
  /[∼≤≥≠±×÷∫∑√∞≈≡⟹⇒→←↔∈∉⊂∪∩\\{}^_]/u,
  // LaTeX 命令，如 \mathrm、\boxed
  /\\[A-Za-z]{2,}/u,
  // 数学定界符
  /\$/u,
  // 「变量 比较符 值」形态的式子，如 x<NaN=false
  /[\w\u4e00-\u9fa5]\s*[<>]\s*\w/u,
];

const isFormulaLike = (block) => FORMULA_RULES.some((rule) => rule.test(block));

// —— 第 3 步：结构位判定 ——

const UNITS = '条|个|页|天|分钟|分|小时|次|道|项|门|节|章|元|%|％|K|字';
const escapeToken = (token) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// 坏词按 token 预编译四条结构位规则；块整体命中一次就报这一次。
const STRUCTURAL_RULES = TOKENS.map((token) => ({
  token,
  // a) 整块就是坏词（表格单元格、徽标、独立文本块）
  onlyToken: new RegExp(`^${escapeToken(token)}$`, 'u'),
  // b) 坏词紧跟量词/单位，如「共 NaN 条」「NaN 分钟」「NaN%」
  withUnit: new RegExp(`${escapeToken(token)}\\s*(?:${UNITS})`, 'u'),
  // c) 冒号 + 块尾，如「用时：NaN」
  afterColon: new RegExp(`[:：]\\s*${escapeToken(token)}\\s*$`, 'u'),
}));

// d) 日期/路径位：坏日期或坏路径，不管前面有没有量词。
const DATE_PATH_RE = /NaN-NaN-NaN|NaT|Invalid Date|undefined\/undefined|NaN\/NaN/u;

/** 这一块对某个 token 是否算结构位命中。 */
function hitsToken(block, rule) {
  if (rule.onlyToken.test(block)) return true;
  if (rule.withUnit.test(block)) return true;
  if (rule.afterColon.test(block)) return true;
  const datePath = block.match(DATE_PATH_RE);
  if (datePath !== null) {
    if (datePath[0].includes('undefined')) return rule.token === 'undefined';
    if (datePath[0].includes('NaN')) return rule.token === 'NaN';
    // NaT / Invalid Date 是「日期算不出来」的日期位，算 NaN 这一类
    return rule.token === 'NaN';
  }
  return false;
}

/** 命中块里坏词 ± 24 字符，空白压成单空格。 */
function snippetOf(block, token) {
  const index = block.indexOf(token);
  if (index < 0) return block.slice(0, 48);
  const start = Math.max(0, index - 24);
  return block.slice(start, index + token.length + 24);
}

/** 判据入口：返回 [{ token, snippet }]，空数组表示没漏出坏词。 */
export function judgeBadWords(html) {
  const hits = [];
  for (const block of toBlocks(html)) {
    if (isFormulaLike(block)) continue;
    for (const rule of STRUCTURAL_RULES) {
      if (!hitsToken(block, rule)) continue;
      hits.push({ token: rule.token, snippet: snippetOf(block, rule.token) });
    }
  }
  return hits;
}
