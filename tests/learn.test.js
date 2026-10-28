/**
 * 网络学堂解析层测试（零依赖）
 * 运行：node tests/learn.test.js
 *
 * 这里**不联网**：全部针对纯函数 —— 响应体形状识别、日期归一、课程映射、去重组装。
 * 之所以要把这些钉死，是因为真实接口长什么样我们只能从页面 HTML 推断，
 * 一旦学堂改字段，我们希望是测试先红，而不是用户发现 DDL 少了几条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  cookieValue,
  learnHeaders,
  withCsrfQuery,
  aoDataOf,
  pickSemesters,
  pickLearnCourses,
  normalizeWideChars,
  learnCourseListPath,
  asArray,
  looksLikeHomeworkRow,
  pickRows,
  toMillis,
  millisToDay,
  millisToMinute,
  normalizeDue,
  guessKind,
  mapRowToList,
  rowKey,
  matchCourse,
  stripCourseCode,
  pickCourseIds,
  pickCourseNames,
  pickStudentEndpoints,
  buildCandidates,
  diffCandidates,
  learnMarkOf,
  toTaskItem,
  LEARN_LISTS,
  LEARN_SEMESTERS_PATH,
  LEARN_BASE,
  learnHomeworkViewPath,
  learnHomeworkViewUrl,
  parseLearnKey,
  htmlToText,
  parseHomeworkDetail,
  fetchHomeworkDetail,
} from '../lib/learn.js';

/** 把「北京时间 年月日时分」换算成毫秒时间戳，避免测试里手算 UTC 偏移出错。 */
function beijing(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 8, mi);
}

// ─────────────────────────────── 基础解析 ───────────────────────────────

test('decodeEntities：数字实体、十六进制实体与常见命名实体', () => {
  assert.equal(decodeEntities('&lt;a&gt;'), '<a>');
  assert.equal(decodeEntities('&amp;'), '&');
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('&#x41;'), 'A');
  assert.equal(decodeEntities('&#20013;'), '中');
  // &nbsp; 必须是普通空格：它是 HTML 里最常见的分隔符，留在名字里会污染匹配
  assert.equal(decodeEntities('大学&nbsp;物理'), '大学 物理');
  assert.equal(decodeEntities(null), '');
});

test('cookieValue：取值、去空白、取不到返回空串', () => {
  const cookie = 'JSESSIONID=abc123; XSRF-TOKEN=tok-9 ; other=1';
  assert.equal(cookieValue(cookie, 'JSESSIONID'), 'abc123');
  assert.equal(cookieValue(cookie, 'XSRF-TOKEN'), 'tok-9');
  assert.equal(cookieValue(cookie, 'missing'), '');
  assert.equal(cookieValue('', 'JSESSIONID'), '');
  assert.equal(cookieValue(null, 'JSESSIONID'), '');
  // 值里含 '=' 也要完整取回（base64 常见）
  assert.equal(cookieValue('k=a=b', 'k'), 'a=b');
});

test('learnHeaders：默认只带 Cookie；withXsrf 才补 X-XSRF-TOKEN', () => {
  const cookie = 'JSESSIONID=abc; XSRF-TOKEN=tok-9';
  const plain = learnHeaders(cookie);
  assert.equal(plain.Cookie, cookie);
  assert.equal(plain['X-XSRF-TOKEN'], undefined);
  assert.equal(plain['X-Requested-With'], 'XMLHttpRequest');

  const xsrf = learnHeaders(cookie, true);
  assert.equal(xsrf['X-XSRF-TOKEN'], 'tok-9');

  // Cookie 里没有 XSRF-TOKEN 时不能凭空造一个头，否则反而会被判非法请求
  assert.equal(learnHeaders('JSESSIONID=abc', true)['X-XSRF-TOKEN'], undefined);
});

test('asArray：数组原样、null/undefined 变空、单值包一层', () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray('x'), ['x']);
});

test('looksLikeHomeworkRow：命中任一提示键即为真', () => {
  assert.equal(looksLikeHomeworkRow({ bt: '作业一' }), true);
  assert.equal(looksLikeHomeworkRow({ xszyid: 7 }), true);
  assert.equal(looksLikeHomeworkRow({ jzsjStr: '2026-10-15' }), true);
  assert.equal(looksLikeHomeworkRow({ foo: 1 }), false);
  assert.equal(looksLikeHomeworkRow([{ bt: 'x' }]), false);
  assert.equal(looksLikeHomeworkRow(null), false);
});

