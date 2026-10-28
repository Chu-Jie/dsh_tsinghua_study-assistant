// 抓网络学堂登录页与它的 login.js，分析登录方式（只读、无凭据）。
// 用法：node tools/probe-learn-login.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = `${import.meta.dirname}/../.probe-learn`;
mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://learn.tsinghua.edu.cn';

async function get(path) {
  const res = await fetch(path.startsWith('http') ? path : BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': UA },
  });
  const text = await res.text();
  return { status: res.status, text };
}

const login = await get('/f/login');
writeFileSync(`${OUT}/login.html`, login.text, 'utf8');
console.log(`登录页 HTTP ${login.status}，${login.text.length} 字符 → .probe-learn/login.html`);

const form = /<form[\s\S]{0,800}?<\/form>/i.exec(login.text);
if (form) {
  console.log('\n--- <form> ---');
  console.log(form[0].replace(/\s+/g, ' ').slice(0, 1200));
}

const collect = (text, label, patterns) => {
  for (const [name, re] of Object.entries(patterns)) {
    const found = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
    if (found.length) console.log(`\n--- ${label} · ${name} ---\n${found.slice(0, 25).join('\n')}`);
  }
};

const PATTERNS = {
  'url:': /url\s*:\s*["']([^"']+)["']/g,
  'ajax 调用': /\.(?:post|get|ajax)\s*\(\s*["']([^"']+)["']/g,
  'action=': /action=["']([^"']+)["']/g,
  'href 路径': /href=["'](\/[^"'#]+)["']/g,
  '单引号路径': /'(\/[a-zA-Z0-9_\-./]{3,70})'/g,
};

collect(login.text, '登录页', PATTERNS);

// 把登录页引用的脚本逐个抓下来分析（只抓 /res/ 下同源的）
const scripts = [...new Set([...login.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))];
console.log(`\n共 ${scripts.length} 个脚本，逐个分析：`);
for (const src of scripts) {
  const r = await get(src);
  const clean = src.startsWith('http') ? src : BASE + src;
  const name = src.replace(/[^\w.-]/g, '_').slice(-60);
  writeFileSync(`${OUT}/js_${name}`, r.text, 'utf8');
  console.log(`\n=== ${src} (HTTP ${r.status}, ${r.text.length} 字符) ===`);
  collect(r.text, src.split('/').pop(), PATTERNS);
}
