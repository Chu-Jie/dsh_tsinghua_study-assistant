// 校验「单双周 + 星期几」的课表过滤是否符合预期。
// 全用 UTC 日期算术，避开时区把「本地午夜」折算成前一天的问题。
// 用法：node tools/check-week-parity.mjs [起始日期 yyyy-MM-dd] [天数]
import { readFileSync } from 'node:fs';
import { parseWeeks } from '../lib/core.js';

const DATA = 'D:/workspace/作业/学习台';
const courses = JSON.parse(readFileSync(`${DATA}/课程.json`, 'utf8')).courses;
const term = JSON.parse(readFileSync(`${DATA}/学期.json`, 'utf8'));
const cur = term.terms.find((t) => t.id === term.currentId) ?? term.terms[0];

const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY = 86400000;
const utc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const startMs = utc(cur.startDate);
const fromIso = process.argv[2] ?? isoOf(Date.UTC(
  new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(),
));
const days = Number(process.argv[3] ?? 14);
const fromMs = utc(fromIso);

console.log(`学期 ${cur.name}  开学 ${cur.startDate}（第 1 周周一）  共 ${cur.totalWeeks} 周`);
console.log(`起点 ${fromIso}，往后 ${days} 天\n`);

for (let i = 0; i < days; i += 1) {
  const ms = fromMs + i * DAY;
  const iso = isoOf(ms);
  const dayIdx = Math.round((ms - startMs) / DAY);
  const week = Math.floor(dayIdx / 7) + 1;
  const wd = (dayIdx % 7) + 1; // 开学日是周一 → 偏移 0 即周一
  const even = week % 2 === 0;
  const hit = [];
  for (const course of courses) {
    for (const s of course.sessions) {
      if (s.weekday !== wd) continue;
      const parsed = parseWeeks(s.weeks);
      if (!parsed.ok || !parsed.weeks.includes(week)) continue;
      hit.push(`${course.name} 第${s.startPeriod}-${s.endPeriod}节 ${s.location}`);
    }
  }
  console.log(`${iso} ${DAY_NAMES[wd]} 第${week}周(${even ? '双' : '单'})  ${hit.length === 0 ? '—' : hit.join(' | ')}`);
}
