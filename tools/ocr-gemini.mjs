#!/usr/bin/env node
// 扫描件取字（三档链路）
//
// 用法：
//   node tools/ocr-gemini.mjs "<pdf 路径>" [选项]
//
// 选项：
//   --tier chain|gemini|notebook|local   只跑某一档（默认 chain：按 gemini→notebook→local 降级）
//   --out "<目录>"                       默认 <pdf 同目录>/第NN次作业_OCR文本
//   --max-pages 20                       硬上限，防止误传整本教材
//   --budget-gemini 120                  第一档预算（秒）
//   --budget-notebook 120                第二档预算（秒）
//   --page-from 21 --page-to 40          只取这一段页（必须成对，单次 ≤60 页；教材分批靠它）
//                                        也可用环境变量 OCR_PAGE_FROM / OCR_PAGE_TO
//   --keep                               保留临时 PNG
//   --delete-conversation                临时对话不可用时，跑完把本次会话删掉（默认**不删**；也可设 OCR_DELETE_CONVERSATION=1）
//                                        默认只走「临时对话」：它不落近期会话；切不到也不碰账号里已有的任何会话
//
// 规范见 `_工具/学习台-扫描件取字规范.md`。一句话：
//   1) Gemini 本体（图片）→ 2) NotebookLM（PDF 直传）→ 3) 本地 RapidOCR；
//   每档各自限时，超时/被地区拦截/质量门不过就降级；三档都不成就报错退出，绝不编造。
//
// 退出码：0 成功；2 参数/文件问题；3 浏览器或 CDP 问题；4 三档都失败。
//
// 依赖：Edge（登录可用地区账号）、Clash 7897、系统 Python 3.12（pypdfium2；本机 OCR 还要 rapidocr_onnxruntime）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..', '..');
const OCR_CLI = path.join(WORKSPACE, '_工具', 'OCR统一入口.py');

const CDP_PORT = 9222;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const PROFILE = path.join(os.homedir(), '.cache', 'gemini-edge-daily');
const PROXY = 'http://127.0.0.1:7897';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

// 2026-10-20：多行指令经 execCommand 插进 Quill 只剩第一行（实测 user-query 只收到「只做文字转写…」），
// 所以整条指令压成一行，用「；」分隔各项要求。
// 2026-10-23 19:5x（用户定）：166 字的提示词在新版界面上会被答「我似乎无权访问该内容」，改成短句；
// 但下面几样是解析器的硬约束，不能删：「=== 第 N 页 ===」页标记、```text 代码块、单行（Quill 只吃第一行）。
const PROMPT =
  '帮我把拍的这几页讲义按顺序打成文字，只要文字，不用解释。每页开头单独一行写「=== 第 N 页 ===」，第 1 页就是第一张图；全部放进一个 ```text 代码块，代码块外别写字；公式写成 $...$，题号、选项、图注照原样，认不出的字写 [?]。'

const log = (...a) => console.log('[ocr]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fatal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = {
    pdf: process.env.OCR_PDF || null,
    out: null,
    maxPages: 20,
    keep: false,
    keepConversation: false,
    // 2026-10-20 晚（用户定）：默认**不删**会话，只走「临时对话」；要清就显式给 --delete-conversation。
    deleteConversation: process.env.OCR_DELETE_CONVERSATION === '1' || process.env.OCR_DELETE_CONVERSATION === 'true',
    tier: 'chain',
    budgetGemini: 120,
    budgetNotebook: 120,
    budgetVision: 900,
    scale: 3,
    renderOnly: false,
    pageFrom: Number(process.env.OCR_PAGE_FROM || 0) || null,
    pageTo: Number(process.env.OCR_PAGE_TO || 0) || null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--render-only') args.renderOnly = true;
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]) || 20;
    else if (a === '--tier') args.tier = argv[++i];
    else if (a === '--budget-gemini') args.budgetGemini = Number(argv[++i]) || 120;
    else if (a === '--budget-notebook') args.budgetNotebook = Number(argv[++i]) || 120;
    else if (a === '--budget-vision') args.budgetVision = Number(argv[++i]) || 900;
    else if (a === '--scale') args.scale = Number(argv[++i]) || 3;
    else if (a === '--keep') args.keep = true;
    else if (a === '--delete-conversation') args.deleteConversation = true;
    else if (a === '--keep-conversation') args.keepConversation = true; // 老参数，等于默认行为（不删）
    else if (a === '--page-from') args.pageFrom = Number(argv[++i]) || null;
    else if (a === '--page-to') args.pageTo = Number(argv[++i]) || null;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node tools/ocr-gemini.mjs "<pdf>" [--tier chain|gemini|notebook|vision|local] [--out dir] [--max-pages 20]');
      process.exit(0);
    } else if (!args.pdf) args.pdf = a;
  }
  if (!args.pdf) throw new Fatal(2, '缺少 PDF 路径（也可用环境变量 OCR_PDF）');
  if (!fs.existsSync(args.pdf)) throw new Fatal(2, 'PDF 不存在：' + args.pdf);
  args.pdf = path.resolve(args.pdf);
  if (!['chain', 'gemini', 'notebook', 'vision', 'local'].includes(args.tier)) throw new Fatal(2, '--tier 只能是 chain/gemini/notebook/vision/local');
  if (args.pageFrom || args.pageTo) {
    const from = args.pageFrom || 1;
    const to = args.pageTo;
    if (!to || to < from) throw new Fatal(2, '页范围必须成对给：--page-from N --page-to M（M>=N）');
    if (to - from + 1 > 60) throw new Fatal(2, '一次最多 60 页，请分批');
    args.pageFrom = from;
    args.pageTo = to;
    args.maxPages = Math.max(args.maxPages, to);
  }
  return args;
}

function outputDirFor(pdfPath, override) {
  if (override) return path.resolve(override);
  const dir = path.dirname(pdfPath);
  const base = path.basename(pdfPath, path.extname(pdfPath));
  const m = base.match(/第\s*(\d{1,2})\s*次/);
  const tag = m ? `第${m[1].padStart(2, '0')}次作业_OCR文本` : `${base}_OCR文本`;
  return path.join(dir, tag);
}

function withTimeout(promise, seconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Fatal(4, `${label} 超时（${seconds}s）`)), seconds * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- 渲染（系统 Python + pypdfium2） ----------

const RENDER_PY = `
import json, os, sys
from pypdfium2 import PdfDocument
cfg = json.loads(sys.stdin.buffer.read().decode("utf-8"))
doc = PdfDocument(cfg["pdf"])
total = len(doc)
first = int(cfg.get("pageFrom") or 1)
last = int(cfg.get("pageTo") or 0) or total
last = min(last, total, int(cfg["maxPages"]) if int(cfg["maxPages"]) > 0 else total)
if first < 1: first = 1
made = []
for i in range(first - 1, last):
    pil = doc[i].render(scale=float(cfg["scale"])).to_pil()
    p = os.path.join(cfg["outDir"], "page%02d.png" % (i + 1))
    pil.save(p, optimize=True)
    made.append({"page": i + 1, "path": p, "w": pil.size[0], "h": pil.size[1]})
print(json.dumps({"pages": total, "made": made, "range": [first, last]}, ensure_ascii=False))
`;

function pythonPath() {
  // 默认走 PATH 上的 python；要指定解释器就用 OCR_PYTHON（绝对路径或裸命令都行）。
  const py = process.env.OCR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  // 只有写绝对路径时才做存在性检查，裸命令交给 PATH 解析
  if ((py.includes('/') || py.includes('\\')) && !fs.existsSync(py)) {
    throw new Fatal(2, '找不到系统 Python：' + py + '（可用 OCR_PYTHON 指定）');
  }
  return py;
}

