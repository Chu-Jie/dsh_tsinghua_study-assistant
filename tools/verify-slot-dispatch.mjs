/**
 * 用**生产版** SlotCore 验证「main 槽 keyed 分派」这条链。
 *
 * 背景：点击侧栏『学习辅助』后中间区域空白，但 `Slots.listSubTree` 显示
 * `main` 槽里 `key: 'study-assistant'` 确实是 active 占位者。于是问题只可能是：
 *   ① 注册时 `options.key` 没进 `entry.options`（renderer 按 `entry.options.key` 查找）；
 *   ② key 不是字符串；
 *   ③ 声明的 slot 名与注册的 name 不一致（会被 register 拒掉）。
 * 本脚本直接加载生产版 registry，把这三条一次性钉死。
 *
 * DSH 3（harness 0.2.1-rc.3）起包结构变了，这份脚本要跟着改：
 *   - 旧布局（DSH 0.10.0、以及「如果未来恢复独立包」）：`@deepseek-ai/dsh-client-ui-slots/lib/index.js`
 *     是可直接 import 的独立包，SlotCore 是它的导出成员；
 *   - DSH 3：这个包**不再单独发到 app.asar**（它只出现在 web-frontend 的 devDependencies），
 *     生产实现被 rolldown 打进 `@deepseek-ai/dsh-web-frontend/dist/assets/index-<hash>.js`，
 *     由 bundle 顶部 vendor 模块表以
 *       {"@deepseek-ai/dsh-client-ui-slots": <module>}
 *     提供给插件 `require()`；`<module>` 是冻结命名空间，导出 `SlotCore`。
 * 所以本脚本的取证顺序是：
 *   ① 独立包还在 → 直接 import（旧版兼容）；
 *   ② 否则从 web-frontend bundle 里按 vendor 模块表定位 `SlotCore` 的**类定义文本**，
 *      用 `node:vm` 求值出同一个类（不是手写复刻），再跑同一套 8 条检查；
 *   ③ 两套来源都拿不到 → exit 2，并打印解包命令（防「假绿」：拿不到生产代码就绝不通过）；
 *   ④ bundle 在、但 SlotCore 的导出面/类体抽取失败 → 明确报「该版 API 变了」，
 *      打印最小可验证的静态等价检查后 exit 1 —— 宁可明显失败，也不静默变成假绿。
 *
 * 用法：node tools/verify-slot-dispatch.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { dshModuleCandidates, describeSource, EXTRACT_HINT } from './_dsh-packages.mjs';

const SLOTS_MODULE_ID = '@deepseek-ai/dsh-client-ui-slots';
const STANDALONE_SEGMENTS = ['@deepseek-ai', 'dsh-client-ui-slots', 'lib', 'index.js'];
const FRONTEND_ASSETS_SEGMENTS = ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets'];
const FRONTEND_BUNDLE_RE = /^index-.*\.js$/;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function readIfExists(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 braceIndex 处的 `{` 起截到配对的 `}`（含两端）；用于从压缩 bundle 里抠类体。 */
function readBalancedBraces(source, braceIndex) {
  if (source[braceIndex] !== '{') return null;
  let depth = 0;
  for (let index = braceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceIndex, index + 1);
    }
  }
  return null;
}

/**
 * 在 web-frontend bundle 里定位 `@deepseek-ai/dsh-client-ui-slots` 的 SlotCore 类定义文本。
 * 返回 {ok:true,moduleId,className,classText} 或 {ok:false,reason,...}。
 */
