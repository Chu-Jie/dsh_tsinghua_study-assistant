/**
 * v2-B2（2026-11-21）：「同理」继承 + 范围批量改掌握度。
 * 运行：npm test
 *
 * 与 `http-assistant-mastery.test.js` 一样按**红线**写，不按功能写：
 *   1. 「同理」= **继承**上一条命令（后端回看 messages），它自己不含等级、不含目标；
 *   2. 批量预览同样**一个字节都不写**，落库只能走 `POST /assistant/mastery-batch` 且必须 `confirm:true`；
 *   3. 「今天」按**本地时区**截日期（UTC 截断会在晚上跨日时算错）；
 *   4. 批量里已是目标等级的跳过、未知 id / 越界等级只算那一条失败（成功 M / 失败 K 如实回）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { DOC_VERSION } from '../lib/core.js';
import {
  buildMasteryBatchPlan,
  localDateKey,
  looksLikeInheritCommand,
  looksLikeMasteryBatchCommand,
  parseMasteryBatchScope,
  resolveInheritedCommand,
} from '../lib/mastery.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');

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

/** 一条学习行为（六个字段，与 `学习行为.json` 的白名单一致）。 */
function behaviorRecord(patch = {}) {
  return {
    firstLearnedAt: null,
    lastLearnedAt: null,
    visitCount: 1,
    totalMinutes: 0,
    masterySource: 'auto',
    masteryUpdatedAt: null,
    ...patch,
  };
}

const COURSES = [
  { id: 'c_phy', name: '大学物理B(2)', shortName: '' },
  { id: 'c_ds', name: '数据结构', shortName: '' },
  { id: 'c_digital', name: '数字电子技术基础', shortName: '' },
];

async function startServer(nodes, options = {}) {
  const dir = await makeTempDir('study-assistant-mastery-batch-');
  const store = createStore(dir);
  await store.init();
  await store.writeDocument('knowledgeNetwork', { version: DOC_VERSION, nodes, edges: [], updatedAt: null });
  if (options.behavior !== undefined) {
    await store.writeDocument('learningBehavior', {
      version: DOC_VERSION,
      nodes: options.behavior,
      updatedAt: null,
    });
  }
  if (options.courses !== false) {
    await store.writeDocument('courses', { version: DOC_VERSION, courses: options.courses ?? COURSES, updatedAt: null });
  }
  const warns = [];
  const clock = options.clock ?? makeClock();
  const calls = [];
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    now: () => clock.now(),
    timeZone: options.timeZone,
    // 模型桩：用来断言「命令不调模型、闲聊才调」
    assistantChat: async (input) => {
      calls.push(input);
      return { content: '（模型回答）' };
    },
    logger: {
      error() {},
      info() {},
      warn(...args) { warns.push(args.map((item) => String(item)).join(' ')); },
    },
    ...options.extraDeps,
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
  return JSON.parse(await fsp.readFile(path.join(dir, '知识点网络.json'), 'utf8'));
}

async function readBehaviorFile(dir) {
  return JSON.parse(await fsp.readFile(path.join(dir, '学习行为.json'), 'utf8'));
}

async function snapshotDir(root) {
  const entries = [];
  async function walk(dir, prefix) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
      else entries.push([rel, await fsp.readFile(path.join(dir, item.name), 'utf8')]);
    }
  }
  await walk(root, '');
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

// ---------------------------------------------------------------------------
// 纯函数：触发词与本地时区
// ---------------------------------------------------------------------------

test('「同理」只认整句：同理。算，同理心是什么意思 / 同理，第 3 章讲什么 都不算', () => {
  assert.equal(looksLikeInheritCommand('同理'), true);
  assert.equal(looksLikeInheritCommand(' 同理。 '), true, '去空白、去句末标点后仍是一句光秃秃的同理');
  assert.equal(looksLikeInheritCommand('一样'), true);
  assert.equal(looksLikeInheritCommand('同理心是什么意思'), false, '提问不许被当成继承');
  assert.equal(looksLikeInheritCommand('同理，第3章讲什么'), false, '自带内容的不算「光秃秃」');
  assert.equal(looksLikeInheritCommand(''), false);
  assert.equal(looksLikeInheritCommand(null), false);
});

