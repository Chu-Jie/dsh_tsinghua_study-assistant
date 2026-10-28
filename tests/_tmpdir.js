/**
 * 临时数据目录：创建 + 可靠删除。
 *
 * 实现只有一份，放在 tools/temp-dir.mjs（校验脚本也要用它 —— 见那里的详细说明：
 * Windows 上 `fs.rm(recursive)` 会随机抛 ENOTEMPTY，清理失败绝不能把正常的运行判成失败）。
 * 这里只做转出，好让 tests/ 下的 import 路径保持简短。
 */

export { makeTempDir, removeTempDir } from '../tools/temp-dir.mjs';
