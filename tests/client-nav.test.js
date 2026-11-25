/**
 * 导航历史（2026-11-25 卡 ⑥.7 末句 / ⑨）：今日 → 知识点 → 资料 → 上一步 → 上一步。
 *
 * 用户报障：从知识点页点「到资料页查看」跳到资料页后，「上一步」回不到知识点页。
 * 根因在 `goto()`：只把**离开前**的位置压栈，当前位置从不入栈。
 * 这个用例把整块主面板真的渲染出来（带 state + 一次 effect），按用户的手指点一遍按钮：
 *   上一步必须回到知识点页，再上一步回到今日页；并且前进能回到知识点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const FULL_FILE = path.join(HERE, '..', 'client.full.js');
const SHIPPED_FILE = path.join(HERE, '..', 'client.js');

/**
 * 带记忆的 React 替身：state 跨渲染保留，effect **在渲染时立刻跑一次**
 * （导航起点是在 mount effect 里入栈的，不跑 effect 就永远没有「上一步」）。
 */
function createStatefulReact(cells) {
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
    },
    useState(initial) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, (value) => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value; }];
    },
    useEffect(fn) {
      cursor += 1;
      const cleanup = fn();
      return cleanup;
    },
    useMemo(factory) { return factory(); },
    useRef(value) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { current: value };
      return cells[i];
    },
    useCallback(fn) { cursor += 1; return fn; },
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
    },
  };
  return { react: React, begin() { cursor = 0; } };
}

/** 摊平元素树：保留节点（type/props）与纯文本。 */
function flatten(tree) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    out.push(node);
    (node.children ?? []).forEach(walk);
  })(tree);
  return out;
}

function textOf(tree) {
  return flatten(tree).filter((item) => typeof item === 'string').join('');
}

function loadPanel() {
  const cells = [];
  const stateful = createStatefulReact(cells);
  const registrations = [];
  const context = {
    window: {
      addEventListener() {},
      removeEventListener() {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      setTimeout,
      clearTimeout,
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    // 面板启动会读一次 /state；这里给一份空但合法的文档表，不碰真磁盘、不碰真端口
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, docs: {}, problems: [] }) }),
    document: {
      head: { appendChild() {} },
      createElement() { return { setAttribute() {}, textContent: '' }; },
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      const fakeRequire = (specifier) => {
        assert.equal(specifier, 'react', `客户端只允许 require('react')，实际请求了 ${specifier}`);
        return stateful.react;
      };
      context.__exports = registration.factory(fakeRequire);
    },
  };
  vm.runInNewContext(fs.readFileSync(FULL_FILE, 'utf8'), context, { filename: FULL_FILE });
  const half = context.__exports;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      inject(slot, callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
    get() { return undefined; },
  };
  half.apply(ctx);
  const main = registrations.find((entry) => entry.options?.name === 'main');
  assert.ok(main, '主面板必须注册到 main 槽位');
  return { half: half, stateful, render: () => renderTree(main.component, {}) };
}

/** 极简 renderToStaticMarkup：函数组件直接调，类组件实例化后调 render()。 */
function renderTree(node, props) {
  function render(current) {
    if (current === null || current === undefined || current === false) return '';
    if (typeof current === 'string' || typeof current === 'number') return { text: String(current) };
    if (Array.isArray(current)) return current.map(render);
    const type = current.type;
    if (typeof type === 'function') {
      const prototype = type.prototype;
      if (prototype !== undefined && typeof prototype.render === 'function') {
        const instance = new type({ ...current.props, children: current.children });
        return render(instance.render());
      }
      return render(type({ ...current.props, children: current.children }));
    }
    return current;
  }
  return render({ __el: true, type: node, props: { ...(props ?? {}), children: [] }, children: [] });
}

/** 当前选中的页签（按 `aria-selected` 找），返回页签中文名。 */
function currentTab(tree) {
  const tabs = flatten(tree).filter((node) => node.type === 'button' && node.props?.role === 'tab');
  const selected = tabs.find((node) => node.props?.['aria-selected'] === true);
  assert.ok(selected !== undefined, '必须有一个页签是选中态');
  return { label: textOf(selected), buttons: tabs };
}

