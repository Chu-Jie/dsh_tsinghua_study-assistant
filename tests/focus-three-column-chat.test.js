/**
 * 专注三栏 · 右栏真聊天（v2-J，2026-11-23，任务卡 ③ 块 B / D / E）。
 *
 * 这张卡把探针的占位右栏换成**真能聊天**的一栏，同时把右侧两根轴合并成一根、删掉右下角旧入口。
 * 真拖拽/真发请求要真 DOM + 真网络，本项目零依赖、没有浏览器测试栈，所以这里只钉三类东西：
 *   ① 纯逻辑（下拉选项归一、会话消息归一、预览识别）—— 直接调 internals 里的函数；
 *   ② 渲染（右栏三件套：模型下拉 / 输入框 / 发送；会话条；收起按钮回调）—— 直接渲染组件；
 *   ③ 源码钉子（两根轴门控、旧浮层入口已删、新 CSS 只用主题令牌且 0 hex）。
 *
 * 真机验收（重启 DSH 后多轮、切模型、拖轴）由用户按交付报告里的步骤做。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const FULL_FILE = path.join(HERE, '..', 'client.full.js');
const SHIPPED_FILE = path.join(HERE, '..', 'client.js');
const SOURCE = fs.readFileSync(FULL_FILE, 'utf8');
const SHIPPED = fs.readFileSync(SHIPPED_FILE, 'utf8');

/** 带 state 记忆的 React 替身（照 tests/focus-three-column-probe.test.js 的口径）。 */
function createStatefulReact() {
  const cells = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
    },
    useState(initial) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, (v) => { cells[i].value = typeof v === 'function' ? v(cells[i].value) : v; }];
    },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useRef(value) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { current: value };
      return cells[i];
    },
    useCallback(fn) { cursor++; return fn; },
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
    },
  };
  return { react: React, begin() { cursor = 0; } };
}

/** 把一棵（可能嵌套数组的）元素树摊平成节点列表。 */
function flatten(tree) {
  const out = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    out.push(n);
    (n.children || []).forEach(walk);
  })(tree);
  return out;
}

