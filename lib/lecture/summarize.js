/**
 * 大模型驱动的三个能力：滚动小结、提问秒答、课后总结。
 *
 * 这一层**不碰网络也不碰宿主服务** —— 它只接受一个注入的 `complete()`：
 *
 *     complete({ system, prompt, maxTokens, timeoutMs }) -> Promise<{ok, text, error, detail}>
 *
 * 真正把它接到宿主 `llm` 服务上的适配器在 `lib/lecture/llm.js`。这样切分的好处：
 * 这一层的调度逻辑（什么时候该调、调多频、失败怎么办、并发怎么串起来）可以用
 * 假模型钉死，不必等真机、也不必花钱。
 *
 * 三条底线：
 *   1. **绝不让模型的失败打断上课** —— 所有对外方法都不抛错，只返回 `ok:false`。
 *   2. **绝不并发打同一个模型** —— 录音转写可能几十秒，同时再发两个请求只会
 *      让课堂页卡住；统一走一条串行链。
 *   3. **绝不重复回答同一道题** —— 同一道题只答一次，且两次答题之间有冷却。
 */

/** 累积新增多少字才更新一次滚动小结（太少会几十秒一次，费钱又吵）。 */
export const ROLLING_MIN_CHARS = 600;

/** 两次滚动小结之间的最短间隔。 */
export const ROLLING_MIN_INTERVAL_MS = 60000;

/** 两次「提问秒答」之间的最短间隔 —— 抢答要快，但也不能每句话都问一次模型。 */
export const ANSWER_MIN_INTERVAL_MS = 15000;

/** 递给模型的转写稿上限（字符）—— 一节课几万字全塞进去会顶到上下文上限。 */
export const MAX_PROMPT_CHARS = 24000;

/** 滚动小结的历史最多留这么多条（课后笔记里要回顾）。 */
export const MAX_ROLLING_HISTORY = 40;

/** 只保留最后这些字用于滚动小结的输入窗口。 */
export const ROLLING_WINDOW_CHARS = 3000;

/** 裁剪转写稿：超过上限就保留**尾部**（课末的内容对总结更重要）。 */
export function clipTranscript(text, maxChars = MAX_PROMPT_CHARS) {
  const body = String(text ?? '');
  if (body.length <= maxChars) return body;
  return '（前面还有 ' + String(body.length - maxChars) + ' 字，已省略）\n' + body.slice(-maxChars);
}

/** 取最近的窗口文本，给滚动小结用。 */
export function recentWindow(text, maxChars = ROLLING_WINDOW_CHARS) {
  const body = String(text ?? '');
  return body.length <= maxChars ? body : body.slice(-maxChars);
}

/**
 * @param {object} options
 * @param {(request: {system?: string, prompt: string, maxTokens?: number, timeoutMs?: number}) => Promise<{ok: boolean, text?: string, error?: string, detail?: string}>} options.complete
 */
