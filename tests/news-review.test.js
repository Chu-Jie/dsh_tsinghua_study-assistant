// B2 卡：要闻「AI 内容审核」的钉子（2026-11-19）。
//
// 覆盖 7 件事：
//   1. 源清单：删了「清华新闻·最新动态」，保住「人才培养」，5 栏 4 站；
//   2. buildReviewPrompt：判据写在 system、每条一行、首段截 150、不带任何凭据字样；
//   3. parseReviewResponse：正常 / 围栏与寒暄 / 非法 JSON / 编造 id / keep-drop 冲突 / 漏判；
//   4. reviewItems 正常判定：keep 进、drop 出、理由留存、一次批量；
//   5. 降级：非法 JSON、网络失败、缺通道 —— 一律全批保留 + failed 计数 + enabled=false；
//   6. 缓存：判过的 url 不再调模型；dry-run 不写缓存；缓存截到 500 条；
//   7. 批量合并：>60 条自动分批，每批 ≤60，结果按原顺序拼回。
//
// 全部用注入的假 callModel，**不真调 API、不读凭据**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  REVIEW_SYSTEM_PROMPT,
  SOURCES,
  buildReviewPrompt,
  defaultReviewCachePath,
  parseReviewResponse,
  reviewCacheKey,
  reviewItems,
} from '../tools/fetch-news.mjs';

/** 造一条「归一化后」的要闻。 */
function newsItem(index, overrides = {}) {
  const url = overrides.url ?? `https://www.tsinghua.edu.cn/info/1023/2026${index}.htm`;
  return {
    id: overrides.id ?? `n_test${String(index).padStart(3, '0')}`,
    title: `标题 ${index}`,
    url,
    source: '清华新闻',
    publishedAt: '2026-11-18',
    excerpt: '首段一句话。',
    category: 'academic',
    fetchedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

/** 静默 logger（测试不往控制台喷日志）。 */
function silentLogger() {
  const lines = [];
  return { lines, line: (text) => lines.push(text) };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'news-review-'));
}

test('源清单：删掉「清华新闻·最新动态」，保留「人才培养」，5 个栏目 / 4 个站点', () => {
  assert.equal(SOURCES.length, 5, '删源后应剩 5 个栏目');
  const ids = SOURCES.map((source) => source.id);
  assert.ok(!ids.includes('thu-news-zxdt'), 'thu-news-zxdt 必须已删除');
  assert.ok(ids.includes('thu-news-rcpy'), '人才培养源必须保留（它夹杂实用稿，交给审核层）');
  for (const source of SOURCES) {
    assert.ok(!/news\/zxdt\.htm/.test(source.url), `${source.id} 不应再指向最新动态`);
    assert.ok(!/最新动态/.test(source.name), `${source.id} 的名称不应含「最新动态」`);
  }
  // 站点去重：学发中心 2 栏、清华新闻 1 栏、iCenter 1 栏、挑战杯 1 栏 = 4 个站点
  const hosts = new Set(SOURCES.map((source) => new URL(source.url).hostname));
  assert.equal(hosts.size, 4, '4 个站点');
});

test('buildReviewPrompt：判据在 system 里，每条一行，首段截 150 字，不含凭据字样', () => {
  const items = [
    newsItem(1, { title: '2026年秋季学期宣传工作负责人会议召开' }),
    newsItem(2, { title: '2026-2027秋 本科生/研究生退课安排' }),
    newsItem(3, { excerpt: 'x'.repeat(400) }),
  ];
  const prompt = buildReviewPrompt(items);

  assert.equal(prompt.system, REVIEW_SYSTEM_PROMPT, 'system 就是导出那份判据，不另造');
  for (const keyword of ['退课', '奖学金', '招聘', '竞赛', '入党发展会', '签约', '论坛', '拿不准就保留']) {
    assert.ok(prompt.system.includes(keyword), `判据应提到「${keyword}」`);
  }
  assert.ok(prompt.system.includes('drop：清华大学与北汽集团签署战略合作协议'), '真实例子要写进 prompt');

  assert.ok(prompt.user.includes('共 3 条'), 'user 里要有总数');
  for (const item of items) {
    const rows = prompt.user.split('\n').filter((line) => line.startsWith(`${item.id} |`));
    assert.equal(rows.length, 1, `${item.id} 应正好一行`);
    assert.ok(rows[0].includes(item.publishedAt), '行里要有日期');
    assert.ok(rows[0].includes(item.source), '行里要有来源');
    assert.ok(rows[0].includes(item.title), '行里要有标题');
  }
  // 首段截断：150 个 x 在，151 个 x 不在
  assert.ok(prompt.user.includes('x'.repeat(150)), '首段应保留前 150 字');
  assert.ok(!prompt.user.includes('x'.repeat(151)), '首段超过 150 字的部分应被截掉');

  // 凭据不外泄到 prompt
  assert.ok(!/PARATERA_API_KEY|Authorization|Bearer|sk-[A-Za-z0-9]/.test(prompt.system + prompt.user));
});

