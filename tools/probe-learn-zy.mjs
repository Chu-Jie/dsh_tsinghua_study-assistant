// 用会话 cookie 读学生端**真实作业数据**，固认证方式、验字段、预览将导入什么。
//
// 实探确认的请求形状（读平台自己的 JS 得出的，不是猜的）：
//
//   课程列表（两段式）：
//     GET  /b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq                       → 学期串数组
//     GET  /b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/<学期>/zh_CN?timestamp=<ms>
//                                                                            → 课程数组
//
//   作业列表（DataTables 服务端分页，**必须 POST**）：
//     POST /b/wlxt/kczy/zy/student/zyListWj?_csrf=<token>                     未提交
//     POST /b/wlxt/kczy/zy/student/zyListYjwg?_csrf=<token>                   已提交未批改
//     POST /b/wlxt/kczy/zy/student/zyListYpg?_csrf=<token>                    已批改
//     body: application/x-www-form-urlencoded，单个参数
//           aoData = JSON.stringify([{name:'wlkcid', value:'<课堂号>'}, ...])
//
// 三条缺一不可：① 必须 POST（GET 一律 400）；② `wlkcid` 必须放进 `aoData`
// （空的 aoData 也返回 200，但那是不分学期的全部作业，会静默导入一堆陈年数据）；
// ③ URL 要带 `_csrf`。证据在 tools/probe-learn-zy-shape.mjs 里，六种形状各测过一次。
//
// 认证：`/f/**` 只用 Cookie 就够；**`/b/**` 缺 `X-XSRF-TOKEN` 会 403**。
// 所以用户必须把 `JSESSIONID` 和 `XSRF-TOKEN` 一起复制。`--auth` 会把两种方式
// 的结果分开摆出来，而不是只报「最终成功了没有」。
//
// 本脚本**直接调用 lib/learn.js**（`fetchLearnCourses` / `fetchHomeworkForCourses` /
// `pickRows` / `normalizeDue` / `buildCandidates`），因此它跑通就等于插件那条代码
// 路径跑通，而不是「另写一套只在探针里对的解析」。
//
// 用法（cookie 只从环境变量读，绝不落盘）：
//   $env:LEARN_COOKIE = "JSESSIONID=xxxx; XSRF-TOKEN=yyyy"
//   node tools/probe-learn-zy.mjs --list                          # 只列课堂，不拉作业
//   node tools/probe-learn-zy.mjs --auth 2026-2027-1152225553     # 两种认证各试一次
//   node tools/probe-learn-zy.mjs 2026-2027-1152225553            # 拉一门课的三个列表
//   node tools/probe-learn-zy.mjs --debug <课堂号>                 # 附原始 JSON 片段
//   node tools/probe-learn-zy.mjs --semester=2025-2026-2          # 指定学期
//
// 只发 GET 与「读列表用的 POST」。不碰 /tijiao、/add、/delete、/edit、/upload
// 等任何写接口 —— 这里的 POST 是查询语义，服务端就是拿它当查询用的。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  LEARN_BASE,
  LEARN_LISTS,
  learnHeaders,
  withCsrfQuery,
  aoDataOf,
  fetchLearnIndex,
  fetchLearnCourses,
  fetchHomeworkForCourses,
  buildCandidates,
  diffCandidates,
  normalizeDue,
  rowKey,
  stripCourseCode,
} from '../lib/learn.js';

const OUT_DIR = path.join(import.meta.dirname, '..', '.probe-learn');
/** 本地学习台数据目录 —— 用来预览「学堂课程 → 本地课程 id」会怎么映射。 */
const LOCAL_COURSES = path.join(import.meta.dirname, '..', '..', '..', '学习台', '课程.json');

