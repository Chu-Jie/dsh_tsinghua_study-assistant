// 跟随网络学堂的登录重定向链，看它到底怎么认证（只读，不带任何凭据）。
// 用法：node tools/probe-learn-chain.mjs
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

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

async function step(url) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  });
  saveCookies(res);
  const ct = res.headers.get('content-type') ?? '';
  let text = '';
  if (ct.includes('text') || ct.includes('json') || ct.includes('javascript')) text = await res.text();
  return { status: res.status, location: res.headers.get('location'), ct, text };
}

const startUrl = process.argv[2] ?? 'https://learn.tsinghua.edu.cn/f/redirectByStuOrTeacher';
let url = startUrl;
console.log('跟随重定向链（只读）\n');

for (let i = 0; i < 10; i += 1) {
  const r = await step(url);
  console.log(`[${i}] HTTP ${r.status}  ${url}`);
  console.log(`     content-type: ${r.ct}`);
  if (r.location) console.log(`     location: ${r.location}`);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.text)?.[1]?.trim();
  if (title) console.log(`     <title>: ${title}`);
  const forms = [...r.text.matchAll(/<form[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  if (forms.length) console.log(`     form: ${forms.slice(0, 4).join(' || ')}`);
  const actions = [...new Set([...r.text.matchAll(/action=["']([^"']+)["']/gi)].map((m) => m[1]))];
  if (actions.length) console.log(`     action: ${actions.join(' , ')}`);
  const inputs = [...new Set([...r.text.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]))];
  if (inputs.length) console.log(`     inputs: ${inputs.join(', ')}`);
  const scripts = [...new Set([...r.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))];
  if (scripts.length) console.log(`     scripts: ${scripts.slice(0, 10).join('\n              ')}`);
  const iframes = [...new Set([...r.text.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))];
  if (iframes.length) console.log(`     iframe: ${iframes.join(' , ')}`);
  // 页面里出现的 API 路径线索
  const apis = [...new Set([...r.text.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{3,70})["'`]/g)].map((m) => m[1]))]
    .filter((p) => !/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)$/i.test(p));
  if (apis.length) console.log(`     路径线索: ${apis.slice(0, 20).join(', ')}`);
  console.log('');

  if (!r.location) break;
  url = r.location.startsWith('http') ? r.location : new URL(r.location, 'https://learn.tsinghua.edu.cn').href;
}

console.log(`最终 cookie: ${[...jar.keys()].join(', ') || '(无)'}`);
