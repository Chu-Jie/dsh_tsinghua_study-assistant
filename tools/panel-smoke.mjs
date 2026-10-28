#!/usr/bin/env node
/**
 * 面板烟测（2026-10-23 凌晨）：拿真实的 `学习台/*.json`，在不启动宿主的前提下
 * 把客户端面板的每个页签、知识页的每个视图、每个节点的详情卡都渲染一遍。
 *
 * 为什么要有它：`tests/client.test.js` 用的是手搓的小数据，覆盖不到「真实数据里某个字段
 * 长得跟以为的不一样」这类问题；而这类问题的表现是**打开面板就白屏**（例如 2026-10-23 凌晨
 * 的 `outlineDoc` TDZ、`nodes` 里混进 null）。发现一次白屏要重启宿主 + 肉眼找，太贵。
 *
 * 做法：极简 React 替身（和测试里那份同构）+ vm 加载发布件 `client.js`，
 * 组件函数同步调用，真渲染子树。不联网、不写盘、零依赖。
 *
 * 用法：
 *   node tools/panel-smoke.mjs                 # 用默认数据目录（工作区 学习台/）
 *   node tools/panel-smoke.mjs --data D:\x\学习台  # 指定数据目录
 *   node tools/panel-smoke.mjs --verbose       # 每个用例都打一行
 * 退出码：0 = 全部渲染通过；1 = 有页面抛异常或漏出 undefined/NaN/[object Object]。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 与 tests/client.test.js 同构的 React 替身：组件同步调用、hooks 只取值不调度。 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
    },
  };
}

/** 极简 renderToStaticMarkup：类组件的错误边界也照真 React 的语义走一遍。 */
function renderToMarkup(node) {
  function walk(item) {
    if (item === null || item === undefined || item === false) return '';
    if (typeof item === 'string' || typeof item === 'number') return String(item);
    if (Array.isArray(item)) return item.map(walk).join('');
    if (typeof item.type === 'function') {
      const proto = item.type.prototype;
      if (proto !== undefined && typeof proto.render === 'function') {
        const instance = new item.type({ ...item.props, children: item.children });
        try {
          return walk(instance.render());
        } catch (error) {
          if (typeof item.type.getDerivedStateFromError !== 'function') throw error;
          instance.state = { ...instance.state, ...item.type.getDerivedStateFromError(error) };
          instance.componentDidCatch?.(error);
          return walk(instance.render());
        }
      }
      return walk(item.type({ ...item.props, children: item.children }));
    }
    return `<${item.type}>${item.children.map(walk).join('')}</${item.type}>`;
  }
  return walk(node);
}

/** 加载发布件 client.js，返回它的 internals（测试/工具专用出口）。 */
function loadClient(clientFile) {
  const injected = [];
  const context = {
    window: {},
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      head: {
        appendChild(node) { node.isConnected = true; injected.push(node); return node; },
        removeChild(node) { node.isConnected = false; return node; },
      },
      createElement(tag) {
        return { tagName: tag.toUpperCase(), attributes: {}, isConnected: false, setAttribute(key, value) { this.attributes[key] = value; }, textContent: '' };
      },
      querySelector() { return null; },
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, docs: {}, hashes: {}, problems: [] }) }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) { context.__exports = registration.factory(() => makeReact()); },
  };
  vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), context, { filename: clientFile });
  const exports_ = context.__exports;
  const internals = exports_?.DESCRIPTORS?.internals ?? exports_?.internals;
  if (internals === undefined) throw new Error('client.js 没导出 internals（无法烟测）');
  return internals;
}

