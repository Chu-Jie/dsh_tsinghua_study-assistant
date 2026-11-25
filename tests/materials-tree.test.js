/**
 * 资料树渲染（2026-11-25 卡 ⑥ / ⑨）：五组四棵树、0 组不画、>200 折叠、`_OCR` 折成一行。
 *
 * 这里只调 bundle 里那批**纯函数**（吃 scan + opts，不碰 React 状态），
 * 所以既不用真浏览器，也不会碰到磁盘：结构对不对，跑一次就看得出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const FULL_FILE = path.join(HERE, '..', 'client.full.js');
const SHIPPED_FILE = path.join(HERE, '..', 'client.js');

/** 极简 React 替身（照 tests/client.test.js 的口径）：组件同步调用，effect/state 都不用真跑。 */
function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
    },
  };
}

/** 在最小假环境里跑 bundle，返回 internals。 */
function loadClient() {
  const context = {
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }),
    document: {
      head: { appendChild() {} },
      createElement() { return { setAttribute() {}, textContent: '' }; },
      querySelector: () => null,
    },
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      const fakeRequire = (specifier) => {
        assert.equal(specifier, 'react', `客户端只允许 require('react')，实际请求了 ${specifier}`);
        return createFakeReact();
      };
      context.__exports = registration.factory(fakeRequire);
    },
  };
  vm.runInNewContext(fs.readFileSync(FULL_FILE, 'utf8'), context, { filename: FULL_FILE });
  const half = context.__exports;
  const ctx = {
    logger: { info() {}, warn() {} },
    slots: { inject(slot, cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; }, register() { return () => {}; } },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
    get() { return undefined; },
  };
  half.apply(ctx);
  return half.DESCRIPTORS.internals;
}

/** 摊平元素树，取出所有可读文本（连着 children）。 */
function textOf(tree) {
  const out = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    (node.children ?? []).forEach(walk);
  })(tree);
  return out.join('');
}

/** 摊平元素树，取出所有节点（保留 type/props，便于断言行结构与按钮）。 */
function flatten(tree) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || node === undefined || typeof node !== 'object') return;
    out.push(node);
    (node.children ?? []).forEach(walk);
  })(tree);
  return out;
}

function file(filePath, extra = {}) {
  const norm = String(filePath).replace(/\\/gu, '/');
  const name = norm.split('/').filter(Boolean).pop();
  const dot = name.lastIndexOf('.');
  return {
    path: norm,
    name,
    size: 1024 * 1024,
    ext: dot > 0 ? name.slice(dot).toLowerCase() : '',
    mtime: '2026-10-30T08:00:00.000Z',
    pages: null,
    state: 'unindexed',
    ...extra,
  };
}

