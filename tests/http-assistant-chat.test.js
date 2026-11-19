/**
 * `POST /assistant/reply`（学习助手浮层 MVP）的 HTTP 与通道测试。
 * 运行：npm test
 *
 * 六条硬要求（对着任务卡第 ⑨ 节逐条落）：
 *   1. **绝不真打网络**：整体桩 `deps.assistantChat` 或只换网络层的 `deps.assistantFetch`，
 *      默认的 magpie 通道在这份测试里一次都不会被真的调用。
 *   2. **密钥不泄露**：从临时凭据文件读出来的假密钥，不能出现在响应、日志、detail 里。
 *   3. **MVP 不落盘**：每个成功用例前后对数据目录做全量快照，必须一字不差、不多一个文件。
 *   4. **预留字段只收不用**：`conversationId` / `persist` 带着也照常工作，但不产生任何文件。
 *   5. **参数错误一律 400 `bad-request`**，且**不调用通道**（别让一次错参数白花额度）。
 *   6. **通道失败一律 502 `assistant-unavailable`**，detail 只留错误类型 / HTTP 码，
 *      不含用户原文全文。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, callMagpie, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 假密钥里塞一个足够独特的前缀，好在响应/日志里做「不含密钥」的断言。 */
const FAKE_KEY = 'sk-magpie-test-SECRET-abcdef1234567890';
/** 用户原文里放一个记号，用来断言 detail 不回传原文。 */
const USER_MARKER = '用户原文记号-ASSISTANT-7f3c';
const USER_TEXT = `请解释一下这个定理：${USER_MARKER}`;

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-chat-');
  const store = createStore(dir);
  await store.init();
  const warns = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: {
      error() {},
      info() {},
      warn(...args) { warns.push(args.map((item) => String(item)).join(' ')); },
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
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
  return fetch(url, {
    method: 'POST',
    headers,
    body: typeof options.rawBody === 'string' ? options.rawBody : JSON.stringify(body),
  });
}

/**
 * 数据目录全量快照：`[[相对路径, 文件内容]]`，按路径排序。
 *
 * 用它断言「接口一个字节都不写」——只比文件名不够（覆盖写同名文件也躲得过去）。
 */
async function snapshotDir(root) {
  const entries = [];
  async function walk(dir, prefix) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        await walk(path.join(dir, item.name), rel);
      } else {
        entries.push([rel, await fs.readFile(path.join(dir, item.name), 'utf8')]);
      }
    }
  }
  await walk(root, '');
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

/** 造一个只含 MAGPIE 密钥的临时凭据文件（不写进仓库、测完即删）。 */
async function makeCredentialFile(key = FAKE_KEY) {
  const dir = await makeTempDir('study-assistant-cred-');
  const file = path.join(dir, '.credentials.yaml');
  await fs.writeFile(file, `refs:\n  MAGPIE_GATEWAY_KEY: ${key}\n`, 'utf8');
  return {
    file,
    cleanup: async () => { await removeTempDir(dir); },
  };
}

/** 一个够用的 fetch 桩：只实现 callMagpie 用到的 status / ok / json()。 */
function fetchResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')),
  };
}

test('POST /assistant/reply：缺安全请求头 / 跨站来源 → 403，且不调用通道', async () => {
  let called = 0;
  const server = await startServer({
    assistantChat: async () => { called += 1; return { content: '不该走到这里' }; },
  });
  try {
    const noHeader = await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages: [{ role: 'user', content: '你好' }] }, { withHeader: false });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');

    const crossSite = await jsonRequest(
      `${server.baseUrl}/assistant/reply`,
      { messages: [{ role: 'user', content: '你好' }] },
      { extraHeaders: { 'sec-fetch-site': 'cross-site' } },
    );
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error, 'cross-site-rejected');

    assert.equal(called, 0, '前置校验没过就绝不许花额度');
  } finally {
    await server.close();
  }
});