test('pickRows：覆盖裸数组、aaData、两层 result.list、未知包装的深度搜索', () => {
  const rows = [{ bt: 'A', jzsj: 1 }];
  assert.deepEqual(pickRows(rows), rows);
  assert.deepEqual(pickRows({ aaData: rows }), rows);
  assert.deepEqual(pickRows({ resultList: rows }), rows);
  assert.deepEqual(pickRows({ data: rows }), rows);
  // DataTables 偶尔套两层
  assert.deepEqual(pickRows({ result: { list: rows } }), rows);
  // 完全不认识的形状：只好深度搜索，但要能找到
  assert.deepEqual(pickRows({ code: 0, payload: { deep: { rows } } }), rows);
  // 找不到时返回 null 而不是抛异常 —— 「形状不认识」是可诊断信息
  assert.equal(pickRows({ code: 0, msg: 'ok' }), null);
  assert.equal(pickRows(null), null);
  assert.equal(pickRows('nope'), null);
  // 但「已知容器键 + 空数组」是**有效答案**（这门课确实没有作业），要成 [] 而不是 null。
  // 否则调用方无法区分「零条作业」与「响应形状不认识」，诊断信息会误导人。
  assert.deepEqual(pickRows({ aaData: [] }), []);
});

// ─────────────────────────────── 日期 ───────────────────────────────

test('toMillis：数字、数字字符串、非法值', () => {
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.equal(toMillis('1700000000000'), 1700000000000);
  assert.equal(toMillis(''), null);
  assert.equal(toMillis('abc'), null);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(0), null);
});

test('millisToDay / millisToMinute：按 +08:00 换算', () => {
  const ms = beijing(2026, 10, 15, 23, 59);
  assert.equal(millisToDay(ms), '2026-10-15');
  assert.equal(millisToMinute(ms), '2026-10-15 23:59');
  // 跨日：北京时间 00:30 是 UTC 前一天 16:30，若按 UTC 算会错一天
  const midnight = beijing(2026, 10, 16, 0, 30);
  assert.equal(millisToDay(midnight), '2026-10-16');
  assert.equal(millisToMinute(midnight), '2026-10-16 00:30');
});

test('normalizeDue：优先毫秒 jzsj，补交只作为 grace', () => {
  const due = normalizeDue({ jzsj: beijing(2026, 10, 15, 23, 59), bjjzsj: beijing(2026, 10, 22, 23, 59) });
  assert.equal(due.value, '2026-10-15 23:59');
  assert.equal(due.source, 'jzsj');
  // 关键：补交期不能顶替主截止，否则提醒会晚一周
  assert.equal(due.grace, '2026-10-22 23:59');
  assert.notEqual(due.value, due.grace);
});

test('normalizeDue：没有毫秒值时回落字符串字段', () => {
  assert.deepEqual(normalizeDue({ jzsjStr: '2026-10-15 23:59' }), { value: '2026-10-15 23:59', source: 'jzsjStr', grace: null });
  // 斜杠格式与不补零的月日都要能认
  assert.equal(normalizeDue({ jzsjStr: '2026/10/5' }).value, '2026-10-05');
  assert.equal(normalizeDue({ jzrq: '2026-3-7 8:05' }).value, '2026-03-07 08:05');
  // 只有日期没有时间也接受
  assert.deepEqual(normalizeDue({ jzsjStr: '2026-10-15' }), { value: '2026-10-15', source: 'jzsjStr', grace: null });
});

test('normalizeDue：认不出来就诚实地返回 null', () => {
  assert.deepEqual(normalizeDue({}), { value: null, source: null, grace: null });
  assert.deepEqual(normalizeDue({ jzsjStr: '待定' }), { value: null, source: null, grace: null });
  assert.deepEqual(normalizeDue(null), { value: null, source: null, grace: null });
});

// ─────────────────────────────── 行 → 候选 ───────────────────────────────

test('guessKind：按标题关键词判类型，猜不出是 homework', () => {
  assert.equal(guessKind('期中考试'), 'exam');
  assert.equal(guessKind('第 3 次小测'), 'exam');
  assert.equal(guessKind('结课论文'), 'paper');
  assert.equal(guessKind('课程设计报告'), 'report');
  assert.equal(guessKind('实验三 数据通路'), 'lab');
  assert.equal(guessKind('第三章习题'), 'homework');
  assert.equal(guessKind(undefined), 'homework');
});

test('rowKey：xszyid 优先，逐级退化，且必须稳定', () => {
  assert.equal(rowKey({ xszyid: 12, zyid: 3 }), 'xszyid:12');
  assert.equal(rowKey({ zyid: 3, wlkcid: 'W1' }), 'zy:W1:3');
  assert.equal(rowKey({ bt: '作业一', jzsj: 1000 }), `title:作业一#${millisToMinute(1000)}`);
  assert.equal(rowKey({ bt: '作业一' }), 'title:作业一#');
  assert.equal(rowKey(null), null);
  // 两次调用必须同值，否则每次同步都会重复导入
  const row = { zyid: 3, wlkcid: 'W1', bt: 'x' };
  assert.equal(rowKey(row), rowKey({ ...row }));
});

