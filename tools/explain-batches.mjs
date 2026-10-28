#!/usr/bin/env node
/**
 * explain-batches —— 「详解预生成」的批次台账 + 输入包生成器（零依赖、对数据目录**只读**）。
 *
 * 为什么要有这个工具（2026-10-25 用户拍板：开发线收尾 + 详解预生成管线准备）：
 *   详解是**离线批量预生成**的（用户 2026-10-23 拍板，不现场跑），但开工前得先知道：
 *   哪些节文本齐了能开工、哪些节缺页、哪些节已有节点缺详解、哪些节连节点都没有（要 --create-nodes）。
 *   再往下，生成会话每开工一节都要自己找 `pageNNNN.md`、自己判断该读几页——既慢又容易把整本书读进上下文。
 *   所以把这两件事收进一个工具：
 *     ① 台账：读 `_工具/讲解预生成-输入清单_*.json`（扫描线/取字线的产物）＋ 现盘 学习台/ 四份文档，
 *        算出每节状态（done / ready / no-text）与「要不要建节点」；
 *     ② 输入包：`--build` 把某一节需要的 3–8 页正文拼成一个 md（带页号、节点现状、写作规范、闸门口径），
 *        生成会话直接读这一个文件，不用伸手找文件、也不会一次读整本书。
 *
 * 本工具**只写 `_工具/` 下的暂存件**（台账 JSON / 输入包 md），不碰 `学习台/` 任何文档——
 * 真正的落盘仍然只有一条路：`tools/analysis.mjs --merge <patch> --gate --create-nodes --apply`。
 *
 * 用法：
 *   node tools/explain-batches.mjs                          # 默认：控制台台账（只读）
 *   node tools/explain-batches.mjs --json                   # 机器可读
 *   node tools/explain-batches.mjs --course c_ds --chapter 2 # 只看某课某章
 *   node tools/explain-batches.mjs --out _工具/台账.json     # 台账落盘（人读 JSON）
 *   node tools/explain-batches.mjs --build _工具/_讲解输入包 --limit 3
 *        # 为「待生成」的节写输入包 md（默认全部；--limit 控制份数）
 *   node tools/explain-batches.mjs --manifest <file>        # 指定清单（默认取 _工具/ 里最新那份）
 *
 * 「状态」口径（一节只落一个状态，优先级从上到下）：
 *   no-text  该节页范围里有缺页（manifest 的 missingOcr）或页文本文件不存在 ⇒ 不能开工
 *   done     该节至少一个节点在 资料分析.json 里已有 explain ⇒ 不用再生成
 *   ready    文本齐、但还没有任何详解 ⇒ 可开工；其中「节下没有任何节点」的会标「需建节点」
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..', '..');
const DEFAULT_DATA_DIR = path.join(WORKSPACE, '学习台');
const DEFAULT_MANIFEST_DIR = path.join(WORKSPACE, '_工具');
const MANIFEST_PATTERN = /^讲解预生成-输入清单_.*\.json$/;
const DEFAULT_BUILD_DIR = path.join(WORKSPACE, '_工具', '_讲解输入包');
/** 《教材页码偏移》：大纲里的 page 是**书本印刷页码**，台账/输入包要的是 PDF 页序（PDF = book + offset）。 */
const DEFAULT_OFFSET_FILE = path.join(WORKSPACE, '_工具', '教材页码偏移.json');
/** 一个「节」的页范围超过这么多页就不信它（多半是清单里没标页码，写成了 0–全书页数）。 */
const MAX_SECTION_PAGES = 120;

const str = (value) => (typeof value === 'string' ? value : '');
const arr = (value) => (Array.isArray(value) ? value : []);
const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 读 JSON，容忍记事本/PowerShell 留下的 UTF-8 BOM。读不到或坏了返回 null（调用方决定要不要报错）。 */
export function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 在 `_工具/` 下找最新的 `讲解预生成-输入清单_*.json`（按修改时间；同时间按文件名倒序）。 */
export function findLatestManifest(dir = DEFAULT_MANIFEST_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && MANIFEST_PATTERN.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { file, name: entry.name, mtime };
    })
    .sort((a, b) => (b.mtime - a.mtime) || b.name.localeCompare(a.name, 'zh-Hans-CN'));
  return candidates.length > 0 ? candidates[0].file : null;
}

/**
 * 现盘只读快照：知识点网络（节点）、资料分析（详解）、资料索引（合法 sources.file）。
 * @param {string} dataDir 学习台目录
 */
