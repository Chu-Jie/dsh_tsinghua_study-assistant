/**
 * 演示数据脚本（零依赖）
 * 运行：node tools/seed-demo.mjs
 *
 * 往「学习台」里写入一份可直接看的演示数据：一个学期、4 门课、若干任务与成绩。
 * 用途：插件装上后先有内容可看，验证界面与接口是通的。
 *
 * 安全说明：
 *   - 只写「学习台」目录，绝不触碰 _工具/作业台状态.json 或任何作业文件；
 *   - 写入沿用 lib/store.js 的受保护写入（原子写 + 冲突检测 + 备份）；
 *   - 已存在同名学期/课程时不重复添加，可安全重复执行；
 *   - 加 --reset 参数可先清空四份数据再写入。
 */

import path from 'node:path';
import process from 'node:process';

import { createStore } from '../lib/store.js';

const DATA_DIR = process.env.HW_DATA_DIR ?? path.resolve(import.meta.dirname, '..', '..', '..', '学习台');
const RESET = process.argv.includes('--reset');

const store = createStore(DATA_DIR);

/** ISO 星期：周一 1 … 周日 7。 */
function isoWeekday(date) {
  return date.getDay() === 0 ? 7 : date.getDay();
}

function formatDay(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 本学期开始日：取「本周一」往前 4 周，保证演示数据落在教学周内。 */
function termStart() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (isoWeekday(now) - 1) - 28);
  return formatDay(monday);
}

function isoDate(offsetDays) {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return formatDay(target);
}

const TERM = {
  id: 's_demo2026',
  name: '2026 秋（演示）',
  startDate: termStart(),
  endDate: isoDate(112),
  totalWeeks: 16,
  isCurrent: true,
};

const COURSES = [
  {
    id: 'c_ds',
    name: '数据结构',
    teacher: '示例教师',
    credits: 4,
    type: '必修',
    sessions: [
      { weekday: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'A101' },
      { weekday: 3, startPeriod: 3, endPeriod: 4, weeks: '1-16双', location: 'A101' },
    ],
    note: '演示数据',
  },
  {
    id: 'c_phy',
    name: '大学物理',
    teacher: '示例教师',
    credits: 3,
    type: '必修',
    sessions: [{ weekday: 2, startPeriod: 3, endPeriod: 4, weeks: '1-16', location: 'B202' }],
    note: '演示数据',
  },
  {
    id: 'c_digital',
    name: '数字电子技术',
    teacher: '示例教师',
    credits: 3.5,
    type: '必修',
    sessions: [{ weekday: 4, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'C303' }],
    note: '演示数据',
  },
  {
    id: 'c_eng',
    name: '大学英语',
    teacher: '示例教师',
    credits: 2,
    type: '通识',
    sessions: [{ weekday: 5, startPeriod: 5, endPeriod: 6, weeks: '1-16', location: 'D404' }],
    note: '演示数据',
  },
];

const TASKS = [
  { id: 't_demo1', title: '数据结构第 3 次作业', courseId: 'c_ds', kind: 'homework', due: isoDate(-2), status: 'todo', priority: 'high', estimateHours: 4, progress: 20 },
  { id: 't_demo2', title: '物理实验报告（示波器）', courseId: 'c_phy', kind: 'report', due: isoDate(0), status: 'doing', priority: 'high', estimateHours: 3, progress: 60 },
  { id: 't_demo3', title: '数电第 2 次作业', courseId: 'c_digital', kind: 'homework', due: isoDate(2), status: 'todo', priority: 'normal', estimateHours: 2, progress: 0 },
  { id: 't_demo4', title: '英语单元小测', courseId: 'c_eng', kind: 'exam', due: isoDate(5), status: 'todo', priority: 'normal', estimateHours: 3, progress: 0 },
  { id: 't_demo5', title: '课程设计选题报告', courseId: 'c_ds', kind: 'paper', due: isoDate(12), status: 'todo', priority: 'low', estimateHours: 8, progress: 0 },
  { id: 't_demo6', title: '小组展示分工', kind: 'group', due: isoDate(9), status: 'todo', priority: 'normal', estimateHours: 1, progress: 0 },
  { id: 't_demo7', title: '已经交掉的那次作业', courseId: 'c_phy', kind: 'homework', due: isoDate(-9), status: 'done', priority: 'normal', estimateHours: 2, progress: 100 },
];

