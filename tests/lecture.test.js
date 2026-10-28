/**
 * 听课（M1）接口测试（零依赖）
 * 运行：node tests/lecture.test.js
 *
 * 覆盖三块：
 *   1. wav.js 本身 —— 打包与校验必须自洽（打包出来的东西自己得认）；
 *   2. GET /lecture/panel、/lecture/wav.js —— 页面与模块能被浏览器取到；
 *   3. POST /lecture/chunk —— 校验顺序与错误码，这些是页面唯一能拿到的线索。
 *
 * 语音服务用**桩**而不是真模型：这里要验的是「桥没接上/接上了/报错了」
 * 三种分支的**接口行为**，不是识别质量。识别率只能真机量。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER, LECTURE_MAX_BODY_BYTES } from '../lib/api.js';
import {
  float32ToWavPcm16,
  inspectWav,
  resampleLinear,
  wavBytesForSeconds,
  copyBytes,
  levelPercent,
  LECTURE_SAMPLE_RATE,
  LECTURE_BYTES_PER_SECOND,
  WAV_HEADER_BYTES,
} from '../lib/lecture/wav.js';
import { createSpeechBridge, LECTURE_LANGUAGES } from '../lib/lecture/asr.js';
import { CLIENT_MODULE_FILES, clientModulePath } from '../lib/lecture/panel.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/**
 * 起一个真实服务。
 *
 * `speech` 传 null 就模拟「实验包没启用」，传桩对象就模拟「接上了」——
 * 接口内部只通过 `deps.speech` 取它，所以这里能直接控制那条分支。
 */
async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-lecture-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {} },
    speech: options.speech ?? null,
    studentName: options.studentName,
    summarizer: options.summarizer ?? null,
    handoff: options.handoff ?? null,
    recordingDir: options.recordingDir ?? '',
  });
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
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

/** 能过校验的音频桥桩；`transcribe` 的行为可按用例替换。 */
function stubSpeech(overrides = {}) {
  const calls = [];
  return {
    calls,
    status: async () => ({
      available: true,
      hint: '',
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: LECTURE_LANGUAGES }],
    }),
    available: () => true,
    transcribe: async (audio, request) => {
      const checked = inspectWav(audio);
      calls.push({ bytes: audio.byteLength, request, seconds: checked.ok ? checked.seconds : null });
      return {
        ok: true,
        text: '同学们看这道题',
        audioSeconds: checked.ok ? checked.seconds : 0,
        inferenceSeconds: 0.42,
        wallMs: 460,
        language: request?.language ?? 'auto',
      };
    },
    ...overrides,
  };
}

/** 造一段能过校验的正弦波 WAV；sampleRate 传 8000 就能造出「非法采样率」的样本。 */
function makeWav(seconds, sampleRate = LECTURE_SAMPLE_RATE) {
  const count = Math.max(1, Math.round(seconds * sampleRate));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return float32ToWavPcm16(samples, sampleRate);
}

