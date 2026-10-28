/**
 * 知识点内嵌聊天（`POST /knowledge/chat`）的往返测试。
 *
 * 模型调用用假 `complete`：这里验的是「消息校验」「多轮历史怎么拼进 prompt」
 * 「错误码」，不是模型答得好不好。
 *
 * 契约（实现见 `lib/api.js` 的 handleKnowledgeChatPost）：
 * - POST 体 `{ node, messages: [{role, content}] }`，必须带 `X-Study-Request`；
 * - `messages` 最后一条必须是 user，最多 20 条、单条最多 2000 字；
 * - 只读这个知识点的证据，**不落盘**（聊天是临时的，所以没有缓存文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-chat-');
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

/** 造一个节点：返回它的 id（id 由服务端生成，得回头读一次 state）。 */
async function makeNode(server, extra = {}) {
  const response = await postJson(`${server.baseUrl}/mutate`, {
    doc: 'knowledgeNetwork',
    action: 'create',
    item: { name: '二分查找', courseId: 'c_ds', chapter: '第 2 章 向量', section: '2.6', mastery: 1, ...extra },
  });
  assert.equal(response.status, 200);
  const state = await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json();
  const nodes = Array.isArray(state?.doc?.nodes) ? state.doc.nodes : [];
  const created = nodes[nodes.length - 1];
  assert.equal(typeof created?.id, 'string', '节点必须真的落盘了');
  return created.id;
}

test('聊天：一轮问答回 reply，prompt 里带知识点名与对话，不写任何缓存文件', async () => {
  const calls = [];
  const server = await startServer({
    complete: async (request) => {
      calls.push(request);
      return { ok: true, text: '  一句话：二分查找每次砍一半，所以是 log。  ', model: 'fake-model' };
    },
  });
  try {
    const id = await makeNode(server);
    const response = await postJson(`${server.baseUrl}/knowledge/chat`, {
      node: id,
      messages: [{ role: 'user', content: '为什么二分查找是 log 级？' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.node, id);
    assert.equal(body.name, '二分查找');
    assert.equal(body.reply, '一句话：二分查找每次砍一半，所以是 log。', '首尾空白要削掉');
    assert.equal(body.model, 'fake-model');
    assert.equal(body.chars, body.reply.length);
    assert.ok(Array.isArray(body.sources), 'sources 必须是数组（没证据时是空数组）');
    assert.deepEqual(body.sources, [], '这个节点没有证据，就不该编出来源');

    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes('就「二分查找」这个知识点对话'), '角色里要带知识点名');
    assert.ok(calls[0].prompt.includes('【对话】'));
    assert.ok(calls[0].prompt.includes('学生：为什么二分查找是 log 级？'));
    assert.ok(calls[0].prompt.includes('请回答学生最后这一问。'));
    assert.equal(calls[0].maxTokens, 1200);
    assert.equal(calls[0].timeoutMs, 180000);

    // 聊天结果不落盘：讲解缓存目录不该因为聊天多出文件
    const fs = await import('node:fs');
    const dir = `${server.dir}/讲解缓存`;
    const exists = fs.existsSync(dir);
    assert.equal(exists, false, '聊天不写讲解缓存目录');
  } finally {
    await server.close();
  }
});

test('聊天：多轮历史按顺序进 prompt，助教那轮标「助教：」', async () => {
  const calls = [];
  const server = await startServer({
    complete: async (request) => {
      calls.push(request);
      return { ok: true, text: '接着说。' };
    },
  });
  try {
    const id = await makeNode(server);
    const response = await postJson(`${server.baseUrl}/knowledge/chat`, {
      node: id,
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一次答' },
        { role: 'user', content: '第二问' },
      ],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.reply, '接着说。');
    const prompt = calls[0].prompt;
    const first = prompt.indexOf('学生：第一问');
    const answer = prompt.indexOf('助教：第一次答');
    const second = prompt.indexOf('学生：第二问');
    assert.ok(first > 0 && answer > first && second > answer, '三轮顺序不能乱');
  } finally {
    await server.close();
  }
});

test('聊天：消息不合法逐条拒绝，且一次都不调模型', async () => {
  const calls = [];
  const server = await startServer({
    complete: async (request) => {
      calls.push(request);
      return { ok: true, text: '不该被调用' };
    },
  });
  try {
    const id = await makeNode(server);
    const chat = (body) => postJson(`${server.baseUrl}/knowledge/chat`, body);

    const noNode = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(noNode.status, 400);
    assert.equal((await noNode.json()).error, 'missing-node');

    const emptyList = await chat({ node: id, messages: [] });
    assert.equal(emptyList.status, 400);
    assert.equal((await emptyList.json()).error, 'bad-messages');

    const badRole = await chat({ node: id, messages: [{ role: 'system', content: 'hi' }] });
    assert.equal(badRole.status, 400);
    assert.equal((await badRole.json()).error, 'bad-role');

    const blank = await chat({ node: id, messages: [{ role: 'user', content: '   ' }] });
    assert.equal(blank.status, 400);
    assert.equal((await blank.json()).error, 'empty-message');

    const tooLong = await chat({ node: id, messages: [{ role: 'user', content: 'x'.repeat(2001) }] });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error, 'message-too-long');

    const many = await chat({
      node: id,
      messages: Array.from({ length: 21 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条` })),
    });
    assert.equal(many.status, 400);
    const manyBody = await many.json();
    assert.equal(manyBody.error, 'too-many-messages');
    assert.equal(manyBody.limit, 20);

    const endsWithAssistant = await chat({ node: id, messages: [{ role: 'assistant', content: '我说完了' }] });
    assert.equal(endsWithAssistant.status, 400);
    assert.equal((await endsWithAssistant.json()).error, 'last-must-be-user');

    assert.equal(calls.length, 0, '参数都不对，一次模型都不该调');
  } finally {
    await server.close();
  }
});

test('聊天：节点不存在 404，没挂模型 503，模型失败/空回复 502，缺写请求头 403', async () => {
  const server = await startServer({ complete: async () => ({ ok: true, text: '不会用到' }) });
  try {
    const missing = await postJson(`${server.baseUrl}/knowledge/chat`, {
      node: 'k_不存在',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'node-missing');

    const noHeader = await postJson(`${server.baseUrl}/knowledge/chat`, {
      node: 'k_x',
      messages: [{ role: 'user', content: 'hi' }],
    }, false);
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');
  } finally {
    await server.close();
  }

  const failServer = await startServer({ complete: async () => ({ ok: false, error: 'rate-limit', detail: '429' }) });
  try {
    const created = await makeNode(failServer);
    const failed = await postJson(`${failServer.baseUrl}/knowledge/chat`, {
      node: created,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.equal(failedBody.error, 'llm-rate-limit');
    assert.equal(failedBody.detail, '429');

    const emptyServer = await startServer({ complete: async () => ({ ok: true, text: '   ' }) });
    try {
      const nodeId = await makeNode(emptyServer);
      const empty = await postJson(`${emptyServer.baseUrl}/knowledge/chat`, {
        node: nodeId,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(empty.status, 502);
      assert.equal((await empty.json()).error, 'llm-empty-response');
    } finally {
      await emptyServer.close();
    }
  } finally {
    await failServer.close();
  }

  const noLlm = await startServer({});
  try {
    const nodeId = await makeNode(noLlm);
    const unavailable = await postJson(`${noLlm.baseUrl}/knowledge/chat`, {
      node: nodeId,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, 'llm-unavailable');
  } finally {
    await noLlm.close();
  }

});