test('mapRowToList：缺标题给占位名，缺截止不编日期', () => {
  const item = mapRowToList({ xszyid: 1, bt: '  ', jzsj: beijing(2026, 10, 15, 23, 59) });
  assert.equal(item.title, '(未命名作业)');
  assert.equal(item.key, 'xszyid:1');
  assert.equal(item.due, '2026-10-15 23:59');
  assert.equal(item.dueSource, 'jzsj');

  const noDue = mapRowToList({ xszyid: 2, bt: '读书笔记' });
  assert.equal(noDue.due, null);
  assert.equal(noDue.dueSource, null);
  assert.equal(noDue.kind, 'homework');

  // 不像作业的行直接拒绝，不要往候选里塞垃圾
  assert.equal(mapRowToList({ foo: 1 }), null);
});

// ─────────────────────────────── 课程映射 ───────────────────────────────

test('stripCourseCode：剥课程号，但保留属于名字的 (2)', () => {
  // 学堂名 = 课程名 + 课程号
  assert.equal(stripCourseCode('大学物理B(2)（10430494-3）'), '大学物理B(2)');
  // (2) 是名字的一部分，必须留下，否则会和「大学物理B(1)」撞车
  assert.equal(stripCourseCode('大学物理B(2)'), '大学物理B(2)');
  // 全角括号归一成半角：本地写「英语阅读写作(A)」、学堂写「英语阅读写作（A）」，
  // 这是输入法差异，不该让用户去加别名 —— 归一化后必须两边相等。
  assert.equal(stripCourseCode('离散数学（1）'), '离散数学(1)');
  assert.equal(stripCourseCode('英语阅读写作（A）'), stripCourseCode('英语阅读写作(A)'));
  // 纯 4 位以上数字当课程号剥掉
  assert.equal(stripCourseCode('数字电子技术基础（2026）'), '数字电子技术基础');
  // 空白（含全角）统一拿掉
  assert.equal(stripCourseCode(' 大学 物理 B (2) '), '大学物理B(2)');
  assert.equal(stripCourseCode(null), '');
});

test('matchCourse：全角/半角括号不影响精确匹配', () => {
  // 真机实测的差异之一：本地「英语阅读写作(A)」vs 学堂「英语阅读写作（A）」
  const courses = [{ id: 'c9', name: '英语阅读写作(A)' }];
  assert.deepEqual(matchCourse('英语阅读写作（A）', courses), { courseId: 'c9', how: 'exact' });
});

test('matchCourse：精确优先，括号课程号不影响', () => {
  const courses = [
    { id: 'c1', name: '大学物理B(2)' },
    { id: 'c2', name: '数字电子技术基础' },
    { id: 'c3', name: '数据结构' },
  ];
  // 学堂名带课程号，本地名不带 —— 归一化后必须判成 exact，而不是降级成 prefix
  assert.deepEqual(matchCourse('大学物理B(2)（10430494-3）', courses), { courseId: 'c1', how: 'exact' });
  assert.deepEqual(matchCourse('数字电子技术基础', courses), { courseId: 'c2', how: 'exact' });
});

test('matchCourse：别名命中', () => {
  const courses = [{ id: 'c2', name: '数字电子技术基础', aliases: ['数电'] }];
  assert.deepEqual(matchCourse('数电', courses), { courseId: 'c2', how: 'alias' });
  // 别名是精确比较，不做包含 —— 「数电」不该命中「数电实验」
  const withLab = [
    { id: 'c2', name: '数字电子技术基础', aliases: ['数电'] },
    { id: 'c4', name: '数电实验' },
  ];
  assert.deepEqual(matchCourse('数电实验', withLab), { courseId: 'c4', how: 'exact' });
});

test('matchCourse：唯一前缀才接受，命中多门必须报 ambiguous 而不是猜', () => {
  const courses = [{ id: 'c1', name: '大学物理B(2)' }, { id: 'c2', name: '数字电子技术基础' }];
  assert.deepEqual(matchCourse('大学物理B', courses), { courseId: 'c1', how: 'prefix' });

  const two = [{ id: 'c1', name: '大学物理B(1)' }, { id: 'c2', name: '大学物理B(2)' }];
  const result = matchCourse('大学物理B', two);
  assert.equal(result.how, 'ambiguous');
  assert.equal(result.courseId, null);
  assert.equal(result.candidates.length, 2);
});

test('matchCourse：手动映射优先于一切自动判断', () => {
  const courses = [{ id: 'c1', name: '大学物理B(2)' }];
  assert.deepEqual(matchCourse('大学物理B', courses, { 大学物理B: 'c9' }), { courseId: 'c9', how: 'manual' });
  // 手动映射用「包含」匹配，便于用户只写关键词
  assert.deepEqual(matchCourse('大学物理B(2)（10430494-3）', courses, { 物理: 'c9' }), { courseId: 'c9', how: 'manual' });
});

