// 第 15 份主文档「要闻」的源码级钉子（2026-11-19 B 卡）。
//
// 覆盖四件事：
//   1. 注册面：DOC_KEYS / DOC_FILES / defaultDoc / DOC_SHAPE / validateDoc 的 news-* 拒收理由；
//   2. 归一化：URL 白名单 + 相对链接解析 + 跟踪参数、titles/source/date 的必填与首段 200 字上限；
//   3. 去重与排序：id 由 url 决定，同 url 只有一条，新的在前；
//   4. 保留策略：合并既有 + 14 天/100 条交集 + 丢未来日期，以及「今日」页 7 天窗口。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_KEYS,
  DOC_FILES,
  DOC_VERSION,
  NEWS_CATEGORIES,
  NEWS_EXCERPT_MAX,
  NEWS_RETENTION,
  buildNewsBoard,
  defaultDoc,
  dedupeNews,
  limitNews,
  mergeNews,
  newsExcerptFrom,
  newsIdForUrl,
  normalizeNewsItem,
  normalizeNewsUrl,
  sortNews,
  validateDoc,
} from '../lib/core.js';

// 2026-11-19 是周四 —— 窗口起点用固定时钟，不依赖真实时间
const NOW = new Date(2026, 10, 19, 7, 0);
// 抓取时间存的是 UTC ISO（store 写 updatedAt 也是这个口径），但面板显示要按本机时区，
// 所以「07:00」这条断言用同一个本地 Date 转出来的串，避免测试机器时区不同就红
const FETCHED_AT = NOW.toISOString();

