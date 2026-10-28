#!/usr/bin/env node
/**
 * knowledge-weave —— 把「知识点候选」织成「知识点网络」节点（命令行入口）。
 *
 * 数据流：`取字批次 → 学习台/知识点候选.json`（流水线写）→ **本工具合并** → `学习台/知识点网络.json`
 * （面板读、人标记）。合并规则在 `lib/knowledge.js`（纯函数，有单测）；这里只负责读写磁盘。
 *
 * 用法：
 *   node tools/knowledge-weave.mjs                 # 只打印会发生什么（默认不写盘）
 *   node tools/knowledge-weave.mjs --apply         # 真写：先备份再原子替换，带 hash 冲突检测
 *   node tools/knowledge-weave.mjs --data <目录>    # 默认 <工作区>/学习台
 *   node tools/knowledge-weave.mjs --json          # 机器可读输出（给脚本/agent 用）
 *
 * 安全：写盘走 `lib/store.js` 的受保护写入（临时文件 + rename + `备份/` 轮转 + expectedHash），
 * 所以面板正开着时也不会把别人的修改盖掉——冲突会返回 `conflict` 而不是硬写。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.js';
import { weaveCandidates } from '../lib/knowledge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');

export function parseArgs(argv) {
  const args = { dataDir: DEFAULT_DATA_DIR, apply: false, json: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data') args.dataDir = path.resolve(argv[++index]);
    else if (item === '--apply') args.apply = true;
    else if (item === '--json') args.json = true;
    else if (item === '--quiet') args.quiet = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  return args;
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node tools/knowledge-weave.mjs [--apply] [--data 学习台目录] [--json] [--quiet]');
    return 0;
  }
  const log = args.json || args.quiet ? () => {} : (...parts) => console.log('[weave]', ...parts);
  const store = createStore(args.dataDir);

  const networkRead = await store.readDocument('knowledgeNetwork');
  const candidatesRead = await store.readDocument('knowledgeCandidates');
  const questionsRead = await store.readDocument('questions');
  const coursesRead = await store.readDocument('courses');

  if (!networkRead.ok && networkRead.reason !== 'missing') {
    console.error(`[weave] 失败：知识点网络.json 读不了（${networkRead.reason}）`);
    return 2;
  }
  if (!candidatesRead.ok) {
    if (candidatesRead.reason === 'missing') {
      if (args.json) console.log(JSON.stringify({ ok: true, stats: { candidates: 0, created: 0, merged: 0, unchanged: 0, skipped: 0 }, written: false, reason: 'no-candidates' }));
      else log('没有 知识点候选.json（取字批次还没产出候选），无事可做');
      return 0;
    }
    console.error(`[weave] 失败：知识点候选.json 读不了（${candidatesRead.reason}）`);
    return 2;
  }

  const result = weaveCandidates({
    network: networkRead.ok ? networkRead.doc : { version: 1, nodes: [], edges: [] },
    candidates: candidatesRead.doc,
    questions: questionsRead.ok ? questionsRead.doc : { questions: [] },
    courses: coursesRead.ok ? coursesRead.doc : { courses: [] },
  });
  const stats = result.stats;
  log(`候选 ${stats.candidates} 条 → 新建 ${stats.created} · 合并 ${stats.merged} · 未变 ${stats.unchanged} · 跳过 ${stats.skipped}（新增证据 ${stats.evidenceAdded}）`);

  let written = false;
  let writeReason = '';
  if (!result.changed) {
    log('网络没有变化，不写盘');
  } else if (!args.apply) {
    log('--dry 模式：没有写盘（加 --apply 才真写）');
  } else {
    const write = await store.writeDocument('knowledgeNetwork', result.network, {
      expectedHash: networkRead.ok ? networkRead.hash : null,
    });
    written = write.ok;
    writeReason = write.ok ? '' : write.reason ?? 'write-failed';
    if (write.ok) log(`已写入 学习台/知识点网络.json（${result.network.nodes.length} 个节点）`);
    else console.error(`[weave] 写入失败：${writeReason}`);
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: !(args.apply && result.changed && !written),
      stats,
      changed: result.changed,
      written,
      reason: writeReason || undefined,
      ids: result.details.created.map((item) => item.id),
    }));
  }
  return args.apply && result.changed && !written ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error('[weave] 失败：', error?.message ?? error);
    process.exitCode = 2;
  }
}
