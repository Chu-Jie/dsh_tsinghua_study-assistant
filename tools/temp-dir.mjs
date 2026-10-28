/**
 * 临时目录：创建 + 可靠删除（Windows 上必须重试）。
 *
 * 为什么需要这个文件：
 *   测试与校验脚本都在 os.tmpdir() 下自建目录，跑完就 `fs.rm(dir, { recursive: true, force: true })`。
 *   但 Node 在 Windows 上的递归删除是「先遍历、再逐个删、最后 rmdir」，只要删除过程中
 *   目录里**又出现**一个文件，最后那步就会抛：
 *     ENOTEMPTY: directory not empty, rmdir 'C:\Users\...\Temp\study-assistant-test-XXXXXX'
 *   实测这套测试因此随机变红（同一个测试有时过、有时不过，与代码无关）：
 *     - 杀软（本机是 Kaspersky Endpoint Security）的实时扫描会短暂持有刚写入文件的句柄；
 *     - store 的写队列/备份轮转也可能在断言结束后才把最后一个文件落盘。
 *   最典型的一次：tools/verify-tool-output.mjs 的 7 项检查**全部通过**，却在最后
 *   `fs.rm` 上抛 ENOTEMPTY，于是整个脚本退出码 1，把 tests/host.test.js 的那条测试带红
 *   ——「被测代码全对、测试却红」，纯噪音。
 *
 * 所以清理改成「对可重试的错误做退避重试」；重试仍失败时**只警告、不抛错**：
 *   清理失败不携带任何业务信息，绝不能让它把一个正常的运行判成失败。泄漏的临时目录
 *   会打印路径，交给 %TEMP% 自己回收。
 *
 * 注意：只影响**清理阶段**；创建/写入/断言阶段的错误一律照原样抛出。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Windows 上删除目录时可能瞬态出现、值得重试的错误码。 */
const RETRYABLE_CODES = new Set(['ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

export async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 删除临时目录；遇到 Windows 上的瞬态失败会退避重试，最终仍失败则只打印警告。
 * @param {string} dir 要删除的目录（递归）
 * @param {{attempts?: number, delayMs?: number, quiet?: boolean}} [options]
 *        默认重试 6 次、退避 60ms 起步；`quiet: true` 时不打印放弃警告。
 * @returns {Promise<boolean>} 是否真的删掉了
 */
export async function removeTempDir(dir, { attempts = 6, delayMs = 60, quiet = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error?.code)) break;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  if (!quiet) {
    console.warn(`⚠ 清理临时目录失败（不影响本次结果，%TEMP% 会回收）：${dir}\n  ${lastError?.message ?? lastError}`);
  }
  return false;
}
