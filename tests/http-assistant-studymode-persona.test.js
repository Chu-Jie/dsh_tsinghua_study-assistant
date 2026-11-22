/**
 * 专注学习模式「学习搭子」人设（v2-E 卡，2026-11-22）测试。
 * 运行：npm test
 *
 * 对着任务卡 ⑥ 的五条逐条落：
 *   1. `context.studyMode === true` + 有身份 → system 含人设锚点「学习搭子」且含【用户画像】。
 *   2. 不带 `studyMode`（或 false）→ system 不含人设锚点，且与 v2-D 现状逐字一致。
 *   3. 人设 + 画像 + 界面提示共存 → 只有一条 system，顺序为 画像 → 人设 → 界面。
 *   4. `buildStudyModePersona` 纯函数：`{}` / `null` / `{studyMode:false}` → 空串；`{studyMode:true}` → 文案。
 *   5. 人设文案不进响应体（响应仍只有 `{ok, reply}`）、不进日志。
 *
 * 另加前端源码级断言（卡 ⑥ 最后一条 + ③ 证据区挪末尾）：
 *   - 证据块在 `analysisBlock` 之后、`markError` 之前；
 *   - 顶部「有 N 条依据…」说明行已不存在，`pill('未验证')` 仍在；
 *   - `studyModeMemory` 只在进入专注处置真，其余调用点全部置假。
 *
 * 所有 HTTP 用例都不真打网络：统一注入 `deps.assistantChat` 桩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { DOC_VERSION } from '../lib/core.js';
import { API_PREFIX, REQUEST_HEADER, createApiHandler } from '../lib/api.js';
import { STUDY_TUTOR_PERSONA, buildStudyModePersona } from '../lib/assistant-persona.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 测试身份：占位姓名 + 假学号（真名/真学号绝不进仓库）。 */
const STUDENT_NAME = '示例同学';
const STUDENT_ID = '2025000000';
const TERM_NAME = '2026 秋（大二上）';
const COURSE_NAME = '大学物理B(2)';
const NODE_ID = 'k_charge';
const NODE_NAME = '电荷守恒与相对论不变性';
/** 人设锚点：只取「学习搭子」四个字，避免测试与文案微调死绑。 */
const PERSONA_ANCHOR = '学习搭子';
/** 画像锚点（v2-D 现状）。 */
const PERSONA_HINT_ANCHOR = '【用户画像】';
/** 界面提示锚点（v2-A 现状）。 */
const CONTEXT_HINT_ANCHOR = '【当前界面】';

function knowledgeNode(id, name, mastery) {
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
  };
}

/** 种一份足够撑起画像的「学习台」：学期 / 课程 / 知识点网络。 */
async function seedLearningData(store) {
  await store.writeDocument('term', {
    version: DOC_VERSION,
    terms: [{ id: 't_2026f', name: TERM_NAME, startDate: '2026-09-01', endDate: '2026-12-20', totalWeeks: 16, isCurrent: true }],
    currentId: 't_2026f',
    updatedAt: null,
  });
  await store.writeDocument('courses', {
    version: DOC_VERSION,
    courses: [{ id: 'c_phy', name: COURSE_NAME, sessions: [] }],
    updatedAt: null,
  });
  await store.writeDocument('knowledgeNetwork', {
    version: DOC_VERSION,
    nodes: [
      knowledgeNode(NODE_ID, NODE_NAME, 1),
      knowledgeNode('k_gauss', '高斯定理', 2),
    ],
    edges: [],
    updatedAt: null,
  });
}

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-studymode-');
  const store = createStore(dir);
  await store.init();
  if (options.seed !== false) await seedLearningData(store);

  const calls = [];
  const warns = [];
  const deps = {
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: {
      error() {},
      info() {},
      warn(...args) { warns.push(args.map((item) => String(item)).join(' ')); },
    },
    assistantChat: async (input) => {
      calls.push(input);
      return { content: '好的，先说直觉，再给推导。' };
    },
  };
  if (options.identity !== false) {
    deps.studentName = STUDENT_NAME;
    deps.studentId = STUDENT_ID;
  }
  const handler = createApiHandler(deps);
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
    calls,
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

// ---------------------------------------------------------------------------
// 一、纯函数（卡 ⑥.4）
// ---------------------------------------------------------------------------