test('parseReviewResponse：围栏 + 寒暄也能抠出 JSON', () => {
  const items = [newsItem(1), newsItem(2)];
  const text = [
    '好的，判定如下：',
    '```json',
    JSON.stringify({ keep: [items[0].id], drop: [items[1].id], why: { [items[1].id]: '纯科研进展' } }),
    '```',
    '以上。',
  ].join('\n');
  const parsed = parseReviewResponse(text, items);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.keep, [items[0].id]);
  assert.deepEqual(parsed.drop, [items[1].id]);
  assert.equal(parsed.why[items[1].id], '纯科研进展');
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.degraded, false);
});

test('parseReviewResponse：非法输出返回 error，绝不抛异常', () => {
  const items = [newsItem(1)];
  assert.equal(parseReviewResponse('抱歉，我无法判断这些新闻。', items).error, 'no-json');
  assert.equal(parseReviewResponse('{"keep":["n_test001"', items).error, 'no-json', '没闭合的括号连 JSON 候选都截不出来');
  assert.equal(parseReviewResponse('{"keep": ["x",}', items).error, 'bad-json');
  assert.equal(parseReviewResponse('{"keep":[],"drop":[]}', items).error, 'no-verdict');
  assert.equal(parseReviewResponse('', []).error, 'no-items');
});

test('parseReviewResponse：编造的 id 被忽略，keep 与 drop 冲突时保留优先，漏判记 missing', () => {
  const items = [newsItem(1), newsItem(2), newsItem(3)];
  const text = JSON.stringify({
    keep: [items[0].id, 'n_不存在的id'],
    drop: [items[0].id, items[2].id],
    why: { 'n_不存在的id': '瞎编', [items[2].id]: ' 入党发展会  ' },
  });
  const parsed = parseReviewResponse(text, items);
  assert.deepEqual(parsed.keep, [items[0].id]);
  assert.deepEqual(parsed.drop, [items[2].id], '同一 id 同时在 keep/drop，按保留处理');
  assert.equal(parsed.why['n_不存在的id'], undefined, '编造 id 的理由不留');
  assert.equal(parsed.why[items[2].id], '入党发展会', '理由压平空白');
  assert.deepEqual(parsed.missing, [items[1].id], '漏判的条目要记下来（调用方按保留处理）');
  assert.equal(parsed.degraded, true);
});

test('reviewItems 正常判定：drop 的不进行、理由留下、只发 1 次请求', async () => {
  const items = [
    newsItem(1, { title: '2026年秋季学期宣传工作负责人会议召开' }),
    newsItem(2, { title: '2026-2027秋 本科生/研究生退课安排' }),
    newsItem(3, { title: '人工智能学院召开助理教授刘淼入党发展会' }),
  ];
  const calls = [];
  const callModel = async (prompt) => {
    calls.push(prompt);
    return {
      content: JSON.stringify({
        keep: [items[1].id],
        drop: [items[0].id, items[2].id],
        why: { [items[0].id]: '宣传会议', [items[2].id]: '入党发展会' },
      }),
    };
  };
  const logger = silentLogger();
  const result = await reviewItems(items, { callModel, cachePath: '', logger });

  assert.deepEqual(result.kept.map((item) => item.id), [items[1].id]);
  assert.deepEqual(result.dropped.map((item) => item.id), [items[0].id, items[2].id]);
  assert.equal(result.why[items[0].id], '宣传会议');
  assert.equal(result.failed.length, 0);
  assert.equal(result.cached, 0);
  assert.equal(result.enabled, true);
  assert.equal(result.error, undefined);
  assert.equal(result.degraded, false);
  assert.equal(calls.length, 1, '三条一批，只发 1 次');
});

