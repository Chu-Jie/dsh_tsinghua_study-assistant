/**
 * 提交件扫描与匹配测试（零依赖，只用 node:assert + node:test）
 * 运行：node --test tests/deliverables.test.js
 *
 * 全部读写都发生在 os.tmpdir() 下自建的临时目录里：
 * 既不触碰真实的「学习台」数据目录，也绝不往真实工作区写任何文件。
 * 测试身份用假名假号，避免在磁盘上留下带本人姓名 + 学号的文件。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseDeliverableName,
  parseTaskSeq,
  resolveCourseIds,
  collectDeliverables,
} from '../lib/deliverables.js';

/** 测试身份（不是真实数据）。 */
const NAME = '张同学';
const ID = '2025000000';

/** 课程表外形与真实「学习台/课程.json」一致（id / name / aliases）。 */
const COURSES = [
  { id: 'c_phy', name: '大学物理B(2)', aliases: ['物理', '大学物理', '大物'], note: '工作区目录：物理/' },
  { id: 'c_digital', name: '数字电子技术基础', aliases: ['数电', '数电实验', '数字电子技术实验', '数字电路'] },
  { id: 'c_ds', name: '数据结构', aliases: ['数构', 'DS'] },
  { id: 'c_disc', name: '离散数学', aliases: ['离散'] },
];

/** 建出来的临时根目录，after 里统一清理。 */
const tempRoots = [];

after(async () => {
  for (const dir of tempRoots) {
    // Windows 上递归删除可能撞到杀软句柄，退避重试（清理失败不该把正常的运行判成失败）
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }).catch(() => undefined);
  }
});

/** 造一个隔离的工作区根目录。 */
async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-deliv-'));
  tempRoots.push(dir);
  return dir;
}

/** 按相对路径（正斜杠）在工作区里写一个文件。 */
async function writeFileAt(root, relative, text = '提交件') {
  const abs = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  return abs;
}

/** 任务夹具：字段与「学习台/任务.json」的 tasks[] 一致。 */
function task(id, title, { courseId, kind = 'homework', status = 'todo', note = '' } = {}) {
  return {
    id,
    title,
    courseId,
    kind,
    status,
    note,
    due: '2026-09-20',
    priority: 'normal',
    estimateHours: 2,
    progress: status === 'done' ? 100 : 0,
    doneAt: status === 'done' ? '2026-09-19T10:00:00.000Z' : null,
    createdAt: '2026-09-10T00:00:00.000Z',
  };
}

/** 跑一次扫描，并断言恰好命中一条 findings。 */
async function scanOne(root, tasks, extra = {}) {
  const result = await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses: COURSES,
    tasks,
    ...extra,
  });
  assert.equal(result.enabled, true, '应处于启用状态');
  assert.equal(result.findings.length, 1, `应只有一条 findings，实际：${JSON.stringify(result.findings, null, 2)}`);
  return result.findings[0];
}

/** 目录树快照（相对路径 + 字节数），用于验证扫描是只读的。 */
async function snapshot(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const stat = await fs.stat(abs);
      out.push(`${path.relative(dir, abs).split(path.sep).join('/')}:${stat.size}`);
    }
  }
  await walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------- 纯函数

test('parseTaskSeq：序号表达式（中文数字、HW、周次、纯数字列表）', () => {
  assert.deepEqual(parseTaskSeq('第三周作业'), [3]);
  assert.deepEqual(parseTaskSeq('第二周作业'), [2]);
  assert.deepEqual(parseTaskSeq('物理第 01 次作业'), [1]);
  assert.deepEqual(parseTaskSeq('第十一周作业'), [11]);
  assert.deepEqual(parseTaskSeq('第二十三周作业'), [23]);
  assert.deepEqual(parseTaskSeq('HW2'), [2]);
  assert.deepEqual(parseTaskSeq('hw1'), [1]);
  assert.deepEqual(parseTaskSeq('3、4'), [3, 4]);
  assert.deepEqual(parseTaskSeq('周次： 1'), [1]);
  assert.deepEqual(parseTaskSeq('2'), [2]);
  // 解析不出来是 null（= 该维度未知），不是空数组
  // 数字片段里混进非法字符：整体认不出来就返回 null，绝不猜
  assert.equal(parseTaskSeq('第3x次作业'), null);
  assert.equal(parseTaskSeq('三x'), null);
  assert.equal(parseTaskSeq('仪器使用报告'), null);
  assert.equal(parseTaskSeq('数电实验二 预习报告（常用电子仪器的使用）'), null);
  assert.equal(parseTaskSeq(''), null);
  assert.equal(parseTaskSeq(null), null);
  assert.equal(parseTaskSeq(7), null);
});