test('matchCourse：空名、没课程、完全不认识', () => {
  assert.deepEqual(matchCourse('', [{ id: 'c1', name: 'x' }]), { courseId: null, how: 'empty' });
  assert.deepEqual(matchCourse('物理', []), { courseId: null, how: 'no-courses' });
  assert.deepEqual(matchCourse('量子力学', [{ id: 'c1', name: '大学物理B(2)' }]), { courseId: null, how: 'unmatched' });
});

// ─────────────────────────────── HTML 抽取 ───────────────────────────────

test('pickCourseIds：去重取课堂号', () => {
  const html = `
    <a href="/f/wlxt/index/course/student/course?wlkcid=2026-2027-1152225553">大学物理B(2)</a>
    <a href="/f/wlxt/index/course/student/course?wlkcid=2026-2027-1152225553">重复</a>
    <a href="?wlkcid=2026-2027-1152226877">数据结构</a>`;
  assert.deepEqual(pickCourseIds(html), ['2026-2027-1152225553', '2026-2027-1152226877']);
  assert.deepEqual(pickCourseIds(''), []);
});

test('pickCourseNames：课堂号 → 课程名，后者覆盖前者，模板串要排除', () => {
  const html = `
    <a href="course?wlkcid=2026-2027-1152225553">{{value.kcid}}</a>
    <a href="course?wlkcid=2026-2027-1152225553"> 大学物理B(2) </a>
    <a href="course?wlkcid=2026-2027-1152226877">数据结构&amp;算法</a>`;
  const map = pickCourseNames(html);
  assert.equal(map['2026-2027-1152225553'], '大学物理B(2)');
  assert.equal(map['2026-2027-1152226877'], '数据结构&算法');
});

test('pickStudentEndpoints：扫出学生端接口，去重', () => {
  const html = `
    "/b/wlxt/kczy/zy/student/zyListWj"
    "/b/wlxt/kczy/zy/student/zyListYjwg"
    "/b/wlxt/kczy/zy/student/zyListWj"
    "/b/wlxt/kczy/zy/teacher/zyListWj"`;
  const found = pickStudentEndpoints(html);
  assert.equal(found.length, 2);
  assert.ok(found.includes('/b/wlxt/kczy/zy/student/zyListWj'));
  assert.ok(found.includes('/b/wlxt/kczy/zy/student/zyListYjwg'));
  // 教师端接口不能被当成学生端
  assert.ok(!found.some((p) => p.includes('/teacher/')));
});

// ─────────────────────────────── 组装 ───────────────────────────────

test('LEARN_LISTS：三张表都指向 student 路径，且只有未提交表算「待办」', () => {
  assert.equal(LEARN_LISTS.length, 3);
  for (const list of LEARN_LISTS) {
    assert.ok(list.path.startsWith('zyList'), list.path);
    assert.ok(typeof list.label === 'string' && list.label !== '');
  }
  const open = LEARN_LISTS.filter((l) => l.open);
  assert.equal(open.length, 1);
  assert.equal(open[0].path, 'zyListWj');
});

test('buildCandidates：按 key 去重、标 expired、收集 ambiguous', () => {
  const courses = [{ id: 'c1', name: '大学物理B(2)' }];
  const now = new Date('2026-10-01T00:00:00Z');
  const openRow = { xszyid: 1, bt: '第三次作业', jzsj: beijing(2026, 10, 15, 23, 59) };
  const pastRow = { xszyid: 2, bt: '第一次作业', jzsj: beijing(2026, 9, 1, 23, 59) };

  const { candidates, ambiguous } = buildCandidates(
    [
      // 同一行在两张表里都出现（漏交的作业会同时出现在未提交与已批改里）
      { wlkcid: 'W1', name: '大学物理B(2)（10430494-3）', listKey: 'wj', rows: [openRow, pastRow] },
      { wlkcid: 'W1', name: '大学物理B(2)（10430494-3）', listKey: 'ypg', rows: [openRow] },
    ],
    courses,
    { now },
  );

  assert.equal(candidates.length, 2);
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  assert.equal(byKey.get('xszyid:1').expired, false);
  assert.equal(byKey.get('xszyid:2').expired, true);
  assert.equal(byKey.get('xszyid:1').courseId, 'c1');
  assert.equal(byKey.get('xszyid:1').wlkcid, 'W1');
  assert.equal(byKey.get('xszyid:1').source, 'learn');
  // 老调用方没给 entry.open 时一律当作「还没交」—— 不能因为缺字段就把作业标成已完成
  assert.equal(byKey.get('xszyid:1').open, true);
  assert.equal(ambiguous.length, 0);
});

