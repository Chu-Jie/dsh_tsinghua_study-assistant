/**
 * `GET /news` 的接口级测试（零依赖）
 * 运行：node tests/http-news.test.js（`npm test` 会自动发现）
 *
 * 用真实 http.Server 往返请求，数据目录是自建临时目录，绝不触碰真实数据。
 * 覆盖四种状态：文件在但空 / 有数据按窗口裁剪 / 文件损坏 / 写入口被拒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

// 抓取时间按本机时区显示，断言不能写死某个时区的结果（CI 是 UTC）
const FETCHED_AT_DATE = new Date(2026, 10, 19, 7, 0); // 本地 07:00
const FETCHED_AT = FETCHED_AT_DATE.toISOString(); // 同一时刻的 UTC 串
const FETCHED_CLOCK = `${String(FETCHED_AT_DATE.getHours()).padStart(2, '0')}:${String(FETCHED_AT_DATE.getMinutes()).padStart(2, '0')}`; // 本机时区 HH:mm

async function startServer() {
  const dir = await makeTempDir('study-assistant-news-http-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
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
    store,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function item(overrides = {}) {
  return {
    id: 'n_test',
    title: '测试要闻',
    url: 'https://www.tsinghua.edu.cn/info/1177/1.htm',
    source: '清华新闻',
    publishedAt: '2026-11-19',
    excerpt: '第一段。',
    category: 'academic',
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

test('GET /news：文件在但一条都没有 → 200 + missing:false + 空数组（不是 404）', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/news`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.missing, false, 'init 已经补了空结构，所以不是 missing');
    assert.equal(payload.days, 7, '默认 7 天');
    assert.deepEqual(payload.items, []);
    assert.equal(payload.board.shown, 0);
    assert.equal(payload.board.fetchedClock, null, '没抓过就没有抓取时间');
  } finally {
    await server.close();
  }
});

test('GET /news：窗口按 ?days= 裁剪，今天与 30 天前的条目分开计', async () => {
  const server = await startServer();
  try {
    const doc = {
      version: 1,
      items: [item({ id: 'n_today', publishedAt: '2026-11-19' }), item({ id: 'n_old', title: '旧闻', publishedAt: '2026-10-20', url: 'https://www.tsinghua.edu.cn/info/1177/2.htm' })],
      fetchedAt: FETCHED_AT,
      updatedAt: '2026-11-19T07:00:00.000Z',
    };
    const written = await server.store.writeDocument('news', doc);
    assert.equal(written.ok, true);

    const seven = await (await fetch(`${server.baseUrl}/news?days=7&now=2026-11-19T03:00:00.000Z`)).json();
    assert.equal(seven.ok, true);
    assert.equal(seven.board.shown, 1, '30 天前的进不了 7 天窗口');
    assert.equal(seven.board.todayCount, 1);
    assert.equal(seven.items[0].id, 'n_today');
    assert.equal(seven.board.fetchedClock, FETCHED_CLOCK, '抓取时间按本机时区取 HH:mm，任意时区一致');

    const wide = await (await fetch(`${server.baseUrl}/news?days=60&now=2026-11-19T03:00:00.000Z`)).json();
    assert.equal(wide.board.shown, 2);
    assert.equal(wide.board.total, 2, 'total 是库里总条数，不受窗口影响');
  } finally {
    await server.close();
  }
});

test('GET /news：?days= 非法或越界回落默认 / 封顶 60', async () => {
  const server = await startServer();
  try {
    for (const [query, expected] of [['days=abc', 7], ['days=0', 7], ['days=-3', 7], ['days=999', 60]]) {
      const payload = await (await fetch(`${server.baseUrl}/news?${query}`)).json();
      assert.equal(payload.days, expected, `${query} 应回落成 ${expected}`);
    }
  } finally {
    await server.close();
  }
});

test('GET /news：文件坏了 → 200 + ok:false + news-unreadable（不假装没有新闻）', async () => {
  const server = await startServer();
  try {
    // ① 顶层形状坏了：reason 是通用的 `bad-field:items`（validateDoc 的字段级检查先于逐条检查）
    await fs.writeFile(path.join(server.dir, '要闻.json'), '{"version":1,"items":"不是数组"}', 'utf8');
    const shape = await (await fetch(`${server.baseUrl}/news`)).json();
    assert.equal(shape.ok, false);
    assert.equal(shape.error, 'news-unreadable');
    assert.equal(shape.reason, 'corrupt:bad-field:items', 'store 读坏时统一加 corrupt: 前缀');
    assert.deepEqual(shape.items, []);

    // ② 条目级坏了：reason 带 `news-` 前缀（逐条校验是这一层的）
    await fs.writeFile(path.join(server.dir, '要闻.json'), JSON.stringify({
      version: 1,
      items: [item({ url: 'javascript:alert(1)' })],
      fetchedAt: null,
      updatedAt: '2026-11-19T07:00:00.000Z',
    }), 'utf8');
    const perItem = await (await fetch(`${server.baseUrl}/news`)).json();
    assert.equal(perItem.ok, false);
    assert.equal(perItem.error, 'news-unreadable');
    assert.equal(perItem.reason, 'corrupt:news-bad-url');
  } finally {
    await server.close();
  }
});

test('POST /mutate：要闻没有写入口，回 400 use-dedicated-route', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
      body: JSON.stringify({ doc: 'news', action: 'create', item: item() }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'use-dedicated-route');
    assert.equal(payload.key, 'news');
  } finally {
    await server.close();
  }
});
