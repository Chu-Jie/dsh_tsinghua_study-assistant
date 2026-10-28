// tools/check-privacy.mjs —— 开源前的隐私闸门：零依赖扫描仓库内文本文件里的真实姓名/学号/本机路径/邮箱/令牌/会话票据等泄漏。
// 用法：node tools/check-privacy.mjs [--quiet]（--quiet 只打命中行与一行汇总，CI 用；成功时静默）。
// 退出码：0 = 干净；1 = 有命中（CI 会红）；2 = 规则编译失败或内部错误。
// 扫描范围：仓库根目录（= 本文件所在目录的上一级），递归；排除 .git/、node_modules/、二进制扩展名，
//   以及单文件体积超上限的巨型数据文件（当前仓库最大文件 3.7 MB，上限见 MAX_FILE_BYTES）；
//   实扫文件数与耗时打在末尾汇总行，CI 里可据此发现性能回归。
// 豁免：①规则文件自身（其正则字面量必然命中自己）；②vendor/ 下第三方文件的「邮箱/令牌」两类规则（由 THIRD_PARTY_NOTICES.md 覆盖）。

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SELF_REL = 'tools/check-privacy.mjs';

const QUIET = process.argv.slice(2).includes('--quiet');

// ——— 遍历配置 ———
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.zst', '.gz',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav',
  '.exe', '.dll', '.node', '.sqlite', '.db'
]);
const SNIPPET_MAX = 120;
// 单文件体积上限：只为防 CI 被超大二进制/数据块拖住。现仓库最大文件 demo-data/资料分析.json ≈ 3.7 MB，
// 上限留足余量；调小会牺牲 demo 数据里的扫描覆盖，调大只影响耗时。
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const VENDOR_PREFIX = 'vendor/';

// ——— 敏感字面量：分段拼接，避免闸门脚本自身成为新的泄漏源（本文件也在公开仓库里）———
const SECRET_DIGITS = {
  student: ['2025', '01', '0664'].join(''),
  qq: ['2174', '2429', '79'].join(''),
  winuser: ['217', '42'].join('')
};
const ACCOUNT_SRC = [
  '\\b' + SECRET_DIGITS.student + '\\b',
  '\\b' + SECRET_DIGITS.qq + '\\b',
  '\\b' + SECRET_DIGITS.winuser + '\\b'
].join('|');

// ——— 规则表：先集中成「字符串 + flags」，再用 new RegExp 编译，编译失败显式退 2 ———
// 所有正则默认不区分大小写；唯一例外是邮箱的 TLD 只认小写字母（见 EMAIL 注释）。
const PATTERNS = {
  // 1. 真实姓名与拼音。中文姓名三位刻意写成 \u 转义（还原后才是作者真名），理由同上面的分段拼接。
  NAME: ['\u675c\u660a\u9633|\\bdu\\s?hao\\s?yang|\\bduhao\\b', 'i'],
  // 2. 真实学号 / 作者 QQ 号 / 本机 Windows 用户名片段（字面量由 SECRET_DIGITS 拼出）
  ACCOUNT: [ACCOUNT_SRC, ''],
  // 3. 本机绝对路径：D:\大学（单/双反斜杠都算）与 C:\Users\<非占位用户名>
  LOCAL_UNI: ['D:[\\\\/]+\u5927\u5b66', 'i'],
  WIN_USER: ['[A-Za-z]:[\\\\/]+Users[\\\\/]+([^\\s\\\\/"\x27`|;,)\\）】<>]+)', 'i'],
  // 4. 邮箱：除白名单外任何 xxx@yyy.zz
  //    TLD 刻意只认小写字母 —— 真实 TLD 都是小写，而第三方混淆代码里（vendor/pdfjs 的字符移位块）
  //    的伪邮箱必然含大写，否则会被那一条误报永久染红（另有 vendor 豁免兜底）。
  EMAIL: ['[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[a-z]{2,24}(?!\\.?[A-Za-z0-9-])', 'g'],
  // 5. 令牌
  GHP: ['\\bghp_[A-Za-z0-9]{20,}', ''],
  GH_PAT: ['\\bgithub_pat_[A-Za-z0-9_]{20,}', ''],
  SK: ['\\bsk-[A-Za-z0-9]{20,}', ''],
  BEARER: ['\\bBearer\\s+[A-Za-z0-9._-]{20,}', 'i'],
  TOKEN_Q: ['\\btoken=([A-Za-z0-9]{32,})', 'gi'],
  // 6. 会话票据：JSESSIONID= / TSINGHUAUSERID= 后跟真实值
  TICKET: ['\\b(?:JSESSIONID|TSINGHUAUSERID)=([^\\s;"\x27`&,)\\\\]+)', 'gi'],
  // 7. 网络学堂真实 id：域名 learn.tsinghua.edu.cn 允许，wlkcid= / xszyid= 的真实 id 要报
  LEARN_ID: ['\\b(?:wlkcid|xszyid)=([A-Za-z0-9]+)', 'gi'],
  // 8. URL 查询参数里带真实学号 / 邮箱
  URL_PARAM: ['[?&](?:sid|studentid|student_id|studentId|email|mail|学号)=([^&\\s"\x27`<>]+)', 'gi']
};

