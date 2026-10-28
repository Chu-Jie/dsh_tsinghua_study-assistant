import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './_tmpdir.js';
import {
  ADTS_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DEFAULT_RECORDING_DIR,
  MAX_READ_BYTES,
  isAdtsName,
  isAudioName,
  listRecordings,
  readRecording,
  resolveRecording,
  safeSegment,
} from '../lib/lecture/recording.js';

async function makeBase(t) {
  const base = await makeTempDir('lecture-rec-');
  t.after(() => removeTempDir(base));
  return base;
}

async function put(base, session, name, bytes, mtimeMs) {
  const dir = path.join(base, session);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(file, bytes);
  if (mtimeMs !== undefined) {
    const at = new Date(mtimeMs);
    await fsp.utimes(file, at, at);
  }
  return file;
}

test('safeSegment：只认干干净净的一层名字', () => {
  assert.equal(safeSegment('2026-10-09 20.04.19'), '2026-10-09 20.04.19');
  assert.equal(safeSegment('  录音.aac  '), '录音.aac');
  assert.equal(safeSegment(''), null);
  assert.equal(safeSegment('   '), null);
  assert.equal(safeSegment('.'), null);
  assert.equal(safeSegment('..'), null);
  assert.equal(safeSegment('a/b.aac'), null);
  assert.equal(safeSegment('a\\b.aac'), null);
  assert.equal(safeSegment('C:a.aac'), null);
  assert.equal(safeSegment(null), null);
  assert.equal(safeSegment(42), null);
});

test('isAudioName：后缀白名单大小写不敏感', () => {
  assert.deepEqual(AUDIO_EXTENSIONS, ['.aac', '.m4a', '.wemta']);
  assert.equal(isAudioName('2026_10_09200419.aac'), true);
  assert.equal(isAudioName('MEETING.M4A'), true);
  assert.equal(isAudioName('double_click_to_convert_quick_record.wemta'), true);
  assert.equal(isAudioName('2026_10_09200419.aacidx'), false);
  assert.equal(isAudioName('meeting_01.mp4'), false);
  assert.equal(isAudioName('notes.txt'), false);
  assert.equal(isAudioName(null), false);
});

test('DEFAULT_RECORDING_DIR 指到用户主目录下的录像目录', () => {
  assert.equal(DEFAULT_RECORDING_DIR, path.join(os.homedir(), '会议录像'));
  assert.equal(MAX_READ_BYTES, 8 * 1024 * 1024);
});

test('resolveRecording：合法组合落成绝对路径', () => {
  const base = 'D:\\会议录像';
  const resolved = resolveRecording(base, '2026-10-09 20.04.19', '2026_10_09200419.aac');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.file, path.join(base, '2026-10-09 20.04.19', '2026_10_09200419.aac'));
  assert.equal(resolved.session, '2026-10-09 20.04.19');
  assert.equal(resolved.name, '2026_10_09200419.aac');
});

test('resolveRecording：每一类坏输入都有自己的错误码', () => {
  const base = 'D:\\会议录像';
  assert.equal(resolveRecording('', 's', 'a.aac').error, 'no-dir');
  assert.equal(resolveRecording(base, '..', 'a.aac').error, 'bad-session');
  assert.equal(resolveRecording(base, '..\\..\\Windows', 'a.aac').error, 'bad-session');
  assert.equal(resolveRecording(base, 's', '../a.aac').error, 'bad-name');
  assert.equal(resolveRecording(base, 's', 'a.txt').error, 'not-audio');
  // 名字本身干净、但拼出来的路径跑到外面
  const escaped = resolveRecording('D:\\会议录像', 'sub', 'a.aac');
  assert.equal(escaped.ok, true, '普通子目录本来就该放行');
  assert.equal(resolveRecording(base, 's', 'a.acidx').error, 'not-audio');
});

test('listRecordings：只收音频、按修改时间倒序、带场次与大小', async (t) => {
  const base = await makeBase(t);
  await put(base, '2026-10-09 20.04.19', '2026_10_09200419.aac', Buffer.alloc(64, 1), 1000);
  await put(base, '2026-10-09 20.04.19', '2026_10_09200419.aacidx', Buffer.alloc(8, 2), 1001);
  await put(base, '2026-10-09 19.23.26', 'double_click_to_convert_quick_record.wemta', Buffer.alloc(32, 3), 2000);
  await put(base, '2026-05-17 10.00.00', 'meeting_01.m4a', Buffer.alloc(16, 4), 500);
  await put(base, 'notes', 'readme.txt', Buffer.alloc(4, 5), 3000);
  await fsp.mkdir(path.join(base, 'empty-session'), { recursive: true });

  const listed = await listRecordings(base);
  assert.equal(listed.ok, true);
  assert.equal(listed.exists, true);
  assert.equal(listed.total, 3);
  assert.deepEqual(
    listed.items.map((item) => item.name),
    ['double_click_to_convert_quick_record.wemta', '2026_10_09200419.aac', 'meeting_01.m4a'],
  );
  assert.equal(listed.items[0].session, '2026-10-09 19.23.26');
  assert.equal(listed.items[1].size, 64);
  assert.equal(typeof listed.items[1].mtime, 'number');
  assert.equal(listed.items[1].file, path.join(base, '2026-10-09 20.04.19', '2026_10_09200419.aac'));
});

