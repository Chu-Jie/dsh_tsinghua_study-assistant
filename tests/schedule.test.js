// 第 14 份主文档「日程」+「今日日程」纯函数（2026-11-19 A 卡）的源码级钉子。
//
// 覆盖三件事：
//   1. 注册面：DOC_KEYS / DOC_FILES / defaultDoc / DOC_SHAPE / validateDoc；
//   2. buildDailyBrief：今日课程、今日自定义日程（全天排最后）、今日 DDL（逾期在前、已完结剔除）；
//   3. formatDailyBrief：一段可直发微信/QQ 的纯文本，含空态文案与超量截断。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_KEYS,
  DOC_FILES,
  DOC_VERSION,
  defaultDoc,
  buildDailyBrief,
  formatDailyBrief,
  validateDoc,
} from '../lib/core.js';

// 2026-11-19 是周四；本学期第 1 教学周的周一设为 2026-11-16
const NOW = new Date(2026, 10, 19, 10, 0);

function doc(overrides = {}) {
  return {
    term: { version: 1, terms: [{ id: 't1', name: '2026 秋', startDate: '2026-11-16', totalWeeks: 16 }], currentId: 't1', updatedAt: null },
    courses: {
      version: 1,
      courses: [{
        id: 'c1',
        name: '高等数学',
        sessions: [{ weekday: 4, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: '六教 6A101' }],
      }],
      updatedAt: null,
    },
    tasks: {
      version: 1,
      tasks: [
        { id: 't_over', title: '逾期作业', due: '2026-11-16', status: 'todo', courseId: 'c1' },
        { id: 't_today', title: '今天作业', due: '2026-11-19 23:59', status: 'todo' },
        { id: 't_done', title: '已完成', due: '2026-11-19', status: 'done' },
        { id: 't_none', title: '无截止', due: null, status: 'todo' },
        { id: 't_later', title: '下周交', due: '2026-11-26', status: 'todo' },
      ],
      updatedAt: null,
    },
    schedule: {
      version: 1,
      entries: [
        { id: 's_eve', title: '晚上复盘', date: '2026-11-19', time: '21:00', note: '', createdAt: 'x', updatedAt: 'x' },
        { id: 's_morning', title: '交实验报告', date: '2026-11-19', time: '09:30', note: '三教', createdAt: 'x', updatedAt: 'x' },
        { id: 's_all', title: '取快递', date: '2026-11-19', time: null, note: '', createdAt: 'x', updatedAt: 'x' },
        { id: 's_old', title: '昨天的会', date: '2026-11-18', time: '15:00', note: '', createdAt: 'x', updatedAt: 'x' },
      ],
      updatedAt: null,
    },
    ...overrides,
  };
}

test('日程：已登记为第 14 份文档，默认空壳含 entries:[]', () => {
  assert.equal(DOC_KEYS.length, 16, 'DOC_KEYS 应为 16 份（要闻是第 15 份、学习行为是第 16 份）');
  assert.equal(DOC_KEYS[DOC_KEYS.length - 3], 'schedule', '日程退到倒数第三（后面是要闻与学习行为）');
  assert.equal(DOC_KEYS[DOC_KEYS.length - 2], 'news', '要闻是第 15 份（2026-11-19 B 卡）');
  assert.equal(DOC_FILES.schedule, '日程.json');

  const skeleton = defaultDoc('schedule');
  assert.deepEqual(skeleton, { version: DOC_VERSION, entries: [], updatedAt: null });
  assert.deepEqual(validateDoc('schedule', skeleton), { ok: true });
});

test('日程：validateDoc 放行合法条目（时间为 null 的「全天」也算合法）', () => {
  const valid = {
    version: DOC_VERSION,
    updatedAt: '2026-11-19T00:00:00.000Z',
    entries: [
      { id: 's_1', title: '交实验报告', date: '2026-11-19', time: '09:30', note: '三教', createdAt: 'a', updatedAt: 'b' },
      { id: 's_2', title: '取快递', date: '2026-11-19', time: null, createdAt: 'a', updatedAt: 'b' },
    ],
  };
  assert.deepEqual(validateDoc('schedule', valid), { ok: true });
});

test('日程：validateDoc 逐条拒绝坏条目（坏一条就整份不写）', () => {
  const base = { version: DOC_VERSION, updatedAt: null, entries: [] };
  const withEntry = (entry) => ({ ...base, entries: [entry] });
  const good = { id: 's_1', title: '标题', date: '2026-11-19', time: '09:30', createdAt: 'a', updatedAt: 'b' };

  assert.equal(validateDoc('schedule', { ...base, entries: [] }).ok, true);
  assert.equal(validateDoc('schedule', { ...base, entries: 'oops' }).ok, false);
  assert.equal(validateDoc('schedule', withEntry({ ...good, id: 'bad id!' })).reason, 'schedule-bad-id');
  assert.equal(validateDoc('schedule', withEntry({ ...good, title: '   ' })).reason, 'schedule-missing-title');
  assert.equal(validateDoc('schedule', withEntry({ ...good, date: '2026-02-31' })).reason, 'schedule-bad-date');
  assert.equal(validateDoc('schedule', withEntry({ ...good, date: '11-19' })).reason, 'schedule-bad-date');
  assert.equal(validateDoc('schedule', withEntry({ ...good, time: '24:00' })).reason, 'schedule-bad-time');
  assert.equal(validateDoc('schedule', withEntry({ ...good, time: '9:5' })).reason, 'schedule-bad-time');
  assert.equal(validateDoc('schedule', withEntry({ ...good, note: 1 })).reason, 'schedule-bad-note');
  assert.equal(validateDoc('schedule', withEntry({ ...good, createdAt: undefined })).reason, 'schedule-bad-createdAt');
  assert.equal(validateDoc('schedule', withEntry(null)).reason, 'schedule-not-an-object');
  assert.equal(validateDoc('schedule', {
    ...base, entries: [good, { ...good }],
  }).reason, 'schedule-duplicate-id');
});

