#!/usr/bin/env node
/**
 * 分题入库：把已经取好字的作业 OCR 文本切成题目，写进 `学习台/题目.json`。
 *
 * 为什么要有这个工具：`题目.json` / `知识点候选.json` 一直是空的，于是面板「知识点」段的节点
 * 永远是 0、织网与导出画布也没有输入。取字那一步已经跑完（10 份作业、0 失败页），缺的是
 * 「把一页页转写文字切成一道道题」这一步。
 *
 * 输入：`学习台/资料索引.json` 里 `kind === 'homework'` 且 `ocr.outDir` / `text.outFile` 有值的记录。
 * 读优先级：`<outDir>/全文.md` → `<outDir>/pageNN.md`（逐页拼）。
 * 输出：`学习台/题目.json`（字段按 `_工具/任务单-…md` §5.2 的契约）。
 *
 * 切题只靠**题号行**（三种已实测风格）：
 *   1. `13.2 …` / `* 13.29 …`            物理、部分数电（章.题号）
 *   2. `［题 1.1］ …` / `[题 2. 10] …`     数电（方括号包着题号，空格位置随机）
 *   3. `39. …` / `1、…`                   离散数学、数据结构（纯数字）
 * 子问 `(1)` `（2）` 不算新题——它们不以「数字 + 点/顿号 + 空白」开头，或紧跟括号。
 *
 * **默认只预览**（dry）。加 `--apply` 才写盘：写前把原文件备份为 `题目.json.bak-<时间戳>`，
 * 然后按 `sourceFile` 覆盖该来源的题（别的来源一条不碰），最后原子替换。
 *
 * 用法：
 *   node tools/split-homework.mjs                 # 预览：每份文件切出几题、置信度分布
 *   node tools/split-homework.mjs --apply         # 真写（带备份，可重跑）
 *   node tools/split-homework.mjs --json          # 机器可读输出
 *   node tools/split-homework.mjs --only 物理/作业/第02次作业_原题.pdf
 *   node tools/split-homework.mjs --data <学习台目录> --workspace <工作区根>
 *
 * 退出码：0 正常；1 有文件 0 题（提示人工看）；2 参数/环境错误；3 写盘失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 注意：不能拿 `new URL(import.meta.url).pathname` 当路径——中文会被百分号转义
// （`/D:/%E5%A4%A7%E5%AD%A6/...`），派生出来的工作区与数据目录全错。必须用 fileURLToPath。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..', '..');
const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');

// 题号行的三种实测风格。命名只为日志与置信度判断，正则按「最不挑剔」写。
const PATTERNS = [
  // 13.2 / 2.10 / * 13.29：章.题号，后面必须跟空白或中文
  { style: 'chapter.no', re: /^[*\s]*[（(]?\s*(\d{1,3}\.\d{1,3})\s*[)）]?\s*(?=\S)/u },
  // ［题 1.1］ / [题 2. 10]
  { style: 'bracket', re: /^[*\s]*[\[［]\s*题\s*([\d.\s]{1,10}?)\s*[\]］]/u },
  // 39. / 1、 / 2.
  { style: 'plain', re: /^[*\s]*(\d{1,3})[.、．]\s*(?!\d)/u },
];

// 全文.md 的头部元信息不是题目内容：`> 通道：gemini`、`- 目录：…`、`# 标题`、`---`、代码围栏。
const SKIP_LINE_RE = /^(?:#|>|\|-|```)/u;
const META_LINE_RE = /^(?:>\s*[^：:]{1,16}[：:]|-\s*[^：:]{1,12}[：:])/u;

// 「1. 第 2 版教材第 14 章习题 39、40(1)(2)。」后面紧跟的 `39.` / `40.` 是子题号（离散第 02 次实测）。
// 判据：纯数字风格、题号跳到上一题 +1 之外、且上一题正文里点过这个号。
function continuesPrevious(open, hit) {
  if (open === null) return false;
  if (hit.style !== 'plain') return false;
  const previous = Number(open.no);
  const next = Number(hit.no);
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return false;
  if (next <= previous + 1) return false;
  return open.lines.join(' ').includes(hit.no);
}

function sha256File(file) {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** 把「全文.md」按 `## 第 N 页` 切成 [{page, lines}]；没有页标记时整篇当第 1 页。 */
export function splitPages(text) {
  const pages = [];
  const preface = [];
  let current = null;
  let sawMarker = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const mark = /^##\s*第\s*(\d{1,4})\s*页/u.exec(raw.trim());
    if (mark !== null) {
      if (current !== null && current.lines.length > 0) pages.push(current);
      current = { page: Number(mark[1]), lines: [] };
      sawMarker = true;
      continue;
    }
    if (current === null) preface.push(raw);
    else current.lines.push(raw);
  }
  if (current !== null && current.lines.length > 0) pages.push(current);
  if (!sawMarker && preface.some((line) => line.trim() !== '')) return [{ page: 1, lines: preface }];
  return pages;
}

