#!/usr/bin/env node
/**
 * 学习台 · 「今日要闻」抓取脚本（第 15 份文档 `要闻.json`）
 *
 * 谁在跑：Windows 计划任务「学习台-要闻抓取」，每天 07:00 一次，动作直接是
 *   node.exe <本脚本> --data <学习台目录>
 * （不经 powershell / cmd 外壳，父进程是「任务计划程序」——见 ds-host-safety §7.2。）
 *
 * 约束（用户 2026-11-19 定案，别改）：
 *   - **零依赖**：只用 Node 内置模块，不 npm install；
 *   - **摘要不靠模型**：摘要 = 标题 + 日期 + 链接 + 来源 + 正文首段（抓不到首段就留空）；
 *   - **抓完后有一次内容审核**（B2 卡；用户 2026-11-19 重新拍板「AI 智能判断」，覆盖旧的「不调 LLM」）：
 *     用 DeepSeek 批量判「对在校学生有没有直接用处」，非实用的**抓取时不入库**；
 *     判据、url 缓存与「失败一律保守保留」的铁律见下面「AI 内容审核」一节；
 *   - **不碰登录态**：只抓公开页面。`info.tsinghua.edu.cn`（JS 壳+登录）与 `mp.weixin.qq.com`
 *     （单页 3.7MB）在详情白名单外，一律跳过；
 *   - **更新 = 覆盖写当次结果**：读既有 → 合并新抓（同 id 新的覆盖旧的）→ 按
 *     `NEWS_RETENTION`（14 天 ∩ 100 条）裁剪 → 整体覆盖写。合并这一步是必要的，
 *     否则「14 天窗口」永远只有一天的条目（清华新闻首页一页就 10 条 ≈ 一天的量）；
 *   - 落盘**走 lib/store.js 的 writeDocument**（校验 → 备份 → 临时文件 sync → rename），
 *     不自己 writeFileSync 覆盖，免得和宿主进程的写撞车。
 *
 * 用法：
 *   node tools/fetch-news.mjs --data "<学习台目录>"                       # 真抓 → 审核 → 真写
 *   node tools/fetch-news.mjs --data "<学习台目录>" --dry-run             # 只抓只判不写（也不写审核缓存）
 *   node tools/fetch-news.mjs --data "<学习台目录>" --no-review           # 关掉内容审核（看「审核前」长什么样）
 *   node tools/fetch-news.mjs --data "<学习台目录>" --detail 8 --detail-total 30 --quiet
 *
 * 环境变量（计划任务里不必设，留作手工排查用）：
 *   STUDY_DATA_DIR   等价于 --data
 *   STUDY_NEWS_LOG   日志文件路径，默认 %LOCALAPPDATA%\dsh-study-assistant\logs\fetch-news.log
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../lib/store.js';
import { DOC_FILES } from '../lib/core.js';
import {
  NEWS_CATEGORY_LABEL,
  NEWS_EXCERPT_MAX,
  NEWS_RETENTION,
  limitNews,
  mergeNews,
  newsExcerptFrom,
  normalizeNewsItem,
} from '../lib/core.js';

// ---------------------------------------------------------------------------
// 抓取参数
// ---------------------------------------------------------------------------

const UA = 'dsh-study-assistant-newsfetch/1.0 (personal local aggregator; +local study dashboard)';
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAYS_MS = [1000, 3000];
const POLITE_MIN_MS = 300;
const POLITE_MAX_MS = 800;

/**
 * 公开源清单（Step 0 逐站实测后定稿，**5 个栏目 / 4 个站点**）。
 *
 * B2 卡（2026-11-19）砍掉了原来的校级时政日更栏目（原 `www.tsinghua.edu.cn/news/zxdt.htm`）：
 * 它整页是宣传工作会 / 领导会见 / 签约揭牌 / 入党发展会 / 外事论坛 / 纯科研进展，对在校学生没用。
 * 同站的「清华新闻·人才培养」保留 —— 那里夹杂退课、奖学金、就业等实用稿，交给下面
 * 「AI 内容审核」逐条判。
 *
 * `parser` 决定列表怎么抽；`detail` 决定详情页要不要抓（只为首段与「列表无标题」的场景）。
 * 日期解析不了、标题抽不出来的条目一律丢 —— 不猜、不补、不编。
 */
const SOURCES = [
  {
    id: 'learning-tzgg',
    name: '学发中心·通知公告',
    url: 'https://learning.tsinghua.edu.cn/xwgg/tzgg.htm',
    source: '学发中心',
    category: 'notice',
    parser: 'learning',
    detail: 'sparse', // 只有少数条目指向可抽详情的域（大部分指向 info 门户，会按白名单跳过）
  },
  {
    id: 'learning-dtxw',
    name: '学发中心·动态新闻',
    url: 'https://learning.tsinghua.edu.cn/xwgg/dtxw.htm',
    source: '学发中心',
    category: 'career',
    parser: 'learning',
    detail: 'sparse',
  },
  {
    id: 'thu-news-rcpy',
    name: '清华新闻·人才培养',
    url: 'https://www.tsinghua.edu.cn/news/rcpy.htm',
    source: '清华新闻',
    category: 'academic',
    parser: 'thuNews',
    detail: 'sparse', // 列表自带摘要，详情只为补长
  },
  {
    id: 'icenter-tzgg',
    name: 'iCenter·通知公告',
    url: 'https://www.icenter.tsinghua.edu.cn/index/tzgg.htm',
    source: 'iCenter 训练中心',
    category: 'competition',
    // 列表把「日期 + 标题 + 摘要」糊成一整块、没有独立节点，所以标题以详情页 <title> 为准
    parser: 'icenter',
    detail: 'all',
  },
  {
    id: 'tiaozhanbei-notice',
    name: '挑战杯·赛事通知',
    url: 'https://www.tiaozhanbei.net/tzb/notice',
    source: '挑战杯',
    category: 'competition',
    parser: 'tiaozhanbei',
    detail: 'all',
  },
];