function runJson(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Fatal(2, `${cmd} 起不来：${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Fatal(4, `${cmd} 退出码 ${code}：${err.trim().slice(0, 300)}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        reject(new Fatal(4, `${cmd} 输出不是 JSON：${out.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

async function renderPages(pdf, tmpDir, maxPages, scale = 3, pageFrom = null, pageTo = null) {
  fs.mkdirSync(tmpDir, { recursive: true });
  log('渲染 PDF →', tmpDir);
  const res = await runJson(pythonPath(), ['-c', RENDER_PY], { pdf, outDir: tmpDir, maxPages, scale, pageFrom, pageTo });
  log(`共 ${res.pages} 页，渲染 ${res.made.length} 页（${res.range ? res.range[0] + '-' + res.range[1] : '全部'}）`);
  return res;
}

// ---------- CDP ----------

class Conn {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Fatal(3, 'CDP WebSocket 连不上'));
      // 连接断掉时把还在等的调用全部拒掉，否则它们会永远挂着（见 send() 的注释）
      this.ws.onclose = () => {
        for (const [, p] of this.pending) {
          try { p.rej(new Fatal(4, 'CDP 连接已关闭')); } catch { /* ignore */ }
        }
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (!m.id && m.method) {
          const waiters = this.listeners.get(m.method) || [];
          this.listeners.set(
            m.method,
            waiters.filter((w) => {
              if (w.done) return false;
              w.done = true;
              w.res(m.params);
              return false;
            })
          );
          return;
        }
        const p = m.id && this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    // 2026-10-21 15:2x：CDP 连接半死（页面跳转 / 渲染进程换掉）时，旧实现既没有超时、也没有 onclose
    // 收敛 pending，于是 await conn.send(...) 永远不返回 —— 整批静默卡死：pid 还在、CPU 0.2 s、
    // 一句日志都不再打（实测 p52 卡在「发送前」之后 8 分钟，runner 只能等 900 s 总超时）。
    // 现在每个调用都带超时，同一条连接断掉时立刻把 pending 全部拒掉。
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Fatal(4, `CDP 调用 ${method} 超时（30s，连接可能已断）`));
      }, 30000);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { res: settle(res), rej: settle(rej) });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        rej(new Fatal(4, 'CDP 发送失败：' + e.message));
      }
    });
  }
  once(method) {
    return new Promise((res) => {
      const list = this.listeners.get(method) || [];
      list.push({ res, done: false });
      this.listeners.set(method, list);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function cdpAlive() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser() {
  if (await cdpAlive()) {
    log('复用已有调试实例 :' + CDP_PORT);
    return;
  }
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Fatal(3, '找不到 msedge.exe');
  log('启动 Edge（profile ' + PROFILE + '）');
  const child = spawn(
    exe,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--proxy-server=${PROXY}`,
      '--proxy-bypass-list=<-loopback>',
      '--no-first-run',
      '--new-window',
      '--window-size=1280,900',
      'https://gemini.google.com/app'
    ],
    { detached: true, stdio: 'ignore', windowsHide: false }
  );
  child.unref();
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (await cdpAlive()) return;
  }
  throw new Fatal(3, 'Edge 起来了但 9222 没开');
}

async function attach() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const conn = new Conn(version.webSocketDebuggerUrl);
  await conn.ready;
  const { targetInfos } = await conn.send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  const target = pages.find((p) => /gemini\.google\.com|notebooklm\.google\.com/.test(p.url)) ?? pages[0];
  if (!target) throw new Fatal(3, '浏览器里没有可用标签页');
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return { conn, sessionId };
}

function makeCtx(conn, sessionId) {
  const evaluate = async (expression) => {
    const r = await conn.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId
    );
    if (r.exceptionDetails) throw new Error('页面脚本报错：' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  };
  const click = async (x, y) => {
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, sessionId);
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  };
  // Quill 编辑器只认 beforeinput/execCommand，Input.insertText 会让「发送」按钮出现但点了不发
  const type = async (text) => {
    const literal = JSON.stringify(text);
    const put = await evaluate(`(function(){
      var e = document.querySelector('div.ql-editor[contenteditable="true"]');
      if (!e) return 'no-editor';
      e.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, ${literal});
      return String(e.innerText.length);
    })()`);
    if (put === 'no-editor' || Number(put) < Math.min(8, text.length)) {
      await conn.send('Input.insertText', { text }, sessionId);
    }
  };
  return { evaluate, click, type, conn, sessionId };
}

async function navigate(ctx, url, waitMs = 5000) {
  await ctx.conn.send('Page.enable', {}, ctx.sessionId);
  await ctx.conn.send('Page.navigate', { url }, ctx.sessionId);
  await sleep(waitMs);
}

// 点一个可见元素（坐标现取现点，避免布局变化后坐标失效）
async function clickByLabel(ctx, labelRe) {
  // 2026-10-20：Gemini 的「+（上传和工具）」用 CDP 坐标点击点不开菜单（命中子节点 span，Angular 不认），
  // 改成在页面里直接 element.click()（evaluate 带 userGesture，能触发 input[type=file].click()）。
  const box = await ctx.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('button,[role=menuitem],[role=button]')).filter(function(x){
      var a = x.getAttribute('aria-label') || '';
      var t = (x.innerText || '').trim();
      var re = ${labelRe.toString()};
      return (re.test(a) || re.test(t)) && x.offsetParent !== null && !x.disabled;
    })[0];
    if (!b) return null;
    var r = b.getBoundingClientRect();
    try { b.click(); } catch (e) {}
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (!box) return false;
  return true;
}

const chipCount = async (ctx) =>
  (await ctx.evaluate(
    `(function(){return Array.from(document.querySelectorAll('.file-preview-chip,uploader-file-preview')).filter(function(x){return x.offsetParent!==null}).length})()`
  )) || 0;

function setClipboardImage(png) {
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Drawing.Image]::FromFile('${png.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose(); 'ok'`;
  return new Promise((resolve, reject) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { stdio: 'ignore', windowsHide: true });
    c.on('error', (e) => reject(new Fatal(4, '设系统剪贴板失败：' + e.message)));
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Fatal(4, '设系统剪贴板失败，退出码 ' + code))));
  });
}

// 2026-10-20：Gemini 的「+ → 上传文件」在无头自动化下不触发 fileChooser 事件（input 被创建但选择器不弹），
// 改成「系统剪贴板放图 + 输入框 Ctrl+V」，实测稳定挂上 file-preview-chip。
// 2026-10-20 晚：新建 Edge 实例时窗口不在前台，Ctrl+V 会落到别的窗口 ⇒ 粘贴前先对输入框做一次真实坐标点击，
// 并每条目重试最多 3 次。
async function clickComposer(ctx) {
  await ctx.conn.send('Page.bringToFront', {}, ctx.sessionId);
  const rect = await ctx.evaluate(`(function(){
    var e = document.querySelector('div.ql-editor[contenteditable="true"]');
    if (!e) return null;
    e.scrollIntoView({block:'center'});
    var r = e.getBoundingClientRect();
    return {x: Math.round(r.left + Math.min(40, r.width/2)), y: Math.round(r.top + Math.min(16, r.height/2))};
  })()`);
  if (!rect) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.conn.send(
      'Input.dispatchMouseEvent',
      { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
      ctx.sessionId
    );
    await sleep(60);
  }
  await sleep(150);
  return true;
}
// 2026-10-20 21:2x：Gemini 会把「上一轮没发出去的草稿（含附件）」恢复出来 —— 实测一条失败批留下的
// 3 张图被带进下一批，变成一次发 6 张、两批页混在同一条消息里（这种批一定答不出来）。
// 挂图前先把输入框清干净，否则 base 计数把残留算进去，判定还会「通过」。
async function clearComposer(ctx) {
  let n = await chipCount(ctx);
  if (!n) return true;
  await clickComposer(ctx);
  for (let round = 0; round < 3 && n > 0; round += 1) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await ctx.conn.send(
        'Input.dispatchKeyEvent',
        { type, modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
        ctx.sessionId
      );
      await sleep(80);
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await ctx.conn.send(
        'Input.dispatchKeyEvent',
        { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
        ctx.sessionId
      );
      await sleep(80);
    }
    await sleep(600);
    n = await chipCount(ctx);
  }
  if (n > 0) {
    // 兜底：逐个点缩略图上的移除按钮
    await ctx.evaluate(`(function(){
      var btns = Array.from(document.querySelectorAll('.file-preview-chip button,[aria-label*=移除],[aria-label*=删除],[aria-label*=Remove]'));
      btns.forEach(function(b){ if (b.offsetParent !== null) b.click(); });
      return btns.length;
    })()`);
    await sleep(800);
    n = await chipCount(ctx);
  }
  if (n > 0) log('  清空输入框失败，仍有 ' + n + ' 张缩略图');
  return n === 0;
}