function parseArgs(argv) {
  const args = { data: path.join(HERE, '..', '..', '..', '学习台'), verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--data') args.data = argv[++i];
    else if (token === '--verbose') args.verbose = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

function readDocs(dataDir) {
  const docs = {};
  const names = {
    term: '学期.json',
    courses: '课程.json',
    tasks: '任务.json',
    grades: '成绩.json',
    homework: '作业.json',
    materials: '资料索引.json',
    questions: '题目.json',
    knowledgeCandidates: '知识点候选.json',
    knowledgeNetwork: '知识点网络.json',
    knowledgeOutline: '知识点大纲.json',
  };
  for (const [key, name] of Object.entries(names)) {
    const file = path.join(dataDir, name);
    docs[key] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  }
  return docs;
}

const BAD_TOKENS = ['undefined', 'NaN', '[object Object]'];
const args = parseArgs(process.argv.slice(2));
const clientFile = path.join(HERE, '..', 'client.js');
const internals = loadClient(clientFile);
const docs = readDocs(args.data);
const now = new Date();

const cases = [];
const run = (name, build) => {
  try {
    const html = renderToMarkup(build());
    const bad = BAD_TOKENS.filter((token) => html.includes(token));
    cases.push({ name, ok: true, chars: html.length, bad });
    if (args.verbose) console.log(`  ✔ ${name}（${html.length} 字符）`);
  } catch (error) {
    cases.push({ name, ok: false, error: `${error.name}: ${error.message}` });
  }
};

// 1) 整个面板（默认页签 = 今日）
run('MainPanel', () => ({ __el: true, type: internals.mainPanel, props: { docs, now, refresh: () => {}, openDetail: () => {} } }));
// 2) 单页
run('TodayTab', () => ({ __el: true, type: internals.todayTab, props: { docs, now, refresh: () => {}, onOpenKnowledgeReview: () => {}, onOpenKnowledge: () => {} } }));
run('SettingsTab', () => ({ __el: true, type: internals.settingsTab, props: { docs, refresh: () => {}, busy: false, run: async () => {}, setBusy: () => {} } }));
run('MaterialsTab', () => ({ __el: true, type: internals.materialsTab, props: { docs, refresh: () => {}, onOpenKnowledge: () => {} } }));
// 3) 知识点页五视图 + 七档筛选
for (const view of ['tree', 'mind', 'graph', 'list', 'explain']) {
  run(`KnowledgeTab/${view}`, () => ({ __el: true, type: internals.knowledgeTab, props: { docs, refresh: () => {}, initialView: view } }));
}
for (const filter of ['all', 'unlearned', 'marked', 'due', 'unmounted', 'issues', 'noanalysis']) {
  internals.resetKnowledgeUi();
  internals.readKnowledgeUi({ filter, view: 'list' });
  run(`KnowledgeTab/筛选=${filter}`, () => ({ __el: true, type: internals.knowledgeTab, props: { docs, refresh: () => {} } }));
}
// 4) 每个节点的详情卡（证据、讲解、改挂靠三条路径都在这里）
const nodes = Array.isArray(docs.knowledgeNetwork?.nodes) ? docs.knowledgeNetwork.nodes : [];
for (const node of nodes) {
  internals.resetKnowledgeUi();
  internals.readKnowledgeUi({ selected: node.id, view: 'list' });
  run(`KnowledgeTab/选中=${node.id}`, () => ({ __el: true, type: internals.knowledgeTab, props: { docs, refresh: () => {} } }));
}
internals.resetKnowledgeUi();
// 5) 坏数据 / 空数据
run('坏数据/空 docs', () => ({ __el: true, type: internals.knowledgeTab, props: { docs: {}, refresh: () => {} } }));
run('坏数据/空节点表', () => ({ __el: true, type: internals.knowledgeTab, props: { docs: { ...docs, knowledgeNetwork: { nodes: [] } }, refresh: () => {} } }));
run('坏数据/nodes 混 null', () => ({
  __el: true,
  type: internals.knowledgeTab,
  props: { docs: { ...docs, knowledgeNetwork: { nodes: [null, {}, { id: 'k_x', evidence: [{ type: 'question', id: 'q_missing' }] }] } }, refresh: () => {} },
}));
run('坏数据/无大纲', () => ({ __el: true, type: internals.knowledgeTab, props: { docs: { ...docs, knowledgeOutline: {} }, refresh: () => {} } }));
// 2026-10-23 凌晨：三种「字段存在但形状不对」的坏数据——真实文件被别的脚本写坏时大概长这样
run('坏数据/大纲 chapters 不是数组', () => ({
  __el: true,
  type: internals.knowledgeTab,
  props: { docs: { ...docs, knowledgeOutline: { courses: [{ courseId: 'c_ds', chapters: null }, null] } }, refresh: () => {} },
}));
run('坏数据/题目表混 null', () => ({
  __el: true,
  type: internals.knowledgeTab,
  props: { docs: { ...docs, questions: { questions: [null, { id: 'q1', prompt: 'x' }, null] } }, refresh: () => {} },
}));
run('坏数据/课程表混 null', () => ({
  __el: true,
  type: internals.knowledgeTab,
  props: { docs: { ...docs, courses: { courses: [null, { id: 'c_ds', name: '数据结构' }] } }, refresh: () => {} },
}));
run('坏数据/今日页字段全空', () => ({
  __el: true,
  type: internals.todayTab,
  props: { docs: { knowledgeNetwork: { nodes: null }, tasks: { tasks: null } }, now, refresh: () => {} },
}));

const failed = cases.filter((item) => item.ok !== true);
const dirty = cases.filter((item) => item.ok === true && item.bad.length > 0);
for (const item of failed) console.log(`  ✖ ${item.name} → ${item.error}`);
for (const item of dirty) console.log(`  ⚠ ${item.name} → 漏出 ${item.bad.join('、')}`);

const health = internals.knowledgeHealth(nodes, {
  outline: docs.knowledgeOutline,
  questions: Array.isArray(docs.questions?.questions) ? docs.questions.questions : [],
});
console.log(`\n数据：${nodes.length} 个节点 / 大纲 ${(docs.knowledgeOutline?.courses ?? []).length} 门课 / 题目 ${Array.isArray(docs.questions?.questions) ? docs.questions.questions.length : 0} 道`);
console.log(`体检：未归类 ${health.unclassified} · 未分节 ${health.unmounted} · 无证据 ${health.noEvidence} · 悬空 ${health.dangling} · 无大纲 ${health.noOutline}`);
console.log(`用例 ${cases.length}：失败 ${failed.length}，文案异常 ${dirty.length}`);

if (failed.length > 0 || dirty.length > 0) {
  console.log('\n✖ 面板烟测不通过');
  process.exit(1);
}
console.log('✔ 面板烟测通过（真数据下 7 个页签、5 个视图、7 档筛选、全部节点详情都能渲染）');
