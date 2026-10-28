/**
 * 课堂录音的 WAV 工具（**同构**：Node 与浏览器共用同一份源码）
 *
 * 为什么单独一个文件、而且刻意不 import 任何 Node 内建模块：
 *   浏览器里的录音页要「录 → 重采样 → 打包成 WAV」，
 *   服务端要「先校验再送转写」。两边的格式约定必须**逐字一致**，
 *   否则页面辛苦采的音频会被服务端一句 `bad-audio` 丢掉，还很难查。
 *   所以把打包与校验放进同一个文件，页面直接把它当 ES 模块 import，
 *   测试也能在 Node 里用**页面同款函数**造样本去喂服务端。
 *
 * 格式为什么非得是 16 kHz 单声道 PCM16：
 *   DSH 的 `speechToText` 在解析 provider 之前会逐字段校验 WAV
 *   （见 `dsh-experimental-speech-to-text/lib/types/wave.js` 的 validateWave），
 *   不符合就直接抛
 *   `Audio must be a canonical 16 kHz mono PCM16 WAV recording`。
 */

/** 采样率：DSH 语音服务只认这一个。 */
export const LECTURE_SAMPLE_RATE = 16000;
/** 声道数：只认单声道。 */
export const LECTURE_CHANNELS = 1;
/** 位深：只认 16 位。 */
export const LECTURE_BITS = 16;
/** 规范 WAV 的头部长度（RIFF + fmt + data，无附加块）。 */
export const WAV_HEADER_BYTES = 44;
/** 每秒音频占用的字节数（16 kHz × 1 声道 × 2 字节）。 */
export const LECTURE_BYTES_PER_SECOND = (LECTURE_SAMPLE_RATE * LECTURE_CHANNELS * LECTURE_BITS) / 8;

/** 一段音频秒数 → 规范 WAV 的总字节数（含 44 字节头）。 */
export function wavBytesForSeconds(seconds) {
  return WAV_HEADER_BYTES + Math.round(seconds * LECTURE_BYTES_PER_SECOND);
}

/**
 * 把任意「类字节」输入统一成 Uint8Array 视图。
 *
 * ⚠️ 不能直接 `new Uint8Array(buf.buffer)`：Node 的 Buffer 常是分配池里的一段，
 *    `.buffer` 指向整个池，会把无关字节当音频读进来（长度还会「对得上」，
 *    于是错误一路走到底）。必须带上 byteOffset / byteLength。
 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** 复制成一段独立的字节：送进宿主前用它，彻底摆脱分配池的疑虑。 */
export function copyBytes(value) {
  const view = toBytes(value);
  if (view === null) return null;
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/** 小端写入 ASCII 标记。 */
function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i) & 0xff);
}

/** 小端读取 ASCII 标记。 */
function readAscii(bytes, start, end) {
  let text = '';
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

/**
 * Float32 单声道样本（取值 -1..1）→ 规范 16 kHz 单声道 PCM16 WAV。
 *
 * 越界样本钳位而不是回绕：麦克风偶发爆音时，回绕会变成刺耳的爆裂声，
 * 反而更容易把识别带偏。
 */
export function float32ToWavPcm16(samples, sampleRate = LECTURE_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) && !Array.isArray(samples)) {
    throw new TypeError('float32ToWavPcm16 需要 Float32Array 或普通数组');
  }
  const count = samples.length;
  const dataBytes = count * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, LECTURE_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * LECTURE_CHANNELS * 2, true); // 字节率
  view.setUint16(32, LECTURE_CHANNELS * 2, true); // 块对齐
  view.setUint16(34, LECTURE_BITS, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < count; i += 1) {
    const raw = samples[i];
    const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    // 正负半轴分别用 0x7fff / 0x8000：对称缩放会让 +1 溢出成负数
    const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    view.setInt16(WAV_HEADER_BYTES + i * 2, value, true);
  }
  return out;
}

/**
 * 线性插值重采样。
 *
 * 为什么要它：我们请求 `new AudioContext({sampleRate: 16000})`，但浏览器**有权
 * 拒绝**（硬件只支持 44.1k/48k 时会回落）。一旦回落，直接按 48k 打包就会让
 * 服务端拿到「头里写 16k、实际 48k」的音频 —— 校验能过，转写结果却是乱码。
 * 所以这里按实际采样率兜一手，保证送出去的字节名副其实。
 */
export function resampleLinear(samples, fromRate, toRate = LECTURE_SAMPLE_RATE) {
  if (fromRate === toRate) return samples instanceof Float32Array ? samples : Float32Array.from(samples);
  const input = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  if (input.length === 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = left + 1 >= input.length ? input.length - 1 : left + 1;
    const weight = position - left;
    out[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return out;
}

/**
 * 校验一段字节是不是「规范 16 kHz 单声道 PCM16 WAV」。
 *
 * 与服务端 `validateWave` 的判定**逐条对应**，但这里返回原因而不是抛异常 ——
 * 接口要把原因回给页面，让人一眼看出是采样率错了还是根本没收着音频。
 *
 * @returns {{ok: true, seconds: number, audioBytes: number} | {ok: false, reason: string, seconds?: number}}
 */
export function inspectWav(bytes, maxSeconds = 0) {
  const data = toBytes(bytes);
  if (data === null) return { ok: false, reason: 'not-bytes' };
  if (data.length < 46) return { ok: false, reason: 'too-short' };
  if (readAscii(data, 0, 4) !== 'RIFF') return { ok: false, reason: 'not-riff' };
  if (readAscii(data, 8, 12) !== 'WAVE') return { ok: false, reason: 'not-wave' };
  if (readAscii(data, 12, 16) !== 'fmt ') return { ok: false, reason: 'missing-fmt' };
  if (readAscii(data, 36, 40) !== 'data') return { ok: false, reason: 'missing-data' };

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(16, true) !== 16) return { ok: false, reason: 'bad-fmt-size' };
  if (view.getUint16(20, true) !== 1) return { ok: false, reason: 'not-pcm' };
  if (view.getUint16(22, true) !== LECTURE_CHANNELS) return { ok: false, reason: 'not-mono' };
  const rate = view.getUint32(24, true);
  if (rate !== LECTURE_SAMPLE_RATE) return { ok: false, reason: 'bad-sample-rate', sampleRate: rate };
  if (view.getUint32(28, true) !== LECTURE_SAMPLE_RATE * 2) return { ok: false, reason: 'bad-byte-rate' };
  if (view.getUint16(32, true) !== 2) return { ok: false, reason: 'bad-block-align' };
  if (view.getUint16(34, true) !== LECTURE_BITS) return { ok: false, reason: 'bad-bit-depth' };
  if (view.getUint32(4, true) !== data.length - 8) return { ok: false, reason: 'bad-riff-size' };
  if (view.getUint32(40, true) !== data.length - WAV_HEADER_BYTES) return { ok: false, reason: 'bad-data-size' };
  if ((data.length - WAV_HEADER_BYTES) % 2 !== 0) return { ok: false, reason: 'odd-payload' };

  const seconds = (data.length - WAV_HEADER_BYTES) / LECTURE_BYTES_PER_SECOND;
  if (maxSeconds > 0 && seconds > maxSeconds) return { ok: false, reason: 'too-long', seconds };
  return { ok: true, seconds, audioBytes: data.length - WAV_HEADER_BYTES };
}

/** 把 RMS（0..1）换算成 0..100 的音量条宽度，用对数刻度让小音量也看得见。 */
export function levelPercent(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const percent = ((db + 60) / 60) * 100; // -60 dB → 0%，0 dB → 100%
  return Math.max(0, Math.min(100, Math.round(percent)));
}
