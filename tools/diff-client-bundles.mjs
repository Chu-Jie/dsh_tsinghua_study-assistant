// 逐行比较两份客户端 bundle，把差异打印出来（只读）。
// 用途：当两份额外的副本与发布件必须逐字一致时，用它确认差异只有预期的那些。
// 用法：node tools/diff-client-bundles.mjs
import { readFileSync } from 'node:fs';

const HERE = import.meta.dirname;
const A = `${HERE}/../client.js`;
const B = `${HERE}/../client.full.js`;

const a = readFileSync(A, 'utf8').split('\n');
const b = readFileSync(B, 'utf8').split('\n');

console.log(`client.js      ${a.length} 行`);
console.log(`client.full.js ${b.length} 行\n`);

// 简单的 LCS 差异：bundle 只有一千多行，够用
const n = a.length;
const m = b.length;
const width = m + 1;
const table = new Uint32Array((n + 1) * width);
for (let i = n - 1; i >= 0; i -= 1) {
  for (let j = m - 1; j >= 0; j -= 1) {
    table[i * width + j] = a[i] === b[j]
      ? table[(i + 1) * width + (j + 1)] + 1
      : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
  }
}

let i = 0;
let j = 0;
let changes = 0;
while (i < n && j < m) {
  if (a[i] === b[j]) { i += 1; j += 1; continue; }
  if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
    console.log(`- ${String(i + 1).padStart(4)} │ ${a[i]}`);
    i += 1;
  } else {
    console.log(`+ ${String(j + 1).padStart(4)} │ ${b[j]}`);
    j += 1;
  }
  changes += 1;
}
for (; i < n; i += 1) { console.log(`- ${String(i + 1).padStart(4)} │ ${a[i]}`); changes += 1; }
for (; j < m; j += 1) { console.log(`+ ${String(j + 1).padStart(4)} │ ${b[j]}`); changes += 1; }

console.log(`\n差异行数：${changes}${changes === 0 ? '（两份逐字一致）' : ''}`);
