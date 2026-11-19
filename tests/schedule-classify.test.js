/**
 * 「今日日程」四分类的纯函数测试（2026-11-19 A2 卡）。
 * 运行：npm test（node --test tests/*.test.js）
 *
 * 钉住四件事：
 *   1. 关键词判类的**顺序**（科创 → 生活 → 工作 → 兜底学习）与兜底；
 *   2. 课程 / DDL 的本地覆盖表（localStorage）优先于关键词，且坏值自愈；
 *   3. `buildScheduleBoard` 把三类来源摊成 4 个版块时的**缺省与兼容**：
 *      旧版 `日程.json`（没有 category / endTime / location / source）必须照样渲染成
 *      「工作其他 + 全天」而不是崩、不是空行；
 *   4. 失败文案不含密钥。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { validateDoc } from '../lib/core.js';

const HERE = import.meta.dirname;
const CLIENT_FILE = path.join(HERE, '..', 'client.js');

/** 最小 localStorage（每次 load 一份全新内存表）。 */
function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => store.clear(),
    get size() { return store.size; },
  };
}

/**
 * 在最小浏览器假环境里执行 client.js，只取 internals。
 *
 * 不调 `half.apply(ctx)`：这些用例全是纯函数，不需要槽位注册；少一层假 ctx 就少一处
 * 「测试替身写错导致的假绿」。
 */