test('parseDeliverableName：去掉姓名学号后解析课程令牌、序号、类型', () => {
  const options = { name: NAME, studentId: ID };
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_物理第一次作业.pdf`, options), {
    ok: true, subjectToken: '物理', seq: [1], kind: 'homework',
  });
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_数电第二次作业.pdf`, options), {
    ok: true, subjectToken: '数电', seq: [2], kind: 'homework',
  });
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_离散数学第一次作业.pdf`, options), {
    ok: true, subjectToken: '离散数学', seq: [1], kind: 'homework',
  });
  // 实验报告：序号与 kind 关键词都要从令牌里剥掉
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_数电实验第三次实验报告.pdf`, options), {
    ok: true, subjectToken: '数电实验', seq: [3], kind: 'report',
  });
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_物理HW2.docx`, options), {
    ok: true, subjectToken: '物理', seq: [2], kind: 'homework',
  });
  // 纯「报告」也算 report；没有序号时 seq 为 null
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_仪器使用报告.pdf`, options), {
    ok: true, subjectToken: '仪器使用', seq: null, kind: 'report',
  });
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_物理测验.pdf`, options), {
    ok: true, subjectToken: '物理', seq: null, kind: 'exam',
  });
  // 缺身份：文件名里没有学号 / 姓名，或者调用方就没给
  assert.deepEqual(parseDeliverableName('物理第一次作业.pdf', options), { ok: false, reason: 'missing-identity' });
  assert.deepEqual(parseDeliverableName(`${ID}_物理第一次作业.pdf`, options), { ok: false, reason: 'missing-identity' });
  assert.deepEqual(parseDeliverableName(`${ID}_${NAME}_物理第一次作业.pdf`, {}), { ok: false, reason: 'missing-identity' });
});

test('resolveCourseIds：全名、别名、前缀命中与去重', () => {
  assert.deepEqual(resolveCourseIds('物理', COURSES), ['c_phy']);
  assert.deepEqual(resolveCourseIds(' 数电 ', COURSES), ['c_digital']);
  assert.deepEqual(resolveCourseIds('数电实验', COURSES), ['c_digital']);
  assert.deepEqual(resolveCourseIds('离散数学', COURSES), ['c_disc']);
  // 课程名以令牌开头即命中（`物理实验` → `物理实验B(1)`）
  assert.deepEqual(resolveCourseIds('物理实验', [{ id: 'c_p2', name: '物理实验B(1)', aliases: [] }]), ['c_p2']);
  // 认不出来、空令牌、脏输入都返回 []
  assert.deepEqual(resolveCourseIds('随笔', COURSES), []);
  assert.deepEqual(resolveCourseIds('', COURSES), []);
  assert.deepEqual(resolveCourseIds('   ', COURSES), []);
  assert.deepEqual(resolveCourseIds('物理', null), []);
  assert.deepEqual(resolveCourseIds(null, COURSES), []);
});

test('resolveCourseIds：完全命中压过前缀命中（真实课表里「物理」与「物理实验B(1)」并存）', () => {
  // 真机回归：真实「课程.json」同时有「物理」（别名）与「物理实验B(1)」，
  // 若两档混在一起，`物理/提交文件/…物理第一次作业.pdf` 会被判成课程不唯一、永远不自动归档。
  const real = [
    { id: 'c_phy', name: '大学物理B(2)', aliases: ['物理', '大学物理', '大物'] },
    { id: 'c_phylab', name: '物理实验B(1)', aliases: ['物理实验', '大物实验', '物实'] },
  ];
  assert.deepEqual(resolveCourseIds('物理', real), ['c_phy'], '完全命中别名「物理」就该只回物理');
  assert.deepEqual(resolveCourseIds('物理实验', real), ['c_phylab'], '没有完全命中时才用前缀');
  assert.deepEqual(resolveCourseIds('大物', real), ['c_phy']);
  assert.deepEqual(resolveCourseIds('大学物理B(2)', real), ['c_phy']);
});

test('扫描：真实课表下「物理/提交文件/…物理第一次作业.pdf」要能对上物理课', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const real = [
    { id: 'c_phy', name: '大学物理B(2)', aliases: ['物理', '大学物理', '大物'], note: '工作区目录：物理/' },
    { id: 'c_phylab', name: '物理实验B(1)', aliases: ['物理实验', '大物实验', '物实'], note: '工作区目录：物理实验/' },
  ];
  const finding = await scanOne(root, [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })], { courses: real });
  assert.equal(finding.status, 'ready', '目录与文件名两条线索都指向物理课');
  assert.equal(finding.courseId, 'c_phy');
  assert.equal(finding.taskId, 't_phy_1');
});

// ---------------------------------------------------------------- 扫描 + 匹配

test('ready：唯一 open 任务命中（物理第一次作业 → 物理第 01 次作业）', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const finding = await scanOne(root, [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })]);

  // findings 的形状必须逐字段与规格一致（多一个键都会被这里挡下）
  assert.deepEqual(finding, {
    file: `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`,
    basename: `${ID}_${NAME}_物理第一次作业.pdf`,
    courseId: 'c_phy',
    seq: [1],
    kind: 'homework',
    status: 'ready',
    taskId: 't_phy_1',
    candidates: [],
    reason: 'unique-task',
  });
});

test('done/task-done：只有已完成任务能匹配上', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const finding = await scanOne(root, [
    task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy', status: 'done' }),
  ]);
  assert.equal(finding.status, 'done');
  assert.equal(finding.reason, 'task-done');
  assert.equal(finding.taskId, null, 'done 不给 taskId');
  assert.deepEqual(finding.candidates, [{ taskId: 't_phy_1', title: '物理第 01 次作业', seq: [1] }]);
});

test('ambiguous/task-ambiguous：同课程两个 open 任务同序号', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const finding = await scanOne(root, [
    task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' }),
    task('t_phy_2', '物理第 1 次作业', { courseId: 'c_phy' }),
  ]);
  assert.equal(finding.status, 'ambiguous');
  assert.equal(finding.reason, 'task-ambiguous');
  assert.equal(finding.taskId, null, '不唯一时绝不给出 taskId');
  assert.equal(finding.courseId, 'c_phy');
  assert.deepEqual(finding.candidates.map((c) => c.taskId).sort(), ['t_phy_1', 't_phy_2']);
});

test('unmatched/course-unknown：目录名与文件名都认不出课程', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `随笔/提交文件/${ID}_${NAME}_随笔第一次作业.pdf`);
  const finding = await scanOne(root, []);
  assert.equal(finding.status, 'unmatched');
  assert.equal(finding.reason, 'course-unknown');
  assert.equal(finding.courseId, null);
  assert.equal(finding.taskId, null);
  assert.deepEqual(finding.candidates, []);
});

test('unmatched/course-mismatch：目录与文件名指向不同课程', async () => {
  const root = await makeRoot();
  // 目录说是数电实验，文件名却说物理 → 两路线索的交集为空
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const finding = await scanOne(root, [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })]);
  assert.equal(finding.status, 'unmatched');
  assert.equal(finding.reason, 'course-mismatch');
});

test('stray/not-in-submit-dir：直接躺在工作区根下的提交件不归档', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `${ID}_${NAME}_物理第一次作业.pdf`);
  const finding = await scanOne(root, [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })]);
  assert.equal(finding.status, 'stray');
  assert.equal(finding.reason, 'not-in-submit-dir');
  assert.equal(finding.file, `${ID}_${NAME}_物理第一次作业.pdf`);
  assert.equal(finding.taskId, null, '放错位置绝不能触发归档');
  assert.deepEqual(finding.candidates, []);
});

test('enabled:false：缺学号 / 缺姓名 / 根目录不存在或是文件', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`);
  const tasks = [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })];
  const base = { workspaceRoot: root, studentName: NAME, studentId: ID, courses: COURSES, tasks };

  for (const patch of [{ studentId: '' }, { studentId: '   ' }, { studentName: '' }]) {
    const result = await collectDeliverables({ ...base, ...patch });
    assert.deepEqual(result, { enabled: false, root, findings: [], reason: 'disabled' }, JSON.stringify(patch));
  }

  const missing = await collectDeliverables({ ...base, workspaceRoot: path.join(root, '不存在的目录') });
  assert.equal(missing.enabled, false);
  assert.equal(missing.reason, 'disabled');
  assert.deepEqual(missing.findings, []);

  const notDir = await writeFileAt(root, '这是个文件.txt');
  const fileAsRoot = await collectDeliverables({ ...base, workspaceRoot: notDir });
  assert.equal(fileAsRoot.enabled, false);
  assert.equal(fileAsRoot.reason, 'disabled');
});

