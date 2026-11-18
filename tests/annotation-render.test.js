/**
 * 批注渲染链的「真 React 形状」回归测试（2026-11-12）。
 *
 * 为什么单独一个文件：`tests/client.test.js` 用的 `createFakeReact` 把 children 挂在
 * **元素对象上**（`el.children`），而真 React 只把 children 放在 **`el.props.children`**。
 * 2026-10-31 的批注渲染链是照着假形状写的，于是单测全绿、浏览器里一条批注都画不出来
 * （`annotationRenderedText` 恒为空 → `annotationMarkOffsets` 恒为空 → 正文零 `<mark>`）。
 *
 * 这里用**只认 `props.children`** 的严格替身，专门守这条链：
 *   1. 渲染文本能取出来（不为空）；
 *   2. 渲染偏移能算出来，且切出的原文与 quote 逐字相等；
 *   3. 标记节点用 `h()` 重建后仍是合法元素（props 保留、children 在 props 上）；
 *   4. 旧替身形状（children 挂元素上）仍然兼容，不让老测试白白变红；
 *   5. `found` 但没落到正文的批注要进「待处理」，不能再静默消失。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
// 2026-11-12：client.full.js 才是可编辑的源码（标题分级 / 公式排版都改在那里），
// client.js 是同步产物；这里测源码，避免「改 full 忘了同步」时测试还绿着。
const CLIENT_FILE = path.join(HERE, '..', 'client.full.js');

/**
 * 严格 React 替身：children **只在** `props.children` 上，与浏览器一致。
 * 单个孩子按 React 的约定折叠成非数组值。
 */
function createStrictReact() {
  function createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat;
    const key = merged.key ?? null;
    delete merged.key;
    return { type, key, props: merged };
  }
  return {
    createElement,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useMemo(factory) {
      return factory();
    },
    useRef(value) {
      return { current: value };
    },
    useCallback(fn) {
      return fn;
    },
    Component: class Component {
      constructor(props) {
        this.props = props ?? {};
        this.state = {};
      }
    },
  };
}

/** 在最小浏览器假环境里执行 client.js，返回 internals。 */
function loadClient() {
  const injectedStyles = [];
  const react = createStrictReact();
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    document: {
      head: {
        appendChild(node) {
          node.isConnected = true;
          injectedStyles.push(node);
          return node;
        },
        removeChild(node) {
          node.isConnected = false;
          return node;
        },
      },
      createElement(tag) {
        return { tagName: tag.toUpperCase(), attributes: {}, isConnected: false, setAttribute(key, value) { this.attributes[key] = value; }, textContent: '' };
      },
      querySelector() {
        return null;
      },
    },
    fetch: async () => ({
      status: 200,
      json: async () => ({ ok: true, dataDir: '测试目录', healthy: true, files: [], docs: {}, hashes: {}, problems: [] }),
    }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      const fakeRequire = () => react;
      context.__exports = registration.factory(fakeRequire);
    },
  };
  const code = fs.readFileSync(CLIENT_FILE, 'utf8');
  vm.runInNewContext(code, context, { filename: CLIENT_FILE });

  const half = context.__exports;
  const services = {
    sidebarRightTabs: { register() { return () => {}; } },
    sidebarRight: { openTab() {} },
  };
  const ctx = {
    logger: { info() {} },
    slots: {
      inject(slotName, callback) {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register() {
        return () => {};
      },
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      return typeof name === 'string' ? services[name] : undefined;
    },
  };
  half.apply(ctx);
  return { internals: half.DESCRIPTORS.internals, react };
}

/** 按 `props.children` 收集树里所有元素（含自身）；`withLegacy` 时改读旧替身的 `children`。 */
function flattenElements(node, out = [], withLegacy = false) {
  if (Array.isArray(node)) {
    node.forEach((child) => flattenElements(child, out));
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  out.push(node);
  flattenElements(withLegacy ? node.children : node.props?.children, out);
  return out;
}

/** 按 `props.children` 取元素的纯文本。 */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node === null || typeof node !== 'object') return '';
  return textOf(node.props?.children);
}

const BODY = ['# 第2章 逻辑代数基础', '', '逻辑代数是数字电路的基础。', '', '常用公式要背熟。', ''].join('\n');
const QUOTE = '逻辑代数是数字电路的基础。';

