/**
 * 全量导出 / 恢复的往返测试（`GET /backup/export`、`POST /backup/restore`）。
 *
 * 验的是「真能盖回来」这条底线：导出九份 → 改掉其中一份 → 恢复 → 改掉的内容回到导出时刻；
 * 校验和不符、结构不符必须在写盘之前就被拒掉（宁可恢复失败，也不写半份坏数据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-backup-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    ...options,
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
    store,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function postJson(url, body, withHeader = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (withHeader) headers[REQUEST_HEADER] = '1';
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function getCourses(server) {
  const state = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
  return Array.isArray(state?.doc?.courses) ? state.doc.courses : [];
}

test('导出：十一份文档都在，包带格式/版本/校验和，缺的文档记进 skipped', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/backup/export`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.count, 11, '十一份文档都是默认结构，应当全部导出');
    assert.deepEqual(result.skipped, []);
    assert.equal(result.bundle.format, 'study-assistant.bundle');
    assert.equal(result.bundle.version, 1);
    assert.match(result.bundle.checksum, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.keys(result.bundle.docs).length, 11);
    assert.ok(result.bundle.hashes && typeof result.bundle.hashes.courses === 'string', '每份文档带磁盘 sha256');
    assert.ok(typeof result.bundle.exportedAt === 'string');
  } finally {
    await server.close();
  }
});

test('恢复：改掉数据后导回，内容回到导出时刻（覆盖同名文档 + 写前备份）', async () => {
  const server = await startServer();
  try {
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'create',
      item: { id: 'c_keep', name: '要留住的课' },
    });
    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();
    assert.equal(exported.count, 11);

    // 导出之后再改：多一门课 —— 恢复后这门课应当消失
    await postJson(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'create',
      item: { id: 'c_extra', name: '导出后才加的课' },
    });
    assert.equal((await getCourses(server)).length, 2);

    const response = await postJson(`${server.baseUrl}/backup/restore`, { bundle: exported.bundle });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.restored.length, 11);
    assert.deepEqual(result.failed, []);
    assert.equal(result.exportedAt, exported.bundle.exportedAt);

    const courses = await getCourses(server);
    assert.equal(courses.length, 1, '恢复后应当只剩导出时刻的那一门课');
    assert.equal(courses[0].name, '要留住的课');

    // 写前自动备份：恢复把「导出之后的状态」也留了一份在 学习台/备份/
    const backups = await fs.readdir(path.join(server.dir, '备份'));
    assert.ok(backups.some((name) => name.startsWith('课程.json.')), '覆盖前要把旧版存进备份目录');
  } finally {
    await server.close();
  }
});

test('恢复：包被改过（校验和不符）→ 400 且一个字节都不写', async () => {
  const server = await startServer();
  try {
    await postJson(`${server.baseUrl}/mutate`, { doc: 'courses', action: 'create', item: { id: 'c_a', name: '原本的课' } });
    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();
    const tampered = JSON.parse(JSON.stringify(exported.bundle));
    tampered.docs.courses.courses = [{ id: 'c_evil', name: '塞进来的课' }];

    const response = await postJson(`${server.baseUrl}/backup/restore`, { bundle: tampered });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'checksum-mismatch');
    assert.notEqual(result.expected, result.actual);

    const courses = await getCourses(server);
    assert.equal(courses.length, 1);
    assert.equal(courses[0].name, '原本的课', '校验和不符时绝不能写盘');
  } finally {
    await server.close();
  }
});

test('恢复：结构不合法的文档在写盘前被拒（invalid-doc 带 key）', async () => {
  const server = await startServer();
  try {
    await postJson(`${server.baseUrl}/mutate`, { doc: 'courses', action: 'create', item: { id: 'c_b', name: '现存课程' } });
    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();
    const broken = JSON.parse(JSON.stringify(exported.bundle));
    broken.docs.grades = { version: 1, courses: '不是数组' };
    // 重算校验和 ⇒ 只剩「结构不合法」这一关能挡住它
    const { bundleChecksum } = await import('../lib/backup.js');
    broken.checksum = bundleChecksum(broken.docs);

    const response = await postJson(`${server.baseUrl}/backup/restore`, broken);
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, 'invalid-doc');
    assert.equal(result.key, 'grades');
    assert.match(result.detail, /bad-field/);
    assert.equal((await getCourses(server))[0].name, '现存课程', '整包被拒时其余文档也不写');
  } finally {
    await server.close();
  }
});

test('恢复：不带写请求头 / 不是 JSON 体 → 403 与 415，都不写盘', async () => {
  const server = await startServer();
  try {
    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();

    const noHeader = await postJson(`${server.baseUrl}/backup/restore`, { bundle: exported.bundle }, false);
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');

    const notJson = await fetch(`${server.baseUrl}/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', [REQUEST_HEADER]: '1' },
      body: 'hello',
    });
    assert.equal(notJson.status, 415);
    assert.equal((await notJson.json()).error, 'need-json-content-type');
  } finally {
    await server.close();
  }
});

test('恢复：坏包（不是导出包 / 空 docs）→ 400，错误码能区分', async () => {
  const server = await startServer();
  try {
    const badFormat = await postJson(`${server.baseUrl}/backup/restore`, { bundle: { format: 'x', version: 1, docs: {} } });
    assert.equal(badFormat.status, 400);
    assert.equal((await badFormat.json()).error, 'bad-format');

    const noDocs = await postJson(`${server.baseUrl}/backup/restore`, {
      bundle: { format: 'study-assistant.bundle', version: 1, docs: {}, checksum: 'sha256:0' },
    });
    assert.equal(noDocs.status, 400);
    assert.equal((await noDocs.json()).error, 'no-docs');

    const badPayload = await fetch(`${server.baseUrl}/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
      body: '[]',
    });
    assert.equal(badPayload.status, 400);
    assert.equal((await badPayload.json()).error, 'bad-payload');
  } finally {
    await server.close();
  }
});