test('降级：模型两次都吐非法 JSON → 全批保留、failed 计数、enabled=false', async () => {
  const items = [newsItem(1), newsItem(2), newsItem(3)];
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return { content: '我判断不了，抱歉。' };
  };
  const logger = silentLogger();
  const result = await reviewItems(items, { callModel, cachePath: '', logger });

  assert.equal(calls, 2, '缺省只重问一次（2 次请求封顶）');
  assert.deepEqual(result.kept.map((item) => item.id), items.map((item) => item.id), '全批保留');
  assert.equal(result.dropped.length, 0, '绝不清空');
  assert.deepEqual(result.failed, items.map((item) => item.id));
  assert.equal(result.enabled, false);
  assert.equal(result.error, 'no-json');
  assert.ok(logger.lines.some((line) => line.includes('审核输出不合格')), '日志要留痕');
});

test('降级：网络失败 / 429 重试耗尽 → 全批保留、exit 不炸、日志 ERR', async () => {
  const items = [newsItem(1), newsItem(2)];
  const callModel = async () => { throw new Error('HTTP 429'); };
  const logger = silentLogger();
  const result = await reviewItems(items, { callModel, cachePath: '', logger });

  assert.deepEqual(result.kept.map((item) => item.id), items.map((item) => item.id));
  assert.equal(result.dropped.length, 0);
  assert.deepEqual(result.failed, items.map((item) => item.id));
  assert.equal(result.enabled, false, '审核层标为不可用，面板照旧显示这批');
  assert.equal(result.error, 'HTTP 429');
  assert.ok(logger.lines.some((line) => line.includes('审核请求失败')));
});

test('降级：没有可用的模型通道（缺凭据）→ 全批保留，一次请求都不发', async () => {
  const items = [newsItem(1), newsItem(2)];
  const result = await reviewItems(items, { callModel: undefined, cachePath: '' });
  assert.deepEqual(result.kept.map((item) => item.id), items.map((item) => item.id));
  assert.equal(result.dropped.length, 0);
  assert.equal(result.enabled, false);
  assert.equal(result.error, 'missing-model-channel');
});

test('开关：enabled=false（--no-review）原样返回，不碰模型、不碰缓存', async () => {
  const items = [newsItem(1), newsItem(2)];
  let calls = 0;
  const callModel = async () => { calls += 1; return { content: '{}' }; };
  const result = await reviewItems(items, { callModel, enabled: false, cachePath: '' });
  assert.equal(calls, 0);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.kept.map((item) => item.id), items.map((item) => item.id));
  assert.equal(result.dropped.length, 0);
});

test('缓存：判过的 url 不再花钱重判；新条目仍然送审', async () => {
  const dir = await tempDir();
  const cachePath = path.join(dir, 'news-review-cache.json');
  const cachedDrop = newsItem(1, { title: '签约揭牌' });
  const cachedKeep = newsItem(2, { title: '奖学金公示' });
  const fresh = newsItem(3, { title: '秋招宣讲会' });
  await fs.writeFile(cachePath, JSON.stringify({
    [reviewCacheKey(cachedDrop.url)]: { keep: false, why: '对外签约', at: '2026-11-18T00:00:00.000Z' },
    [reviewCacheKey(cachedKeep.url)]: { keep: true, why: '', at: '2026-11-18T00:00:00.000Z' },
  }), 'utf8');

  const calls = [];
  const callModel = async (prompt) => {
    calls.push(prompt);
    const ids = prompt.user.split('\n').filter((line) => line.startsWith('n_')).map((line) => line.split(' | ')[0]);
    return { content: JSON.stringify({ keep: ids, drop: [], why: {} }) };
  };
  const result = await reviewItems([cachedDrop, cachedKeep, fresh], { callModel, cachePath });

  assert.equal(result.cached, 2, '两条走缓存');
  assert.equal(calls.length, 1, '只有新条目发请求');
  const sentIds = calls[0].user.split('\n').filter((line) => line.startsWith('n_')).map((line) => line.split(' | ')[0]);
  assert.deepEqual(sentIds, [fresh.id], '缓存命中的不重复送审');
  assert.deepEqual(result.dropped.map((item) => item.id), [cachedDrop.id]);
  assert.equal(result.why[cachedDrop.id], '对外签约', '缓存里的理由要带回来');
  assert.deepEqual(result.kept.map((item) => item.id), [cachedKeep.id, fresh.id], '按原顺序');
});

