/**
 * 三栏布局最小可行性探针的测试（2026-11-23，可弃）。
 *
 * 这张卡只验证「能不能做」，所以这里的断言也只要两件事：
 *   1) 结构真的长出来了（左/中/右三栏、两条边界分隔条、两栏可隐藏可恢复）；
 *   2) 右栏测试 tab 的注册路径真的走了公开 API（ctx.slots.register + sidebarRightTabs.register + openTab）。
 *
 * 不做像素级断言：真实拖拽/观感由用户重启 DSH 后验收，这里只钉代码路径，避免假绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const FULL_FILE = path.join(HERE, '..', 'client.full.js');
const SHIPPED_FILE = path.join(HERE, '..', 'client.js');

/** 极简 React 替身（照 tests/client.test.js 的口径，只实现本项目用到的那部分）。 */
function createFakeReact() {
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
    },
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
  return React;
}

/** 带 state 记忆的 React 替身：点一次按钮能真的改 state 并重渲染（三栏显隐靠它验）。 */
function createStatefulReact() {
  const cells = [];
  let cursor = 0;
  const base = createFakeReact();
  return {
    react: {
      ...base,
      useState(initial) {
        const i = cursor++;
        if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial };
        return [cells[i].value, (v) => { cells[i].value = typeof v === 'function' ? v(cells[i].value) : v; }];
      },
      useRef(value) {
        const i = cursor++;
        if (!cells[i]) cells[i] = { current: value };
        return cells[i];
      },
      useCallback(fn) {
        cursor++;
        return fn;
      },
    },
    begin() { cursor = 0; },
  };
}

/** 在最小浏览器假环境里执行一份 bundle，返回插件半边 + 注册记录。 */
function loadBundle(file, options = {}) {
  const registrations = [];
  const tabTypes = [];
  const openedKinds = [];
  const logs = [];
  const styleTags = [];
  const store = new Map(Object.entries(options.localStorage ?? {}));
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
      head: {
        appendChild(node) {
          node.isConnected = true;
          styleTags.push(node);
          return node;
        },
      },
      createElement(tag) {
        return { tagName: tag.toUpperCase(), isConnected: false, setAttribute() {}, textContent: '' };
      },
      querySelector: () => null,
    },
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      const fakeRequire = (specifier) => {
        assert.equal(specifier, 'react', `客户端只允许 require('react')，实际请求了 ${specifier}`);
        return options.react ?? createFakeReact();
      };
      context.__exports = registration.factory(fakeRequire);
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

  const half = context.__exports;
  const services = {
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition);
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) {
        openedKinds.push(kind);
      },
    },
  };
  const ctx = {
    logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    slots: {
      inject(slotName, callback) {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      return services[name];
    },
  };
  half.apply(ctx);
  return { half, registrations, tabTypes, openedKinds, logs, styleTags };
}

const SOURCE = fs.readFileSync(FULL_FILE, 'utf8');
const SHIPPED = fs.readFileSync(SHIPPED_FILE, 'utf8');

/** 从源码里切出 `.sa-focus-chat{...}` 这条规则（单行、无嵌套大括号）。 */
function cssRule(text, selectorStart) {
  const at = text.indexOf(selectorStart);
  if (at < 0) return '';
  const end = text.indexOf('}', at);
  return text.slice(at, end + 1);
}

test('CSS：右栏/边界/浮标三条新规则齐备，且只用主题令牌、无 hex', () => {
  const chat = cssRule(SOURCE, '.sa-focus-chat{');
  assert.ok(chat.includes('position:fixed') && chat.includes('right:0'), '右栏要 fixed 贴右缘');
  assert.ok(chat.includes('--sa-focus-chat'), '宽度由 --sa-focus-chat 控制（拖拽只改这个变量）');
  const boundary = cssRule(SOURCE, '.sa-focus-boundary{');
  assert.ok(boundary.includes('cursor:ew-resize'), '边界分隔条要可左右拖');
  const boundaryLine = cssRule(SOURCE, '.sa-focus-boundary::before{');
  assert.ok(boundaryLine.includes('var(--dsw-alias-border-l1)'), '边界中线颜色走主题令牌');
  const stub = cssRule(SOURCE, '.sa-focus-stub{');
  assert.ok(stub.includes('cursor:pointer'), '隐藏后的恢复浮标要可点');
  for (const [name, rule] of [['右栏', chat], ['边界基线', boundary], ['边界中线', boundaryLine], ['浮标', stub]]) {
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(rule), `${name} 里不许出现 hex 色值：${rule}`);
  }
  for (const [name, rule] of [['右栏', chat], ['边界中线', boundaryLine], ['浮标', stub]]) {
    assert.ok(rule.includes('--dsw-alias-'), `${name} 的颜色要走主题令牌`);
  }
});

