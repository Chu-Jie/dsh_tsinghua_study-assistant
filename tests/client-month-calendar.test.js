/**
 * 「本月日程」月历的纯函数测试（2026-11-25）。
 * 运行：npm test（node --test tests/*.test.js）
 *
 * 用户口径：「一个日历，每一个日期下方如果有除了上课以外的安排，就用不同颜色的框写明具体内容」。
 * 这里钉住六件事：
 *   1. 网格排版固定 7 的整数倍、周一开头、前后补到上/下月并标 `inMonth:false`；
 *   2. **课程永远不进格子**（只收日程与未完成任务的 DDL）；
 *   3. 日程按四分类着色、DDL 用独立的 chip-ddl 色；坏分类兜底学习；
 *   4. 同一天里日程在 DDL 前面，各自按时间排；
 *   5. 「今天」只标一格（按 `now` 的日期，不是时区漂移后的日期）；
 *   6. `month` 传 0/13 这种越界值要被夹到 1/12，坏日期条目丢掉不抛。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const CLIENT_FILE = path.join(HERE, '..', 'client.js');

/** 最小 localStorage（月历是纯函数，不需要真存储，但 client.js 顶层会碰它）。 */
function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => store.clear(),
  };
}

/** 在最小浏览器假环境里执行 client.js，只取 internals（同 schedule-classify.test.js 的加载器）。 */
function loadInternals() {
  const context = {
    window: { localStorage: memoryStorage() },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    document: {
      head: { appendChild: (node) => node, removeChild: (node) => node },
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), attributes: {}, isConnected: false, setAttribute(k, v) { this.attributes[k] = v; }, textContent: '' }),
      querySelector: () => null,
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, docs: {} }) }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      assert.equal(registration.id, 'dsh-study-assistant', '模块 id 必须等于包名');
      const fakeReact = {
        createElement(type, props, ...children) {
          const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
          return { __el: true, type, props: { ...(props ?? {}), children: flat }, children: flat };
        },
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect() {},
        useMemo: (factory) => factory(),
        useRef: (value) => ({ current: value }),
        useCallback: (fn) => fn,
        Component: class Component { constructor(props) { this.props = props ?? {}; this.state = {}; } },
      };
      context.__exports = registration.factory((specifier) => {
        assert.equal(specifier, 'react', `客户端只允许 require('react')，实际请求了 ${specifier}`);
        return fakeReact;
      });
    },
  };
  vm.runInNewContext(fs.readFileSync(CLIENT_FILE, 'utf8'), context, { filename: CLIENT_FILE });
  return context.__exports.DESCRIPTORS.internals;
}

// 2026-11-19 是周四；11 月 1 日是周日 ⇒ 周一开头时前面要补 6 格（10-26 起）。
const NOW = new Date('2026-11-19T09:00:00+08:00');

function flatten(grid) {
  return grid.weeks.reduce((all, week) => all.concat(week), []);
}

test('网格排版：35 或 42 格、周一开头、首格补到上个月、末格补到下个月', () => {
  const internals = loadInternals();
  assert.equal(typeof internals.buildMonthGrid, 'function', 'client 必须把 buildMonthGrid 交给测试');
  const grid = internals.buildMonthGrid({ year: 2026, month: 11, now: NOW });

  assert.equal(grid.title, '2026年11月');
  assert.deepEqual(Array.from(grid.weekdayLabels), ['一', '二', '三', '四', '五', '六', '日'], '国内习惯：周一开头');
  assert.equal(grid.weeks.length, 6, '11 月要补 6 格 ⇒ 42 格 = 6 行');
  for (const week of grid.weeks) assert.equal(week.length, 7, '每一行必须正好 7 格');

  const cells = flatten(grid);
  assert.equal(cells[0].key, '2026-10-26', '首格是上个月最后一个完整周里的周一');
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[41].key, '2026-12-06', '末格补到 12 月 6 日');
  assert.equal(cells[41].inMonth, false);
  assert.equal(cells.filter((cell) => cell.inMonth).length, 30, '11 月是 30 天');

  // 2 月这种整月正好 4 周的情况只能是 35 格，不能多出一行空格子
  const feb = internals.buildMonthGrid({ year: 2027, month: 2, now: NOW });
  assert.equal(feb.weeks.length, 4, '2027-02-01 是周一 ⇒ 28 天正好 4 行');
  assert.equal(flatten(feb).length, 28, '不多补一行空格子');
});

test('只收「除上课以外的安排」：日程 + 未完成 DDL，课程不入格', () => {
  const internals = loadInternals();
  const grid = internals.buildMonthGrid({
    year: 2026,
    month: 11,
    now: NOW,
    entries: [
      { id: 'e1', title: '看数电知识点', date: '2026-11-26', time: '09:00', endTime: '11:00', category: 'study' },
    ],
    tasks: [
      { id: 't1', title: '交数据结构作业', due: '2026-11-26 23:59' },
    ],
    // 故意塞一个「课程」形状的对象：它不该被认成条目（课程根本不走这个函数）
    courses: [{ id: 'c1', title: '数字电路', weekday: 4 }],
  });
  const day = flatten(grid).find((cell) => cell.key === '2026-11-26');
  assert.deepEqual(Array.from(day.items, (item) => item.kind), ['entry', 'ddl'], '同一天：日程在前、DDL 在后，课程不出现');
  assert.equal(grid.itemCount, 2, 'itemCount 只算本月格子里的安排');
});