test('kind 兜底：两边都没有序号时只按 kind 匹配（唯一即 ready）', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_数电实验报告.pdf`);
  const finding = await scanOne(root, [
    task('t_lab_1', '数电实验 预习报告', { courseId: 'c_digital', kind: 'report' }),
    task('t_lab_2', '数电第二次作业', { courseId: 'c_digital', kind: 'homework' }),
  ]);
  assert.equal(finding.status, 'ready');
  assert.equal(finding.taskId, 't_lab_1');
  assert.equal(finding.kind, 'report');
  assert.equal(finding.seq, null, '提交件本身没有可解析的序号');
});

test('回归：数电实验报告不得归档到 kind=homework 的「第三周作业」', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_数电实验第三次实验报告.pdf`);
  const courses = [COURSES.find((c) => c.id === 'c_digital')];
  const result = await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses,
    tasks: [task('t_w3', '第三周作业', { courseId: 'c_digital', kind: 'homework' })],
  });

  const finding = result.findings[0];
  assert.equal(finding.kind, 'report', '文件名里的「实验报告」应判成 report');
  assert.equal(finding.seq.includes(3), true, '第三次应解析出 3');
  // 序号对上了，但 kind 不同（report ≠ homework）—— 这正是必须挡住的错配
  assert.notEqual(finding.status, 'ready');
  assert.equal(finding.status, 'unmatched');
  assert.equal(finding.reason, 'no-task');
  assert.equal(finding.taskId, null);
});

