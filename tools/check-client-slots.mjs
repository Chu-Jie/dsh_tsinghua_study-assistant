/**
 * 离线校验「客户端半边」的槽位注册：不装插件、不开浏览器，直接跑 client.js 的 apply()。
 *
 * 为什么需要它：
 *   桌面端只持久化渲染进程最后 50 行 console，客户端 entry 激活失败的真实异常
 *   经常捞不到（见 docs/故障复盘与后续开发.md §3）。这个脚本把 apply() 放到
 *   **真实的槽位注册表**（@deepseek-ai/dsh-client-ui-slots 的 SlotCore）上跑，
 *   槽位的 kind/scope 抄自桌面端真实契约（dsh-cordis-client-runner 的 Slot 清单），
 *   所以注册类的错误（缺少 options.id/key、撞 id、撞 key、槽位未声明）会在这里直接抛出来。
 *
 * 它**不能**证明的东西：bundle 是否被浏览器成功加载/物化、渲染结果、宿主侧行为。
 *
 * 用法：
 *   node tools/check-client-slots.mjs                  # 检查本仓库的 client.js（默认）
 *   node tools/check-client-slots.mjs <client.js 路径>
 *   node tools/check-client-slots.mjs --late           # 走「槽位稍后才声明」的顺序
 *   node tools/check-client-slots.mjs <client.js> --late
 *
 * 环境变量：
 *   DSH_PACKAGE_ROOT / DSH_UNPACKED_ROOT  包含 node_modules 的目录（最高优先）
 *   DSH_DESKTOP_NODE_MODULES              node_modules 目录本身
 *   不设的话，按 tools/_dsh-packages.mjs 的候选顺序找（DSH 3 的包在 asar 里，
 *   要先解包到 _工具/_dsh3-src；退化到旧安装会打印警告，那种绿灯不算新版兼容）。
 *
 * 两个来源是分开的：
 *   SlotCore（兼容性证据）—— 取新版包；找不到就退出 1。
 *   react（仅供构造元素）—— DSH 3 磁盘上没有可 require 的 react（被打进客户端 bundle 了），
 *                            于是取候选里第一个能找到的，通常是旧安装那份，不代表新版兼容性。
 *
 * ⚠ HOST_SLOTS 是**手抄**的（抄自 dsh-cordis-client-runner 的 Slot 清单），不来自任何包。
 *   DSH 升级时要照新版 runner 同步，否则本脚本的结论会与线上不一致。
 *
 * 退出码：0 = apply() 无异常；1 = 抛错或注册失败（打印完整堆栈）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { findDshPackageFile, describeSource, EXTRACT_HINT } from './_dsh-packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const late = args.includes('--late');
const clientPath = resolve(args.find((a) => !a.startsWith('--')) ?? join(here, '..', 'client.js'));

const slotsEntry = findDshPackageFile(['@deepseek-ai', 'dsh-client-ui-slots', 'lib', 'index.js']);
if (slotsEntry === null) {
  console.error(`找不到 dsh-client-ui-slots，无法做离线槽位校验。\n${EXTRACT_HINT}`);
  process.exit(1);
}
console.log(describeSource(slotsEntry));

/**
 * React：只用来给 client.js 构造元素，**不是兼容性证据**。
 * 新版桌面端把 react 打进了客户端 bundle，磁盘上（含 asar 与 app.asar.unpacked）都没有
 * 可 require 的 react，所以这里按候选顺序找一个能用的（最可能是旧安装那份）。
 */
const reactEntry = findDshPackageFile(['react', 'package.json']);
if (reactEntry === null) {
  console.error(`找不到可 require 的 react，离线槽位校验跑不起来。\n${EXTRACT_HINT}`);
  process.exit(1);
}
console.log(`React 来源：${reactEntry.root}（仅供构造元素，不代表新版兼容性）`);

