import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findLatestManifest,
  loadLiveData,
  hasExplain,
  readOcrPageMap,
  sectionView,
  flattenManifest,
  summarizeSections,
  filterSections,
  renderTable,
  renderSectionLines,
  readPageText,
  renderPack,
  writePacks,
} from '../tools/explain-batches.mjs';

/** 建一个临时工作区：`<tmp>/学习台/` + 若干页文本文件 + 可选清单。 */
function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-batches-'));
  const dataDir = path.join(root, '学习台');
  const toolDir = path.join(root, '_工具');
  const bookDir = path.join(root, '数据结构', '教材', '_OCR', '数据结构教材');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });
  fs.mkdirSync(bookDir, { recursive: true });
  for (const page of [2, 3, 4, 5, 6, 7]) {
    fs.writeFileSync(path.join(bookDir, pageName(page)), `# 第 ${page} 页\n\n第 ${page} 页正文。\n`, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, toolDir, bookDir };
}

function writeJson(file, value, { bom = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${bom ? '\uFEFF' : ''}${JSON.stringify(value, null, 2)}`, 'utf8');
}

function pageName(page) {
  return `page${String(page).padStart(4, '0')}.md`;
}

function pageFile(root, page) {
  return { page, file: `数据结构/教材/_OCR/数据结构教材/${pageName(page)}` };
}

/** 铺一份最小现网数据：两个节点、其中 k_a 已有详解、教材登记进索引。 */
function seedLive(dataDir) {
  writeJson(path.join(dataDir, '知识点网络.json'), {
    version: 1,
    nodes: [
      { id: 'k_a', name: '时间复杂度', courseId: 'c_ds' },
      { id: 'k_b', name: '渐进复杂度', courseId: 'c_ds' },
    ],
  });
  writeJson(path.join(dataDir, '资料分析.json'), {
    version: 1,
    courses: [{ courseId: 'c_ds', points: [{ id: 'k_a', title: '时间复杂度', explain: '已生成详解' }] }],
    runs: [],
  });
  writeJson(path.join(dataDir, '资料索引.json'), { version: 1, files: [{ path: '数据结构/教材/数据结构教材.pdf', kind: 'textbook' }] });
}

function makeManifest(root) {
  return {
    generatedAt: '2026-10-25T06:46:40.000Z',
    courses: [
      {
        courseId: 'c_ds',
        courseName: '数据结构',
        book: { path: '数据结构/教材/数据结构教材.pdf', outDir: '数据结构/教材/_OCR/数据结构教材', pages: 412, donePages: 412, failedPages: [] },
        chapters: [
          {
            no: '1',
            title: '绪论',
            label: '第1章 绪论',
            page: 1,
            pageEnd: 26,
            sections: [
              {
                no: '1.1',
                title: '计算机与算法',
                page: 2,
                pageEnd: 3,
                missingOcr: [],
                pageFiles: [pageFile(root, 2), pageFile(root, 3)],
                nodeIds: [],
                nodeNames: [],
                hasExplain: false,
              },
              {
                no: '1.2',
                title: '复杂度度量',
                page: 4,
                pageEnd: 5,
                missingOcr: [],
                pageFiles: [pageFile(root, 4), pageFile(root, 5)],
                nodeIds: ['k_a'],
                nodeNames: ['时间复杂度'],
                hasExplain: true,
              },
              {
                no: '1.3',
                title: '复杂度分析',
                page: 6,
                pageEnd: 7,
                missingOcr: [7],
                pageFiles: [pageFile(root, 6)],
                nodeIds: ['k_b'],
                nodeNames: ['渐进复杂度'],
                hasExplain: false,
              },
            ],
          },
        ],
      },
      {
        courseId: 'c_phy',
        courseName: '物理',
        book: { path: '物理/教材/大学物理学下.pdf', pages: 457, donePages: 0 },
        chapters: [],
      },
    ],
  };
}

test('explain-batches：找最新清单（跳过不相干文件、空目录回 null）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(findLatestManifest(dir), null);
  const older = path.join(dir, '讲解预生成-输入清单_20261023.json');
  const newer = path.join(dir, '讲解预生成-输入清单_20261025.json');
  fs.writeFileSync(older, '{}');
  fs.writeFileSync(newer, '{}');
  fs.writeFileSync(path.join(dir, '别的清单.json'), '{}');
  const past = new Date('2026-10-23T00:00:00Z');
  const future = new Date('2026-10-25T00:00:00Z');
  fs.utimesSync(older, past, past);
  fs.utimesSync(newer, future, future);
  assert.equal(findLatestManifest(dir), newer);
});

test('explain-batches：三种节状态（done / ready / no-text）与「需建节点」标记', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  seedLive(dataDir);
  // 盘上真的缺第 7 页，§1.3 才该判缺文本（否则现盘扫描会把它救回来）
  fs.rmSync(path.join(root, '数据结构', '教材', '_OCR', '数据结构教材', 'page0007.md'));

  const live = loadLiveData(dataDir);
  assert.equal(live.nodesById.size, 2);
  assert.equal(live.pointsById.size, 1);
  assert.ok(live.indexedPaths.has('数据结构/教材/数据结构教材.pdf'));
  assert.equal(hasExplain(live.pointsById.get('k_a')), true);
  assert.equal(hasExplain(live.pointsById.get('k_b')), false);

  const all = flattenManifest(manifest, live, { root });
  const [s11, s12, s13] = all;
  assert.equal(s11.status, 'ready', '文本齐但没有节点 → ready');
  assert.equal(s11.needCreateNodes, true);
  assert.equal(s12.status, 'done', '节点已有详解 → done');
  assert.equal(s12.needCreateNodes, false);
  assert.deepEqual(s12.explainedIds, ['k_a']);
  assert.equal(s13.status, 'no-text', '页里有缺失就不再是 ready');
  assert.deepEqual(s13.missingPages, [7]);
  assert.equal(s13.chapterLabel, '第1章 绪论');
  assert.deepEqual(s13.pageFiles.map((item) => item.page), [6]);
});

test('explain-batches：页文本文件不存在按缺文本处理（清单与盘面漂移）', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  fs.rmSync(path.join(root, '数据结构', '教材', '_OCR', '数据结构教材', 'page0004.md'));
  const live = loadLiveData(dataDir);
  const view = sectionView(manifest.courses[0].chapters[0].sections[1], live, { root });
  assert.equal(view.status, 'no-text');
  assert.deepEqual(view.fileMissing, [4]);
});

test('explain-batches：按课/章/状态过滤 + 汇总统计 + 人读表', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  seedLive(dataDir);
  // 盘上故意缺第 7 页 → §1.3 按现盘算应判缺文本（清单快照也这么记，两边一致）
  fs.rmSync(path.join(root, '数据结构', '教材', '_OCR', '数据结构教材', 'page0007.md'));
  const live = loadLiveData(dataDir);
  const all = flattenManifest(manifest, live, { root });
  assert.equal(all.length, 3);

  assert.equal(filterSections(all, { course: 'c_ds' }).length, 3);
  assert.equal(filterSections(all, { course: 'c_phy' }).length, 0);
  assert.equal(filterSections(all, { only: 'ready' }).length, 1);
  assert.equal(filterSections(all, { chapter: '1', only: 'no-text' }).length, 1);

  const summary = summarizeSections(all);
  assert.equal(summary.total.sections, 3);
  assert.equal(summary.total.ready, 1);
  assert.equal(summary.total.done, 1);
  assert.equal(summary.total.noText, 1);
  assert.equal(summary.courses.length, 1);
  assert.equal(summary.courses[0].chapters, 1);
  assert.equal(summary.courses[0].nodes, 2);
  assert.equal(summary.courses[0].explained, 1);

  const table = renderTable(summary, {
    now: new Date('2026-10-25T16:00:00+08:00'),
    manifest: '清单.json',
    dataDir,
    noOutlineCourses: ['c_phy 物理'],
  });
  assert.match(table, /详解预生成批次台账/);
  assert.match(table, /c_ds/);
  assert.match(table, /ready 1/);
  assert.match(table, /无大纲/);
  assert.match(table, /--build/);
});

test('explain-batches：读页正文会剥掉 BOM 与首行「# 第 N 页」', (t) => {
  const { root } = makeWorkspace(t);
  const file = path.join(root, '数据结构', '教材', '_OCR', '数据结构教材', 'page0002.md');
  fs.writeFileSync(file, '\uFEFF# 第 2 页\n\n正文第一行\n正文第二行\n', 'utf8');
  assert.equal(readPageText(file), '正文第一行\n正文第二行');
});

test('explain-batches：输入包带上页号、正文、来源文件、闸门口径与模板', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  const live = loadLiveData(dataDir);
  const item = flattenManifest(manifest, live, { root })[0];
  const pages = item.pageFiles.map((entry) => ({ page: entry.page, file: entry.file, text: readPageText(path.join(root, entry.file)) }));
  const pack = renderPack(item, pages, { now: new Date('2026-10-25T08:00:00Z') });

  assert.match(pack, /# 输入包 · 数据结构 · §1\.1 计算机与算法/);
  assert.match(pack, /PDF 页 2–3（共 2 页）/);
  assert.match(pack, /### 第 2 页（源：`数据结构\/教材\/_OCR\/数据结构教材\/page0002\.md`）/);
  assert.match(pack, /第 2 页正文/);
  assert.match(pack, /不要写 id/);
  assert.match(pack, /质量闸门/);
  assert.match(pack, /explain.*≥ 300 字/);
  assert.match(pack, /"file": "数据结构\/教材\/数据结构教材\.pdf"/);
  assert.match(pack, /--gate --create-nodes --apply/);
  assert.match(pack, /run-c_ds-1\.1-20261025/);
});

test('explain-batches：按现盘 OCR 页重算缺页（清单快照过期时不再冤判缺文本）', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  const chapter = manifest.courses[0].chapters[0];
  // 清单快照当时只取到第 2 页，第 3 页记成「还没取字」，但盘上其实已经补上了
  chapter.sections[0].pageFiles = [pageFile(root, 2)];
  chapter.sections[0].missingOcr = [3];
  const live = loadLiveData(dataDir);

  const pageMap = readOcrPageMap('数据结构/教材/_OCR/数据结构教材', { root });
  assert.equal(pageMap.size, 6);
  assert.equal(pageMap.get(3), '数据结构/教材/_OCR/数据结构教材/page0003.md');

  const fresh = sectionView(chapter.sections[0], live, { root, pageMap });
  assert.deepEqual(fresh.missingPages, []);
  assert.equal(fresh.pageCount, 2);
  assert.equal(fresh.status, 'ready');

  const stale = sectionView(chapter.sections[0], live, { root });
  assert.deepEqual(stale.missingPages, [3], '不给现盘页表就照清单快照算');
  assert.equal(stale.status, 'no-text');
});

test('explain-batches：目录不存在时现盘页表是空 Map（不抛）', (t) => {
  const { root } = makeWorkspace(t);
  assert.equal(readOcrPageMap('', { root }).size, 0);
  assert.equal(readOcrPageMap('不存在的目录', { root }).size, 0);
});

test('explain-batches：节点以现盘网络为准（清单快照里没有、生成过的节点也能判 done）', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  const section = manifest.courses[0].chapters[0].sections[0]; // 清单里 nodeIds 为空
  seedLive(dataDir);
  writeJson(path.join(dataDir, '知识点网络.json'), {
    version: 1,
    nodes: [
      { id: 'k_new01', name: '起泡排序', courseId: 'c_ds', section: '1.1' },
      { id: 'k_new02', name: '算法要素', courseId: 'c_ds', section: '1.1' },
    ],
  });
  writeJson(path.join(dataDir, '资料分析.json'), {
    version: 1,
    courses: [{ courseId: 'c_ds', points: [{ id: 'k_new01', title: '起泡排序', explain: '已生成' }] }],
    runs: [],
  });
  const live = loadLiveData(dataDir);
  assert.equal(live.nodesBySection.get('c_ds|1.1').length, 2);

  const view = sectionView(section, live, { root, courseId: 'c_ds', bookPages: 412 });
  assert.equal(view.status, 'done');
  assert.deepEqual(view.nodeNames.sort(), ['起泡排序', '算法要素'].sort());
  assert.deepEqual(view.explainedIds, ['k_new01']);
  assert.equal(view.needCreateNodes, false);

  // 现盘没节点时仍按清单兜底（清单也没有 → ready 需建节点）
  const fresh = sectionView(section, loadLiveData(makeWorkspace(t).dataDir), { root, courseId: 'c_ds' });
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.needCreateNodes, true);
});

test('explain-batches：节点的 subsection 也算「本节有节点」（清单节号是教材小节号时）', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  const base = manifest.courses[0].chapters[0].sections[0];
  // 清单里这一节的编号其实是教材的小节号（如 3.2.1 是 3.2 的小节）
  const section = { ...base, no: '3.2.1', nodeIds: [], nodeNames: [] };
  seedLive(dataDir);
  writeJson(path.join(dataDir, '知识点网络.json'), {
    version: 1,
    nodes: [{ id: 'k_sub01', name: '二极管的开关特性', courseId: 'c_ds', section: '3.2', subsection: '3.2.1' }],
  });
  writeJson(path.join(dataDir, '资料分析.json'), {
    version: 1,
    courses: [{ courseId: 'c_ds', points: [{ id: 'k_sub01', title: '二极管的开关特性', explain: '已生成' }] }],
    runs: [],
  });
  const live = loadLiveData(dataDir);
  assert.equal(live.nodesBySection.get('c_ds|3.2').length, 1);
  assert.equal(live.nodesBySection.get('c_ds|3.2.1').length, 1, 'subsection 也要登记一份，否则这节永远算 ready');

  const view = sectionView(section, live, { root, courseId: 'c_ds', bookPages: 412 });
  assert.equal(view.status, 'done');
  assert.equal(view.needCreateNodes, false);
});

test('explain-batches：页范围不可用（从 0 页起/倒序）不按现盘扫描，单列计数', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  seedLive(dataDir);
  const section = manifest.courses[0].chapters[0].sections[0];
  section.page = 0;
  section.pageEnd = 412;
  section.pageFiles = [];
  section.missingOcr = [];

  const all = flattenManifest(manifest, loadLiveData(dataDir), { root });
  assert.equal(all[0].rangeInvalid, true);
  assert.equal(all[0].pageCount, 0);
  assert.equal(all[0].status, 'no-text');

  const summary = summarizeSections(all);
  assert.equal(summary.total.noRange, 1);
  assert.equal(summary.courses[0].noRange, 1);

  const lines = renderSectionLines(all);
  assert.match(lines, /页范围不可用/);
  assert.match(lines, /按目录人工标页/);

  // 倒序（清单里 §6.5 写成了 159–158）同样判不可用
  const inverted = sectionView({ no: '6.5', title: '图遍历', page: 159, pageEnd: 158 }, loadLiveData(dataDir), { root });
  assert.equal(inverted.rangeInvalid, true);
});

test('explain-batches：--build 只写 ready 的节，文件名带课程与节号', (t) => {
  const { root, dataDir } = makeWorkspace(t);
  const manifest = makeManifest(root);
  seedLive(dataDir);
  const live = loadLiveData(dataDir);
  const all = flattenManifest(manifest, live, { root });
  const outDir = path.join(root, '_工具', '_讲解输入包');
  const written = writePacks(all, outDir, { root, now: new Date('2026-10-25T08:00:00Z') });

  assert.equal(written.length, 2);
  assert.deepEqual(written.map((item) => item.no), ['1.1', '1.3']);
  assert.equal(written[0].courseId, 'c_ds');
  assert.equal(written[0].pages, 2);
  const file = path.join(outDir, 'c_ds-1.1.md');
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /第 2 页正文/);
  assert.match(text, /第 3 页正文/);
  const tail = fs.readFileSync(path.join(outDir, 'c_ds-1.3.md'), 'utf8');
  assert.match(tail, /第 7 页正文/);
});