test('buildCandidates：把列表的 open 透传到候选，供 toTaskItem 落提交状态', () => {
  const rows = [{ xszyid: 7, bt: '第二次作业', jzsj: beijing(2026, 10, 15, 23, 59) }];
  const { candidates } = buildCandidates(
    [{ wlkcid: 'W1', name: '大学物理B(2)', listKey: 'yjwg', open: false, rows }],
    [{ id: 'c1', name: '大学物理B(2)' }],
    { now: new Date('2026-10-01T00:00:00Z') },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].open, false);
  assert.equal(candidates[0].listKey, 'yjwg');
});

test('buildCandidates：对不上课也照样产出候选，courseId 为 null', () => {
  const { candidates, ambiguous } = buildCandidates(
    [{ wlkcid: 'W9', name: '量子力学', listKey: 'wj', rows: [{ xszyid: 5, bt: '作业', jzsj: beijing(2026, 10, 15, 23, 59) }] }],
    [{ id: 'c1', name: '大学物理B(2)' }],
    { now: new Date('2026-10-01T00:00:00Z') },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].courseId, null);
  assert.equal(candidates[0].learnName, '量子力学');
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].how, 'unmatched');
});

test('learnMarkOf / diffCandidates：靠 note 里的记号去重', () => {
  assert.equal(learnMarkOf({ note: '先看第一章 [learn:xszyid:1] 再交' }), 'xszyid:1');
  assert.equal(learnMarkOf({ note: '普通备注' }), null);
  assert.equal(learnMarkOf({}), null);
  assert.equal(learnMarkOf(null), null);

  const existing = [{ id: 't1', note: '[learn:xszyid:1]' }];
  const candidates = [{ key: 'xszyid:1' }, { key: 'xszyid:2' }];
  const { created, skipped } = diffCandidates(existing, candidates);
  assert.deepEqual(created.map((c) => c.key), ['xszyid:2']);
  assert.deepEqual(skipped.map((c) => c.key), ['xszyid:1']);
  // 空输入不能炸
  assert.deepEqual(diffCandidates(null, null), { created: [], skipped: [] });
});

test('toTaskItem：产出可落盘的任务条目，缺失截止不写假日期', () => {
  const makeId = (prefix) => `${prefix}0001`;
  const now = new Date('2026-10-01T00:00:00Z');
  const task = toTaskItem(
    { key: 'xszyid:1', title: '第三次作业', courseId: 'c1', kind: 'homework', due: '2026-10-15 23:59' },
    makeId,
    { now, priority: 'high' },
  );
  assert.equal(task.id, 't0001');
  assert.equal(task.courseId, 'c1');
  assert.equal(task.due, '2026-10-15 23:59');
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 'high');
  assert.equal(task.createdAt, now.toISOString());
  assert.equal(learnMarkOf(task), 'xszyid:1');

  const bare = toTaskItem({ key: 'xszyid:2', title: '读书笔记', due: null }, makeId, { now });
  assert.equal(bare.due, null);
  assert.equal(bare.priority, 'normal');
  // 标题超长要截断，避免把任务文件撑坏
  const long = toTaskItem({ key: 'k', title: 'x'.repeat(500) }, makeId, { now });
  assert.equal(long.title.length, 120);
  assert.ok(long.note.length <= 300);

  // 平台已经收到这份作业（行来自「已提交未批改 / 已批改」列表）→ 直接落 done，
  // 否则用户会看到一堆早就交了的作业挂在「未完成」里。
  const submitted = toTaskItem({ key: 'xszyid:3', title: '第一次作业', open: false }, makeId, { now });
  assert.equal(submitted.status, 'done');
  assert.equal(submitted.progress, 100);
  // 完成时刻由 normalizeTask 落成「导入时刻」—— 真提交时刻在平台那边，这里不编日期
  assert.equal(submitted.doneAt, null);
  assert.equal(learnMarkOf(submitted), 'xszyid:3');
});

// ─────────────────── 作业接口的请求形状（POST + aoData + _csrf） ───────────────────

test('withCsrfQuery：把 _csrf 追加到查询串，且不重复追加', () => {
  const cookie = 'JSESSIONID=abc; XSRF-TOKEN=tok%2Fen';
  // 没有查询串 → 用 ?
  assert.equal(withCsrfQuery('/b/wlxt/x', cookie), '/b/wlxt/x?_csrf=tok%252Fen');
  // 已有查询串 → 用 &
  assert.equal(withCsrfQuery('/b/wlxt/x?timestamp=1', cookie), '/b/wlxt/x?timestamp=1&_csrf=tok%252Fen');
  // 已经带过就不再追加（否则会出现两个 _csrf，服务端取哪个不确定）
  assert.equal(withCsrfQuery('/b/wlxt/x?_csrf=other', cookie), '/b/wlxt/x?_csrf=other');
  // Cookie 里根本没有 XSRF-TOKEN → 原样返回，不硬塞一个空的 _csrf
  assert.equal(withCsrfQuery('/b/wlxt/x', 'JSESSIONID=abc'), '/b/wlxt/x');
  assert.equal(withCsrfQuery(null, cookie), '');
});

