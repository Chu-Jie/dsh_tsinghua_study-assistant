/**
 * `POST /assistant/behavior`（学习行为 · 打开知识点记一次访问）的 HTTP 测试。
 * 运行：npm test
 *
 * 对着任务卡 ⑥「行为路由」与 ⑨「验收」逐条落：
 *   1. `{nodeId}` 写一次：visitCount+1、首次填 firstLearnedAt、下一次 lastLearnedAt 更新；
 *   2. **同一分钟内重复上报只算一次**（后端去重，不靠前端自觉）；
 *   3. 未知 nodeId → 404，且一个字节都不写；
 *   4. `totalMinutes` 本步恒 0（不做假时长）；
 *   5. 写盘走 store（原子写 + 写前备份），落的是 `学习台/学习行为.json`，结构是 `{version,nodes:{…}}`；
 *   6. 顺带推进掌握度，但 **manual 的点绝不动**。
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

/** 可拨的时钟：让「同一分钟」这种断言不靠 sleep。 */
function makeClock(startIso = '2026-11-20T01:05:00.000Z') {
  let at = new Date(startIso).getTime();
  return {
    now: () => new Date(at),
    set(iso) { at = new Date(iso).getTime(); },
    advance(ms) { at += ms; },
  };
}

function knowledgeNode(id, name, mastery, patch = {}) {
  return {
    id,
    name,
    courseId: 'c_phy',
    chapter: '第12章 静电场',
    section: '12.1',
    subsection: '',
    aliases: [],
    mastery,
    marked: false,
    reviewedAt: null,
    note: '',
    evidence: [],
    createdAt: '2026-10-20T14:09:12.982Z',
    ...patch,
  };
}

async function startServer(nodes, options = {}) {
  const dir = await makeTempDir('study-assistant-behavior-');
  const store = createStore(dir);
  await store.init();
  // 种一份知识网络（两三个点就够）
  const seeded = { version: DOC_VERSION, nodes, edges: [], updatedAt: null };
  await store.writeDocument('knowledgeNetwork', seeded);
  const warns = [];
  const clock = options.clock ?? makeClock();
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    now: () => clock.now(),
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
    clock,
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

/** 读回 `学习行为.json`（不存在就 null）。 */
async function readBehaviorFile(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, '学习行为.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 读回 `知识点网络.json`。 */
async function readNetworkFile(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, '知识点网络.json'), 'utf8'));
}

/** 全量快照（含备份目录）：用来断言「这次一个字节都没写」。 */
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