test('localDateKey：按本地时区截日期（UTC 直接截断会在晚上 8 点后算错）', () => {
  // UTC 11-21 16:30 = 上海 11-22 00:30 → 本地「今天」已经是 22 号
  assert.equal(localDateKey('2026-11-21T16:30:00.000Z', 'Asia/Shanghai'), '2026-11-22');
  assert.equal(localDateKey('2026-11-21T16:30:00.000Z', 'UTC'), '2026-11-21');
  // 上海 11-21 23:00（UTC 还是 11-21 下午）：本地仍是 21 号
  assert.equal(localDateKey('2026-11-21T15:00:00.000Z', 'Asia/Shanghai'), '2026-11-21');
  assert.equal(localDateKey('不是时间', 'Asia/Shanghai'), '', '解析不出来回空串，不当成今天');
  // 时区名不认识时退回本机时区，不抛错
 assert.equal(typeof localDateKey(new Date('2026-11-21T16:30:00.000Z'), 'Not/AZone'), 'string');
});

test('章号：中文数字与阿拉伯数字都认，且章名能把同号章分开', () => {
  const doc = {
    nodes: [
      knowledgeNode('k_1', '电偶极子', 0, { chapter: '第12章 静电场' }),
      knowledgeNode('k_2', '高斯定理', 0, { chapter: '第12章 静电场' }),
      knowledgeNode('k_3', '排序的稳定性', 1, { courseId: 'c_ds', chapter: '第12章 排序' }),
      knowledgeNode('k_4', '门电路', 0, { courseId: 'c_digital', chapter: '第 3 章 门电路' }),
    ],
  };
  const chapters = parseMasteryBatchScope('把第十二章 静电场一整章全部标记为精通', doc, { courses: COURSES });
  assert.equal(chapters.ok, true);
  assert.equal(chapters.scope.kind, 'chapter');
  assert.equal(chapters.scope.chapter, '第12章静电场', '章名归一（去空白）后才是比对的键');
  assert.equal(chapters.scope.label, '第12章 静电场');
  assert.equal(chapters.level, 3);

  const ambiguous = parseMasteryBatchScope('把第12章一整章全部标记为熟练', doc, { courses: COURSES });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous-chapter', '多门课同号章：不瞎挑一章');
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(ambiguous.candidates.map((item) => item.courseId).sort(), ['c_ds', 'c_phy']);

  const byCourse = parseMasteryBatchScope('把数据结构第12章整章标为精通', doc, { courses: COURSES });
  assert.equal(byCourse.ok, true);
  assert.equal(byCourse.scope.courseId, 'c_ds', '句子里点了课名就按课收窄');
});

// ---------------------------------------------------------------------------
// 「同理」继承（HTTP）
// ---------------------------------------------------------------------------

test('同理：继承上一条单点命令（同一 nodeId、同一等级），不调模型', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1), knowledgeNode('k_b', '高斯定理', 0)]);
  try {
    const history = [
      { role: 'user', content: '把电偶极子设为精通' },
      { role: 'assistant', content: '将把「电偶极子」掌握度从 1（学过）改为 3（精通），确认吗？' },
      { role: 'user', content: '同理' },
    ];
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages: history });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction?.kind, 'set-mastery', '继承单点 → 复用 set-mastery 预览形状');
    assert.equal(result.proposedAction?.nodeId, 'k_a');
    assert.equal(result.proposedAction?.to, 3);
    assert.match(result.reply, /接着上一条/, '话术要交代「继承的是哪一句」');
    assert.equal(server.calls.length, 0, '继承是纯后端解析，不调模型');
  } finally {
    await server.close();
  }
});