test('CSS：三栏覆盖规则挂在 data-focus-three-col 上，默认态与既有 212px/200px 原样保留', () => {
  assert.ok(SOURCE.includes('.sa-focus-header[data-focus-three-col="true"]{width:var(--sa-focus-rail'), '左栏宽度改成变量，但只在三栏态生效');
  assert.ok(SOURCE.includes('.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]{padding:'), '正文让位改成左右两栏变量');
  assert.ok(SOURCE.includes('.sa-reader-pane[data-study-mode="true"]{position:fixed'), '默认全屏规则仍在');
  assert.ok(SOURCE.includes('padding:18px 18px 18px 212px'), '默认 212px 让位一字不动（既有断言仍可用）');
  assert.ok(SOURCE.includes('.sa-focus-header{position:fixed'), '竖条默认规则仍在');
  assert.ok(/\.sa-focus-header\{[^}]*width:200px/.test(SOURCE), '竖条默认 200px 仍在');
});

test('渲染：进学习模式后出现左/中/右三栏、两条边界分隔条、右栏含 HOST SLOT OK 入口', () => {
  const stateful = createStatefulReact();
  const { half } = loadBundle(FULL_FILE, { react: stateful.react });
  const lib = half.DESCRIPTORS.internals;
  const docs = { courses: { courses: [{ id: 'a', name: 'A' }] }, knowledgeNetwork: { nodes: [{ id: 'p', name: 'Focus point', courseId: 'a', chapter: '第1章 A' }] } };
  lib.readKnowledgeUi({ selected: 'p', treeCourseId: 'a' });
  const flat = (tree) => {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      out.push(n);
      (n.children || []).forEach(walk);
    })(tree);
    return out;
  };
  const render = () => { stateful.begin(); return flat(lib.knowledgeTab({ docs })); };

  let f = render();
  const page = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0 }) };
  f.find((n) => n.props?.className === 'sa-reader-pane').props.ref.current = { closest: () => page, getBoundingClientRect: () => ({ top: 0 }) };
  const text = (n) => (n.children || []).filter((x) => typeof x === 'string').join('');
  f.find((n) => n.type === 'button' && text(n) === '进入学习模式').props.onClick({ currentTarget: {} });
  f = render();

  const pane = f.find((n) => n.props?.className === 'sa-reader-pane');
  assert.equal(pane.props['data-focus-three-col'], 'true', '进专注后正文面要打 data-focus-three-col');
  assert.equal(pane.props.style['--sa-focus-rail'], '200px', '左栏默认 200px');
  assert.equal(pane.props.style['--sa-focus-chat'], '360px', '右栏默认 360px');
  assert.ok(f.some((n) => n.props?.className === 'sa-focus-chat'), '右栏 .sa-focus-chat 要渲染出来');
  assert.ok(f.some((n) => n.props?.['data-sa-focus-chat'] === 'true'), '右栏要带探针标记');

  const boundaries = f.filter((n) => n.props?.className === 'sa-focus-boundary');
  assert.deepEqual(boundaries.map((n) => n.props['data-sa-boundary']).sort(), ['chat', 'rail'], '两条边界分隔条：左栏边界 + 右栏边界');
  const rail = boundaries.find((n) => n.props['data-sa-boundary'] === 'rail');
  assert.equal(rail.props.style.left, '200px', '左边界贴左栏右缘');
  const chatBoundary = boundaries.find((n) => n.props['data-sa-boundary'] === 'chat');
  assert.equal(chatBoundary.props.style.left, 'calc(100vw - 360px)', '右边界贴右栏左缘');

  // 2026-11-23 产品化（大卡块 D/E）：右栏里那句「在宿主右栏打开测试标签（HOST SLOT OK）」
  // 的探针按钮随真聊天上线被删（卡 ③ 块 E 明确要求），右栏改挂聊天组件（FocusChatPanel）。
  // 这里只钉「结构」：探针占位文案不再出现、右栏挂的是组件；组件内部的模型下拉/输入框
  // 由 tests/focus-three-column-chat.test.js 直接渲染组件来验（这里的假 React 不展开子组件）。
  const aside = f.find((n) => n.props?.['data-sa-focus-chat'] === 'true');
  assert.ok(!f.some((n) => n.props?.['data-sa-probe'] === 'host-tab'), '探针取证按钮已删，不许留在产品界面里');
  assert.ok(aside.children.some((c) => typeof c?.type === 'function'), '右栏挂的是聊天组件，不再是占位文案');
  const asideText = (function deep(n) {
    let text = '';
    (function walk(x) {
      if (typeof x === 'string') { text += x; return; }
      if (!x || typeof x !== 'object') return;
      (x.children || []).forEach(walk);
    })(n);
    return text;
  })(aside);
  assert.ok(!asideText.includes('三栏探针'), '占位文案「三栏探针…」已删干净');
  assert.ok(!asideText.includes('HOST SLOT OK'), '探针按钮文案已删干净');
});