/** 发一片录音。`withHeader: false` 用来看写请求校验是否真的生效。 */
function chunkRequest(baseUrl, body, options = {}) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  return fetch(`${baseUrl}/lecture/chunk${options.query ?? ''}`, {
    method: 'POST',
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// wav.js：打包与校验自洽
// ---------------------------------------------------------------------------

test('float32ToWavPcm16 打包出来的 WAV 能被 inspectWav 认下来', () => {
  const wav = makeWav(1);
  const checked = inspectWav(wav);
  assert.equal(checked.ok, true);
  assert.equal(checked.seconds, 1);
  assert.equal(checked.audioBytes, LECTURE_BYTES_PER_SECOND);
  assert.equal(wav.byteLength, wavBytesForSeconds(1));
  assert.equal(wav.byteLength, WAV_HEADER_BYTES + LECTURE_BYTES_PER_SECOND);
});

test('inspectWav 逐条拒绝不合规的字节', () => {
  assert.deepEqual(inspectWav('nope'), { ok: false, reason: 'not-bytes' });
  assert.equal(inspectWav(new Uint8Array(0)).reason, 'too-short');
  assert.equal(inspectWav(new Uint8Array(64)).reason, 'not-riff');

  const broken = makeWav(0.5);
  broken[0] = 0x58; // 破坏 RIFF 标记
  assert.equal(inspectWav(broken).reason, 'not-riff');

  const eightK = makeWav(0.5, 8000);
  const bad = inspectWav(eightK);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-sample-rate');
  assert.equal(bad.sampleRate, 8000);

  const short = makeWav(0.5).slice(0, 40);
  assert.equal(inspectWav(short).reason, 'too-short');
});

test('inspectWav 认得出声道数、位深与字节率', () => {
  const wav = makeWav(0.5);
  const stereo = copyBytes(wav);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(inspectWav(stereo).reason, 'not-mono');

  const wrongDepth = copyBytes(wav);
  new DataView(wrongDepth.buffer).setUint16(34, 8, true);
  assert.equal(inspectWav(wrongDepth).reason, 'bad-bit-depth');

  const wrongByteRate = copyBytes(wav);
  new DataView(wrongByteRate.buffer).setUint32(28, 16000, true);
  assert.equal(inspectWav(wrongByteRate).reason, 'bad-byte-rate');
});

test('inspectWav 的 too-long 判定与 maxSeconds 对应', () => {
  const wav = makeWav(1);
  assert.equal(inspectWav(wav, 2).ok, true);
  const limited = inspectWav(wav, 0.5);
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'too-long');
});

test('copyBytes 复制而不是共享内存', () => {
  const source = makeWav(0.2);
  const copy = copyBytes(source);
  copy[0] = 0x00;
  assert.equal(source[0], 0x52); // 'R' 仍在
  assert.equal(copyBytes('nope'), null);
});

test('resampleLinear 把 48 kHz 降到 16 kHz，长度按比例缩短', () => {
  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 10);
  const out = resampleLinear(input, 48000, 16000);
  assert.equal(out.length, 1600);
  // 采样率相同则原样返回，不做无谓的复制与抖动
  assert.equal(resampleLinear(input, 16000, 16000), input);
});

test('levelPercent 把 RMS 映射到 0..100，并夹住边界', () => {
  assert.equal(levelPercent(0), 0);
  assert.equal(levelPercent(-1), 0);
  assert.equal(levelPercent(1), 100);
  assert.equal(levelPercent(1000), 100);
  assert.equal(levelPercent(0.001), 0);
  assert.equal(levelPercent(0.1), 67); // −20 dB → (−20 + 60) / 60
  assert.equal(levelPercent(0.5), 90); // −6 dB
  assert.equal(levelPercent(null), 0);
});

// ---------------------------------------------------------------------------
// GET /lecture/health、/lecture/panel、/lecture/wav.js
// ---------------------------------------------------------------------------

