/**
 * 点名 / 答题提醒层测试（零依赖）
 * 运行：node tests/lecture-alert.test.js
 *
 * 这一层最容易出的错是**误报**：一节课四十分钟，只要「都」「好」「度」这种高频字
 * 进了同音表，或者没有称呼语闸门，提醒会响几十次，用户第一件事就是把它关掉。
 * 所以下面的用例里，负面用例（必须一条都不报）和正面用例一样重要。
 *
 * 覆盖：dict.js 的同音字档位 → rollcall.js 的三档规则与两种去重 → session.js 的
 * 跨帧拼接、时间窗去重、落盘往返。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_STUDENT_NAME, buildNameMatcher, parseNameVariants } from '../lib/lecture/dict.js';
import { MAX_ALERTS_PER_FRAME, detectAlerts, snippetAround } from '../lib/lecture/rollcall.js';
import { createLectureSession, localDate, safeFileName } from '../lib/lecture/session.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/* ------------------------------------------------------------------ 同音字表 */

test('buildNameMatcher：默认学生名是示例同学，表外字退化成字面匹配', () => {
  assert.equal(DEFAULT_STUDENT_NAME, '示例同学');
  const matcher = buildNameMatcher('示例同学');
  assert.equal(matcher.name, '示例同学');
  // 「示例同学」四个字都不在同音字表里 → 每个字退化成它自己，仍然能精确匹配
  assert.deepEqual(matcher.classes, ['示', '例', '同', '学']);
  assert.deepEqual(matcher.syllables, [undefined, undefined, undefined, undefined]);
  matcher.full.lastIndex = 0;
  assert.equal(matcher.full.exec('请示例同学回答')?.[0], '示例同学');
});

test('buildNameMatcher：同音字表覆盖的音节能建出整名/名/姓三档', () => {
  // 表里示范的是 du4 hao4 yang2（示例姓名「杜浩阳」），三档都该建出来
  const matcher = buildNameMatcher('杜浩阳');
  assert.deepEqual(matcher.syllables, ['du4', 'hao4', 'yang2']);
  assert.equal(matcher.classes.length, 3);

  matcher.full.lastIndex = 0;
  assert.equal(matcher.full.exec('杜昊阳')?.[0], '杜昊阳', '同音字要能整名命中');
  matcher.given.lastIndex = 0;
  assert.equal(matcher.given.exec('好，浩阳你来说')?.[0], '浩阳');
  matcher.surname.lastIndex = 0;
  assert.equal(matcher.surname.exec('度同学')?.[0], '度', '同音姓氏也要能命中（再由误报词表拦）');
});

test('buildNameMatcher：表外字退化成字面匹配，两字名没有名/姓档', () => {
  const matcher = buildNameMatcher('李雷');
  assert.deepEqual(matcher.classes, ['李', '雷']);
  matcher.full.lastIndex = 0;
  assert.equal(matcher.full.exec('李雷同学')?.[0], '李雷');
  assert.equal(matcher.given, null);
  assert.equal(matcher.surname, null);
});

test('buildNameMatcher：空名字回退到默认名，不会建出空正则', () => {
  const matcher = buildNameMatcher('   ');
  assert.equal(matcher.name, DEFAULT_STUDENT_NAME);
  const demo = buildNameMatcher(null);
  assert.equal(demo.full.exec('示例同学')?.[0], '示例同学');
});

/* -------------------------------------------------------------- 姓名变体配置 */

test('parseNameVariants：顿号、逗号、空格都能拆，空串返回空数组', () => {
  assert.deepEqual(parseNameVariants('李雷雷、雷子，小李'), ['李雷雷', '雷子', '小李']);
  assert.deepEqual(parseNameVariants(' 雷子  小李 '), ['雷子', '小李']);
  assert.deepEqual(parseNameVariants(''), []);
  assert.deepEqual(parseNameVariants(null), []);
  assert.deepEqual(parseNameVariants(['甲', '乙']), ['甲', '乙']);
});

