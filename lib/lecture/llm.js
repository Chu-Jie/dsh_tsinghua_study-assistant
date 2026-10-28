/**
 * 把宿主服务接成 `summarize.js` 需要的那一个 `complete()` 函数。
 *
 * 三条来自源码侦察的硬事实（决定了这里怎么写）：
 *
 *   1. `ctx.get('llm').stream(options)` **自己不会抛错** —— adapter 选择、dispatch、
 *      迭代失败都会被转成一个终止分片 `{type:'finish', reason:{kind:'error'|'aborted', failure}}`。
 *      所以判失败要**看 finish 分片**，不能只靠 try/catch。稳定失败码：
 *      `NO_ADAPTER` / `MISSING_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED`
 *      等，按 code 分流，别去解析消息文本。
 *   2. `messages[].content` **必须是块数组**（`[{ type:'text', text }]`），不是字符串。
 *   3. 默认模型来自 `ctx.get('agentDefaultModel').currentSelection()`；它没挂的话
 *      退到 `ctx.get('sessionController').modelCatalog().default`。
 *
 * 交接给新会话用 `sessionController`（GUI 自己用的那套）：`create()` → `prompt()`。
 * **不要**用 `ctx.sessions.create()` —— 那种会话的生命周期挂在调用方 fiber 上，
 * fiber 一销毁会话就没了，用户在侧栏里找不到。
 */

/** 单次生成的默认上限：两分钟足够写一份课后总结。 */
export const DEFAULT_TIMEOUT_MS = 180000;

/** 投给新会话的交接词上限。 */
export const HANDOFF_MAX_PROMPT_CHARS = 20000;

/**
 * 从宿主里找当前的默认模型。
 *
 * @param {(name: string) => any} get `ctx.get`
 * @returns {{provider: string, model: string, reasoningEffort?: string, source: string}|null}
 */
export function resolveDefaultSelection(get) {
  if (typeof get !== 'function') return null;
  try {
    const selection = get('agentDefaultModel')?.currentSelection?.();
    if (selection !== undefined && selection !== null && typeof selection.provider === 'string' && typeof selection.model === 'string' && selection.provider !== '' && selection.model !== '') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        source: 'agentDefaultModel',
      };
    }
  } catch {
    // 服务没挂或接口变了都正常，继续往下退
  }
  try {
    const fallback = get('sessionController')?.modelCatalog?.()?.default;
    if (fallback !== undefined && fallback !== null && typeof fallback.provider === 'string' && typeof fallback.model === 'string' && fallback.provider !== '' && fallback.model !== '') {
      return {
        provider: fallback.provider,
        model: fallback.model,
        ...(typeof fallback.reasoningEffort === 'string' ? { reasoningEffort: fallback.reasoningEffort } : {}),
        source: 'modelCatalog',
      };
    }
  } catch {
    // 同上
  }
  return null;
}

/**
 * 造一个 `complete()`。
 *
 * @param {{getLlm: () => any, getSelection: () => object|null, logger?: object, timeoutMs?: number}} deps
 */
export function createLlmComplete(deps = {}) {
  const getLlm = typeof deps.getLlm === 'function' ? deps.getLlm : () => null;
  const getSelection = typeof deps.getSelection === 'function' ? deps.getSelection : () => null;
  const logger = deps.logger ?? console;
  const defaultTimeout = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function complete(request = {}) {
    const prompt = String(request.prompt ?? '');
    if (prompt.trim() === '') return { ok: false, text: '', error: 'empty-prompt' };

    const llm = getLlm();
    if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
      return { ok: false, text: '', error: 'llm-unavailable' };
    }
    const selection = getSelection();
    if (selection === null || selection === undefined) {
      return { ok: false, text: '', error: 'no-default-model' };
    }

    const controller = new AbortController();
    const limit = Number.isFinite(request.timeoutMs) ? request.timeoutMs : defaultTimeout;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);

    let text = '';
    let failure = null;
    try {
      const options = {
        provider: selection.provider,
        model: selection.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        signal: controller.signal,
      };
      if (typeof request.system === 'string' && request.system !== '') options.system = request.system;
      if (Number.isFinite(request.maxTokens)) options.maxTokens = request.maxTokens;
      if (Number.isFinite(request.temperature)) options.temperature = request.temperature;
      if (typeof selection.reasoningEffort === 'string') options.reasoningEffort = selection.reasoningEffort;

      for await (const chunk of llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') {
          text += String(chunk.text ?? '');
        } else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'error' || kind === 'aborted') {
            failure = chunk.reason?.failure ?? { code: kind, message: '' };
          }
        }
      }
    } catch (error) {
      // 中间件错误、cleanup 错误、或我们自己 for-await 体里的错会走到这里
      logger.error?.('[study-assistant] 模型调用异常：', error);
      return { ok: false, text: '', error: 'llm-threw', detail: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) return { ok: false, text: '', error: 'llm-timeout', detail: `超过 ${limit} ms` };
    if (failure !== null) {
      return {
        ok: false,
        text: '',
        error: String(failure.code ?? 'llm-failed'),
        detail: String(failure.message ?? ''),
      };
    }
    if (text.trim() === '') return { ok: false, text: '', error: 'empty-response' };
    return { ok: true, text };
  };
}

