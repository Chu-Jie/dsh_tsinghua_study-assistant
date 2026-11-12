/**
 * 快速预演：用绝对数据目录跑一遍两个工具，确认它们读到真实数据。
 * 用法：node tools/preflight.mjs [数据目录]
 *
 * 默认数据目录＝工作区（`<repo>/../../..`）下的 `学习台`，与 `lectures-sync.mjs` 的 ROOT 同一口径。
 * 旧版写死 `D:/workspace/作业/学习台`：那个目录不存在时 store 的 init 会就地补一套**空文档**，
 * 于是「体检通过」但这套空数据不是真的（2026-10-30 在本机留下过一份 11 份空 JSON 的空壳）。
 * 所以这里既改默认值，也在数据目录里找不到主文档时直接退出，绝不创建空数据目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const workspace = path.resolve(here, '..', '..', '..');
const dataDir = path.resolve(process.argv[2] ?? path.join(workspace, '学习台'));

const markers = ['学期.json', '资料索引.json', '资料分析.json'];
const missing = markers.filter((file) => !fs.existsSync(path.join(dataDir, file)));
if (missing.length > 0) {
  console.error(`数据目录不像学习台数据目录：${dataDir}（缺 ${missing.join('、')}）`);
  console.error('请显式传入数据目录，例如：node tools/preflight.mjs "<学习台数据目录>"');
  process.exit(1);
}
// 文件在、但内容是空壳，同样不是真数据（旧默认值在本机留下过这样一套 11 份空 JSON）。
const indexedFiles = (() => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, '资料索引.json'), 'utf8'));
    return Array.isArray(doc?.files) ? doc.files.length : -1;
  } catch {
    return -1;
  }
})();
if (indexedFiles <= 0) {
  console.error(`数据目录里没有资料索引条目（资料索引.json 的 files 为空或读不动）：${dataDir}`);
  console.error('这通常意味着数据目录传错了（空壳目录）；请传真实数据目录，例如：node tools/preflight.mjs "<学习台数据目录>"');
  process.exit(1);
}

const host = await import(pathToFileURL(path.join(here, '..', 'index.js')).href);
const tools = [];
const ctx = {
  logger: { info() {}, error() {} },
  effect(cb) {
    const d = cb();
    return typeof d === 'function' ? d : () => {};
  },
  inject() {
    return () => {};
  },
  webServer: { register: () => () => {} },
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
};

host.apply(ctx, { dataDir, backupKeep: 10, locale: 'zh', gpaMode: '4.0-weighted' });
console.log(`数据目录：${dataDir}`);
console.log(`注册工具：${tools.map((t) => t.name).join(', ')}`);
console.log('');

for (const tool of tools) {
  const value = await tool.execute({}, {});
  console.log(`=== ${tool.name} ===`);
  console.log(tool.output.render({}, value)[0].text);
  console.log('');
}