test('buildNameMatcher：变体按原文匹配（不解释正则元字符），与整名同权重', () => {
  const matcher = buildNameMatcher('李雷', '雷子、小李');
  assert.equal(matcher.variants.length, 2);

  // 变体就是「叫到你」：不应该因为不是同音字就被漏掉
  const hit = detectAlerts('那就请雷子上黑板写一下', { matcher }).find((alert) => alert.matched === '雷子');
  assert.ok(hit, '配置的变体应命中');
  assert.equal(hit.kind, 'name');
  assert.equal(hit.severity, 3);

  // 不带配置时同一个词不该命中（说明命中的确来自变体，而不是同音字表碰巧）
  const none = detectAlerts('那就请雷子上黑板写一下', { studentName: '李雷' });
  assert.equal(none.some((alert) => alert.matched === '雷子'), false);

  // 变体里的元字符按字面处理，不能让它变成通配符
  const dotted = buildNameMatcher('李雷', '雷.子');
  assert.equal(dotted.variants[0].test('雷子'), false);
  assert.equal(dotted.variants[0].test('雷.子'), true);

  // 与姓名完全相同的变体去重，免得同一处报两次
  assert.equal(buildNameMatcher('李雷', '李雷').variants.length, 0);
});

/* ------------------------------------------------------------------ 正面用例 */

test('detectAlerts：整名命中判 3 档，且不因为「同学」多报一条', () => {
  const alerts = detectAlerts('示例同学同学，我们继续');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'name');
  assert.equal(alerts[0].severity, 3);
  assert.equal(alerts[0].matched, '示例同学');
  assert.equal(alerts[0].label, '叫到你');
  assert.ok(alerts[0].snippet.includes('示例同学'));
});

test('detectAlerts：同音错字（度皓洋）照样算叫到你', () => {
  const alerts = detectAlerts('度皓洋，你来回答一下', { studentName: '杜浩阳' });
  const names = alerts.filter((a) => a.kind === 'name');
  assert.equal(names.length, 1);
  assert.equal(names[0].matched, '度皓洋');
  assert.equal(names[0].severity, 3);
});

test('detectAlerts：只报名字（没有姓）也算 3 档', () => {
  const alerts = detectAlerts('这个问题请浩阳回答', { studentName: '杜浩阳' });
  const names = alerts.filter((a) => a.kind === 'name');
  assert.equal(names.length, 1);
  assert.equal(names[0].matched, '浩阳');
  assert.equal(names[0].severity, 3);
});

test('detectAlerts：只在窗口里出现的姓单字，必须挨着称呼语才报，且判 2 档', () => {
  const alerts = detectAlerts('杜同学，在吗', { studentName: '杜浩阳' });
  const names = alerts.filter((a) => a.kind === 'name');
  assert.equal(names.length, 1);
  assert.equal(names[0].matched, '杜');
  assert.equal(names[0].severity, 2);
});

test('detectAlerts：点名 / 签到类是 3 档', () => {
  const alerts = detectAlerts('我们先点名，没到的下课来找我');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'rollcall');
  assert.equal(alerts[0].severity, 3);
  assert.equal(alerts[0].matched, '点名');
  assert.equal(alerts[0].label, '点名 / 签到');
});

test('detectAlerts：要求作答是 3 档，一般提问是 2 档', () => {
  const strong = detectAlerts('这一题谁来回答');
  const hit = strong.find((a) => a.kind === 'question-strong');
  assert.ok(hit, '「谁来回答」要判成要求作答');
  assert.equal(hit.severity, 3);
  assert.equal(hit.label, '要求作答');
  // 「谁来回答」里含「谁来」，包含去重后不该再多一条
  assert.equal(strong.some((a) => a.matched === '谁来'), false);

  const soft = detectAlerts('这道题思考一下，等下我提问');
  assert.ok(soft.length >= 2);
  for (const alert of soft) {
    assert.equal(alert.kind, 'question');
    assert.equal(alert.severity, 2);
    assert.equal(alert.label, '提问');
  }
});

/* ------------------------------------------------------------------ 负面用例 */