test('中文数字：第三周作业 与 数电第三次作业 的序号都解析成 [3]', async () => {
  const root = await makeRoot();
  assert.deepEqual(parseTaskSeq('第三周作业'), [3]);
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_数电第三次作业.pdf`);
  const finding = await scanOne(root, [
    task('t_w3', '第三周作业', { courseId: 'c_digital', kind: 'homework' }),
  ]);
  assert.deepEqual(finding.seq, [3]);
  assert.equal(finding.status, 'ready');
  assert.equal(finding.taskId, 't_w3');
});

test('已归档优先：任务备注里已写着该文件名 → done/already-noted', async () => {
  const root = await makeRoot();
  const basename = `${ID}_${NAME}_物理第一次作业.pdf`;
  await writeFileAt(root, `物理/提交文件/${basename}`);
  const finding = await scanOne(root, [
    task('t_phy_1', '物理第 01 次作业', {
      courseId: 'c_phy',
      status: 'done',
      note: `2026-09-20 已收件：${basename}`,
    }),
    // 同时还有一条 open 的同序号任务：备注优先，不该判成 ready
    task('t_phy_1b', '物理第 1 次作业', { courseId: 'c_phy' }),
  ]);
  assert.equal(finding.status, 'done');
  assert.equal(finding.reason, 'already-noted');
  assert.deepEqual(finding.candidates.map((c) => c.taskId), ['t_phy_1']);
});

test('扫描范围：跳过 _工具/.隐藏/~$，递归深度不超过 3 层', async () => {
  const root = await makeRoot();
  const rel = `${ID}_${NAME}_物理第一次作业.pdf`;
  await writeFileAt(root, `_工具/提交文件/${rel}`);
  await writeFileAt(root, `.隐藏/提交文件/${rel}`);
  await writeFileAt(root, `物理/提交文件/~$${rel}`);
  await writeFileAt(root, `物理/提交文件/a/b/${rel}`);
  await writeFileAt(root, `物理/提交文件/a/b/c/${rel}`);

  const result = await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses: COURSES,
    tasks: [task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' })],
  });
  assert.deepEqual(result.findings.map((f) => f.file), [`物理/提交文件/a/b/${rel}`]);
  assert.equal(result.findings[0].status, 'ready');
});

test('排序与多学科：ready → ambiguous → done → unmatched → stray，同级按 file 升序', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`); // ready
  await writeFileAt(root, `离散数学/提交文件/${ID}_${NAME}_离散数学第一次作业.pdf`); // done
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_数电第一次作业.pdf`); // ambiguous
  await writeFileAt(root, `随笔/提交文件/${ID}_${NAME}_随笔第一次作业.pdf`); // unmatched
  await writeFileAt(root, `${ID}_${NAME}_物理第二次作业.pdf`); // stray

  const result = await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses: COURSES,
    tasks: [
      task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' }),
      task('t_disc_1', '离散数学第一次作业', { courseId: 'c_disc', status: 'done' }),
      task('t_digital_1', '数电第一次作业', { courseId: 'c_digital' }),
      task('t_digital_1b', '数电第 1 次作业', { courseId: 'c_digital' }),
    ],
  });
  assert.deepEqual(result.findings.map((f) => f.status), ['ready', 'ambiguous', 'done', 'unmatched', 'stray']);
  assert.deepEqual(result.findings.map((f) => f.taskId), ['t_phy_1', null, null, null, null]);
});

test('只读：扫描前后工作区目录树逐字节不变', async () => {
  const root = await makeRoot();
  await writeFileAt(root, `物理/提交文件/${ID}_${NAME}_物理第一次作业.pdf`, '内容 A');
  await writeFileAt(root, `数电实验/提交文件/${ID}_${NAME}_数电第一次作业.pdf`, '内容 B');
  await writeFileAt(root, `随笔/提交文件/${ID}_${NAME}_随笔第一次作业.pdf`, '内容 C');
  await writeFileAt(root, `${ID}_${NAME}_离散数学第一次作业.pdf`, '内容 D');

  const before = await snapshot(root);
  await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses: COURSES,
    tasks: [
      task('t_phy_1', '物理第 01 次作业', { courseId: 'c_phy' }),
      task('t_digital_1', '数电第一次作业', { courseId: 'c_digital' }),
    ],
  });
  assert.deepEqual(await snapshot(root), before, 'collectDeliverables 必须只读');
});

test('根目录参数：root 原样回传，非目录的直接子项不当作学科目录', async () => {
  const root = await makeRoot();
  // 根下放一个普通文件与一个空的「提交文件」目录（不是 <学科>/提交文件）
  await writeFileAt(root, '提交文件/readme.txt');
  const result = await collectDeliverables({
    workspaceRoot: root,
    studentName: NAME,
    studentId: ID,
    courses: COURSES,
    tasks: [],
  });
  assert.equal(result.enabled, true);
  assert.equal(result.root, root);
  assert.deepEqual(result.findings, []);
});
