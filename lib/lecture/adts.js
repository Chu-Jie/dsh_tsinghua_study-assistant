/**
 * ADTS（Audio Data Transport Stream）帧切分。
 *
 * 腾讯会议「录音笔」写出来的是 ADTS AAC：每个帧自带 7/9 字节头，头里有这一帧的
 * 长度。这件事的价值在于**帧是自描述的** —— 上课时文件在被一段段写长，我们只要
 * 从上次读到的位置继续，把「完整的那几帧」交出去解码就行，不必等整段录完。
 *
 * 本模块刻意不 import 任何 Node 内建模块：宿主（Node）和页面（浏览器）共用同一份。
 */

/** 帧头同步字：12 位全 1。 */
export const ADTS_SYNC_MASK = 0xfff0;
/** 不带 CRC 的帧头长度。 */
export const ADTS_HEADER_BYTES = 7;
/** 带 CRC 的帧头长度。 */
export const ADTS_HEADER_BYTES_CRC = 9;
/** frame_length 字段只有 13 位。 */
export const ADTS_MAX_FRAME_BYTES = 8191;
/** AAC 每帧固定 1024 个采样。 */
export const AAC_SAMPLES_PER_FRAME = 1024;

/** sampling_frequency_index → 采样率（13/14 保留，15 是显式频率，这里不支持）。 */
export const ADTS_SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350,
]);

function byteAt(bytes, index) {
  if (!bytes || index < 0 || index >= bytes.length) return -1;
  return bytes[index];
}

/** 这一对字节是不是同步字。 */
export function isAdtsSync(bytes, offset) {
  if (!bytes || offset < 0 || offset + 1 >= bytes.length) return false;
  return bytes[offset] === 0xff && (bytes[offset + 1] & 0xf0) === 0xf0;
}

/**
 * 解析 offset 处的帧头。
 *
 * 返回 `{ok:true, frameLength, headerBytes, sampleRate, channels, profile, crc}`，
 * 或 `{ok:false, reason}`，reason 取值：
 * `no-sync | bad-rate-index | bad-frame-length | truncated`。
 */
export function parseAdtsHeader(bytes, offset = 0) {
  if (!isAdtsSync(bytes, offset)) return { ok: false, reason: 'no-sync' };
  const b1 = byteAt(bytes, offset + 1);
  const b2 = byteAt(bytes, offset + 2);
  const b3 = byteAt(bytes, offset + 3);
  const b4 = byteAt(bytes, offset + 4);
  const b5 = byteAt(bytes, offset + 5);
  if (b5 < 0) return { ok: false, reason: 'truncated' };

  const crc = (b1 & 0x01) === 0;
  const profile = (b2 >> 6) & 0x03;
  const rateIndex = (b2 >> 2) & 0x0f;
  const channels = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
  const frameLength = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);
  const headerBytes = crc ? ADTS_HEADER_BYTES_CRC : ADTS_HEADER_BYTES;

  if (rateIndex >= ADTS_SAMPLE_RATES.length) return { ok: false, reason: 'bad-rate-index' };
  if (frameLength < headerBytes) return { ok: false, reason: 'bad-frame-length' };

  return {
    ok: true,
    frameLength,
    headerBytes,
    sampleRate: ADTS_SAMPLE_RATES[rateIndex],
    channels: channels === 0 ? 2 : channels,
    profile,
    crc,
  };
}

/** 从 from 起找下一个同步字；找不到返回 -1。 */
export function findSync(bytes, from = 0) {
  if (!bytes) return -1;
  for (let i = Math.max(0, from); i + 1 < bytes.length; i += 1) {
    if (isAdtsSync(bytes, i)) return i;
  }
  return -1;
}

/**
 * 把 `bytes[from..]` 切成完整的帧列表。
 *
 * 返回：
 *   `frames`  —— `[{offset, length, sampleRate, channels}]`（都是相对 bytes 的绝对下标）
 *   `rest`    —— 第一处「还没写完整 / 不是同步字」的位置；调用方应当把
 *                `bytes.slice(rest)` 留到下次读取时拼上去，不能丢
 *   `skipped` —— 从 from 到第一帧之间被跳过的字节数（丢包或头部杂讯）
 *   `sampleRate` / `channels` / `partialBytes` —— 从第一帧头读出的参数，便于调用方
 *                在还没有整帧时就先知道格式
 */
export function splitFrames(bytes, from = 0) {
  const out = { frames: [], rest: bytes ? bytes.length : 0, skipped: 0, sampleRate: 0, channels: 0 };
  if (!bytes || bytes.length === 0) return out;

  let cursor = Math.max(0, from);
  const first = findSync(bytes, cursor);
  if (first === -1) {
    // 一个同步字都没有：全是杂讯，别让调用方一直重扫同一段
    out.rest = bytes.length;
    out.skipped = bytes.length - cursor;
    return out;
  }
  out.skipped = first - cursor;
  cursor = first;

  while (cursor + 4 < bytes.length) {
    const header = parseAdtsHeader(bytes, cursor);
    if (!header.ok) {
      // 头部坏了（丢包）：往后找下一个同步字继续
      const next = findSync(bytes, cursor + 1);
      if (next === -1) break;
      out.skipped += next - cursor;
      cursor = next;
      continue;
    }
    if (cursor + header.frameLength > bytes.length) {
      // 这一帧还没写完
      break;
    }
    out.frames.push({
      offset: cursor,
      length: header.frameLength,
      sampleRate: header.sampleRate,
      channels: header.channels,
    });
    if (out.sampleRate === 0) {
      out.sampleRate = header.sampleRate;
      out.channels = header.channels;
    }
    cursor += header.frameLength;
  }

  out.rest = cursor;
  return out;
}

/** 一段帧合起来是多少秒。 */
export function framesSeconds(frameCount, sampleRate = 44100) {
  if (!Number.isFinite(frameCount) || frameCount <= 0 || !sampleRate) return 0;
  return (frameCount * AAC_SAMPLES_PER_FRAME) / sampleRate;
}

/**
 * 从头读格式而不解帧：给「刚拿到文件先显示格式」用。
 * 返回 `{ok, sampleRate, channels, headerBytes}` 或 `{ok:false, reason}`。
 */
export function inspectAdts(bytes) {
  const at = findSync(bytes, 0);
  if (at === -1) return { ok: false, reason: 'no-sync' };
  const header = parseAdtsHeader(bytes, at);
  if (!header.ok) return { ok: false, reason: header.reason };
  return {
    ok: true,
    sampleRate: header.sampleRate,
    channels: header.channels,
    headerBytes: header.headerBytes,
    offset: at,
  };
}
