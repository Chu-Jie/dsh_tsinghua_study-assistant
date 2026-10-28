/**
 * 一次性修复：把 client.full.js 里**编造的**主题令牌名换成官方真实令牌。
 *
 * 事故背景：我原先写的 --dsw-alias-text-primary / bg-subtle / border-subtle /
 * accent-primary / status-danger 等**在 DSH 里根本不存在**。不存在的自定义属性
 * 会让 `color`、`background`、`border-color` 退化为初始值（透明 / inherit），
 * 于是主题插件改变了继承背景之后，整个面板就"看不见东西"。
 *
 * 白名单来源：从已安装的官方客户端包 CSS 里实证提取（grep `--dsw-alias-` / `--dsw-radius-`）。
 *
 * 用法：node tools/fix-theme-tokens.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = path.join(import.meta.dirname, '..', 'client.full.js');
const dry = process.argv.includes('--dry');

/**
 * 官方真实令牌（实证提取，只列我用得到的）。
 * 来源示例：
 *   --dsw-alias-bg-base          conversation 的 wSkVaW_root
 *   --dsw-alias-bg-layer-1/2     trajectory / documentpreview
 *   --dsw-alias-border-l1..l3    conversation / sidebar-files / guide
 *   --dsw-alias-label-primary/secondary/tertiary/caption
 *   --dsw-alias-state-*-primary  approval / attachment
 *   --dsw-alias-state-warn-primary   DSH 3 的真实名（theme / plugin-manager / approval /
 *                                    chat / primitives / tool / user-questions 都在用）；
 *                                    旧名 --dsw-alias-state-warning-primary 在 DSH 3 里已 0 处
 *   --dsw-alias-interactive-bg-hover   各处 hover
 *   --dsw-radius-sm/md/lg/xl           各处圆角
 */
export const OFFICIAL_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-business-primary',
  '--dsw-radius-sm',
  '--dsw-radius-md',
  '--dsw-radius-lg',
  '--dsw-radius-xl',
]);

/** 编造 → 官方真实 的替换表。 */
export const TOKEN_FIXES = [
  // 背景
  ['--dsw-alias-bg-subtle-hover', '--dsw-alias-interactive-bg-hover'],
  ['--dsw-alias-bg-subtle', '--dsw-alias-bg-layer-2'],
  ['--dsw-alias-bg-base', '--dsw-alias-bg-base'],       // 本来就对，保持
  // 文本
  ['--dsw-alias-text-on-accent', '--dsw-alias-label-primary'],
  ['--dsw-alias-text-primary', '--dsw-alias-label-primary'],
  ['--dsw-alias-text-secondary', '--dsw-alias-label-secondary'],
  // 边框
  ['--dsw-alias-border-subtle', '--dsw-alias-border-l1'],
  // 强调色
  ['--dsw-alias-accent-primary', '--dsw-alias-brand-primary'],
  // 状态色
  ['--dsw-alias-status-danger', '--dsw-alias-state-error-primary'],
  ['--dsw-alias-status-warning', '--dsw-alias-state-warn-primary'],
  // 圆角
  ['var(--dsw-radius-7px)', 'var(--dsw-radius-md)'],
];

// 只在**直接运行**时执行替换与写盘。
// 起初这里是无条件的顶层代码，于是 tools/audit-theme-tokens.mjs 一 import
// 这个模块，就会顺手跑一遍替换逻辑（虽然当时恰好没变化、没写盘，但这属于
// 「import 一个工具脚本会触发它的副作用」——迟早会误改文件）。
const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const source = readFileSync(file, 'utf8');
  let output = source;
  const applied = [];

  for (const [from, to] of TOKEN_FIXES) {
    if (from === to) continue;
    // 只替换 var(...) 里的用法，避免误伤注释
    const pattern = new RegExp(`var\\(${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[,)])`, 'g');
    const hits = output.match(pattern);
    if (hits === null) continue;
    output = output.replace(pattern, `var(${to}`);
    applied.push(`${from} → ${to}   (${hits.length} 处)`);
  }

  // 汇总：替换后仍在使用、但不在白名单里的令牌（应当为空）
  const remaining = [...new Set([...output.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
    .filter((name) => !OFFICIAL_TOKENS.has(name));

  console.log('=== 已替换 ===');
  if (applied.length === 0) console.log('  （无）');
  for (const line of applied) console.log(`  ${line}`);
  console.log('');
  console.log('=== 替换后仍在用但不在白名单里的令牌 ===');
  if (remaining.length === 0) {
    console.log('  无 —— 全部令牌都是官方真实存在的');
  } else {
    for (const name of remaining) console.log(`  ✗ ${name}`);
  }

  if (dry) {
    console.log('\n（--dry：未写文件）');
  } else if (output !== source) {
    writeFileSync(file, output, 'utf8');
    console.log(`\n已写入 ${file}`);
  } else {
    console.log('\n无变化，未写文件');
  }
}