export function loadLiveData(dataDir = DEFAULT_DATA_DIR) {
  const network = readJsonIfExists(path.join(dataDir, '知识点网络.json'));
  const analysis = readJsonIfExists(path.join(dataDir, '资料分析.json'));
  const index = readJsonIfExists(path.join(dataDir, '资料索引.json'));

  const nodes = arr(network?.nodes).filter(isObj);
  const nodesById = new Map();
  for (const node of nodes) {
    const id = str(node.id).trim();
    if (id !== '') nodesById.set(id, node);
  }
  const pointsById = new Map();
  for (const course of arr(analysis?.courses).filter(isObj)) {
    for (const point of arr(course.points).filter(isObj)) {
      const id = str(point.id).trim();
      if (id !== '') pointsById.set(id, point);
    }
  }
  const indexedPaths = new Set(arr(index?.files).filter(isObj).map((file) => str(file.path).trim()).filter(Boolean));
  // 按「课程 + 节号」建节点索引：清单是快照，生成过的节点只有现盘才知道。
  // 注意清单里的节号可能是教材的**小节号**（如 3.2.1 其实是 3.2 的小节、2.7.2 是 2.7 的小节），
  // 所以一个节点要同时登记到 section 与 subsection 两个键下，否则这几节会被永远算成「ready 需建节点」。
  const nodesBySection = new Map();
  for (const node of nodes) {
    const courseId = str(node.courseId).trim();
    if (courseId === '') continue;
    const places = new Set([str(node.section).trim(), str(node.subsection).trim()].filter((value) => value !== ''));
    for (const place of places) {
      const key = `${courseId}|${place}`;
      if (!nodesBySection.has(key)) nodesBySection.set(key, []);
      const bucket = nodesBySection.get(key);
      if (!bucket.some((item) => item.id === node.id)) bucket.push(node);
    }
  }
  return { nodes, nodesById, pointsById, indexedPaths, nodesBySection };
}

/** 某个知识点的详解是否已经预生成（有非空 explain）。 */
export function hasExplain(point) {
  return isObj(point) && str(point.explain).trim() !== '';
}

/**
 * 扫一遍某门课的 OCR 目录，得到「现盘上真有文本的页」→ `Map<page, 相对路径>`。
 * 清单是某一时刻的快照，扫描线还在往后跑；台账要按**现盘**算，否则永远显示「缺文本」。
 */
export function readOcrPageMap(outDir, options = {}) {
  const root = options.root ?? WORKSPACE;
  const map = new Map();
  if (str(outDir).trim() === '') return map;
  const dir = path.resolve(root, str(outDir));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    const match = /^page(\d{3,4})\.md$/i.exec(name);
    if (!match) continue;
    map.set(Number(match[1]), path.relative(root, path.join(dir, name)).split(path.sep).join('/'));
  }
  return map;
}

/**
 * 一节的视图：把 manifest 的节 + 现盘状态合成一行台账。
 * @param {object} section manifest 里的节对象（`{no,title,page,pageEnd,need,missingOcr,pageFiles,subs,nodeIds,nodeNames}`）
 * @param {object} live loadLiveData 的返回值
 * @param {{root?: string, pageMap?: Map<number,string>, bookPages?: number, courseId?: string}} [options]
 *   root：工作区目录；pageMap：现盘 OCR 页表（给了就按现盘重算缺页）；bookPages：总页数；courseId：用来按现盘找该节节点
 */
export function sectionView(section, live, options = {}) {
  const root = options.root ?? WORKSPACE;
  const pageMap = options.pageMap ?? null;
  const manifestPages = arr(section?.pageFiles).filter((item) => isObj(item) && num(item.page) !== null);
  const start = num(section?.page);
  const end = num(section?.pageEnd);
  let pageFiles = manifestPages.map((item) => ({ page: num(item.page), file: str(item.file).trim() }));
  let missingPages = arr(section?.missingOcr).map((value) => num(value)).filter((value) => value !== null);
  const bookPages = num(options.bookPages);
  const rangeInvalid = start === null || end === null || start < 1 || end < start
    || (end - start + 1) > MAX_SECTION_PAGES || (bookPages !== null && end > bookPages);

  // 清单是快照：只要拿到了现盘页表、且页范围可信，就按 [page, pageEnd] 重算「哪些页真有文本」
  if (pageMap && !rangeInvalid) {
    const present = [];
    const missing = [];
    for (let page = start; page <= end; page += 1) {
      if (pageMap.has(page)) present.push({ page, file: pageMap.get(page) });
      else missing.push(page);
    }
    pageFiles = present;
    missingPages = missing;
  }
  // 节点以**现盘网络**为准（清单是 06:46 快照，之后生成过的节点它不知道）；清单里的只作兜底
  const liveNodes = live.nodesBySection?.get(`${str(options.courseId).trim()}|${str(section?.no).trim()}`) ?? [];
  const manifestIds = arr(section?.nodeIds).map((value) => str(value).trim()).filter(Boolean);
  const manifestNames = arr(section?.nodeNames).map((value) => str(value).trim());
  const nameById = new Map();
  manifestIds.forEach((id, at) => nameById.set(id, manifestNames[at] ?? id));
  for (const node of liveNodes) {
    const id = str(node.id).trim();
    if (id !== '') nameById.set(id, str(node.name).trim() || id);
  }
  const nodeIds = [...nameById.keys()];
  const nodeNames = nodeIds.map((id) => nameById.get(id));
  const nodes = nodeIds.map((id) => live.nodesById.get(id)).filter(isObj);
  const explained = nodeIds.filter((id) => hasExplain(live.pointsById.get(id)));

  const fileMissing = [];
  for (const item of pageFiles) {
    const file = path.resolve(root, str(item.file));
    if (!fs.existsSync(file)) fileMissing.push(num(item.page));
  }

  let status;
  if (rangeInvalid) status = 'no-text';
  else if (pageFiles.length === 0 || missingPages.length > 0 || fileMissing.length > 0) status = 'no-text';
  else if (explained.length > 0) status = 'done';
  else status = 'ready';

  return {
    no: str(section?.no).trim(),
    title: str(section?.title).trim(),
    page: num(section?.page),
    pageEnd: num(section?.pageEnd),
    pageCount: pageFiles.length,
    pageFiles: pageFiles.map((item) => ({ page: num(item.page), file: str(item.file) })),
    missingPages,
    fileMissing,
    rangeInvalid,
    nodeIds,
    nodeNames,
    hasNodes: nodeIds.length > 0,
    explainedIds: explained,
    needCreateNodes: nodeIds.length === 0,
    status,
  };
}

