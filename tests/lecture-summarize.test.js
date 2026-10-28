/**
 * 这一层钉的是「什么时候调模型、调失败怎么办、同一道题绝不答两次」——
 * 上课的时候模型抽风、超时、返回一坨不是 JSON 的东西都是常态，
 * 调度逻辑只要错一次，学生那一节课就全毁了。
 *
 * 所以这里全部用**假模型**：不联网、不花钱、结果稳定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSummaryEngine,
  clipTranscript,
  recentWindow,
  ANSWER_MIN_INTERVAL_MS,
  MAX_PROMPT_CHARS,
  ROLLING_MIN_CHARS,
  ROLLING_MIN_INTERVAL_MS,
  ROLLING_WINDOW_CHARS,
} from '../lib/lecture/summarize.js';
import { isSummaryEmpty } from '../lib/lecture/report.js';

function fakeComplete(handler) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return handler(request, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const QUESTION_ALERT = {
  kind: 'question',
  key: 'question::这道题选什么',
  matched: '这道题',
  snippet: '这道题选什么？',
};

test('available：没给 complete 就说不可用，且三个能力都只是「没做」而不是抛错', async () => {
  const engine = createSummaryEngine({});
  assert.equal(engine.available(), false);
  assert.equal(engine.shouldRoll(100000, 999999999), false);
  const roll = await engine.roll({ text: '随便', at: 1 });
  assert.equal(roll.ok, false);
  assert.equal(roll.skipped, 'llm-unavailable');
  const answer = await engine.answer({ alert: QUESTION_ALERT, text: '随便', at: 1 });
  assert.equal(answer.ok, false);
  assert.equal(answer.skipped, 'llm-unavailable');
  const summary = await engine.summarize({ text: '随便' });
  assert.equal(summary.ok, false);
  assert.equal(summary.error, 'llm-unavailable');
});

test('shouldRoll：字数和间隔两道闸门都放了才放行', () => {
  const engine = createSummaryEngine({
    complete: async () => ({ ok: true, text: '脉络' }),
    rollingMinChars: 100,
    rollingMinIntervalMs: 1000,
  });
  assert.equal(engine.shouldRoll(40, 5000), false);
  assert.equal(engine.shouldRoll(40, 5000), false);
  assert.equal(engine.shouldRoll(40, 5000), true); // 120 ≥ 100，且第一次永远放行
});

test('shouldRoll：刚滚过就再攒够字数，也要等间隔', async () => {
  const complete = fakeComplete(() => ({ ok: true, text: '脉络一' }));
  const engine = createSummaryEngine({ complete, rollingMinChars: 100, rollingMinIntervalMs: 60000 });
  assert.equal(engine.shouldRoll(120, 5000), true);
  await engine.roll({ text: '片段一', at: 5000 });
  assert.equal(engine.shouldRoll(500, 5500), false); // 字数够了，但离上一次只有 500ms
  assert.equal(engine.shouldRoll(0, 66000), true); // 过了一分钟
});

test('roll：把上一版脉络和新片段一起递给模型，滚动文本与历史都更新', async () => {
  const complete = fakeComplete(() => ({ ok: true, text: '讲了红黑树的插入' }));
  const engine = createSummaryEngine({ complete, rollingMinChars: 10, rollingMinIntervalMs: 0 });
  engine.setCourse('数据结构');
  assert.equal(engine.shouldRoll(20, 1000), true);
  const result = await engine.roll({ text: '今天我们讲红黑树的插入', at: 1000 });
  assert.equal(result.ok, true);
  assert.equal(engine.rollingText(), '讲了红黑树的插入');
  assert.deepEqual(engine.rollingHistory(), ['讲了红黑树的插入']);
  assert.equal(complete.calls.length, 1);
  assert.match(complete.calls[0].prompt, /红黑树的插入/);
  assert.match(complete.calls[0].prompt, /数据结构/);

  engine.shouldRoll(20, 2000);
  await engine.roll({ text: '接着讲删除的调整', at: 2000 });
  assert.match(complete.calls[1].prompt, /讲了红黑树的插入/); // 上一版作为增量更新的底稿
  assert.deepEqual(engine.rollingHistory(), ['讲了红黑树的插入', '讲了红黑树的插入']);
});

test('roll：模型失败时保留上一版脉络，并把攒下的字数留着下次重试', async () => {
  const complete = fakeComplete(() => ({ ok: false, error: 'timeout', detail: '超时' }));
  const engine = createSummaryEngine({ complete, rollingMinChars: 100, rollingMinIntervalMs: 0 });
  engine.shouldRoll(120, 1000);
  const result = await engine.roll({ text: '片段', at: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.equal(engine.rollingText(), '');
  // 字数没被清掉 ⇒ 下一次 shouldRoll 不必重新攒
  assert.equal(engine.shouldRoll(0, 2000), true);
});

test('roll：模型直接抛异常也只返回失败，不把异常扔给课堂', async () => {
  let logged = 0;
  const engine = createSummaryEngine({
    complete: async () => {
      throw new Error('socket hang up');
    },
    logger: { error: () => { logged += 1; } },
  });
  const result = await engine.roll({ text: '片段', at: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'llm-threw');
  assert.match(result.detail, /socket hang up/);
  assert.equal(logged, 1);
});

test('roll：模型返回空文本也算失败，别把空脉络当成新脉络', async () => {
  const engine = createSummaryEngine({ complete: async () => ({ ok: true, text: '   ' }) });
  const result = await engine.roll({ text: '片段', at: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'llm-failed');
  assert.equal(engine.rollingText(), '');
});

test('answer：点名类提醒不答题 —— 那要的是学生本人抬头，不是 AI 插话', async () => {
  const engine = createSummaryEngine({ complete: async () => ({ ok: true, text: '答案' }) });
  const rollcall = await engine.answer({ alert: { kind: 'rollcall', key: 'rollcall::点名' }, text: '', at: 1 });
  assert.equal(rollcall.skipped, 'not-a-question');
  const named = await engine.answer({ alert: { kind: 'name', key: 'name::示例同学' }, text: '', at: 1 });
  assert.equal(named.skipped, 'not-a-question');
  const nothing = await engine.answer({ text: '', at: 1 });
  assert.equal(nothing.skipped, 'not-a-question');
});

test('answer：同一道题只答一次，两道不同的题之间要有冷却', async () => {
  const complete = fakeComplete((request, n) => ({ ok: true, text: '答案' + n }));
  const engine = createSummaryEngine({ complete, answerMinIntervalMs: 1000 });

  const first = await engine.answer({ alert: QUESTION_ALERT, text: '这道题选什么？', at: 10000 });
  assert.equal(first.ok, true);
  assert.equal(first.key, 'question::这道题选什么');
  assert.deepEqual(engine.answers(), [{ key: 'question::这道题选什么', text: '答案1' }]);

  const again = await engine.answer({ alert: QUESTION_ALERT, text: '这道题选什么？', at: 99000 });
  assert.equal(again.ok, false);
  assert.equal(again.skipped, 'already-answered');
  assert.equal(complete.calls.length, 1);

  const tooSoon = await engine.answer({
    alert: { kind: 'question-strong', key: 'question-strong::谁来回答', snippet: '谁来回答' },
    text: '谁来回答？',
    at: 10500,
  });
  assert.equal(tooSoon.skipped, 'cooldown');

  const later = await engine.answer({
    alert: { kind: 'question-strong', key: 'question-strong::谁来回答', snippet: '谁来回答' },
    text: '谁来回答？',
    at: 12000,
  });
  assert.equal(later.ok, true);
  assert.equal(engine.answers().length, 2);
});

test('answer：失败不记进「答过的题」里，下一帧还能再试', async () => {
  const complete = fakeComplete(() => ({ ok: false, error: 'llm-failed' }));
  const engine = createSummaryEngine({ complete, answerMinIntervalMs: 0 });
  const first = await engine.answer({ alert: QUESTION_ALERT, text: '', at: 1000 });
  assert.equal(first.ok, false);
  assert.deepEqual(engine.answers(), []);
  const second = await engine.answer({ alert: QUESTION_ALERT, text: '', at: 2000 });
  assert.equal(second.ok, false);
  assert.equal(complete.calls.length, 2);
});

test('summarize：模型给出合法 JSON 就解析成结构化总结', async () => {
  const complete = fakeComplete(() => ({
    ok: true,
    text: '好的，这是总结：\n```json\n{"overview":"讲了红黑树","points":[{"title":"插入","detail":"先变色再旋转"}],"questions":[{"question":"为什么","answer":"因为高度","status":"answered"}],"terms":["红黑树"],"todos":[],"followups":["删除怎么调整"]}\n```',
  }));
  const engine = createSummaryEngine({ complete });
  const result = await engine.summarize({ text: '这节讲红黑树', course: '数据结构', date: '2026-10-09' });
  assert.equal(result.ok, true);
  assert.equal(result.summary.overview, '讲了红黑树');
  assert.equal(result.summary.points[0].title, '插入');
  assert.equal(result.summary.followups[0], '删除怎么调整');
  assert.match(complete.calls[0].prompt, /数据结构/);
  assert.match(complete.calls[0].prompt, /2026-10-09/);
});

test('summarize：模型没给 JSON 时保留原文，交给渲染层降级成「原文 + 摘录」', async () => {
  const complete = fakeComplete(() => ({ ok: true, text: '这节课讲了红黑树，重点是插入时的旋转。' }));
  const engine = createSummaryEngine({ complete });
  const result = await engine.summarize({ text: '这节讲红黑树' });
  assert.equal(result.ok, true);
  assert.equal(isSummaryEmpty(result.summary), true);
  assert.equal(result.raw, '这节课讲了红黑树，重点是插入时的旋转。');
});

test('prompt 里的转写稿会被裁到上限，并明说前面省略了多少字', () => {
  const long = '甲'.repeat(MAX_PROMPT_CHARS + 500);
  const clipped = clipTranscript(long);
  assert.ok(clipped.length < long.length);
  assert.match(clipped, /前面还有 500 字，已省略/);
  assert.equal(clipTranscript('短的就原样').includes('省略'), false);

  const window = recentWindow('乙'.repeat(ROLLING_WINDOW_CHARS + 100));
  assert.equal(window.length, ROLLING_WINDOW_CHARS);
});

test('并发调用排成一条链：同一时刻绝不打两个模型请求', async () => {
  let active = 0;
  let maxActive = 0;
  const engine = createSummaryEngine({
    complete: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, text: '脉络' };
    },
    rollingMinIntervalMs: 0,
    answerMinIntervalMs: 0,
  });
  await Promise.all([
    engine.roll({ text: '一', at: 1 }),
    engine.roll({ text: '二', at: 2 }),
    engine.answer({ alert: QUESTION_ALERT, text: '三', at: 3 }),
    engine.summarize({ text: '四' }),
  ]);
  assert.equal(maxActive, 1);
});

test('reset：换一节课时脉络、历史、答过的题、闸门全部归零', async () => {
  const complete = fakeComplete(() => ({ ok: true, text: '脉络' }));
  const engine = createSummaryEngine({ complete, rollingMinIntervalMs: 60000 });
  engine.shouldRoll(999, 1000);
  await engine.roll({ text: '片段', at: 1000 });
  await engine.answer({ alert: QUESTION_ALERT, text: '片段', at: 1000 });
  assert.notEqual(engine.rollingText(), '');
  engine.reset();
  assert.equal(engine.rollingText(), '');
  assert.deepEqual(engine.rollingHistory(), []);
  assert.deepEqual(engine.answers(), []);
  assert.equal(engine.shouldRoll(999, 1100), true); // 间隔闸门也被重置了
});

test('默认闸门是「600 字 / 60 秒 / 15 秒」这套课堂节奏', () => {
  assert.equal(ROLLING_MIN_CHARS, 600);
  assert.equal(ROLLING_MIN_INTERVAL_MS, 60000);
  assert.equal(ANSWER_MIN_INTERVAL_MS, 15000);
});
