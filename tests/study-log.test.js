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
  atomicWriteJson,
  backupRoot,
  buildTimeline,
  DURATION_MIN_SECONDS,
  learningDurationPath,
  normalizeDurationRecord,
  normalizeReadingPosition,
  readLearningDurations,
  appendLearningDuration,
  safeName,
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

test('阅读位置规整：缺 path / 坏 page 拒绝，正常值补 updatedAt、反斜杠归一', () => {
  assert.equal(normalizeReadingPosition({}).ok, false);
  assert.equal(normalizeReadingPosition({ path: 'a.md', page: 0 }).ok, false);
  assert.equal(normalizeReadingPosition({ path: '../a.md' }).ok, false);
  const ok = normalizeReadingPosition({ path: '数据结构\\讲义\\a.md', page: 3, courseId: 'c_ds' }, '2026-10-30T08:00:00.000Z');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.path, '数据结构/讲义/a.md');
  assert.equal(ok.value.updatedAt, '2026-10-30T08:00:00.000Z');
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
    // 备份名现在带“时间戳之后”的进程内唯一后缀，同毫秒连写也不会互相覆盖，
    // 所以 13 次连写必然产生 13 个唯一名字 → 清理后恰好留 BACKUP_KEEP 份。
    // 这里保留等值断言（不放宽到 <=），作为“同毫秒不撞名”的回归保护；
    // 也不再依赖“13 次写盘跨 ≥10 个毫秒”这种时序假设（快盘/CI 上原本必失败）。
    assert.equal(backups.length, BACKUP_KEEP, `备份最多保留 ${BACKUP_KEEP} 份`);
    // 再确认按名字字典序保留的是**最新**一份（后缀加在时间戳之前会打乱排序，这里会抓到）
    const newest = backups.slice().sort().at(-1);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(backupDir, newest), 'utf8')),
      { n: 11 },
      '排序保留的应是最新一份备份（第 13 次写前落盘的 {n:11}）',
    );
    // 不能留 .tmp 中间文件
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.equal(leftovers.length, 0, '不能留临时文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────── 学习时长（C2，2026-11-17） ───────────────────

test('学习时长规整：合法记录补 recordedAt；<5s / 坏字段各自拒收并给 reason', () => {
  const base = { startAt: '2026-11-17T02:00:00.000Z', endAt: '2026-11-17T02:25:00.000Z', seconds: 1500, scopeType: 'node', mode: 'pomodoro', courseId: 'c_ds', nodeId: 'k1' };
  const ok = normalizeDurationRecord(base, '2026-11-17T02:25:01.000Z');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.seconds, 1500);
  assert.equal(ok.value.mode, 'pomodoro');
  assert.equal(ok.value.scopeType, 'node');
  assert.equal(ok.value.recordedAt, '2026-11-17T02:25:01.000Z', '未带 recordedAt 时补 nowIso');

  // <5 秒不落盘（正好 5 也算合格，与 DURATION_MIN_SECONDS 对齐）
  assert.equal(normalizeDurationRecord({ ...base, seconds: 4 }).reason, 'bad-seconds');
  assert.equal(normalizeDurationRecord({ ...base, seconds: DURATION_MIN_SECONDS }).ok, true, '恰好 5 秒要过');
  assert.equal(normalizeDurationRecord({ ...base, seconds: 1.5 }).reason, 'bad-seconds', '非整数秒拒收');
  // 起止
  assert.equal(normalizeDurationRecord({ ...base, startAt: '' }).reason, 'missing-start');
  assert.equal(normalizeDurationRecord({ ...base, endAt: '' }).reason, 'missing-end');
  assert.equal(normalizeDurationRecord({ ...base, startAt: 'not-a-date' }).reason, 'bad-time');
  assert.equal(normalizeDurationRecord({ ...base, endAt: '2026-11-17T01:00:00.000Z' }).reason, 'end-before-start', 'endAt 早于 startAt 拒收');
  // 白名单
  assert.equal(normalizeDurationRecord({ ...base, scopeType: 'weird' }).reason, 'bad-scope');
  assert.equal(normalizeDurationRecord({ ...base, mode: 'timer' }).reason, 'bad-mode');
  // 路径逃逸
  assert.equal(normalizeDurationRecord({ ...base, scopeType: 'material', path: '../x.md' }).reason, 'bad-path');
});

test('学习时长落盘：追加两条 → 读回顺序一致、数量对；路径在 学习记录/学习时长.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-duration-'));
  try {
    assert.deepEqual(await readLearningDurations(dir), [], '空文件应回空数组');
    const r1 = { startAt: '2026-11-17T02:00:00.000Z', endAt: '2026-11-17T02:25:00.000Z', seconds: 1500, scopeType: 'node', courseId: 'c_ds', nodeId: 'k1', mode: 'pomodoro', recordedAt: '2026-11-17T02:25:01.000Z' };
    const r2 = { startAt: '2026-11-17T03:00:00.000Z', endAt: '2026-11-17T03:00:30.000Z', seconds: 30, scopeType: 'stopwatch', courseId: 'c_ds', nodeId: 'k2', mode: 'stopwatch', recordedAt: '2026-11-17T03:00:31.000Z' };
    const w1 = await appendLearningDuration(dir, r1);
    assert.equal(w1.total, 1);
    const w2 = await appendLearningDuration(dir, r2);
    assert.equal(w2.total, 2);
    const all = await readLearningDurations(dir);
    assert.equal(all.length, 2);
    assert.equal(all[0].nodeId, 'k1', '保持追加顺序');
    assert.equal(all[1].seconds, 30);
    assert.equal(learningDurationPath(dir), path.join(dir, '学习记录', '学习时长.json'));
    // 落盘文件结构 {version:1, records:[...]}
    const raw = JSON.parse(await fs.readFile(learningDurationPath(dir), 'utf8'));
    assert.equal(raw.version, 1);
    assert.ok(Array.isArray(raw.records));
    // 备份目录也要有旧版本（追加写前会备份）
    const backups = (await fs.readdir(path.join(dir, '学习记录', '_backup'))).filter((name) => name.startsWith('学习时长.json.') && name.endsWith('.bak'));
    assert.ok(backups.length >= 1, '追加写要进 _backup');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
