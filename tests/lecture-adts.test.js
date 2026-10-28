import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AAC_SAMPLES_PER_FRAME,
  ADTS_MAX_FRAME_BYTES,
  findSync,
  framesSeconds,
  inspectAdts,
  isAdtsSync,
  parseAdtsHeader,
  splitFrames,
} from '../lib/lecture/adts.js';

/**
 * 造一个合法 ADTS 帧：`total` 是整帧长度（含帧头）。
 * 默认按腾讯会议录音笔的真实参数：MPEG-2 AAC-LC / 32 kHz / 单声道 / 无 CRC。
 */
function makeFrame(total, { rateIndex = 5, channels = 1, crc = false, profile = 1, fill = 0x7f } = {}) {
  assert.ok(total >= (crc ? 9 : 7), '帧长必须能装下帧头');
  const bytes = new Uint8Array(total);
  bytes[0] = 0xff;
  bytes[1] = crc ? 0xf0 : 0xf1;
  bytes[2] = ((profile & 0x03) << 6) | ((rateIndex & 0x0f) << 2) | ((channels >> 2) & 0x01);
  bytes[3] = ((channels & 0x03) << 6) | ((total >> 11) & 0x03);
  bytes[4] = (total >> 3) & 0xff;
  bytes[5] = ((total & 0x07) << 5) | 0x1f;
  bytes[6] = 0xfc;
  for (let i = crc ? 9 : 7; i < total; i += 1) bytes[i] = fill;
  return bytes;
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// 真实文件头：D:\会议录像\2026-10-09 20.04.19\2026_10_09200419.aac 的前 7 字节
const REAL_HEADER = new Uint8Array([0xff, 0xf1, 0x54, 0x40, 0x40, 0x01, 0x00]);

test('parseAdtsHeader：录音笔真实帧头 = 32 kHz / 单声道 / 512 字节帧', () => {
  const header = parseAdtsHeader(REAL_HEADER, 0);
  assert.equal(header.ok, true);
  assert.equal(header.frameLength, 512);
  assert.equal(header.headerBytes, 7);
  assert.equal(header.sampleRate, 32000);
  assert.equal(header.channels, 1);
  assert.equal(header.crc, false);
});

test('parseAdtsHeader：带 CRC 的帧头是 9 字节', () => {
  const header = parseAdtsHeader(makeFrame(300, { crc: true }), 0);
  assert.equal(header.ok, true);
  assert.equal(header.headerBytes, 9);
  assert.equal(header.frameLength, 300);
});

test('parseAdtsHeader：坏输入各有明确 reason', () => {
  assert.equal(parseAdtsHeader(new Uint8Array([0x00, 0x01, 0x02]), 0).reason, 'no-sync');
  assert.equal(parseAdtsHeader(new Uint8Array([0xff, 0xf0]), 0).reason, 'truncated');
  // rateIndex = 13 是保留值
  const bad = makeFrame(64);
  bad[2] = (bad[2] & 0xc3) | (13 << 2);
  assert.equal(parseAdtsHeader(bad, 0).reason, 'bad-rate-index');
  // frame_length 小于帧头长度
  const small = new Uint8Array(8);
  small.set([0xff, 0xf1, 0x54, 0x40, 0x00, 0x00, 0xfc]);
  assert.equal(parseAdtsHeader(small, 0).reason, 'bad-frame-length');
});

test('isAdtsSync / findSync：跳过前面的杂讯', () => {
  const bytes = concat([new Uint8Array([0x00, 0x11, 0x22]), makeFrame(64)]);
  assert.equal(isAdtsSync(bytes, 0), false);
  assert.equal(isAdtsSync(bytes, 3), true);
  assert.equal(findSync(bytes, 0), 3);
  assert.equal(findSync(new Uint8Array([1, 2, 3]), 0), -1);
});

test('splitFrames：三整帧全切出来，参数取第一帧', () => {
  const bytes = concat([makeFrame(512), makeFrame(512), makeFrame(300)]);
  const split = splitFrames(bytes, 0);
  assert.equal(split.frames.length, 3);
  assert.deepEqual(split.frames.map((f) => [f.offset, f.length]), [[0, 512], [512, 512], [1024, 300]]);
  assert.equal(split.sampleRate, 32000);
  assert.equal(split.channels, 1);
  assert.equal(split.skipped, 0);
  assert.equal(split.rest, 1324);
});

test('splitFrames：最后一帧没写完时 rest 停在它的帧头（增量读取的核心）', () => {
  const whole = concat([makeFrame(512), makeFrame(512)]);
  const partial = whole.slice(0, 700);
  const split = splitFrames(partial, 0);
  assert.equal(split.frames.length, 1);
  assert.equal(split.rest, 512);

  // 下次读到更多字节：把残留拼上新数据，第二帧才成形
  const next = concat([partial.slice(split.rest), whole.slice(700)]);
  const again = splitFrames(next, 0);
  assert.equal(again.frames.length, 1);
  assert.equal(again.frames[0].length, 512);
  assert.equal(again.rest, 512);
});

test('splitFrames：坏帧头之后能重新同步，并累计 skipped', () => {
  const good = makeFrame(300);
  const broken = new Uint8Array(good);
  broken[3] = 0x00; // 帧长被改成 0 → bad-frame-length
  broken[4] = 0x00;
  broken[5] = 0x1f;
  const bytes = concat([broken, good]);
  const split = splitFrames(bytes, 0);
  assert.equal(split.frames.length, 1);
  assert.equal(split.frames[0].offset, 300);
  assert.ok(split.skipped > 0);
});

test('splitFrames：一个同步字都没有时不会死循环，rest 推到末尾', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const split = splitFrames(bytes, 0);
  assert.equal(split.frames.length, 0);
  assert.equal(split.rest, bytes.length);
  assert.equal(split.skipped, bytes.length);
  assert.equal(splitFrames(null, 0).rest, 0);
  assert.equal(splitFrames(new Uint8Array(0), 0).frames.length, 0);
});

test('splitFrames：带 CRC 的帧按 9 字节头解析', () => {
  const bytes = concat([makeFrame(400, { crc: true }), makeFrame(400, { crc: true })]);
  const split = splitFrames(bytes, 0);
  assert.equal(split.frames.length, 2);
  assert.deepEqual(split.frames.map((f) => f.length), [400, 400]);
  assert.equal(split.rest, 800);
});

test('framesSeconds / 常量：按 1024 采样一帧算时长', () => {
  assert.equal(AAC_SAMPLES_PER_FRAME, 1024);
  assert.equal(framesSeconds(31, 32000), 0.992);
  assert.equal(framesSeconds(0, 32000), 0);
  assert.equal(framesSeconds(-3, 32000), 0);
  assert.equal(framesSeconds(10, 0), 0);
  assert.equal(ADTS_MAX_FRAME_BYTES, 8191);
});

test('inspectAdts：只读格式，不要求整帧完整', () => {
  const bytes = concat([new Uint8Array([0xaa, 0xbb]), REAL_HEADER]);
  const info = inspectAdts(bytes);
  assert.equal(info.ok, true);
  assert.equal(info.sampleRate, 32000);
  assert.equal(info.channels, 1);
  assert.equal(info.offset, 2);
  assert.equal(inspectAdts(new Uint8Array([9, 9, 9])).reason, 'no-sync');
});
