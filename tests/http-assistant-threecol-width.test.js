// 学习助手三栏布局-正文宽度修复（2026-11-23）的钉子。
//
// 用户冒烟反馈：三栏（专注学习模式）下拖左栏右缘 / 右栏左缘，中间正文页宽不跟着变。
// 根因是两套控宽机制打架：三栏用 .sa-reader-pane 的 padding 让位（--sa-focus-rail / --sa-focus-chat），
// v2-H 正文手柄用 max-width（90ch / 内联 --sa-read-col）把页宽卡死；且正文手柄与右栏轴在右侧重复。
//
// 本卡口径：三栏态正文永远填满左右栏之间的剩余空间；三栏态只剩两根边界轴（左栏右缘 + 右栏左缘），
// 正文手柄不再显示；普通专注态（非三栏）与 v2-H 既有行为一字不动。
//
// 为什么是源码级：真拖拽要真 DOM + 真指针事件，本项目零依赖、没有浏览器测试栈
// （同 http-assistant-reader-width.test.js / focus-three-column-probe.test.js 的口径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

/** 取一条 CSS 规则（从选择器首次出现处到它的 `{` 之后的第一个 `}`）；选择器列表（a,b{）也认。 */
function cssRule(text, selector) {
  const at = text.indexOf(selector);
  assert.ok(at >= 0, `找不到 CSS 规则：${selector}`);
  const open = text.indexOf('{', at);
  assert.ok(open > at, `CSS 规则没开括号：${selector}`);
  const close = text.indexOf('}', open);
  assert.ok(close > open, `CSS 规则没闭合：${selector}`);
  return text.slice(at, close + 1);
}

