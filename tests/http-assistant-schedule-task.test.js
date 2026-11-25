/**
 * 「经聊天改日程 / 改 DDL」：`POST /assistant/reply` 只出**预览**，落库仍由前端走 `POST /mutate`。
 * 运行：npm test
 *
 * 用户口径（2026-11-25）：
 *   1. 学习助手**有权限**增删改 `日程.json` 与 `任务.json`；
 *   2. 但**先说清要改什么、用户点头才落库** —— 预览阶段一个字节都不许写；
 *   3. 删除额外多确认一次（后端只打 `danger` 标，二次确认在前端）。
 *
 * 所以这些用例按「红线」写：宁可断言「没写盘」，也不去断言界面长什么样。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { DOC_VERSION } from '../lib/core.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

const PARSE_PROMPT_MARK = '解析器';


function taskItem(id, title, due) {
  return {
    id,
    title,
    courseId: 'c_phy',
    kind: 'homework',
    due,
    status: 'todo',
    priority: 'normal',
    estimateHours: null,
    progress: 0,
    doneAt: null,
    note: '',
    createdAt: '2026-11-10T02:00:00.000Z',
  };
}

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-schedule-task-');
  const store = createStore(dir);
  await store.init();
  // 日程条目**走真实写入路径创建**（`POST /mutate`）：直接 writeDocument 手搓条目会被
  // 文档 shape 校验挡回去（entries 被清空），那样测出来的就不是线上真会有的数据。
  await store.writeDocument('tasks', {
    version: DOC_VERSION,
    tasks: [taskItem('t_a', '物理实验报告', '2026-11-22')],
    updatedAt: null,
  });
  await store.writeDocument('courses', {
    version: DOC_VERSION,
    courses: [{ id: 'c_phy', name: '物理', aliases: [], color: null }],
    updatedAt: null,
  });

  const calls = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    now: () => new Date('2026-11-20T03:00:00.000Z'),
    assistantChat: async (input) => {
      calls.push(input);
      const system = String(input?.messages?.[0]?.content ?? '');
      if (system.includes(PARSE_PROMPT_MARK)) {
        const answer = typeof options.parseAnswer === 'function' ? options.parseAnswer(input) : options.parseAnswer;
        return { content: typeof answer === 'string' ? answer : JSON.stringify(answer ?? { actions: [] }) };
      }
      return { content: '（模型回答）' };
    },
    logger: { error() {}, info() {}, warn() {} },
    ...options.handlerOptions,
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}${API_PREFIX}`;
  const created = await fetch(`${baseUrl}/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
    body: JSON.stringify({
      doc: 'schedule',
      action: 'create',
      item: { title: '取快递', date: '2026-11-21', time: '10:00', category: 'study' },
    }),
  }).then((response) => response.json());
  const scheduleDoc = JSON.parse(await fs.readFile(path.join(dir, '日程.json'), 'utf8'));
  const scheduleId = scheduleDoc.entries?.[0]?.id ?? '';
  return {
    baseUrl,
    dir,
    calls,
    scheduleId,
    mutateOk: created.ok === true,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function ask(url, text) {
  return fetch(`${url}/assistant/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
}

/** 整目录快照：用来证明「预览阶段一个字节都没写」。 */
async function snapshotDir(root) {
  const entries = [];
  async function walk(dir, prefix) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
      else entries.push([rel, await fs.readFile(path.join(dir, item.name), 'utf8')]);
    }
  }
  await walk(root, '');
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

test('加日程：出一份预览，且一个字节都不落库', async () => {
  const server = await startServer({
    parseAnswer: {
      actions: [
        { target: 'schedule', op: 'create', title: '交实验报告', date: '2026-11-21', time: '15:00', category: 'study' },
      ],
    },
  });
  try {
    const before = await snapshotDir(server.dir);
    const response = await ask(server.baseUrl, '明天下午三点加一个日程：交实验报告');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction?.kind, 'schedule-task');
    assert.equal(result.proposedAction.actions.length, 1);
    const action = result.proposedAction.actions[0];
    assert.equal(action.target, 'schedule');
    assert.equal(action.op, 'create');
    assert.equal(action.item.title, '交实验报告');
    assert.equal(action.item.date, '2026-11-21');
    assert.equal(action.item.time, '15:00');
    assert.equal(result.proposedAction.danger, false, '新增不该被标成危险');
    assert.match(result.reply, /还没落库/);
    assert.deepEqual(await snapshotDir(server.dir), before, '预览阶段绝不许落库');
  } finally {
    await server.close();
  }
});

