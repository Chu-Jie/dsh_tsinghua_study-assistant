// 把 client.js 用到的主题令牌，与**真实 DSH 安装里存在的**令牌对照。
//
// 为什么需要它：tests/client.test.js 已经用 tools/fix-theme-tokens.mjs 的
// OFFICIAL_TOKENS 白名单守着「不能用编造的令牌」。但白名单本身是**人工维护**的，
// 它可能被写错——这次就抓到过一例：我一度把半径令牌写成 --dsw-alias-radius-*，
// 而 DSH 里真实的名字是 --dsw-radius-*（没有 alias 段）。只比对白名单永远发现
// 不了这种错，因为两边都错得一致。所以这里直接去 DSH 的官方包里取证。
//
// 用法：node tools/audit-theme-tokens.mjs [DSH安装目录]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

import { resolveDshModules, describeSource, EXTRACT_HINT } from './_dsh-packages.mjs';

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
const CLIENT = path.join(PLUGIN_ROOT, 'client.js');

// 取证来源交给 _dsh-packages.mjs：新版 DSH 3 的 web 端代码在 app.asar 里（磁盘上没有
// 解包副本），所以要优先用 _工具/_dsh3-src 那份解包结果；只有实在没有新版代码时才会
// 退回旧安装，此时必须打印警告——否则「全部通过」会被误读成新版兼容。
const resolved = resolveDshModules();
const dshRoot = process.argv[2] ?? (resolved === null ? undefined : path.dirname(resolved.root));
if (dshRoot === undefined) {
  console.log(`跳过：找不到 DSH 的包目录（可用第一参数指定）。\n${EXTRACT_HINT}`);
  process.exit(0);
}

const usingArg = process.argv[2] !== undefined;
console.log(
  describeSource({
    root: dshRoot,
    label: usingArg ? '命令行参数指定' : resolved.label,
    legacy: !usingArg && resolved.legacy === true,
  }),
);
console.log('');

const pkgRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai');
if (!existsSync(pkgRoot)) {
  console.log(`跳过：${pkgRoot} 不存在。`);
  process.exit(0);
}

// 1) 从官方包里扒出全部 --dsw-* 令牌定义
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|css|mjs)$/.test(entry.name) && statSync(full).size > 0) out.push(full);
  }
  return out;
}

const official = new Set();
for (const file of walk(pkgRoot)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/--dsw-[a-z0-9-]+/g)) official.add(match[0]);
}

// 2) client.js 里真正被 var() 用到的令牌
const source = readFileSync(CLIENT, 'utf8');
const used = [...new Set([...source.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();

// 3) 白名单本身是否都真实存在（这是本脚本的独有价值）
const { OFFICIAL_TOKENS } = await import('./fix-theme-tokens.mjs');
const whitelist = [...OFFICIAL_TOKENS].sort();

const usedMissing = used.filter((t) => !official.has(t));
const whitelistMissing = whitelist.filter((t) => !official.has(t));

console.log(`DSH 安装目录：${dshRoot}`);
console.log(`官方包里出现的 --dsw-* 令牌：${official.size} 个`);
console.log(`client.js 的 var() 用到：${used.length} 个`);
console.log(`OFFICIAL_TOKENS 白名单：${whitelist.length} 个\n`);

for (const token of used) {
  console.log(`  ${official.has(token) ? '✓' : '✗ DSH 里不存在'}  ${token}`);
}

let bad = false;
if (usedMissing.length > 0) {
  bad = true;
  console.log(`\n✗ client.js 用了 DSH 里不存在的令牌：${usedMissing.join('、')}`);
}
if (whitelistMissing.length > 0) {
  bad = true;
  console.log(`\n✗ 白名单里这些令牌 DSH 里其实不存在（白名单本身写错了）：${whitelistMissing.join('、')}`);
  console.log('  这类错误只比对白名单是发现不了的，必须像这里一样去官方包取证。');
}

if (!bad) {
  console.log('\n✓ client.js 用到的令牌全部真实存在，且白名单没有写错。');
} else {
  process.exitCode = 1;
}