/** 一份最小但结构完整的单科扫描结果（形状与 `GET /materials/scan?course=` 一致）。 */
function makeScan(overrides = {}) {
  return {
    courseId: 'c_disc',
    courseName: '离散数学',
    dir: '离散数学',
    total: 20,
    bytes: 1024,
    skipped: [],
    counts: { textbook: 2, textbookOcr: 3, textbookOcrPages: 3, ppt: 1, exercise: 4, lecture: 1, other: 2 },
    groups: [
      {
        id: 'textbook',
        title: '教材',
        count: 5,
        ocrCount: 3,
        sections: [
          {
            id: 'files',
            title: '教材原件',
            kind: 'files',
            count: 2,
            root: { id: '教材', name: '教材', count: 2, files: [file('离散数学/教材/离散数学.pdf', { pages: 812, state: 'ocr' })], nodes: [], texts: [] },
          },
          {
            id: 'ocr',
            title: '教材 OCR',
            kind: 'ocr',
            count: 3,
            roots: [{
              id: 'ocr-1',
              path: '离散数学/_OCR',
              count: 1603,
              pageCount: 1603,
              books: [{ id: 'b1', name: '离散数学.pdf', count: 1603, pageCount: 1603, files: 1603, pages: [1], firstPage: 1, lastPage: 1603, idxPath: null }],
            }],
          },
        ],
      },
      { id: 'ppt', title: 'PPT', count: 1, sections: [{ id: 'ppt', title: 'PPT', kind: 'files', count: 1, root: { id: 'ppt', name: '教材/ppt', count: 1, files: [file('离散数学/教材/ppt/12静电场.pptx', { state: 'text' })], nodes: [], texts: [] } }] },
      { id: 'exercise', title: '习题', count: 4, sections: [{ id: 'exercise', title: '习题', kind: 'files', count: 4, root: { id: '作业', name: '作业', count: 4, files: [], nodes: [{ id: '作业/第01次', name: '第01次', count: 4, files: [file('离散数学/作业/第01次/第01次作业.pdf')], texts: [{ id: 't1', name: '第01次作业_OCR文本', count: 3, idxPath: null }] }], texts: [] } }] },
      { id: 'lecture', title: '讲义', count: 1, sections: [{ id: 'lecture', title: '讲义', kind: 'files', count: 1, root: { id: '讲义', name: '讲义', count: 1, files: [file('离散数学/讲义/第01章.md', { state: 'text', ext: '.md' })], nodes: [], texts: [] } }] },
      { id: 'other', title: '其他', count: 2, sections: [{ id: 'other', title: '其他', kind: 'files', count: 2, root: { id: 'other', name: '其他', count: 2, files: [file('离散数学/README.md'), file('离散数学/复习/x.zip')], nodes: [], texts: [] } }] },
    ],
    ...overrides,
  };
}

test('① 五组顺序固定、0 条的组不画（卡 ⑥.1）', () => {
  const lib = loadClient();
  const scan = makeScan();
  // 故意塞一个 count=0 的组进去（后端本来就该滤掉，前端再兜一层）
  scan.groups.push({ id: 'empty', title: '空组', count: 0, sections: [] });

  const rows = flatten(lib.renderMaterialGroups(scan, { isOpen: () => false }));
  const heads = rows
    .filter((node) => String(node.props?.className ?? '').includes('sa-mat-group-row'))
    .map(textOf);
  assert.equal(heads.length, 5, `五组都要出现（实际：${heads.join(' / ')}）`);
  const order = ['教材', 'PPT', '习题', '讲义', '其他'];
  heads.forEach((text, index) => {
    const title = text.replace(/^[▸▾]\s*/u, '');
    assert.ok(title.startsWith(order[index]), `第 ${index + 1} 组应是「${order[index]}」，实际：${text}`);
  });
  assert.ok(!heads.join('').includes('空组'), '0 条的组不该画出来');

  // 组默认收起：只画组头，不画组内任何一条
  const leavesCollapsed = rows.filter((node) => String(node.props?.className ?? '').includes('sa-mat-leaf'));
  assert.equal(leavesCollapsed.length, 0, '全部默认收起时不该有叶子行');
});

test('② 展开教材：原件与 OCR 两个子节，OCR 只给一行「N 个取字页」', () => {
  const lib = loadClient();
  const scan = makeScan();
  const open = (key) => key === 'group:textbook' || key === 'section:textbook:files' || key === 'section:textbook:ocr';
  const rows = flatten(lib.renderMaterialGroups(scan, { isOpen: open }));
  const text = textOf(rows);

  assert.ok(text.includes('教材原件'), '教材组内要有「教材原件」子节');
  assert.ok(text.includes('教材 OCR'), '教材组内要有「教材 OCR」子节');
  assert.ok(text.includes('离散数学.pdf'), '教材原件要列出书名');
  assert.ok(text.includes('812 页'), '能探测到页数的要写页数');
  assert.ok(text.includes('1603 个取字页'), `OCR 目录要折成一行（实际：${text}）`);
  assert.ok(!/page\d{4}\.md/u.test(text), '`_OCR` 目录里那几千个页级 md 文件名一个都不许露出来');
});