/** 造一条合法条目；默认日期是今天。 */
function item(overrides = {}) {
  const url = overrides.url ?? 'https://www.tsinghua.edu.cn/info/1023/2026.htm';
  return {
    id: newsIdForUrl(url),
    title: '标题',
    url,
    source: '清华新闻',
    publishedAt: '2026-11-19',
    excerpt: '',
    category: 'academic',
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

function newsDoc(items, overrides = {}) {
  return { version: DOC_VERSION, items, fetchedAt: FETCHED_AT, updatedAt: null, ...overrides };
}

test('要闻：已登记为第 15 份文档，默认空壳含 items:[] 且可校验', () => {
  assert.equal(DOC_KEYS.length, 16, 'DOC_KEYS 应为 16 份（v2-B 卡把学习行为追加在最后）');
  assert.equal(DOC_KEYS[DOC_KEYS.length - 2], 'news', '要闻仍是第 15 份，只被学习行为挤到倒数第二');
  assert.equal(DOC_KEYS[DOC_KEYS.length - 3], 'schedule', '日程因此退到倒数第三');
  assert.equal(DOC_FILES.news, '要闻.json');

  const skeleton = defaultDoc('news');
  assert.deepEqual(skeleton, { version: DOC_VERSION, items: [], fetchedAt: null, updatedAt: null });
  assert.deepEqual(validateDoc('news', skeleton), { ok: true });
});

test('要闻：分类白名单与保留策略是卡上定的四个分类 / 14 天 100 条', () => {
  assert.deepEqual(NEWS_CATEGORIES, ['notice', 'academic', 'career', 'competition']);
  assert.deepEqual(NEWS_RETENTION, { days: 14, max: 100 });
  assert.equal(NEWS_EXCERPT_MAX, 200);
});

test('要闻：validateDoc 放行合法文档（每类分类都算合法）', () => {
  const items = NEWS_CATEGORIES.map((category, index) => item({
    url: `https://www.tsinghua.edu.cn/info/1023/2026${index}.htm`,
    category,
    title: `标题 ${index}`,
  }));
  assert.deepEqual(validateDoc('news', newsDoc(items)), { ok: true });
});

test('要闻：validateDoc 拒收坏条目，理由都带 news-* 前缀', () => {
  const cases = [
    ['news-not-an-object', ['不是对象']],
    ['news-bad-id', [item({ id: '带 空格 的 id' })]],
    ['news-duplicate-id', [item(), item({ title: '同 url 同 id，重复' })]],
    ['news-missing-title', [item({ title: '   ' })]],
    ['news-bad-url', [item({ url: 'javascript:alert(1)' })]],
    ['news-bad-url', [item({ url: 'ftp://example.com/a.htm' })]],
    ['news-missing-source', [item({ source: '' })]],
    ['news-bad-date', [item({ publishedAt: '2026-02-31' })]],
    ['news-bad-date', [item({ publishedAt: '11 月 19 日' })]],
    ['news-bad-excerpt', [item({ excerpt: null })]],
    ['news-excerpt-too-long', [item({ excerpt: 'x'.repeat(NEWS_EXCERPT_MAX + 1) })]],
    ['news-bad-category', [item({ category: 'gossip' })]],
    ['news-bad-item-fetched-at', [item({ fetchedAt: '昨天' })]],
  ];
  for (const [reason, items] of cases) {
    assert.equal(validateDoc('news', newsDoc(items)).reason, reason);
  }
  // 顶层 fetchedAt 写了就必须能解析；null 是「还没抓过」，放行
  assert.equal(validateDoc('news', newsDoc([], { fetchedAt: '前天' })).reason, 'news-bad-fetched-at');
  assert.deepEqual(validateDoc('news', newsDoc([], { fetchedAt: null })), { ok: true });
});

test('要闻：normalizeNewsUrl 只放 http/https，相对链接按 base 解析，跟踪参数被去掉', () => {
  assert.equal(normalizeNewsUrl('https://www.tsinghua.edu.cn/a.htm#top'), 'https://www.tsinghua.edu.cn/a.htm');
  assert.equal(
    normalizeNewsUrl('https://mp.weixin.qq.com/s/abc?from=timeline&isappinstalled=0'),
    'https://mp.weixin.qq.com/s/abc',
  );
  // 索引页上的相对链接（清华官网的大宗形态）
  assert.equal(normalizeNewsUrl('../info/1023/2026.htm', 'https://www.tsinghua.edu.cn/news/zxdt.htm'), 'https://www.tsinghua.edu.cn/info/1023/2026.htm');
  assert.equal(normalizeNewsUrl('/info/1023/2026.htm', 'https://www.tsinghua.edu.cn/news/zxdt.htm'), 'https://www.tsinghua.edu.cn/info/1023/2026.htm');
  // 挡住的那些
  assert.equal(normalizeNewsUrl('javascript:alert(1)'), null);
  assert.equal(normalizeNewsUrl('data:text/html,hi'), null);
  assert.equal(normalizeNewsUrl('#anchor'), null);
  assert.equal(normalizeNewsUrl('../info/1.htm'), null, '没有 base 时相对链接解析不了，就该丢');
  assert.equal(normalizeNewsUrl('   '), null);
  assert.equal(normalizeNewsUrl(null), null);
});

test('要闻：normalizeNewsItem 缺任何一项必填都返回 null（不猜、不补）', () => {
  assert.equal(normalizeNewsItem(null), null);
  assert.equal(normalizeNewsItem({ title: '无 url' }), null);
  assert.equal(normalizeNewsItem({ url: 'https://a.cn/x', source: '清华新闻', publishedAt: '2026-11-19' }), null, '缺标题');
  assert.equal(normalizeNewsItem({ url: 'https://a.cn/x', title: 'x', publishedAt: '2026-11-19' }), null, '缺来源');
  assert.equal(normalizeNewsItem({ url: 'https://a.cn/x', title: 'x', source: '清华新闻' }), null, '缺日期');
  assert.equal(normalizeNewsItem({ url: 'https://a.cn/x', title: 'x', source: '清华新闻', publishedAt: '2026/11/19' }), null, '日期格式不对');
  // 缺 base 的相对链接也丢
  assert.equal(normalizeNewsItem({ url: '../info/1.htm', title: 'x', source: '清华新闻', publishedAt: '2026-11-19' }), null);
});

test('要闻：normalizeNewsItem 归一化字段 —— 空白压平、首段 ≤200、分类回落 notice', () => {
  const long = '第一段正文。'.repeat(60);
  const one = normalizeNewsItem({
    title: '  清华  团队  发布  新成果 ',
    url: 'https://www.tsinghua.edu.cn/info/1023/2026.htm#x',
    source: ' 清华新闻 ',
    publishedAt: '2026-11-19',
    excerpt: long,
    category: '不存在',
    fetchedAt: FETCHED_AT,
  });
  assert.equal(one.title, '清华 团队 发布 新成果');
  assert.equal(one.url, 'https://www.tsinghua.edu.cn/info/1023/2026.htm');
  assert.equal(one.source, '清华新闻');
  assert.equal(one.category, 'notice', '不在白名单的分类回落到 notice，而不是原样写进文档');
  assert.ok(one.excerpt.length <= NEWS_EXCERPT_MAX, '首段不能超过 200 字');
  assert.ok(one.excerpt.endsWith('…'), '超长首段要补省略号');
  assert.equal(one.id, newsIdForUrl(one.url));
});

test('要闻：newsExcerptFrom 句末断开优先，断不开就硬截，长度都不超上限', () => {
  assert.equal(newsExcerptFrom('  两句话。  第二句！ ', 200), '两句话。 第二句！');
  assert.equal(newsExcerptFrom('', 200), '');
  assert.equal(newsExcerptFrom(null, 200), '');
  const sentences = '甲乙丙丁。'.repeat(100);
  const cut = newsExcerptFrom(sentences, 20);
  assert.ok(cut.length <= 20);
  assert.ok(cut.endsWith('。…'), '在句号处断开');
  const noMark = 'x'.repeat(500);
  const hard = newsExcerptFrom(noMark, 20);
  assert.equal(hard.length, 20);
  assert.ok(hard.endsWith('…'), '没有句读时硬截并补省略号');
});

test('要闻：id 由 url 决定 —— 同 url 同 id，不同 url 不同 id，改标题不影响 id', () => {
  const id = newsIdForUrl('https://www.tsinghua.edu.cn/info/1023/2026.htm');
  assert.equal(id, newsIdForUrl('  https://www.tsinghua.edu.cn/info/1023/2026.htm  '));
  assert.match(id, /^n_[0-9a-f]{16}$/);
  assert.equal(newsIdForUrl(''), null);
  const other = newsIdForUrl('https://www.tsinghua.edu.cn/info/1023/2027.htm');
  assert.notEqual(id, other);
  const sameUrlNewTitle = normalizeNewsItem({
    title: '改了标题',
    url: 'https://www.tsinghua.edu.cn/info/1023/2026.htm',
    source: '清华新闻',
    publishedAt: '2026-11-19',
  });
  assert.equal(sameUrlNewTitle.id, id);
});

test('要闻：dedupeNews 按 id 留先出现的，sortNews 新的在前、同日按标题稳定', () => {
  const a = item({ url: 'https://a.cn/1', title: 'A', publishedAt: '2026-11-18' });
  const b = item({ url: 'https://a.cn/2', title: 'B', publishedAt: '2026-11-19' });
  const c = item({ url: 'https://a.cn/3', title: 'C', publishedAt: '2026-11-19' });
  const dupA = { ...a, title: 'A 的重复' };
  assert.deepEqual(dedupeNews([a, dupA, b]).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(sortNews([a, c, b]).map((x) => x.title), ['B', 'C', 'A']);

  const sameDay = [
    item({ url: 'https://a.cn/z', title: 'Z', publishedAt: '2026-11-19' }),
    item({ url: 'https://a.cn/a', title: 'A', publishedAt: '2026-11-19' }),
  ];
  // 抓取顺序换了，展示顺序不能跟着跳（否则每天重排像换了一批）
  assert.deepEqual(sortNews(sameDay).map((x) => x.title), ['A', 'Z']);
  assert.deepEqual(sortNews([...sameDay].reverse()).map((x) => x.title), ['A', 'Z']);
});

test('要闻：mergeNews 同 id 以新抓的为准，旧条目不会凭空消失（保留窗口才成立）', () => {
  const old = item({ url: 'https://a.cn/1', title: '旧标题', publishedAt: '2026-11-10', excerpt: '' });
  const keep = item({ url: 'https://a.cn/2', title: '昨天抓到的', publishedAt: '2026-11-18' });
  const fresh = item({ url: 'https://a.cn/1', title: '新标题', publishedAt: '2026-11-10', excerpt: '补上的首段' });
  const merged = mergeNews([old, keep], [fresh]);
  assert.deepEqual(merged.map((x) => x.title), ['昨天抓到的', '新标题'], '新的在前，同 id 用新抓的');
  assert.equal(merged.find((x) => x.id === old.id).excerpt, '补上的首段');
  assert.equal(merged.length, 2, '合并不会重复计数');
});

test('要闻：limitNews 走 14 天 ∩ 100 条的保留策略，未来日期被丢', () => {
  const today = item({ url: 'https://a.cn/today', publishedAt: '2026-11-19' });
  const edge = item({ url: 'https://a.cn/edge', publishedAt: '2026-11-06' }); // 今天往前数第 14 天
  const tooOld = item({ url: 'https://a.cn/old', publishedAt: '2026-11-05' });
  const future = item({ url: 'https://a.cn/future', publishedAt: '2026-11-20' });
  const kept = limitNews([tooOld, today, edge, future], { now: NOW });
  assert.deepEqual(kept.map((x) => x.publishedAt), ['2026-11-19', '2026-11-06']);
  assert.equal(kept.length, 2);

  // 条数上限：给 120 条同日条目，只留前 100 条
  const many = Array.from({ length: 120 }, (_, index) => item({
    url: `https://a.cn/many-${index}`,
    title: `条目 ${String(index).padStart(3, '0')}`,
    publishedAt: '2026-11-19',
  }));
  assert.equal(limitNews(many, { now: NOW }).length, NEWS_RETENTION.max);
});

test('要闻：buildNewsBoard 给「今日」页的是最近 7 天、新的在前、今天几条单独数出来', () => {
  const items = [
    item({ url: 'https://a.cn/today', publishedAt: '2026-11-19' }),
    item({ url: 'https://a.cn/yesterday', publishedAt: '2026-11-18' }),
    item({ url: 'https://a.cn/8days', publishedAt: '2026-11-12' }), // 窗口外（7 天 = 11-13 起）
    item({ url: 'https://a.cn/7days', publishedAt: '2026-11-13' }), // 窗口边缘（含）
    item({ url: 'https://a.cn/old', publishedAt: '2026-10-01' }),
  ];
  const board = buildNewsBoard(newsDoc(items), { days: 7, now: NOW });
  assert.equal(board.days, 7);
  assert.equal(board.windowStart, '2026-11-13');
  assert.equal(board.today, '2026-11-19');
  assert.deepEqual(board.items.map((x) => x.publishedAt), ['2026-11-19', '2026-11-18', '2026-11-13']);
  assert.equal(board.shown, 3);
  assert.equal(board.todayCount, 1);
  assert.equal(board.total, 5, 'total 是库里全部条数，不受展示窗口影响');
  assert.equal(board.fetchedClock, '07:00', '抓取时间按本机时区取 HH:mm');
});

test('要闻：buildNewsBoard 空文档也要能出骨架（面板据此写空态）', () => {
  const skeleton = defaultDoc('news');
  const board = buildNewsBoard(skeleton, { now: NOW });
  assert.deepEqual(board.items, []);
  assert.equal(board.shown, 0);
  assert.equal(board.total, 0);
  assert.equal(board.todayCount, 0);
  assert.equal(board.fetchedAt, null);
  assert.equal(board.fetchedClock, null);
});