test('aoDataOf：带完整骨架，并把自定义条件放在后面', () => {
  const out = aoDataOf([{ name: 'wlkcid', value: '2026-2027-1152225553' }]);
  const names = out.map((e) => e.name);
  // 骨架字段在，浏览器里就是发这些
  for (const key of ['sEcho', 'iColumns', 'iDisplayStart', 'iDisplayLength', 'iSortingCols']) {
    assert.ok(names.includes(key), `缺少骨架字段 ${key}`);
  }
  const wlkcid = out.find((e) => e.name === 'wlkcid');
  assert.equal(wlkcid.value, '2026-2027-1152225553');
  // 自定义条件必须在骨架之后：真机实测服务端只认 aoData 里的字段
  assert.equal(names.indexOf('wlkcid'), names.length - 1);

  // iDisplayLength 跟随 limit（作业多的课不能只拿 10 条）
  assert.equal(aoDataOf([], 500).find((e) => e.name === 'iDisplayLength').value, 500);
  // 默认 limit 给足
  assert.equal(aoDataOf().find((e) => e.name === 'iDisplayLength').value, 200);
  // 垃圾条目被忽略而不是塞进去
  const dirty = aoDataOf([{ name: '', value: 1 }, null, 'x', { value: 2 }, { name: 'ok', value: 3 }]);
  assert.deepEqual(dirty.filter((e) => e.name === 'ok'), [{ name: 'ok', value: 3 }]);
  assert.equal(dirty.length, 15 + 1);
  // 不传参数也不炸
  assert.equal(aoDataOf().length, 15);
});

test('pickSemesters：真实响应首元素是 null，只收学期串', () => {
  // 真机实测原样：queryxnxq 返回的就是这样一个数组
  const real = [null, '2026-2027-1', '2025-2026-3', '2025-2026-2', '2025-2026-1'];
  assert.deepEqual(pickSemesters(real), ['2026-2027-1', '2025-2026-3', '2025-2026-2', '2025-2026-1']);
  // 去重
  assert.deepEqual(pickSemesters(['2026-2027-1', '2026-2027-1']), ['2026-2027-1']);
  // 不是学期串的一律丢掉
  assert.deepEqual(pickSemesters(['2026-2027', '2026-2027-11', 'x', 3, null, {}]), []);
  // 包装形状也要认
  assert.deepEqual(pickSemesters({ resultList: ['2026-2027-1'] }), ['2026-2027-1']);
  // 形状完全不认识 → 空数组，不抛异常
  assert.deepEqual(pickSemesters({ weird: true }), []);
  assert.deepEqual(pickSemesters(null), []);
});

test('pickLearnCourses：wlkcid/kcm/xf 三个字段的取法', () => {
  const payload = {
    message: 'success',
    resultList: [
      { wlkcid: '2026-2027-1152226496', kcm: '数字电子技术基础', xnxq: '2026-2027-1', jsh: '2011990', xf: null },
      // 重复课堂号只留第一条
      { wlkcid: '2026-2027-1152226496', kcm: '重复的', xnxq: '2026-2027-1' },
      // 课程名里可能带实体
      { wlkcid: 'A', kcm: '离散数学 &amp; 应用', xf: 3 },
      // 没有 wlkcid 的条目没法用，丢掉
      { kcm: '没有课堂号' },
    ],
  };
  const out = pickLearnCourses(payload);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    wlkcid: '2026-2027-1152226496',
    name: '数字电子技术基础',
    semester: '2026-2027-1',
    teacherNo: '2011990',
    // 实测该字段为 null，绝不能当成 0 学分
    credits: null,
  });
  assert.equal(out[1].name, '离散数学 & 应用');
  assert.equal(out[1].credits, 3);
  assert.equal(out[1].semester, null);
  // 裸数组也认；形状不认识 → 空数组而不是抛异常
  assert.equal(pickLearnCourses([{ wlkcid: 'B', kcm: 'x' }]).length, 1);
  assert.deepEqual(pickLearnCourses({ weird: true }), []);
  assert.deepEqual(pickLearnCourses(null), []);
});

test('normalizeWideChars：全角括号与标点归一，其余不动', () => {
  assert.equal(normalizeWideChars('英语阅读写作（A）'), '英语阅读写作(A)');
  assert.equal(normalizeWideChars('形势与政策（2）-春'), '形势与政策(2)-春');
  assert.equal(normalizeWideChars('大学物理B（2）'), '大学物理B(2)');
  assert.equal(normalizeWideChars('a：b，c、d'), 'a:b,c,d');
  assert.equal(normalizeWideChars('大学\u3000物理'), '大学 物理');
  assert.equal(normalizeWideChars(null), '');
  // 不能把半角括号、普通空格改坏
  assert.equal(normalizeWideChars('Already (fine) here'), 'Already (fine) here');
});

