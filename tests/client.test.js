/**
 * 客户端 bundle 测试（零依赖）
 * 运行：node tests/client.test.js
 *
 * client.js 是给浏览器用的单文件模块，但它的「加载 → 注册 → 渲染」三段
 * 都能在 Node 里用最小假环境跑通。这样能在安装之前就发现：
 *   - 模块加载期抛错（会让整个 bundle 不生效）；
 *   - 槽位注册选项写错（id/key/order 与宿主契约不符）；
 *   - 某个组件渲染即抛错（在浏览器里的表现就是槽位空白 + 控制台报错）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { OFFICIAL_TOKENS } from '../tools/fix-theme-tokens.mjs';

const HERE = import.meta.dirname;
const CLIENT_FILE = path.join(HERE, '..', 'client.js');

/** 极简 React 替身：只实现本项目用到的那部分，组件函数一律同步调用。 */
function createFakeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
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
    /**
     * 错误边界用的类组件基座。真实 React 里 startTransition / getDerivedStateFromError
     * 都由框架驱动；这里只提供最小的「构造 + 可渲染」，让假 renderer 能同步调用 render()。
     */
    Component: class Component {
      constructor(props) {
        this.props = props ?? {};
        this.state = {};
      }
    },
  };
  return React;
}

/** 极简 renderToStaticMarkup：递归调用函数组件，捕获渲染期异常。 */
function createFakeServer() {
  function render(node) {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(render).join('');
    if (typeof node.type === 'function') {
      // 类组件（错误边界）走「实例化 + render()」；函数组件直接调用。
      const prototype = node.type.prototype;
      if (prototype !== undefined && typeof prototype.render === 'function') {
        const instance = new node.type({ ...node.props, children: node.children });
        try {
          return render(instance.render());
        } catch (error) {
          // 复刻 React 的错误边界语义：子树抛错 → getDerivedStateFromError → 重画。
          // 没有这一步，测试会以为「边界不起作用」，而真实 React 里是好的。
          if (typeof node.type.getDerivedStateFromError !== 'function') throw error;
          instance.state = { ...instance.state, ...node.type.getDerivedStateFromError(error) };
          instance.componentDidCatch?.(error);
          return render(instance.render());
        }
      }
      return render(node.type({ ...node.props, children: node.children }));
    }
    // 宿主元素：把标签名写进输出，便于断言「确实渲染出了 svg」
    return `<${node.type}>${node.children.map(render).join('')}</${node.type}>`;
  }
  return { renderToStaticMarkup: render };
}

/** 在最小浏览器假环境里执行 client.js，返回注册记录。 */
function loadClient(options = {}) {
  const registrations = [];
  const tabTypes = [];
  const openedKinds = [];
  const logs = [];
  const serviceReads = [];
  const injectedStyles = [];
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // 最小 document 替身：只提供「注入样式表」这条路径需要的部分。
    // client.js 的 Style 组件只在渲染期把 <style> 追加到 document.head，
    // 绝不把 style 节点渲染进槽位（详见 client.js 里那段为什么的注释）。
    // 这里额外模拟 DSH 3 的两件事：节点的 isConnected 状态（样式被模块系统回收后
    // 必须能重新注入）与 `style[data-plugin-css="…"]` 查询（官方包的归属约定）。
    document: {
      head: {
        appendChild(node) {
          node.isConnected = true;
          injectedStyles.push(node);
          return node;
        },
        removeChild(node) {
          node.isConnected = false;
          const at = injectedStyles.indexOf(node);
          if (at >= 0) injectedStyles.splice(at, 1);
          return node;
        },
      },
      createElement(tag) {
        return { tagName: tag.toUpperCase(), attributes: {}, isConnected: false, setAttribute(k, v) { this.attributes[k] = v; }, textContent: '' };
      },
      querySelector(selector) {
        const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector);
        if (match === null) return null;
        return injectedStyles.find((el) => el.attributes['data-plugin-css'] === match[1]) || null;
      },
    },
    fetch: async () => ({
      status: 200,
      json: async () => ({ ok: true, dataDir: '测试目录', healthy: true, files: [], docs: {}, hashes: {}, problems: [] }),
    }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      assert.equal(registration.id, 'dsh-study-assistant', '模块 id 必须等于包名');
      const fakeRequire = (specifier) => {
        assert.equal(specifier, 'react', `客户端只允许 require('react')，实际请求了 ${specifier}`);
        return options.react ?? createFakeReact();
      };
      context.__exports = registration.factory(fakeRequire);
    },
  };

  const code = fs.readFileSync(CLIENT_FILE, 'utf8');
  vm.runInNewContext(code, context, { filename: CLIENT_FILE });

  const half = context.__exports;
  const ctx = {
    logger: { info: (...args) => logs.push(args.join(' ')) },
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
    // 真 ctx 的安全读取入口。**客户端半边现在只允许通过它取可选服务**：
    // 真 cordis 4 的 ctx 代理对「读取未 inject 的服务属性」是抛错
    // （cannot get property "X" without inject），所以直接点属性会激活失败。
    // 详见 client.js 里 safeService 的说明与 README 第九节第 5 条。
    get(name) {
      if (typeof name !== 'string') return undefined;
      // 记录每一次服务读取，便于断言「代码只读它该读的」。
      // 真 ctx 对未提供/未声明的服务会抛错，所以这里记录而不抛，
      // 让测试可以明确断言「没有意外读取」而不是整条用例失败。
      serviceReads.push(name);
      return services[name];
    },
  };
  // 服务表：默认提供右侧栏服务；传 withoutSidebarRight 可模拟服务缺失
  const services = {};
  if (options.withoutSidebarRight !== true) {
    services.sidebarRightTabs = {
      register(definition) {
        tabTypes.push(definition);
        return () => {};
      },
    };
    services.sidebarRight = {
      openTab(kind) {
        if (options.openTabThrows === true) throw new Error('no session');
        openedKinds.push(kind);
      },
    };
  }
  half.apply(ctx);
  return { half, registrations, tabTypes, openedKinds, logs, ctx, serviceReads, injectedStyles, document: context.document };
}

function statefulClient() {
 const cells=[];let cursor=0;const base=createFakeReact();
 const react={...base,useState(initial){const i=cursor++;if(!cells[i])cells[i]={value:typeof initial==='function'?initial():initial};return [cells[i].value,v=>{cells[i].value=typeof v==='function'?v(cells[i].value):v;}];},
 useRef(v){const i=cursor++;if(!cells[i])cells[i]={current:v};return cells[i];},useCallback(fn){cursor++;return fn;}};
 const loaded=loadClient({react});return {...loaded,begin(){cursor=0;},flat(tree){const out=[];function walk(n){if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;out.push(n);(n.children||[]).forEach(walk);}walk(tree);return out;}};
}
function renderFullKnowledge(docs,view,memory={}) {
 const probe=statefulClient(),lib=probe.half.DESCRIPTORS.internals;lib.readKnowledgeUi(memory);probe.begin();const tree=lib.knowledgeTab({docs,initialView:view});
 const button=probe.flat(tree).find(n=>n.type==='button'&&(n.children.includes('展开完整导图')||n.children.includes('展开完整目录')));
 assert.ok(button);button.props.onClick();probe.begin();return createFakeServer().renderToStaticMarkup({__el:true,type:lib.knowledgeTab,props:{docs,initialView:view},children:[]});
}

test('client.js：模块注册 id 正确、只 require react', () => {
  const { half } = loadClient();
  // 跨 realm 的数组不能直接 deepEqual（原型不同），先转成本地数组
  assert.deepEqual([...half.inject], ['slots'], '客户端半边必须声明 inject: ["slots"]');
  assert.equal(typeof half.apply, 'function');
});

test('宿主 Config：在 cordis resolveConfig 的真实读取路径上可用', async () => {
  const host = await import('../index.js');

  // 逐字复制 cordis/lib/index.js 的 resolveConfig 逻辑（956-962 行）。
  // 这一步是必须的：只有走一遍 cordis 真正用的那条路径，才能证明
  // Config 的形状没写错。此前正是因为把 Config 写成了纯 JSON Schema
  // （没有 ~standard），导致插件在宿主里激活失败（fiberPhase: failed）。
  function resolveConfig(runtime, config) {
    if (!runtime.Config) return config;
    const result = runtime.Config['~standard'].validate(config);
    if ('then' in result) throw new TypeError('Async config validation is not supported');
    if (result.issues) throw new Error(`invalid config: ${JSON.stringify(result.issues)}`);
    return result.value;
  }
  const runtime = { Config: host.Config, apply: host.apply };

  // 挂载时不传 config
  const fromNothing = resolveConfig(runtime, undefined);
  assert.equal(fromNothing.backupKeep, 10);
  assert.ok(fromNothing.dataDir.length > 0);

  // cordis.patch.yml 里写的配置
  const fromPatch = resolveConfig(runtime, { dataDir: '学习台', locale: 'zh', gpaMode: '4.0-weighted', backupKeep: 10 });
  assert.equal(fromPatch.dataDir, '学习台');
  assert.equal(fromPatch.backupKeep, 10);

  // 非法配置必须抛出可读错误，而不是静默通过
  assert.throws(() => resolveConfig(runtime, { backupKeep: -1 }), /invalid config/);
  assert.throws(() => resolveConfig(runtime, { 未知项: 1 }), /invalid config/);
});

test('宿主与客户端半边的 inject 列表保持一致', async () => {
  const host = await import('../index.js');
  const { half } = loadClient();
  const clientInject = [...half.inject].map((name) => name.replace(/^remote\./, ''));
  const hostInject = [...host.inject];
  // 宿主依赖 tools / webServer；客户端只依赖 slots。
  // 两边声明不同是正常的，但任何一边都不允许出现重复项。
  assert.equal(new Set(clientInject).size, clientInject.length, '客户端 inject 不应有重复项');
  assert.equal(new Set(hostInject).size, hostInject.length, '宿主 inject 不应有重复项');
  assert.ok(hostInject.includes('tools'), '宿主必须声明 tools');
  assert.ok(hostInject.includes('webServer'), '宿主必须声明 webServer');
});

test('宿主 index.js：导出形式正确、Config 符合 Standard Schema', async () => {
  const host = await import('../index.js');
  assert.equal(typeof host.apply, 'function', '必须导出 apply(ctx, config)');
  assert.equal(host.name, 'study-assistant');
  assert.ok(host.inject.includes('tools') && host.inject.includes('webServer'));

  // cordis 通过 Config["~standard"].validate() 同步校验配置
  const standard = host.Config['~standard'];
  assert.ok(standard, 'Config 必须实现 Standard Schema（~standard）');
  assert.equal(typeof standard.validate, 'function');
  assert.equal(standard.version, 1);
  assert.equal(typeof standard.vendor, 'string');

  // 空配置应补上默认值
  const empty = standard.validate(undefined);
  assert.ok(!('issues' in empty), `空配置不应报错：${JSON.stringify(empty)}`);
  assert.equal(empty.value.backupKeep, 10);
  assert.ok(empty.value.dataDir.length > 0, 'dataDir 应有默认值');

  // 非法配置应返回 issues 而不是抛异常
  const badType = standard.validate({ dataDir: 123 });
  assert.ok(Array.isArray(badType.issues), 'dataDir 类型错误应报 issues');
  const unknownKey = standard.validate({ 拼错的项: true });
  assert.ok(Array.isArray(unknownKey.issues), '未知配置项应报 issues');
  const badKeep = standard.validate({ backupKeep: -3 });
  assert.ok(Array.isArray(badKeep.issues), '负数 backupKeep 应报 issues');

  // 合法配置通过，缺失项补默认值
  const good = standard.validate({ dataDir: 'D:\\tmp\\x', backupKeep: 5 });
  assert.deepEqual(good.value, {
    dataDir: 'D:\\tmp\\x',
    backupKeep: 5,
    locale: 'zh',
    gpaMode: '4.0-weighted',
    studentName: '示例同学',
    studentNameVariants: '',
    // 学号与录像目录默认留空 = 对应功能不启用（换台机器不会乱扫别人的文件）
    studentId: '',
    workspaceRoot: '',
    recordingDir: '',
  });
  assert.equal(standard.validate({ studentName: '   ' }).issues.length, 1, '空姓名应报 issues');
  assert.equal(standard.validate({ studentId: '' }).value.studentId, '', '空学号 = 关闭归档扫描，合法');
  assert.equal(standard.validate({ studentId: 7 }).issues.length, 1, 'studentId 必须是字符串');
  assert.equal(standard.validate({ studentNameVariants: 7 }).issues.length, 1, 'studentNameVariants 必须是字符串');
  assert.equal(standard.validate({ workspaceRoot: 7 }).issues.length, 1, 'workspaceRoot 必须是字符串');
  assert.equal(standard.validate({ recordingDir: 7 }).issues.length, 1, 'recordingDir 必须是字符串');
  assert.equal(standard.validate({ studentName: '李雷' }).value.studentName, '李雷');
  assert.equal(
    standard.validate({ studentNameVariants: '李雷雷、雷子' }).value.studentNameVariants,
    '李雷雷、雷子',
  );
  // 这一项和别处相反：**显式写空串 = 关掉录音导入**（也是默认值）
  assert.equal(standard.validate({ recordingDir: '' }).value.recordingDir, '', '空串应能关掉录音导入');
  assert.equal(standard.validate({ recordingDir: 'E:\\录像' }).value.recordingDir, 'E:\\录像');

  // 枚举项限值
  assert.ok(Array.isArray(standard.validate({ locale: 'fr' }).issues), '不在枚举内的 locale 应报 issues');
  assert.ok(Array.isArray(standard.validate({ gpaMode: '6.0' }).issues), '不在枚举内的 gpaMode 应报 issues');
  assert.equal(standard.validate({ locale: 'en' }).value.locale, 'en');

  // patch 里写的配置必须整体合法（此前漏了 locale/gpaMode 导致激活失败）
  const fromPatch = standard.validate({ dataDir: '学习台', locale: 'zh', gpaMode: '4.0-weighted', backupKeep: 10 });
  assert.ok(!('issues' in fromPatch), `cordis.patch.yml 的配置必须合法：${JSON.stringify(fromPatch)}`);
});

/**
 * 当前 client.js 处于哪个上线阶段。
 *
 * 第 1 阶段（空骨架）：不注册任何槽位，用来**单独**验证宿主半边不会让应用起不来。
 * 第 2 阶段（完整）：注册四个界面落点。
 *
 * 槽位相关的断言只在第 2 阶段有意义；阶段 1 下明确跳过而不是假装失败，
 * 这样「75 项全绿」这个数字不会因为阶段切换而失真。
 */
function clientPhase() {
  const { half } = loadClient();
  const phase = half.DESCRIPTORS?.phase;
  return typeof phase === 'number' ? phase : 2;
}
const PHASE = clientPhase();
const isPhase1 = PHASE === 1;

test('client.js：主面板、侧栏图标、会话内嵌三个落点都注册，且 id/key 符合宿主契约', { skip: isPhase1 ? '第 1 阶段空骨架，不注册槽位' : false }, () => {
  const { registrations } = loadClient();
  const bySlot = new Map(registrations.map((entry) => [entry.options.name, entry]));

  // 1) 侧栏图标：id 必须与 main 面板的 key 相同，侧栏才能自动寻址
  const icon = bySlot.get('sidebar.panellist');
  assert.ok(icon, '缺少 sidebar.panellist 注册');
  assert.equal(icon.options.id, 'study-assistant');
  assert.equal(typeof icon.options.order, 'number');
  assert.equal(typeof icon.options.label, 'function', 'label 应为 thunk 以便跟随 locale');
  assert.equal(icon.options.label(), '学习辅助');

  // 2) 主面板：key 必须与图标 id 相同
  const main = bySlot.get('main');
  assert.ok(main, '缺少 main 注册');
  assert.equal(main.options.key, icon.options.id, 'main 的 key 必须等于 sidebar.panellist 的 id');
  assert.equal(typeof main.options.inject, 'function', '主面板应注入 openDetail');
  assert.equal(typeof main.options.inject().openDetail, 'function');

  // 3) 会话内嵌
  const dock = bySlot.get('conversation.composer.dock');
  assert.ok(dock, '缺少 conversation.composer.dock 注册');
  assert.equal(dock.options.id, 'study-due');
});

test('右侧栏契约：标签类型必须注册，且渲染体的 key 必须等于标签类型的 id', { skip: isPhase1 ? '第 1 阶段空骨架，不注册槽位' : false }, () => {
  const { registrations, tabTypes } = loadClient();

  // 这是之前真实踩过的坑：只注册了渲染体、没注册标签类型，
  // 宿主会显示「nothing can view this」，这一格永远不可达。
  assert.equal(tabTypes.length, 1, '必须向 sidebarRightTabs 注册恰好一个标签类型');
  const definition = tabTypes[0];
  assert.equal(typeof definition.id, 'string');
  assert.ok(definition.id.length > 0);
  assert.equal(typeof definition.kind, 'string');
  assert.ok(definition.kind.length > 0);
  assert.equal(typeof definition.title, 'function', 'title 应为可调用的 thunk');
  assert.equal(typeof definition.title(), 'string');
  assert.ok(['builtin', 'extension', 'user'].includes(definition.priority), `priority 取值可疑：${definition.priority}`);

  // 槽位的 key 必须用标签类型的 id（而不是 kind）
  for (const slotName of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    const entry = registrations.find((r) => r.options.name === slotName);
    assert.ok(entry, `缺少 ${slotName} 注册`);
    assert.equal(entry.options.key, definition.id, `${slotName} 的 key 必须等于标签类型的 id`);
  }

  // 面板与详情槽位的划分必须与描述符一致
  const half = loadClient().half;
  assert.deepEqual([...half.DESCRIPTORS.detailSlots], ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  assert.equal(half.DESCRIPTORS.detailTabDefinition.id, definition.id);
  assert.equal(half.DESCRIPTORS.detailTabDefinition.kind, definition.kind);
});

test('右侧栏打开入口：用正确的 kind 调用 openTab，且无服务/无会话时不抛错', { skip: isPhase1 ? '第 1 阶段空骨架，不注册 openDetail' : false }, () => {
  // 正常情况：应传 kind，不是 id
  const normal = loadClient();
  assert.equal(normal.openedKinds.length, 0, 'apply 阶段不应自动打开标签页');
  assert.equal(normal.half.DESCRIPTORS.openDetailTab(normal.ctx), true);
  assert.deepEqual(normal.openedKinds, [normal.half.DESCRIPTORS.detailTabKind]);

  // openTab 抛错（空白会话没有会话上下文）时必须被吞掉，返回 false
  const throwing = loadClient({ openTabThrows: true });
  assert.equal(throwing.half.DESCRIPTORS.openDetailTab(throwing.ctx), false);

  // 服务缺失时不能抛错，也不能阻止其它槽位注册
  const absent = loadClient({ withoutSidebarRight: true });
  assert.equal(absent.half.DESCRIPTORS.openDetailTab(absent.ctx), false);
  assert.ok(absent.registrations.some((r) => r.options.name === 'main'), '缺服务时主面板仍应注册');
  assert.ok(absent.logs.some((line) => line.includes('sidebarRightTabs')), '应记录一条跳过说明');
  assert.equal(absent.tabTypes.length, 0);

  // 无参调用也不能崩
  assert.equal(loadClient().half.DESCRIPTORS.openDetailTab(undefined), false);
});

test('服务读取契约：只通过 ctx.get() 读可选服务，且只读该读的', { skip: isPhase1 ? '第 1 阶段空骨架，不读任何服务' : false }, () => {
  const { serviceReads } = loadClient();
  // 允许的服务清单 —— 新增服务读取时必须同步这里，强迫作者想清楚
  const allowed = new Set(['sidebarRightTabs', 'sidebarRight']);
  const unexpected = serviceReads.filter((name) => !allowed.has(name));
  assert.deepEqual(unexpected, [], `读取了未预期的服务：${unexpected.join(', ')}`);
  assert.ok(serviceReads.includes('sidebarRightTabs'), 'apply 阶段应读取 sidebarRightTabs');
});

test('根因回归：任何一份客户端源码都不得直接点读可选服务属性', () => {
  // 这条守的是真实事故：写成 `ctx.sidebarRightTabs` 时，真 cordis 的 ctx 代理会抛
  // `cannot get property "sidebarRightTabs" without inject`，把 fiber 置为 FAILED，
  // 渲染进程报 `web boot: 1 entry did not activate`。
  // 假 ctx 不会抛，所以必须用静态检查把这种写法挡在提交之前。
  //
  // **两份文件都要查**：分阶段上线时 client.js 可能是空骨架，
  // 但 client.full.js（第 2 阶段要用的完整实现）必须始终满足契约 —— 否则
  // 骨架阶段"全绿"会掩盖完整版里的问题。
  const targets = [
    { label: 'client.js', file: CLIENT_FILE },
    { label: 'client.full.js', file: path.join(path.dirname(CLIENT_FILE), 'client.full.js') },
  ].filter((t) => fs.existsSync(t.file));

  assert.ok(targets.length >= 1, '至少要能读到一份客户端源码');

  for (const { label, file } of targets) {
    const raw = fs.readFileSync(file, 'utf8');
    // 只剥注释（保留字符串字面量）：注释里会写到被禁止的写法本身，会误报。
    // 现有代码里没有字符串含 `ctx.sidebarRight*`，所以不必剥字符串。
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

    for (const name of ['sidebarRightTabs', 'sidebarRight']) {
      const directRead = new RegExp(`ctx\\??\\.${name}\\b`);
      assert.equal(directRead.test(code), false,
        `${label} 的代码里不得直接点读 ctx.${name}；请用 safeService(ctx, '${name}')`);
    }
    // 只有真正读取可选服务的版本才需要 safeService（空骨架不读任何服务）
    const readsOptionalService = code.includes('sidebarRightTabs');
    if (readsOptionalService) {
      assert.match(code, /typeof ctx\.get\s*[!=]==?\s*'function'/,
        `${label} 的 safeService 必须显式检查 ctx.get 是否为函数`);
      assert.match(code, /ctx\.get\(name\)/, `${label} 的 safeService 必须通过 ctx.get(name) 读取服务`);
    }
  }
});

test('MainPanel 必须接受 usePanelInfo 并传入 selector（否则渲染期 TypeError）', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const { registrations } = loadClient();
  const main = registrations.find((r) => r.options.name === 'main');
  const { renderToStaticMarkup } = createFakeServer();

  // 真实的 usePanelInfo 绑定到 useSyncExternalStoreWithSelector，
  // 其实现**无条件调用传入的 selector**：不传 selector 时首帧渲染即 TypeError。
  const seenSelectors = [];
  const usePanelInfo = (selector) => {
    seenSelectors.push(selector);
    if (typeof selector !== 'function') throw new TypeError('selector is not a function');
    return selector({ activePanelId: 'study-assistant' });
  };

  let html = null;
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup({
      __el: true,
      type: main.component,
      props: { usePanelInfo, panelInfo: { activePanelId: 'study-assistant' } },
      children: [],
    });
  }, '带 usePanelInfo 时主面板渲染不得抛错');

  assert.equal(seenSelectors.length, 1, 'usePanelInfo 必须恰好调用一次（hook 顺序恒定）');
  assert.equal(typeof seenSelectors[0], 'function', '必须传入 selector');
  assert.ok(html.includes('大学生学习辅助系统'));

  // 没有 usePanelInfo 的宿主形态也不能崩（走兜底实现）
  assert.doesNotThrow(() => {
    renderToStaticMarkup({
      __el: true,
      type: main.component,
      props: { panelInfo: { activePanelId: 'conversation' } },
      children: [],
    });
  }, '缺少 usePanelInfo 时主面板渲染不得抛错');
});

