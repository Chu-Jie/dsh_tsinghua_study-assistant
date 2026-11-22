/**
 * 助手会话 HTTP 路由（v2-C，2026-11-21）测试。
 * 运行：npm test
 *
 * 对着任务卡 ⑥.2 / ⑨ 的验收门：
 *   - GET /assistant/session/list        默认隐藏归档，?includeArchived=1 全列
 *   - GET /assistant/session/get?id=     单会话全文；缺失 400、不存在 404
 *   - POST /assistant/session/new        建空会话
 *   - POST /assistant/session/rename     改名置 titleCustom=true
 *   - POST /assistant/session/archive    归档/取消归档（只标记位不删磁盘）
 *   - 所有 POST 缺 X-Study-Request 头 → 4xx 拒绝（writePreflight）
 *   - POST /assistant/reply 带 conversationId → 落盘；不带 → 一字不落（兼容旧行为）
 *   - 带 conversationId 时历史以磁盘会话为准，压缩后只带摘要+近 N 轮 + 新提问
 *
 * 全部不真打网络（整体桩 deps.assistantChat），不碰真实数据目录（每例独立临时目录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { readSession, assistantSessionRoot } from '../lib/assistant-session.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-session-');
  const store = createStore(dir);
  await store.init();
  const warns = [];
  const seen = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: {
      error() {},
      info() {},
      warn(...args) { warns.push(args.map((item) => String(item)).join(' ')); },
    },
    // 默认桩：记录每次送模型的 messages，回一个可识别的答复
    assistantChat: async (input) => {
      seen.push(input);
      return { content: `答复#${seen.length}` };
    },
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
    warns,
    seen,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function jsonRequest(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function snapshotDir(root) {
  const entries = [];
  async function walk(dir, prefix) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        await walk(path.join(dir, item.name), rel);
      } else {
        const buf = await fs.readFile(path.join(dir, item.name));
        entries.push(`${rel}:${buf.length}:${buf.toString('base64').slice(0, 24)}`);
      }
    }
  }
  await walk(root, '');
  entries.sort();
  return entries;
}

// ---------------------------------------------------------------------------
// 会话 CRUD
// ---------------------------------------------------------------------------

test('session/new → get → list 基本闭环', async () => {
  const server = await startServer();
  try {
    const newRes = await jsonRequest(`${server.baseUrl}/assistant/session/new`, {});
    assert.equal(newRes.status, 200);
    const newBody = await newRes.json();
    assert.equal(newBody.ok, true);
    const id = newBody.session.id;
    assert.match(id, /^asst_/);

    const got = await getJson(`${server.baseUrl}/assistant/session/get?id=${encodeURIComponent(id)}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.session.id, id);
    assert.deepEqual(got.body.session.messages, []);

    const list = await getJson(`${server.baseUrl}/assistant/session/list`);
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0].id, id);
  } finally {
    await server.close();
  }
});

test('session/new 可带初始 title', async () => {
  const server = await startServer();
  try {
    const res = await jsonRequest(`${server.baseUrl}/assistant/session/new`, { title: '自定义开题' });
    const body = await res.json();
    assert.equal(body.session.title, '自定义开题');
  } finally {
    await server.close();
  }
});

test('session/get 缺 id → 400；不存在 → 404', async () => {
  const server = await startServer();
  try {
    assert.equal((await getJson(`${server.baseUrl}/assistant/session/get`)).status, 400);
    assert.equal((await getJson(`${server.baseUrl}/assistant/session/get?id=nope`)).status, 404);
  } finally {
    await server.close();
  }
});

test('session/rename 改名 → titleCustom=true；空标题 400；不存在 404', async () => {
  const server = await startServer();
  try {
    const newRes = await jsonRequest(`${server.baseUrl}/assistant/session/new`, {});
    const id = (await newRes.json()).session.id;
    const ok = await jsonRequest(`${server.baseUrl}/assistant/session/rename`, { id, title: '  新名字  ' });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.session.title, '新名字');
    assert.equal(okBody.session.titleCustom, true);

    assert.equal((await jsonRequest(`${server.baseUrl}/assistant/session/rename`, { id, title: '' })).status, 400);
    assert.equal((await jsonRequest(`${server.baseUrl}/assistant/session/rename`, { id: 'nope', title: 'x' })).status, 404);
  } finally {
    await server.close();
  }
});

test('session/archive 归档后默认列表隐藏、文件仍在、includeArchived 可见、可取消归档', async () => {
  const server = await startServer();
  try {
    const newRes = await jsonRequest(`${server.baseUrl}/assistant/session/new`, { title: '待归档' });
    const id = (await newRes.json()).session.id;
    const arc = await jsonRequest(`${server.baseUrl}/assistant/session/archive`, { id, archived: true });
    assert.equal(arc.status, 200);
    assert.equal((await arc.json()).session.archived, true);

    const hidden = await getJson(`${server.baseUrl}/assistant/session/list`);
    assert.equal(hidden.body.sessions.some((s) => s.id === id), false, '默认列表隐藏归档');

    const withArch = await getJson(`${server.baseUrl}/assistant/session/list?includeArchived=1`);
    assert.equal(withArch.body.sessions.some((s) => s.id === id), true);

    // 文件仍在磁盘
    const onDisk = await readSession(server.dir, id);
    assert.notEqual(onDisk, null);

    // 取消归档
    const un = await jsonRequest(`${server.baseUrl}/assistant/session/archive`, { id, archived: false });
    assert.equal((await un.json()).session.archived, false);
    const visible = await getJson(`${server.baseUrl}/assistant/session/list`);
    assert.equal(visible.body.sessions.some((s) => s.id === id), true, '取消归档后回列表');
  } finally {
    await server.close();
  }
});

test('所有 POST 缺 X-Study-Request 头 → 拒绝（writePreflight）', async () => {
  const server = await startServer();
  try {
    for (const route of ['/assistant/session/new', '/assistant/session/rename', '/assistant/session/archive']) {
      const res = await fetch(`${server.baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // 故意不带 REQUEST_HEADER
        body: JSON.stringify({ id: 'x', title: 't', archived: true }),
      });
      assert.ok(res.status >= 400 && res.status < 500, `${route} 应 4xx，实际 ${res.status}`);
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// reply 落盘：带 conversationId vs 不带
// ---------------------------------------------------------------------------

test('reply 不带 conversationId → 不落盘（数据目录快照一字不差）', async () => {
  const server = await startServer();
  try {
    const before = await snapshotDir(server.dir);
    const res = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '你好' }],
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, '答复#1');
    const after = await snapshotDir(server.dir);
    assert.deepEqual(after, before, '不带 conversationId 必须一字不落');
    // 助手会话目录都不该冒出来
    const exists = await fs.stat(assistantSessionRoot(server.dir)).then(() => true).catch(() => false);
    assert.equal(exists, false, '无 conversationId 不应创建 助手会话/ 目录');
  } finally {
    await server.close();
  }
});

test('reply 带 conversationId → 落盘 user+assistant 两条，切回能读全过程', async () => {
  const server = await startServer();
  try {
    const id = 'asst_persist_1';
    const res = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [{ role: 'user', content: '极限的定义是什么' }],
    });
    assert.equal(res.status, 200);
    const onDisk = await readSession(server.dir, id);
    assert.notEqual(onDisk, null, '应落盘');
    assert.equal(onDisk.messages.length, 2);
    assert.equal(onDisk.messages[0].role, 'user');
    assert.equal(onDisk.messages[0].content, '极限的定义是什么');
    assert.equal(onDisk.messages[1].role, 'assistant');
    // 首条自动命名
    assert.equal(onDisk.title, '极限的定义是什么');
  } finally {
    await server.close();
  }
});

test('reply 第二轮带 conversationId：历史以磁盘为准，只把新提问接到压缩视图', async () => {
  const server = await startServer();
  try {
    const id = 'asst_persist_2';
    // 第一轮
    await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [{ role: 'user', content: '第一问' }],
    });
    // 第二轮：前端仍可能传全量，但后端应以磁盘为准，只取最后一条 user
    await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '答一' },
        { role: 'user', content: '第二问' },
      ],
    });
    const onDisk = await readSession(server.dir, id);
    assert.equal(onDisk.messages.length, 4, '两轮共 4 条，不因前端重复传而重复落盘');
    assert.equal(onDisk.messages[2].content, '第二问');
    assert.equal(onDisk.messages[3].content, '答复#2');
  } finally {
    await server.close();
  }
});

test('summary 压缩：>30 条触发后，送模型的是 [摘要+近10轮+新提问]，磁盘保留全部消息', async () => {
  // 桩：第一次回答复，第二次（摘要器）回摘要文本
  const seen = [];
  let callIdx = 0;
  const server = await startServer({
    assistantChat: async (input) => {
      seen.push(input);
      callIdx += 1;
      // 摘要器调用：system 里含「摘要」
      const isSummarizer = input.messages.some((m) => m.role === 'system' && String(m.content).includes('摘要器'));
      if (isSummarizer) return { content: '这里是一段压缩后的对话摘要' };
      return { content: `答复#${callIdx}` };
    },
  });
  try {
    const id = 'asst_compress_1';
    // 预置 34 条历史（17 轮），塞进磁盘文件
    const { writeSession } = await import('../lib/assistant-session.js');
    const msgs = [];
    for (let i = 0; i < 17; i += 1) {
      msgs.push({ role: 'user', content: `历史问${i}` });
      msgs.push({ role: 'assistant', content: `历史答${i}` });
    }
    await writeSession(server.dir, {
      id,
      title: '历史会话',
      titleCustom: false,
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z',
      summary: '',
      summaryUpTo: 0,
      archived: false,
      messages: msgs,
    });

    // 发一轮新提问，落盘后总条数 34+2=36 > 30 → 本轮照常用全量历史回答，答完后才触发摘要
    const res = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [{ role: 'user', content: '新提问' }],
    });
    assert.equal(res.status, 200);

    // 本轮答疑调用（触发压缩的那一轮）：还没有摘要，送的是磁盘全量 + 新提问
    const firstAnswer = seen.find((call) => !call.messages.some((m) => m.role === 'system' && String(m.content).includes('摘要器')));
    assert.ok(firstAnswer, '应有答疑调用');
    assert.equal(
      firstAnswer.messages.some((m) => String(m.content).includes('【之前对话摘要】')),
      false,
      '触发压缩的那一轮，回答时还没有摘要（压缩发生在此轮答完之后）',
    );
    assert.equal(
      firstAnswer.messages.map((m) => m.content).join('\n').includes('历史问0'),
      true,
      '触发轮仍用全量历史回答',
    );

    // 磁盘保留全部消息（36 条）+ 摘要已写入
    const afterFirst = await readSession(server.dir, id);
    assert.equal(afterFirst.messages.length, 36, '磁盘绝不删早期消息');
    assert.ok(afterFirst.summary !== '', '摘要已生成写入');
    assert.ok(afterFirst.summaryUpTo > 0, 'summaryUpTo 推进');

    // 第二轮新提问：这一次送模型的是 [摘要 + 近10轮 + 新提问]，早期历史不再原样发
    seen.length = 0;
    const res2 = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [{ role: 'user', content: '再来一问' }],
    });
    assert.equal(res2.status, 200);
    const secondAnswer = seen.find((call) => !call.messages.some((m) => m.role === 'system' && String(m.content).includes('摘要器')));
    assert.ok(secondAnswer, '应有第二次答疑调用');
    const joined = secondAnswer.messages.map((m) => m.content).join('\n');
    assert.equal(joined.includes('【之前对话摘要】'), true, '下一轮送模型带摘要行');
    assert.equal(joined.includes('历史问0'), false, '早期历史已被摘要覆盖，不再原样发');
    assert.ok(secondAnswer.messages.length < 36, '送模型条数远少于磁盘全量');
    // 磁盘仍保留全部（36 + 2 = 38）
    const afterSecond = await readSession(server.dir, id);
    assert.equal(afterSecond.messages.length, 38, '磁盘继续追加,绝不删');
  } finally {
    await server.close();
  }
});

test('摘要失败降级：摘要器抛错不阻塞回答，消息照样落盘、答复正常返回', async () => {
  let callIdx = 0;
  const server = await startServer({
    assistantChat: async (input) => {
      callIdx += 1;
      const isSummarizer = input.messages.some((m) => m.role === 'system' && String(m.content).includes('摘要器'));
      if (isSummarizer) throw new Error('summary-boom');
      return { content: `答复#${callIdx}` };
    },
  });
  try {
    const id = 'asst_compress_fail';
    const { writeSession } = await import('../lib/assistant-session.js');
    const msgs = [];
    for (let i = 0; i < 17; i += 1) {
      msgs.push({ role: 'user', content: `q${i}` });
      msgs.push({ role: 'assistant', content: `a${i}` });
    }
    await writeSession(server.dir, {
      id, title: 't', titleCustom: false,
      createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z',
      summary: '', summaryUpTo: 0, archived: false, messages: msgs,
    });
    const res = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      conversationId: id,
      messages: [{ role: 'user', content: '还会答吗' }],
    });
    assert.equal(res.status, 200, '摘要失败不阻塞回答');
    assert.equal((await res.json()).reply !== '', true);
    const onDisk = await readSession(server.dir, id);
    assert.equal(onDisk.messages.length, 36, '降级时消息照样全量落盘');
    assert.equal(onDisk.summary, '', '摘要留空待下次');
    assert.ok(server.warns.some((w) => w.includes('摘要')), '应有降级日志');
  } finally {
    await server.close();
  }
});