function tabButton(tree, label) {
  const hit = flatten(tree).find((node) => node.type === 'button' && node.props?.role === 'tab' && textOf(node) === label);
  assert.ok(hit !== undefined, `找不到页签「${label}」`);
  return hit;
}

function backButton(tree) {
  const hit = flatten(tree).find((node) => node.type === 'button' && textOf(node).includes('返回'));
  assert.ok(hit !== undefined, '头部必须有「← 返回」按钮');
  return hit;
}

test('① 今日 → 知识点 → 资料 → 上一步 → 上一步：先回知识点，再回今日', () => {
  const { half, stateful, render } = loadPanel();
  const lib = half.DESCRIPTORS.internals;
  // 从干净的起点开始（模块级历史是跨用例共享的）
  lib.resetNavigation();
  lib.resetMaterialsUi();
  lib.resetKnowledgeUi();

  stateful.begin();
  let tree = render();
  assert.equal(currentTab(tree).label, '今日', '起点是今日页');
  assert.equal(backButton(tree).props.disabled, true, '刚开始没有上一步可退');

  // 点「知识点」
  tabButton(tree, '知识点').props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '知识点', '点页签就该切过去');
  assert.equal(backButton(tree).props.disabled, false, '到了知识点页，上一步必须可点');

  // 点「资料」（复刻用户从知识点页跳到资料页那条路径）
  tabButton(tree, '资料').props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '资料');

  // 上一步：必须回到知识点（旧实现会直接落回今日，这就是用户报的 bug）
  backButton(tree).props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '知识点', '上一步要回到知识点页，而不是跳过它');

  // 再上一步：回到今日
  backButton(tree).props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '今日', '再上一步回到今日页');
  assert.equal(backButton(tree).props.disabled, true, '已经到最前面了，上一步该置灰');

  // 前进：回到知识点（前进分支没被上一步弄丢）
  const forward = flatten(tree).find((node) => node.type === 'button' && textOf(node).includes('前进'));
  assert.ok(forward !== undefined, '头部必须有「前进 →」按钮');
  assert.equal(forward.props.disabled, false, '退过之后应该能前进');
  forward.props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '知识点', '前进回到刚才退出的位置');
});

test('② 历史栈顶永远等于「我现在在哪」：同一页签内重复进入不堆空历史', () => {
  const { half, stateful, render } = loadPanel();
  const lib = half.DESCRIPTORS.internals;
  lib.resetNavigation();
  lib.resetMaterialsUi();
  lib.resetKnowledgeUi();

  stateful.begin();
  let tree = render();
  const today = currentTab(tree).label;
  assert.equal(today, '今日');

  // 连点两次「今日」（当前页签）：既不该切走，也不该多出一条历史
  tabButton(tree, '今日').props.onClick();
  tabButton(tree, '今日').props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '今日', '点当前页签不该切走');
  assert.equal(backButton(tree).props.disabled, true, '点当前页签不该凭空造出「上一步」');

  // 资料 → 知识点 → 上一步：回到资料（不是回到今日）
  tabButton(tree, '资料').props.onClick();
  stateful.begin();
  tree = render();
  tabButton(tree, '知识点').props.onClick();
  stateful.begin();
  tree = render();
  backButton(tree).props.onClick();
  stateful.begin();
  tree = render();
  assert.equal(currentTab(tree).label, '资料', '只退一步就该回到紧邻的那个页签');
});

test('③ 知识点页的「打开原件」是真调 POST /materials/open，失败要说原因', () => {
  const source = fs.readFileSync(FULL_FILE, 'utf8');
  // 卡 ⑥.7：不再是「跳到资料页读 OCR 原文」，而是打开磁盘上的原件；旁边留「在资料页定位」文字链
  assert.ok(source.includes("postStudy('/materials/open'"), '知识点页要直接调 open 接口');
  assert.ok(source.includes('在资料页定位'), '原按钮旁要保留「在资料页定位」文字链');
  assert.ok(!source.includes("}, '去资料页看')"), '旧的「去资料页看」按钮已删（改成打开原件 + 定位）');
  // 失败不能静默：错误码要翻成人话
  assert.ok(source.includes('materialActionErrorText'), '打开失败的提示要复用统一的错误文案映射');
});
