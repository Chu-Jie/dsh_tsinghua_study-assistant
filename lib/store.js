/**
 * 学习台数据层（零依赖，仅 Node 标准库）
 *
 * 写入策略沿用已有「作业控制台」中经过回归测试验证的做法：
 *   - 原子写：临时文件 → fsync → rename 换上去；
 *   - 冲突检测：写前比对磁盘文件的 sha256，被外部程序改过就拒绝写入；
 *   - 损坏保护：JSON 非法或结构不符时拒绝写入，绝不当成空数据清空重写；
 *   - 并发：进程内一条 promise 队列串行化所有写；
 *   - 备份：每次成功写入前把上一版压入 备份/，并按时序轮转保留 N 份。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { DOC_FILES, DOC_KEYS, DOC_VERSION, defaultDoc, validateDoc, isPlainObject } from './core.js';

/** 数据文件写入互斥锁文件名（0 字节，仅用于加锁，删掉会自动重建）。 */
export const LOCK_FILE = '写入.lock';
/** 备份子目录名。 */
export const BACKUP_DIR = '备份';

/** 一份文档的读取结果。 */
function ok(value) {
  return { ok: true, ...value };
}
function fail(reason, extra) {
  return { ok: false, reason, ...(extra ?? {}) };
}

/** 计算字节的 sha256。 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 该文档对应的绝对路径。 */
export function docPath(dataDir, key) {
  const file = DOC_FILES[key];
  if (file === undefined) throw new Error(`study-assistant: 未知文档 "${key}"`);
  return path.join(dataDir, file);
}

/**
 * 按文件名解析文档键；只接受白名单内的键，天然挡住路径穿越。
 * @returns {string|null}
 */
export function docKeyFromName(name) {
  for (const key of DOC_KEYS) {
    if (DOC_FILES[key] === name) return key;
  }
  return null;
}