test('渲染：左栏可隐藏可恢复，隐藏后左边界同步消失；右栏同理', () => {
  const stateful = createStatefulReact();
  const { half, openedKinds } = loadBundle(FULL_FILE, { react: stateful.react, localStorage: { sa_probe_host_tab: '1' } });
  const lib = half.DESCRIPTORS.internals;
  const docs = { courses: { courses: [{ id: 'a', name: 'A' }] }, knowledgeNetwork: { nodes: [{ id: 'p', name: 'Focus point', courseId: 'a', chapter: '第1章 A' }] } };
  lib.readKnowledgeUi({ selected: 'p', treeCourseId: 'a' });
  const flat = (tree) => {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      out.push(n);
      (n.children || []).forEach(walk);
    })(tree);
    return out;
  };
  const render = () => { stateful.begin(); return flat(lib.knowledgeTab({ docs })); };
  const text = (n) => (n.children || []).filter((x) => typeof x === 'string').join('');

  let f = render();
  const page = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0 }) };
  f.find((n) => n.props?.className === 'sa-reader-pane').props.ref.current = { closest: () => page, getBoundingClientRect: () => ({ top: 0 }) };
  f.find((n) => n.type === 'button' && text(n) === '进入学习模式').props.onClick({ currentTarget: {} });
  f = render();

  // 左栏：隐藏 → 竖条消失、左边界消失、左侧浮标出现；点浮标 → 全部回来
  f.find((n) => n.props?.['data-sa-hide'] === 'left').props.onClick();
  f = render();
  assert.ok(!f.some((n) => n.props?.className === 'sa-focus-header sa-study-header'), '左栏隐藏后竖条不再渲染');
  assert.ok(!f.some((n) => n.props?.['data-sa-boundary'] === 'rail'), '左边界同步隐藏');
  assert.ok(f.some((n) => n.props?.['data-sa-stub'] === 'left'), '左侧恢复浮标出现');
  f.find((n) => n.props?.['data-sa-stub'] === 'left').props.onClick();
  f = render();
  assert.ok(f.some((n) => n.props?.className === 'sa-focus-header sa-study-header'), '点浮标后左栏恢复');

  // 右栏：隐藏 → .sa-focus-chat 消失、右边界消失、右侧浮标出现；点浮标 → 回来
  // （收起按钮现在长在聊天组件里；这里直接调右栏挂载时传下去的 onHide，等价于点那颗「收起 ⟩」）
  const asideNow = f.find((n) => n.props?.['data-sa-focus-chat'] === 'true');
  asideNow.children.find((c) => typeof c?.type === 'function').props.onHide();
  f = render();
  assert.ok(!f.some((n) => n.props?.className === 'sa-focus-chat'), '右栏隐藏后不再渲染');
  assert.ok(!f.some((n) => n.props?.['data-sa-boundary'] === 'chat'), '右边界同步隐藏');
  assert.ok(f.some((n) => n.props?.['data-sa-stub'] === 'right'), '右侧恢复浮标出现');
  f.find((n) => n.props?.['data-sa-stub'] === 'right').props.onClick();
  f = render();
  assert.ok(f.some((n) => n.props?.className === 'sa-focus-chat'), '点浮标后右栏恢复');

  // 2026-11-23 产品化（大卡块 E）：探针里那颗「打开宿主测试标签」的入口按钮已删，
  // 「关掉右栏后左缘那条轴也消失」由上一段断言；openTab 路径的钉子改由「B：开关打开时」那条负责。
});

