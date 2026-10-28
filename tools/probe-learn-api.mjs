// 测试网络学堂的 /b/wlxt/** 接口在**未登录**状态下是否可达、返回什么。
// 只发 GET、不带任何凭据，用来判断「需要登录」还是「被 WAF 拦截」。
// 用法：node tools/probe-learn-api.mjs
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

async function probe(path, extraHeaders = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...extraHeaders,
      },
    });
    saveCookies(res);
    const ct = res.headers.get('content-type') ?? '';
    const body = (ct.includes('text') || ct.includes('json')) ? (await res.text()).slice(0, 300) : '<binary>';
    const flag = res.status === 200 ? '✓' : res.status === 401 || res.status === 403 ? '锁' : '?';
    console.log(`${flag} HTTP ${res.status}  ${path}`);
    console.log(`    ct=${ct.slice(0, 60)}  len=${body === '<binary>' ? 'binary' : body.length}`);
    if (body !== '<binary>' && body !== '') console.log(`    body: ${body.replace(/\s+/g, ' ')}`);
    const loc = res.headers.get('location');
    if (loc) console.log(`    location: ${loc}`);
    return res.status;
  } catch (error) {
    console.log(`! 网络错误  ${path}  ${error.message}`);
    return 0;
  }
}

console.log('=== 1) 先建立会话（拿 XSRF-TOKEN 与 JSESSIONID）===');
await probe('/');
await probe('/f/redirectByStuOrTeacher');
await probe('/f/login');
console.log(`   cookie: ${[...jar.keys()].join(', ')}`);

const xsrf = jar.get('XSRF-TOKEN');

console.log('\n=== 2) 未登录直接访问 /b/wlxt/** 读取接口 ===');
const ENDPOINTS = [
  '/b/wlxt/xt/wlxt_tsk/querytsk',
  '/b/wlxt/xt/wlxt_bgk/querybgk',
  '/b/wlxt/index/course/student/course',
  '/b/wlxt/kczy/xszy/student/pageList',
  '/b/wlxt/kcgg/v_wlkc_ggb/pageList',
  '/b/wlxt/common/currentUser',
  '/b/wlxt/user/info',
];
for (const path of ENDPOINTS) await probe(path);

if (xsrf) {
  console.log('\n=== 3) 带上 X-XSRF-TOKEN 再试一次 ===');
  for (const path of ENDPOINTS.slice(0, 4)) {
    await probe(path, { 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest' });
  }
}

console.log('\n=== 4) 试试 SSO/CAS 单点登录入口是否存在 ===');
for (const path of ['/f/sso/login', '/f/cas', '/f/login/cas', '/f/ids/login', '/sso/login']) {
  await probe(path);
}

console.log('\n完成。judge: 200 可达 / 锁 需要登录 / ? 其他');
