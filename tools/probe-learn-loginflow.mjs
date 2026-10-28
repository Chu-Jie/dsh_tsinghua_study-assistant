// 分析网络学堂的登录过程（只读脚本，不提交任何账号密码）。
// 目标：找出登录用的是哪个接口、需要哪些字段、以及登录后有哪些数据接口。
// 用法：node tools/probe-learn-loginflow.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = `${import.meta.dirname}/../.probe-learn`;
mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://learn.tsinghua.edu.cn';

const jar = new Map();
function saveCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const raw of list) {
    const m = /^([^=]+)=([^;]*)/.exec(raw);
    if (m) jar.set(m[1], m[2]);
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function get(path) {
  const res = await fetch(path.startsWith('http') ? path : BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, Accept: '*/*', ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  });
  saveCookies(res);
  const text = await res.text().catch(() => '');
  return { status: res.status, text, loc: res.headers.get('location') };
}

await get('/f/login');
console.log(`会话 cookie: ${[...jar.keys()].join(', ')}\n`);

const TARGETS = [
  '/res/js/common/login.js?v=839',
  '/res/app/wlxt/js/common.js?v=839',
  '/res/js/common/myApp.js?v=839',
  '/f/login',
];

const PATH_RE = /["'`](\/(?:b|f)\/[a-zA-Z0-9_\-./?=&]{3,90})["'`]/g;
const FUNC_RE = /\$\.(?:post|get|ajax|getJSON)\s*\(\s*(["']?)([^"',)\s]+)\1/g;

for (const target of TARGETS) {
  const r = await get(target);
  const name = target.replace(/[^\w.-]/g, '_').slice(-50);
  writeFileSync(`${OUT}/flow_${name}`, r.text, 'utf8');
  console.log(`=== ${target}  HTTP ${r.status}  ${r.text.length} 字符 → .probe-learn/flow_${name} ===`);

  const paths = [...new Set([...r.text.matchAll(PATH_RE)].map((m) => m[1]))];
  const calls = [...new Set([...r.text.matchAll(FUNC_RE)].map((m) => m[2]))];
  const logins = [...new Set([...r.text.matchAll(/["']([^"']*(?:login|Login)[^"']*)["']/g)].map((m) => m[1]))].slice(0, 15);

  if (paths.length) console.log(`  接口路径:\n    ${paths.slice(0, 30).join('\n    ')}`);
  if (calls.length) console.log(`  ajax 目标:\n    ${calls.slice(0, 20).join('\n    ')}`);
  if (logins.length) console.log(`  含 login 的字符串:\n    ${logins.join('\n    ')}`);
  console.log('');
}

// 登录页的表单细节
const loginPage = await get('/f/login');
const formMatch = /<form[\s\S]{0,1500}?<\/form>/i.exec(loginPage.text);
if (formMatch) {
  console.log('=== 登录表单原文 ===');
  console.log(formMatch[0].replace(/\s+/g, ' '));
}
const loginJs = /src=["']([^"']*login[^"']*)["']/gi;
console.log('\n=== 登录页里名字含 login 的脚本 ===');
for (const m of loginPage.text.matchAll(loginJs)) console.log(`  ${m[1]}`);