test('main 条目必须自带错误边界：渲染崩溃时把原因画出来，而不是留一片空白', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const { registrations } = loadClient();
  const main = registrations.find((r) => r.options.name === 'main');
  const { renderToStaticMarkup } = createFakeServer();

  // 让面板内部抛出：真实的槽位渲染器只会把这一格退化成
  // `<div data-slot-error="main">` 空壳（界面上就是「点了没反应」），
  // 原因只出现在控制台里。自带边界必须把它变成可读文字。
  const explodingPanelInfo = () => {
    throw new Error('模拟面板内部崩溃');
  };

  let html = '';
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup({
      __el: true,
      type: main.component,
      props: { usePanelInfo: explodingPanelInfo, panelInfo: { activePanelId: 'study-assistant' } },
      children: [],
    });
  }, '崩溃必须被条目自带的错误边界接住，不能冒泡成空壳');

  assert.ok(html.includes('面板渲染失败'), `崩溃原因必须出现在画面上，实际输出：${html.slice(0, 300)}`);
  assert.ok(html.includes('模拟面板内部崩溃'), '必须带上原始错误信息，便于无 DevTools 时定位');
});

test('面板根元素必须带 data-sa-panel 标记，且 .sa-root 必须有层级声明', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const css = fs.readFileSync(CLIENT_FILE, 'utf8');

  // 用户探针 m02223 的教训：`document.querySelector('.sa-root')` 命中了
  // 一个被渲染进 main 槽的 <style> 节点（style 也能带 class，而且被 flex
  // 拉伸成 1152×928），于是「面板根节点」的测量一直指向错误对象。
  // 给真正的主面板容器加一个不可能是 style 的标记，探针才能可靠区分。
  const markerCount = (css.match(/data-sa-panel/g) ?? []).length;
  assert.ok(markerCount >= 5, `每个 .sa-root 渲染分支都要带 data-sa-panel 标记，实际 ${markerCount} 处`);

  // 绝不能把 style 节点当 JSX 子节点渲染：它会成为主面板列的直接子元素参与布局。
  assert.equal(/return\s+h\('style'/.test(css), false, 'style 节点不得渲染进槽位，必须注入 document.head');

  // 主面板是列里的非定位块级元素，需要自己建立层级，
  // 否则主题皮肤的立绘层（position:absolute + z-index:0）会与它互压。
  const root = /\.sa-root\{([^}]*)\}/.exec(css);
  assert.ok(root !== null, '必须存在 .sa-root 规则');
  assert.match(root[1], /position:relative/, '.sa-root 必须 position:relative');
  assert.match(root[1], /z-index:1/, '.sa-root 必须 z-index:1，抬到皮肤装饰层之上');
  assert.match(root[1], /isolation:isolate/, '.sa-root 必须 isolation:isolate，隔离皮肤的外层混合');
});

test('样式表必须注入 document.head 且只注入一次', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const { registrations, injectedStyles } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();

  // 每个注册组件都渲染一遍（会多次触发 Style 组件）。
  for (const registration of registrations) {
    assert.doesNotThrow(() => {
      renderToStaticMarkup({
        __el: true,
        type: registration.component,
        props: {
          usePanelInfo: (selector) => (typeof selector === 'function' ? selector({ activePanelId: 'study-assistant' }) : { activePanelId: 'study-assistant' }),
          courses: [], tasks: [], terms: [], grades: [],
        },
        children: [],
      });
    }, `${registration.options.name} 组件渲染抛错`);
  }

  assert.equal(injectedStyles.length, 1, `样式表应当只注入一次，实际 ${injectedStyles.length} 次`);
  const style = injectedStyles[0];
  assert.equal(style.tagName, 'STYLE');
  assert.equal(style.attributes['data-study-assistant'], '');
  assert.ok(style.textContent.includes('.sa-root'), '注入的样式表必须含 .sa-root 规则');
});

test('样式表按 DSH 3 约定声明归属，被模块系统回收后能自愈重注入', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const { registrations, injectedStyles, document: doc } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();
  const renderAll = () => {
    for (const registration of registrations) {
      renderToStaticMarkup({
        __el: true,
        type: registration.component,
        props: {
          usePanelInfo: (selector) => (typeof selector === 'function' ? selector({ activePanelId: 'study-assistant' }) : { activePanelId: 'study-assistant' }),
          courses: [], tasks: [], terms: [], grades: [],
        },
        children: [],
      });
    }
  };

  renderAll();
  assert.equal(injectedStyles.length, 1, '首次渲染应当只注入一张样式表');
  const style = injectedStyles[0];

  // DSH 3 的 dsh-client-modules.materialize() → claimStyles(id) 会把文档里
  // **所有还没有 data-plugin 的 <style>** 认领给正在物化的那个插件，然后
  // removeOwnedStyles(id) 在条目被替换/回收时把它们删掉。预先声明归属就不会被抢。
  assert.equal(style.attributes['data-plugin'], 'dsh-study-assistant', '必须预先声明 data-plugin 归属');
  assert.equal(style.attributes['data-plugin-css'], 'dsh-study-assistant/Style', '必须带 data-plugin-css 清单键');
  const claimable = injectedStyles.filter((el) => el.attributes['data-plugin'] === undefined);
  assert.equal(claimable.length, 0, '不能留下会被别的插件认领走的无主样式表');

  // 模拟 removeOwnedStyles('dsh-study-assistant')：条目换代时样式表被删除。
  doc.head.removeChild(style);
  assert.equal(injectedStyles.length, 0, '前置条件：样式表已被模块系统回收');

  renderAll();
  assert.equal(injectedStyles.length, 1, '样式表被回收后，重新渲染必须重新注入（否则面板永久裸奔）');
  assert.ok(injectedStyles[0].textContent.includes('.sa-root'), '重新注入的样式表必须含 .sa-root 规则');
});

test('client.js：每个注册的组件都能渲染出内容而不抛错', { skip: isPhase1 ? '第 1 阶段空骨架，无组件' : false }, () => {
  const { registrations } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();
  // 覆盖两种 owner props：带 hooks 的（面板）与只给数字的（图标）
  const propsVariants = [
    { size: 18, active: true, panelInfo: { activePanelId: 'study-assistant' }, usePanelInfo: () => ({ activePanelId: 'study-assistant' }) },
    { size: 16, active: false, panelInfo: { activePanelId: 'conversation' }, usePanelInfo: () => ({ activePanelId: 'conversation' }) },
    {},
  ];

  for (const { options, component } of registrations) {
    let rendered = null;
    for (const props of propsVariants) {
      // 组件在「加载中」状态下渲染，此时不会发起真实请求
      rendered = renderToStaticMarkup({ __el: true, type: component, props, children: [] });
    }
    assert.equal(typeof rendered, 'string', `${options.name} 的渲染结果应为字符串`);
  }
});

test('client.js：主面板在加载中状态给出可读文案，不出现 undefined', { skip: isPhase1 ? '第 1 阶段空骨架，无主面板组件' : false }, () => {
  const { registrations } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();
  const main = registrations.find((entry) => entry.options.name === 'main');
  const html = renderToStaticMarkup({
    __el: true,
    type: main.component,
    props: { panelInfo: { activePanelId: 'study-assistant' }, usePanelInfo: () => ({ activePanelId: 'study-assistant' }) },
    children: [],
  });
  assert.ok(html.includes('正在读取学习台数据'), `加载态应显示提示文案，实际：${html.slice(0, 200)}`);
  assert.ok(html.includes('大学生学习辅助系统'), '应显示面板标题');
  assert.ok(!html.includes('undefined'), '不应把 undefined 渲染进界面');
});

test('client.js：侧栏图标在选中/未选中两种状态下都渲染 svg', { skip: isPhase1 ? '第 1 阶段空骨架，无图标组件' : false }, () => {
  const { registrations } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();
  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  for (const active of [true, false]) {
    const html = renderToStaticMarkup({ __el: true, type: icon.component, props: { size: 20, active }, children: [] });
    assert.equal(html.includes('svg') || html.length > 0, true);
  }
});