function extractSlotCoreClass(source) {
  const moduleMap = new RegExp(`"${escapeRegExp(SLOTS_MODULE_ID)}"\\s*:\\s*([A-Za-z0-9_$]+)`).exec(source);
  if (moduleMap === null) return { ok: false, reason: 'no-module-map' };
  const moduleId = moduleMap[1];

  // vendor 模块的命名空间对象：Object.freeze(Object.defineProperty({__proto__:null,SlotCore:<cls>,...
  const namespace = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(moduleId)}\\s*=\\s*Object\\.freeze\\(Object\\.defineProperty\\(\\{__proto__:null[^}]*?SlotCore:([A-Za-z0-9_$]+)`,
  ).exec(source);
  if (namespace === null) return { ok: false, reason: 'no-slotcore-export', moduleId };
  const className = namespace[1];

  // 常见形态：var SI=class{...}；也兼容 class 声明被改名/提升的写法。
  for (const prefix of [`var ${className}=class{`, `let ${className}=class{`, `const ${className}=class{`, `${className}=class{`]) {
    const at = source.indexOf(prefix);
    if (at < 0) continue;
    const body = readBalancedBraces(source, at + prefix.length - 1);
    if (body !== null && body.includes('entriesOfSlot(')) return { ok: true, moduleId, className, classText: `class${body}` };
  }

  // 兜底：导出对象里的 SlotCore 名字在前、类体在后时，按「含 entriesOfSlot 的类」反查。
  let at = source.indexOf('entriesOfSlot(');
  while (at >= 0) {
    const classAt = source.lastIndexOf('=class{', at);
    if (classAt >= 0) {
      const body = readBalancedBraces(source, classAt + '=class'.length);
      if (body !== null && body.includes('register(') && body.includes('specDynamic(')) {
        return { ok: true, moduleId, className, classText: `class${body}` };
      }
    }
    at = source.indexOf('entriesOfSlot(', at + 1);
  }
  return { ok: false, reason: 'no-class-body', moduleId, className };
}

const EXTRACT_REASON_TEXT = {
  'no-module-map': 'bundle 里没有 vendor 模块表条目 "@deepseek-ai/dsh-client-ui-slots"',
  'no-slotcore-export': 'vendor 模块的命名空间里没有 SlotCore 导出',
  'no-class-body': '找到了 SlotCore 导出名，但类定义文本抽取失败（压缩/结构变了）',
};

/**
 * 求值生产类体。类体只依赖 bundle 的模块级常量 i1（Object.freeze([])，空条目列表）
 * 和宿主同名的 queueMicrotask；其余命名空间导出（错误类/标签工具）类体不引用。
 * 若未来版本引用了未提供的符号，这里会抛 ReferenceError —— 脚本据此报「API 变了」，
 * 不会拿一个残缺实现静默通过。
 */
function evaluateSlotCore(classText, filename) {
  const sandbox = {
    i1: Object.freeze([]),
    queueMicrotask,
  };
  try {
    return { ok: true, SlotCore: vm.runInNewContext(`(${classText})`, sandbox, { filename }) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/** 在某个候选根里找 web-frontend bundle 并抽 SlotCore。 */
function loadFromFrontendBundle(candidate) {
  const assetsDir = path.join(candidate.root, ...FRONTEND_ASSETS_SEGMENTS);
  let names;
  try {
    names = readdirSync(assetsDir);
  } catch {
    return { kind: 'missing' };
  }

  const matched = [];
  for (const name of names) {
    if (!FRONTEND_BUNDLE_RE.test(name)) continue;
    const file = path.join(assetsDir, name);
    const source = readIfExists(file);
    if (source === null || !source.includes(SLOTS_MODULE_ID)) continue;
    matched.push({ file, source });
  }
  if (matched.length === 0) return { kind: 'missing' };

  const reasons = [];
  for (const { file, source } of matched) {
    const extracted = extractSlotCoreClass(source);
    if (extracted.ok !== true) {
      reasons.push(`${path.basename(file)}：${EXTRACT_REASON_TEXT[extracted.reason] ?? extracted.reason}`);
      continue;
    }
    const evaluated = evaluateSlotCore(extracted.classText, file);
    if (evaluated.ok !== true) {
      reasons.push(`${path.basename(file)}：类体求值失败（${evaluated.reason}）`);
      continue;
    }
    return {
      kind: 'loaded',
      mod: { SlotCore: evaluated.SlotCore },
      source: { file, root: candidate.root, label: candidate.label, legacy: candidate.legacy },
      layout: 'bundle',
      bundleName: path.basename(file),
      moduleId: extracted.moduleId,
      className: extracted.className,
    };
  }
  return { kind: 'api-changed', reasons, source: matched[0].source, file: matched[0].file };
}

console.log('verify-slot-dispatch：用生产版 SlotCore 钉死 main 槽分派链\n');

const candidates = dshModuleCandidates().filter((candidate) => existsSync(path.join(candidate.root, '@deepseek-ai')));
if (candidates.length === 0) {
  console.log(`找不到生产版 SlotCore 的取证来源：既没有解包产物，也没有 DSH_PACKAGE_ROOT。\n${EXTRACT_HINT}`);
  process.exit(2);
}

let evidence = null;
let apiProblem = null;
const incomplete = [];
for (const candidate of candidates) {
  // ① 旧布局：独立包可直接 import。
  const standaloneFile = path.join(candidate.root, ...STANDALONE_SEGMENTS);
  if (readIfExists(standaloneFile) !== null) {
    let mod;
    try {
      mod = await import(pathToFileURL(standaloneFile).href);
    } catch (error) {
      console.log(`加载生产版 dsh-client-ui-slots 失败：${error?.message ?? error}`);
      process.exit(1);
    }
    evidence = {
      mod,
      source: { file: standaloneFile, root: candidate.root, label: candidate.label, legacy: candidate.legacy },
      layout: 'standalone',
    };
    break;
  }

  // ② DSH 3 布局：SlotCore 在 web-frontend bundle 的 vendor 模块表里。
  const bundle = loadFromFrontendBundle(candidate);
  if (bundle.kind === 'loaded') {
    evidence = bundle;
    break;
  }
  if (bundle.kind === 'api-changed') {
    // 该根目录确实带着 slots 的痕迹，但导出面已对不上 → 停止降级，明确报 API 变了。
    apiProblem = { ...bundle, candidate };
    break;
  }
  incomplete.push(candidate);
}

if (evidence === null && apiProblem !== null) {
  console.log('该版 API 变了：`@deepseek-ai/dsh-client-ui-slots` 的 SlotCore 导出面与旧版校验脚本假设的不一致。');
  console.log(describeSource({ file: apiProblem.file, root: apiProblem.candidate.root, label: apiProblem.candidate.label, legacy: apiProblem.candidate.legacy }));
  for (const reason of apiProblem.reasons) console.log(`  - ${reason}`);
  console.log('\n最小可验证等价检查（静态断言，只用于定位，不代表通过）：');
  const source = apiProblem.source;
  const staticChecks = [
    ['bundle 登记了 vendor 模块 @deepseek-ai/dsh-client-ui-slots', source.includes(SLOTS_MODULE_ID)],
    ['命名空间里有 SlotCore 导出', /SlotCore\s*:/.test(source)],
    ['keyed 注册要求 options.key', source.includes('requires options.key')],
    ['entriesOfSlot 按 options.key 取 keyed 条目', source.includes('options.key')],
    ['register 拒绝未声明的槽（不静默失效）', source.includes('is not declared')],
  ];
  for (const [label, ok] of staticChecks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  console.log('\n请更新 tools/verify-slot-dispatch.mjs 的定位逻辑，按新版导出面重写 8 条检查的挂载点；不要删检查或放宽断言。');
  process.exit(1);
}

if (evidence === null) {
  console.log('找不到生产版 SlotCore 的取证来源：下面这些 DSH 包目录里既没有独立包 `dsh-client-ui-slots`，');
  console.log('也没有含它的 `dsh-web-frontend/dist/assets/index-*.js`（解包可能不完整）。');
  for (const candidate of incomplete) console.log(`  - ${candidate.label}: ${candidate.root}`);
  console.log(`\n${EXTRACT_HINT}`);
  process.exit(2);
}

console.log(describeSource(evidence.source));
console.log('');
if (evidence.layout === 'bundle') {
  console.log('包结构（DSH 3）：`@deepseek-ai/dsh-client-ui-slots` 已不再单独发包，SlotCore 在 web-frontend bundle 的 vendor 模块表里：');
  console.log(`  ${SLOTS_MODULE_ID} → ${evidence.moduleId}（导出 SlotCore → ${evidence.className}）`);
  console.log(`  来源文件：${evidence.bundleName}`);
  console.log('');
}

const { mod } = evidence;

check('存在导出面（模块命名空间 / CJS 默认导出）', typeof mod === 'object' && mod !== null, `实际类型 ${typeof mod}`);
check('导出面里有可实例化的 SlotCore', typeof mod.SlotCore === 'function', `实际类型 ${typeof mod.SlotCore}`);

const core = new mod.SlotCore();
const PANEL_ID = 'study-assistant';

// 复刻官方 shell 的声明：main 是 root 作用域的 keyed 槽，已占用 conversation。
// 旧版 SlotCore 有公开的 declare()；DSH 3 起改为 register({ children })（官方 shell 的做法）。
core.declare?.('main', { kind: 'keyed', scope: 'root' });
const declare = core.declare?.bind(core) ?? core.specDynamic?.bind(core);
check('拿到了声明入口（declare 或 specDynamic）', typeof declare === 'function', `实际类型 ${typeof declare}`);

// 若生产版没有公开 declare，就退回到「通过 children 表声明」的路径：
// 这正是真实插件系统的做法（一个 entry 的 children 声明子槽）。
if (core.spec('main') === undefined) {
  // 用一个假的父条目声明 main
  core.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, () => null);
}
check('main 槽已声明', core.spec('main') !== undefined, 'spec("main") 仍是 undefined');

// 注册本插件的格子
const component = () => null;
core.register({ name: 'main', key: PANEL_ID }, component);

const entries = core.entriesOfSlot('main');
check('main 槽里有 1 个条目', entries.length === 1, `实际 ${entries.length}`);

const entry = entries[0];
check('entry.options.key === "study-assistant"', entry?.options?.key === PANEL_ID, `实际 ${JSON.stringify(entry?.options)}`);
check('entry.component 是刚注册的组件', entry?.component === component);

// renderer 的查找式：find((e) => e.options.key === opts?.entryKey)
const found = core.entriesOfSlot('main').find((e) => e.options.key === PANEL_ID);
check('renderer 的查找式能命中', found !== undefined);

// 声明的 name 与注册的 name 不一致时必须被拒（防「静默不生效」）
let rejected = false;
try {
  core.register({ name: 'main-nonexistent', key: 'x' }, component);
} catch {
  rejected = true;
}
check('注册到未声明的槽会被拒绝（不会静默失效）', rejected);

console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${passed} 项通过，${failures.length} 项失败`);
process.exit(failures.length === 0 ? 0 : 1);