test('buildStudyModePersona：只有 studyMode === true 才返回文案，其余一律空串', () => {
  assert.equal(buildStudyModePersona({ studyMode: true }), STUDY_TUTOR_PERSONA);
  assert.equal(buildStudyModePersona({}), '');
  assert.equal(buildStudyModePersona(null), '');
  assert.equal(buildStudyModePersona(undefined), '');
  assert.equal(buildStudyModePersona({ studyMode: false }), '');
  assert.equal(buildStudyModePersona({ studyMode: 'true' }), '', '字符串 "true" 不算真值');
  assert.equal(buildStudyModePersona({ studyMode: 1 }), '', '数字 1 不算真值');
  assert.equal(buildStudyModePersona('studyMode'), '');
});

test('STUDY_TUTOR_PERSONA：五段齐全、含五个小标题、无学号占位', () => {
  for (const tag of ['【身份】', '【怎么讲】', '【语气】', '【收尾】', '【边界】']) {
    assert.equal(STUDY_TUTOR_PERSONA.includes(tag), true, `人设文案缺 ${tag}`);
  }
  assert.equal(STUDY_TUTOR_PERSONA.includes(PERSONA_ANCHOR), true);
  assert.equal(STUDY_TUTOR_PERSONA.includes(STUDENT_ID), false);
  assert.equal(STUDY_TUTOR_PERSONA.split('\n').length, 5);
});

// ---------------------------------------------------------------------------
// 二、HTTP 链路
// ---------------------------------------------------------------------------

test('studyMode=true + 有身份：system 含「学习搭子」人设，且仍含【用户画像】', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '这条守恒式怎么记？' }],
      context: { tab: 'knowledge', nodeId: NODE_ID, nodeTitle: NODE_NAME, studyMode: true },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'reply'], '响应里不许冒出新字段');

    const sent = server.calls[0].messages;
    assert.equal(sent.filter((item) => item.role === 'system').length, 1, '只允许一条 system');
    const system = sent[0].content;
    assert.equal(system.includes(PERSONA_ANCHOR), true, '专注模式要带人设');
    assert.equal(system.includes(PERSONA_HINT_ANCHOR), true, '画像照旧在');
    assert.equal(system.includes(CONTEXT_HINT_ANCHOR), true, '界面提示照旧在');
  } finally {
    await server.close();
  }
});

test('不带 studyMode（或 false）：system 不含人设，且与 v2-D 现状逐字一致', async () => {
  const server = await startServer();
  try {
    const messages = [{ role: 'user', content: '这条守恒式怎么记？' }];
    const baseContext = { tab: 'knowledge', nodeId: NODE_ID, nodeTitle: NODE_NAME };

    const plain = await jsonRequest(`${server.baseUrl}/assistant/reply`, { messages, context: baseContext });
    const explicitFalse = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages,
      context: { ...baseContext, studyMode: false },
    });
    const onStudy = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages,
      context: { ...baseContext, studyMode: true },
    });
    assert.equal(plain.status, 200);
    assert.equal(explicitFalse.status, 200);
    assert.equal(onStudy.status, 200);

    const plainSystem = server.calls[0].messages[0].content;
    const falseSystem = server.calls[1].messages[0].content;
    const studySystem = server.calls[2].messages[0].content;

    assert.equal(plainSystem.includes(PERSONA_ANCHOR), false, '非专注不许带人设');
    assert.deepEqual(server.calls[1].messages, server.calls[0].messages, 'studyMode:false 必须与不带逐字一致');
    assert.equal(plainSystem.startsWith(PERSONA_HINT_ANCHOR), true, 'v2-D 现状：画像在最前');

    // 逐字一致的最强证明：把专注模式那条里的人设段摘掉，剩下的必须与非专注完全相同
    const stripped = studySystem.replace(`${STUDY_TUTOR_PERSONA}\n`, '');
    assert.equal(stripped, plainSystem, '去掉人设段后必须与 v2-D 逐字一致');
  } finally {
    await server.close();
  }
});

test('画像 + 人设 + 界面提示共存：只有一条 system，顺序为 画像 → 人设 → 界面', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '这一页怎么读？' }],
      context: { tab: 'knowledge', nodeId: NODE_ID, nodeTitle: NODE_NAME, studyMode: true },
    });
    assert.equal(response.status, 200);
    const sent = server.calls[0].messages;
    assert.equal(sent.filter((item) => item.role === 'system').length, 1);
    assert.equal(sent.length, 2);
    const system = sent[0].content;
    const atPersona = system.indexOf(PERSONA_HINT_ANCHOR);
    const atTutor = system.indexOf(PERSONA_ANCHOR);
    const atContext = system.indexOf(CONTEXT_HINT_ANCHOR);
    assert.equal(atPersona, 0, '画像在最前');
    assert.equal(atTutor > atPersona, true, '人设在画像之后');
    assert.equal(atContext > atTutor, true, '界面提示在人设之后');
    assert.equal(system.includes('页签=知识点'), true);
  } finally {
    await server.close();
  }
});

