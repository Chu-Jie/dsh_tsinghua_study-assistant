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

/**
 * 数据文件写入互斥锁文件名。
 *
 * ⚠️ **仅为占位常量，没有取锁/释放锁的实现**（2026-10-29 复核：全库 0 处引用）。
 * 实际的并发保护是「每文档写队列 + 写前重新读盘的乐观 hash 检测 + 原子写」，
 * **跨进程无锁**——两个宿主同时写同一 dataDir 时靠 hash 冲突返回 409 让人重试。
 *
 * 保留它的原因：`.dsh/skills/study-data-verify` 与 `course-material-intake` 都引用
 * 这个常量来解释「为什么 写入.lock 不存在也不代表没有并发」。删它之前先改那两处文档。
 */
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

  /** 原子写：临时文件 → fsync → rename → fsync 父目录。 */
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
    // rename 只改了目录项，目录本身也要落盘，否则掉电后可能退回旧目录状态。
    // 目录 fsync 在 Windows 等平台不被支持（打开目录会 EISDIR/EPERM），失败按「平台不支持」处理。
    try {
      const dir = await fs.open(path.dirname(file), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // 平台/文件系统不支持目录 fsync：忽略，不影响写入结果
    }
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

  /**
   * 备份名里的时间：`<文档>.<YYYYMMDD-HHmmss>` → 毫秒时间戳；认不出的名字返回 null。
   * 老式/手工名（`.bak-<戳>`、`.pre-*`、`.snapshot-*` …）一律返回 null：
   * 它们是人手工留下的，什么时候清由人决定，不由插件猜。
   */
  function backupStampOf(prefix, name) {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/u.exec(name.slice(prefix.length));
    if (match === null) return null;
    const at = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ).getTime();
    return Number.isFinite(at) ? at : null;
  }

  /**
   * 轮转备份：只保留最近 keep 份**本插件自己写的**备份。
   *
   * 判据是备份名里的时间戳，不是字典序：字典序里 '2' < 'b'，老式 `名字.bak-20261028-190404`
   * 会把新式 `名字.20261122-233211` 全挤到队头，于是「最新那份」被当成最旧删掉
   * （2026-11-23 K09 诊断坐实）。外来命名不计数、不删除。
   */
  async function rotateBackups(key, keep) {
    const prefix = `${DOC_FILES[key]}.`;
    const dir = path.join(dataDir, BACKUP_DIR);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    // 只收本插件自己写的 `<文档>.<YYYYMMDD-HHmmss>`；人工/工具留下的 .bak-/.pre-/.snapshot-
    // 是人的资产，这里一份都不碰（不删既有产物）。
    // ⚠ 必须先按 prefix 逐字比对再解析时间：`backupStampOf` 只按 prefix 的**长度**切尾巴，
    //   于是同长度前缀的别的文档（`学期.json.` / `课程.json.` / `日程.json.` …都是「两字+.json.」）
    //   会被误算成自己的备份。2026-11-23（v2-J 卡）实测踩到：写 日程.json 时把 课程.json 的备份
    //   一起轮转掉了，http-backup 那条「覆盖前要把旧版存进备份目录」随机变红。
    const mine = [];
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const at = backupStampOf(prefix, name);
      if (at !== null) mine.push({ name, at });
    }
    // 同一秒内写两次会撞名（后一份直接覆盖前一份），这里用名字兜底保证顺序稳定。
    mine.sort((a, b) => (a.at === b.at ? (a.name < b.name ? -1 : 1) : a.at - b.at));
    const excess = mine.length - Math.max(0, keep);
    for (let i = 0; i < excess; i += 1) {
      await fs.rm(path.join(dir, mine[i].name), { force: true });
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
