#!/usr/bin/env node
/**
 * kp-notes-export（命令行入口）—— 把学习台的「知识点网络」镜像成 dsh-kp-notes 的笔记目录。
 *
 * 渲染与落盘逻辑全在 `lib/kp-notes-export.js`（纯函数 + 受控写盘，有单测）；这里只做参数解析。
 * 面板上的「导出到画布」按钮走 `POST /knowledge/export`，调的也是同一个模块。
 *
 * 用法：
 *   node tools/kp-notes-export.mjs                       # 生成到 <工作区>/学习台/知识画布
 *   node tools/kp-notes-export.mjs --out D:\某处\画布
 *   node tools/kp-notes-export.mjs --dry                 # 只打印计划，不写盘
 *   node tools/kp-notes-export.mjs --check               # 有差异就退出码 1
 *   node tools/kp-notes-export.mjs --no-prune            # 不清陈旧文件
 *   node tools/kp-notes-export.mjs --data <学习台目录>    # 默认 <工作区>/学习台
 *
 * 安全边界：只写 `--out` 下面、只删**上一份 manifest 里登记过**的文件；别处的东西一律不碰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DATA_DIR,
  DEFAULT_OUT_DIR,
  applyExport,
  diffExport,
  planExport,
  readJson,
  sha256,
} from '../lib/kp-notes-export.js';

export { DEFAULT_DATA_DIR, DEFAULT_OUT_DIR, applyExport, diffExport, planExport };

/* -------------------------------------------------------------------- CLI */

export function parseArgs(argv) {
  const args = { dataDir: DEFAULT_DATA_DIR, outDir: DEFAULT_OUT_DIR, dry: false, check: false, prune: true, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data') args.dataDir = path.resolve(argv[++index]);
    else if (item === '--out') args.outDir = path.resolve(argv[++index]);
    else if (item === '--dry') args.dry = true;
    else if (item === '--check') args.check = true;
    else if (item === '--no-prune') args.prune = false;
    else if (item === '--quiet') args.quiet = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  return args;
}

export function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node tools/kp-notes-export.mjs [--data 学习台目录] [--out 输出目录] [--dry] [--check] [--no-prune] [--quiet]');
    return 0;
  }
  const log = args.quiet ? () => {} : (...parts) => console.log('[kp-notes-export]', ...parts);
  const networkFile = path.join(args.dataDir, '知识点网络.json');
  const questionsFile = path.join(args.dataDir, '题目.json');
  const coursesFile = path.join(args.dataDir, '课程.json');

  const network = readJson(networkFile, null);
  if (network === null) {
    console.error(`[kp-notes-export] 失败：读不到 ${networkFile}`);
    return 2;
  }
  const plan = planExport({
    network,
    questions: readJson(questionsFile, { questions: [] }),
    courses: readJson(coursesFile, { courses: [] }),
    sourceLine: `知识点网络 ${String(network.updatedAt ?? '').replace('T', ' ').slice(0, 16) || '（未标注）'}`,
  });
  plan.source = {
    network: sha256(JSON.stringify(network)),
    questions: sha256(fs.readFileSync(questionsFile, 'utf8')),
    courses: sha256(fs.readFileSync(coursesFile, 'utf8')),
  };

  log(`章 ${plan.summary.chapters} · 笔记 ${plan.summary.notes} · 题目文件 ${plan.summary.questionFiles}（题目 ${plan.summary.questions}）· 未配对题目 ${plan.summary.skippedQuestions}`);
  log(`输出目录 ${args.outDir}`);

  if (args.check) {
    const changes = diffExport(args.outDir, plan);
    if (changes.length === 0) {
      log('--check：已是最新（无差异）');
      return 0;
    }
    for (const change of changes) console.log(`  ${change.kind === 'missing' ? '缺' : change.kind === 'stale' ? '陈旧' : '有差异'} ${change.rel}`);
    log(`--check：${changes.length} 处差异（跑一次不带 --check 即可更新）`);
    return 1;
  }

  if (args.dry) {
    for (const rel of Object.keys(plan.files)) console.log(`  ＋ ${rel}`);
    log('--dry：没有写盘');
    return 0;
  }

  const result = applyExport(args.outDir, plan, { prune: args.prune });
  log(`写入 ${result.written.length} 个文件，未变 ${result.unchanged} 个${args.prune ? `，清理陈旧 ${result.removed.length} 个` : '（--no-prune，未清理）'}`);
  if (result.kept.length > 0) log(`有 ${result.kept.length} 个陈旧文件没删掉（可能被占用）：${result.kept.slice(0, 3).join('、')}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error('[kp-notes-export] 失败：', error?.message ?? error);
    process.exitCode = 2;
  }
}
