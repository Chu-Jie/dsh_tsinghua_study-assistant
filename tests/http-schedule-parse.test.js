/**
 * `POST /schedule/parse`（AI 智能识别）+ 日程新字段落盘的 HTTP 测试。
 * 运行：npm test
 *
 * 三条硬要求：
 *   1. **绝不真打网络**：`deps.aiComplete` 全部用桩注入，默认的 Paratera 通道在这份测试里
 *      一次都不会被执行；「缺密钥」用 `aiKeyPath` 指到一个不存在的文件来模拟。
 *   2. **失败不猜、不入库**：任何 `ok:false` 的响应里都不能带 draft，`日程.json` 一个字节不变。
 *   3. **旧字段兼容**：老形状的 create（只有 title/date/time/note）仍能写进去，读回时四个新字段
 *      有缺省值（work / '' / null / manual）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/** 固定的「今天」：2026-11-19（周四），让相对日期兜底可断言。 */
const FIXED_NOW = new Date('2026-11-19T09:00:00+08:00');

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-parse-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({
    store,
    dataDir: dir,
    backupKeep: 3,
    logger: { error() {}, info() {}, warn() {} },
    now: () => new Date(FIXED_NOW.getTime()),
    ...options,
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

function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 日程文件原文（没有就返回 null）。用来断言「识别接口一个字节都不写」。 */
async function scheduleFileText(dir) {
  try {
    return await fs.readFile(path.join(dir, '日程.json'), 'utf8');
  } catch {
    return null;
  }
}

const GOOD_CONTENT = JSON.stringify({
  title: '挑战杯初赛材料讨论',
  date: '2026-11-20',
  time: '15:00',
  endTime: '16:30',
  location: '六教 3204',
  category: 'innovation',
});

test('POST /schedule/parse：缺安全请求头 → 403，且不调用模型', async () => {
  let called = 0;
  const server = await startServer({
    aiComplete: async () => { called += 1; return { content: GOOD_CONTENT }; },
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天下午三点开会' }, { withHeader: false });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'need-request-header');
    assert.equal(called, 0);
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：空文本 → 400，不调用模型', async () => {
  let called = 0;
  const server = await startServer({
    aiComplete: async () => { called += 1; return { content: GOOD_CONTENT }; },
  });
  try {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
      const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, body);
      assert.equal(response.status, 400, '空/非字符串文本按 400 拒收');
      assert.equal((await response.json()).error, 'schedule-parse-empty');
    }
    assert.equal(called, 0);
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：正常 JSON → 返回完整 draft，且不写 日程.json', async () => {
  const server = await startServer({
    aiComplete: async (input) => {
      // prompt 必须带「今天」与原文，模型才知道相对日期怎么换算
      assert.match(input.user, /【今天】2026-11-19（周四）/);
      assert.match(input.user, /挑战杯初赛/);
      assert.equal(input.temperature, 0.2, '温度必须是 0.2，别让模型自由发挥');
      return { content: GOOD_CONTENT, attempts: [{ attempt: 1, status: 200 }] };
    },
  });
  try {
    const before = await scheduleFileText(server.dir);
    const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天下午三点在六教 3204 讨论挑战杯初赛' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.draft.title, '挑战杯初赛材料讨论');
    assert.equal(result.draft.date, '2026-11-20');
    assert.equal(result.draft.time, '15:00');
    assert.equal(result.draft.endTime, '16:30');
    assert.equal(result.draft.location, '六教 3204');
    assert.equal(result.draft.category, 'innovation');
    assert.equal(result.draft.source, 'auto-ai', '识别结果一律标 auto-ai，前端还要用户确认');
    const after = await scheduleFileText(server.dir);
    assert.equal(after, before, '识别接口不许写盘（文件内容必须一字不差）');
    assert.deepEqual(JSON.parse(after).entries, [], '识别结果不许自己进 日程.json');
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：模型套代码围栏 / 前后加话也能解析', async () => {
  const server = await startServer({
    aiComplete: async () => ({ content: `好的，结果如下：\n\`\`\`json\n${GOOD_CONTENT}\n\`\`\`\n如需调整告诉我。` }),
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天下午三点讨论挑战杯' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.draft.title, '挑战杯初赛材料讨论');
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：非 JSON / 缺标题 / 网络失败 / 坏 JSON → ok:false 且不写盘', async () => {
  const cases = [
    { name: '纯文本', content: '我猜是明天下午三点开会', status: 502, error: 'ai-bad-output' },
    { name: '缺标题', content: JSON.stringify({ date: '2026-11-20', time: '15:00' }), status: 502, error: 'ai-bad-title' },
    { name: '截断的 JSON', content: '{"title":"组会","date":"2026-11-20"', status: 502, error: 'ai-bad-output' },
  ];
  for (const item of cases) {
    const server = await startServer({ aiComplete: async () => ({ content: item.content }) });
    try {
      const before = await scheduleFileText(server.dir);
      const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天下午三点开会' });
      assert.equal(response.status, item.status, `${item.name}：状态码`);
      const result = await response.json();
      assert.equal(result.ok, false, `${item.name}：必须 ok:false`);
      assert.equal(result.error, item.error, `${item.name}：错误码`);
      assert.equal(result.draft, undefined, `${item.name}：失败时不许给 draft（不拿半成品入库）`);
      assert.equal(await scheduleFileText(server.dir), before, `${item.name}：不许写盘`);
    } finally {
      await server.close();
    }
  }

  // 通道本身抛错（超时 / DNS / 限流重试耗尽）
  const server = await startServer({
    aiComplete: async () => { throw new Error('socket hang up'); },
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天开会' });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ai-unavailable');
    assert.equal(result.draft, undefined);
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：没读到密钥 → 503 ai-key-missing，且提示不含密钥', async () => {
  const server = await startServer({
    // 指到一个不存在的凭据文件：走真实的 readParateraKey 分支，但绝不读真密钥
    aiKeyPath: path.join('C:\\不存在的目录', 'no-credentials.yaml'),
  });
  try {
    const response = await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天开会' });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ai-key-missing');
    const text = JSON.stringify(result);
    assert.match(text, /PARATERA_API_KEY/, '要告诉用户缺的是哪个键');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8}/, '响应里不能出现密钥本体');
    assert.doesNotMatch(text, /credentials\.yaml.*=.*[A-Za-z0-9]{20}/);
  } finally {
    await server.close();
  }
});

test('POST /schedule/parse：模型没给日期时用原文相对日期兜底；给不出就留空', async () => {
  const server = await startServer({
    aiComplete: async (input) => {
      if (input.user.includes('明天')) {
        return { content: JSON.stringify({ title: '组会', date: '', time: '15:00', endTime: null, location: '', category: 'work' }) };
      }
      if (input.user.includes('下周三')) {
        return { content: JSON.stringify({ title: '院系例会', date: '', time: '14:00', location: '系馆', category: 'work' }) };
      }
      return { content: JSON.stringify({ title: '月底前找时间', date: '', time: null, location: '', category: '' }) };
    },
  });
  try {
    const tomorrow = await (await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '明天下午三点开组会' })).json();
    assert.equal(tomorrow.ok, true);
    assert.equal(tomorrow.draft.date, '2026-11-20', '「明天」用当前时间兜底成 11-20');

    const nextWeek = await (await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '下周三下午两点系馆开会' })).json();
    assert.equal(nextWeek.ok, true);
    // 2026-11-19 是周四；下周三是 11-25
    assert.equal(nextWeek.draft.date, '2026-11-25', '「下周三」要按教学周推');

    const noDate = await (await jsonRequest(`${server.baseUrl}/schedule/parse`, { text: '月底前找时间交材料' })).json();
    assert.equal(noDate.ok, true);
    assert.equal(noDate.draft.date, '', '算不出来的日期必须留空，不许猜');
    assert.equal(noDate.draft.category, '', '模型没给合法分类时留空，由前端保留下拉默认值');
  } finally {
    await server.close();
  }
});