test('POST /assistant/reply：参数不合法一律 400 bad-request，且不调用通道', async () => {
  let called = 0;
  const server = await startServer({
    assistantChat: async () => { called += 1; return { content: '不该走到这里' }; },
  });
  try {
    const cases = [
      { name: '非对象', body: [] },
      { name: '缺 messages', body: {} },
      { name: 'messages 空', body: { messages: [] } },
      { name: 'messages 非数组', body: { messages: '你好' } },
      { name: '消息非对象', body: { messages: ['你好'] } },
      { name: 'role 非法', body: { messages: [{ role: 'tool', content: '你好' }] } },
      { name: 'role 缺失', body: { messages: [{ content: '你好' }] } },
      { name: 'content 空串', body: { messages: [{ role: 'user', content: '   ' }] } },
      { name: 'content 非字符串', body: { messages: [{ role: 'user', content: 42 }] } },
      { name: '末条不是 user', body: { messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }] } },
      { name: '消息过多', body: { messages: Array.from({ length: 41 }, () => ({ role: 'user', content: '问' })) } },
      { name: '单条过长', body: { messages: [{ role: 'user', content: 'x'.repeat(20001) }] } },
      {
        name: '整段过长',
        body: { messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'y'.repeat(17000) })) },
      },
      { name: 'maxTokens 非整数', body: { messages: [{ role: 'user', content: '问' }], maxTokens: 1.5 } },
      { name: 'maxTokens 越界', body: { messages: [{ role: 'user', content: '问' }], maxTokens: 999999 } },
      { name: 'conversationId 类型错', body: { messages: [{ role: 'user', content: '问' }], conversationId: 123 } },
      { name: 'persist 类型错', body: { messages: [{ role: 'user', content: '问' }], persist: 'yes' } },
    ];
    for (const item of cases) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, item.body);
      assert.equal(response.status, 400, `${item.name}：状态码`);
      const result = await response.json();
      assert.equal(result.ok, false, `${item.name}：必须 ok:false`);
      assert.equal(result.error, 'bad-request', `${item.name}：错误码`);
      assert.equal(typeof result.detail, 'string', `${item.name}：要说清哪一条不合法`);
      assert.ok(result.detail !== '', `${item.name}：detail 不能为空`);
    }

    // 非法 JSON 走框架层的 bad-json（同样是 400，但不是参数语义）
    const badJson = await jsonRequest(`${server.baseUrl}/assistant/reply`, null, { rawBody: '{"messages":[' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'bad-json');

    assert.equal(called, 0, '参数错时一次通道都不能调');
  } finally {
    await server.close();
  }
});

test('POST /assistant/reply：正常多轮 → 200 reply，整段历史原样转发，且不落盘', async () => {
  const seen = [];
  const server = await startServer({
    assistantChat: async (input) => {
      seen.push(input);
      return { content: '这是助手的回答', attempts: [{ attempt: 1, status: 200 }] };
    },
  });
  try {
    const before = await snapshotDir(server.dir);
    const messages = [
      { role: 'user', content: '第一问', id: '多余字段不该被转发' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ];
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.reply, '这是助手的回答');
    assert.equal(result.conversationId, undefined, 'MVP 不回传也不生成 conversationId');

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].messages, [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ], '只转发 role/content，多余字段不许带到网关');
    assert.equal(seen[0].maxTokens, 2048, 'maxTokens 缺省 2048');
    assert.equal(seen[0].temperature, 0.3);

    const after = await snapshotDir(server.dir);
    assert.deepEqual(after, before, '接口不许写盘（文件集合与内容都必须一字不差）');
  } finally {
    await server.close();
  }
});

test('POST /assistant/reply：conversationId / persist 带着也照常工作，但不产生任何文件', async () => {
  const server = await startServer({
    assistantChat: async () => ({ content: '收到' }),
  });
  try {
    const before = await snapshotDir(server.dir);
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '你好' }],
      conversationId: 'conv-abc-123',
      persist: true,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.reply, '收到');

    const after = await snapshotDir(server.dir);
    assert.deepEqual(after, before, 'persist:true 这一版也不落盘');
    assert.equal(after.some(([name]) => /assistant|conversation|chat/i.test(name)), false, '不许出现聊天记录文件');
  } finally {
    await server.close();
  }
});

