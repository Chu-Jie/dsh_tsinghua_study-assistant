/**
 * 一键开工接口测试（零依赖）
 * 运行：node tests/homework-spawn.test.js
 *
 * 验的是「点火」这一下：任务校验、课程校验、会话接口是否真的被调用、
 * 投出去的固定指令里那几条硬约束有没有写漏。
 * 真正的取字/分题/生成不在这里测 —— 那些已经换由会话里的 agent 做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 起一个真实服务；`handoff` 可注入假实现，默认「没开会话接口」。 */
async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-spawn-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} }, ...options });
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
    store,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 预置一门课与一条作业任务。 */
async function seed(store) {
  await store.writeDocument('courses', {
    version: 1,
    courses: [{ id: 'c_ds', name: '数据结构', aliases: ['数据结构'], credits: 4, sessions: [] }],
    updatedAt: new Date().toISOString(),
  });
  await store.writeDocument('tasks', {
    version: 1,
    tasks: [
      { id: 't_ds_1', title: '数据结构第 01 次作业', courseId: 'c_ds', kind: 'homework', due: '2026-10-10', status: 'open' },
      { id: 't_orphan', title: '没有课程的任务', courseId: null, kind: 'homework', due: '2026-10-11', status: 'open' },
    ],
    updatedAt: new Date().toISOString(),
  });
}

test('缺自定义头 → 403', async () => {
  const server = await startServer({ handoff: async () => ({ ok: true, sessionId: 's1' }) });
  try {
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' }, { withHeader: false });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

test('没带 taskId → 400 missing-task', async () => {
  const server = await startServer({ handoff: async () => ({ ok: true, sessionId: 's1' }) });
  try {
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, {});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'missing-task');
  } finally {
    await server.close();
  }
});

test('taskId 不合法 → 400 bad-id', async () => {
  const server = await startServer({ handoff: async () => ({ ok: true, sessionId: 's1' }) });
  try {
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: '../../etc/passwd' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'bad-id');
  } finally {
    await server.close();
  }
});

test('任务不存在 → 404 unknown-task', async () => {
  const server = await startServer({ handoff: async () => ({ ok: true, sessionId: 's1' }) });
  try {
    await seed(server.store);
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_nope' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'unknown-task');
  } finally {
    await server.close();
  }
});

test('任务没挂课程 → 409 course-not-found，且不去建会话', async () => {
  let called = 0;
  const server = await startServer({
    handoff: async () => { called += 1; return { ok: true, sessionId: 's1' }; },
  });
  try {
    await seed(server.store);
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_orphan' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'course-not-found');
    assert.equal(called, 0);
  } finally {
    await server.close();
  }
});

test('正常点火：200 且固定指令里带硬约束', async () => {
  const calls = [];
  const server = await startServer({
    handoff: async (input) => { calls.push(input); return { ok: true, sessionId: 'sess-42' }; },
  });
  try {
    await seed(server.store);
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, 'sess-42');
    assert.equal(payload.taskId, 't_ds_1');

    assert.equal(calls.length, 1);
    const prompt = calls[0].prompt;
    // 指令里必须真的点名这次作业与课程，否则会话不知道从哪下手
    assert.ok(prompt.includes('数据结构第 01 次作业'));
    assert.ok(prompt.includes('数据结构/作业/'));
    // 两份产物的文件名是用户 2026-10-20 定的，写错就等于没交付
    assert.ok(prompt.includes('第NN次作业_引导与详解.md'));
    assert.ok(prompt.includes('第NN次作业_誊写版.md'));
    // 可打印 HTML 也是一键开工的产物（用户 2026-10-20 傍晚定）：md2html.py 转一份，命名沿用脚本默认名
    assert.ok(prompt.includes('_工具/md2html.py'));
    assert.ok(prompt.includes('(可打印).html'));
    // 硬约束：不改 status、不建署名文件
    assert.ok(prompt.includes('不要改 status'));
    assert.ok(prompt.includes('提交文件/'));
    // 一轮确认，而不是全自动闷头出答案
    assert.ok(prompt.includes('先回一条确认'));
    // 2026-10-27 按现行作业规范重写后新增的硬要求，缺一条就等于退回旧口径
    assert.ok(prompt.includes('先判模式'), '要先判 A/B/C 模式');
    assert.ok(prompt.includes('题目—答案映射表'), '模式 A 必须有题目—答案映射表');
    assert.ok(prompt.includes('作业.json'), '题号要对齐 作业.json 的 questions[].no');
    // 誊写版是「可直接抄的完成稿」，旧口径「不带推导」已废弃
    assert.ok(prompt.includes('可直接抄的完成稿'));
    assert.ok(!prompt.includes('不带推导'), '誊写版不能退回「只给答案」');
    assert.ok(prompt.includes('第NN次数值验证.py'), '数值验证脚本要入库');
    assert.ok(prompt.includes('按每版分别定位'), '多版本教材要分别作答');
    assert.ok(prompt.includes('需你确认'), '拿不准的题要标注');
    assert.ok(prompt.includes('[learn:xszyid:'), 'note 要保留 learn 记号');
    assert.ok(prompt.includes('present'), '收尾要给交付卡片');
  } finally {
    await server.close();
  }
});

test('宿主没给会话接口 → 503 sessions-unavailable', async () => {
  const server = await startServer();
  try {
    await seed(server.store);
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'sessions-unavailable');
  } finally {
    await server.close();
  }
});

test('会话开失败了 → 502，并把宿主的原因带出来', async () => {
  const server = await startServer({ handoff: async () => ({ ok: false, error: 'handoff-failed', detail: 'boom' }) });
  try {
    await seed(server.store);
    const response = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error, 'handoff-failed');
    assert.equal(payload.detail, 'boom');
  } finally {
    await server.close();
  }
});

test('旧的四条写接口已经下线 → 404', async () => {
  const server = await startServer({ handoff: async () => ({ ok: true, sessionId: 's1' }) });
  try {
    for (const route of ['/homework/scan', '/homework/split', '/homework/confirm', '/homework/generate']) {
      const response = await jsonRequest(`${server.baseUrl}${route}`, {});
      assert.equal(response.status, 404, route);
    }
    for (const route of ['/homework', '/homework/list']) {
      const response = await fetch(`${server.baseUrl}${route}`);
      assert.equal(response.status, 404, route);
    }
  } finally {
    await server.close();
  }
});
