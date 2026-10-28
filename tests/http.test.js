/**
 * HTTP 接口测试（零依赖）
 * 运行：node tests/http.test.js
 *
 * 用一个真实的 http.Server 监听 127.0.0.1 随机端口做往返请求，
 * 这样能真实覆盖方法、请求头、请求体与状态码，而不是伪造 req/res。
 * 数据目录是自建临时目录，绝不触碰真实数据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER, MAX_BODY_BYTES } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 起一个真实服务，返回 baseUrl 与关闭函数。options 会并入 handler 依赖（如提交件归档的姓名/学号）。 */
async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-http-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    ...options,
    // `workspaceRoot` 允许写成 (dir) => 路径：测试要在临时目录里造工作区，
    // 而目录名要到调用时才存在，不能提前算。
    ...(typeof options.workspaceRoot === 'function' ? { workspaceRoot: options.workspaceRoot(dir) } : {}),
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
    handler,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

/** 带自定义头的 JSON 请求。 */
function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  Object.assign(headers, options.headers ?? {});
  return fetch(url, { method: options.method ?? 'POST', headers, body: options.rawBody ?? JSON.stringify(body) });
}

test('GET /health：数据正常时 200', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    // 四份学习数据 + 作业流 + 三份取字产物（资料索引 / 题目 / 知识点候选）+ 知识网络
    assert.equal(payload.files.length, 11);
  } finally {
    await server.close();
  }
});

test('GET /state：不带 doc 返回全部四份', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    for (const key of ['term', 'courses', 'tasks', 'grades']) {
      assert.ok(payload.docs[key], `缺少 ${key}`);
    }
    assert.deepEqual(payload.problems, []);
  } finally {
    await server.close();
  }
});

test('GET /state?doc=：单份读取；未知 doc 返回 400', async () => {
  const server = await startServer();
  try {
    const good = await fetch(`${server.baseUrl}/state?doc=tasks`);
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).doc.tasks, []);

    const bad = await fetch(`${server.baseUrl}/state?doc=../../etc/passwd`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown-doc');
  } finally {
    await server.close();
  }
});

test('POST /mutate：创建任务并落盘', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '数电第一次作业', kind: 'homework', due: '2026-09-20' },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 1);

    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(state.doc.tasks.length, 1);
    assert.equal(state.doc.tasks[0].title, '数电第一次作业');
    assert.ok(state.doc.tasks[0].id.startsWith('t'), '应自动生成 id');
  } finally {
    await server.close();
  }
});

test('POST /mutate：更新与删除', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: 'A' } });
    const created = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    const id = created.doc.tasks[0].id;

    const updated = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'update', id, item: { title: 'A 改', status: 'done' } });
    assert.equal(updated.status, 200);
    const afterUpdate = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(afterUpdate.doc.tasks[0].title, 'A 改');
    assert.equal(afterUpdate.doc.tasks[0].status, 'done');
    assert.equal(afterUpdate.doc.tasks[0].progress, 100, '已完成应把进度置满');
    assert.ok(afterUpdate.doc.tasks[0].doneAt, '已完成应记录完成时刻');

    const deleted = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'delete', id });
    assert.equal(deleted.status, 200);
    const afterDelete = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(afterDelete.doc.tasks.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /mutate 知识网络：建节点、只送掌握度也保留其余字段、非法档位被拒', async () => {
  const server = await startServer();
  try {
    const created = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'create',
      item: {
        name: '节点电压法',
        chapter: '第 2 章',
        aliases: ['节点法'],
        evidence: [{ type: 'ocr', file: '数电/作业/第01次作业_OCR文本/tier-gemini-page02.md', page: 2, quote: '节点电压法' }],
      },
    });
    assert.equal(created.status, 200, '知识网络必须走通用 /mutate（与 homework 不同，它没有专用路由）');

    const first = await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json();
    assert.equal(first.doc.nodes.length, 1);
    const node = first.doc.nodes[0];
    assert.ok(node.id.startsWith('k'), '应自动生成 k 开头的 id');
    assert.equal(node.mastery, 0, '新节点默认「未学」');
    assert.equal(node.marked, false);
    assert.equal(node.evidence.length, 1);
    assert.deepEqual(first.doc.edges, [], '第一版边留空（层级由渲染时推导）');

    // 面板点「熟练」只送 id + mastery，其余字段必须从磁盘上那条继承
    const marked = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', id: node.id, item: { mastery: 2 },
    });
    assert.equal(marked.status, 200);
    const second = (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json()).doc.nodes[0];
    assert.equal(second.mastery, 2);
    assert.equal(second.name, '节点电压法');
    assert.equal(second.chapter, '第 2 章');
    assert.deepEqual(second.aliases, ['节点法']);
    assert.equal(second.evidence[0].quote, '节点电压法');
    assert.ok(second.reviewedAt, '掌握度变化应记一次复习时间');

    // 点同一档位不该刷新复习时间（否则「最近复习」会被误触刷掉）
    const same = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', id: node.id, item: { mastery: 2 },
    });
    assert.equal(same.status, 200);
    const third = (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json()).doc.nodes[0];
    assert.equal(third.reviewedAt, second.reviewedAt);

    // 掌握度只有 0–3 四档
    const bad = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', id: node.id, item: { mastery: 9 },
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'bad-mastery');

    // 「重点」标记与掌握度正交
    const starred = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', id: node.id, item: { marked: true },
    });
    assert.equal(starred.status, 200);
    const fourth = (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json()).doc.nodes[0];
    assert.equal(fourth.marked, true);
    assert.equal(fourth.mastery, 2, '只改标记不该动掌握度');

    // 三份取字产物仍然不给通用 /mutate（与知识网络刻意不同）
    const candidates = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeCandidates', action: 'create', item: { name: 'x' },
    });
    assert.equal(candidates.status, 400);
    assert.equal((await candidates.json()).error, 'use-dedicated-route');
  } finally {
    await server.close();
  }
});

test('POST /mutate 批量：一次请求改一片节点、只落一次盘，坏 id 则整批不动', async () => {
  const server = await startServer();
  try {
    const read = async () => (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json());
    for (const name of ['甲', '乙', '丙']) {
      const created = await jsonRequest(`${server.baseUrl}/mutate`, {
        doc: 'knowledgeNetwork', action: 'create', item: { name },
      });
      assert.equal(created.status, 200);
    }
    const ids = (await read()).doc.nodes.map((node) => node.id);
    assert.equal(ids.length, 3);

    // 两条一次改：落盘一次，没在 items 里的第三条不受影响
    const batch = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'update',
      items: ids.slice(0, 2).map((id) => ({ id, item: { mastery: 2 } })),
    });
    assert.equal(batch.status, 200);
    const result = await batch.json();
    assert.equal(result.updated, 2, '应报告实际改了几条');
    const afterBatch = await read();
    assert.equal(afterBatch.hash, result.hash, '返回的 hash 就是落盘后的 hash');
    assert.equal(afterBatch.doc.nodes.filter((node) => node.mastery === 2).length, 2);
    assert.equal(afterBatch.doc.nodes.find((node) => node.id === ids[2]).mastery, 0, '未列出的节点保持原样');

    // 只要有一条 id 不存在，整批都不写盘（全成或全不成，否则面板会以为成功了一半）
    const broken = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'update',
      items: [{ id: ids[0], item: { mastery: 3 } }, { id: 'k_does_not_exist', item: { mastery: 3 } }],
    });
    assert.equal(broken.status, 404);
    const brokenBody = await broken.json();
    assert.equal(brokenBody.error, 'not-found');
    assert.deepEqual(brokenBody.ids, ['k_does_not_exist']);
    const afterBroken = await read();
    assert.equal(afterBroken.hash, afterBatch.hash, '失败的批量不能改动磁盘');
    assert.equal(afterBroken.doc.nodes.find((node) => node.id === ids[0]).mastery, 2, '先一条也不能被改');

    // 空数组与非法档位分别拒绝，且都不落盘
    const empty = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', items: [],
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'empty-items');

    const badLevel = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'update',
      items: [{ id: ids[0], item: { mastery: 9 } }],
    });
    assert.equal(badLevel.status, 400);
    assert.equal((await badLevel.json()).error, 'bad-mastery');
    assert.equal((await read()).hash, afterBatch.hash);

    // 超过 500 条必须明确报错，不能静默截断（2026-10-23 凌晨修：原来 slice(0,500) 会让调用方
    // 以为「全都改了」，实际只改前 500 个）
    const tooMany = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'update',
      items: Array.from({ length: 501 }, (_, index) => ({ id: `k_bulk_${index}`, item: { mastery: 2 } })),
    });
    assert.equal(tooMany.status, 400);
    const tooManyBody = await tooMany.json();
    assert.equal(tooManyBody.error, 'too-many-items');
    assert.equal(tooManyBody.limit, 500);
    assert.equal((await read()).hash, afterBatch.hash, '超限的批量不能改动磁盘');

    // 批量只对 update 生效：create 带 items 仍按单条规则报缺字段
    const wrongAction = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'create', items: [{ id: ids[0], item: {} }],
    });
    assert.equal(wrongAction.status, 400);
  } finally {
    await server.close();
  }
});

test('POST /knowledge/weave 织网：候选变节点、人标的掌握度不被覆盖、重跑不重复', async () => {
  const server = await startServer();
  try {
    // 先按面板的行为手工建一个节点并标成「熟练」——织网必须保住它
    const seeded = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'create',
      item: { name: '循环队列', chapter: '第 3 章 栈与队列', mastery: 2 },
    });
    assert.equal(seeded.status, 200);

    // 取字批次的产物：候选与题目（这两份没有 /mutate 路由，只能落盘）
    await fs.writeFile(path.join(server.dir, '课程.json'), JSON.stringify({
      version: 1, updatedAt: new Date().toISOString(), courses: [{ id: 'c_ds', name: '数据结构' }],
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(server.dir, '知识点候选.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      candidates: [
        { courseId: 'c_ds', name: '循环队列', aliases: ['环形队列'], chapter: '第 3 章 栈与队列', evidence: [{ type: 'material', file: '数据结构/教材/数据结构教材.pdf', page: 58, quote: '循环队列把数组首尾相连' }] },
        { courseId: 'c_ds', name: '时间复杂度', chapter: '第 1 章 绪论' },
      ],
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(server.dir, '题目.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      questions: [{ id: 'q_ds_1', courseId: 'c_ds', no: '3', prompt: '求下列算法的时间复杂度', knowledgeNames: ['时间复杂度'] }],
    }, null, 2), 'utf8');

    const woven = await jsonRequest(`${server.baseUrl}/knowledge/weave`, {});
    assert.equal(woven.status, 200);
    const wovenBody = await woven.json();
    assert.equal(wovenBody.changed, true);
    assert.equal(wovenBody.written, true);
    assert.equal(wovenBody.stats.created, 1);
    assert.equal(wovenBody.stats.merged, 1);

    const network = (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json()).doc;
    assert.equal(network.nodes.length, 2);
    const queue = network.nodes.find((node) => node.name === '循环队列');
    assert.equal(queue.mastery, 2, '人标的掌握度不能被织网冲掉');
    assert.deepEqual(queue.aliases, ['环形队列']);
    assert.deepEqual(queue.evidence.map((item) => item.type), ['material'], '合并不重复、不丢');
    const complexity = network.nodes.find((node) => node.name === '时间复杂度');
    assert.equal(complexity.mastery, 0);
    assert.deepEqual(complexity.evidence, [{ type: 'question', id: 'q_ds_1' }], '题目里点名的知识点应挂上证据');
    assert.ok(complexity.id.startsWith('k'));

    // 再点一次「织网」：什么都不该变（幂等）
    const again = await jsonRequest(`${server.baseUrl}/knowledge/weave`, {});
    const againBody = await again.json();
    assert.equal(againBody.changed, false);
    assert.equal(againBody.written, false);
  } finally {
    await server.close();
  }
});

