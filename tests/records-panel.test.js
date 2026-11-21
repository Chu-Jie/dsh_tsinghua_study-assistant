// 学习记录（P3，2026-10-30）的源码级钉子：记录页签 + 时间线 + 阅读位置。
//
// 2026-11-18 E2 卡：交互助手对话（`POST /assistant/chat`、`GET /study-log?chat=`、
// `POST /study-log/delete`、归档对话列表、「让助手读当前阅读段落」注入）整体下线，
// 这里只留「页签还在、时间线还走 GET /study-log、阅读位置还在、学习记录不进 /state」，
// 外加几条「已下线的东西不该复活」的反向钉子。磁盘旧对话文件不删，测试不碰磁盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('记录页签只剩时间线：头卡 + 时间线卡在，对话面板与对话入口都不在', () => {
  assert.ok(CLIENT.includes("h('h3', null, '学习记录')"), '「学习记录」头卡还在');
  assert.ok(CLIENT.includes("h('h3', null, '时间线')"), '时间线卡还在');
  assert.ok(CLIENT.includes("sa-log-row"), '时间线行样式还在用');
  // 对话那套（列表 / 面板 / 气泡 / 注入按钮 / 新建）一律不该复活
  for (const gone of ['sa-chat-log', 'sa-chat-msg', 'chatSection', 'sessionPanel', '让助手读当前阅读段落', 'fetchChatSession']) {
    assert.ok(!CLIENT.includes(gone), `对话面板的「${gone}」应已下线`);
  }
});

test('阅读位置（P3）：客户端调对接口，服务端两条路由都还在', () => {
  assert.ok(CLIENT.includes('`${API}/study-log'), '时间线走 GET /study-log');
  assert.ok(CLIENT.includes('`${API}/reading-position`'), '阅读位置走 POST /reading-position');
  assert.ok(CLIENT.includes("scopeType: 'material'"), '资料阅读位置要带 scopeType=material');
  assert.ok(API.includes("if (rest === '/study-log')"), 'GET /study-log 仍注册');
  assert.ok(API.includes("if (rest === '/reading-position')"), 'POST /reading-position 仍注册');
  assert.ok(API.includes("if (rest === '/study-log/duration')"), '学习时长路由不受影响');
});

test('交互助手对话已下线：三条路由与对话索引读取都不该复活', () => {
  for (const gone of ["'/assistant/chat'", "'/study-log/delete'", 'readChatIndex', 'readChatSession', 'readMaterialContextSlice', 'collectExplainEvidence']) {
    assert.ok(!API.includes(gone), `服务端不该再有「${gone}」`);
  }
  assert.ok(!CLIENT.includes('`${API}/assistant/chat`'), '客户端不该再打 /assistant/chat');
  assert.ok(!CLIENT.includes('`${API}/study-log/delete`'), '客户端不该再打 /study-log/delete');
  assert.ok(!API.includes('chats,'), 'GET /study-log 响应里不该再有 chats 字段');
  assert.ok(API.includes('timeline,'), 'GET /study-log 仍要回时间线');
  assert.ok(API.includes('readingPosition: position'), 'GET /study-log 仍要回阅读位置');
});

test('学习记录不进 /state：旁挂目录不能混进 DOC_KEYS', () => {
  assert.ok(DOC_KEYS.includes('annotations'), '批注确实是第 12 份文档（A2 已立）');
  assert.ok(DOC_KEYS.length === 16, 'DOC_KEYS 现为 16 份（批注 + 知识映射 + 日程 + 要闻 + 学习行为），学习记录没有混进来');
  assert.ok(DOC_KEYS.includes('knowledgeMap'), '知识映射是第 13 份文档（C0 已立）');
  assert.ok(DOC_KEYS.includes('schedule'), '日程是第 14 份文档（2026-11-19 A 卡）');
  assert.ok(DOC_KEYS.includes('news'), '要闻是第 15 份文档（2026-11-19 B 卡）');
  assert.ok(DOC_KEYS.includes('learningBehavior'), '学习行为是第 16 份文档（2026-11-20 v2-B 卡）');
  assert.ok(!DOC_KEYS.some((key) => /studylog|studyLog|records|reading/i.test(key)), '学习记录不是主文档');
  assert.ok(!STUDY_LOG.includes('writeDocument'), '学习记录用原子写，不走 store.writeDocument');
});