/** 备份文件名里的时间戳：20260924-200343。 */
function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 创建数据层。@param {string} dataDir 数据目录的绝对路径 */
export function createStore(dataDir) {
  /** 每个文档一条写队列，保证同一文档的写串行执行。 */
  const queues = new Map();

  function enqueue(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    // 队列自身不能因单次失败而中断
    queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async function ensureDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  /** 确保数据目录与四份文档存在；缺失的用默认空结构补上。 */
  async function init() {
    await ensureDir();
    const created = [];
    for (const key of DOC_KEYS) {
      const file = docPath(dataDir, key);
      try {
        await fs.access(file);
      } catch {
        const doc = { ...defaultDoc(key), updatedAt: new Date().toISOString() };
        await writeFileAtomic(file, JSON.stringify(doc, null, 2));
        created.push(key);
      }
    }
    return { ok: true, dataDir, created };
  }

  /** 原子写：临时文件 → fsync → rename。 */
  async function writeFileAtomic(file, text) {
    await ensureDir();
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    let handle;
    try {
      handle = await fs.open(tmp, 'w');
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      if (handle !== undefined) await handle.close();
    }
    await fs.rename(tmp, file);
  }

  /**
   * 读取一份文档。
   * @returns {Promise<{ok: boolean, doc?: object, hash?: string, raw?: string, reason?: string}>}
   *   文件不存在 → ok:false reason:'missing'；JSON 非法或结构不符 → reason:'corrupt'。
   */
  async function readDocument(key) {
    const file = docPath(dataDir, key);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return fail('missing', { file });
      return fail(`read-error:${error?.code ?? 'unknown'}`, { file });
    }
    const hash = sha256(Buffer.from(raw, 'utf8'));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail('corrupt:json', { file, hash, raw });
    }
    const valid = validateDoc(key, parsed);
    if (!valid.ok) return fail(`corrupt:${valid.reason}`, { file, hash, raw });
    return ok({ doc: parsed, hash, raw, file });
  }

  /** 读取全部四份文档；缺失的返回默认值并标记 missing。 */
  async function readAll() {
    const docs = {};
    const problems = [];
    for (const key of DOC_KEYS) {
      const result = await readDocument(key);
      if (result.ok) {
        docs[key] = result.doc;
        continue;
      }
      problems.push({ key, reason: result.reason });
      if (result.reason === 'missing') {
        docs[key] = { ...defaultDoc(key), updatedAt: null };
      } else {
        docs[key] = null;
      }
    }
    return { ok: problems.every((p) => p.reason === 'missing'), docs, problems, dataDir };
  }

  /** 当前磁盘上该文档的 sha256（不存在返回 null）。 */
  async function hashOf(key) {
    const file = docPath(dataDir, key);
    try {
      const raw = await fs.readFile(file);
      return sha256(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** 轮转备份：只保留最近 keep 份。 */
  async function rotateBackups(key, keep) {
    const prefix = `${DOC_FILES[key]}.`;
    const dir = path.join(dataDir, BACKUP_DIR);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const mine = entries.filter((name) => name.startsWith(prefix)).sort();
    const excess = mine.length - Math.max(0, keep);
    for (let i = 0; i < excess; i += 1) {
      await fs.rm(path.join(dir, mine[i]), { force: true });
    }
  }

  /**
   * 写入一份文档（受保护的写入）。
   * @param {string} key
   * @param {object} doc 完整的新文档
   * @param {{expectedHash?: string|null, now?: Date}} [options]
   *   expectedHash：调用方读取时的 sha256。传 undefined 表示跳过冲突检测（仅初始化用）。
   * @returns {Promise<{ok: boolean, hash?: string, reason?: string}>}
   */
  function writeDocument(key, doc, options = {}) {
    return enqueue(key, async () => {
      const valid = validateDoc(key, doc);
      if (!valid.ok) return fail(`refuse-invalid:${valid.reason}`);

      const file = docPath(dataDir, key);
      await ensureDir();

      // 冲突检测：磁盘现状必须与调用方读到的一致，否则拒绝覆盖
      if (options.expectedHash !== undefined) {
        const current = await hashOf(key);
        const expected = options.expectedHash ?? null;
        if (current !== expected) {
          return fail('conflict', { currentHash: current, expectedHash: expected });
        }
      }

      // 备份上一版（内容必须是合法 JSON，损坏文件不做备份、也不覆盖）
      let previousRaw = null;
      try {
        previousRaw = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') return fail(`read-error:${error?.code ?? 'unknown'}`);
      }
      if (previousRaw !== null) {
        try {
          const previous = JSON.parse(previousRaw);
          const previousValid = validateDoc(key, previous);
          if (!previousValid.ok) {
            // 损坏保护：原文件不是合法结构，拒绝写入，保留原样
            return fail(`refuse-corrupt-on-disk:${previousValid.reason}`);
          }
          const backupDir = path.join(dataDir, BACKUP_DIR);
          await fs.mkdir(backupDir, { recursive: true });
          const keep = Number.isInteger(options.backupKeep) ? options.backupKeep : 10;
          await fs.writeFile(path.join(backupDir, `${DOC_FILES[key]}.${stamp(options.now ?? new Date())}`), previousRaw, 'utf8');
          await rotateBackups(key, keep);
        } catch {
          return fail('refuse-corrupt-on-disk:json');
        }
      }

      const next = { ...doc, version: DOC_VERSION, updatedAt: new Date().toISOString() };
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await writeFileAtomic(file, text);
      return ok({ hash: sha256(Buffer.from(text, 'utf8')), doc: next });
    });
  }

  /** 数据健康检查，供 /health 与 study_status 工具使用。 */
  async function health() {
    const files = [];
    for (const key of DOC_KEYS) {
      const result = await readDocument(key);
      files.push({
        key,
        file: DOC_FILES[key],
        exists: result.reason !== 'missing',
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        bytes: result.raw === undefined ? null : Buffer.byteLength(result.raw, 'utf8'),
        hash: result.hash ?? null,
      });
    }
    return {
      dataDir,
      version: DOC_VERSION,
      files,
      healthy: files.every((item) => item.ok),
    };
  }

  /**
   * 危险操作：把某份文档恢复为默认空结构。
   * 会先备份，且要求调用方显式传入 confirm:true。
   */
  function resetDocument(key, options = {}) {
    if (options.confirm !== true) return Promise.resolve(fail('need-confirm'));
    return writeDocument(key, { ...defaultDoc(key), updatedAt: new Date().toISOString() }, {
      expectedHash: options.expectedHash,
      backupKeep: options.backupKeep,
    });
  }

  return { dataDir, init, readDocument, readAll, writeDocument, hashOf, health, resetDocument, ensureDir };
}

export { isPlainObject };
