/**
 * 这一层是「我们和宿主之间的缝」，缝错了整条 AI 链路就是哑的。
 *
 * 用假 `llm` / 假 `sessionController` 钉死三件事：
 *   1. 失败是**终止分片**给的，不是抛出来的（宿主 `stream()` 自己吞异常）；
 *   2. `messages[].content` 必须是块数组；
 *   3. 交接是 `sessionController.create()` + `prompt()`，`prompt` 必须带 signal。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLlmComplete,
  createSessionHandoff,
  resolveDefaultSelection,
  DEFAULT_TIMEOUT_MS,
  HANDOFF_MAX_PROMPT_CHARS,
} from '../lib/lecture/llm.js';

/** 假 llm：按脚本吐分片，并记下收到的 options。 */
function fakeLlm(chunks, options = {}) {
  const calls = [];
  return {
    calls,
    stream(generateOptions) {
      calls.push(generateOptions);
      return (async function* run() {
        if (typeof options.before === 'function') await options.before();
        if (options.throwInStream === true) throw new Error('middleware exploded');
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const SELECTION = { provider: 'deepseek-official', model: 'deepseek-flash' };

function makeComplete(llm, extra = {}) {
  return createLlmComplete({ getLlm: () => llm, getSelection: () => SELECTION, ...extra });
}

test('resolveDefaultSelection：优先 agentDefaultModel，其次 modelCatalog', () => {
  const get = (name) => {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'high' }) };
    return undefined;
  };
  assert.deepEqual(resolveDefaultSelection(get), { provider: 'p1', model: 'm1', reasoningEffort: 'high', source: 'agentDefaultModel' });

  const onlyCatalog = (name) => (name === 'sessionController' ? { modelCatalog: () => ({ default: { provider: 'p2', model: 'm2' } }) } : undefined);
  assert.deepEqual(resolveDefaultSelection(onlyCatalog), { provider: 'p2', model: 'm2', source: 'modelCatalog' });
});

test('resolveDefaultSelection：都没有、服务抛错、字段不全新，一律返回 null', () => {
  assert.equal(resolveDefaultSelection(() => undefined), null);
  assert.equal(resolveDefaultSelection(undefined), null);
  assert.equal(resolveDefaultSelection(() => {
    throw new Error('service down');
  }), null);
  assert.equal(resolveDefaultSelection((name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: '', model: 'm' }) } : undefined)), null);
  assert.equal(resolveDefaultSelection((name) => (name === 'agentDefaultModel' ? { currentSelection: () => undefined } : undefined)), null);
  // 前一个服务炸了也要继续往后试
  const resilient = (name) => {
    if (name === 'agentDefaultModel') throw new Error('boom');
    return { modelCatalog: () => ({ default: { provider: 'p3', model: 'm3' } }) };
  };
  assert.deepEqual(resolveDefaultSelection(resilient), { provider: 'p3', model: 'm3', source: 'modelCatalog' });
});

test('complete：把 text-delta 拼起来，reasoning-delta 不算正文', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'reasoning-delta', index: 0, text: '（先想一想）' },
    { type: 'text-delta', index: 0, text: '这节讲' },
    { type: 'text-delta', index: 0, text: '红黑树。' },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await makeComplete(llm)({ prompt: '总结一下', system: '你是助教', maxTokens: 400 });
  assert.equal(result.ok, true);
  assert.equal(result.text, '这节讲红黑树。');

  const sent = llm.calls[0];
  assert.equal(sent.provider, 'deepseek-official');
  assert.equal(sent.model, 'deepseek-flash');
  assert.equal(sent.system, '你是助教');
  assert.equal(sent.maxTokens, 400);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].role, 'user');
  assert.deepEqual(sent.messages[0].content, [{ type: 'text', text: '总结一下' }]);
  assert.equal(sent.signal instanceof AbortSignal, true);
  assert.equal('purpose' in sent, false); // 插件自己的生成不该冒充 session-title
});

test('complete：失败码来自终止分片，不是异常 —— 这是宿主 stream() 的真实行为', async () => {
  const llm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'too many requests', status: 429 } } },
  ]);
  const result = await makeComplete(llm)({ prompt: '总结一下' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'RATE_LIMIT');
  assert.equal(result.detail, 'too many requests');
});