test('POST /assistant/reply：读不到密钥 → 503 assistant-key-missing，响应不含密钥', async () => {
  const server = await startServer({
    // 指到一个不存在的凭据文件：走真实的 readMagpieKey 分支，但绝不读真密钥
    assistantKeyPath: path.join('C:\\不存在的目录', 'no-credentials.yaml'),
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: USER_TEXT }],
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'assistant-key-missing');
    const text = JSON.stringify(result);
    assert.match(text, /MAGPIE_GATEWAY_KEY/, '要告诉用户缺的是哪个键');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8}/, '响应里不能出现密钥本体');
    assert.equal(text.includes(USER_MARKER), false, '失败响应不许回传用户原文');
  } finally {
    await server.close();
  }
});

test('POST /assistant/reply：凭据里没有那一行 → 503（不把别的键当成 magpie key）', async () => {
  const cred = await makeCredentialFile('sk-some-other-key-999999');
  const file = path.join(path.dirname(cred.file), 'without-magpie.yaml');
  await fs.writeFile(file, 'refs:\n  PARATERA_API_KEY: sk-other-999999\n', 'utf8');
  const server = await startServer({ assistantKeyPath: file });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '你好' }],
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error, 'assistant-key-missing');
    assert.equal(JSON.stringify(result).includes('sk-other-999999'), false, '别的键的值也不许回显');
  } finally {
    await server.close();
    await cred.cleanup();
  }
});

test('POST /assistant/reply：通道抛错 / 返回失败 / 空内容 → 502，detail 不含原文与密钥', async () => {
  const variants = [
    {
      name: '桩抛错',
      chat: async () => { throw new Object({ name: 'TimeoutError' }); },
      expectDetail: '通道没通',
    },
    {
      name: '通道返回 ok:false',
      chat: async () => ({ ok: false, error: 'assistant-unavailable', detail: 'HTTP 500' }),
      expectDetail: 'HTTP 500',
    },
    {
      name: '模型空内容',
      chat: async () => ({ ok: false, error: 'assistant-bad-output', detail: '模型返回空内容' }),
      expectDetail: '空内容',
    },
    {
      name: '返回空字符串',
      chat: async () => ({ content: '   ' }),
      expectDetail: '空内容',
    },
  ];
  for (const item of variants) {
    const server = await startServer({ assistantChat: item.chat });
    try {
      const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
        messages: [{ role: 'user', content: USER_TEXT }],
      });
      assert.equal(response.status, 502, `${item.name}：状态码`);
      const result = await response.json();
      assert.equal(result.ok, false, `${item.name}：必须 ok:false`);
      assert.equal(result.error, 'assistant-unavailable', `${item.name}：错误码`);
      assert.ok(result.detail.includes(item.expectDetail), `${item.name}：detail 要说明是哪一类失败`);
      assert.equal(result.detail.includes(USER_MARKER), false, `${item.name}：detail 不许回传用户原文`);
      assert.doesNotMatch(JSON.stringify(result), /sk-[A-Za-z0-9]{8}/, `${item.name}：响应不许出现密钥`);
      assert.equal(result.reply, undefined, `${item.name}：失败时不许给 reply（前端不会拿到半截回答）`);
    } finally {
      await server.close();
    }
  }
});