/**
 * 读《教材页码偏移》：`{courses: {c_ds: {offset: 22}, …}}` → `Map<courseId, offset>`。
 * 偏移来自「拿大纲的节标题去 OCR 页里搜，命中页 − 大纲 page」的实测（见 `_工具/教材页码偏移.json` 的 evidence）。
 * @param {string} [file]
 * @returns {Map<string, number>}
 */
export function loadPageOffsets(file = DEFAULT_OFFSET_FILE) {
  const doc = readJsonIfExists(file);
  const out = new Map();
  for (const [courseId, info] of Object.entries(isObj(doc?.courses) ? doc.courses : {})) {
    const offset = num(info?.offset);
    if (offset !== null) out.set(String(courseId).trim(), offset);
  }
  return out;
}

/**
 * 大纲 → 清单形状的「章 / 节」骨架（清单是 10-25 的快照，某门课清单里没有章节时靠它兜底）。
 * 大纲只记每节的**起始书本页码**，这里加偏移换成 PDF 页序，再用「下一节起始 − 1」补出 pageEnd
 * （章末节自动跨到下一章第一节；全书最后一节用 bookPages）。
 * @param {object} outline `学习台/知识点大纲.json`
 * @param {string} courseId
 * @param {{offset?: number, bookPages?: number|null}} [options]
 * @returns {Array<object>} 与 manifest 的 `chapters[]` 同形
 */
export function chaptersFromOutline(outline, courseId, options = {}) {
  const course = arr(outline?.courses).filter(isObj).find((item) => str(item.courseId).trim() === str(courseId).trim());
  if (!course) return [];
  const offset = num(options.offset) ?? 0;
  const bookPages = num(options.bookPages);
  /** 页码可能是 null / ''（大纲里「还没标页」就是这个形状），别让 num() 把 null 掰成 0。 */
  const pageNum = (value) => (value === null || value === undefined || value === '' ? null : num(value));
  const chapters = arr(course.chapters).filter(isObj);
  const sectionLists = chapters.map((chapter) => arr(chapter.sections).filter(isObj));
  const starts = [];
  for (const list of sectionLists) {
    for (const section of list) {
      const book = pageNum(section.page);
      starts.push(book === null ? null : book + offset);
    }
  }
  const out = chapters.map((chapter, index) => ({
    no: String(chapter.no ?? '').trim(),
    title: str(chapter.title).trim(),
    page: pageNum(chapter.page) === null ? null : pageNum(chapter.page) + offset,
    sections: sectionLists[index],
  }));
  // 摊平顺序与 starts 对齐：逐章逐节写回页范围
  let cursor = 0;
  for (let ci = 0; ci < sectionLists.length; ci += 1) {
    const chapterEnd = pageNum(chapters[ci].pageEnd);
    const count = sectionLists[ci].length;
    const nextChapterStart = ci + 1 < sectionLists.length ? starts[cursor + count] : null;
    out[ci].sections = sectionLists[ci].map((section) => {
      const start = starts[cursor];
      const nextStart = cursor + 1 < starts.length ? starts[cursor + 1] : null;
      let end = start;
      if (start !== null) {
        if (nextStart !== null && nextStart > start) end = nextStart - 1;
        else if (nextStart !== null) end = start; // 下一节同页起 ⇒ 本节只占这一页
        else if (chapterEnd !== null && chapterEnd >= start) end = chapterEnd; // 章末节：用章自己的结束页
        else if (nextChapterStart !== null && nextChapterStart > start) end = nextChapterStart - 1;
        else if (bookPages !== null && bookPages >= start) end = bookPages;
      }
      cursor += 1;
      return {
        no: str(section.no).trim(),
        title: str(section.title).trim(),
        page: start,
        pageEnd: end,
        subs: arr(section.subs).map((sub) => ({ no: str(sub?.no).trim(), title: str(sub?.title).trim() })),
        fromOutline: true,
      };
    });
  }
  return out.filter((chapter) => chapter.sections.length > 0);
}