test('缓存：dry-run（writeCache=false）判了但不落盘；正常写盘截到最近 500 条', async () => {
  const dir = await tempDir();
  const cachePath = path.join(dir, 'news-review-cache.json');
  const items = [newsItem(1), newsItem(2)];
  const callModel = async (prompt) => {
    const ids = prompt.user.split('\n').filter((line) => line.startsWith('n_')).map((line) => line.split(' | ')[0]);
    return { content: JSON.stringify({ keep: ids, drop: [], why: {} }) };
  };

  // dry-run：文件不存在，跑完也不该出现
  await reviewItems(items, { callModel, cachePath, writeCache: false });
  await assert.rejects(fs.stat(cachePath), 'dry-run 不写缓存');

  // 正常写：先塞 600 条旧缓存，跑 1 条新条目后应截到 500
  const seed = {};
  for (let index = 0; index < 600; index += 1) {
    seed[`hash${index}`] = { keep: true, why: '', at: `2026-10-01T00:${String(index % 60).padStart(2, '0')}:00.000Z` };
  }
  await fs.writeFile(cachePath, JSON.stringify(seed), 'utf8');
  await reviewItems([newsItem(9)], { callModel, cachePath, writeCache: true });

  const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  const keys = Object.keys(saved);
  assert.equal(keys.length, 500, '缓存只留最近 500 条');
  assert.ok(keys.includes(reviewCacheKey(newsItem(9).url)), '本次新判的要在里面');
});

test('批量合并：70 条自动分 2 批（40 + 30），结果按原顺序拼回', async () => {
  const items = Array.from({ length: 70 }, (_, index) => newsItem(index + 1));
  const batchSizes = [];
  const callModel = async (prompt) => {
    const ids = prompt.user.split('\n').filter((line) => line.startsWith('n_')).map((line) => line.split(' | ')[0]);
    batchSizes.push(ids.length);
    // 每批剔掉最后一条（模拟「有 drop 也有 keep」）
    const drop = ids.length > 0 ? [ids[ids.length - 1]] : [];
    const keep = ids.filter((id) => !drop.includes(id));
    return { content: JSON.stringify({ keep, drop, why: {} }) };
  };
  const result = await reviewItems(items, { callModel, cachePath: '' });

  assert.deepEqual(batchSizes, [40, 30], '每批 ≤40（一个请求判不完就自动分批）');
  assert.equal(result.dropped.length, 2, '两批各剔 1 条');
  assert.equal(result.kept.length, 68);
  assert.deepEqual(
    result.kept.map((item) => result.kept.indexOf(item)),
    result.kept.map((_, index) => index),
    '顺序稳定',
  );
  assert.equal(result.kept[0].id, items[0].id, '第一条仍是原始第一条');
  assert.equal(result.enabled, true);
});

test('缓存路径默认落在 %LOCALAPPDATA%\\dsh-study-assistant\\logs（不是第 16 份文档）', () => {
  const file = defaultReviewCachePath();
  assert.ok(file.endsWith(path.join('dsh-study-assistant', 'logs', 'news-review-cache.json')), file);
  assert.ok(!file.includes('学习台'), '缓存不进 学习台/ 数据目录');
});
