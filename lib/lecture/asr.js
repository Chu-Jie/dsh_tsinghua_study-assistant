/**
 * 语音转写桥：把 DSH 宿主上的 `speechToText` 服务包成「可缺席」的形状
 *
 * ⚠️ 为什么必须是「可缺席」的、而不能写进 `inject`：
 *   提供 `speechToText` 的是可选实验包
 *   `@deepseek-ai/dsh-experimental-voice-input-bundle`（默认 enabled: false）。
 *   一旦把 `speechToText` 写进 index.js 的 `export const inject`，
 *   这个包没启用时**整个学习台插件都不会激活** —— 课表、DDL、成绩全都用不了。
 *   所以这里只做运行时探测：拿得到就干活，拿不到就回一句人话让用户去开。
 *
 * 模型已经在本地缓存好了（`<DSH_HOME>/speech-to-text/sensevoice/models/...`，
 * INT8 约 239 MB），启用实验包之后不需要再联网下载。
 */

/** SenseVoice 认的语种提示（见 speech-to-text-sensevoice/lib/worker.js 的 languages）。 */
export const LECTURE_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

/** 没启用语音包时给用户看的引导。这句话会出现在接口返回和页面上。 */
export const SPEECH_HINT =
  '语音转写服务未启用：请在 DSH 的插件管理页启用 '
  + '「@deepseek-ai/dsh-experimental-voice-input-bundle（语音输入 · 实验）」后重启。'
  + '识别模型已在本机缓存（约 239 MB），启用后无需重新下载。';

/** 首次调用可能要等模型加载进内存，超时给得比推理本身宽得多。 */
const DEFAULT_TIMEOUT_MS = 180000;

/** 把 provider 信息压成可安全 JSON 化的形状（原始对象可能带函数与循环引用）。 */
function describeProvider(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id === '') return null;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    location: typeof raw.location === 'string' ? raw.location : '',
    languages: Array.isArray(raw.languages) ? raw.languages.filter((v) => typeof v === 'string') : [],
  };
}

/** 错误对象 → 一行可读文本。 */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown';
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 创建语音桥。
 *
 * @param {{getService?: () => unknown, logger?: {error?: Function}, timeoutMs?: number}} deps
 *   `getService` 每次调用都重新探测（宿主可能在会话中途启用/禁用语音包）。
 */
export function createSpeechBridge(deps = {}) {
  const getService = typeof deps.getService === 'function' ? deps.getService : () => null;
  const log = deps.logger ?? console;
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;

  /** 探测服务；探测本身绝不能让接口 500。 */
  function service() {
    try {
      const found = getService();
      return found === undefined || found === null ? null : found;
    } catch (error) {
      log.error?.('[study-assistant] 探测 speechToText 服务失败：', error);
      return null;
    }
  }

  /** 当前状态：供 `/lecture/health` 与页面显示用。 */
  async function status() {
    const svc = service();
    if (svc === null) return { available: false, hint: SPEECH_HINT, providers: [] };

    let providers = [];
    try {
      // listProviders 可能是同步的，也可能是异步的；统一 await 一下即可
      const raw = await svc.listProviders?.();
      providers = (Array.isArray(raw) ? raw : []).map(describeProvider).filter((item) => item !== null);
    } catch (error) {
      log.error?.('[study-assistant] 列语音提供方失败：', error);
      return { available: true, hint: `无法列出语音提供方：${describeError(error)}`, providers: [] };
    }

    return { available: true, hint: null, providers };
  }

  /**
   * 转写一段音频。
   *
   * 调用顺序按官方契约来：`resolve(request) -> SpeechSpec`，再 `transcribe(spec, signal)`。
   * `resolve` 是同步的、可能抛（比如 providerId 不认识），所以单独包一层 try，
   * 好把「选错了提供方」和「推理本身失败」区分开报。
   *
   * @param {Uint8Array} audio 规范 16 kHz 单声道 PCM16 WAV 字节
   * @returns {Promise<{ok: true, text: string, audioSeconds: number, inferenceSeconds: number, wallMs: number, language: string} | {ok: false, error: string, detail?: string}>}
   */
  async function transcribe(audio, options = {}) {
    const svc = service();
    if (svc === null) return { ok: false, error: 'speech-unavailable', detail: SPEECH_HINT };

    const language = LECTURE_LANGUAGES.includes(options.language) ? options.language : 'auto';
    const request = { audio, language };
    if (typeof options.providerId === 'string' && options.providerId !== '') request.providerId = options.providerId;

    let spec = request;
    try {
      if (typeof svc.resolve === 'function') spec = svc.resolve(request);
    } catch (error) {
      return { ok: false, error: 'speech-resolve-failed', detail: describeError(error) };
    }

    const controller = new AbortController();
    const budget = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : timeoutMs;
    const timer = setTimeout(() => controller.abort(), budget);
    const started = Date.now();
    try {
      const transcript = await svc.transcribe(spec, controller.signal);
      return {
        ok: true,
        text: typeof transcript?.text === 'string' ? transcript.text : '',
        audioSeconds: Number(transcript?.audioSeconds) || 0,
        inferenceSeconds: Number(transcript?.inferenceSeconds) || 0,
        wallMs: Date.now() - started,
        language,
      };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? 'speech-timeout' : 'speech-failed',
        detail: aborted ? `超过 ${Math.round(budget / 1000)} 秒仍未返回` : describeError(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { status, transcribe, available: () => service() !== null };
}