test('同理：继承上一条批量范围（今天学过的），按当前重算', async () => {
  const server = await startServer(
    [knowledgeNode('k_a', '电偶极子', 0), knowledgeNode('k_b', '高斯定理', 0), knowledgeNode('k_c', '电势', 0)],
    {
      behavior: {
        k_a: behaviorRecord({ lastLearnedAt: '2026-11-20T02:00:00.000Z' }),
        k_b: behaviorRecord({ lastLearnedAt: '2026-11-20T02:10:00.000Z' }),
        k_c: behaviorRecord({ lastLearnedAt: '2026-11-19T02:00:00.000Z' }),
      },
    },
  );
  try {
    const history = [
      { role: 'user', content: '把今天学过的标记为熟练' },
      { role: 'assistant', content: '将把「今天学过的」里的 2 个知识点设为 熟练，确认吗？' },
      { role: 'user', content: '同上' },
    ];
    const first = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages: history })).json();
    assert.equal(first.proposedAction?.kind, 'set-mastery-batch');
    assert.equal(first.proposedAction?.range, 'today');
    assert.equal(first.proposedAction?.total, 2);
    assert.equal(server.calls.length, 0);

    // 现在又多学了一个点（今天）→ 「同上」要按**当前**重算，而不是照抄上一条的 2 个快照
    await fsp.writeFile(path.join(server.dir, '学习行为.json'), JSON.stringify({
      version: DOC_VERSION,
      nodes: {
        k_a: behaviorRecord({ lastLearnedAt: '2026-11-20T02:00:00.000Z' }),
        k_b: behaviorRecord({ lastLearnedAt: '2026-11-20T02:10:00.000Z' }),
        k_c: behaviorRecord({ lastLearnedAt: '2026-11-20T02:30:00.000Z', firstLearnedAt: '2026-11-19T02:00:00.000Z' }),
      },
      updatedAt: null,
    }), 'utf8');

    const second = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages: history })).json();
    assert.equal(second.proposedAction?.total, 3, '继承的是「范围定义」，不是上次的 nodeId 快照');
    assert.deepEqual(
      second.proposedAction.nodes.map((item) => item.nodeId).sort(),
      ['k_a', 'k_b', 'k_c'],
    );
  } finally {
    await server.close();
  }
});

test('同理：找不到上一条命令 → 回提示语、不给 proposedAction、不调模型', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '同理' }],
    });
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /上一条没有可继承的改动/);
    assert.equal(server.calls.length, 0, '不是当普通提问扔给模型（那样用户会以为改了）');
  } finally {
    await server.close();
  }
});

test('同理：上一句是闲聊时继续往前找真正那条命令', async () => {
  const doc = { nodes: [knowledgeNode('k_a', '电偶极子', 0)] };
  const messages = [
    { role: 'user', content: '帮我看看这门课怎么复习' },
    { role: 'assistant', content: '先过一遍公式……' },
    { role: 'user', content: '把电偶极子设为熟练' },
    { role: 'assistant', content: '将把「电偶极子」掌握度从 0（未学）改为 2（熟练），确认吗？' },
    { role: 'user', content: '今天天气怎么样' },
    { role: 'assistant', content: '（闲聊）' },
    { role: 'user', content: '同理' },
  ];
  const inherited = resolveInheritedCommand(messages, doc, { version: DOC_VERSION, nodes: {} }, {});
  assert.equal(inherited.ok, true, '闲聊不该阻断更早那条真命令');
  assert.equal(inherited.level, 2);
  assert.equal(inherited.scope.nodeId, 'k_a');
});

// ---------------------------------------------------------------------------
// 今天学过的：筛选口径与本地时区边界
// ---------------------------------------------------------------------------

