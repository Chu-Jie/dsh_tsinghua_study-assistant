// 从学生端首页 HTML 里挖出学生视角的接口路径与每个课堂的计数。
//
// 背景：最早那份可行性报告只能从 /res/js/common.js 里挖路径，而那**是教师端脚本**，
// 挖到的都带 teacher 段，不能确认学生端叫什么。用户把登录后的学生端首页 HTML 存下来后，
// 才第一次看到真正的学生视角路径。
//
// 用法：
//   node tools/mine-learn-student.mjs <首页.html> [更多.html ...]
// 不带参数则读 .probe-learn/ 下所有 .html
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_DIR = path.join(import.meta.dirname, '..', '.probe-learn');

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : (existsSync(PROBE_DIR)
    ? readdirSync(PROBE_DIR).filter((f) => f.endsWith('.html')).map((f) => path.join(PROBE_DIR, f))
    : []);

if (files.length === 0) {
  console.log('没有找到 HTML 文件。把一个登录后的页面存到 .probe-learn/ 下，或作为参数传入。');
  process.exit(0);
}

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  console.log(`\n===== ${path.basename(file)} (${html.length} 字符) =====`);

  // 1) 所有 /f/ 与 /b/ 链接，按出现次数排序
  const links = new Map();
  for (const m of html.matchAll(/["'\s(](\/[fb]\/[A-Za-z0-9_\-/]+)(\?[^"'\s)]*)?/g)) {
    const base = m[1];
    const entry = links.get(base) ?? { count: 0, sampleQuery: m[2] ?? '' };
    entry.count++;
    if (!entry.sampleQuery && m[2]) entry.sampleQuery = m[2];
    links.set(base, entry);
  }

  const sorted = [...links.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\n--- 接口路径（共 ${sorted.length} 个）---`);
  for (const [p, info] of sorted) {
    const role = /\/(student|teacher|xs)\//.exec(p)?.[1] ?? '';
    const tag = role === 'student' ? '[学生]' : role === 'teacher' ? '[教师]' : '';
    console.log(`  ${tag.padEnd(7)}×${String(info.count).padEnd(4)} ${p}${info.sampleQuery.slice(0, 60)}`);
  }

  // 2) 学生视角 /b/ 数据接口（形态 /b/wlxt/<模块>/<实体>/student/<动作>）
  const studentApis = [...new Set(
    [...html.matchAll(/\/b\/wlxt[A-Za-z0-9_\-/]*\/student\/[A-Za-z0-9_]+/g)].map((m) => m[0]),
  )].sort();
  if (studentApis.length > 0) {
    console.log(`\n--- 学生视角 /b/ 数据接口（${studentApis.length} 个）---`);
    for (const p of studentApis) console.log(`  ${p}`);
  }

  // 3) 每个课堂的 wlkcid + 课程名 + 各栏目计数
  //    首页的 .item 块里：hidden .wlkcid、title 属性里的课程名、zyundo 是未提交作业数
  const courses = [];
  for (const block of html.matchAll(/<div class="item ">([\s\S]*?)<\/ul>\s*<\/div>/g)) {
    const seg = block[1];
    const wlkcid = /class="wlkcid" type="hidden" value="([^"]+)"/.exec(seg)?.[1];
    const name = /class="title">([^<]+)</.exec(seg)?.[1];
    const teacher = /class="teacherName">([^<]*)</.exec(seg)?.[1];
    const sched = /class="d222"[\s\S]*?title="([^"]*)"/.exec(seg)?.[1];
    const count = (cls) => {
      const m = new RegExp(`class="${cls}">\\s*([0-9]+)\\s*<`).exec(seg);
      return m ? Number(m[1]) : null;
    };
    // 页面里的 <script type="text/html"> 模板也会被扫到，它的 kcid 是 {{value.kcid}}，
    // 不是真实课堂号 —— 必须排除，否则会把模板当成第 N 门课报出来。
    if (wlkcid && !wlkcid.includes('{{')) {
      courses.push({
        wlkcid, name, teacher, sched,
        gg: count('ggundo'), kj: count('kjundo'),
        zy: count('zyundo'), tl: count('tlundo'), dy: count('dyzs'), wj: count('xwjs'),
      });
    }
  }

  if (courses.length > 0) {
    console.log(`\n--- 课堂（${courses.length} 门）---`);
    for (const c of courses) {
      console.log(`  ${c.wlkcid}  ${c.name}`);
      console.log(`      教师=${c.teacher ?? '?'}  未提交作业=${c.zy ?? '?'}  未浏览公告=${c.gg ?? '?'}  未浏览课件=${c.kj ?? '?'}`);
      console.log(`      排课=${c.sched ?? '?'}`);
    }
  }

  // 4) 敏感项提醒：学生端首页会带学号、姓名、邮箱，别把它们写进任何提交物
  const sensitive = [];
  if (/id="userid"[^>]*value="[^"]+"/.test(html)) sensitive.push('学号 (id="userid")');
  if (/@mails?\.tsinghua\.edu\.cn/.test(html)) sensitive.push('校内邮箱');
  if (/class="teacher-logo"/.test(html) && /同学/.test(html)) sensitive.push('姓名');
  if (sensitive.length > 0) {
    console.log(`\n⚠ 这个页面含个人信息（${sensitive.join('、')}）。不要把 HTML 原文或这些值写进报告、日志、提交物。`);
  }
}