test('POST /knowledge/export 导出画布：写 md 与 manifest、重跑只写变化、删陈旧不碰手写件', async () => {
  const server = await startServer();
  try {
    // 一个节点 + 一道题，够生成一份笔记与一份题目文件
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork',
      action: 'create',
      item: { name: '节点电压法', chapter: '第 2 章 电路分析方法', mastery: 1, aliases: ['节点法'], evidence: [{ type: 'question', id: 'q_dg_2' }] },
    });
    await fs.writeFile(path.join(server.dir, '题目.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      questions: [{ id: 'q_dg_2', courseId: null, no: '2', prompt: '用节点电压法求各支路电流', page: 2, kind: 'homework', knowledgeNames: ['节点电压法'] }],
    }, null, 2), 'utf8');

    const first = await jsonRequest(`${server.baseUrl}/knowledge/export`, {});
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.ok, true);
    assert.ok(body.written >= 2, '至少一份笔记 + 一份题目文件');
    assert.equal(body.summary.notes, 1);
    assert.equal(body.summary.questionFiles, 1);
    assert.equal(body.outDir, '知识画布');

    const canvas = path.join(server.dir, '知识画布');
    const notes = await fs.readdir(path.join(canvas, 'notes'), { recursive: true });
    const noteFiles = notes.filter((name) => String(name).endsWith('.md'));
    assert.equal(noteFiles.length, 1);
    const noteText = await fs.readFile(path.join(canvas, 'notes', String(noteFiles[0])), 'utf8');
    assert.match(noteText, /type: point/);
    assert.match(noteText, /节点电压法/);
    assert.match(noteText, /学过/, '掌握度 1 应写成「学过」');
    assert.ok(await fs.readFile(path.join(canvas, '_manifest.json'), 'utf8'));

    // 用户自己放进画布的笔记不能被清理
    const mine = path.join(canvas, 'notes', '我自己的笔记.md');
    await fs.writeFile(mine, '# 手写\n', 'utf8');

    const second = await jsonRequest(`${server.baseUrl}/knowledge/export`, {});
    const secondBody = await second.json();
    assert.equal(secondBody.written, 0, '内容没变就不重写');
    assert.equal(secondBody.unchanged, body.written);
    assert.ok(await fs.readFile(mine, 'utf8'), '清理只认 manifest，不能删掉手写笔记');

    // 节点改名后旧的笔记文件应作为「陈旧」被清掉（只在 manifest 登记范围内）
    const node = (await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json()).doc.nodes[0];
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'knowledgeNetwork', action: 'update', id: node.id, item: { name: '节点电压法（改名）' },
    });
    const third = await jsonRequest(`${server.baseUrl}/knowledge/export`, {});
    const thirdBody = await third.json();
    assert.ok(thirdBody.removed >= 1, '旧名字的笔记应被清掉');
    assert.ok(await fs.readFile(mine, 'utf8'), '手写笔记仍在');
  } finally {
    await server.close();
  }
});


test('POST /mutate：缺自定义头被 403 拒绝（挡住跨站表单提交）', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: 'x' } }, { withHeader: false });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'need-request-header');

    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(state.doc.tasks.length, 0, '被拒绝的请求不得写入');
  } finally {
    await server.close();
  }
});

test('POST /mutate：跨站来源被 403 拒绝', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: 'x' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'cross-site-rejected');
  } finally {
    await server.close();
  }
});

test('POST /mutate：Content-Type 不对返回 415', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', [REQUEST_HEADER]: '1' },
      body: JSON.stringify({ doc: 'tasks', action: 'create', item: { title: 'x' } }),
    });
    assert.equal(response.status, 415);
  } finally {
    await server.close();
  }
});

test('POST /mutate：坏 JSON、坏 payload、未知文档/动作都被拒绝', async () => {
  const server = await startServer();
  try {
    const badJson = await jsonRequest(`${server.baseUrl}/mutate`, null, { rawBody: '{坏' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'bad-json');

    const badPayload = await jsonRequest(`${server.baseUrl}/mutate`, [1, 2, 3]);
    assert.equal(badPayload.status, 400);
    assert.equal((await badPayload.json()).error, 'bad-payload');

    const badDoc = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'nope', action: 'create', item: {} });
    assert.equal(badDoc.status, 400);
    assert.equal((await badDoc.json()).error, 'unknown-doc');

    const badAction = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'drop-table' });
    assert.equal(badAction.status, 400);
    assert.equal((await badAction.json()).error, 'unknown-action');
  } finally {
    await server.close();
  }
});

test('POST /mutate：超过体积上限返回 413', async () => {
  const server = await startServer();
  try {
    const huge = `{"doc":"tasks","action":"create","item":{"title":"${'x'.repeat(MAX_BODY_BYTES + 1024)}"}}`;
    const response = await jsonRequest(`${server.baseUrl}/mutate`, null, { rawBody: huge });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'too-large');
  } finally {
    await server.close();
  }
});

test('POST /mutate：必填字段缺失/非法 id 返回 400，找不到返回 404', async () => {
  const server = await startServer();
  try {
    const noTitle = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { due: '2026-01-01' } });
    assert.equal(noTitle.status, 400);
    assert.equal((await noTitle.json()).error, 'title-required');

    const badId = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'delete', id: '../x' });
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).error, 'bad-id');

    const missing = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'delete', id: 't_notexist' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not-found');
  } finally {
    await server.close();
  }
});

test('删除课程：被任务引用时 409 拒绝，避免孤儿记录', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'create',
      item: { name: '数据结构', sessions: [{ weekday: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'A101' }] },
    });
    const courses = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
    const courseId = courses.doc.courses[0].id;

    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: '作业', courseId } });

    const blocked = await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'courses', action: 'delete', id: courseId });
    assert.equal(blocked.status, 409);
    const payload = await blocked.json();
    assert.equal(payload.error, 'course-in-use');
    assert.equal(payload.references.tasks, 1);
  } finally {
    await server.close();
  }
});

test('课程别名：写入后落盘并在读回时保留，供 DDL 导入用简称匹配', async () => {
  const server = await startServer();
  try {
    const created = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'create',
      item: { name: '数字电子技术基础', aliases: ['数电', '数电实验'], credits: 3.5 },
    });
    assert.equal(created.status, 200, `创建课程应成功，实际 ${created.status}`);

    const courses = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
    const course = courses.doc.courses[0];
    assert.deepEqual(course.aliases, ['数电', '数电实验'], '别名必须原样落盘，不能被规范化丢掉');

    // 别名要经得起 update：只改 name 时别名不应被清空
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'update',
      id: course.id,
      item: { name: '数字电子技术基础', aliases: course.aliases },
    });
    const after = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
    assert.deepEqual(after.doc.courses[0].aliases, ['数电', '数电实验'], '更新后别名应保留');
  } finally {
    await server.close();
  }
});

test('课程别名：去空、去重、限长，坏输入不炸', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses',
      action: 'create',
      item: { name: '测试课', aliases: ['  数电  ', '数电', '', '   ', 42, null, '数电实验'] },
    });
    const courses = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
    const aliases = courses.doc.courses[0].aliases;
    assert.deepEqual(aliases, ['数电', '数电实验'], `别名应去空去重并忽略非字符串，实际 ${JSON.stringify(aliases)}`);

    // 完全没给别名时也不应产生 undefined 之类写回文件
    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'courses', action: 'create', item: { name: '没有别名的课' } });
    const all = await (await fetch(`${server.baseUrl}/state?doc=courses`)).json();
    const second = all.doc.courses.find((c) => c.name === '没有别名的课');
    assert.deepEqual(second.aliases, [], '未提供别名时应落成空数组');
  } finally {
    await server.close();
  }
});

test('冲突：传入过期 expectedHash 时 409 拒绝，且不覆盖磁盘内容', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: '原始任务' } });
    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();

    // 用一个明显过期的 hash 作为前置条件，模拟「读到之后被别人改过」
    const stale = '0'.repeat(64);
    const response = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '不该写进去' },
      expectedHash: stale,
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'conflict');

    const after = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(after.doc.tasks.length, 1, '冲突时不得写入');
    assert.equal(after.doc.tasks[0].title, '原始任务');
    assert.equal(after.hash, state.hash, '磁盘内容必须没变');
  } finally {
    await server.close();
  }
});

test('冲突：传入正确的 expectedHash 时写入成功', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: '第一条' } });
    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();

    const response = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '第二条' },
      expectedHash: state.hash,
    });
    assert.equal(response.status, 200);
    const after = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(after.doc.tasks.length, 2);
  } finally {
    await server.close();
  }
});

test('GET /overview：返回概览与计数', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'term',
      action: 'create',
      item: { name: '2026 秋', startDate: '2026-09-07', endDate: '2026-12-27', totalWeeks: 16, isCurrent: true },
    });
    const response = await fetch(`${server.baseUrl}/overview`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.terms, 1);
    assert.equal(payload.term.name, '2026 秋');
    assert.ok(payload.overview, '应给出概览');
  } finally {
    await server.close();
  }
});

test('POST /reset-doc：需要 confirm', async () => {
  const server = await startServer();
  try {
    await jsonRequest(`${server.baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: '将被清空' } });

    const noConfirm = await jsonRequest(`${server.baseUrl}/reset-doc`, { doc: 'tasks' });
    assert.equal(noConfirm.status, 400);
    assert.equal((await noConfirm.json()).error, 'need-confirm');

    const done = await jsonRequest(`${server.baseUrl}/reset-doc`, { doc: 'tasks', confirm: true });
    assert.equal(done.status, 200);
    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    assert.equal(state.doc.tasks.length, 0);
  } finally {
    await server.close();
  }
});

test('方法与路由：PUT 返回 405，未知路径返回 404', async () => {
  const server = await startServer();
  try {
    const wrongMethod = await fetch(`${server.baseUrl}/state`, { method: 'PUT' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');

    const unknown = await fetch(`${server.baseUrl}/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown-route');
  } finally {
    await server.close();
  }
});

test('损坏保护：磁盘文件损坏时 /mutate 返回 409 而不是清空重写', async () => {
  const dir = await makeTempDir('study-assistant-corrupt-');
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
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const tasksFile = path.join(dir, '任务.json');
    const broken = '{ 损坏';
    await fs.writeFile(tasksFile, broken, 'utf8');

    const response = await jsonRequest(`${baseUrl}/mutate`, { doc: 'tasks', action: 'create', item: { title: '不该写进去' } });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /^corrupt/);
    assert.equal(await fs.readFile(tasksFile, 'utf8'), broken, '损坏文件必须原样保留');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});

// ─────────────────────── 网络学堂：凭据隔离与参数校验 ───────────────────────

/**
 * 网络学堂相关的接口**不联网**就能测的那部分：参数校验、状态查询、
 * 以及最要紧的一条 —— 会话 Cookie 不能被当成普通学习数据暴露出去。
 * 真正拉作业需要校内 cookie，那部分只能靠 tools/probe-learn-zy.mjs 在真机验。
 */
test('网络学堂：/learn/status 未连接时返回 connected:false', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/learn/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.connected, false);
    // 状态接口绝不能把 Cookie 回显出去
    assert.equal('cookie' in payload, false);
    assert.equal(JSON.stringify(payload).includes('JSESSIONID'), false);
  } finally {
    await server.close();
  }
});