test('B：开关打开时，apply() 把探针 tab 注册进 sidebar.right.pane.tab，并注册 tab 类型（id/kind 与槽位 key 一致）', () => {
  const { half, registrations, tabTypes } = loadBundle(FULL_FILE, { localStorage: { sa_probe_host_tab: '1' } });
  const probe = half.DESCRIPTORS.probeTab;
  assert.equal(probe.id, 'study-assistant/probe');
  assert.equal(probe.kind, 'studyProbe');
  assert.equal(probe.defaultEnabled, false, '探针 tab 默认关闭：不给产品多留永久 tab，也不破坏既有「只注册一个类型」契约');
  assert.ok(tabTypes.some((t) => t.id === probe.id && t.kind === probe.kind), 'sidebarRightTabs.register 收到探针 tab 类型');
  assert.ok(registrations.some((r) => r.options.name === 'sidebar.right.pane.tab' && r.options.key === probe.id),
    'sidebar.right.pane.tab 收到同 key 的渲染体（key 必须等于 tab 类型 id，否则永不派发）');
  assert.ok(registrations.some((r) => r.options.name === 'sidebar.right.pane.tab.title' && r.options.key === probe.id),
    '标题槽位同 key 注册');
  const probeReg = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab' && r.options.key === probe.id);
  const tree = probeReg.component({});
  const found = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    found.push(n);
    (n.children || []).forEach(walk);
  })(tree);
  assert.ok(found.some((n) => (n.children || []).includes('HOST SLOT OK')), '测试 tab 必须只显示 HOST SLOT OK 这一行结论');
});

test('B：开关默认关闭 —— 不注册第二个 tab 类型（既有契约测试仍绿）', () => {
  const { tabTypes, registrations, half } = loadBundle(FULL_FILE);
  assert.equal(tabTypes.length, 1, '默认只注册产品自己的 studyDetail 类型');
  assert.equal(tabTypes[0].kind, half.DESCRIPTORS.detailTabDefinition.kind);
  assert.ok(!registrations.some((r) => r.options.key === 'study-assistant/probe'), '默认不注册探针渲染体');
});

test('三栏栏宽夹取：坏值回下限、超限夹到上下界、正常值取整', () => {
  const { half } = loadBundle(FULL_FILE);
  const fl = half.DESCRIPTORS.internals.focusLayout;
  assert.equal(fl.railMin, 120);
  assert.equal(fl.railMax, 420);
  assert.equal(fl.chatMin, 260);
  assert.equal(fl.chatMax, 640);
  assert.equal(fl.clamp('abc', 120, 420), 120, 'NaN 回下限，不许把栏拖成 NaN');
  assert.equal(fl.clamp(9999, 120, 420), 420, '超上限夹到上限');
  assert.equal(fl.clamp(-50, 260, 640), 260, '负数夹到下限');
  assert.equal(fl.clamp(333.6, 260, 640), 334, '正常值四舍五入到整像素');
});

test('两份 bundle 逐字一致（改 client.full.js 必须 --reverse 同步到 client.js）', () => {
  assert.equal(SHIPPED, SOURCE, 'client.js 必须与 client.full.js 逐字一致');
});
