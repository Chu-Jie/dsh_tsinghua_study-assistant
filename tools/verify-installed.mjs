/**
 * 端到端验收脚本（零依赖）
 * 运行：node tools/verify-installed.mjs
 *
 * 目的：在**真正安装到 profile 的那份产物**上，而不是工作区源码上，跑一遍完整链路：
 *   1. 加载已安装包，走 cordis 的 resolveConfig 逻辑校验配置；
 *   2. 用假 ctx 跑 apply()，确认路由与工具注册；
 *   3. 直接调用两个工具，确认返回真实数据；
 *   4. 用真实 http.Server 挂上路由，逐个请求接口，确认状态码与内容；
 *   5. 读一遍真实数据目录，确认演示数据在位、健康。
 *
 * 之所以需要它：install_bundle 替换已安装包后会返回 restart-required，
 * 而运行中的 Host 进程的 ESM 模块缓存不会自动重载。这个脚本用 Node 直接
 * 加载同一份文件，所以能证明「重启后就是可用的」，而不必等重启。
 *
 * 安全：只读真实数据目录与状态文件，不写任何作业数据。
 */

import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { makeTempDir, removeTempDir } from './temp-dir.mjs';
import { findDshPackageFile, describeSource, EXTRACT_HINT } from './_dsh-packages.mjs';

// 安装位置：先认「真的装了本插件」的那个 profile —— 否则在旧默认路径上会
// 找不到插件、把整轮验收判成失败（或更糟：对着旧代目录报绿）。
const PACKAGE = 'dsh-study-assistant';
const PROFILE_CANDIDATES = [
  process.env.DSH_PROFILE_DIR,
  path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'desktop'),
  // 旧桌面端（dsh-desktop 0.10.x）的 profile 位置，只作为候选、找不到就算了
  path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web'),
].filter((p) => typeof p === 'string' && p !== '');
const PROFILE_DIR = PROFILE_CANDIDATES.find(
  (p) => existsSync(path.join(p, 'node_modules', PACKAGE)),
) ?? PROFILE_CANDIDATES[0];
const INSTALLED = path.join(PROFILE_DIR, 'node_modules', PACKAGE);
const WORKSPACE = process.env.DSH_STUDY_WORKSPACE
  ?? path.resolve(import.meta.dirname, '..', '..', '..');
const DATA_DIR = path.join(WORKSPACE, '学习台');
const STATE_FILE = path.join(WORKSPACE, '_工具', '作业台状态.json');
const API_PREFIX = '/api/study-assistant';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
}

