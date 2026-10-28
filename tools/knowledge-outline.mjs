#!/usr/bin/env node
/**
 * knowledge-outline —— 从教材 OCR 目录页解析「章 → 节 → 小节」骨架，写 `学习台/知识点大纲.json`。
 *
 * 为什么要有这个工具：知识点树要做到「点学科 → 章 → 节 → 知识点」，但 `知识点网络.json` 里
 * 节点的 `section` 原本全空，树只有两层半。章/节/小节只能来自教材目录，所以把目录单独存成
 * 第 10 份数据文档（`knowledgeOutline`），节点只负责按 `section` / `subsection` 挂靠。
 *
 * 输入：任意课程的教材 OCR 页目录，用 `--ocr` 指到 `…/教材/_OCR/<书>/`。目录页有两种挑法：
 *   - 数据结构（默认）：`page0015.md`、`page0016.md` 简要目录，`page0017.md`–`page0022.md` 详细目录（带三级小节号）；
 *   - 其他书：`--pages page0008.md,page0009.md,...` 显式指定，或不给 `--pages` 让工具自动挑
 *     （单页里「引导点 + 页码」出现 ≥4 处，或含 `目 录` / `CONTENTS` 即认目录页）。
 * 输出：`学习台/知识点大纲.json`，形状
 *   `{version, updatedAt, sources:[{courseId, book, pages[]}],
 *     courses:[{courseId, name, book, chapters:[{no, title, page, sections:[{no, title, page, subs:[{no, title, page}]}]}]}]}`
 *
 * **默认只预览**（dry），加 `--apply` 才写盘：写前把旧文件备份成 `知识点大纲.json.bak-<时间戳>`，
 * 再经 `lib/store.js` 的受保护写入（临时文件 + rename + `备份/` 轮转 + expectedHash）。
 *
 * 已实测的解析坑：
 *   1. 目录行里的引导点/下划线要先折成空格（`§8.1 伸展树_____204`），否则 §8–12 整段丢；
 *      离散数学（第 2 版）用的是**全角省略号** `………………`，同一套 `normalizeLine` 一起折；
 *   2. 小节行是 `2.6.5 二分查找 168`，正则**不能**要求标题与页码间有两个以上空白/点；
 *   3. 详细目录有缺口（OCR 失败页 3.4–5.1、6.4–6.12、8.x–9.2 等），这些节只到「节」级、`subs` 为空；
 *   4. 极少数小节标题跨行（如 `1.3.4 多项式$O(...)$`），解析不出来的行直接跳过，不猜；
 *   5. **两栏目录**（离散数学第 2 版，一行两条词条）：先按 3 个以上空白切栏，再逐栏解析，
 *      否则右栏的「3.2 命题公式的分类」「14.5 图的运算」全丢；
 *   6. **标题跨行**（`第 18 章  支配集、覆盖集、独立集、` + `匹配与着色 …… 356`）：用 LIFO 短队列
 *      把没有页码的片段接在后面，两段都是中文时直连不插空格（`货郎`+`担问题`）；
 *   7. 目录里「章」行缺失（只出现 3.2/3.3）时会建空壳章，最后按章号排序并回落命名 `第N章`。
 *
 * 用法：
 *   node tools/knowledge-outline.mjs                     # 预览：解析出几章几节几小节
 *   node tools/knowledge-outline.mjs --apply             # 真写（带备份，可重跑）
 *   node tools/knowledge-outline.mjs --json              # 机器可读输出
 *   node tools/knowledge-outline.mjs --ocr <目录>         # 指定 OCR 页目录
 *   node tools/knowledge-outline.mjs --pages a.md,b.md   # 显式指定目录页（不给就自动挑）
 *   node tools/knowledge-outline.mjs --data <学习台目录>   # 指定数据目录
 *   node tools/knowledge-outline.mjs --course c_digital --name 数电 --book "…" --ocr <目录>
 *                                                        # 写别的课（默认**合并**：同 courseId 原位覆盖、
 *                                                        # 其他课保留；`sources` 按 courseId 去重）
 *   node tools/knowledge-outline.mjs --apply --replace   # 只保留这一门课（整份覆盖，慎用）
 *
 * 已落盘的课：`c_ds`（12 章 / 64 节 / 271 小节，数据结构 C++ 第 3 版）、
 * `c_disc`（19 章 / 75 节 / 0 小节，离散数学第 2 版，目录只到「节」级）。
 *
 * 退出码：0 正常；1 解析结果为空或与旧数据差太多（防手滑覆盖）；2 参数/环境错误；3 写盘失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.js';
import { DOC_VERSION } from '../lib/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');
export const DEFAULT_OCR_DIR = path.join(WORKSPACE, '数据结构', '教材', '_OCR', '数据结构教材');

const BRIEF_PAGES = ['page0015.md', 'page0016.md'];
const DETAIL_PAGES = ['page0017.md', 'page0018.md', 'page0019.md', 'page0020.md', 'page0021.md', 'page0022.md'];

export function parseArgs(argv) {
  const args = {
    dataDir: DEFAULT_DATA_DIR,
    ocrDir: DEFAULT_OCR_DIR,
    pages: [],
    apply: false,
    json: false,
    quiet: false,
    courseId: 'c_ds',
    name: '数据结构',
    book: '数据结构（C++语言版）第3版',
    replace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data') args.dataDir = path.resolve(argv[++index]);
    else if (item === '--ocr') args.ocrDir = path.resolve(argv[++index]);
    else if (item === '--pages') {
      args.pages = String(argv[++index] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    else if (item === '--course') args.courseId = String(argv[++index] ?? '').trim();
    else if (item === '--name') args.name = String(argv[++index] ?? '').trim();
    else if (item === '--book') args.book = String(argv[++index] ?? '').trim();
    else if (item === '--replace') args.replace = true;
    else if (item === '--apply') args.apply = true;
    else if (item === '--json') args.json = true;
    else if (item === '--quiet') args.quiet = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  if (args.courseId === '') throw new Error('--course 不能是空串');
  return args;
}

/** 去掉行尾的引导点与多余空白，标题里连续空白压成一个。 */
const clean = (s) => s
  .replace(/[_\.·•…\s]+$/g, '')
  .replace(/^\s+|\s+$/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

/**
 * 目录里页码前常有连续引导点（`.`/`·`/`•`/全角 `…`/下划线），先折成空格再匹配。
 * 2026-10-22 加全角省略号：离散数学第 2 版目录用的是 `……………………`，不加会把整本目录全丢掉。
 */
const normalizeLine = (s) => s.trim().replace(/[_\.·•…]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * 把一行拆成若干「词条」。两栏排版的目录一行能塞两条（中间隔若干空格），
 * 所以要先按 3 个以上空白切栏，再逐栏规范化；单栏行切出来还是一段。
 */
const splitColumns = (raw) => String(raw)
  .split(/\s{3,}|\t+/)
  .map(normalizeLine)
  .filter((item) => item !== '');

/** 一个词条的开头：`第 N 章` 或 `§x.y` / `x.y` / `x.y.z`。 */
const ENTRY_RE = /^(?:第\s*(\d{1,2})\s*章|§?\s*(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?))\s*(.*)$/;
/** 词条尾部的书页码：`标题… 页码`。 */
const PAGE_TAIL_RE = /^(.*?)\s+(\d{1,3})$/;
/** 只有页码的续行（极窄栏裁出来的孤页号）。 */
const PAGE_ONLY_RE = /^(\d{1,3})$/;
/** 中日韩字符（含 、。（） 等全角标点）：跨行标题拼接时中文之间不该插空格。 */
const isCjkChar = (ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
/**
 * 跨行标题拼回去：两段都以中文结尾/开头就直连（`初等数论在…中的` + `几个应用`），
 * 否则用一个空格（`Chapter` + `Title`）。
 */
const joinParts = (parts) => (Array.isArray(parts) ? parts : []).reduce((acc, part) => {
  const piece = String(part ?? '');
  if (acc === '') return piece;
  if (piece === '') return acc;
  const left = acc.slice(-1);
  const right = piece.slice(0, 1);
  return `${acc}${isCjkChar(left) && isCjkChar(right) ? '' : ' '}${piece}`;
}, '');

/**
 * 解析目录页 → `[{no, title, page, sections:[{no, title, page, subs:[{no, title, page}]}]}]`。
 * 纯函数（只读传入的文本），方便测试与 --dry。
 *
 * 支持的版式（2026-10-22 扩）：
 *   - 单栏：`第 1 章 绪论 1` / `§2.5 无序向量 22` / `2.5.7 去重 25`；
 *   - **两栏**：`第 14 章 图的基本概念 …… 293        14.5 图的运算 …… 311`（一行两条，按 ≥3 空格切栏）；
 *   - **标题跨行**：`15.3 最短路问题、中国邮递员问题与货郎` + `担问题 …… 323`（上一行没页码，接下行的尾页号）；
 *   - 引导点含全角 `…`（离散第 2 版目录就是这种）。
 * 解析不出的行（只有编号没页码、又没下文续上）直接丢，不猜。
 *
 * @param {{brief:string[], detail:string[]}} texts 每页的文本（brief 先扫，detail 后扫，便于章序稳定）
 */
export function parseOutline(texts = {}) {
  const brief = Array.isArray(texts.brief) ? texts.brief : [];
  const detail = Array.isArray(texts.detail) ? texts.detail : [];
  const chapters = new Map(); // 章号 -> { no, title, page, sections: Map }
  const order = [];

  const ensureChapter = (no, title, page) => {
    if (!chapters.has(no)) {
      chapters.set(no, { no, title: clean(title || ''), page: Number(page) || 0, sections: new Map() });
      order.push(no);
      return chapters.get(no);
    }
    // 两栏目录里节的词条可能先于章标题被扫到，先建了个空壳章；章标题后来到了就补上
    const exist = chapters.get(no);
    const nextTitle = clean(title || '');
    if (nextTitle !== '' && exist.title === '') exist.title = nextTitle;
    if (!exist.page && Number(page) > 0) exist.page = Number(page);
    return exist;
  };
  const ensureSection = (no, title, page) => {
    const chapNo = Number(String(no).split('.')[0]);
    const chap = chapters.get(chapNo) ?? ensureChapter(chapNo, ``, 0);
    if (!chap.sections.has(no)) chap.sections.set(no, { no, title: clean(title || ''), page: Number(page) || 0, subs: [] });
    return chap.sections.get(no);
  };

  const scan = (pages) => {
    let pending = null; // 上一行只有编号/半截标题、还没拿到页码的词条
    let lastSection = null;
    // 两栏版式里「半截标题」和它的续行可能隔着一整条别的词条，所以不能只记一条 pending，
    // 用一个短队列（LIFO 匹配），最多留 6 条，超了丢最旧的。
    const pendings = [];
    const pushPending = (item) => {
      pendings.push(item);
      if (pendings.length > 6) pendings.shift();
    };
    const takePending = () => {
      const item = pendings.pop();
      return item ?? null;
    };
    const emit = (kind, no, title, page) => {
      if (kind === 'chapter') {
        ensureChapter(Number(no), title, page);
        lastSection = null;
        return;
      }
      if (kind === 'section') {
        lastSection = ensureSection(no, title, page);
        return;
      }
      // 小节：优先挂到自己的节，节还没出现时退回「最近一个节」（与旧实现一致）
      const secNo = String(no).split('.').slice(0, 2).join('.');
      const sec = chapters.get(Number(secNo.split('.')[0]))?.sections.get(secNo) ?? lastSection;
      if (sec && !sec.subs.some((item) => item.no === no)) {
        sec.subs.push({ no, title: clean(title || ''), page: Number(page) || 0 });
      }
    };

    for (const text of pages) {
      for (const raw of String(text || '').split('\n')) {
        for (const seg of splitColumns(raw)) {
          if (/^第\s*\d+\s*部分/.test(seg) || /^习\s*题/.test(seg)) { pendings.length = 0; continue; }
          const m = seg.match(ENTRY_RE);
          if (m) {
            const isChapter = Boolean(m[1]);
            const no = isChapter ? Number(m[1]) : m[2];
            const kind = isChapter ? 'chapter' : (String(no).split('.').length >= 3 ? 'sub' : 'section');
            const rest = String(m[3] || '').trim();
            const tail = rest.match(PAGE_TAIL_RE);
            if (tail) emit(kind, no, tail[1], tail[2]);
            else pushPending({ kind, no, parts: rest === '' ? [] : [rest] });
            continue;
          }
          const onlyPage = seg.match(PAGE_ONLY_RE);
          if (onlyPage) {
            const target = takePending();
            if (target) emit(target.kind, target.no, joinParts(target.parts), onlyPage[1]);
            continue;
          }
          const tail = seg.match(PAGE_TAIL_RE);
          if (tail) {
            const target = takePending();
            if (target) {
              target.parts.push(tail[1]);
              emit(target.kind, target.no, joinParts(target.parts), tail[2]);
            }
            continue;
          }
          const target = pendings[pendings.length - 1];
          if (target) target.parts.push(seg);
        }
      }
    }
    // 扫完还没拿到页码的词条：丢掉（不猜页码）
  };

  scan(brief);
  scan(detail);

  const list = order.map((no) => chapters.get(no)).sort((a, b) => a.no - b.no);
  for (const chap of list) {
    if (chap.title === '') chap.title = `第${chap.no}章`;
    chap.sections = [...chap.sections.values()].sort((a, b) => {
      const [ax, ay] = a.no.split('.').map(Number);
      const [bx, by] = b.no.split('.').map(Number);
      return ax - bx || ay - by;
    });
  }
  return list;
}

/** 统计：章 / 节 / 小节数。 */
export function outlineCounts(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  return list.reduce((acc, chap) => {
    acc.chapters += 1;
    acc.sections += Array.isArray(chap.sections) ? chap.sections.length : 0;
    acc.subs += (chap.sections || []).reduce((n, sec) => n + (Array.isArray(sec.subs) ? sec.subs.length : 0), 0);
    return acc;
  }, { chapters: 0, sections: 0, subs: 0 });
}

/** 组装要落盘的大纲文档（store 会补 version/updatedAt）。 */
export function buildOutlineDoc(chapters, { courseId = 'c_ds', name = '数据结构', book = '数据结构（C++语言版）第3版', pages = [] } = {}) {
  return {
    version: DOC_VERSION,
    sources: [{ courseId, book, pages: [...pages] }],
    courses: [{ courseId, name, book, chapters }],
  };
}

/**
 * 把一门课合并进现有大纲文档（**同 `courseId` 原位覆盖、别的课保留**）。
 *
 * 为什么要合并而不是整份替换：`知识点大纲.json` 是 10 份数据文档里的第 10 份，一门课一个
 * `courses[]` 条目。`--apply` 若直接写 `buildOutlineDoc`，以后给数电/离散建大纲时会把数据结构
 * 那门课冲掉——等于每次只能留一门课。合并的语义：
 *   - 同 `courseId`：替换（保持它在数组里的位置）；
 *   - 新 `courseId`：追加到末尾；
 *   - `sources`：按 `courseId` 去重后替换（同一门课重复跑不会越堆越多）。
 *
 * @param {object} currentDoc 磁盘上现有的大纲（可能为空/损坏，都当空处理）
 * @param {{courseId:string,name?:string,book?:string,chapters:Array}} courseEntry 要写入的课程
 * @param {{courseId:string,book?:string,pages?:string[]}} [source] 数据来源说明；不传则沿用旧的
 */
export function mergeCourse(currentDoc, courseEntry, source = null) {
  const base = currentDoc && typeof currentDoc === 'object' ? currentDoc : {};
  const courses = Array.isArray(base.courses) ? base.courses.filter((item) => item && typeof item === 'object') : [];
  const courseId = String(courseEntry?.courseId ?? '');
  const nextCourses = courses.some((item) => String(item.courseId ?? '') === courseId)
    ? courses.map((item) => (String(item.courseId ?? '') === courseId ? courseEntry : item))
    : [...courses, courseEntry];
  const oldSources = Array.isArray(base.sources) ? base.sources.filter((item) => item && typeof item === 'object') : [];
  const keptOld = oldSources.find((item) => String(item.courseId ?? '') === courseId) ?? null;
  const nextSource = source ?? keptOld;
  // 按原顺序重建：同 courseId 的旧条目（可能重复）只留一条，换成 nextSource；没有就追加
  const sources = [];
  let placed = false;
  for (const item of oldSources) {
    if (String(item.courseId ?? '') !== courseId) { sources.push(item); continue; }
    if (!placed && nextSource) { sources.push(nextSource); placed = true; }
  }
  if (!placed && nextSource) sources.push(nextSource);
  return { version: DOC_VERSION, sources, courses: nextCourses };
}

function readPages(dir, names) {
  const out = [];
  for (const page of names) {
    const file = path.join(dir, page);
    if (fs.existsSync(file)) out.push({ page, text: fs.readFileSync(file, 'utf8') });
  }
  return out;
}

/**
 * 自动挑目录页：一个 OCR 目录里几十上百页，但只有目录页有「一长串引导点 + 页码」这种特征。
 * 判定：单页出现 ≥4 处「引导点 + 页码」，或页里直接写着「目 录 / CONTENTS」。
 * 换一门课（`--ocr` 指到别的目录）时用得到，免得每门课都手工列页号。
 */
export function pickTocPages(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((name) => /^page\d+\.md$/.test(name)).sort();
  const out = [];
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const leaders = (text.match(/(?:…{2,}|\.{6,}|_{4,})\s*\d{1,3}/g) || []).length;
    if (leaders >= 4 || /目\s*录|CONTENTS/i.test(text)) out.push({ page: name, text });
  }
  return out;
}

/** 目录页从哪来：显式 `--pages` > 数据结构默认页 > 自动挑。 */
function collectTocPages(args) {
  if (Array.isArray(args.pages) && args.pages.length > 0) return readPages(args.ocrDir, args.pages);
  if (path.resolve(args.ocrDir) === path.resolve(DEFAULT_OCR_DIR)) {
    return [...readPages(args.ocrDir, BRIEF_PAGES), ...readPages(args.ocrDir, DETAIL_PAGES)];
  }
  return pickTocPages(args.ocrDir);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node tools/knowledge-outline.mjs [--apply] [--json] [--ocr <目录>] [--data <目录>]');
    console.log('       [--course <课程id>] [--name <课程名>] [--book <教材名>] [--pages <页1,页2>] [--replace]');
    console.log('  默认合并进现有 知识点大纲.json（同 courseId 原位覆盖，其他课保留）；--replace 才整份覆盖。');
    console.log('  目录页：不传 --pages 时，数据结构走固定页清单，别的课自动挑（引导点 + 页码 ≥4 处的页）。');
    return 0;
  }
  const tocPages = collectTocPages(args);
  if (tocPages.length === 0) {
    console.error(`找不到任何目录页：${args.ocrDir}`);
    return 2;
  }

  // 统一扫一遍：单流即可（章/节/小节都在同一个扫描器里分派），跨行标题也能接上
  const chapters = parseOutline({ brief: tocPages.map((item) => item.text) });
  const counts = outlineCounts(chapters);
  const pages = tocPages.map((item) => item.page);
  if (counts.chapters === 0) {
    console.error('没解析出任何章——OCR 文本格式可能变了，先别写盘。');
    return 1;
  }

  // 防手滑：这门课新解析结果比磁盘上少一半以上就拒绝写（别的课不参与比较）
  const store = createStore(args.dataDir);
  const current = await store.readDocument('knowledgeOutline');
  const currentDoc = current?.ok ? current.doc : null;
  const currentCourses = Array.isArray(currentDoc?.courses) ? currentDoc.courses : [];
  const currentEntry = currentCourses.find((item) => String(item?.courseId ?? '') === args.courseId) ?? null;
  const currentCounts = outlineCounts(currentEntry?.chapters);
  const otherCourses = currentCourses.filter((item) => String(item?.courseId ?? '') !== args.courseId).length;
  const shrink = currentCounts.chapters > 0 && counts.chapters < currentCounts.chapters / 2;

  const summary = {
    counts,
    current: currentCounts,
    courseId: args.courseId,
    otherCourses,
    shrink,
    pages,
    ocrDir: args.ocrDir,
    applied: false,
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else if (!args.quiet) {
    console.log(`目录页：${pages.join(', ')}`);
    console.log(`解析结果：${counts.chapters} 章 / ${counts.sections} 节 / ${counts.subs} 小节（${args.courseId}）`);
    console.log(`磁盘现状：${currentCounts.chapters} 章 / ${currentCounts.sections} 节 / ${currentCounts.subs} 小节（同一门课）`);
    if (otherCourses > 0) console.log(`大纲里另有 ${otherCourses} 门课，本次合并不会动它们`);
  }

  if (args.apply) {
    if (shrink) {
      console.error(`解析结果比磁盘少一半以上（${counts.chapters} < ${currentCounts.chapters}/2），拒绝写盘。`);
      return 1;
    }
    const courseEntry = { courseId: args.courseId, name: args.name, book: args.book, chapters };
    const source = { courseId: args.courseId, book: args.book, pages: [...pages] };
    const doc = args.replace
      ? buildOutlineDoc(chapters, { courseId: args.courseId, name: args.name, book: args.book, pages })
      : mergeCourse(currentDoc, courseEntry, source);
    const result = await store.writeDocument('knowledgeOutline', doc, {});
    summary.applied = Boolean(result.ok);
    summary.docCourses = Array.isArray(doc.courses) ? doc.courses.map((item) => item.courseId) : [];
    if (args.json) console.log(JSON.stringify({ ...summary, result }, null, 2));
    else if (!args.quiet) {
      console.log(result.ok
        ? `已写入 学习台/知识点大纲.json（${result.hash}）；现有课程：${summary.docCourses.join(', ')}`
        : `写盘失败：${result.reason}`);
    }
    return result.ok ? 0 : 3;
  }
  if (!args.json && !args.quiet) console.log('（预览模式，没有写盘；加 --apply 才写）');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(2);
  });
}
