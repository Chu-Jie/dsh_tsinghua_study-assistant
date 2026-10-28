/**
 * 快速预演：用绝对数据目录跑一遍两个工具，确认它们读到真实数据。
 * 用法：node tools/preflight.mjs [数据目录]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const dataDir = process.argv[2] ?? 'D:/workspace/作业/学习台';

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