function planFor(overrides = {}) {
  const quote = overrides.quote ?? QUOTE;
  const start = BODY.indexOf(quote);
  assert.ok(start >= 0, '样本原文里必须有 quote');
  return {
    id: 'a_test',
    type: 'highlight',
    content: '批注内容',
    state: 'found',
    start,
    end: start + quote.length,
    quote,
    ...overrides,
  };
}

test('真 React 形状：annotationRenderedText 能取出 h() 树的文本', () => {
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const nodes = [
    h('p', { className: 'sa-p' }, '第一段。'),
    h('p', { className: 'sa-p' }, h('strong', {}, '加粗'), '结尾。'),
  ];
  assert.equal(internals.annotationRenderedText(nodes), '第一段。加粗结尾。');
});

test('真 React 形状：渲染偏移算得出来，切出的原文与 quote 逐字相等', () => {
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const preview = [h('p', { className: 'sa-p' }, QUOTE), h('p', { className: 'sa-p' }, '常用公式要背熟。')];
  const rendered = internals.annotationRenderedText(preview);
  assert.ok(rendered.length > 0, '渲染文本不能为空（这正是 2026-10-31 的断点）');
  const marks = internals.annotationMarkOffsets(BODY, rendered, [planFor()]);
  assert.equal(marks.length, 1, 'found 的批注必须能映射到渲染偏移');
  assert.equal(rendered.slice(marks[0].start, marks[0].end), QUOTE);
});

test('真 React 形状：annotationMarkedNodes 用 h() 重建元素，mark 保留 props 与 id', () => {
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const preview = [h('p', { className: 'sa-p' }, QUOTE), h('p', { className: 'sa-p' }, '常用公式要背熟。')];
  const rendered = internals.annotationRenderedText(preview);
  const marks = internals.annotationMarkOffsets(BODY, rendered, [planFor()]);
  const marked = internals.annotationMarkedNodes(preview, marks);
  const elements = flattenElements(marked);
  const markNodes = elements.filter((node) => node.type === 'mark');
  assert.equal(markNodes.length, 1, '正文里必须真的出现一个 <mark>');
  assert.equal(textOf(markNodes[0]), QUOTE);
  assert.equal(markNodes[0].props['data-annotation-id'], 'a_test');
  assert.match(String(markNodes[0].props.className), /sa-annotation-found/);
  // 外层元素没有被 `{...node, children}` 打坏：className 还在，children 仍在 props 上
  const paragraph = elements.find((node) => node.type === 'p');
  assert.equal(paragraph.props.className, 'sa-p');
  assert.equal(paragraph.children, undefined, 'children 不允许再挂到元素对象上');
});

test('旧替身形状（children 挂元素上）仍然兼容，老测试不会变红', () => {
  const { internals } = loadClient();
  const legacy = [{ __el: true, type: 'p', props: { className: 'sa-p' }, children: [QUOTE] }];
  assert.equal(internals.annotationRenderedText(legacy), QUOTE);
  const marks = internals.annotationMarkOffsets(BODY, QUOTE, [planFor()]);
  assert.equal(marks.length, 1);
  const marked = internals.annotationMarkedNodes(legacy, marks);
  // 旧替身的 children 是不可变数组，`{...node, children: [...]}` 之后 React 拿到的仍是新数组；
  // 这里只断言「原文一个字没丢、标记的 props 齐」——形状差异不影响兼容性。
  const collect = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((child) => collect(child, out)); return out; }
    if (node === null || typeof node !== 'object') return out;
    out.push(node);
    collect(node.children, out);
    collect(node.props?.children, out);
    return out;
  };
  const flat = collect(marked);
  const markNode = flat.find((node) => node.type === 'mark');
  assert.ok(markNode, '旧替身下也要包出 <mark>');
  assert.equal(String(markNode.props?.['data-annotation-id'] ?? markNode.id ?? ''), 'a_test');
});