test('client.js：资料页把索引/题目/知识点都渲染出来，空数据给空态而不是空白', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const { renderToStaticMarkup } = createFakeServer();
  assert.equal(typeof internals.materialsTab, 'function', 'client 必须把资料页交给测试');
  assert.equal(typeof internals.knowledgeTab, 'function', 'client 必须把知识点页（独立第七页签）交给测试');
  assert.equal(typeof internals.materialText, 'function', 'client 必须有取资料正文的 helper');

  const docs = {
    // 课程表也参与渲染（课程名与筛选下拉），这里只给一门课。
    courses: { courses: [{ id: 'c_dg', name: '数字电子技术基础', aliases: ['数电'] }] },
    materials: {
      files: [
        {
          path: '数电/作业/第01次作业_原题.pdf',
          courseId: 'c_dg',
          kind: 'homework',
          textLayer: false,
          text: null,
          ocr: { done: true, pages: 3, donePages: [1, 2], outDir: '数电/作业/第01次作业_OCR文本' },
        },
        {
          path: '数电/教材/第01章.pdf',
          courseId: 'c_dg',
          kind: 'material',
          textLayer: true,
          ocr: null,
          text: { done: true, chars: 13, outFile: '数电/教材/_TEXT/第01章.md' },
        },
      ],
    },
    questions: {
      questions: [
        { no: '1', prompt: '求图示电路的节点电压', courseId: 'c_dg', sourceFile: '第01次作业_原题.pdf', page: 2, knowledgeNames: ['节点电压法'] },
      ],
    },
    knowledgeCandidates: {
      candidates: [{ name: '节点电压法', courseId: 'c_dg', chapter: '第 2 章', evidence: [{ type: 'question', id: 'q1' }, { type: 'ocr', file: 'a.md', page: 2, quote: '节点电压法' }] }],
    },
    // 知识网络（2026-10-20 夜里）：知识点段画的是这张图，候选只做计数
    knowledgeNetwork: {
      nodes: [
        { id: 'k1', name: '节点电压法', courseId: 'c_dg', chapter: '第 2 章', section: '2.3', mastery: 2, marked: true, reviewedAt: '2026-10-20T12:00:00.000Z', evidence: [{ type: 'question', id: 'q1' }] },
        { id: 'k2', name: '戴维南等效', courseId: 'c_dg', chapter: '第 4 章', section: '4.1', mastery: 0, marked: false, evidence: [] },
      ],
    },
  };

  const render = (view, data = docs) => renderToStaticMarkup({ __el: true, type: internals.materialsTab, props: { docs: data, view }, children: [] });
  // 知识点从「资料」页抽成独立页签后，它自己就是一段界面
  const renderKnowledge = (data = docs) => renderFullKnowledge(data, 'tree', internals.readKnowledgeUi());

  // 数据被外部改坏（nodes 里有 null / 非对象）不能让整页白屏：2026-10-23 凌晨真实数据探针抓到过
  const broken = renderKnowledge({
    ...docs,
    knowledgeNetwork: { nodes: [null, {}, { id: 'k_bad', evidence: [{ type: 'question', id: 'q404' }] }] },
  });
  assert.ok(broken.length > 0, '坏节点也要能渲染出页面');
  assert.ok(!broken.includes('undefined'), '坏节点渲染不能漏出 undefined');

  // 资料：路径、课程名、取字进度都要出现，且不出现 undefined
  const files = render('files');
  assert.ok(files.includes('数电/作业/第01次作业_原题.pdf'), '资料行应显示 path');
  assert.ok(files.includes('数字电子技术基础'), '资料行应显示课程名');
  assert.ok(files.includes('2/3 页'), '扫描件应显示已取页数/总页数');
  assert.ok(files.includes('文字层'), '有文字层的资料应标出来');
  assert.ok(files.includes('未取字') === false, '不该把有产物的资料标成未取字');
  assert.ok(!files.includes('undefined'), `资料页不应渲染出 undefined：${files.slice(0, 300)}`);

  // 题目
  const questions = render('questions');
  assert.ok(questions.includes('求图示电路的节点电压'), '题目行应显示题干');
  assert.ok(questions.includes('节点电压法'), '题目行应显示知识点');
  assert.ok(questions.includes('第 2 页'), '题目行应显示来源页');

  // 知识点（独立第七页签）：默认是「树」，图上画的是知识网络（节点 → 章 → 课程），不是候选清单
  const knowledge = renderKnowledge();
  // 批2：树是主视图——学科 → 章 → 节 → 知识点（现在 section 为空，节点直接挂章下）
  assert.ok(knowledge.includes('目录树 · '), '知识点页默认进「树」视图');
  assert.ok(knowledge.includes('数字电子技术基础'), '树第一层是学科名');
  assert.ok(knowledge.includes('▸') || knowledge.includes('▾'), '树的分支要有开合箭头');
  assert.ok(knowledge.includes('全部展开') && knowledge.includes('全部收起'), '树要有整棵展开/收起');
  assert.ok(knowledge.includes('打印树'), '树要有「先展开再打印」的出口（折叠状态直接打印只剩学科名）');
  // 树默认全收起 ⇒ 章名/节点名不该先蹦出来（点开才看得到），这条防「树其实是把列表硬塞进去」
  assert.ok(knowledge.includes('第 2 章'), '单学科目录树首次展示学科与章');
  const knowledgeTreeOpen = renderToStaticMarkup({
    __el: true, type: internals.knowledgeTab, props: { docs, initialView: 'list' }, children: [],
  });
  assert.ok(knowledgeTreeOpen.includes('第 2 章'), '列表视图仍按章分组');
  const knowledgeGraph = renderToStaticMarkup({
    __el: true, type: internals.knowledgeTab, props: { docs, initialView: 'graph' }, children: [],
  });
  assert.ok(knowledgeGraph.includes('<svg'), '「图」视图必须真的画图');
  // 搜索命中高亮（2026-10-22 深夜）：有关键词时树自动展开，命中处包 <b>
  internals.readKnowledgeUi({ query: '第 2 章' });
  const knowledgeSearch = renderKnowledge();
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.ok(knowledgeSearch.includes('<b>'), '搜索命中要把命中处加粗，否则「筛出来了但看不出为什么」');
  assert.ok(knowledgeSearch.includes('第 2 章'), '有关键词时树自动展开到命中层');
  assert.ok(knowledgeSearch.includes('清空筛选'), '有关键词时给一个「清空筛选」的出口');
  assert.ok(knowledgeGraph.includes('节点电压法'), '图上应有节点名');
  assert.ok(knowledgeGraph.includes('戴维南等效'), '第二个节点也要画出来');
  assert.ok(knowledgeGraph.includes('第 2 章') && knowledgeGraph.includes('第 4 章'), '章要作为中间层出现');
  assert.ok(knowledgeGraph.includes('★'), '标了重点的节点要有星号');
  assert.ok(knowledgeGraph.includes('点节点看详情'), '要提示怎么操作');
  assert.ok(knowledgeGraph.includes('节点 2'), '抬头应显示节点数');
  // 复习可用性（2026-10-21）：工具条、待复习卡、批量标记都要在知识页出现
  assert.ok(knowledge.includes('命中 '), '知识页要显示「命中 N / M」计数');
  assert.ok(knowledge.includes('待复习'), '知识页要有待复习队列');
  assert.ok(knowledge.includes('批量：把当前命中的'), '命中多个节点时要给批量标记');
  assert.ok(knowledge.includes('批量归位'), '命中多个节点时也要能批量归位（没归到节的点一次归一层）');
  assert.ok(knowledge.includes('归位这 '), '批量归位的按钮要写明会改几个');
  assert.ok(knowledge.includes('批量归位：把命中的这些知识点一起归到这同一层'), '批量归位要写清「改哪些」');
  // 体检（2026-10-23 凌晨）：数字摆在工具条上，不用开终端
  assert.ok(knowledge.includes('体检：'), '知识页要显示体检数字');
  assert.ok(knowledge.includes('章号对不上 ') && knowledge.includes('题目找不到 '), '体检要分开数章号对不上与题目找不到');
  assert.ok(knowledge.includes('有问题'), '要有「有问题」这一档筛选');
  // 详解覆盖（2026-10-24 傍晚）：工具条上要看得出「68 个里写了几个详解」，并能筛出没写的
  assert.ok(knowledge.includes('详解：'), '工具条要有一行「详解：X / Y」');
  assert.ok(knowledge.includes('没详解'), '要有「没详解」这一档筛选');
  // 跳转后要能看见自己在哪（2026-10-24 傍晚）：选中行带 id，切页签/筛选后平滑滚到中间
  const scrollSource = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(scrollSource.includes("id: selected === node.id ? 'sa-kp-selected' : undefined"), '选中的行要带 id');
  assert.ok(scrollSource.includes("target.scrollIntoView({ block: kpView === 'graph' ? 'start' : 'center', behavior: reduced ? 'auto' : 'smooth' })"), '要真的滚过去');
  assert.ok(scrollSource.includes("typeof document === 'undefined'"), '烟测/静态渲染环境没有 document，要有守卫');
  // 整批同值动作（2026-10-23 凌晨）：★ 与打卡，都不碰掌握度
  assert.ok(knowledge.includes('全标★') && knowledge.includes('取消★'), '批量要能整片标/取消重点');
  assert.ok(knowledge.includes('都打卡'), '批量要能整片记「今天复习过」');
  assert.ok(knowledge.includes('不改掌握度'), '打卡不能顺手改掌握度，文案里要讲明');
  // 批量上限（2026-10-23 凌晨）：服务端超过 500 条直接 400 too-many-items，面板要先拦一道
  const clientSource = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(clientSource.includes('const BATCH_LIMIT = 500;'), '面板要和服务端同一个批量上限');
  assert.ok(clientSource.includes('一次最多改 '), '命中的节点超限时要说人话，而不是把错误码甩给用户');

  assert.ok(knowledge.includes('列表'), '要能在图和列表之间切换');
  assert.ok(knowledge.includes('讲解'), '要能切到「讲解」视图看已生成的讲解');
  // 思维导图（2026-10-23 夜，A 块）：真导图视图 + 掌握度的符号/颜色图例
  assert.ok(knowledge.includes('导图'), '工具条要有「导图」视图（真思维导图）');
  assert.ok(knowledge.includes('掌握度：'), '工具条要给掌握度的图例');
  // 掌握度多选（2026-10-24）：图例变成可点的筛选，勾了档位才出现「四档都要」这个复位出口
  assert.ok(knowledge.includes('未学 ') && knowledge.includes('精通 '), '每档都要带「符号 + 标签 + 个数」');
  assert.ok(!knowledge.includes('四档都要'), '没勾任何档位时不显示复位按钮');
  internals.readKnowledgeUi({ masteryLevels: [0] });
  const knowledgeMastery = renderKnowledge();
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.ok(knowledgeMastery.includes('四档都要'), '勾了掌握度档位后要给「四档都要」的复位出口');
  assert.ok(knowledgeMastery.includes('（只看 1 档）'), '要说明当前只看了几档');
  assert.ok(knowledgeMastery.includes('清空筛选'), '掌握度筛选也算「有筛选」，要给清空出口');
  assert.ok(internals.MASTERY_STYLE.length === 4, '掌握度四档编码不能少');
  for (const item of internals.MASTERY_STYLE) {
    assert.ok(typeof item.symbol === 'string' && item.symbol.length > 0, `每档掌握度都要有符号：${item.label}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(item.color), `每档掌握度都要有颜色：${item.label}`);
  }
  const knowledgeMind = renderFullKnowledge(docs, 'mind', internals.readKnowledgeUi());
  assert.ok(knowledgeMind.includes('<svg'), '「导图」视图必须真的画 svg');
  // 第三刀：默认展开「有未学（mastery<2）或到期待复习」的章——k2 是未学 ⇒ 第 4 章铺开、第 2 章收着
  assert.ok(knowledgeMind.includes('已展开 0 个'), '导图默认只展开「该复习的章」，抬头按实际铺出的点数报');
  assert.ok(knowledgeMind.includes('2 章未展开'), '导图要提示还有几章没展开');
  assert.ok(!knowledgeMind.includes('全部知识点'), '单学科树不应出现全部知识点总根');
  assert.ok(knowledgeMind.includes('第 2 章') && knowledgeMind.includes('第 4 章'), '章要作为中间层出现');
  assert.ok(knowledgeMind.includes('▸') && !knowledgeMind.includes('▾'), '未展开 ▸ / 已展开 ▾ 都要出现');
  assert.ok(knowledgeMind.includes(' 个'), '章要带旗下点数');
  assert.ok(knowledgeMind.includes('全部展开') && knowledgeMind.includes('全部收起'), '导图要有整棵展开/收起');
  // 动效只能查源码：这里的假渲染器只吐标签名（不带属性），拿不到 className/pathLength。
  const mindSource = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(mindSource.includes("className: 'sa-mind-link'"), '连线要打上 sa-mind-link（画出来的动效靠它）');
  assert.ok(mindSource.includes("className: 'sa-mind-node'"), '导图节点要打上 sa-mind-node（错峰淡入靠它）');
  assert.ok(/pathLength: 1/.test(mindSource), '连线要带 pathLength=1，dashoffset 才与真实路径长度无关');
  assert.ok(mindSource.includes('@keyframes sa-draw') && mindSource.includes('@keyframes sa-pop'), '两段动效的 keyframes 要在');
  assert.ok(/prefers-reduced-motion[\s\S]{0,400}?\.sa-mind-link/.test(mindSource), '「减少动态效果」时要关掉导图动效');
  // 展开两章之后再渲一次：知识点出现、带掌握度符号
  internals.readKnowledgeUi({ treeCourseId: 'c_dg', subjectTrees: internals.patchSubjectTree({}, 'c_dg', { mindOpen: ['第 2 章', '第 4 章','mind:section:c_dg|第 2 章|2.3','mind:section:c_dg|第 4 章|4.1'] }) });
  const knowledgeMindOpen = renderFullKnowledge(docs, 'mind', internals.readKnowledgeUi());
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.ok(knowledgeMindOpen.includes('已展开 2 个'), '展开两章后要把 2 个知识点铺出来');
  assert.ok(knowledgeMindOpen.includes('▾'), '展开的章箭头要变成 ▾');
  assert.ok(knowledgeMindOpen.includes('○ ') || knowledgeMindOpen.includes('◔ ') || knowledgeMindOpen.includes('◑ ')
    || knowledgeMindOpen.includes('● '), '知识点圆点前要有掌握度符号');
  assert.ok(!knowledgeMind.includes('undefined'), `导图不该渲染出 undefined：${knowledgeMind.slice(0, 300)}`);
  assert.ok(!knowledgeMindOpen.includes('undefined'), `展开后的导图不该渲染出 undefined：${knowledgeMindOpen.slice(0, 300)}`);
  // 选中节点后的详情卡（2026-10-22 深夜）：复习打卡与改挂靠。
  // 用 readKnowledgeUi 预置「上次选中的节点」——真正的 focus 是 effect 里 setState，静态渲染跑不到 effect。
  internals.readKnowledgeUi({ selected: 'k1' });
  const knowledgeNode = renderKnowledge();
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.ok(knowledgeNode.includes('今天复习过了'), '节点卡要能给「今天复习过了」打卡（只写 reviewedAt）');
  assert.ok(knowledgeNode.includes('改位置'), '节点卡要能改这个知识点在教材里的位置（章/节/小节）');
  // 备注行内编辑（2026-10-23 凌晨）：node.note 一直有字段、一直没有入口
  assert.ok(knowledgeNode.includes('写备注'), '节点卡要能写备注（存 node.note）');
  assert.ok(clientSource.includes('const [noteDraft, setNoteDraft] = useState(null);'), '备注要有一个独立的行内编辑状态');
  assert.ok(clientSource.includes('保存备注'), '备注要有保存按钮');
  assert.ok(clientSource.includes('node?.note,'), '备注要进搜索（自己写的易错点最想搜到）');
  assert.ok(!knowledgeNode.includes('undefined'), `节点卡不该渲染出 undefined：${knowledgeNode.slice(0, 300)}`);
  // 内嵌聊天（2026-10-24）：就这个知识点提问，答案只用它的证据、不落盘
  assert.ok(knowledgeNode.includes('就问这个知识点'), '节点卡要有「就问这个知识点」的聊天框');
  assert.ok(knowledgeNode.includes('对话不存档'), '聊天要写明不存档（服务端确实不写盘）');
  assert.ok(knowledgeNode.includes('发送'), '聊天要有发送按钮');
  assert.ok(clientSource.includes('async function chatNode(nodeId, messages)'), '聊天请求要走 chatNode');
  assert.ok(clientSource.includes('${API}/knowledge/chat'), '聊天请求打到 POST /knowledge/chat');
  assert.ok(clientSource.includes('const sendChat = async () =>'), '节点卡要有发送逻辑');
  assert.ok(clientSource.includes('请回答学生最后这一问。') === false, 'prompt 拼装留在服务端，客户端不掺和');
  assert.ok(typeof internals.chatNode === 'function', 'chatNode 要导出给测试');
  assert.ok(typeof internals.chatErrorMessage === 'function', 'chatErrorMessage 要导出给测试');
  // 讲解视图（2026-10-22 深夜）：按「课程 › 章」分组 + 覆盖缺口
  const knowledgeExplain = renderToStaticMarkup({
    __el: true, type: internals.knowledgeTab, props: { docs, initialView: 'explain' }, children: [],
  });
  assert.ok(knowledgeExplain.includes('覆盖 0 个节点'), '讲解视图抬头要报覆盖了多少节点');
  assert.ok(knowledgeExplain.includes('还差 2 个没生成'), '讲解视图要提示还有多少节点没生成过');
  // 三态（2026-10-24 夜）：详解 / 只有旧讲解 / 都没有，三种要一次看全
  assert.ok(knowledgeExplain.includes('有详解 ') && knowledgeExplain.includes('只有旧讲解 '), '抬头要分开报「有详解 / 只有旧讲解」');
  assert.ok(knowledgeExplain.includes('都没有 '), '抬头要报「都没有」的个数');
  assert.ok(!knowledge.includes('undefined'), `知识网络不该渲染出 undefined：${knowledge.slice(0, 300)}`);
  // 坏数据（2026-10-23 凌晨）：courses.courses 里混 null 时也不能整页白屏。
  // 真实成因：别处的脚本写坏 JSON 时数组里会留下 null，而课程名查找直接读 item.id。
  const dirtyCourses = renderToStaticMarkup({
    __el: true,
    type: internals.knowledgeTab,
    props: { docs: { ...docs, courses: { courses: [null, { id: 'c_ds', name: '数据结构' }] } }, children: [],
    },
  });
  assert.ok(dirtyCourses.includes('数据结构'), '坏课程表里剩下的合法课程仍要渲染');
  assert.ok(!dirtyCourses.includes('undefined'), '坏课程表不该渲染出 undefined');

  // 空数据：三段各自给「等谁来填」的空态，不留空白
  const empty = {
    courses: { courses: [] },
    materials: { files: [] },
    questions: { questions: [] },
    knowledgeCandidates: { candidates: [] },
    knowledgeNetwork: { nodes: [], edges: [] },
  };
  const emptyFiles = render('files', empty);
  assert.ok(emptyFiles.includes('资料索引.json'), `空态应说明数据从哪来：${emptyFiles.slice(0, 300)}`);
  assert.ok(render('questions', empty).includes('题目.json'), '题目空态应点名 题目.json');
  assert.ok(renderKnowledge(empty).includes('知识点候选.json'), '知识网络空态应点名 知识点候选.json');
  assert.ok(renderKnowledge(empty).includes('还没有知识网络'), '空网络要说明是空的，而不是画一张空图');

  // 连 docs 都没给（宿主刚启动、state 还没回来）也不能崩
  const bare = renderToStaticMarkup({ __el: true, type: internals.materialsTab, props: {}, children: [] });
  assert.ok(typeof bare === 'string' && bare.includes('资料索引.json'), '没数据时也要渲染出空态');
  const bareKnowledge = renderToStaticMarkup({ __el: true, type: internals.knowledgeTab, props: {}, children: [] });
  assert.ok(typeof bareKnowledge === 'string' && bareKnowledge.includes('还没有知识网络'), '知识点页没数据时也要给空态');
});

test('client.js：强调按钮用描边而不是品牌色底，动效都留了「减少动态效果」的开关', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  // 用户 2026-10-21 明确说「黑底黑字的按键干脆不要」：brand-primary 底色必须去掉
  assert.ok(!/\.sa-btn\.primary\{background:var\(--dsw-alias-brand-primary\)/.test(source), '强调按钮不能再填品牌色底（系统主题下就是黑底黑字）');
  assert.ok(/\.sa-btn\.primary\{[^}]*border-color:var\(--dsw-alias-brand-primary\)/.test(source), '强调靠描边 + 加粗');
  // 动效：页签淡入、树展开上浮、转圈、进度条，并且能在系统「减少动态效果」时全关
  for (const name of ['sa-fade', 'sa-rise', 'sa-spin', 'sa-indet']) {
    assert.ok(source.includes(`@keyframes ${name}`), `缺少关键帧 ${name}`);
  }
  assert.ok(source.includes('prefers-reduced-motion'), '要有减少动态效果的开关');
  assert.ok(source.includes('.sa-spinner{'), '生成中要有转圈');
  assert.ok(source.includes('.sa-progress.indet'), '长任务要有进度条');
  // 视图切换过渡（2026-10-24）：树/导图/图/列表/讲解之间切换要重放一次淡入，
  // 且这一层也得服从「减少动态效果」。
  assert.ok(/\.sa-kp-view\{animation:sa-fade/.test(source), '视图切换要有淡入过渡，不能硬切换');
  assert.ok(/prefers-reduced-motion[\s\S]{0,400}?\.sa-kp-view/.test(source), '「减少动态效果」时也要关掉视图切换过渡');
  // 树的展开感（2026-10-24 夜）：子行按序错开淡入，别整段同时蹦出来
  assert.ok(source.includes('@keyframes sa-reveal'), '树行要有 sa-reveal 关键帧');
  assert.ok(/\.sa-kp-leaf,\.sa-tree-row\{animation:sa-reveal/.test(source), '树的行要真的挂上这个动画');
  assert.ok(source.includes('Math.min(index, 12) * 14'), '子行要按序号错开（最多 12 行，之后同时出现）');
  // 双向联动：资料 → 知识点（已有）+ 知识点 → 资料
  assert.ok(source.includes('onOpenMaterial'), '知识点页要能把「这一页」交回资料页');
  assert.ok(source.includes('去资料页看'), '资料正文卡要有跳到资料页的按钮');
  assert.ok(/const onOpenMaterial = \(path, page\) =>/.test(source), 'MainPanel 要接住这个跳转');
});

test('client.js：知识点搜索/筛选/待复习/分章是纯函数，改词改筛选都只影响命中集合', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-21T12:00:00.000Z');
  const fresh = new Date(now - DAY).toISOString();
  const stale = new Date(now - 8 * DAY).toISOString();
  const ids = (rows) => JSON.stringify(rows.map((node) => node.id));

  const nodes = [
    { id: 'a', name: '电偶极子', aliases: ['电偶极矩'], chapter: '第 12 章 静电场', section: '12.1', mastery: 1, marked: true, reviewedAt: stale },
    { id: 'b', name: '高斯定理', chapter: '第 12 章 静电场', section: '12.2', mastery: 0, marked: false, reviewedAt: fresh },
    { id: 'c', name: '刚体转动', chapter: '第 13 章', section: '13.1', mastery: 3, marked: false, reviewedAt: stale },
  ];

  // 搜索：名称、别名、章名都能命中；空词=全量；命中不到就是空
  assert.equal(typeof internals.filterKnowledgeNodes, 'function', 'client 必须把筛选函数交给测试');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { query: '偶极', now })), '["a"]', '按名称搜索');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { query: '静电场', now })), '["a","b"]', '按章名搜索');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { query: '12.2', now })), '["b"]', '按节号搜索');
  assert.equal(
    ids(internals.filterKnowledgeNodes([
      { id: 'x', name: '二分查找', chapter: '第 2 章 向量', section: '2.6', subsection: '2.6.5', mastery: 1 },
    ], { query: '2.6.5', now })),
    '["x"]',
    '按小节号搜索（2026-10-22 深夜补）',
  );
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { query: '不存在的词', now })), '[]');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { now })), '["a","b","c"]', '空查询给全量');

  // 掌握度多选（2026-10-24）：四档任意组合，空数组 = 不筛；与筛选档是「与」关系
  const masteryNodes = [
    { id: 'm0', name: '未学点', chapter: '第 1 章', mastery: 0 },
    { id: 'm1', name: '学过点', chapter: '第 1 章', mastery: 1 },
    { id: 'm2', name: '熟练点', chapter: '第 2 章', mastery: 2 },
    { id: 'm3', name: '精通点', chapter: '第 2 章', mastery: 3 },
    { id: 'm9', name: '越界点', chapter: '第 3 章', mastery: 9 },
    { id: 'mx', name: '坏值点', chapter: '第 3 章' },
  ];
  assert.equal(ids(internals.filterKnowledgeNodes(masteryNodes, { masteryLevels: [0], now })), '["m0","mx"]', '只看未学（缺 mastery 的按 0 算）');
  assert.equal(ids(internals.filterKnowledgeNodes(masteryNodes, { masteryLevels: [2, 3], now })), '["m2","m3","m9"]', '熟练+精通（越界 9 夹到 3）');
  assert.equal(ids(internals.filterKnowledgeNodes(masteryNodes, { masteryLevels: [], now })), '["m0","m1","m2","m3","m9","mx"]', '空数组=四档都要');
  assert.equal(ids(internals.filterKnowledgeNodes(masteryNodes, { masteryLevels: ['x', 5, -1], now })), '["m0","m1","m2","m3","m9","mx"]', '非法档位被忽略');
  assert.equal(
    ids(internals.filterKnowledgeNodes(masteryNodes, { masteryLevels: [0, 1], filter: 'marked', now })),
    '[]',
    '掌握度与筛选档要同时满足（marked 都没标 ⇒ 空）',
  );

  // 四档筛选
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { filter: 'unlearned', now })), '["a","b"]', '未学=掌握度 <2');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { filter: 'marked', now })), '["a"]');
  assert.equal(ids(internals.filterKnowledgeNodes(nodes, { filter: 'due', now })), '["a"]', '待复习=没到精通且满 7 天');
  // 未分节（2026-10-22 深夜）：只留 section 为空的节点，捞出来逐条「改挂靠」
  assert.equal(
    ids(internals.filterKnowledgeNodes([...nodes, { id: 'd', name: '卡诺图', chapter: '第 2 章 逻辑代数基础', section: '', mastery: 1 }], { filter: 'unmounted', now })),
    '["d"]',
    '未分节=还没挂到教材节上的节点',
  );
  // 体检（2026-10-23 凌晨）：四类问题分开数，issueIds 供「有问题」筛选
  assert.equal(typeof internals.knowledgeHealth, 'function', 'client 必须把体检交给测试');
  const healthOutline = {
    courses: [{ courseId: 'c1', chapters: [{ no: 2, sections: [] }] }],
  };
  const healthNodes = [
    { id: 'n1', courseId: 'c1', chapter: '第 2 章 向量', section: '2.1', evidence: [{ type: 'question', id: 'q1' }] },
    { id: 'n2', courseId: 'c1', chapter: '第 9 章 无此章', section: '9.1', evidence: [{ type: 'question', id: 'q1' }] },
    { id: 'n3', courseId: 'c1', chapter: '第 2 章 向量', section: '', evidence: [{ type: 'question', id: 'q1' }] },
    { id: 'n4', courseId: 'c1', chapter: '第 2 章 向量', section: '2.1', evidence: [] },
    { id: 'n5', courseId: 'c1', chapter: '第 2 章 向量', section: '2.1', evidence: [{ type: 'question', id: 'q404' }] },
    { id: 'n5', courseId: 'c1', chapter: '第 2 章 向量', section: '2.1', evidence: [{ type: 'question', id: 'q1' }] },
  ];
  const health = internals.knowledgeHealth(healthNodes, { outline: healthOutline, questions: [{ id: 'q1' }] });
  assert.equal(health.total, 6);
  assert.equal(health.unclassified, 1, '章号不在大纲里算未归类');
  assert.equal(health.unmounted, 1, 'section 为空算未分节');
  assert.equal(health.noEvidence, 1, 'evidence 为空算无证据');
  assert.equal(health.dangling, 1, '题号查不到算悬空');
  assert.equal(JSON.stringify(health.duplicateIds), '["n5"]', '同 id 出现两次要报出来');
  assert.equal(JSON.stringify([...health.issueIds].sort()), '["n2","n3","n4","n5"]', '问题节点 id 去重后合并成一个集合');
  assert.equal(JSON.stringify(internals.knowledgeHealth([], {})), JSON.stringify({
    total: 0, unclassified: 0, unmounted: 0, noEvidence: 0, dangling: 0, duplicateIds: [], issueIds: [], mountableIds: [], noOutline: 0,
  }), '空输入给全 0');
  // 「未分节」只算有教材大纲的课（2026-10-23 凌晨）：物理整门没大纲，节点 section 永远空，
  // 但挂不上去，算进「未分节」只会让人白点
  const noOutlineHealth = internals.knowledgeHealth(
    [{ id: 'p1', courseId: 'c_phy', chapter: '第 12 章 静电场', section: '', evidence: [{ type: 'question', id: 'q1' }] }],
    { outline: healthOutline, questions: [{ id: 'q1' }] },
  );
  assert.equal(noOutlineHealth.unmounted, 0, '没大纲的课不算未分节');
  assert.equal(noOutlineHealth.noOutline, 1, '没大纲的课单独计数，面板上给一句「整门退老树」');
  assert.equal(JSON.stringify(noOutlineHealth.mountableIds), '[]', '可挂节点集合里不该有没大纲的课');
  assert.equal(
    ids(internals.filterKnowledgeNodes(healthNodes, { filter: 'unmounted', now, mountableIds: health.mountableIds })),
    '["n3"]',
    '「未分节」筛选跟着可挂集合走，只剩 n3',
  );
  assert.equal(
    ids(internals.filterKnowledgeNodes(healthNodes, { filter: 'issues', now, issueIds: health.issueIds })),
    '["n2","n3","n4","n5","n5"]',
    '「有问题」筛选只留问题节点',
  );

  // 详解覆盖（2026-10-24 傍晚）：分析线一批批往 资料分析.json 写 points，
  // 面板要能一眼看出「68 个里写了几个」，并且能筛出「还没写的那批」
  assert.equal(typeof internals.analysisCoverage, 'function', 'client 必须把详解覆盖交给测试');
  const coverageIndex = { a: { id: 'a' }, b: { id: 'b' } };
  assert.equal(
    JSON.stringify(internals.analysisCoverage([{ id: 'a' }, { id: 'b' }], coverageIndex)),
    JSON.stringify({ total: 2, covered: 2, missing: 0, missingIds: [] }),
    '全都有详解时 missing 为 0',
  );
  assert.equal(
    JSON.stringify(internals.analysisCoverage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], coverageIndex)),
    JSON.stringify({ total: 3, covered: 2, missing: 1, missingIds: ['c'] }),
    '没写详解的进 missingIds，按节点顺序',
  );
  assert.equal(
    JSON.stringify(internals.analysisCoverage([], null)),
    JSON.stringify({ total: 0, covered: 0, missing: 0, missingIds: [] }),
    '空节点或坏索引都按 0 算，不能崩',
  );
  assert.equal(
    JSON.stringify(internals.analysisCoverage([{ id: '' }, { id: 'a' }], coverageIndex)),
    JSON.stringify({ total: 2, covered: 1, missing: 1, missingIds: [] }),
    'id 为空的节点算 missing，但不进筛选集合（否则会筛出一个没法点的空节点）',
  );
  assert.equal(
    ids(internals.filterKnowledgeNodes(
      [{ id: 'a', name: '甲' }, { id: 'c', name: '丙' }],
      { filter: 'noanalysis', now, analysisIds: ['c'] },
    )),
    '["c"]',
    '「没详解」筛选按 analysisIds 只留还没写详解的节点',
  );

  // 待复习判定：精通不再提醒；没标过/坏时间戳算到期；刚复习过不算
  assert.equal(internals.isReviewDue({ mastery: 3, reviewedAt: stale }, now), false, '精通不再提醒');
  assert.equal(internals.isReviewDue({ mastery: 1 }, now), true, '从没复习算到期');
  assert.equal(internals.isReviewDue({ mastery: 1, reviewedAt: fresh }, now), false, '刚复习过不算到期');
  assert.equal(internals.isReviewDue({ mastery: 1, reviewedAt: 'not-a-date' }, now), true, '坏时间戳按没标过处理');
  // 复习节奏（2026-10-21 夜，不改数据）：没有 reviewedAt 时从 createdAt（建点时间）起算 7 天
  assert.equal(internals.isReviewDue({ mastery: 1, createdAt: stale }, now), true, '只有建点时间：满 7 天算到期');
  assert.equal(internals.isReviewDue({ mastery: 1, createdAt: fresh }, now), false, '刚建的点不立刻催复习');
  assert.equal(internals.isReviewDue({ mastery: 1, reviewedAt: fresh, createdAt: stale }, now), false, 'reviewedAt 优先于 createdAt');

  // 证据统计（只读辅助：只告诉你有几条题/页，不参与算分、不改档）
  assert.equal(typeof internals.summarizeKnowledgeEvidence, 'function', 'client 必须把证据统计交给测试');
  assert.equal(JSON.stringify(internals.summarizeKnowledgeEvidence([
    { type: 'question', id: 'q1' },
    { type: 'question', id: 'q2' },
    { type: 'file', file: '物理/教材/x.pdf', page: 3 },
  ])), JSON.stringify({ total: 3, questions: 2, pages: 1 }));
  assert.equal(JSON.stringify(internals.summarizeKnowledgeEvidence(null)), JSON.stringify({ total: 0, questions: 0, pages: 0 }), '没有证据不能崩');
  assert.equal(JSON.stringify(internals.summarizeKnowledgeEvidence([{ id: 'q1' }])), JSON.stringify({ total: 1, questions: 0, pages: 1 }), '没有 type 的按页证据算');

  // 队列排序：重点 → 掌握度低 → 久未复习；精通不入队
  const queue = internals.knowledgeReviewQueue([
    { id: 'x', name: '乙', mastery: 0, marked: false, reviewedAt: stale },
    { id: 'y', name: '甲', mastery: 1, marked: true, reviewedAt: stale },
    { id: 'z', name: '丙', mastery: 0, marked: true, reviewedAt: stale },
    { id: 'w', name: '丁', mastery: 3, marked: true, reviewedAt: stale },
  ], { now });
  assert.equal(ids(queue), '["z","y","x"]', '重点在前，其次掌握度低/久未复习，精通不入队');

  // 题目 → 知识点反向索引：从节点的 evidence 反查，题目视图据此显示「这题考了哪些点」
  assert.equal(typeof internals.knowledgeByQuestion, 'function', 'client 必须把反向索引交给测试');
  const byQuestion = internals.knowledgeByQuestion([
    { id: 'n1', name: '高斯定理', mastery: 1, marked: true, evidence: [{ type: 'question', id: 'q1' }, { type: 'question', id: 'q2' }] },
    { id: 'n2', name: '电势', mastery: 0, marked: false, evidence: [{ type: 'question', id: 'q2' }] },
    { id: 'n3', name: '电偶极子', mastery: 2, marked: false, evidence: [{ type: 'file', file: '物理/教材/x.pdf', page: 3 }] },
    { id: '', name: '坏节点', evidence: [{ type: 'question', id: 'q3' }] },
    { id: 'n4', name: '重复证据', evidence: [{ type: 'question', id: 'q1' }, { type: 'question', id: 'q1' }] },
    null,
  ]);
  assert.equal(JSON.stringify(Object.keys(byQuestion).sort()), JSON.stringify(['q1', 'q2']), '只有题证据进索引，页证据与坏节点都不进');
  assert.equal(JSON.stringify(byQuestion.q1.map((row) => row.id)), JSON.stringify(['n1', 'n4']), 'q1 关联两个节点');
  assert.equal(JSON.stringify(byQuestion.q2.map((row) => `${row.name}:${row.mastery}:${row.marked}`)), JSON.stringify(['高斯定理:1:true', '电势:0:false']), '重点在前、掌握度低的在前');
  assert.equal(JSON.stringify(byQuestion.q1[0]), JSON.stringify({ id: 'n1', name: '高斯定理', mastery: 1, marked: true }), '行里只带渲染要用的四个字段');
  assert.equal(JSON.stringify(internals.knowledgeByQuestion(null)), '{}', '没有节点不能崩');

  // 证据行查题干：2026-10-21 深夜 bug 回归（知识点页抽出来后 findQuestion 闭包了资料页的 questions
  // ⇒ 点开带证据的节点报 ReferenceError: questions is not defined）。题目表必须由调用方传，且不能崩。
  assert.equal(typeof internals.findQuestionById, 'function', 'client 必须把「按 id 查题」交给测试');
  const qTable = [{ id: 'q1', prompt: '求节点电压', page: 2 }, { id: 7, prompt: '数字题', page: 9 }];
  assert.equal(internals.findQuestionById(qTable, 'q1').prompt, '求节点电压', '字符串 id 能查到');
  assert.equal(internals.findQuestionById(qTable, 7).prompt, '数字题', '数字 id 与字符串 id 按字面比较');
  assert.equal(internals.findQuestionById(qTable, 'q1'), internals.findQuestionById(qTable, 'q1'), '查到的就是表里那一条');
  assert.equal(internals.findQuestionById(qTable, 'q404'), null, '查不到返回 null（渲染时要写「题干缺失」）');
  assert.equal(internals.findQuestionById(null, 'q1'), null, '没有题目表不能崩');
  assert.equal(internals.findQuestionById([{ id: '' }], ''), null, '空 id 不算命中，避免把第一条误配上去');
  // 源码级：KnowledgeTab 自己声明题目表（不再是闭包里借资料页的）
  // 窗口给到 1200 字：2026-10-23 凌晨在函数头加了几行 netNodes 过滤，600 字窗口会被挤爆
  // 2026-10-23 凌晨又统一改成 objectList(docs.questions?.questions)（顺带滤掉 null 项）
  assert.ok(
    /function KnowledgeTab\([\s\S]{0,1200}?const questions = (objectList\(docs\.questions\?\.questions\)|Array\.isArray\(docs\.questions\?\.questions\))/.test(fs.readFileSync(CLIENT_FILE, 'utf8')),
    '知识点页必须自己声明 questions（2026-10-21 深夜 ReferenceError 的根因）',
  );

  // 章节进度：四档分布 + 到熟练数 + 重点数，供列表章头的小条与文案用
  assert.equal(typeof internals.chapterMasteryStats, 'function', 'client 必须把章节进度交给测试');
  const chapterStats = internals.chapterMasteryStats([
    { id: 'a', mastery: 0 },
    { id: 'b', mastery: 1, marked: true },
    { id: 'c', mastery: 2 },
    { id: 'd', mastery: 3, marked: true },
    { id: 'e', mastery: 3 },
    { id: 'f' },
  ]);
  assert.equal(JSON.stringify(chapterStats.counts), JSON.stringify([2, 1, 1, 2]), '四档各几个：未学 2、学过 1、熟练 1、精通 2');
  assert.equal(chapterStats.total, 6, '总数要等于四档之和');
  assert.equal(chapterStats.mastered, 3, '到熟练 = 熟练 + 精通');
  assert.equal(chapterStats.marked, 2, '重点数单独统计');
  assert.equal(JSON.stringify(internals.chapterMasteryStats([])), JSON.stringify({ total: 0, counts: [0, 0, 0, 0], mastered: 0, marked: 0 }), '空章不能崩');
  assert.equal(JSON.stringify(internals.chapterMasteryStats(null).counts), JSON.stringify([0, 0, 0, 0]), '没有节点不能崩');
  assert.equal(JSON.stringify(internals.chapterMasteryStats([{ mastery: 9 }, { mastery: -3 }]).counts), JSON.stringify([1, 0, 0, 1]), '越界掌握度夹到 0/3 两档');

  // 分组：课程→章；章内按 section；空章名归「未分章」
  const groups = internals.groupKnowledgeByChapter([
    { id: '1', name: 'B', courseId: 'c1', chapter: '第 2 章', section: '2.2' },
    { id: '2', name: 'A', courseId: 'c1', chapter: '第 2 章', section: '2.1' },
    { id: '3', name: 'C', courseId: 'c1', chapter: '', section: '' },
    { id: '4', name: 'D', courseId: 'c2', chapter: '第 1 章', section: '' },
  ], { course: (id) => (id === 'c1' ? '数字电子技术基础' : '离散数学') });
  assert.equal(JSON.stringify(groups.map((group) => group.chapter)), JSON.stringify(['第 2 章', '未分章', '第 1 章']), '按课程+章分组、保持插入序');
  assert.equal(ids(groups[0].nodes), '["2","1"]', '章内按 section 排序');
  assert.equal(groups[0].courseLabel, '数字电子技术基础');
  assert.equal(groups[2].courseLabel, '离散数学');

  // 没有节点也不能崩（宿主刚启动、网络还没织）
  assert.equal(ids(internals.filterKnowledgeNodes(null, { now })), '[]');
  assert.equal(JSON.stringify(internals.knowledgeReviewQueue(undefined, { now })), '[]');
  assert.equal(JSON.stringify(internals.groupKnowledgeByChapter([], {})), '[]');

  // 树（2026-10-21 夜批2）：学科 → 章 → 节 → 知识点；section 有值才多一层
  const treeNodes = [
    { id: '1', name: 'B', courseId: 'c1', chapter: '第 2 章', section: '2.2', mastery: 2, marked: true },
    { id: '2', name: 'A', courseId: 'c1', chapter: '第 2 章', section: '2.1', mastery: 3, marked: false },
    { id: '3', name: 'C', courseId: 'c1', chapter: '第 2 章', section: '', mastery: 0, marked: false },
    { id: '4', name: 'D', courseId: 'c2', chapter: '', section: '', mastery: 1, marked: false },
  ];
  const tree = internals.buildKnowledgeTree(treeNodes, { course: (id) => (id === 'c1' ? '数字电子技术基础' : '离散数学') });
  assert.equal(tree.length, 2, '树第一层是学科');
  assert.equal(tree[0].kind, 'course');
  assert.equal(tree[0].label, '数字电子技术基础');
  assert.equal(tree[0].count, 3, '分支的 count = 旗下叶数');
  assert.equal(tree[0].stats.mastered, 2, '分支带四档统计（到熟练 2 个）');
  const chapterNode = tree[0].children[0];
  assert.equal(chapterNode.kind, 'chapter');
  assert.equal(chapterNode.label, '第 2 章');
  assert.equal(chapterNode.count, 3);
  assert.equal(JSON.stringify(chapterNode.children.map((item) => item.kind)), '["section","section","node"]', '有 section 的分节，section 空的直接挂章下');
  assert.equal(chapterNode.children[0].children[0].node.id, '1', '叶子带原节点对象（节内保持插入序）');
  assert.equal(tree[1].children[0].label, '未分章', '空章名归「未分章」');
  // 全部展开要能拿到所有分支键（叶子不在内）
  const keys = internals.knowledgeTreeBranchKeys(tree);
  assert.equal(keys.length, 2 + 2 + 2, '分支键=2 学科+2 章+2 节');
  assert.ok(keys.every((key) => key.startsWith('course:') || key.startsWith('chapter:') || key.startsWith('section:')), '分支键带类型前缀');
  assert.equal(JSON.stringify(internals.buildKnowledgeTree([], {})), '[]');
  assert.equal(JSON.stringify(internals.buildKnowledgeTree(null)), '[]');

  // 大纲树（2026-10-21 深夜批5）：教材「章 → 节 → 小节」骨架 + 节点按 section/subsection 挂靠
  assert.equal(typeof internals.buildOutlineTree, 'function', 'client 必须把大纲树函数交给测试');
  const outline = {
    courses: [{
      courseId: 'c1',
      name: '数据结构',
      chapters: [{
        no: 2,
        title: '向量',
        page: 27,
        sections: [
          { no: '2.5', title: '常规向量', page: 37, subs: [{ no: '2.5.7', title: '唯一化', page: 42 }] },
          { no: '2.6', title: '有序向量', page: 44, subs: [] },
          { no: '2.7', title: '排序与下界', page: 57, subs: [] },
        ],
      }],
    }],
  };
  const outlineNodes = [
    { id: 'n1', name: '无序向量去重', courseId: 'c1', chapter: '第 2 章 向量', section: '2.5', subsection: '2.5.7', mastery: 2 },
    { id: 'n2', name: '二分查找', courseId: 'c1', chapter: '第 2 章 向量', section: '2.6', subsection: '2.6.5', mastery: 3 },
    { id: 'n3', name: '向量', courseId: 'c1', chapter: '第 2 章 向量', section: '2.1', mastery: 1 },
    { id: 'n4', name: '离散题', courseId: 'c2', chapter: '第 14 章 图的基本概念', mastery: 1 },
  ];
  const ot = internals.buildOutlineTree(outline, outlineNodes, { course: (id) => (id === 'c1' ? '数据结构' : '离散数学') });
  assert.equal(ot.length, 2, '有课程的课程大纲 + 没大纲的课程接在后面');
  assert.equal(ot[0].kind, 'course');
  assert.equal(ot[0].label, '数据结构');
  assert.equal(ot[0].children.length, 1, '大纲里只有第 2 章');
  assert.equal(ot[0].children[0].label, '第2章 向量');
  assert.equal(ot[0].children[0].children.length, 4, '三个节 + 一个「未分节」');
  const sec25 = ot[0].children[0].children[0];
  assert.equal(sec25.kind, 'section');
  assert.equal(sec25.label, '§2.5 常规向量');
  assert.equal(sec25.page, 37, '节带教材页码');
  assert.equal(sec25.children.length, 1, '§2.5 只有一个小节，且该小节有节点');
  assert.equal(sec25.children[0].kind, 'sub');
  assert.equal(sec25.children[0].children[0].node.id, 'n1', '小节号匹配的节点挂在该小节下');
  const sec26 = ot[0].children[0].children[1];
  assert.equal(sec26.children.length, 1, '§2.6 没有小节，节点直接挂节下');
  assert.equal(sec26.children[0].node.id, 'n2');
  const sec27 = ot[0].children[0].children[2];
  assert.equal(sec27.empty, true, '教材里有、没有节点的节标空');
  assert.equal(sec27.count, 0);
  assert.equal(sec27.stats.mastered, 0);
  const lost = ot[0].children[0].children[3];
  assert.equal(lost.label, '没归到节（这章里还没对上某一节）', '节号对不上的节点进「没归到节」');
  assert.equal(lost.children[0].node.id, 'n3');
  // 一节既有小节、又有「只挂到节」的节点：后者收进分组行（2026-10-26 修「知识点掉在外面、小节下拉全空」）
  const outlineGrouped = {
    courses: [{
      courseId: 'c1',
      name: '课',
      chapters: [{
        no: 2,
        title: '向量',
        page: 27,
        sections: [{ no: '2.5', title: '常规向量', page: 37, subs: [{ no: '2.5.7', title: '唯一化', page: 42 }] }],
      }],
    }],
  };
  const groupedTree = internals.buildOutlineTree(outlineGrouped, [{ id: 'm1', name: '节级点', courseId: 'c1', chapter: '第 2 章 向量', section: '2.5' }], {});
  const groupedSec = groupedTree[0].children[0].children[0];
  assert.equal(groupedSec.children.length, 2, '分组行 + 一个小节，节级节点不再和小节并排');
  assert.equal(groupedSec.children[0].kind, 'group');
  assert.equal(groupedSec.children[0].label, '本节知识点（未分到小节）');
  assert.equal(groupedSec.children[0].children[0].node.id, 'm1', '节级节点进分组');
  assert.equal(groupedSec.children[1].kind, 'sub', '小节仍在分组后面');
  assert.equal(groupedSec.count, 1, '分组里的节点照样算进节的计数');
  assert.equal(ot[0].children[0].count, 3, '章计数只算真节点');
  assert.equal(ot[0].children[0].stats.mastered, 2);
  // 树分支的「＋」要预填课程/章/节/小节（2026-10-22 深夜）：手打「第 2 章 向量」太容易挂不上
  assert.equal(JSON.stringify(ot[0].children[0].ctx), JSON.stringify({ courseId: 'c1', chapter: '第2章 向量', section: '', subsection: '' }), '章分支带章级预填');
  assert.equal(JSON.stringify(sec25.ctx), JSON.stringify({ courseId: 'c1', chapter: '第2章 向量', section: '2.5', subsection: '' }), '节分支带节级预填');
  assert.equal(JSON.stringify(sec25.children[0].ctx), JSON.stringify({ courseId: 'c1', chapter: '第2章 向量', section: '2.5', subsection: '2.5.7' }), '小节分支带小节级预填');
  assert.equal(ot[0].ctx ?? null, null, '课程层不给预填（太粗，预填到章才有用）');
  const clientSourceForPrefill = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(clientSourceForPrefill.includes('const prefillAdd = (ctx) =>'), '要有把分支上下文塞进加节点表单的函数');
  assert.ok(clientSourceForPrefill.includes("title: '在这一层新建一个知识点：自动把课程/章/节/小节填好，你只写名字'"), '树分支行要有「＋ 新建」按钮');
  assert.ok(/subsection: draft\.subsection\.trim\(\)/.test(clientSourceForPrefill), '新建节点要把小节号一起写进去');
  assert.ok(clientSourceForPrefill.includes("list: 'sa-kp-mount-chapter'"), '「改位置」的章名输入要带大纲候选（datalist）');
  assert.ok(clientSourceForPrefill.includes('id: \'sa-kp-mount-sub\''), '小节也要给候选');
  assert.ok(/onClick: typeof onOpenKnowledge === 'function' \? \(\) => onOpenKnowledge\(node\.id\) : undefined/.test(clientSourceForPrefill), '今日页待复习条目要能点开对应知识点');
  // 批量改挂靠（2026-10-22 深夜）：未分节节点逐条改太慢，一次挂一层
  assert.ok(clientSourceForPrefill.includes('const mountFiltered = async () =>'), '要有批量归位函数');
  assert.ok(clientSourceForPrefill.includes('批量归位至少要填章名'), '章名必填要拦住');
  assert.ok(clientSourceForPrefill.includes("list: 'sa-kp-batch-chapter'"), '批量归位的章名也要有候选');
  assert.ok(clientSourceForPrefill.includes('id: \'sa-kp-batch-sub\''), '批量归位也要有小节候选');
  assert.ok(/batchMount\.chapter\.trim\(\)/.test(clientSourceForPrefill), '批量挂靠要读章名输入');
  // 树分支上的「挂」：先切课程 + 筛未分节，再预填批量改挂靠（2026-10-22 深夜）
  assert.ok(clientSourceForPrefill.includes("title: '归位：把这门课还没归到章/节的知识点列出来，并把这一层填到下面的「批量归位」'"), '树分支要有「归位」按钮');
  assert.ok(/setKpFilter\('unmounted'\)/.test(clientSourceForPrefill), '「挂」要先筛未分节');
  assert.ok(/setCourseId\(entry\.ctx\.courseId/.test(clientSourceForPrefill), '「挂」必须先切到这门课，否则会误伤别的课的未分节点');
  assert.equal(ot[1].label, '离散数学', '没有大纲的课程退回老算法整门接在后面');
  assert.equal(ot[1].children[0].children[0].node.id, 'n4');
  // 没有大纲时退回老算法；空输入不崩
  assert.equal(internals.buildOutlineTree({}, treeNodes, {}).length, 2);
  assert.equal(JSON.stringify(internals.buildOutlineTree(null, [], {})), '[]');

  // 搜索命中分段（2026-10-22 深夜）：树/列表/讲解共用同一套切法
  assert.equal(typeof internals.splitByQuery, 'function', '搜索高亮必须走纯函数');
  assert.equal(JSON.stringify(internals.splitByQuery('高斯定理', '')), JSON.stringify([{ text: '高斯定理', hit: false }]), '空词整段不高亮');
  assert.equal(JSON.stringify(internals.splitByQuery('高斯定理', '高斯')), JSON.stringify([{ text: '高斯', hit: true }, { text: '定理', hit: false }]), '命中段要标出来');
  assert.equal(JSON.stringify(internals.splitByQuery('Karnaugh', 'kar')), JSON.stringify([{ text: 'Kar', hit: true }, { text: 'naugh', hit: false }]), '英文大小写不敏感');
  assert.equal(JSON.stringify(internals.splitByQuery('aa', 'a')), JSON.stringify([{ text: 'a', hit: true }, { text: 'a', hit: true }]), '连续命中要切开');
  assert.equal(JSON.stringify(internals.splitByQuery('离散数学', '概率')), JSON.stringify([{ text: '离散数学', hit: false }]), '没命中就整段回');
  assert.equal(JSON.stringify(internals.splitByQuery(null, 'x')), JSON.stringify([{ text: '', hit: false }]), 'null 不崩');
});


test('client.js：知识点页签切走再回来，展开/搜索/选中都还在', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  assert.equal(typeof internals.readKnowledgeUi, 'function', 'client 必须把界面记忆交给测试');
  assert.equal(typeof internals.resetKnowledgeUi, 'function');

  // 默认值：第一次进页签是树视图、不搜索、不选中
  const fresh = internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.equal(fresh.view, 'mind');
  assert.equal(fresh.filter, 'all');
  assert.equal(fresh.query, '');
  assert.equal(fresh.selected, null);
  assert.equal(JSON.stringify(fresh.openTree), '[]');

  // 记一次：切走再回来（组件重新挂载）读到的就是刚才那份
  internals.readKnowledgeUi({ query: '高斯', filter: 'marked', view: 'list', selected: 'k1', openTree: ['course:c_phy', 'chapter:c_phy|第 12 章 静电场'] });
  const back = internals.readKnowledgeUi();
  assert.equal(back.query, '高斯');
  assert.equal(back.filter, 'marked');
  assert.equal(back.view, 'list');
  assert.equal(back.selected, 'k1');
  assert.equal(back.openTree.length, 2);

  // 新增的「未分节」筛选也要能被记住（KP_UI_FILTERS 白名单）
  internals.readKnowledgeUi({ filter: 'unmounted' });
  assert.equal(internals.readKnowledgeUi().filter, 'unmounted', '未分节筛选要能记住');

  // 坏值夹回默认，别把界面卡死在非法状态（空 selected 也算「没选中」）
  internals.readKnowledgeUi({ filter: '不存在的筛', view: 'unknown', selected: '', openTree: ['', 42, 'ok'] });
  const clamped = internals.readKnowledgeUi();
  assert.equal(clamped.filter, 'all');
  assert.equal(clamped.view, 'mind');
  assert.equal(clamped.selected, null);
  assert.equal(JSON.stringify(clamped.openTree), '["ok"]');

  // 掌握度多选（2026-10-24）：只收 0–3 整数、去重升序；坏值一律当「不筛」
  internals.readKnowledgeUi({ masteryLevels: [2, 0, 2, 9, -1, 1.5, 'x'] });
  assert.equal(JSON.stringify(internals.readKnowledgeUi().masteryLevels), '[0,2]', '掌握度只留 0–3 整数、去重、升序');
  internals.readKnowledgeUi({ masteryLevels: 'x' });
  assert.equal(JSON.stringify(internals.readKnowledgeUi().masteryLevels), '[]', '非数组当空（四档都要）');
  internals.readKnowledgeUi({ masteryLevels: [] });
  assert.equal(internals.readKnowledgeUi().masteryLevels.length, 0);

  // 非对象参数不崩、也不改状态
  assert.equal(internals.readKnowledgeUi(null).view, 'mind');
  assert.equal(internals.readKnowledgeUi('x').view, 'mind');
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
  assert.equal(JSON.stringify(internals.readKnowledgeUi().masteryLevels), '[]', 'reset 要把掌握度筛选也清掉');
});


test('client.js：点知识点看到预生成的详解（含例题与来历），没分析过就明说「未分析」', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const { renderToStaticMarkup } = createFakeServer();
  assert.equal(typeof internals.buildAnalysisPoints, 'function', 'client 必须把详解索引交给测试');

  // 纯函数：课程 → 知识点展平成 id 索引；坏数据/重复 id 都不能崩
  const index = internals.buildAnalysisPoints({
    courses: [
      { courseId: 'c_ds', points: [{ id: 'p1', title: '甲' }, { id: '', title: '无 id' }, null] },
      { courseId: 'c_ds2', points: [{ id: 'p1', title: '覆盖' }, { id: 'p2', title: '乙' }] },
      null,
    ],
  });
  assert.equal(Object.keys(index).length, 2);
  assert.equal(index.p1.title, '覆盖', '同 id 后者覆盖（与 tools/analysis.mjs 合并语义一致）');
  assert.equal(index.p2.title, '乙');
  assert.equal(JSON.stringify(internals.buildAnalysisPoints(null)), '{}');
  assert.equal(JSON.stringify(internals.buildAnalysisPoints({ courses: 'x' })), '{}');

  const docs = {
    courses: { courses: [{ id: 'c_ds', name: '数据结构' }] },
    knowledgeNetwork: {
      nodes: [{
        id: 'n1',
        name: '无序向量去重',
        courseId: 'c_ds',
        chapter: '第 2 章 向量',
        section: '2.5',
        subsection: '2.5.7',
        mastery: 1,
        evidence: [],
      }],
    },
  };
  // 选中节点靠界面记忆预置（focus 是 effect 里 setState，静态渲染不跑 effect）
  internals.readKnowledgeUi({ selected: 'n1' });
  const withoutAnalysis = renderToStaticMarkup({ __el: true, type: internals.knowledgeTab, props: { docs }, children: [] });
  assert.ok(withoutAnalysis.includes('详解'), '节点卡要有「详解」小节');
  assert.ok(withoutAnalysis.includes('未分析'), '没有分析产物时必须明说未分析，不能拿三档讲解冒充');

  const analyzed = renderToStaticMarkup({
    __el: true,
    type: internals.knowledgeTab,
    props: {
      // 列表视图（树视图默认收起，叶子行不渲染，看不到「有详解」标记）
      initialView: 'list',
      docs: {
        ...docs,
        knowledgeAnalysis: {
          courses: [{
            courseId: 'c_ds',
            points: [{
              id: 'n1',
              title: '无序向量去重',
              level: '核心',
              keywords: ['去重', '唯一化'],
              explain: '第一段：先讲人话。\n\n第二段：再上符号。',
              analogy: '像把一筐苹果里的坏果挑掉。',
              formulas: [{ tex: 'O(n^2)', plain: '最坏情况下比较次数按平方增长' }],
              pitfalls: ['忘了先排序就二分'],
              examples: [{ prompt: '给无序向量去重', steps: ['先看有没有重复', '再决定用不用哈希'], answer: '返回去重后的向量', method: '先判重再动手' }],
              sources: [{ file: '数据结构/教材/数据结构教材.pdf', page: 62, quote: '唯一化' }],
            }],
          }],
        },
      },
    },
    children: [],
  });
  for (const piece of ['第一段：先讲人话。', '第二段：再上符号。', '打个比方：', '易错', '✗ 忘了先排序就二分', '例题', '答：', '套路：', '来历', '第 62 页', '看原文页', '核心', '去重']) {
    assert.ok(analyzed.includes(piece), `详解卡应包含「${piece}」`);
  }
  assert.ok(!analyzed.includes('未分析'), '有分析产物时不该再显示未分析');
  // 覆盖标记（2026-10-24 傍晚）：写过详解的点在列表/树里直接标出来，不用逐个点开看
  assert.ok(analyzed.includes('有详解'), '写过详解的节点行上要标「有详解」');
  assert.ok(!analyzed.includes('undefined'), `详解卡不应渲染出 undefined：${analyzed.slice(0, 300)}`);
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();
});


test('client.js：知识网络布局是层级树（课程→章→点），坐标确定、父子对齐', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  assert.equal(typeof internals.buildKnowledgeLayout, 'function', 'client 必须把布局函数交给测试');
  // 注意：client 在 vm 里跑，数组原型与测试进程不同 ⇒ 用 JSON 比，别用 deepStrictEqual
  assert.equal(JSON.stringify(internals.MASTERY_LABELS), JSON.stringify(['未学', '学过', '熟练', '精通']), '掌握度四档文案');

  const nodes = [
    { id: 'a', name: '基尔霍夫定律', courseId: 'c_dg', chapter: '第 1 章', section: '1.1', mastery: 3 },
    { id: 'b', name: '节点电压法', courseId: 'c_dg', chapter: '第 2 章', section: '2.3', mastery: 1 },
    { id: 'c', name: '戴维南等效', courseId: 'c_dg', chapter: '第 2 章', section: '2.1', mastery: 0 },
  ];
  const layout = internals.buildKnowledgeLayout(nodes, { course: () => '数字电子技术基础' });

  const points = layout.nodes.filter((item) => item.level === 'point');
  const chapters = layout.nodes.filter((item) => item.level === 'chapter');
  const courses = layout.nodes.filter((item) => item.level === 'course');
  assert.equal(points.length, 3, '三个知识点都要画');
  assert.equal(chapters.length, 2, '两章 → 两个中间节点');
  assert.equal(courses.length, 1, '一门课 → 一个根节点');
  assert.equal(layout.links.length, points.length + chapters.length, '层级边数 = 点 + 章');

  // 三列从左到右：课程 x < 章 x < 点 x
  assert.ok(courses[0].x < chapters[0].x && chapters[0].x < points[0].x, '三列必须是从左到右');

  // 点按章分组后纵向排开：同一章的 y 相邻且严格递增，不同章的块不重叠
  const sameChapter = points.filter((item) => ['2.1', '2.3'].includes(item.ref.section)).sort((a, b) => a.y - b.y);
  assert.equal(sameChapter.length, 2);
  assert.ok(sameChapter[0].y < sameChapter[1].y, '同章的点必须纵向递增');
  assert.equal(sameChapter[0].ref.name, '戴维南等效', '章内按 section 排序（2.1 在 2.3 前）');
  const ys = points.map((item) => item.y).sort((a, b) => a - b);
  assert.equal(new Set(ys).size, ys.length, '不同点不能重叠在同一 y');

  // 父节点纵向居中于子节点之间
  assert.ok(chapters[0].y >= points[0].y && chapters[0].y <= points[1].y, `章应居中于其点之间：${chapters[0].y}`);
  assert.ok(courses[0].y > chapters[0].y && courses[0].y < chapters[0].y + 200, '课程节点应落在章的纵向范围内');

  // 同一份数据两次布局结果一致（确定性，否则每次刷新图都会动）
  assert.deepEqual(
    internals.buildKnowledgeLayout(nodes, { course: () => '数字电子技术基础' }),
    layout,
  );

  // 空输入也要给可用尺寸，不能 NaN（空态由面板自己渲染文案）
  const blank = internals.buildKnowledgeLayout([]);
  assert.equal(blank.nodes.length, 0);
  assert.ok(Number.isFinite(blank.width) && Number.isFinite(blank.height) && blank.height > 0, '空图也要有正的尺寸');
  assert.ok(!JSON.stringify(blank).includes('NaN'), '空图不能出现 NaN 坐标');
});

test('client.js：思维导图布局是横向树（全部→课→章→点），叶子不重叠、坐标确定', () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  assert.equal(typeof internals.buildMindMap, 'function', 'client 必须把导图布局交给测试');
  const nodes = [
    { id: 'a', name: '节点电压法', courseId: 'c_dg', chapter: '第 2 章', section: '2.1', mastery: 2, marked: true },
    { id: 'b', name: '叠加定理', courseId: 'c_dg', chapter: '第 2 章', section: '2.3', mastery: 1 },
    { id: 'c', name: '戴维南等效', courseId: 'c_dg', chapter: '第 4 章', section: '4.1', mastery: 0 },
  ];
  const map = internals.buildMindMap(nodes, { course: () => '数字电子技术基础' });
  const kinds = (kind) => map.nodes.filter((item) => item.kind === kind);
  assert.equal(kinds('root').length, 1, '导图要有唯一根节点');
  assert.equal(kinds('course').length, 1, '一门课 → 一个课程节点');
  assert.equal(kinds('chapter').length, 2, '两章 → 两个章节点');
  assert.equal(kinds('point').length, 3, '三个知识点都要画');
  assert.equal(map.points, 3, '抬头要能报知识点数');
  assert.ok(map.links.length >= 5, '连线至少覆盖根→课→章→点');

  // 四层从左到右
  const xOf = (kind) => kinds(kind)[0].x;
  assert.ok(xOf('root') < xOf('course') && xOf('course') < xOf('chapter') && xOf('chapter') < xOf('point'),
    '四层必须自左向右排');

  // 叶子纵向不重叠
  const ys = kinds('point').map((item) => item.y).sort((left, right) => left - right);
  assert.equal(new Set(ys).size, ys.length, '知识点不能叠在同一 y');

  // 父节点取子节点竖直中心
  const chapter = kinds('chapter')[0];
  assert.ok(chapter.y >= ys[0] && chapter.y <= ys[ys.length - 1], '章应落在其子节点的纵向范围内');

  // 掌握度与重点要带到布局里（渲染层直接用来上色/加星）
  const point = kinds('point').find((item) => item.id === 'a');
  assert.equal(point.mastery, 2);
  assert.equal(point.marked, true);

  // 确定性 + 空输入不崩
  assert.deepEqual(internals.buildMindMap(nodes, { course: () => '数字电子技术基础' }), map);
  const blank = internals.buildMindMap([]);
  assert.equal(blank.nodes.length, 0);
  assert.equal(blank.width, 0);
  assert.ok(!JSON.stringify(blank).includes('NaN'), '空导图不能出现 NaN 坐标');
  assert.ok(!JSON.stringify(internals.buildMindMap([null, 1, 'x'])).includes('NaN'), '坏输入也不能出现 NaN');

  // 第二刀：expanded 控制「默认只展开到章」。给 [] ⇒ 只画到章；给一章 ⇒ 只铺那一章的点
  const labels = { course: () => '数字电子技术基础' };
  const collapsedAll = internals.buildMindMap(nodes, labels, { expanded: [] });
  assert.equal(collapsedAll.points, 0, '没展开任何章时不该铺知识点');
  assert.equal(collapsedAll.collapsed, 2, '两章都算「未展开」');
  assert.equal(collapsedAll.nodes.filter((item) => item.kind === 'point').length, 0);
  assert.equal(collapsedAll.nodes.filter((item) => item.kind === 'chapter').length, 2, '章节点仍要在');
  assert.ok(collapsedAll.nodes.filter((item) => item.kind === 'chapter').every((item) => item.open === false),
    '折叠的章要标 open:false');
  assert.ok(collapsedAll.nodes.filter((item) => item.kind === 'chapter').every((item) => item.total === undefined || typeof item.total === 'number'),
    '章要带总点数（渲染层显示「N 个」）');

  const onlyChapter = internals.buildMindMap(nodes, labels, { expanded: ['第 2 章'] });
  assert.equal(onlyChapter.points,0,'Opening a chapter must leave sections collapsed');
  assert.ok(onlyChapter.nodes.filter(n=>n.kind==='section').every(n=>n.open===false));
  const oneChapter = internals.buildMindMap(nodes, labels, { expanded: ['第 2 章','mind:section:c_dg|第 2 章|2.1','mind:section:c_dg|第 2 章|2.3'] });
  assert.equal(oneChapter.points, 2, '只展开第 2 章 ⇒ 只铺该章的 2 个点');
  assert.equal(oneChapter.collapsed, 1, '第 4 章仍折叠');
  // 注意：client 在 vm 里跑，数组原型与测试进程不同 ⇒ 用 JSON 比，别用 deepStrictEqual
  assert.equal(JSON.stringify(oneChapter.nodes.filter((item) => item.kind === 'point').map((item) => item.id).sort()),
    JSON.stringify(['a', 'b']), '只展开第 2 章时铺出来的正是这两个点');
  assert.equal(oneChapter.nodes.filter((item) => item.kind === 'chapter' && item.open === true).length, 1);

  const expandAll = internals.buildMindMap(nodes, labels, { expanded: null });
  assert.equal(expandAll.points, 3, 'expanded 传 null = 全展开');
  assert.equal(expandAll.collapsed, 0);
});

test('client.js：知识网络的标记走 /mutate 的 knowledgeNetwork，不复用取字产物的只读路由', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  // 源码级契约：面板必须用 knowledgeNetwork 这个 doc 名，且只送要改的字段
  assert.match(source, /mutate\('knowledgeNetwork', 'update'/);
  assert.match(source, /mutate\('knowledgeNetwork', 'create'/);
  assert.ok(source.includes('知识点网络.json'), '空态点名数据来源');
});

test('client.js：织网与导出画布走两条专用 POST，成功时把服务端的数字摘要出来', {
  skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false,
}, () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.match(source, /fetch\(`\$\{API\}\/knowledge\/\$\{kind\}`/, '两个按钮共用一个 POST 封装');
  assert.ok(source.includes("runKnowledgeJob('weave')"), '要有「织网」按钮');
  assert.ok(source.includes("runKnowledgeJob('export')"), '要有「导出到画布」按钮');
  assert.ok(source.includes('织网完成：新增'), '成功要显示新增/合并/无变化的数字');
  assert.ok(source.includes('已导出到 '), '成功要显示导出目录与计数');
  assert.ok(source.includes('学习台/知识画布'), '按钮旁要写明画布落点');
  // 织网/导出是写盘操作，必须带安全请求头（和其它 POST 一致）
  // 位置变了：知识点搬家后 runKnowledgeJob 与 emptyText 不再相邻，用「后面紧跟 loadExplainList」当右边界
  const jobStart = source.indexOf('const runKnowledgeJob = async (kind)');
  const jobEnd = source.indexOf('const loadExplainList');
  assert.ok(jobStart >= 0 && jobEnd > jobStart, 'runKnowledgeJob 与 loadExplainList 的相对位置变了，测试要跟着改');
  const jobBlock = source.slice(jobStart, jobEnd);
  assert.ok(jobBlock.includes('[REQUEST_HEADER]'), '写盘请求必须带 X-Study-Request 头');
});

test('client.js：内联算法与 lib/core.js 逐项一致（真正的防漂移）', { skip: isPhase1 ? '第 1 阶段空骨架，未导出内联算法' : false }, async () => {

  const core = await import('../lib/core.js');
  const { half } = loadClient();
  const client = half.DESCRIPTORS?.internals;
  assert.ok(client, 'client.js 必须导出 DESCRIPTORS.internals 供逐项比对');

  // 同一组输入同时跑两边，断言结果完全一致。
  // 这才是「防漂移」——此前那条测试只测了 core.js 自己，是个假测试。
  //
  // 唯一放宽的地方：client 内联版只保留**界面用得到的**语义字段，
  // core.js 还会带开发者诊断用的字段：
  //   - core.parseWeeks 的 `reason`（如 'unparsed:abc'）
  //   - core.deadlineUrgency 的 `hours`（界面只用 level/days）
  // 所以比对前删掉这些字段，其余字段仍要求完全一致。
  const DIAGNOSTIC_FIELDS = ['reason', 'hours', 'counted'];
  const semantic = (value) => {
    const copy = JSON.parse(JSON.stringify(value ?? null));
    if (copy !== null && typeof copy === 'object') {
      for (const key of DIAGNOSTIC_FIELDS) delete copy[key];
    }
    return copy;
  };
  const assertSame = (name, input, label) => {
    assert.ok(typeof client[name] === 'function', `client 缺少内联算法 ${name}`);
    assert.ok(typeof core[name] === 'function', `core 缺少 ${name}`);
    const args = Array.isArray(input) ? input : [input];
    const a = client[name](...args);
    const b = core[name](...args);
    assert.deepEqual(semantic(a), semantic(b),
      `${name} 在 ${label} 上不一致：client=${JSON.stringify(a)} core=${JSON.stringify(b)}`);
  };

  // parseWeeks
  for (const expr of ['1-16', '1-8,10-16', '3', '1-8单', '1-8(双)', 'abc', '', '1-', '0']) {
    assertSame('parseWeeks', expr, `parseWeeks(${JSON.stringify(expr)})`);
  }

  // isWeekActive —— 含「无 sessions 时回退顶层 weeks」这一条（曾经两边不一致）
  const courses = [
    { sessions: [{ weekday: 1, weeks: '1-16' }] },
    { sessions: [{ weekday: 1, weeks: 'abc' }] },
    { weeks: '1-16' },          // 无 sessions：旧版客户端在这里与 core 结论不同
    { weeks: '2-16双' },
    { sessions: [] },
    {},
  ];
  for (const course of courses) {
    for (const week of [1, 2, 3, 0, 17]) {
      assertSame('isWeekActive', [course, week], `isWeekActive(${JSON.stringify(course)}, ${week})`);
    }
  }

  // currentTeachingWeek
  const term = { startDate: '2026-09-07', totalWeeks: 16 };
  for (const date of ['2026-09-07', '2026-09-13', '2026-09-14', '2026-08-01', '2027-03-01', 'bad']) {
    assertSame('currentTeachingWeek', [term, date], `currentTeachingWeek(${date})`);
  }

  // deadlineUrgency
  const now = new Date(2026, 8, 10, 9, 0, 0);
  for (const task of [
    { due: '2026-09-09' }, { due: '2026-09-10' }, { due: '2026-09-12' },
    { due: '2026-09-20' }, { due: '' }, { due: '2026-09-01', status: 'done' },
    { due: '2026-09-10 08:00' }, { status: 'dropped' },
  ]) {
    assertSame('deadlineUrgency', [task, now], `deadlineUrgency(${JSON.stringify(task)})`);
  }

  // compareTasksByDue（含排序稳定性）
  const tasks = [
    { id: 'a', due: '2026-09-25' }, { id: 'b', due: '2026-09-01' },
    { id: 'c', due: '2026-09-10' }, { id: 'd', due: '2026-09-02', status: 'done' },
    { id: 'e', due: '' },
  ];
  assert.deepEqual(
    [...tasks].sort((x, y) => client.compareTasksByDue(x, y, now)).map((t) => t.id),
    [...tasks].sort((x, y) => core.compareTasksByDue(x, y, now)).map((t) => t.id),
    'compareTasksByDue 的排序结果不一致',
  );

  // isClosedTask / parseTimestamp
  for (const task of [{ status: 'done' }, { status: 'dropped' }, { status: 'todo' }, {}, { status: 'doing' }]) {
    assertSame('isClosedTask', task, `isClosedTask(${JSON.stringify(task)})`);
  }
  for (const value of ['2026-10-08T11:33:02.990Z', '2026-09-30 12:09:58.905', '2026-10-08', '', null, undefined, 'bad', 0]) {
    assertSame('parseTimestamp', value, `parseTimestamp(${JSON.stringify(value)})`);
  }

  // compareClosedTasksByDoneAtDesc —— 用真实数据里的 doneAt 形状，两边逐对比较
  const closed = [
    { id: 'a', status: 'done', doneAt: '2026-09-30T05:50:00.738Z', due: '2026-09-21' },
    { id: 'b', status: 'done', doneAt: '2026-10-08T11:33:02.990Z', due: '2026-10-09 00:00' },
    { id: 'c', status: 'done', doneAt: null, due: '2026-09-20' },
    { id: 'd', status: 'done', doneAt: null, due: '2026-09-25' },
    { id: 'e', status: 'dropped' },
  ];
  for (const left of closed) {
    for (const right of closed) {
      assert.equal(
        client.compareClosedTasksByDoneAtDesc(left, right),
        core.compareClosedTasksByDoneAtDesc(left, right),
        `compareClosedTasksByDoneAtDesc(${left.id}, ${right.id}) 不一致`,
      );
    }
  }

  // compareDeadlineList —— 混排（未完结 + 已完结）的排序结果必须一致
  const mixed = [
    { id: 'p', status: 'todo', due: '2026-09-25' },
    { id: 'q', status: 'done', doneAt: '2026-09-30T05:50:00.738Z', due: '2026-09-21' },
    { id: 'r', status: 'doing', due: '2026-09-01' },
    { id: 's', status: 'done', doneAt: '2026-10-08T11:33:02.990Z', due: '2026-10-09 00:00' },
    { id: 't', status: 'todo', due: '' },
  ];
  assert.deepEqual(
    [...mixed].sort((x, y) => client.compareDeadlineList(x, y, now)).map((t) => t.id),
    [...mixed].sort((x, y) => core.compareDeadlineList(x, y, now)).map((t) => t.id),
    'compareDeadlineList 的排序结果不一致',
  );

  // scoreToGpa4 / gradeToGpa4
  for (const score of [100, 90, 85, 61, 60, 59, 0, NaN, undefined]) {
    assertSame('scoreToGpa4', score, `scoreToGpa4(${String(score)})`);
  }
  for (const grade of ['优秀', '良好', '中等', '及格', '不及格', 'A', 'F', '未知']) {
    assertSame('gradeToGpa4', grade, `gradeToGpa4(${grade})`);
  }

  // computeGpa —— 覆盖漂移过的两处：坏条目缺 courseId、credit 为 Infinity
  const gradeDocs = [
    { courses: [{ courseId: 'a', score: 90, credit: 3 }, { courseId: 'b', score: 80, credit: 2 }] },
    { courses: [{ courseId: 'a', score: null, credit: 3 }, { courseId: 'b', score: 99, credit: 0 }] },
    { courses: [null, 'bad', { courseId: 'c', score: 70, credit: 1 }] },
    { courses: [{ courseId: 'd', score: 88, credit: 1e999 }] },   // JSON 里 1e999 → Infinity
    { courses: [] },
    {},
  ];
  for (const doc of gradeDocs) {
    assertSame('computeGpa', doc, `computeGpa(${JSON.stringify(doc)?.slice(0, 60)}…)`);
  }

  // parseDay / parseDue
  for (const value of ['2026-09-07', '2026-02-31', '2026-13-01', '', 'bogus', null]) {
    assertSame('parseDay', value, `parseDay(${JSON.stringify(value)})`);
  }
  for (const value of ['2026-09-10', '2026-09-10 12:30', '2026-09-10T08:05', 'bogus', null]) {
    const a = client.parseDue(value);
    const b = core.parseDue(value);
    assert.equal(a === null, b === null, `parseDue(${JSON.stringify(value)}) 的可解析性不一致`);
    if (a !== null && b !== null) assert.equal(a.getTime(), b.getTime(), `parseDue(${JSON.stringify(value)}) 时刻不一致`);
  }

  // teachingWeekStart / dateOfWeekday / formatMonthDay（课表表头显示日期用）
  const weekTerm = { startDate: '2026-09-14', totalWeeks: 16 };
  for (const week of [1, 2, 6, 7, 16, 0, -1, '3', null, undefined]) {
    const a = client.teachingWeekStart(weekTerm, week);
    const b = core.teachingWeekStart(weekTerm, week);
    assert.equal(a === null, b === null, `teachingWeekStart(week=${String(week)}) 可空性不一致`);
    if (a !== null && b !== null) assert.equal(a.getTime(), b.getTime(), `teachingWeekStart(week=${String(week)}) 不一致`);
  }
  for (const week of [1, 6, 7]) {
    for (const weekday of [1, 3, 5, 7, 0, 8]) {
      const a = client.dateOfWeekday(weekTerm, week, weekday);
      const b = core.dateOfWeekday(weekTerm, week, weekday);
      assert.equal(a === null, b === null, `dateOfWeekday(${week},${weekday}) 可空性不一致`);
      if (a !== null && b !== null) assert.equal(a.getTime(), b.getTime(), `dateOfWeekday(${week},${weekday}) 不一致`);
    }
  }
  assert.equal(client.formatMonthDay(core.dateOfWeekday(weekTerm, 6, 1)), '10/19', '第 6 周周一应为 10/19');
  assert.equal(client.formatMonthDay(core.dateOfWeekday(weekTerm, 7, 3)), '10/28', '第 7 周周三应为 10/28');
  assertSame('formatMonthDay', weekTerm.startDate, "formatMonthDay('2026-09-14')");

  // parseQuickDay —— 相对日期依赖 now，两边必须给出同一天
  const quickNow = new Date(2026, 8, 30, 13, 0, 0);   // 2026-09-30 周三
  for (const value of ['2026-10-15', '10/20', '10-20', '9/1', '今天', '明天', '后天', '周五', '周三', '下周周三', '10/20 14:30', '', 'bogus', '13/45']) {
    assertSame('parseQuickDay', [value, quickNow], `parseQuickDay(${JSON.stringify(value)})`);
  }

  // parseQuickTasks —— 整块文本解析（含科目名唯一前缀匹配、错误行）
  const quickCourses = [
    { id: 'c_ds', name: '数据结构', aliases: ['数构', 'DS'] },
    { id: 'c_digital', name: '数字电子技术基础', aliases: ['数电', '数电实验'] },
    { id: 'c_phylab', name: '物理实验B(1)', aliases: ['物理实验'] },
    { id: 'c_phy', name: '大学物理B(2)', aliases: ['物理', '大学物理'] },
    { id: 'c_eng', name: '英语阅读写作(A)', aliases: ['英语'] },
  ];
  const quickTexts = [
    '',
    '第 3 次作业 | 数据结构 | 10/20 | 作业',
    '# 注释行\n第 3 次作业 | 数据结构 | 10/20 | 作业\n实验二预习报告 | 数电实验 | 明天 | 实验',
    '第 3 次作业 | 数据结构 | 10/20 | 作业 | 高',
    '只有标题',
    '作业 | 不存在的课 | 10/20 | 作业',
    '作业 | 英语 | 10/20 | 作业',           // 「英语」唯一前缀匹配
    '作业 | B | 10/20 | 作业',               // 匹配到多门课
    '作业 | 数据结构 | 不存在的日期 | 作业',
    '作业 | 数据结构 | 10/20 | 不存在的类型',
    '作业 | 数据结构 | 10/20 | 作业 | 特急',
    '| 数据结构 | 10/20 | 作业',
    '作业 | 数电 | 10/20 | 作业',            // 别名精确命中
    '作业 | 数电实验 | 10/20 | 作业',        // 较长的别名也应命中同一门课
    '作业 | DS | 10/20 | 作业',              // 别名不区分大小写
    '作业 | 物理实验 | 10/20 | 作业',        // 别名精确 > 课程名子串
    '作业 | 大学物理 | 10/20 | 作业',
  ];
  for (const value of quickTexts) {
    // 用 semantic() 归一化后再比：client 与 core 的解析结果来自两个 realm 的
    // 对象字面量，assert.deepEqual 会把原型差异当成不等（会误报）。
    const a = semantic(client.parseQuickTasks(value, { courses: quickCourses, now: quickNow }));
    const b = semantic(core.parseQuickTasks(value, { courses: quickCourses, now: quickNow }));
    assert.deepEqual(a, b, `parseQuickTasks 在 ${JSON.stringify(value).slice(0, 40)} 上不一致：client=${JSON.stringify(a)} core=${JSON.stringify(b)}`);
  }
  // 解析出来的草稿要能被宿主接受：不含内部字段 _line 之外的多余键
  const sample = core.parseQuickTasks('第 3 次作业 | 数据结构 | 10/20 | 作业', { courses: quickCourses, now: quickNow });
  assert.equal(sample.ok, true, '正常行必须解析成功');
  assert.equal(sample.items.length, 1, '应解析出 1 条');
  assert.equal(sample.items[0].courseId, 'c_ds', '科目应解析成课程 id');
  assert.equal(sample.items[0].due, '2026-10-20', '日期应归一化为 YYYY-MM-DD');
  assert.equal(sample.items[0].kind, 'homework', '类型应解析成 kind');

  // 别名必须能当科目写：这是「数电」这类简称能不能用的关键
  const byAlias = (text) => core.parseQuickTasks(text, { courses: quickCourses, now: quickNow });
  assert.equal(byAlias('实验 | 数电 | 10/20 | 实验').items[0]?.courseId, 'c_digital', '「数电」应经别名命中数字电子技术基础');
  assert.equal(byAlias('实验 | 数电实验 | 10/20 | 实验').items[0]?.courseId, 'c_digital', '「数电实验」应命中同一门课');
  assert.equal(byAlias('作业 | ds | 10/20 | 作业').items[0]?.courseId, 'c_ds', '别名匹配应忽略大小写');
  assert.equal(byAlias('作业 | 物理实验 | 10/20 | 作业').items[0]?.courseId, 'c_phylab', '「物理实验」应命中物理实验，而不是大学物理');
  assert.equal(byAlias('作业 | 大学物理 | 10/20 | 作业').items[0]?.courseId, 'c_phy', '「大学物理」应命中大学物理');

  // 认不出科目时要给出可用写法提示，而不是光说「找不到」
  const miss = core.parseQuickTasks('作业 | 不存在的课 | 10/20 | 作业', { courses: quickCourses, now: quickNow });
  assert.equal(miss.ok, false, '未知科目必须报错');
  assert.match(miss.errors[0].reason, /可用的科目/, '找不到科目时应提示可用写法');
  assert.match(miss.errors[0].reason, /数电/, '提示里应带上别名');

  // 「物理」是 c_phy 的别名，同时也是 c_phylab 课程名「物理实验B(1)」的一部分。
  // 精确别名命中要优先于子串匹配——否则用户写自己的别名反而会被判歧义。
  const physicsAlias = core.parseQuickTasks('作业 | 物理 | 10/20 | 作业', { courses: quickCourses, now: quickNow });
  assert.equal(physicsAlias.ok, true, '精确别名应优先于子串匹配');
  assert.equal(physicsAlias.items[0]?.courseId, 'c_phy', '「物理」应命中大学物理');

  // 真正的歧义（没有任何精确命中）必须报错而不是猜一门课
  const ambiguous = core.parseQuickTasks('作业 | 物 | 10/20 | 作业', { courses: quickCourses, now: quickNow });
  assert.equal(ambiguous.ok, false, '「物」无精确命中且匹配多门课时必须报错，不能猜');
  assert.match(ambiguous.errors[0].reason, /匹配到多门课/, '歧义错误文案');
  assert.match(ambiguous.errors[0].reason, /请写得更具体/, '歧义时应提示写具体些');
});

test('client.js：别名输入解析，且网络学堂路由与服务端逐一对应（防「按钮点了没反应」）', { skip: isPhase1 ? '第 1 阶段空骨架，无内联算法' : false }, () => {
  const { half } = loadClient();
  const client = half.DESCRIPTORS?.internals;
  assert.ok(typeof client?.parseAliasInput === 'function', 'client.js 必须导出 internals.parseAliasInput');

  // 按标点拆，**不按空格拆**：别名里带空格是正常的（「大学 物理」）。
  // 用 join 比对而不是 deepEqual：返回值是 vm 里那个 realm 的数组，
  // deepStrictEqual 会把原型差异当不等（同一坑见上面 parseQuickTasks 的 semantic()）。
  const aliases = (input) => client.parseAliasInput(input).join('|');
  assert.equal(aliases('数电、数电实验'), '数电|数电实验');
  assert.equal(aliases('数电,数电实验; DS'), '数电|数电实验|DS', '逗号、分号、顿号都当分隔符');
  assert.equal(aliases('大学 物理'), '大学 物理', '别名里的空格不能被当成分隔符');
  assert.equal(aliases('，、; '), '', '只有分隔符时应得到空数组，而不是空串元素');
  assert.equal(aliases('  '), '');
  assert.equal(aliases(''), '');
  assert.equal(aliases(undefined), '', '非字符串输入不能抛错');
  assert.equal(aliases(null), '');

  // 路由契约：客户端调用的每个 /learn/<x> 都必须在服务端注册。
  // 这一条防的是「界面点了没反应」——服务端少注册一条路由时，
  // 前面所有测试都还是绿的，只有真机上按钮无声无息。
  const clientSource = fs.readFileSync(CLIENT_FILE, 'utf8');
  const serverSource = fs.readFileSync(path.join(HERE, '..', 'lib', 'api.js'), 'utf8');
  const used = [...new Set([...clientSource.matchAll(/learnPost\(\s*'([a-z-]+)'/g)].map((m) => m[1]))];
  assert.ok(used.includes('connect') && used.includes('sync'), `客户端应调用 connect 与 sync，实际 ${JSON.stringify(used)}`);
  for (const route of used) {
    assert.ok(serverSource.includes(`rest === '/learn/${route}'`), `客户端调用了 /learn/${route}，但服务端没有注册这条路由`);
  }
  assert.match(clientSource, /learnStatus\(/, '客户端必须能读 /learn/status，否则「已连接」状态永远显示不出来');
  assert.ok(serverSource.includes("rest === '/learn/status'"), '服务端没有注册 GET /learn/status');

  // 提交件归档：客户端两次调用都必须在服务端注册。归档是写请求，少注册一条路由时
  // 「自动归档」会安静地不生效（扫描还可能因为 404 报成「插件没加载」），所以同样要钉住。
  assert.match(clientSource, /deliverablesScan\(/, '客户端必须能读 GET /deliverables');
  assert.match(clientSource, /deliverablesArchive\(/, '客户端必须能调 POST /deliverables/archive');
  assert.ok(serverSource.includes("rest === '/deliverables'"), '服务端没有注册 GET /deliverables');
  assert.ok(serverSource.includes("rest === '/deliverables/archive'"), '服务端没有注册 POST /deliverables/archive');

  // 资料正文：面板「资料」页点开一份资料要读 md，少注册这条路由时点开只会一直「读取失败」。
  assert.match(clientSource, /async function materialText\(/, '客户端必须能以只读方式取资料正文');
  assert.ok(clientSource.includes('/materials/text?'), '客户端必须调 GET /materials/text');
  assert.ok(serverSource.includes("rest === '/materials/text'"), '服务端没有注册 GET /materials/text');
});

test('client.js：window.confirm 与 fetch 缺失时渲染不崩（防御性）', { skip: isPhase1 ? '第 1 阶段空骨架，无组件' : false }, () => {
  const { registrations } = loadClient();
  const { renderToStaticMarkup } = createFakeServer();
  const schedule = registrations.find((entry) => entry.options.name === 'main');
  // 渲染课表页需要一个「已就绪」的状态，这里只确认组件函数本身可调用且返回元素
  const element = schedule.component({
    panelInfo: { activePanelId: 'study-assistant' },
    usePanelInfo: () => ({ activePanelId: 'study-assistant' }),
  });
  assert.ok(element && element.__el === true, '组件应返回 React 元素');
});

// ---------------------------------------------------------------------------
// 主题令牌白名单（真机事故回归测试）
//
// 事故：我原先在 CSS 里用了 --dsw-alias-text-primary / bg-subtle / border-subtle /
// accent-primary / status-danger 等**DSH 里根本不存在的**令牌名。不存在的自定义
// 属性会让 color/background/border-color 退化成初始值（透明 / inherit），默认
// 主题下偶然能看，用户装上主题插件后整个面板"看不见东西"（m01726）。
//
// 白名单来自 tools/fix-theme-tokens.mjs，那里面是从官方客户端包 CSS 实证提取的。
// ---------------------------------------------------------------------------

/** 把 CSS 里所有 var(--dsw-xxx) 引用提取成去重列表。 */
function extractDswTokens(css) {
  return [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();
}

test('client bundle：CSS 里所有 var(--dsw-*) 都必须是官方真实令牌', () => {
  assert.ok(OFFICIAL_TOKENS.size > 0, '白名单不应为空');
  for (const file of ['client.js', 'client.full.js']) {
    const source = fs.readFileSync(path.join(HERE, '..', file), 'utf8');
    const used = extractDswTokens(source);
    assert.ok(used.length > 0, `${file} 应至少引用一个主题令牌`);
    for (const token of used) {
      assert.ok(
        OFFICIAL_TOKENS.has(token),
        `${file} 用了不存在的主题令牌 ${token} —— ` +
        '不存在的自定义属性会让颜色属性退化为初始值，在主题插件下表现为面板完全看不见。' +
        '请从 tools/fix-theme-tokens.mjs 的 OFFICIAL_TOKENS 里选一个真实令牌。',
      );
    }
  }
});

test('client bundle：面板根容器必须自带不透明背景，不能只靠继承', () => {
  // 官方主面板容器（plugin-manager 的 .X_2TxG_page、conversation 的 wSkVaW_root）
  // 都会显式声明颜色，不留"背景透明 + 颜色继承"的组合给主题插件翻车。
  //
  // 2026-09-30 补充：这里曾用过 --dsw-alias-bg-base，但主题皮肤把这枚令牌定义成
  // `transparent`（它要自己画整列背景），于是面板底色变透明、内容浮在立绘上。
  // 改用 bg-layer-1：这枚令牌皮肤给的是不透明/近不透明色，面板底色不会被抽掉。
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  const rule = source.match(/\.sa-root\{[^}]*\}/);
  assert.ok(rule !== null, 'client.full.js 应存在 .sa-root 规则');
  assert.match(rule[0], /background:\s*var\(--dsw-alias-bg-(layer-1|layer-2|overlay)\)/, '.sa-root 的背景必须用不透明层级令牌（bg-layer-1/2/overlay），不能用 bg-base（主题可能把它设为 transparent）');
  assert.match(rule[0], /color:\s*var\(--dsw-alias-label-primary\)/, '.sa-root 必须有 color: var(--dsw-alias-label-primary)');
});

test('client bundle：CSS 里不应用未定义的圆角像素值', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  const radii = [...source.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(radii.length > 0, '应存在 border-radius 声明');
  for (const value of radii) {
    if (value === '999px') continue;               // 胶囊形状，官方也是硬写
    if (value.includes('var(--dsw-radius-')) continue;
    assert.fail(`border-radius 用了非令牌值 ${value}，请改用 var(--dsw-radius-sm|md|lg|xl)`);
  }
});

test('client.js：能「返回上一页」——页签/筛选/打开的文件一起复原，Alt+← 也走同一条路', { skip: isPhase1 }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  internals.resetKnowledgeUi();
  internals.resetMaterialsUi();
  internals.resetNavigation();

  for (const name of ['readMaterialsUi', 'resetMaterialsUi', 'navSnapshot', 'navPush', 'navBack', 'navForward', 'navCanBack', 'navCanForward', 'resetNavigation']) {
    assert.equal(typeof internals[name], 'function', `client 必须导出 ${name}（返回上一页靠它）`);
  }

  // 起点：今日页
  internals.navPush(internals.navSnapshot('today'));
  assert.equal(internals.navCanBack(), false, '只有一个位置时不该能返回');

  // 在资料页打开一份资料的第 3 页，然后点题目里的知识点跳走 —— 跳转那一下才会把「离开时的位置」压栈
  internals.readMaterialsUi({ view: 'files', courseId: 'c_ds', openPath: '数据结构/教材/a.pdf', openPage: 3 });
  internals.navPush(internals.navSnapshot('materials'));

  // 知识点页：选中 k1、列表视图、只看重点
  internals.readKnowledgeUi({ selected: 'k1', view: 'list', filter: 'marked' });
  internals.navPush(internals.navSnapshot('knowledge'));
  assert.equal(internals.navCanBack(), true);

  // 返回一次：回到资料页，连「打开的文件 + 第 3 页 + 筛的课程」一起复原
  const back = internals.navBack();
  assert.equal(back.tab, 'materials');
  assert.equal(internals.readMaterialsUi().openPath, '数据结构/教材/a.pdf');
  assert.equal(internals.readMaterialsUi().openPage, 3);
  assert.equal(internals.readMaterialsUi().courseId, 'c_ds');

  // 再返回一次：回到今日页
  assert.equal(internals.navBack().tab, 'today');
  assert.equal(internals.navCanBack(), false, '到起点就不能再返回');

  // 前进两次：资料页（文件还在）→ 知识点页（选中与筛选还在）
  assert.equal(internals.navCanForward(), true);
  assert.equal(internals.navForward().tab, 'materials');
  assert.equal(internals.readMaterialsUi().openPath, '数据结构/教材/a.pdf');
  const forward = internals.navForward();
  assert.equal(forward.tab, 'knowledge');
  assert.equal(internals.readKnowledgeUi().selected, 'k1');
  assert.equal(internals.readKnowledgeUi().filter, 'marked');

  // 到头了就不能再走，不抛错也不移位
  assert.equal(internals.navForward(), null);
  assert.equal(internals.navCanForward(), false);

  // 坏值：openPage 传 0 / 负数 / 非数字都夹成 null，别把界面卡在「第 null 页」
  internals.readMaterialsUi({ openPath: '', openPage: 0 });
  assert.equal(internals.readMaterialsUi().openPath, null);
  assert.equal(internals.readMaterialsUi().openPage, null);

  // 界面必须真的给出返回/前进与快捷键：读源码断（假渲染器不序列化属性，断不了 title）
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(source.includes("'← 返回'"), '页头要有「← 返回」按钮');
  assert.ok(source.includes("'前进 →'"), '页头要有「前进 →」按钮');
  assert.ok(source.includes('回到上一个位置（Alt+←）'), '返回按钮要有悬停说明');
  assert.ok(/event\.key === 'ArrowLeft'/.test(source), '要支持 Alt+← 快捷键');
  assert.ok(/event\.key === 'ArrowRight'/.test(source), '要支持 Alt+→ 快捷键');
  assert.ok(source.includes('event.altKey !== true'), '快捷键只在按住 Alt 时生效');
  assert.ok(source.includes('key: \`materials-\${navVersion}\`'), '资料页要按 navVersion 重挂载才能复原');
  assert.ok(source.includes('key: \`knowledge-\${navVersion}\`'), '知识点页要按 navVersion 重挂载才能复原');
  assert.ok(source.includes('关上这份正文'), '正文卡要有「关闭」');
  assert.ok(source.includes('收起这个知识点的详情'), '节点卡要有「收起」');
});

test('截止列表必须带科目：主面板「临近截止」与右侧栏「最近截止」都不能只显示任务名', () => {
  // 用户反馈：「临近截止那一栏，不要只有任务名，加上科目信息」。
  // 任务是只存 courseId 的，所以科目名必须现算现渲染 —— 这条把「算出来了」和
  // 「渲染出去了」分开钉住：只算不画同样是没有科目。
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  const labels = ['临近截止', '最近截止'];
  for (const label of labels) {
    assert.ok(source.includes(`'${label}'`), `应存在「${label}」这一栏`);
  }

  // 两处截止列表都要建课程索引（两处各一次 useMemo/常量 + 用到就拿）
  const indexUses = [...source.matchAll(/courseNameIndex\(docs\)/g)].length;
  assert.ok(indexUses >= 2, `两处截止列表都应建立课程索引，实际 ${indexUses} 处`);

  // 科目名必须真的被渲染成元素：subject === '' ? null : h('span', …)
  const rendered = [...source.matchAll(/subject === '' \? null : h\('span'[^)]*\)/g)].length;
  assert.equal(rendered, 2, `两处截止列表都应把科目渲染成独立元素，实际 ${rendered} 处`);

  // 科目那一格不参与伸缩：否则窄容器里被截掉的是科目，用户就白提了这个需求
  assert.ok(/whiteSpace: 'nowrap'/.test(source), '科目那一格必须 whiteSpace: nowrap，避免被伸缩吃掉');
});

test('作业流：只剩一键开工一个写接口，且必须带安全头与任务号', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');

  // 只剩 /homework/spawn 一个写接口，包装里必须带自定义请求头（宿主 writePreflight 认这个头）
  assert.ok(/function homeworkSpawn\(taskId\)/.test(source), '应存在 homeworkSpawn 包装');
  assert.ok(/\[REQUEST_HEADER\]: '1'/.test(source), 'POST 必须带自定义请求头，否则宿主 403');
  assert.ok(/fetch\(`\$\{API\}\/homework\/spawn`/.test(source), '客户端应调用 /homework/spawn');
  assert.ok(/taskId/.test(source), '请求体要带 taskId');

  // 旧的四条接口必须彻底消失：留着就是两条并行的作业流，用户会点错
  for (const pathname of ['/homework/scan', '/homework/split', '/homework/confirm', '/homework/generate']) {
    assert.ok(!source.includes(`'${pathname}'`), `旧的 ${pathname} 应已下线`);
  }
});

test('作业流：详情面板的两个分支（平台有原文 / 拉不到原文）都要给出开工入口', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  const calls = [...source.matchAll(/renderHomeworkSpawnRow\(task, ops\)/g)].length;
  // 一个函数定义 + 两个分支各调用一次 = 3
  assert.equal(calls, 3, `定义一处、两个分支各渲染一处，实际 ${calls} 处`);
  // 入口要写明产物落在哪，否则用户跑完不知道去哪找
  assert.ok(source.includes('答案/'), '应说明产物写入 答案/');
  assert.ok(source.includes('新对话'), '应说明会新开一条对话');
});

test('client.js：讲解三档走一条专用 POST，档位键与服务端一致，错误码翻成人话', { skip: isPhase1 ? '第 1 阶段空骨架，无资料页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const clientSource = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(HERE, '..', 'lib', 'knowledge-explain.js'), 'utf8');

  // 三档键必须与宿主 EXPLAIN_STYLES 完全一致（顺序也一致：先讲透、再速通、最后提示）
  assert.equal(
    JSON.stringify(internals.EXPLAIN_STYLE_OPTIONS.map((item) => item.key)),
    JSON.stringify(['assistant', 'exam', 'hint']),
    '三档键必须与 lib/knowledge-explain.js 对齐',
  );
  assert.equal(JSON.stringify(internals.EXPLAIN_STYLE_OPTIONS.map((item) => item.label)), JSON.stringify(['助教推导', '考前速通', '只给提示']));
  for (const key of ['assistant', 'exam', 'hint']) {
    assert.ok(serverSource.includes(`key: '${key}'`), `服务端应有 ${key} 这一档`);
  }

  // 客户端只发档位键，不拼指令原文（指令留在服务端，改口径不用发客户端）
  assert.ok(/function explainNode\(nodeId, style, options = \{\}\)/.test(clientSource), '应有 explainNode 包装');
  assert.ok(clientSource.includes('/knowledge/explain`'), '应调用 /knowledge/explain');
  assert.ok(/\[REQUEST_HEADER\]: '1'/.test(clientSource), 'POST 必须带自定义请求头，否则宿主 403');
  assert.ok(!clientSource.includes('针对「'), '指令原文不该出现在客户端');

  // 错误码翻人话：429 不该直接把 llm-rate-limit 甩给用户
  assert.equal(typeof internals.explainErrorMessage, 'function', 'client 必须把错误码翻译交给测试');
  assert.ok(internals.explainErrorMessage({ error: 'llm-rate-limit' }).includes('429'));
  assert.ok(internals.explainErrorMessage({ error: 'llm-unavailable' }).includes('没有挂模型'));
  assert.ok(internals.explainErrorMessage({ error: 'llm-timeout' }).includes('超时'));
  assert.ok(internals.explainErrorMessage({ error: 'bad-style' }).includes('档位'));
  const withDetail = internals.explainErrorMessage({ error: 'llm-rate-limit', detail: '429 too many requests' });
  assert.ok(withDetail.includes('429 too many requests'), '上游原文要带上，否则用户没法判断是哪种 429');

  // 面板上三个按钮 + 重新生成：不给「重新生成」就只能等缓存过期
  for (const label of ['助教推导', '考前速通', '只给提示', '重新生成']) {
    assert.ok(clientSource.includes(`'${label}'`), `面板应有「${label}」`);
  }
  assert.ok(clientSource.includes('讲解缓存'), '要说明结果落在 学习台/讲解缓存/');

  // 批量生成一章（2026-10-21 夜第三段）：串行、只补缺的、进度可见
  assert.ok(clientSource.includes('生成缺的'), '章头批量按钮要写明「生成缺的 N 份」');
  assert.ok(clientSource.includes('串行生成'), '要说明是串行跑，避免用户以为卡住');
  assert.ok(/const runChapterBatch = async \(group\) =>/.test(clientSource), '批量入口应是 runChapterBatch');
  assert.ok(clientSource.includes('这一章都已生成'), '整章都生成过时要给明确结论，而不是禁用按钮让人猜');
});

test('client.js：设置页有数据备份与生成记录，打印只印当前页签', { skip: isPhase1 ? '第 1 阶段空骨架，无设置页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const { renderToStaticMarkup } = createFakeServer();
  const clientSource = fs.readFileSync(CLIENT_FILE, 'utf8');

  assert.equal(typeof internals.settingsTab, 'function', 'client 必须把设置页交给测试');
  assert.equal(typeof internals.exportBackup, 'function', '导出走 exportBackup');
  assert.equal(typeof internals.restoreBackup, 'function', '恢复走 restoreBackup');

  const docs = {
    term: { terms: [] },
    courses: { courses: [{ id: 'c_dg', name: '数字电子技术基础' }] },
    homework: {
      records: [
        { id: 'h1', courseId: 'c_dg', title: '第01次作业_原题', model: { at: '2026-10-19T14:53:36.264Z', provider: 'p', model: 'DeepSeek-V4.1-Flash-1017' } },
        { id: 'h2', courseId: 'c_dg', title: '第02次作业_原题', model: null },
      ],
    },
    knowledgeNetwork: { nodes: [{ id: 'k1' }, { id: 'k2' }], updatedAt: '2026-10-21T04:00:00.000Z' },
    // 第四处来源（2026-10-24）：分析流水线写了哪些批次进来
    knowledgeAnalysis: {
      courses: [{ courseId: 'c_dg', points: [{ id: 'p1' }, { id: 'p2' }] }],
      runs: [
        { id: 'r1', at: '2026-10-23T22:10:00+08:00', courseId: 'c_dg', kind: 'textbook-points', unit: '第 2 章 逻辑代数', model: 'DeepSeek-V4.1-Flash-1017', points: 2, chars: 1800, ok: true },
        { id: 'r2', at: '2026-10-23T23:40:00+08:00', courseId: 'c_dg', kind: 'ppt-points', unit: '第 1–3 讲', model: 'DeepSeek-V4.1-Flash-1017', points: 0, ok: false },
      ],
    },
  };
  const settings = renderToStaticMarkup({ __el: true, type: internals.settingsTab, props: { docs }, children: [] });

  // 数据备份卡：导出 + 选文件恢复 + 说明「覆盖同名文档、写前自动备份」
  assert.ok(settings.includes('数据备份'), '设置页要有「数据备份」卡');
  assert.ok(settings.includes('导出全部数据'), '要有导出按钮');
  assert.ok(settings.includes('选择备份文件恢复'), '要有恢复入口');
  assert.ok(settings.includes('覆盖同名文档'), '要说明恢复会覆盖同名文档');
  assert.ok(settings.includes('学习台/备份'), '要说明写前自动进备份目录');

  // 生成记录卡：三源都要出现在界面上
  assert.ok(settings.includes('生成记录'), '设置页要有「生成记录」卡');
  assert.ok(settings.includes('作业分题'), '第一源：作业.json 的分题记录');
  assert.ok(settings.includes('DeepSeek-V4.1-Flash-1017'), '有模型记录的条目要显示模型名');
  assert.ok(settings.includes('未记录模型'), '没有模型记录的条目要明说「未记录模型」，不能留空');
  assert.ok(settings.includes('知识点讲解'), '第二源：讲解缓存');
  assert.ok(settings.includes('知识网络'), '第三源：知识点网络的更新时间');
  assert.ok(settings.includes('2 个节点'), '要显示节点数');
  // 第四源（2026-10-24）：教材/PPT/作业的分析批次要能看到「跑了哪批、出了多少点、什么模型、什么时候」
  assert.ok(settings.includes('资料分析（资料分析.json）'), '第四源：分析流水线的批次记录');
  assert.ok(settings.includes('2 个批次'), '要报批次总数');
  assert.ok(settings.includes('2 个知识点详解'), '要报已生成的知识点详解总数');
  assert.ok(settings.includes('textbook-points'), '每条批次要显示 kind');
  assert.ok(settings.includes('第 2 章 逻辑代数'), '每条批次要显示单元');
  assert.ok(settings.includes('0 点'), '失败批次的点数也要照实显示（0 点）');
  // 失败批次标红只能查源码：这里的假渲染器只吐标签名，拿不到 className
  assert.ok(clientSource.includes("run?.ok === false ? 'sa-error'"), '失败的批次要标红，不能和成功的一样显示');
  // 批次可展开（2026-10-24 夜）：note 与失败原因默认折叠，点开才看得到
  assert.ok(settings.includes('▸'), '批次行默认收起，要有 ▸ 提示能点开');
  assert.ok(settings.includes('其中 1 个失败'), '有失败批次时抬头要直接报个数，不能只标红');
  assert.ok(clientSource.includes('setOpenRun'), '批次行点击要能展开/收起');
  assert.ok(clientSource.includes('批次 id：'), '展开后要能看到批次 id（报告里对照用）');
  assert.ok(clientSource.includes('这一批做了什么'), '展开后要能看到 note');
  assert.ok(clientSource.includes('失败原因：'), '失败批次展开后要说清楚为什么失败');
  assert.ok(!settings.includes('undefined'), `设置页不应渲染出 undefined：${settings.slice(0, 400)}`);

  // 打印：页头一颗按钮 + @media print 只留当前页签内容
  assert.ok(clientSource.includes("onClick: () => window.print()"), '页头要有「打印」按钮');
  assert.ok(clientSource.includes('@media print'), 'CSS 必须有打印规则');
  assert.ok(/@media print\{[\s\S]*?\.sa-tabs,[^{]*\{display:none !important\}/.test(clientSource), '打印时要藏掉页签栏/按钮/输入框');
  assert.ok(/@media print\{[\s\S]*?\.sa-kg-wrap\{max-height:none !important/.test(clientSource), '打印时知识画布要整块展开，不能留滚动条');
  assert.ok(/@media print\{[\s\S]*?break-inside:avoid/.test(clientSource), '卡片不要跨页断开');

  // 恢复请求必须带自定义头，否则宿主 403
  assert.ok(/async function restoreBackup\(bundle\)/.test(clientSource), '恢复应有 restoreBackup 包装');
  assert.ok(clientSource.includes('/backup/restore`'), '恢复要打到 /backup/restore');
  assert.ok(clientSource.includes('/backup/export`'), '导出要打到 /backup/export');
});

test('client.js：今日页显示待复习知识点，点「去复习」跳到知识点页的待复习筛选', { skip: isPhase1 ? '第 1 阶段空骨架，无今日页' : false }, () => {
  const { half } = loadClient();
  const internals = half.DESCRIPTORS.internals;
  const { renderToStaticMarkup } = createFakeServer();
  assert.equal(typeof internals.todayTab, 'function', 'client 必须把今日页交给测试');

  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date();
  const docs = {
    term: { currentId: 't1', terms: [{ id: 't1', name: '2026 秋', startDate: '2026-09-14', weeks: 16 }] },
    courses: { courses: [{ id: 'c_dg', name: '数电' }] },
    tasks: { tasks: [] },
    grades: { grades: [] },
    knowledgeNetwork: {
      nodes: [
        { id: 'k1', name: '卡诺图', courseId: 'c_dg', chapter: '第 1 章', mastery: 1, marked: true, reviewedAt: old, createdAt: old },
        { id: 'k2', name: '逻辑代数', courseId: 'c_dg', chapter: '第 1 章', mastery: 3, marked: false, reviewedAt: old, createdAt: old },
      ],
    },
  };
  const html = renderToStaticMarkup({ __el: true, type: internals.todayTab, props: { docs, now, refresh: () => {}, onOpenKnowledgeReview: () => {} } });

  assert.ok(html.includes('待复习知识点'), '今日页要有「待复习知识点」卡');
  assert.ok(html.includes('卡诺图'), '到期的节点要显示出来');
  assert.ok(!html.includes('逻辑代数'), '掌握度到「精通」的不进待复习队列');
  assert.ok(html.includes('去复习'), '有到期节点时给「去复习」入口');
  // 详解进度（2026-10-24 傍晚）：分析线一批批写，第一屏就该看到「写了几个 / 一共几个」
  assert.ok(html.includes('知识点详解进度'), '今日页要有「知识点详解进度」卡');
  assert.ok(html.includes('0 / 2'), '没有分析产物时进度是 0 / 2（两个节点）');
  assert.ok(html.includes('还有 2 个知识点没有详解'), '还没写的数量要说出来，并指给分析线看');

  // 空态：没有到期节点时给规则说明，而不是一片空白
  const emptyHtml = renderToStaticMarkup({
    __el: true,
    type: internals.todayTab,
    props: { docs: { ...docs, knowledgeNetwork: { nodes: [] } }, now, refresh: () => {} },
  });
  assert.ok(emptyHtml.includes('没有到期的知识点'), '空态要解释规则');

  // 联动的落点：点「去复习」= kpFocus {filter:'due'}，知识点页的 focus 分支要认这个键
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(source.includes("setKpFocus({ filter: 'due' })"), '「去复习」要把待复习筛选交给知识点页');
  assert.ok(source.includes("setKpFocus({ filter: 'noanalysis' })"), '「去写没写的」要把「没详解」筛选交给知识点页');
  assert.ok(/KP_UI_FILTERS\.includes\(wantedFilter\)/.test(source), '知识点页的 focus 分支要认 filter');

  // 空队列要能自证「规则在跑」：算出下一批到期时刻，写进卡片的空态里
  const fresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(typeof internals.nextReviewDueAt, 'function', 'client 要导出下一批到期时刻的纯函数');
  // 复习回声（2026-10-22 深夜）：近 7 天复习过几个
  assert.equal(typeof internals.countReviewedWithin, 'function', 'client 要导出「近 7 天复习数」的纯函数');
  assert.equal(internals.countReviewedWithin([], now.getTime()), 0, '空表回 0');
  assert.equal(
    internals.countReviewedWithin([
      { id: 'a', reviewedAt: new Date(now.getTime() - 86400000).toISOString() },
      { id: 'b', reviewedAt: new Date(now.getTime() - 30 * 86400000).toISOString() },
      { id: 'c' },
      { id: 'd', reviewedAt: new Date(now.getTime() + 3600000).toISOString() },
    ], now.getTime()),
    1,
    '只数窗口内的：昨天算、30 天前不算、没 reviewedAt 不算、未来时间不算',
  );
  const laterHtml = renderToStaticMarkup({
    __el: true,
    type: internals.todayTab,
    props: {
      docs: { ...docs, knowledgeNetwork: { nodes: [{ id: 'k3', name: '刚建的点', courseId: 'c_dg', mastery: 1, marked: false, createdAt: fresh }] } },
      now,
      refresh: () => {},
      onOpenKnowledgeReview: () => {},
    },
  });
  assert.ok(laterHtml.includes('下一批'), '空队列时要写「下一批 … 到期」，不能只说「没有到期的」');
  assert.ok(!laterHtml.includes('undefined'), '日期不能渲染成 undefined');

  // 纯函数边界：精通不算、刚建的不算到期、算不出起点的当已到期、空表回 null
  assert.equal(internals.nextReviewDueAt([{ id: 'a', mastery: 3, createdAt: fresh }], now.getTime()), null, '精通不进下一批');
  assert.equal(internals.nextReviewDueAt([], now.getTime()), null, '空表回 null');
  assert.equal(internals.nextReviewDueAt([{ id: 'b', mastery: 1 }], now.getTime()), null, '没有时间字段的按已到期处理');
  const oneDay = internals.nextReviewDueAt([{ id: 'c', mastery: 1, createdAt: fresh }], now.getTime());
  assert.ok(oneDay > now.getTime() && oneDay <= now.getTime() + 7 * 24 * 60 * 60 * 1000, '刚落过的点要在 7 天内到期');
});



test('mind map: full outline hierarchy, no collapsed overlap, course-specific expansion', () => {
  const {half}=loadClient();const lib=half.DESCRIPTORS.internals;
  const rows=[{id:'a',name:'A very long knowledge point with enough text to wrap onto multiple lines',courseId:'a',chapter:'第1章 基础',section:'1.1',subsection:'1.1.1'},
    {id:'b',name:'Section level point',courseId:'a',chapter:'第1章 基础',section:'1.1'},
    {id:'c',name:'Another course',courseId:'b',chapter:'第1章 基础',section:'1.1'}];
  const outline={courses:[{courseId:'a',chapters:[{no:1,title:'基础',sections:[{no:'1.1',title:'第一节',subs:[{no:'1.1.1',title:'第一小节'}]}]}]}]};
  const all=lib.buildMindMap(rows,{course:id=>id},{outline,expanded:null});
  const byKey=new Map(all.nodes.map(x=>[x.key,x]));
  const parent=n=>byKey.get(all.links.find(l=>l.to===n.key)?.from);
  const a=all.nodes.find(x=>x.id==='a'),b=all.nodes.find(x=>x.id==='b');
  assert.equal(parent(a).kind,'sub');assert.equal(parent(parent(a)).kind,'section');
  assert.equal(parent(b).kind,'group','Preserve section-level grouping introduced by previous work');
  assert.equal(all.points,3);assert.ok(a.lines.length>1);
  for(const n of all.nodes){assert.ok(n.x>=0 && n.y-n.height/2>=0);assert.ok(n.x+n.width<=all.width);assert.ok(n.y+n.height/2<=all.height);}
  for(const n of all.nodes){for(const m of all.nodes){if(n.key===m.key||n.depth!==m.depth)continue;assert.ok(Math.abs(n.y-m.y)>=(n.height+m.height)/2,'No overlapping boxes at any level');}}
  const folded=lib.buildMindMap(rows,{course:id=>id},{outline,expanded:[]});
  const chapters=folded.nodes.filter(n=>n.kind==='chapter');assert.equal(chapters.length,2);assert.notEqual(chapters[0].y,chapters[1].y);
  const first=lib.buildMindMap(rows,{course:id=>id},{outline,expanded:[chapters[0].key]});
  assert.equal(first.points,0);assert.equal(first.collapsed,1);assert.ok(first.nodes.filter(n=>n.kind==='section').every(n=>!n.open));
  assert.equal(lib.resetKnowledgeUi().view,'mind');
  const {renderToStaticMarkup}=createFakeServer();
  const html=renderToStaticMarkup({__el:true,type:lib.knowledgeTab,props:{docs:{knowledgeNetwork:{nodes:rows},knowledgeOutline:outline}},children:[]});
  assert.ok(html.includes('展开完整导图'));assert.ok(html.includes('选一个知识点开始阅读'));
});


test('subject tree: independent defaults, course roots and immutable memory snapshots', () => {
 const {half}=loadClient(),lib=half.DESCRIPTORS.internals;
 const data=[{id:'a1',courseId:'a',name:'A point',chapter:'第1章 Intro',section:'1.1'},
 {id:'b1',courseId:'b',name:'B point',chapter:'第1章 Intro',section:'1.1'}];
 let memory={};const fresh=lib.subjectTreeState(memory,'a');
 assert.equal(JSON.stringify(fresh.mindOpen),'[]');assert.equal(JSON.stringify(fresh.openTree),JSON.stringify(['course:a']));
 memory=lib.patchSubjectTree(memory,'a',{mindOpen:['mind:chapter:a|第1章 Intro'],openTree:['course:a','chapter:a|第1章 Intro'],scroll:{mind:{left:140,top:310}}});
 const first=memory;memory=lib.patchSubjectTree(memory,'b',{mindOpen:['mind:chapter:b|第1章 Intro'],scroll:{tree:{left:5,top:80}}});
 assert.equal(lib.subjectTreeState(memory,'a').scroll.mind.top,310);assert.equal(lib.subjectTreeState(memory,'b').scroll.mind.top,0);
 assert.equal(lib.subjectTreeState(memory,'b').scroll.tree.top,80);assert.equal(Object.keys(first).length,1);
 const cold=lib.buildMindMap(data,{course:id=>'Course '+id},{courseRoot:true,courseId:'a',expanded:[]});
 assert.equal(cold.nodes.filter(n=>n.depth===0).length,1);assert.equal(cold.nodes[0].kind,'course');assert.equal(cold.points,0);
 assert.equal(cold.nodes.some(n=>n.kind==='root'||n.id==='b1'),false);
 const open=lib.buildMindMap(data,{course:id=>id},{courseRoot:true,courseId:'a',expanded:null});
 assert.equal(open.points,1);assert.equal(open.nodes.find(n=>n.kind==='point').id,'a1');
 lib.readKnowledgeUi({treeCourseId:'a',subjectTrees:memory});const snapshot=lib.navSnapshot('knowledge');
 lib.readKnowledgeUi({subjectTrees:lib.patchSubjectTree(memory,'a',{mindOpen:[]})});
 assert.equal(snapshot.knowledge.subjectTrees.a.mindOpen.length,1);
 const invalid=lib.subjectTreeState({a:{mindOpen:[3,'x'],scroll:{mind:{left:-1,top:Infinity}}}},'a');
 assert.equal(JSON.stringify(invalid.mindOpen),JSON.stringify(['x']));assert.equal(invalid.scroll.mind.left,0);assert.equal(invalid.scroll.mind.top,0);
 assert.equal(lib.knowledgeTreeCourses([null,...data],{},[{id:'a',name:'A'},{id:'unused',name:'Unused'}]).length,3);
});

test('subject tree: A to B to A restores both views and clears cross-course details', () => {
 const cells=[];let cursor=0;const base=createFakeReact();
 const react={...base,useState(initial){const i=cursor++;if(!cells[i])cells[i]={value:typeof initial==='function'?initial():initial};return [cells[i].value,value=>{cells[i].value=typeof value==='function'?value(cells[i].value):value;}];},
 useRef(value){const i=cursor++;if(!cells[i])cells[i]={current:value};return cells[i];},useCallback(fn){cursor++;return fn;}};
 const {half}=loadClient({react}),lib=half.DESCRIPTORS.internals;
 const docs={courses:{courses:[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}]},knowledgeNetwork:{nodes:[
 {id:'a1',name:'Alpha only leaf',courseId:'a',chapter:'第1章 A',section:'1.1'},
 {id:'b1',name:'Beta only leaf',courseId:'b',chapter:'第1章 B',section:'1.1'}]}};
 function render(){cursor=0;const tree=lib.knowledgeTab({docs});const flat=[];const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;flat.push(n);(n.children||[]).forEach(walk);};walk(tree);return flat;}
 const text=n=>(n.children||[]).filter(x=>typeof x==='string').join('');
 const select=flat=>flat.find(n=>n.props?.['aria-label']==='选择学科树');
 const box=flat=>flat.find(n=>n.props?.['data-tree-course']);
 const chapter=flat=>flat.find(n=>n.type==='g'&&typeof n.props?.['aria-expanded']==='boolean');
 function full(){let f=render();const button=f.find(n=>n.type==='button'&&(text(n)==='展开完整导图'||text(n)==='展开完整目录'));if(button){button.props.onClick();f=render();}return f;}
 let f=full();assert.equal(select(f).props.value,'a');assert.equal(chapter(f).props['aria-expanded'],false);
 chapter(f).props.onClick();f=render();assert.equal(chapter(f).props['aria-expanded'],true);
 box(f).props.onScroll({currentTarget:{scrollLeft:130,scrollTop:270}});
 select(f).props.onChange({target:{value:'b'}});f=full();assert.equal(select(f).props.value,'b');assert.equal(chapter(f).props['aria-expanded'],false);
 let dom={scrollLeft:999,scrollTop:999};box(f).props.ref(dom);assert.equal(dom.scrollLeft,0);assert.equal(dom.scrollTop,0);
 box(f).props.onScroll({currentTarget:{scrollLeft:7,scrollTop:80}});
 select(f).props.onChange({target:{value:'a'}});f=full();assert.equal(chapter(f).props['aria-expanded'],true);
 dom={scrollLeft:0,scrollTop:0};box(f).props.ref(dom);assert.equal(dom.scrollLeft,130);assert.equal(dom.scrollTop,270);
 f.find(n=>n.type==='g'&&n.props?.['aria-label']==='1.1').props.onClick();f=render();
 const leaf=f.find(n=>n.type==='g'&&n.props?.['aria-label']==='Alpha only leaf');leaf.props.onClick();f=render();assert.ok(f.some(n=>n.props?.id==='sa-kp-detail'));
 select(f).props.onChange({target:{value:'b'}});f=render();assert.equal(f.some(n=>n.props?.id==='sa-kp-detail'),false);
 f.find(n=>n.type==='button'&&text(n)==='目录树').props.onClick();f=render();assert.equal(box(f).props['data-tree-course'],'b');
 box(f).props.onScroll({currentTarget:{scrollLeft:3,scrollTop:46}});
 select(f).props.onChange({target:{value:'a'}});f=render();dom={scrollLeft:9,scrollTop:9};box(f).props.ref(dom);assert.equal(dom.scrollTop,0);
 select(f).props.onChange({target:{value:'b'}});f=render();dom={scrollLeft:0,scrollTop:0};box(f).props.ref(dom);assert.equal(dom.scrollTop,46);
 assert.equal(lib.readKnowledgeUi().subjectTrees.a.scroll.mind.top,270);
});

test('详解渲染：**粗体**、行内代码、$公式$ 不再原样露出，块级标题与列表各自成块', () => {
  const { half } = loadClient();
  const lib = half.DESCRIPTORS.internals;
  const textOf = (node) => (typeof node === 'string' ? node : (node.children || []).map(textOf).join(''));
  // 行内：原文里的三种轻量标记都要变成元素，普通文字仍是字符串
  const inline = lib.analysisInline('用 **单极型** 器件，栅极电压 `v_GS` 决定 $I_D$ 的大小', 'k0');
  assert.equal(inline.map((node) => (typeof node === 'string' ? 'text' : node.type)).join('|'), 'text|strong|text|code|text|span|text');
  assert.equal(textOf(inline[1]), '单极型');
  assert.equal(textOf(inline[3]), 'v_GS');
  assert.equal(textOf(inline[5]), 'ID');
  assert.equal(inline[0], '用 ');
  // 没有标记时不许造元素（否则纯文本讲解会被拆成碎片）
  assert.equal(lib.analysisInline('一段没有标记的话', 'k1').join('|'), '一段没有标记的话');

  // 块级：`### 标题` → 加粗 div；`- ` 连续行 → ul/li；普通段 → p 且保留 pre-wrap
  const blocks = lib.analysisBlockNodes('### 一、结构\n\nT1 与 T2 串联，栅极并接 v_I。\n\n- 上管 P 沟道增强型\n- 下管 N 沟道增强型', 'b');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'div');
  assert.ok(textOf(blocks[0]).includes('一、结构'));
  assert.equal(blocks[1].type, 'p');
  assert.equal(blocks[1].props.style.whiteSpace, 'pre-wrap');
  assert.equal(blocks[2].type, 'ul');
  assert.equal(blocks[2].children.length, 2);
  assert.equal(blocks[2].children[0].type, 'li');
  assert.equal(textOf(blocks[2].children[1]), '下管 N 沟道增强型');
  assert.equal(lib.analysisBlockNodes('   ', 'b').length, 0, '空白不该渲染出一个空段');

  // 斜体：单个 `*…*` 不能吞掉 `**粗体**`，也不能把正文里的乘号当斜体
  assert.equal(lib.analysisInline('只有 *这一处* 强调', 'k2').map((node) => (typeof node === 'string' ? 'text' : node.type)).join('|'), 'text|em|text');
  assert.equal(textOf(lib.analysisInline('只有 *这一处* 强调', 'k2')[1]), '这一处');

  // 表格：整段竖线行 → 外层可横向滚动的 div + table + thead/tbody，分隔行不显示
  const table = lib.analysisBlockNodes('| A | Y |\n|---|---|\n| 0 | 1 |\n| 1 | 0 |', 't');
  assert.equal(table.length, 1);
  assert.equal(table[0].children[0].type, 'table');
  const thead = table[0].children[0].children[0];
  const tbody = table[0].children[0].children[1];
  assert.equal(thead.type, 'thead');
  assert.equal(thead.children[0].children.length, 2, '表头两列');
  assert.equal(tbody.type, 'tbody');
  assert.equal(tbody.children.length, 2, '真值表两行数据');
  assert.equal(textOf(tbody.children[1].children[1]), '0');

  // 列表与正文混排：顺序不能乱（正文段在前、列表在后）
  const mixed = lib.analysisBlockNodes('说明一句\n- 甲\n- 乙', 'm');
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].type, 'p');
  assert.equal(mixed[1].type, 'ul');
  assert.equal(textOf(mixed[1].children[0]), '甲');
  // 数字序号 → ol（生成侧写「1. 2. 3.」时不再原样露出）
  const ordered = lib.analysisBlockNodes('1. 第一步\n2. 第二步', 'o');
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].type, 'ol');
  assert.equal(ordered[0].children.length, 2);

  // 接线检查：详解里的插图必须走白名单路由（不是 data: 也不是本地路径）
  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(source.includes('/materials/image?path='), '插图要经 /materials/image 取字节');
  assert.ok(source.includes('selectedPoint.figures'), '详解要读 point.figures');
});