/**
 * 只取大纲里某一章的节（清单里那一章只有章头、没有节时用，如数电第 1 章）。
 * @param {object} outline
 * @param {string} courseId
 * @param {string|number} chapterNo
 * @param {{offset?: number, bookPages?: number|null}} [options]
 * @returns {Array<object>}
 */
export function chapterSectionsFromOutline(outline, courseId, chapterNo, options = {}) {
  const chapters = chaptersFromOutline(outline, courseId, options);
  const target = chapters.find((chapter) => String(chapter.no).trim() === String(chapterNo ?? '').trim());
  return target ? target.sections : [];
}

/**
 * 把整份 manifest 摊平成带章上下文的节列表。
 * @param {object} manifest 讲解预生成输入清单 JSON
 * @param {object} live loadLiveData 的返回值
 * @param {{root?: string, outline?: object, offsets?: Map<string, number>}} [options]
 *   outline：现盘 `学习台/知识点大纲.json`（清单里没章节的课用它兜底）；offsets：书本页码 → PDF 页序的偏移
 * @returns {Array<object>} 每项含 courseId/courseName/book/chapterNo/chapterTitle + sectionView 字段
 */
export function flattenManifest(manifest, live, options = {}) {
  const out = [];
  const offsets = options.offsets instanceof Map ? options.offsets : new Map();
  for (const course of arr(manifest?.courses).filter(isObj)) {
    const courseId = str(course.courseId).trim();
    const courseName = str(course.courseName).trim();
    const book = isObj(course.book)
      ? {
        path: str(course.book.path).trim(),
        pages: num(course.book.pages),
        donePages: num(course.book.donePages),
        outDir: str(course.book.outDir).trim(),
        livePages: null,
      }
      : { path: '', pages: null, donePages: null, outDir: '', livePages: null };
    const pageMap = book.outDir === '' ? null : readOcrPageMap(book.outDir, { root: options.root });
    if (pageMap) book.livePages = pageMap.size;
    let chapters = arr(course.chapters).filter(isObj);
    // 清单是 10-25 的快照：那之后才解析出大纲的课（如物理）在清单里「有章无节」，
    // 退回现盘大纲补出节骨架，否则这门课永远进不了台账。
    if (chapters.every((chapter) => arr(chapter.sections).length === 0)) {
      const fromOutline = chaptersFromOutline(options.outline, courseId, {
        offset: offsets.get(courseId) ?? 0,
        bookPages: book.pages,
      });
      if (fromOutline.length > 0) chapters = fromOutline;
    }
    for (const chapter of chapters) {
      const chapterNo = str(chapter.no).trim();
      let chapterTitle = str(chapter.title).trim();
      let chapterLabel = str(chapter.label).trim() || (chapterTitle === '' ? `第${chapterNo}章` : `第${chapterNo}章 ${chapterTitle}`);
      let sectionList = arr(chapter.sections).filter(isObj);
      // 清单是 10-25 的快照：那之后才补出节结构的章（如数电第 1 章）在清单里只有章头，
      // 用现盘大纲同一章补节，否则这一章永远进不了台账。
      if (sectionList.length === 0) {
        const fromOutline = chapterSectionsFromOutline(options.outline, courseId, chapterNo, {
          offset: offsets.get(courseId) ?? 0,
          bookPages: book.pages,
        });
        if (fromOutline.length > 0) {
          sectionList = fromOutline;
          // 章名以大纲为准（清单快照里的章名可能还是旧的，如「信息和编码」）
          const outlineCourse = arr(options.outline?.courses).filter(isObj)
            .find((item) => str(item.courseId).trim() === courseId);
          const outlineChapter = arr(outlineCourse?.chapters).filter(isObj)
            .find((item) => String(item.no ?? '').trim() === chapterNo);
          const outlineTitle = str(outlineChapter?.title).trim();
          if (outlineTitle !== '') {
            chapterTitle = outlineTitle;
            chapterLabel = `第${chapterNo}章 ${outlineTitle}`;
          }
        }
      }
      for (const section of sectionList) {
        out.push({
          courseId,
          courseName,
          book,
          chapterNo,
          chapterTitle,
          chapterLabel,
          chapterPage: num(chapter.page),
          chapterPageEnd: num(chapter.pageEnd),
          ...sectionView(section, live, { ...options, pageMap, bookPages: book.pages, courseId }),
        });
      }
    }
  }
  return out;
}

