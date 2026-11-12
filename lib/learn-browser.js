/**
 * 用系统自带的 Edge 维持网络学堂会话（零依赖）。
 *
 * ## 为什么需要它
 *
 * 网络学堂的会话是「一段时间不操作就失效」。插件里存的 Cookie 是**手动复制**来的
 * 快照，过期后只能靠用户再粘一次 —— 实测活不到一天，用户明确说「最好完全不用管」。
 *
 * 自动登录走不通：统一身份认证的登录表单要**图形验证码**，密码还要 SM2 公钥加密
 * （`sm2Util.js`），没有人工介入过不去。直接从 Edge 的 Cookie 数据库里读也不行：
 * Chromium 的 App-Bound 加密密钥只有浏览器进程能解，绕过它属于「会被杀软拦下的
 * 那类做法」，本插件不碰。
 *
 * ⚠ 2026-11-12 探针更正：登录表单平时**不带**图形验证码（`#i_code` 那一行默认
 * `display:none`，只有风控才弹）。页面自己的脚本会把明文密码加密进 `#sm2pass`，
 * 所以在 headless 里把账号密码填进可见框、勾上「信任浏览器」、点 `<a>登录</a>`
 * 就能**静默**过 —— 见 `silentRelogin()`。上面那段「必须人工介入」只对**风控弹
 * 验证码**的那种极端情况仍然成立。
 *
 * 于是只剩一条干净的路：**让浏览器自己去登录**。用 DevTools 协议（CDP）驱动一个
 * 专用 profile 的 Edge —— 只要这个 profile 里还存着「信任浏览器」的登录态，
 * 静默跳一次统一身份认证就能拿回新会话；信任态也过期、又没有存账号密码时，
 * 才退回弹一个可见窗口让用户手动登一次（半年一次的量级）。读完 Cookie 立刻
 * 可以关掉浏览器，不常驻。
 *
 * ## 边界
 *
 * - 专用 profile（默认 `<工作区>\.learn-edge\`）与用户日常 Edge 完全隔离，
 *   里面只有网络学堂的会话，不会碰到用户的浏览记录和别的网站密码。
 * - 调试端口只监听 127.0.0.1，且**随用随开、用完即关**，不常驻后台。
 * - 本模块只负责「浏览器里有什么」；要不要把新 Cookie 写进配置由 `api.js` 决定。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 网络学堂主机名。 */
export const LEARN_HOST = 'learn.tsinghua.edu.cn';
/** 学校登录入口页（页面上有统一身份认证的链接）。 */
export const LEARN_LOGIN_PATH = '/f/login';
/** 学生端首页 —— 登录判据 `id="userid"` 就在这页里。 */
export const LEARN_INDEX_PATH = '/f/wlxt/index/course/student/';
/** 默认调试端口。被占用时依次往后找。 */
export const LEARN_BROWSER_PORT = 9333;
/** 统一身份认证的主机名。 */
export const SSO_HOST = 'id.tsinghua.edu.cn';

/** 睡一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 系统自带 Edge 的可能位置，按可靠度排序。
 *
 * 不查注册表：这台机器上重装 Edge 的路径也是这两处，而查注册表要多依赖一层
 * `reg.exe` 输出解析，收益不值。
 */
export function edgeCandidates(env = process.env) {
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = env['ProgramFiles'] || 'C:\\Program Files';
  const local = env['LOCALAPPDATA'];
  const out = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  if (typeof local === 'string' && local !== '') {
    out.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return out;
}

/** 找到 Edge 可执行文件；找不到返回 `null`（不抛）。 */
export function findEdgeExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  for (const candidate of edgeCandidates(env)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // 探测失败就当这个候选不存在
    }
  }
  return null;
}

/**
 * 从网络学堂登录页里取出「统一身份认证」入口地址。
 *
 * 刻意不硬编码 URL 里那一串 id（它由学校侧生成）：页面给什么就用什么，
 * 学校改版时这里跟着页面走，不需要改代码。
 */
export function ssoUrlFromLoginHtml(html) {
  const text = String(html ?? '');
  const match = new RegExp(`https://${SSO_HOST.replace(/\./g, '\\.')}/[^"'\\s<>\\\\]*login[^"'\\s<>\\\\]*`, 'i').exec(text);
  if (match === null) return null;
  return match[0].replace(/&amp;/g, '&');
}

/** CDP 给回来的 Cookie 数组 → 该主机可用的 `Cookie` 请求头。 */
export function cookiesToHeader(cookies, host = LEARN_HOST) {
  const list = Array.isArray(cookies) ? cookies : [];
  const wanted = list.filter((item) => {
    const domain = String(item?.domain ?? '');
    return domain === host || domain === `.${host}`;
  });
  return wanted.map((item) => `${item.name}=${item.value}`).join('; ');
}