/**
 * 从页里切题。返回 {questions, styles, warnings}。
 * 每个 question：{no, style, page, lines[]}，后面再统一成契约字段。
 */
export function splitQuestions(pages) {
  const questions = [];
  const warnings = [];
  const styles = new Set();
  let open = null;

  for (const page of pages) {
    for (const raw of page.lines) {
      const line = raw.trim();
      if (line === '') {
        if (open !== null) open.lines.push('');
        continue;
      }
      let hit = null;
      for (const pattern of PATTERNS) {
        const match = pattern.re.exec(line);
        if (match !== null) {
          hit = { style: pattern.style, no: match[1].replace(/\s+/gu, '') };
          break;
        }
      }
      if (hit !== null) {
        if (continuesPrevious(open, hit)) {
          open.lines.push(line);
          continue;
        }
        if (open !== null) questions.push(open);
        open = { no: hit.no, style: hit.style, page: page.page, lines: [line] };
        styles.add(hit.style);
        continue;
      }
      if (open === null) {
        // 题号之前的内容（作业说明、页眉残留）：不丢，记成了警告，人工看
        if (SKIP_LINE_RE.test(line) || META_LINE_RE.test(line)) continue;
        if (line.length >= 6) warnings.push(`第 ${page.page} 页题号之前的内容被忽略：${line.slice(0, 40)}`);
        continue;
      }
      if (SKIP_LINE_RE.test(line) || META_LINE_RE.test(line)) continue;
      open.lines.push(line);
    }
  }
  if (open !== null) questions.push(open);
  return { questions, styles: [...styles], warnings };
}

/**
 * 人工核对后的排除表：OCR 把题号认错、导致同一道题在两个来源里各出现一次时，只留真的那条。
 * 2026-10-20 物理第 02 次实测：原题第 5 页 `13.5 如果在一空间区域中电势是常数…` 与
 * `13.15 用电势梯度法求习题 13.5 中…` 对不上（真正的 13.5 是细直杆题，在单独的
 * `第02次作业_附_习题13.5题面.pdf` 里），判为 OCR 题号认错，排除。
 */
const KNOWN_NOISE = [
  { path: '物理/作业/第02次作业_原题.pdf', no: '13.5', reason: '题号疑似 OCR 认错，真 13.5 在附页文件里' },
];

/** 一段题目文本 → 契约字段。 */
export function toQuestionRecord(question, context) {
  const prompt = question.lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const homeworkSeq = context.homeworkSeq;
  const idParts = ['q', context.courseId ?? 'unknown', `hw${homeworkSeq ?? 'x'}`, String(question.no).replace(/[^\w.-]/gu, '')];
  const seen = context.seen ?? new Map();
  let id = idParts.join('_');
  if (seen.has(id)) {
    const n = seen.get(id) + 1;
    seen.set(id, n);
    id = `${id}_${n}`;
  } else {
    seen.set(id, 1);
  }
  // 置信度：题干太短、或该文件里题号重复 → low（人工核对后再用）
  const duplicate = context.nos.filter((no) => no === question.no).length > 1;
  const confidence = prompt.length >= 12 && !duplicate ? 'high' : 'low';
  return {
    id,
    courseId: context.courseId ?? null,
    sourceFile: context.path,
    sourceHash: context.sourceHash ?? '',
    homeworkSeq: homeworkSeq ?? null,
    no: String(question.no),
    prompt,
    page: question.page,
    kind: 'homework',
    knowledgeNames: [],
    confidence,
  };
}