/**
 * 桌面端真实槽位契约（kind/scope）。
 * 出处：@deepseek-ai/dsh-cordis-client-runner/lib/client.js 里的 Slot 清单。
 * 契约变化时（DSH 升级）要同步这里，否则本脚本会给出与线上不一致的结论。
 */
const HOST_SLOTS = [
  { name: 'main', kind: 'keyed', scope: 'root', by: "root 里的条目（client-ui-layout）" },
  { name: 'sidebar.panellist', kind: 'list', scope: 'root', by: "root 里的条目（client-ui-sidebar）" },
  { name: 'conversation.composer.dock', kind: 'list', scope: 'session', by: 'client-ui-conversation' },
  { name: 'sidebar.right.pane.tab', kind: 'keyed', scope: 'session', by: 'client-ui-sidebar-right' },
  { name: 'sidebar.right.pane.tab.title', kind: 'keyed', scope: 'session', by: 'client-ui-sidebar-right' },
];

const { SlotCore } = await import(pathToFileURL(slotsEntry.file).href);
const require = createRequire(join(reactEntry.root, 'noop.js'));
const React = require('react');

const core = new SlotCore();
const trace = [];
const notes = [];

function declareHostSlots() {
  core.registerFactory(
    {
      name: 'probe:root-shell',
      scope: 'root',
      children: Object.fromEntries(
        HOST_SLOTS.filter((s) => s.scope === 'root').map((s) => [s.name, { kind: s.kind, scope: s.scope }]),
      ),
    },
    () => null,
  );
  core.registerFactory(
    {
      name: 'probe:session-shell',
      scope: 'session',
      children: Object.fromEntries(
        HOST_SLOTS.filter((s) => s.scope === 'session').map((s) => [s.name, { kind: s.kind, scope: s.scope }]),
      ),
    },
    () => null,
  );
  notes.push(`已按契约声明宿主槽位：${HOST_SLOTS.map((s) => `${s.name}(${s.kind}/${s.scope})`).join('、')}`);
}

/** 待声明时挂起的回调（--late 模式用），键 = 槽位名。 */
const pending = new Map();

/**
 * 可选服务的真实实例。它们**只**通过 ctx.get(name) 可达 —— 直接点属性会抛，
 * 与真 cordis 一致（见下方 throwing getter 的说明）。
 * 注意：必须先于 ctx 定义，因为 ctx.get 闭包引用它。
 */
const SERVICES = {
  sidebarRightTabs: {
    register(definition) {
      trace.push(`tabType OK: ${definition.id} / ${definition.kind} / priority=${definition.priority}`);
      return () => {};
    },
  },
  sidebarRight: {
    openTab(kind) {
      trace.push(`openTab(${JSON.stringify(kind)})`); // 探针里假定存在活跃会话
    },
  },
};

const ctx = {
  logger: {
    info: (m) => trace.push(`log: ${m}`),
    warn: (m) => trace.push(`warn: ${m}`),
    error: (m) => trace.push(`error: ${m}`),
  },
  effect(fn, label) {
    const r = fn();
    return typeof r === 'function' ? r : () => trace.push(`dispose: ${label}`);
  },
  on: () => () => {},
  /**
   * 安全读取可选服务。
   *
   * **这一步是本文件最关键的对齐。** 真 cordis 4 的 ctx 代理对「读取未 inject 的服务属性」
   * 会抛 `cannot get property "X" without inject`；客户端半边第一次上线时正是因此激活失败
   * （渲染进程报 `web boot: 1 entry did not activate`，见 docs/故障复盘与后续开发.md §四）。
   * 如果这里不提供 `get`，插件会走「服务缺失」分支正常返回，本脚本就会给出
   * 「apply() 正常返回」的**错误结论** —— 这正是上次漏判根因 B 的原因。
   */
  get(name) {
    const value = SERVICES[name];
    trace.push(`get(${JSON.stringify(name)}) → ${value === undefined ? 'undefined' : '服务'}`);
    return value;
  },
  slots: {
    inject(key, callback) {
      if (late) {
        trace.push(`inject(${key}) → 槽位尚未声明，挂起回调`);
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(callback);
        return () => trace.push(`dispose: inject(${key})`);
      }
      trace.push(`inject(${key}) → 已声明，同步执行回调`);
      const d = callback();
      return typeof d === 'function' ? d : () => {};
    },
    register(options, component) {
      const dispose = core.register(options, component);
      const addr = options.key !== undefined ? `key=${options.key}` : options.id !== undefined ? `id=${options.id}` : '';
      trace.push(`register OK: ${options.name} ${addr}`.trim());
      return dispose;
    },
    registerFactory(options, component) {
      trace.push(`registerFactory: ${options.name}`);
      return core.registerFactory(options, component);
    },
  },
};