test('POST /mutate doc=schedule：新字段能落盘，旧形状仍兼容并补缺省', async () => {
  const server = await startServer({});
  try {
    // 新形状：四个新字段都写进去
    const created = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: {
        title: '挑战杯初赛材料讨论',
        date: '2026-11-20',
        time: '15:00',
        endTime: '16:30',
        location: '六教 3204',
        category: 'innovation',
        source: 'auto-ai',
        note: '带电脑',
      },
    });
    assert.equal(created.status, 200);

    // 旧形状：只有 title/date/time/note
    const legacy = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '去三教交纸质作业', date: '2026-11-19', time: null, note: '五点前' },
    });
    assert.equal(legacy.status, 200);

    const doc = JSON.parse(await fs.readFile(path.join(server.dir, '日程.json'), 'utf8'));
    assert.equal(doc.entries.length, 2);
    const fresh = doc.entries.find((entry) => entry.title === '挑战杯初赛材料讨论');
    assert.equal(fresh.category, 'innovation');
    assert.equal(fresh.endTime, '16:30');
    assert.equal(fresh.location, '六教 3204');
    assert.equal(fresh.source, 'auto-ai');
    const old = doc.entries.find((entry) => entry.title === '去三教交纸质作业');
    assert.equal(old.category, 'work', '旧形状补缺省分类 work');
    assert.equal(old.endTime, null, '旧形状补缺省结束时间 null');
    assert.equal(old.location, '', '旧形状补缺省地点');
    assert.equal(old.source, 'manual', '旧形状缺省来源 manual');
  } finally {
    await server.close();
  }
});

test('POST /mutate doc=schedule：非法分类 / 非法结束时间 → 400 拒写', async () => {
  const server = await startServer({});
  try {
    const badCategory = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '试试', date: '2026-11-19', category: 'hobby' },
    });
    assert.equal(badCategory.status, 400);
    assert.equal((await badCategory.json()).error, 'schedule-bad-category');

    const badEnd = await jsonRequest(`${server.baseUrl}/mutate`, {
      doc: 'schedule',
      action: 'create',
      item: { title: '试试', date: '2026-11-19', time: '09:00', endTime: '9:30' },
    });
    assert.equal(badEnd.status, 400);
    assert.equal((await badEnd.json()).error, 'schedule-bad-end-time');

    // 两条都没写进去
    const doc = JSON.parse(await fs.readFile(path.join(server.dir, '日程.json'), 'utf8'));
    assert.equal(doc.entries.length, 0);
  } finally {
    await server.close();
  }
});