/** 按课程聚合统计（台账表头用）。 */
export function summarizeSections(sections) {
  const byCourse = new Map();
  for (const section of arr(sections)) {
    const key = section.courseId;
    if (!byCourse.has(key)) {
      byCourse.set(key, {
        courseId: key,
        courseName: section.courseName,
        book: section.book,
        sections: 0,
        done: 0,
        ready: 0,
        noText: 0,
        readyToCreate: 0,
        noRange: 0,
        chapters: new Set(),
        nodes: new Set(),
        explained: new Set(),
        pages: 0,
      });
    }
    const row = byCourse.get(key);
    row.sections += 1;
    row.chapters.add(section.chapterNo);
    row.pages += section.pageCount;
    if (section.status === 'done') row.done += 1;
    else if (section.status === 'ready') {
      row.ready += 1;
      if (section.needCreateNodes) row.readyToCreate += 1;
    } else {
      row.noText += 1;
      if (section.rangeInvalid) row.noRange += 1;
    }
    for (const id of section.nodeIds) row.nodes.add(id);
    for (const id of section.explainedIds) row.explained.add(id);
  }
  const courses = [...byCourse.values()].map((row) => ({
    ...row,
    chapters: row.chapters.size,
    nodes: row.nodes.size,
    explained: row.explained.size,
  }));
  const total = {
    courses: courses.length,
    sections: courses.reduce((sum, row) => sum + row.sections, 0),
    done: courses.reduce((sum, row) => sum + row.done, 0),
    ready: courses.reduce((sum, row) => sum + row.ready, 0),
    noText: courses.reduce((sum, row) => sum + row.noText, 0),
    readyToCreate: courses.reduce((sum, row) => sum + row.readyToCreate, 0),
    noRange: courses.reduce((sum, row) => sum + row.noRange, 0),
    pages: courses.reduce((sum, row) => sum + row.pages, 0),
  };
  return { courses, total };
}

/** 过滤：--course / --chapter / --only（status）。 */
export function filterSections(sections, options = {}) {
  const courseId = str(options.course).trim();
  const chapterNo = str(options.chapter).trim();
  const only = str(options.only).trim();
  return arr(sections).filter((section) => {
    if (courseId !== '' && section.courseId !== courseId) return false;
    if (chapterNo !== '' && String(section.chapterNo) !== chapterNo) return false;
    if (only !== '' && section.status !== only) return false;
    return true;
  });
}

/** 人读台账（控制台）。 */
export function renderTable(summary, options = {}) {
  const lines = [];
  const stamp = options.now instanceof Date ? options.now : new Date();
  lines.push(`详解预生成批次台账（${formatTime(stamp)}）`);
  lines.push(`清单：${options.manifest ?? '(未知)'}`);
  if (options.dataDir) lines.push(`数据目录：${options.dataDir}`);
  lines.push('');
  for (const course of arr(summary?.courses)) {
    const book = course.book ?? {};
    const pages = book.pages === null ? '?' : book.pages;
    const livePages = book.livePages ?? book.donePages;
    const donePages = livePages === null || livePages === undefined ? '?' : livePages;
    const drift = book.livePages !== null && book.livePages !== undefined && book.donePages !== null && book.donePages !== undefined && book.livePages !== book.donePages
      ? `（清单快照写 ${book.donePages} 页，现盘多 ${book.livePages - book.donePages} 页）`
      : '';
    lines.push(`课程 ${course.courseId} ${course.courseName}（${book.path || '无教材'} · ${donePages}/${pages} 页已取字${drift}）`);
    lines.push(`  章 ${course.chapters} ｜ 大纲${course.sections} 节 ｜ 有节点 ${course.nodes} 个（已详解 ${course.explained}）`
      + ` ｜ ready ${course.ready}（其中需建节点 ${course.readyToCreate}）｜ done ${course.done} ｜ 缺文本 ${course.noText}`
      + (course.noRange > 0 ? `（其中页范围不可用 ${course.noRange}）` : ''));
    const blocked = course.sections - course.ready - course.done - course.noText;
    if (blocked !== 0) lines.push(`  ⚠ 分类对不上：${blocked} 节既不算 ready/done 也不算缺文本`);
  }
  const total = summary?.total ?? {};
  lines.push('');
  lines.push(`合计：${total.courses ?? 0} 门课 ｜ ${total.sections ?? 0} 节 ｜ ready ${total.ready ?? 0} ｜ done ${total.done ?? 0}`
    + ` ｜ 缺文本 ${total.noText ?? 0} ｜ 可读页 ${total.pages ?? 0}`);
  if (arr(options.noOutlineCourses).length > 0) {
    lines.push(`无大纲/无章节结构：${arr(options.noOutlineCourses).join('、')}（等大纲解析或手写后再进台账）`);
  }
  lines.push('');
  lines.push('下一步：');
  lines.push('  --build <目录> --limit N   为 ready 的节写输入包（一次 3–8 页，生成会话直接读）');
  lines.push('  --json / --out <file>     机器可读台账 / 落盘');
  return lines.join('\n');
}