test('complete：宿主自己抛错也能兜住，只返回失败', async () => {
  const logged = [];
  const llm = fakeLlm([], { throwInStream: true });
  const result = await makeComplete(llm, { logger: { error: (...args) => logged.push(args) } })({ prompt: '总结一下' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'llm-threw');
  assert.match(result.detail, /middleware exploded/);
  assert.equal(logged.length, 1);
});

test('complete：超时就自己掐断，并把 signal 递给宿主', async () => {
  let seenSignal = null;
  const llm = {
    stream(options) {
      seenSignal = options.signal;
      return (async function* run() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const result = await makeComplete(llm)({ prompt: '总结一下', timeoutMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'llm-timeout');
  assert.equal(seenSignal.aborted, true);
});

test('complete：前置条件不满足时给出各自的错误码，不硬着头皮去调', async () => {
  const missingLlm = createLlmComplete({ getLlm: () => null, getSelection: () => SELECTION });
  assert.equal((await missingLlm({ prompt: 'x' })).error, 'llm-unavailable');

  const missingSelection = createLlmComplete({ getLlm: () => fakeLlm([]), getSelection: () => null });
  assert.equal((await missingSelection({ prompt: 'x' })).error, 'no-default-model');

  const emptyPrompt = makeComplete(fakeLlm([]));
  assert.equal((await emptyPrompt({ prompt: '   ' })).error, 'empty-prompt');

  const noText = makeComplete(fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]));
  assert.equal((await noText({ prompt: 'x' })).error, 'empty-response');

  assert.equal(DEFAULT_TIMEOUT_MS, 180000);
});

test('handoff：create → prompt，content 是块数组，requestId 每次都不一样', async () => {
  const created = [];
  const prompted = [];
  const controller = {
    async create(request) {
      created.push(request);
      return { sessionId: `session-${created.length}` };
    },
    async prompt(request, signal) {
      prompted.push({ request, signal });
      return { accepted: true };
    },
  };
  const handoff = createSessionHandoff({ getController: () => controller });
  const first = await handoff({ prompt: '这是交接词', cwd: 'D:\\workspace\\作业' });
  const second = await handoff({ prompt: '第二次' });
  assert.equal(first.ok, true);
  assert.equal(first.sessionId, 'session-1');
  assert.deepEqual(created[0], { cwd: 'D:\\workspace\\作业' });
  assert.deepEqual(created[1], {});
  assert.equal(prompted[0].request.sessionId, 'session-1');
  assert.equal(prompted[0].request.mode, 'queue');
  assert.deepEqual(prompted[0].request.content, [{ type: 'text', text: '这是交接词' }]);
  assert.notEqual(prompted[0].request.requestId, prompted[1].request.requestId);
  assert.equal(prompted[0].signal instanceof AbortSignal, true);
});

test('handoff：能解析到工作区就传 workspaceId（否则新会话落到「未分组」）', async () => {
  const created = [];
  const controller = {
    async create(request) {
      created.push(request);
      return { sessionId: `session-${created.length}` };
    },
    async prompt() {
      return { accepted: true };
    },
  };
  const asked = [];
  const registry = {
    async resolveByPath(path) {
      asked.push(path);
      if (path === 'D:\\workspace\\作业') return { id: 'ws-作业', path };
      if (path === 'D:\\boom') throw new Error('registry down');
      return undefined;
    },
  };
  const handoff = createSessionHandoff({ getController: () => controller, getWorkspaceRegistry: () => registry });

  await handoff({ prompt: '甲', cwd: 'D:\\workspace\\作业' });
  await handoff({ prompt: '乙', cwd: 'D:\\没有登记' });
  await handoff({ prompt: '丙', cwd: 'D:\\boom' });
  await handoff({ prompt: '丁' });

  assert.deepEqual(asked, ['D:\\workspace\\作业', 'D:\\没有登记', 'D:\\boom']);
  assert.deepEqual(created[0], { workspaceId: 'ws-作业' });
  assert.deepEqual(created[1], { cwd: 'D:\\没有登记' });
  assert.deepEqual(created[2], { cwd: 'D:\\boom' });
  assert.deepEqual(created[3], {});
});

test('handoff：标题失败不影响交接成功（标题只是锦上添花）', async () => {
  const controller = {
    async create() {
      return { sessionId: 'session-9' };
    },
    async prompt() {
      return { accepted: true };
    },
  };
  const logged = [];
  const title = {
    async rename() {
      throw new Error('not live');
    },
  };
  const handoff = createSessionHandoff({
    getController: () => controller,
    getSessions: () => ({ get: () => ({ id: 'session-9' }) }),
    getTitle: () => title,
    logger: { error: (...args) => logged.push(args) },
  });
  const result = await handoff({ prompt: '交接词', title: '数据结构 · 课堂追问' });
  assert.equal(result.ok, true);
  assert.equal(result.titled, false);
  assert.equal(logged.length, 1);
});

test('handoff：改名成功时如实汇报', async () => {
  const renamed = [];
  const handoff = createSessionHandoff({
    getController: () => ({
      async create() {
        return { sessionId: 's1' };
      },
      async prompt() {
        return { accepted: true };
      },
    }),
    getSessions: () => ({ get: (id) => ({ id }) }),
    getTitle: () => ({ async rename(session, title) { renamed.push([session.id, title]); } }),
  });
  const result = await handoff({ prompt: '交接词', title: '物理 · 课堂追问' });
  assert.equal(result.titled, true);
  assert.deepEqual(renamed, [['s1', '物理 · 课堂追问']]);
});

test('handoff：没有会话服务、建不出来、创建抛错，都只返回失败', async () => {
  assert.equal((await createSessionHandoff({ getController: () => null })({ prompt: 'x' })).error, 'sessions-unavailable');
  assert.equal((await createSessionHandoff({ getController: () => ({ create: async () => ({}) }) })({ prompt: 'x' })).error, 'create-failed');
  assert.equal((await createSessionHandoff({ getController: () => ({}) })({ prompt: 'x' })).error, 'sessions-unavailable');
  // 这条用例故意让宿主抛错：logger 换成空实现，免得预期内的失败日志混进 `npm test` 输出
  assert.equal((await createSessionHandoff({
    getController: () => ({ async create() { return { sessionId: 's' }; }, async prompt() { throw new Error('busy'); } }),
    logger: { error() {} },
  })({ prompt: 'x' })).error, 'handoff-failed');
  assert.equal((await createSessionHandoff({ getController: () => ({}) })({ prompt: '  ' })).error, 'empty-prompt');
});

test('handoff：交接词过长会被裁到上限', async () => {
  let sent = '';
  const handoff = createSessionHandoff({
    getController: () => ({
      async create() {
        return { sessionId: 's1' };
      },
      async prompt(request) {
        sent = request.content[0].text;
        return { accepted: true };
      },
    }),
  });
  const result = await handoff({ prompt: '甲'.repeat(HANDOFF_MAX_PROMPT_CHARS + 300) });
  assert.equal(result.ok, true);
  assert.equal(sent.length, HANDOFF_MAX_PROMPT_CHARS);
});
