// 打印皮肤 CSS 中与四种 chrome 层、pane 布局相关的规则全文。
//
// 用法：node tools/scan-skin-css.mjs <皮肤包 client.js 的路径>
// 之所以要传参：第三方皮肤装在各自机器的 profile 里，路径不通用。
import { readFileSync } from 'node:fs';

const SKIN = process.argv[2];
if (SKIN === undefined) {
  console.error('用法：node tools/scan-skin-css.mjs <skin 的 lib/client.js 路径>');
  process.exit(2);
}
const source = readFileSync(SKIN, 'utf8');

const sheets = [];
for (const m of source.matchAll(/const\s+(css[A-Za-z0-9$]*)\s*=\s*"((?:[^"\\]|\\.){200,})"/g)) {
  sheets.push({ name: m[1], text: m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') });
}

function rules(css) {
  const out = [];
  // 选择器可能含逗号导致一个 body 对应多选择器，这里按 `{...}` 分组即可。
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim(), body: m[2].trim() });
  return out;
}

const want = /skin-chrome=(top-trim|bottom-trim|character-stage)|skin-trim-layer|data-maid-character|maid-boot-error/;
for (const sheet of sheets) {
  for (const r of rules(sheet.text)) {
    if (!want.test(r.selector)) continue;
    console.log(`\nSEL  ${r.selector}`);
    console.log(`BODY ${r.body}`);
  }
}