test('POST /assistant/reply：真链路（假凭据 + fetch 桩）→ 200，密钥只用于 Authorization，不进响应/日志', async () => {
  const cred = await makeCredentialFile();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      auth: init?.headers?.Authorization,
      body: JSON.parse(init?.body ?? '{}'),
    });
    return fetchResponse(200, {
      choices: [{ message: { role: 'assistant', content: '网关的回答' } }],
    });
  };
  const server = await startServer({ assistantKeyPath: cred.file, assistantFetch: fetchImpl });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: USER_TEXT }],
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.reply, '网关的回答');

    assert.equal(calls.length, 1, '一次成功只需要打一次网关');
    assert.match(calls[0].url, /\/chat\/completions$/, '地址要以 /chat/completions 结尾');
    assert.equal(calls[0].auth, `Bearer ${FAKE_KEY}`, '密钥只走 Authorization 头');
    assert.equal(calls[0].body.model, 'group/wb', '缺省模型必须是 group/wb');
    assert.equal(calls[0].body.max_tokens, 2048, 'max_tokens 缺省 2048（给少了 reasoning 会吃光预算）');
    assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: USER_TEXT }]);

    const responseText = JSON.stringify(result);
    assert.equal(responseText.includes(FAKE_KEY), false, '响应里不许出现密钥');
    assert.equal(server.warns.join('\n').includes(FAKE_KEY), false, '日志里不许出现密钥');
    assert.equal(server.warns.join('\n').includes(USER_MARKER), false, '日志里不许出现用户原文');
  } finally {
    await server.close();
    await cred.cleanup();
  }
});

test('POST /assistant/reply：maxTokens 可由前端覆盖，覆盖值要真的传进网关', async () => {
  const cred = await makeCredentialFile();
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init?.body ?? '{}');
    return fetchResponse(200, { choices: [{ message: { content: '短回答' } }] });
  };
  const server = await startServer({ assistantKeyPath: cred.file, assistantFetch: fetchImpl });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '来个长一点的回答' }],
      maxTokens: 512,
    });
    assert.equal(response.status, 200);
    assert.equal(sentBody.max_tokens, 512);
  } finally {
    await server.close();
    await cred.cleanup();
  }
});

test('callMagpie：429/5xx 退避重试，第二次成功就返回；attempts 记录完整', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) return fetchResponse(503, '');
    return fetchResponse(200, { choices: [{ message: { content: '重试后的回答' } }] });
  };
  const result = await callMagpie({
    key: FAKE_KEY,
    messages: [{ role: 'user', content: '你好' }],
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, '重试后的回答');
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((item) => item.status), [503, 200]);
});

test('callMagpie：4xx 直接失败（不重试），detail 只留 HTTP 码，不回传上游响应体', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fetchResponse(401, `invalid key ${FAKE_KEY} ${USER_MARKER}`);
  };
  const result = await callMagpie({
    key: FAKE_KEY,
    messages: [{ role: 'user', content: USER_TEXT }],
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'assistant-rejected');
  assert.equal(result.detail, 'HTTP 401');
  assert.equal(calls, 1, '鉴权错重试也没用');
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(result).includes(USER_MARKER), false);
});

test('callMagpie：content 为 null 时回退取 reasoning_content；两者都空才判 bad-output', async () => {
  const reasoningOnly = await callMagpie({
    key: FAKE_KEY,
    messages: [{ role: 'user', content: '你好' }],
    fetchImpl: async () => fetchResponse(200, {
      choices: [{ message: { content: null, reasoning_content: '思考段里的答案' } }],
    }),
    retryDelayMs: 0,
  });
  assert.equal(reasoningOnly.ok, true);
  assert.equal(reasoningOnly.content, '思考段里的答案');

  let calls = 0;
  const empty = await callMagpie({
    key: FAKE_KEY,
    messages: [{ role: 'user', content: '你好' }],
    fetchImpl: async () => {
      calls += 1;
      return fetchResponse(200, { choices: [{ message: { content: null, reasoning_content: '' } }] });
    },
    retryDelayMs: 0,
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'assistant-bad-output');
  assert.equal(empty.detail, '模型返回空内容');
  assert.equal(calls, 3, '空回要按次数重试完再认输');
});

test('callMagpie：超时按 assistant-timeout 记，detail 不含密钥', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  const result = await callMagpie({
    key: FAKE_KEY,
    messages: [{ role: 'user', content: '你好' }],
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'assistant-timeout');
  assert.equal(result.detail, '请求超时');
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});
