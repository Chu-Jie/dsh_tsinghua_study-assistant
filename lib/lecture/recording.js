/**
 * 腾讯会议「录音笔」留下的本地录音文件。
 *
 * 这段时间的侦察结论（决定了整个课堂音频的来源）：
 *   - 逐字稿**不落本地**：IndexedDB / Local Storage / 三十多个 SQLite 全翻过，
 *     网页缓存里只有元宝的界面文案；
 *   - 但**音频在**：每次开录音笔会在录制目录里新建 `<开始时间>\` 子目录，写出
 *     `<文件名>.aac`（ADTS AAC，逐帧自描述）与一个 `.aacidx` 索引；
 *   - 文件在上课过程中是被**一段段写长**的（读取时它可能正被腾讯会议占用，
 *     所以这里全部用「允许共享读」的方式打开）。
 *
 * 本模块只做三件事：列目录、把用户/页面给的名字安全地落成一个真实路径、按偏移读字节。
 * 解码与识别都在页面侧（Chromium 自带 AAC 解码器）完成。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 腾讯会议默认把录音写在这里（用户主目录下的「会议录像」）。
 *
 * 这只是个**参考**默认值：插件配置项 `recordingDir` 不写就是关闭（空串），
 * 想用录音导入时填自己机器上的实际目录。
 */
export const DEFAULT_RECORDING_DIR = path.join(os.homedir(), '会议录像');
/** 认可的音/视文件后缀（`.wemta` 是腾讯自己的音频容器，先放行、能不能解由页面判断）。 */
export const AUDIO_EXTENSIONS = ['.aac', '.m4a', '.wemta'];
/**
 * 页面侧能自己切片的容器：只有 ADTS（`.aac`）是逐帧自描述的，可以「从任意偏移，
 * 只解后面新增的完整帧」；`.m4a`/`.wemta` 是别的容器（要先读 `moov` 之类的头），
 * 列进「实时跟随」的下拉里只会让人白选一场，所以列表里给它们打 `adts:false`。
 */
export const ADTS_EXTENSIONS = ['.aac'];
/** 一次最多返回多少字节，避免一个请求把几百兆录音全塞进内存。 */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

/** 这段字符串能不能安全地当作一层目录/文件名用。 */
export function safeSegment(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === '.' || text === '..') return null;
  if (text.includes('/') || text.includes('\\')) return null;
  if (text.includes(':')) return null;
  if (text !== path.basename(text)) return null;
  return text;
}

/** 后缀在不在这份白名单里（大小写不敏感）。 */
export function isAudioName(name) {
  if (typeof name !== 'string') return false;
  return AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/** 这份文件能不能被页面逐帧切片（见 ADTS_EXTENSIONS）。 */
export function isAdtsName(name) {
  if (typeof name !== 'string') return false;
  return ADTS_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/**
 * 把 `session + name` 落成一个绝对路径。
 *
 * 两道闸门：两段名字都不许含分隔符（`safeSegment`），落出来的路径必须真的在
 * 录制目录里面（防 `..` 变体绕过）。返回 `{ok:true, file, session, name}` 或
 * `{ok:false, error, detail}`，error 取值 `no-dir | bad-session | bad-name | not-audio | outside`。
 */
export function resolveRecording(baseDir, session, name) {
  if (typeof baseDir !== 'string' || baseDir.trim() === '') {
    return { ok: false, error: 'no-dir', detail: '没有配置录音目录' };
  }
  const safeSession = safeSegment(session);
  if (safeSession === null) return { ok: false, error: 'bad-session', detail: '场次名不合法' };
  const safeName = safeSegment(name);
  if (safeName === null) return { ok: false, error: 'bad-name', detail: '文件名不合法' };
  if (!isAudioName(safeName)) {
    return { ok: false, error: 'not-audio', detail: `只认 ${AUDIO_EXTENSIONS.join(' / ')}` };
  }
  const root = path.resolve(baseDir);
  const file = path.resolve(root, safeSession, safeName);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return { ok: false, error: 'outside', detail: '路径跑到录音目录外面了' };
  }
  return { ok: true, file, session: safeSession, name: safeName };
}

/**
 * 列出录制目录里的音频文件，新的在前。
 *
 * 目录不存在不算错误（用户可能还没录过）：返回 `{ok:false, error:'no-dir', exists:false, items:[]}`，
 * 页面据此显示「还没有录音」而不是报故障。
 */
export async function listRecordings(baseDir, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40;
  if (typeof baseDir !== 'string' || baseDir.trim() === '') {
    return { ok: false, error: 'no-dir', dir: null, exists: false, items: [] };
  }
  const root = path.resolve(baseDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      error: 'no-dir',
      dir: root,
      exists: false,
      items: [],
      detail: String(error?.message ?? error),
    };
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = entry.name;
    let files;
    try {
      files = await fs.readdir(path.join(root, session), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !isAudioName(file.name)) continue;
      const full = path.join(root, session, file.name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      items.push({
        session,
        name: file.name,
        size: stat.size,
        mtime: stat.mtimeMs,
        file: full,
        adts: isAdtsName(file.name),
      });
    }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, dir: root, exists: true, items: items.slice(0, limit), total: items.length };
}

/**
 * 读一段字节。
 *
 * `offset` 是绝对字节偏移；返回值里 `bytes` 是这一段、`end` 是下一次该从哪继续、
 * `eof` 表示「已经读到当前文件末尾」。上课时文件还在长，所以 eof 只是「此刻到末尾」。
 */
export async function readRecording(baseDir, session, name, options = {}) {
  const resolved = resolveRecording(baseDir, session, name);
  if (!resolved.ok) return resolved;

  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? Math.min(options.maxBytes, MAX_READ_BYTES)
    : MAX_READ_BYTES;
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;

  let stat;
  try {
    stat = await fs.stat(resolved.file);
  } catch (error) {
    return {
      ok: false,
      error: 'not-found',
      file: resolved.file,
      detail: String(error?.message ?? error),
    };
  }

  const size = stat.size;
  if (offset >= size) {
    return {
      ok: true,
      file: resolved.file,
      session: resolved.session,
      name: resolved.name,
      size,
      mtime: stat.mtimeMs,
      offset: size,
      end: size,
      requested: offset,
      bytes: new Uint8Array(0),
      eof: true,
    };
  }

  const length = Math.min(maxBytes, size - offset);
  const buffer = Buffer.allocUnsafe(length);
  let handle;
  try {
    // 文件此刻可能正被腾讯会议写着：Node 的 open 默认允许共享读
    handle = await fs.open(resolved.file, 'r');
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = new Uint8Array(buffer.subarray(0, bytesRead));
    return {
      ok: true,
      file: resolved.file,
      session: resolved.session,
      name: resolved.name,
      size,
      mtime: stat.mtimeMs,
      offset,
      end: offset + bytesRead,
      requested: offset,
      bytes,
      eof: offset + bytesRead >= size,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'read-failed',
      file: resolved.file,
      detail: String(error?.message ?? error),
    };
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* 关不掉也不影响这次读取 */ }
    }
  }
}
