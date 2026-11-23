// 学习助手 v2-H 返工（2026-11-23）：专注阅读「可见竖向分隔条」可拖动正文列宽的钉子。
//
// 为什么是源码级：真拖拽要真 DOM + 真指针事件，本项目零依赖、没有浏览器测试栈
// （v2-G 浮层拖拽手柄同样是源码级钉子，见 tests/http-assistant-panel-ui.test.js）。
// 上一版（v2-H 首版）手柄挂在 .sa-reader-pane 内部 → 被 overflow 裁剪 + 被右侧滚动条盖住，
// 用户实测「拖不动」。返工的口径就是「挂对祖先 + 常态可见 + 该有的都在、不该有的没有」：
//   ① .sa-read-splitter 是 .sa-knowledge-page 直接子级，**不在** .sa-reader-pane 内；旧 .sa-reader-resize 已 0 命中；
//   ② 常态可见：20px 热区 + 中间一条 2px ::before 竖线 + cursor:ew-resize；
//   ③ splitterStyle.left 由正文卡 getBoundingClientRect().right 算出（贴正文右边界）；
//   ④ 只有 data-read-col-dragged="true" 才覆盖 max-width（未拖动仍是 90ch 居中，默认观感一字不动）；
//   ⑤ readColumnWidthMemory 是模块级 let、默认 null、不落盘；startColResize 松手与卸载都摘监听；
//   ⑥ 0 处 dangerouslySetInnerHTML；⑦ 新增 CSS 无 hex 色值；⑧ 左侧 200px 竖条不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