test('着色：四分类各一色，坏分类兜底学习，DDL 用 chip-ddl', () => {
  const internals = loadInternals();
  const grid = internals.buildMonthGrid({
    year: 2026,
    month: 11,
    now: NOW,
    entries: [
      // 带上时间是为了让顺序唯一确定（全是「全天」时按标题排，断言会跟着文案走）
      { id: 'a', title: '复习数电', date: '2026-11-05', time: '08:00', category: 'study' },
      { id: 'b', title: '挑战杯路演', date: '2026-11-05', time: '09:00', category: 'innovation' },
      { id: 'c', title: '聚餐', date: '2026-11-05', time: '10:00', category: 'life' },
      { id: 'd', title: '实习面试', date: '2026-11-05', time: '11:00', category: 'work' },
      { id: 'e', title: '分类写坏的条目', date: '2026-11-05', time: '12:00', category: 'nope' },
    ],
    tasks: [{ id: 't', title: '交作业', due: '2026-11-05 23:59' }],
  });
  const day = flatten(grid).find((cell) => cell.key === '2026-11-05');
  assert.deepEqual(Array.from(day.items, (item) => item.tone), ['cat-study', 'cat-innovation', 'cat-life', 'cat-work', 'cat-study', 'chip-ddl']);
  assert.equal(day.items[5].timeLabel, '23:59 截止', 'DDL 的时间标签要写清是截止时间');
});

test('同一天内排序：按时间升序，没填时间的是「全天」排最前', () => {
  const internals = loadInternals();
  const grid = internals.buildMonthGrid({
    year: 2026,
    month: 11,
    now: NOW,
    entries: [
      { id: 'late', title: '晚上开会', date: '2026-11-10', time: '20:00' },
      { id: 'all', title: '全天的事', date: '2026-11-10', time: null },
      { id: 'noon', title: '中午吃饭', date: '2026-11-10', time: '12:00', endTime: '13:00' },
    ],
  });
  const day = flatten(grid).find((cell) => cell.key === '2026-11-10');
  assert.deepEqual(Array.from(day.items, (item) => item.id), ['all', 'noon', 'late']);
  assert.equal(day.items[1].timeLabel, '12:00–13:00', '有结束时间就写成时间段');
  assert.equal(day.items[0].timeLabel, '全天');
});

test('今天标记：只标 now 那一天，跨月补格里一个都不标', () => {
  const internals = loadInternals();
  const grid = internals.buildMonthGrid({ year: 2026, month: 11, now: NOW });
  const todays = flatten(grid).filter((cell) => cell.isToday);
  assert.equal(todays.length, 1);
  assert.equal(todays[0].key, '2026-11-19');

  // 换到 12 月：11 月的今天不在网格里（补格里有 11-30 也不会被标成今天）
  const dec = internals.buildMonthGrid({ year: 2026, month: 12, now: NOW });
  assert.equal(flatten(dec).filter((cell) => cell.isToday).length, 0);
});

test('越界与坏数据：month 夹到 1–12，坏日期条目丢掉，缺参数不抛', () => {
  const internals = loadInternals();
  assert.equal(internals.buildMonthGrid({ year: 2026, month: 0, now: NOW }).month, 1);
  assert.equal(internals.buildMonthGrid({ year: 2026, month: 13, now: NOW }).month, 12);
  assert.equal(internals.buildMonthGrid({ year: 2026, month: 12, now: NOW }).title, '2026年12月');

  const grid = internals.buildMonthGrid({
    year: 2026,
    month: 11,
    now: NOW,
    entries: [{ id: 'bad', title: '日期是坏的', date: '不是日期' }, null, { title: '没日期' }],
    tasks: [{ id: 't', title: '截止时间写坏', due: '下周一' }],
  });
  assert.equal(grid.itemCount, 0, '坏日期一律不入格');
  assert.doesNotThrow(() => internals.buildMonthGrid());
  assert.doesNotThrow(() => internals.buildMonthGrid(null));
  // 缺省用 now 的年月
  const fallback = internals.buildMonthGrid({ now: NOW });
  assert.equal(fallback.title, '2026年11月');
});

