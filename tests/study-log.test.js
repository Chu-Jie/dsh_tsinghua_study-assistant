/**
 * 学习记录（P3）纯逻辑 + 磁盘层测试：文件名安全、上下文截断、阅读位置规整、
 * 时间线聚合、对话原子写与索引重建。
 *
 * 守的底线：路径不能逃逸、6000 字上限必须真的截断并回报总数、
 * 时间线只用现有 JSON 不许编造、写盘不能把旧数据冲掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BACKUP_KEEP,
  CONTEXT_MAX_CHARS,
  atomicWriteJson,
  backupRoot,
  buildChatIndexEntry,
  buildTimeline,
  chatFilePath,
  chatTitleFor,
  clipContext,
  newChatId,
  normalizeReadingPosition,
  normalizeScope,
  readChatIndex,
  readChatSession,
  safeName,
  writeChatSession,
} from '../lib/study-log.js';

test('文件名安全化：挡住路径分隔符与 ..，中文与常用符号保留', () => {
  assert.equal(safeName('../etc/passwd'), '_etc_passwd');
  assert.equal(safeName('a/b\\c:d'), 'a_b_c_d');
  assert.equal(safeName('第1章 绪论'), '第1章_绪论');
  assert.equal(safeName('   '), 'untitled');
  assert.equal(safeName('...'), 'untitled');
  assert.equal(safeName('x'.repeat(200)).length, 80);
  assert.ok(!safeName('../x').includes('..'), '不能保留 .. 造成穿越');
});

test('上下文截断：不超限原样返回；超限截到 6000 并回报总数与 truncated', () => {
  const short = clipContext('hello');
  assert.equal(short.text, 'hello');
  assert.equal(short.truncated, false);
  assert.equal(short.total, 5);
  assert.equal(short.chars, 5);

  const long = clipContext('a'.repeat(CONTEXT_MAX_CHARS + 500));
  assert.equal(long.truncated, true);
  assert.equal(long.chars, CONTEXT_MAX_CHARS);
  assert.equal(long.total, CONTEXT_MAX_CHARS + 500);
  assert.equal(long.text.length, CONTEXT_MAX_CHARS);
});

test('阅读位置规整：缺 path / 坏 page 拒绝，正常值补 updatedAt、反斜杠归一', () => {
  assert.equal(normalizeReadingPosition({}).ok, false);
  assert.equal(normalizeReadingPosition({ path: 'a.md', page: 0 }).ok, false);
  assert.equal(normalizeReadingPosition({ path: '../a.md' }).ok, false);
  const ok = normalizeReadingPosition({ path: '数据结构\\讲义\\a.md', page: 3, courseId: 'c_ds' }, '2026-10-30T08:00:00.000Z');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.path, '数据结构/讲义/a.md');
  assert.equal(ok.value.updatedAt, '2026-10-30T08:00:00.000Z');
});

test('归档范围规整：未知类型退 free，字段白名单', () => {
  const scope = normalizeScope({ type: 'node', nodeId: 'k_1', extra: 'x' });
  assert.equal(scope.type, 'node');
  assert.equal(scope.nodeId, 'k_1');
  assert.equal('extra' in scope, false);
  assert.equal(normalizeScope({ type: 'weird' }).type, 'free');
});

test('时间线：读到 / 批注 / 知识点三类，按时间倒序，条条带数据来源', () => {
  const timeline = buildTimeline({
    readingPosition: { path: '数据结构/讲义/第01章.md', page: 2, updatedAt: '2026-10-30T07:00:00.000Z' },
    annotations: {
      notes: [
        { file: '数据结构/讲义/第01章.md', content: '这里没懂', createdAt: '2026-10-30T06:00:00.000Z', updatedAt: '2026-10-30T06:30:00.000Z' },
        { file: 'x.md', content: '没有时间', createdAt: '' },
      ],
    },
    knowledgeNetwork: {
      nodes: [
        { name: '复杂度度量', mastery: 2, marked: true, reviewedAt: '2026-10-30T09:00:00.000Z' },
        { name: '没有复习时间', mastery: 1, reviewedAt: null },
      ],
    },
  });
  assert.equal(timeline.length, 3, '没有时间戳的批注/知识点不进时间线');
  assert.equal(timeline[0].kind, 'knowledge');
  assert.equal(timeline[0].at, '2026-10-30T09:00:00.000Z');
  assert.match(timeline[0].detail, /掌握度 2\/3/);
  assert.match(timeline[0].detail, /重点/);
  assert.equal(timeline[1].kind, 'read');
  assert.equal(timeline[2].kind, 'note');
  for (const item of timeline) assert.ok(item.basis.endsWith('.json'), '每条都要标数据来源');
});

test('对话索引条目：只保留 6 个字段', () => {
  const entry = buildChatIndexEntry({
    id: 'chat_1', title: '第1章', courseId: 'c_ds', scope: { type: 'node', nodeId: 'k1' },
    updatedAt: '2026-10-30T08:00:00.000Z', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    extra: 'should-drop',
  });
  assert.deepEqual(Object.keys(entry).sort(), ['courseId', 'id', 'messageCount', 'scope', 'title', 'updatedAt']);
  assert.equal(entry.messageCount, 2);
});

test('会话 id 形如 chat_YYYYMMDD_HHMMSS_xxxx', () => {
  const id = newChatId(new Date('2026-10-30T14:30:12.000Z'), 'ab12cd');
  assert.match(id, /^chat_\d{8}_\d{6}_[a-z0-9]{4}$/);
});

test('对话标题：有名字用名字，否则用章节号或文件名兜底', () => {
  assert.equal(chatTitleFor({ type: 'node' }, '复杂度度量'), '复杂度度量');
  assert.equal(chatTitleFor({ type: 'chapter', chapterNo: '3' }, ''), '第 3 章');
  assert.equal(chatTitleFor({ type: 'material', path: '数据结构/资料/a.md' }, ''), 'a');
});

test('原子写 + 备份：旧文件先进 _backup，写坏不会留半个文件，备份最多 10 份', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-study-log-'));
  try {
    const file = path.join(dir, 'x.json');
    const backupDir = path.join(dir, '_backup');
    // 连续写 13 次，每次都应把上一份备份下来，但只留最近 BACKUP_KEEP 份
    for (let i = 0; i < 13; i += 1) {
      await atomicWriteJson(file, { n: i }, { backupDir });
    }
    const text = await fs.readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(text), { n: 12 }, '最后写入的是第 13 次的内容');
    const backups = (await fs.readdir(backupDir)).filter((name) => name.startsWith('x.json.') && name.endsWith('.bak'));
    assert.equal(backups.length, BACKUP_KEEP, `备份最多保留 ${BACKUP_KEEP} 份`);
    // 不能留 .tmp 中间文件
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.equal(leftovers.length, 0, '不能留临时文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('对话落盘：写单条 → 索引重建、按更新时间倒序、路径在 学习记录/对话/<course> 下', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-chat-'));
  try {
    const a = { id: 'chat_a', title: 'A', courseId: 'c_ds', scope: { type: 'node', nodeId: 'k1' }, updatedAt: '2026-10-30T01:00:00.000Z', messages: [{ role: 'user', content: 'hi' }] };
    const b = { id: 'chat_b', title: 'B', courseId: 'c_ds', scope: { type: 'node', nodeId: 'k2' }, updatedAt: '2026-10-30T02:00:00.000Z', messages: [{ role: 'user', content: 'yo' }] };
    await writeChatSession(dir, a);
    await writeChatSession(dir, b);
    const index = await readChatIndex(dir);
    assert.equal(index.length, 2);
    assert.equal(index[0].id, 'chat_b', '最近更新的排最前');
    const loaded = await readChatSession(dir, 'c_ds', 'chat_a');
    assert.equal(loaded.title, 'A');
    const expected = path.join(dir, '学习记录', '对话', 'c_ds', 'chat_a.json');
    assert.equal(chatFilePath(dir, 'c_ds', 'chat_a'), expected);
    assert.ok(backupRoot(dir).endsWith(path.join('学习记录', '_backup')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
