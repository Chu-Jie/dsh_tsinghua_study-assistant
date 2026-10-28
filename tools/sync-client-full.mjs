// 同步两份客户端 bundle。
//
// 背景：`package.json` 的 `files` 只发布 `client.js`，但仓库里还留着
// `client.full.js`（完整实现的另一份副本，早期当"权威源"用）。
// 没有构建步骤，所以两份必须逐字一致，否则测试与真机跑的可能是不同的代码。
//
// 现在的方向是 **client.js → client.full.js**：client.js 是发布件、也是唯一
// 被真机加载的那份，改它之后跑本脚本把它镜像到 client.full.js。
//
// ⚠ 如果你改的是 `client.full.js`，直接跑默认模式会把改动**全部覆盖掉**。
// 那种情况请用 `--reverse` —— 但它只做复制，不会替你验证「没丢东西」：
// 先用下面的单行命令确认 client.js 的非空行全都还在 client.full.js 里，
// 再反向复制。少这一步就可能把只存在于 client.js 的修改悄悄删掉。
//
// 用法：
//   node tools/sync-client-full.mjs            # 把 client.js 镜像到 client.full.js
//   node tools/sync-client-full.mjs --dry      # 只看会不会改，不写
//   node tools/sync-client-full.mjs --check    # 只检查一致性（不一致则退出码 1）
//   node tools/sync-client-full.mjs --reverse  # 反过来：client.full.js → client.js
//
// 改动前先证明纯增量（missing 必须是 0）：
//   node -e "const fs=require('fs');const a=fs.readFileSync('client.js','utf8').split(/\r?\n/).filter(s=>s.trim());const b=new Set(fs.readFileSync('client.full.js','utf8').split(/\r?\n/).filter(s=>s.trim()));console.log('missing:',a.filter(l=>!b.has(l)).length)"
import { readFileSync, writeFileSync } from 'node:fs';

const HERE = import.meta.dirname;
const SHIPPED = `${HERE}/../client.js`;
const FULL = `${HERE}/../client.full.js`;

const shipped = readFileSync(SHIPPED, 'utf8');
const full = readFileSync(FULL, 'utf8');
const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--dry')
    ? 'dry'
    : process.argv.includes('--reverse')
      ? 'reverse'
      : 'write';

console.log(`client.js      ${shipped.length} 字符`);
console.log(`client.full.js ${full.length} 字符`);

if (shipped === full) {
  console.log('两份逐字一致 ✓ —— 无需同步。');
  process.exit(0);
}

if (mode === 'check') {
  console.error('两份不一致 ✗ —— 请运行 `node tools/sync-client-full.mjs` 同步。');
  process.exit(1);
}

const diff = shipped.length - full.length;
console.log(`两份不一致：client.js 比 client.full.js ${diff >= 0 ? '多' : '少'} ${Math.abs(diff)} 字符`);

if (mode === 'dry') {
  console.log('--dry：未写入。');
  process.exit(0);
}

if (mode === 'reverse') {
  writeFileSync(SHIPPED, full, 'utf8');
  console.log('已用 client.full.js 覆盖 client.js（--reverse）');
  console.log(`  覆盖后：${readFileSync(SHIPPED, 'utf8') === full ? '逐字一致 ✓' : '仍不一致 ✗'}`);
  console.log('  ⚠ --reverse 只做复制，不验证「没丢东西」——请确认你已跑过 --check 之前那一步的纯增量检查。');
  process.exit(0);
}

writeFileSync(FULL, shipped, 'utf8');
const after = readFileSync(FULL, 'utf8');
console.log(`已用 client.js 覆盖 client.full.js → ${after === shipped ? '逐字一致 ✓' : '仍不一致 ✗'}`);
console.log(`含 injectStyleOnce：${after.includes('injectStyleOnce')}；含 data-sa-panel：${(after.match(/data-sa-panel/g) ?? []).length} 处`);