test('③ 大目录保护：>200 条先画 200 条 + 一行「还有 N 个」（卡 ⑥.5）', () => {
  const lib = loadClient();
  const node = {
    id: 'big',
    name: '往年试题',
    count: 205,
    files: Array.from({ length: 205 }, (_, index) => file(`离散数学/往年试题/q${index}.pdf`)),
    nodes: [],
    texts: [],
  };
  const rows = lib.materialNodeRows(node, 0, '', { isOpen: () => true, showAll: () => false });
  const leaves = rows.filter((row) => String(row.props?.className ?? '').includes('sa-mat-leaf'));
  assert.equal(leaves.length, 200, '单目录一次最多平铺 200 条');
  assert.ok(textOf(rows).includes('还有 5 个'), '剩下的条数要明说，别静默截断');

  // 点「展开全部」之后才全给出来
  const all = lib.materialNodeRows(node, 0, '', { isOpen: () => true, showAll: () => true });
  assert.equal(all.filter((row) => String(row.props?.className ?? '').includes('sa-mat-leaf')).length, 205, '展开全部要给满 205 条');
});

test('④ 卡片尾部详情：大小 · 类型 · 页数 · 取字状态 · 修改时间（一行）', () => {
  const lib = loadClient();
  const meta = lib.materialFileMetaLine({
    path: '离散数学/教材/离散数学.pdf',
    size: 76.4 * 1024 * 1024,
    pages: 812,
    state: 'ocr',
    mtime: '2026-10-30T08:00:00.000Z',
  });
  assert.equal(meta, '76.4 MB · PDF · 812 页 · 已取字 · 2026-10-30', `详情行不对：${meta}`);
  assert.ok(!meta.includes('\n'), '详情必须挤在一行（超长交给 CSS 省略）');

  // 拿不到大小/页数/时间时不许印出 undefined 或 null
  const bare = lib.materialFileMetaLine({ path: '离散数学/README.md', state: 'unindexed' });
  assert.equal(bare, 'MD · 未登记', `缺字段时只写拿得到的：${bare}`);
  assert.ok(!/undefined|null/u.test(bare), '不许把 undefined/null 印到界面上');
});

test('⑤ 默认展开只放「≤20 个文件的单层目录」，其余一律收起（卡 ⑥.2）', () => {
  const lib = loadClient();
  const scan = makeScan({
    groups: [{
      id: 'ppt',
      title: 'PPT',
      count: 3,
      sections: [{
        id: 'ppt',
        title: 'PPT',
        kind: 'files',
        root: {
          id: 'ppt',
          name: '教材/ppt',
          count: 3,
          files: [],
          texts: [],
          nodes: [
            { id: 'small', name: '小目录', count: 3, files: [file('a.pdf'), file('b.pdf'), file('c.pdf')], nodes: [], texts: [] },
            { id: 'big', name: '大目录', count: 30, files: Array.from({ length: 30 }, (_, i) => file(`c${i}.pdf`)), nodes: [], texts: [] },
            { id: 'nested', name: '还有子目录', count: 1, files: [file('d.pdf')], nodes: [{ id: 'x', name: 'x', count: 1, files: [file('e.pdf')], nodes: [], texts: [] }], texts: [] },
          ],
        },
      }],
    }],
  });
  const keys = Array.from(lib.materialDefaultOpenKeys(scan));
  assert.equal(keys[0], 'node:small', '3 条的单层目录要出现在默认展开里');
  assert.ok(keys.includes('node:small'), '3 条的单层目录可以直接展开');
  assert.ok(!keys.includes('node:big'), '30 条的大目录不许默认展开（卡 ⑥.5 的折叠口径）');
  assert.ok(!keys.includes('node:nested'), '有子目录的节点不许默认展开（卡 ⑥.2）');
});