// 2026-10-20 19:4x：系统剪贴板连续粘贴到第 3 张必失败（探针实测：chips 30 秒卡在 2 不动，
// 与超时无关，是这版 Gemini 输入框的硬截断）。改用 CDP 拖拽一次投递整批 PNG：
// 实测 12 个文件 1 秒内挂上 10 张（Gemini 单条消息图片上限 = 10）。
async function dropFiles(ctx, files) {
  const rect = await ctx.evaluate(`(function(){
    var e = document.querySelector('div.ql-editor[contenteditable="true"]');
    if (!e) return null;
    e.scrollIntoView({block:'center'});
    var r = e.getBoundingClientRect();
    return {x: Math.round(r.left + Math.min(40, r.width/2)), y: Math.round(r.top + Math.min(16, r.height/2))};
  })()`);
  if (!rect) return false;
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await ctx.conn.send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data }, ctx.sessionId);
    await sleep(150);
  }
  return true;
}

// 2026-10-23 13:3x：Gemini 前端换版（输入框占位符从「与 Gemini 对话」变成「问问 Gemini」，发送键要打字后才出现）。
// 新版里拖拽和剪贴板虽然能把缩略图挂上，但模型一律回「通常我可以提供这类帮助，但我似乎无权访问该内容」——
// 图片实际没进模型。只有走官方「上传和工具 → 上传文件」的真实文件选择器（CDP Page.fileChooserOpened +
// DOM.setFileInputFiles）才认，且一次能塞整批。失败时不抛，返回 false 交给老的拖拽/剪贴板路径兜底。
async function uploadViaChooser(ctx, files) {
  try {
    await ctx.conn.send('Page.enable', {}, ctx.sessionId);
    await ctx.conn.send('DOM.enable', {}, ctx.sessionId);
  } catch { /* 已启用时重复调用无害 */ }
  // 1) 开「上传和工具」菜单
  // 2026-10-23 19:5x 实测：坐标点击在这个 Angular 菜单上经常「点了没反应」（菜单是 toggle，点第二下又会关掉），
  // 一旦没开成就会静默回退到拖拽 —— 而拖拽挂上的图只有缩略图、模型根本看不到，于是每批都拿到
  // 「通常我可以提供这类帮助，但我似乎无权访问该内容」。改成用元素自己的 click()。
  const hasItem = async () =>
    (await ctx.evaluate(`!!Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(function(e){ return (e.innerText||'').trim() === '上传文件'; })`)) === true;
  if (!(await hasItem())) {
    const raw = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('button,[role="button"]')).find(function(x){ return /上传和工具/.test(x.getAttribute('aria-label')||''); });
      if (!b) return 'null';
      b.click();
      var r = b.getBoundingClientRect();
      return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
    })()`);
    if (!raw || raw === 'null') { log('  新版上传：找不到「上传和工具」按钮'); return false; }
    const box = JSON.parse(raw);
    await sleep(1000);
    if (!(await hasItem())) {
      // 菜单是 toggle：上一次可能已经把它点开又关掉，这里用坐标再点一次
      await ctx.click(box.x, box.y);
      await sleep(1000);
    }
  }
  if (!(await hasItem())) { log('  新版上传：菜单里没有「上传文件」'); return false; }
  // 2) 先挂 fileChooser 监听，再用元素 click() 点菜单项
  try { await ctx.conn.send('Page.setInterceptFileChooserDialog', { enabled: true }, ctx.sessionId); } catch {}
  const chooser = ctx.conn.once('Page.fileChooserOpened');
  const clicked = await ctx.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(function(e){ return (e.innerText||'').trim() === '上传文件'; });
    if (!b) return 'no-item';
    b.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') { log('  新版上传：点不到「上传文件」'); return false; }
  const ev = await Promise.race([chooser, sleep(8000).then(() => null)]);
  try { await ctx.conn.send('Page.setInterceptFileChooserDialog', { enabled: false }, ctx.sessionId); } catch {}
  if (!ev || !ev.backendNodeId) { log('  新版上传：没等到文件选择器'); return false; }
  try {
    await ctx.conn.send('DOM.setFileInputFiles', { files, backendNodeId: ev.backendNodeId }, ctx.sessionId);
  } catch (e) {
    log('  新版上传：塞文件失败（' + e.message + '）');
    return false;
  }
  // 3) 等缩略图到齐，并确认没有「上传失败」
  for (let k = 0; k < 60; k += 1) {
    await sleep(1000);
    const n = await chipCount(ctx);
    if (n >= files.length) {
      // 再等「正在上传」消失，最多 30 s
      for (let t = 0; t < 30; t += 1) {
        const uploading = await ctx.evaluate(`/正在上传|上传中/.test(document.body.innerText||'')`);
        if (!uploading) break;
        await sleep(1000);
      }
      // 2026-10-23 20:0x：「正在上传」消失不代表服务端已经处理完，新版界面里立刻发送会拿到
      // 「我似乎无权访问该内容」（=模型看不到附件）。多等 8 秒再交出去。
      await sleep(8000);
      const bad = await ctx.evaluate(`/上传失败|无法上传|发生错误/.test(document.body.innerText||'')`);
      if (bad) { log('  新版上传：页面报上传失败'); return false; }
      log(`  文件选择器上传 ${files.length} 张`);
      return true;
    }
  }
  log('  新版上传：缩略图迟迟不到齐');
  return false;
}

async function attachImages(ctx, files) {
  if (!(await clickComposer(ctx))) throw new Fatal(4, '找不到输入框，无法粘贴图片');
  await clearComposer(ctx);
  const base = await chipCount(ctx);
  // 2026-10-20 19:4x：拖拽优先（剪贴板连续粘贴第 3 张起必失败）；不够数再回退下面的剪贴板逐张粘贴。
  if (files.length > 10) throw new Fatal(2, `单批最多 10 页（Gemini 单条消息图片上限），本批 ${files.length} 页`);
  // 2026-10-23 13:4x：Gemini 换新版界面后，拖拽/剪贴板挂上的图会被答「似乎无权访问该内容」，
  // 只有「上传和工具 → 上传文件」这条真实文件选择器路径才认，所以改成三档：文件选择器 → 拖拽 → 剪贴板。
  if (await uploadViaChooser(ctx, files)) return (await chipCount(ctx)) - base;
  log('  文件选择器路径没成，回退拖拽');
  if (await dropFiles(ctx, files)) {
    for (let k = 0; k < 30; k += 1) {
      await sleep(500);
      if ((await chipCount(ctx)) - base >= files.length) {
        log(`  拖拽挂上 ${files.length} 张`);
        return files.length;
      }
    }
    log('  拖拽后缩略图不够数，回退剪贴板逐张粘贴');
  }
  for (let i = 0; i < files.length; i += 1) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      await setClipboardImage(files[i]);
      await clickComposer(ctx);
      for (const type of ['rawKeyDown', 'keyUp']) {
        await ctx.conn.send(
          'Input.dispatchKeyEvent',
          { type, modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 },
          ctx.sessionId
        );
        await sleep(120);
      }
      for (let k = 0; k < 25; k += 1) {
        await sleep(400);
        if ((await chipCount(ctx)) >= base + i + 1) {
          ok = true;
          break;
        }
      }
      if (!ok) log(`  第 ${i + 1} 张没挂上，重试（第 ${attempt} 次）`);
    }
    if (!ok) throw new Fatal(4, `第 ${i + 1} 张图没挂上（粘贴后没出现缩略图）`);
    log(`  已挂第 ${i + 1}/${files.length} 张`);
  }
  return (await chipCount(ctx)) - base;
}
async function typeAndSend(ctx, text) {
  const ok = await ctx.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('div[contenteditable="true"],textarea')).filter(function(e){ return e.offsetParent !== null; })[0];
    if (!b) return 'no-input';
    b.focus();
    return 'ok';
  })()`);
  if (ok !== 'ok') throw new Fatal(4, '找不到输入框');
  // insertText 只往「真有焦点」的元素里塞，而 evaluate 里的 b.focus() 不保证拿到焦点
  // （复用的调试实例可能停在后台窗口）—— 2026-10-20 18:49 实测：图挂上了、指令却一个字没进去，
  // 于是整轮空转 135 s 超时。改成「先真实点一下输入框再输」，并校验长度、最多重试 3 次。
  let typedLen = 0;
  for (let attempt = 1; attempt <= 3 && typedLen <= 1; attempt += 1) {
    await clickComposer(ctx);
    await ctx.type(text);
    await sleep(900);
    typedLen = await ctx.evaluate(`(function(){
      var e = document.querySelector('div.ql-editor[contenteditable="true"]');
      return e ? e.innerText.length : 0;
    })()`);
    if (typedLen <= 1) log(`  指令没进输入框，重试（第 ${attempt} 次）`);
  }
  if (typedLen <= 1) throw new Fatal(4, '指令没输进输入框（insertText 没生效，可能窗口不在前台）');

  const respBefore = Number(await ctx.evaluate(`document.querySelectorAll('model-response').length`)) || 0;
  const sent = async () => {
    const info = await ctx.evaluate(`(function(){
      var e = document.querySelector('div.ql-editor[contenteditable="true"]');
      return JSON.stringify({ path: location.pathname, len: e ? e.innerText.length : -1,
        resp: document.querySelectorAll('model-response').length,
        said: /你说|You said/.test(document.body.innerText) });
    })()`);
    const { path: p, len, said, resp } = JSON.parse(info);
    // ⚠️ Quill 清空后的 innerText 是 "\n"（长度 1，不是 0）。2026-10-20 之前只判 `len === 0`，
    //    于是「文字已经发出去、输入框已清空」也判成没发出去 —— 实测 18:47 那次就是这样：
    //    会话已经在侧边栏建出来了，脚本却报「指令没发出去」，并因此漏删了会话。
    //    现在把「变空」也算作发出，但要求它先有过内容（typedLen > 1），避免一开始就误判。
    return /\/app\/[0-9a-f]{8,}/.test(p) || (typedLen > 1 && len <= 1) || said || resp > respBefore;
  };

  // 第一选择：点「发送」（现取坐标）
  const diag = () =>
    ctx.evaluate(`(function(){
      var e = document.querySelector('div[contenteditable="true"]');
      var sb = Array.from(document.querySelectorAll('button')).filter(function(b){
        return /发送|Send/.test(b.getAttribute('aria-label')||'') && b.offsetParent !== null;
      });
      return JSON.stringify({ len: e ? e.innerText.length : -1, sendBtn: sb.length, disabled: sb[0] ? sb[0].disabled : null,
        thumbs: document.querySelectorAll('img[src^="blob:"]').length, url: location.pathname });
    })()`);
  log('发送前：' + (await diag()));
  // 2026-10-23 19:5x：新版界面里坐标点「发送」经常点不动（按钮是新渲染的，坐标拿到后又被布局挪走），
  // 而元素自己的 click() 可靠 —— 先走它，再退回坐标点击和回车。
  const jsClick = await ctx.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(e){
      return /发送|Send/.test(e.getAttribute('aria-label')||'') && !e.disabled && e.offsetParent !== null;
    });
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  })()`);
  if (jsClick === 'ok') {
    for (let i = 0; i < 10; i += 1) {
      await sleep(600);
      if (await sent()) return 'js-click';
    }
    log('  元素 click() 点过发送但没发出去，退回坐标点击');
  }
  if (await clickByLabel(ctx, /^发送$|^Send$/)) {
    for (let i = 0; i < 10; i += 1) {
      await sleep(600);
      if (await sent()) return 'click';
    }
  }

  // 兜底：回车
  const press = async (type) =>
    ctx.conn.send(
      'Input.dispatchKeyEvent',
      { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      ctx.sessionId
    );
  await press('keyDown');
  await press('keyUp');
  for (let i = 0; i < 10; i += 1) {
    await sleep(600);
    if (await sent()) return 'enter';
  }
  throw new Fatal(4, '指令没发出去（点发送和回车都没建出新对话）');
}

const PAGES_RE = /===\s*第\s*(\d+)\s*页\s*===/g;

// 2026-10-23 19:3x：Gemini 新版界面里，答案不再挂在 `model-response` 的 innerText 上 ——
// 实测（纯文字问「只回一个字：好」）`model-response.innerText` 只有无障碍标签「Gemini 说」，
// 真答案「好」在 `model-response-content` / `.markdown.markdown-main-panel` 的 textContent 里。
// 旧代码读 innerText ⇒ 明明答完了却拿到 0-8 字，被判「答完但正文里没有页标记」，白跑一整批。
// 统一改读「末条回复的 markdown 容器 textContent」，并按需剥掉开头那句「Gemini 说」。
const ANSWER_TEXT_JS = `(function(){
  var rs = Array.from(document.querySelectorAll('model-response'));
  if (!rs.length) return '';
  var el = rs[rs.length - 1];
  var cands = el.querySelectorAll('model-response-content, .markdown.markdown-main-panel, .model-response-text');
  var node = cands.length ? cands[cands.length - 1] : el;
  var t = node.textContent || '';
  t = t.replace(/^Gemini\\s*说\\s*/, '').replace(/\\u00a0/g, ' ');
  return t.trim();
})()`;

function waitForPages(ctx, expectMax, budgetSeconds, baseResponses) {
  return waitForAnswer(ctx, expectMax, budgetSeconds, baseResponses);
}

/**
 * 2026-10-20 21:2x 改：判「答完」不再硬性要求正文里出现 `=== 第 N 页 ===`。
 *
 * 旧逻辑要求 `pages > 0 && 正文长度不变`，而密集教材页常要 200-300 s 才答完 —— 预算一到就判失败，
 * runner 于是回 /app 新开对话、把同样的图再发一遍（用户 2026-10-20 21:05 亲眼看到「已经答完又发一遍」）。
 * 现在改成盯「模型回复容器」本身：回复出现、不再显示「停止生成」、且回复文本连续两次采样长度不变
 * 就认为这一轮结束。有页标记就正常收，没页标记交给 extractTranscript 报「答完但没页标记」，
 * 绝不把已经答完的结果丢掉重发。
 */
async function waitForAnswer(ctx, expectMax, budgetSeconds, baseResponses) {
  const started = Date.now();
  const base = Number(baseResponses) || 0;
  let lastR = -1;
  let lastGrow = Date.now();
  let quiet = 0;
  while (Date.now() - started < budgetSeconds * 1000) {
    await sleep(3000);
    const info = await ctx.evaluate(
      `(function(){
        // 2026-10-23 19:3x：改读 markdown 容器的 textContent（新版 UI 里 innerText 只剩「Gemini 说」）
        var last = ${ANSWER_TEXT_JS};
        var rs = Array.from(document.querySelectorAll('model-response'));
        // 2026-10-20 21:3x 实测：Gemini 的「还在生成」标志是输入框右下那颗
        // button[aria-label="停止回答"]（32×32、display:flex、offsetParent 非空）；
        // 生成结束它会换回「发送」。正文里根本没有「停止生成 / Stop generating」这几个字，
        // 旧判据所以永远判成「不忙」⇒ 只要文本 3 秒不变就收工，把半页答案当成答完
        // （数据结构 p7-9 就这么只落了 405 字，而回答最后其实有 895 字）。
        var stopBtn = document.querySelector('button[aria-label*="停止"], button[aria-label*="Stop"]');
        var stopVisible = !!(stopBtn && stopBtn.getBoundingClientRect().width > 0);
        // 报错只在「本批新出现的那条回复」里判：旧会话/旧草稿的报错文本留在页面上，
        // 会让本来正常的一批在 1 秒内被误判成「生成被拒」（2026-10-20 21:19 那次就是）。
        var fresh = rs.length > ${base};
        return JSON.stringify({
          pages: (last.match(/===\\s*第\\s*\\d+\\s*页\\s*===/g) || []).length,
          busy: stopVisible,
          err: fresh && /出了点问题|Something went wrong|发生错误/.test(last),
          rlen: last.length
        });
      })()`
    );
    const { pages, busy, err, rlen } = JSON.parse(info);
    // 页面自己报错就别等了：这是账号/节点层面的生成失败，不是转写慢
    if (err && !busy) throw new Fatal(4, 'Gemini 页面报「出了点问题」（生成被拒，换节点或换账号再试）');
    if (rlen > lastR) { lastGrow = Date.now(); quiet = 0; }
    else if (rlen > 0 && rlen === lastR && !busy) quiet += 1;
    else quiet = 0;
    lastR = rlen;
    // 2026-10-20 21:5x 修：旧代码一见「页标记数够了」就 return ⇒ 第 N 个标记才刚出现、这一页
    // 一个字都还没写完，落盘自然是半页（数据结构 p9 只存到「进一步的」，真实后面还有十几行；
    // 物理04 p2 更狠，直接判成「答完但没页标记」）。现在必须**同时**满足：本批页标记够数 + 正文
    // 连续两次采样不涨（6 s）+ 停止按钮不亮，才算这一轮结束。
    if (quiet >= 2 && (expectMax <= 0 || pages >= expectMax)) return pages;
    // 页标记始终不够（模型没按格式输出）：安静 24 s 才认命，别把还在写的正文当答案。
    if (quiet >= 8) {
      log('⚠ 回复已停稳但页标记只有 ' + pages + '/' + expectMax + ' 个，按现有内容收尾');
      return pages;
    }
    // 流卡死：停止按钮一直亮着、**已经有内容**、正文 3 分钟没多一个字 ⇒ 这一轮不会自己好了。
    // 2026-10-20 22:1x 实测补上 `rlen > 0`：Gemini 有时先「想」两三分钟才吐第一个字（回复容器都还不存在），
    // 这时 rlen 一直是 0、lastGrow 永远不更新，旧判据会在 181 s 就判「卡住」并把空文本交上去 ——
    // 而那一刻请求其实还在跑，再过十几秒就整页吐完了（数据结构第 9 页就这么被丢掉一次，
    // 最后是靠「不重发、直接从页面抢救」才补回来的）。
    if (busy && rlen > 0 && Date.now() - lastGrow > 180000) {
      log('⏳ 回复卡住（停止按钮亮着、正文 ' + Math.round((Date.now() - lastGrow) / 1000) + 's 没增长），先把已有内容落下');
      return pages;
    }
  }
  throw new Fatal(4, '等转写超时（' + Math.round(budgetSeconds) + 's 内回复没稳定下来）');
}

// 纯文本处理（页标记识别 / 模型名噪声 / 页拆分 / 质量门 / 单页无标记兜底）抽到 `tools/ocr-text.mjs`：
// 本文件尾部是顶层 try/finally + process.exit，测试无法 import，纯函数放那边才能单测。
import {
  acceptSinglePageText,
  extractTranscript,
  qualityOf,
  splitPages,
} from './ocr-text.mjs';

function writeResult(outDir, tier, pdf, pages, meta = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const header = [
    `# ${path.basename(pdf)} · ${tier} 转写`,
    '',
    `- 来源：\`${pdf}\``,
    `- 通道：${tier}`,
    `- 方式：${meta.method || ''}`,
    `- 时间：${new Date().toISOString()}`,
    `- 页数：${pages.length}`,
    '- 注意：页眉页脚可能未转写；公式为 LaTeX 源码',
    ''
  ].join('\n');
  for (const p of pages) {
    fs.writeFileSync(path.join(outDir, `${tier}-page${String(p.no).padStart(2, '0')}.md`), `# 第 ${p.no} 页\n\n${p.body}\n`, 'utf8');
  }
  const all = header + pages.map((p) => `## 第 ${p.no} 页\n\n${p.body}`).join('\n\n') + '\n';
  fs.writeFileSync(path.join(outDir, `${tier}-全文.md`), all, 'utf8');
  return all;
}