/** 截一段源码：[start, end)。找不到标记就直接失败，免得静默退化成「在全文里碰巧命中」。 */
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到终点标记：${endMarker}`);
  return text.slice(start, end);
}

/** 以某个标记为中心截一段（用于「这个 JSX 处于哪个条件分支」这类判断）。 */
function around(text, marker, before, after) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `找不到标记：${marker}`);
  return text.slice(Math.max(0, at - before), at + after);
}

const KPTAB = sliceBetween(SOURCE, 'function KnowledgeTab({ docs = {}', 'const treeWorkspace = h(');
const SECTION = sliceBetween(SOURCE, "h('section', { className: 'sa-reader-pane'", 'lectureHintCard,');
const PAGE = sliceBetween(SOURCE, "return h('div', { className: 'sa-knowledge-page'", 'function RecordsTab(');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

// 新增：三栏态正文宽度规则（四条同款选择器合写一条）
const THREE_COL_WIDTH = cssRule(
  SOURCE,
  '.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]>.sa-node-detail',
);
// 既有：v2-H 拖过列宽后的覆盖规则（普通态用，必须原样保留）
const DRAGGED_OVERRIDE = cssRule(
  SOURCE,
  '.sa-reader-pane[data-focus-reader="true"][data-read-col-dragged="true"]>.sa-card',
);
// 新增：三栏态正文手柄退场
const SPLITTER_OFF = cssRule(
  SOURCE,
  '.sa-knowledge-page:has(.sa-reader-pane[data-focus-three-col="true"])>.sa-read-splitter',
);
// 新增：三栏 padding 让位（左/右栏宽决定中间区宽度）
const THREE_COL_PADDING = cssRule(
  SOURCE,
  '.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]{padding:',
);

test('① 三栏态正文卡取消限宽：max-width:none + width:auto + 两侧 margin 归零（吃满 padding 夹出的中间区）', () => {
  assert.ok(THREE_COL_WIDTH.includes('max-width:none'),
    '三栏态必须放开 max-width —— 90ch / --sa-read-col 会把页宽卡死，拖边界只剩白边变');
  assert.ok(THREE_COL_WIDTH.includes('width:auto'), '宽度交给容器（padding 夹出的剩余空间）');
  assert.ok(THREE_COL_WIDTH.includes('margin-left:0') && THREE_COL_WIDTH.includes('margin-right:0'),
    '两侧 margin 归零：auto 居中会把「填满」又变回「居中窄列」');

  // 四条选择器都要在（study-mode 与 focus-reader 两套标记 × card 与 node-detail 两种正文卡）
  for (const sel of [
    '.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]>.sa-node-detail',
    '.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]>.sa-card',
    '.sa-reader-pane[data-focus-reader="true"][data-focus-three-col="true"]>.sa-node-detail',
    '.sa-reader-pane[data-focus-reader="true"][data-focus-three-col="true"]>.sa-card',
  ]) {
    assert.ok(THREE_COL_WIDTH.includes(sel), `三栏正文宽度规则缺选择器：${sel}`);
  }

  // 门控严格：每条选择器都必须带 data-focus-three-col="true"（普通专注态不许被波及）
  const selectorPart = THREE_COL_WIDTH.slice(0, THREE_COL_WIDTH.indexOf('{'));
  const selectors = selectorPart.split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(selectors.length, 4, '恰好四条选择器');
  for (const sel of selectors) {
    assert.ok(sel.includes('[data-focus-three-col="true"]'), `选择器必须门控在三栏态：${sel}`);
  }

  // 特异性/顺序：必须写在 :3065 的 dragged 覆盖规则之后（同特异性靠顺序取胜），
  // 否则「拖过正文手柄再进三栏」时 max-width 会被 --sa-read-col 抢回去。
  assert.ok(SOURCE.indexOf('data-focus-three-col="true"]>.sa-card{max-width:none') > SOURCE.indexOf('data-read-col-dragged="true"]>.sa-card'),
    '三栏规则必须写在 data-read-col-dragged 覆盖规则之后，才盖得住 --sa-read-col');
});

test('② 三栏态正文手柄退场：CSS 层 display:none + 不吃指针；专注态恒三栏 → 手柄永不显示', () => {
  assert.ok(SPLITTER_OFF.includes('display:none'), '三栏态必须把 .sa-read-splitter 藏掉');
  assert.ok(/display:none\s*!important/.test(SPLITTER_OFF),
    'display 要 !important —— 手柄拖拽时会把 display:block 写进内联 style，普通规则盖不住');
  assert.ok(SPLITTER_OFF.includes('pointer-events:none'),
    '藏掉的同时要断指针：不许留一条看不见但能拖的热区挡住右栏左缘');
  assert.ok(SPLITTER_OFF.includes('data-focus-three-col="true"'), '隐藏必须门控在三栏态');

  // 专注态恒三栏：data-focus-three-col 的值就是 focusReading，所以「手柄会渲染」必然等于「手柄被隐藏」
  assert.ok(SECTION.includes("'data-focus-three-col': focusReading ? 'true' : 'false'"),
    'data-focus-three-col 必须由 focusReading 决定（专注即三栏），否则隐藏规则可能落空');
  assert.ok(SECTION.includes("'data-study-mode': focusReading ? 'true' : 'false'"), '阅读面标记同一闸门');

  // 手柄的 JSX 仍只在 focusReading 下出现（既有测试 ① 锚定这段，不能删）
  const branch = around(PAGE, "className: 'sa-read-splitter'", 900, 200);
  assert.ok(branch.includes("focusReading ? h('div', {"), '正文手柄只在专注态渲染（会被 ② 的 CSS 藏掉，等于专注态 0 显示）');

  // 右侧只留一根轴：merged 退场规则仍在（右栏开时手柄本来也退场，双保险）
  const merged = cssRule(SOURCE, '.sa-read-splitter[data-sa-axis="merged"]');
  assert.ok(merged.includes('display:none') && merged.includes('pointer-events:none'), 'merged 退场规则不许删');
});

test('③ v2-H 既有标识符与规则全在：startColResize / colWidth / --sa-read-col / data-read-col-dragged / 90ch 默认', () => {
  // 函数体不动（http-assistant-reader-width.test.js ⑥ 对 startColResize 后 2600 字符做源码断言）
  const at = KPTAB.indexOf('const startColResize = (event)');
  assert.ok(at >= 0, 'startColResize 必须还在（既有测试的回归钩子）');
  const body = KPTAB.slice(at, at + 2600);
  assert.ok(body.includes('measureReadCardMaxWidth(pane)'), '起算口径不许变（量 max-width）');
  assert.ok(body.includes('clampReadColumn(startW + ((Number(ev?.clientX) || 0) - startX), maxW)'), '拖拽算法不许变');
  assert.ok(body.includes('setColWidth(next)'), 'colWidth 仍在写回');
  assert.ok(KPTAB.includes('const [colWidth, setColWidth] = useState(() => readColumnWidthMemory)'), 'colWidth state 仍在');

  // 覆盖规则原样：只在 dragged 时用内联 --sa-read-col，且仍居中
  assert.ok(DRAGGED_OVERRIDE.includes('max-width:var(--sa-read-col'), '--sa-read-col 覆盖规则不许删/不许改语义');
  assert.ok(DRAGGED_OVERRIDE.includes('margin-left:auto') && DRAGGED_OVERRIDE.includes('margin-right:auto'), '普通态仍居中');
  assert.ok(SECTION.includes("'data-read-col-dragged': focusReading && colWidth != null ? 'true' : 'false'"), 'dragged 标记仍在');
  assert.ok(SECTION.includes("...(focusReading && colWidth != null ? { '--sa-read-col': colWidth + 'px' } : {})"), '--sa-read-col 内联仍在');

  // 普通专注态的 90ch 默认观感一字不动（三栏规则必须门控，不许全局取消）
  const plainStudy = cssRule(SOURCE, '.sa-reader-pane[data-study-mode="true"]>.sa-card');
  const plainFocus = cssRule(SOURCE, '.sa-reader-pane[data-focus-reader="true"]>.sa-card');
  for (const [name, rule] of [['data-study-mode', plainStudy], ['data-focus-reader', plainFocus]]) {
    assert.ok(rule.includes('max-width:90ch'), `${name} 默认列宽仍是 90ch`);
    assert.ok(rule.includes('margin-left:auto') && rule.includes('margin-right:auto'), `${name} 默认仍居中`);
    assert.ok(!rule.includes('max-width:none'), `${name} 默认规则不许被改成 max-width:none`);
  }

  // 手柄本体样式仍在（不是删代码，只是三栏态不显示）
  assert.ok(cssRule(SOURCE, '.sa-read-splitter{position:fixed').includes('width:20px'), '手柄 20px 热区样式仍保留');
});

test('④ 两根边界轴可拖且拖了正文跟着变：rail → --sa-focus-rail / chat → --sa-focus-chat → padding 夹宽', () => {
  // 两条轴的 CSS：竖线可见 + 20px 热区（与手柄同一手感）
  const boundary = cssRule(SOURCE, '.sa-focus-boundary{');
  assert.ok(boundary.includes('width:20px'), '边界轴要有 20px 热区（14px 太细，抓不住）');
  assert.ok(boundary.includes('cursor:ew-resize'), '光标东西向');
  assert.ok(boundary.includes('touch-action:none'), '禁掉触摸滚动手势，别被抢走');
  assert.ok(boundary.includes('transform:translateX(-50%)'), 'left 指边界线本身，不偏半格');
  const line = cssRule(SOURCE, '.sa-focus-boundary::before{');
  assert.ok(line.includes('width:2px') && line.includes('var(--dsw-alias-border-l1)'), '竖线 2px，走主题边框令牌');
  assert.ok(/opacity:\s*\.55/.test(line), '常态 .55 看得见又不抢戏');

  // JSX：左栏右缘 + 右栏左缘各一根，都进 startBoundaryResize
  assert.ok(PAGE.includes("onMouseDown: startBoundaryResize('rail')"), '左栏右缘要可拖');
  assert.ok(PAGE.includes("onMouseDown: startBoundaryResize('chat')"), '右栏左缘要可拖');
  assert.ok(PAGE.includes("'data-sa-boundary': 'rail'") && PAGE.includes("'data-sa-boundary': 'chat'"), '两条轴要有稳定锚点');
  assert.ok(PAGE.includes("style: { left: railWidth + 'px' }"), '左轴位置贴左栏右缘（railWidth）');
  assert.ok(PAGE.includes("left: 'calc(100vw - ' + chatWidth + 'px)'"), '右轴位置贴右栏左缘（calc(100vw - chatWidth)）');

  // 拖拽写回 state：rail → railWidth、chat → chatWidth，都夹在 FOCUS_*_MIN/MAX
  const start = KPTAB.indexOf('const startBoundaryResize = (side) => (event)');
  assert.ok(start >= 0, 'startBoundaryResize 必须在');
  const fn = KPTAB.slice(start, start + 1600);
  assert.ok(fn.includes("focusLayoutMemory.rail = next; setRailWidth(next)"), '左轴写回 railWidth');
  assert.ok(fn.includes("focusLayoutMemory.chat = next; setChatWidth(next)"), '右轴写回 chatWidth');
  assert.ok(fn.includes('clampFocusSize(startW + delta, lo, hi)'), '宽度要夹进 FOCUS_*_MIN/MAX');
  assert.ok(fn.includes("document.addEventListener('mousemove', onMove)"), '拖动靠 document mousemove');
  assert.ok(fn.includes("document.removeEventListener('mousemove', onMove)"), '松手要摘监听');

  // 闭环：三栏 padding 吃这两个变量 → 正文宽随之变（配合 ① 的 max-width:none）
  assert.ok(THREE_COL_PADDING.includes('var(--sa-focus-rail'), '左栏宽要经 padding-left 让位');
  assert.ok(THREE_COL_PADDING.includes('var(--sa-focus-chat'), '右栏宽要经 padding-right 让位');
  assert.ok(SECTION.includes("'--sa-focus-rail': (leftRailOpen ? railWidth : 0) + 'px'"), 'railWidth → --sa-focus-rail');
  assert.ok(SECTION.includes("'--sa-focus-chat': (rightChatOpen ? chatWidth : 0) + 'px'"), 'chatWidth → --sa-focus-chat');
});

test('⑤ 安全与主题令牌：新增规则 0 hex、0 处 dangerouslySetInnerHTML、两份 bundle 逐字一致', () => {
  for (const [name, css] of [['三栏正文宽度', THREE_COL_WIDTH], ['三栏 padding', THREE_COL_PADDING],
    ['手柄退场', SPLITTER_OFF], ['边界轴', cssRule(SOURCE, '.sa-focus-boundary{')],
    ['边界竖线', cssRule(SOURCE, '.sa-focus-boundary::before{')]]) {
    assert.equal(HEX.test(css), false, `${name} 规则里不许有硬编码 hex：${css}`);
  }
  for (const [name, text] of [['client.full.js', SOURCE], ['client.js', SHIPPED]]) {
    assert.ok(!text.includes('dangerouslySetInnerHTML'), `${name} 不许出现 dangerouslySetInnerHTML`);
  }
  assert.equal(SHIPPED, SOURCE, 'client.js 必须与 client.full.js 逐字一致（sync-client-full --reverse 后再 --check）');
});
