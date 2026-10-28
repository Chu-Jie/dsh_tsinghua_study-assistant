/**
 * 核心逻辑测试（零依赖，只用 node:assert + node:test）
 * 运行：node tests/core.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWeeks,
  isWeekActive,
  currentTeachingWeek,
  isoWeekday,
  weekdayName,
  parseDay,
  formatDay,
  daysBetween,
  parseDue,
  deadlineUrgency,
  compareTasksByDue,
  isClosedTask,
  parseTimestamp,
  compareClosedTasksByDoneAtDesc,
  compareDeadlineList,
  scoreToGpa4,
  gradeToGpa4,
  computeGpa,
  requiredGpaForTarget,
  validateDoc,
  defaultDoc,
  isValidId,
  buildOverview,
  DOC_KEYS,
  URGENCY,
} from '../lib/core.js';

test('parseWeeks：常规表达式', () => {
  assert.deepEqual(parseWeeks('1-16').weeks, Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(parseWeeks('1-8,10-16').weeks, [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(parseWeeks('3').weeks, [3]);
  assert.deepEqual(parseWeeks(' 1-4 、 6 ').weeks, [1, 2, 3, 4, 6]);
});

test('parseWeeks：单双周', () => {
  assert.deepEqual(parseWeeks('1-8单').weeks, [1, 3, 5, 7]);
  assert.deepEqual(parseWeeks('1-8(双)').weeks, [2, 4, 6, 8]);
  const odd = parseWeeks('1-10单周');
  assert.equal(odd.parity, 'odd');
  assert.deepEqual(odd.weeks, [1, 3, 5, 7, 9]);
  assert.deepEqual(parseWeeks('2-8双').weeks, [2, 4, 6, 8]);
});

test('parseWeeks：非法输入返回 ok:false 而不是抛异常', () => {
  for (const bad of ['', 'abc', '1-', '-5', '5-2', '0', '1-99', '1-abc', null, undefined, 42]) {
    const result = parseWeeks(bad);
    assert.equal(result.ok, false, `应判定为非法：${JSON.stringify(bad)}`);
    assert.deepEqual(result.weeks, []);
  }
  // 单双周过滤后为空也要判定非法
  assert.equal(parseWeeks('2-2单').ok, false);
});

test('isWeekActive：按 sessions 的周次判断', () => {
  const course = { sessions: [{ weekday: 2, weeks: '1-8,10-16' }, { weekday: 4, weeks: '2-16双' }] };
  assert.equal(isWeekActive(course, 1), true);
  assert.equal(isWeekActive(course, 9), false);
  assert.equal(isWeekActive(course, 0), false);
  assert.equal(isWeekActive({ sessions: [{ weekday: 1, weeks: 'abc' }] }, 3), false);
});

test('currentTeachingWeek：开学日、假期、非法日期', () => {
  const term = { startDate: '2026-09-07', totalWeeks: 16 };
  assert.equal(currentTeachingWeek(term, '2026-09-07').week, 1);
  assert.equal(currentTeachingWeek(term, '2026-09-13').week, 1);
  assert.equal(currentTeachingWeek(term, '2026-09-14').week, 2);
  assert.equal(currentTeachingWeek(term, '2026-09-30').week, 4);

  const before = currentTeachingWeek(term, '2026-08-01');
  assert.equal(before.inTerm, false);
  assert.equal(before.reason, 'before-term');

  const after = currentTeachingWeek(term, '2027-03-01');
  assert.equal(after.inTerm, false);
  assert.equal(after.reason, 'after-term');

  assert.equal(currentTeachingWeek(term, 'not-a-date').reason, 'bad-date');
  assert.equal(currentTeachingWeek({ startDate: '2026-09-07' }, '2026-09-07').week, 1);
});

test('parseDay：挡住被自动进位的非法日期，且不受时区影响', () => {
  assert.equal(parseDay('2026-09-07').getDate(), 7);
  assert.equal(parseDay('2026-02-31'), null);
  assert.equal(parseDay('2026-13-01'), null);
  assert.equal(parseDay(''), null);
  assert.equal(parseDay(undefined), null);
  assert.equal(formatDay(parseDay('2026-09-07')), '2026-09-07');
  // 时区安全：解析后格式化必须回到同一天
  assert.equal(formatDay(parseDay('2026-01-01')), '2026-01-01');
  assert.equal(formatDay(parseDay('2026-12-31')), '2026-12-31');
});

test('daysBetween 与 isoWeekday', () => {
  assert.equal(daysBetween('2026-09-07', '2026-09-14'), 7);
  assert.equal(daysBetween('2026-09-14', '2026-09-07'), -7);
  assert.equal(daysBetween('bad', '2026-09-07'), null);
  assert.equal(isoWeekday('2026-09-07'), 1); // 周一
  assert.equal(isoWeekday('2026-09-13'), 7); // 周日
  assert.equal(weekdayName(1), '周一');
  assert.equal(weekdayName(7), '周日');
  assert.equal(weekdayName(9), '');
});

test('parseDue：只有日期按当日 23:59，带时间按该时刻', () => {
  const endOfDay = parseDue('2026-09-10');
  assert.equal(endOfDay.getHours(), 23);
  assert.equal(endOfDay.getMinutes(), 59);
  const noon = parseDue('2026-09-10 12:30');
  assert.equal(noon.getHours(), 12);
  assert.equal(noon.getMinutes(), 30);
  const colon = parseDue('2026-09-10T08:05');
  assert.equal(colon.getHours(), 8);
  assert.equal(colon.getMinutes(), 5);
  assert.equal(parseDue('bogus'), null);
  assert.equal(parseDue(null), null);
});

test('deadlineUrgency：分档与已完成', () => {
  const now = new Date(2026, 8, 10, 9, 0, 0); // 2026-09-10 09:00 本地
  assert.equal(deadlineUrgency({ due: '2026-09-09' }, now).level, URGENCY.OVERDUE);
  assert.equal(deadlineUrgency({ due: '2026-09-10' }, now).level, URGENCY.TODAY);
  assert.equal(deadlineUrgency({ due: '2026-09-12' }, now).level, URGENCY.SOON);
  assert.equal(deadlineUrgency({ due: '2026-09-20' }, now).level, URGENCY.LATER);
  assert.equal(deadlineUrgency({ due: '' }, now).level, URGENCY.UNKNOWN);
  assert.equal(deadlineUrgency({ due: '2026-09-01', status: 'done' }, now).level, URGENCY.DONE);
  assert.equal(deadlineUrgency({ due: '2026-09-01', status: 'dropped' }, now).level, URGENCY.DONE);

  // 当天已过时刻算逾期（03:00 已过 09:00 之前的 08:00）
  assert.equal(deadlineUrgency({ due: '2026-09-10 08:00' }, now).level, URGENCY.OVERDUE);
  assert.equal(deadlineUrgency({ due: '2026-09-10 23:00' }, now).level, URGENCY.TODAY);
});

test('compareTasksByDue：逾期最前，已完成沉底', () => {
  const now = new Date(2026, 8, 10, 9, 0, 0);
  const tasks = [
    { id: 'later', title: 'l', due: '2026-09-25' },
    { id: 'overdue', title: 'o', due: '2026-09-01' },
    { id: 'today', title: 't', due: '2026-09-10' },
    { id: 'done', title: 'd', due: '2026-09-02', status: 'done' },
    { id: 'nodate', title: 'n', due: '' },
  ];
  const sorted = [...tasks].sort((a, b) => compareTasksByDue(a, b, now)).map((t) => t.id);
  assert.deepEqual(sorted, ['overdue', 'today', 'later', 'nodate', 'done']);
});

test('compareDeadlineList：已完结沉底，组内按完成时间倒序', () => {
  const now = new Date(2026, 9, 8, 20, 0, 0);
  const tasks = [
    { id: 'old-done', status: 'done', doneAt: '2026-09-30T05:50:00.738Z', due: '2026-09-21' },
    { id: 'new-done', status: 'done', doneAt: '2026-10-08T11:33:02.990Z', due: '2026-10-09 00:00' },
    { id: 'overdue', status: 'todo', due: '2026-10-01' },
    { id: 'today', status: 'todo', due: '2026-10-08' },
    { id: 'no-done-at', status: 'done', due: '2026-09-25' },
  ];
  const sorted = [...tasks].sort((a, b) => compareDeadlineList(a, b, now)).map((t) => t.id);
  assert.deepEqual(sorted, ['overdue', 'today', 'new-done', 'old-done', 'no-done-at']);
  // 用户的诉求就是这个方向：今天刚做完的那条排在已完成组的最上面，而不是按截止日排到最后
  assert.ok(sorted.indexOf('new-done') < sorted.indexOf('old-done'));
});

test('compareClosedTasksByDoneAtDesc：缺 doneAt 的排后面，再按截止日倒序', () => {
  const older = { id: 'a', status: 'done', doneAt: '2026-09-30T05:50:00.738Z' };
  const newer = { id: 'b', status: 'done', doneAt: '2026-10-08T11:33:02.990Z' };
  assert.ok(compareClosedTasksByDoneAtDesc(older, newer) > 0, '更早完成的应排在后面');
  assert.ok(compareClosedTasksByDoneAtDesc(newer, older) < 0);

  const missing = { id: 'c', status: 'done', doneAt: null, due: '2026-09-20' };
  const missing2 = { id: 'd', status: 'done', due: '2026-09-25' };
  assert.ok(compareClosedTasksByDoneAtDesc(older, missing) < 0, '有完成时间的排在没完成时间的前面');
  assert.ok(compareClosedTasksByDoneAtDesc(missing, missing2) > 0, '都没有完成时间时按截止日倒序');
  assert.equal(
    compareClosedTasksByDoneAtDesc({ status: 'done', due: '2026-09-20' }, { status: 'done' }),
    0,
    '完全没有可比信息时返回 0，保持原序',
  );
});

test('isClosedTask / parseTimestamp', () => {
  assert.equal(isClosedTask({ status: 'done' }), true);
  assert.equal(isClosedTask({ status: 'dropped' }), true);
  assert.equal(isClosedTask({ status: 'todo' }), false);
  assert.equal(isClosedTask({}), false);
  assert.equal(parseTimestamp('2026-10-08T11:33:02.990Z'), Date.parse('2026-10-08T11:33:02.990Z'));
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp('bad'), null);
});

test('scoreToGpa4 / gradeToGpa4', () => {
  assert.equal(scoreToGpa4(90), 4);
  assert.equal(scoreToGpa4(85), 3.5);
  assert.equal(scoreToGpa4(61), 1.1);
  assert.equal(scoreToGpa4(60), 1);
  assert.equal(scoreToGpa4(59), 0);
  assert.equal(scoreToGpa4(100), 4);
  assert.equal(scoreToGpa4(NaN), null);
  assert.equal(scoreToGpa4(undefined), null);
  assert.equal(gradeToGpa4('优秀'), 4);
  assert.equal(gradeToGpa4('良好'), 3);
  assert.equal(gradeToGpa4('中等'), 2);
  assert.equal(gradeToGpa4('及格'), 1);
  assert.equal(gradeToGpa4('不及格'), 0);
  assert.equal(gradeToGpa4('未知等级'), null);
});

test('computeGpa：加权、跳过无分数/无学分项，绝不静默当 0', () => {
  const result = computeGpa({
    courses: [
      { courseId: 'a', score: 90, credit: 3 }, // 4.0 × 3
      { courseId: 'b', score: 80, credit: 2 }, // 3.0 × 2
      { courseId: 'c', grade: '良好', credit: 1 }, // 3.0 × 1
      { courseId: 'd', score: null, credit: 3 }, // 无分数 → 跳过
      { courseId: 'e', score: 99, credit: 0 }, // 无学分 → 跳过
    ],
  });
  assert.equal(result.credits, 6);
  assert.equal(result.gpa, 3.5);
  assert.equal(result.average, 86);
  assert.deepEqual(result.skipped.map((s) => s.reason).sort(), ['no-credit', 'no-score']);
});

test('computeGpa：空数据返回 null 而不是 0', () => {
  const empty = computeGpa({ courses: [] });
  assert.equal(empty.gpa, null);
  assert.equal(empty.average, null);
  assert.equal(empty.credits, 0);
  assert.equal(computeGpa(null).gpa, null);
});

test('requiredGpaForTarget：反推与不可达', () => {
  const grades = { courses: [{ courseId: 'a', score: 80, credit: 2 }] }; // 3.0 × 2
  const reach = requiredGpaForTarget(grades, 3.5, 2);
  assert.equal(reach.reachable, true);
  assert.equal(reach.requiredGpa, 4);

  const unreachable = requiredGpaForTarget(grades, 4, 2);
  assert.equal(unreachable.reachable, false);
  assert.equal(unreachable.reason, 'above-max');

  const noBase = requiredGpaForTarget({ courses: [] }, 3.5, 2);
  assert.equal(noBase.reason, 'no-existing-credits');
  assert.equal(requiredGpaForTarget(grades, 3.5, 0).reason, 'no-remaining-credits');
});

test('validateDoc：损坏判定与默认结构', () => {
  for (const key of DOC_KEYS) {
    assert.equal(validateDoc(key, defaultDoc(key)).ok, true, `${key} 的默认结构必须合法`);
  }
  assert.equal(validateDoc('courses', null).ok, false);
  assert.equal(validateDoc('courses', []).ok, false);
  assert.equal(validateDoc('courses', {}).ok, false);
  assert.equal(validateDoc('courses', { version: 99, courses: [] }).ok, false);
  assert.equal(validateDoc('unknown', {}).ok, false);
  assert.equal(validateDoc('grades', { version: 1, courses: [] }).ok, false); // 缺 rules
});

test('isValidId：只允许安全字符，挡住路径穿越', () => {
  assert.equal(isValidId('c_abc123'), true);
  assert.equal(isValidId('t-1'), true);
  assert.equal(isValidId('../etc/passwd'), false);
  assert.equal(isValidId('a/b'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId('x'.repeat(65)), false);
});

test('buildOverview：今日课程、周次、GPA 汇总', () => {
  const data = {
    term: { terms: [{ id: 's1', name: '2026 秋', startDate: '2026-09-07', totalWeeks: 16, isCurrent: true }], currentId: 's1' },
    courses: {
      courses: [
        { id: 'c1', name: '数据结构', sessions: [{ weekday: 1, startPeriod: 3, endPeriod: 4, weeks: '1-16', location: 'A101' }] },
        { id: 'c2', name: '物理', sessions: [{ weekday: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'B202' }] },
        { id: 'c3', name: '英语', sessions: [{ weekday: 3, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'C303' }] },
      ],
    },
    tasks: {
      tasks: [
        { id: 't1', title: '数电作业', due: '2026-09-08', status: 'todo' },
        { id: 't2', title: '已交', due: '2026-09-01', status: 'done' },
        { id: 't3', title: '物理作业', due: '2026-09-06', status: 'todo' },
      ],
    },
    grades: { courses: [{ courseId: 'c1', score: 90, credit: 4 }] },
  };
  // 2026-09-07 是周一，第 1 教学周
  const overview = buildOverview(data, new Date(2026, 8, 7, 10, 0, 0));
  assert.equal(overview.week, 1);
  assert.equal(overview.inTerm, true);
  assert.equal(overview.weekdayName, '周一');
  assert.deepEqual(overview.todayCourses.map((c) => c.name), ['物理', '数据结构']);
  assert.equal(overview.todayCourses[0].location, 'B202');
  assert.equal(overview.upcoming.length, 2);
  assert.equal(overview.upcoming[0].title, '物理作业'); // 逾期排在明天到期之前
  assert.equal(overview.upcoming[0].level, 'overdue');
  assert.equal(overview.upcoming[1].title, '数电作业');
  assert.equal(overview.overdueCount, 1);
  assert.equal(overview.gpa.gpa, 4);
});

test('buildOverview：无学期与放假时不崩', () => {
  const empty = buildOverview({ term: null, courses: null, tasks: null, grades: null }, new Date(2026, 8, 7));
  assert.equal(empty.term, null);
  assert.equal(empty.week, 0);
  assert.deepEqual(empty.todayCourses, []);
  assert.equal(empty.gpa.gpa, null);

  const holiday = buildOverview({
    term: { terms: [{ id: 's1', name: 'T', startDate: '2026-09-07', totalWeeks: 2 }], currentId: 's1' },
    courses: { courses: [{ id: 'c1', name: 'x', sessions: [{ weekday: 1, startPeriod: 1, endPeriod: 1, weeks: '1-2' }] }] },
    tasks: { tasks: [] },
    grades: { courses: [] },
  }, new Date(2026, 9, 1));
  assert.equal(holiday.inTerm, false);
  assert.equal(holiday.termState, 'after-term');
  assert.deepEqual(holiday.todayCourses, []);
});
