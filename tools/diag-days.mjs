/**
 * 精确诊断：client 的 parseDay 对 Date 输入为何返回 null。
 * 用法：node tools/diag-days.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = import.meta.dirname;
const React = { createElement: () => null };

const code = readFileSync(path.join(here, '..', 'client.full.js'), 'utf8');
const context = { window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ status: 200, json: async () => ({ ok: true, docs: {} }) }) };
context.window.__ModuleLoader__ = { load(spec) { context.__spec = spec; } };
vm.runInNewContext(code, context, { filename: 'client.full.js' });
const half = context.__spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
});
const client = half.DESCRIPTORS.internals;
const core = await import(pathToFileURL(path.join(here, '..', 'lib', 'core.js')).href);

const now = new Date(2026, 8, 10, 9, 0, 0);
console.log('宿主 realm 的 now 构造器名 =', now.constructor.name);
console.log('now instanceof 宿主 Date     =', now instanceof Date);

const cDue = client.parseDue('2026-09-09');
console.log('');
console.log('client.parseDue 返回类型      =', Object.prototype.toString.call(cDue));
console.log('cDue.constructor.name        =', cDue.constructor.name);
console.log('cDue instanceof 宿主 Date     =', cDue instanceof Date, '  ← 跨 realm 时这里会是 false');
console.log('Number.isNaN(cDue.getTime()) =', Number.isNaN(cDue.getTime()));
console.log('');
console.log('client.parseDay(cDue)        =', String(client.parseDay(cDue)));
console.log('client.parseDay(now)         =', String(client.parseDay(now)));
console.log('core.parseDay(cDue)          =', String(core.parseDay(cDue)));
console.log('');
console.log('=== 结论判据 ===');
console.log('若 cDue instanceof Date 为 false，而 getTime() 正常，');
console.log('则 client.parseDay 的 `value instanceof Date` 判断会漏掉它 → 走进字符串分支 → 返回 null。');