test('公式排版：formulas[].tex 与行内 $…$ 都转成符号，界面不再露出 LaTeX 源码', () => {
  const { half } = loadClient();
  const lib = half.DESCRIPTORS.internals;
  const textOf = (node) => (typeof node === 'string' ? node : (node.children || []).map(textOf).join(''));
  const flat = (nodes) => nodes.map((node) => textOf(node)).join('');

  // 用户报的那串，就是 c_digital §3.3 点 k_aa054c6a3c 的 formulas[1].tex
  const tex = 'v_I=V_{IL} \\Rightarrow V_{OH}\\approx V_{DD};\\quad v_I=V_{IH} \\Rightarrow V_{OL}\\approx 0';
  const nodes = lib.latexNodes(tex, 'f0');
  const text = flat(nodes);
  assert.ok(!text.includes('\\'), `不许露出反斜杠：${text}`);
  assert.ok(!text.includes('{') && !text.includes('}'), `不许露出花括号：${text}`);
  assert.ok(text.includes('⇒') && text.includes('≈'), `关系符要换成字符：${text}`);
  assert.ok(text.includes('DD') && text.includes('OL'), `下标内容要保留：${text}`);
  // 下标是真的 <sub>，不是下划线文字
  const subs = nodes.filter((node) => typeof node !== 'string' && node.type === 'sub');
  assert.equal(subs.length >= 4, true, '四处下标都要变成 <sub>');
  assert.equal(subs.map(textOf).join(','), 'I,IL,OH,DD,I,IH,OL');

  // 分式上下叠：inline-flex 两行（分子 + 分母）
  const frac = lib.latexNodes('\\frac{V_{DD}-V_{DS}}{I_D}', 'f1');
  const fracBox = frac.find((node) => typeof node !== 'string' && node.props?.style?.display === 'inline-flex');
  assert.ok(fracBox, '分式要竖排');
  assert.equal(fracBox.children.length, 2);
  assert.equal(textOf(fracBox.children[1]), 'ID');

  // 根号、粗体数学、黑板体、希腊字母
  assert.equal(flat(lib.latexNodes('\\sqrt{x^2+y^2}', 'f2')).startsWith('√'), true);
  assert.equal(typeof lib.latexNodes('\\mathbf{R}_1', 'f3')[0], 'object');
  assert.equal(flat(lib.latexNodes('\\mathbb{R}', 'f4')), 'ℝ');
  assert.equal(flat(lib.latexNodes('\\varepsilon_{ox}', 'f5')), 'εox');

  // 认不出的命令：只留名字，反斜杠不许外露
  const unknown = flat(lib.latexNodes('\\foo{x}+1', 'f6'));
  assert.ok(!unknown.includes('\\'), unknown);
  assert.ok(unknown.includes('foo'), unknown);

  // 行内 $…$ 走同一套排版（真实数据里的 `S[\text{lo}, \text{hi})`）
  const inline = lib.analysisInline('区间写成 $S[\\text{lo}, \\text{hi})$ 就行', 'k');
  const inlineText = textOf({ children: inline });
  assert.ok(!inlineText.includes('\\') && !inlineText.includes('$'), inlineText);
  assert.equal(inlineText, '区间写成 S[lo, hi) 就行');

  // 卡片：先排好的式子、再一句人话；tex 为空时只剩人话
  const card = lib.formulaCard({ tex: '\\frac{1}{2}mV^2', plain: '动能' }, 0);
  assert.equal(card.props.className, 'sa-formula');
  assert.equal(textOf(card.children[1]), '动能');
  const plainOnly = lib.formulaCard({ tex: '', plain: '只有人话' }, 1);
  assert.equal(plainOnly.children.length, 1);

  // 环境（真实数据里 15 处 `\begin{cases}`）：不排版，但也不许把环境名印出来
  const env = flat(lib.latexNodes('f=\\begin{cases} x & x>0 \\\\ 0 & x\\le 0 \\end{cases}', 'f7'));
  assert.ok(!env.includes('cases'), `环境名不许外露：${env}`);
  assert.ok(env.includes('x>0') && /x≤\s*0/u.test(env), `环境里的内容要保留：${env}`);

  // 教材 OCR 的公式编号 `\tag{12.11}`（2026-10-27 晚）：以前会印成「tag12.11」
  const tagged = flat(lib.latexNodes('E=\\int\\mathrm{d}E\\tag{12.11}', 'f8'));
  assert.ok(!/tag/iu.test(tagged.replace(/\\(?:ta|ag)/gu, '')), `编号关键字不许外露：${tagged}`);
  assert.ok(tagged.includes('12.11'), `编号数字要保留：${tagged}`);
});