test('annotationPendingList：found 但没落到正文的批注进「待处理」，已落的不进', () => {
  const { internals } = loadClient();
  const plan = [planFor({ id: 'placed' }), planFor({ id: 'unplaced' })];
  const marks = [{ id: 'placed', type: 'highlight', state: 'found', start: 0, end: QUOTE.length }];
  const pending = internals.annotationPendingList(plan, marks);
  assert.deepEqual(pending.map((item) => item.id), ['unplaced']);
  // 不传 marks 时保持旧语义：只列 fuzzy + lost
  const legacyPlan = [planFor({ id: 'found' }), planFor({ id: 'fuzzy', state: 'fuzzy' }), planFor({ id: 'lost', state: 'lost' })];
  assert.deepEqual(internals.annotationPendingList(legacyPlan).map((item) => item.id), ['fuzzy', 'lost']);
});

test('annotationStyleToCss：只认白名单键，非法/缺省忽略，null 表示无样式', () => {
  const { internals } = loadClient();
  const { annotationStyleToCss } = internals;

  assert.equal(annotationStyleToCss(undefined), null);
  assert.equal(annotationStyleToCss(null), null);
  assert.equal(annotationStyleToCss({}), null);
  assert.equal(annotationStyleToCss({ border: '2px' }), null, '白名单外的键全忽略');
  const css = annotationStyleToCss({ color: 'red', highlight: 'yellow', underline: 'blue', bold: true, italic: true });
  assert.equal(css.color, internals.ANNOTATION_STYLE_PALETTE.color.red);
  assert.equal(css.backgroundColor, internals.ANNOTATION_STYLE_PALETTE.highlight.yellow);
  assert.equal(css.textDecorationLine, 'underline');
  assert.equal(css.textDecorationColor, internals.ANNOTATION_STYLE_PALETTE.underline.blue);
  assert.equal(css.fontWeight, 700);
  assert.equal(css.fontStyle, 'italic');
  // 非法色值忽略
  assert.equal(annotationStyleToCss({ color: 'purple' }), null);
});

test('第十二轮（2026-11-18）：字色/下划线色块的底色要取对应键（不能再一律 ?.backgroundColor 取成空→全白）', () => {
  // 用户反馈「初次选中文字，左侧栏字色/下划线色块全空白」。根因：色块底色一律用
  // annotationStyleToCss(...)?.backgroundColor，但 color→css.color、underline→css.textDecorationColor，
  // 取 backgroundColor 恒为 undefined → 色块白板。这里守三键映射 + 源码里三条 dockSW/swatch 都按 kind 取值。
  const { internals } = loadClient();
  const { annotationStyleToCss, ANNOTATION_STYLE_PALETTE } = internals;
  assert.equal(annotationStyleToCss({ highlight: 'green' }).backgroundColor, ANNOTATION_STYLE_PALETTE.highlight.green);
  assert.equal(annotationStyleToCss({ color: 'red' }).color, ANNOTATION_STYLE_PALETTE.color.red);
  assert.equal(annotationStyleToCss({ underline: 'blue' }).textDecorationColor, ANNOTATION_STYLE_PALETTE.underline.blue);
  const src = fs.readFileSync(CLIENT_FILE, 'utf8');
  // 两条色块工厂（左侧栏 dockSW 与浮动气泡 swatch）都要按 kind 取正确颜色给 backgroundColor
  assert.ok(/const chipColor = css === null \? undefined : \(kind === 'highlight' \? css\.backgroundColor : \(kind === 'underline' \? css\.textDecorationColor : css\.color\)\)/.test(src),
    '色块底色要按 kind 取 backgroundColor/color/textDecorationColor（否则字色/下划线色块是白的）');
  // 不能再出现「一律 ?.backgroundColor」的字色/下划线色块写法
  assert.ok(!/kind === 'highlight' \? \{ highlight: value \} : \(kind === 'underline' \? \{ underline: value \} : \{ color: value \}\)\)\?\.backgroundColor/.test(src),
    '不能再用 ?.backgroundColor 一律取色块底色');
});

