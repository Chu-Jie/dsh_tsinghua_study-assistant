// 浮层气泡排版（v2-F，2026-11-22）的钉子：助手回复走现有 Markdown/公式排版器，源码不再裸露。
//
// 为什么要有：气泡原先把 `item.content` 当纯文本直出，`**加粗**`、`\(q=ne\)`、
// `\times10^{-19}`、`\text{C}` 全以源码露在屏幕上（用户真机冒烟 v2-E 时截图报的）。
// 这里两条腿：源码级（气泡处确实调了渲染器、没退回纯文本、没有 dangerouslySetInnerHTML）
// + 行为级（用仓库自带的假 React 把 client.js 跑起来，直接验纯函数产出什么节点）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

/** 极简 React 替身：只实现本项目用到的那部分（与 tests/client.test.js 同口径）。 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    Component: class Component { constructor(props) { this.props = props ?? {}; this.state = {}; } },
  };
}

/** 在最小浏览器假环境里执行 client.js，拿到 DESCRIPTORS.internals（渲染纯函数都在里面）。 */
function loadInternals() {
  const store = new Map();
  const context = {
    window: {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    document: {
      head: { appendChild(node) { node.isConnected = true; }, removeChild() {} },
      createElement(tag) {
        return { tagName: String(tag).toUpperCase(), attributes: {}, isConnected: false, setAttribute(k, v) { this.attributes[k] = v; }, textContent: '' };
      },
      querySelector() { return null; },
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      context.__exports = registration.factory((specifier) => {
        assert.equal(specifier, 'react', '客户端只允许 require("react")');
        return fakeReact();
      });
    },
  };
  vm.runInNewContext(SHIPPED, context, { filename: 'client.js' });
  return context.__exports.DESCRIPTORS.internals;
}

const lib = loadInternals();
const { renderAssistantText } = lib;

/** 把节点树拍平成纯文字，用来断言「源码没漏到屏幕上」。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}
/** 深度找某类节点（strong / ul / p …）。 */
function findAll(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, out)); return out; }
  if (node.type === type) out.push(node);
  (node.children ?? []).forEach((child) => findAll(child, type, out));
  return out;
}

test('气泡处：助手回复交给 renderAssistantText，不再把 item.content 裸放', () => {
  assert.ok(SOURCE.includes('renderAssistantText(item.content'), '气泡要调 renderAssistantText(item.content, …)');
  assert.ok(!SOURCE.includes("h('div', { className: 'sa-assist-bubble' }, item.content)"),
    '原来的「纯文本直出」那一行必须消失');
  // 用户气泡保持纯文本（理由见气泡处注释：mixedTextNodes 会剥落单的 `$`）
  assert.ok(SOURCE.includes("item.role === 'user'"), '气泡要按 role 分流');
});

test('渲染器只用现有工具：analysisParagraphs / mixedTextNodes / isListLine / listNode', () => {
  const at = SOURCE.indexOf('const renderAssistantText = ');
  assert.ok(at > 0, 'renderAssistantText 必须存在');
  const body = SOURCE.slice(at, at + 4000);
  for (const tool of ['analysisParagraphs(', 'mixedTextNodes(', 'isListLine(', 'listNode(']) {
    assert.ok(body.includes(tool), `renderAssistantText 要复用 ${tool}`);
  }
  // 不新造解析器：函数体里不该出现自写的 markdown 正则拼装
  assert.ok(!/\bnew RegExp\b/u.test(body), '渲染器里不许现场拼正则解析 markdown');
});

test('安全回归：两个客户端 bundle 里 0 处 dangerous HTML 注入', () => {
  for (const [name, text] of [['client.full.js', SOURCE], ['client.js', SHIPPED]]) {
    assert.equal((text.match(/dangerouslySetInnerHTML/gu) ?? []).length, 0, `${name} 不许出现 dangerouslySetInnerHTML`);
    assert.ok(!/\.innerHTML\s*=/u.test(text), `${name} 不许写 innerHTML`);
    assert.ok(!/document\.write/u.test(text), `${name} 不许 document.write`);
  }
});

test('**加粗** 真加粗：产出 strong，标记不进屏', () => {
  const nodes = renderAssistantText('用 **库仑定律** 说明：力与距离平方成反比', 'k0');
  assert.equal(nodes[0].type, 'p', '普通段落要包成 <p>');
  const strong = findAll(nodes, 'strong');
  assert.equal(strong.length, 1, '**…** 要产出一个 strong');
  assert.equal(textOf(strong[0]), '库仑定律');
  const text = textOf(nodes);
  assert.ok(!text.includes('**'), `屏幕文字不许残留 **：${text}`);
  assert.ok(text.includes('力与距离平方成反比'), '粗体外的正文照常显示');
});