test('buildDailyBrief：今日课程 / 今日日程 / 今日 DDL 三块各按自己的口径算', () => {
  const brief = buildDailyBrief(doc(), NOW);

  assert.equal(brief.date, '2026-11-19');
  assert.equal(brief.weekday, 4);
  assert.equal(brief.weekdayName, '周四');
  assert.equal(brief.inTerm, true);
  assert.equal(brief.week, 1);

  assert.equal(brief.courses.length, 1, '周四第 1-2 节的课应当出现');
  assert.equal(brief.courses[0].name, '高等数学');
  assert.equal(brief.courses[0].location, '六教 6A101');
  assert.equal(brief.courses[0].startPeriod, 1);
  assert.equal(brief.courses[0].endPeriod, 2);

  assert.deepEqual(brief.entries.map((e) => e.id), ['s_morning', 's_eve', 's_all'], '按时间升序，全天排最后；昨天的不进');
  assert.equal(brief.entries[0].note, '三教');

  assert.deepEqual(brief.ddl.overdue.map((d) => d.id), ['t_over'], '逾期单独一组');
  assert.deepEqual(brief.ddl.today.map((d) => d.id), ['t_today'], '今天到期的单独一组');
  assert.equal(brief.ddl.total, 2, '已完成 / 下周 / 无截止都不算今日 DDL');
});

test('buildDailyBrief：放假或没课时不编课，坏条目不会混进来', () => {
  const outOfTerm = buildDailyBrief(doc({
    term: { version: 1, terms: [{ id: 't1', name: '2026 秋', startDate: '2026-09-07', totalWeeks: 10 }], currentId: 't1', updatedAt: null },
  }), NOW);
  assert.equal(outOfTerm.inTerm, false);
  assert.deepEqual(outOfTerm.courses, [], '不在教学周内就不该算出课');

  const dirty = buildDailyBrief(doc({
    schedule: { version: 1, entries: [null, { id: 's_x', title: '坏日期', date: 'oops', time: '09:00' }, 42], updatedAt: null },
  }), NOW);
  assert.deepEqual(dirty.entries, [], '读入面也要挡掉坏条目，别把 undefined 渲染成一行');
});

test('formatDailyBrief：纯文本三段 + 空态文案', () => {
  const text = formatDailyBrief(buildDailyBrief(doc(), NOW));
  assert.match(text, /^【今日日程 · 11\/19 周四 · 第 1 周】/);
  assert.match(text, /■ 今日课程/);
  assert.match(text, /1\. 高等数学　第 1-2 节 · 六教 6A101/);
  assert.match(text, /■ 自定义日程/);
  assert.match(text, /09:30　交实验报告（三教）/);
  assert.match(text, /全天　取快递/);
  assert.match(text, /■ 今日 DDL/);
  assert.match(text, /\[逾期 3 天\] 逾期作业（截止 2026-11-16）/);
  assert.match(text, /\[今天 23:59\] 今天作业（截止 2026-11-19 23:59）/);
  assert.ok(!text.includes('昨天的会'), '非今日条目不该进推送');

  const empty = formatDailyBrief(buildDailyBrief({
    term: { version: 1, terms: [{ id: 't1', name: '2026 秋', startDate: '2026-11-16', totalWeeks: 16 }], currentId: 't1' },
    courses: { version: 1, courses: [], updatedAt: null },
    tasks: { version: 1, tasks: [], updatedAt: null },
    schedule: { version: 1, entries: [], updatedAt: null },
  }, NOW));
  assert.match(empty, /今天没有课。/);
  assert.match(empty, /今天没有自定义日程。/);
  assert.match(empty, /今天没有到期或逾期的 DDL。/);
});

test('formatDailyBrief：超量时给出「还有 N 条」而不是静默截断', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `s_${i}`, title: `事项 ${i}`, date: '2026-11-19', time: `${String(i + 8).padStart(2, '0')}:00`, createdAt: 'a', updatedAt: 'b',
  }));
  const text = formatDailyBrief(buildDailyBrief(doc({ schedule: { version: 1, entries: many, updatedAt: null } }), NOW), { maxEntries: 5 });
  assert.match(text, /还有 7 条/);

  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `d_${i}`, title: `DDL ${i}`, due: '2026-11-19', status: 'todo' }));
  const ddlText = formatDailyBrief(buildDailyBrief(doc({ tasks: { version: 1, tasks, updatedAt: null } }), NOW), { maxDeadlines: 3 });
  assert.match(ddlText, /还有 7 条/);
});