test('studyMode 不是布尔 true 时后端归一丢弃：字符串 "true" 也不套人设', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '问一句' }],
      context: { tab: 'knowledge', nodeId: NODE_ID, studyMode: 'true' },
    });
    assert.equal(response.status, 200);
    assert.equal(server.calls[0].messages[0].content.includes(PERSONA_ANCHOR), false);
  } finally {
    await server.close();
  }
});

test('人设不进响应体、不进日志：响应仍只有 {ok, reply}', async () => {
  const server = await startServer();
  try {
    const response = await jsonRequest(`${server.baseUrl}/assistant/reply`, {
      messages: [{ role: 'user', content: '问一句' }],
      context: { tab: 'knowledge', nodeId: NODE_ID, studyMode: true },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(PERSONA_ANCHOR), false, '人设不许外显到响应');
    assert.equal(text.includes(PERSONA_HINT_ANCHOR), false, '画像也不许外显');
    assert.equal(server.warns.join('\n').includes(PERSONA_ANCHOR), false, '日志里不打人设');
    assert.equal(server.warns.join('\n').includes(PERSONA_HINT_ANCHOR), false, '日志里不打画像');
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['ok', 'reply']);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 三、前端源码级（卡 ③ 证据区挪末尾 + 卡 ④ 专注标志）
// ---------------------------------------------------------------------------

const CLIENT_FILES = ['client.full.js', 'client.js'];

test('证据块已挪到 analysisBlock 之后、markError 之前，且顶部「有 N 条依据」说明行已删除', async () => {
  for (const file of CLIENT_FILES) {
    const source = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const atAnalysis = source.indexOf('\n        analysisBlock,');
    const atEvidence = source.indexOf("evidenceRows(selectedNode.evidence, 'sel').length === 0");
    const atMarkError = source.indexOf("markError === '' ? null : h('div', { className: 'sa-error'");
    assert.ok(atAnalysis > 0, `${file} 找不到 analysisBlock 位置`);
    assert.ok(atEvidence > 0, `${file} 找不到证据块`);
    assert.ok(atMarkError > 0, `${file} 找不到 markError 位置`);
    assert.equal(atEvidence > atAnalysis, true, `${file} 证据块必须在 analysisBlock 之后`);
    assert.equal(atEvidence < atMarkError, true, `${file} 证据块必须在 markError 之前（详情卡最后一块）`);

    assert.equal(source.includes("'证据'"), true, `${file} 证据块标题必须保留`);
    assert.equal(source.includes('条依据（题目'), false, `${file} 顶部「有 N 条依据…」说明行必须删掉`);
    assert.equal(source.includes('还没有任何题目或资料页支持它'), false, `${file} 空证据说明行也必须删掉`);
    assert.equal(source.includes("pill('未验证', 'soon')"), true, `${file} 未验证徽标必须保留`);
  }
});

test('studyModeMemory：模块级声明，只有进入专注处置真，其余 setFocusReading(false) 全部同步置假', async () => {
  for (const file of CLIENT_FILES) {
    const source = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(/let studyModeMemory = false;/.test(source), true, `${file} 要有模块级 studyModeMemory`);
    assert.equal((source.match(/studyModeMemory = true;/g) ?? []).length, 1, `${file} 置真只能有一处`);
    assert.equal((source.match(/studyModeMemory = false;/g) ?? []).length >= 4, true, `${file} 各退出点都要置假`);

    // setFocusReading( 的所有调用点：置真那处旁边必须有 studyModeMemory = true，置假那处必须置假
    const calls = source.match(/setFocusReading\([^)]*\)/g) ?? [];
    const trues = calls.filter((item) => item.includes('true'));
    assert.equal(trues.length, 1, `${file} 只有 enterFocusReading 一处 setFocusReading(true)`);
    const enterBlock = source.slice(source.indexOf(trues[0]) - 120, source.indexOf(trues[0]) + 120);
    assert.equal(enterBlock.includes('studyModeMemory = true;'), true, `${file} 进入专注必须同步置真`);

    // buildAssistantContext：只在真值时才写字段
    assert.equal(source.includes('if (studyModeMemory === true) context.studyMode = true;'), true,
      `${file} buildAssistantContext 要按 studyModeMemory 带 studyMode`);
  }
});