test('网络学堂：/learn/connect 参数校验（空与过短的 cookie）', async () => {
  const server = await startServer();
  try {
    const empty = await jsonRequest(`${server.baseUrl}/learn/connect`, { cookie: '' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'need-cookie');

    const short = await jsonRequest(`${server.baseUrl}/learn/connect`, { cookie: 'x' });
    assert.equal(short.status, 400);
    assert.equal((await short.json()).error, 'cookie-too-short');

    // 参数不合法时不该落盘任何配置，否则界面会显示「已连接」而其实是空的
    const status = await (await fetch(`${server.baseUrl}/learn/status`)).json();
    assert.equal(status.connected, false);
  } finally {
    await server.close();
  }
});

test('网络学堂：未连接时 /learn/sync 与 /learn/fetch 返回 400 而不是 500', async () => {
  const server = await startServer();
  try {
    for (const route of ['/learn/sync', '/learn/fetch', '/learn/apply-updates']) {
      const response = await jsonRequest(`${server.baseUrl}${route}`, {});
      assert.equal(response.status, 400, route);
      assert.equal((await response.json()).error, 'not-connected', route);
    }
  } finally {
    await server.close();
  }
});

test('网络学堂：未连接时 /learn/semester 返回 400 而不是 500', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/learn/semester`, { semesterId: '2026-2027-1' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'not-connected');
  } finally {
    await server.close();
  }
});

test('网络学堂：换学期先验参数再联网，失败不动配置，status 给出可选学期', async () => {
  const dir = await makeTempDir('study-assistant-sem-');
  const store = createStore(dir);
  await store.init();
  // 手工放一份「已连接」配置，形状与 writeLearnConfig 写出的完全一致
  const original = JSON.stringify({
    version: 1,
    cookie: 'JSESSIONID=SECRET-VALUE',
    manual: {},
    courses: [],
    semesterId: '2026-2027-1',
    semesters: ['2026-2027-1', '2025-2026-3'],
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  await fs.writeFile(path.join(dir, '网络学堂.json'), original, 'utf8');

  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    // 换学期要用服务端自己存的 Cookie（界面拿不到），所以这里不需要、也不接受 Cookie 参数；
    // 但「要换成哪个学期」必须给清楚 —— 否则等于瞎拉一个学期的课。
    const missing = await jsonRequest(`${baseUrl}/learn/semester`, {});
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'need-semester');

    // 全空白也算没给
    const blank = await jsonRequest(`${baseUrl}/learn/semester`, { semesterId: '   ' });
    assert.equal(blank.status, 400);
    assert.equal((await blank.json()).error, 'need-semester');

    // 参数不合格时必须**在联网之前**就返回，且不能把配置写坏 —— 逐字比对原文件
    assert.equal(await fs.readFile(path.join(dir, '网络学堂.json'), 'utf8'), original);

    // status 要能给出可选学期，否则界面上没有「换学期」的抓手
    const status = await (await fetch(`${baseUrl}/learn/status`)).json();
    assert.deepEqual(status.semesters, ['2026-2027-1', '2025-2026-3']);
    assert.equal(status.semesterId, '2026-2027-1');
  } finally {
    await server.close();
    await removeTempDir(dir);
  }
});

test('网络学堂：同步接口受跨站保护，两道闸门都要拦住', async () => {
  const server = await startServer();
  try {
    // 第一道：漏了自定义头 —— 拿到 403 且不给具体业务错误
    const noHeader = await jsonRequest(`${server.baseUrl}/learn/sync`, {}, { withHeader: false });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');

    // 第二道：头都齐了但声明来自别的站点
    const crossSite = await jsonRequest(`${server.baseUrl}/learn/sync`, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error, 'cross-site-rejected');

    // 同一道闸门也要覆盖 /connect、/fetch、/apply-updates，不能只护住 sync
    for (const route of ['/learn/connect', '/learn/fetch', '/learn/apply-updates']) {
      const blocked = await jsonRequest(`${server.baseUrl}${route}`, {}, { withHeader: false });
      assert.equal(blocked.status, 403, route);
      assert.equal((await blocked.json()).error, 'need-request-header', route);
    }
  } finally {
    await server.close();
  }
});

// ─────────────────── 网络学堂：同步的提交状态（假 fetch，不联网） ───────────────────

/**
 * 用假的 `globalThis.fetch` 把网络学堂的响应喂进来。
 *
 * 覆盖的是「导入把已交作业写成待办」这个真实缺陷：只做参数校验、不联网的那几条
 * 测试抓不到它 —— 缺陷出在「平台的提交状态被丢掉」这条链路上，必须让数据真的
 * 走一遍 `候选 → toTaskItem → 落盘`。
 */
test('网络学堂：同步按平台状态落完成，并修复早先被写成待办的已交作业', async () => {
  const dir = await makeTempDir('study-assistant-sync-');
  const store = createStore(dir);
  await store.init();
  // 手工放一份「已连接」配置，形状与 writeLearnConfig 写出的完全一致
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: 'JSESSIONID=SECRET-VALUE; XSRF-TOKEN=tok',
      manual: {},
      courses: [],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-09-30T00:00:00.000Z',
    }),
    'utf8',
  );

  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

  const realFetch = globalThis.fetch;
  const envelope = (rows) => ({ result: 'success', msg: null, object: { iTotalRecords: rows.length, aaData: rows } });
  // 平台给的是毫秒时间戳；这里按 +08:00 折算，好让 jzsj 是个真实的 23:59
  const due = (y, m, d) => Date.UTC(y, m - 1, d, 23 - 8, 59);

  try {
    // 上一次同步导进来的一条待办：平台其实早就收到了，第二次同步应该就地补标
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '第一次作业', kind: 'homework', due: '2026-09-20 23:59', note: '[learn:xszyid:2]' },
    });
    // 用户手工标成完成的：即便平台说它没交，也不该被打回待办
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '线下作业', kind: 'homework', status: 'done', note: '[learn:xszyid:9]' },
    });

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const respond = (payload, text) => ({
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => (text === undefined ? JSON.stringify(payload) : text),
        json: async () => payload,
      });
      if (href.includes('/f/wlxt/index/course/student/')) return respond(null, '<html><span id="userid">x</span></html>');
      if (href.includes('queryxnxq')) return respond([null, '2026-2027-1']);
      if (href.includes('loadCourseBySemesterId')) return respond([{ wlkcid: 'W1', kcm: '大学物理B(2)', xf: 3 }]);
      // 未提交：xszyid 1 是新作业，应当导成待办
      if (href.includes('zyListWj')) {
        return respond(envelope([
          { xszyid: 1, bt: '第三次作业', jzsj: due(2026, 10, 15), jzsjStr: '2026-10-15 23:59' },
          { xszyid: 9, bt: '线下作业', jzsj: due(2026, 10, 20), jzsjStr: '2026-10-20 23:59' },
        ]));
      }
      // 已提交未批改：xszyid 2 与本地那条待办是同一份作业
      if (href.includes('zyListYjwg')) {
        return respond(envelope([{ xszyid: 2, bt: '第一次作业', jzsj: due(2026, 9, 20), jzsjStr: '2026-09-20 23:59' }]));
      }
      if (href.includes('zyListYpg')) return respond(envelope([]));
      throw new Error(`测试没有为这个网络学堂请求准备响应：${href}`);
    };

    const response = await jsonRequest(`${baseUrl}/learn/sync`, {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    // 「第三次作业」是新作业；「第一次作业」早就在本地（按远端记号跳过），只能靠补标修正
    assert.equal(payload.imported, 1);
    assert.equal(payload.completed, 1, '平台说已交、本地挂在待办的应就地标为完成');
    assert.equal(payload.skipped, 2);

    const state = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    const byNote = new Map(state.doc.tasks.map((t) => [t.note, t]));
    assert.equal(byNote.get('[learn:xszyid:1]').status, 'todo');
    assert.equal(byNote.get('[learn:xszyid:1]').progress, 0);
    assert.equal(byNote.get('[learn:xszyid:2]').status, 'done');
    assert.equal(byNote.get('[learn:xszyid:2]').progress, 100);
    assert.ok(byNote.get('[learn:xszyid:2]').doneAt, '补标完成也要有完成时刻');
    // 用户手工标的完成不能因为「平台没交」就被打回待办 —— 只单向升级
    assert.equal(byNote.get('[learn:xszyid:9]').status, 'done');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});

// ─────────────────── 网络学堂：检查更新（平台改过截止时间） ───────────────────

/**
 * 同步的盲区：已导入的条目按远端记号直接归 `skipped`，`due` 永远保持本地旧值。
 * 真实事故是「补课作业」——老师把截止从 10-18 放到 10-26，平台已经是 10-26，
 * 界面还显示 10-18。这一组钉死「查得出差异、写回只动 due」。
 */
test('网络学堂：/learn/updates 找出平台改过的截止时间，/learn/apply-updates 只改 due', async () => {
  const dir = await makeTempDir('study-assistant-updates-');
  const store = createStore(dir);
  await store.init();
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: 'JSESSIONID=SECRET-VALUE; XSRF-TOKEN=tok',
      manual: {},
      courses: [],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-09-30T00:00:00.000Z',
    }),
    'utf8',
  );

  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

  const realFetch = globalThis.fetch;
  const envelope = (rows) => ({ result: 'success', msg: null, object: { iTotalRecords: rows.length, aaData: rows } });
  const due = (y, m, d) => Date.UTC(y, m - 1, d, 23 - 8, 59);

  try {
    // 本地留着邮件里的 10-18（用户手工录的），平台其实已经放宽到 10-26
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: {
        title: '补课作业',
        kind: 'homework',
        due: '2026-10-18 23:59',
        note: '[learn:xszyid:26] 梁老师邮件说 10/18 前交',
      },
    });
    const before = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    const taskId = before.doc.tasks[0].id;

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const respond = (payload, text) => ({
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => (text === undefined ? JSON.stringify(payload) : text),
        json: async () => payload,
      });
      if (href.includes('/f/wlxt/index/course/student/')) return respond(null, '<html><span id="userid">x</span></html>');
      if (href.includes('queryxnxq')) return respond([null, '2026-2027-1']);
      if (href.includes('loadCourseBySemesterId')) return respond([{ wlkcid: 'W1', kcm: '物理实验B(1)', xf: 1 }]);
      if (href.includes('zyListWj')) return respond(envelope([]));
      if (href.includes('zyListYjwg')) {
        return respond(envelope([
          { xszyid: 26, bt: '补课作业', jzsj: due(2026, 10, 26), jzsjStr: '2026-10-26 23:59' },
        ]));
      }
      if (href.includes('zyListYpg')) return respond(envelope([]));
      throw new Error(`测试没有为这个网络学堂请求准备响应：${href}`);
    };

    // ① 只读检查：差异必须查得出来，且什么都不写
    const checked = await (await fetch(`${baseUrl}/learn/updates`)).json();
    assert.equal(checked.ok, true);
    assert.equal(checked.diffs.length, 1);
    assert.equal(checked.diffs[0].taskId, taskId);
    assert.equal(checked.diffs[0].from, '2026-10-18 23:59');
    assert.equal(checked.diffs[0].to, '2026-10-26 23:59');
    const untouched = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    assert.equal(untouched.doc.tasks[0].due, '2026-10-18 23:59', '只读检查不能动数据');

    // ② 按平台更新：只改 due，标题/状态/note 一个都不许变
    const applied = await (await jsonRequest(`${baseUrl}/learn/apply-updates`, { taskIds: [taskId] })).json();
    assert.equal(applied.ok, true);
    assert.equal(applied.updated, 1);
    assert.equal(typeof applied.hash, 'string');

    const state = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    const task = state.doc.tasks.find((t) => t.id === taskId);
    assert.equal(task.due, '2026-10-26 23:59');
    assert.equal(task.title, '补课作业');
    assert.equal(task.status, 'todo');
    assert.ok(String(task.note).startsWith('[learn:xszyid:26]'), 'note 里的记号必须原样留着，否则下次同步会重复导入');

    // ③ 再查一次：已经一致，没有可写的了（写请求要幂等）
    const again = await (await jsonRequest(`${baseUrl}/learn/apply-updates`, {})).json();
    assert.equal(again.updated, 0);
    assert.equal(again.diffs.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});

/**
 * 比对口径：只有「真的不一样」才算差异。
 *
 * - 平台没给截止日期（`jzsj` 为空）时**保留本地** —— 那通常只是老师没设期限，
 *   不该把用户手工录的日期清掉。
 * - `2026-10-26` 与 `2026-10-26 23:59` 是同一个时刻（都按当日 23:59 计），
 *   写法不同不该冒出一条「更新」。
 */
test('网络学堂：/learn/updates 不把「平台没日期」或「写法不同」当成改动', async () => {
  const dir = await makeTempDir('study-assistant-updates2-');
  const store = createStore(dir);
  await store.init();
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: 'JSESSIONID=SECRET-VALUE; XSRF-TOKEN=tok',
      manual: {},
      courses: [],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-09-30T00:00:00.000Z',
    }),
    'utf8',
  );

  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

  const realFetch = globalThis.fetch;
  const envelope = (rows) => ({ result: 'success', msg: null, object: { iTotalRecords: rows.length, aaData: rows } });

  try {
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '没设期限的作业', kind: 'homework', due: '2026-11-05 23:59', note: '[learn:xszyid:31]' },
    });
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '写法不同的作业', kind: 'homework', due: '2026-10-26 23:59', note: '[learn:xszyid:32]' },
    });

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const respond = (payload, text) => ({
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => (text === undefined ? JSON.stringify(payload) : text),
        json: async () => payload,
      });
      if (href.includes('/f/wlxt/index/course/student/')) return respond(null, '<html><span id="userid">x</span></html>');
      if (href.includes('queryxnxq')) return respond([null, '2026-2027-1']);
      if (href.includes('loadCourseBySemesterId')) return respond([{ wlkcid: 'W1', kcm: '物理实验B(1)', xf: 1 }]);
      if (href.includes('zyListWj')) return respond(envelope([]));
      if (href.includes('zyListYjwg')) {
        return respond(envelope([
          // 平台没设截止：本地那个 11-05 必须留着
          { xszyid: 31, bt: '没设期限的作业' },
          // 同一时刻的另一种写法：不是改动
          { xszyid: 32, bt: '写法不同的作业', jzsjStr: '2026-10-26' },
        ]));
      }
      if (href.includes('zyListYpg')) return respond(envelope([]));
      throw new Error(`测试没有为这个网络学堂请求准备响应：${href}`);
    };

    const checked = await (await fetch(`${baseUrl}/learn/updates`)).json();
    assert.equal(checked.ok, true);
    assert.equal(checked.diffs.length, 0, `不该报出差异：${JSON.stringify(checked.diffs)}`);

    const applied = await (await jsonRequest(`${baseUrl}/learn/apply-updates`, {})).json();
    assert.equal(applied.ok, true);
    assert.equal(applied.updated, 0);

    const state = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    const byNote = new Map(state.doc.tasks.map((t) => [t.note, t]));
    assert.equal(byNote.get('[learn:xszyid:31]').due, '2026-11-05 23:59');
    assert.equal(byNote.get('[learn:xszyid:32]').due, '2026-10-26 23:59');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});


// ─────────────────── 网络学堂：票空了不值当断线（浏览器才是凭据持有者） ───────────────────

/**
 * 2026-10-18 的真实事故：`网络学堂.json` 里的票被写成空串，界面那排「导入」按钮
 * 整排消失，这么耗了九个小时。根因不是「票没了」，而是**把磁盘缓存当成了唯一的票**。
 *
 * 学堂那张 `JSESSIONID` 是会话 Cookie（关浏览器就没了）+ 服务端空闲超时，真正
 * 长期有效的是 SSO 的 `TSINGHUAUSERID`（「信任浏览器」，一年）。所以缓存空了应当
 * 先去浏览器问一句，而不是直接判「未连接」。
 */
test('网络学堂：缓存里的票空了，先从专用浏览器取回再判死活', async () => {
  const dir = await makeTempDir('study-assistant-adopt-');
  const store = createStore(dir);
  await store.init();
  // 12:50 那份文件的形状：cookie 是空串
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: '',
      manual: {},
      courses: [],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-10-18T04:50:09.000Z',
    }),
    'utf8',
  );

  const browserCookie = 'JSESSIONID=FROM-BROWSER-TICKET; XSRF-TOKEN=abc';
  const browser = {
    edgeAvailable: true,
    status: () => ({ running: true, mode: 'headless', port: 9333 }),
    readCookie: async () => ({ ok: true, cookie: browserCookie, cookies: [], reason: null }),
    renew: async () => ({ ok: false, reason: '不该走到续期：浏览器里本来就有票' }),
    stop: async () => ({ ok: true, stopped: true }),
  };

  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {}, info() {}, warn() {} },
    learnBrowser: browser,
  });

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const headers = init?.headers ?? {};
      const sent = String(headers.cookie ?? headers.Cookie ?? '');
      if (!sent.includes('FROM-BROWSER-TICKET')) throw new Error('验活时没带上浏览器里那张票');
      return {
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => '<html><span id="userid">示例同学</span></html>',
        json: async () => ({}),
      };
    };

    const snapshot = await handler.learn.checkNow('startup');
    assert.equal(snapshot.alive, true, '浏览器里有票就该是活的');
    assert.equal(snapshot.reason, 'ok');

    // 取回来的票要落盘，否则下一次重启又回到「空票」状态
    const saved = JSON.parse(await fs.readFile(path.join(dir, '网络学堂.json'), 'utf8'));
    assert.equal(saved.cookie, browserCookie);
  } finally {
    globalThis.fetch = realFetch;
    await removeTempDir(dir);
  }
});

/**
 * 「要人工登录」以前是**永久**封条：一次 SSO 表单就把自动续期锁死到用户手动点按钮，
 * 而且还会顺手把浏览器关掉 —— 可浏览器是唯一持有「信任浏览器」票的人，关掉等于自断退路。
 * 现在它只是一个冷却：到期自动再试一次。
 */
test('网络学堂：「要人工登录」只是冷却，不是永久封条，也不许关浏览器', async () => {
  const dir = await makeTempDir('study-assistant-cooldown-');
  const store = createStore(dir);
  await store.init();
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: 'JSESSIONID=STILL-GOOD-TICKET',
      manual: {},
      courses: [],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-10-18T10:00:00.000Z',
    }),
    'utf8',
  );

  let renewCalls = 0;
  let stopCalls = 0;
  const browser = {
    edgeAvailable: true,
    status: () => ({ running: true, mode: 'headless', port: 9333 }),
    renew: async () => {
      renewCalls += 1;
      return { ok: false, reason: 'needs-manual-login', detail: null, ssoTouch: 'login-form' };
    },
    readCookie: async () => ({ ok: false, reason: 'not-used-here' }),
    stop: async () => { stopCalls += 1; return { ok: true, stopped: true }; },
  };

  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {}, info() {}, warn() {} },
    learnBrowser: browser,
    // 冷却时长注入 0：测试里不等 20 分钟，直接验「到期会不会再试」
    learnManualCooldownMs: 0,
  });

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      return {
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => '<html><span id="userid">示例同学</span></html>',
        json: async () => ({}),
      };
    };

    const first = await handler.learn.checkNow('timer');
    assert.equal(first.manualNeeded, true, 'SSO 要人工时要贴封条');
    assert.equal(first.alive, true, '封条不等于会话死了：票还活着就照实说活着');
    assert.equal(stopCalls, 0, '封条期间不许关浏览器 —— 它是唯一持有「信任浏览器」票的人');
    assert.equal(renewCalls, 1);

    // 冷却到期：「自动续期」必须自己再试一次，而不是死等用户点按钮
    const second = await handler.learn.checkNow('timer');
    assert.equal(renewCalls, 2, '冷却到期后要自己再试一次，而不是死等用户点按钮');
    // SSO 仍然要人工 ⇒ 封条重新贴上。这里验的是「真的又试了一次」，不是「解封成功」。
    // 旧实现是永久封条：它连这一次都不会试。
    assert.equal(second.manualNeeded, true);
  } finally {
    globalThis.fetch = realFetch;
    await removeTempDir(dir);
  }
});

// ─────────────────── 网络学堂：作业详情（假 fetch，不联网） ───────────────────

/**
 * 「一门本地课对上两个课堂号」是真实存在的形状：平台把「数字电子技术基础」和
 * 「数字电子技术实验」都算在 `c_digital` 名下（一个 `exact`、一个 `alias`）。
 * 拿错课堂号时平台回 500（真机上就是这个现象），所以钉死两件事：
 * 候选按 `exact` 优先排序、拿错号会自己换下一个再试。
 */
test('网络学堂：/learn/detail 挑课堂号、解析详情、短期缓存', async () => {
  const dir = await makeTempDir('study-assistant-detail-');
  const store = createStore(dir);
  await store.init();
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({
      version: 1,
      cookie: 'JSESSIONID=SECRET-VALUE; XSRF-TOKEN=tok',
      manual: {},
      // 故意把 alias 放前面：只取第一个的实现会拿错课堂号
      courses: [
        { wlkcid: 'W-LAB', name: '数字电子技术实验', courseId: 'c_digital', matched: true, how: 'alias', candidates: [] },
        { wlkcid: 'W-BASE', name: '数字电子技术基础', courseId: 'c_digital', matched: true, how: 'exact', candidates: [] },
      ],
      semesterId: '2026-2027-1',
      semesters: ['2026-2027-1'],
      updatedAt: '2026-10-10T00:00:00.000Z',
    }),
    'utf8',
  );
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

  const realFetch = globalThis.fetch;
  const page = (body) => ({ status: 200, ok: true, headers: new Map(), text: async () => body });
  const tries = [];
  try {
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '第三周作业', kind: 'homework', due: '2026-10-11 23:59', courseId: 'c_digital', note: '[learn:xszyid:abc]' },
    });
    // 第二条：exact 那个课堂号拿不到（500），必须自己换 alias 那个再试
    await jsonRequest(`${baseUrl}/mutate`, {
      doc: 'tasks',
      action: 'create',
      item: { title: '实验报告', kind: 'homework', due: '2026-10-18 23:59', courseId: 'c_digital', note: '[learn:xszyid:def]' },
    });
    const state = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
    const find = (mark) => state.doc.tasks.find((item) => String(item.note ?? '').includes(mark));
    const task = find('xszyid:abc');
    const taskTwo = find('xszyid:def');
    assert.ok(task && taskTwo, '任务没建上，后面的断言就没意义');

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      tries.push(href.slice(href.indexOf('/f/wlxt')));
      const detailPage = (title, due) => page('<html><span id="userid">2025000000</span>'
        + '<div class="ttee">作业内容及要求：</div>'
        + `<div class="list"><div class="fl left">作业标题</div><div class="right"><p>${title}</p></div></div>`
        + `<div class="list"><div class="fl left">截止日期(GMT+8)</div><div class="right">${due}</div></div>`);
      if (href.includes('wlkcid=W-BASE') && href.includes('xszyid=abc')) return detailPage('第三周作业', '2026-10-11 23:59');
      if (href.includes('wlkcid=W-BASE')) return { status: 500, ok: false, headers: new Map(), text: async () => 'boom' };
      if (href.includes('wlkcid=W-LAB')) return detailPage('实验报告', '2026-10-18 23:59');
      throw new Error(`测试没有为这个网络学堂请求准备响应：${href}`);
    };

    const first = await (await fetch(`${baseUrl}/learn/detail?taskId=${task.id}`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.wlkcid, 'W-BASE', 'exact 的那个课堂号应当排在 alias 前面');
    assert.equal(first.cached, false);
    assert.equal(first.detail.title, '第三周作业');
    assert.equal(first.detail.due, '2026-10-11 23:59');
    assert.equal(first.local.title, '第三周作业');
    assert.equal(tries.length, 1, 'exact 一次命中，不该白试 alias');
    assert.ok(tries[0].startsWith('/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=W-BASE&xszyid=abc'));

    const second = await (await fetch(`${baseUrl}/learn/detail?taskId=${task.id}`)).json();
    assert.equal(second.ok, true);
    assert.equal(second.cached, true, '三分钟内重复点开不该再打平台');
    assert.equal(tries.length, 1);

    // exact 那个号拿不到时就该换下一个：这是「数字电子技术基础 / 数字电子技术实验」
    // 共用同一个本地课程 id 时的真实退路（真机上错配就是 500）
    const third = await (await fetch(`${baseUrl}/learn/detail?taskId=${taskTwo.id}`)).json();
    assert.equal(third.ok, true);
    assert.equal(third.wlkcid, 'W-LAB', 'exact 拿不到就该换 alias 那个再试');
    assert.equal(third.detail.title, '实验报告');
    assert.deepEqual(
      tries.slice(1).map((href) => href.split('&_csrf')[0]),
      [
        '/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=W-BASE&xszyid=def',
        '/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=W-LAB&xszyid=def',
      ],
    );

    // 拉不到详情也是 200 + ok:false：界面要能退回本地字段、不许报红
    const missing = await (await fetch(`${baseUrl}/learn/detail?taskId=t_不存在`)).json();
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'no-task');
    assert.equal(missing.local, null);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});
test('凭据隔离：会话 Cookie 不进 /state，也不能被 /reset-doc 碰', async () => {
  const dir = await makeTempDir('study-assistant-cred-');
  const store = createStore(dir);
  await store.init();
  // 手工放一份「已连接」配置，形状与 writeLearnConfig 写出的完全一致
  await fs.writeFile(
    path.join(dir, '网络学堂.json'),
    JSON.stringify({ version: 1, cookie: 'JSESSIONID=SECRET-VALUE', manual: {}, courses: [], updatedAt: new Date().toISOString() }),
    'utf8',
  );
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} } });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    // /state 返回四份学习数据，绝不能把凭据带上
    const state = await (await fetch(`${baseUrl}/state`)).text();
    assert.equal(state.includes('SECRET-VALUE'), false, '/state 泄露了会话 Cookie');
    assert.equal(state.includes('网络学堂'), false, '/state 不该包含凭据文件');

    // /learn/status 只回「连上了」，不回 Cookie 本身
    const status = await (await fetch(`${baseUrl}/learn/status`)).json();
    assert.equal(status.connected, true);
    assert.equal(JSON.stringify(status).includes('SECRET-VALUE'), false);

    // /reset-doc 是给学习数据用的；凭据文件必须不在可重置范围内
    for (const doc of ['learn', '网络学堂', 'credential']) {
      const response = await jsonRequest(`${baseUrl}/reset-doc`, { doc, confirm: true });
      assert.equal(response.status, 400, doc);
    }
    assert.equal((await fs.readFile(path.join(dir, '网络学堂.json'), 'utf8')).includes('SECRET-VALUE'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(dir);
  }
});

/** 造一个「工作区」：<root>/<学科>/提交文件/<学号>_<姓名>_<学科>第N次作业.pdf */
async function makeSubmitFile(root, courseDir, basename) {
  const dir = path.join(root, courseDir, '提交文件');
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, basename);
  await fs.writeFile(abs, 'PDF');
  return abs;
}

/** 建一门课、返回它的 id。 */
async function createCourse(baseUrl, item) {
  const response = await jsonRequest(`${baseUrl}/mutate`, { doc: 'courses', action: 'create', item });
  assert.equal(response.status, 200);
  const state = await (await fetch(`${baseUrl}/state?doc=courses`)).json();
  const created = state.doc.courses.find((course) => course.name === item.name);
  assert.ok(created, `课程 ${item.name} 应已落盘`);
  return created.id;
}

/** 建一条任务、返回它的 id。 */
async function createTask(baseUrl, item) {
  const response = await jsonRequest(`${baseUrl}/mutate`, { doc: 'tasks', action: 'create', item });
  assert.equal(response.status, 200);
  const state = await (await fetch(`${baseUrl}/state?doc=tasks`)).json();
  return state.doc.tasks.find((task) => task.title === item.title).id;
}

test('提交件归档：没配 studentId 时 GET /deliverables 明确回 enabled:false，归档是空操作', async () => {
  const server = await startServer(); // 不传 studentName / studentId
  try {
    const payload = await (await fetch(`${server.baseUrl}/deliverables`)).json();
    assert.equal(payload.ok, true);
    assert.equal(payload.enabled, false, '没配身份就不该扫');
    assert.equal(payload.reason, 'disabled');
    assert.deepEqual(payload.findings, []);

    const response = await jsonRequest(`${server.baseUrl}/deliverables/archive`, {});
    assert.equal(response.status, 200, '关掉扫描时归档应是空操作，而不是报错');
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.deepEqual(body.archived, []);
  } finally {
    await server.close();
  }
});

test('提交件归档：唯一命中才写盘，落 done + doneAt + 备注里的文件名', async () => {
  const workspace = await makeTempDir('study-assistant-ws-');
  try {
    const file = '2025000000_示例同学_数据结构第二次作业.pdf';
    await makeSubmitFile(workspace, '数据结构', file);

    const server = await startServer({ studentName: '示例同学', studentId: '2025000000', workspaceRoot: workspace });
    try {
      const courseId = await createCourse(server.baseUrl, { name: '数据结构', aliases: ['数构'] });
      const hw1 = await createTask(server.baseUrl, { title: 'HW1', kind: 'homework', courseId });
      const hw2 = await createTask(server.baseUrl, { title: 'HW2', kind: 'homework', courseId });

      const scan = await (await fetch(`${server.baseUrl}/deliverables`)).json();
      assert.equal(scan.enabled, true);
      assert.equal(scan.findings.length, 1);
      assert.equal(scan.findings[0].status, 'ready', '第二次作业只应命中 HW2');
      assert.equal(scan.findings[0].taskId, hw2);
      assert.equal(scan.findings[0].courseId, courseId);

      const response = await jsonRequest(`${server.baseUrl}/deliverables/archive`, {});
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.archived.length, 1);
      assert.equal(body.archived[0].taskId, hw2);
      assert.equal(body.archived[0].file, `数据结构/提交文件/${file}`);

      const tasks = (await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json()).doc.tasks;
      const afterHw2 = tasks.find((task) => task.id === hw2);
      assert.equal(afterHw2.status, 'done', '唯一命中就该归档');
      assert.equal(afterHw2.progress, 100);
      assert.ok(afterHw2.doneAt, '归档必须记录完成时刻（界面上按它倒序）');
      assert.ok(afterHw2.note.includes(file), '备注里要留下提交件文件名，供「别重复归档」判定');
      assert.equal(tasks.find((task) => task.id === hw1).status, 'todo', '没命中的任务一个字都不能动');

      // 再扫一次：同一份件不该被重复归档（状态转成 done，理由 already-noted）
      const rescanned = await (await fetch(`${server.baseUrl}/deliverables`)).json();
      assert.equal(rescanned.findings[0].status, 'done');
      assert.equal(rescanned.findings[0].reason, 'already-noted');
      const again = await (await jsonRequest(`${server.baseUrl}/deliverables/archive`, {})).json();
      assert.deepEqual(again.archived, [], '重复扫描不能再归档一次');

      // 写请求的防护与其它 POST 一致
      const noHeader = await jsonRequest(`${server.baseUrl}/deliverables/archive`, {}, { withHeader: false });
      assert.equal(noHeader.status, 403);
      const crossing = await jsonRequest(`${server.baseUrl}/deliverables/archive`, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(crossing.status, 403);
    } finally {
      await server.close();
    }
  } finally {
    await removeTempDir(workspace);
  }
});

test('提交件归档：命中不唯一时只提示、绝不猜（宁可漏判也不误判）', async () => {
  const workspace = await makeTempDir('study-assistant-ws-');
  try {
    const file = '2025000000_示例同学_数电第二次作业.pdf';
    await makeSubmitFile(workspace, '数电', file);

    const server = await startServer({ studentName: '示例同学', studentId: '2025000000', workspaceRoot: workspace });
    try {
      const courseId = await createCourse(server.baseUrl, { name: '数字电子技术基础', aliases: ['数电'] });
      // 两条任务都能对上「第二次」⇒ 谁都不能自动归档
      const a = await createTask(server.baseUrl, { title: '第二次作业', kind: 'homework', courseId });
      const b = await createTask(server.baseUrl, { title: 'HW2', kind: 'homework', courseId });

      const scan = await (await fetch(`${server.baseUrl}/deliverables`)).json();
      assert.equal(scan.findings[0].status, 'ambiguous');
      assert.equal(scan.findings[0].reason, 'task-ambiguous');
      assert.deepEqual(scan.findings[0].candidates.map((item) => item.taskId).sort(), [a, b].sort());

      const body = await (await jsonRequest(`${server.baseUrl}/deliverables/archive`, {})).json();
      assert.deepEqual(body.archived, [], '不唯一就不能自动归档');
      const tasks = (await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json()).doc.tasks;
      assert.equal(tasks.every((task) => task.status === 'todo'), true, '两条任务都必须保持未完成');

      // 明确点名（items）也只认白名单里的候选，凭空编的 taskId 会被跳过而不是写入
      const bogus = await (await jsonRequest(`${server.baseUrl}/deliverables/archive`, { items: [{ taskId: 't_不存在', file: `数电/提交文件/${file}` }] })).json();
      assert.deepEqual(bogus.archived, []);
      assert.equal(bogus.skipped[0].reason, 'not-a-candidate');
      const tasksAfter = (await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json()).doc.tasks;
      assert.equal(tasksAfter.every((task) => task.status === 'todo'), true);
    } finally {
      await server.close();
    }
  } finally {
    await removeTempDir(workspace);
  }
});

// ─────────────────── 网络学堂：会话自愈（注入假浏览器，不起 Edge） ───────────────────

/** 造一个「专用浏览器」替身：不启进程，只按剧本回话。 */
function fakeLearnBrowser(script = {}) {
  const calls = { renew: 0, openLoginWindow: 0, stop: 0, readCookie: 0, renewOptions: null };
  return {
    calls,
    edgeAvailable: script.edgeAvailable !== false,
    status: () => ({
      running: script.running === true, mode: script.running === true ? 'headless' : null,
      port: 9333, pid: script.running === true ? 4242 : null, startedAt: null,
      profileDir: 'C:\\tmp\\learn-edge', edgePath: 'C:\\pf86\\Microsoft\\Edge\\Application\\msedge.exe',
    }),
    renew: async (options = {}) => {
      calls.renew += 1;
      calls.renewOptions = options;
      return script.renew ?? { ok: true, cookie: 'JSESSIONID=NEW; XSRF-TOKEN=tok2', source: 'renewed' };
    },
    // 只读当前浏览器里的 Cookie（不导航）—— 手动登录后靠它把票收下来
    readCookie: async () => {
      calls.readCookie += 1;
      return script.readCookie ?? { ok: true, cookie: 'JSESSIONID=NEW; XSRF-TOKEN=tok2' };
    },
    openLoginWindow: async () => {
      calls.openLoginWindow += 1;
      return script.openLoginWindow ?? { ok: true };
    },
    stop: async () => {
      calls.stop += 1;
      script.running = false;   // 真的关掉之后，status() 就不该还说在跑
      return script.stop ?? { ok: true, stopped: true };
    },
  };
}

const LEARN_CONFIG_FIXTURE = {
  version: 1,
  cookie: 'JSESSIONID=OLD; XSRF-TOKEN=tok',
  manual: {},
  courses: [],
  semesterId: '2026-2027-1',
  semesters: ['2026-2027-1'],
  updatedAt: '2026-09-30T00:00:00.000Z',
};

/**
 * 资料正文：面板「资料」页点开一份资料时读它的 md。
 *
 * 三条必须钉住的边界：
 *   1. `path` 只能是索引里登记过的那条（URL 里塞不进 `../`，也不可能读到工作区别的文件）；
 *   2. 扫描件按 `tier-gemini-pageNN.md` → `gemini-pageNN.md` → `pageNNNN.md` 的次序找，
 *      一次只回一页，并把「哪些页有字」带回去给界面翻页；
 *   3. 没取字的页、没登记的路径、空参数都要各自回一个能读懂的错误码，而不是 500。
 */
test('资料正文：按索引白名单读 md，页文件按命名规则挑，未登记与空参数都拒绝', async () => {
  const server = await startServer({ workspaceRoot: (dir) => path.join(dir, 'ws') });
  try {
    const ws = path.join(server.dir, 'ws');
    const ocrDir = path.join(ws, '数电', '作业', '第01次作业_OCR文本');
    await fs.mkdir(ocrDir, { recursive: true });
    await fs.writeFile(path.join(ocrDir, 'tier-gemini-page01.md'), '# 第 1 页\n\n基尔霍夫电流定律\n', 'utf8');
    await fs.writeFile(path.join(ocrDir, 'tier-gemini-page02.md'), '# 第 2 页\n\n节点电压法\n', 'utf8');
    await fs.mkdir(path.join(ws, '数电', '教材', '_TEXT'), { recursive: true });
    await fs.writeFile(path.join(ws, '数电', '教材', '_TEXT', '第01章.md'), '文字层正文：逻辑代数基础', 'utf8');

    const index = {
      version: 1,
      files: [
        {
          path: '数电/作业/第01次作业_原题.pdf',
          courseId: 'c_dg',
          kind: 'homework',
          textLayer: false,
          text: null,
          ocr: {
            done: true,
            pages: 3,
            donePages: [1, 2],
            blankPages: [],
            failedPages: [3],
            outDir: '数电/作业/第01次作业_OCR文本',
            localOnlyPages: [],
            updatedAt: '2026-10-20T10:00:00.000Z',
          },
        },
        {
          path: '数电/教材/第01章.pdf',
          courseId: 'c_dg',
          kind: 'material',
          textLayer: true,
          ocr: null,
          text: { done: true, chars: 13, outFile: '数电/教材/_TEXT/第01章.md', updatedAt: '2026-10-20T10:00:00.000Z' },
        },
      ],
      updatedAt: '2026-10-20T10:00:00.000Z',
    };
    await fs.writeFile(path.join(server.dir, '资料索引.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    const ask = async (query) => {
      const response = await fetch(`${server.baseUrl}/materials/text?${query}`);
      return { status: response.status, payload: await response.json() };
    };
    const first = encodeURIComponent('数电/作业/第01次作业_原题.pdf');

    // 默认第一页
    const page1 = await ask(`path=${first}`);
    assert.equal(page1.status, 200);
    assert.equal(page1.payload.ok, true);
    assert.equal(page1.payload.kind, 'ocr');
    assert.equal(page1.payload.page, 1);
    assert.deepEqual(page1.payload.pages, [1, 2], '只应列出真正有产物的页（第 3 页失败）');
    assert.match(page1.payload.text, /基尔霍夫电流定律/);
    assert.equal(page1.payload.file, '数电/作业/第01次作业_OCR文本/tier-gemini-page01.md');

    // 指定页
    const page2 = await ask(`path=${first}&page=2`);
    assert.equal(page2.status, 200);
    assert.equal(page2.payload.page, 2);
    assert.match(page2.payload.text, /节点电压法/);

    // 没取字的页：404 + 已有页清单（界面据此提示，而不是空白）
    const page3 = await ask(`path=${first}&page=3`);
    assert.equal(page3.status, 404);
    assert.equal(page3.payload.error, 'page-missing');
    assert.deepEqual(page3.payload.pages, [1, 2]);

    // 有文字层的资料：一次读完，没有页概念
    const textDoc = await ask(`path=${encodeURIComponent('数电/教材/第01章.pdf')}`);
    assert.equal(textDoc.status, 200);
    assert.equal(textDoc.payload.kind, 'text');
    assert.equal(textDoc.payload.page, null);
    assert.match(textDoc.payload.text, /逻辑代数基础/);

    // 未登记路径（含路径穿越写法）：404，绝不去碰工作区别处
    for (const bad of ['../../etc/passwd', '数电/作业/不存在.pdf', '']) {
      const denied = await ask(`path=${encodeURIComponent(bad)}`);
      assert.equal(denied.status, bad === '' ? 400 : 404, `路径 ${JSON.stringify(bad)} 必须被拒绝`);
      assert.equal(denied.payload.ok, false);
    }
  } finally {
    await server.close();
  }
});

/**
 * 续期这条链路只有一个硬边界：**验证通过才落盘**。
 *
 * 「浏览器说自己登录了」不算数，所以这里让假浏览器回一张 Cookie，再由假的平台
 * 响应决定这张 Cookie 认不认。写得再漂亮也不能把还能用的旧 Cookie 覆盖掉 ——
 * 那比续期失败本身糟糕得多。
 */
test('网络学堂：/learn/renew 验活后才换 Cookie，失败时一个字都不动', async () => {
  const server = await startServer({ learnBrowser: fakeLearnBrowser() });
  const configPath = path.join(server.dir, '网络学堂.json');
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(configPath, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');

    // 会话状态：还没验过 ⇒ alive 必须是 null（界面不能把「没验过」画成「已失效」）
    const before = await (await fetch(`${server.baseUrl}/learn/session`)).json();
    assert.equal(before.ok, true);
    assert.equal(before.connected, true);
    assert.equal(before.alive, null);
    assert.equal(before.renewing, false);
    assert.equal(before.browser.running, false);
    assert.equal(before.edgeAvailable, true);
    assert.equal(JSON.stringify(before).includes('JSESSIONID'), false, '会话状态绝不能回 Cookie');

    // 假平台：只有新 Cookie 能拿到学生端首页
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      const loggedIn = sent.includes('JSESSIONID=NEW');
      return {
        status: 200,
        ok: true,
        url: href,
        headers: new Map(),
        text: async () => (loggedIn ? '<html><span id="userid">2025000000</span></html>' : '<html><title>登录超时</title></html>'),
        json: async () => null,
      };
    };

    const renewed = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(renewed.ok, true);
    assert.equal(renewed.source, 'renewed');
    assert.equal(renewed.session.alive, true);
    assert.equal(renewed.session.reason, 'ok');
    assert.ok(renewed.session.checkedAt, '续期成功要记下验证时刻');

    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.cookie, 'JSESSIONID=NEW; XSRF-TOKEN=tok2', '验证过的新 Cookie 才写盘');
    assert.equal(saved.semesterId, '2026-2027-1', '续期只换 Cookie，学期与课程映射都别丢');

    // 失败路线：换了一张平台不认的 Cookie ⇒ 配置必须原样
    const failing = fakeLearnBrowser({ renew: { ok: true, cookie: 'JSESSIONID=BROKEN', source: 'renewed' }, readCookie: { ok: false, reason: 'edge-dead' } });
    const server2 = await startServer({ learnBrowser: failing });
    const configPath2 = path.join(server2.dir, '网络学堂.json');
    try {
      await fs.writeFile(configPath2, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
      const bad = await (await jsonRequest(`${server2.baseUrl}/learn/renew`, {})).json();
      assert.equal(bad.ok, false);
      assert.equal(bad.error, 'cookie-invalid', '平台不认的新 Cookie 不能算成功');
      assert.equal(bad.session.alive, false);
      assert.equal(await fs.readFile(configPath2, 'utf8'), JSON.stringify(LEARN_CONFIG_FIXTURE), '续期失败绝不能覆盖旧配置');
    } finally {
      await server2.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

test('网络学堂：续期失败（浏览器说登不上）把原因透出来，不动配置', async () => {
  const browser = fakeLearnBrowser({ renew: { ok: false, reason: 'needs-manual-login' }, readCookie: { ok: false, reason: 'edge-idle' } });
  // 续期失败后 handler 会「直连再问一次」（bareLearnCheck）。真去问学堂的话，
  // 结果取决于跑测试的机器能不能连上 —— CI 上连不上会得到 alive:null，
  // 本地连得上才得到 false。这里把 fetch 打成「登录超时」页，结论就固定了。
  const realFetch = globalThis.fetch;
  const staleLoginPage = {
    status: 200,
    ok: true,
    url: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/',
    headers: new Map(),
    text: async () => '<html><title>登录超时</title></html>',
    json: async () => null,
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    // 只拦学堂那条，测试自己访问本机 server 的请求照旧走真 fetch
    if (url.includes('learn.tsinghua.edu.cn')) return staleLoginPage;
    return realFetch(input, init);
  };
  const server = await startServer({ learnBrowser: browser });
  const configPath = path.join(server.dir, '网络学堂.json');
  try {
    await fs.writeFile(configPath, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    const payload = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'needs-manual-login');
    assert.equal(payload.session.alive, false);
    assert.equal(payload.session.reason, 'needs-manual-login');
    assert.equal(browser.calls.renew, 1);
    assert.equal(await fs.readFile(configPath, 'utf8'), JSON.stringify(LEARN_CONFIG_FIXTURE));
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

test('网络学堂：没装 Edge 时续期直接说 edge-not-found，不去碰浏览器', async () => {
  const browser = fakeLearnBrowser({ edgeAvailable: false });
  const server = await startServer({ learnBrowser: browser });
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    const payload = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'edge-not-found');
    assert.equal(browser.calls.renew, 0, '没浏览器就别假装在续期');
    const session = await (await fetch(`${server.baseUrl}/learn/session`)).json();
    assert.equal(session.edgeAvailable, false);
  } finally {
    await server.close();
  }
});

test('网络学堂：登录窗口与关浏览器两个按钮照做，并且都要过写请求闸门', async () => {
  const browser = fakeLearnBrowser({ running: true });
  const server = await startServer({ learnBrowser: browser });
  try {
    const opened = await (await jsonRequest(`${server.baseUrl}/learn/login-window`, {})).json();
    assert.equal(opened.ok, true);
    assert.equal(browser.calls.openLoginWindow, 1);
    assert.equal(opened.browser.running, true);

    const stopped = await (await jsonRequest(`${server.baseUrl}/learn/browser-stop`, {})).json();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(browser.calls.stop, 1);

    // 有副作用的接口不能只靠「是 POST」当保护：跨站与缺头都要拦住
    const crossSite = await jsonRequest(`${server.baseUrl}/learn/browser-stop`, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const noHeader = await jsonRequest(`${server.baseUrl}/learn/login-window`, {}, { withHeader: false });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error, 'need-request-header');
    assert.equal(browser.calls.openLoginWindow, 1, '被拦下的请求不该真的弹窗口');
    assert.equal(browser.calls.stop, 1);
  } finally {
    await server.close();
  }
});

test('网络学堂：/learn/status 带上会话状态，且仍然不回 Cookie', async () => {
  const server = await startServer({ learnBrowser: fakeLearnBrowser() });
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    const payload = await (await fetch(`${server.baseUrl}/learn/status`)).json();
    assert.equal(payload.connected, true);
    assert.ok(payload.session, 'status 要顺带回会话状态，省得界面再发一次请求');
    assert.equal(payload.session.alive, null);
    assert.equal(JSON.stringify(payload).includes('JSESSIONID'), false);
  } finally {
    await server.close();
  }
});

test('网络学堂：详情撞上 Cookie 过期时，自动续期并用新 Cookie 重试一次', async () => {
  const browser = fakeLearnBrowser({ renew: { ok: true, cookie: 'JSESSIONID=NEW', source: 'renewed' } });
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify({
      ...LEARN_CONFIG_FIXTURE,
      courses: [{ wlkcid: 'W1', name: '数字电子技术基础', courseId: 'c_digital', matched: true, how: 'exact' }],
    }), 'utf8');
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses', action: 'create', item: { id: 'c_digital', name: '数字电子技术基础' },
    });
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks', action: 'create',
      item: { title: '第三周作业', kind: 'homework', courseId: 'c_digital', note: '[learn:xszyid:abc]' },
    });

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      const loggedIn = sent.includes('JSESSIONID=NEW');
      const respond = (text, status = 200) => ({
        status, ok: status === 200, url: href, headers: new Map(),
        text: async () => text, json: async () => null,
      });
      if (href.includes('/f/wlxt/index/course/student/')) {
        return respond(loggedIn ? '<html><span id="userid">x</span></html>' : '<html><title>登录超时</title></html>');
      }
      if (!loggedIn) return respond('<html><title>登录超时</title></html>');
      // 详情页必须带 id="userid"：fetchHomeworkDetail 把它当「这页是登录页吗」的判据
      return respond('<html><span id="userid">x</span><div class="ttee">作业内容及要求</div><div class="fl left">作业标题</div><div class="fl right">第三周作业</div></html>');
    };

    // 编的 taskId 先撞 no-task（这不是重点）
    const bogus = await (await fetch(`${server.baseUrl}/learn/detail?taskId=${encodeURIComponent('t_x')}`)).json();
    assert.equal(bogus.ok, false);
    assert.equal(bogus.error, 'no-task');

    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    const taskId = state.doc.tasks[0].id;
    const after = await (await fetch(`${server.baseUrl}/learn/detail?taskId=${taskId}`)).json();
    if (after.ok !== true) {
      const session = await (await fetch(`${server.baseUrl}/learn/session`)).json();
      assert.fail(`详情应经自动续期后成功；实际=${JSON.stringify(after)}；会话=${JSON.stringify(session)}；renew 次数=${browser.calls.renew}`);
    }
    assert.equal(after.detail.title, '第三周作业');
    assert.equal(browser.calls.renew, 1, '旧 Cookie 过期应触发而且只触发一次续期');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 详情那条路续期失败时，**不许把浏览器故障写成 Cookie 失效**。
 *
 * 2026-10-17 的真机现场：点开作业详情撞上过期 → 顺手续期 → SSO 回跳超时
 * （`sso-timeout`）→ 旧代码把这次失败直接写进全局会话，`alive = false` 且不更新
 * `checkedAt`。可那张票 187ms 后直连一问还是活的，于是界面红了二十多分钟。
 * 现在这活儿归直连说话：详情照样报它自己的错，会话状态不许被污染。
 */
test('网络学堂：详情续期撞上 sso-timeout 时，票还活着就不许报红', async () => {
  const browser = fakeLearnBrowser({ renew: { ok: false, reason: 'sso-timeout' } });
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify({
      ...LEARN_CONFIG_FIXTURE,
      courses: [{ wlkcid: 'W1', name: '数字电子技术基础', courseId: 'c_digital', matched: true, how: 'exact' }],
    }), 'utf8');
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'courses', action: 'create', item: { id: 'c_digital', name: '数字电子技术基础' },
    });
    await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'tasks', action: 'create',
      item: { title: '第四周作业', kind: 'homework', courseId: 'c_digital', note: '[learn:xszyid:abc]' },
    });

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const respond = (text, status = 200) => ({
        status, ok: status === 200, url: href, headers: new Map(),
        text: async () => text, json: async () => null,
      });
      // 学生端首页：这张票是活的（id="userid" 就是 fetchLearnIndex 的判活依据）
      if (href.includes('/f/wlxt/index/course/student/')) return respond('<html><span id="userid">2025000000</span></html>');
      // 详情页：偏偏进不去（登录超时），于是先报 cookie-invalid
      return respond('<html><title>登录超时</title></html>');
    };

    const state = await (await fetch(`${server.baseUrl}/state?doc=tasks`)).json();
    const taskId = state.doc.tasks[0].id;
    const after = await (await fetch(`${server.baseUrl}/learn/detail?taskId=${taskId}`)).json();
    assert.equal(after.ok, false, '详情这一发确实没拿到');
    assert.equal(after.error, 'cookie-invalid');
    assert.equal(browser.calls.renew, 1, '撞上过期会顺手续一次');

    const session = await (await fetch(`${server.baseUrl}/learn/session`)).json();
    assert.equal(session.alive, true, '票是好的 ⇒ 会话不许被判死');
    assert.equal(session.reason, 'ok');
    assert.ok(session.checkedAt, '复查要记下时刻');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

test('网络学堂：续期撞上「必须人工登录」后不再每轮白试，用户一动手就解封', async () => {
  // readCookie 也给死票：否则「浏览器兜底取票」会把这张假票当成活的，测不到封条
  const script = { renew: { ok: false, reason: 'needs-manual-login' }, readCookie: { ok: false, reason: 'edge-idle' } };
  const browser = fakeLearnBrowser(script);
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      const alive = sent.includes('JSESSIONID=NEW');
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => (alive ? '<html><span id="userid">x</span></html>' : '<html><title>登录超时</title></html>'),
        json: async () => null,
      };
    };

    // 第一次心跳：旧 Cookie 死了 → 去续期 → SSO 要人工登录 → 贴上「别再自动试」的封条
    const first = await server.handler.learn.checkNow('timer');
    assert.equal(first.alive, false);
    assert.equal(first.reason, 'needs-manual-login');
    assert.equal(first.manualNeeded, true);
    assert.equal(browser.calls.renew, 1);

    // 后面的心跳（含启动那次）都该被封条挡住：这正是「别每 30 分钟白弹一个浏览器」的用意
    const second = await server.handler.learn.checkNow('timer');
    const third = await server.handler.learn.checkNow('startup');
    assert.equal(browser.calls.renew, 1, '封条还在时不该再碰浏览器');
    assert.equal(second.reason, 'needs-manual-login');
    assert.equal(third.reason, 'needs-manual-login');

    // 用户点「立即续期」：解封并真的再试一次（这次还是被拦住 → 封条重新贴上）
    const manual = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(manual.ok, false);
    assert.equal(manual.error, 'needs-manual-login');
    assert.equal(browser.calls.renew, 2, '手动这次必须真的去试');
    assert.equal(manual.session.manualNeeded, true);

    // 用户在登录窗口里登好了，再点一次就能把新 Cookie 收下来
    script.renew = { ok: true, cookie: 'JSESSIONID=NEW', source: 'renewed' };
    const good = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(good.ok, true);
    assert.equal(good.session.manualNeeded, false);
    assert.equal(good.session.alive, true);

    const saved = JSON.parse(await fs.readFile(path.join(server.dir, '网络学堂.json'), 'utf8'));
    assert.equal(saved.cookie, 'JSESSIONID=NEW');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 心跳的本来目的：**每 20 分钟真的走进登录域一趟**，把学堂与清华 SSO 两边的空闲
 * 计时器一起清零。
 *
 * 两个容易做错的点都在这里钉住：
 * ① 必须把 `touchSso` 传下去 —— 少了它，浏览器只逛学堂，SSO 那边照样闲死，
 *    于是每次真需要换票时都变成「必须人工登录」，正是用户抱怨的现象；
 * ② 浏览器把**同一张** Cookie 又发回来时不写盘 —— 会话本来就活着，写盘只会让
 *    `网络学堂.json` 的 mtime 每 20 分钟跳一次，还白搭一次验活请求。
 */
test('网络学堂：心跳走浏览器并顺手喂 SSO，Cookie 没变就不写盘', async () => {
  const browser = fakeLearnBrowser({
    renew: { ok: true, cookie: LEARN_CONFIG_FIXTURE.cookie, source: 'existing', ssoTouch: 'ok' },
  });
  const server = await startServer({ learnBrowser: browser });
  const configPath = path.join(server.dir, '网络学堂.json');
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(configPath, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    const before = await fs.readFile(configPath, 'utf8');
    let platformHits = 0;
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      platformHits += 1;
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => '<html><span id="userid">x</span></html>',
        json: async () => null,
      };
    };

    const snap = await server.handler.learn.checkNow('timer');
    assert.equal(snap.alive, true);
    assert.equal(snap.reason, 'ok');
    assert.equal(browser.calls.renew, 1, '心跳必须真的让浏览器跑一趟');
    assert.equal(browser.calls.renewOptions.touchSso, true, '必须顺手喂 SSO，否则它闲死之后就要人工登录');
    assert.equal(browser.calls.renewOptions.headless, true, '心跳用的窗口不该占屏幕');
    assert.equal(platformHits, 0, 'Cookie 一模一样：不该再花一次验活请求');
    assert.equal(await fs.readFile(configPath, 'utf8'), before, 'Cookie 没变就不该写盘（mtime 不许每 20 分钟跳一次）');
    assert.equal(snap.cookieUpdatedAt, null, '从没换到新 Cookie，就不该有「续期时间」');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 「关闭后台浏览器」的语义边界。
 *
 * 关掉之后心跳**不许**偷偷把它拉起来（否则按钮等于没用），但用户手动点「立即续期」
 * 就是要它干活 —— 那时必须无视这条偏好，并把偏好清掉。
 */
test('网络学堂：关掉后台浏览器后心跳不再自动拉起，手动续期才恢复', async () => {
  const script = { running: true };
  const browser = fakeLearnBrowser(script);
  const server = await startServer({ learnBrowser: browser });
  const configPath = path.join(server.dir, '网络学堂.json');
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(configPath, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      const alive = sent.includes('JSESSIONID=NEW');
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => (alive ? '<html><span id="userid">x</span></html>' : '<html><title>登录超时</title></html>'),
        json: async () => null,
      };
    };

    const stopped = await (await jsonRequest(`${server.baseUrl}/learn/browser-stop`, {})).json();
    assert.equal(stopped.ok, true);
    assert.equal(browser.calls.stop, 1);
    assert.equal(stopped.browser.running, false);

    const afterStop = await (await fetch(`${server.baseUrl}/learn/session`)).json();
    assert.equal(afterStop.browserOptOut, true);

    // 心跳：不许碰浏览器；退回 Cookie 直连 ⇒ 旧 Cookie 已死，如实说 cookie-invalid
    const beat = await server.handler.learn.checkNow('timer');
    assert.equal(browser.calls.renew, 0, '用户按了关闭，心跳不许偷偷把浏览器拉起来');
    assert.equal(beat.alive, false);
    assert.equal(beat.reason, 'cookie-invalid');

    // 用户手动催：无视偏好，真的去弄一张新 Cookie 回来
    script.renew = { ok: true, cookie: 'JSESSIONID=NEW', source: 'renewed' };
    const manual = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(manual.ok, true);
    assert.equal(browser.calls.renew, 1);
    assert.equal(manual.session.browserOptOut, false, '手动催过之后偏好要清掉，心跳才能继续保活');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.cookie, 'JSESSIONID=NEW');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 在**已经存在的数据目录**上再起一个 handler。
 *
 * 用来模拟「DSH 重启」：详情那份三分钟内存缓存跟着上一个 handler 一起没了，
 * 于是下一次点开必须真的去打平台 —— 落盘缓存该在这时候顶上来。
 */
async function startHandlerOn(dir, options = {}) {
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} }, ...options });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}${API_PREFIX}`,
    handler,
    close: async () => { await new Promise((resolve) => server.close(resolve)); },
  };
}