/** 详情页域名白名单（不在表里的一律不抓详情；`info.tsinghua.edu.cn` / 微信故意不在内）。 */
const DETAIL_HOSTS = [
  'www.tsinghua.edu.cn',
  'www.icenter.tsinghua.edu.cn',
  'www.tiaozhanbei.net',
];
const DETAIL_HOST_SUFFIXES = ['.cic.tsinghua.edu.cn'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = () => POLITE_MIN_MS + Math.floor(Math.random() * (POLITE_MAX_MS - POLITE_MIN_MS));

/** 去掉标签、压平空白、解几个最常见的实体。 */
function stripTags(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 把 `2026.11.18` / `2026-11-18` / `2026年11月18日` 统一成 `YYYY-MM-DD`；解不出来返回 null。 */
function toDate(text) {
  const raw = String(text ?? '').trim();
  let match = /^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/.exec(raw);
  if (match === null) match = /(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `MM-DD` + `YYYY` 两个节点拼成日期。 */
function toDateFromParts(monthDay, year) {
  const md = /(\d{1,2})-(\d{1,2})/.exec(String(monthDay ?? ''));
  const yy = /(\d{4})/.exec(String(year ?? ''));
  if (md === null || yy === null) return null;
  return toDate(`${yy[1]}.${md[1]}.${md[2]}`);
}

/** 详情页白名单判定。 */
function detailAllowed(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (DETAIL_HOSTS.includes(host)) return true;
  return DETAIL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 把列表里的 href 解析成绝对 URL，并**把清华各站的 http 统一升到 https**。
 *
 * 为什么必须做：同一篇稿子在清华新闻的不同栏目里协议写法不同 —— 有的写 `http://www.tsinghua.edu.cn/info/1176/129386.htm`，
 * 有的写相对 `../info/1176/129386.htm`（解析出来是 https）。协议不同 →
 * `newsIdForUrl` 算出两个 id → 同一条要闻在面板上出现两次。统一协议后 id 才真正按「同一篇文章」归一。
 */
function resolveUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  let url;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.protocol === 'http:' && /(^|\.)tsinghua\.edu\.cn$/i.test(url.hostname)) url.protocol = 'https:';
  return url.toString();
}

/** 按 content-type / 域名决定如何解码（校园站有一批 GBK 页面，用 utf8 读会得到乱码）。 */
function decodeBody(buffer, contentType, url) {
  const ct = String(contentType ?? '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const likelyGbk = ct.includes('gbk') || ct.includes('gb2312') || ct.includes('gb18030')
    || DETAIL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (likelyGbk) {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      // 本机 ICU 不带 gbk 时退到 utf-8（只会让首段变乱码，不至于整条丢掉）
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/** 带超时与重试的 GET；返回 `{ok, status, text, error}`，**不抛异常**（一个源挂了不该拖垮整轮）。 */
async function fetchText(url, label) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // 4xx 重试没有意义（除了 429）
        if (response.status !== 429 && response.status >= 400 && response.status < 500) break;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = decodeBody(buffer, response.headers.get('content-type'), url);
      return { ok: true, status: response.status, text, bytes: buffer.length };
    } catch (error) {
      lastError = String(error?.message ?? error);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: null, text: '', error: `${label}: ${lastError ?? 'unknown'}` };
}

// ---------------------------------------------------------------------------
// 列表解析（每个源一套，按 Step 0 实测的 DOM 结构写）
// ---------------------------------------------------------------------------

/** 学发中心（learning.tsinghua.edu.cn）：`li.list-item` + `p.md`/`p.year` + `h3[title]`。 */
function parseLearning(html, source) {
  const rows = [];
  const blocks = html.split(/<li[^>]*class="[^"]*list-item[^"]*"/i).slice(1);
  for (const block of blocks) {
    const chunk = block.slice(0, block.indexOf('</li>') === -1 ? block.length : block.indexOf('</li>'));
    const href = /href="([^"]+)"/.exec(chunk);
    const title = /<h3[^>]*title="([^"]*)"/.exec(chunk) ?? /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk);
    const monthDay = /class="md"[^>]*>([\d]{1,2}-[\d]{1,2})/.exec(chunk);
    const year = /class="year"[^>]*>(\d{4})/.exec(chunk);
    if (href === null || title === null) continue;
    // ⚠️ 实测这个栏目的列表**不是严格按日期降序**（第 1 页首条反而是最旧的），
    // 所以这里只负责解析，排序统一交给 core.sortNews。
    const publishedAt = toDateFromParts(monthDay?.[1], year?.[1]);
    rows.push({
      title: stripTags(title[1]),
      url: href[1],
      base: source.url,
      publishedAt,
      excerpt: '',
    });
  }
  return rows;
}

/** 清华新闻（www.tsinghua.edu.cn/news/*）：`div.sj > p`(日) + `span`(YYYY.MM) + `div.tit p.bt`。 */
function parseThuNews(html, source) {
  const rows = [];
  const blocks = html.split(/<li[\s>]/i).slice(1);
  for (const block of blocks) {
    if (!/class="sj"/.test(block)) continue;
    const chunk = block.slice(0, block.indexOf('</li>') === -1 ? block.length : block.indexOf('</li>'));
    const href = /href="([^"]+)"/.exec(chunk);
    const day = /class="sj"[^>]*>\s*<p[^>]*>(\d{1,2})<\/p>/.exec(chunk);
    const month = /<span[^>]*>(\d{4})\.(\d{1,2})<\/span>/.exec(chunk);
    const title = /class="bt"[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
    if (href === null || title === null) continue;
    const publishedAt = day === null || month === null
      ? null
      : toDate(`${month[1]}.${month[2]}.${day[1]}`);
    // 「人才培养」这类栏目把摘要直接写在列表里（截断在固定长度）—— 有就用，没有就留给详情页
    const rest = title[1] === undefined ? '' : chunk.slice(chunk.indexOf(title[0]) + title[0].length);
    const inline = stripTags(rest).replace(/\s+/g, ' ').trim();
    rows.push({
      title: stripTags(title[1]),
      url: href[1],
      base: source.url,
      publishedAt,
      excerpt: inline.length >= 20 ? inline.slice(0, 400) : '',
    });
  }
  return rows;
}