// ---------- 第一档：Gemini 本体 ----------

/** 本次运行在 Gemini 里开出来的会话 id（跑完要删，`--keep-conversation` 时保留）。 */
let lastConversationId = null;

/** 从当前地址取会话 id（`/app/<hex>`）；还在首页时就返回 null。 */
async function conversationIdFromPage(ctx) {
  const p = await ctx.evaluate('location.pathname');
  const m = String(p || '').match(/\/app\/([0-9a-f]{6,})/);
  return m ? m[1] : null;
}

/**
 * 地址栏还没跳转时的兜底：在侧边栏里找标题以本次指令开头的那一行。
 *
 * 2026-10-20 实测：Gemini 有时会把新会话建出来、侧边栏已经出现，
 * 地址栏却还停在 `/app`（生成中也可能这样）。只认「标题以我们指令开头」的行，
 * 避免误删别人或别的会话。
 */
async function conversationIdByPrompt(ctx, prefix) {
  const head = String(prefix || '').slice(0, 12);
  if (head.length < 10) return null;
  const found = await ctx.evaluate(`(function(){
    var want = ${JSON.stringify(head)};
    var rows = Array.from(document.querySelectorAll('a[href*="/app/"]'));
    for (var i = 0; i < rows.length; i += 1) {
      var t = (rows[i].innerText || '').trim();
      if (t.indexOf(want) === 0) {
        var m = (rows[i].getAttribute('href') || '').match(/\\/app\\/([0-9a-f]{6,})/);
        if (m) return m[1];
      }
    }
    return null;
  })()`);
  return found || null;
}