/** 详情用例共用的平台响应：`up=false` 时给一张登录超时页（等价于 Cookie 过期）。 */
function detailPlatform(out, { up }) {
  const page = (body) => ({ status: 200, ok: true, url: '', headers: new Map(), text: async () => body, json: async () => null });
  const detailPage = '<html><span id="userid">2025000000</span>'
    + '<div class="ttee">作业内容及要求：</div>'
    + '<div class="list"><div class="fl left">作业标题</div><div class="right"><p>HW3</p></div></div>'
    + '<div class="list"><div class="fl left">截止日期(GMT+8)</div><div class="right">2026-10-16 00:00</div></div>';
  return async (url, init = {}) => {
    const href = String(url);
    if (!href.startsWith('https://learn.tsinghua.edu.cn')) return out.realFetch(url, init);
    out.hits.push(href.slice(href.indexOf('/f/wlxt')));
    if (!up()) return page('<html><title>登录超时</title></html>');
    return page(detailPage);
  };
}

const DETAIL_CONFIG_FIXTURE = {
  version: 1,
  cookie: 'JSESSIONID=SECRET-VALUE; XSRF-TOKEN=tok',
  manual: {},
  courses: [{ wlkcid: 'W-DS', name: '数据结构', courseId: 'c_ds', matched: true, how: 'exact', candidates: [] }],
  semesterId: '2026-2027-1',
  semesters: ['2026-2027-1'],
  updatedAt: '2026-10-10T00:00:00.000Z',
};