test('detectAlerts：不报「都 / 好 / 号」这类高频字（同音表刻意不收）', () => {
  assert.deepEqual(detectAlerts('我都听懂了吧'), []);
  assert.deepEqual(detectAlerts('这个号很难抢'), []);
  assert.deepEqual(detectAlerts('好，我们接着讲'), []);
});

test('detectAlerts：姓单字落在「速度 / 程度」这类词里要判误报', () => {
  assert.deepEqual(detectAlerts('这个速度太快了，同学们都跟不上'), []);
  assert.deepEqual(detectAlerts('这门课的难度和深度都挺合适'), []);
});

test('detectAlerts：光有姓、附近没有称呼语就不报', () => {
  assert.deepEqual(detectAlerts('杜甫的诗写得很好'), []);
});

test('detectAlerts：纯噪音 / 空文本不报', () => {
  assert.deepEqual(detectAlerts(''), []);
  assert.deepEqual(detectAlerts('。，、——'), []);
});

test('detectAlerts：一段异常文本最多产 MAX_ALERTS_PER_FRAME 条', () => {
  const alerts = detectAlerts('点名 '.repeat(30));
  assert.equal(alerts.length, MAX_ALERTS_PER_FRAME);
});

test('snippetAround：截断时加省略号，短文本原样返回', () => {
  assert.equal(snippetAround('示例同学同学', 0, 3), '示例同学同学');
  const long = `${'前'.repeat(40)}示例同学${'后'.repeat(40)}`;
  const snippet = snippetAround(long, 40, 3, 5);
  // 宽度 = 名字前后各若干字，名字本身长度不由这里假定，断言只看形状
  assert.ok(snippet.startsWith('…前') && snippet.endsWith('后…'), '两端要有省略号');
  assert.ok(snippet.includes('示例同学'), '名字要留在片段里');
});

/* ------------------------------------------------------------------ 会话层 */

test('safeFileName / localDate：课程名里的 Windows 非法字符要换掉', () => {
  assert.equal(safeFileName('高等数学/习题课'), '高等数学_习题课');
  assert.equal(safeFileName('   '), '未命名课程');
  assert.equal(safeFileName('a?b*c'), 'a_b_c');
  assert.equal(safeFileName('很长的课程名'.repeat(10)).length, 40);
  assert.equal(localDate(new Date(2026, 9, 9, 13, 5, 0)), '2026-10-09');
});

test('session：喂一帧文本 → 拿到提醒 → 停止时落盘完整记录', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      clock: () => new Date(2026, 9, 9, 8, 0, 0),
      studentName: '示例同学',
    });

    assert.equal(session.running(), false);
    assert.deepEqual(await session.feed({ text: '还没开始' }), { ok: false, error: 'no-session' });

    const started = await session.start({ course: '高等数学', source: 'screen' });
    assert.equal(started.ok, true);
    assert.equal(started.session.course, '高等数学');
    assert.equal(session.running(), true);

    // 没结束就不许再开一节 —— 否则两节课的逐字稿会串在一起
    const again = await session.start({ course: '线性代数' });
    assert.equal(again.ok, false);
    assert.equal(again.error, 'session-active');

    const fed = await session.feed({ text: '示例同学同学，你来回答一下' });
    assert.equal(fed.ok, true);
    assert.equal(fed.appended, '示例同学同学，你来回答一下');
    assert.equal(fed.alerts.length, 1);
    assert.equal(fed.alerts[0].kind, 'name');
    assert.equal(fed.alerts[0].ack, false);
    assert.equal(fed.alerts[0].id, 'a1');

    const snap = session.snapshot();
    assert.equal(snap.running, true);
    assert.equal(snap.alerts.length, 1);
    assert.equal(snap.segments.length, 1);

    const acked = await session.ack('a1');
    assert.deepEqual(acked, { ok: true, id: 'a1' });
    assert.equal(session.snapshot().alerts.length, 0, '确认过的提醒不该再出现在浮层里');
    assert.equal((await session.ack('a999')).error, 'unknown-alert');

    const stopped = await session.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stats.frames, 1);
    assert.equal(stopped.stats.alerts, 1);
    assert.equal(session.running(), false);

    const expected = path.join(dir, '听课记录', '2026-10-09-高等数学.json');
    assert.equal(stopped.file, expected);
    const payload = JSON.parse(await fs.readFile(expected, 'utf8'));
    assert.equal(payload.kind, 'lecture-transcript');
    assert.equal(payload.course, '高等数学');
    assert.equal(payload.source, 'screen');
    assert.equal(payload.studentName, '示例同学');
    assert.equal(payload.stoppedAt, new Date(2026, 9, 9, 8, 0, 0).toISOString());
    assert.equal(payload.text, '示例同学同学，你来回答一下');
    assert.equal(payload.alerts.length, 1);
    assert.equal(payload.alerts[0].matched, '示例同学');
    assert.equal(payload.segments.length, 1);

    const listed = await session.list();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.items.map((item) => item.name), ['2026-10-09-高等数学.json']);
  } finally {
    await removeTempDir(dir);
  }
});

