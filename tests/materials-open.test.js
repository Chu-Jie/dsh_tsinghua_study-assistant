/**
 * 资料树三个接口的往返测试：`GET /materials/scan`、`POST /materials/open`、`POST /materials/reveal`。
 *
 * 这里最要紧的不是「能不能打开」，而是**只打开它该打开的东西**：
 *   1. 越界（`..`、绝对路径指到工作区外）一律 403，且响应体里不许出现真实路径；
 *   2. 没在本次扫描 / 资料索引里出现过的路径一律 403（`.bak-*`、`提交文件/` 也在内）；
 *   3. `open` 只收文件、`reveal` 文件目录都收；
 *   4. `openExternal` 一律注入假实现 —— 测试绝不能在开发机上真的弹窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER, MATERIAL_SUBJECTS } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function touch(abs, bytes = 'x') {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes, 'utf8');
}

/** 起一个真 HTTP 服务：数据目录 `<root>/学习台`，工作区根 `<root>`（和生产同构）。 */
async function startServer(openExternal = async (request) => ({ ok: true, ...request })) {
  const root = await makeTempDir('study-assistant-open-');
  const dir = path.join(root, '学习台');
  await fs.mkdir(dir, { recursive: true });
  const store = createStore(dir);
  await store.init();

  await touch(path.join(root, '物理/教材/大学物理.pdf'));
  await touch(path.join(root, '物理/教材/大学物理.pdf.bak-20260101'));
  await touch(path.join(root, '物理/教材/往年扫描/旧版.pdf'));
  await touch(path.join(root, '物理/提交文件/第01次/hw.pdf'));
  await touch(path.join(root, '学习台/图片/demo.png'));
  await touch(path.join(root, '外部/secret.pdf'));

  // 资料索引里登记一条「不属于任何学科目录」的记录：白名单要走「索引 ∪ 扫描」两路
  await store.writeDocument('materials', {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: [{ path: '学习台/图片/demo.png', courseId: 'misc', kind: 'png' }],
  });

  const calls = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    workspaceRoot: root,
    openExternal: async (request) => {
      calls.push(request);
      return openExternal(request);
    },
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
    root,
    dir,
    calls,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(root);
    },
  };
}