test('今天学过的：0 个 → 回人话、无 proposedAction、不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)], { behavior: {} });
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把今天学过的标记为熟练' }],
    })).json();
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /今天还没有记录到学过的知识点/);
    assert.deepEqual(await snapshotDir(server.dir), before, '预览阶段不写盘');
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('今天学过的：按本地时区算「今天」（UTC 截断会把昨天 23:00 误算进来）', async () => {
  // 现在是上海 11-22 00:30（UTC 仍是 11-21 16:30）
  const clock = makeClock('2026-11-21T16:30:00.000Z');
  const server = await startServer(
    [knowledgeNode('k_y', '昨天深夜学的', 0), knowledgeNode('k_t', '今天凌晨学的', 0)],
    {
      clock,
      timeZone: 'Asia/Shanghai',
      behavior: {
        // 上海 11-21 23:00 —— 本地是「昨天」，UTC 截断会算成 11-21（=今天）而误收
        k_y: behaviorRecord({ lastLearnedAt: '2026-11-21T15:00:00.000Z' }),
        // 上海 11-22 00:10 —— 本地今天
        k_t: behaviorRecord({ lastLearnedAt: '2026-11-21T16:10:00.000Z' }),
      },
    },
  );
  try {
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把今天学过的标记为熟练' }],
    })).json();
    assert.equal(result.proposedAction?.kind, 'set-mastery-batch');
    assert.deepEqual(result.proposedAction.nodes.map((item) => item.nodeId), ['k_t'], '昨天 23:00 不属于今天');
    assert.equal(result.proposedAction.total, 1);
  } finally {
    await server.close();
  }
});

test('今天学过的：预览带清单（from/fromLabel）、同档计入 skipped、不写盘', async () => {
  const server = await startServer(
    [knowledgeNode('k_a', '电偶极子', 0), knowledgeNode('k_b', '高斯定理', 2), knowledgeNode('k_c', '电势', 0)],
    {
      behavior: {
        k_a: behaviorRecord({ lastLearnedAt: '2026-11-20T02:00:00.000Z' }),
        k_b: behaviorRecord({ lastLearnedAt: '2026-11-20T02:05:00.000Z', masterySource: 'manual' }),
        k_c: behaviorRecord({ lastLearnedAt: '2026-11-18T02:00:00.000Z' }),
      },
    },
  );
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把今天学过的标记为熟练' }],
    })).json();

    const action = result.proposedAction;
    assert.equal(action.kind, 'set-mastery-batch');
    assert.equal(action.toLabel, '熟练');
    assert.equal(action.total, 2, 'total = 命中的今天节点数（含已是该等级的）');
    assert.equal(action.skipped, 1, 'k_b 已经是熟练，跳过不写');
    assert.deepEqual(action.nodes, [{
      nodeId: 'k_a', nodeName: '电偶极子', from: 0, fromLabel: '未学',
    }]);
    assert.deepEqual(await snapshotDir(server.dir), before, '清单预览阶段一个字节都不许写');
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 某一整章
// ---------------------------------------------------------------------------