function save(name, content) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 摊平字段结构：键路径 + 类型 + 样例值，用来确认截止时间字段到底叫什么、什么单位。 */
function shape(value, prefix = '', out = [], depth = 0) {
  if (depth > 3) return out;
  if (Array.isArray(value)) {
    out.push(`${prefix}[] 长度 ${value.length}`);
    if (value.length > 0) shape(value[0], `${prefix}[0].`, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && typeof v === 'object') shape(v, `${prefix}${k}.`, out, depth + 1);
      else {
        const s = typeof v === 'string' ? v.slice(0, 60) : String(v);
        out.push(`${prefix}${k}  (${v === null ? 'null' : typeof v})  = ${s}`);
      }
    }
    return out;
  }
  out.push(`${prefix}  = ${String(value).slice(0, 60)}`);
  return out;
}

/**
 * 原样两种认证各打一次，专门用来回答「到底要不要 X-XSRF-TOKEN」。
 *
 * 这里**不走 `learnRequest`**：那个函数会自己在 403 时升级认证，
 * 结果被合并成「最终成功的方式」，看不出「仅 Cookie 究竟行不行」。
 * 要定论就必须把两种方式的结果分开摆出来。
 *
 * 注意这里发的是**作业接口真正的形状**（POST + aoData + _csrf）——
 * 早前那次用 GET 去比认证，两种方式都返回 400，什么也定论不了。
 */
