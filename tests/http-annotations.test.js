/**
 * 批注接口（第 12 份主文档 `annotations` / `学习台/批注.json`）的往返测试。
 *
 * 「原文只读、批注是覆盖层」的安全线，重点验四条：
 *   1. 批注只能写在 `资料索引.json` 登记过、且有文字层（`text.outFile`）的资料上，
 *      白名单外的文件一律 400（杜绝借批注接口读/写任意文件）；
 *   2. 锚点由**服务端完整原文**重算，客户端伪造/过期的偏移会被指纹重定位纠正，
 *      quote 根本不存在就回 400 `anchor-not-found`，绝不静默套到别的位置；
 *   3. 增删改一次请求只落一次盘（`store.writeDocument` + `expectedHash`）；
 *   4. `annotations` 作为主文档，`/state`、`/backup/export`、`restore` 都自动带上它。
 *
 * 契约：`POST /mutate` + `doc === 'annotations'`，`action = create | update | delete`，
 *       读接口 `GET /annotations`、`GET /annotations/export`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

const LESSON_REL = '数据结构/讲义/第1章.md';
const LESSON = [
  '# 第1章 数据结构绪论',
  '',
  '数据结构是计算机存储、组织数据的方式。',
  '',
  '算法是对特定问题求解步骤的描述。',
  '',
  '数据结构是计算机存储、组织数据的方式。',
  '',
].join('\n');

const QUOTE = '数据结构是计算机存储、组织数据的方式。';
const SECOND_QUOTE = '算法是对特定问题求解步骤的描述。';

function quoteSpan(quote, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i += 1) start = LESSON.indexOf(quote, start + 1);
  return { start, end: start + quote.length };
}

async function startServer() {
  const root = await makeTempDir('study-assistant-annotations-');
  const dir = path.join(root, '学习台');
  await fs.mkdir(dir, { recursive: true });
  const store = createStore(dir);
  await store.init();
  // 铺一份真实存在的讲义原文（相对工作区根），并在 资料索引.json 里登记。
  const lessonAbs = path.join(root, LESSON_REL);
  await fs.mkdir(path.dirname(lessonAbs), { recursive: true });
  await fs.writeFile(lessonAbs, LESSON, 'utf8');
  await store.writeDocument('materials', {
    version: 1,
    files: [{ path: LESSON_REL, text: { outFile: LESSON_REL } }],
  });
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    workspaceRoot: root,
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    dir,
    root,
    store,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(root);
    },
  };
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
    body: JSON.stringify(body),
  });
}

async function listNotes(server, file) {
  const suffix = file ? `?file=${encodeURIComponent(file)}` : '';
  const body = await (await fetch(`${server.baseUrl}/annotations${suffix}`)).json();
  return body;
}

test('annotations 是主文档：/state?doc=annotations 返回 200 默认结构', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/state?doc=annotations`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, 'annotations');
    assert.deepEqual(body.doc.notes, []);
    assert.equal(typeof body.hash, 'string');
  } finally {
    await server.close();
  }
});

test('note 批注：create → list → update → delete 往返，锚点由服务端重算', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    const created = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '我的第一条笔记', quote: QUOTE, start: span.start, end: span.end },
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.count, 1);
    assert.equal(createdBody.item.file, LESSON_REL);
    assert.equal(createdBody.item.anchor.quote, QUOTE);
    assert.equal(createdBody.item.anchor.start, span.start, '偏移要落在原文真实位置');
    assert.match(createdBody.item.id, /^[A-Za-z0-9_-]{1,64}$/);
    const id = createdBody.item.id;

    const listed = await listNotes(server, LESSON_REL);
    assert.equal(listed.count, 1);
    assert.equal(listed.notes[0].content, '我的第一条笔记');

    const updated = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'update',
      id,
      item: { content: '改过的笔记' },
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).count, 1);
    const afterUpdate = await listNotes(server, LESSON_REL);
    assert.equal(afterUpdate.notes[0].content, '改过的笔记');
    assert.equal(afterUpdate.notes[0].anchor.start, span.start, '只改正文时锚点不应漂移');
    assert.notEqual(afterUpdate.notes[0].createdAt, undefined);

    const deleted = await postJson(`${server.baseUrl}/mutate`, { doc: 'annotations', action: 'delete', id });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).count, 0);
    assert.equal((await listNotes(server, LESSON_REL)).count, 0);
  } finally {
    await server.close();
  }
});

test('三种类型 note/highlight/insert 共用同一套锚点数据', async () => {
  const server = await startServer();
  try {
    const a = quoteSpan(QUOTE, 0);
    const b = quoteSpan(SECOND_QUOTE, 0);
    for (const [type, span, quote] of [
      ['note', a, QUOTE],
      ['highlight', b, SECOND_QUOTE],
      ['insert', a, QUOTE],
    ]) {
      const response = await postJson(`${server.baseUrl}/mutate`, {
        doc: 'annotations',
        action: 'create',
        item: { file: LESSON_REL, type, content: `类型 ${type}`, quote, start: span.start, end: span.end },
      });
      assert.equal(response.status, 200, `${type} 应能创建`);
    }
    const listed = await listNotes(server, LESSON_REL);
    assert.equal(listed.count, 3);
    assert.deepEqual(listed.notes.map((note) => note.type).sort(), ['highlight', 'insert', 'note']);
    for (const note of listed.notes) {
      assert.equal(typeof note.anchor.quote, 'string');
      assert.equal(typeof note.anchor.start, 'number');
      assert.equal(typeof note.anchor.end, 'number');
    }
  } finally {
    await server.close();
  }
});

test('style 行内格式：create 落库、list 回读、update 改色/清除都能往返', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    const created = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: {
        file: LESSON_REL, type: 'highlight', content: '带样式的批注',
        quote: QUOTE, start: span.start, end: span.end,
        style: { color: 'red', highlight: 'yellow', underline: 'blue', bold: true, italic: false },
      },
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.ok, true);
    assert.deepEqual(createdBody.item.style, { color: 'red', highlight: 'yellow', underline: 'blue', bold: true, italic: false });
    const id = createdBody.item.id;

    const listed = await listNotes(server, LESSON_REL);
    assert.deepEqual(listed.notes[0].style, { color: 'red', highlight: 'yellow', underline: 'blue', bold: true, italic: false }, 'list 要带回 style');

    // update 只改 color（不重算锚点）
    const updated = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'update', id, item: { style: { color: 'green', bold: false } },
    });
    assert.equal(updated.status, 200);
    const afterUpdate = await listNotes(server, LESSON_REL);
    assert.deepEqual(afterUpdate.notes[0].style, { color: 'green', bold: false }, 'update 用新 style 整体替换');
    assert.equal(afterUpdate.notes[0].anchor.start, span.start, '改样式不应动锚点');

    // update 传 style:null → 清除样式
    await postJson(`${server.baseUrl}/mutate`, { doc: 'annotations', action: 'update', id, item: { style: null } });
    const afterClear = await listNotes(server, LESSON_REL);
    assert.equal(afterClear.notes[0].style, undefined, 'style:null 要清除 style 字段');
  } finally {
    await server.close();
  }
});

test('style 行内格式：非法值在服务端兜底剥离（不 400），不影响批注落盘', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    const created = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: {
        file: LESSON_REL, type: 'highlight', content: '脏 style',
        quote: QUOTE, start: span.start, end: span.end,
        style: { color: 'purple', highlight: 'yellow', border: '2px' },
      },
    });
    // 注：create 走 buildAnnotationFromInput，脏值被剥离，只保留 highlight:yellow
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.item.style, { highlight: 'yellow' }, '只保留白名单内的合法维度');
  } finally {
    await server.close();
  }
});

test('改文重定位：偏移不可信但 quote 仍在原文（重复片段）→ 服务端纠正，落到最近的真实位置', async () => {
  const server = await startServer();
  try {
    const real = quoteSpan(QUOTE, 0);
    const response = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      // 故意把 start 报成 0（错误偏移），quote 仍能在原文里找到
      item: { file: LESSON_REL, type: 'highlight', content: '偏移是错的', quote: QUOTE, start: 0, end: QUOTE.length },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.item.anchor.start, real.start, '服务端要用指纹把偏移纠正到真实位置');
    assert.equal(body.item.anchor.quote, QUOTE);
  } finally {
    await server.close();
  }
});

test('锚点失效：quote 不在原文 → 400 anchor-not-found，且不落盘', async () => {
  const server = await startServer();
  try {
    const response = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: 'x', quote: '这句话根本不存在于原文。', start: 0, end: 12 },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'anchor-not-found');
    assert.equal((await listNotes(server, LESSON_REL)).count, 0, '失败的批注不能写进文件');
  } finally {
    await server.close();
  }
});

test('白名单：未登记文件 → file-not-indexed；登记但无文字层 → not-text-material', async () => {
  const server = await startServer();
  try {
    const notIndexed = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: '不存在/讲义.md', type: 'note', content: 'x', quote: 'q', start: 0, end: 1 },
    });
    assert.equal(notIndexed.status, 400);
    assert.equal((await notIndexed.json()).error, 'file-not-indexed');

    // 追加一条只有 OCR 目录、没有 text.outFile 的记录
    const materials = await (await fetch(`${server.baseUrl}/state?doc=materials`)).json();
    await server.store.writeDocument('materials', {
      ...materials.doc,
      files: [...materials.doc.files, { path: '扫描/讲义.pdf', ocr: { outDir: '扫描/讲义' } }],
    });
    const notText = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: '扫描/讲义.pdf', type: 'note', content: 'x', quote: 'q', start: 0, end: 1 },
    });
    assert.equal(notText.status, 400);
    assert.equal((await notText.json()).error, 'not-text-material');
  } finally {
    await server.close();
  }
});

test('知识点虚拟文件 kp:<nodeId>：正文由客户端 kpText 提供，锚点自洽才收；缺 kpText 拒收', async () => {
  const server = await startServer();
  try {
    // 知识点详情正文不在 资料索引.json 里，服务端用请求带来的 kpText 做锚点校验。
    const KP_BODY = '这是知识点正文的一段话。后面还有别的内容。';
    const KP_FILE = 'kp:k_2179afdba8';
    const span = { start: KP_BODY.indexOf('一段话'), end: KP_BODY.indexOf('一段话') + 3 };

    const created = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: {
        file: KP_FILE, type: 'highlight', content: '一段话',
        quote: '一段话', start: span.start, end: span.end, exact: true,
        style: { highlight: 'blue' }, kpText: KP_BODY,
      },
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.ok, true);
    assert.equal(body.item.file, KP_FILE);
    assert.equal(body.item.anchor.quote, '一段话');
    assert.deepEqual(body.item.style, { highlight: 'blue' });

    // 回读：list 能拿到这条 kp 批注
    const listed = await listNotes(server, KP_FILE);
    assert.equal(listed.count, 1);

    // 缺 kpText → 400 missing-kp-text（不能白拿客户端不存在的正文）
    const noText = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: KP_FILE, type: 'note', content: 'x', quote: '一段话', start: span.start, end: span.end },
    });
    assert.equal(noText.status, 400);
    assert.equal((await noText.json()).error, 'missing-kp-text');

    // kpText 里根本没有该 quote → 400 anchor-not-found
    const wrongText = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: KP_FILE, type: 'note', content: 'x', quote: '原文里没有这句', start: 0, end: 6, kpText: KP_BODY },
    });
    assert.equal(wrongText.status, 400);
    assert.equal((await wrongText.json()).error, 'anchor-not-found');
  } finally {
    await server.close();
  }
});

test('导出：/annotations/export 可只读导出并支持 file 过滤', async () => {  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '导出我', quote: QUOTE, start: span.start, end: span.end },
    });
    const all = await (await fetch(`${server.baseUrl}/annotations/export`)).json();
    assert.equal(all.ok, true);
    assert.equal(all.format, 'json');
    assert.equal(all.count, 1);
    assert.equal(typeof all.exportedAt, 'string');

    const filtered = await (await fetch(`${server.baseUrl}/annotations/export?file=${encodeURIComponent(LESSON_REL)}`)).json();
    assert.equal(filtered.count, 1);
    const empty = await (await fetch(`${server.baseUrl}/annotations/export?file=${encodeURIComponent('别的/文件.md')}`)).json();
    assert.equal(empty.count, 0);

    const badFormat = await fetch(`${server.baseUrl}/annotations/export?format=xml`);
    assert.equal(badFormat.status, 400);
    assert.equal((await badFormat.json()).error, 'unsupported-format');
  } finally {
    await server.close();
  }
});

test('导出：format=md 产出按文件分组、带 [标签] 与原文片段的干净 Markdown', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    // 建五条：重点 / 疑问 / 待复习 / 已学会 / 无标记（普通）
    for (const markKind of ['key', 'question', 'review', 'learned', undefined]) {
      const item = { file: LESSON_REL, type: 'highlight', content: `批注-${markKind ?? '普通'}`, quote: QUOTE, start: span.start, end: span.end };
      if (markKind !== undefined) item.markKind = markKind;
      const res = await postJson(`${server.baseUrl}/mutate`, { doc: 'annotations', action: 'create', item });
      assert.equal(res.status, 200, `create markKind=${markKind}`);
    }
    const mdResp = await fetch(`${server.baseUrl}/annotations/export?format=md`);
    assert.equal(mdResp.status, 200);
    const md = await mdResp.json();
    assert.equal(md.ok, true);
    assert.equal(md.format, 'md');
    assert.equal(md.count, 5);
    assert.equal(md.file, null);
    assert.equal(typeof md.markdown, 'string');
    assert.match(md.markdown, /^# 高光与批注材料（导出：全部）/);
    // 分组标题用人读名：普通资料去扩展名（数据结构/讲义/第1章）
    const LESSON_DISPLAY = LESSON_REL.replace(/\.[a-zA-Z0-9]+$/, '');
    assert.match(md.markdown, new RegExp(`## ${LESSON_DISPLAY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(md.markdown, /- \[重点\] 批注-key —— 原文：「/);
    assert.match(md.markdown, /- \[疑问\] 批注-question —— 原文：「/);
    assert.match(md.markdown, /- \[待复习\] 批注-review —— 原文：「/);
    assert.match(md.markdown, /- \[已学会\] 批注-learned —— 原文：「/);
    assert.match(md.markdown, /- \(普通\) 批注-普通 —— 原文：「/);
    // 每条下方有一行时间/状态（新增信息维度）
    assert.match(md.markdown, /^ {2}> 标记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 重点$/m);
    assert.match(md.markdown, /^ {2}> 标记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 已学会$/m);
    assert.match(md.markdown, /^ {2}> 标记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 普通$/m);
    // 原文片段取自 quote（前 40 字，此处 quote 未超长，应完整出现）
    assert.match(md.markdown, new RegExp(`原文：「${QUOTE}」`));
    // json 导出仍原样工作，且 notes 自然带上 markKind
    const json = await (await fetch(`${server.baseUrl}/annotations/export?format=json`)).json();
    assert.equal(json.format, 'json');
    assert.equal(json.count, 5);
    const kinds = json.notes.map((n) => n.markKind).filter((k) => k !== undefined).sort();
    assert.deepEqual(kinds, ['key', 'learned', 'question', 'review']);
  } finally {
    await server.close();
  }
});

test('导出 format=md 支持 file 过滤且标题标注该文件名', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '甲', quote: QUOTE, start: span.start, end: span.end, markKind: 'key' },
    });
    const md = await (await fetch(`${server.baseUrl}/annotations/export?format=md&file=${encodeURIComponent(LESSON_REL)}`)).json();
    assert.equal(md.count, 1);
    const LESSON_DISPLAY2 = LESSON_REL.replace(/\.[a-zA-Z0-9]+$/, '');
    assert.match(md.markdown, new RegExp(`^# 高光与批注材料（导出：${LESSON_DISPLAY2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}）`));
    const empty = await (await fetch(`${server.baseUrl}/annotations/export?format=md&file=${encodeURIComponent('别的/文件.md')}`)).json();
    assert.equal(empty.count, 0);
    assert.match(empty.markdown, /（暂无批注）/);
  } finally {
    await server.close();
  }
});

test('markKind 往返：create 合法值落库、非法值静默丢弃；update 可改/可清除（null）', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    const base = { file: LESSON_REL, type: 'highlight', content: 'c', quote: QUOTE, start: span.start, end: span.end };

    // create：合法值落库
    const created = await (await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'create', item: { ...base, markKind: 'key' },
    })).json();
    assert.equal(created.item.markKind, 'key');
    const id = created.item.id;

    // create：非法值静默丢弃（不 400、不带 markKind）
    const dirty = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'create', item: { ...base, markKind: '重点' },
    });
    assert.equal(dirty.status, 200);
    const dirtyBody = await dirty.json();
    assert.equal(dirtyBody.item.markKind, undefined);

    // update：改成 question
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'update', id, item: { markKind: 'question' },
    });
    let notes = (await listNotes(server)).notes;
    assert.equal(notes.find((n) => n.id === id).markKind, 'question');

    // update：null 清除
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'update', id, item: { markKind: null },
    });
    notes = (await listNotes(server)).notes;
    assert.equal(notes.find((n) => n.id === id).markKind, undefined);
  } finally {
    await server.close();
  }
});

test('file 键归一化：反斜杠/前导斜杠/绝对路径/学习台前缀 都能查到同一条批注', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    const created = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '键归一', quote: QUOTE, start: span.start, end: span.end },
    });
    assert.equal(created.status, 200);
    const absWin = path.join(server.root, LESSON_REL);
    const absPosix = absWin.replace(/\\/g, '/');
    const forms = [
      LESSON_REL,
      LESSON_REL.replace(/\//g, '\\'),
      `/${LESSON_REL}`,
      `./${LESSON_REL}`,
      `学习台/${LESSON_REL}`,
      absPosix,
      absWin,
      `file:///${absPosix}`,
    ];
    for (const form of forms) {
      const listed = await listNotes(server, form);
      assert.equal(listed.count, 1, `形态 ${form} 应能查到同一条批注`);
      assert.equal(listed.file, LESSON_REL, `返回体要带回归一化后的 file（${form}）`);
    }

    const second = quoteSpan(SECOND_QUOTE, 0);
    const viaAbs = await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: absWin, type: 'note', content: '用绝对路径写', quote: SECOND_QUOTE, start: second.start, end: second.end },
    });
    assert.equal(viaAbs.status, 200);
    const createdAbs = await viaAbs.json();
    assert.equal(createdAbs.item.file, LESSON_REL, '绝对路径写入要落成相对键');
    assert.equal((await listNotes(server, LESSON_REL)).count, 2, '两种形态写的是同一个文件键');
  } finally {
    await server.close();
  }
});

test('备份：export 含 annotations 且带 sha256，restore 能写回', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '备份前的批注', quote: QUOTE, start: span.start, end: span.end },
    });
    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();
    assert.equal(exported.ok, true);
    assert.ok(exported.bundle.docs.annotations, '导出包必须含 annotations');
    assert.equal(exported.bundle.docs.annotations.notes.length, 1);
    assert.match(exported.bundle.hashes.annotations, /^[0-9a-f]{64}$/, 'annotations 要带磁盘 sha256');

    // 导出后再加一条，恢复后应只剩导出时刻那一条
    const span2 = quoteSpan(SECOND_QUOTE, 0);
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations',
      action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '导出后才加的', quote: SECOND_QUOTE, start: span2.start, end: span2.end },
    });
    assert.equal((await listNotes(server, LESSON_REL)).count, 2);

    const restored = await postJson(`${server.baseUrl}/backup/restore`, { bundle: exported.bundle });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json();
    assert.equal(restoredBody.ok, true);
    assert.ok(restoredBody.restored.some((item) => item.key === 'annotations'));

    const after = await listNotes(server, LESSON_REL);
    assert.equal(after.count, 1, '恢复后批注回到导出时刻');
    assert.equal(after.notes[0].content, '备份前的批注');
  } finally {
    await server.close();
  }
});

test('自动落盘：每次写批注后 _工具/AI材料/ 自动生成该讲义 md + _全部.md（覆盖式）', async () => {
  const server = await startServer();
  try {
    const span = quoteSpan(QUOTE, 0);
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'annotations', action: 'create',
      item: { file: LESSON_REL, type: 'note', content: '自动保存一条', quote: QUOTE, start: span.start, end: span.end, markKind: 'key' },
    });
    const outDir = path.join(server.root, '_工具', 'AI材料');
    // 该讲义一份（去扩展名后作文件名）+ 总目录
    const lessonDisk = '数据结构_讲义_第1章.md';
    const lessonPath = path.join(outDir, lessonDisk);
    const allPath = path.join(outDir, '_全部.md');
    const lessonMd = await fs.readFile(lessonPath, 'utf8');
    assert.match(lessonMd, /^# 高光与批注材料/, '自动落盘文件要有标题');
    assert.match(lessonMd, /- \[重点\] 自动保存一条/);
    assert.match(lessonMd, /  > 标记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 重点/);
    const allMd = await fs.readFile(allPath, 'utf8');
    assert.match(allMd, /## 数据结构\/讲义\/第1章/, '总目录按人读篇名分组');

    // 信息接口能报出目录与文件
    const info = await (await fetch(`${server.baseUrl}/annotations/material`)).json();
    assert.equal(info.ok, true);
    assert.equal(info.dir, outDir);
    assert.ok(info.files.includes(lessonDisk), 'info 要列出该讲义 md');
    assert.ok(info.files.includes('_全部.md'), 'info 要列出总目录');

    // 再改一条：文件被覆盖更新（仍是 1 条批注、但内容变了）
    const id = (await listNotes(server, LESSON_REL)).notes[0].id;
    // 等 60 秒太浪费；createdAt 与 update 的 updatedAt 若落在同一分钟，格式化后会相等、不附「改于」。
    // 所以这里断言「内容已更新」即可，时间行只要还是「标记于 …」就说明时间维度在。
    await postJson(`${server.baseUrl}/mutate`, { doc: 'annotations', action: 'update', id, item: { content: '改过的内容' } });
    const lessonMd2 = await fs.readFile(lessonPath, 'utf8');
    assert.match(lessonMd2, /改过的内容/, '更新后自动落盘文件应反映新内容');
    assert.match(lessonMd2, /  > 标记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '时间行仍在（改于仅跨分钟才附）');

    // 全删：总目录变「暂无批注」
    await postJson(`${server.baseUrl}/mutate`, { doc: 'annotations', action: 'delete', id });
    const allMd2 = await fs.readFile(allPath, 'utf8');
    assert.match(allMd2, /（暂无批注）/, '删空后总目录提示暂无');
  } finally {
    await server.close();
  }
});
