/**
 * 右栏「选模型」的钉子和契约（v2-J，2026-11-23，任务卡 ③ D-2 / D-3）。
 *
 * 这张卡给学习助手加了两个最小扩展，测试只钉这两件事：
 *   ① `POST /assistant/reply` 认得可选 `model`：合法值原样进网关调用；
 *      不带 / 非法（非字符串、超长、带空格的脏值）一律回退默认 `group/wb`，**绝不 400**；
 *   ② `GET /assistant/models`：服务端读密钥后转网关 `/models`，只回 id/owned_by；
 *      读不到密钥 / 网关不通 / 返回体不认识 → 200 + 只有一个默认模型的降级结果。
 *
 * 绝不真打网络：整体桩 `deps.assistantChat`，或只换网络层的 `deps.assistantFetch`。
 * 也绝不读真密钥：凭据一律用临时目录里现造的假文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 假密钥塞一个独特前缀，好在响应里做「不含密钥」的断言。 */
const FAKE_KEY = 'sk-magpie-model-test-SECRET-9876543210';
/** 与后端常量口径一致：不带 model 时网关收到的仍是这个名字。 */
const DEFAULT_MODEL = 'group/wb';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-model-');
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

function jsonRequest(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
    body: JSON.stringify(body),
  });
}

/** 造一个只含 MAGPIE 密钥的临时凭据文件（不写进仓库、测完即删）。 */
async function makeCredentialFile() {
  const dir = await makeTempDir('study-assistant-model-cred-');
  const file = path.join(dir, '.credentials.yaml');
  await fs.writeFile(file, `refs:\n  MAGPIE_GATEWAY_KEY: ${FAKE_KEY}\n`, 'utf8');
  return {
    file,
    cleanup: async () => { await removeTempDir(dir); },
  };
}

/**
 * 只实现 callMagpie / models 路由用到的那点 fetch 面：status / ok / json()。
 * `seen` 记录每次请求的 url 与 body，供断言「到底把哪个模型发出去了」。
 */
function makeFetchStub(respond) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    return respond(String(url), init);
  };
  return { fetchImpl, seen };
}

/** OpenAI 形状的回复，够 callMagpie 取 content。 */
function chatOk(content = '这是助手的回答') {
  return {
    status: 200,
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

test('① 带合法 model → 网关调用拿到的就是这个模型（不是默认值）', async () => {
  const seen = [];
  const server = await startServer({
    assistantChat: async (input) => { seen.push(input); return { content: '好' }; },
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '解释一下傅里叶变换' }],
      model: 'workbuddy/glm-5.3',
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.reply, '好');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'workbuddy/glm-5.3', '选中的模型要原样传进通道');
    // 顺带钉住其它参数没被顺手改掉
    assert.equal(seen[0].maxTokens, 2048);
    assert.equal(seen[0].temperature, 0.3);
    assert.deepEqual(seen[0].messages, [{ role: 'user', content: '解释一下傅里叶变换' }]);
  } finally {
    await server.close();
  }
});

test('② 不带 model → 与旧行为逐字一致：真链路请求体里仍是 group/wb', async () => {
  const cred = await makeCredentialFile();
  const stub = makeFetchStub((url) => {
    assert.match(url, /\/chat\/completions$/, '不带 model 时只该打 chat/completions');
    return chatOk('旧行为');
  });
  const server = await startServer({ assistantKeyPath: cred.file, assistantFetch: stub.fetchImpl });
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '你好' }],
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.reply, '旧行为');

    assert.equal(stub.seen.length, 1);
    const body = stub.seen[0].body;
    assert.equal(body.model, DEFAULT_MODEL, '不带 model 必须是默认 group/wb（向后兼容）');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }], '消息数组一字不差');
    assert.match(String(stub.seen[0].headers.Authorization ?? ''), /^Bearer /, '鉴权头照旧');
  } finally {
    await server.close();
    await cred.cleanup();
  }
});