test('session：跨帧被截断的名字能拼上（「老师示」+「例同学…」）', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      clock: () => new Date(2026, 9, 9, 8, 0, 0),
      studentName: '示例同学',
    });
    await session.start({ course: '高等数学' });
    const first = await session.feed({ text: '今天我们讲函数的连续性，老师说示' });
    assert.deepEqual(first.alerts, [], '名字还没拼全，这一帧不该报');

    // 腾讯会议的字幕是滚动窗口：新一帧以上一帧的末尾 6 个字开头，名字被切在「示」「例」之间
    const second = await session.feed({ text: '性，老师说示例同学同学你来回答一下' });
    assert.equal(second.overlap, 6);
    assert.equal(second.appended, '例同学同学你来回答一下');
    assert.equal(second.alerts.length, 1);
    assert.equal(second.alerts[0].matched, '示例同学');
    assert.equal(second.alerts[0].severity, 3);
    assert.equal(session.snapshot().textTail, '今天我们讲函数的连续性，老师说示例同学同学你来回答一下');
    await session.stop();
  } finally {
    await removeTempDir(dir);
  }
});

test('session：同一帧重复到达不追加、也不再报提醒', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      clock: () => new Date(2026, 9, 9, 8, 0, 0),
      studentName: '示例同学',
    });
    await session.start({ course: '高等数学' });
    const first = await session.feed({ text: '示例同学同学你来回答一下' });
    assert.equal(first.alerts.length, 1);
    const repeat = await session.feed({ text: '示例同学同学你来回答一下' });
    assert.equal(repeat.appended, '');
    assert.deepEqual(repeat.alerts, []);
    assert.equal(session.snapshot().textTail, '示例同学同学你来回答一下');
    await session.stop();
  } finally {
    await removeTempDir(dir);
  }
});

test('session：已经报过的那一段延伸出新句子时，老命中不再重复报', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      clock: () => new Date(2026, 9, 9, 8, 0, 0),
      studentName: '示例同学',
    });
    await session.start({ course: '高等数学' });
    const first = await session.feed({ text: '示例同学同学你来回答一下' });
    assert.equal(first.alerts.length, 1);
    // 整帧是上一帧 + 追加 —— 新命中必须落在追加的那一段里
    const second = await session.feed({ text: '示例同学同学你来回答一下，请翻到第三页' });
    assert.equal(second.appended, '，请翻到第三页');
    assert.deepEqual(second.alerts, [], '老命中（offset 3 <= 新起点 11）要滤掉');
    await session.stop();
  } finally {
    await removeTempDir(dir);
  }
});

test('session：一分钟内同样的提醒只报一次', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const now = { at: new Date(2026, 9, 9, 8, 0, 0) };
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      clock: () => now.at,
      studentName: '示例同学',
    });
    await session.start({ course: '高等数学' });

    // 为什么要造这么长的一帧：去重键用的是「命中词 + 前后各 26 字的片段」，
    // 只有当名字在两次命中里都离文本两端足够远（前后都带省略号）、且周围
    // 26 字完全一样时，键才真的相等。这正是滚动字幕反复重发同一句的样子。
    const window = `${'甲'.repeat(26)}示例同学${'乙'.repeat(26)}`;
    const filler = '丙'.repeat(30);
    const first = `前${'甲'.repeat(30)}${window}${filler}`;
    const second = `${first}${filler}${window}${filler}`;

    const fed1 = await session.feed({ text: first });
    assert.equal(fed1.alerts.length, 1);
    const fed2 = await session.feed({ text: second });
    assert.ok(fed2.appended.length > 0, '这一帧确实带了新内容');
    assert.deepEqual(fed2.alerts, [], '同样的提醒在时间窗内要丢掉');
    assert.equal(fed2.session.stats.dropped, 1);
    await session.stop();
  } finally {
    await removeTempDir(dir);
  }
});