/** 逐节明细（筛选后台账用）：`§no 标题 · PDF 页 a–b · 状态 · 缺哪几页`。 */
export function renderSectionLines(sections, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Number(options.limit) : 40;
  const lines = [];
  for (const section of arr(sections).slice(0, limit)) {
    const range = section.page === null || section.page === undefined
      ? '页?'
      : `p.${section.page}${section.pageEnd && section.pageEnd !== section.page ? `–${section.pageEnd}` : ''}`;
    const statusText = {
      ready: section.needCreateNodes ? 'ready（需建节点）' : 'ready（补详解）',
      done: 'done（已详解）',
      'no-text': '缺文本',
    }[section.status] ?? section.status;
    const extra = [];
    if (section.rangeInvalid) {
      extra.push(`页范围不可用（清单写 p.${section.page ?? '?'}–${section.pageEnd ?? '?'}，要先按目录人工标页）`);
    } else if (section.status === 'no-text' && section.missingPages.length > 0) {
      const shown = section.missingPages.slice(0, 6).join(', ');
      extra.push(`缺 p.${shown}${section.missingPages.length > 6 ? ` 等 ${section.missingPages.length} 页` : ''}`);
    }
    if (section.status === 'no-text' && section.fileMissing.length > 0) extra.push(`页文件不在盘：${section.fileMissing.slice(0, 4).join(', ')}`);
    if (section.nodeNames.length > 0) extra.push(`节点：${section.nodeNames.join('、')}`);
    lines.push(`  §${section.no} ${section.title} · ${section.chapterLabel} · ${range} · ${statusText}`
      + (extra.length > 0 ? ` · ${extra.join(' · ')}` : ''));
  }
  return lines.join('\n');
}

function formatTime(date) {  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 读一页正文（去掉 BOM 与首行 `# 第 N 页`，首行由输入包自己写页号）。 */
export function readPageText(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return text.replace(/^\s*#\s*第\s*\d+\s*页\s*\r?\n+/, '').trim();
}

/**
 * 生成一节输入包的 markdown。pages: `[{page, file, text}]`（text 是已读出来的正文）。
 * @returns {string}
 */
export function renderPack(item, pages, options = {}) {
  const bookPath = str(item.book?.path).trim();
  const lines = [];
  lines.push(`# 输入包 · ${item.courseName || item.courseId} · §${item.no} ${item.title}`);
  lines.push('');
  lines.push('> 由 `_plugins/study-assistant/tools/explain-batches.mjs --build` 生成。**本文件只读**：不要改它，产物写 patch。');
  lines.push(`> 课程：\`${item.courseId}\` ${item.courseName} ｜ 教材：\`${bookPath || '（清单没记教材路径）'}\`（页码一律 **PDF 页序**）`);
  lines.push(`> 章：${item.chapterLabel} ｜ 节：§${item.no} ${item.title} ｜ PDF 页 ${item.page ?? '?'}–${item.pageEnd ?? '?'}（共 ${pages.length} 页）`);
  lines.push(`> 现有节点：${item.hasNodes ? item.nodeIds.map((id, at) => `${item.nodeNames[at] || id}（\`${id}\`）`).join('、') : '无 —— 写 patch 时**不要写 id**，落盘加 `--create-nodes` 由工具建节点'}`);
  if (item.nodeIds.length > 0) {
    const missing = item.nodeIds.filter((id) => !item.explainedIds.includes(id));
    if (missing.length > 0) lines.push(`> 缺详解的节点：${missing.map((id) => `\`${id}\``).join('、')}（这些就是要补的；不要新造重复节点）`);
  }
  lines.push('');
  lines.push('## 一、写作规范（摘要；详版见 `_工具/资料分析会话-执行命令_20261023.md` §3）');
  lines.push('1. **先说人话**：这一段解决什么问题、不用它会怎样；再上定义与符号。');
  lines.push('2. **术语第一次出现必须解释**，别假设读者知道（渐进复杂度、主元、秩……）。');
  lines.push('3. **公式给两遍**：`tex` 给会读的人，`plain` 用一句话说这个公式在讲什么。');
  lines.push('4. **必须给一个生活化比方**（`analogy`），比方要贴切、不要硬凑。');
  lines.push('5. **易错点写「错在哪 + 怎么避免」**（`pitfalls`），不要只写「注意」。');
  lines.push('6. **例题要有步骤**（`examples[].steps` 一步一条）+ `answer` + `method`（套路）。');
  lines.push('7. 每段 2–4 句；一个点的 `explain` 400–900 字（硬门槛 ≥300 字），别写成论文。');
  lines.push('');
  lines.push('## 二、质量闸门（落盘时会卡）');
  lines.push('- `explain` ≥ 300 字、`keywords` ≥ 3、`pitfalls` ≥ 2、`examples` ≥ 1、`sources` ≥ 1；');
  lines.push(`- \`sources[].file\` 必须是 \`学习台/资料索引.json\` 里登记过的 path（本书即 \`${bookPath || '…'}\`），\`page\` 用 PDF 页序，不确定写 \`null\`；`);
  lines.push('- 不许出现「见上文 / 如下表 / 同上」这类跳步；');
  lines.push('- 不许编造：文本里没有的结论要标 `【补充】` 并说明依据（图片页公式按标准定义补全时尤其要标）。');
  lines.push('');
  lines.push('## 三、页文本');
  for (const page of arr(pages)) {
    lines.push('');
    lines.push(`### 第 ${page.page} 页（源：\`${page.file}\`）`);
    lines.push('');
    lines.push(page.text === '' ? '（本页取字为空——图片页，按标准定义补全并标【补充】）' : page.text);
  }
  lines.push('');
  lines.push('## 四、patch 模板（把 ⟨…⟩ 换成实际内容；落盘命令在最后）');
  lines.push('```jsonc');
  lines.push('{');
  lines.push(`  "courseId": "${item.courseId}",`);
  lines.push('  "runs": [{');
  lines.push(`    "id": "run-${item.courseId}-${item.no}-${stampId(options.now)}",`);
  lines.push(`    "at": "${(options.now instanceof Date ? options.now : new Date()).toISOString()}",`);
  lines.push('    "kind": "textbook",');
  lines.push(`    "courseId": "${item.courseId}",`);
  lines.push('    "model": "⟨你这一轮用的模型名⟩",');
  lines.push(`    "scope": "§${item.no} ${item.title}",`);
  lines.push('    "produced": { "points": ⟨N⟩, "exercises": 0, "questions": 0 },');
  lines.push('    "notes": ""');
  lines.push('  }],');
  lines.push('  "points": [{');
  lines.push(`    "no": "${item.no}",`);
  lines.push('    "title": "⟨知识点名⟩",');
  lines.push('    "level": "core",');
  lines.push('    "keywords": ["⟨词1⟩", "⟨词2⟩", "⟨词3⟩"],');
  lines.push('    "explain": "⟨第一段⟩\\n\\n⟨第二段⟩",');
  lines.push('    "analogy": "⟨打个比方：…⟩",');
  lines.push('    "formulas": [{ "tex": "⟨tex⟩", "plain": "⟨一句话解释⟩" }],');
  lines.push('    "pitfalls": ["⟨错在哪 + 怎么避免⟩", "⟨…⟩"],');
  lines.push('    "examples": [{ "prompt": "⟨题干⟩", "steps": ["⟨第 1 步⟩", "⟨第 2 步⟩"], "answer": "⟨答⟩", "method": "⟨套路⟩" }],');
  lines.push(`    "sources": [{ "file": "${bookPath || '⟨资料索引里的 path⟩'}", "page": ${item.page ?? 'null'}, "quote": "⟨原文摘句⟩" }],`);
  lines.push('    "generatedAt": "⟨ISO 时间⟩",');
  lines.push('    "model": "⟨模型名⟩"');
  lines.push('  }]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## 五、落盘与自检');
  lines.push('```');
  lines.push(`cd _plugins/study-assistant`);
  lines.push(`node tools/analysis.mjs --merge ../../_工具/资料分析补丁/${item.courseId}-${item.no}.json --gate --create-nodes --apply   # 先不带 --apply 预览`);
  lines.push('node tools/analysis.mjs --validate');
  lines.push('```');
  return lines.join('\n');
}