/** 这次 Gemini 一档是不是在「临时对话」里跑的（临时对话不落近期会话，就不用再删）。 */
let lastGeminiTempMode = false;

/**
 * 2026-10-20 21:1x：`Page.navigate('/app')` 有时并不会回到空白新对话，而是把**上一次会话连同草稿**
 * 恢复出来。后果很脏：新一批的图被追加进旧对话，正文里旧答案的页标记污染计数（旧逻辑 `pages > maxPages`
 * 直接 break 再抛超时），`extractTranscript` 还会从旧答案里抠出上一批的文字当成本批结果。
 * 这里在挂图前强制回到「正文里 0 个页标记、没有『你说』、输入框空、没有附件」的干净新对话。
 */
async function ensureFreshChat(ctx) {
  const probe = () =>
    ctx.evaluate(`(function(){
      var body = document.body.innerText || '';
      var ed = document.querySelector('div.ql-editor[contenteditable="true"]');
      return JSON.stringify({
        pages: (body.match(/===\\s*第\\s*\\d+\\s*页\\s*===/g) || []).length,
        said: /你说|You said/.test(body),
        len: ed ? ed.innerText.length : -1,
        chips: Array.from(document.querySelectorAll('.file-preview-chip,uploader-file-preview')).filter(function(x){return x.offsetParent!==null}).length
      });
    })()`);
  for (let round = 1; round <= 3; round += 1) {
    const st = JSON.parse(await probe());
    if (st.pages === 0 && !st.said && st.chips === 0 && st.len <= 1) return true;
    log(`  页面还停在上一轮（页标记 ${st.pages}，草稿 ${st.len} 字，附件 ${st.chips}）⇒ 点「发起新对话」重置`);
    const clicked = await clickByLabel(ctx, /^(发起新对话|新对话|New chat)$/);
    if (!clicked) {
      await navigate(ctx, 'https://gemini.google.com/app', 4000);
    }
    await sleep(2500);
  }
  const st = JSON.parse(await probe());
  if (st.pages === 0 && !st.said && st.chips === 0) return true;
  throw new Fatal(4, '重置不到空白新对话（正文仍有 ' + st.pages + ' 个页标记 / ' + st.chips + ' 个附件）');
}

