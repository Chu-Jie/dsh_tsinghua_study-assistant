/**
 * 「经聊天改掌握度」的两步走：`POST /assistant/reply`（只预览）+ `POST /assistant/mastery`（才落库）。
 * 运行：npm test
 *
 * 本卡最易违规的一处就在这里，所以测试按「红线」写而不是按「功能」写：
 *   1. **预览与落库必须分开两次请求**：`/assistant/reply` 命中意图时**一个字节都不写**；
 *   2. **没有 `confirm: true` 的直接调用一律 400，绝不落库**；
 *   3. 落库时等级回 `知识点网络.mastery`、`reviewedAt` 按「变了才刷」的口径、
 *      `学习行为.json` 记 `masterySource: 'manual'`（从此算法跳过）；
 *   4. 同档不写网络、幂等；越界/未知节点各自拒。
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

function makeClock(startIso = '2026-11-20T03:00:00.000Z') {
  let at = new Date(startIso).getTime();
  return {
    now: () => new Date(at),
    set(iso) { at = new Date(iso).getTime(); },
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
    evidence: [{ type: 'page', file: '物理/教材/大学物理学下.pdf', page: 22 }],
    createdAt: '2026-10-20T14:09:12.982Z',
    ...patch,
  };
}

async function startServer(nodes, options = {}) {
  const dir = await makeTempDir('study-assistant-mastery-');
  const store = createStore(dir);
  await store.init();
  await store.writeDocument('knowledgeNetwork', { version: DOC_VERSION, nodes, edges: [], updatedAt: null });
  const warns = [];
  const clock = options.clock ?? makeClock();
  const calls = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    now: () => clock.now(),
    // 默认给一个模型桩：断言「不是命令的句子照常走模型」，且绝不打真网络
    assistantChat: async (input) => {
      calls.push(input);
      return { content: '（模型回答）' };
    },
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
    calls,
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

async function readNetworkFile(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, '知识点网络.json'), 'utf8'));
}

async function readBehaviorFile(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, '学习行为.json'), 'utf8'));
}

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

test('POST /assistant/mastery：不带 confirm:true → 400 confirm-required，且一个字节都不写', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1)]);
  try {
    const before = await snapshotDir(server.dir);
    for (const body of [
      { nodeId: 'k_a', mastery: 3 },
      { nodeId: 'k_a', mastery: 3, confirm: 'true' },
      { nodeId: 'k_a', mastery: 3, confirm: 1 },
    ]) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/mastery`, body);
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.equal(result.ok, false);
      assert.equal(result.error, 'confirm-required', '写操作必须显式二次确认');
      assert.match(result.detail, /确认/, '要告诉前端这是两步走');
    }
    assert.deepEqual(await snapshotDir(server.dir), before, '预览阶段绝不许落库');
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery：越界/非法 mastery → 400，且不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1)]);
  try {
    const before = await snapshotDir(server.dir);
    for (const mastery of [4, -1, 1.5, '3', null, undefined]) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery, confirm: true });
      assert.equal(response.status, 400, `mastery=${String(mastery)}`);
      const result = await response.json();
      assert.equal(result.error, 'bad-mastery');
    }
    assert.deepEqual(await snapshotDir(server.dir), before, '被拒的请求一个字节都不写');
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery：未知节点 / 缺 nodeId → 404 / 400，且不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1)]);
  try {
    const before = await snapshotDir(server.dir);
    const unknown = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_zzz', mastery: 3, confirm: true });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown-node');

    const noId = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { mastery: 3, confirm: true });
    assert.equal(noId.status, 400);
    assert.equal((await noId.json()).error, 'bad-node-id');

    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery：正常落库 → 网络 mastery 改、reviewedAt 刷、学习行为记 manual', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1)]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 3, confirm: true });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.nodeName, '电偶极子');
    assert.equal(result.from, 1);
    assert.equal(result.to, 3);
    assert.equal(result.changed, true);
    assert.equal(result.masterySource, 'manual');

    const network = await readNetworkFile(server.dir);
    const node = network.nodes.find((item) => item.id === 'k_a');
    assert.equal(node.mastery, 3, '等级写回知识点网络.mastery（唯一真源）');
    assert.equal(node.reviewedAt, '2026-11-20T03:00:00.000Z', '变了才刷 reviewedAt（与面板同一口径）');
    assert.deepEqual(node.evidence, [{ type: 'page', file: '物理/教材/大学物理学下.pdf', page: 22 }], 'evidence 原样不动');
    assert.equal(node.name, '电偶极子', '其余字段原样继承');
    assert.equal(node.chapter, '第12章 静电场');

    const behavior = await readBehaviorFile(server.dir);
    assert.equal(behavior.nodes.k_a.masterySource, 'manual', '从此算法跳过这个点');
    assert.equal(behavior.nodes.k_a.masteryUpdatedAt, '2026-11-20T03:00:00.000Z');
    assert.equal(behavior.nodes.k_a.visitCount, 0, '没访问过就是 0，不编行为');
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery：同档（1→1）→ 不动网络、不刷 reviewedAt，但仍记 manual 且幂等', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1, { reviewedAt: '2026-10-01T00:00:00.000Z' })]);
  try {
    const networkBefore = await readNetworkFile(server.dir);
    const first = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 1, confirm: true });
    const result = await first.json();
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.masterySource, 'manual', '「人明确说了它是这一档」也要留下');

    const networkAfter = await readNetworkFile(server.dir);
    assert.deepEqual(networkAfter, networkBefore, '同档不写网络：连 updatedAt 都不变');

    // 幂等：再来一次，结果一致、不炸
    const second = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 1, confirm: true });
    assert.equal(second.status, 200);
    const again = await second.json();
    assert.equal(again.changed, false);
    assert.equal((await readNetworkFile(server.dir)).nodes[0].reviewedAt, '2026-10-01T00:00:00.000Z');
  } finally {
    await server.close();
  }
});

test('两步不可并：/assistant/reply 只回预览、不写盘；confirm 后才落库', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);

    const preview = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把电偶极子设为精通' }],
    });
    assert.equal(preview.status, 200);
    const previewResult = await preview.json();
    assert.equal(previewResult.ok, true);
    assert.equal(previewResult.reply, '将把「电偶极子」掌握度从 0（未学）改为 3（精通），确认吗？（还没改：点下面的「确认修改」才落库。）');
    assert.deepEqual(previewResult.proposedAction, {
      kind: 'set-mastery',
      nodeId: 'k_a',
      nodeName: '电偶极子',
      from: 0,
      to: 3,
      fromLabel: '未学',
      toLabel: '精通',
    });
    assert.deepEqual(await snapshotDir(server.dir), before, '预览阶段一个字节都不许写（红线）');
    assert.equal(server.calls.length, 0, '命中意图时不调模型（避免模型嘴上答应）');

    // 用户点「确认修改」→ 才发第二次请求
    const confirmed = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 3, confirm: true });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).changed, true);
    assert.equal((await readNetworkFile(server.dir)).nodes[0].mastery, 3);
  } finally {
    await server.close();
  }
});

test('预览：同名多义 → 列候选、不给 proposedAction；没点名 → 提示说清一点', async () => {
  const server = await startServer([
    knowledgeNode('k_a', '电荷', 0, { chapter: '第12章 静电场' }),
    knowledgeNode('k_b', '电荷', 0, { chapter: '第13章 电势' }),
  ]);
  try {
    const ambiguous = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把电荷设为熟练' }],
    });
    const result = await ambiguous.json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction, undefined, '多义时绝不猜一个去改');
    assert.match(result.reply, /第12章 静电场/);
    assert.match(result.reply, /第13章 电势/);
  } finally {
    await server.close();
  }
});

test('预览：名字对不上 → 无 proposedAction；提问句 → 照常走模型', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const noNode = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把它设为精通' }],
    });
    const result = await noNode.json();
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /没在知识点网络里找到/);
    assert.equal(server.calls.length, 0);

    // 「怎么才能学到精通」是提问，不是命令 → 交给模型
    const question = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '电偶极子怎么才能学到精通？' }],
    });
    const answer = await question.json();
    assert.equal(answer.ok, true);
    assert.equal(answer.reply, '（模型回答）');
    assert.equal(answer.proposedAction, undefined);
    assert.equal(server.calls.length, 1, '提问该走模型');
  } finally {
    await server.close();
  }
});

test('预览：没点名时用界面上下文里的当前选中点（v2-A context）', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1)]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把这个改成熟练' }],
      context: { tab: 'knowledge', nodeId: 'k_a', nodeTitle: '电偶极子' },
    });
    const result = await response.json();
    assert.equal(result.proposedAction?.nodeId, 'k_a');
    assert.equal(result.proposedAction?.from, 1);
    assert.equal(result.proposedAction?.to, 2);
  } finally {
    await server.close();
  }
});

test('学习行为.json 不进 /assistant/reply 的响应、也不进日志', async () => {
  const server = await startServer([
    knowledgeNode('k_a', '电偶极子', 0, { evidence: [{ type: 'lecture', file: '物理/讲义/第12章.md' }] }),
  ]);
  try {
    // 先制造一条行为（含 visitCount 等字段）
    await jsonRequest(`${server.baseUrl}/assistant/behavior`, { nodeId: 'k_a' });
    const behavior = await readBehaviorFile(server.dir);
    assert.equal(behavior.nodes.k_a.visitCount, 1);

    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把电偶极子改成 2' }],
    });
    const result = await response.json();
    const text = JSON.stringify(result);
    assert.equal(text.includes('visitCount'), false, '答疑响应里不许夹带行为记录');
    assert.equal(text.includes('firstLearnedAt'), false);
    assert.equal(text.includes('masterySource'), false);
    assert.equal(server.warns.join('\n').includes('visitCount'), false, '日志里也不许出现行为内容');
  } finally {
    await server.close();
  }
});

test('plugin 卸载/未装时前端拿到的错误码可读：mastery 路由的错误码都在中文映射里', async () => {
  // 这里只钉「错误码是稳定的字符串」，前端的文案表按这些码来翻（见 client.full.js 的 assistantFailureText）
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const noHeader = await jsonRequest(`${server.baseUrl}/assistant/mastery`, { nodeId: 'k_a', mastery: 3, confirm: true }, { withHeader: false });
    assert.equal((await noHeader.json()).error, 'need-request-header');
    const crossSite = await jsonRequest(
      `${server.baseUrl}/assistant/mastery`,
      { nodeId: 'k_a', mastery: 3, confirm: true },
      { extraHeaders: { 'sec-fetch-site': 'cross-site' } },
    );
    assert.equal((await crossSite.json()).error, 'cross-site-rejected');
  } finally {
    await server.close();
  }
});