/** 一份作业 → 题目数组（纯函数，测试直接用）。 */
export function splitFileText(text, context = {}) {
  const pages = splitPages(text);
  const { questions: raw, styles, warnings } = splitQuestions(pages);
  // 同一题号出现两次：原题末尾常被追加「附：习题 13.5 题面」这类页，OCR 会重复一次。
  // 保留正文更长的那份（题面更完整），并记一条警告供人工抽查。
  const merged = [];
  const byNo = new Map();
  for (const question of raw) {
    const key = String(question.no);
    const previous = byNo.get(key);
    if (previous === undefined) {
      byNo.set(key, question);
      merged.push(question);
      continue;
    }
    const keepNew = question.lines.join(' ').length > previous.lines.join(' ').length;
    warnings.push(`题号 ${key} 在文本里出现两次，保留${keepNew ? '后' : '前'}一份`);
    if (keepNew) {
      byNo.set(key, question);
      merged[merged.indexOf(previous)] = question;
    }
  }
  const nos = merged.map((item) => item.no);
  const seen = new Map();
  const records = merged
    .filter((question) => {
      const noise = KNOWN_NOISE.find((item) => item.path === context.path && item.no === String(question.no));
      if (noise === undefined) return true;
      warnings.push(`按人工核对表排除题号 ${question.no}：${noise.reason}`);
      return false;
    })
    .map((question) => toQuestionRecord(question, { ...context, nos, seen }));
  return { records, styles, warnings, pages: pages.length };
}

function loadSourceText(workspace, record) {
  const candidates = [];
  if (typeof record.ocr?.outDir === 'string' && record.ocr.outDir !== '') {
    const outDir = path.resolve(workspace, record.ocr.outDir);
    candidates.push(path.join(outDir, '全文.md'));
    try {
      candidates.push(...fs.readdirSync(outDir)
        .filter((name) => /^page\d{1,4}\.md$/iu.test(name))
        .sort()
        .map((name) => path.join(outDir, name)));
    } catch {
      // 目录不存在：后面的候选自然都读不到
    }
  }
  if (typeof record.text?.outFile === 'string' && record.text.outFile !== '') {
    candidates.push(path.resolve(workspace, record.text.outFile));
  }
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      if (text.trim() !== '') return { text, file };
    } catch {
      // 换下一个候选
    }
  }
  return { text: null, file: null };
}