function stampId(now) {
  const date = now instanceof Date ? now : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * 为若干节写输入包文件。
 * @returns {Array<{no: string, courseId: string, file: string, pages: number, skipped: string[]}>}
 */
export function writePacks(sections, outDir, options = {}) {
  const root = options.root ?? WORKSPACE;
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const item of arr(sections)) {
    const pages = [];
    const skipped = [];
    for (const entry of arr(item.pageFiles)) {
      const file = path.resolve(root, entry.file);
      try {
        const text = readPageText(file);
        pages.push({ page: entry.page, file: entry.file, text });
      } catch {
        skipped.push(entry.page);
      }
    }
    if (item.status !== 'ready') continue;
    const name = `${item.courseId}-${item.no.replace(/[^\w.-]/g, '_')}.md`;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, renderPack(item, pages, { now: options.now }), 'utf8');
    written.push({ courseId: item.courseId, no: item.no, file, pages: pages.length, skipped });
  }
  return written;
}

/** 命令行里的相对路径一律按**工作区**解析（本工具常从插件目录 `cd` 进去跑，按 cwd 会写错地方）。 */
function resolveFromWorkspace(value) {
  const text = str(value).trim();
  if (text === '') return '';
  return path.isAbsolute(text) ? text : path.resolve(WORKSPACE, text);
}

