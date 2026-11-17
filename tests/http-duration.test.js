/**
 * 学习时长接口（`POST/GET /study-log/duration`）的往返测试（C2，2026-11-17）。
 *
 * 契约（实现见 `lib/api.js` 的 handleStudyDurationPost/Get）：
 * - POST 体 `{ startAt, endAt, seconds, scopeType, mode, courseId?, nodeId?, path?, chapterNo? }`，
 *   必须带 `X-Study-Request`；成功 200 `{ok:true,written:true,record,total}`；坏值 400 `{ok:false,error:reason}`。
 * - <5 秒拒收（error='bad-seconds'）。
 * - GET 无参返全部 `{records,totalSeconds}`；`?date=YYYY-MM-DD` 按 startAt 本地日期过滤 + 当日总秒数。
 * - 落盘到 `学习记录/学习时长.json`（结构 {version:1,records:[]}），不进 /state、不进备份包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer() {
  const dir = await makeTempDir('study-assistant-duration-');
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

const sample = {
  startAt: '2026-11-17T02:00:00.000Z',
  endAt: '2026-11-17T02:25:00.000Z',
  seconds: 1500,
  scopeType: 'node',
  courseId: 'c_ds',
  nodeId: 'k1',
  mode: 'pomodoro',
};

test('POST 学习时长：合法记录 200 落盘，GET 读回，落 学习记录/学习时长.json，不进 /state', async () => {
  const server = await startServer();
  try {
    const r1 = await postJson(`${server.baseUrl}/study-log/duration`, sample);
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.equal(b1.written, true);
    assert.equal(b1.total, 1);
    assert.equal(b1.record.seconds, 1500);
    assert.equal(b1.record.mode, 'pomodoro');

    const r2 = await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, seconds: 30, mode: 'stopwatch', nodeId: 'k2', startAt: '2026-11-17T03:00:00.000Z', endAt: '2026-11-17T03:00:30.000Z' });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).total, 2);

    const g = await fetch(`${server.baseUrl}/study-log/duration`);
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.records.length, 2);
    assert.equal(gb.totalSeconds, 1530);
    assert.equal(gb.records[0].nodeId, 'k1', '保持追加顺序');

    // 落盘文件存在且结构正确
    const file = path.join(server.dir, '学习记录', '学习时长.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.records.length, 2);

    // 不进 /state（不是主文档）
    const state = await (await fetch(`${server.baseUrl}/state`)).json();
    const json = JSON.stringify(state);
    assert.ok(!json.includes('学习时长.json'), '/state 不应含学习时长');
  } finally {
    await server.close();
  }
});

test('POST 学习时长：<5s / 缺头 / 坏字段都拒收并给 reason', async () => {
  const server = await startServer();
  try {
    // <5 秒
    const short = await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, seconds: 3 });
    assert.equal(short.status, 400);
    assert.equal((await short.json()).error, 'bad-seconds');
    // 缺 startAt
    const noStart = await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, startAt: '' });
    assert.equal(noStart.status, 400);
    assert.equal((await noStart.json()).error, 'missing-start');
    // 坏 mode
    const badMode = await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, mode: 'timer' });
    assert.equal(badMode.status, 400);
    assert.equal((await badMode.json()).error, 'bad-mode');
    // endAt 早于 startAt
    const reversed = await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, endAt: '2026-11-17T01:00:00.000Z' });
    assert.equal(reversed.status, 400);
    assert.equal((await reversed.json()).error, 'end-before-start');
    // 没有写请求头 → 拒绝（writePreflight）
    const noHeader = await postJson(`${server.baseUrl}/study-log/duration`, sample, false);
    assert.ok(noHeader.status >= 400, '缺 X-Study-Request 应被拒');
    // 一次都不落盘
    const g = await (await fetch(`${server.baseUrl}/study-log/duration`)).json();
    assert.equal(g.records.length, 0);
  } finally {
    await server.close();
  }
});

test('GET 学习时长 ?date=：只返该本地日期记录并给当日总秒数', async () => {
  const server = await startServer();
  try {
    // 本地时间 2026-11-17 当日两条、次日一条（这里用本地日期串构造，避免时区歧义）
    const d = new Date(2026, 10, 17, 10, 0, 0); // 2026-11-17 10:00 本地
    const dEnd = new Date(d.getTime() + 25 * 60 * 1000);
    const nextDay = new Date(2026, 10, 18, 9, 0, 0);
    const nextDayEnd = new Date(nextDay.getTime() + 10 * 60 * 1000);
    await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, startAt: d.toISOString(), endAt: dEnd.toISOString(), seconds: 1500 });
    await postJson(`${server.baseUrl}/study-log/duration`, { ...sample, startAt: nextDay.toISOString(), endAt: nextDayEnd.toISOString(), seconds: 600 });

    const g = await fetch(`${server.baseUrl}/study-log/duration?date=2026-11-17`);
    const gb = await g.json();
    assert.equal(gb.date, '2026-11-17');
    assert.equal(gb.records.length, 1, '只返 11-17 当日一条');
    assert.equal(gb.totalSeconds, 1500);
  } finally {
    await server.close();
  }
});