async function sha256File(file) {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== 0. 安装产物 ===');
  const entry = path.join(INSTALLED, 'index.js');
  const clientFile = path.join(INSTALLED, 'client.js');
  check('已安装 index.js 存在', await fs.access(entry).then(() => true, () => false), entry);
  check('已安装 client.js 存在', await fs.access(clientFile).then(() => true, () => false), clientFile);
  if (failed > 0) {
    console.log('\n安装产物缺失，后续检查跳过。请先运行 plugin_manager install_bundle。');
    process.exitCode = 1;
    return;
  }

  const stateHashBefore = await sha256File(STATE_FILE);

  // 1) 加载已安装包
  console.log('\n=== 1. 加载已安装包并校验配置（走 cordis 的 resolveConfig 逻辑）===');
  const host = await import(pathToFileURL(entry).href);
  check('导出 apply 函数', typeof host.apply === 'function');
  check('导出 name = study-assistant', host.name === 'study-assistant');
  check('inject 含 tools 与 webServer', Array.isArray(host.inject)
    && host.inject.includes('tools') && host.inject.includes('webServer'));

  // 逐字复制 cordis/lib/index.js 的 resolveConfig
  function resolveConfig(runtime, config) {
    if (!runtime.Config) return config;
    const result = runtime.Config['~standard'].validate(config);
    if ('then' in result) throw new TypeError('Async config validation is not supported');
    if (result.issues) throw new Error(`invalid config: ${JSON.stringify(result.issues)}`);
    return result.value;
  }
  let resolved = null;
  let resolveError = null;
  try {
    resolved = resolveConfig(host, { dataDir: DATA_DIR, backupKeep: 10, locale: 'zh', gpaMode: '4.0-weighted' });
  } catch (error) {
    resolveError = error;
  }
  check('配置解析成功（这正是此前激活失败的那一步）', resolveError === null, resolveError?.message);
  check('dataDir 解析正确', resolved?.dataDir === DATA_DIR, resolved?.dataDir);

  // 2) 假 ctx 跑 apply
  console.log('\n=== 2. 用假 ctx 运行 apply() ===');
  const registrations = { routes: [], tools: [], effects: [] };
  const ctx = {
    logger: { info() {}, error() {} },
    effect(callback, label) {
      const dispose = callback();
      registrations.effects.push({ label, dispose });
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    webServer: {
      register(route) {
        registrations.routes.push(route);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        registrations.tools.push(definition);
        return () => {};
      },
    },
  };
  host.apply(ctx, resolved);

  const routePaths = registrations.routes.map((r) => `${r.kind ?? 'exact'}:${r.path}`);
  check('只注册一条 prefix 路由（逐条注册 exact 会让 /learn/* 全部 404）',
    registrations.routes.length === 1
      && registrations.routes[0].kind === 'prefix'
      && registrations.routes[0].path === API_PREFIX,
    routePaths.join(', '));

  // 契约检查：handler 里实现的每条相对路径都必须被已注册路由覆盖。
  // 这一条是「注册清单」与「handler 实现」之间唯一的自动对账点，
  // 上一版脚本把错的清单写死成断言，反而锁住了缺陷。
  const apiSource = await fs.readFile(path.join(INSTALLED, 'lib', 'api.js'), 'utf8');
  const handlerPaths = [...new Set([...apiSource.matchAll(/rest === '([^']+)'/g)].map((m) => m[1]))]
    .map((sub) => `${API_PREFIX}${sub}`);
  const uncovered = handlerPaths.filter((h) => !registrations.routes.some(
    (r) => (r.kind ?? 'exact') === 'prefix' && (h === r.path || h.startsWith(`${r.path}/`))));
  check(`handler 实现的 ${handlerPaths.length} 条路径全部被已注册路由覆盖`, uncovered.length === 0, uncovered.join(', '));
  check('契约里含 /learn/status', handlerPaths.includes(`${API_PREFIX}/learn/status`));
  check('契约里含 /learn/semester', handlerPaths.includes(`${API_PREFIX}/learn/semester`));

  const toolNames = registrations.tools.map((t) => t.name);
  check('注册了 study_status', toolNames.includes('study_status'), toolNames.join(', '));
  check('注册了 study_overview', toolNames.includes('study_overview'));
  check('所有工具都有 output.render', registrations.tools.every((t) => typeof t.output?.render === 'function'));

  // 用**生产环境的校验器本身**校验工具 schema。
  // 这是本脚本最重要的一项：类型数组（type: ['string','null']）会让
  // assertSupportedJsonSchema 抛 JsonSchemaError；插件又是 required 行，
  // 于是整个 DSH 启动失败、桌面端进安全模式——本会话真实发生过一次。
  // 所以不能只用「照抄的规则」，必须跑官方那份代码 —— 而且必须是**新版**那份：
  // 这里原先写死 `D:\DSH Desktop\...`（0.10.0 的旧安装），在 DSH 3 下属于假绿。
  const toolsEntry = findDshPackageFile(['@deepseek-ai', 'dsh-tools', 'lib', 'index.js']);
  let assertSupported;
  if (toolsEntry === null) {
    console.log(`  ! 找不到 dsh-tools 包，本项按跳过处理。${EXTRACT_HINT}`);
  } else {
    console.log(`  ${describeSource(toolsEntry).split('\n').join('\n  ')}`);
    try {
      const toolsPkg = await import(pathToFileURL(toolsEntry.file).href);
      assertSupported = toolsPkg.assertSupportedJsonSchema;
    } catch (error) {
      assertSupported = undefined;
      console.log(`  ! 未能加载生产校验器（${error?.message ?? error}），本项按跳过处理`);
    }
  }
  if (typeof assertSupported === 'function') {
    for (const tool of registrations.tools) {
      let failure = null;
      try {
        assertSupported(tool.output.schema);
        assertSupported(tool.parameters);
      } catch (error) {
        failure = error?.message ?? String(error);
      }
      check(`${tool.name} 通过生产版 assertSupportedJsonSchema`, failure === null, failure);
    }
  }

  // 3) 直接调用工具
  console.log('\n=== 3. 直接调用两个工具 ===');
  const statusTool = registrations.tools.find((t) => t.name === 'study_status');
  const overviewTool = registrations.tools.find((t) => t.name === 'study_overview');

  const status = await statusTool.execute({}, {});
  check('study_status 报告健康', status.healthy === true, JSON.stringify(status.files?.map((f) => f.reason)));
  check('study_status 看到十一份文件', status.files.length === 11, `实际 ${status.files.length} 份`);
  const statusText = statusTool.output.render({}, status)[0].text;
  check('study_status 渲染出文本', typeof statusText === 'string' && statusText.includes('总体状态'));

  // 期望值全部从真实数据文件现读，不写死数字。
  // 之前这里写死的是「2026 秋（演示）/ 4 门课 / 6 个未完成任务 / 含 79 分」，
  // 那是演示数据的期望值；换成真实数据后这些断言必然失败，
  // 而失败原因跟插件本身无关——写死期望值会把「数据变了」误报成「代码坏了」。
  const readDoc = async (name) => JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8'));
  const termDoc = await readDoc('学期.json');
  const coursesDoc = await readDoc('课程.json');
  const tasksDoc = await readDoc('任务.json');
  const gradesDoc = await readDoc('成绩.json');
  const expectTerm = termDoc.terms.find((t) => t.id === termDoc.currentId) ?? termDoc.terms[0];
  const expectCourses = coursesDoc.courses.length;
  const expectActive = tasksDoc.tasks.filter((t) => t.status !== 'done').length;
  const expectScored = gradesDoc.courses.filter((g) => typeof g.score === 'number').length;

  const overview = await overviewTool.execute({}, {});
  check(`study_overview 读到 ${expectCourses} 门课（与课程.json 一致）`, overview.counts.courses === expectCourses, `${overview.counts.courses} vs ${expectCourses}`);
  check(`study_overview 读到 ${expectActive} 个未完成任务（与任务.json 一致）`, overview.counts.activeTasks === expectActive, `${overview.counts.activeTasks} vs ${expectActive}`);
  check(`study_overview 读到学期「${expectTerm.name}」（与学期.json 一致）`, overview.term?.name === expectTerm.name, overview.term?.name);
  check('study_overview 读到的教学周与学期起始日自洽', overview.overview.week >= 1, String(overview.overview.week));
  // GPA：只有真的存在带分数的成绩时才要求算得出来，否则应为「暂无成绩」
  if (expectScored > 0) {
    check(`GPA 已算出（成绩.json 有 ${expectScored} 门带分数）`, typeof overview.overview.gpa.gpa === 'number', String(overview.overview.gpa.gpa));
    check('未计入学分的条目被显式列出而非静默算 0', Array.isArray(overview.overview.gpa.skipped), JSON.stringify(overview.overview.gpa.skipped?.length));
  } else {
    check('暂无成绩时 GPA 为 null 且不伪造 0', overview.overview.gpa.gpa === null, String(overview.overview.gpa.gpa));
    check('未计入学分的条目被显式列出（空数组也算合规）', Array.isArray(overview.overview.gpa.skipped), JSON.stringify(overview.overview.gpa.skipped));
  }
  const overviewText = overviewTool.output.render({}, overview)[0].text;
  check('study_overview 渲染出教学周', /第 \d+ 教学周/.test(overviewText), overviewText.split('\n')[0]);

  // 4) 真实 HTTP 往返
  console.log('\n=== 4. 真实 HTTP 往返（真实 http.Server）===');
  const server = http.createServer((req, res) => {
    // 必须照抄宿主 `dsh-host-webserver` 的 match() 语义：
    // exact 表按路径完全相等匹配；prefix 表要求 pathname === prefix
    // 或 pathname.startsWith(prefix + '/')。
    // 上一版这个假分发只做「完全相等」，于是「逐条注册 exact」的缺陷
    // 在验收脚本里也是绿的 —— 真机上 /learn/* 全部 404，脚本却全过。
    const pathname = new URL(req.url, 'http://x').pathname;
    const kindOf = (r) => r.kind ?? 'exact';
    const match = registrations.routes.find((r) => kindOf(r) === 'exact' && r.path === pathname)
      ?? registrations.routes.find((r) => kindOf(r) === 'prefix'
        && (pathname === r.path || pathname.startsWith(`${r.path}/`)));
    if (match === undefined) {
      res.writeHead(404).end();
      return;
    }
    Promise.resolve(match.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

  try {
    const health = await fetch(`${base}/health`);
    check('GET /health → 200', health.status === 200, String(health.status));
    const healthBody = await health.json();
    check('/health 返回 ok:true', healthBody.ok === true);

    const state = await fetch(`${base}/state`);
    const stateBody = await state.json();
    check('GET /state → 200 且带十一份数据', state.status === 200 && ['term', 'courses', 'tasks', 'grades', 'homework', 'materials', 'questions', 'knowledgeCandidates', 'knowledgeNetwork', 'knowledgeOutline', 'knowledgeAnalysis'].every((k) => stateBody.docs[k] !== undefined));
    check('/state 返回每份文档的 sha256', typeof stateBody.hashes?.courses === 'string' && typeof stateBody.hashes?.homework === 'string');

    const overviewRes = await fetch(`${base}/overview`);
    const overviewBody = await overviewRes.json();
    check(`GET /overview → 200 且计数与课程.json 一致（${expectCourses}）`, overviewRes.status === 200 && overviewBody.counts.courses === expectCourses, `${overviewBody.counts?.courses} vs ${expectCourses}`);

    // 回归：/learn/* 曾经因为只注册 exact 而整族 404（真机反馈过）。
    // 现在必须是「请求到达 handler」——GET 拿 200，POST 缺自定义头拿 403（不是 404）。
    const learnStatus = await fetch(`${base}/learn/status`);
    const learnBody = learnStatus.status === 200 ? await learnStatus.json() : {};
    check('GET /learn/status → 200（不再是 404）', learnStatus.status === 200, String(learnStatus.status));
    check('/learn/status 返回 connected 布尔值与可选学期数组',
      typeof learnBody.connected === 'boolean' && Array.isArray(learnBody.semesters),
      JSON.stringify({ connected: learnBody.connected, semesters: learnBody.semesters?.length }));

    const learnSyncNoHeader = await fetch(`${base}/learn/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('POST /learn/sync 缺自定义头 → 403（路由已注册，不是 404）', learnSyncNoHeader.status === 403, String(learnSyncNoHeader.status));

    const learnSemesterNoHeader = await fetch(`${base}/learn/semester`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ semesterId: '2026-2027-1' }),
    });
    check('POST /learn/semester 缺自定义头 → 403（路由已注册，不是 404）', learnSemesterNoHeader.status === 403, String(learnSemesterNoHeader.status));

    // 写请求：先确认防护生效，再用临时目录里的数据做一次真实写入（不碰真实数据）
    const noHeader = await fetch(`${base}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: 'tasks', action: 'create', item: { title: 'x' } }),
    });
    check('缺自定义头 → 403（挡住跨站表单提交）', noHeader.status === 403, String(noHeader.status));

    const crossSite = await fetch(`${base}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Study-Request': '1', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ doc: 'tasks', action: 'create', item: { title: 'x' } }),
    });
    check('跨站来源 → 403', crossSite.status === 403, String(crossSite.status));

    const badDoc = await fetch(`${base}/state?doc=../../etc/passwd`);
    check('路径穿越式 doc 参数 → 400', badDoc.status === 400, String(badDoc.status));

    // 真实写入走临时数据目录，避免动到演示数据
    const tmpDir = await makeTempDir('study-verify-');
    const { createStore } = await import(pathToFileURL(path.join(INSTALLED, 'lib', 'store.js')).href);
    const store = createStore(tmpDir);
    await store.init();
    const read = await store.readDocument('tasks');
    const written = await store.writeDocument('tasks', { ...read.doc, tasks: [{ id: 't_verify', title: '验收写入' }] }, { expectedHash: read.hash, backupKeep: 3 });
    check('临时目录写入成功', written.ok === true, written.reason);
    const reread = await store.readDocument('tasks');
    check('重新读出内容一致', reread.doc.tasks[0]?.title === '验收写入');
    const conflict = await store.writeDocument('tasks', { ...reread.doc, tasks: [] }, { expectedHash: read.hash });
    check('过期 sha256 → 拒绝写入（conflict）', conflict.ok === false && conflict.reason === 'conflict', conflict.reason);
    await removeTempDir(tmpDir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 5) 边界承诺
  console.log('\n=== 5. 边界承诺 ===');
  const stateHashAfter = await sha256File(STATE_FILE);
  check('_工具/作业台状态.json 未被改动', stateHashAfter === stateHashBefore, `${stateHashBefore} → ${stateHashAfter}`);
  const dataFiles = await fs.readdir(DATA_DIR);
  check('学习台十一份数据在位', ['学期.json', '课程.json', '任务.json', '成绩.json', '作业.json', '资料索引.json', '题目.json', '知识点候选.json', '知识点网络.json', '知识点大纲.json', '资料分析.json'].every((f) => dataFiles.includes(f)), dataFiles.join(', '));
  check('备份目录存在', dataFiles.includes('备份'));

  console.log(`\n=== 结果：${passed} 项通过，${failed} 项失败 ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`验收脚本异常：${error?.stack ?? error}`);
  process.exitCode = 1;
});