async function compareAuth(wlkcid) {
  const modes = [{ name: '仅 Cookie', withXsrf: false }];
  if (/XSRF-TOKEN=([^;]+)/.test(cookie)) modes.push({ name: 'Cookie+XSRF', withXsrf: true });
  const body = new URLSearchParams({ aoData: JSON.stringify(aoDataOf([{ name: 'wlkcid', value: wlkcid }])) });
  const out = [];
  for (const mode of modes) {
    let status = 0;
    let chars = 0;
    let looksJson = false;
    let note = '';
    try {
      const res = await fetch(LEARN_BASE + withCsrfQuery('/b/wlxt/kczy/zy/student/zyListWj', cookie), {
        method: 'POST',
        headers: { ...learnHeaders(cookie, mode.withXsrf), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'manual',
      });
      const text = await res.text();
      status = res.status;
      chars = text.length;
      looksJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
      const location = res.headers.get('location');
      if (location !== null) note = `Location: ${location}`;
    } catch (error) {
      note = `请求失败：${String(error?.message ?? error)}`;
    }
    out.push({ mode: mode.name, status, chars, looksJson, note });
  }
  return out;
}

/** 读本地课程列表（只读，用于预览映射）；读不到就返回空数组。 */
function readLocalCourses() {
  try {
    const doc = JSON.parse(readFileSync(LOCAL_COURSES, 'utf8'));
    return Array.isArray(doc.courses) ? doc.courses : [];
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const listOnly = args.includes('--list');
const authOnly = args.includes('--auth');
const semesterArg = args.find((a) => a.startsWith('--semester='));
const semverId = semesterArg === undefined ? null : semesterArg.slice('--semester='.length);
const targets = args.filter((a) => !a.startsWith('--'));

const cookie = process.env.LEARN_COOKIE ?? '';

async function main() {
  if (cookie === '') {
    console.log('缺少 LEARN_COOKIE。先设置：');
    console.log('  $env:LEARN_COOKIE = "JSESSIONID=...; XSRF-TOKEN=..."');
    console.log('  取法：在这个浏览器登录 learn.tsinghua.edu.cn → F12 → Network → 刷新 →');
    console.log('        点任意一个发往 learn.tsinghua.edu.cn 的请求 → Headers →');
    console.log('        Request Headers 里的 Cookie 行 → 右键 → Copy value。');
    console.log('  两个都要带：/b/** 接口缺 XSRF-TOKEN 会被 403。');
    return 1;
  }

  // ─────────────────────────── 验活 ───────────────────────────
  const index = await fetchLearnIndex(cookie);
  console.log(`验活 GET /f/wlxt/index/course/student/ → HTTP ${index.status}${index.location ? `  Location: ${index.location}` : ''}  认证方式：${index.authUsed}`);
  if (!index.alive) {
    console.log('  → cookie 已失效（HTTP 200 但没有 id="userid"，说明被换成了登录页）。');
    console.log('    重新登录网络学堂，再复制新的 JSESSIONID / XSRF-TOKEN。');
    return 1;
  }
  console.log(`  → cookie 有效。${index.text.length} 字节`);

  // ─────────────────────── 课程列表（真接口） ───────────────────────
  // 早前这里读的是首页 HTML 里的课程列表 —— 但那个列表是 JS 模板
  // （`value="{{value.kcid}}"`），真机永远扫出 0 门。真接口是这个两段式的。
  console.log('\n拉课程列表（queryxnxq → loadCourseBySemesterId）…');
  const listed = await fetchLearnCourses(cookie, { semesterId: semverId });
  if (listed.error !== null) {
    console.log(`  ⚠ 失败：${listed.error}`);
    if (listed.error.startsWith('semesters-http-403') || listed.error.startsWith('courses-http-403')) {
      console.log('    403 说明缺少 X-XSRF-TOKEN —— 把 XSRF-TOKEN 也一起复制进 LEARN_COOKIE。');
    }
  }
  console.log(`  学期（${listed.semesters.length} 个）：${listed.semesters.join('  ') || '(无)'}`);
  console.log(`  当前使用：${listed.semesterId ?? '(无)'}   认证方式：${listed.authUsed}`);
  console.log(`\n我的课堂（${listed.courses.length} 门）：`);
  for (const c of listed.courses) console.log(`  ${c.wlkcid}  ${c.name}${c.credits === null ? '' : `  ${c.credits} 学分`}`);
  const nameMap = {};
  for (const c of listed.courses) nameMap[c.wlkcid] = c.name;

  if (listOnly) {
    console.log('\n（--list 模式：只列课堂，未请求任何作业接口）');
    return 0;
  }

  const wanted = targets.length > 0 ? targets : listed.courses.map((c) => c.wlkcid);
  if (wanted.length === 0) {
    console.log('\n没有课堂可探。把课堂号作为参数传进来，或先修好课程列表接口。');
    return 0;
  }
  if (targets.length === 0) console.log(`\n（未指定课堂号，默认探全部 ${wanted.length} 门）`);

  // ─────────────────────────── 定论认证方式 ───────────────────────────
  if (authOnly || debug) {
    console.log('\n=========== 认证方式定论（同一个 POST 请求 × 两种方式）===========');
    for (const target of wanted.slice(0, 3)) {
      const rows = await compareAuth(target);
      console.log(`\n  ${nameMap[target] ?? target}  ${target}`);
      for (const r of rows) {
        const verdict = r.status === 200 && r.looksJson ? '✅ 可用' : r.status === 403 ? '❌ 403 被拒' : r.status === 200 ? '⚠ 200 但不是 JSON' : `HTTP ${r.status}`;
        console.log(`    ${r.mode.padEnd(12)} → ${verdict}  ${r.chars} 字符  ${r.note}`);
      }
    }
    console.log('\n  结论读法：只有「仅 Cookie」可用 → 用户只需粘 JSESSIONID；');
    console.log('            「仅 Cookie」403 而「Cookie+XSRF」可用 → 必须两个都粘。');
    if (authOnly) return 0;
  }

  // ─────────────────────────── 逐课堂拉三个列表 ───────────────────────────
  const targetList = wanted.map((wlkcid) => ({ wlkcid, name: nameMap[wlkcid] ?? '' }));
  const fetched = await fetchHomeworkForCourses(targetList, cookie);

  const rawByCourse = {};
  let failed = 0;
  for (const entry of fetched) {
    const okText = entry.error === null || entry.error === undefined ? '成功' : String(entry.error);
    console.log(`\n  [${entry.label}] ${entry.wlkcid}  ${okText}  行数 ${entry.rows.length}  认证 ${entry.authUsed}`);
    // 出错项没有 topKeys（早期版本这里直接 .length，在真机上 TypeError 把整个脚本崩掉）
    if (Array.isArray(entry.topKeys) && entry.topKeys.length > 0) console.log(`    顶层键：${entry.topKeys.join(', ')}`);
    if (entry.error !== null && entry.error !== undefined) {
      failed += 1;
      console.log(`    ⚠ ${entry.error}${entry.message ? `  ${entry.message}` : ''}`);
      continue;
    }
    if (entry.total !== undefined && entry.total !== null) console.log(`    服务端记录数：${entry.total}`);
    if (entry.rows.length === 0) continue;

    const first = entry.rows[0];
    console.log('    字段结构（取第一条）：');
    for (const line of shape(first)) console.log(`      ${line}`);

    const due = normalizeDue(first);
    console.log(`    截止判定：${due.value ?? '(认不出来)'}  来源 ${due.source ?? '-'}  补交 ${due.grace ?? '-'}`);
    console.log(`    去重键：${rowKey(first)}`);
    // 行内自带课程名（wlkcm），可用来交叉验证课堂号有没有挂错
    if (first.wlkcm !== undefined) console.log(`    行内课程名 wlkcm：${first.wlkcm}`);
    if (first.jzsj !== undefined && first.jzsjStr !== undefined) {
      console.log(`    jzsj=${first.jzsj} ↔ jzsjStr=${first.jzsjStr}（毫秒时间戳、按 +08:00 显示）`);
    }

    rawByCourse[`zy-${entry.wlkcid}-${entry.listKey}`] = entry.rows;
    if (debug) console.log(`    原始首行 JSON：${JSON.stringify(first).slice(0, 800)}`);
  }

  for (const [name, rows] of Object.entries(rawByCourse)) save(`${name}.json`, JSON.stringify(rows, null, 2));

  // ─────────────────── 预览：插件这一趟会导入什么 ───────────────────
  const courses = readLocalCourses();
  const { candidates, ambiguous } = buildCandidates(fetched, courses, { now: new Date() });
  console.log('\n=========== 导入预览 ===========');
  console.log(`本地课程 ${courses.length} 门${courses.length === 0 ? '（读不到 学习台/课程.json，课程映射只能显示为未匹配）' : ''}`);
  console.log(`候选 ${candidates.length} 条`);
  if (failed > 0) console.log(`⚠ 有 ${failed} 个接口没取到数据，其余已正常读取（网络学堂经常个别抽风，不当整体失败）。`);

  if (ambiguous.length > 0) {
    console.log('\n⚠ 这些课堂没能对上本地课程，导入后 courseId 会是空：');
    for (const a of ambiguous) {
      const ways = a.how === 'ambiguous' ? `（多门候选：${a.candidates.map((c) => c.name).join('、')}）` : '（本地没有同名课程）';
      console.log(`  ${a.wlkcid}  ${a.learnName}  → ${stripCourseCode(a.learnName) || '(空)'}  ${ways}`);
    }
  }

  const existing = readLocalTasks();
  const { created: fresh } = diffCandidates(existing, candidates);
  for (const c of candidates) {
    const flag = c.expired ? '已过期 ' : '待完成 ';
    const course = c.courseId ?? '未匹配';
    console.log(`  ${flag}${(c.due ?? '(无截止)').padEnd(18)} [${course}] ${c.title}   ${c.kind}`);
  }
  if (fresh.length > 0) save('open-homework.json', JSON.stringify(fresh, null, 2));
  console.log(`\n  其中未过期 ${candidates.filter((c) => !c.expired).length} 条，已过期 ${candidates.filter((c) => c.expired).length} 条。`);
  console.log(`  本地已有任务 ${existing.length} 条，按 note 里的 [learn:...] 记号去重后，真机同步会新建 ${fresh.length} 条。`);

  console.log(`\n产物：${OUT_DIR}`);
  console.log('⚠ 含作业内容，可能含个人信息，确认完请删掉整个 .probe-learn/ 目录。');
  return 0;
}

/** 读本地任务（只读），用来算「去重后真正会新建几条」。 */
function readLocalTasks() {
  try {
    const file = path.join(import.meta.dirname, '..', '..', '..', '学习台', '任务.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(doc.tasks) ? doc.tasks : [];
  } catch {
    return [];
  }
}

// 不用 process.exit()：在 Windows 上 undici 的异步句柄正在关闭时强退会触发
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
// 并让退出码变成 0xC0000409。设 exitCode 再正常返回就没这个问题。
process.exitCode = await main();