test('material preview: 教材页正文按「排版」读，页眉/分隔线丢掉、公式真排版', () => {
  const test = statefulClient();
  const lib = test.half.DESCRIPTORS.internals;
  assert.equal(typeof lib.materialPreviewNodes, 'function', 'client 要把材料页排版导出给测试用');

  const body = [
    '# 第 30 页',
    '式中，$r$ 是电荷元 $\\mathrm{d}q$ 到 $P$ 的距离。',
    '',
    '$$\\boldsymbol{E}=\\int\\mathrm{d}\\boldsymbol{E}$$',
    '$$\\tag{12.11}$$',
    '---',
    '### 例 12.3',
    '求电偶极子中垂线上任一点的电场强度。',
  ].join('\n');
  const nodes = lib.materialPreviewNodes(body, 'mp');
  assert.ok(Array.isArray(nodes) && nodes.length > 0, '要排出版式节点');
  const flat = (function walk(list, out) {
    for (const item of list) {
      if (item === null || item === undefined || item === false) continue;
      if (typeof item === 'string' || typeof item === 'number') { out.push(String(item)); continue; }
      if (Array.isArray(item)) { walk(item, out); continue; }
      walk(item.children ?? [], out);
    }
    return out.join('');
  })(nodes, []);
  // 页眉 `# 第 30 页` 与 `---` 都不该印出来
  assert.ok(!flat.includes('第 30 页'), `页眉要丢掉：${flat}`);
  assert.ok(!flat.includes('---'), `分隔线要丢掉：${flat}`);
  // 行内单字母公式 `$r$` 不许露 `$`，整段公式不许露反斜杠命令
  assert.ok(!flat.includes('$'), `行内公式要排版：${flat}`);
  assert.ok(!/\\[A-Za-z]+/u.test(flat), `不许露 LaTeX 源码：${flat}`);
  assert.ok(flat.includes('例 12.3'), `小标题文字要保留：${flat}`);
  assert.ok(flat.includes('电荷元'), `正文要保留：${flat}`);
});