test('一整章：唯一命中 → 清单预览；同档跳过；不写盘', async () => {
  const server = await startServer([
    knowledgeNode('k_1', '电偶极子', 0),
    knowledgeNode('k_2', '高斯定理', 3, { reviewedAt: '2026-10-01T00:00:00.000Z' }),
    knowledgeNode('k_3', '连续带电体的电场', 1),
  ]);
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把第12章静电场一整章全部标记为精通' }],
    })).json();
    const action = result.proposedAction;
    assert.equal(action.kind, 'set-mastery-batch');
    assert.equal(action.range, 'chapter');
    assert.equal(action.targetLabel, '第12章 静电场');
    assert.equal(action.level, 3);
    assert.equal(action.total, 3);
    assert.equal(action.skipped, 1);
    assert.deepEqual(action.nodes.map((item) => item.nodeId).sort(), ['k_1', 'k_3']);
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('一整章：多门课同号章 → ambiguous 回候选、绝不猜一个去改', async () => {
  const server = await startServer([
    knowledgeNode('k_1', '电偶极子', 0, { chapter: '第3章 门电路', courseId: 'c_digital' }),
    knowledgeNode('k_2', '列表', 0, { chapter: '第3章 列表', courseId: 'c_ds' }),
  ]);
  try {
    const before = await snapshotDir(server.dir);
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把第3章全部标记为精通' }],
    })).json();
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /第3章 门电路/);
    assert.match(result.reply, /第3章 列表/);
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('一整章：报了一个不存在的章号 → 回「没找到」，不写盘', async () => {
  const server = await startServer([knowledgeNode('k_1', '电偶极子', 0)]);
  try {
    const result = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把第99章一整章全部标记为精通' }],
    })).json();
    assert.equal(result.proposedAction, undefined);
    assert.match(result.reply, /没找到/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 批量落库：confirm 红线、如实计数
// ---------------------------------------------------------------------------

test('POST /assistant/mastery-batch：不带 confirm:true → 400 confirm-required，一个字节都不写', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);
    for (const body of [
      { items: [{ nodeId: 'k_a', mastery: 3 }] },
      { items: [{ nodeId: 'k_a', mastery: 3 }], confirm: 'true' },
      { items: [], confirm: true },
      { confirm: true },
    ]) {
      const response = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, body);
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.ok(['confirm-required', 'bad-payload'].includes(result.error), `收到 ${result.error}`);
    }
    assert.deepEqual(await snapshotDir(server.dir), before, '没确认就绝不落库');
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery-batch：整批落库 → 网络 mastery/reviewedAt 与学习行为 manual 逐条对上', async () => {
  const server = await startServer([
    knowledgeNode('k_a', '电偶极子', 1),
    knowledgeNode('k_b', '高斯定理', 0),
  ]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, {
      items: [{ nodeId: 'k_a', mastery: 3 }, { nodeId: 'k_b', mastery: 3 }],
      confirm: true,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.requested, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.changed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);

    const network = await readNetworkFile(server.dir);
    for (const id of ['k_a', 'k_b']) {
      const node = network.nodes.find((item) => item.id === id);
      assert.equal(node.mastery, 3, '等级写回知识点网络.mastery（唯一真源）');
      assert.equal(node.reviewedAt, '2026-11-20T03:00:00.000Z', '变了才刷 reviewedAt');
    }
    const behavior = await readBehaviorFile(server.dir);
    for (const id of ['k_a', 'k_b']) {
      assert.equal(behavior.nodes[id].masterySource, 'manual', '逐条先立 manual 旗');
      assert.equal(behavior.nodes[id].masteryUpdatedAt, '2026-11-20T03:00:00.000Z');
      assert.equal(behavior.nodes[id].visitCount, 0, '没访问过就是 0，不编行为');
    }
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery-batch：部分条目非法 → 成功 1 / 失败 2，只写合法那条', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, {
      items: [
        { nodeId: 'k_a', mastery: 2 },
        { nodeId: 'k_zzz', mastery: 2 },
        { nodeId: 'k_a2', mastery: 9 },
      ],
      confirm: true,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.succeeded, 1, '不谎报全成功');
    assert.equal(result.changed, 1);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failures.map((item) => item.reason).sort(), ['bad-mastery', 'unknown-node']);

    const network = await readNetworkFile(server.dir);
    assert.equal(network.nodes[0].mastery, 2);
    const behavior = await readBehaviorFile(server.dir);
    assert.equal(behavior.nodes.k_a.masterySource, 'manual');
    assert.equal(behavior.nodes.k_zzz, undefined, '失败的那条不许留下半条记录');
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery-batch：全部非法 → 400 no-valid-items，不写盘', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const before = await snapshotDir(server.dir);
    const response = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, {
      items: [{ nodeId: 'k_zzz', mastery: 3 }],
      confirm: true,
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no-valid-items');
    assert.equal(result.failed, 1);
    assert.deepEqual(await snapshotDir(server.dir), before);
  } finally {
    await server.close();
  }
});