const R = new Map();
for (const [id, [src, flags]] of Object.entries(PATTERNS)) {
  try {
    R.set(id, new RegExp(src, flags));
  } catch (err) {
    console.error('[check-privacy] 规则编译失败（' + id + '）：' + (err && err.message ? err.message : err));
    console.error('[check-privacy] 已中止，退出码 2。正则源码：' + src);
    process.exit(2);
  }
}

// ——— 占位符判定：这些值出现属于正常文档/代码，不算隐私 ———
const PLACEHOLDER_RES = [
  /^\.\.\./,   // ...
  /^</,        // <user> / <id>
  /^%/,        // %USERNAME% / %s
  /^\$/,       // $USER / ${...}
  /^\{/,       // ${...} / {id}
  /^\*+$/,     // ***
  /^x{2,}$/i,  // xxx
  /^y{2,}$/i,  // yy
  /^a{3,}$/i   // aaa
];
function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim();
  if (!v) return true;
  if (v.length > 512) return false;
  return PLACEHOLDER_RES.some((re) => re.test(v));
}

// 测试代码里的假票据（JSESSIONID=SECRET-VALUE 这类）：纯字母/连字符、不含数字 ⇒ 当占位符。
// 真实票据是 hex/base64/uuid，几乎一定含数字。
function isDummyTicket(value) {
  return !/[0-9]/.test(value) && /^[A-Za-z][A-Za-z-]*$/.test(value);
}

// ——— 邮箱白名单（域名命中即放行）：*@users.noreply.github.com、*@example.com|edu、*@mozilla.org|com、*@pdfjs*、*@w3.org
const EMAIL_ALLOW_DOMAINS = [
  'users.noreply.github.com',
  'example.com',
  'example.edu',
  'mozilla.org',
  'mozilla.com',
  'w3.org'
];
function isAllowedEmail(domain) {
  const d = String(domain).toLowerCase();
  if (EMAIL_ALLOW_DOMAINS.some((allow) => d === allow || d.endsWith('.' + allow))) return true;
  return /(^|\.)pdfjs/i.test(d) || d.startsWith('pdfjs');
}

// ——— C:\Users\<用户名> 的占位用户名 ———
const USERNAME_PLACEHOLDERS = new Set([
  'demo', 'user', 'name', 'yourname', 'username', 'your-name', 'your_name',
  'someone', 'me', 'test', 'example', 'admin', '...', '<user>', '$user'
]);

// ——— 小工具：遍历某条规则的所有匹配，交给判定函数决定算不算命中 ———
// 注意：非 global 的正则 exec 永远从头开始，必须只取一次，否则会死循环。
function scanWith(re, line, judge) {
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(line);
    if (!m) return null;
    if (m[0].length === 0) {
      if (!re.global) return null;
      re.lastIndex++;
      continue;
    }
    const verdict = judge(m);
    if (verdict) return verdict;
    if (!re.global) return null;
  }
}

// ——— 规则实现：test(line) => null | { text, index } ———
// vendorExempt: 在 vendor/ 下不报（第三方文件，来源与许可见 THIRD_PARTY_NOTICES.md）
const RULES = [
  {
    id: 'name',
    label: '真实姓名/拼音',
    test(line) {
      const m = R.get('NAME').exec(line);
      return m ? { text: m[0], index: m.index } : null;
    }
  },
  {
    id: 'account',
    label: '真实学号/账号',
    test(line) {
      const m = R.get('ACCOUNT').exec(line);
      return m ? { text: m[0], index: m.index } : null;
    }
  },
  {
    id: 'localpath',
    label: '本机绝对路径',
    test(line) {
      const m1 = R.get('LOCAL_UNI').exec(line);
      if (m1) return { text: m1[0], index: m1.index };
      return scanWith(R.get('WIN_USER'), line, (m) => {
        const user = m[1];
        if (/^[<$%{]/.test(user)) return null;
        if (USERNAME_PLACEHOLDERS.has(user.toLowerCase())) return null;
        return { text: m[0], index: m.index };
      });
    }
  },
  {
    id: 'email',
    label: '邮箱地址',
    vendorExempt: true,
    test(line) {
      return scanWith(R.get('EMAIL'), line, (m) => {
        const at = m[0].lastIndexOf('@');
        if (isAllowedEmail(m[0].slice(at + 1))) return null;
        return { text: m[0], index: m.index };
      });
    }
  },
  {
    id: 'token',
    label: '疑似令牌',
    vendorExempt: true,
    test(line) {
      for (const key of ['GHP', 'GH_PAT', 'SK', 'BEARER']) {
        const m = R.get(key).exec(line);
        if (m) return { text: m[0], index: m.index };
      }
      return scanWith(R.get('TOKEN_Q'), line, (m) => {
        if (isPlaceholder(m[1])) return null;
        return { text: m[0], index: m.index };
      });
    }
  },
  {
    id: 'ticket',
    label: '会话票据',
    test(line) {
      return scanWith(R.get('TICKET'), line, (m) => {
        const value = m[1];
        if (isPlaceholder(value)) return null;
        if (value.length < 8) return null;
        if (isDummyTicket(value)) return null;
        return { text: m[0], index: m.index };
      });
    }
  },
  {
    id: 'learnid',
    label: '网络学堂真实 id',
    test(line) {
      return scanWith(R.get('LEARN_ID'), line, (m) => {
        const value = m[1];
        if (/^\d{6,}$/.test(value) || /^[0-9a-f]{32}$/i.test(value)) {
          return { text: m[0], index: m.index };
        }
        return null;
      });
    }
  },
  {
    id: 'urlparam',
    label: 'URL 参数带身份信息',
    test(line) {
      return scanWith(R.get('URL_PARAM'), line, (m) => {
        const value = m[1];
        if (isPlaceholder(value)) return null;
        if (/^\d{8,}$/.test(value) || /^2025\d/.test(value) || /@[^@\s]+\./.test(value)) {
          return { text: m[0], index: m.index };
        }
        return null;
      });
    }
  }
];

// ——— 文件遍历 ———
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error('[check-privacy] 读取目录失败，跳过：' + dir + '（' + err.code + '）');
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  }
}