test('style 贯穿渲染链：带 highlight 色的批注 mark 带上内联 backgroundColor', () => {
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const preview = [h('p', { className: 'sa-p' }, QUOTE), h('p', { className: 'sa-p' }, '常用公式要背熟。')];
  const rendered = internals.annotationRenderedText(preview);
  const plan = [planFor({ id: 'a_style', style: { highlight: 'pink', color: 'blue', bold: true } })];
  // 先确认 plan 带出 style → marks 带出 style → markNode 用到
  assert.equal(plan[0].style.highlight, 'pink');
  const marks = internals.annotationMarkOffsets(BODY, rendered, plan);
  assert.equal(marks[0].style.highlight, 'pink', 'markOffsets 要透传 style');
  assert.equal(marks[0].style.color, 'blue');
  const marked = internals.annotationMarkedNodes(preview, marks);
  const markNode = flattenElements(marked).find((node) => node.type === 'mark');
  assert.ok(markNode, '必须有 mark');
  assert.equal(markNode.props.style.backgroundColor, internals.ANNOTATION_STYLE_PALETTE.highlight.pink);
  assert.equal(markNode.props.style.color, internals.ANNOTATION_STYLE_PALETTE.color.blue);
  assert.equal(markNode.props.style.fontWeight, 700);
  // 有显式高光色时不再挂 is-highlight（避免默认淡色叠加、盖掉用户选色）
  assert.doesNotMatch(String(markNode.props.className), /is-highlight/);
});

test('无 style 的批注：mark 不带内联 style，highlight 类型沿用 is-highlight 默认外观', () => {
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const preview = [h('p', { className: 'sa-p' }, QUOTE)];
  const rendered = internals.annotationRenderedText(preview);
  const marks = internals.annotationMarkOffsets(BODY, rendered, [planFor({ id: 'plain', type: 'highlight' })]);
  const marked = internals.annotationMarkedNodes(preview, marks);
  const markNode = flattenElements(marked).find((node) => node.type === 'mark');
  assert.equal(markNode.props.style, undefined, '无 style 不加内联样式（旧外观不变）');
  assert.match(String(markNode.props.className), /is-highlight/);
});

test('buildAnnotationRenderPlan：note 上的 style 原样带进 plan，旧的 lost 分支也不丢', () => {
  const { internals } = loadClient();
  const start = BODY.indexOf(QUOTE);
  const notes = [
    { id: 'k1', type: 'highlight', content: 'x', style: { underline: 'red' }, anchor: { quote: QUOTE, start, end: start + QUOTE.length } },
    { id: 'k2', type: 'note', content: 'y', anchor: { quote: '不存在的句子', start: 0, end: 6 } },
  ];
  const plan = internals.buildAnnotationRenderPlan(notes, BODY);
  assert.equal(plan[0].style.underline, 'red');
  assert.equal(plan[0].state, 'found');
  assert.equal(plan[1].state, 'lost');
  assert.equal(plan[1].style, undefined, '无 style 就是 undefined，不乱造空对象');
});

test('annotationCreateItem：带 style 时透传，无 style 时不带 style 字段', () => {
  const { internals } = loadClient();
  const start = BODY.indexOf(QUOTE);
  const anchor = { quote: QUOTE, start, end: start + QUOTE.length, prefix: '', suffix: '' };
  const withStyle = internals.annotationCreateItem({ file: 'f.md', type: 'highlight', content: '', anchor, style: { color: 'green', bold: true } });
  assert.equal(withStyle.style.color, 'green');
  assert.equal(withStyle.style.bold, true);
  const noStyle = internals.annotationCreateItem({ file: 'f.md', type: 'note', content: 'hi', anchor });
  assert.equal('style' in noStyle, false, '无 style 时不写 style 字段（旧行为不变）');
});

test('AnnotationLayer 把 marks 接进待处理列表：found 但没落正文的批注不再静默消失', () => {
  // 界面照样看不到（2026-11-12 修批注链时发现的第二个坑：参数加了、调用点没改）。
  const clientSource = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');
  assert.match(clientSource, /annotationPendingList\(plan, marks\)/, 'AnnotationLayer 必须把 marks 传给 annotationPendingList');
  assert.match(clientSource, /is-unplaced/, '待处理区/列表要有「未落到正文」的可视标记');
  assert.match(clientSource, /未落到正文/, '待处理区要给出「未落到正文」的文字说明');
});