test('MathJax 分隔符与裸 LaTeX：公式排版后不漏源码', () => {
  const nodes = renderAssistantText('元电荷 \\(e=1.6\\times10^{-19}\\text{C}\\)，电荷量 \\(q=ne\\)', 'k1');
  const text = textOf(nodes);
  for (const leak of ['\\(', '\\)', '\\times', '\\text', '$', '\\(']) {
    assert.ok(!text.includes(leak), `公式源码不许漏「${leak}」：${text}`);
  }
  assert.ok(text.includes('×'), '\\times 要排成 ×');
  assert.ok(text.includes('C'), '\\text{C} 只留内容');
  // 行内公式确实建了公式节点（衬线字体那层 span），不是一段纯文字
  const spans = findAll(nodes, 'span');
  assert.ok(spans.some((node) => node.props.style && node.props.style.fontFamily), '要有排好版的公式 span');
});

test('裸 LaTeX 命令（没有 $ 包着）也能排：\\times 不裸露', () => {
  const nodes = renderAssistantText('其中 e=1.6\\times10^{-19} C 是元电荷', 'k2');
  const text = textOf(nodes);
  assert.ok(!text.includes('\\times'), `裸命令不许漏：${text}`);
  assert.ok(text.includes('×'), `要排成 ×：${text}`);
});

test('列表：- a / - b 成 <ul> 两个 <li>，编号行成 <ol>', () => {
  const bullets = renderAssistantText('三条判据：\n- 电荷守恒\n- 能量守恒\n- 动量守恒', 'k3');
  const uls = findAll(bullets, 'ul');
  assert.equal(uls.length, 1, '- 开头连续行要成 ul');
  assert.equal(findAll(uls[0], 'li').length, 3, '三条要三个 li');
  assert.ok(!textOf(bullets).includes('- 电荷守恒'), '前缀 - 不该留在屏幕上');

  const ordered = renderAssistantText('1. 先取字\n2. 再排版', 'k4');
  const ols = findAll(ordered, 'ol');
  assert.equal(ols.length, 1, '数字开头成 ol');
  assert.equal(findAll(ols[0], 'li').length, 2, '两条要两个 li');
});

test('列表项走混排（不是纯 analysisInline）：Φ_e 这类裸下标也排版', () => {
  // 判据：analysisInline 认不出没有 `$` 的 `Φ_e`，会把 `_` 原样印出来；
  // mixedTextNodes 才走 splitMathRuns + plainMathNodes。列表项里能排开，就说明行内渲染器换对了。
  const nodes = renderAssistantText('- 通量 Φ_e = ∮ E·dS 恒定\n- 电压 $U=IR$', 'k5');
  const items = findAll(nodes, 'li');
  assert.equal(items.length, 2);
  assert.ok(!textOf(items[0]).includes('_'), `列表项的裸下标不许漏：${textOf(items[0])}`);
  const spans = findAll(nodes, 'span');
  assert.ok(spans.some((node) => node.props.style && node.props.style.fontFamily), '列表项里的公式要排成公式节点');
});

test('纯文本原样输出：没有标记时不出多余节点', () => {
  const nodes = renderAssistantText('先看题目里的已知量，再列方程。', 'k6');
  assert.equal(nodes.length, 1);
  assert.equal(textOf(nodes), '先看题目里的已知量，再列方程。');
});

test('HTML 只当字面量：<script> 不进节点树', () => {
  const nodes = renderAssistantText('讲解里出现 <script>alert(1)</script> 也只是文字', 'k7');
  assert.equal(findAll(nodes, 'script').length, 0, '不许产出 script 元素');
  assert.ok(textOf(nodes).includes('<script>alert(1)</script>'), '原文要按字面量显示');
});

test('分级标题复用 HEADING_STYLE：### 一、结构 不露 #', () => {
  const nodes = renderAssistantText('### 一、结构', 'k8');
  assert.equal(nodes[0].type, 'div', '标题行要成块');
  assert.ok(nodes[0].props.style && nodes[0].props.style.fontWeight >= 600, '要沿用详解正文的标题字重');
  assert.ok(!textOf(nodes).includes('###'), '`###` 不该露出来');
});

test('气泡内样式只用令牌：新增代码里 0 处硬编码 hex', () => {
  const at = SOURCE.indexOf('const renderAssistantText = ');
  const body = SOURCE.slice(at - 2000, at + 4000);
  assert.ok(!/#[0-9a-fA-F]{3,8}/u.test(body), '气泡排版相关代码不许出现硬编码 hex');
});