async function tierGemini(ctx, files, maxPages, budget) {
  await navigate(ctx, 'https://gemini.google.com/app', 5000);
  const guarded = await ctx.evaluate(`/不支持你所在的地区|not available in your country/.test(document.body.innerText)`);
  if (guarded) throw new Fatal(4, 'Gemini 判定账号不支持当前地区');
  await ensureFreshChat(ctx);
  // 优先走「临时对话」：不改账号里的历史，比「事后删会话」稳得多（删除要靠菜单 DOM，容易失灵）。
  // 实测 2026-10-20：点一下「临时对话」后界面出现「不会显示在近期对话…存储 72 小时」的提示。
  // 2026-10-23 19:5x：OCR_NO_TEMP=1 可以强制走普通新对话（新版界面里「临时对话」疑似收不到附件，用来对照排查）
  const tempClicked = process.env.OCR_NO_TEMP === '1'
    ? false
    : await clickByLabel(ctx, /^临时对话$|^Temporary chat$/);
  await sleep(1500);
  lastGeminiTempMode =
    tempClicked &&
    (await ctx.evaluate(
      `/不会显示在近期对话|won't appear in recent|Not show up in recent|临时对话.*72 小时|Temporary chats? (are|is)/.test(document.body.innerText)`
    ));
  log(lastGeminiTempMode ? 'Gemini：已切到临时对话（不落近期会话）' : 'Gemini：临时对话不可用，跑完删会话');
  // 本轮发送前页面上已有几条模型回复（正常情况下 ensureFreshChat 之后应该是 0）。
  // 后面判「页面报错」只认比这个数多出来的新回复，免得被旧会话的报错文本误伤。
  const baseN = Number(await ctx.evaluate(`document.querySelectorAll('model-response').length`)) || 0;
  await attachImages(ctx, files);
  await sleep(1500);
  try {
    await typeAndSend(ctx, PROMPT);
  } finally {
    // 无论 typeAndSend 判成功还是抛错，都先把会话 id 抓下来：Gemini 常常「会话建出来了、
    // 但地址栏没跳、输入框已清空」，漏抓就等于漏删（2026-10-20 18:47 那次就是这么漏的）。
    lastConversationId = (await conversationIdFromPage(ctx)) || (await conversationIdByPrompt(ctx, PROMPT));
    if (lastConversationId) log('Gemini 本体：会话 id = ' + lastConversationId);
  }
  log('Gemini 本体：指令已发送，等待转写…');
  const n = await waitForPages(ctx, maxPages, budget, baseN);
  // 只认「最后一条模型回复」的文本：整页 innerText 里可能还挂着旧会话的答案（临时对话/草稿恢复时），
  // 那样 extractTranscript 会从旧答案里抠字当本批结果 —— 那是最坏的假字。
  // 2026-10-23 19:3x：改走 ANSWER_TEXT_JS（新版 UI 的答案在 textContent 里，innerText 只有「Gemini 说」）。
  const raw = await ctx.evaluate(ANSWER_TEXT_JS);
  const body = raw && raw.length > 20 ? raw : await ctx.evaluate('document.body.innerText');
  let text = extractTranscript(body);
  // 2026-10-21 15:0x：单页批次时模型经常「答完就收」、不写 `=== 第 N 页 ===`（实测数据结构教材 p52：
  // 回复已停稳但页标记 0/1）。extractTranscript 以「第 1 页」标记为锚点，没标记就回 null ⇒ 整段好字被
  // 当成失败丢掉。本批只上传了一张图时不存在「文字对不回页」的风险，整段就是这一页；多页批次仍必须
  // 报失败（没标记无法知道哪段属于哪页），交给上层（`_工具/夜间取字/run-nightly.mjs`）拆成单页重跑。
  // 判定逻辑在 `tools/ocr-text.mjs`，那边有单测（这里文件尾是顶层 process.exit，测试 import 不了）。
  if (!text && maxPages === 1) {
    const whole = acceptSinglePageText(raw, body);
    if (whole.ok) {
      log('  · 单页无页标记：整段按第 1 页收（' + whole.chars + ' 字）');
      text = whole.text;
    } else {
      log('  · 单页无页标记，但正文不可用（' + whole.reason + '，' + whole.chars + ' 字）');
    }
  }
  if (!text) throw new Fatal(4, '答完了但正文里没有页标记（模型没按格式输出）');
  const pages = splitPages(text);
  // 2026-10-20 21:4x：模型偶尔把第 1 页整段照抄一遍当第 2 页（用户亲眼看到「第 1 页和第 2 页一字不差」）。
  // 这种重复会把后面每页都往前错一位 —— 必须删掉重复的那一节，让剩下各节重新对上图片顺序。
  const normOf = (s) => String(s || '').replace(/\s+/g, '');
  for (let i = pages.length - 1; i >= 1; i -= 1) {
    const a = normOf(pages[i]);
    if (a.length > 80 && a === normOf(pages[i - 1])) {
      log('  ⚠ 第 ' + (i + 1) + ' 段与第 ' + i + ' 段内容完全相同（模型重复输出），已丢弃这一段');
      pages.splice(i, 1);
    }
  }
  // 2026-10-20 21:1x：模型偶尔多写一节（本批只传了 N 页，它却输出 N+1 个页标记）。多出来的那页没有
  // 对应图片，内容就是编的 —— 绝不能落盘，否则会被当成「这页已取」。
  if (pages.length > maxPages && maxPages > 0) {
    log('  ⚠ 模型多写了 ' + (pages.length - maxPages) + ' 页（本批只上传 ' + maxPages + ' 页），只保留前 ' + maxPages + ' 页');
    pages.length = maxPages;
  }
  if (!pages.length) {
    // 把「模型到底写了什么」留在日志里：只报「页拆分失败」没法排查（是标记变形还是正文没出来）
    log('Gemini 本体：页标记原文 = ' + JSON.stringify(text.slice(0, 200)));
    throw new Fatal(4, '页拆分失败');
  }
  return pages;
}

// ---------- 第二档：NotebookLM ----------

async function tierNotebook(ctx, pdf, maxPages, budget) {
  await navigate(ctx, 'https://notebooklm.google.com/', 6000);
  const url = await ctx.evaluate('location.href');
  if (/location=unsupported/.test(url)) throw new Fatal(4, 'NotebookLM 被地区拦截（location=unsupported）');

  // 新建笔记本
  const newBox = await ctx.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('button')).filter(function(x){
      return /新建|Create new|Add notebook/.test((x.getAttribute('aria-label')||'') + ' ' + x.innerText);
    })[0];
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
  })()`);
  if (!newBox) throw new Fatal(4, '找不到「新建」按钮（NotebookLM 页面结构可能变了）');
  await ctx.click(...Object.values(JSON.parse(newBox)));
  await sleep(2500);

  // 上传 PDF 作为来源
  const inputs = await ctx.evaluate(`document.querySelectorAll('input[type=file]').length`);
  if (!inputs) throw new Fatal(4, 'NotebookLM 没有文件输入框');
  const doc = await ctx.conn.send('DOM.getDocument', { depth: 1 }, ctx.sessionId);
  const { nodeId } = await ctx.conn.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, ctx.sessionId);
  if (!nodeId) throw new Fatal(4, 'NotebookLM 文件输入框定位失败');
  await ctx.conn.send('DOM.setFileInputFiles', { nodeId, files: [pdf] }, ctx.sessionId);
  log('NotebookLM：已提交 PDF，等来源处理…');
  await sleep(12000);

  await typeAndSend(ctx, PROMPT);
  const n = await waitForPages(ctx, maxPages, budget);
  const raw = await ctx.evaluate('document.body.innerText');
  const text = extractTranscript(raw);
  if (!text) throw new Fatal(4, 'NotebookLM 文本里没有页标记（可能需要代码块指令）');
  return splitPages(text);
}

async function deleteNotebook(ctx) {
  try {
    await ctx.evaluate(`history.back()`);
    await sleep(3000);
    // hover 第一行 → 行内「更多选项」→ 删除 → 全部删除
    const row = await ctx.evaluate(`(function(){
      var r = document.querySelectorAll('[role="row"], a[href*="/notebook/"]')[0];
      if (!r) return null;
      var b = r.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 40), y: Math.round(b.y + b.height/2) });
    })()`);
    if (!row) return;
    const { x, y } = JSON.parse(row);
    await ctx.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, ctx.sessionId);
    await sleep(800);
    const ops = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('button')).filter(function(x){ return /更多选项|More options|打开笔记本操作菜单/.test(x.getAttribute('aria-label')||''); })[0];
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`);
    if (!ops) return;
    await ctx.click(...Object.values(JSON.parse(ops)));
    await sleep(1200);
    const del = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('button,li,div[role="menuitem"]')).filter(function(x){ return /^删除$|^Delete$/.test((x.innerText||'').trim()); })[0];
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`);
    if (!del) return;
    await ctx.click(...Object.values(JSON.parse(del)));
    await sleep(1500);
    const confirm = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('button')).filter(function(x){ return /全部删除|Delete all|删除/.test((x.innerText||'').trim()); })[0];
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`);
    if (confirm) await ctx.click(...Object.values(JSON.parse(confirm)));
    log('NotebookLM：已删除临时笔记本');
  } catch (e) {
    log('NotebookLM：删笔记本失败（需手动清）', e.message);
  }
}

