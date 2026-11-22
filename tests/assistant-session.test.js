/**
 * 助手会话（v2-C，2026-11-21）纯函数 + 磁盘层测试。
 *
 * 对着任务卡 ⑨ 的验收要点逐条落：
 *   - 会话新增 / 读写 / 索引重建与排序；
 *   - 改名置 titleCustom=true（此后不自动覆盖）；
 *   - 归档 archived:true 后默认列表不显示、但文件仍在磁盘、可切回、可取消归档；
 *   - 摘要触发阈值（>30 条）/ 摘要后发送只带近 N 轮 / 摘要失败降级；
 *   - 首条用户消息自动命名；
 *   - E2 钉子名未复活（本模块与导出名不含旧对话函数名）。
 *
 * 全部不真打网络、不碰真实数据目录（每个用例独立临时目录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ASSISTANT_BACKUP_KEEP,
  COMPRESS_TRIGGER_TURNS,
  DEFAULT_SESSION_TITLE,
  KEEP_RECENT_TURNS,
  TITLE_MAX_CHARS,
  appendMessages,
  applySummary,
  archiveSession,
  assistantBackupRoot,
  assistantSessionPath,
  buildIndexEntry,
  buildNewSession,
  buildSendMessages,
  buildSummaryPrompt,
  createSession,
  deriveTitle,
  listSessions,
  newSessionId,
  normalizeSessionDoc,
  normalizeSessionMessage,
  planCompression,
  readIndex,
  readSession,
  renameSession,
  safeId,
  scanSessions,
  shouldCompress,
  writeSession,
} from '../lib/assistant-session.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

const T0 = '2026-11-21T10:00:00.000Z';

function userMsg(content, at = T0) {
  return { role: 'user', content, at };
}
function asstMsg(content, at = T0) {
  return { role: 'assistant', content, at };
}

// ---------------------------------------------------------------------------
// 纯函数：id / 标题 / 规整
// ---------------------------------------------------------------------------

test('newSessionId：前缀 asst_（避开旧 chat_），含时间戳+随机，且不含路径分隔符', () => {
  const id = newSessionId(new Date('2026-11-21T10:00:00Z'), 'abcd');
  assert.match(id, /^asst_2026/);
  assert.equal(id.endsWith('_abcd'), true);
  assert.equal(id.startsWith('chat_'), false, '不许用旧 chat_ 前缀');
  assert.equal(/[\\/:*?"<>|]/.test(id), false);
});

test('deriveTitle：折叠空白取前 20 字；空内容退回默认标题', () => {
  const title = deriveTitle('  第一问   换行\n也算空格的内容很长很长很长超过二十个字了吧');
  assert.equal(Array.from(title).length, TITLE_MAX_CHARS);
  assert.equal(title.startsWith('第一问 换行 也算'), true);
  assert.equal(deriveTitle('   '), DEFAULT_SESSION_TITLE);
  assert.equal(deriveTitle(''), DEFAULT_SESSION_TITLE);
});

test('safeId：挡住路径分隔符与控制字符，全非法时退回 fallback', () => {
  assert.equal(safeId('../etc/passwd'), '.._etc_passwd'.replace(/^[.\s]+/, ''), '去掉前后点号');
  assert.equal(safeId('a\\b/c'), 'a_b_c');
  assert.equal(safeId(''), 'session');
  assert.equal(safeId('...'), 'session');
});

test('normalizeSessionMessage：role 白名单 + content 非空 + 可选 action 透传', () => {
  assert.equal(normalizeSessionMessage({ role: 'user', content: 'hi' }, T0).ok, true);
  assert.equal(normalizeSessionMessage({ role: 'bot', content: 'hi' }, T0).reason, 'bad-role');
  assert.equal(normalizeSessionMessage({ role: 'user', content: '   ' }, T0).reason, 'bad-content');
  const withAction = normalizeSessionMessage({
    role: 'assistant',
    content: '预览',
    action: { kind: 'set-mastery', nodeId: 'k1' },
  }, T0);
  assert.equal(withAction.ok, true);
  assert.deepEqual(withAction.value.action, { kind: 'set-mastery', nodeId: 'k1' });
  const noAt = normalizeSessionMessage({ role: 'user', content: 'hi' }, T0);
  assert.equal(noAt.value.at, T0, '缺 at 补 nowIso');
});

test('buildNewSession：空会话骨架字段齐备、archived=false、summary 空', () => {
  const doc = buildNewSession({}, T0);
  assert.match(doc.id, /^asst_/);
  assert.equal(doc.title, DEFAULT_SESSION_TITLE);
  assert.equal(doc.titleCustom, false);
  assert.equal(doc.summary, '');
  assert.equal(doc.summaryUpTo, 0);
  assert.equal(doc.archived, false);
  assert.deepEqual(doc.messages, []);
  assert.equal(doc.createdAt, T0);
});

test('normalizeSessionDoc：坏消息丢弃、缺字段补默认、archived 只认 true', () => {
  const doc = normalizeSessionDoc({
    id: 'asst_x',
    title: '',
    messages: [
      { role: 'user', content: 'ok' },
      { role: 'nope', content: 'bad' },
      { role: 'user', content: '' },
    ],
    archived: 'yes',
  }, T0);
  assert.equal(doc.id, 'asst_x');
  assert.equal(doc.title, DEFAULT_SESSION_TITLE);
  assert.equal(doc.messages.length, 1, '两条坏消息被丢弃');
  assert.equal(doc.archived, false, 'archived 只认真布尔 true');
});

// ---------------------------------------------------------------------------
// 纯函数：追加 + 自动命名
// ---------------------------------------------------------------------------

test('appendMessages：首条用户消息自动命名（20 字），第二轮不再改标题', () => {
  const empty = buildNewSession({ id: 'asst_auto' }, T0);
  const first = '这是一条很长很长的第一条用户提问内容超过二十个字应当被截断';
  const afterFirst = appendMessages(empty, [userMsg(first), asstMsg('答一')], T0);
  assert.equal(afterFirst.messages.length, 2);
  assert.equal(afterFirst.title, deriveTitle(first), '首条自动命名');
  const afterSecond = appendMessages(afterFirst, [userMsg('第二问'), asstMsg('答二')], '2026-11-21T10:05:00Z');
  assert.equal(afterSecond.title, deriveTitle(first), 'titleCustom=false 但已有标题，不覆盖？—— 实际上只在首条命名');
  assert.equal(afterSecond.messages.length, 4);
});

test('appendMessages：用户改过名（titleCustom=true）后首条命名不生效', () => {
  const custom = { ...buildNewSession({ id: 'asst_c', title: '我的标题' }, T0), titleCustom: true };
  const after = appendMessages(custom, [userMsg('随便一句话'), asstMsg('答')], T0);
  assert.equal(after.title, '我的标题', '自定义标题不被首条消息覆盖');
});

// ---------------------------------------------------------------------------
// 纯函数：上下文压缩
// ---------------------------------------------------------------------------

test('shouldCompress：>30 条触发（30 条不触发，31 条触发）', () => {
  assert.equal(COMPRESS_TRIGGER_TURNS, 30);
  const msgs30 = Array.from({ length: 30 }, (_, i) => userMsg(`m${i}`));
  const msgs31 = Array.from({ length: 31 }, (_, i) => userMsg(`m${i}`));
  assert.equal(shouldCompress(msgs30), false, '正好 30 条不触发');
  assert.equal(shouldCompress(msgs31), true, '31 条触发');
});

test('planCompression：触发时把 [summaryUpTo, len-10) 段交出，近 10 条原样保留', () => {
  assert.equal(KEEP_RECENT_TURNS, 10);
  const messages = Array.from({ length: 34 }, (_, i) => userMsg(`m${i}`));
  const plan = planCompression({ messages, summaryUpTo: 0 });
  assert.equal(plan.needCompress, true);
  assert.equal(plan.from, 0);
  assert.equal(plan.to, 24, '34 - 10 = 24，m0..m23 并入摘要');
  assert.equal(plan.segment.length, 24);
  assert.equal(plan.segment[0].content, 'm0');
  assert.equal(plan.segment[23].content, 'm23');
});

test('planCompression：已压缩过（summaryUpTo>0）只并入新超出部分', () => {
  const messages = Array.from({ length: 34 }, (_, i) => userMsg(`m${i}`));
  const plan = planCompression({ messages, summaryUpTo: 20 });
  assert.equal(plan.needCompress, true);
  assert.equal(plan.from, 20);
  assert.equal(plan.to, 24);
  assert.equal(plan.segment.length, 4, '只并入 m20..m23');
});

test('planCompression：未超阈值不压缩', () => {
  const messages = Array.from({ length: 12 }, (_, i) => userMsg(`m${i}`));
  const plan = planCompression({ messages, summaryUpTo: 0 });
  assert.equal(plan.needCompress, false);
  assert.equal(plan.segment.length, 0);
});

test('buildSendMessages：无摘要=全量；有摘要=system 摘要 + slice(summaryUpTo)', () => {
  const noSummary = buildSendMessages({
    messages: [userMsg('问1'), asstMsg('答1')],
    summary: '',
    summaryUpTo: 0,
  });
  assert.equal(noSummary.length, 2, '无摘要全量发送');
  assert.equal(noSummary.some((m) => m.role === 'system'), false);

  const withSummary = buildSendMessages({
    messages: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? userMsg(`问${i}`) : asstMsg(`答${i}`))),
    summary: '之前讨论了极限的定义',
    summaryUpTo: 8,
  });
  assert.equal(withSummary[0].role, 'system');
  assert.equal(withSummary[0].content, '【之前对话摘要】之前讨论了极限的定义');
  assert.equal(withSummary.length, 1 + 4, '摘要 system + 后 4 条');
  assert.equal(withSummary[1].content, '问8');
});

test('buildSummaryPrompt：拼上次摘要与本次早期消息，role 翻成中文', () => {
  const prompt = buildSummaryPrompt('旧摘要', [userMsg('问题A'), asstMsg('回答B')]);
  assert.equal(prompt.includes('【更早的摘要】旧摘要'), true);
  assert.equal(prompt.includes('用户：问题A'), true);
  assert.equal(prompt.includes('助手：回答B'), true);
  // 无旧摘要时不出现那行
  assert.equal(buildSummaryPrompt('', [userMsg('x')]).startsWith('【更早'), false);
});

test('applySummary：写回 summary 与 summaryUpTo（不改入参）', () => {
  const original = { ...buildNewSession({ id: 'asst_s' }, T0), messages: Array.from({ length: 5 }, (_, i) => userMsg(`m${i}`)) };
  const next = applySummary(original, '  一段  摘要 ', 3);
  assert.equal(next.summary, '一段 摘要', '空白折叠');
  assert.equal(next.summaryUpTo, 3);
  assert.equal(original.summary, '', '不改入参');
});

// ---------------------------------------------------------------------------
// 磁盘层：读写 / 索引 / 排序
// ---------------------------------------------------------------------------

test('写单会话 → 读回一致；索引按 updatedAt 倒序', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    const a = { ...buildNewSession({ id: 'asst_a', title: 'A' }, '2026-11-21T01:00:00.000Z') };
    a.messages = [userMsg('a问'), asstMsg('a答')];
    a.updatedAt = '2026-11-21T01:00:00.000Z';
    const b = { ...buildNewSession({ id: 'asst_b', title: 'B' }, '2026-11-21T02:00:00.000Z') };
    b.messages = [userMsg('b问')];
    b.updatedAt = '2026-11-21T02:00:00.000Z';
    await writeSession(dir, a);
    await writeSession(dir, b);

    const idx = await readIndex(dir);
    assert.equal(idx.length, 2);
    assert.equal(idx[0].id, 'asst_b', '最近更新的排最前');

    const loaded = await readSession(dir, 'asst_a');
    assert.equal(loaded.title, 'A');
    assert.equal(loaded.messages.length, 2);

    const expected = path.join(dir, '助手会话', 'asst_a.json');
    assert.equal(assistantSessionPath(dir, 'asst_a'), expected);
    assert.ok(assistantBackupRoot(dir).endsWith(path.join('助手会话', '_backup')));
  } finally {
    await removeTempDir(dir);
  }
});

test('索引缓存坏掉时 readIndex 自动扫目录重建', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    await writeSession(dir, { ...buildNewSession({ id: 'asst_x', title: 'X' }, T0), messages: [userMsg('q')] });
    // 故意写坏索引
    await fs.writeFile(path.join(dir, '助手会话', '索引.json'), '{not json', 'utf8');
    const idx = await readIndex(dir);
    assert.equal(idx.length, 1);
    assert.equal(idx[0].id, 'asst_x');
  } finally {
    await removeTempDir(dir);
  }
});

test('scanSessions 跳过临时文件与非 json', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    await createSession(dir, { id: 'asst_one' }, T0);
    const root = path.join(dir, '助手会话');
    await fs.writeFile(path.join(root, 'junk.txt'), 'x', 'utf8');
    const list = await scanSessions(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'asst_one');
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 改名 / 归档
// ---------------------------------------------------------------------------

test('renameSession：改名并置 titleCustom=true，此后 appendMessages 不再覆盖标题', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    await createSession(dir, { id: 'asst_r' }, T0);
    const renamed = await renameSession(dir, 'asst_r', '  我改的名字  ', T0);
    assert.equal(renamed.ok, true);
    assert.equal(renamed.session.title, '我改的名字');
    assert.equal(renamed.session.titleCustom, true);
    const stored = await readSession(dir, 'asst_r');
    const after = appendMessages(stored, [userMsg('新提问')], '2026-11-21T11:00:00Z');
    assert.equal(after.title, '我改的名字', '改过名后不再自动覆盖');
  } finally {
    await removeTempDir(dir);
  }
});

test('renameSession：空标题拒收；不存在会话回 not-found', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    await createSession(dir, { id: 'asst_r2' }, T0);
    assert.equal((await renameSession(dir, 'asst_r2', '   ', T0)).error, 'empty-title');
    assert.equal((await renameSession(dir, 'nope', 'x', T0)).error, 'not-found');
  } finally {
    await removeTempDir(dir);
  }
});

test('archiveSession：归档后默认列表隐藏、文件仍在磁盘、可切回、可取消归档', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    await createSession(dir, { id: 'asst_arc', title: '将归档' }, T0);
    await writeSession(dir, { ...(await readSession(dir, 'asst_arc')), messages: [userMsg('重要提问'), asstMsg('重要回答')] });

    const archived = await archiveSession(dir, 'asst_arc', true, T0);
    assert.equal(archived.ok, true);
    assert.equal(archived.session.archived, true);

    // 默认列表不显示
    const visible = await listSessions(dir);
    assert.equal(visible.some((item) => item.id === 'asst_arc'), false, '归档会话默认列表隐藏');

    // 但文件仍在磁盘、能切回（读到完整 messages）
    const stillOnDisk = await readSession(dir, 'asst_arc');
    assert.notEqual(stillOnDisk, null, '归档不删磁盘');
    assert.equal(stillOnDisk.messages.length, 2, '能切回看全过程');

    // includeArchived 能看到
    const withArchived = await listSessions(dir, { includeArchived: true });
    assert.equal(withArchived.some((item) => item.id === 'asst_arc'), true);

    // 取消归档回到列表
    const unarchived = await archiveSession(dir, 'asst_arc', false, T0);
    assert.equal(unarchived.session.archived, false);
    const visibleAgain = await listSessions(dir);
    assert.equal(visibleAgain.some((item) => item.id === 'asst_arc'), true, '取消归档后回到列表');
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 备份 + 空目录
// ---------------------------------------------------------------------------

test('写会话保留 ≤BACKUP_KEEP 份备份', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    const id = 'asst_bak';
    for (let i = 0; i < ASSISTANT_BACKUP_KEEP + 3; i += 1) {
      await writeSession(dir, { ...buildNewSession({ id }, T0), messages: [userMsg(`m${i}`)] });
    }
    const backups = (await fs.readdir(assistantBackupRoot(dir)))
      .filter((name) => name.startsWith('asst_bak.json.') && name.endsWith('.bak'));
    assert.ok(backups.length <= ASSISTANT_BACKUP_KEEP, `备份应 ≤ ${ASSISTANT_BACKUP_KEEP} 份，实际 ${backups.length}`);
    const leftovers = (await fs.readdir(path.dirname(assistantSessionPath(dir, id)))).filter((n) => n.includes('.tmp-'));
    assert.equal(leftovers.length, 0, '不留临时文件');
  } finally {
    await removeTempDir(dir);
  }
});

test('readSession：不存在的会话回 null；空目录 scanSessions 回空数组', async () => {
  const dir = await makeTempDir('sa-asst-');
  try {
    assert.equal(await readSession(dir, 'nope'), null);
    assert.deepEqual(await scanSessions(dir), []);
    assert.deepEqual(await listSessions(dir), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('buildIndexEntry：摘要头折叠到 60 字、messageCount 正确、不含整段 messages', () => {
  const entry = buildIndexEntry({
    id: 'asst_e',
    title: '标题',
    updatedAt: T0,
    archived: false,
    summary: `${'字'.repeat(100)}`,
    messages: [userMsg('a'), asstMsg('b')],
  });
  assert.equal(entry.messageCount, 2);
  assert.equal(Array.from(entry.summaryHead).length, 60);
  assert.equal('messages' in entry, false, '索引条目不带整段 messages');
});
