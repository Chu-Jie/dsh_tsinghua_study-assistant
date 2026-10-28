/**
 * 听课面板（M1 自检版）
 *
 * 页面本体在同目录的 `panel.html`，**每次请求现读盘**，所以改页面只要刷新浏览器，
 * 不必重启 DSH。这一点很要紧：宿主侧 `lib/*.js` 在本机的 profile 里没配 `hmr`
 * 的 module root，改了要重启整个桌面端才生效，而调页面是高频动作。
 *
 * 为什么是一张**独立页面**、而不是 DSH 的客户端插件插槽：
 *   DSH 3 的 Electron 会话把权限请求一律拒掉
 *   （`setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); })`），
 *   在它的窗口里 getUserMedia 永远失败，和 Windows 隐私设置无关。
 *   而插件经 `ctx.webServer.register({kind:'prefix'})` 挂上的路由**不受 DSH
 *   浏览器会话鉴权约束**（裸 URL 就能拿到 200），所以在系统浏览器（Edge）里
 *   用 `http://127.0.0.1:<DSH Web UI 端口>/api/study-assistant/lecture/panel` 打开即可
 *   （端口每次重启都变：看宿主启动日志，或从监听端口反查宿主进程）——
 *   127.0.0.1 属于浏览器安全上下文，麦克风只差一次「允许」。
 *   好处是一次都不用碰 `app.asar`，也不用去凑那个每进程内存态、不落盘的 launch token。
 *
 * 页面本身**零依赖**：只 import 我们自己的 `./wav.js`（与 Node 端同一份源码），
 * 由 api.js 按 `CLIENT_MODULE_FILES` 白名单直接读盘送出。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 页面用到的客户端模块（相对本目录），由 api.js 按文件名直接读盘送出。 */
export const CLIENT_MODULE_FILES = ['wav.js', 'adts.js'];

/** 页面文件名。单独导出，方便测试与排障直接定位。 */
export const PANEL_FILE = 'panel.html';

/**
 * 录音导入页的文件名。
 *
 * 它和听课台是**两张页面**：听课台每节课都用，导入页只在「第一次拿真实录音
 * 量识别率」这类时候打开一次，塞在一起会把主界面撑得没人愿意看。
 */
export const IMPORT_FILE = 'import.html';

/** 取客户端模块的绝对路径。只允许白名单内的文件名，挡掉路径穿越。 */
export function clientModulePath(name) {
  if (!CLIENT_MODULE_FILES.includes(name)) return null;
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/** 面板 HTML 的绝对路径。 */
export function panelHtmlPath() {
  return fileURLToPath(new URL(`./${PANEL_FILE}`, import.meta.url));
}

/** 读面板 HTML。刻意不走缓存：页面迭代只该需要刷新浏览器。 */
export async function readPanelHtml() {
  return await readFile(panelHtmlPath(), 'utf8');
}

/** 导入页 HTML 的绝对路径。 */
export function importHtmlPath() {
  return fileURLToPath(new URL(`./${IMPORT_FILE}`, import.meta.url));
}

/** 读导入页 HTML。同样每次现读盘。 */
export async function readImportHtml() {
  return await readFile(importHtmlPath(), 'utf8');
}