function loadInternals(options = {}) {
  const localStorage = options.localStorage ?? memoryStorage();
  const context = {
    window: { localStorage },
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

const FIXED_NOW = new Date('2026-11-19T09:00:00+08:00');

test('classifyByKeyword：科创 / 生活 / 工作命中，其余兜底学习', () => {
  const internals = loadInternals();
  const classify = internals.classifyByKeyword;
  assert.equal(typeof classify, 'function', 'client 必须把 classifyByKeyword 交给测试');

  // 科创关键词（用户 2026-11-19 定案的那份）
  for (const text of ['挑战杯初赛材料', '大创中期检查', '论文二稿', '星火计划路演', '答辩预演']) {
    assert.equal(classify(text), 'innovation', `「${text}」应判科创`);
  }
  // 生活
  for (const text of ['社团例会', '周末聚餐', '健身私教课', '生日会', '看电影']) {
    assert.equal(classify(text), 'life', `「${text}」应判生活`);
  }
  // 工作其他
  for (const text of ['实习面试', '招聘宣讲会', '小组会议', '兼职排班']) {
    assert.equal(classify(text), 'work', `「${text}」应判工作其他`);
  }
  // 学习是兜底：课程 / 作业 / 复习 / 考试，以及完全没关键词的标题
  for (const text of ['数字电路第 5 章复习', '交实验报告', '期中考试', '随便写点什么']) {
    assert.equal(classify(text), 'study', `「${text}」应兜底学习`);
  }
  // 顺序钉死：同时命中两组关键词时，科创先于学习（学习没有自己的关键词表，只做兜底）
  assert.equal(classify('课程设计比赛'), 'innovation', '「比赛」优先级高于兜底的「学习」');
  assert.equal(classify(''), 'study', '空标题兜底学习');
  assert.equal(classify(null), 'study', 'null 也要兜底，不能抛');
});

test('分类覆盖表：localStorage 只认四个分类，坏值读时自愈、写时删除', () => {
  const internals = loadInternals();
  const seeded = loadInternals({ localStorage: memoryStorage({
    [internals.SCHEDULE_OVERRIDE_STORAGE_KEY]: JSON.stringify({ 'course:c1': 'life', 'ddl:d1': 'study', 'course:c2': 'unknown', bad: 1 }),
  }) });
  const overrides = seeded.readCategoryOverrides();
  assert.deepEqual({ ...overrides }, { 'course:c1': 'life', 'ddl:d1': 'study' }, '非法分类与非法键必须被过滤');

  // 写一条合法的 → 读得到；写一条非法 → 该键被删掉（等价于「恢复自动判断」）
  const storage = memoryStorage();
  internals.writeCategoryOverride(storage, 'course:c3', 'innovation');
  assert.equal(internals.readCategoryOverrides(storage)['course:c3'], 'innovation');
  internals.writeCategoryOverride(storage, 'course:c3', 'nope');
  assert.equal(internals.readCategoryOverrides(storage)['course:c3'], undefined, '非法值应删除该键');

  // 存储被禁用（getItem 抛错）时不能把整页拖崩
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual({ ...seeded.readCategoryOverrides(broken) }, {});
});

test('buildScheduleBoard：旧版日程条目（无新字段）不崩、缺省「工作其他 + 全天」', () => {
  const internals = loadInternals();
  const board = internals.buildScheduleBoard({
    courses: [],
    tasks: [],
    // 2026-11-19 A 卡的旧形状：只有 id/title/date/time/note/createAt
    entries: [
      { id: 'old_1', title: '去三教交纸质作业', date: '2026-11-19', time: null, note: '下午五点前', createdAt: '2026-11-19T07:00:00Z' },
      { id: 'old_2', title: '组会', date: '2026-11-19', time: '14:00', note: '', createdAt: '2026-11-19T07:00:00Z' },
    ],
    overrides: {},
    now: FIXED_NOW,
  });

  assert.equal(board.blocks.length, 4, '永远是 4 个版块');
  assert.deepEqual([...board.blocks.map((block) => block.category)], ['study', 'innovation', 'life', 'work']);
  const work = board.blocks.find((block) => block.category === 'work');
  assert.equal(work.rows.length, 2, '旧条目缺省进「工作其他」');
  const allDay = work.rows.find((row) => row.title === '去三教交纸质作业');
  assert.equal(allDay.timeLabel, '全天', 'time 为 null 时显示「全天」');
  assert.equal(board.total, 2);
});

test('buildScheduleBoard：新字段生效、起止时间与排序（有时间在前、全天最后）', () => {
  const internals = loadInternals();
  const board = internals.buildScheduleBoard({
    courses: [],
    tasks: [],
    entries: [
      { id: 'e_late', title: '晚课复习', date: '2026-11-19', time: '20:00', endTime: '21:30', category: 'study', location: '图书馆', source: 'manual' },
      { id: 'e_early', title: '小组会', date: '2026-11-19', time: '09:30', endTime: '11:00', category: 'work', location: '六教 3204', source: 'auto-ai' },
      { id: 'e_noon', title: '全天报名', date: '2026-11-19', time: null, endTime: null, category: 'innovation', source: 'manual' },
    ],
    overrides: {},
    now: FIXED_NOW,
  });

  const study = board.blocks.find((block) => block.category === 'study');
  assert.equal(study.rows[0].timeLabel, '20:00–21:30', '起止时间用 – 连起来');
  const innovation = board.blocks.find((block) => block.category === 'innovation');
  assert.equal(innovation.rows[0].timeLabel, '全天');
  const work = board.blocks.find((block) => block.category === 'work');
  assert.equal(work.rows[0].detail.source, 'auto-ai', '来源字段要透到详情');
  assert.equal(work.rows[0].detail.location, '六教 3204');

  // 同一版块内的时间排序
  const mixed = internals.buildScheduleBoard({
    courses: [],
    tasks: [],
    entries: [
      { id: 'a', title: '下午', date: '2026-11-19', time: '15:00', category: 'study' },
      { id: 'b', title: '上午', date: '2026-11-19', time: '09:00', category: 'study' },
      { id: 'c', title: '全天', date: '2026-11-19', time: null, category: 'study' },
    ],
    overrides: {},
    now: FIXED_NOW,
  });
  const rows = mixed.blocks.find((block) => block.category === 'study').rows;
  assert.deepEqual([...rows.map((row) => row.title)], ['上午', '下午', '全天'], '按开始时间升序，全天排最后');
});

test('buildScheduleBoard：覆盖表优先于关键词，课程 / DDL 都不写回数据', () => {
  const internals = loadInternals();
  const board = internals.buildScheduleBoard({
    courses: [
      { course: { id: 'c1', name: '数字电路实验', teacher: '张老师' }, session: { weekday: 4, startPeriod: 5, endPeriod: 6, weeks: '1-16', location: '三教 3306' } },
      { course: { id: 'c2', name: '挑战杯项目讨论' }, session: { weekday: 4, startPeriod: 9, endPeriod: 9, weeks: '1-16' } },
    ],
    tasks: [
      { id: 't1', title: '交实验报告', due: '2026-11-19 23:59', courseId: 'c1', subjectName: '数字电路实验' },
    ],
    entries: [],
    // 用户把「数字电路实验」手动改成「学习」，把 t1 改成「生活」
    overrides: { 'course:c1': 'study', 'ddl:t1': 'life' },
    now: FIXED_NOW,
  });
  const byId = {};
  for (const block of board.blocks) for (const row of block.rows) byId[row.key] = row;
  assert.equal(byId['course:c1'].category, 'study', '覆盖表优先于关键词（含「实验」的课本来兜底学习，这里靠覆盖钉住）');
  assert.equal(byId['ddl:t1'].category, 'life', 'DDL 的覆盖优先于「实验」等关键词');
  // 没有覆盖的课程按关键词走：挑战杯 → 科创
  assert.equal(byId['course:c2'].category, 'innovation');
  // 课程行显示节次、科目进详情
  assert.equal(byId['course:c1'].timeLabel, '第 5-6 节');
  assert.ok(byId['ddl:t1'].detail.lines.some((line) => line.startsWith('科目：数字电路实验')));
});

test('buildScheduleBoard：空输入 / 坏条目一律不抛，仍返回 4 个空版块', () => {
  const internals = loadInternals();
  for (const input of [undefined, {}, { entries: [null, {}, { id: 1, title: 2 }], courses: [null], tasks: [null, { title: 'x' }] }]) {
    const board = internals.buildScheduleBoard(input);
    assert.equal(board.blocks.length, 4);
    assert.equal(board.total, 0);
  }
});

test('validateDoc：旧格式日程文档（条目无新字段）照常通过，坏新字段被拒', () => {
  // 旧版 日程.json：条目只有 id/title/date/time/note/createdAt/updatedAt。
  // 这是用户磁盘上真实存在的那份形状 —— 校验层不能因为「多了四个字段」就把它判成损坏。
  const legacy = {
    version: 1,
    entries: [
      { id: 's_1', title: '旧条目', date: '2026-11-19', time: '09:30', note: '三教', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z' },
      { id: 's_2', title: '旧的全天条目', date: '2026-11-19', time: null, note: '', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z' },
    ],
    updatedAt: '2026-11-18T00:00:00.000Z',
  };
  const checked = validateDoc('schedule', legacy);
  assert.equal(checked.ok, true, '旧格式必须原样通过');

  // 新字段齐全的也通过
  const modern = {
    ...legacy,
    entries: [{
      id: 's_3', title: '新条目', date: '2026-11-19', time: '15:00', endTime: '16:30',
      note: '', location: '六教 3204', category: 'innovation', source: 'auto-ai',
      createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
    }],
  };
  assert.equal(validateDoc('schedule', modern).ok, true);

  // 每个新字段都有对应的拒写理由，且不影响别的字段
  const bad = [
    [{ category: 'hobby' }, 'schedule-bad-category'],
    [{ source: 'robot' }, 'schedule-bad-source'],
    [{ endTime: '9:30' }, 'schedule-bad-end-time'],
    [{ location: 42 }, 'schedule-bad-location'],
  ];
  for (const [patch, reason] of bad) {
    const doc = { ...legacy, entries: [{ ...legacy.entries[0], ...patch }] };
    const result = validateDoc('schedule', doc);
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 应被拒`);
    assert.equal(result.reason, reason);
  }
});

test('aiFailureText：只提示去哪读密钥，绝不把密钥本身拼进界面', () => {
  const internals = loadInternals();
  const text = internals.aiFailureText({ ok: false, error: 'ai-key-missing', detail: '' });
  assert.match(text, /\.dsh/, '要告诉用户去哪找密钥');
  assert.match(text, /refs\.PARATERA_API_KEY/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]/, '失败文案里不能出现像密钥的串');
  assert.match(internals.aiFailureText({ ok: false, error: 'ai-bad-title', detail: '' }), /手动填/);
  assert.match(internals.aiFailureText({ ok: false, error: 'ai-timeout', detail: 'HTTP 429' }), /429/);
});