test('GET /lecture/health：语音服务没接上也是 200，并给出引导', async () => {
  const server = await startServer({ speech: null });
  try {
    const response = await fetch(`${server.baseUrl}/lecture/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.speech.available, false);
    assert.equal(payload.speech.providers.length, 0);
    assert.ok(payload.speech.hint.length > 0);
    assert.equal(payload.sampleRate, LECTURE_SAMPLE_RATE);
    assert.equal(payload.panel, `${API_PREFIX}/lecture/panel`);
  } finally {
    await server.close();
  }
});

test('GET /lecture/health：接上语音服务后报告 provider', async () => {
  const server = await startServer({ speech: stubSpeech() });
  try {
    const payload = await (await fetch(`${server.baseUrl}/lecture/health`)).json();
    assert.equal(payload.speech.available, true);
    assert.equal(payload.speech.providers[0].id, 'sensevoice-local');
  } finally {
    await server.close();
  }
});

test('GET /lecture/panel：返回 HTML 页面', async () => {
  const server = await startServer({ speech: null });
  try {
    const response = await fetch(`${server.baseUrl}/lecture/panel`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.ok(html.startsWith('<!doctype html'));
    assert.ok(html.includes("from './wav.js'"));
    // 页面里的头名是大小写混排的 'X-Study-Request'，这里按小写比对
    assert.ok(html.toLowerCase().includes(REQUEST_HEADER));
  } finally {
    await server.close();
  }
});

test('GET /lecture/wav.js：返回页面 import 的那份同构模块', async () => {
  const server = await startServer({ speech: null });
  try {
    const response = await fetch(`${server.baseUrl}/lecture/wav.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    assert.ok(source.includes('export function inspectWav'));
    assert.ok(source.includes('export function float32ToWavPcm16'));
  } finally {
    await server.close();
  }
});

test('GET /lecture/<未登记的模块>：404', async () => {
  const server = await startServer({ speech: null });
  try {
    // asr.js 存在于磁盘上，但它不在页面模块白名单里，不该被当静态文件发出去
    const response = await fetch(`${server.baseUrl}/lecture/asr.js`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'unknown-module');
  } finally {
    await server.close();
  }
});

test('clientModulePath 只放行白名单里的文件名', () => {
  assert.deepEqual(CLIENT_MODULE_FILES, ['wav.js', 'adts.js']);
  assert.ok(clientModulePath('wav.js').endsWith('wav.js'));
  assert.ok(clientModulePath('adts.js').endsWith('adts.js'));
  assert.equal(clientModulePath('../store.js'), null);
  assert.equal(clientModulePath('asr.js'), null);
  assert.equal(clientModulePath(''), null);
});

// ---------------------------------------------------------------------------
// POST /lecture/chunk
// ---------------------------------------------------------------------------

test('POST /lecture/chunk：正常路径把音频交给桥并回传文本', async () => {
  const speech = stubSpeech();
  const server = await startServer({ speech });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(8), { query: '?language=zh' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.text, '同学们看这道题');
    assert.equal(payload.seconds, 8);
    assert.equal(payload.bytes, wavBytesForSeconds(8));
    assert.equal(payload.language, 'zh');
    assert.equal(payload.inferenceSeconds, 0.42);
    assert.equal(speech.calls.length, 1);
    assert.equal(speech.calls[0].request.language, 'zh');
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：语种缺省为 auto', async () => {
  const speech = stubSpeech();
  const server = await startServer({ speech });
  try {
    const payload = await (await chunkRequest(server.baseUrl, makeWav(1))).json();
    assert.equal(payload.language, 'auto');
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：缺少写请求头时 403，且不惊动语音服务', async () => {
  const speech = stubSpeech();
  const server = await startServer({ speech });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(1), { withHeader: false });
    assert.equal(response.status, 403);
    assert.equal(speech.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：非 WAV 报 bad-audio 而不是 500', async () => {
  const speech = stubSpeech();
  const server = await startServer({ speech });
  try {
    const response = await chunkRequest(server.baseUrl, Buffer.from('这不是音频'));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'bad-audio');
    assert.equal(payload.reason, 'too-short');
    assert.equal(speech.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：8 kHz 音频被拒，并回传实际采样率', async () => {
  const server = await startServer({ speech: stubSpeech() });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(1, 8000));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'bad-audio');
    assert.equal(payload.reason, 'bad-sample-rate');
    assert.equal(payload.sampleRate, 8000);
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：短于 0.3 秒判为误触', async () => {
  const speech = stubSpeech();
  const server = await startServer({ speech });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(0.1));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'audio-too-short');
    assert.equal(speech.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：语音服务没接上时 503 + 引导文案', async () => {
  const server = await startServer({ speech: null });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(1));
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'speech-unavailable');
    assert.ok(payload.detail.includes('voice-input'));
  } finally {
    await server.close();
  }
});