/**
 * 把 ctx 上的服务属性改成**抛错的 getter**，忠实模拟真 cordis 的代理：
 * 读取未在 inject 里声明的服务属性时抛 `cannot get property "X" without inject`。
 *
 * 这一步让「点属性读服务」这种写法在本脚本里直接失败，而不是被宽容的桩放过去。
 * 下方 `apply()` 的 try/catch 会把它当作激活失败报出来。
 */
for (const name of ['sidebarRightTabs', 'sidebarRight']) {
  Object.defineProperty(ctx, name, {
    configurable: true,
    enumerable: false,
    get() {
      throw new Error(`cannot get property "${name}" without inject`);
    },
  });
}

// 1) 以模块表的方式加载 bundle：bundle 只注册工厂，物化发生在第一次 require
let captured = null;
const fakeWindow = { __ModuleLoader__: { load(spec) { captured = spec; } } };
const code = readFileSync(clientPath, 'utf8');
try {
  new Function('window', 'require', code)(fakeWindow, (name) => {
    if (name === 'react') return React;
    throw new Error(`bundle 顶层 require 了模块表之外的包：${JSON.stringify(name)}`);
  });
} catch (error) {
  console.error(`✗ bundle 顶层求值失败：${error.message}`);
  process.exit(1);
}
if (captured === null) {
  console.error('✗ bundle 没有调用 window.__ModuleLoader__.load()');
  process.exit(1);
}

if (!late) declareHostSlots();

let plugin;
try {
  plugin = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`factory 内 require 了模块表之外的包：${JSON.stringify(name)}`);
  });
} catch (error) {
  console.error(`✗ factory() 抛出（物化失败，浏览器里同样会失败）：\n${error.stack ?? error}`);
  process.exit(1);
}

const results = [];
try {
  plugin.apply(ctx);
  results.push(`apply() 正常返回（module id = ${captured.id}）`);
  if (late) {
    declareHostSlots();
    for (const slot of HOST_SLOTS) {
      for (const callback of pending.get(slot.name) ?? []) {
        try {
          const d = callback();
          results.push(`延迟回调 OK: ${slot.name}`);
          void d;
        } catch (error) {
          results.push(`延迟回调抛出: ${slot.name} → ${error.message}`);
        }
      }
    }
  }
} catch (error) {
  console.error(`✗ apply() 抛出：\n${error.stack ?? error}`);
  console.error('--- 轨迹 ---');
  for (const line of trace) console.error('  ' + line);
  process.exit(1);
}

const failures = results.filter((r) => r.includes('抛出'));
console.log(`✓ 模式：${late ? '槽位稍后声明（真实启动顺序）' : '槽位已声明'}`);
console.log(`✓ bundle：${clientPath}`);
console.log(`✓ module id：${captured.id}`);
for (const note of notes) console.log(`✓ ${note}`);
console.log('--- 轨迹 ---');
for (const line of trace) console.log('  ' + line);
console.log('--- 结果 ---');
for (const line of results) console.log('  ' + line);
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 处失败`);
  process.exit(1);
}
console.log('\n全部通过。注意：本脚本不覆盖「bundle 加载/物化」与渲染，客户端仍以真机 console 为准。');