/**
 * 详情能拉到就顺手存一份；等 Cookie 死了、平台再也拉不动时，
 * 上次那份原文（老师的要求、附件、成绩、评语）还得还给界面。
 *
 * 这是「红字一直挂着」那个投诉的正面对策：会话可以掉，看过的东西不该跟着消失。
 */
test('网络学堂：详情拉到就落盘；之后 Cookie 失效仍把上次那份还给界面（标注是旧的）', async () => {
  const dir = await makeTempDir('study-assistant-detail-cache-');
  const realFetch = globalThis.fetch;
  const hits = [];
  let up = true;
  const browser = fakeLearnBrowser({ edgeAvailable: false });
  let phase = await startHandlerOn(dir, { learnBrowser: browser });
  try {
    await fs.writeFile(path.join(dir, '网络学堂.json'), JSON.stringify(DETAIL_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = detailPlatform({ realFetch, hits }, { up: () => up });

    const made = await jsonRequest(`${phase.baseUrl}/mutate`, {
      doc: 'tasks', action: 'create',
      item: { title: 'HW3', kind: 'homework', due: '2026-10-16 00:00', courseId: 'c_ds', note: '[learn:xszyid:abc]' },
    });
    assert.equal(made.status, 200);
    const taskId = (await (await fetch(`${phase.baseUrl}/state?doc=tasks`)).json()).doc.tasks[0].id;

    const first = await (await fetch(`${phase.baseUrl}/learn/detail?taskId=${taskId}`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.detail.title, 'HW3');
    assert.equal(first.detail.due, '2026-10-16 00:00');

    // 落盘了没：缓存文件得真在，形状够界面用
    const stored = JSON.parse(await fs.readFile(path.join(dir, '任务详情.json'), 'utf8'));
    assert.equal(stored.items[taskId].detail.title, 'HW3');
    assert.equal(stored.items[taskId].courseName, '数据结构');
    assert.ok(Number.isFinite(Date.parse(stored.items[taskId].fetchedAt)));

    // 「重启」：新 handler（内存缓存清零）+ 平台已经拉不动了
    await phase.close();
    up = false;
    hits.length = 0;
    phase = await startHandlerOn(dir, { learnBrowser: fakeLearnBrowser({ edgeAvailable: false }) });

    const second = await (await fetch(`${phase.baseUrl}/learn/detail?taskId=${taskId}`)).json();
    assert.ok(hits.length >= 1, '这一轮必须真的去打过平台，否则「拉不到」是假的');
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.stale, true, '界面要能据此说明这是上次存下来的');
    assert.equal(second.detail.title, 'HW3');
    assert.equal(second.wlkcid, 'W-DS');
    assert.equal(second.courseName, '数据结构');
    assert.ok(Number.isFinite(Date.parse(second.fetchedAt)));
    assert.equal(second.local.title, 'HW3', '本地字段仍然一起给，界面照旧能显示');
  } finally {
    globalThis.fetch = realFetch;
    await phase.close();
    await removeTempDir(dir);
  }
});

test('网络学堂：没有缓存时拉不到就照实报错，不假装有详情', async () => {
  const dir = await makeTempDir('study-assistant-detail-cache-');
  const realFetch = globalThis.fetch;
  const hits = [];
  let phase = await startHandlerOn(dir, { learnBrowser: fakeLearnBrowser({ edgeAvailable: false }) });
  try {
    await fs.writeFile(path.join(dir, '网络学堂.json'), JSON.stringify(DETAIL_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = detailPlatform({ realFetch, hits }, { up: () => false });

    const made = await jsonRequest(`${phase.baseUrl}/mutate`, {
      doc: 'tasks', action: 'create',
      item: { title: 'HW4', kind: 'homework', due: '2026-10-20 00:00', courseId: 'c_ds', note: '[learn:xszyid:zzz]' },
    });
    assert.equal(made.status, 200);
    const taskId = (await (await fetch(`${phase.baseUrl}/state?doc=tasks`)).json()).doc.tasks[0].id;

    const got = await (await fetch(`${phase.baseUrl}/learn/detail?taskId=${taskId}`)).json();
    assert.equal(got.ok, false);
    assert.equal(got.error, 'cookie-invalid');
    assert.equal(got.detail, null);
    assert.equal(got.local.title, 'HW4');

    await assert.rejects(fs.access(path.join(dir, '任务详情.json')), '没拉到过就不该凭空造一份缓存');
  } finally {
    globalThis.fetch = realFetch;
    await phase.close();
    await removeTempDir(dir);
  }
});

/**
 * 2026-10-18 改：这里**不再关浏览器**。
 *
 * 旧实现「要人工登录就把浏览器关掉省内存」有个致命后果：那台浏览器是唯一持有
 * SSO「信任浏览器」票（`TSINGHUAUSERID`，一年有效）的人。关掉它 = 把自动续期的
 * 最后一条路也关掉，用户点「打开登录窗口」还得重新等它启动。
 */
test('网络学堂：要人工登录时不关浏览器（它是唯一持有「信任浏览器」票的人）', async () => {
  const browser = fakeLearnBrowser({
    running: true,
    renew: { ok: false, reason: 'needs-manual-login', detail: 'SSO 也过期了' },
    readCookie: { ok: false, reason: 'edge-idle' },
  });
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    // 票也死了（直连只看到登录页）：这种时候报红才是对的
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => '<html><title>登录超时</title></html>',
        json: async () => null,
      };
    };
    const result = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'needs-manual-login');
    assert.equal(browser.calls.stop, 0, '封条期间不许关浏览器：它一关，自动续期就彻底没路了');
    assert.equal(result.session.browser.running, true, '浏览器要留着，等用户去窗口里登');
    assert.equal(result.session.manualNeeded, true, '贴上封条（有冷却，不是永久）');
    assert.equal(result.session.alive, false);
    assert.equal(result.session.reason, 'needs-manual-login', '票真没了，才让人去登录窗口');
    const saved = JSON.parse(await fs.readFile(path.join(server.dir, '网络学堂.json'), 'utf8'));
    assert.equal(saved.cookie, LEARN_CONFIG_FIXTURE.cookie, '失败绝不动已存的票');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 「打开登录窗口」之后不该再让用户点第二下：这边自己盯着浏览器里的票，
 * 一换就验活、落盘。验活仍然是不变的铁律 —— 界面里的票不能靠猜。
 */
test('网络学堂：手动登录后自己把 Cookie 收下来，验活通过才落盘', async () => {
  const script = { running: true, readCookie: { ok: true, cookie: 'JSESSIONID=OLD; XSRF-TOKEN=tok' } };
  const browser = fakeLearnBrowser(script);
  const server = await startServer({ learnBrowser: browser });
  const configPath = path.join(server.dir, '网络学堂.json');
  const realFetch = globalThis.fetch;
  const hits = [];
  try {
    await fs.writeFile(configPath, JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      hits.push(sent);
      const alive = sent.includes('JSESSIONID=FRESH');
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => (alive ? '<html><span id="userid">x</span></html>' : '<html><title>登录超时</title></html>'),
        json: async () => null,
      };
    };

    const opened = await (await jsonRequest(`${server.baseUrl}/learn/login-window`, {})).json();
    assert.equal(opened.ok, true);
    assert.equal(browser.calls.openLoginWindow, 1);
    assert.equal(opened.session.loginHarvesting, true, '窗口一开就该盯着');
    assert.equal(opened.session.manualNeeded, false, '要人工登了，封条先撕掉');

    // 用户还没登完：浏览器里还是那张旧票 ⇒ unchanged，不写盘、不打平台
    const before = await server.handler.learn.harvestOnce();
    assert.equal(before.ok, false);
    assert.equal(before.reason, 'unchanged');
    assert.equal(hits.length, 0, '同一张票不值当再验一次');
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).cookie, LEARN_CONFIG_FIXTURE.cookie);

    // 用户登完了：浏览器里换了新票
    script.readCookie = { ok: true, cookie: 'JSESSIONID=FRESH; XSRF-TOKEN=tok2' };
    const got = await server.handler.learn.harvestOnce();
    assert.equal(got.ok, true);
    assert.equal(got.source, 'manual-login');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.cookie, 'JSESSIONID=FRESH; XSRF-TOKEN=tok2');
    assert.equal(saved.semesterId, LEARN_CONFIG_FIXTURE.semesterId, '只换票，别的字段一个都不许动');

    const status = await (await fetch(`${server.baseUrl}/learn/status`)).json();
    assert.equal(status.session.alive, true);
    assert.equal(status.session.reason, 'renewed');
    assert.equal(status.session.manualNeeded, false);
    assert.equal(status.session.loginHarvesting, false, '收到票就停止盯着');
    assert.equal(status.session.lastSsoTouch, null, '这条路上没碰过浏览器续期，不该有喂 SSO 的记录');
    assert.ok(!JSON.stringify(status).includes('JSESSIONID'), '会话状态仍然不许带 Cookie');

    // 浏览器已经被关掉（或压根没起来）时不许假装作数
    script.running = false;
    const orphan = await server.handler.learn.harvestOnce();
    assert.equal(orphan.ok, false);
    assert.equal(orphan.reason, 'browser-not-running');
  } finally {
    server.handler.learn.stopHarvest('test');
    globalThis.fetch = realFetch;
    await server.close();
  }
});

