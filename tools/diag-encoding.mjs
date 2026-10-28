/**
 * 一次性诊断：卸载记录里的 sourceSpec 到底是真乱码，还是控制台显示假象？
 * 用法：node tools/diag-encoding.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'recovery', 'plugin-removals.json');
const raw = readFileSync(file, 'utf8');
const parsed = JSON.parse(raw);
const key = Object.keys(parsed.removals)[0];
const spec = parsed.removals[key].generationBackups[0].sourceSpec;

const codePoints = [...spec];
console.log('文件本身是合法 UTF-8 且 JSON 可解析：是');
console.log('sourceSpec 码点长度 =', codePoints.length);
console.log('前 24 个码点(hex) =', codePoints.slice(0, 24).map((c) => c.codePointAt(0).toString(16)).join(' '));
console.log('');
console.log('包含 U+5927/U+5B66（「大学」）      :', spec.includes('\u5927\u5b66'));
console.log('包含 U+FFFD（替换字符，真损坏标志）  :', spec.includes('\uFFFD'));
console.log('包含「澶」U+6FB6（GBK 误读典型字）   :', spec.includes('\u6fb6'));
console.log('');
// 关键判据：把「澶у」按 GBK 逆映射回字节，再按 UTF-8 解码，看能否还原「大学」
console.log('判据说明：若「澶у」重现为「大学」，则文件里存的是真乱码；');
console.log('          若 spec 本身直接含「大学」，则之前看到的乱码只是控制台渲染。');