/** 取一段源码：找不到标记就直接失败，免得静默退化成「在全文里碰巧命中」。 */
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到终点标记：${endMarker}`);
  return text.slice(start, end);
}

/** 取一条 CSS 规则（选择器首次出现处到它的 `{` 之后的第一个 `}`）。 */
function cssRule(text, selectorStart) {
  const at = text.indexOf(selectorStart);
  assert.ok(at >= 0, `找不到 CSS 规则：${selectorStart}`);
  const open = text.indexOf('{', at);
  const close = text.indexOf('}', open);
  assert.ok(open > at && close > open, `CSS 规则不完整：${selectorStart}`);
  return text.slice(at, close + 1);
}

/**
 * 在最小浏览器假环境里执行 bundle，返回插件半边。
 *
 * `fetchImpl` 会挂进 vm 的全局上下文：右栏聊天是「真发请求」的组件，测试里换成桩，
 * 绝不真打网络（也绝不碰真密钥/真网关）。
 */
function loadBundle(options = {}) {
  const stateful = options.stateful ?? createStatefulReact();
  const fetchCalls = [];
  const registrations = [];
  const styleTags = [];
  const store = new Map(Object.entries(options.localStorage ?? {}));
  const fetchImpl = options.fetchImpl ?? (async () => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: true }),
  }));
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
    fetch: async (url, init = {}) => {
      fetchCalls.push({
        url: String(url),
        method: String(init.method ?? 'GET'),
        headers: init.headers ?? {},
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      });
      return fetchImpl(String(url), init);
    },
    document: {
      head: { appendChild(node) { node.isConnected = true; styleTags.push(node); return node; } },
      createElement(tag) { return { tagName: tag.toUpperCase(), isConnected: false, setAttribute() {}, textContent: '' }; },
      querySelector: () => null,
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
    logger: { info() {}, warn() {} },
    slots: {
      inject(slotName, callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
      register(registration, component) { registrations.push({ registration, component }); return () => {}; },
    },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
    get() { return undefined; },
  };
  half.apply(ctx);
  return { half, stateful, fetchCalls, registrations, styleTags };
}

test('① 下拉选项归一：默认模型排第一、去重、空清单也有默认一个', () => {
  const { half } = loadBundle();
  const chat = half.DESCRIPTORS.internals.focusChat;
  const models = chat.normalizeModels([
    { id: 'workbuddy/glm-5.3', owned_by: 'workbuddy' },
    { id: 'group/wb', owned_by: 'group' },
    { id: 'group/wb', owned_by: 'group' },
    { id: '   ', owned_by: 'x' },
    { id: 42, owned_by: 'y' },
    { id: 'antigravity/gemini-3.8-flash' },
  ]);
  // 注意：bundle 跑在 vm 的独立 realm 里，跨 realm 的对象原型不同，严格 deepEqual 会「看着一样却判不等」，
  // 所以数组先摊回本 realm 的普通数组再比。
  assert.deepEqual(Array.from(models, (item) => item.id), [
    'group/wb',
    'workbuddy/glm-5.3',
    'antigravity/gemini-3.8-flash',
  ], '默认模型排第一，其余按原顺序，重复与脏值被丢掉');
  assert.deepEqual(Array.from(chat.normalizeModels(null), (item) => item.id), ['group/wb'], '拿不到清单也要给默认一个（下拉不空）');
  assert.equal(chat.modelDefault, 'group/wb', '默认模型与后端 MAGPIE_MODEL 同一个字符串');
});

test('② 会话消息归一与预览识别：role/action 带上、坏形状的预览一律不算', () => {
  const { half } = loadBundle();
  const chat = half.DESCRIPTORS.internals.focusChat;
  const mapped = chat.mapSessionMessages([
    { role: 'user', content: '问', extra: '多余字段' },
    { role: 'assistant', content: '答', action: { kind: 'set-mastery', nodeId: 'p' } },
    { role: 'tool', content: 5 },
  ]);
  assert.deepEqual(mapped.map((item) => item.role), ['user', 'assistant', 'assistant'], '非 user 一律当 assistant');
  assert.equal(mapped[0].content, '问');
  assert.equal(mapped[0].action, null);
  // 跨 realm 的普通对象不能严格 deepEqual，用 JSON 口径比结构
  assert.equal(JSON.stringify(mapped[1].action), JSON.stringify({ kind: 'set-mastery', nodeId: 'p' }), '预览动作要带上');
  assert.equal(mapped[2].content, '', '非字符串 content 归空串，别把数字当正文渲染');
  for (const item of mapped) {
    assert.equal(item.actionState, null, '从磁盘读回来的消息不该带着「待确认」状态');
    assert.equal(item.batchSelected, null);
    assert.equal(item.batchExpanded, false);
  }

  assert.equal(chat.pickProposal({ kind: 'set-mastery', nodeId: 'p' }).kind, 'set-mastery');
  assert.equal(chat.pickProposal({ kind: 'set-mastery-batch', nodes: [] }).kind, 'set-mastery-batch');
  assert.equal(chat.pickProposal({ kind: 'do-something-else' }), null, '别的 kind 不许被当成确认卡');
  assert.equal(chat.pickProposal(null), null);
  assert.equal(chat.pickProposal('set-mastery'), null);
});

test('③ 右栏渲染：模型下拉 + 输入框 + 发送 + 收起按钮，收起走 onHide 回调', () => {
  const { half, stateful } = loadBundle();
  const chat = half.DESCRIPTORS.internals.focusChat;
  let hidden = 0;
  stateful.begin();
  const nodes = flatten(chat.panel({ onHide: () => { hidden += 1; }, buildContext: () => ({ studyMode: true }) }));

  const hideBtn = nodes.find((n) => n.props?.['data-sa-hide'] === 'right');
  assert.ok(hideBtn, '头部要有「收起 ⟩」按钮');
  hideBtn.props.onClick();
  assert.equal(hidden, 1, '收起按钮要调 onHide（右栏显隐由 KnowledgeTab 的 state 管）');

  const select = nodes.find((n) => n.type === 'select' && n.props?.['data-sa-chat-model'] === true);
  assert.ok(select, '要有模型下拉');
  assert.equal(select.props.value, 'group/wb', '默认选中 group/wb');
  const options = (select.children || []).filter((n) => n.type === 'option');
  assert.deepEqual(options.map((n) => n.props.value), ['group/wb'], '还没拉到清单时至少有一个默认模型可选');
  select.props.onChange({ target: { value: 'workbuddy/glm-5.3' } });
  stateful.begin();
  const after = flatten(chat.panel({ onHide: () => {}, buildContext: () => ({ studyMode: true }) }));
  assert.equal(after.find((n) => n.type === 'select').props.value, 'workbuddy/glm-5.3', '选中值进 state，下次请求就带它');

  const textarea = nodes.find((n) => n.type === 'textarea');
  assert.ok(textarea, '要有输入框');
  const sendBtn = nodes.find((n) => n.type === 'button' && (n.children || []).includes('发送'));
  assert.ok(sendBtn, '要有发送按钮');
  assert.equal(sendBtn.props.disabled, true, '草稿为空时发送按钮禁用');

  const nodes2 = flatten(chat.panel({ onHide: () => {}, buildContext: () => ({ studyMode: true }) }));
  const newBtn = nodes2.find((n) => n.props?.['data-sa-chat'] === 'new');
  assert.ok(newBtn, '要有「新会话」按钮');
  const sessionsBtn = nodes2.find((n) => n.props?.['data-sa-chat'] === 'sessions');
  assert.ok(sessionsBtn, '要有「会话」列表开关');
  const bar = nodes2.find((n) => n.props?.['data-sa-focus-bar'] === true);
  assert.ok(bar, '收起列表时要显示当前会话条');
  assert.ok((bar.children || []).includes('新会话') || JSON.stringify(bar).includes('新会话'), '还没开会话时显示「新会话」');
});

test('④ 发送：带上选中的 model、界面上下文（含 studyMode）与会话 id，回复进对话气泡', async () => {
  const replies = [];
  const { half, stateful, fetchCalls } = loadBundle({
    fetchImpl: async (url) => {
      if (url.includes('/assistant/session/new')) {
        return { status: 200, ok: true, json: async () => ({ ok: true, session: { id: 'sid-1' } }) };
      }
      if (url.includes('/assistant/reply')) {
        return { status: 200, ok: true, json: async () => ({ ok: true, reply: '**答**：这是回复' }) };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    },
  });
  const chat = half.DESCRIPTORS.internals.focusChat;
  stateful.begin();
  let nodes = flatten(chat.panel({
    onHide: () => {},
    buildContext: () => ({ tab: 'knowledge', nodeId: 'p', studyMode: true }),
  }));
  const textarea = nodes.find((n) => n.type === 'textarea');
  textarea.props.onChange({ target: { value: '解释一下这个定理' } });
  // 换模型（下拉的 onChange 直接写 state）
  stateful.begin();
  nodes = flatten(chat.panel({ onHide: () => {}, buildContext: () => ({ tab: 'knowledge', nodeId: 'p', studyMode: true }) }));
  nodes.find((n) => n.type === 'select').props.onChange({ target: { value: 'workbuddy/glm-5.3' } });

  stateful.begin();
  nodes = flatten(chat.panel({ onHide: () => {}, buildContext: () => ({ tab: 'knowledge', nodeId: 'p', studyMode: true }) }));
  const sendBtn = nodes.find((n) => n.type === 'button' && (n.children || []).includes('发送'));
  assert.equal(sendBtn.props.disabled, false, '有草稿就能发');
  sendBtn.props.onClick();
  // 放微任务跑完：new 会话 → reply → setMessages
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));

  const replyCall = fetchCalls.find((item) => item.url.includes('/assistant/reply'));
  assert.ok(replyCall, '必须真的发一次 /assistant/reply');
  assert.equal(replyCall.body.model, 'workbuddy/glm-5.3', '选中的模型要随请求发出去');
  assert.deepEqual(replyCall.body.messages, [{ role: 'user', content: '解释一下这个定理' }], '整段历史只留 role/content');
  assert.deepEqual(replyCall.body.context, { tab: 'knowledge', nodeId: 'p', studyMode: true }, '专注模式里的界面上下文要带上');
  assert.equal(replyCall.body.conversationId, 'sid-1', '先建会话再带 id 发，才会落盘');
  assert.equal(replyCall.headers['X-Study-Request'], '1', '写请求的安全头照旧');

  stateful.begin();
  const rendered = flatten(chat.panel({ onHide: () => {}, buildContext: () => ({}) }));
  const bubbles = rendered.filter((n) => n.props?.className === 'sa-focus-chat-bubble');
  assert.ok(bubbles.length >= 2, '一问一答都要在对话区里');
  assert.equal(bubbles[0].children[0], '解释一下这个定理', '用户自己的话保持纯文本原样');
  const assistantBubble = bubbles[1];
  assert.ok((assistantBubble.children || []).some((c) => typeof c === 'object'), '助手回复走渲染器（概不裸奔 Markdown）');
  replies.push(replyCall.body.reply);
});

test('⑤ 两根轴合一：右栏开时正文手柄退场（data-sa-axis=merged），右栏关掉后回来', () => {
  const { half, stateful } = loadBundle();
  const lib = half.DESCRIPTORS.internals;
  const docs = {
    courses: { courses: [{ id: 'a', name: 'A' }] },
    knowledgeNetwork: { nodes: [{ id: 'p', name: 'Focus point', courseId: 'a', chapter: '第1章 A' }] },
  };
  lib.readKnowledgeUi({ selected: 'p', treeCourseId: 'a' });
  const render = () => {
    stateful.begin();
    return flatten(lib.knowledgeTab({ docs }));
  };
  const text = (n) => (n.children || []).filter((x) => typeof x === 'string').join('');

  let f = render();
  const page = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0 }) };
  f.find((n) => n.props?.className === 'sa-reader-pane').props.ref.current = { closest: () => page, getBoundingClientRect: () => ({ top: 0 }) };
  f.find((n) => n.type === 'button' && text(n) === '进入学习模式').props.onClick({ currentTarget: {} });
  f = render();

  const splitter = f.find((n) => n.props?.['data-sa-read-splitter'] === true);
  assert.ok(splitter, 'v2-H 的正文手柄元素仍在（右栏关掉时要能回来）');
  assert.equal(splitter.props['data-sa-axis'], 'merged', '右栏开着 → 手柄标记成 merged（CSS 收掉它 + 不吃指针）');
  const chatBoundary = f.find((n) => n.props?.['data-sa-boundary'] === 'chat');
  assert.ok(chatBoundary, '右侧只留「右栏左缘」这一根轴');
  assert.equal(chatBoundary.props.style.top, '64px', '这根轴从右栏头顶开始（宿主顶栏高度让位），不钻进顶栏');

  const aside = f.find((n) => n.props?.['data-sa-focus-chat'] === 'true');
  aside.children.find((c) => typeof c?.type === 'function').props.onHide();
  f = render();
  const splitterOff = f.find((n) => n.props?.['data-sa-read-splitter'] === true);
  assert.equal(splitterOff.props['data-sa-axis'], 'split', '右栏关掉 → 正文手柄恢复（v2-H 能力不丢）');
  assert.ok(!f.some((n) => n.props?.['data-sa-boundary'] === 'chat'), '右栏关掉 → 那根轴也收掉');
});

test('⑥ 旧入口已删：右下角浮层不再渲染，组件本体暂留', () => {
  assert.ok(!SOURCE.includes("className: 'sa-assist-fab'"), '圆点按钮的渲染已删');
  assert.ok(!SOURCE.includes("className: 'sa-assist-dot'"), '圆点按钮里的那个点也删干净（只剩无引用的 CSS 规则）');
  assert.ok(!SOURCE.includes('h(AssistantOverlay, {'), '浮层挂载点已删（不再往面板里挂任何浮层）');
  assert.ok(SOURCE.includes('function AssistantOverlay(props = {}) {'), '组件本体暂留不删（避免大爆炸）；报告里说明它已无引用');
});

test('⑦ 右栏新 CSS：头顶让位走变量、只用主题令牌、0 hex、竖条不钻顶栏', () => {
  const chat = cssRule(SOURCE, '.sa-focus-chat{');
  assert.ok(chat.includes('top:var(--sa-focus-chat-top'), '顶部偏移必须走变量（真机按宿主顶栏高度算）');
  assert.ok(chat.includes('--sa-focus-chat'), '宽度仍由 --sa-focus-chat 控制');
  assert.ok(chat.includes('--dsw-alias-'), '底色/边框走主题令牌');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(chat), false, '不许出现硬编码 hex');

  const axis = cssRule(SOURCE, '.sa-read-splitter[data-sa-axis="merged"]');
  assert.ok(axis.includes('display:none'), '右栏开时正文手柄要真的不显示');
  assert.ok(axis.includes('pointer-events:none'), '别留一条看不见但能拖的热区');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(axis), false, '不许出现硬编码 hex');

  // 新增的右栏聊天 CSS 段整段查一遍：0 hex（卡 ④ 硬约束 2）
  const section = sliceBetween(SOURCE, '.sa-focus-chat{', '.sa-focus-boundary{');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(section), false, '右栏聊天整段 CSS 不许出现 hex');
});

test('⑧ 右栏顶部让位：坏值回 64，超界/负数都被夹住，量不到也回 64', () => {
  const { half } = loadBundle();
  const fl = half.DESCRIPTORS.internals.focusLayout;
  assert.equal(fl.chatTopFallback, 64);
  assert.equal(fl.clampChatTop('abc'), 64, 'NaN 回初值');
  assert.equal(fl.clampChatTop(-10), 64, '负数回初值（量错了宁可保守）');
  assert.equal(fl.clampChatTop(200), 64, '超过 96 也回初值（别把右栏顶掉半屏）');
  assert.equal(fl.clampChatTop(40), 40, '正常值原样用');
  assert.equal(fl.clampChatTop(52.4), 52, '取整到像素');
  assert.equal(fl.readHostTopInset(), 64, '假 DOM 里量不到宿主顶栏 → 回初值，不抛错');
});

test('⑨ 两份 bundle 逐字一致（改 client.full.js 必须 --reverse 同步到 client.js）', () => {
  assert.equal(SHIPPED, SOURCE);
});