/** iCenter（index/tzgg）：`ul.nt11 > li > a`，`div.time > h3`(MM-DD) + `h6`(YYYY)，`h4` 标题、`p` 摘要。 */
function parseIcenter(html, source) {
  const rows = [];
  const blocks = html.split(/<li[\s>]/i).slice(1);
  for (const block of blocks) {
    if (!/class="time"/.test(block)) continue;
    const chunk = block.slice(0, block.indexOf('</li>') === -1 ? block.length : block.indexOf('</li>'));
    const href = /href="([^"]+)"/.exec(chunk);
    const monthDay = /<h3[^>]*>([\d]{1,2}-[\d]{1,2})<\/h3>/.exec(chunk);
    const year = /<h6[^>]*>(\d{4})<\/h6>/.exec(chunk);
    const title = /<h4[^>]*>([\s\S]*?)<\/h4>/.exec(chunk);
    const excerpt = /<p[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
    if (href === null || title === null) continue;
    rows.push({
      title: stripTags(title[1]),
      url: href[1],
      base: source.url,
      publishedAt: toDateFromParts(monthDay?.[1], year?.[1]),
      // 列表里的摘要被截断过（末尾带 ...），够用了；只有空的时候才去详情页补
      excerpt: excerpt === null ? '' : stripTags(excerpt[1]),
    });
  }
  return rows;
}