test('session：独立实例之间互不干扰，list() 在没有目录时返回空', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const session = createLectureSession({ dataDir: dir, logger: { error() {} } });
    assert.deepEqual(session.snapshot(), {
      ok: true,
      running: false,
      session: null,
      rolling: '',
      segments: [],
      alerts: [],
      textTail: '',
    });
    const listed = await session.list();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.items, []);
    assert.equal((await session.stop()).error, 'no-session');
  } finally {
    await removeTempDir(dir);
  }
});

/* --------------------------------------------------- 与总结引擎的挂钩（后台任务） */

/** 记账版假引擎：把每次调用记下来，并按用例决定返回什么。 */
test('session：文本来源 mic/tab/paste 原样保留，未知值退回 screen', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const cases = [['mic', 'mic'], ['tab', 'tab'], ['paste', 'paste'], ['screen', 'screen'], ['nonsense', 'screen'], [undefined, 'screen']];
    for (const [input, expected] of cases) {
      const session = createLectureSession({ dataDir: dir, logger: { error() {} } });
      const started = await session.start({ course: '高等数学', source: input });
      assert.equal(started.ok, true);
      assert.equal(started.session.source, expected, `source=${String(input)}`);
      await session.stop();
    }
  } finally {
    await removeTempDir(dir);
  }
});

function stubEngine(overrides = {}) {
  const calls = { roll: 0, answer: 0, answerKinds: [], setCourse: [], reset: 0 };
  const engine = {
    calls,
    available: () => true,
    setCourse(value) { calls.setCourse.push(value); },
    reset() { calls.reset += 1; },
    shouldRoll: () => true,
    roll: async ({ text, at }) => {
      calls.roll += 1;
      return { ok: true, text: `脉络#${calls.roll}（${text.length} 字 @${at}）` };
    },
    // 真引擎的 answer() 自己会挡掉点名/签到类（见 lecture-summarize.test.js），
    // 这里照抄那条契约，好让「谁被答了」这件事在会话层也看得出来。
    answer: async ({ alert }) => {
      calls.answer += 1;
      calls.answerKinds.push(alert.kind);
      if (alert.kind !== 'question' && alert.kind !== 'question-strong') {
        return { ok: false, skipped: 'not-a-question' };
      }
      return { ok: true, key: alert.key, text: `答案：${alert.matched}` };
    },
    summarize: async () => ({ ok: true, summary: null, raw: '' }),
    ...overrides,
  };
  return engine;
}

