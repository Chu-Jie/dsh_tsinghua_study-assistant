/**
 * 读取 DSH 的会话日志（*.jsonl.zstd）并按关键字过滤，用于事后复盘。
 *
 * 为什么需要一个专门的脚本：
 *   会话日志是**追加式的多帧 zstd**（每条记录一个独立帧，一次日志动辄 1000+ 帧）。
 *   Node 的 zlib.zstdDecompressSync / createZstdDecompress 只解第一帧，
 *   直接解会得到「解压出 195 字节、1 条记录」这种假成功。
 *
 * 用法：
 *   node tools/read-dsh-session-log.mjs <session.v4.jsonl.zstd> [关键字|关键字2] [最多打印条数]
 *
 * 例：
 *   node tools/read-dsh-session-log.mjs "<DSH_HOME>/sessions/<工作区目录名>/<session-xxxx>/session.v4.jsonl.zstd" "did not activate|startup failed"
 *   node tools/read-dsh-session-log.mjs <日志> "" 5      # 只打印最后 5 条
 *
 * 会话日志位置：`<DSH_HOME>/sessions/<工作区目录名>/<session-xxxx>/session.v4.jsonl.zstd`
 * DSH_HOME 默认是 `~/.dsh`；旧桌面端（dsh-desktop）下则是 `%APPDATA%\dsh-desktop\harness`。
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (file === undefined) {
  console.error('用法：node tools/read-dsh-session-log.mjs <session.v4.jsonl.zstd> [关键字|关键字2] [最多条数]');
  process.exit(2);
}
const keywords = (process.argv[3] ?? '').split('|').filter(Boolean);
const maxHits = Number(process.argv[4] ?? 40);

const buf = readFileSync(file);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
    offsets.push(i);
  }
}
if (offsets.length === 0 || offsets[0] !== 0) offsets.unshift(0);

const parts = [];
let failed = 0;
for (let i = 0; i < offsets.length; i++) {
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8'));
  } catch {
    failed++;
  }
}

const lines = parts.join('').split('\n').filter((l) => l.trim() !== '');
console.error(`[info] ${file}`);
console.error(`[info] 帧数=${offsets.length} 解压失败=${failed} 记录数=${lines.length}`);

const hits = keywords.length === 0 ? lines : lines.filter((l) => keywords.some((k) => l.includes(k)));
console.error(`[info] 命中 ${hits.length} 条（关键字 ${JSON.stringify(keywords)}，最多打印 ${maxHits} 条）`);

for (const line of hits.slice(-maxHits)) {
  console.log(line.length > 4000 ? line.slice(0, 4000) + ' …[截断]' : line);
  console.log('---');
}
