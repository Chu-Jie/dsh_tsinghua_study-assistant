// 学习助手浮层面板 UI（v2-G，2026-11-22；v2-G 补丁 2026-11-23 把拖拽手柄挪到左上角）的钉子：左上角拖拽缩放 / 不透明底色 / 面板自管深浅主题。
//
// 为什么是源码级：React 拖拽与主题切换要真 DOM + 真指针事件才测得动，而本项目没有浏览器测试栈
// （零依赖）。卡 ⑥ 定的口径就是"该有的都在、不该有的没有"——这里逐条锁死：
//   ① sa-assist-resize 手柄在（左上角，border-left/border-top 三角）；② 宽高读 state（CSS 只留 min/max 兜底）；③ moon/sun 两分支 + 顶栏按钮；
//   ④ 模块级 assistThemeMemory 与 data-sa-assist-theme；⑤ 深浅两套 --sa-assist-* 变量 + 深色覆盖块；
//   ⑥ 安全回归（0 处 dangerouslySetInnerHTML、面板区域无行内 hex）；⑦ 既有钉子与 v2-F 气泡没被撞坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

/** 截一段源码：[start, end)。找不到标记就直接失败，免得静默退化成"在全文里碰巧命中"。 */
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到终点标记：${endMarker}`);
  return text.slice(start, end);
}

/** 取一条 CSS 规则（从 `选择器{` 到它的第一个 `}`）。 */
function cssRule(text, selector) {
  const at = text.indexOf(`${selector}{`);
  assert.ok(at >= 0, `找不到 CSS 规则：${selector}`);
  const close = text.indexOf('}', at);
  assert.ok(close > at, `CSS 规则没闭合：${selector}`);
  return text.slice(at, close + 1);
}

// 面板那一整片 CSS（从 .sa-assist 开始到 print 收口）
const CSS = sliceBetween(SOURCE, '.sa-assist{position:absolute', '@media print{.sa-assist{display:none');
// 组件本体（从 AssistantOverlay 到 MainPanel）
const OVERLAY = sliceBetween(SOURCE, 'function AssistantOverlay', 'function MainPanel');
// 图标工厂
const ICONS = sliceBetween(SOURCE, 'function AssistHeadIcon', 'function AssistantOverlay');

test('① 左上角拖拽手柄：类名 + cursor:nwse-resize + onMouseDown 都接上了（v2-G 补丁：手柄移到左上）', () => {
  const handleCss = cssRule(CSS, '.sa-assist-resize');
  assert.ok(handleCss.includes('cursor:nwse-resize'), '手柄光标要是 nwse-resize（左上角缩放仍是 NW-SE 方向）');
  assert.ok(handleCss.includes('position:absolute'), '手柄绝对定位在面板左上角');
  assert.ok(handleCss.includes('left:0') && handleCss.includes('top:0'), '手柄贴着左上角');
  assert.ok(!handleCss.includes('right:0') && !handleCss.includes('bottom:0'),
    '手柄不许再贴右下角（贴右下时鼠标一出屏幕就拖不动）');
  assert.ok(handleCss.includes('align-items:flex-start') && handleCss.includes('justify-content:flex-start'),
    '三角要对齐到左上角');
  const handleArrow = cssRule(CSS, '.sa-assist-resize::after');
  assert.ok(handleArrow.includes('border-left:2px solid currentColor'), '左上角三角要画左边');
  assert.ok(handleArrow.includes('border-top:2px solid currentColor'), '左上角三角要画上边');
  assert.ok(handleArrow.includes('border-top-left-radius:2px'), '圆角留在左上角');
  assert.ok(!handleArrow.includes('border-right:') && !handleArrow.includes('border-bottom:'),
    '原右下角的两条描边要去掉');
  assert.ok(OVERLAY.includes("className: 'sa-assist-resize'"), '面板里要渲染出 .sa-assist-resize 节点');
  assert.ok(OVERLAY.includes('onMouseDown: startResize'), '手柄按下要进 startResize');
  assert.ok(OVERLAY.includes('const startResize = (event)'), 'startResize 必须存在');
});

test('② 面板宽高读 state，CSS 只剩 min/max 兜底（不再写死 460px 当唯一尺寸）', () => {
  assert.ok(OVERLAY.includes('style: { width: `${size.w}px`, height: `${size.h}px` }'),
    '面板宽高必须来自 state 的 size.w / size.h');
  assert.ok(OVERLAY.includes('const [size, setSize] = useState(() => ({ w: assistSizeMemory.w, h: assistSizeMemory.h }))'),
    '尺寸 state 的初值来自模块记忆 assistSizeMemory');
  const panelCss = cssRule(CSS, '.sa-assist-panel');
  for (const cap of ['min-width:', 'max-width:', 'min-height:', 'max-height:']) {
    assert.ok(panelCss.includes(cap), `CSS 兜底要留 ${cap}`);
  }
  assert.ok(panelCss.includes('width:min(360px,calc(100cqw - 28px))'), '首屏默认宽仍是 360px（min 250 的经验值不动）');
});

test('③ 拖拽算尺寸：往左拖变宽 / 往上拖变高（newW = startW - dx、newH = startH - dy）+ clamp + 记忆写回 + 监听清理', () => {
  const at = OVERLAY.indexOf('const startResize = (event)');
  const body = OVERLAY.slice(at, at + 2600);
  assert.ok(body.includes('const dx = (Number(ev?.clientX) || 0) - startX'), '横向位移按 clientX 算');
  assert.ok(body.includes('const dy = (Number(ev?.clientY) || 0) - startY'), '纵向位移按 clientY 算');
  assert.ok(body.includes('startW - dx'), '宽度 = 起点宽 - dx（手柄在左上，往左拖 dx<0 变宽）');
  assert.ok(!body.includes('startW + dx'), '宽度不能再是起点宽 + dx（那是手柄在右下的算法）');
  assert.ok(body.includes('startH - dy'), '高度 = 起点高 - dy（面板右下角锚定，往上拖变高）');
  assert.ok(body.includes('clampAssistSize(startW - dx, ASSIST_SIZE_MIN.w, maxW)'), '宽度夹到最小/可用上限');
  assert.ok(body.includes('clampAssistSize(startH - dy, ASSIST_SIZE_MIN.h, maxH)'), '高度夹到最小/可用上限');
  assert.ok(body.includes('assistSizeMemory = next'), '每一帧都把尺寸写回模块记忆（松手即记住）');
  assert.ok(body.includes("document.addEventListener('mousemove', onMove)"), '拖动期间挂 mousemove');
  assert.ok(body.includes("document.addEventListener('mouseup', onUp)"), '松手靠 mouseup 收口');
  assert.ok(body.includes("document.removeEventListener('mousemove', onMove)"), '收口必须摘 mousemove，不能泄漏');
  assert.ok(body.includes("document.removeEventListener('mouseup', onUp)"), '收口必须摘 mouseup');
  assert.ok(OVERLAY.includes('useEffect(() => () => { stopResize(); }, [])'), '组件卸载也要清监听');
});

test('④ AssistHeadIcon 有 moon / sun 两个手写分支，风格与既有图标一致', () => {
  assert.ok(ICONS.includes("if (name === 'moon')"), '缺 moon（月牙）分支');
  assert.ok(ICONS.includes("if (name === 'sun')"), '缺 sun（太阳）分支');
  assert.ok(ICONS.includes("viewBox: '0 0 24 24'"), '仍是 24×24 viewBox，与其他图标同款');
  assert.ok(ICONS.includes("stroke: 'currentColor'"), '颜色仍走 currentColor');
  assert.ok(ICONS.includes('strokeWidth: 1.8'), '线宽仍是 1.8');
  // 太阳要有圆心 + 至少四道光芒；月牙要有一条闭合弧线
  const sunBody = ICONS.slice(ICONS.indexOf("if (name === 'sun')"), ICONS.indexOf('// 缺省'));
  assert.ok(sunBody.includes("h('circle'"), '太阳要有圆心圆');
  assert.ok((sunBody.match(/h\('path'/g) ?? []).length >= 4, '太阳至少四条光芒路径');
  const moonBody = ICONS.slice(ICONS.indexOf("if (name === 'moon')"), ICONS.indexOf("if (name === 'sun')"));
  assert.equal((moonBody.match(/h\('path'/g) ?? []).length, 1, '月牙一条弧线就够（不要画成实心圆）');
});

test('⑤ 顶部图标栏有纯图标深浅切换按钮：浅色月亮、深色太阳，无文字', () => {
  assert.ok(OVERLAY.includes("'data-sa-assist-theme-toggle': theme"), '按钮要有主题标记便于真机定位');
  assert.ok(OVERLAY.includes("title: theme === 'dark' ? '切换浅色' : '切换深色'"), 'title 要说人话（切换浅色/切换深色）');
  assert.ok(OVERLAY.includes("'aria-label': theme === 'dark' ? '切换浅色' : '切换深色'"), 'aria-label 与 title 对齐');
  assert.ok(OVERLAY.includes("h(AssistHeadIcon, { name: theme === 'dark' ? 'sun' : 'moon' })"),
    '浅色显月亮、深色显太阳');
  assert.ok(OVERLAY.includes('onClick: toggleTheme'), '点击走 toggleTheme');
  assert.ok(OVERLAY.includes("const next = theme === 'dark' ? 'light' : 'dark';"), 'toggleTheme 反着切');
  // 纯图标：按钮不挂文字子节点（三个图标按钮的写法是 h(按钮, null, h(Icon))）
  const toggle = OVERLAY.slice(OVERLAY.indexOf("'data-sa-assist-theme-toggle'"), OVERLAY.indexOf('h(AssistHeadIcon, { name: theme ==='));
  assert.ok(!/h\('span',[^\n]*'切换/.test(toggle), '切换按钮里不许再塞文字 span');
});

test('⑥ 主题与尺寸是模块级记忆（不落盘），面板挂 data-sa-assist-theme', () => {
  assert.match(SOURCE, /^\s{4}let assistThemeMemory = 'light';$/mu,
    'assistThemeMemory 必须是模块级 let（4 空格缩进，和 navTabMemory / studyModeMemory 同层）');
  assert.match(SOURCE, /^\s{4}let assistSizeMemory = \{ w: ASSIST_SIZE_DEFAULT\.w, h: ASSIST_SIZE_DEFAULT\.h \};$/mu,
    'assistSizeMemory 同样是模块级 let');
  assert.ok(SOURCE.includes('const [theme, setTheme] = useState(() => assistThemeMemory)'),
    'state 初值从模块记忆取');
  assert.ok(OVERLAY.includes("'data-sa-assist-theme': theme"), '面板根要带 data-sa-assist-theme={theme}');
  // 不落盘：新代码不许碰 localStorage / 学习台 JSON
  const at = SOURCE.indexOf("let assistThemeMemory = 'light';");
  const region = SOURCE.slice(at, at + 900);
  assert.ok(!/localStorage|readFile|writeFile|\.json/u.test(region), '主题/尺寸记忆只活在内存里，不落盘');
});

test('⑦ 不透明底：面板/消息区/输入区都不再吃宿主的半透明 alias 令牌', () => {
  const panelCss = cssRule(CSS, '.sa-assist-panel');
  assert.ok(panelCss.includes('background:var(--sa-assist-surface)'), '面板底色用面板自有不透明变量');
  assert.ok(!panelCss.includes('bg-overlay'), '面板不许再引用宿主的 --dsw-alias-bg-overlay（带 alpha）');
  assert.ok(cssRule(CSS, '.sa-assist-log').includes('background:var(--sa-assist-surface)'), '消息区也要实色底');
  assert.ok(cssRule(CSS, '.sa-assist-compose').includes('background:var(--sa-assist-surface-2)'), '输入区实色底');
  assert.ok(!/\.sa-assist-(panel|log|compose)\{[^}]*rgba?\(/u.test(CSS), '关键容器底色不许出现 rgba/透明色');
});

test('⑧ 深浅两套 --sa-assist-* 变量都在，深色覆盖块里全是实色 hex', () => {
  assert.equal((CSS.match(/--sa-assist-surface:/gu) ?? []).length, 2, '浅色/深色各一套 --sa-assist-surface');
  assert.equal((CSS.match(/--sa-assist-fg:/gu) ?? []).length, 2, '浅色/深色各一套 --sa-assist-fg');
  assert.equal((CSS.match(/--sa-assist-border:/gu) ?? []).length, 2, '浅色/深色各一套 --sa-assist-border');
  assert.equal((CSS.match(/--sa-assist-bubble-user:/gu) ?? []).length, 2, '气泡（用户）深浅各一套');
  assert.equal((CSS.match(/--sa-assist-input:/gu) ?? []).length, 2, '输入框深浅各一套');
  const dark = cssRule(CSS, '.sa-assist-panel[data-sa-assist-theme="dark"]');
  assert.ok(dark.includes('--sa-assist-surface:#1e2024'), '深色面板底 = #1e2024');
  assert.ok(dark.includes('--sa-assist-fg:#eceef2'), '深色正文色 = #eceef2');
  const darkColors = dark.match(/--sa-assist-[a-z0-9-]+:#[0-9a-fA-F]{6}/gu) ?? [];
  assert.ok(darkColors.length >= 10, `深色那套变量要整组实色 hex（现有 ${darkColors.length} 个）`);
  assert.equal((dark.match(/--sa-assist-[a-z0-9-]+:(?!\s*#)(?!\s*var\()/gu) ?? []).length, 0,
    '深色变量里不许夹带半透明色/令牌');
  // 面板内部件也要跟着面板变量走，否则深色下会露出宿主浅色按钮
  assert.ok(cssRule(CSS, '.sa-assist-panel .sa-btn').includes('var(--sa-assist-btn)'), '深色面板里的按钮吃面板变量');
  assert.ok(cssRule(CSS, '.sa-assist-panel .sa-input').includes('var(--sa-assist-input)'), '输入框吃面板变量');
  assert.ok(cssRule(CSS, '.sa-assist-panel .sa-muted').includes('var(--sa-assist-fg-soft)'), '次要文字吃面板变量');
});

test('⑨ 安全回归：两个 bundle 0 处 dangerouslySetInnerHTML，面板组件区域 0 处行内 hex', () => {
  for (const [name, text] of [['client.full.js', SOURCE], ['client.js', SHIPPED]]) {
    assert.equal((text.match(/dangerouslySetInnerHTML/gu) ?? []).length, 0, `${name} 不许出现 dangerouslySetInnerHTML`);
    assert.ok(!/\.innerHTML\s*=/u.test(text), `${name} 不许写 innerHTML`);
  }
  assert.equal((OVERLAY.match(/style\s*:\s*\{[^}]*#[0-9a-fA-F]{3,8}/gu) ?? []).length, 0,
    'AssistantOverlay 里不许有行内 style 硬编码 hex（颜色一律进 <style> 的 CSS 变量）');
  assert.equal((OVERLAY.match(/'#[0-9a-fA-F]{6}'/gu) ?? []).length, 0, '组件里不许出现 hex 字符串常量');
});

test('⑩ 没撞坏既有钉子和 v2-F 气泡渲染', () => {
  assert.ok(SOURCE.includes('function buildAssistantContext'), 'v2-A 的界面上下文采集还在');
  assert.ok(SOURCE.includes('if (studyModeMemory === true) context.studyMode = true;'), 'v2-E 的专注人设字段还在');
  assert.ok(SOURCE.includes('renderAssistantText(item.content'), 'v2-F：助手气泡仍走 Markdown/公式渲染器');
  assert.ok(SOURCE.includes("className: `sa-assist-msg ${item.role === 'user' ? 'user' : 'assistant'}`"), '气泡按 role 分流的类名没变');
  assert.ok(SOURCE.includes('/assistant/reply'), '问答接口路径没动');
  assert.ok(SOURCE.includes("'data-sa-assist-panel': true"), 'E2 的面板标记 data-sa-assist-panel 还在');
  assert.ok(SOURCE.includes("'data-sa-assist-log': true"), '日志区标记 data-sa-assist-log 还在');
  assert.ok(SOURCE.includes('function AssistantOverlay'), '浮层组件本体还在');
});