/** 截一段源码：[start, end)。找不到标记就直接失败，免得静默退化成「在全文里碰巧命中」。 */
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到终点标记：${endMarker}`);
  return text.slice(start, end);
}

/** 取一条 CSS 规则（从选择器首次出现处到它的 `{` 之后的第一个 `}`）；选择器列表（a:hover::before,b::before{）也认。 */
function cssRule(text, selector) {
  const at = text.indexOf(selector);
  assert.ok(at >= 0, `找不到 CSS 规则：${selector}`);
  const open = text.indexOf('{', at);
  assert.ok(open > at, `CSS 规则没开括号：${selector}`);
  const close = text.indexOf('}', open);
  assert.ok(close > open, `CSS 规则没闭合：${selector}`);
  return text.slice(at, close + 1);
}

// KnowledgeTab 组件本体（到 treeWorkspace 拼装处收口，覆盖 state / 拖拽函数 / 渲染段）
const KPTAB = sliceBetween(SOURCE, 'function KnowledgeTab({ docs = {}', 'const treeWorkspace = h(');
// reader-pane 的渲染段（section 开标签到正文卡之前）—— 返工后这里**不该**再有分隔条
const SECTION = sliceBetween(SOURCE, "h('section', { className: 'sa-reader-pane'", 'lectureHintCard,');
// .sa-knowledge-page 的返回段（从返回语句到组件结束）—— 分隔条应挂在这里
const PAGE = sliceBetween(SOURCE, "return h('div', { className: 'sa-knowledge-page'", 'function RecordsTab(');
// 新增/移除的 CSS
const SPLITTER = cssRule(SOURCE, '.sa-read-splitter{position:fixed');
const SPLITTER_LINE = cssRule(SOURCE, '.sa-read-splitter::before{');
const SPLITTER_ACTIVE = cssRule(SOURCE, '.sa-read-splitter:hover::before');
const SPLITTER_HOVER = cssRule(SOURCE, '.sa-read-splitter:hover{');
const OVERRIDE = cssRule(
  SOURCE,
  '.sa-reader-pane[data-focus-reader="true"][data-read-col-dragged="true"]>.sa-card',
);
const HEX = /#[0-9a-fA-F]{3,8}\b/;

test('① 分隔条挂对祖先：.sa-knowledge-page 直接子级，绝不在 .sa-reader-pane 内部（返工根因）', () => {
  assert.ok(PAGE.includes("className: 'sa-knowledge-page', ref: splitterHostRef"),
    '宿主要拿 ref：位置测量另外靠它做挂载校验');
  assert.ok(PAGE.includes("className: 'sa-read-splitter'"), '分隔条要渲染在 .sa-knowledge-page 的子列表里');
  assert.ok(PAGE.includes('onMouseDown: startColResize'), '分隔条按下要进 startColResize');
  assert.ok(PAGE.includes("role: 'separator'") && PAGE.includes("'aria-orientation': 'vertical'"),
    '无障碍语义：竖向分隔条（可拖动 = 改变两侧宽度）');
  assert.ok(PAGE.includes("'data-sa-read-splitter': true"), '分隔条要有稳定锚点，供真机冒烟与测试定位');
  assert.ok(PAGE.includes("focusReading ? h('div', {"), '分隔条只在专注阅读时出现（平时不挡任何东西）');
  assert.ok(PAGE.includes('style: splitterStyle'), '位置走内联样式（left 由 JS 按正文卡右边界算）');

  // 根因防线：手柄不许再出现在 reader-pane 的 children 里
  assert.ok(!SECTION.includes('sa-read-splitter'), '.sa-reader-pane 里不许再挂分隔条（会被 overflow 裁 + 被滚动条盖）');
  assert.ok(!SECTION.includes('sa-reader-resize'), 'reader-pane 里旧的 .sa-reader-resize 必须已删干净');
  assert.equal(SOURCE.split('sa-reader-resize').length - 1, 0, '旧手柄样式/标记全文 0 命中');

  // 结构顺序：knowledge-page 在 reader-pane 外层（源码里 knowledge-page 的 return 在 section 之后）
  assert.ok(SOURCE.indexOf("className: 'sa-knowledge-page'") > SOURCE.indexOf("className: 'sa-reader-pane'"),
    '.sa-knowledge-page 是 reader-pane 的祖先（return 语句在外层）');
});

test('② 常态可见：20px 热区 + 中间 2px 竖线 + cursor:ew-resize + 悬停变主题色', () => {
  assert.ok(SPLITTER.includes('position:fixed'), '分隔条 fixed 到视口，不随阅读面滚动');
  assert.ok(SPLITTER.includes('top:0') && SPLITTER.includes('bottom:0'), '竖条通高：一眼看出这里是可拖的边界');
  assert.ok(SPLITTER.includes('width:20px'), '20px 热区：够抓、又不挡正文');
  assert.ok(SPLITTER.includes('cursor:ew-resize'), '光标要是东西向（左右）拖拽');
  assert.ok(SPLITTER.includes('touch-action:none'), '禁用触摸默认手势，避免拖动被滚动手势抢走');
  assert.ok(SPLITTER.includes('background:transparent'), '热区本身透明，只露中间那根竖线');
  assert.ok(SPLITTER.includes('transform:translateX(-50%)'), 'left 指的是竖线本身，不偏半格');

  // 常态可见的那条线：不是 opacity:0，也不是靠 hover 才出现
  assert.ok(SPLITTER_LINE.includes('content:'), '::before 要真的画出线');
  assert.ok(SPLITTER_LINE.includes('width:2px'), '线宽 2px');
  assert.ok(SPLITTER_LINE.includes('var(--dsw-alias-border-l1)'), '线色用别名边框令牌');
  assert.ok(/opacity:\s*\.55/.test(SPLITTER_LINE), '常态 .55 不透明度 —— 看得见但不抢戏');

  assert.ok(SPLITTER_ACTIVE.includes('var(--dsw-alias-brand-primary)'), 'hover / 拖动中换成品牌色令牌');
  assert.ok(SPLITTER_ACTIVE.includes('opacity:1'), 'hover / 拖动中线要实');
  assert.ok(SPLITTER_HOVER.includes('color-mix(in srgb'), '悬停热区给一层淡淡的品牌色底，强化「可拖」暗示');
});

test('③ 位置跟随：left 由正文卡 getBoundingClientRect().right 算，并随 colWidth/readScale 重算', () => {
  const at = KPTAB.indexOf('const computeSplitterStyle = ()');
  assert.ok(at >= 0, 'computeSplitterStyle 必须在 KnowledgeTab 内（要拿 readerRef / splitterHostRef）');
  const body = KPTAB.slice(at, at + 900);
  assert.ok(body.includes('splitterHostRef.current') && body.includes('readerRef.current'),
    '两个 ref 都要校验（宿主存在 + 阅读面存在）');
  assert.ok(body.includes('getBoundingClientRect()'), '要量正文卡的真实矩形');
  assert.ok(body.includes('right = r.right'), '取矩形右边界当分隔条 left（贴正文卡右缘）');
  assert.ok(body.includes("left: Math.round(right) + 'px'"), 'left 四舍五入到整像素写内联');
  assert.ok(body.includes('innerWidth - 30'), '量不到要兜底贴右侧，至少能看见、能拖');

  assert.ok(KPTAB.includes('const splitterHostRef = useRef(null)'), 'KnowledgeTab 内要有宿主 ref');
  assert.ok(KPTAB.includes('const [splitterStyle, setSplitterStyle] = useState'),
    '位置走 state，随窗口/进出专注刷新');
  assert.ok(KPTAB.includes('}, [focusReading, colWidth, readScale]);'),
    '依赖三件套：进出专注 / 拖动改列宽 / 字号倍率都要重算位置');
  assert.ok(KPTAB.includes('window.addEventListener(\'resize\', recompute)'),
    '面板伸缩（窗口 resize）也要重算');
  assert.ok(KPTAB.includes('!focusReading) { setSplitterStyle({ left: \'0px\', display: \'none\' })'),
    '退出专注要收掉分隔条');
});

test('④ 只有拖过（data-read-col-dragged="true"）才覆盖 90ch，未拖动仍是 90ch 居中', () => {
  const occurrences = OVERRIDE.split('data-read-col-dragged="true"').length - 1;
  assert.equal(occurrences, 1, '覆盖规则自身要带 dragged 条件');
  assert.ok(OVERRIDE.includes('max-width:var(--sa-read-col'), '列宽走内联 CSS 变量 --sa-read-col');
  // 2026-11-23 用户反馈「一拖就贴左」→ 改为始终居中：覆盖规则与默认可视同款 margin auto 居中
  assert.ok(OVERRIDE.includes('margin-left:auto'), '拖过之后仍居中（不贴左）');
  assert.ok(OVERRIDE.includes('margin-right:auto'), '拖过之后仍居中（两侧 auto）');
  assert.ok(!OVERRIDE.includes('max-width:90ch'), '覆盖规则里不许再出现 90ch');

  // 默认（没拖过）那两条 90ch 必须原样留着 —— 这是「观感一字不动」的防回归底线
  const plainStudy = cssRule(SOURCE, '.sa-reader-pane[data-study-mode="true"]>.sa-card');
  const plainFocus = cssRule(SOURCE, '.sa-reader-pane[data-focus-reader="true"]>.sa-card');
  for (const [name, rule] of [['data-study-mode', plainStudy], ['data-focus-reader', plainFocus]]) {
    assert.ok(rule.includes('max-width:90ch'), `${name} 的默认列宽仍是 90ch`);
    assert.ok(rule.includes('margin-left:auto') && rule.includes('margin-right:auto'), `${name} 的默认仍是居中`);
  }

  // 渲染侧：属性与变量都挂 focusReading && colWidth != null 这一个闸门上
  assert.ok(SECTION.includes("'data-read-col-dragged': focusReading && colWidth != null ? 'true' : 'false'"),
    'data-read-col-dragged 必须由「专注 + 拖过」共同决定，别处不许无条件置 true');
  assert.ok(SECTION.includes("...(focusReading && colWidth != null ? { '--sa-read-col': colWidth + 'px' } : {})"),
    '--sa-read-col 只在拖过之后才写内联样式');
});

test('⑤ readColumnWidthMemory 是模块级 let、默认 null、不落盘', () => {
  assert.ok(/^ {4}let readColumnWidthMemory = null;/m.test(SOURCE),
    '模块级（4 空格缩进，与 assistSizeMemory 同区）let，默认 null');
  const MEMORY = sliceBetween(SOURCE, 'let readColumnWidthMemory = null;', 'function measureReadPaneColumnWidth');
  assert.ok(MEMORY.includes('const READ_COLUMN_MIN = 360'), '最窄 360px：再窄正文挤成一条');
  assert.ok(!MEMORY.includes('localStorage'), '列宽不许进 localStorage（不落盘，刷新回默认）');
  assert.ok(!MEMORY.includes('fetch('), '列宽不许上报服务端 / 写学习台 JSON');
  assert.ok(MEMORY.includes('function clampReadColumn'), '夹取函数在模块级，拖拽时复用');

  assert.ok(KPTAB.includes('const [colWidth, setColWidth] = useState(() => readColumnWidthMemory)'),
    'KnowledgeTab 的 colWidth 初值来自模块记忆：退出再进仍记得上次宽度');
  assert.ok(!KPTAB.includes('setColWidth(null)'), '退出专注不许清掉 colWidth（记住；刷新才回默认）');
});

test('⑥ startColResize：量真实列宽作起点 + mousemove/mouseup + 松手与卸载都摘监听', () => {
  const at = KPTAB.indexOf('const startColResize = (event)');
  assert.ok(at >= 0, 'startColResize 必须在 KnowledgeTab 内（要拿 readerRef）');
  const body = KPTAB.slice(at, at + 2600);
  assert.ok(body.includes('measureReadCardMaxWidth(pane)'), '起点优先取 max-width（content-box 的 .sa-card 不能拿矩形宽当起点，否则跑得比鼠标快）');
  assert.ok(body.includes('measureReadPaneColumnWidth(pane)'), '退回口径：拿不到 max-width 时量正文卡真实像素宽');
  assert.ok(body.includes('const leftPad = viewW > 0 && viewW <= 720 ? 132 : 212'),
    '左侧让位跟随响应式：窄屏 132 / 宽屏 212');
  assert.ok(body.includes('const maxW = Math.max(READ_COLUMN_MIN, viewW - leftPad - 36)'),
    '上限＝屏宽 − 左侧让位 − 右内边距 18 − 手柄余量');
  assert.ok(body.includes('clampReadColumn(startW + ((Number(ev?.clientX) || 0) - startX), maxW)'),
    '往右拖 dx>0 变宽：newW = startW + dx，并夹进 [360, maxW]');
  assert.ok(!body.includes('startW - dx'), '不能是减 dx（那是左手柄的算法，右侧手柄往右拖应更宽）');
  assert.ok(body.includes('const pane = readerRef.current'), '仍从 reader-pane 的 ref 拿滚动容器（ref 没变）');
  assert.ok(body.includes("document.addEventListener('mousemove', onMove)"), '拖动靠 document 上的 mousemove');
  assert.ok(body.includes("document.addEventListener('mouseup', onUp)"), '松手靠 document 上的 mouseup');
  assert.ok(body.includes("document.removeEventListener('mousemove', onMove)"), 'cleanup 要摘 mousemove');
  assert.ok(body.includes("document.removeEventListener('mouseup', onUp)"), 'cleanup 要摘 mouseup');
  assert.ok(body.includes('readColumnWidthMemory = next'), '每帧写回模块记忆');
  assert.ok(body.includes('setColWidth(next)'), '每帧写回 state 触发重绘');
  assert.ok(body.includes("handle.dataset.dragging = 'true'"), '拖动中挂 data-dragging，CSS 高亮竖线');
  assert.ok(body.includes('const handle = event.currentTarget'), 'handle 取 currentTarget（返工后是分隔条）');

  // 组件卸载（退出专注 / 切页签）必须清监听，否则拖到一半卸载会留下悬空的 mousemove
  assert.ok(KPTAB.includes('useEffect(() => () => { stopColResize(); }, [])'),
    '卸载 effect 要摘监听（同 v2-G stopResize 的做法）');
  assert.ok(KPTAB.includes('const stopColResize = () =>'), 'stopColResize 必须存在，松手/卸载共用一份 cleanup');
});

test('⑦ 安全回归：0 处 dangerouslySetInnerHTML、新增 CSS 无 hex', () => {
  for (const [name, text] of [['client.full.js', SOURCE], ['client.js', SHIPPED]]) {
    assert.ok(!text.includes('dangerouslySetInnerHTML'), `${name} 不许出现 dangerouslySetInnerHTML`);
  }
  for (const [name, css] of [['.sa-read-splitter', SPLITTER], ['::before', SPLITTER_LINE],
    [':hover::before', SPLITTER_ACTIVE], [':hover', SPLITTER_HOVER], ['dragged 覆盖', OVERRIDE]]) {
    assert.ok(!HEX.test(css), `${name} 里不许有 hex 色值（一律 --dsw-alias-* 令牌）：${css}`);
  }
});

test('⑧ 左侧竖条与默认观感都不动：.sa-focus-header 仍 200px / 两份 bundle 逐字一致', () => {
  const header = cssRule(SOURCE, '.sa-focus-header{position:fixed');
  assert.ok(header.includes('width:200px'), '左侧竖条宽度不动（用户只要求改正文列）');
  assert.ok(header.includes('left:0') && header.includes('position:fixed'), '竖条定位不动');
  assert.equal(SHIPPED, SOURCE, 'client.js 必须与 client.full.js 逐字一致（sync-client-full --reverse 后再 --check）');
});