// 兜底：前 8KB 含 NUL 字节就当二进制跳过（扩展名没覆盖到的二进制文件）
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 截取命中位置附近的 120 字符，超长单行才不会只看到开头一堆无关字符
function snippet(line, index) {
  const text = String(line).replace(/\r$/, '');
  if (text.length <= SNIPPET_MAX) return text.trim();
  const half = Math.floor(SNIPPET_MAX / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(text.length, start + SNIPPET_MAX);
  start = Math.max(0, end - SNIPPET_MAX);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ——— 扫描 ———
const startedAt = Date.now();
const files = [];
walk(REPO_ROOT, files);

const hits = [];
let scanned = 0;
let selfExempted = false;
let vendorFiles = 0;
let oversizeSkipped = 0;

for (const full of files) {
  const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
  if (rel === SELF_REL) {
    selfExempted = true;
    continue;
  }
  let buf;
  try {
    buf = readFileSync(full);
  } catch (err) {
    console.error('[check-privacy] 读取文件失败，跳过：' + rel + '（' + err.code + '）');
    continue;
  }
  if (buf.length > MAX_FILE_BYTES) {
    oversizeSkipped++;
    continue;
  }
  if (looksBinary(buf)) continue;
  scanned++;

  const inVendor = rel.startsWith(VENDOR_PREFIX);
  if (inVendor) vendorFiles++;
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      if (inVendor && rule.vendorExempt) continue;
      let result = null;
      try {
        result = rule.test(line);
      } catch (err) {
        console.error('[check-privacy] 规则执行失败（' + rule.id + '）：' + (err && err.message ? err.message : err));
        process.exit(2);
      }
      if (!result) continue;
      hits.push({ rel, line: i + 1, rule: rule.label, snippet: snippet(line, result.index) });
      break; // 同一行只报第一条命中的规则，避免一条脏行刷屏
    }
  }
}
const elapsedMs = Date.now() - startedAt;

// ——— 输出 ———
// --quiet：成功时只留一行汇总（CI 日志不刷屏）；有命中时照旧打「文件:行: 规则: 片段」。
if (!QUIET) {
  console.log('扫描范围：' + REPO_ROOT + '（递归；排除 .git/、node_modules/、二进制扩展名、单文件 > ' +
    Math.round(MAX_FILE_BYTES / 1048576) + ' MB）');
  if (selfExempted) console.log('规则文件自身已豁免：' + SELF_REL);
  if (vendorFiles > 0) {
    console.log('vendor/ 下 ' + vendorFiles + ' 个第三方文件已豁免「邮箱/令牌」两类规则（THIRD_PARTY_NOTICES.md 覆盖）');
  }
  if (oversizeSkipped > 0) console.log('超过体积上限被跳过的文件：' + oversizeSkipped + ' 个');
  for (const h of hits) console.log(h.rel + ':' + h.line + ': ' + h.rule + ': ' + h.snippet);
  if (hits.length > 0) console.log('');
} else {
  for (const h of hits) console.log(h.rel + ':' + h.line + ': ' + h.rule + ': ' + h.snippet);
}

console.log('共扫 ' + scanned + ' 文件，命中 ' + hits.length + ' 条（耗时 ' + elapsedMs + ' ms）');
if (oversizeSkipped > 0) console.log('（另有 ' + oversizeSkipped + ' 个文件超过体积上限未扫）');
process.exitCode = hits.length > 0 ? 1 : 0;