function parseArgs(argv) {
  const out = {
    dataDir: DEFAULT_DATA_DIR,
    manifest: '',
    manifestDir: DEFAULT_MANIFEST_DIR,
    course: '',
    chapter: '',
    only: '',
    json: false,
    out: '',
    build: '',
    limit: 0,
    quiet: false,
    help: false,
    outline: '',
    offsets: DEFAULT_OFFSET_FILE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--manifest') { i += 1; out.manifest = resolveFromWorkspace(argv[i]); }
    else if (arg === '--manifest-dir') { i += 1; out.manifestDir = resolveFromWorkspace(argv[i]) || out.manifestDir; }
    else if (arg === '--data') { i += 1; out.dataDir = resolveFromWorkspace(argv[i]) || out.dataDir; }
    else if (arg === '--course') { i += 1; out.course = str(argv[i]); }
    else if (arg === '--chapter') { i += 1; out.chapter = str(argv[i]); }
    else if (arg === '--only') { i += 1; out.only = str(argv[i]); }
    else if (arg === '--out') { i += 1; out.out = resolveFromWorkspace(argv[i]); }
    else if (arg === '--build') { i += 1; out.build = resolveFromWorkspace(argv[i]) || DEFAULT_BUILD_DIR; }
    else if (arg === '--limit') { i += 1; out.limit = Math.max(0, Number(argv[i]) || 0); }
    else if (arg === '--root') { i += 1; out.root = resolveFromWorkspace(argv[i]) || WORKSPACE; }
    else if (arg === '--outline') { i += 1; out.outline = resolveFromWorkspace(argv[i]); }
    else if (arg === '--offsets') { i += 1; out.offsets = resolveFromWorkspace(argv[i]) || DEFAULT_OFFSET_FILE; }
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node tools/explain-batches.mjs [--manifest <file>] [--data <目录>] [--course <id>] [--chapter <no>]'
      + ' [--only ready|done|no-text] [--json] [--out <file>] [--build <目录>] [--limit <n>]'
      + ' [--outline <知识点大纲.json>] [--offsets <教材页码偏移.json>]');
    return 0;
  }
  const manifestFile = args.manifest !== '' ? args.manifest : findLatestManifest(args.manifestDir);
  if (!manifestFile) {
    console.error(`找不到输入清单：${args.manifestDir} 下没有 讲解预生成-输入清单_*.json（可用 --manifest 指定）`);
    return 2;
  }
  const manifest = readJsonIfExists(manifestFile);
  if (!manifest) {
    console.error(`清单读不了或不是合法 JSON：${manifestFile}`);
    return 2;
  }
  const live = loadLiveData(args.dataDir);
  const outlineFile = args.outline !== '' ? args.outline : path.join(args.dataDir, '知识点大纲.json');
  const outline = readJsonIfExists(outlineFile);
  const offsets = loadPageOffsets(args.offsets ?? DEFAULT_OFFSET_FILE);
  const all = flattenManifest(manifest, live, { root: args.root ?? WORKSPACE, outline, offsets });
  const filtered = filterSections(all, args);
  const summary = summarizeSections(filtered);
  // 台账算完还一节都没有的课，才算「无大纲/无章节结构」（清单里没章节、现盘大纲也补不上）
  const coveredCourses = new Set(all.map((section) => section.courseId));
  const noOutlineCourses = arr(manifest.courses)
    .filter((course) => isObj(course) && !coveredCourses.has(str(course.courseId).trim()))
    .map((course) => `${str(course.courseId)} ${str(course.courseName)}`);

  const result = {
    generatedAt: new Date().toISOString(),
    manifest: manifestFile,
    outline: outlineFile,
    dataDir: args.dataDir,
    summary,
    noOutlineCourses,
    sections: filtered,
  };

  if (args.build !== '') {
    const ready = filtered.filter((section) => section.status === 'ready');
    const targets = args.limit > 0 ? ready.slice(0, args.limit) : ready;
    const written = writePacks(targets, args.build, { root: args.root ?? WORKSPACE });
    result.build = { dir: args.build, written: written.length, files: written };
  }

  if (args.out !== '') {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!args.quiet) {
    console.log(renderTable(summary, { manifest: manifestFile, dataDir: args.dataDir, noOutlineCourses }));
    // 带了筛选（--course/--chapter/--only）就把命中的节逐条列出来，否则「缺文本 10」看不出缺在哪
    if (args.course !== '' || args.chapter !== '' || args.only !== '') {
      const detail = renderSectionLines(filtered, { limit: args.limit > 0 ? args.limit : 40 });
      if (detail !== '') {
        console.log('');
        console.log(detail);
        if (filtered.length > (args.limit > 0 ? args.limit : 40)) console.log(`  …共 ${filtered.length} 节`);
      }
    }
    if (args.build !== '') {
      console.log('');
      console.log(`已写输入包 ${result.build.written} 份 → ${args.build}`);
      for (const file of arr(result.build.files).slice(0, 10)) console.log(`  ${path.relative(WORKSPACE, file.file)}（${file.pages} 页）`);
      if (result.build.written > 10) console.log(`  …共 ${result.build.written} 份`);
    }
    if (args.out !== '') {
      console.log('');
      console.log(`台账已写：${args.out}`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(2);
  });
}
