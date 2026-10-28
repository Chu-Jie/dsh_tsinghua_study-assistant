/**
 * 讲解接口（`GET/POST /knowledge/explain`）的往返测试。
 *
 * 模型调用用假 `complete`：这里验的是「缓存命中/未命中」「三档指令怎么拼」
 * 「错误码」，不是模型写得好不好（那要靠真跑的探针，见 NEXT.md）。
 *
 * 契约（实现见 `lib/api.js` 的 handleKnowledgeExplainGet/Post）：
 * - POST 体 `{ node, style }`，必须带 `X-Study-Request`；`complete` 回 `{ok, text}`。
 * - GET `?node=&style=` 读缓存；只给 `node` 时列已生成的档位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-explain-');
  const store = createStore(dir);
  await store.init();
  const { workspaceRoot: workspaceRootOption, ...rest } = options;
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    // `workspaceRoot: true` = 让工作区根就是临时目录（测试要落「相对工作区根」的页文件）
    ...(workspaceRootOption === true ? { workspaceRoot: dir } : {}),
    ...rest,
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
    item: { name: '节点电压法', courseId: 'c_digital', chapter: '第 2 章', mastery: 1, ...extra },
  });
  assert.equal(response.status, 200);
  const state = await (await fetch(`${server.baseUrl}/state?doc=knowledgeNetwork`)).json();
  const nodes = Array.isArray(state?.doc?.nodes) ? state.doc.nodes : [];
  const created = nodes[nodes.length - 1];
  assert.equal(typeof created?.id, 'string', '节点必须真的落盘了');
  return created.id;
}

test('讲解：没生成过时 GET 回 404，POST 生成一次后 GET 命中同一份缓存', async () => {
  const calls = [];
  const server = await startServer({
    complete: async (request) => {
      calls.push(request);
      return { ok: true, text: '\n## 一句话定义\n用节点电压法列方程。\n' };
    },
  });
  try {
    const id = await makeNode(server);
    assert.equal(typeof id, 'string', '节点建出来了才谈得上讲解');

    const miss = await fetch(`${server.baseUrl}/knowledge/explain?node=${id}&style=assistant`);
    assert.equal(miss.status, 404);
    const missBody = await miss.json();
    assert.equal(missBody.ok, false);
    assert.equal(missBody.error, 'not-generated');
    assert.equal(calls.length, 0, '只是看一眼缓存，不该调模型');

    const created = await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'assistant' });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.cached, false);
    assert.equal(createdBody.styleLabel, '助教推导');
    assert.ok(createdBody.text.includes('用节点电压法列方程'));
    assert.ok(createdBody.file.startsWith('讲解缓存/'));
    assert.ok(createdBody.file.endsWith(`/${id}-assistant.md`));
    assert.equal(calls.length, 1);
    // 指令是那一档的原文，且知识点名被填进去
    assert.ok(calls[0].prompt.startsWith('你是这门课的助教。针对「节点电压法」，只用资料里的内容，分步推导：'));
    assert.equal(calls[0].maxTokens, 1800);
    assert.equal(calls[0].timeoutMs, 180000);

    // 磁盘上确实有一份带头的缓存（任务单要求写「知识点/风格/生成时间/笔记本」）
    const cacheFile = path.join(server.dir, '讲解缓存', `${id}-assistant.md`);
    const raw = await fs.readFile(cacheFile, 'utf8');
    assert.ok(raw.startsWith('---\n知识点: 节点电压法\n'));
    assert.ok(raw.includes('风格: 助教推导'));
    assert.ok(raw.includes('笔记本: 宿主内模型'));

    const hit = await fetch(`${server.baseUrl}/knowledge/explain?node=${id}&style=assistant`);
    assert.equal(hit.status, 200);
    const hitBody = await hit.json();
    assert.equal(hitBody.ok, true);
    assert.equal(hitBody.cached, true);
    assert.equal(hitBody.meta['知识点'], '节点电压法');
    assert.ok(hitBody.text.includes('用节点电压法列方程'));
    assert.equal(calls.length, 1, '缓存命中不能再调模型');

    // 只给 node：列出已生成的档位
    const list = await (await fetch(`${server.baseUrl}/knowledge/explain?node=${id}`)).json();
    assert.equal(JSON.stringify(list.available.map((item) => item.style)), JSON.stringify(['assistant']));

    // 另一档是另一份缓存
    const exam = await (await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'exam' })).json();
    assert.equal(exam.ok, true);
    assert.equal(exam.cached, false);
    assert.equal(exam.styleLabel, '考前速通');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].prompt.includes('针对「节点电压法」，三分钟内能看完：'));

    // 不带 node：列全部已生成讲解（面板「讲解」视图用；同一条路由的第二种形态）
    const all = await (await fetch(`${server.baseUrl}/knowledge/explain`)).json();
    assert.equal(all.ok, true);
    assert.equal(all.dir, '讲解缓存');
    assert.equal(all.count, 2, '两个档位都该列出来');
    assert.equal(JSON.stringify(all.items.map((item) => item.style).sort()), JSON.stringify(['assistant', 'exam']));
    assert.ok(all.items.every((item) => item.node === id && item.name === '节点电压法' && item.stale === false));
    assert.ok(all.items.every((item) => item.chars > 0), '每条都要有字数，面板好估长');
    assert.ok(all.items.every((item) => item.generatedAt !== '' && item.model !== ''), '生成时间与模型要能读出来');
    assert.ok(all.items.every((item) => item.file.startsWith('讲解缓存/')), '要回缓存相对路径，方便去磁盘找');
  } finally {
    await server.close();
  }
});

test('讲解：资料片段取自题目正文，能跟上来源与页号', async () => {
  const prompts = [];
  const server = await startServer({
    // 资料页文件按「相对工作区根」解析；测试里让工作区根就是临时目录，好落页文件
    workspaceRoot: true,
    complete: async (request) => {
      prompts.push(request.prompt);
      return { ok: true, text: '第一版回答' };
    },
  });
  try {
    // 证据里只存题目 id，正文要回查 题目.json
    const questions = await server.store.readDocument('questions');
    questions.doc.questions = [
      {
        id: 'q_dg_1',
        courseId: 'c_digital',
        sourceFile: '数电/作业/第01次作业_原题.pdf',
        no: '1.1',
        prompt: '如图所示的电路，求各节点的电压。（节点电压法的基本用法）',
        page: 1,
        kind: 'homework',
        knowledgeNames: ['节点电压法'],
      },
    ];
    await server.store.writeDocument('questions', questions.doc, { expectedHash: questions.hash });

    // 这道题所在作业页的取字原文：讲解要「只用资料里的内容」，题干之外的上下文靠它
    const materials = await server.store.readDocument('materials');
    materials.doc.files = [
      {
        path: '数电/作业/第01次作业_原题.pdf',
        courseId: 'c_digital',
        kind: 'homework',
        textLayer: false,
        text: null,
        ocr: { done: true, pages: 1, outDir: '数电/作业/第01次作业_OCR文本' },
      },
    ];
    await server.store.writeDocument('materials', materials.doc, { expectedHash: materials.hash });
    const pageDir = path.join(server.dir, '数电', '作业', '第01次作业_OCR文本');
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(
      path.join(pageDir, 'tier-gemini-page01.md'),
      '## 第 1 页\n\n节点电压法：对每个独立节点列 KCL 方程，参考节点取电位为零。\n',
      'utf8',
    );

    const id = await makeNode(server, { evidence: [{ type: 'question', id: 'q_dg_1' }] });
    const body = await (await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'hint' })).json();
    assert.equal(body.ok, true);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('【资料片段】'));
    assert.ok(prompts[0].includes('题目 1.1'));
    assert.ok(prompts[0].includes('数电/作业/第01次作业_原题.pdf'));
    assert.ok(prompts[0].includes('第 1 页'));
    assert.ok(prompts[0].includes('节点电压法的基本用法'));
    assert.ok(prompts[0].includes('（原文）'), '题目所在页的取字原文也要带上');
    assert.ok(prompts[0].includes('对每个独立节点列 KCL 方程'));
    assert.ok(prompts[0].includes('不要给答案'));
    assert.equal(body.evidence.used, 2, '题干 + 所在页原文 = 两条片段');

    // 再生成同一档：直接命中缓存，不重复调模型
    const again = await (await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'hint' })).json();
    assert.equal(again.cached, true);
    assert.equal(prompts.length, 1);
  } finally {
    await server.close();
  }
});

test('讲解：证据缺失时不让模型瞎编，并要求说「资料未覆盖」', async () => {
  let prompt = '';
  const server = await startServer({
    complete: async (request) => {
      prompt = request.prompt;
      return { ok: true, text: '资料未覆盖。' };
    },
  });
  try {
    const id = await makeNode(server); // 没有 evidence
    const body = await (await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'exam' })).json();
    assert.equal(body.ok, true);
    assert.ok(prompt.includes('资料未覆盖'));
    assert.ok(!prompt.includes('【资料片段】'));
    assert.equal(body.evidence.used, 0);
  } finally {
    await server.close();
  }
});

test('讲解：参数与错误码（缺 node / 认不出的档 / 节点不存在 / 模型报错 / 没挂模型）', async () => {
  const server = await startServer({
    complete: async () => ({ ok: false, error: 'rate-limit', detail: '429 too many requests' }),
  });
  try {
    assert.equal((await postJson(`${server.baseUrl}/knowledge/explain`, { style: 'assistant' }, true)).status, 400);
    assert.equal((await fetch(`${server.baseUrl}/knowledge/explain?style=assistant`)).status, 400);
    assert.equal((await (await fetch(`${server.baseUrl}/knowledge/explain?style=assistant`)).json()).error, 'missing-node');

    // 写请求必须带自定义头（与 /mutate 同一套 CSRF 防护）
    const noHeader = await postJson(`${server.baseUrl}/knowledge/explain`, { node: 'k_any', style: 'exam' }, false);
    assert.equal(noHeader.status, 403);

    const id = await makeNode(server);
    const badStyle = await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'nope' });
    assert.equal(badStyle.status, 400);
    assert.equal((await badStyle.json()).error, 'bad-style');
    const badStyleGet = await (await fetch(`${server.baseUrl}/knowledge/explain?node=${id}&style=nope`)).json();
    assert.equal(badStyleGet.error, 'bad-style');

    const missingNode = await postJson(`${server.baseUrl}/knowledge/explain`, { node: 'k_nobody', style: 'exam' });
    assert.equal(missingNode.status, 404);
    assert.equal((await missingNode.json()).error, 'node-missing');

    const boom = await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'exam' });
    assert.equal(boom.status, 502);
    const boomBody = await boom.json();
    assert.equal(boomBody.ok, false);
    assert.equal(boomBody.error, 'llm-rate-limit');
    assert.ok(String(boomBody.detail).includes('429'));
  } finally {
    await server.close();
  }
});

test('讲解：没注入 complete() 时回 503，不静默假装成功', async () => {
  const server = await startServer();
  try {
    const id = await makeNode(server);
    const response = await postJson(`${server.baseUrl}/knowledge/explain`, { node: id, style: 'hint' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'llm-unavailable');
  } finally {
    await server.close();
  }
});
