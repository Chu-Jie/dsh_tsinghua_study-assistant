// 探测清华大学网络学堂的接入可行性（只读、不登录、不发送凭据）。
//
// 目的是回答一个问题：这个插件能不能「直接读网络学堂的数据」。
// 只做公开可访问的端点探测 + 静态资源分析，不尝试登录、不带任何账号信息。
//
// 用法：node tools/probe-learn-tsinghua.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = `${import.meta.dirname}/../.probe-learn`;
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function probe(label, url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
      ...init,
    });
    const ms = Date.now() - started;
    const ct = res.headers.get('content-type') ?? '';
    let text = '';
    if (ct.includes('text') || ct.includes('json')) {
      text = await res.text();
    } else {
      await res.arrayBuffer();
    }
    console.log(`\n=== ${label} ===`);
    console.log(`  ${url}`);
    console.log(`  → HTTP ${res.status} ${res.statusText}  ${ms}ms  ${ct}`);
    for (const [k, v] of res.headers) {
      if (/^(location|set-cookie|x-|server|www-auth)/i.test(k)) console.log(`  ${k}: ${v.slice(0, 200)}`);
    }
    if (text !== '') {
      console.log(`  长度 ${text.length}`);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
      if (title) console.log(`  <title> ${title}`);
      // 找出页面里所有的脚本/表单/接口线索
      const scripts = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
      if (scripts.length) console.log(`  脚本: ${scripts.slice(0, 12).join('\n        ')}`);
      const forms = [...text.matchAll(/<form[^>]*>/gi)].map((m) => m[0]);
      if (forms.length) console.log(`  表单: ${forms.map((f) => f.replace(/\s+/g, ' ')).slice(0, 6).join('\n        ')}`);
      const apis = [...new Set([...text.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{2,60})["'`]/g)].map((m) => m[1]))]
        .filter((p) => !/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/i.test(p));
      if (apis.length) console.log(`  页面内路径线索(前 25): ${apis.slice(0, 25).join(', ')}`);
      writeFileSync(`${OUT}/${label.replace(/[^\w-]/g, '_')}.html`, text, 'utf8');
    }
    return { status: res.status, ct, text };
  } catch (error) {
    console.log(`\n=== ${label} ===`);
    console.log(`  ${url}`);
    console.log(`  → 网络错误: ${error.message}`);
    return { status: 0, ct: '', text: '' };
  }
}

console.log('探测清华大学网络学堂（只读）');
console.log(`输出目录：${OUT}`);

const HOME = await probe('01-home', 'https://learn.tsinghua.edu.cn/');
await probe('02-b-dir', 'https://learn.tsinghua.edu.cn/b/');

// 从首页里找登录入口
const loginHints = [...new Set([...HOME.text.matchAll(/(?:href|action|url)\s*=\s*["']([^"']*(?:login|sso|auth|cas)[^"']*)["']/gi)]
  .map((m) => m[1]))];
console.log(`\n登录入口线索: ${loginHints.length ? loginHints.join('\n            ') : '（首页里没有直接找到）'}`);

for (const [index, hint] of loginHints.slice(0, 3).entries()) {
  const url = hint.startsWith('http') ? hint : new URL(hint, 'https://learn.tsinghua.edu.cn/').href;
  await probe(`03-login-${index}`, url);
}

console.log('\n完成。抓到的 HTML 存在 .probe-learn/ 里，可用于进一步分析。');
