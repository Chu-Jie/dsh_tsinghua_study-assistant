// 用**真实的学习台数据**渲染课表与 DDL 两个页签，把渲染结果打成文本看。
//
// 目的：单元测试只验证纯函数，这个脚本验证「真数据 + 真组件」这一层
// ——课表表头到底有没有日期、一键导入的预览到底解析出几条。
//
// 用法：
//   node tools/render-tabs-preview.mjs            # 渲染本周课表 + DDL 导入预览
//   node tools/render-tabs-preview.mjs 6          # 指定教学周
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const ROOT = `${HERE}/../../..`;
const DATA = `${ROOT}/学习台`;

// --- 假的 React/JSX 环境（与 tests/client.test.js 保持同一套简化实现） ---
// 这里特意手写一份最小实现，而不是 import 测试文件：
// 工具脚本必须能在不跑测试框架的情况下单独用。
const React = {
  Component: class Component {
    constructor(props) { this.props = props ?? {}; }
    setState() {}
    render() { return null; }
  },
  createElement(type, props, ...children) {
    return { __el: true, type, props: props ?? {}, children: children.flat() };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
};

globalThis.window = globalThis.window ?? {};
globalThis.document = globalThis.document ?? { head: { appendChild() {} }, createElement: () => ({}) };

const half = (() => {
  // 客户端 bundle 通过 window.__ModuleLoader__.load() 注册自己。
  // 用 vm 跑：bundle 里有跨 realm 的 `instanceof`/`Array.isArray` 调用，
  // 放进同一个新 realm 才与浏览器一致。
  const registrations = [];
  const injectedStyles = [];
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      head: { appendChild(node) { injectedStyles.push(node); return node; } },
      createElement: (tag) => ({ tagName: tag.toUpperCase(), attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, textContent: '' }),
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, docs: {}, hashes: {}, files: [], problems: [] }) }),
  };
  context.window.__ModuleLoader__ = {
    load(registration) {
      registrations.push(registration.id);
      context.__exports = registration.factory((specifier) => {
        if (specifier !== 'react') throw new Error(`客户端只允许 require('react')，实际 ${specifier}`);
        return React;
      });
    },
  };
  const code = readFileSync(`${HERE}/../client.js`, 'utf8');
  vm.runInNewContext(code, context, { filename: 'client.js' });
  if (context.__exports === undefined) throw new Error('client.js 没有注册任何模块');
  return context.__exports;
})();

const readDoc = (name) => {
  try {
    return JSON.parse(readFileSync(`${DATA}/${name}`, 'utf8'));
  } catch (error) {
    console.error(`读取 ${name} 失败：${error.message}`);
    return null;
  }
};

const term = readDoc('学期.json');
const courses = readDoc('课程.json');
const tasks = readDoc('任务.json');

const internals = half.DESCRIPTORS.internals;
const activeTerm = term.terms.find((t) => t.id === term.currentId) ?? term.terms[0];
const currentWeek = internals.currentTeachingWeek(activeTerm, new Date()).week;
const shownWeek = Number(process.argv[2]) || currentWeek;

// 把 React 元素树拍平成文本，够看清结构就行
const flatten = (node, depth = 0) => {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map((child) => flatten(child, depth)).join('');
  if (typeof node !== 'object' || node.__el !== true) return String(node);
  const children = flatten(node.children, depth + 1);
  if (children === '') return '';
  return `${children}`;
};

console.log('='.repeat(72));
console.log(`学期：${activeTerm.name}（第 1 周周一 = ${activeTerm.startDate}）`);
console.log(`本周（今天 ${new Date().toISOString().slice(0, 10)}）：第 ${currentWeek} 教学周；下面渲染第 ${shownWeek} 周`);
console.log('='.repeat(72));

// ---- 课表页签的表头：这是需求 ① 的核心 ----
const monday = internals.teachingWeekStart(activeTerm, shownWeek);
const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
console.log(`\n【课表表头】第 ${shownWeek} 周  ${internals.formatMonthDay(monday)} – ${internals.formatMonthDay(sunday)}`);
for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
  const date = internals.dateOfWeekday(activeTerm, shownWeek, weekday);
  const isToday = internals.parseDay(date).getTime() === internals.parseDay(new Date()).getTime();
  console.log(`  周${'一二三四五六日'[weekday - 1]}  ${internals.formatMonthDay(date)}${isToday ? '   ← 今天（高亮）' : ''}`);
}

// ---- 课表格子内容 ----
console.log(`\n【课表内容】第 ${shownWeek} 周`);
const all = courses.courses;
const cellFor = (period, weekday) => all.flatMap((course) => (course.sessions ?? [])
  .filter((s) => Number(s.weekday) === weekday
    && internals.isWeekActive(course, shownWeek)
    && Number(s.startPeriod) <= period && Number(s.endPeriod) >= period)
  .map((s) => ({ course, session: s })));
const maxPeriod = Math.max(12, ...all.flatMap((c) => (c.sessions ?? []).map((s) => Number(s.endPeriod) || 0)));
for (let period = 1; period <= maxPeriod; period += 1) {
  const row = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const items = cellFor(period, weekday);
    if (items.length > 0) row.push(`周${'一二三四五六日'[weekday - 1]}: ${items.map((i) => i.course.name).join('/')}`);
  }
  if (row.length > 0) console.log(`  第${String(period).padStart(2)}节  ${row.join('   ')}`);
}

// ---- 一键导入的解析预览（需求 ③） ----
console.log('\n' + '='.repeat(72));
console.log('【一键导入 DDL】用真实课程表解析示例文本');
console.log('='.repeat(72));
const sample = [
  '# 下面这些都是示例，不会写入任何文件',
  '第 3 次作业 | 数据结构 | 10/20 | 作业',
  '实验二预习报告 | 数电实验 | 明天 | 实验',
  '物理第 3 次作业 | 物理 | 下周五 | 作业 | 高',
  '英语单元小测 | 英语 | 10/24 | 考试',
  '离散数学第 2 次作业 | 离散 | 2026-10-27 | 作业',
  '这条会报错 | 不存在的课 | 10/20 | 作业',
].join('\n');
const parsed = internals.parseQuickTasks(sample, { courses: all, now: new Date() });
console.log(`\n识别到 ${parsed.items.length} 条，${parsed.errors.length} 行有问题\n`);
for (const item of parsed.items) {
  const course = all.find((c) => c.id === item.courseId);
  console.log(`  第 ${item._line} 行  →  「${item.title}」  科目=${course?.name ?? '未指定'}  截止=${item.due ?? '无'}  类型=${item.kind}  优先级=${item.priority}`);
}
for (const err of parsed.errors) console.log(`  ✗ 第 ${err.line} 行：${err.reason}`);
console.log(`\n结论：${parsed.ok ? '全部可解析，按钮会导入 ' + parsed.items.length + ' 条' : '有错误行 → 按钮禁用，不会写入一半'}`);
console.log(`（当前任务库里已有 ${tasks.tasks.length} 条任务，本脚本只读不写）`);
console.log(`\nflatten 自检：${flatten(half.DESCRIPTORS.internals ? 'ok' : 'bad')}`);