/** 轮询会话上的收尾状态，直到后台的总结/写笔记/交接跑完（或超时）。 */
async function waitForSessionReport(session, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    report = session.report().report;
    if (report !== null && typeof report.stage === 'string'
      && (report.stage === 'done' || report.stage === 'done-no-session' || report.stage === 'note-failed')) {
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return report;
}

test('session：喂帧会触发滚动小结与提问秒答，且回填到会话上（全程不 await）', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const engine = stubEngine();
    const session = createLectureSession({ dataDir: dir, logger: { error() {} }, summarizer: engine });
    const started = await session.start({ course: '高等数学', source: 'screen' });
    assert.equal(started.ok, true);
    assert.deepEqual(engine.calls.setCourse, ['高等数学'], '开课要把课程名告诉引擎');
    assert.equal(engine.calls.reset, 1);

    // 一帧里同时有「叫到名字」和「提问」：两类提醒都要交给引擎，但只有提问类会被真的回答
    const fed = await session.feed({ text: '示例同学同学，这道题谁来回答一下' });
    const kinds = fed.alerts.map((alert) => alert.kind);
    assert.ok(kinds.includes('name') === true, `这一帧应该有叫名字的提醒：${kinds.join(',')}`);
    assert.ok(kinds.includes('question-strong') === true, `这一帧也应该有提问提醒：${kinds.join(',')}`);

    // 后台任务：等到回填完成（最多 1 秒），而不是假设它同步完成
    const deadline = Date.now() + 1000;
    let snapshot = session.snapshot();
    const answered = () => snapshot.alerts.some((alert) => typeof alert.answer === 'string');
    while (Date.now() < deadline && (snapshot.rolling === '' || !answered())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      snapshot = session.snapshot();
    }

    assert.ok(snapshot.rolling.startsWith('脉络#1'), '滚动小结要回填进快照');
    assert.equal(engine.calls.roll, 1);
    // 点名/签到类**根本不问模型**：这类提醒要的是学生本人抬头，AI 插话只会帮倒忙
    const questionKinds = kinds.filter((kind) => kind === 'question' || kind === 'question-strong');
    assert.deepEqual(engine.calls.answerKinds, questionKinds, '只有提问类提醒去问模型');
    assert.equal(engine.calls.answer, questionKinds.length);
    const nameAlert = snapshot.alerts.find((alert) => alert.kind === 'name');
    assert.equal(nameAlert.answer, undefined, '点名不该有 AI 答案，只该有提醒');
    const withAnswers = snapshot.alerts.filter((alert) => typeof alert.answer === 'string');
    assert.equal(withAnswers.length, questionKinds.length);
    for (const alert of withAnswers) {
      assert.ok(alert.answer.startsWith('答案：'), '提问要有答案');
      assert.ok(typeof alert.answerAt === 'string');
    }

    // 结束：在飞的 AI 任务要先落地，否则最后一段小结写不进文件
    const stopped = await session.stop();
    assert.equal(stopped.ok, true);
    assert.ok(stopped.rolling.startsWith('脉络#1'));
    const saved = JSON.parse(await fs.readFile(stopped.file, 'utf8'));
    assert.ok(saved.rolling.startsWith('脉络#1'));
    const savedQuestion = saved.alerts.find((alert) => alert.kind === 'question-strong');
    assert.ok(savedQuestion.answer.startsWith('答案：'));
  } finally {
    await removeTempDir(dir);
  }
});

test('session：引擎报错只记进会话，不让喂帧/结束失败', async () => {
  const dir = await makeTempDir('lecture-alert-');
  try {
    const engine = stubEngine({
      roll: async () => ({ ok: false, error: 'llm-timeout' }),
      answer: async () => ({ ok: false, error: 'RATE_LIMIT' }),
      summarize: async () => ({ ok: false, error: 'llm-timeout' }),
    });
    const session = createLectureSession({
      dataDir: dir,
      logger: { error() {} },
      summarizer: engine,
      // 这里不测写盘（api.js 那条链路有端到端用例），但要让收尾流程能走完，
      // 才看得到「总结失败」是怎么记下来的。
      reporting: {
        render: () => '# 笔记',
        write: async () => ({ ok: true, file: `${dir}\\笔记\\x.md`, dirName: '', via: '', fallback: true }),
        handoffPrompt: () => 'prompt',
        handoff: null,
      },
    });
    await session.start({ course: '高等数学' });
    const fed = await session.feed({ text: '示例同学同学，这道题谁来回答一下' });
    assert.equal(fed.ok, true, '模型失败不能影响喂帧');

    const stopped = await session.stop();
    assert.equal(stopped.ok, true, '模型失败不能影响结束');

    const report = await waitForSessionReport(session);
    // 失败要留痕：面板得能告诉用户「这次没总结成」，而不是安静地给一份空笔记
    assert.equal(report.stage, 'done-no-session');
    assert.equal(report.summaryOk, false);
    assert.equal(report.summaryError, 'llm-timeout');
    assert.equal(report.note.ok, true, '总结失败也要把逐字稿摘录落成笔记');
  } finally {
    await removeTempDir(dir);
  }
});
