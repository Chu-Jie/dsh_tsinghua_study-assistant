/**
 * 用**生产版** validateJsonSchemaValue 验证：工具的输出 schema 能否通过真实返回值。
 *
 * 为什么需要它：
 *   工具 schema 有两道关卡，我先后各踩了一次——
 *     1) 注册时 `assertSupportedJsonSchema`（拒绝 type 数组）→ 曾让整个 DSH 启动失败；
 *     2) 执行后 `validateJsonSchemaValue`（按 output.schema 校验返回值）
 *        → 本次报 `"value.version" is not a declared property (additionalProperties: false)`。
 *   本脚本把第 2 道关卡离线跑通，避免再靠"部署后才发现"。
 *
 * 用法：node tools/verify-tool-output.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findDshPackageFile, describeSource, EXTRACT_HINT } from './_dsh-packages.mjs';
import { makeTempDir, removeTempDir } from './temp-dir.mjs';

const toolsEntry = findDshPackageFile(['@deepseek-ai', 'dsh-tools', 'lib', 'index.js']);
if (toolsEntry === null) {
  // 换台机器 / CI 上没有安装 DSH 时属于正常情况：这道关卡依赖宿主自带的生产版
  // 校验器，拿不到就跳过（不是失败）。`npm run verify:dsh` 里还有更严格的
  // verify-slot-dispatch，那个找不到生产代码时会明确报错，避免「假绿」。
  console.log(`跳过：找不到生产版 dsh-tools（本机没装 DSH，或版本不同）。\n${EXTRACT_HINT}`);
  process.exit(0);
}
console.log(describeSource(toolsEntry));

let assertSupportedJsonSchema;
let validateJsonSchemaValue;
try {
  const toolsPkg = await import(pathToFileURL(toolsEntry.file).href);
  assertSupportedJsonSchema = toolsPkg.assertSupportedJsonSchema;
  validateJsonSchemaValue = toolsPkg.validateJsonSchemaValue;
} catch (error) {
  console.error(`无法加载生产校验器：${error?.message ?? error}`);
  process.exit(1);
}

const here = import.meta.dirname;
const host = await import(pathToFileURL(path.join(here, '..', 'index.js')).href);

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
};

// 用临时数据目录跑 apply()，避免依赖真实数据
const dir = await makeTempDir('study-tooloutput-');
const tools = [];
const ctx = {
  logger: { info() {}, error() {} },
  effect(cb) {
    const d = cb();
    return typeof d === 'function' ? d : () => {};
  },
  // 真 ctx 上 apply() 会用它登记「等 workspaceChanges 服务就绪」的子插件；
  // 这里只是让它别抛错，补丁本身由 tests/changed-files-order.test.js 与 tests/host.test.js 覆盖
  inject() {
    return () => {};
  },
  webServer: { register: () => () => {} },
  tools: {
    register(definition) {
      // 第 1 道关卡：注册时校验
      assertSupportedJsonSchema(definition.output.schema);
      assertSupportedJsonSchema(definition.parameters);
      tools.push(definition);
      return () => {};
    },
  },
};

console.log('=== 注册阶段（assertSupportedJsonSchema）===');
try {
  host.apply(ctx, { dataDir: dir, backupKeep: 2, locale: 'zh', gpaMode: '4.0-weighted' });
  check('apply() 未抛错，两个工具都通过注册校验', tools.length === 2, `实际 ${tools.length} 个`);
} catch (error) {
  check('apply() 未抛错', false, error?.message);
}

console.log('');
console.log('=== 执行阶段（validateJsonSchemaValue）===');
for (const tool of tools) {
  let value = null;
  let execError = null;
  try {
    value = await tool.execute({}, {});
  } catch (error) {
    execError = error;
  }
  check(`${tool.name} 执行不抛错`, execError === null, execError?.message);
  if (execError !== null) continue;

  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value');
  check(`${tool.name} 的返回值符合自己的 output.schema`, violations.length === 0,
    violations.map((v) => (typeof v === 'string' ? v : v.message)).join('; '));

  // 渲染也不该抛
  let renderError = null;
  try {
    tool.output.render({}, value);
  } catch (error) {
    renderError = error;
  }
  check(`${tool.name} 的 render 不抛错`, renderError === null, renderError?.message);
  void renderError;
}

console.log('');
console.log(`=== 结果：${passed} 项通过，${failed} 项失败 ===`);
await removeTempDir(dir);
if (failed > 0) process.exitCode = 1;
