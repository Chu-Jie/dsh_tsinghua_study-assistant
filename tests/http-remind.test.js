// 「一键提醒」+ 日程写入口的 HTTP 测试（2026-11-19 A 卡）。
//
// 两条硬要求：
//   1. **绝不真发消息**：所有用例一律注入 `remindDeliver` / `remindChannels`，
//      默认的 dsh-im HTTP 投递路径在这份测试里永远不会被执行；
//   2. 覆盖三条通道语义：微信通 → 停；微信不通 → 回退 QQ；两条都不通 → 仍返回文本供前端复制。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-remind-');
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
    port,
    dir,
    handler,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  Object.assign(headers, options.headers ?? {});
  return fetch(url, { method: options.method ?? 'POST', headers, body: JSON.stringify(body) });
}

/** 今天（本地时区）的 `YYYY-MM-DD`；提醒文本里的「今日 DDL」要靠它命中。 */
function todayText() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const CHANNELS = [
  { channel: 'weixin', botId: 'wx_test_bot', targetId: 'owner-direct' },
  { channel: 'qq', botId: 'qq_test_bot', targetId: 'owner-direct' },
];

test('POST /remind：缺安全请求头时 403，且一次都不投递', async () => {
  let called = 0;
  const server = await startServer({
    remindChannels: () => CHANNELS,
    remindDeliver: async () => {
      called += 1;
      return { ok: true };
    },
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/remind`, {}, { withHeader: false });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'need-request-header');
    assert.equal(called, 0, '被闸门挡下时不该碰投递');
  } finally {
    await server.close();
  }
});

test('POST /remind：微信成功即止，返回 channel=weixin 与可发送文本', async () => {
  const calls = [];
  const server = await startServer({
    remindChannels: () => CHANNELS,
    remindDeliver: async (payload) => {
      calls.push(payload);
      return { ok: true };
    },
  });
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '今天要交的实验报告', due: todayText() },
    });
    const response = await jsonRequest(`${server.baseUrl}/remind`, {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'weixin');
    assert.equal(calls.length, 1, '微信通了就不该再打扰 QQ');
    assert.equal(calls[0].botId, 'wx_test_bot');
    assert.equal(calls[0].targetId, 'owner-direct');
    assert.match(result.text, /^【今日日程 · \d{2}\/\d{2} 周/, '文本以日程抬头开头');
    assert.match(result.text, /今天要交的实验报告/, '今天的 DDL 要进文本');
    assert.equal(result.attempts.length, 1);
  } finally {
    await server.close();
  }
});

test('POST /remind：微信失败自动回退 QQ，attempts 记两条', async () => {
  const tried = [];
  const server = await startServer({
    remindChannels: () => CHANNELS,
    remindDeliver: async (payload) => {
      tried.push(payload.botId);
      if (payload.botId === 'wx_test_bot') return { ok: false, error: 'delivery-failed' };
      return { ok: true };
    },
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/remind`, {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'qq');
    assert.deepEqual(tried, ['wx_test_bot', 'qq_test_bot']);
    assert.deepEqual(result.attempts.map((a) => a.channel), ['weixin', 'qq']);
    assert.equal(result.attempts[0].ok, false);
    assert.match(result.detail, /回退 qq/);
  } finally {
    await server.close();
  }
});

test('POST /remind：两条都不通时 502，但文本照回（前端靠它复制兜底）', async () => {
  const server = await startServer({
    remindChannels: () => CHANNELS,
    remindDeliver: async () => ({ ok: false, error: 'bot-not-connected' }),
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/remind`, {});
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'remind-failed');
    assert.equal(result.attempts.length, 2);
    assert.match(result.text, /【今日日程 · /, '失败也要把文本带回来，用户才能复制');
  } finally {
    await server.close();
  }
});

test('POST /remind：没有可用的「本人私聊」目标时 503 并给出怎么修', async () => {
  const server = await startServer({
    remindChannels: () => [],
    remindDeliver: async () => ({ ok: true }),
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/remind`, {});
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error, 'remind-no-channel');
    assert.match(result.detail, /私聊目标/);
    assert.match(result.text, /【今日日程 · /);
  } finally {
    await server.close();
  }
});

test('POST /remind：Host 不是回环地址时拒发（投递接口没有鉴权，不能当跳板）', async () => {
  const server = await startServer({
    remindChannels: () => CHANNELS,
    remindDeliver: async () => {
      throw new Error('不该被调用');
    },
  });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: `${API_PREFIX}/remind`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [REQUEST_HEADER]: '1',
          Host: 'evil.example.com:8080',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: chunks.join('') }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(body.status, 400);
    assert.equal(JSON.parse(body.text).error, 'bad-host');
  } finally {
    await server.close();
  }
});

test('POST /mutate doc=schedule：建 / 改 / 删都走通用范式，坏字段 400', async () => {
  const server = await startServer({ remindChannels: () => [], remindDeliver: async () => ({ ok: true }) });
  try {
    const created = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '交实验报告', date: todayText(), time: '09:30', note: '三教' },
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.count, 1);

    const state = await (await fetch(`${server.baseUrl}/state?doc=schedule`)).json();
    assert.equal(state.doc.entries.length, 1);
    assert.equal(state.doc.entries[0].title, '交实验报告');
    assert.equal(state.doc.entries[0].time, '09:30');
    assert.match(state.doc.entries[0].id, /^s_/, 'id 由服务端生成');
    assert.ok(state.doc.entries[0].createdAt && state.doc.entries[0].updatedAt, '两个时间戳都要落');

    const badDate = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '坏日期', date: '2026-2-31' },
    });
    assert.equal(badDate.status, 400);
    assert.equal((await badDate.json()).error, 'schedule-bad-date');

    const noTitle = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '   ', date: todayText() },
    });
    assert.equal(noTitle.status, 400);
    assert.equal((await noTitle.json()).error, 'schedule-title-required');

    const deleted = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'delete',
      id: state.doc.entries[0].id,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).count, 0);
  } finally {
    await server.close();
  }
});

test('日程写进 /state 与 /backup/export（新文档自动跟着既有链路走）', async () => {
  const server = await startServer({ remindChannels: () => [], remindDeliver: async () => ({ ok: true }) });
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '取快递', date: todayText(), time: null },
    });
    const all = await (await fetch(`${server.baseUrl}/state`)).json();
    assert.equal(all.files.schedule, '日程.json');
    assert.equal(all.docs.schedule.entries.length, 1);

    const exported = await (await fetch(`${server.baseUrl}/backup/export`)).json();
    assert.equal(exported.count, 16);
    assert.equal(exported.bundle.docs.schedule.entries.length, 1);
  } finally {
    await server.close();
  }
});