test('learnCourseListPath / LEARN_SEMESTERS_PATH：接口路径写死了才敢用', () => {
  assert.equal(LEARN_SEMESTERS_PATH, '/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq');
  const p = learnCourseListPath('2026-2027-1');
  assert.ok(p.startsWith('/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/2026-2027-1/zh_CN?timestamp='));
  assert.ok(Number(p.split('timestamp=')[1]) > 0);
  // 默认 locale 是 zh_CN（不传就是中文课程名）
  assert.ok(learnCourseListPath('2026-2027-1', 'en_US').includes('/en_US?timestamp='));
  // 学期串要转义，别让特殊字符改写路径
  assert.ok(learnCourseListPath('a/b').includes('/a%2Fb/'));
});

// ───────────────────────── 作业详情页（viewYxzy） ─────────────────────────
//
// 真机结构（2026-10-09，数据结构 HW3）：三段 `<div class="ttee">段名</div>` 开头，
// 段内是 `<div class="…left…">标签</div><div class="right">值</div>`。
// 这些用例的价值在于：平台改版时是测试先红，而不是用户点开详情看到一片空白。

/** 复刻真机骨架的最小 HTML（含空值字段与一个 PDF 附件）。 */
const DETAIL_HTML = `<!doctype html><html><body>
<div id="userid">2025000000</div>
<div class="ttee">作业内容及要求：</div>
<div class="list"><div class="fl left">作业标题</div><div class="right"><p>HW3</p></div></div>
<div class="list"><div class="fl left">作业说明</div><div class="right"></div></div>
<div class="list"><div class="fl left">作业附件</div><div class="right">
<span class="ftitle"><a target="_blank" href="/f/wlxt/kc/wj_wjb/student/openNewWindow?fileId=abc">数据结构第三次作业.pdf</a></span><span class="color_999">81.08K</span>
</div></div>
<div class="list"><div class="fl left">发布对象</div><div class="right">全体学生-全体</div></div>
<div class="list"><div class="fl left">完成方式</div><div class="right">每人独立完成一份作业</div></div>
<div class="list"><div class="fl left">截止日期(GMT+8)</div><div class="right">2026-10-16 00:00</div></div>
<div class="ttee">学生提交作业情况：</div>
<div class="list"><div class="fl left">学号</div><div class="right">2025000000 示例同学</div></div>
<div class="list"><div class="fl left">提交日期</div><div class="right">2026-10-08 21:21</div></div>
<div class="list"><div class="fl left">上交作业内容</div><div class="right"><p>示例同学_2025000000_数据结构第二次作业<br>烦请老师查收</p></div></div>
<div class="ttee">老师批阅结果：</div>
<div class="list"><div class="fl left">批阅老师</div><div class="right"></div></div>
<div class="list"><div class="fl left">成绩</div><div class="right"></div></div>
<div class="list"><div class="fl left">评语</div><div class="right"></div></div>
</body></html>`;

