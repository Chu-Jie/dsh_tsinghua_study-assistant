// 学习记录 + 交互助手（P3，2026-10-30）的源码级钉子与纯函数用例。
//
// 这里不启动 HTTP，也不联网：只钉「接口/落点/边界」这些容易在后续重构里被悄悄改掉的结构，
// 加两条 buildChatPrompt 的上下文拼接（注入段只在显式带 context 时出现，且标明截断字数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChatPrompt, CHAT_SYSTEM_ROLE, EVIDENCE_MAX_CHARS } from '../lib/knowledge-explain.js';
import { CONTEXT_MAX_CHARS, clipContext, normalizeScope } from '../lib/study-log.js';
import { DOC_KEYS } from '../lib/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const API = fs.readFileSync(path.join(HERE, '..', 'lib', 'api.js'), 'utf8');
const STUDY_LOG = fs.readFileSync(path.join(HERE, '..', 'lib', 'study-log.js'), 'utf8');

test('学习记录面板（P3）：新页签「记录」已挂上', () => {
  assert.ok(CLIENT.includes("records: '记录'"), 'TEXT.tabs 要有 records');
  assert.ok(CLIENT.includes("['records', TEXT.tabs.records]"), 'tabDefs 要列出记录页');
  assert.ok(CLIENT.includes('function RecordsTab('), '要有 RecordsTab 组件');
  assert.ok(CLIENT.includes("} else if (tab === 'records')"), 'body 分派要认 records');
  assert.ok(CLIENT.includes('h(RecordsTab, {'), '要真正渲染 RecordsTab');
});

test('对话与阅读位置（P3）：客户端调对接口', () => {
  assert.ok(CLIENT.includes('`${API}/study-log'), '时间线走 GET /study-log');
  assert.ok(CLIENT.includes('`${API}/assistant/chat`'), '聊天走 POST /assistant/chat');
  assert.ok(CLIENT.includes('`${API}/reading-position`'), '阅读位置走 POST /reading-position');
  assert.ok(CLIENT.includes('`${API}/study-log/delete`'), '删对话走 POST /study-log/delete');
  assert.ok(CLIENT.includes("scopeType: 'material'"), '资料阅读位置要带 scopeType=material');
});

test('手动注入当前阅读段落：默认不发，只有点按钮才带 context', () => {
  assert.ok(CLIENT.includes('让助手读当前阅读段落'), '要有显式注入按钮');
  assert.ok(CLIENT.includes('if (inject && log?.readingPosition)'), '只有勾选（inject）时才拼 context');
  assert.ok(CLIENT.includes("payload.context = { type: 'material'"), '注入的是一个 material 上下文，不是正文乱塞');
  assert.ok(CLIENT.includes('只读了前'), '超长要显示「只读了前 N 字」');
});

test('批注/对话不回流：证据只来自节点资料，学习记录不进 /state', () => {
  // 后端聊天只从当前节点收集证据（collectExplainEvidence），不读 annotations/对话
  assert.ok(API.includes('const evidence = await collectExplainEvidence(node);'), '节点会话证据来自 collectExplainEvidence');
  assert.ok(!/readDocument\('annotations'\)[\s\S]{0,80}buildEvidenceDigest/.test(API), '批注不能直接进聊天证据');
  // 学习记录旁挂目录，不能混进 DOC_KEYS（不进 /state、不进备份）
  assert.ok(DOC_KEYS.includes('annotations'), '批注确实是第 12 份文档（A2 已立）');
  assert.ok(DOC_KEYS.length === 13, 'DOC_KEYS 现为 13 份（批注 + 知识映射），学习记录没有混进来');
  assert.ok(DOC_KEYS.includes('knowledgeMap'), '知识映射是第 13 份文档（C0 已立）');
  assert.ok(!DOC_KEYS.some((key) => /studylog|studyLog|records|reading/i.test(key)), '学习记录不是主文档');
  assert.ok(!STUDY_LOG.includes('writeDocument'), '学习记录用原子写，不走 store.writeDocument');
});

test('服务端：/study-log、/assistant/chat、/reading-position、/study-log/delete 都已注册', () => {
  assert.ok(API.includes("if (rest === '/study-log')"), 'GET /study-log');
  assert.ok(API.includes("if (rest === '/assistant/chat')"), 'POST /assistant/chat');
  assert.ok(API.includes("if (rest === '/reading-position')"), 'POST /reading-position');
  assert.ok(API.includes("if (rest === '/study-log/delete')"), 'POST /study-log/delete');
  assert.ok(API.includes('function readMaterialContextSlice('), '要有服务端重读磁盘的片段读取');
  assert.ok(API.includes('buildChatPrompt({ name: name ==='), '聊天要经 buildChatPrompt 拼上下文');
});

test('buildChatPrompt：没有 context 时不出现【当前阅读段落】', () => {
  const prompt = buildChatPrompt({
    name: '戴维南定理',
    evidence: '【资料片段】原文 A',
    messages: [{ role: 'user', content: '这一步为什么这样' }],
  });
  assert.ok(prompt.includes('戴维南定理'));
  assert.ok(!prompt.includes('下面是学生此刻正在读的原文'), '默认不注入阅读段落正文块');
});

test('buildChatPrompt：显式 context 才出现阅读段落，并标注截断字数', () => {
  const prompt = buildChatPrompt({
    name: '戴维南定理',
    evidence: '【资料片段】原文 A',
    messages: [{ role: 'user', content: '继续说' }],
    context: { text: '正在读的原文片段', label: '数据结构/教材/第3章.md 第 2 页', truncated: true, chars: 6000 },
  });
  assert.ok(prompt.includes('下面是学生此刻正在读的原文'), '有 context 才有阅读段落正文块');
  assert.ok(prompt.includes('正在读的原文片段'));
  assert.ok(prompt.includes('只读了前 6000 字'), '超长要标只读了前 N 字');
  assert.ok(prompt.includes('数据结构/教材/第3章.md 第 2 页'), '要带来源');
});

test('CHAT_SYSTEM_ROLE 要求把当前阅读段落与资料片段同等对待', () => {
  assert.ok(CHAT_SYSTEM_ROLE.includes('【当前阅读段落】'));
  assert.ok(CHAT_SYSTEM_ROLE.includes('同等对待'));
});

test('clipContext：6000 字硬上限，超了标 truncated', () => {
  const long = 'a'.repeat(CONTEXT_MAX_CHARS + 500);
  const clipped = clipContext(long);
  assert.equal(clipped.chars, CONTEXT_MAX_CHARS);
  assert.equal(clipped.truncated, true);
  const short = clipContext('短');
  assert.equal(short.truncated, false);
});

test('normalizeScope：认知识点/资料/自由，非法退回 free', () => {
  assert.equal(normalizeScope({ type: 'node', nodeId: 'n1' }).type, 'node');
  assert.equal(normalizeScope({ type: 'material', path: 'a/b.md' }).path, 'a/b.md');
  assert.equal(normalizeScope({ type: '乱写' }).type, 'free');
});

test('证据预算常量没有分叉：6000 字上限同一处定义', () => {
  assert.equal(EVIDENCE_MAX_CHARS, 6000);
  assert.ok(API.includes('clipContext('), '切片走 clipContext（复用 6000 上限）');
});