/** 挑战杯（tzb/notice）：`<a href="/article/NNNN/">标题</a>` + 紧随其后的 `YYYY.MM.DD`（部分条目无日期）。 */
function parseTiaozhanbei(html, source) {
  const rows = [];
  const blocks = html.split(/<a[^>]*href="\/article\//i).slice(1);
  for (const block of blocks) {
    const idMatch = /^(\d+)\//.exec(block);
    if (idMatch === null) continue;
    const open = block.indexOf('>');
    const close = block.indexOf('</a>');
    if (open === -1 || close === -1 || close < open) continue;
    const title = stripTags(block.slice(open + 1, close)).replace(/\s+/g, ' ').trim();
    if (title === '') continue;
    // 日期不在 <a> 里，落在它后面的兄弟节点上；本块到下一个 /article/ 链接为止，所以在尾部找
    const tail = block.slice(close, close + 300);
    const dateMatch = /(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(tail);
    rows.push({
      title,
      url: `/article/${idMatch[1]}/`,
      base: source.url,
      publishedAt: dateMatch === null ? null : toDate(`${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}`),
      excerpt: '',
      // 列表没日期就去详情页要一个；要不到就按「缺日期」丢掉（不编日期）
      dateFromDetail: dateMatch === null,
    });
  }
  return rows;
}

const PARSERS = {
  learning: parseLearning,
  thuNews: parseThuNews,
  icenter: parseIcenter,
  tiaozhanbei: parseTiaozhanbei,
};

// ---------------------------------------------------------------------------
// 详情页：首段 + （必要时）标题/日期
// ---------------------------------------------------------------------------

/**
 * 从详情页里抠正文首段。
 *
 * 坑（Step 0 实测）：清华新闻详情页有**两个** `div.content`，第二个是页脚版权块
 * （「清华大学新闻中心版权所有…」）。所以只取**第一个**候选块，并且把含「版权所有」的
 * 块整体跳过 —— 否则会把页脚当首段。
 */
function extractExcerpt(html) {
  const cleaned = String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const candidates = [
    /<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>/i,
    /<div[^>]*id="(?:vsb_content|js_content|content)"[^>]*>/i,
    /<div[^>]*class="[^"]*(?:article|TRS_Editor|artical)[^"]*"[^>]*>/i,
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(cleaned);
    if (match === null) continue;
    const block = cleaned.slice(match.index + match[0].length, match.index + match[0].length + 60000);
    const text = stripTags(block);
    // 页脚 / 版权块 / 太短的块都不算首段
    if (/版权所有|京ICP备|Copyright/i.test(text.slice(0, 120))) continue;
    const paragraph = firstRealParagraph(text);
    if (paragraph !== '') return paragraph;
  }
  // 兜底：整页去掉导航与标题后，找第一段足够长的文字
  const whole = stripTags(cleaned);
  return firstRealParagraph(whole);
}

/** 取第一段「像正文」的文字：优先 ≥25 字的行，其次最长的行；都不行就空。 */
function firstRealParagraph(text) {
  const lines = String(text ?? '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const substantial = lines.find((line) => line.length >= 25 && !/^(首页|返回|上一篇|下一篇|分享)/.test(line));
  if (substantial !== undefined) return substantial;
  const longest = lines.reduce((best, line) => (line.length > best.length ? line : best), '');
  return longest.length >= 15 ? longest : '';
}

/** 详情页 `<title>`（去掉「 - 清华大学」「_清华大学」这类后缀）。 */
function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  if (match === null) return '';
  return stripTags(match[1])
    .replace(/[|_-]\s*清华大学.*$/g, '')
    .replace(/\s*[-_|]\s*清华新闻网.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 详情页里出现的第一个日期（挑战杯列表没日期时用）。 */
function extractDate(html) {
  const text = stripTags(String(html ?? '').slice(0, 20000));
  const patterns = [/(\d{4})-(\d{1,2})-(\d{1,2})/, /(\d{4})\.(\d{1,2})\.(\d{1,2})/, /(\d{4})年(\d{1,2})月(\d{1,2})日/];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = toDate(`${match[1]}.${match[2]}.${match[3]}`);
    if (value !== null) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 参数与日志
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    dataDir: process.env.STUDY_DATA_DIR ?? '',
    logFile: process.env.STUDY_NEWS_LOG ?? '',
    dryRun: false,
    quiet: false,
    // 详情预算：默认每源 12 条、全局 40 条。6 个源一天的列表量大约 60 条，其中真正需要
    // 详情的（首段为空 / 列表没日期）约 30–40 条 —— 这个预算刚好覆盖，又不会一次发几百个请求。
    detailPerSource: 15,
    detailTotal: 45,
    // 内容审核（B2）：默认开；--no-review 关掉，用来对比「审核前 vs 审核后」
    review: true,
    reviewCachePath: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--data') { options.dataDir = next ?? ''; index += 1; continue; }
    if (arg === '--log') { options.logFile = next ?? ''; index += 1; continue; }
    if (arg === '--detail') { options.detailPerSource = Math.max(0, Number(next) || 0); index += 1; continue; }
    if (arg === '--detail-total') { options.detailTotal = Math.max(0, Number(next) || 0); index += 1; continue; }
    if (arg === '--review-cache') { options.reviewCachePath = next ?? ''; index += 1; continue; }
    if (arg === '--no-review') { options.review = false; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--quiet') { options.quiet = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
  }
  if (options.logFile === '') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    options.logFile = path.join(base, 'dsh-study-assistant', 'logs', 'fetch-news.log');
  }
  if (options.reviewCachePath === '') options.reviewCachePath = defaultReviewCachePath();
  return options;
}

/** 日志：同时落盘与 stdout（落盘是为了计划任务跑完之后还能回读「真在跑」的证据）。 */
function createLogger(file, quiet) {
  const lines = [];
  const write = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };
  return {
    write,
    line: (text) => write(`[${new Date().toISOString()}] ${text}`),
    flush: async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, `${lines.join('\n')}\n`, 'utf8');
      } catch (error) {
        // 日志写不进去不能拖垮抓取本身，但要在 stderr 留痕
        console.error(`[fetch-news] 日志落盘失败：${String(error?.message ?? error)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AI 内容审核（B2 卡 2026-11-19；用户重新拍板「AI 智能判断」，覆盖旧的「不调 LLM」）
// ---------------------------------------------------------------------------
//
// 为什么有这一层：原有筛选是**按来源赋 category**（`清华新闻` 一律 `academic`），而校级新闻是
// 时政日更 —— 宣传工作会、领导会见、签约揭牌、入党发展会、外事论坛、纯科研进展全被当成
// 「教务教学」塞进面板。用户验收原话：「搜集到的信息很差，尽是些没用的」。所以改成**按内容判**。
//
// 三条铁律（用户定，别改）：
//   1. **失败保守**：模型挂了 / 输出非法 / 凭据缺失 → 本批**全部保留**（等同没加这一层），
//      只记日志 ERR —— 绝不清空要闻、绝不误杀；
//   2. **判过就不再花钱**：url 归一后哈希做 key 落缓存，重复抓到直接用旧判决；
//      缓存不进仓库、不进备份、不是第 16 份文档；
//   3. **一次批量**：≤60 条一批、每批最多 2 次模型请求，不做一条一问。
//
// `callModel` 是注入参数：测试传假的（不真调 API），生产传下面 `createReviewCaller` 造的
// Paratera fetch（与 `_工具/OCR修复/batch-fix.mjs` 同一条通道：temperature 0.2、429/5xx 退避重试）。

/** 审核通道（与 batch-fix.mjs 同源；可用环境变量覆盖，便于本机排查）。 */
const REVIEW_BASE_URL = process.env.PARATERA_BASE_URL || 'https://llmapi.paratera.com/v1';
const REVIEW_MODEL = process.env.PARATERA_MODEL || 'DeepSeek-V4.1-Flash-1017';
/** 一批最多判多少条（再多就分批发，避免单次响应被截断）。 */
const REVIEW_BATCH_MAX = 40;
/** 单次请求超时；批量判几十条首段，90s 足够，超时按失败处理（保守保留）。 */
const REVIEW_REQUEST_MS = 90000;
/** 缓存只留最近判过的这么多条，避免文件无限长大。 */
const REVIEW_CACHE_KEEP = 500;
/** 每条首段送进 prompt 的最大字数（判据主要看标题，首段只做补充）。 */
const REVIEW_EXCERPT_MAX = 150;

/**
 * 审核判据（system）。写法要点：先说「保留什么」再说「剔除什么」，最后一句必须是
 * 「拿不准倾向保留」——这样模型漏判时偏向留，符合「宁可多留一条，不可错删有用通知」。
 */
const REVIEW_SYSTEM_PROMPT = `你是清华大二学生本人的「今日要闻」审核员。抓取脚本把候选新闻交给你，你只做一件事：判断每一条对**在校学生本人的学习 / 生活 / 科研 / 就业**是否**直接有用**，决定它能不能进面板。

【保留】凡带具体学生行动项的一律保留：
选课 / 退课 / 考试安排 / 成绩与复议 / 报名 / 申请 / 截止日期 / 奖学金与助学金 / 立项与入选结果 / 录取公示 / 讲座与报告会（学生可听）/ 招聘会 / 宣讲会 / 实习 / 竞赛（挑战杯、揭榜挂帅、大创、星火、URT 等）/ 假期与校历 / 教室、宿舍、图书馆、食堂、校医院的开放与变更 / 校园服务（校园卡、网费、班车、体测、医保、报到）通知。

【结果类怎么判】立项结果、入选名单、录取公示、获奖名单 —— 只要名单里的对象是**学生个人或学生团队**，就保留（学生要查自己在不在里面）；对象是高校、院系、机构、教师，或者是「赛事已落幕」的赛后报道，一律剔除。

【剔除】以下一律 drop：
① 校级宣传工作会、宣传口会议、理论学习与意识形态活动；
② 领导会见、调研、视察、座谈；
③ 对外签约、揭牌、合作协议、挂牌、共建；
④ 入党发展会、人事任免、干部培训、挂职锻炼；
⑤ 外事论坛、峰会、边会、国际会议主办；
⑥ 纯科研进展与学术成果报道（论文发表、结构解析、实验突破、团队获奖），除非明确写着招学生参与或报名；
⑦ 校友活动与社会捐赠、基金会捐赠；
⑧ 没有任何学生行动项的泛泛动态（荣誉、排名、致辞、纪念、座谈）。

【拿不准就保留】宁可多留一条无用新闻，也绝不错删一条学生要用的通知。只要标题或首段出现「报名 / 申请 / 截止 / 面向 / 学生 / 同学 / 选课 / 退课 / 考试 / 奖学金 / 招聘 / 实习 / 竞赛 / 讲座 / 开放 / 预约 / 领取 / 缴费」这类学生行动词，即使来源是清华新闻也保留。

【真实例子（照这个口径判）】
drop：2026年秋季学期宣传工作负责人会议召开
drop：人工智能学院召开助理教授刘淼入党发展会
drop：清华大学与北汽集团签署战略合作协议
drop：清华大学和香港中文大学（深圳）主办APEC大学领导人论坛
drop：生命学院李赛团队合作解析嵌在痘病毒内核上的门户复合物的结构
drop：「韧性之路：建设气候适应型社会」高级别主题边会举行
keep：2026-2027秋 本科生/研究生退课安排
keep：2026年清华大学特等奖学金（本科生）答辩会入围名单公示
keep：清华自习地点图鉴
keep：秋招进行时，让「清小搭」助你一臂之力！
keep：计算机系举办第四届「家国计」就业洽谈会
keep：挑战杯 / 揭榜挂帅 / 大创类赛事通知

【输出格式】只输出一个 JSON 对象，不要解释、不要任何推理过程、不要代码围栏；第一个字符必须是 {，最后一个字符必须是 }：
{"keep":["id1","id2"],"drop":["id3"],"why":{"id3":"≤20字理由"}}
keep 与 drop 的 id 合起来必须正好覆盖输入里的全部条目：不漏、不重、不编新 id。why 只写 drop 的。`;

/**
 * 生成审核 prompt。
 *
 * @param {Array<object>} items 归一化后的要闻（有 id / publishedAt / source / title / excerpt）
 * @returns {{system: string, user: string}} 纯函数，可断言（测试不依赖网络）
 */
export function buildReviewPrompt(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.map((item) => {
    const id = String(item?.id ?? '');
    const date = String(item?.publishedAt ?? '');
    const source = String(item?.source ?? '').replace(/\s+/g, ' ').trim();
    const title = String(item?.title ?? '').replace(/\s+/g, ' ').trim();
    const excerpt = String(item?.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, REVIEW_EXCERPT_MAX);
    return `${id} | ${date} | ${source} | ${title} | ${excerpt === '' ? '（无首段）' : excerpt}`;
  });
  const user = [
    `【候选新闻】共 ${list.length} 条，每条一行，格式：id | 日期 | 来源 | 标题 | 首段（最多${REVIEW_EXCERPT_MAX}字）`,
    ...rows,
    '',
    `请逐条判定上面 ${list.length} 条，输出 {"keep":[...],"drop":[...],"why":{...}}。`,
    `keep 与 drop 的 id 合起来必须正好覆盖这 ${list.length} 条（不漏、不重、不编）。`,
    `只输出 JSON 本身：第一个字符是 {，最后一个字符是 }，不要解释、不要推理过程、不要代码围栏。`,
  ].join('\n');
  return { system: REVIEW_SYSTEM_PROMPT, user };
}

/**
 * 解析模型输出。容错优先，**永远不抛**：
 *   - 带代码围栏 / 前后有寒暄 → 抠第一个 `{` 到最后一个 `}` 再解析；
 *   - 解析不了 → `{error}`（调用方按「本批全部保留」处理）；
 *   - id 不在输入里 → 忽略（模型编的 id 不能影响真条目）；
 *   - 同一个 id 同时出现在 keep 和 drop → **保留优先**（安全侧）；
 *   - 输入里有、输出里两个数组都没提到的 id → 记进 `missing`，由调用方按保留处理。
 *
 * @param {string} text 模型返回的原文
 * @param {Array<object>} items 送审的那批条目（用来校验 id 与算 missing）
 * @returns {{keep: string[], drop: string[], why: object, missing: string[], degraded: boolean} | {error: string}}
 */
export function parseReviewResponse(text, items) {
  const list = Array.isArray(items) ? items : [];
  const valid = new Set();
  for (const item of list) {
    const id = String(item?.id ?? '');
    if (id !== '') valid.add(id);
  }
  if (valid.size === 0) return { error: 'no-items' };

  const raw = String(text ?? '').replace(/```[A-Za-z]*\s*/g, ' ').replace(/```/g, ' ');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return { error: 'no-json' };

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: 'bad-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'bad-shape' };

  const pick = (value) => {
    const ids = Array.isArray(value) ? value : [];
    const out = [];
    for (const entry of ids) {
      const id = String(entry ?? '');
      if (valid.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const keep = pick(parsed.keep);
  const keepSet = new Set(keep);
  const drop = pick(parsed.drop).filter((id) => !keepSet.has(id));
  if (keep.length === 0 && drop.length === 0) return { error: 'no-verdict' };

  const why = {};
  const reasons = parsed.why;
  if (reasons !== null && typeof reasons === 'object' && !Array.isArray(reasons)) {
    for (const [id, reason] of Object.entries(reasons)) {
      if (!valid.has(id)) continue;
      const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') why[id] = text.slice(0, 40);
    }
  }

  const decided = new Set([...keep, ...drop]);
  const missing = [...valid].filter((id) => !decided.has(id));
  return { keep, drop, why, missing, degraded: missing.length > 0 };
}

// ---------------------------------------------------------------------------
// 审核缓存（%LOCALAPPDATA%\dsh-study-assistant\logs\news-review-cache.json）
// ---------------------------------------------------------------------------

/** 审核缓存的默认落点（**不是第 16 份文档**，不进仓库、不进备份）。 */
function defaultReviewCachePath() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-study-assistant', 'logs', 'news-review-cache.json');
}

/** url → 缓存 key：先按 core 的口径归一，再取 sha256 前 16 位（同 url 同 key，与 id 无关）。 */
function reviewCacheKey(url) {
  const text = String(url ?? '').trim();
  if (text === '') return '';
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 读缓存；文件不存在 / 坏了都当空缓存（审核照跑，不影响抓取）。 */
async function readReviewCache(file) {
  if (typeof file !== 'string' || file === '') return {};
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text.replace(/^\ufeff/, ''));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 写缓存：只留最近 `REVIEW_CACHE_KEEP` 条；写失败只记日志（缓存丢了下次重判，不算故障）。 */
async function writeReviewCache(file, cache, logger) {
  if (typeof file !== 'string' || file === '') return;
  const entries = Object.entries(cache)
    .filter(([, value]) => value !== null && typeof value === 'object' && typeof value.keep === 'boolean')
    .sort((left, right) => String(right[1].at ?? '').localeCompare(String(left[1].at ?? '')))
    .slice(0, REVIEW_CACHE_KEEP);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, 'utf8');
  } catch (error) {
    logger?.line(`⚠ 审核缓存写入失败（不影响本次结果）：${String(error?.message ?? error)}`);
  }
}

// ---------------------------------------------------------------------------
// 审核主函数
// ---------------------------------------------------------------------------

/**
 * 批量审核。**唯一出口是 `kept`**：调用方只把 `kept` 交给 mergeNews，被 drop 的压根不入库。
 *
 * @param {Array<object>} items 归一化后的条目（`normalizeNewsItem` 产物）
 * @param {object} options
 * @param {Function} [options.callModel] `async ({system,user}) => {content}`；不传 = 审核不可用（全保留）
 * @param {string} [options.cachePath] 缓存文件路径；空 = 不用缓存
 * @param {object} [options.logger] 有 `.line(text)`
 * @param {boolean} [options.enabled=true] false = 本层关闭（`--no-review`）
 * @param {boolean} [options.writeCache=true] dry-run 传 false（判了但不落缓存）
 * @returns {Promise<{kept: object[], dropped: object[], failed: string[], cached: number,
 *   enabled: boolean, why: object, error?: string, degraded: boolean}>}
 */
export async function reviewItems(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const logger = options.logger;
  const cachePath = typeof options.cachePath === 'string' ? options.cachePath : '';
  const writeCache = options.writeCache !== false;
  const callModel = typeof options.callModel === 'function' ? options.callModel : null;
  const enabled = options.enabled !== false;
  const result = {
    kept: list.slice(),
    dropped: [],
    failed: [],
    cached: 0,
    enabled,
    why: {},
    degraded: false,
  };
  if (!enabled) return result; // 关掉就是原样（不做任何模型请求）
  if (list.length === 0) return result;

  // 凭据缺失 / 通道造不出来 → 这一层视为不可用，整批保留（第一硬规矩）
  if (callModel === null) {
    result.enabled = false;
    result.error = 'missing-model-channel';
    return result;
  }

  const cache = await readReviewCache(cachePath);
  const order = new Map();
  list.forEach((item, index) => { if (!order.has(item?.id)) order.set(item?.id, index); });

  const kept = [];
  const dropped = [];
  const pending = [];
  for (const item of list) {
    const key = reviewCacheKey(item?.url);
    const hit = key === '' ? null : cache[key];
    if (hit !== null && typeof hit === 'object' && typeof hit.keep === 'boolean') {
      result.cached += 1;
      if (hit.keep === true) {
        kept.push(item);
      } else {
        dropped.push(item);
        if (typeof hit.why === 'string' && hit.why !== '') result.why[item.id] = hit.why;
      }
      continue;
    }
    pending.push(item);
  }

  let lastError = null;
  for (let start = 0; start < pending.length; start += REVIEW_BATCH_MAX) {
    const chunk = pending.slice(start, start + REVIEW_BATCH_MAX);
    let verdict = null;
    let parseError = null;
    // 每批最多 2 次请求：第一次不合格（非法 JSON / 没判决）才重问一次
    for (let attempt = 0; attempt < 2 && verdict === null; attempt += 1) {
      try {
        const reply = await callModel(buildReviewPrompt(chunk));
        const content = reply !== null && typeof reply === 'object' ? (reply.content ?? reply.text ?? '') : reply;
        const parsed = parseReviewResponse(content, chunk);
        if (parsed.error === undefined) {
          verdict = parsed;
          break;
        }
        parseError = parsed.error;
        logger?.line(`  · 审核输出不合格（${parsed.error}）${attempt === 0 ? '，重问一次' : '，这批按保留处理'}`);
        // 失败样本落日志（前 80 字），排查模型是「答非所问」还是「被截断」——不含凭据，可安全落盘
        logger?.line(`  · 响应样本（前 80 字）：${String(content).replace(/\s+/g, ' ').slice(0, 80) || '（空）'}`);
      } catch (error) {
        lastError = String(error?.message ?? error);
        logger?.line(`  · 审核请求失败（${lastError}）${attempt === 0 ? '，重试一次' : '，这批按保留处理'}`);
      }
    }

    if (verdict === null) {
      // 两次都没拿到可用判决 → 这批**全部保留**，记 failed 供 RESULT 与日志呈现
      for (const item of chunk) {
        kept.push(item);
        result.failed.push(item.id);
      }
      if (result.error === undefined) result.error = lastError ?? parseError ?? 'review-unavailable';
      continue;
    }

    const dropSet = new Set(verdict.drop);
    for (const item of chunk) {
      if (dropSet.has(item.id)) {
        dropped.push(item);
        const reason = verdict.why[item.id];
        if (typeof reason === 'string' && reason !== '') result.why[item.id] = reason;
      } else {
        // keep 与 missing（模型漏判）都按保留 —— 宁可多留
        kept.push(item);
      }
    }
    if (verdict.degraded === true) {
      result.degraded = true;
      logger?.line(`  · review degraded：本批有 ${verdict.missing.length} 条模型没判到，已按保留处理`);
    }

    if (writeCache === true && cachePath !== '') {
      const at = new Date().toISOString();
      for (const item of chunk) {
        const key = reviewCacheKey(item?.url);
        if (key === '') continue;
        if (!verdict.keep.includes(item.id) && !dropSet.has(item.id)) continue; // 漏判的不缓存，下次还能重判
        cache[key] = {
          keep: dropSet.has(item.id) ? false : true,
          why: verdict.why[item.id] ?? '',
          at,
        };
      }
    }
  }

  if (writeCache === true && cachePath !== '' && pending.length > 0) await writeReviewCache(cachePath, cache, logger);

  // 有任何一批没判成 → 这一层整体标为不可用（RESULT 里能看到，日志已报 ERR）
  if (result.failed.length > 0) result.enabled = false;

  // 保持原始顺序（缓存命中与实时判定的条目会交错，交给 mergeNews 前先归位）
  const rank = (item) => order.get(item?.id) ?? Number.MAX_SAFE_INTEGER;
  result.kept = kept.slice().sort((left, right) => rank(left) - rank(right));
  result.dropped = dropped.slice().sort((left, right) => rank(left) - rank(right));
  return result;
}

/**
 * 生产用 `callModel`：从 `~/.dsh/.credentials.yaml` 读 `refs.PARATERA_API_KEY` 后直连 Paratera。
 *
 * **密钥绝不打印、不落盘、不进 prompt、不进日志**；这里只在 Authorization 头里用一次。
 * 读不到凭据返回 `null` → `reviewItems` 会把整批判为「通道不可用」并全部保留。
 */
async function createReviewCaller() {
  let credentialFile;
  let text;
  try {
    credentialFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    text = await fs.readFile(credentialFile, 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*PARATERA_API_KEY:\s*(\S+)\s*$/m.exec(text);
  if (match === null || match[1] === '') return null;
  const apiKey = match[1];

  return async function callModel({ system, user }) {
    let lastError = null;
    // 429 / 5xx 退避重试：共 3 次（2s、4s），与 batch-fix.mjs 的口径一致
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(2000 * attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REVIEW_REQUEST_MS);
      try {
        const response = await fetch(`${REVIEW_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: REVIEW_MODEL,
            temperature: 0.2,
            max_tokens: 8000,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content ?? '';
        if (typeof content !== 'string' || content.trim() === '') throw new Error('模型返回空内容');
        return { content };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('模型调用失败');
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 取一个源的列表页（每个源只取第 1 页：首页即最新，多抓只会重复）。 */
async function fetchSourceList(source, logger) {
  const result = await fetchText(source.url, `${source.name} 列表`);
  if (!result.ok) {
    logger.line(`✗ ${source.name} 列表 ${source.url} → ${result.error}`);
    return [];
  }
  logger.line(`✓ ${source.name} 列表 ${source.url} → ${result.bytes} bytes`);
  const parser = PARSERS[source.parser];
  // 解析完立刻把链接解析成绝对地址并归一到 https：后面的详情白名单与 id 生成都依赖它
  const rows = parser(result.text, source)
    .map((row) => ({ ...row, url: resolveUrl(row.url, row.base) ?? '', base: undefined }))
    .filter((row) => row.url !== '');
  // 同一页里同一篇稿子常出现两次（桌面 / 移动两套标记），其中一处把日期放在链接**前面**，
  // 于是「同 url 一条有日期、一条没日期」。按 url 合并：有日期的优先，摘要取非空的那份。
  const byUrl = new Map();
  for (const row of rows) {
    const previous = byUrl.get(row.url);
    if (previous === undefined) {
      byUrl.set(row.url, row);
      continue;
    }
    byUrl.set(row.url, {
      ...previous,
      title: previous.title !== '' ? previous.title : row.title,
      publishedAt: previous.publishedAt ?? row.publishedAt,
      excerpt: (previous.excerpt ?? '') !== '' ? previous.excerpt : row.excerpt,
    });
  }
  return [...byUrl.values()].map((row) => ({ ...row, dateFromDetail: row.publishedAt === null }));
}

/**
 * 抓详情：只为「拿首段」和「列表没有日期」两种情况花请求。
 *
 * 两个省请求的规矩（都对站点友好，也省自己的时间）：
 *   1. **超出保留窗口的旧条目直接跳过** —— 它们本来就会被 `limitNews` 裁掉，抓详情没有意义；
 *   2. 每个源有上限、全局也有上限（`--detail` / `--detail-total`），不会一次跑几百个请求。
 */
async function enrichWithDetail(rows, source, limits, minDay, logger) {
  const budget = Math.min(limits.perSource, limits.remaining);
  let used = 0;
  for (const row of rows) {
    if (used >= budget) break;
    const need = row.excerpt === '' || row.dateFromDetail === true;
    if (!need) continue;
    // 有日期但太旧的：抓了也会被裁掉，直接跳过
    if (row.dateFromDetail !== true && typeof row.publishedAt === 'string' && row.publishedAt < minDay) continue;
    if (!detailAllowed(row.url)) continue; // 白名单外的（info 门户 / 微信）直接跳过
    used += 1;
    limits.remaining -= 1;
    const result = await fetchText(row.url, `${source.name} 详情`);
    if (!result.ok) {
      logger.line(`  · 详情失败 ${row.url} → ${result.error}`);
      continue;
    }
    const title = extractTitle(result.text);
    if (row.titleFromList === true && title !== '') row.title = title;
    if (row.dateFromDetail === true) {
      const date = extractDate(result.text);
      if (date !== null) row.publishedAt = date;
    }
    if (row.excerpt === '') row.excerpt = extractExcerpt(result.text);
    await sleep(jitter());
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log('用法：node tools/fetch-news.mjs --data <学习台目录> [--dry-run] [--no-review] [--review-cache <文件>] [--detail N] [--detail-total N] [--quiet] [--log <文件>]');
    return 0;
  }
  const logger = createLogger(options.logFile, options.quiet);
  logger.line(`—— 今日要闻抓取开始（${options.dryRun ? 'dry-run，不写盘' : '真实写入'}）`);

  if (options.dataDir === '') {
    logger.line('✗ 缺少数据目录：请传 --data <学习台目录>，或设环境变量 STUDY_DATA_DIR');
    await logger.flush();
    return 2;
  }
  const dataDir = path.resolve(options.dataDir);
  logger.line(`数据目录 ${dataDir}`);
  logger.line(`日志文件 ${options.logFile}`);

  // ---- 一、读既有文档（dry-run 也读，这样才能算出「合并后会是什么样」）----
  const store = createStore(dataDir);
  let existing = [];
  let expectedHash = null;
  const read = await store.readDocument('news');
  if (read.ok === true) {
    existing = Array.isArray(read.doc?.items) ? read.doc.items : [];
    expectedHash = read.hash;
    logger.line(`既有要闻 ${existing.length} 条（updatedAt ${read.doc?.updatedAt ?? 'null'}）`);
  } else if (read.reason === 'missing') {
    logger.line('既有要闻：文件不存在（首次运行）');
  } else {
    // 损坏保护：结构坏了就**拒绝覆盖**，把原因写进日志等人工处理，绝不当成空数据清空重写
    logger.line(`✗ 既有 要闻.json 读不出来（${read.reason}），按损坏保护拒绝写入，请人工检查 ${read.file ?? dataDir}`);
    await logger.flush();
    return 3;
  }

  // ---- 二、逐源抓列表 ----
  const collected = [];
  const sourceStats = [];
  const limits = { perSource: options.detailPerSource, remaining: options.detailTotal };
  // 保留窗口的起点（含今天往前数 days 天）；比它更旧的条目抓了详情也会被裁掉
  const now = new Date();
  const monthsAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (NEWS_RETENTION.days - 1));
  const minDay = `${monthsAgo.getFullYear()}-${String(monthsAgo.getMonth() + 1).padStart(2, '0')}-${String(monthsAgo.getDate()).padStart(2, '0')}`;
  logger.line(`保留窗口起点 ${minDay}（更旧的条目不再花请求抓详情）`);
  for (const source of SOURCES) {
    const rows = await fetchSourceList(source, logger);
    if (rows.length === 0) {
      sourceStats.push({ id: source.id, name: source.name, rows: 0, added: 0, error: '列表为空或抓取失败' });
      logger.line(`✗ ${source.name}：0 条`);
      continue;
    }
    await enrichWithDetail(rows, source, limits, minDay, logger);
    let added = 0;
    let dropped = 0;
    for (const row of rows) {
      const item = normalizeNewsItem({
        title: row.title,
        url: row.url,
        source: source.source,
        publishedAt: row.publishedAt,
        excerpt: row.excerpt,
        category: source.category,
      });
      if (item === null) {
        dropped += 1;
        continue;
      }
      collected.push(item);
      added += 1;
    }
    sourceStats.push({ id: source.id, name: source.name, rows: rows.length, added, dropped, error: null });
    logger.line(`✓ ${source.name}：解析 ${rows.length} 条 → 归一到 ${added} 条（丢弃 ${dropped} 条：缺日期/缺标题/链接不合格）`);
  }

  // ---- 二·五、AI 内容审核（B2）----
  // 插在「逐源收集之后、合并之前」：被判 drop 的**不进 collected**，所以根本不会入库
  // （不是先入库再删，面板与 备份/ 都不会见到它们）。判定看内容，不看来源。
  const reviewCaller = options.review === true ? await createReviewCaller() : null;
  if (options.review === true && reviewCaller === null) {
    logger.line('✗ 审核通道不可用（读不到 ~/.dsh/.credentials.yaml 的 refs.PARATERA_API_KEY 或文件缺失）：本批按保守策略全部保留');
  }
  const review = await reviewItems(collected, {
    enabled: options.review === true,
    callModel: reviewCaller ?? undefined,
    cachePath: options.reviewCachePath,
    logger,
    writeCache: options.dryRun !== true,
  });
  logger.line(`审核：${review.enabled ? '开' : '关'}${options.review === true ? '' : '（--no-review）'} · 缓存命中 ${review.cached} 条 · 保留 ${review.kept.length} 条 · 剔除 ${review.dropped.length} 条 · 未判回退保留 ${review.failed.length} 条`);
  if (review.error !== undefined) {
    logger.line(`✗ 审核降级（${review.error}）：本批全部保留，要闻不会被清空 —— 请查凭据 / 网络 / 模型服务`);
  }
  for (const item of review.dropped.slice(0, 10)) {
    logger.line(`  · drop [${item.source}] ${item.title}${review.why[item.id] === undefined ? '' : `｜${review.why[item.id]}`}`);
  }
  if (review.dropped.length > 10) logger.line(`  · ……另有 ${review.dropped.length - 10} 条被剔除（判定理由见 RESULT.review）`);
  // 诊断用：本次抓到的日期范围，配合下面的「合并」一行就能看出「抓到了但被窗口裁掉」的情况
  const collectedDates = review.kept.map((item) => String(item.publishedAt ?? '')).sort();
  if (collectedDates.length > 0) {
    logger.line(`本次抓到条目日期 ${collectedDates[0]} ~ ${collectedDates[collectedDates.length - 1]}（窗口 ${minDay} ~ 今天）`);
  }

  // ---- 三、合并 + 按保留策略裁剪 ----
  const merged = limitNews(mergeNews(existing, review.kept), {
    days: NEWS_RETENTION.days,
    max: NEWS_RETENTION.max,
  });
  const fresh = review.kept.length;
  const byCategory = {};
  for (const item of merged) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  logger.line(`合并：本次抓到 ${fresh} 条 + 既有 ${existing.length} 条 → 保留后 ${merged.length} 条（窗口 ${NEWS_RETENTION.days} 天 / 上限 ${NEWS_RETENTION.max} 条）`);
  logger.line(`分类分布：${Object.entries(byCategory).map(([key, value]) => `${NEWS_CATEGORY_LABEL[key] ?? key} ${value}`).join(' · ') || '空'}`);
  for (const item of merged.slice(0, 5)) {
    logger.line(`  · ${item.publishedAt} [${item.source}] ${item.title}${item.excerpt === '' ? '' : `｜${item.excerpt.slice(0, 40)}…`}`);
  }

  const payload = {
    version: 1,
    items: merged,
    fetchedAt: new Date().toISOString(),
    updatedAt: null,
  };

  // ---- 四、写盘（或 dry-run 只报数）----
  let written = 0;
  if (options.dryRun === true) {
    logger.line(`[dry-run] 将写入 ${merged.length} 条，实际写入 0 条（未改动 要闻.json）`);
  } else {
    const result = await store.writeDocument('news', payload, { expectedHash, backupKeep: 10 });
    if (result.ok !== true) {
      logger.line(`✗ 写入失败：${result.reason}${result.currentHash === undefined ? '' : `（磁盘 hash ${String(result.currentHash).slice(0, 12)}… 与读取时不一致，可能有人同时在改）`}`);
      await logger.flush();
      return 4;
    }
    written = merged.length;
    logger.line(`✓ 已写入 ${DOC_FILES.news}：${written} 条，新 hash ${String(result.hash).slice(0, 12)}…${existing === null ? '（首次写入，没有旧版可备份）' : '（上一版已进 备份/）'}`);
  }

  // 机器可读的一行摘要（计划任务日志里一眼能看到结果）
  const summary = {
    ok: true,
    dryRun: options.dryRun,
    sources: sourceStats,
    collected: fresh,
    kept: merged.length,
    written,
    fetchedAt: payload.fetchedAt,
    excerptMax: NEWS_EXCERPT_MAX,
    // B2：本次内容审核的结果（enabled=false 表示审核没跑成 / 被 --no-review 关掉，整批按原样保留）
    review: {
      enabled: review.enabled,
      kept: review.kept.length,
      dropped: review.dropped.length,
      failed: review.failed.length,
      cached: review.cached,
    },
  };
  logger.line(`RESULT ${JSON.stringify(summary)}`);
  await logger.flush();

  // 全部源都挂才视为失败（部分源挂是常态：校园站偶发抖动）
  const allFailed = sourceStats.every((stat) => stat.added === 0);
  if (allFailed) {
    console.error('[fetch-news] 所有源都没抓到条目，请查日志：' + options.logFile);
    return 1;
  }
  return 0;
}

// 只有「被直接执行」才跑主流程；被测试 `import` 时只拿纯函数，不发任何请求、不读任何文件。
const invokedDirectly = typeof process.argv[1] === 'string' && process.argv[1] !== ''
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(`[fetch-news] 未捕获异常：${String(error?.stack ?? error)}`);
      process.exitCode = 5;
    });
}

export { SOURCES, REVIEW_SYSTEM_PROMPT, defaultReviewCachePath, reviewCacheKey };