test('split reader: compact selection and full-map return preserve the navigator',()=>{
 const test=statefulClient(),lib=test.half.DESCRIPTORS.internals;
 const docs={courses:{courses:[{id:'a',name:'Alpha'}]},knowledgeNetwork:{nodes:[{id:'a1',courseId:'a',chapter:'第1章 A',section:'1.1',name:'First point'},{id:'a2',courseId:'a',chapter:'第1章 A',section:'1.1',name:'Second point'}]}};
 const text=n=>(n.children||[]).filter(x=>typeof x==='string').join('');
 lib.readKnowledgeUi({treeCourseId:'a',subjectTrees:lib.patchSubjectTree({},'a',{openTree:['course:a','chapter:a|第1章 A','section:a|第1章 A|1.1']})});
 function render(){test.begin();return test.flat(lib.knowledgeTab({docs}));}
 let f=render();assert.ok(f.some(n=>n.props?.className==='sa-card sa-reader-empty'));
 f.find(n=>n.props?.className==='sa-compact-scroll').props.onScroll({currentTarget:{scrollLeft:0,scrollTop:120}});
 f.find(n=>n.type==='button'&&n.props?.title==='First point').props.onClick();f=render();
 assert.equal(f.find(n=>n.props?.className==='sa-learning-layout').props['data-browser-collapsed'],'true');
 assert.ok(f.some(n=>n.props?.id==='sa-kp-detail'));
 f.find(n=>n.type==='button'&&text(n)==='更换知识点').props.onClick();f=render();
 assert.equal(f.find(n=>n.props?.className==='sa-learning-layout').props['data-browser-collapsed'],'false');
 f.find(n=>n.type==='button'&&text(n)==='展开完整导图').props.onClick();f=render();
 assert.equal(f.find(n=>n.props?.className==='sa-learning-layout').props['data-full-browser'],'true');
 f.find(n=>n.type==='g'&&typeof n.props?.['aria-expanded']==='boolean').props.onClick();f=render();
 f.find(n=>n.type==='g'&&n.props?.['aria-label']==='1.1').props.onClick();f=render();
 f.find(n=>n.type==='g'&&n.props?.['aria-label']==='Second point').props.onClick();f=render();
 assert.equal(f.find(n=>n.props?.className==='sa-learning-layout').props['data-full-browser'],'false');
 assert.ok(f.some(n=>n.type==='h3'&&text(n)==='Second point'));
 const dom={scrollLeft:0,scrollTop:0};f.find(n=>n.props?.className==='sa-compact-scroll').props.ref(dom);assert.equal(dom.scrollTop,120);
 f.find(n=>n.type==='button'&&text(n)==='收起').props.onClick();f=render();
 assert.equal(f.some(n=>n.props?.id==='sa-kp-detail'),false);
 assert.equal(f.find(n=>n.props?.className==='sa-learning-layout').props['data-browser-collapsed'],'false');
 const source=fs.readFileSync(CLIENT_FILE,'utf8');assert.ok(source.includes('if (focusReading && readerRef.current) readerRef.current.scrollTop = 0;'));
});