/**
 * 删掉本次运行在 Gemini 里开出来的那个会话（尽力而为，删不掉只记日志）。
 *
 * 为什么需要：取字批次一次要开十几个会话，不清理就在账号里堆一堆「扫描件转写」，
 * 下次手工找东西时全被它们挤下去（2026-10-20 用户要求「工具跑完自动删会话」）。
 *
 * 定位方式：发送后地址栏是 `/app/<id>`，回到 `/app` 列表按 href 里含该 id 找那一行——
 * 不依赖「第一行就是刚开的」，比 NotebookLM 那版更稳（那里只能按第一行猜）。
 * 点开菜单一律用页面内 element.click()：CDP 坐标点击在 Gemini 上常命中子节点，Angular 不认。
 */
async function deleteGeminiConversation(ctx, id) {
  if (!id) {
    log('Gemini：没记到会话 id，跳过删除');
    return;
  }
  const rid = JSON.stringify(String(id));
  try {
    await navigate(ctx, 'https://gemini.google.com/app', 4000);
    await sleep(1500);
    // 1) 在侧边栏找到这次那条会话，hover 让它显出「更多选项」
    const found = await ctx.evaluate(`(function(){
      var a = Array.from(document.querySelectorAll('a[href*="/app/"]')).filter(function(x){
        return (x.getAttribute('href')||'').indexOf(${rid}) >= 0;
      })[0];
      if (!a) return null;
      a.scrollIntoView({block:'center'});
      var r = a.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`);
    if (!found) {
      log('Gemini：侧边栏里没找到这条会话（可能已滚出首屏），跳过删除');
      return;
    }
    const pos = JSON.parse(found);
    await ctx.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', buttons: 0 }, ctx.sessionId);
    await sleep(800);
    // 2)「更多选项」→「删除」→（有二次确认就再点一次「删除」）
    const opened = await ctx.evaluate(`(function(){
      var a = Array.from(document.querySelectorAll('a[href*="/app/"]')).filter(function(x){
        return (x.getAttribute('href')||'').indexOf(${rid}) >= 0;
      })[0];
      if (!a) return 'no-row';
      var scope = a.closest('li,[role="listitem"],div') || a.parentElement || document;
      var b = Array.from(scope.querySelectorAll('button')).filter(function(x){
        return /更多选项|More options|Conversation options|会话选项/.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||''));
      })[0];
      if (!b) return 'no-menu-button';
      try { b.click(); } catch (e) { return 'click-failed'; }
      return 'ok';
    })()`);
    if (opened !== 'ok') {
      log('Gemini：没点开会话菜单（' + opened + '），跳过删除');
      return;
    }
    await sleep(1000);
    const clicked = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('[role="menuitem"],button,li,div')).filter(function(x){
        return /^删除$|^Delete$/.test((x.innerText||'').trim()) && x.offsetParent !== null;
      })[0];
      if (!b) return false;
      try { b.click(); } catch (e) {}
      return true;
    })()`);
    if (!clicked) {
      log('Gemini：菜单里没有「删除」，跳过');
      return;
    }
    await sleep(1500);
    const confirmed = await ctx.evaluate(`(function(){
      var b = Array.from(document.querySelectorAll('button')).filter(function(x){
        return /^删除$|^Delete$/.test((x.innerText||'').trim()) && x.offsetParent !== null;
      })[0];
      if (!b) return false;
      try { b.click(); } catch (e) {}
      return true;
    })()`);
    await sleep(1000);
    const left = await ctx.evaluate(`(function(){
      return Array.from(document.querySelectorAll('a[href*="/app/"]')).some(function(x){
        return (x.getAttribute('href')||'').indexOf(${rid}) >= 0;
      });
    })()`);
    if (left) log('Gemini：删会话未确认成功（列表里还在，需手动清）');
    else log(confirmed ? 'Gemini：已删除本次会话' : 'Gemini：会话已从列表消失');
  } catch (e) {
    log('Gemini：删会话失败（需手动清）', e.message);
  }
}

// ---------- 第三档：本机视觉模型（Ollama，不外传） ----------

const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_APP = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
const VISION_MODEL = process.env.STUDY_VISION_MODEL || 'qwen2.5vl:7b';

const VISION_PROMPT = [
  '这是一页中文大学作业的扫描图。请逐字转写本页上的全部文字与公式：',
  '1) 保持原有题号与段落顺序，不要合并或改写；',
  '2) 公式一律用 LaTeX 写在 $...$ 里（行间公式用 $$...$$）；',
  '3) 只转写，不要解题、不要解释、不要补全；',
  '4) 看不清的符号用 ??? 标记，不要猜。'
].join('\n');

async function ollamaUp() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureOllama() {
  if (await ollamaUp()) return true;
  if (!fs.existsSync(OLLAMA_APP)) return false;
  log('Ollama 没在跑，尝试启动（官方应用，非自造外壳）…');
  try {
    const child = spawn(OLLAMA_APP, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    log('Ollama 启动失败：' + e.message);
    return false;
  }
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    if (await ollamaUp()) return true;
  }
  return false;
}

// 模型偶发死循环：同一行刷几十遍。识别出来就降 num_predict 再试一次。
function looksRunaway(text) {
  if (text.length > 12000) return true;
  const counts = new Map();
  for (const line of text.split('\n')) {
    const key = line.trim();
    if (key.length < 8) continue;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > 12) return true;
  }
  return false;
}

// 死循环时保命：把重复开始之前的内容留下（通常已经是这一页的正文）
function trimRunaway(text) {
  const counts = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const key = lines[i].trim();
    if (key.length < 8) continue;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > 3) {
      const kept = lines.slice(0, i).join('\n').trim();
      return { text: kept, truncated: true };
    }
  }
  const kept = text.slice(0, 4000).trim();
  return { text: kept, truncated: text.length > kept.length };
}

async function ollamaOnce(b64, numPredict) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: VISION_PROMPT,
      images: [b64],
      stream: false,
      options: { temperature: 0, num_ctx: 12288, num_predict: numPredict }
    }),
    signal: AbortSignal.timeout(600000)
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 200);
    try {
      msg = JSON.parse(raw)?.error?.message || msg;
    } catch {}
    throw new Fatal(4, `视觉模型返回 ${res.status}：${msg}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Fatal(4, '视觉模型输出不是 JSON');
  }
  return String(data.response || '').trim();
}