test('回归（React #137 img 自闭合崩溃）：annotationMarkedNodes 不得给无 children 的元素塞 children', () => {
  // 2026-11-18 用户实测「面板渲染失败 React error #137 args[]=img」：有任一批注后，
  // annotationMarkedNodes 的 walk 会给每个元素重设 children，连 <img> 这种自闭合标签
  // 也被写成 children:[undefined]，真 React 抛「img is a self-closing tag and must neither
  // have children」。这里用只认 props.children 的严格替身，断言：<img> 原样返回、不带 children。
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  const preview = [
    h('p', { className: 'sa-p' }, QUOTE),
    h('figure', { key: 'fig0' },
      h('img', { src: 'x.png', alt: '图注', style: { maxWidth: '100%' } }),
      h('figcaption', {}, '图注')),
  ];
  const rendered = internals.annotationRenderedText(preview);
  const marks = internals.annotationMarkOffsets(BODY, rendered, [planFor()]);
  const marked = internals.annotationMarkedNodes(preview, marks);
  const elements = flattenElements(marked);
  const img = elements.find((node) => node.type === 'img');
  assert.ok(img, '正文里的 <img> 必须还在');
  assert.equal('children' in img.props, false, '<img> 绝不能带 children（否则真 React 崩溃）');
  // 段落这种本来就有 children 的元素照常重建，mark 仍在
  assert.ok(elements.some((node) => node.type === 'mark'), '有意义文字的段落仍要包出 <mark>');
  const figcaption = elements.find((node) => node.type === 'figcaption');
  assert.ok(figcaption, 'figcaption 保住了');
});

test('回归（公式区高亮排版错乱）：annotationMarkedNodes 绝不把 <mark> 塞进公式 span / <sup>', () => {
  // 2026-11-18 用户实测「高亮选中公式后，删除高亮导致排版错乱（同一句话重复出现）」。
  // 根因：行内公式是 KaTeX 风格的多层 span（上标 <sup> 会重复渲染基准文本），旧 walk 钻进
  // 公式内部按字符偏移切文本，把一条高亮切成十几个 <mark>，其中不少落在 <sup> 里，把公式
  // 的排版整个拆坏。修复：把公式子树当原子单元，整块不切。这里断言——跨公式的高亮只产生
  // 极少 mark，且一个都不在公式 span 或 <sup> 内。
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  // 造一个真实形状的行内公式 span（带 MATH_INLINE_STYLE 同款 style）与一个 sa-formula 块
  const inlineMathStyle = { fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontSize: '1.02em', letterSpacing: '0.01em' };
  const mathSpan = h('span', { style: inlineMathStyle }, 'e', '=', '1', '.', '6', '0', '2', '×', '1', '0', h('sup', { style: { fontSize: '0.72em' } }, '-', '1', '9'), ' ', 'C');
  const preview = [
    h('p', {}, '每个电子的电量绝对值是 ', mathSpan, '。'),
  ];
  const body = internals.annotationRenderedText(preview);
  const rendered = body;
  // 高亮从「绝对值是」一路盖过整个公式到句号
  const start = body.indexOf('绝对值是') + '绝对值是'.length;
  const end = body.indexOf('。', body.indexOf('C')) + 1;
  const quote = body.slice(start, end);
  const plan = [{ id: 'f1', type: 'highlight', content: '', state: 'found', start, end, quote, style: { highlight: 'yellow' } }];
  const marks = internals.annotationMarkOffsets(body, rendered, plan);
  const marked = internals.annotationMarkedNodes(preview, marks);
  // 遍历 marked 树，统计 mark 数量、落在公式 span / <sup> 内的 mark 数量
  const isFormulaStyle = (st) => st && st.fontStyle === 'italic' && /Georgia/i.test(String(st.fontFamily || ''));
  let total = 0; let inFormula = 0; let inSup = 0;
  (function walk(node, sup, formula) {
    if (Array.isArray(node)) { node.forEach((c) => walk(c, sup, formula)); return; }
    if (node === null || typeof node !== 'object') return;
    const nowFormula = formula || isFormulaStyle(node.props?.style) || String(node.props?.className ?? '').indexOf('sa-formula') !== -1;
    const nowSup = sup || node.type === 'sup';
    if (node.type === 'mark') { total += 1; if (nowFormula) inFormula += 1; if (nowSup) inSup += 1; }
    walk(node.props?.children, nowSup, nowFormula);
  })(marked, false, false);
  assert.ok(total >= 1, '跨公式的高亮至少要包出一个 mark（落在公式外的文字上）');
  assert.equal(inFormula, 0, '<mark> 绝不能落进公式 span 内（否则上标排版被拆坏）');
  assert.equal(inSup, 0, '<mark> 绝不能落进 <sup> 内');
  // 文本层面不丢字、不重复：拼接后与原文逐字相等
  assert.equal(textOf(marked), body, '包 mark 前后正文必须逐字相等（不丢字、不重复）');
});