function homeworkSeqOf(p) {
  const match = /第\s*(\d{1,2})\s*次/u.exec(String(p ?? ''));
  return match === null ? null : Number(match[1]);
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
  const target = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function parseArgs(argv) {
  const args = {
    dataDir: DEFAULT_DATA_DIR,
    workspace: null,
    apply: false,
    json: false,
    quiet: false,
    only: null,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data') args.dataDir = path.resolve(argv[++index]);
    else if (item === '--workspace') args.workspace = path.resolve(argv[++index]);
    else if (item === '--apply') args.apply = true;
    else if (item === '--json') args.json = true;
    else if (item === '--quiet') args.quiet = true;
    else if (item === '--list') args.list = true;
    else if (item === '--only') args.only = argv[++index];
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  return args;
}

export async function run(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const args = parseArgs(argv);
  if (args.help) {
    log('用法：node tools/split-homework.mjs [--apply] [--list] [--only <来源路径>] [--json] [--data 学习台目录] [--workspace 工作区根]');
    return 0;
  }
  const dataDir = args.dataDir;
  const workspace = args.workspace ?? path.dirname(dataDir);
  const indexPath = path.join(dataDir, '资料索引.json');
  const questionsPath = path.join(dataDir, '题目.json');
  const index = readJson(indexPath, null);
  if (index === null || !Array.isArray(index.files)) {
    log(`[split] 读不到资料索引：${indexPath}`);
    return 2;
  }

  const homework = index.files.filter((item) => item.kind === 'homework'
    && (typeof item.ocr?.outDir === 'string' || typeof item.text?.outFile === 'string'));
  const targets = args.only === null ? homework : homework.filter((item) => item.path === args.only);
  if (targets.length === 0) {
    log(args.only === null ? '[split] 资料索引里没有可切的作业' : `[split] 找不到来源：${args.only}`);
    return 2;
  }

  const existing = readJson(questionsPath, { version: 1, updatedAt: null, questions: [] });
  const keptOthers = (existing.questions ?? []).filter((item) => !targets.some((target) => target.path === item.sourceFile));
  const produced = [];
  const report = [];
  const problems = [];

  for (const record of targets) {
    const { text, file } = loadSourceText(workspace, record);
    if (text === null) {
      problems.push({ path: record.path, reason: '没找到取字文本' });
      continue;
    }
    const sourceAbs = path.resolve(workspace, record.path);
    const sourceHash = (sha256File(sourceAbs) ?? '').slice(0, 16);
    const result = splitFileText(text, {
      path: record.path,
      courseId: record.courseId ?? null,
      homeworkSeq: homeworkSeqOf(record.path),
      sourceHash,
    });
    const high = result.records.filter((item) => item.confidence === 'high').length;
    report.push({
      path: record.path,
      textFile: path.relative(workspace, file).split(path.sep).join('/'),
      pages: result.pages,
      questions: result.records.length,
      high,
      low: result.records.length - high,
      styles: result.styles,
      nos: result.records.map((item) => item.no),
      questionsDetail: result.records.map((item) => ({ no: item.no, page: item.page, prompt: item.prompt })),
      warnings: result.warnings,
    });
    if (result.records.length === 0) problems.push({ path: record.path, reason: '没切出题（题号风格不认识？）' });
    produced.push(...result.records);
  }

  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    questions: [...keptOthers, ...produced],
  };
  // 跨文件撞 id（例：`物理/…第02次作业_原题.pdf` 末尾被追加了「附：习题 13.5 题面」页，
  // 与单独的 `第02次作业_附_习题13.5题面.pdf` 切出同一条 `q_physics_hw2_13.5`）：
  // 保留先出现的，后面的加 `_2`、`_3` 后缀，保证 题目.json 里 id 唯一。
  const usedIds = new Set(keptOthers.map((item) => item.id));
  for (const item of produced) {
    if (!usedIds.has(item.id)) {
      usedIds.add(item.id);
      continue;
    }
    let suffix = 2;
    while (usedIds.has(`${item.id}_${suffix}`)) suffix += 1;
    item.id = `${item.id}_${suffix}`;
    usedIds.add(item.id);
  }

  if (args.json) {
    log(JSON.stringify({ dry: !args.apply, report, problems, written: produced.length, kept: keptOthers.length }, null, 2));
  } else {
    for (const item of report) {
      log(`[split] ${item.path} → ${item.questions} 题（高 ${item.high} / 待核 ${item.low}，${item.pages} 页，风格 ${item.styles.join('+') || '无'}）`);
      if (!args.quiet) log(`        题号：${item.nos.join(' ')}`);
      if (args.list) {
        for (const detail of item.questionsDetail) {
          log(`        · ${detail.no}（第 ${detail.page} 页）${detail.prompt.replace(/\s+/gu, ' ').slice(0, 40)}`);
        }
      }
      for (const warning of item.warnings.slice(0, 3)) log(`        ⚠ ${warning}`);
    }
    for (const problem of problems) log(`[split] ⚠ ${problem.path}：${problem.reason}`);
    log(`[split] 合计 ${produced.length} 题（保留其它来源 ${keptOthers.length} 题）`);
  }

  if (!args.apply) {
    log('[split] --dry 模式：没有写盘（加 --apply 才真写）');
    return produced.length === 0 ? 1 : 0;
  }
  if (fs.existsSync(questionsPath)) {
    const backup = backupFile(questionsPath);
    if (!args.json) log(`[split] 已备份：${path.basename(backup)}`);
  }
  try {
    writeJsonAtomic(questionsPath, next);
  } catch (error) {
    log(`[split] 写盘失败：${error.message}`);
    return 3;
  }
  log(`[split] 已写入 ${questionsPath}：${produced.length} 题`);
  return problems.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