async function visionOne(page, index, total) {
  const b64 = fs.readFileSync(page.path).toString('base64');
  const t0 = Date.now();
  let body = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      body = await ollamaOnce(b64, attempt === 1 ? 1600 : 800);
      lastErr = null;
    } catch (e) {
      lastErr = e;
      log(`  第 ${index + 1} 页第 ${attempt} 次请求失败（${e.message}），等 5 s 重试`);
      await sleep(5000);
      const up = await ensureOllama();
      if (!up) throw new Fatal(4, `Ollama 掉线且起不来（第 ${index + 1} 页）`);
      continue;
    }
    if (!body) {
      lastErr = new Error('空输出');
      continue;
    }
    if (looksRunaway(body)) {
      const trimmed = trimRunaway(body);
      if (trimmed.text.length >= 40) {
        log(`  第 ${index + 1} 页输出中途开始重复，已截断保留 ${trimmed.text.length} 字`);
        body = trimmed.text + '\n\n> ⚠️ 本页转写在中途开始重复，已截断；图形/电路部分请对照原 PDF 核对。';
        break;
      }
      log(`  第 ${index + 1} 页输出像死循环（${body.length} 字），降上限重试`);
      lastErr = new Error('输出重复');
      body = null;
      continue;
    }
    break;
  }
  if (!body) throw new Fatal(4, `视觉模型没给出可用结果（第 ${index + 1} 页）：${lastErr?.message || 'unknown'}`);
  log(`  第 ${index + 1}/${total} 页完成：${body.length} 字，${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { no: index + 1, body };
}

async function tierVision(images, budgetSeconds) {
  if (!(await ensureOllama())) throw new Fatal(4, `Ollama 不可用（${OLLAMA}），先启动 Ollama 应用`);
  const list = images.map((p) => ({ path: p }));
  const pages = new Array(list.length).fill(null);
  const started = Date.now();
  let cursor = 0;
  const workers = Array.from({ length: 1 }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      if ((Date.now() - started) / 1000 > budgetSeconds) throw new Fatal(4, '视觉模型超预算');
      try {
        pages[i] = await visionOne(list[i], i, list.length);
      } catch (e) {
        log(`  第 ${i + 1} 页转写失败（${e.message}），先留空继续下一页`);
        pages[i] = {
          no: i + 1,
          body: `> ⚠️ 本页自动转写失败（图形/电路较复杂或模型反复出错），请对照原 PDF 第 ${i + 1} 页人工核对。\n> 失败原因：${e.message}`,
          failed: true
        };
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch (e) {
    throw e instanceof Fatal ? e : new Fatal(4, '视觉模型失败：' + e.message);
  }
  const out = pages.filter(Boolean).map((p, i) => ({ no: i + 1, body: p.body }));
  if (!out.length) throw new Fatal(4, '视觉模型没有产出');
  return out;
}

// ---------- 第四档：本地 RapidOCR ----------

async function tierLocal(pdf, outDir, maxPages, from = 1, to = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'local-ocr.md');
  log('本地 RapidOCR 开跑（慢，但不外传）…');
  const args = [OCR_CLI, pdf, '--out', outFile, '--engine', 'rapid', '--scale', '3', '--pages', `${from}-${to || maxPages}`];
  await new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let err = '';
    child.stdout.setEncoding('utf8').on('data', () => {});
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Fatal(4, 'OCR 起不来：' + e.message)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Fatal(4, 'RapidOCR 失败：' + err.slice(-300)))));
  });
  if (!fs.existsSync(outFile)) throw new Fatal(4, 'RapidOCR 没产出 ' + outFile);
  const raw = fs.readFileSync(outFile, 'utf8');
  // 脚本输出形如 「===== p.3  [rapid 12块 1.2s] =====\n正文」
  const pages = [];
  const re = /^=====\s*p\.(\d+)\s+\[[^\]]*\]\s*=====\s*$/gm;
  const hits = [...raw.matchAll(re)];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index + hits[i][0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : raw.length;
    pages.push({ no: Number(hits[i][1]), body: raw.slice(start, end).trim() });
  }
  if (!pages.length) throw new Fatal(4, 'RapidOCR 输出里没有页标记');
  return pages;
}

// ---------- 主流程 ----------

let keepTmp = false;
let args;
const tmpDir = path.join(os.tmpdir(), 'ocr-chain-' + Date.now());
const tried = [];

try {
  args = parseArgs(process.argv.slice(2));
  keepTmp = args.keep;
  const outDir = outputDirFor(args.pdf, args.out);

  const order = args.tier === 'chain' ? ['gemini', 'notebook', 'vision', 'local'] : [args.tier];

  // 只渲染不取字：给「助手看图转写」这条兜底路用
  if (args.renderOnly) {
    const made = await renderPages(args.pdf, tmpDir, args.maxPages, args.scale, args.pageFrom, args.pageTo);
    const files = made.made.map((m) => m.path);
    console.log(JSON.stringify({ ok: true, mode: 'render-only', pages: files.length, dir: tmpDir, files }));
    keepTmp = true;
    process.exit(0);
  }

  let ctx = null;

  if (order.some((t) => t === 'gemini' || t === 'notebook')) {
    await ensureBrowser();
    const attached = await attach();
    ctx = makeCtx(attached.conn, attached.sessionId);
  }

  let made = null;
  if (order.some((t) => t !== 'local')) {
    made = await renderPages(args.pdf, tmpDir, args.maxPages, args.scale, args.pageFrom, args.pageTo);
  }

  const offset = (args.pageFrom || 1) - 1;
  const shift = (pages) => (offset ? pages.map((p) => ({ no: p.no + offset, body: p.body })) : pages);
  const count = args.pageFrom ? args.pageTo - args.pageFrom + 1 : args.maxPages;

  const tiers = {
    gemini: async () => {
      try {
        const pages = shift(await withTimeout(tierGemini(ctx, made.made.map((m) => m.path), count, args.budgetGemini), args.budgetGemini + 15, 'Gemini 本体'));
        return { pages, method: 'PDF → PNG（scale 3）→ Gemini 本体 → 固定转写指令 → 删会话', tier: 'gemini' };
      } finally {
        // 默认不删（用户 2026-10-20 晚定）：临时对话不落历史，也就没什么可删的；
        // 万一切不到临时对话，也**不碰**账号里已有的任何会话 —— 要清必须显式 --delete-conversation。
        // 删除依赖菜单 DOM（实测能成功，但脆弱），绝不能默认跑在别人的账号历史上。
        if (args.deleteConversation && !args.keepConversation && !lastGeminiTempMode) {
          await deleteGeminiConversation(ctx, lastConversationId);
        } else if (!lastGeminiTempMode) {
          log('Gemini：本次会话未清理（默认不删；要清加 --delete-conversation）');
        }
      }
    },
    notebook: async () => {
      const pages = shift(await withTimeout(tierNotebook(ctx, args.pdf, count, args.budgetNotebook), args.budgetNotebook + 30, 'NotebookLM'));
      await deleteNotebook(ctx);
      return { pages, method: 'PDF 直传 NotebookLM → 固定转写指令 → 删笔记本', tier: 'notebook' };
    },
    vision: async () => {
      const pages = shift(await tierVision(made.made.map((m) => m.path), args.budgetVision));
      return { pages, method: `PDF → PNG（scale 3）→ 本机 Ollama ${VISION_MODEL}（不外传）`, tier: 'vision' };
    },
    local: async () => {
      const pages = await tierLocal(args.pdf, outDir, args.maxPages, args.pageFrom || 1, args.pageTo || null);
      return { pages, method: '_工具/OCR统一入口.py --engine rapid（本机，不外传）', tier: 'local' };
    }
  };

  for (const name of order) {
    log(`—— 第 ${tried.length + 1} 档：${name} ——`);
    try {
      const res = await tiers[name]();
      const text = res.pages.map((p) => p.body).join('\n');
      const q = qualityOf(text);
      if (q.suspect) {
        tried.push({ name, ok: false, reason: `质量门：${q.ratio * 100}% 的字母都是「${q.topChar}」` });
        log(`质量门命中（${q.ratio}），降级`);
        continue;
      }
      if (res.tier !== 'local') writeResult(outDir, `tier-${res.tier}`, args.pdf, res.pages, { method: res.method });
      else writeResult(outDir, 'tier-local', args.pdf, res.pages, { method: res.method });
      tried.push({ name, ok: true, pages: res.pages.length });
      log(`成功：${name}，${res.pages.length} 页 → ${outDir}`);
      console.log(JSON.stringify({ ok: true, tier: name, pages: res.pages.length, outDir, tried }));
      if (ctx) ctx.conn.close();
      await sleep(150);
      process.exit(0);
    } catch (e) {
      tried.push({ name, ok: false, reason: e.message });
      log(`${name} 失败：${e.message}`);
      if (e instanceof Fatal && e.code === 3) throw e;
    }
  }
  throw new Fatal(4, '所有档都失败：' + tried.map((t) => `${t.name}（${t.reason}）`).join('；'));
} catch (e) {
  keepTmp = true;
  if (e instanceof Fatal) {
    console.error('[ocr] 失败：' + e.message);
    if (tried.length) console.error('[ocr] 尝试记录：' + JSON.stringify(tried));
    process.exit(e.code);
  }
  console.error('[ocr] 意外错误：' + (e?.stack || e));
  process.exit(4);
} finally {
  if (!keepTmp) fs.rmSync(tmpDir, { recursive: true, force: true });
  else log('临时 PNG 保留在', tmpDir);
}