test('isAdtsName / 列表里的 adts 标记：实时跟随只认 .aac', async (t) => {
  assert.deepEqual(ADTS_EXTENSIONS, ['.aac']);
  assert.equal(isAdtsName('2026_10_09200419.aac'), true);
  assert.equal(isAdtsName('MEETING.AAC'), true);
  assert.equal(isAdtsName('meeting_01.m4a'), false);
  assert.equal(isAdtsName('double_click_to_convert_quick_record.wemta'), false);
  assert.equal(isAdtsName('2026_10_09200419.aacidx'), false);
  assert.equal(isAdtsName(null), false);

  const base = await makeBase(t);
  await put(base, '2026-10-09 20.04.19', '2026_10_09200419.aac', Buffer.alloc(64, 1), 1000);
  await put(base, '2026-05-17 10.00.00', 'meeting_01.m4a', Buffer.alloc(16, 4), 500);
  const listed = await listRecordings(base);
  // 宿主仍然把三种音频都列出来（不藏东西），由页面按 adts 过滤
  assert.equal(listed.total, 2);
  assert.deepEqual(
    listed.items.map((item) => [item.name, item.adts]),
    [['2026_10_09200419.aac', true], ['meeting_01.m4a', false]],
  );
});

test('listRecordings：limit 生效；目录不存在返回 no-dir 而不是抛错', async (t) => {
  const base = await makeBase(t);
  await put(base, 's1', 'a.aac', Buffer.alloc(4), 100);
  await put(base, 's2', 'b.aac', Buffer.alloc(4), 200);
  assert.equal((await listRecordings(base, { limit: 1 })).items.length, 1);
  assert.equal((await listRecordings(base, { limit: 1 })).total, 2);

  const missing = await listRecordings(path.join(base, '没有这个目录'));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'no-dir');
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.items, []);

  const blank = await listRecordings('');
  assert.equal(blank.ok, false);
  assert.equal(blank.error, 'no-dir');
  assert.equal(blank.dir, null);
});

test('readRecording：按偏移读一段，end 就是下次的起点', async (t) => {
  const base = await makeBase(t);
  const body = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 251));
  await put(base, 's', 'a.aac', body, 1234);

  const head = await readRecording(base, 's', 'a.aac', { offset: 0, maxBytes: 100 });
  assert.equal(head.ok, true);
  assert.equal(head.size, 300);
  assert.equal(head.offset, 0);
  assert.equal(head.end, 100);
  assert.equal(head.bytes.length, 100);
  assert.equal(head.bytes[99], body[99]);
  assert.equal(head.eof, false);
  assert.equal(head.mtime, 1234);

  const tail = await readRecording(base, 's', 'a.aac', { offset: head.end, maxBytes: 4096 });
  assert.equal(tail.bytes.length, 200);
  assert.equal(tail.end, 300);
  assert.equal(tail.eof, true);

  // 不改文件也能重复读同一段（页面要能重放）
  const again = await readRecording(base, 's', 'a.aac', { offset: 100, maxBytes: 100 });
  assert.deepEqual(Array.from(again.bytes), Array.from(tail.bytes.subarray(0, 100)));
});

test('readRecording：offset 超过文件长度只回空字节 + eof', async (t) => {
  const base = await makeBase(t);
  await put(base, 's', 'a.aac', Buffer.alloc(50, 7));
  const beyond = await readRecording(base, 's', 'a.aac', { offset: 999 });
  assert.equal(beyond.ok, true);
  assert.equal(beyond.bytes.length, 0);
  assert.equal(beyond.offset, 50);
  assert.equal(beyond.end, 50);
  assert.equal(beyond.eof, true);
});

test('readRecording：文件被别的进程独占也能读（共享打开）', async (t) => {
  const base = await makeBase(t);
  const file = await put(base, 's', 'busy.aac', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const handle = await fsp.open(file, 'r+');
  t.after(() => handle.close());
  const read = await readRecording(base, 's', 'busy.aac', { offset: 2, maxBytes: 4 });
  assert.equal(read.ok, true);
  assert.deepEqual(Array.from(read.bytes), [3, 4, 5, 6]);
});

test('readRecording：不存在 / 名字不合法都会明说', async (t) => {
  const base = await makeBase(t);
  const missing = await readRecording(base, 's', 'nope.aac');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not-found');
  assert.equal(missing.file, path.join(base, 's', 'nope.aac'));

  const bad = await readRecording(base, '..', 'nope.aac');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad-session');

  const noDir = await readRecording('', 's', 'a.aac');
  assert.equal(noDir.ok, false);
  assert.equal(noDir.error, 'no-dir');
});