export function createSummaryEngine(options = {}) {
  const complete = typeof options.complete === 'function' ? options.complete : null;
  const logger = options.logger ?? console;
  const rollingMinChars = Number.isFinite(options.rollingMinChars) ? options.rollingMinChars : ROLLING_MIN_CHARS;
  const rollingMinIntervalMs = Number.isFinite(options.rollingMinIntervalMs) ? options.rollingMinIntervalMs : ROLLING_MIN_INTERVAL_MS;
  const answerMinIntervalMs = Number.isFinite(options.answerMinIntervalMs) ? options.answerMinIntervalMs : ANSWER_MIN_INTERVAL_MS;

  let course = typeof options.course === 'string' ? options.course : '';
  let rolling = '';
  const history = [];
  let pendingChars = 0;
  // 用 -Infinity 而不是 0：这样「第一次」永远放行，不必依赖调用方传真实时间戳。
  let lastRollingAt = -Infinity;
  let lastAnswerAt = -Infinity;
  const answered = new Map(); // 提醒 key（kind::matched）→ 答案文本
  let chain = Promise.resolve();

  function available() {
    return complete !== null;
  }

  /** 所有模型调用排成一条链 —— 同一时刻只有一个在飞。 */
  function enqueue(operation) {
    const next = chain.then(operation, operation);
    // 链本身不允许断：失败在 operation 内部已经吞掉了，这里再兜一层
    chain = next.catch(() => {});
    return next;
  }

  function ask(request) {
    if (complete === null) return Promise.resolve({ ok: false, text: '', error: 'llm-unavailable' });
    return Promise.resolve()
      .then(() => complete(request))
      .then((result) => {
        const ok = result !== null && typeof result === 'object' && result.ok === true && typeof result.text === 'string' && result.text.trim() !== '';
        if (!ok) {
          return { ok: false, text: '', error: (result && result.error) || 'llm-failed', detail: (result && result.detail) || '' };
        }
        return { ok: true, text: result.text.trim() };
      })
      .catch((error) => {
        logger.error?.('[study-assistant] 模型调用异常：', error);
        return { ok: false, text: '', error: 'llm-threw', detail: String(error?.message ?? error) };
      });
  }

  return {
    available,

    setCourse(value) {
      course = typeof value === 'string' ? value : '';
    },

    /** 该不该现在更新滚动小结：字数和间隔两个闸门都放了才继续。 */
    shouldRoll(charsAdded, at = Date.now()) {
      if (!available()) return false;
      pendingChars += Math.max(0, Number(charsAdded) || 0);
      if (pendingChars < rollingMinChars) return false;
      if (at - lastRollingAt < rollingMinIntervalMs) return false;
      return true;
    },

    /**
     * 更新滚动小结。调用方先问 `shouldRoll()`，再调这里。
     *
     * @returns {Promise<{ok: boolean, text?: string, skipped?: string, error?: string}>}
     */
    roll(input = {}) {
      if (!available()) return Promise.resolve({ ok: false, skipped: 'llm-unavailable' });
      return enqueue(async () => {
        const { buildRollingPrompt } = await import('./report.js');
        const prompt = buildRollingPrompt({
          course,
          previous: rolling,
          window: recentWindow(input.text),
        });
        const result = await ask({ prompt, maxTokens: 400, timeoutMs: 30000 });
        if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
        rolling = result.text;
        pendingChars = 0;
        lastRollingAt = Number.isFinite(input.at) ? input.at : Date.now();
        history.push(rolling);
        if (history.length > MAX_ROLLING_HISTORY) history.splice(0, history.length - MAX_ROLLING_HISTORY);
        return { ok: true, text: rolling };
      });
    },

    rollingText() {
      return rolling;
    },

    rollingHistory() {
      return history.slice();
    },

    /**
     * 「提问时秒出答案」。
     *
     * 只对 `question` / `question-strong` 这类提醒动手；同一道题（按 key 去重）
     * 只答一次，且两次答题之间要有冷却 —— 老师连着抛三个问题不等于要三次 AI 插话。
     *
     * @returns {Promise<{ok: boolean, key?: string, text?: string, skipped?: string, error?: string}>}
     */
    answer(input = {}) {
      if (!available()) return Promise.resolve({ ok: false, skipped: 'llm-unavailable' });
      const alert = input.alert;
      // 只答「提问」类。点名/签到类提醒要的是学生本人抬头，AI 插话只会帮倒忙。
      if (!alert || (alert.kind !== 'question' && alert.kind !== 'question-strong')) {
        return Promise.resolve({ ok: false, skipped: 'not-a-question' });
      }
      const key = alert && typeof alert.key === 'string' && alert.key !== ''
        ? alert.key
        : (alert ? `${alert.kind ?? ''}::${alert.matched ?? ''}` : '');
      if (key === '') return Promise.resolve({ ok: false, skipped: 'no-alert' });
      if (answered.has(key)) return Promise.resolve({ ok: false, skipped: 'already-answered', key });
      const at = Number.isFinite(input.at) ? input.at : Date.now();
      if (at - lastAnswerAt < answerMinIntervalMs) return Promise.resolve({ ok: false, skipped: 'cooldown', key });
      return enqueue(async () => {
        const { buildAnswerPrompt } = await import('./report.js');
        const prompt = buildAnswerPrompt({
          course,
          summary: rolling,
          context: recentWindow(input.text, 1200),
          question: alert?.snippet ?? '',
        });
        const result = await ask({ prompt, maxTokens: 500, timeoutMs: 25000 });
        if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
        answered.set(key, result.text);
        lastAnswerAt = at;
        return { ok: true, key, text: result.text };
      });
    },

    /** 已经答过的题（面板刷新后还能显示）。 */
    answers() {
      return Array.from(answered.entries()).map(([key, text]) => ({ key, text }));
    },

    /**
     * 课后总结。返回结构化结果；模型没给出合法 JSON 时回退成原文。
     *
     * @returns {Promise<{ok: boolean, summary?: object|null, raw?: string, error?: string}>}
     */
    summarize(input = {}) {
      if (!available()) return Promise.resolve({ ok: false, error: 'llm-unavailable' });
      return enqueue(async () => {
        const { buildSummaryPrompt, parseSummaryJson, normalizeSummary } = await import('./report.js');
        const prompt = buildSummaryPrompt({
          course: typeof input.course === 'string' ? input.course : course,
          date: input.date,
          transcript: clipTranscript(input.text),
        });
        const result = await ask({ prompt, maxTokens: 3000, timeoutMs: 120000 });
        if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
        const summary = normalizeSummary(parseSummaryJson(result.text));
        return { ok: true, summary, raw: result.text };
      });
    },

    /** 换一节课时清干净，别把上节课的结论带进来。 */
    reset() {
      rolling = '';
      history.length = 0;
      pendingChars = 0;
      lastRollingAt = -Infinity;
      lastAnswerAt = -Infinity;
      answered.clear();
    },
  };
}