test('POST /assistant/mastery-batch：同档（1→1）→ 网络不动、reviewedAt 不刷，但仍记 manual', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 1, { reviewedAt: '2026-10-01T00:00:00.000Z' })]);
  try {
    const networkBefore = await readNetworkFile(server.dir);
    const response = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, {
      items: [{ nodeId: 'k_a', mastery: 1 }],
      confirm: true,
    });
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.changed, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(await readNetworkFile(server.dir), networkBefore, '同档不写网络：连 updatedAt 都不变');
    assert.equal((await readBehaviorFile(server.dir)).nodes.k_a.masterySource, 'manual');
  } finally {
    await server.close();
  }
});

test('批量预览与落库都不调模型；预览→确认是两次请求（两步不可并）', async () => {
  const server = await startServer([knowledgeNode('k_a', '电偶极子', 0)]);
  try {
    const preview = await (await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '把第12章一整章全部标记为精通' }],
    })).json();
    assert.equal(preview.proposedAction?.kind, 'set-mastery-batch');
    assert.equal((await readNetworkFile(server.dir)).nodes[0].mastery, 0, '预览一个字节都不写');
    assert.equal(server.calls.length, 0, '命令类回答不经模型');

    const confirmed = await jsonRequest(`${server.baseUrl}/assistant/mastery-batch`, {
      items: preview.proposedAction.nodes.map((item) => ({ nodeId: item.nodeId, mastery: preview.proposedAction.level })),
      confirm: true,
    });
    assert.equal((await confirmed.json()).changed, 1);
    assert.equal((await readNetworkFile(server.dir)).nodes[0].mastery, 3);
    assert.equal(server.calls.length, 0, '写路由更不该调模型');
  } finally {
    await server.close();
  }
});

test('buildMasteryBatchPlan：「今天」集合只认 visitCount ≥ 1 且有 lastLearnedAt 的节点', () => {
  const doc = { nodes: [knowledgeNode('k_a', '电偶极子', 0), knowledgeNode('k_b', '高斯定理', 0)] };
  const behavior = {
    k_a: behaviorRecord({ visitCount: 0, lastLearnedAt: '2026-11-20T02:00:00.000Z' }),
    k_b: behaviorRecord({ visitCount: 1, lastLearnedAt: '2026-11-20T02:00:00.000Z' }),
  };
  const plan = buildMasteryBatchPlan(2, { kind: 'today' }, doc, { version: DOC_VERSION, nodes: behavior }, {
    now: new Date('2026-11-20T03:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.nodes.map((item) => item.nodeId), ['k_b'], 'visitCount=0 的「没真学过」不算');
  assert.equal(plan.total, 1);
});

// ---------------------------------------------------------------------------
// 前端（源码级）：批量清单要在界面上能勾选、能取消（取消不发请求）
// ---------------------------------------------------------------------------

test('前端：认 set-mastery-batch、渲染前 5 + 折叠、确认打 /assistant/mastery-batch 且带 confirm', () => {
  assert.ok(CLIENT.includes("kind === 'set-mastery-batch'"), '前端要认新的 kind');
  assert.ok(CLIENT.includes('`${API}/assistant/mastery-batch`'), '确认要走批量路由');
  assert.ok(CLIENT.includes('confirmMasteryBatch'), '要有专门的批量确认函数');
  assert.ok(CLIENT.includes('batch-selected'), '清单要能勾选（全选/反选）');
  assert.ok(CLIENT.includes('… 共'), '超过 5 个要折叠成「… 共 N 个」');
  assert.ok(/confirm: true/.test(CLIENT), '批量确认同样必须显式带 confirm');
});