test('第十一轮（2026-11-18）：只高亮公式本身时，公式子树要被包成可见的 sa-annotation-formula-hit', () => {
  // 用户反馈「对公式高亮，没有任何显示」：块级 $$ 公式是 .sa-formula 整块，第十轮把它当原子
  // 单元整块不切，于是什么都不画。修复：当某条高亮的渲染区间与公式子树有交集时，把整棵公式子树
  // 包进一层带底色的 <span class="sa-annotation-formula-hit">，既看得见又不拆内部结构。
  const { internals, react } = loadClient();
  const { createElement: h } = react;
  // 造一个块级公式节点（className 含 sa-formula），整段文本就是这一块
  const formulaBlock = h('div', { className: 'sa-formula' }, 'Δ', ' ', 'q', '=', 'n', ' ', 'e', '=', '1', '.', '0', '×', '1', '0', h('sup', {}, '1', '2'));
  const preview = [h('p', {}, '失去的电子总电量为'), formulaBlock];
  const body = internals.annotationRenderedText(preview);
  const rendered = body;
  // 高亮正好覆盖公式那一整段（从「Δ」到公式结尾）
  const start = body.indexOf('Δ');
  const end = body.length;
  const quote = body.slice(start, end);
  const plan = [{ id: 'f2', type: 'highlight', content: '高亮1', state: 'found', start, end, quote, style: { highlight: 'green' } }];
  const marks = internals.annotationMarkOffsets(body, rendered, plan);
  const marked = internals.annotationMarkedNodes(preview, marks);
  const flat = flattenElements(marked, []);
  const formulaHit = flat.filter((node) => String(node.props?.className ?? '').split(/\s+/).includes('sa-annotation-formula-hit'));
  assert.equal(formulaHit.length, 1, '公式子树要被包成 1 个 sa-annotation-formula-hit（可见）');
  const hit = formulaHit[0];
  // 2026-11-18 四修（用户 m02300：公式高亮波及一整行、太宽）：高亮收窄到「只框公式本身」。
  // 做法：外层仍是原 .sa-formula 块级 div（布局不变），高亮套在内部一层 display:inline-block 的 span.sa-annotation-formula-hit 上
  // （inline-block 宽度随内容收缩 = 只框公式）。所以这里是 span 且 inline-block。
  assert.equal(hit.type, 'span', '公式高亮壳应是内层 span（宽度随内容收缩，只框公式本身）');
  assert.equal(hit.props?.style?.display, 'inline-block', '高亮壳必须 inline-block 才能只框公式、不横贯整行');
  assert.ok(hit.props?.style && hit.props.style.backgroundColor !== undefined, '公式高亮要带 background 色（否则又看不见）');
  assert.equal(String(hit.props?.['data-annotation-mark-id'] ?? ''), 'f2', '公式高亮要带 data-annotation-mark-id 供滚动定位');
  // 外层必须是原来的块级 .sa-formula div（不能被压成 inline-block、否则靠左对齐）
  const outerFormula = flat.filter((node) => node.type === 'div' && String(node.props?.className ?? '').split(/\s+/).includes('sa-formula'));
  assert.equal(outerFormula.length, 1, '外层应保留一个块级 .sa-formula div（布局/居中不变）');
  const outerStyle = outerFormula[0].props?.style ?? {};
  assert.notEqual(outerStyle.display, 'inline-block', '外层 .sa-formula 不能被改成 inline-block（否则靠左）');
  // 依然不拆内部结构：公式里的 <sup> 仍在、且没有任何 <mark> 落进公式
  let marksInFormula = 0;
  (function walk(node, formula) {
    if (Array.isArray(node)) { node.forEach((c) => walk(c, formula)); return; }
    if (node === null || typeof node !== 'object') return;
    const nowFormula = formula || String(node.props?.className ?? '').split(/\s+/).includes('sa-formula');
    if (node.type === 'mark' && nowFormula) marksInFormula += 1;
    walk(node.props?.children, nowFormula);
  })(marked, false);
  assert.equal(marksInFormula, 0, '公式内部仍然不能塞 <mark>');
  // 文本不丢不重
  assert.equal(textOf(marked), body, '包公式高亮前后正文必须逐字相等');
});