test('删除：预览带 danger 标，但仍不落库', async () => {
  let deletingId = '';
  const server = await startServer({
    // 条目 id 是 `/mutate` 现生成的（`makeId('s')`），所以桩要用函数形态、请求时才取值。
    parseAnswer: () => ({ actions: [{ target: 'schedule', op: 'delete', id: deletingId }] }),
  });
  try {
    deletingId = server.scheduleId;
    assert.notEqual(deletingId, '', '前置：日程条目得先真的建出来');
    const before = await snapshotDir(server.dir);
    const result = await (await ask(server.baseUrl, '把明天取快递那条日程删掉')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction?.danger, true, '含删除必须打危险标，前端要二次确认');
    assert.equal(result.proposedAction.actions[0].op, 'delete');
    assert.equal(result.proposedAction.actions[0].id, deletingId);
    assert.match(result.reply, /删除要再点一次确认/);
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('改 DDL：用既有 id + patch，且不落库', async () => {
  const server = await startServer({
    parseAnswer: { actions: [{ target: 'task', op: 'update', id: 't_a', patch: { due: '2026-11-25' } }] },
  });
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await ask(server.baseUrl, '物理实验报告的 DDL 改到 11 月 25 号')).json();
    assert.equal(result.ok, true);
    const action = result.proposedAction.actions[0];
    assert.equal(action.target, 'task');
    assert.equal(action.item.due, '2026-11-25');
    assert.equal(action.item.title, '物理实验报告', '改的时候其他字段要沿用它原来的值');
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('凭空编的 id 一律不认：不产生动作，只回一句说明', async () => {
  const server = await startServer({
    parseAnswer: { actions: [{ target: 'schedule', op: 'delete', id: 's_不存在' }] },
  });
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await ask(server.baseUrl, '把那条日程删除')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction, undefined, '认不出目标就不能给确认按钮');
    assert.match(result.reply, /没能翻译成可执行的改动/);
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('字段不合格的 create 被拒（不猜日期），其余仍能出预览', async () => {
  const server = await startServer({
    parseAnswer: {
      actions: [
        { target: 'schedule', op: 'create', title: '说不清哪天的事', date: '明天' },
        { target: 'task', op: 'create', title: '交作业', due: '2026-11-23', kind: 'other' },
      ],
    },
  });
  try {
    const result = await (await ask(server.baseUrl, '帮我把这两件事加到日程和 DDL 里')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction.actions.length, 1, '不合格的那条要被丢掉');
    assert.equal(result.proposedAction.actions[0].target, 'task');
    assert.match(result.reply, /没敢照做/, '被拒的必须明说，不能装作没发生');
  } finally {
    await server.close();
  }
});

test('一次说超过 10 条 → 直接拒，一条都不预览', async () => {
  const actions = Array.from({ length: 11 }, (unused, index) => ({
    target: 'task',
    op: 'create',
    title: `第 ${index + 1} 件事`,
    due: '2026-11-30',
    kind: 'other',
  }));
  const server = await startServer({ parseAnswer: { actions } });
  try {
    const result = await (await ask(server.baseUrl, '加这十一个日程')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /10 条以内/);
  } finally {
    await server.close();
  }
});

test('不是改日程/DDL 的话：先过关键词门，压根不调解析，照常答疑', async () => {
  const server = await startServer({ parseAnswer: { actions: [] } });
  try {
    const result = await (await ask(server.baseUrl, '薛定谔方程怎么推')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction ?? null, null);
    assert.equal(result.reply, '（模型回答）');
    assert.equal(server.calls.length, 1, '只该有一次答疑调用，不该多问一次解析');
    assert.equal(String(server.calls[0].messages[0]?.content ?? '').includes(PARSE_PROMPT_MARK), false);
  } finally {
    await server.close();
  }
});

test('模型返回带围栏的 JSON 也能解析（真实模型常这么答）', async () => {
  const server = await startServer({
    parseAnswer: '好的：\n```json\n{"actions":[{"target":"task","op":"create","title":"交数电作业","due":"2026-11-24","kind":"homework"}]}\n```',
  });
  try {
    const result = await (await ask(server.baseUrl, '加一个 DDL：数电作业 11 月 24 号交')).json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction?.actions?.length, 1);
    assert.equal(result.proposedAction.actions[0].item.title, '交数电作业');
  } finally {
    await server.close();
  }
});