test('跨年翻月：12 月 → 次年 1 月，两个网格各算各的条目，不串月', () => {
  const internals = loadInternals();
  const entries = [
    { id: 'e-1231', title: '跨年夜', date: '2026-12-31', time: '20:00', category: 'life' },
  ];
  const tasks = [
    { id: 't-0101', title: '元旦交作业', due: '2027-01-01 09:00' },
  ];

  const dec = internals.buildMonthGrid({ year: 2026, month: 12, now: NOW, entries, tasks });
  assert.equal(dec.title, '2026年12月');
  assert.equal(dec.itemCount, 1, '12 月的 1 条只算 12-31 的日程，1 月 1 日的 DDL 不算本月');
  const decFlat = flatten(dec);
  assert.equal(decFlat[0].key, '2026-11-30', '2026-12-01 是周二 ⇒ 前面补 1 格到上个周的周一');
  assert.equal(decFlat[0].inMonth, false);
  assert.equal(flatten(dec).filter((cell) => cell.inMonth).length, 31);
  // 末格补到次年：补格里允许带条目，但 inMonth:false、不计入 itemCount（渲染时半透明）
  const spill = decFlat.find((cell) => cell.key === '2027-01-01');
  assert.equal(spill.inMonth, false);
  assert.deepEqual(Array.from(spill.items, (item) => item.id), ['t-0101']);

  const jan = internals.buildMonthGrid({ year: 2027, month: 1, now: NOW, entries, tasks });
  assert.equal(jan.title, '2027年1月');
  assert.equal(jan.weeks.length, 5, '2027-01-01 是周五 ⇒ 补 4 格、31 天 ⇒ 5 行 35 格');
  assert.equal(flatten(jan)[0].key, '2026-12-28', '首格回到上个年度的最后一周周一');
  assert.equal(flatten(jan)[0].inMonth, false);
  assert.equal(jan.itemCount, 1, '1 月只算 1 月 1 日那条 DDL');
  const janDay = flatten(jan).find((cell) => cell.key === '2027-01-01');
  assert.equal(janDay.inMonth, true);
  assert.equal(janDay.items[0].timeLabel, '09:00 截止', 'DDL 带具体时刻时按时刻显示，不硬写成 23:59');
});

test('一天超过 5 条：格子里数据全保留（渲染取前 5 条 + 「还有 N 条」）', () => {
  const internals = loadInternals();
  assert.equal(internals.MONTH_CAL_CHIP_LIMIT, 5, '一格最多摆 5 条（2026-11-25 用户要求从 3 提到 5）');
  const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `m${n}`, title: `第${n}件事`, date: '2026-11-12', time: `${String(8 + n).padStart(2, '0')}:00`, category: 'study',
  }));
  const grid = internals.buildMonthGrid({ year: 2026, month: 11, now: NOW, entries: many });
  const day = flatten(grid).find((cell) => cell.key === '2026-11-12');
  assert.equal(day.items.length, 7, '纯函数不截断：7 条都在，详情面板要能列全');
  assert.equal(grid.itemCount, 7);

  // 截断只发生在渲染层：确认卡里是按常量切片 + 「还有 N 条」，别哪天被改回「只显示几条、其余丢掉」
  const source = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
  assert.ok(source.includes('cell.items.slice(0, MONTH_CAL_CHIP_LIMIT)'), '渲染只摆前 N 条（N 取常量）');
  assert.ok(source.includes('还有 ${cell.items.length - MONTH_CAL_CHIP_LIMIT} 条'), '超出部分要写明「还有 N 条」');
});

test('DDL 带科目：subjectName 落到 item.subject，日程留空，色块文字写成「科目 · 标题」', () => {
  const internals = loadInternals();
  const grid = internals.buildMonthGrid({
    year: 2026,
    month: 11,
    now: NOW,
    entries: [{ id: 'e1', title: '看数电知识点', date: '2026-11-26', time: '09:00', category: 'study' }],
    tasks: [
      { id: 't1', title: '数电第 11 次作业', due: '2026-11-26 23:59', subjectName: '数字电子技术基础' },
      { id: 't2', title: '没挂科目的任务', due: '2026-11-27' },
    ],
  });
  const d26 = flatten(grid).find((cell) => cell.key === '2026-11-26');
  const ddl = d26.items.find((item) => item.kind === 'ddl');
  assert.equal(ddl.subject, '数字电子技术基础', 'DDL 的科目要跟着一起进格子');
  assert.equal(d26.items.find((item) => item.kind === 'entry').subject, '', '日程没有科目，留空串');

  // 网格里靠 courseIndex 现算的 courseId → 课名链路由 TodayTab 负责；纯函数只认 `subjectName`。
  const d27 = flatten(grid).find((cell) => cell.key === '2026-11-27');
  assert.equal(d27.items[0].subject, '', '没挂科目的 DDL 不能写成「undefined · 标题」');

  // 色块文字：科目在标题前，中间用「·」；没有科目就只有标题；科目全是空白当作没有。
  assert.equal(internals.monthChipText({ subject: '数字电子技术基础', title: '数电第 11 次作业' }),
    '数字电子技术基础 · 数电第 11 次作业');
  assert.equal(internals.monthChipText({ title: '看数电知识点' }), '看数电知识点');
  assert.equal(internals.monthChipText({ subject: '   ', title: '看数电知识点' }), '看数电知识点');
});