test('POST /lecture/chunk：桥报告失败时 502，超时映射 504', async () => {
  const failing = stubSpeech({ transcribe: async () => ({ ok: false, error: 'speech-failed', detail: 'boom' }) });
  const server = await startServer({ speech: failing });
  try {
    const response = await chunkRequest(server.baseUrl, makeWav(1));
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'speech-failed');
    // 失败响应也要带上音频时长，页面才知道是哪一片出的问题
    assert.equal(payload.seconds, 1);
  } finally {
    await server.close();
  }

  const timingOut = stubSpeech({ transcribe: async () => ({ ok: false, error: 'speech-timeout', detail: '太慢' }) });
  const server2 = await startServer({ speech: timingOut });
  try {
    assert.equal((await chunkRequest(server2.baseUrl, makeWav(1))).status, 504);
  } finally {
    await server2.close();
  }
});

test('POST /lecture/chunk：超过单片上限时 413', async () => {
  const server = await startServer({ speech: stubSpeech() });
  try {
    const response = await chunkRequest(server.baseUrl, new Uint8Array(LECTURE_MAX_BODY_BYTES + 2048));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'too-large');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// asr.js：桥本身（不依赖真服务）
// ---------------------------------------------------------------------------

test('createSpeechBridge：服务缺失时 status 说明未就绪、transcribe 不抛异常', async () => {
  const bridge = createSpeechBridge({ getService: () => undefined, logger: { error() {} } });
  const status = await bridge.status();
  assert.equal(status.available, false);
  assert.equal(bridge.available(), false);
  assert.ok(status.hint.length > 0);

  const result = await bridge.transcribe(makeWav(1), { language: 'auto' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'speech-unavailable');
});

test('createSpeechBridge：resolve 抛错与 transcribe 抛错分别归类', async () => {
  const resolveFails = createSpeechBridge({
    getService: () => ({ resolve: () => { throw new Error('没有 provider'); } }),
    logger: { error() {} },
  });
  const first = await resolveFails.transcribe(makeWav(1), { language: 'auto' });
  assert.equal(first.ok, false);
  assert.equal(first.error, 'speech-resolve-failed');

  const transcribeFails = createSpeechBridge({
    getService: () => ({
      resolve: () => ({ provider: { id: 'stub' }, audio: new Uint8Array(0), language: 'auto' }),
      transcribe: async () => { throw new Error('worker 挂了'); },
    }),
    logger: { error() {} },
  });
  const second = await transcribeFails.transcribe(makeWav(1), { language: 'auto' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'speech-failed');
  assert.ok(second.detail.includes('worker 挂了'));
});

test('createSpeechBridge：成功路径把 resolve 出的 spec 原样交给 transcribe', async () => {
  const seen = [];
  const spec = { provider: { id: 'stub' }, audio: new Uint8Array([1, 2]), language: 'zh' };
  const bridge = createSpeechBridge({
    getService: () => ({
      resolve: (request) => { seen.push(request); return spec; },
      transcribe: async (given, signal) => {
        seen.push({ sameSpec: given === spec, hasSignal: typeof signal?.aborted === 'boolean' });
        return { text: '好', audioSeconds: 1, inferenceSeconds: 0.1 };
      },
    }),
    logger: { error() {} },
  });
  const result = await bridge.transcribe(makeWav(1), { language: 'zh' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '好');
  assert.equal(result.language, 'zh');
  assert.equal(seen[1].sameSpec, true);
  assert.equal(seen[1].hasSignal, true);
});

test('createSpeechBridge：超时会被 AbortController 掐断', async () => {
  const bridge = createSpeechBridge({
    getService: () => ({
      resolve: () => ({ provider: { id: 'stub' }, audio: new Uint8Array(0), language: 'auto' }),
      transcribe: (spec, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          // 桥是按 `error.name === 'AbortError'` 判定超时的，
          // 所以这里要造一个名副其实的 AbortError，否则会被归成 speech-failed
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    }),
    logger: { error() {} },
  });
  const result = await bridge.transcribe(makeWav(1), { language: 'auto', timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'speech-timeout');
  assert.ok(result.detail.includes('0 秒') || result.detail.includes('秒'));
});

// ---------------------------------------------------------------------------
// 听课分析管线：/lecture/session/*、/lecture/feed、/lecture/state、/lecture/sessions
//
// 这一组接口的**输入是文本**，和音频那条链路完全解耦 —— 读屏 OCR 还没做出来，
// 但整条分析链路（累积逐字稿 → 点名/答题检测 → 落盘）已经能靠它跑通并验收。
// ---------------------------------------------------------------------------

/** 发一个写请求（JSON + X-Study-Request）。`body: undefined` 就是空 body。 */
function apiPost(baseUrl, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

test('听课管线：开始 → 喂逐字稿 → 拿提醒 → 确认 → 结束落盘', async () => {
  const server = await startServer({ studentName: '示例同学' });
  try {
    // 没开始就喂文本 —— 要让调用方拿到明确的 409，而不是静默丢掉
    const early = await apiPost(server.baseUrl, '/lecture/feed', { text: '示例同学' });
    assert.equal(early.status, 409);
    assert.equal((await early.json()).error, 'no-session');

    const started = await apiPost(server.baseUrl, '/lecture/session/start', {
      course: '高等数学',
      source: 'screen',
    });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).session.course, '高等数学');

    const fed = await apiPost(server.baseUrl, '/lecture/feed', {
      text: '今天我们讲函数的连续性，示例同学同学你来回答一下',
    });
    assert.equal(fed.status, 200);
    const fedBody = await fed.json();
    assert.equal(fedBody.appended, '今天我们讲函数的连续性，示例同学同学你来回答一下');
    assert.equal(fedBody.alerts.length, 1);
    assert.equal(fedBody.alerts[0].kind, 'name');
    assert.equal(fedBody.alerts[0].label, '叫到你');
    const alertId = fedBody.alerts[0].id;

    const state = await (await fetch(`${server.baseUrl}/lecture/state`)).json();
    assert.equal(state.running, true);
    assert.equal(state.segments.length, 1);
    assert.equal(state.alerts.length, 1);
    assert.ok(state.textTail.includes('示例同学'));

    const acked = await apiPost(server.baseUrl, '/lecture/alert/ack', { id: alertId });
    assert.equal(acked.status, 200);
    assert.equal((await (await fetch(`${server.baseUrl}/lecture/state`)).json()).alerts.length, 0);

    // 结束：空 body 不该被当成坏请求
    const stopped = await apiPost(server.baseUrl, '/lecture/session/stop');
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json();
    assert.equal(stoppedBody.course, '高等数学');
    assert.equal(stoppedBody.stats.frames, 1);
    assert.ok(stoppedBody.file.endsWith('高等数学.json'));

    // 落盘文件真的在数据目录里，且内容是完整记录而不是空壳
    const saved = JSON.parse(await fs.readFile(stoppedBody.file, 'utf8'));
    assert.equal(saved.kind, 'lecture-transcript');
    assert.equal(saved.text, '今天我们讲函数的连续性，示例同学同学你来回答一下');
    assert.equal(saved.alerts.length, 1);

    const sessions = await (await fetch(`${server.baseUrl}/lecture/sessions`)).json();
    assert.equal(sessions.ok, true);
    assert.deepEqual(sessions.items.map((item) => item.name), [path.basename(stoppedBody.file)]);

    // 结束后不再有运行中的会话
    const after = await (await fetch(`${server.baseUrl}/lecture/state`)).json();
    assert.equal(after.running, false);
    assert.equal(after.session, null);
  } finally {
    await server.close();
  }
});

test('听课管线：写接口缺 X-Study-Request 一律 403', async () => {
  const server = await startServer({});
  try {
    for (const path of ['/lecture/session/start', '/lecture/feed', '/lecture/alert/ack']) {
      const response = await apiPost(server.baseUrl, path, { text: 'x' }, { withHeader: false });
      assert.equal(response.status, 403, `${path} 必须拒绝缺头的请求`);
      assert.equal((await response.json()).error, 'need-request-header');
    }
  } finally {
    await server.close();
  }
});

test('听课管线：同名课程重复开课被拒，空文本不算一帧', async () => {
  const server = await startServer({});
  try {
    await apiPost(server.baseUrl, '/lecture/session/start', { course: '线性代数' });
    const again = await apiPost(server.baseUrl, '/lecture/session/start', { course: '概率论' });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'session-active');

    const blank = await apiPost(server.baseUrl, '/lecture/feed', { text: '   \n  ' });
    assert.equal(blank.status, 200);
    const blankBody = await blank.json();
    assert.equal(blankBody.appended, '');
    assert.deepEqual(blankBody.alerts, []);
    assert.equal((await (await fetch(`${server.baseUrl}/lecture/state`)).json()).segments.length, 0);
  } finally {
    await server.close();
  }
});

test('听课管线：ack 一个不存在的提醒返回 404', async () => {
  const server = await startServer({});
  try {
    await apiPost(server.baseUrl, '/lecture/session/start', { course: '大学物理' });
    const response = await apiPost(server.baseUrl, '/lecture/alert/ack', { id: 'a999' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'unknown-alert');
  } finally {
    await server.close();
  }
});

test('GET /lecture/health：带上会话状态与学生姓名，供面板回显', async () => {
  const server = await startServer({ studentName: '示例同学' });
  try {
    const before = await (await fetch(`${server.baseUrl}/lecture/health`)).json();
    assert.equal(before.lecture.running, false);
    assert.equal(before.lecture.studentName, '示例同学');

    await apiPost(server.baseUrl, '/lecture/session/start', { course: '高等数学' });
    const after = await (await fetch(`${server.baseUrl}/lecture/health`)).json();
    assert.equal(after.lecture.running, true);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 课后收尾：结构化总结 → 写 md 笔记 → 交接给一个新会话
//
// 这条链路整个是**异步**的：`/lecture/session/stop` 只负责把逐字稿写盘，然后立刻
// 返回；总结（可能要几十秒）在后面跑，面板轮询 `/lecture/report` 拿结果。
// 所以下面的用例都要轮询，而不是断言一次就完。
// ---------------------------------------------------------------------------

/** 假总结引擎：钉住课后收尾的调度，不碰真模型（也就不花钱）。 */
function stubSummarizer(overrides = {}) {
  return {
    available: () => true,
    setCourse() {},
    reset() {},
    shouldRoll: () => false,
    roll: async () => ({ ok: true, text: '（假引擎的脉络）' }),
    answer: async () => ({ ok: false, skipped: 'not-a-question' }),
    summarize: async () => ({
      ok: true,
      raw: '',
      summary: {
        overview: '这节课讲了函数的连续性。',
        points: [{ title: '连续的定义', detail: '左右极限都存在且等于函数值' }],
        questions: [],
        terms: ['连续'],
        todos: [],
        followups: ['为什么要先定义极限'],
      },
    }),
    ...overrides,
  };
}

/** 轮询课后收尾状态，直到跑完（或超时）。 */
async function waitForReport(baseUrl, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    report = (await (await fetch(`${baseUrl}/lecture/report`)).json()).report;
    if (report !== null && typeof report.stage === 'string'
      && (report.stage === 'done' || report.stage === 'done-no-session' || report.stage === 'note-failed')) {
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return report;
}

test('课后收尾：结束 → 后台总结 → 写 md 笔记 → 交接给新会话', async () => {
  const handoffs = [];
  const server = await startServer({
    studentName: '示例同学',
    summarizer: stubSummarizer(),
    handoff: async (input) => {
      handoffs.push(input);
      return { ok: true, sessionId: 'session-fake', titled: true };
    },
  });
  try {
    // 还没下课就查收尾状态：必须是「没有」而不是报错
    const idle = await (await fetch(`${server.baseUrl}/lecture/report`)).json();
    assert.equal(idle.ok, true);
    assert.equal(idle.report, null);

    await apiPost(server.baseUrl, '/lecture/session/start', { course: '高等数学', source: 'screen' });
    await apiPost(server.baseUrl, '/lecture/feed', { text: '今天我们讲函数的连续性，示例同学同学你来回答一下' });

    const stopped = await (await apiPost(server.baseUrl, '/lecture/session/stop')).json();
    assert.equal(stopped.ok, true);
    assert.ok(stopped.file.endsWith('.json'));
    assert.equal(stopped.stats.frames, 1);
    assert.equal(stopped.alerts.length, 1);
    // 结束的响应里就带着一份收尾快照，面板不必再查一次才知道「开始了」
    assert.equal(stopped.report.course, '高等数学');

    const report = await waitForReport(server.baseUrl);
    assert.equal(report.stage, 'done');
    assert.equal(report.summaryOk, true);
    assert.equal(report.note.ok, true);
    assert.equal(report.note.fallback, true); // 临时目录里没有「高等数学」目录 → 退到 <dataDir>/笔记/
    assert.ok(report.note.file.includes('笔记'));
    assert.ok(report.note.file.endsWith('高等数学.md'));
    assert.equal(report.handoff.sessionId, 'session-fake');
    assert.equal(report.handoff.titled, true);

    const note = await fs.readFile(report.note.file, 'utf8');
    assert.ok(note.includes('# 高等数学'));
    assert.ok(note.includes('这节课讲了函数的连续性。'));
    assert.ok(note.includes('连续的定义'));
    assert.ok(note.includes('示例同学')); // 笔记头要写明是谁的课
    assert.ok(note.includes(report.transcriptFile)); // 笔记里留逐字稿路径，方便回头查

    assert.equal(handoffs.length, 1);
    assert.ok(handoffs[0].prompt.includes('高等数学'));
    assert.ok(handoffs[0].prompt.includes(report.note.file));
    assert.ok(typeof handoffs[0].cwd === 'string' && handoffs[0].cwd !== '');
    assert.equal(handoffs[0].title, '高等数学 · 课后追问');
  } finally {
    await server.close();
  }
});

test('课后收尾：模型不可用时笔记照样写，只是降级并标注原因', async () => {
  const server = await startServer({ studentName: '示例同学' }); // 既没总结引擎也没会话服务
  try {
    await apiPost(server.baseUrl, '/lecture/session/start', { course: '高等数学' });
    await apiPost(server.baseUrl, '/lecture/feed', { text: '今天我们讲函数的连续性' });
    await apiPost(server.baseUrl, '/lecture/session/stop');

    const report = await waitForReport(server.baseUrl);
    assert.equal(report.stage, 'done-no-session');
    assert.equal(report.summaryOk, false);
    assert.equal(report.summaryError, 'llm-unavailable');
    assert.equal(report.note.ok, true);
    assert.equal(report.handoff.error, 'no-handoff');

    const note = await fs.readFile(report.note.file, 'utf8');
    assert.ok(note.includes('自动总结没成（llm-unavailable）'));
    assert.ok(note.includes('今天我们讲函数的连续性')); // 没有结构化总结时降级成逐字稿摘录
  } finally {
    await server.close();
  }
});

const RECORDING_SESSION = '2026-10-09 20.04.19';
const RECORDING_NAME = '2026_10_09200419.aac';

/** 造一个装了「一条录音笔文件」的临时录像目录。 */
async function makeRecordingDir(bytes = 300) {
  const dir = await makeTempDir('study-assistant-recordings-');
  await fs.mkdir(path.join(dir, RECORDING_SESSION), { recursive: true });
  await fs.writeFile(path.join(dir, RECORDING_SESSION, RECORDING_NAME), Buffer.alloc(bytes, 9));
  return dir;
}

function recordingUrl(baseUrl, session, name, extra = '') {
  return `${baseUrl}/lecture/recording/file?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}${extra}`;
}

test('录音导入：列出录音 / 按偏移读字节 / 路径闸门 / 页面与模块都在线', async () => {
  const recordingDir = await makeRecordingDir(300);
  const server = await startServer({ recordingDir });
  try {
    const list = await (await fetch(`${server.baseUrl}/lecture/recording/list`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.configured, true);
    assert.equal(list.exists, true);
    assert.equal(list.total, 1);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].session, RECORDING_SESSION);
    assert.equal(list.items[0].name, RECORDING_NAME);
    assert.equal(list.items[0].size, 300);
    assert.equal(list.items[0].adts, true); // 页面靠这个标记把 m4a/wemta 从「实时跟随」里滤掉

    const read = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, RECORDING_NAME, '&offset=100&maxBytes=64'));
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'application/octet-stream');
    assert.equal(read.headers.get('x-study-offset'), '100');
    assert.equal(read.headers.get('x-study-end'), '164');
    assert.equal(read.headers.get('x-study-size'), '300');
    assert.equal(read.headers.get('x-study-eof'), '0');
    const bytes = new Uint8Array(await read.arrayBuffer());
    assert.equal(bytes.length, 64);
    assert.equal(bytes[0], 9);

    // 不传 offset 就是从头读；读到末尾之后 offset 落回 size 并置 eof
    const head = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, RECORDING_NAME));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-study-offset'), '0');
    assert.equal(head.headers.get('x-study-end'), '300');
    assert.equal(head.headers.get('x-study-eof'), '1');
    assert.equal((await head.arrayBuffer()).byteLength, 300);

    const beyond = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, RECORDING_NAME, '&offset=999'));
    assert.equal(beyond.status, 200);
    assert.equal(beyond.headers.get('x-study-eof'), '1');
    assert.equal((await beyond.arrayBuffer()).byteLength, 0);

    // 三道闸门：场次名带分隔符 / 文件名带分隔符 / 后缀不在白名单
    const badSession = await fetch(recordingUrl(server.baseUrl, '..\\..\\Windows', RECORDING_NAME));
    assert.equal(badSession.status, 400);
    assert.equal((await badSession.json()).error, 'bad-session');
    const badName = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, '../../secret.aac'));
    assert.equal(badName.status, 400);
    assert.equal((await badName.json()).error, 'bad-name');
    const notAudio = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, '2026_10_09200419.aacidx'));
    assert.equal(notAudio.status, 400);
    assert.equal((await notAudio.json()).error, 'not-audio');
    const missing = await fetch(recordingUrl(server.baseUrl, RECORDING_SESSION, 'nope.aac'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not-found');

    // 导入页与它 import 的模块：页面自己解码，所以两个模块都必须能取到
    const page = await fetch(`${server.baseUrl}/lecture/import`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('./wav.js'));
    assert.ok(html.includes('./adts.js'));
    for (const name of CLIENT_MODULE_FILES) {
      const module = await fetch(`${server.baseUrl}/lecture/${name}`);
      assert.equal(module.status, 200);
      assert.match(module.headers.get('content-type') ?? '', /javascript/);
    }
  } finally {
    await server.close();
    await removeTempDir(recordingDir);
  }
});

test('录音导入：没配录音目录时列目录仍返回 200，只是明说没配置', async () => {
  const server = await startServer({}); // recordingDir 传空
  try {
    const response = await fetch(`${server.baseUrl}/lecture/recording/list`);
    assert.equal(response.status, 200);
    const listed = await response.json();
    assert.equal(listed.ok, true);
    assert.equal(listed.configured, false);
    assert.equal(listed.recordingDir, null);
    assert.equal(listed.exists, false);
    assert.equal(listed.error, 'no-dir');
    assert.deepEqual(listed.items, []);
    assert.equal(listed.total, 0);
  } finally {
    await server.close();
  }
});
