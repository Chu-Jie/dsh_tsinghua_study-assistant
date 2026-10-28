/**
 * 知识点插图接口（`GET /materials/image`）的往返测试。
 *
 * 这个接口是**唯一**能把本地图片字节送到浏览器的路径，所以测试重点不是「能不能显示」，
 * 而是三条安全线：
 *   1. 没登记在 `学习台/图片/_index.json` 的路径一律不下发（否则就是任意读文件）；
 *   2. `..` 之类的越界写法要挡在查索引之前；
 *   3. 白名单外的扩展名（比如 `.gif`、`.html`）不许当图片发出去。
 *
 * 契约（实现见 `lib/api.js` 的 `handleMaterialImage`）：
 * - `?path=` 相对**工作区根**（`workspaceRoot`，默认是 `学习台` 的父目录）；
 * - 索引固定在 `<工作区根>/图片/_index.json`，结构 `{ images: [{ path, caption }] }`；
 * - 命中回 200 + `image/*` + `Cache-Control: public, max-age=86400, immutable`，
 *   并把 caption 放进 `X-Study-Image`（encodeURIComponent）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 1x1 透明 PNG（67 字节）：够 `image/png` 识别，不占空间。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function startServer(options = {}) {
  // 复刻生产布局：<工作区根>/学习台 是数据目录，图落在 <工作区根>/学习台/图片/，
  // 而索引是 <数据目录>/图片/_index.json —— 这两处一旦弄混，生产上就会「图在、索引找不到」。
  const root = await makeTempDir('study-assistant-image-');
  const dir = path.join(root, '学习台');
  await fs.mkdir(dir, { recursive: true });
  const store = createStore(dir);
  await store.init();
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
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(root);
    },
  };
}

/** 在工作区根下放一张图（相对路径 `学习台/图片/…`），并按需要写进数据目录的索引。 */
async function seedImage(server, name, { index = true, ext = 'png', bytes = TINY_PNG, caption = '示意' } = {}) {
  const rel = `学习台/图片/${name}`;
  const abs = path.join(server.root, '学习台', '图片', name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  if (!index) return rel;
  const indexPath = path.join(server.dir, '图片', '_index.json');
  let doc = { version: 1, images: [] };
  try {
    doc = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch {
    // 第一次写：从空索引开始
  }
  const images = Array.isArray(doc.images) ? doc.images : [];
  images.push({ path: rel, caption, ext });
  await fs.writeFile(indexPath, JSON.stringify({ ...doc, images }, null, 2), 'utf8');
  return rel;
}

test('插图：登记过的 PNG 才下发，带缓存头与 caption 头', async () => {
  const server = await startServer();
  try {
    const rel = await seedImage(server, 'c_digital/demo.png', { caption: 'CMOS 反相器（a）结构（b）电路' });
    const response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent(rel)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('cache-control') ?? '', /immutable/);
    assert.equal(decodeURIComponent(response.headers.get('x-study-image') ?? ''), 'CMOS 反相器（a）结构（b）电路');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, TINY_PNG.length, '字节要原样发出，不能被当文本转码');
    assert.ok(body.equals(TINY_PNG));
  } finally {
    await server.close();
  }
});

test('插图：没登记 / 没索引 / 空 path / 越界 / 白名单外扩展名一律不下发', async () => {
  const server = await startServer();
  try {
    // 先放一张登记过的图（让索引文件存在），再验「文件在、索引里没有」→ not-indexed
    await seedImage(server, 'c_digital/warmup.png');
    const unindexed = await seedImage(server, 'c_digital/secret.png', { index: false });
    let response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent(unindexed)}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not-indexed');

    // 空 path
    response = await fetch(`${server.baseUrl}/materials/image`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'missing-path');

    // 越界：查询串里带 `..`（编码后也要认出来）
    response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent('图片/../../secret.png')}`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'escape');

    // 索引里有、但扩展名不在白名单（gif 不再支持：动图当讲解插图没有意义，还会被当资源代理）
    const gif = await seedImage(server, 'c_digital/anim.gif', {
      bytes: Buffer.from('GIF89a', 'ascii'),
      caption: '坏例子',
    });
    response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent(gif)}`);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, 'unsupported-type');
  } finally {
    await server.close();
  }

  // 没有索引文件 → no-index（不是 500，也不是空图）
  const bare = await startServer();
  try {
    const response = await fetch(`${bare.baseUrl}/materials/image?path=${encodeURIComponent('图片/任意.png')}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'no-index');
  } finally {
    await bare.close();
  }
});

test('插图：索引登记了但文件被挪走 → 404 missing，而不是 500', async () => {
  const server = await startServer();
  try {
    const rel = await seedImage(server, 'c_digital/gone.png');
    await fs.rm(path.join(server.root, '学习台', '图片', 'c_digital', 'gone.png'));
    const response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent(rel)}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'missing');
  } finally {
    await server.close();
  }
});

test('插图：反斜杠写法也能命中（Windows 手抄路径不至于白屏）', async () => {
  const server = await startServer();
  try {
    const rel = await seedImage(server, 'c_digital/back.png');
    const response = await fetch(`${server.baseUrl}/materials/image?path=${encodeURIComponent(rel.replace(/\//g, '\\'))}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    await server.close();
  }
});
