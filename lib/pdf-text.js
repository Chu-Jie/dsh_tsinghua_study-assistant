/**
 * PDF 取文字（本地、零网络、零系统依赖）
 *
 * 用的是随包 vendor 进来的 pdf.js（`vendor/pdfjs/pdf.mjs`，Apache-2.0，来源与许可见同目录 LICENSE）。
 * 只取文字层，**不做 OCR**、不渲染、不落盘：扫描件没有文字层时明确报 `no-text`，
 * 让上层提示用户「这份是图片型 PDF」，而不是编一段空文本。
 *
 * pdf.js 的浏览器构建在 Node 里会引用三个 DOM 全局（`DOMMatrix` / `ImageData` / `Path2D`）。
 * 纯取文字其实用不到它们，所以这里补三个空壳：有方法就返回自身，避免 `ReferenceError`。
 * 这是整套方案里唯一「为了跑通而写外壳」的地方，注释写明原因，免得后人以为是死代码。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDFJS_ENTRY = path.join(HERE, '..', 'vendor', 'pdfjs', 'pdf.mjs');
/** pdf.js 5 在 Node 里走 fake worker，仍然会 import 这个文件；没有它取字直接失败。 */
const PDFJS_WORKER = path.join(HERE, '..', 'vendor', 'pdfjs', 'pdf.worker.mjs');

/** 单次最多读 20 页：作业原题一般 1–4 页，20 页足够且不会把整本书拖进内存。 */
export const MAX_PAGES = 20;
/** 单份最大 20 MB，与现场实现的限制一致。 */
export const MAX_BYTES = 20 * 1024 * 1024;
/** 文字上限 10 万字，防止异常文件把 JSON 撑爆。 */
export const MAX_CHARS = 100000;

let polyfillsInstalled = false;

/** 2×3 仿射矩阵的最小实现（pdf.js 只在少数路径上用它做变换）。 */
class MiniMatrix {
  constructor(init) {
    const src = Array.isArray(init) && init.length >= 6
      ? init
      : (init !== null && typeof init === 'object' && typeof init.a === 'number'
        ? [init.a, init.b, init.c, init.d, init.e, init.f]
        : [1, 0, 0, 1, 0, 0]);
    [this.a, this.b, this.c, this.d, this.e, this.f] = src.map((value) => Number(value) || 0);
  }

  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(other) {
    const o = other instanceof MiniMatrix ? other : new MiniMatrix(other);
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b;
    this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d;
    this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e;
    this.f = b * o.e + d * o.f + f;
    return this;
  }

  preMultiplySelf(other) {
    const o = other instanceof MiniMatrix ? other : new MiniMatrix(other);
    const copy = new MiniMatrix(this);
    this.a = o.a; this.b = o.b; this.c = o.c; this.d = o.d; this.e = o.e; this.f = o.f;
    return this.multiplySelf(copy);
  }

  translate(tx = 0, ty = 0) {
    return this.multiplySelf([1, 0, 0, 1, Number(tx) || 0, Number(ty) || 0]);
  }

  scale(sx = 1, sy = sx) {
    return this.multiplySelf([Number(sx) || 1, 0, 0, Number(sy) || 1, 0, 0]);
  }

  rotate() {
    return this;
  }

  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0) return this;
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  clone() {
    return new MiniMatrix(this);
  }

  toFloat32Array() {
    return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f]);
  }
}

/** 极简 ImageData 壳：pdf.js 只在渲染路径上读 data/width/height。 */
class MiniImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') {
      this.width = data;
      this.height = width;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/** 极简 Path2D 壳：取文字不走渲染，所有方法都只返回自身。 */
class MiniPath2D {
  constructor() {}

  addPath() { return this; }
  moveTo() { return this; }
  lineTo() { return this; }
  bezierCurveTo() { return this; }
  quadraticCurveTo() { return this; }
  closePath() { return this; }
  rect() { return this; }
  arc() { return this; }
  arcTo() { return this; }
  ellipse() { return this; }
}

/** 装上三个空壳；重复调用是安全的。 */
function installDomPolyfills() {
  if (polyfillsInstalled) return;
  if (typeof globalThis.DOMMatrix !== 'function') globalThis.DOMMatrix = MiniMatrix;
  if (typeof globalThis.ImageData !== 'function') globalThis.ImageData = MiniImageData;
  if (typeof globalThis.Path2D !== 'function') globalThis.Path2D = MiniPath2D;
  polyfillsInstalled = true;
}

/** pdf.js 的加载入口（懒加载：只有真的取字时才把 1.8 MB 的模块读进来）。 */
async function loadPdfjs() {
  installDomPolyfills();
  if (!existsSync(PDFJS_ENTRY)) {
    throw new Error(`找不到 pdf.js：${PDFJS_ENTRY}`);
  }
  if (!existsSync(PDFJS_WORKER)) {
    throw new Error(`找不到 pdf.js worker：${PDFJS_WORKER}`);
  }
  const pdfjs = await import(pathToFileURL(PDFJS_ENTRY).href);
  // 显式指定 worker：Node 下靠相对解析容易落到别处，写绝对 file:// 最省事。
  if (pdfjs.GlobalWorkerOptions !== undefined && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(PDFJS_WORKER).href;
  }
  return pdfjs;
}

/**
 * 从 PDF 缓冲区里取文字。
 * @param {Uint8Array|Buffer} data PDF 字节
 * @param {{maxPages?: number, maxChars?: number}} [options]
 * @returns {Promise<{ok: true, text: string, pageCount: number, pagesRead: number, chars: number, truncated: boolean}
 *   | {ok: false, reason: string, detail?: string}>}
 */
export async function extractPdfText(data, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || MAX_PAGES);
  const maxChars = Math.max(1000, Number(options.maxChars) || MAX_CHARS);
  // pdf.js 明确拒绝 Buffer（"Please provide binary data as `Uint8Array`"），
  // 必须复制成普通 Uint8Array；Node 的 readFileSync 默认给的就是 Buffer。
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data ?? []);
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_BYTES) return { ok: false, reason: 'too-large', detail: `${bytes.length} 字节` };

  let doc = null;
  try {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: bytes,
      // 纯取文字：不加载字体、不跑 eval、不要标准字体数据（少带 1.3 MB 的 standard_fonts）
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = await task.promise;
    if (doc.numPages === 0) return { ok: false, reason: 'no-pages' };

    const pagesRead = Math.min(doc.numPages, maxPages);
    const parts = [];
    let chars = 0;
    let truncated = false;
    for (let pageNo = 1; pageNo <= pagesRead; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const pieces = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        pieces.push(item.str);
        if (item.hasEOL === true) pieces.push('\n');
      }
      parts.push(pieces.join(''));
      chars += pieces.reduce((sum, piece) => sum + piece.length, 0);
      page.cleanup();
      if (chars >= maxChars) { truncated = true; break; }
    }

    const text = parts.join('\n').slice(0, maxChars).replace(/[ \t]+\n/g, '\n').trim();
    if (text === '') return { ok: false, reason: 'no-text', detail: `${doc.numPages} 页里没有文字层` };
    return { ok: true, text, pageCount: doc.numPages, pagesRead, chars: text.length, truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) return { ok: false, reason: 'encrypted', detail: message };
    return { ok: false, reason: 'parse-failed', detail: message };
  } finally {
    if (doc !== null && typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}