test('网络学堂：等你手动登录的这段时间，心跳不去动浏览器（免得把登录窗口关掉）', async () => {
  const script = { running: true, readCookie: { ok: true, cookie: LEARN_CONFIG_FIXTURE.cookie } };
  const browser = fakeLearnBrowser(script);
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => '<html><title>登录超时</title></html>',
        json: async () => null,
      };
    };

    const opened = await (await jsonRequest(`${server.baseUrl}/learn/login-window`, {})).json();
    assert.equal(opened.session.loginHarvesting, true);

    // 心跳这一轮：可以直连问一句会话怎么样，但不许碰那个正在被使用的浏览器
    const beat = await server.handler.learn.checkNow('timer');
    assert.equal(browser.calls.renew, 0, '人在登着的时候去续期，会把那个窗口一起关掉');
    assert.equal(beat.loginHarvesting, true);
    assert.equal(beat.alive, false);
    assert.equal(beat.reason, 'cookie-invalid', '直连这把尺子照旧，如实说会话现在还不能用');

    // 例外：他本人按「立即续期」时仍然去试（只是这张票验不过，如实报错）
    const manual = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(browser.calls.renew, 1);
    assert.equal(manual.ok, false);
    assert.equal(manual.error, 'cookie-invalid');
  } finally {
    server.handler.learn.stopHarvest('test');
    globalThis.fetch = realFetch;
    await server.close();
  }
});