test('POST /assistant/behavior：缺安全请求头 / 跨站 → 403，且不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);

    const noHeader = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' }, { withHeader: false });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');

    const crossSite = await jsonRequest(
      `${server.baseUrl}/assistant/behavior`,
      { nodeId: 'k_a' },
      { extraHeaders: { 'sec-fetch-site': 'cross-site' } },
    );
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error, 'cross-site-rejected');

    assert.deepEqual(await snapshotDir(server.dir), before, '前置校验没过就绝不许写盘');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：入参不合法 → 400，且不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);
    const cases = [
      { name: '非对象', body: [], error: 'bad-payload' },
      { name: '缺 nodeId', body: {}, error: 'bad-node-id' },
      { name: 'nodeId 非字符串', body: { nodeId: 42 }, error: 'bad-node-id' },
      { name: 'nodeId 带空格', body: { nodeId: 'k a' }, error: 'bad-node-id' },
      { name: 'nodeId 太长', body: { nodeId: 'k'.repeat(65) }, error: 'bad-node-id' },
      { name: 'nodeId 试图穿越', body: { nodeId: '../../etc/passwd' }, error: 'bad-node-id' },
    ];
    for (const item of cases) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/behavior`, item.body);
      assert.equal(response.status, 400, `${item.name}：状态码`);
      const result = await response.json();
      assert.equal(result.ok, false, `${item.name}：ok:false`);
      assert.equal(result.error, item.error, `${item.name}：错误码`);
    }
    assert.deepEqual(await snapshotDir(server.dir), before, '参数错时一个字节都不写');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：未知 nodeId → 404，且不写盘（不静默忽略）', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);
    const response = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_not_exist' });
    assert.equal(response.status, 404);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown-node');
    assert.deepEqual(await snapshotDir(server.dir), before, '未知节点不许留下半截记录');
    // store.init() 会把 16 份主文档都补成默认空壳，所以文件本来就在；关键是**里面没有任何记录**
    const doc = await readBehaviorFile(server.dir);
    assert.deepEqual(doc.nodes, {}, '未知节点不许在 nodes 里留半截记录');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：首次访问 → 写入学习行为.json（visitCount 1），并推进掌握度 0→1', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.counted, true);
    assert.equal(result.visitCount, 1);
    assert.equal(result.firstLearnedAt, '2026-11-20T01:05:00.000Z');
    assert.equal(result.lastLearnedAt, '2026-11-20T01:05:00.000Z');
    assert.equal(result.totalMinutes, 0, '本步不测停留时长，恒 0');
    assert.deepEqual(result.mastery, { from: 0, to: 1, changed: true }, '打开过 = 学过（访问 +1）');

    const doc = await readBehaviorFile(server.dir);
    assert.equal(doc.version, DOC_VERSION);
    assert.equal(typeof doc.nodes, 'object');
    assert.equal(Array.isArray(doc.nodes), false, 'nodes 是对象 map，不是数组');
    assert.deepEqual(Object.keys(doc.nodes), ['k_a']);
    assert.deepEqual(doc.nodes.k_a, {
      firstLearnedAt: '2026-11-20T01:05:00.000Z',
      lastLearnedAt: '2026-11-20T01:05:00.000Z',
      visitCount: 1,
      totalMinutes: 0,
      masterySource: 'auto',
      masteryUpdatedAt: null,
    });
    assert.equal(typeof doc.updatedAt, 'string', 'store 落盘时会补 updatedAt');

    const network = await readNetworkFile(server.dir);
    assert.equal(network.nodes.find((item) => item.id === 'k_a').mastery, 1, '等级写回知识点网络.mastery');
    assert.equal(network.nodes.find((item) => item.id === 'k_a').reviewedAt, '2026-11-20T01:05:00.000Z', '变了才刷 reviewedAt');
    assert.equal(result.mastery.changed, true);
    // 备份目录里应当留下旧版知识网络（store 的既有范式）
    const backups = await fs.readdir(path.join(server.dir, '备份'));
    assert.ok(backups.some((name) => name.startsWith('知识点网络.json.')), '写前自动进备份');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：同一分钟内重复打开只算一次（连盘都不写）', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    const before = await snapshotDir(server.dir);

    server.clock.set('2026-11-20T01:05:40.000Z'); // 同一分钟
    const again = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    assert.equal(again.status, 200);
    const result = await again.json();
    assert.equal(result.counted, false);
    assert.equal(result.reason, 'same-minute');
    assert.equal(result.visitCount, 1, '次数不涨');
    assert.equal(result.lastLearnedAt, '2026-11-20T01:05:00.000Z', '时间也不动');
    assert.deepEqual(result.mastery, { from: 1, to: 1, changed: false });

    assert.deepEqual(await snapshotDir(server.dir), before, '去重命中时一个字节都不写（不白留备份）');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：跨分钟再打开 → visitCount 2，首次时间不变', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    server.clock.set('2026-11-20T01:07:00.000Z');
    const response = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    const result = await response.json();
    assert.equal(result.counted, true);
    assert.equal(result.visitCount, 2);
    assert.equal(result.firstLearnedAt, '2026-11-20T01:05:00.000Z');
    assert.equal(result.lastLearnedAt, '2026-11-20T01:07:00.000Z');
    assert.deepEqual(result.mastery, { from: 1, to: 1, changed: false }, '已经 1 档，再访问不重复加');

    const doc = await readBehaviorFile(server.dir);
    assert.equal(doc.nodes.k_a.visitCount, 2);
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：有 learned 批注的点 → 访问一次就推到 2（访问 +1、批注 +1）', async () => {
  const server = await startServer([knowledgeNode('k_339c6529a0', '电荷', 0, { chapter: '第12章 静电场' })]);
  try {
    // 造一条 kp:<nodeId> + learned 的批注（与真实数据形态一致）
    await fs.writeFile(path.join(server.dir, '批注.json'), `${JSON.stringify({
      version: DOC_VERSION,
      notes: [{
        id: 'a_1',
        type: 'note',
        file: 'kp:k_339c6529a0',
        content: '',
        page: null,
        anchor: { quote: '电荷', start: 0, end: 2, prefix: '', suffix: '' },
        markKind: 'learned',
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      }],
      updatedAt: null,
    }, null, 2)}\n`, 'utf8');

    const response = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_339c6529a0' });
    const result = await response.json();
    assert.equal(result.mastery.to, 2, '打开过 + 有 learned 批注 = 2');
    assert.equal(result.mastery.changed, true);
    const network = await readNetworkFile(server.dir);
    assert.equal(network.nodes.find((item) => item.id === 'k_339c6529a0').mastery, 2);
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：manual 的点只记行为，等级一个字节不动', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    // 先经写路由把它标成 manual（用户手动定在 0 档）
    const confirmed = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 0, confirm: true });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).changed, false);

    const before = await snapshotDir(server.dir);
    const visited = await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    const result = await visited.json();
    assert.deepEqual(result.mastery, { from: 0, to: 0, changed: false }, 'manual 的点算法绝不覆盖');

    const network = await readNetworkFile(server.dir);
    assert.equal(network.nodes[0].mastery, 0, '等级仍然是 0');
    const doc = await readBehaviorFile(server.dir);
    assert.equal(doc.nodes.k_a.visitCount, 1, '但访问次数照记');
    assert.equal(doc.nodes.k_a.masterySource, 'manual', '来源仍是 manual');

    const after = await snapshotDir(server.dir);
    const onlyBehavior = after.filter(([name]) => name !== '学习行为.json' && !name.startsWith('备份/学习行为.json.'));
    const beforeOnlyBehavior = before.filter(([name]) => name !== '学习行为.json' && !name.startsWith('备份/学习行为.json.'));
    assert.deepEqual(onlyBehavior, beforeOnlyBehavior, '行为以外的文件一个都不许变（知识网络没被重写）');
  } finally {
    await server.close();
  }
});

test('POST /assistant/behavior：知识网络损坏 → 409，不写行为文件', async () => {
  const dir = await makeTempDir('study-assistant-behavior-corrupt-');
  const store = createStore(dir);
  await store.init();
  await fs.writeFile(path.join(dir, '知识点网络.json'), '{ 这不是 JSON ', 'utf8');
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {}, info() {}, warn() {} } });
  const server = http.createServer((req, res) => handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await jsonRequest(`http://127.0.0.1:${port}${API_PREFIX}/assistant/behavior`, { nodeId: 'k_a' });
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.match(String(result.error), /^corrupt/, '坏文件拒绝继续写，不回落成空数据');
    assert.deepEqual((await readBehaviorFile(dir)).nodes, {}, '不写任何记录');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});