function post(server, name, body, options = {}) {
  const headers = { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1', ...(options.headers ?? {}) };
  return fetch(`${server.baseUrl}${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('打开：合法原件调一次系统程序，回 pageTargeted:false', async () => {
  const server = await startServer();
  try {
    const response = await post(server, '/materials/open', { path: '物理/教材/大学物理.pdf' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.opened, true);
    assert.equal(body.action, 'open');
    assert.equal(body.page, null);
    assert.equal(body.pageTargeted, false);
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].action, 'open');
    assert.equal(server.calls[0].abs, path.join(server.root, '物理', '教材', '大学物理.pdf'));
  } finally {
    await server.close();
  }
});

test('打开：带 page 如实回答「定位不了页码」，不假装定位过', async () => {
  const server = await startServer();
  try {
    const response = await post(server, '/materials/open', { path: '物理/教材/大学物理.pdf', page: 7 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.page, 7);
    assert.equal(body.pageTargeted, false);
    assert.equal(body.note, 'page-open-unsupported');
    // 页码再怪也不能整个拒掉：坏页码当没传
    const weird = await post(server, '/materials/open', { path: '物理/教材/大学物理.pdf', page: '第7页' });
    assert.equal(weird.status, 200);
    assert.equal((await weird.json()).page, null);
  } finally {
    await server.close();
  }
});

test('打开：越界 / 未登记 / 目录 / 不存在 一律拒绝，且不回显真实路径', async () => {
  const server = await startServer();
  try {
    const cases = [
      ['物理/教材/大学物理.pdf.bak-20260101', 403, 'path-not-allowed'],
      ['物理/提交文件/第01次/hw.pdf', 403, 'path-not-allowed'],
      ['物理/../外部/secret.pdf', 403, 'path-not-allowed'],
      [path.join(server.root, '外部', 'secret.pdf'), 403, 'path-not-allowed'],
      ['学习台/任务.json', 403, 'path-not-allowed'],
      ['物理/教材', 400, 'not-a-file'],
      ['物理/教材/不存在.pdf', 404, 'missing'],
      ['', 400, 'missing-path'],
    ];
    for (const [target, status, error] of cases) {
      const response = await post(server, '/materials/open', { path: target });
      assert.equal(response.status, status, `path=${target}`);
      const body = await response.json();
      assert.equal(body.error, error, `path=${target}`);
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(server.root), false, `403/404 不许回显工作区真实路径：${raw}`);
      assert.equal(raw.includes('secret.pdf'), false, `不许回显文件名：${raw}`);
    }
    assert.equal(server.calls.length, 0, '被拒的请求一次都不该调系统程序');
  } finally {
    await server.close();
  }
});

test('打开：工作区内的绝对路径与资料索引里登记过的路径都放行', async () => {
  const server = await startServer();
  try {
    const abs = path.join(server.root, '物理', '教材', '往年扫描', '旧版.pdf');
    let response = await post(server, '/materials/open', { path: abs.replace(/\\/g, '/') });
    assert.equal(response.status, 200);

    // 索引登记过、但不属于任何学科目录（学习台/图片/demo.png）也要能开
    response = await post(server, '/materials/open', { path: '学习台/图片/demo.png' });
    assert.equal(response.status, 200);
    assert.equal(server.calls.length, 2);
  } finally {
    await server.close();
  }
});

test('定位：文件与目录都收，走 reveal 动作', async () => {
  const server = await startServer();
  try {
    const file = await post(server, '/materials/reveal', { path: '物理/教材/大学物理.pdf' });
    assert.equal(file.status, 200);
    assert.equal((await file.json()).action, 'reveal');

    const folder = await post(server, '/materials/reveal', { path: '物理/教材/往年扫描' });
    assert.equal(folder.status, 200);
    assert.equal((await folder.json()).action, 'reveal');

    const outside = await post(server, '/materials/reveal', { path: '物理/教材/../../外部' });
    assert.equal(outside.status, 403);

    assert.equal(server.calls.length, 2);
    assert.equal(server.calls[1].abs, path.join(server.root, '物理', '教材', '往年扫描'));
  } finally {
    await server.close();
  }
});

test('打开：系统程序拉不起来时回 502 并给出原因码', async () => {
  const server = await startServer(async () => ({ ok: false, error: 'spawn-failed', detail: 'EPERM' }));
  try {
    const response = await post(server, '/materials/open', { path: '物理/教材/大学物理.pdf' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'spawn-failed');
    assert.equal(body.detail, 'EPERM');
    assert.equal(JSON.stringify(body).includes(server.root), false);
  } finally {
    await server.close();
  }
});

test('打开：写请求三道闸（请求头 / content-type）一个都不能少', async () => {
  const server = await startServer();
  try {
    const noHeader = await fetch(`${server.baseUrl}/materials/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '物理/教材/大学物理.pdf' }),
    });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');

    const wrongType = await fetch(`${server.baseUrl}/materials/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', [REQUEST_HEADER]: '1' },
      body: JSON.stringify({ path: '物理/教材/大学物理.pdf' }),
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error, 'need-json-content-type');
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('扫描：单科给四棵树，全部只给汇总，未知名报 404', async () => {
  const server = await startServer();
  try {
    const disc = await fetch(`${server.baseUrl}/materials/scan?course=c_disc`);
    assert.equal(disc.status, 200);
    const payload = await disc.json();
    assert.equal(payload.courseId, 'c_disc');
    assert.ok(Array.isArray(payload.groups));

    const all = await fetch(`${server.baseUrl}/materials/scan`);
    assert.equal(all.status, 200);
    const summary = await all.json();
    assert.equal(summary.course, 'all');
    assert.equal(summary.subjects.length, MATERIAL_SUBJECTS.length);
    for (const subject of summary.subjects) {
      assert.equal(typeof subject.total, 'number');
      assert.equal(typeof subject.counts.textbook, 'number');
    }

    const unknown = await fetch(`${server.baseUrl}/materials/scan?course=c_不存在`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown-course');
  } finally {
    await server.close();
  }
});

test('扫描：只读 —— 不写学习台、不新增文件', async () => {
  const server = await startServer();
  try {
    const before = await fs.readdir(server.dir);
    const beforeTasks = await fs.readFile(path.join(server.dir, '任务.json'), 'utf8');
    await fetch(`${server.baseUrl}/materials/scan?course=c_phy`);
    await fetch(`${server.baseUrl}/materials/scan`);
    const after = await fs.readdir(server.dir);
    assert.deepEqual(after.sort(), before.sort(), '扫描不该在数据目录里留下任何新文件');
    assert.equal(await fs.readFile(path.join(server.dir, '任务.json'), 'utf8'), beforeTasks, '扫描不该改数据');
    assert.equal(server.calls.length, 0, '扫描不该调系统程序');
  } finally {
    await server.close();
  }
});