/**
 * 票还活着、只是浏览器那条喂不动 SSO 时，**不许报红**。
 *
 * 2026-10-12 的真机教训：清华 SSO 的登录态 20 分钟左右就掉，但那张票在学堂服务端
 * 还活得好好的（直连一问就是 `id="userid"`）。以前这里封条一贴就直接判红，
 * 于是每 20 分钟误报一次「Cookie 失效」—— 用户抱怨了好几天的就是它。
 */
test('网络学堂：浏览器那条喂不动 SSO、但票还活着时，会话照旧算有效（cookie-only）', async () => {
  const browser = fakeLearnBrowser({
    running: true,
    renew: { ok: false, reason: 'needs-manual-login', detail: 'SSO 表单又出来了' },
  });
  const server = await startServer({ learnBrowser: browser });
  const realFetch = globalThis.fetch;
  let ticketAlive = true;
  try {
    await fs.writeFile(path.join(server.dir, '网络学堂.json'), JSON.stringify(LEARN_CONFIG_FIXTURE), 'utf8');
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (!href.startsWith('https://learn.tsinghua.edu.cn')) return realFetch(url, init);
      const sent = String(init.headers?.Cookie ?? init.headers?.cookie ?? '');
      const alive = ticketAlive === true && sent.includes('JSESSIONID=OLD');
      return {
        status: 200, ok: true, url: href, headers: new Map(),
        text: async () => (alive ? '<html><span id="userid">x</span></html>' : '<html><title>登录超时</title></html>'),
        json: async () => null,
      };
    };

    const beat = await server.handler.learn.checkNow('timer');
    assert.equal(browser.calls.renew, 1, '心跳仍然会试一次浏览器 —— 喂 SSO 是它的本职');
    assert.equal(beat.alive, true, '票是好的，不许报红');
    assert.equal(beat.reason, 'cookie-only', '如实说：能用，只是走了直连');
    assert.equal(beat.manualNeeded, true, '封条照贴：浏览器那条要人工登录一次');

    const again = await server.handler.learn.checkNow('timer');
    assert.equal(browser.calls.renew, 1, '封条期间不许再弹浏览器（别再白占几百 MB）');
    assert.equal(again.alive, true, '封条不等于会话死了');
    assert.equal(again.reason, 'cookie-only');

    ticketAlive = false;
    const dead = await server.handler.learn.checkNow('timer');
    assert.equal(dead.alive, false, '票也没了才轮到红字');
    assert.equal(dead.reason, 'needs-manual-login', '这时候才该让人去点「打开登录窗口」');

    // 他本人按「立即续期」：照样试一次浏览器；失败照实报错，但会话死活仍由直连说了算
    const manual = await (await jsonRequest(`${server.baseUrl}/learn/renew`, {})).json();
    assert.equal(browser.calls.renew, 2, '他手动催了就得试');
    assert.equal(manual.ok, false);
    assert.equal(manual.error, 'needs-manual-login');
    assert.equal(manual.session.alive, false);
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