const GRADES = [
  { courseId: 'c_ds', score: 88, credit: 4, examType: '期末' },
  { courseId: 'c_phy', score: 92, credit: 3, examType: '期末' },
  { courseId: 'c_digital', score: 79, credit: 3.5, examType: '期末' },
  // 故意留一条没有分数的，用来验证「未计入 GPA」提示不是静默当 0
  { courseId: 'c_eng', score: null, grade: null, credit: 2, examType: '期末' },
];

/** 受保护的写入：读 → 合并 → 带 hash 写。 */
async function mergeDoc(key, merge, listKey) {
  const read = await store.readDocument(key);
  if (!read.ok && read.reason !== 'missing') {
    throw new Error(`「${key}」当前不可读（${read.reason}），为避免覆盖已中止`);
  }
  const base = read.ok ? read.doc : null;
  if (base === null) throw new Error(`「${key}」缺失，请先让插件启动一次以初始化`);
  const next = merge(base);
  if (listKey !== undefined) {
    const before = Array.isArray(base[listKey]) ? base[listKey].length : 0;
    const after = Array.isArray(next[listKey]) ? next[listKey].length : 0;
    if (before === after) {
      console.log(`  · ${key}：已是最新，未改动`);
      return;
    }
  }
  const written = await store.writeDocument(key, next, { expectedHash: read.hash, backupKeep: 10 });
  if (!written.ok) throw new Error(`「${key}」写入失败：${written.reason}`);
  console.log(`  ✓ ${key} 已写入`);
}

async function main() {
  console.log(`数据目录：${DATA_DIR}`);
  await store.init();

  if (RESET) {
    console.log('--reset：先清空四份数据');
    for (const key of ['term', 'courses', 'tasks', 'grades']) {
      const read = await store.readDocument(key);
      const result = await store.resetDocument(key, { confirm: true, expectedHash: read.hash, backupKeep: 10 });
      if (!result.ok) console.log(`  · ${key} 重置跳过：${result.reason}`);
    }
  }

  console.log('写入学期…');
  await mergeDoc('term', (doc) => {
    const terms = Array.isArray(doc.terms) ? [...doc.terms] : [];
    if (terms.some((t) => t.id === TERM.id)) return doc;
    terms.push(TERM);
    return { ...doc, terms, currentId: TERM.id };
  }, 'terms');

  console.log('写入课程…');
  await mergeDoc('courses', (doc) => {
    const list = Array.isArray(doc.courses) ? [...doc.courses] : [];
    for (const course of COURSES) {
      if (!list.some((c) => c.id === course.id)) list.push({ ...course, createdAt: new Date().toISOString() });
    }
    return { ...doc, courses: list };
  }, 'courses');

  console.log('写入任务…');
  await mergeDoc('tasks', (doc) => {
    const list = Array.isArray(doc.tasks) ? [...doc.tasks] : [];
    for (const task of TASKS) {
      if (!list.some((t) => t.id === task.id)) {
        list.push({ ...task, createdAt: new Date().toISOString(), doneAt: task.status === 'done' ? new Date().toISOString() : null, note: '演示数据' });
      }
    }
    return { ...doc, tasks: list };
  }, 'tasks');

  console.log('写入成绩…');
  await mergeDoc('grades', (doc) => {
    const list = Array.isArray(doc.courses) ? [...doc.courses] : [];
    for (const grade of GRADES) {
      if (!list.some((g) => g.courseId === grade.courseId)) list.push(grade);
    }
    return { ...doc, courses: list };
  }, 'courses');

  const health = await store.health();
  console.log('');
  console.log(`完成。数据健康：${health.healthy ? '正常' : '有问题'}`);
  for (const file of health.files) console.log(`  ${file.ok ? '✓' : '✗'} ${file.file}（${file.bytes} 字节）`);
  console.log('');
  console.log('接下来：重启 DSH Desktop，页面刷新后左侧栏会出现「学习辅助」图标。');
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