test('③ 非法 model（非字符串 / 超长 / 带空格脏值）→ 回退默认，不 400、不空转', async () => {
  const seen = [];
  const server = await startServer({
    assistantChat: async (input) => { seen.push(input); return { content: '照样答' }; },
  });
  try {
    const cases = [
      { name: '数字', model: 42 },
      { name: '对象', model: { id: 'x' } },
      { name: '空串', model: '   ' },
      { name: '超长', model: `group/wb${'x'.repeat(80)}` },
      { name: '带空格', model: 'group wb' },
      { name: '带换行注入', model: 'group/wb\nX-Injected: 1' },
    ];
    for (const item of cases) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
        messages: [{ role: 'user', content: '问一句' }],
        model: item.model,
      });
      assert.equal(response.status, 200, `${item.name}：不许因为一个可选字段就 400`);
      const result = await response.json();
      assert.equal(result.ok, true, `${item.name}：仍要正常回答`);
    }
    assert.equal(seen.length, cases.length, '每个用例都该真的走一次通道（不静默失败）');
    for (const item of seen) {
      assert.equal(item.model, DEFAULT_MODEL, '非法值一律回退 group/wb');
    }
  } finally {
    await server.close();
  }
});

test('④ GET /assistant/models：正常返回网关清单，默认模型排第一，只回 id/owned_by', async () => {
  const cred = await makeCredentialFile();
  const stub = makeFetchStub((url) => {
    assert.match(url, /\/models$/, '只该打 /models');
    return {
      status: 200,
      ok: true,
      json: async () => ({
        data: [
          { id: 'workbuddy/glm-5.3', owned_by: 'workbuddy', extra: '不该下发' },
          { id: DEFAULT_MODEL, owned_by: 'group' },
          { id: 'antigravity/claude-opus-4-6-thinking', owned_by: 'antigravity' },
        ],
      }),
    };
  });
  const server = await startServer({ assistantKeyPath: cred.file, assistantFetch: stub.fetchImpl });
  try {
    const response = await fetch(`${server.baseUrl}/assistant/models`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.degraded, undefined, '正常路径不该打降级标记');
    assert.deepEqual(result.models.map((item) => item.id), [
      DEFAULT_MODEL,
      'workbuddy/glm-5.3',
      'antigravity/claude-opus-4-6-thinking',
    ], '默认模型要排第一，其余按网关顺序');
    for (const item of result.models) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'owned_by'], '只下 id / owned_by，别把网关的其它字段带出去');
    }
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false, '响应里不许出现密钥');
    assert.equal(stub.seen.length, 1);
    assert.match(String(stub.seen[0].headers.Authorization ?? ''), /^Bearer /, '转发时带上密钥（只在服务端）');
  } finally {
    await server.close();
    await cred.cleanup();
  }
});

test('⑤ GET /assistant/models：读不到密钥 / 网关报错 / 返回体不认识 → 降级成只回默认模型', async () => {
  // (a) 密钥文件不存在
  const missingKey = await startServer({ assistantKeyPath: path.join('C:\\不存在的目录', 'no-credentials.yaml') });
  try {
    const response = await fetch(`${missingKey.baseUrl}/assistant/models`);
    assert.equal(response.status, 200, '降级也要 200，别让右栏下拉空着');
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.models.map((item) => item.id), [DEFAULT_MODEL]);
  } finally {
    await missingKey.close();
  }

  // (b) 网关 500 / (c) 网关返回一个没有模型名的空壳
  const cred = await makeCredentialFile();
  const variants = [
    { name: '网关 500', respond: () => ({ status: 500, ok: false, json: async () => ({ error: 'boom' }) }) },
    { name: '网关抛错', respond: () => { throw new Object({ name: 'TimeoutError' }); } },
    { name: '空壳返回', respond: () => ({ status: 200, ok: true, json: async () => ({ data: [{ nope: 1 }] }) }) },
  ];
  for (const item of variants) {
    const stub = makeFetchStub(item.respond);
    const server = await startServer({ assistantKeyPath: cred.file, assistantFetch: stub.fetchImpl });
    try {
      const response = await fetch(`${server.baseUrl}/assistant/models`);
      const result = await response.json();
      assert.equal(response.status, 200, `${item.name}：降级也是 200`);
      assert.equal(result.ok, true);
      assert.equal(result.degraded, true, `${item.name}：要标出这是降级结果`);
      assert.deepEqual(result.models.map((model) => model.id), [DEFAULT_MODEL], `${item.name}：至少要给默认模型`);
      assert.equal(JSON.stringify(result).includes(FAKE_KEY), false, `${item.name}：响应里不许出现密钥`);
    } finally {
      await server.close();
    }
  }
  await cred.cleanup();
});
