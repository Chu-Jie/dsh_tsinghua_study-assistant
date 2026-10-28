// 扫描源码包与已安装包里所有发布文件，找出**真实的**编码损坏。
//
// 为什么需要这个脚本：PowerShell 控制台按 CP936 渲染 UTF-8 文件时会显示成
// 「澶у鐢熷」这种乱码，肉眼看上去像文件坏了，其实文件是好的。判断编码唯一
// 可靠的办法是读字节/码点。这个脚本只报告两类硬证据：
//   1. U+FFFD 替换字符 —— 解码时真的有字节无法解析；
//   2. UTF-8 文本被当成 GBK 解读后留下的典型字对（鈥 銆 鐨 锟 …）。
//
// 用法：node tools/scan-encoding.mjs [源码目录] [已安装目录]
//
// 两个参数都可省：源码目录默认是本仓库根；已安装目录默认在 profile 的
// node_modules/<包名> 下（按 DSH_HOME 推导，找不到就只扫源码）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PACKAGE = 'dsh-study-assistant';
const SOURCE = process.argv[2] ?? REPO;
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const INSTALLED_CANDIDATES = [
  process.argv[3] ?? '',
  path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', PACKAGE),
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', PACKAGE),
].filter((p) => p !== '');
const INSTALLED = INSTALLED_CANDIDATES.find((p) => existsSync(p)) ?? '';

const TEXT_EXT = /\.(js|mjs|json|yml|yaml|svg|md|txt)$/;
const MOJIBAKE = /锟|閿|鐨|銆|鈥|鍚|瀛|鏁|璇|缁|绛|鍔|澶|鐢|鏂|鍥|鐞|璁|宸|绛|浠|鏈|浣|鍒|寰|搴|瑙|鏄/g;

// 这几个文件**故意**含有乱码样本（它们本身就是用来识别/记录编码问题的），
// 扫描它们必然命中，属于自己抓自己，直接跳过。
const SELF_REFERENTIAL = new Set([
  'tools/scan-encoding.mjs',
  'tools/diag-encoding.mjs',
  '故障复盘-启动失败事故.md',
]);

function walk(dir, out = []) {
  // 已安装包走的是 profile 下的 junction，它指向 .generations/live/<某个代>。
  // 插件的安装代会随每次 install 更换，旧代会被清掉 —— 于是这个 junction 有一段时间
  // 会指向已消失的目录。**目标不存在不是编码问题**，跳过即可，绝不能因此崩掉整个扫描。
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`  （跳过：目录不存在 —— ${dir}）`);
      return out;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(entry.name) && statSync(full).size > 0) out.push(full);
  }
  return out;
}

let problems = 0;
const targets = [['源码包', SOURCE], ['已安装包', INSTALLED]].filter(([, root]) => root !== '');
for (const [label, root] of targets) {
  console.log(`=== ${label}：${root} ===`);
  let scanned = 0;
  for (const file of walk(root)) {
    if (SELF_REFERENTIAL.has(path.relative(root, file).replaceAll('\\', '/'))) continue;
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    let replacement = 0;
    for (const ch of text) if (ch.charCodeAt(0) === 0xfffd) replacement += 1;
    const mojibake = (text.match(MOJIBAKE) ?? []).length;
    if (replacement > 0 || mojibake > 0) {
      problems += 1;
      console.log(`  ✗ ${path.relative(root, file)}  U+FFFD=${replacement}  乱码字对=${mojibake}`);
    }
  }
  console.log(`  扫描 ${scanned} 个文件，未列出的均无编码问题。`);
}

console.log(problems === 0
  ? '\n结论：全部文件编码正常（控制台上看到的「澶у鐢熷」是 CP936 渲染假象，不是文件损坏）。'
  : `\n结论：发现 ${problems} 个文件存在真实编码损坏。`);
process.exitCode = problems === 0 ? 0 : 1;