/** 一个极小的 CDP 客户端：一次连接、请求/响应配对、超时即失败。 */
export function createCdpClient(webSocketUrl, options = {}) {
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
  if (typeof Impl !== 'function') {
    throw new Error('no-websocket');
  }
  const socket = new Impl(webSocketUrl);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('cdp-socket-error')));
  });
  socket.addEventListener('message', (event) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`cdp-error:${msg.error.message ?? 'unknown'}`));
    else entry.resolve(msg.result ?? {});
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('cdp-timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  return {
    ready,
    send,
    close() {
      try { socket.close(); } catch { /* 关了就别管 */ }
    },
  };
}

async function readJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const fetcher = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { method: options.method ?? 'GET', signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建一个「学习台专用」的浏览器控制器。
 *
 * 所有副作用都在方法里发生：构造对象**不**启动进程、**不**碰磁盘。
 * 这样接口层可以在没用到时完全不惊动系统。
 */
export function createLearnBrowser(config = {}) {
  const logger = config.logger ?? console;
  const profileDir = config.profileDir ?? '';
  const preferredPort = Number.isFinite(config.port) ? config.port : LEARN_BROWSER_PORT;
  const startTimeoutMs = Number.isFinite(config.startTimeoutMs) ? config.startTimeoutMs : 20000;
  const cdpTimeoutMs = Number.isFinite(config.cdpTimeoutMs) ? config.cdpTimeoutMs : 20000;
  const appPath = config.edgePath ?? findEdgeExecutable({ env: config.env ?? process.env });
  const spawnImpl = config.spawnImpl ?? spawn;
  const runSync = config.runSync ?? ((file, args) => spawnSync(file, args, { stdio: 'ignore' }));
  /**
   * 要读 stdout 的同步调用（探测端口占用者用）。
   *
   * 不能复用上面的 `runSync`：它的默认 `stdio: 'ignore'` 会让 `stdout` 永远是
   * `null` —— 2026-11-04 我就是在这个上面白花了一轮，探测永远返回「没有占用者」。
   */
  const runSyncRead = config.runSyncRead ?? ((file, args) => spawnSync(file, args, { encoding: 'utf8' }));
  /** 测试用的 fetch 口子：探 CDP 端口时不真连网络。 */
  const fetchImpl = config.cdpFetch;
  const WebSocketImpl = config.WebSocketImpl ?? globalThis.WebSocket;

  /** 我们自己拉起来的进程；`null` 表示当前没在跑（或没接管）。 */
  let child = null;
  let mode = null;
  let port = preferredPort;
  let startedAt = null;
  const stateFile = profileDir === '' ? '' : path.join(profileDir, 'browser.json');

  function remember() {
    if (stateFile === '') return;
    try {
      if (child === null) fs.rmSync(stateFile, { force: true });
      else fs.writeFileSync(stateFile, `${JSON.stringify({ pid: child.pid, port, mode, startedAt }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // 记不住不影响功能，下次当它没在跑就行
    }
  }

  function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function cdpVersion(candidatePort) {
    // fetchImpl 是给测试用的口子：不真连 127.0.0.1，也不占端口。
    const info = await readJson(`http://127.0.0.1:${candidatePort}/json/version`, { timeoutMs: 1200, fetchImpl });
    return info !== null && typeof info === 'object' ? info : null;
  }

  /** 挑一个真的能被我们用的端口：空闲优先，其次是自己上次留下的那个。 */
  async function choosePort() {
    let savedPort = null;
    if (stateFile !== '') {
      try {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Number.isInteger(saved?.port)) savedPort = saved.port;
      } catch {
        // 没有就算了
      }
    }
    const order = [];
    // 上次用的端口优先（用户可能在系统里给 Edge 放过行），再按默认端口往后找
    if (savedPort !== null && savedPort !== preferredPort) order.push(savedPort);
    for (let i = 0; i < 6; i += 1) order.push(preferredPort + i);
    const seen = new Set();
    let firstOccupied = null;
    for (const candidate of order) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const info = await cdpVersion(candidate);
      if (info === null) return { port: candidate, info: null };
      // 端口被一个 CDP 占着：记下第一个，全部占满时交给调用方决定换哪个端口
      if (firstOccupied === null) firstOccupied = { port: candidate, info };
    }
    return firstOccupied ?? { port: preferredPort, info: null };
  }

  /**
   * 端口上**已经有一个 CDP**（别的浏览器实例占着）时，判断它是不是我们自己的 profile。
   *
   * 2026-11-04 的故障现场：`.learn-edge` 里躺着一个 22 小时没关的僵尸实例，
   * 而我们挑端口只看「端口空不空」；一旦挑中那个被占的端口，新起的 Edge 立刻
   * 撞上 profile 锁、`exit 21` 退出，我们却回报 `browser-exited` —— 一个
   * 完全看不出根因的错误。更糟的是每次心跳都再撞一次（crash_exit_count 涨到 16）。
   *
   * 判据用**进程命令行里的 `--user-data-dir`**：CDP 的 `/json/version` 不报 profile，
   * 但 Windows 上 `Win32_Process` 报。只认「这个 profile 已经被我们自己的浏览器
   * 开着」这一种情况 —— 那是可以接管的；别人的 profile 绝不碰。
   */
  function portOwnerProfile(candidatePort) {
    let scriptPath = null;
    try {
      // ⚠ 必须**落成临时 .ps1 再用 -File 跑**：Windows PowerShell 5.1 的
      // `-Command "..."` 会把内层引号吃掉（`-Filter "Name='msedge.exe'"`
      // 到那边变成 `-Filter Name='msedge.exe'`，直接 `无效查询`，一个进程都
      // 拿不到）。实测 -File 才稳。这也正好符合本机 AGENTS.md「临时脚本用
      // 新文件名、用完即删」的规矩。
      const script = [
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
        `| Where-Object { $_.CommandLine -match '--remote-debugging-port=${candidatePort}(\\s|"|$)' }`,
        '| ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }',
      ].join(' ');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-probe-'));
      scriptPath = path.join(dir, 'probe.ps1');
      fs.writeFileSync(scriptPath, script, 'utf8');
      const out = runSyncRead('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
      const text = typeof out?.stdout === 'string' ? out.stdout : '';
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\t(.*)$/);
        if (match === null) continue;
        const cmd = match[2];
        const found = cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
        if (found === null) continue;
        return { pid: Number(match[1]), profileDir: (found[1] ?? found[2] ?? '').replace(/\\+$/, '') };
      }
      return null;
    } catch {
      return null;
    } finally {
      if (scriptPath !== null) {
        try {
          fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
        } catch {
          // 删不掉就留给系统清 TEMP
        }
      }
    }
  }

  /** 两个 profile 路径是不是同一个（大小写、结尾反斜杠、正反斜杠都不该影响判断）。 */
  function sameProfile(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
    const norm = (value) => value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
    return norm(a) === norm(b);
  }

  /**
   * 尝试接管上次留下的浏览器（DSH 重启、但 Edge 还开着的情况）。
   *
   * 两道口子都开：认自己写下的 `browser.json`（正常路径），也认「端口上占着的
   * 就是我们这个 profile」（`browser.json` 没写成的僵尸实例 —— 2026-11-04 的现场）。
   * 后者接管的那个进程不是我们的子进程，`child.kill` 是空函数，所以关它只能
   * 走 `stop()` 里的 taskkill，`stop()` 已经按 pid 处理。
   */
  async function adopt() {
    // ① 正常的：browser.json 里记着 pid + port
    if (stateFile !== '') {
      let saved = null;
      try {
        saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        saved = null;
      }
      if (saved && alive(saved.pid) && await cdpVersion(saved.port) !== null) {
        child = { pid: saved.pid, kill: () => {}, exitCode: null };
        mode = typeof saved.mode === 'string' ? saved.mode : 'unknown';
        port = saved.port;
        startedAt = typeof saved.startedAt === 'string' ? saved.startedAt : null;
        logger.info?.(`[study-assistant] 接管已有的学习台浏览器（pid ${saved.pid}, 端口 ${saved.port}）`);
        return { port, info: await cdpVersion(port) };
      }
    }
    // ② 僵尸：browser.json 丢了/没写，但端口上开着 CDP 且用的正是我们这个 profile
    for (let i = 0; i < 6; i += 1) {
      const candidate = preferredPort + i;
      const info = await cdpVersion(candidate);
      if (info === null) continue;
      const owner = portOwnerProfile(candidate);
      if (owner === null || !sameProfile(owner.profileDir, profileDir)) continue;
      child = { pid: owner.pid, kill: () => {}, exitCode: null };
      mode = 'unknown';
      port = candidate;
      startedAt = null;
      remember();
      logger.info?.(`[study-assistant] 接管一个没登记过的学习台浏览器（pid ${owner.pid}, 端口 ${candidate}）—— 它就是 2026-11-04 那种僵尸实例`);
      return { port, info };
    }
    return null;
  }

  async function start({ headless = true } = {}) {
    if (appPath === null) return { ok: false, reason: 'edge-not-found' };
    // 先看能不能接管：我们自己那个 profile 已经开着的时候就别再起一个去撞锁
    const adopted = await adopt();
    if (adopted !== null) {
      if (headless === false && mode === 'headless') {
        // 要可见窗口，但现有的是 headless：关掉重建
        await stop();
      } else {
        return { ok: true, port: adopted.port, info: adopted.info, mode, reused: true };
      }
    }
    const chosen = await choosePort();
    port = chosen.port;
    // 目标端口上**已经有人在 listen** 而 CDP 又不认（不是浏览器、或不是我们的 profile）：
    // 硬上就是 exit 21（单例/用户数据目录被占用），换一个端口重来。这里只换一次，
    // 免得在别人的地盘上反复撞。
    if (chosen.info !== null) {
      port = preferredPort + 10;
      logger.warn?.(`[study-assistant] 端口 ${chosen.port} 被非学习台进程占着，改用 ${port}`);
    }
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--no-service-autorun',
      '--disable-background-mode',
    ];
    if (headless) args.push('--headless=new');
    args.push('about:blank');

    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (error) {
      return { ok: false, reason: 'profile-unusable', detail: String(error?.message ?? error) };
    }

    let proc;
    try {
      proc = spawnImpl(appPath, args, { stdio: 'ignore', windowsHide: true, detached: false });
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', detail: String(error?.message ?? error) };
    }
    child = proc;
    mode = headless ? 'headless' : 'visible';
    startedAt = new Date().toISOString();
    remember();
    logger.info?.(`[study-assistant] 启动${headless ? '后台' : '可见'}浏览器（pid ${proc.pid}, 端口 ${port}）`);

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const info = await cdpVersion(port);
      if (info !== null) return { ok: true, port, info, mode };
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        child = null;
        remember();
        // `exit 21` 在 Edge 里几乎只有一个意思：**单例锁冲突** —— 我们的
        // `--user-data-dir` 正被别的实例占着。以前这里原样回 `exit 21`，
        // 日志里只有 `browser-exited exit 21`，谁也看不出根因；现在翻成人话，
        // 并顺手看一眼到底是谁占着，排障时一眼能对上。
        if (proc.exitCode === 21) {
          const owner = portOwnerProfile(preferredPort) ?? portOwnerProfile(preferredPort + 1) ?? portOwnerProfile(preferredPort + 2);
          const detail = owner === null
            ? 'exit 21（profile 正被另一个浏览器实例占用，且找不到占用者）'
            : `exit 21（profile 被 pid ${owner.pid} 占着，profile=${owner.profileDir}）`;
          return { ok: false, reason: 'profile-locked', detail, exitCode: 21 };
        }
        return { ok: false, reason: 'browser-exited', detail: `exit ${proc.exitCode}`, exitCode: proc.exitCode };
      }
      await sleep(300);
    }
    return { ok: false, reason: 'cdp-timeout' };
  }

  async function ensureStarted({ headless = true } = {}) {
    if (child !== null) {
      const info = await cdpVersion(port);
      if (info !== null) {
        // 已经有窗口了就别为了「headless」再关再开 —— 可见的更灵活
        if (!headless && mode === 'headless') {
          await stop();
        } else {
          return { ok: true, port, info, mode, reused: true };
        }
      } else {
        child = null;
        remember();
      }
    }
    // 不用在这里再 adopt 一次：start() 开头就会先接管，重复探测只是白跑一遍
    // PowerShell（本机每次 100~300 ms，心跳里没必要）。
    return await start({ headless });
  }

  async function stop() {
    const proc = child;
    child = null;
    const activePort = port;
    mode = null;
    startedAt = null;
    remember();
    if (proc === null) return { ok: true, stopped: false };

    // 先好好说：CDP 的 Browser.close 让浏览器自己收尾（会话 Cookie 会落盘）
    const info = await cdpVersion(activePort);
    if (info && typeof info.webSocketDebuggerUrl === 'string') {
      try {
        const client = createCdpClient(info.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs: 5000 });
        await client.ready;
        await client.send('Browser.close');
        client.close();
      } catch {
        // 关不掉就走下面的强杀
      }
    }
    for (let i = 0; i < 10; i += 1) {
      if (!alive(proc.pid)) return { ok: true, stopped: true };
      await sleep(300);
    }
    try {
      runSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } catch {
      // 强杀失败也没别的办法了
    }
    return { ok: true, stopped: true };
  }

  /** 拿一个可用的页面 target（没有就新建）。 */
  async function pageTarget() {
    const list = await readJson(`http://127.0.0.1:${port}/json/list`);
    const pages = (Array.isArray(list) ? list : []).filter((item) => item?.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
    if (pages.length > 0) {
      return pages.find((item) => String(item.url ?? '').includes(LEARN_HOST)) ?? pages[0];
    }
    const created = await readJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    if (created === null || typeof created.webSocketDebuggerUrl !== 'string') return null;
    return created;
  }

  /** 开一个页面会话（调用方负责 `close()`）。 */
  async function openPage() {
    const target = await pageTarget();
    if (target === null) return { ok: false, reason: 'no-page-target' };
    const client = createCdpClient(target.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs: cdpTimeoutMs });
    try {
      await client.ready;
      await client.send('Page.enable');
      await client.send('Network.enable');
    } catch (error) {
      client.close();
      return { ok: false, reason: 'cdp-connect-failed', detail: String(error?.message ?? error) };
    }
    return { ok: true, client };
  }

  async function evaluate(client, expression) {
    const out = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    return out?.result?.value;
  }

  async function navigate(client, url, options = {}) {
    const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 900;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
    await client.send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      try {
        if (await evaluate(client, 'document.readyState') === 'complete') break;
      } catch {
        // 导航中途的 evaluate 可能失败，继续等
      }
    }
    await sleep(settleMs);
  }

  async function currentHost(client) {
    try {
      const href = await evaluate(client, 'location.href');
      if (typeof href !== 'string' || href === '') return null;
      return new URL(href).host;
    } catch {
      return null;
    }
  }

  async function hasPasswordField(client) {
    try {
      return await evaluate(client, '!!document.querySelector("input[type=password]")') === true;
    } catch {
      return false;
    }
  }

  /**
   * 这个 profile 现在登录着吗。
   *
   * 判据与 `fetchLearnIndex` 一致：学生端首页里有没有 `id="userid"`。
   * 用页面内判断而不是再发一次 HTTP —— 页面就是浏览器给的，省一次往返。
   */
  async function loggedIn(client) {
    try {
      await navigate(client, `https://${LEARN_HOST}${LEARN_INDEX_PATH}`, { timeoutMs: cdpTimeoutMs });
      return await evaluate(client, '!!document.getElementById("userid")') === true;
    } catch {
      return false;
    }
  }

  /**
   * 顺手喂一次清华统一身份认证（SSO），并顺便看它是不是还活着。
   *
   * 为什么非要有这一步：只请求学堂首页时，学堂那边的会话能续上，但统一身份
   * 认证那边的会话没人碰，闲久了就死 —— 它一死，下次自动续期立刻变成「必须
   * 人工登录」。按 `learn.tsinghua.edu.cn/f/login` 给的那个入口再走一圈，浏览器
   * 就会带着 SSO 会话发一次请求，把它的空闲计时器一起清零。
   *
   * 2026-10-12 教训：只走「登录表单那个入口」可能喂不饱 SSO（那是个公开页面），
   * 所以登录态还在时再补一次身份认证门户首页，给那边的会话多一次刷新机会。
   * 观察到的每一步都带回去（`state` / `landed` / `portal`），好判断到底喂住没有。
   *
   * 返回 `{ state, entry, landed, portal }`：
   *   state  = 'ok'（绕回学堂）/ 'login-form'（SSO 也过期，要人工）/ 'unknown'
   * 无论结果如何都不当作失败：这一步只是「顺便」，不能因为它把好好的 Cookie 判死。
   */
  async function touchSso(client) {
    const detail = { state: 'unknown', entry: null, landed: null, portal: null };
    try {
      await navigate(client, `https://${LEARN_HOST}${LEARN_LOGIN_PATH}`, { timeoutMs: 8000, settleMs: 400 });
      let html = '';
      try {
        html = await evaluate(client, 'document.documentElement.outerHTML') ?? '';
      } catch {
        html = '';
      }
      const sso = ssoUrlFromLoginHtml(typeof html === 'string' ? html : '');
      if (sso === null) return detail;
      detail.entry = sso;
      await navigate(client, sso, { timeoutMs: 8000, settleMs: 800 });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await hasPasswordField(client)) {
          detail.landed = 'login-form';
          detail.state = 'login-form';
          return detail;
        }
        if (await currentHost(client) === LEARN_HOST) {
          detail.landed = 'learn';
          detail.state = 'ok';
          break;
        }
        await sleep(400);
      }
      if (detail.state !== 'ok') {
        detail.landed = await currentHost(client);
        return detail;
      }
      // 登录态还在：补访一次身份认证门户，让那边的会话也过一次
      await navigate(client, `https://${SSO_HOST}/`, { timeoutMs: 8000, settleMs: 600 });
      detail.portal = await hasPasswordField(client) ? 'login-form' : 'ok';
      return detail;
    } catch {
      return detail;
    }
  }

  /** 读当前浏览器里网络学堂的 Cookie（不判活）。 */
  async function readCookie() {
    const ensured = await ensureStarted({ headless: true });
    if (!ensured.ok) return { ok: false, reason: ensured.reason, detail: ensured.detail ?? null, cookie: '' };
    const page = await openPage();
    if (!page.ok) return { ok: false, reason: page.reason, cookie: '' };
    try {
      const all = await page.client.send('Network.getAllCookies');
      const cookies = Array.isArray(all?.cookies) ? all.cookies : [];
      return { ok: true, cookie: cookiesToHeader(cookies), cookies, reason: null };
    } catch (error) {
      return { ok: false, reason: 'cdp-failed', detail: String(error?.message ?? error), cookie: '' };
    } finally {
      page.client.close();
    }
  }

  /**
   * 静默续期：让浏览器自己去统一身份认证换一张新会话回来。
   *
   * 返回 `{ ok, cookie }` 或 `{ ok:false, reason }`；`needs-manual-login` 表示
   * 「信任浏览器」的登录态也过期了，必须人工登一次（界面据此弹可见窗口）。
   *
   * `touchSso: true`（心跳用）会在已经登录的情况下也顺手走一圈统一身份认证，
   * 把 SSO 会话一起喂暖 —— 详见 `touchSso()` 的注释。
   */
  async function renew(options = {}) {
    const headless = options.headless !== false;
    const ensured = await ensureStarted({ headless });
    if (!ensured.ok) return { ok: false, reason: ensured.reason, detail: ensured.detail ?? null };

    const page = await openPage();
    if (!page.ok) return { ok: false, reason: page.reason };
    const { client } = page;

    /**
     * 收 Cookie。`touchSso` 只在「本来就没走登录流程」的路上做 —— 走了 SSO 再
     * 绕回学堂的那条路（`renewed`）本身就已经喂过它了，不必再来一圈。
     */
    async function harvest(source, { skipTouch = false } = {}) {
      let ssoTouch = 'skipped';
      let ssoTouchDetail = null;
      if (options.touchSso === true && !skipTouch) {
        const touched = await touchSso(client);
        ssoTouch = typeof touched === 'string' ? touched : (touched?.state ?? 'unknown');
        ssoTouchDetail = typeof touched === 'string' ? null : touched;
      }
      const all = await client.send('Network.getAllCookies');
      return { ok: true, cookie: cookiesToHeader(all?.cookies ?? []), source, ssoTouch, ssoTouchDetail };
    }

    try {
      // 一、也许现在就登录着（用户刚在可见窗口里登完）——
      //     这条是心跳每 20 分钟走的路，也是最该顺手喂暖 SSO 的时候
      if (await loggedIn(client)) {
        return await harvest('existing');
      }

      // 二、走一次登录入口，看能不能靠「信任浏览器」静默换票
      await navigate(client, `https://${LEARN_HOST}${LEARN_LOGIN_PATH}`, { timeoutMs: cdpTimeoutMs });
      let html = '';
      try {
        html = await evaluate(client, 'document.documentElement.outerHTML') ?? '';
      } catch {
        html = '';
      }
      const sso = ssoUrlFromLoginHtml(typeof html === 'string' ? html : '');
      // 登录页里没有统一身份认证入口：多半是学校改版了，报出来比瞎试好
      if (sso === null) return { ok: false, reason: 'login-page-shape' };
      await navigate(client, sso, { timeoutMs: cdpTimeoutMs, settleMs: 1200 });

      const deadline = Date.now() + cdpTimeoutMs;
      let cameBack = false;
      while (Date.now() < deadline) {
        const host = await currentHost(client);
        if (host === LEARN_HOST) { cameBack = true; break; }
        if (await hasPasswordField(client)) return { ok: false, reason: 'needs-manual-login' };
        await sleep(500);
      }
      if (!cameBack && !(await loggedIn(client))) {
        return { ok: false, reason: 'sso-timeout' };
      }
      if (!(await loggedIn(client))) return { ok: false, reason: 'needs-manual-login' };

      return await harvest('renewed', { skipTouch: true });
    } catch (error) {
      return { ok: false, reason: 'cdp-failed', detail: String(error?.message ?? error) };
    } finally {
      client.close();
    }
  }

  /**
   * 在 SSO 登录表单上「拟人地点一下登录」。
   *
   * 依据（2026-11-12 探针实测，见 history）：清华 SSO 登录页 `id.tsinghua.edu.cn`
   * 真正的表单只有 `#i_user`（学号/账号）、`#i_pass`（密码）、`<a>登录</a>` 按钮、
   * 和三处 `singleLogin`（信任浏览器）复选框；**图形验证码那一行默认 `display:none`**
   * （只有风控时才弹出来）。所以「信任浏览器」票没用、得重登一次时，绝大多数情况
   * 只要把账号密码填进去、勾上信任浏览器、点 `<a>登录</a>` 就能静默过去。
   *
   * 密码框里的密码要加密成 `#sm2pass` 才被后端认（原始 `#i_pass` 只是明文输入框）。
   * 页面自己的登录逻辑会处理这一步，只要在**可见的用户/密码框里触发正确的 input
   * 事件**再点按钮，页面脚本会自己把 SM2 密文算好。这些动作全在 headless 里做，
   * 用户看不到窗口。
   *
   * 返回 `{ ok: true }`（已点下，调用方再等跳回学堂）或 `{ ok:false, reason }`：
   *   - `no-sso-form`：页面上没有可填的登录表单（多半已自动跳回学堂了）
   *   - `captcha-shown`：风控把验证码弹出来了 —— 这种程序过不去，只能人工
   */
  async function attemptSsoLogin(client, credentials) {
    const user = typeof credentials?.user === 'string' ? credentials.user : '';
    const pass = typeof credentials?.pass === 'string' ? credentials.pass : '';
    const hasCreds = user !== '' && pass !== '';

    // 读一次表单现状：有没有可见的 i_user / i_pass、验证码那一行是不是显示了。
    const probe = await evaluate(client, `(() => {
      const u = document.getElementById('i_user');
      const p = document.getElementById('i_pass');
      const code = document.getElementById('i_code');
      const codeRow = code ? (code.closest('div,tr,li') || code.parentElement) : null;
      const rowShown = codeRow ? getComputedStyle(codeRow).display !== 'none' : false;
      const box = code ? code.getBoundingClientRect() : null;
      const captchaShown = !!(rowShown && box && (box.width > 0 || box.height > 0));
      return {
        hasUser: !!u, userVisible: u ? getComputedStyle(u).display !== 'none' : false,
        hasPass: !!p, passVisible: p ? getComputedStyle(p).display !== 'none' : false,
        userValue: u ? u.value : '',
        captchaShown,
      };
    })()`);
    if (!probe || (probe.hasUser !== true && probe.hasPass !== true)) {
      return { ok: false, reason: 'no-sso-form' };
    }
    if (probe.captchaShown === true) {
      // 风控要验证码了，程序填进去也过不去 —— 老实回报，交给用户手动
      return { ok: false, reason: 'captcha-shown' };
    }

    // 把账号密码填进可见框（用 setter + 触发 input/change，页面脚本据此同步 sm2pass）。
    // 密码框已经预填（Edge 密码管理器自动填）时也照样覆盖成我们存的，避免和不一致。
    if (hasCreds) {
      const filled = await evaluate(client, `(() => {
        function setVal(el, val) {
          if (!el) return false;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value === val;
        }
        const u = document.getElementById('i_user');
        const p = document.getElementById('i_pass');
        const okU = u ? setVal(u, ${JSON.stringify(user)}) : false;
        const okP = p ? setVal(p, ${JSON.stringify(pass)}) : false;
        return { okU, okP };
      })()`);
      if (!filled || filled.okU !== true || filled.okP !== true) {
        return { ok: false, reason: 'fill-failed' };
      }
    }

    // 勾上「信任浏览器」（拿一张长命的 TSINGHUAUSERID），再点 `<a>登录</a>`。
    const clicked = await evaluate(client, `(() => {
      // 信任浏览器复选框：id 是 singleLoginId（可见的那个）
      const cb = document.getElementById('singleLoginId')
        || [...document.querySelectorAll('input[name=singleLogin]')].find(e => e.type === 'checkbox' && e.offsetParent !== null);
      if (cb && cb.checked !== true) cb.click();
      // 登录按钮是 <a>，文案「登录」、无 href
      const btn = [...document.querySelectorAll('a,button')].find((e) => {
        const t = (e.tagName === 'INPUT' ? e.value : e.innerText || '').trim();
        return t === '登录' && !e.href && e.offsetParent !== null;
      });
      if (!btn) return { clicked: false };
      btn.click();
      return { clicked: true, captchaChecked: cb ? cb.checked === true : false };
    })()`);
    if (!clicked || clicked.clicked !== true) {
      return { ok: false, reason: 'no-login-button' };
    }
    return { ok: true, trustBrowser: clicked.captchaChecked === true };
  }

  /**
   * 静默重连：信任浏览器的票也过期时，headless 打开 SSO、模拟点击登录把会话换回来。
   *
   * 与 `renew()` 的区别：`renew()` 只做「静默换票」，一旦落到登录表单就认输；
   * 这个函数**硬着头皮把登录表单填完点掉**。它需要一份账号密码（用户显式同意
   * 让插件存的那份），或者在 Edge 里已经被密码管理器自动填好。
   *
   * 全程 headless、绝不弹可见窗口 —— 这就是用户 2026-11-12 要的「拟人化一键重连」。
   */
  async function silentRelogin(credentials, options = {}) {
    const ensured = await ensureStarted({ headless: true });
    if (!ensured.ok) return { ok: false, reason: ensured.reason, detail: ensured.detail ?? null };
    const page = await openPage();
    if (!page.ok) return { ok: false, reason: page.reason };
    const { client } = page;
    try {
      // 一、也许现在本来就登录着（顺便喂暖 SSO 的产物）——先确认一下
      if (await loggedIn(client)) {
        const all = await client.send('Network.getAllCookies');
        return { ok: true, cookie: cookiesToHeader(all?.cookies ?? []), source: 'existing', clicked: false };
      }
      // 二、走登录入口 → 统一身份认证表单
      await navigate(client, `https://${LEARN_HOST}${LEARN_LOGIN_PATH}`, { timeoutMs: cdpTimeoutMs });
      let html = '';
      try { html = await evaluate(client, 'document.documentElement.outerHTML') ?? ''; } catch { html = ''; }
      const sso = ssoUrlFromLoginHtml(typeof html === 'string' ? html : '');
      if (sso === null) return { ok: false, reason: 'login-page-shape' };
      await navigate(client, sso, { timeoutMs: cdpTimeoutMs, settleMs: 1200 });

      // 三、可能「信任浏览器」直接把我们送回学堂了（票没坏到要密码）
      const fastDeadline = Date.now() + 6000;
      while (Date.now() < fastDeadline) {
        if (await currentHost(client) === LEARN_HOST) {
          const all = await client.send('Network.getAllCookies');
          return { ok: true, cookie: cookiesToHeader(all?.cookies ?? []), source: 'renewed', clicked: false };
        }
        if (await hasPasswordField(client)) break;
        await sleep(400);
      }

      // 四、落到登录表单：模拟点击登录（填账号密码 + 勾信任浏览器 + 点按钮）
      const clicked = await attemptSsoLogin(client, credentials);
      if (!clicked.ok) return { ok: false, reason: clicked.reason };

      // 五、点完之后等它跳回学堂（SM2 加密 + 提交可能要一两秒）
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(500);
        if (await currentHost(client) === LEARN_HOST) {
          if (await loggedIn(client)) {
            const all = await client.send('Network.getAllCookies');
            return { ok: true, cookie: cookiesToHeader(all?.cookies ?? []), source: 'relogin', clicked: true };
          }
        }
        // 点了之后又冒出验证码（风控在提交后才判）：程序过不去
        const nowCap = await evaluate(client, `(() => {
          const c = document.getElementById('i_code');
          const row = c ? (c.closest('div,tr,li') || c.parentElement) : null;
          const shown = row ? getComputedStyle(row).display !== 'none' : false;
          const b = c ? c.getBoundingClientRect() : null;
          return !!(shown && b && (b.width > 0 || b.height > 0));
        })()`);
        if (nowCap === true) return { ok: false, reason: 'captcha-shown' };
      }
      return { ok: false, reason: 'relogin-timeout' };
    } catch (error) {
      return { ok: false, reason: 'cdp-failed', detail: String(error?.message ?? error) };
    } finally {
      client.close();
    }
  }

  /** 弹一个可见窗口停在登录页，等用户手动登录（并勾「信任浏览器」）。 */
  async function openLoginWindow() {
    const ensured = await ensureStarted({ headless: false });
    if (!ensured.ok) return { ok: false, reason: ensured.reason, detail: ensured.detail ?? null };
    const page = await openPage();
    if (!page.ok) return { ok: false, reason: page.reason };
    try {
      await navigate(page.client, `https://${LEARN_HOST}${LEARN_LOGIN_PATH}`, { timeoutMs: cdpTimeoutMs });
      return { ok: true, port, mode };
    } catch (error) {
      return { ok: false, reason: 'cdp-failed', detail: String(error?.message ?? error) };
    } finally {
      page.client.close();
    }
  }

  function status() {
    return {
      running: child !== null,
      mode,
      port,
      pid: child?.pid ?? null,
      startedAt,
      profileDir,
      edgePath: appPath,
    };
  }

  return {
    status,
    ensureStarted,
    readCookie,
    renew,
    silentRelogin,
    openLoginWindow,
    stop,
    get edgeAvailable() { return appPath !== null; },
  };
}
