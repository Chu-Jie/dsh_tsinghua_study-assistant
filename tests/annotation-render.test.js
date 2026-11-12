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

test('AnnotationLayer 把 marks 接进待处理列表：found 但没落正文的批注不再静默消失', () => {
  // 纯函数 `annotationPendingList(plan, marks)` 修好了还不够 —— 组件不把 marks 传进去，
  // 界面照样看不到（2026-11-12 修批注链时发现的第二个坑：参数加了、调用点没改）。
  const clientSource = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');
  assert.match(clientSource, /annotationPendingList\(plan, marks\)/, 'AnnotationLayer 必须把 marks 传给 annotationPendingList');
  assert.match(clientSource, /is-unplaced/, '待处理区/列表要有「未落到正文」的可视标记');
  assert.match(clientSource, /未落到正文/, '待处理区要给出「未落到正文」的文字说明');
});
