/**
 * 会话心跳的调度层测试（零依赖、不联网、不起浏览器）
 * 运行：node tests/learn-keepalive.test.js
 *
 * 这里只钉「什么时候跑」：启动后先验一次、之后按间隔跑、上一轮没完不重叠、
 * 校验函数抛异常也不能把宿主带崩。真正的「跑什么」由 api.js 注入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startLearnKeepAlive,
  LEARN_KEEPALIVE_INTERVAL_MS,
  LEARN_KEEPALIVE_FIRST_DELAY_MS,
} from '../lib/learn-keepalive.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const silentLogger = { info() {}, warn() {}, error() {} };

test('心跳：默认 8 分钟一次，启动后先等 5 秒', () => {
  // 20 分钟离学堂那张会话 Cookie 的空闲超时太近，迟一跳就断；8 分钟留两倍余量
  assert.equal(LEARN_KEEPALIVE_INTERVAL_MS, 8 * 60 * 1000);
  assert.equal(LEARN_KEEPALIVE_FIRST_DELAY_MS, 5000);
});

test('心跳：睡了一觉回来（那一跳迟到 3 倍间隔以上）记成 resume', async () => {
  const reasons = [];
  const keepAlive = startLearnKeepAlive({
    check: async (reason) => { reasons.push(reason); },
    firstDelayMs: 1,
    intervalMs: 30,
    logger: silentLogger,
  });
  await sleep(5);
  // 忙等占住事件循环 ≈ 合盖睡眠：醒来后那一跳会迟到很久
  const until = Date.now() + 200;
  while (Date.now() < until) { /* 故意空转 */ }
  await sleep(10);
  keepAlive.stop();
  assert.deepEqual(reasons.slice(0, 1), ['startup']);
  assert.ok(reasons.includes('resume'), `迟到的那一跳应记成 resume，实际：${reasons.join(',')}`);
});

test('心跳：没有 check 直接报错（静默不跑比报错更难查）', () => {
  assert.throws(() => startLearnKeepAlive({ logger: silentLogger }), /check-required/);
});

test('心跳：先跑一次 startup，之后按间隔跑 timer，stop 后彻底停', async () => {
  const reasons = [];
  const keepAlive = startLearnKeepAlive({
    check: async (reason) => { reasons.push(reason); return reason; },
    firstDelayMs: 5,
    intervalMs: 20,
    logger: silentLogger,
  });

  await sleep(15);
  assert.deepEqual(reasons, ['startup'], '启动后应先验一次');

  await sleep(40);
  assert.ok(reasons.length >= 2, `应至少再跑过一次，实际 ${reasons.length} 次`);
  assert.deepEqual(reasons.slice(1, 2), ['timer']);

  keepAlive.stop();
  const seen = reasons.length;
  await sleep(60);
  assert.equal(reasons.length, seen, 'stop 之后不该再跑');
  keepAlive.stop(); // 幂等：重复 stop 也不该抛
});

test('心跳：上一轮还没跑完就跳过这一轮（不会同时开好几个浏览器）', async () => {
  let started = 0;
  const keepAlive = startLearnKeepAlive({
    check: async () => { started += 1; await sleep(60); },
    firstDelayMs: 1,
    intervalMs: 5,
    logger: silentLogger,
  });
  await sleep(30);
  keepAlive.stop();
  assert.equal(started, 1);
});

test('心跳：check 抛异常不冒泡，只记一条日志', async () => {
  const logged = [];
  const keepAlive = startLearnKeepAlive({
    check: async () => { throw new Error('boom'); },
    firstDelayMs: 1,
    intervalMs: 1000,
    logger: { info() {}, warn() {}, error: (...args) => logged.push(args.join(' ')) },
  });
  await sleep(20);
  keepAlive.stop();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /会话心跳异常/);
});

test('心跳：runNow 能手动验一次，onResult 拿得到结果', async () => {
  const seen = [];
  const keepAlive = startLearnKeepAlive({
    check: async (reason) => ({ reason }),
    firstDelayMs: 10000,
    intervalMs: 10000,
    logger: silentLogger,
    onResult: (result) => seen.push(result),
  });
  const out = await keepAlive.runNow('manual');
  keepAlive.stop();
  assert.deepEqual(out, { reason: 'manual' });
  assert.deepEqual(seen, [{ reason: 'manual' }]);
});

test('心跳：runNow 默认原因是 manual', async () => {
  const reasons = [];
  const keepAlive = startLearnKeepAlive({
    check: async (reason) => { reasons.push(reason); },
    firstDelayMs: 10000,
    intervalMs: 10000,
    logger: silentLogger,
  });
  await keepAlive.runNow();
  keepAlive.stop();
  assert.deepEqual(reasons, ['manual']);
});