/**
 * 造一个「课后交接给新会话」的函数：新建一个顶层会话，把交接词作为用户消息投进去。
 * 会话建好之后 agent 会自己跑起来，用户在侧栏里就能接着追问。
 *
 * @param {{getController: () => any, getSessions?: () => any, getTitle?: () => any, logger?: object}} deps
 */
export function createSessionHandoff(deps = {}) {
  const getController = typeof deps.getController === 'function' ? deps.getController : () => null;
  const getSessions = typeof deps.getSessions === 'function' ? deps.getSessions : () => null;
  const getTitle = typeof deps.getTitle === 'function' ? deps.getTitle : () => null;
  const getWorkspaceRegistry =
    typeof deps.getWorkspaceRegistry === 'function' ? deps.getWorkspaceRegistry : () => null;
  const logger = deps.logger ?? console;
  let counter = 0;

  /**
   * 把 cwd 翻译成工作区 id。
   *
   * 宿主 `session/create` 的 `workspaceId` 与 `cwd` 二选一：只给 cwd 建出来的会话不进任何
   * 工作区分组（侧栏显示「未分组」）。所以先问注册表要 id，查不到才退回 cwd。
   *
   * @param {string} cwd 绝对目录
   * @returns {Promise<object>} 传给 controller.create 的参数
   */
  async function locationFor(cwd) {
    if (cwd === '') return {};
    try {
      const registry = getWorkspaceRegistry();
      if (registry !== null && registry !== undefined && typeof registry.resolveByPath === 'function') {
        const workspace = await registry.resolveByPath(cwd);
        if (workspace !== null && workspace !== undefined && typeof workspace.id === 'string' && workspace.id !== '') {
          return { workspaceId: workspace.id };
        }
      }
    } catch (error) {
      logger.error?.('[study-assistant] 解析工作区失败（退回 cwd）：', error);
    }
    return { cwd };
  }

  return async function handoff(input = {}) {
    const text = String(input.prompt ?? '').trim();
    if (text === '') return { ok: false, error: 'empty-prompt' };

    const controller = getController();
    if (controller === null || controller === undefined || typeof controller.create !== 'function') {
      return { ok: false, error: 'sessions-unavailable' };
    }

    let sessionId = '';
    try {
      const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : '';
      const location = await locationFor(cwd);
      const created = await controller.create(location);
      sessionId = String(created?.sessionId ?? '');
      if (sessionId === '') return { ok: false, error: 'create-failed' };
      counter += 1;
      // requestId 只是幂等键：同一个 id 重复投递只会生效一次，所以必须够独特
      await controller.prompt(
        {
          requestId: `study-assistant-lecture-${Date.now()}-${counter}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: text.slice(0, HANDOFF_MAX_PROMPT_CHARS) }],
        },
        new AbortController().signal,
      );
    } catch (error) {
      logger.error?.('[study-assistant] 交接给新会话失败：', error);
      return { ok: false, error: 'handoff-failed', sessionId, detail: String(error?.message ?? error) };
    }

    // 标题是锦上添花：只给 live 会话能重命名，失败就算了，不能影响已经投出去的交接
    let titled = false;
    if (typeof input.title === 'string' && input.title !== '') {
      try {
        const title = getTitle();
        const sessions = getSessions();
        const session = sessions?.get?.(sessionId);
        if (title !== null && title !== undefined && typeof title.rename === 'function' && session !== undefined) {
          await title.rename(session, String(input.title));
          titled = true;
        }
      } catch (error) {
        logger.error?.('[study-assistant] 新会话改名失败（不影响交接）：', error);
      }
    }

    return { ok: true, sessionId, titled };
  };
}