test('progressive tree: chapter, section and subsection require their own expansion',()=>{
 const {half}=loadClient(),lib=half.DESCRIPTORS.internals;
 const nodes=[{id:'p',name:'Leaf',courseId:'a',chapter:'第1章 Test',section:'1.1',subsection:'1.1.1'}];
 const outline={courses:[{courseId:'a',chapters:[{no:1,title:'Test',sections:[{no:'1.1',title:'Section',subs:[{no:'1.1.1',title:'Subsection'}]}]}]}]};
 const options={outline,courseRoot:true,courseId:'a'};
 let m=lib.buildMindMap(nodes,{}, {...options,expanded:[]});const chapter=m.nodes.find(n=>n.kind==='chapter');
 m=lib.buildMindMap(nodes,{}, {...options,expanded:[chapter.key]});const section=m.nodes.find(n=>n.kind==='section');assert.equal(section.open,false);assert.equal(m.points,0);assert.equal(m.nodes.some(n=>n.kind==='sub'),false);
 m=lib.buildMindMap(nodes,{}, {...options,expanded:[chapter.key,section.key]});const sub=m.nodes.find(n=>n.kind==='sub');assert.equal(sub.open,false);assert.equal(m.points,0);
 m=lib.buildMindMap(nodes,{}, {...options,expanded:[chapter.key,section.key,sub.key]});assert.equal(m.points,1);
 m=lib.buildMindMap(nodes,{}, {...options,expanded:[]});assert.equal(m.nodes.some(n=>n.kind==='section'),false);
});
test('mind zoom: fit, clamp, SVG geometry and per-course restoration',()=>{
 const probe=statefulClient(),lib=probe.half.DESCRIPTORS.internals;
 assert.equal(lib.clampMindZoom(NaN),1);assert.equal(lib.clampMindZoom(20),2);assert.equal(lib.clampMindZoom(0.00001),0.001);
 assert.equal(lib.fitMindZoom(1000,2000,524,1024),0.5);assert.equal(lib.fitMindZoom(0,0,500,500),1);assert.ok(32874*lib.fitMindZoom(1210,32874,300,100)<=100);
 const docs={courses:{courses:[{id:'a',name:'A'},{id:'b',name:'B'}]},knowledgeNetwork:{nodes:[{id:'a1',name:'A leaf',courseId:'a',chapter:'第1章 A',section:'1.1'},{id:'b1',name:'B leaf',courseId:'b',chapter:'第1章 B',section:'1.1'}]}};
 const text=n=>(n.children||[]).filter(x=>typeof x==='string').join('');
 function render(){probe.begin();return probe.flat(lib.knowledgeTab({docs}));}
 function full(){let f=render();const b=f.find(n=>n.type==='button'&&text(n)==='展开完整导图');if(b){b.props.onClick();f=render();}return f;}
 let f=full(),svg=f.find(n=>n.type==='svg'),w=svg.props.width;assert.ok(svg.props.viewBox);
 f.find(n=>n.props?.['aria-label']==='缩小导图').props.onClick();f=render();assert.equal(f.find(n=>n.type==='svg').props.width,w*0.8);
 f.find(n=>n.props?.['aria-label']==='选择学科树').props.onChange({target:{value:'b'}});f=full();assert.equal(lib.subjectTreeState(lib.readKnowledgeUi().subjectTrees,'b').mindZoom,1);
 f.find(n=>n.props?.['aria-label']==='选择学科树').props.onChange({target:{value:'a'}});f=full();assert.equal(f.find(n=>n.type==='svg').props.width,w*0.8);
 const box={clientWidth:260,clientHeight:180,scrollLeft:0,scrollTop:0};f.find(n=>n.props?.id==='sa-mind-wrap').props.ref(box);
 f.find(n=>n.type==='button'&&text(n)==='适应窗口').props.onClick();f=render();svg=f.find(n=>n.type==='svg');assert.ok(svg.props.width<=box.clientWidth&&svg.props.height<=box.clientHeight);
 f.find(n=>n.type==='button'&&text(n)==='100%').props.onClick();f=render();assert.equal(f.find(n=>n.type==='svg').props.width,w);
});
test('focus reading: entry, exit and close retain the same selected content',()=>{
 const probe=statefulClient(),lib=probe.half.DESCRIPTORS.internals;
 const docs={courses:{courses:[{id:'a',name:'A'}]},knowledgeNetwork:{nodes:[{id:'p',name:'Focus point',courseId:'a',chapter:'第1章 A'}]}};
 lib.readKnowledgeUi({selected:'p',treeCourseId:'a'});
 const text=n=>(n.children||[]).filter(x=>typeof x==='string').join('');
 function render(){probe.begin();return probe.flat(lib.knowledgeTab({docs}));}
 let f=render();const page={scrollTop:240,scrollLeft:0,getBoundingClientRect:()=>({top:0})};
 f.find(n=>n.props?.className==='sa-reader-pane').props.ref.current={closest:()=>page,getBoundingClientRect:()=>({top:-120})};
 f.find(n=>n.type==='button'&&text(n)==='专注阅读').props.onClick({currentTarget:{}});f=render();assert.equal(f.find(n=>n.props?.className==='sa-reader-pane').props['data-focus-reader'],'true');
 assert.ok(f.some(n=>n.type==='h3'&&text(n)==='Focus point'));
 f.find(n=>n.type==='button'&&text(n)==='退出专注阅读').props.onClick();f=render();assert.equal(f.find(n=>n.props?.className==='sa-reader-pane').props['data-focus-reader'],'false');
 assert.equal(page.scrollTop,240);assert.ok(f.some(n=>n.props?.id==='sa-kp-detail'));
});