/** 临时替换全局 fetch，用完必须还原（`lib/learn.js` 直接用全局 fetch）。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('parseLearnKey：只认两种带远端主键的记号，其余退回本地', () => {
  assert.deepEqual(
    parseLearnKey('xszyid:26ef84e7a119e83c01a120a4495f25e6'),
    { xszyid: '26ef84e7a119e83c01a120a4495f25e6', wlkcid: null, zyid: null },
  );
  assert.deepEqual(
    parseLearnKey('zy:2026-2027-1152226877:26ef84e8a0d2759701a0e32749bb7896'),
    { xszyid: null, wlkcid: '2026-2027-1152226877', zyid: '26ef84e8a0d2759701a0e32749bb7896' },
  );
  // `title:…` 没有远端主键：宁可退回本地字段，也不拿标题去平台猜
  assert.equal(parseLearnKey('title:HW3#2026-10-16 00:00'), null);
  assert.equal(parseLearnKey('xszyid:'), null);
  assert.equal(parseLearnKey('zy:只有一个冒号'), null);
  assert.equal(parseLearnKey(''), null);
  assert.equal(parseLearnKey(null), null);
});

test('learnHomeworkViewPath：主键是 xszyid，参数要转义', () => {
  assert.equal(
    learnHomeworkViewPath('2026-2027-1152226877', 'abc'),
    '/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=2026-2027-1152226877&xszyid=abc',
  );
  assert.equal(
    learnHomeworkViewUrl('w', 'a'),
    `${LEARN_BASE}/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=w&xszyid=a`,
  );
  assert.ok(learnHomeworkViewPath('a b', 'c&d').includes('wlkcid=a%20b&xszyid=c%26d'));
});

test('htmlToText：只出纯文本，块级标签换行、实体还原、脚本丢掉', () => {
  assert.equal(htmlToText('<p>a<br>b</p><div>c</div>'), 'a\nb\nc');
  assert.equal(htmlToText('&lt;p&gt;示例同学&lt;/p&gt;'), '<p>示例同学</p>');
  assert.equal(htmlToText('<script>var x=1;</script>正文'), '正文');
  assert.equal(htmlToText('<textarea></textarea>'), '');
  assert.equal(htmlToText(null), '');
});

test('parseHomeworkDetail：三段都认得出，空值不硬填', () => {
  const detail = parseHomeworkDetail(DETAIL_HTML);
  assert.deepEqual(detail.sections.map((s) => s.title), ['作业内容及要求', '学生提交作业情况', '老师批阅结果']);
  assert.equal(detail.title, 'HW3');
  // 平台这一栏是空的 ⇒ null，界面才能「没有就不显示」
  assert.equal(detail.description, null);
  assert.equal(detail.due, '2026-10-16 00:00');
  assert.equal(detail.audience, '全体学生-全体');
  assert.equal(detail.mode, '每人独立完成一份作业');
  assert.deepEqual(detail.attachments, [{
    name: '数据结构第三次作业.pdf',
    size: '81.08K',
    href: `${LEARN_BASE}/f/wlxt/kc/wj_wjb/student/openNewWindow?fileId=abc`,
  }]);
  assert.equal(detail.student, '2025000000 示例同学');
  assert.equal(detail.submittedAt, '2026-10-08 21:21');
  assert.equal(detail.submission, '示例同学_2025000000_数据结构第二次作业\n烦请老师查收');
  assert.equal(detail.score, null);
  assert.equal(detail.comment, null);
  assert.deepEqual(detail.answerFiles, []);
});

test('parseHomeworkDetail：段标记没了也不白屏 —— 整页当一段兜底', () => {
  const detail = parseHomeworkDetail('<div class="left">作业标题</div><div class="right">HW9</div>');
  assert.deepEqual(detail.sections.map((s) => s.title), ['']);
  assert.equal(detail.title, 'HW9');
});

test('parseHomeworkDetail：最后一个标签不能把页脚吞成自己的值', () => {
  // 真机上调出来过：最后一段的「评语附件」把「去答疑 / 公众号 / 版权所有」全吞了
  const html = `<div id="userid">1</div>
<div class="ttee">老师批阅结果：</div>
<div class="list"><div class="fl left">评语</div><div class="right">好</div></div>
<div class="list"><div class="fl left">评语附件</div><div class="right"></div></div>
<div class="foot">去答疑</div><div class="foot">教务处官方微信公众号</div><div class="foot">版权所有 © 清华大学</div>`;
  const detail = parseHomeworkDetail(html);
  assert.equal(detail.comment, '好');
  assert.deepEqual(detail.commentFiles, []);
  const last = detail.sections.at(-1).rows.at(-1);
  assert.equal(last.label, '评语附件');
  assert.equal(last.text, '');
  assert.ok(!JSON.stringify(detail).includes('版权所有'));
});

test('fetchHomeworkDetail：200 也可能是登录页，必须判成 cookie-invalid', async () => {
  const restore = stubFetch(async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html>请先登录</html>' }));
  try {
    const out = await fetchHomeworkDetail('w', 'x', 'JSESSIONID=1');
    assert.equal(out.ok, false);
    assert.equal(out.error, 'cookie-invalid');
    assert.equal(out.detail, null);
  } finally {
    restore();
  }
});

test('fetchHomeworkDetail：正常页出结构化字段与原文链接；非 200 出 http-<status>', async () => {
  const restoreOk = stubFetch(async (url, init) => {
    assert.ok(String(url).includes('/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=w&xszyid=x'));
    assert.equal(init.method, 'GET');
    return { status: 200, headers: { get: () => null }, text: async () => DETAIL_HTML };
  });
  try {
    const out = await fetchHomeworkDetail('w', 'x', 'JSESSIONID=1');
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(out.detail.title, 'HW3');
    assert.equal(out.detail.wlkcid, 'w');
    assert.equal(out.detail.xszyid, 'x');
    assert.equal(out.detail.url, `${LEARN_BASE}/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=w&xszyid=x`);
  } finally {
    restoreOk();
  }

  const restoreBad = stubFetch(async () => ({ status: 500, headers: { get: () => null }, text: async () => 'boom' }));
  try {
    const out = await fetchHomeworkDetail('w', 'x', 'JSESSIONID=1');
    assert.equal(out.ok, false);
    assert.equal(out.error, 'http-500');
    assert.equal(out.status, 500);
  } finally {
    restoreBad();
  }
});
