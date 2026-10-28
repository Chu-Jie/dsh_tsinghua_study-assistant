/**
 * 清华大学网络学堂（learn.tsinghua.edu.cn）对接 —— 零依赖、纯 Node。
 *
 * ## 这个模块只做一件事
 *
 * 把「学生端作业列表」读出来，转成本地 `任务.json` 能用的形状。
 * 不写任何远端数据，不发任何写请求。
 *
 * ## 接口来源（读平台自己的实现，不是猜的）
 *
 * ### 课程列表：两段式，不能靠解析首页 HTML
 *
 * 学生端首页的课程列表是**前端 JS 模板**（`{{value.kcid}}`），静态 HTML 里
 * 一个真实课堂号都没有 —— 曾经用正则扫首页，真机上恒为 0 门课。真正的接口是在
 * `/res/js/wlxt/kc/kc/student/courseList.js` 的调用点里读出来的：
 *
 *   GET  /b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq
 *        → ["2026-2027-1","2025-2026-3", …]   本人当期与历史学期
 *   GET  /b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/<学期>/<语言>?timestamp=<ms>
 *        → { message:"success", resultList:[{ wlkcid, kcm, xnxq, jsh, xf, … }] }
 *
 * `wlkcid` 就是作业接口要的课堂号，`kcm` 是课程名，`xf` 是学分。
 *
 * ### 作业列表：**POST** + `aoData` + `_csrf`
 *
 * 三个作业接口的名字来自学生端作业页的内联 JS，但**请求形状**必须看
 * `dataTablePlugin.js` 的 `fnServerData`：
 *
 *   $.ajax({ type:'POST', url:sSource, dataType:'json',
 *            data:{ aoData: JSON.stringify(aoData) },
 *            success:function(data){ if (data.result=='success') fnCallback(data.object) } })
 *
 * 而 `sSource` 在发出前被 `handleUrlWithCsrf()` 追加了 `_csrf`：
 *   var csrf_token = getCookie("XSRF-TOKEN");
 *   url += (url.indexOf('?')===-1 ? '?' : '&') + "_csrf=" + encodeURIComponent(csrf_token);
 *
 * 所以正确的调用是（三条缺一不可，只发 GET `?wlkcid=…` 会得到 **HTTP 400**）：
 *
 *   POST /b/wlxt/kczy/zy/student/zyListWj?_csrf=<XSRF-TOKEN>
 *        Content-Type: application/x-www-form-urlencoded
 *        body: aoData=[{"name":"wlkcid","value":"2026-2027-1152225553"}, …]
 *
 * `wlkcid` **必须放在 `aoData` 里**：空 `aoData` 也能返回 200，但那是不分学期的
 * 全部作业（实测 26 条跨学期记录），会静默给用户导入一堆陈年作业。
 *
 * 响应信封是 `{ result:'success', msg:null, object:{ iTotalRecords, aaData:[…] } }`，
 * **行在 `object.aaData`**。
 *
 * ## 认证：Cookie 是必须的，XSRF 头也要带
 *
 * 真机实测（不是推理）：`/f/**` 只要 Cookie；**`/b/**` 缺 `X-XSRF-TOKEN` 会被 403** ——
 * `queryxnxq` 与 `loadCourseBySemesterId` 都只有补上头之后才成功。
 * 这解释了归档里「页面用标准 `$.ajax` 不带自定义头」与「未登录探测 403」的矛盾：
 * 未登录缺的是会话，已登录缺的是 CSRF 头。
 *
 * 所以 `learnGet` / `learnPost` 都采用「先只用 Cookie，403 且有 XSRF cookie 时
 * 补上头重试一次」的自动升级 —— 万一平台哪天放宽校验，只凭 Cookie 也仍然能用。
 *
 * 用户侧结论：**必须把 `JSESSIONID` 和 `XSRF-TOKEN` 一起复制**。
 *
 * ## 为什么坚持「不靠猜」
 *
 * 响应体到底把行数组放在哪一层，页面代码没告诉我们（只给了 URL）。
 * 所以 `pickRows()` 按优先级试一串已知键，再退化为**递归找第一个「像作业」的对象数组**。
 * 多认一种形状不会出错，少认一种就会整体失败 —— 这里刻意宽容。
 */

/** 网络学堂站点地址。 */
export const LEARN_BASE = 'https://learn.tsinghua.edu.cn';

/**
 * 三个作业列表接口。顺序有意义：未提交的优先级最高。
 *
 * `open` 是**这份作业还要不要做**的判据，也是平台自己给出的提交状态：
 * 出现在「已提交未批改 / 已批改」里的行，就是已经交过了。
 * 它必须一路传到 `toTaskItem` —— 否则导入会把所有历史作业都塞成待办，
 * 用户看到一堆早就交了的作业挂在「未完成」里（这正是第一版的行为）。
 */
export const LEARN_LISTS = [
  { key: 'wj', path: 'zyListWj', label: '未提交', open: true },
  { key: 'yjwg', path: 'zyListYjwg', label: '已提交未批改', open: false },
  { key: 'ypg', path: 'zyListYpg', label: '已批改', open: false },
];

/** 请求超时（毫秒）。网络学堂偶尔很慢，但不能无限等。 */
export const LEARN_TIMEOUT_MS = 15000;

/** 取「本人有哪些学期」的接口；返回形如 `[null,"2026-2027-1", …]`。 */
export const LEARN_SEMESTERS_PATH = '/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq';

/**
 * 取某学期课程列表的路径。
 *
 * 末尾的 `?timestamp=<毫秒>` 是平台自己会带的（防缓存），这里照抄，
 * 因为不确定服务端是否对缺省值敏感。
 */
export function learnCourseListPath(semesterId, locale = 'zh_CN') {
  return `/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/${encodeURIComponent(semesterId)}/${encodeURIComponent(locale)}?timestamp=${Date.now()}`;
}

/** 常见 HTML 实体反解 —— 课程名里会出现 `&amp;`、`&#39;` 这类。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 行对象里至少要有其中一个键，才算「像作业」。 */
const HOMEWORK_HINT = ['xszyid', 'zyid', 'bt', 'jzsj', 'jzsjStr'];

/** 已知的行数组容器键，按可信度排序。 */
const ROW_KEYS = ['aaData', 'resultList', 'data', 'rows', 'object', 'list', 'items'];

/** 类作业类型关键词 —— 只有命中才把 kind 判成 exam/paper/report，否则 homework。 */
const KIND_HINTS = [
  { kind: 'exam', words: ['考试', '测验', '小测', '期中', '期末', '随堂'] },
  { kind: 'paper', words: ['论文', '文献', '综述'] },
  { kind: 'report', words: ['报告', '大作业', '项目', '课程设计'] },
  { kind: 'lab', words: ['实验', '上机', '实践'] },
];

// ─────────────────────────────── 纯函数：解析 ───────────────────────────────

/** 从 Cookie 字符串里取某个 cookie 的值；取不到返回 ''。 */
export function cookieValue(cookie, name) {
  if (typeof cookie !== 'string' || cookie === '') return '';
  const parts = cookie.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/** 请求头：先只用 Cookie；`withXsrf` 为真时补 `X-XSRF-TOKEN`（值取 Cookie 里的 XSRF-TOKEN）。 */
export function learnHeaders(cookie, withXsrf = false) {
  const headers = {
    Cookie: String(cookie ?? ''),
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': USER_AGENT,
  };
  if (withXsrf) {
    const token = cookieValue(cookie, 'XSRF-TOKEN');
    if (token !== '') headers['X-XSRF-TOKEN'] = token;
  }
  return headers;
}

/**
 * 复刻平台自己的 `handleUrlWithCsrf(url)`：把 `_csrf=<XSRF-TOKEN>` 追加到查询串。
 *
 * 平台的实现在 `/res/app/wlxt/js/jquery.js`：
 *   url += (url.indexOf('?')===-1 ? '?' : '&') + "_csrf=" + encodeURIComponent(csrf_token)
 * 并且它挂在 `$(document).ajaxSend` 上，所以**每个** get/post 都会带上。
 *
 * Cookie 里没有 `XSRF-TOKEN` 时原样返回（不硬塞空值）——那种情况下请求多半
 * 会在别处失败，加一个空的 `_csrf=` 只会让服务端报出更难懂的错误。
 */
export function withCsrfQuery(pathname, cookie) {
  const path = String(pathname ?? '');
  // 空路径原样返回：给一个不存在的路径追加查询串没有意义，只会掩盖调用方的错误
  if (path === '') return '';
  const token = cookieValue(cookie, 'XSRF-TOKEN');
  if (token === '' || path.includes('_csrf=')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}_csrf=${encodeURIComponent(token)}`;
}

/**
 * 构造 DataTables 服务端分页的 `aoData`。
 *
 * 真机实测：服务端**只认 `aoData` 里的字段**，查询串上的同名参数会被忽略；
 * 而除了自定义条件（`{name:'wlkcid', …}`）之外，分页骨架字段其实不是必需的。
 * 这里仍然带上完整骨架，因为它是浏览器里真实发出的形状 —— 少猜一点，
 * 就少一次「某天服务端加了校验、我们突然全空」的事故。
 *
 * @param {Array<{name:string,value:any}>} [entries] 额外条件，通常含 `wlkcid`
 * @param {number} [limit] 一次取多少行；作业列表通常几十条，默认给足
 */
export function aoDataOf(entries = [], limit = 200) {
  const base = [
    { name: 'sEcho', value: 1 },
    { name: 'iColumns', value: 1 },
    { name: 'sColumns', value: '' },
    { name: 'iDisplayStart', value: 0 },
    { name: 'iDisplayLength', value: limit },
    { name: 'mDataProp_0', value: 'bt' },
    { name: 'sSearch', value: '' },
    { name: 'bRegex', value: false },
    { name: 'sSearch_0', value: '' },
    { name: 'bRegex_0', value: false },
    { name: 'bSearchable_0', value: true },
    { name: 'bSortable_0', value: true },
    { name: 'iSortCol_0', value: 0 },
    { name: 'sSortDir_0', value: 'asc' },
    { name: 'iSortingCols', value: 0 },
  ];
  for (const entry of asArray(entries)) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.name !== 'string' || entry.name === '') continue;
    base.push({ name: entry.name, value: entry.value });
  }
  return base;
}

/**
 * 从 `queryxnxq` 的响应里取出学期串。
 *
 * 真实响应是 `[null,"2026-2027-1","2025-2026-3", …]` —— 注意**首个元素是 null**，
 * 不是对象数组。也接受 `{resultList:[…]}` 这类包装，免得平台一改版就整批失败。
 */
export function pickSemesters(payload) {
  const list = Array.isArray(payload) ? payload : pickRows(payload) ?? [];
  const out = [];
  for (const item of asArray(list)) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (/^\d{4}-\d{4}-\d$/.test(text) && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 归一化全角/半角括号与常见全角标点。
 *
 * 真机实测的差异：本地写「英语阅读写作(A)」，学堂写「英语阅读写作（A）」。
 * 这纯粹是 **输入法** 造成的差异，不该让用户去加别名 —— 归一化就能消化掉。
 */
export function normalizeWideChars(text) {
  return String(text ?? '')
    // 全角括号 → 半角
    .replace(/[\uFF08]/g, '(')
    .replace(/[\uFF09]/g, ')')
    // 全角冒号/逗号/顿号 → 半角
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0C\u3001]/g, ',')
    // 全角空格、不间断空格 → 普通空格
    .replace(/[\u3000\u00A0]/g, ' ');
}

/**
 * 把 `loadCourseBySemesterId` 的响应解析成课程数组。
 *
 * 元素里 `wlkcid` 是课堂号、`kcm` 是课程名、`xnxq` 是学期、`jsh` 是教师号、
 * `xf` 是学分（实测该字段为 null，所以不能拿它当学分的可靠来源）。
 */
export function pickLearnCourses(payload) {
  const list = Array.isArray(payload) ? payload : pickRows(payload) ?? [];
  const out = [];
  const seen = new Set();
  for (const item of asArray(list)) {
    if (item === null || typeof item !== 'object') continue;
    const wlkcid = item.wlkcid === undefined || item.wlkcid === null ? '' : String(item.wlkcid);
    if (wlkcid === '' || seen.has(wlkcid)) continue;
    seen.add(wlkcid);
    const rawName = item.kcm === undefined || item.kcm === null ? '' : String(item.kcm).trim();
    out.push({
      wlkcid,
      name: decodeEntities(rawName),
      semester: item.xnxq === undefined || item.xnxq === null ? null : String(item.xnxq),
      teacherNo: item.jsh === undefined || item.jsh === null ? null : String(item.jsh),
      credits: typeof item.xf === 'number' ? item.xf : null,
    });
  }
  return out;
}

/** 把可能是字符串/数字的值统一成数组。 */
export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** 对象是否是「像作业的一行」。 */
export function looksLikeHomeworkRow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return HOMEWORK_HINT.some((key) => key in value);
}

/**
 * 从任意响应体里找出「作业行数组」。
 *
 * 先按已知容器键取（含 `result.list` 这种两层结构），再退化到递归搜索。
 * 找不到时返回 null，由调用方决定怎么报告 —— 这里不抛异常，
 * 因为「形状不认识」是可诊断信息，不是程序错误。
 */
export function pickRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return null;

  for (const key of ROW_KEYS) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
    // { result: { list: [...] } } 这类两层包装
    if (candidate !== null && typeof candidate === 'object') {
      for (const inner of ROW_KEYS) {
        if (Array.isArray(candidate[inner])) return candidate[inner];
      }
    }
  }

  // 退化：深度优先找第一个「元素像作业」的数组
  const stack = [payload];
  let guard = 0;
  while (stack.length > 0 && guard < 200) {
    guard += 1;
    const node = stack.shift();
    if (node === null || typeof node !== 'object') continue;
    for (const value of Object.values(node)) {
      if (Array.isArray(value) && value.length > 0 && looksLikeHomeworkRow(value[0])) return value;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) stack.push(value);
    }
  }
  return null;
}

/** 尽力把值解析成毫秒时间戳；解析不出来返回 null。 */
export function toMillis(value) {
  // 必须 **> 0**：0 在学堂里是「没有截止时间」的常见占位值，
  // 真把它当时间戳就会算成 1970-01-01，于是任务列表里冒出一个假 DDL。
  // 宁可返回 null 走「无截止时间」分支。
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

/** 毫秒时间戳 → `YYYY-MM-DD`（按 +08:00 算）。 */
export function millisToDay(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:MM`（按 +08:00 算）。 */
export function millisToMinute(ms) {
  const day = millisToDay(ms);
  if (day === null) return null;
  const d = new Date(ms + 8 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/**
 * 把网络学堂的日期字段归一成 `YYYY-MM-DD HH:MM`（或至少 `YYYY-MM-DD`）。
 *
 * 优先用**毫秒时间戳**（`jzsj` / `bjjzsj`），因为它没有歧义；
 * 只有在没有数值时才回落去解析 `jzsjStr` 这类字符串。
 *
 * ⚠️ 注意 `jzsj` 与 `bjjzsj` 是**两个不同口径**：正常截止与补交截止。
 * 页面判「还能不能交」用的是**两个都没过**。这里默认取正常截止，
 * 补交只作为附加信息，避免把补交期误当主截止、导致提醒过晚。
 */
export function normalizeDue(row) {
  if (row === null || typeof row !== 'object') return { value: null, source: null, grace: null };

  const main = toMillis(row.jzsj);
  if (main !== null) {
    return {
      value: millisToMinute(main) ?? millisToDay(main),
      source: 'jzsj',
      grace: toMillis(row.bjjzsj) === null ? null : millisToMinute(toMillis(row.bjjzsj)),
    };
  }

  // 没有数值时间戳时，退回字符串字段（格式通常是 "2026-10-15 23:59"）
  for (const key of ['jzsjStr', 'jzsjstr', 'jzrq']) {
    const raw = row[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      const text = raw.trim().replace(/\//g, '-');
      const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(text);
      if (iso !== null) {
        const dayPart = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
        const value = iso[4] === undefined ? dayPart : `${dayPart} ${iso[4].padStart(2, '0')}:${iso[5]}`;
        return { value, source: key, grace: null };
      }
    }
  }

  return { value: null, source: null, grace: null };
}

/** 根据标题里的关键词猜本地任务类型；猜不出就 `homework`。 */
export function guessKind(title) {
  const text = String(title ?? '');
  for (const hint of KIND_HINTS) {
    if (hint.words.some((word) => text.includes(word))) return hint.kind;
  }
  return 'homework';
}

/**
 * 把一行网络学堂数据转成「候选本地任务」。
 *
 * `courseId` 由调用方（`buildCandidates`）从课程映射里查出来，这里不管映射。
 */
export function mapRowToList(row, courseId = null) {
  if (!looksLikeHomeworkRow(row)) return null;
  const due = normalizeDue(row);
  const title = typeof row.bt === 'string' && row.bt.trim() !== '' ? row.bt.trim() : '(未命名作业)';
  return {
    key: rowKey(row),
    title,
    courseId: courseId === null || courseId === undefined ? null : String(courseId),
    kind: guessKind(title),
    due: due.value,
    dueSource: due.source,
    grace: due.grace,
    raw: {
      zyid: row.zyid ?? null,
      xszyid: row.xszyid ?? null,
      wlkcid: row.wlkcid ?? null,
      mxdxmc: row.mxdxmc ?? null,
    },
  };
}

/**
 * 去重键。
 *
 * 页面自己的主键是 `xszyid`（`getId` 返回它），所以优先用它；
 * 万一某条缺 `xszyid`，退化成 `wlkcid:zyid`；再不行用标题+截止。
 * 关键是**稳定**：同一个远端作业每次同步必须算出同一个键。
 */
export function rowKey(row) {
  if (row === null || typeof row !== 'object') return null;
  const xszyid = row.xszyid;
  if (xszyid !== undefined && xszyid !== null && String(xszyid) !== '') return `xszyid:${xszyid}`;
  if (row.zyid !== undefined && row.zyid !== null && String(row.zyid) !== '') {
    return `zy:${row.wlkcid ?? ''}:${row.zyid}`;
  }
  const due = normalizeDue(row).value;
  return `title:${String(row.bt ?? '')}#${due ?? ''}`;
}

// ─────────────────────────────── 课程映射 ───────────────────────────────

/**
 * 把网络学堂的课程名映射到本地 `课程.json` 的课程 id。
 *
 * 匹配顺序（**精确优先**，这一点很关键）：
 *   1. 本地课程名与学堂名**完全相同**
 *   2. 去掉括号内容后完全相同（学堂名常带 `(10430494-3)` 这类课程号）
 *   3. 任一方的别名命中
 *   4. 唯一前缀匹配 —— 命中多门就**报错而不是猜**
 *
 * 第 4 条返回 `ambiguous` 是刻意的：猜错了会把作业挂到别的课上，
 * 而挂错课比暂时不挂更难发现。用户宁可看到「请手选」。
 *
 * @param {string} learnName 学堂里的课程名
 * @param {Array} courses 本地课程数组（`{id,name,aliases?}`）
 * @param {object} [manual] 手动映射 `{ [学堂名]: 本地课程id }`
 */
export function matchCourse(learnName, courses, manual = {}) {
  const name = stripCourseCode(learnName);
  if (name === '') return { courseId: null, how: 'empty' };

  // 0. 手动映射优先于一切自动判断
  if (manual !== null && typeof manual === 'object') {
    for (const [pattern, id] of Object.entries(manual)) {
      const key = stripCourseCode(pattern);
      if (key !== '' && (key === name || name.includes(key))) return { courseId: id, how: 'manual' };
    }
  }

  const list = Array.isArray(courses) ? courses.filter((c) => c !== null && typeof c === 'object') : [];
  if (list.length === 0) return { courseId: null, how: 'no-courses' };

  // 1. 归一化后完全相同
  const exact = list.filter((c) => stripCourseCode(c.name) === name);
  if (exact.length === 1) return { courseId: exact[0].id, how: 'exact' };

  // 2. 别名命中
  for (const course of list) {
    for (const alias of asArray(course.aliases)) {
      if (typeof alias !== 'string') continue;
      const key = stripCourseCode(alias);
      if (key !== '' && key === name) return { courseId: course.id, how: 'alias' };
    }
  }

  // 3. 唯一前缀 —— 只在恰好命中一门时接受
  const prefixed = list.filter((c) => {
    const local = stripCourseCode(c.name);
    if (local === '') return false;
    return local.startsWith(name) || name.startsWith(local);
  });
  if (prefixed.length === 1) return { courseId: prefixed[0].id, how: 'prefix' };
  if (prefixed.length > 1) {
    return {
      courseId: null,
      how: 'ambiguous',
      candidates: prefixed.map((c) => ({ id: c.id, name: c.name })),
    };
  }

  return { courseId: null, how: 'unmatched' };
}

/** 匹配「末尾括号」并捕获括号内容。 */
const TRAILING_BRACKET = /[（(]([A-Za-z0-9\-_.]*\d[A-Za-z0-9\-_.]*)[)）]\s*$/;

/**
 * 括号内容是否**像课程号**。
 *
 * 学堂里的课程名常写成「大学物理B(2)（10430494-3）」＝「课程名 + 课程号」。
 * 课程号的特征是**含连字符**或**有 4 位以上连续数字**；
 * 而「大学物理B(2)」里的 `(2)` 属于课程名本身（是第 2 学期/第 2 部分），必须保留。
 * 不区分这两者的话，`(2)` 会被当成课程号剥掉，于是「大学物理B(2)」和
 * 「大学物理B(1)」会塌缩成同一个名字 —— 匹配结果从「精确」悄悄降级成「前缀」，
 * 多门课时还会变成 ambiguous，用户看到的现象是「明明有这门课却说没匹配上」。
 */
function looksLikeCourseCode(inner) {
  return inner.includes('-') || /\d{4,}/.test(inner);
}

/**
 * 去掉课程名末尾的课程号括号：`大学物理B(2)（10430494-3）` → `大学物理B(2)`。
 *
 * **循环剥**，因为可能叠了多层（`课程名（A）(B)`）；但要**只剥课程号**，
 * 所以每层都要求括号内容像课程号（见 `looksLikeCourseCode`），
 * 否则立刻停手，把剩下的括号留在名字里。最多剥 5 层，防病态输入死循环。
 */
export function stripCourseCode(name) {
  // 先归一化全角括号：本地可能写「英语阅读写作(A)」而学堂写「英语阅读写作（A）」。
  // 这纯粹是输入法差异，不该让用户去加别名，所以在这里就消化掉。
  let text = normalizeWideChars(name);
  for (let guard = 0; guard < 5; guard += 1) {
    const m = TRAILING_BRACKET.exec(text);
    if (m === null || !looksLikeCourseCode(m[1])) break;
    text = text.slice(0, m.index);
  }
  // 全角/半角空白与换行都拿掉，避免「大学物理 B (2)」与「大学物理B(2)」看起来不同
  return text.replace(/\s+/g, '').trim();
}

// ─────────────────────────────── 组装与比对 ───────────────────────────────

/**
 * 从已落盘的 cookie 里读出一串课堂号。
 *
 * 首页里课堂号出现在形如 `course?wlkcid=2026-2027-1152225553` 的链接上。
 */
export function pickCourseIds(html) {
  const text = String(html ?? '');
  const ids = [];
  const seen = new Set();
  for (const m of text.matchAll(/wlkcid=([0-9]{4}-[0-9]{4}-[0-9]+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

/**
 * 从学生端首页 HTML 里读出「课堂号 → 课程名」。
 *
 * 页面里同一个课堂号会出现多次（下拉切换列表、侧栏导航等），
 * 后面的覆盖前面的 —— 实测带课程名的那个较完整的链接出现在更后面。
 *
 * ⚠️ 模板字符串（`{{value.kcid}}`）也会被这个正则扫到，所以显式排除掉。
 */
export function pickCourseNames(html) {
  const text = String(html ?? '');
  const map = {};
  const pattern = /course\?wlkcid=([0-9]{4}-[0-9]{4}-[0-9]+)[^>]*>([^<]{1,120})</g;
  for (const m of text.matchAll(pattern)) {
    const id = m[1];
    const name = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (name === '' || id.includes('{{') || /^\{\{/.test(name)) continue;
    map[id] = name;
  }
  return map;
}

/**
 * 学生端首页里出现的**全部** `/b/wlxt/**` 学生接口。
 *
 * 目前用来做「接口普查」：万一某个模块的列表接口不是我们已知的那三个，
 * 也能从这里发现，而不是干等到同步结果为空。
 */
export function pickStudentEndpoints(html) {
  const text = String(html ?? '');
  const found = new Set();
  for (const m of text.matchAll(/\/b\/wlxt\/[A-Za-z0-9_\-/]*\/student\/[A-Za-z0-9_]+/g)) found.add(m[0]);
  return [...found];
}

/**
 * 把三张列表的结果合成候选任务。
 *
 * `fetched` 的形状：`[{ wlkcid, name, listKey, open, rows }, …]`
 * 返回 `{ candidates, ambiguous }` —— `ambiguous` 是需要用户手选的课程。
 */
export function buildCandidates(fetched, courses, options = {}) {
  const manual = options.manual ?? {};
  const now = options.now instanceof Date ? options.now : new Date();
  const seen = new Set();
  const candidates = [];
  const ambiguous = [];

  for (const entry of asArray(fetched)) {
    if (entry === null || typeof entry !== 'object') continue;
    const match = matchCourse(entry.name ?? '', courses, manual);
    if (match.how === 'ambiguous' || match.how === 'unmatched') {
      ambiguous.push({
        learnName: entry.name ?? '',
        wlkcid: entry.wlkcid ?? null,
        how: match.how,
        candidates: match.candidates ?? [],
      });
    }
    for (const row of asArray(entry.rows)) {
      const item = mapRowToList(row, match.courseId);
      if (item === null) continue;
      if (item.key === null || seen.has(item.key)) continue;
      seen.add(item.key);
      item.wlkcid = entry.wlkcid ?? null;
      item.learnName = entry.name ?? '';
      item.listKey = entry.listKey ?? null;
      // `open` 一路传到 `toTaskItem`：false 表示平台已经收到这份作业了。
      item.open = entry.open !== false;
      // 已过期的作业不给默认勾选 —— 用户此刻并不需要去补交
      const dueMs = toMillis(row.jzsj);
      item.expired = dueMs !== null && dueMs <= now.getTime();
      item.source = 'learn';
      candidates.push(item);
    }
  }

  return { candidates, ambiguous };
}

/**
 * 拿本地任务去重：返回 `{ created, skipped, changed }`。
 *
 * 去重靠**远端 id 记号**，存在本地任务的 `note` 里（形如 `[learn:xszyid:123]`）。
 * 不新增文档字段，因为 `任务.json` 的形状已被测试锁住；
 * 而且 `note` 本来就是自由文本，用户看得懂、也能自己删掉解绑。
 */
export function diffCandidates(existingTasks, candidates) {
  const marks = new Set();
  for (const task of asArray(existingTasks)) {
    const mark = learnMarkOf(task);
    if (mark !== null) marks.add(mark);
  }

  const created = [];
  const skipped = [];
  for (const item of asArray(candidates)) {
    if (item === null || typeof item !== 'object') continue;
    if (item.key !== null && marks.has(item.key)) skipped.push(item);
    else created.push(item);
  }
  return { created, skipped };
}

/** 从本地任务的 `note` 里取出网络学堂记号；没有则 null。 */
export function learnMarkOf(task) {
  if (task === null || typeof task !== 'object') return null;
  const text = typeof task.note === 'string' ? task.note : '';
  const m = /\[learn:([^\]]+)\]/.exec(text);
  return m === null ? null : m[1];
}

/**
 * 把候选转成可以直接交 `/mutate` 的 `任务.json` 条目。
 *
 * 关键点：
 *   - 本地 id 在这里生成（`makeId('t')` 由调用方注入，避免本模块依赖 core.js 的具体实现）；
 *   - 远端记号写进 `note`，作为下次同步的去重依据；
 *   - `due` 为 null 时**不写 due 字段**，让本地任务显示「无截止时间」而不是一个假日期；
 *   - 状态照抄平台的提交状态：`item.open === false`（来自「已提交未批改 / 已批改」两张
 *     列表）就是已交，直接落 `done`。写死 `todo` 会让用户看到一堆早就交了的作业挂在
 *     未完成里，而同步是按 `note` 里的远端记号去重的 —— 这样的错误条目下次同步会被
 *     跳过，**永远不会自我修正**，只能靠用户手点。
 */
export function toTaskItem(item, makeId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const mark = item.key === null ? '' : `[learn:${item.key}]`;
  const extra = typeof options.noteExtra === 'string' ? options.noteExtra : '';
  const note = `${mark}${extra}`.trim();
  const submitted = item.open === false;
  const task = {
    id: makeId('t'),
    title: String(item.title ?? '(未命名作业)').slice(0, 120),
    courseId: item.courseId === null || item.courseId === undefined ? null : String(item.courseId),
    kind: item.kind ?? 'homework',
    due: item.due ?? null,
    status: submitted ? 'done' : 'todo',
    priority: options.priority ?? 'normal',
    estimateHours: null,
    progress: submitted ? 100 : 0,
    createdAt: now.toISOString(),
    // 刻意留 null：我们只知道「同步这一刻它已经交了」，真正的提交时刻在平台那边。
    // `normalizeTask` 会把 done 落成「导入时刻」—— 比编一个假日期诚实。
    doneAt: null,
    note: note.slice(0, 300),
  };
  return task;
}

// ─────────────────────────────── 网络请求 ───────────────────────────────

/**
 * 带超时的 fetch。
 *
 * 用 `AbortController` 而不是自造 Promise 竞速：竞速会让超时后的响应变成
 * 未处理的拒绝，而 abort 能让底层 socket 真正释放。
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把响应体先按文本读出，再尝试 JSON 解析 —— 非 JSON 也要能诊断。 */
async function readResponse(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, location: res.headers.get('location') };
}

/**
 * 发一个网络学堂请求，认证方式按「先 Cookie，403 再补 XSRF」自动升级。
 *
 * 默认会自动追加 `_csrf` 查询参数（复刻平台的 `ajaxSend` 钩子）。
 * 返回 `{ status, text, json, location, authUsed }`。
 */
async function learnRequest(pathname, cookie, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LEARN_TIMEOUT_MS;
  const base = options.base ?? LEARN_BASE;
  const method = options.method === 'POST' ? 'POST' : 'GET';
  const body = options.body;
  const path = options.csrf === false ? String(pathname ?? '') : withCsrfQuery(pathname, cookie);
  const url = base + path;

  const init = (withXsrf) => {
    const headers = learnHeaders(cookie, withXsrf);
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    return { method, headers, body, redirect: 'manual' };
  };

  let authUsed = 'cookie';
  let res = await fetchWithTimeout(url, init(false), timeoutMs);
  let out = await readResponse(res);

  // 403 且 Cookie 里有 XSRF-TOKEN → 补上头再来一次（只有一次机会，不循环）
  if (out.status === 403 && cookieValue(cookie, 'XSRF-TOKEN') !== '') {
    authUsed = 'cookie+xsrf';
    res = await fetchWithTimeout(url, init(true), timeoutMs);
    out = await readResponse(res);
  }

  return { ...out, authUsed };
}

/** GET；返回 `{ status, text, json, location, authUsed }`。 */
export async function learnGet(pathname, cookie, options = {}) {
  return learnRequest(pathname, cookie, { ...options, method: 'GET' });
}

/**
 * POST 表单；返回同 `learnGet`。
 *
 * 作业列表接口要求 `application/x-www-form-urlencoded` 的单个 `aoData` 参数
 * （见本文件头部「作业列表」一节）——发 JSON 体会得到 400。
 */
export async function learnPost(pathname, form, cookie, options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form ?? {})) params.append(key, String(value));
  return learnRequest(pathname, cookie, { ...options, method: 'POST', body: params.toString() });
}

/** 拉学生端首页 —— 用来验活 cookie，并顺带取出课堂号。 */
export async function fetchLearnIndex(cookie, options = {}) {
  const out = await learnGet('/f/wlxt/index/course/student/', cookie, options);
  const alive = out.status === 200 && /id="userid"/.test(out.text);
  return { ...out, alive, courseIds: alive ? pickCourseIds(out.text) : [] };
}

/**
 * 取某学期的课程列表（课堂号 + 课程名）。
 *
 * 这是**唯一可靠的课程来源**：首页 HTML 里的课程列表是 JS 模板，扫不出东西。
 * 返回 `{ semesters, semesterId, courses, error, authUsed }`，
 * **失败不抛异常**，把原因写进 `error`，让上层能给出可诊断的提示。
 */
export async function fetchLearnCourses(cookie, options = {}) {
  const out = { semesters: [], semesterId: null, courses: [], error: null, authUsed: 'cookie' };

  // 1. 先问「本人有哪些学期」
  try {
    const res = await learnGet(LEARN_SEMESTERS_PATH, cookie, options);
    out.authUsed = res.authUsed;
    if (res.status !== 200) {
      out.error = `semesters-http-${res.status}`;
      return out;
    }
    if (res.json === null) {
      out.error = 'semesters-not-json';
      return out;
    }
    out.semesters = pickSemesters(res.json);
  } catch (error) {
    out.error = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error);
    return out;
  }
  if (out.semesters.length === 0) {
    out.error = 'no-semester';
    return out;
  }

  // 2. 选学期：显式指定的优先，否则用第一个（服务端按由新到旧返回）
  const wanted = options.semesterId;
  const semesterId = typeof wanted === 'string' && out.semesters.includes(wanted) ? wanted : out.semesters[0];
  out.semesterId = semesterId;

  // 3. 再取该学期的课程
  try {
    const res = await learnGet(learnCourseListPath(semesterId, options.locale ?? 'zh_CN'), cookie, options);
    if (res.authUsed !== 'cookie') out.authUsed = res.authUsed;
    if (res.status !== 200) {
      out.error = `courses-http-${res.status}`;
      return out;
    }
    if (res.json === null) {
      out.error = 'courses-not-json';
      return out;
    }
    out.courses = pickLearnCourses(res.json);
    if (out.courses.length === 0) out.error = 'no-course';
  } catch (error) {
    out.error = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error);
  }
  return out;
}

/**
 * 按课堂号去拉三张作业列表。
 *
 * 失败不抛异常：某门课挂了只会在这门课的结果里留下 `error`，
 * 其余课程照常返回 —— 网络学堂经常个别接口抽风，不能因此丢掉整批数据。
 */
export async function fetchHomeworkForCourses(targets, cookie, options = {}) {
  const results = [];
  for (const target of asArray(targets)) {
    const wlkcid = typeof target === 'string' ? target : target?.wlkcid;
    const name = typeof target === 'string' ? '' : target?.name ?? '';
    if (typeof wlkcid !== 'string' || wlkcid === '') continue;
    for (const list of LEARN_LISTS) {
      const pathname = `/b/wlxt/kczy/zy/student/${list.path}`;
      const entry = { wlkcid, name, listKey: list.key, label: list.label, open: list.open !== false, rows: [], error: null, authUsed: 'cookie', total: 0 };
      try {
        // `wlkcid` 必须放进 aoData：空 aoData 也能 200，但那是**跨学期**的全部作业，
        // 会静默导入一堆陈年作业。
        const form = { aoData: JSON.stringify(aoDataOf([{ name: 'wlkcid', value: wlkcid }])) };
        const out = await learnPost(pathname, form, cookie, options);
        entry.authUsed = out.authUsed;

        if (out.status !== 200) {
          entry.error = `http-${out.status}`;
        } else if (out.json === null) {
          entry.error = 'not-json';
        } else {
          const env = out.json;
          const failed = typeof env.result === 'string' && env.result !== 'success';
          // 响应信封：{ result:'success', msg:null, object:{ iTotalRecords, aaData:[…] } }
          entry.rows = failed ? [] : pickRows(env.object ?? env) ?? [];
          entry.total = Number(env.object?.iTotalRecords ?? entry.rows.length) || entry.rows.length;
          entry.topKeys = Object.keys(env).slice(0, 20);
          if (failed) {
            entry.error = `api-${env.result}`;
            if (typeof env.msg === 'string') entry.message = env.msg;
          }
        }
      } catch (error) {
        entry.error = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error);
      }
      results.push(entry);
    }
  }
  return results;
}

// ─────────────────────── 作业详情页（学生端「查看」页） ───────────────────────

/**
 * 学生端「查看作业」页面的路径。
 *
 * 真机实测（2026-10-09，数据结构 HW2/HW3）：
 *   - `wlkcid` + `xszyid` → 200，62 KB 的完整详情页；
 *   - 再多给 `zyid` → 同样 200（页面一致）；
 *   - **只给 `zyid`、不给 `xszyid` → 500**。
 *
 * 也就是说这个页面的主键是 `xszyid`，而 `xszyid` 恰好就是我们存进任务 note 的
 * `[learn:xszyid:…]` 记号 —— 所以点开详情**不必**先去列表里把 `zyid` 找出来。
 */
export function learnHomeworkViewPath(wlkcid, xszyid) {
  return `/f/wlxt/kczy/zy/student/viewYxzy?wlkcid=${encodeURIComponent(wlkcid)}&xszyid=${encodeURIComponent(xszyid)}`;
}

/** 详情页绝对 URL —— 界面上「去网络学堂看原文」直接用它。 */
export function learnHomeworkViewUrl(wlkcid, xszyid) {
  return LEARN_BASE + learnHomeworkViewPath(wlkcid, xszyid);
}

/**
 * 解析本地任务 note 里的网络学堂记号。
 *
 * `rowKey` 会产出两种带远端主键的形状：`xszyid:<xszyid>` 与 `zy:<wlkcid>:<zyid>`；
 * 第三种 `title:<标题>#<截止>` 没有远端主键，解析不出来 —— 返回 null，
 * 让上层退回本地字段而不是拿标题去猜。
 */
export function parseLearnKey(key) {
  const text = String(key ?? '').trim();
  if (text.startsWith('xszyid:')) {
    const xszyid = text.slice('xszyid:'.length).trim();
    return xszyid === '' ? null : { xszyid, wlkcid: null, zyid: null };
  }
  if (text.startsWith('zy:')) {
    const rest = text.slice('zy:'.length);
    const at = rest.indexOf(':');
    if (at <= 0 || at === rest.length - 1) return null;
    return { xszyid: null, wlkcid: rest.slice(0, at), zyid: rest.slice(at + 1) };
  }
  return null;
}

/**
 * HTML → 纯文本。
 *
 * 平台的详情页是 div 拼的富文本，界面上只该显示文字：这里把块级标签换成换行、
 * 去掉行内标签，再反解实体。**刻意不返回 HTML** —— 客户端只会用 textContent 渲染，
 * 平台内容里的尖括号就永远进不了 DOM。
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|td|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 详情页里「左边标签 / 右边值」的标签锚点。
 *
 * 正则**必须排除含嵌套 `<div>` 的匹配**：页面上真正的标签是
 * `<div class="list"><div class="fl left">作业标题</div><div class="right">值</div></div>`，
 * 用普通的 `[\s\S]*?</div>` 会让外层 `class="list"` 先匹配上、把内层标签吞成自己的内容，
 * 结果一个标签都认不出来（真机上调过：`title` 全是 null）。`(?:(?!<div)[\s\S])*?` 就是
 * 保证「这一段里没有更内层的 div」，于是匹配只能落在最内层的标签 div 上。
 */
function detailLabelAnchors(html) {
  const anchors = [];
  for (const match of html.matchAll(/<div class="([^"]*)"[^>]*>((?:(?!<div)[\s\S])*?)<\/div>/g)) {
    if (!/\bleft\b/.test(match[1])) continue;
    anchors.push({
      start: match.index,
      end: match.index + match[0].length,
      label: normalizeDetailLabel(match[2]),
    });
  }
  return anchors;
}

/** `作业附件：` / `截止日期(GMT+8)` → `作业附件` / `截止日期`。 */
function normalizeDetailLabel(raw) {
  return htmlToText(raw)
    .replace(/[：:]\s*$/, '')
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .trim();
}

/**
 * 值段的右边界。
 *
 * 为什么不能直接取到「下一标签」或「段尾」：页面最后还有一大坨页脚
 * （「去答疑 / 去讨论」、公众号、版权声明…），真机上调出来过 —— 最后一个标签
 * （比如「评语附件」）会把整段页脚吞成自己的值，界面上就会冒出一屏
 * 「版权所有 © 清华大学」。
 *
 * 所以按 `<div>` / `</div>` 的嵌套计数找值自己的 div 在哪收口：从值段里第一个
 * `<div …>` 开始计数，回到 0 的那一个 `</div>` 就是右边界（不含它）。
 * 值段里根本没有 div（纯文本值）时退回原来的硬边界。
 */
function valueSliceEnd(html, from, hardEnd) {
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = from;
  let depth = 0;
  let seen = false;
  let match;
  while ((match = tag.exec(html)) !== null) {
    if (match.index >= hardEnd) break;
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (seen && depth === 0) return match.index;
      if (depth < 0) return match.index;
    } else {
      depth += 1;
      seen = true;
    }
  }
  return hardEnd;
}

/**
 * 抽出值里挂着的文件（附件）。
 *
 * 形如 `<span class="ftitle"><a href="…openNewWindow?fileId=…">名字.pdf</a></span>
 * <span class="color_999">81.08K</span>`；链接写成绝对地址，界面可以直接点。
 */
function detailFiles(valueHtml) {
  const files = [];
  const pattern = /<span class="ftitle">\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/span>\s*<span class="color_999">\s*([^<]*)<\/span>/g;
  for (const match of String(valueHtml ?? '').matchAll(pattern)) {
    const href = match[1].trim();
    files.push({
      name: htmlToText(match[2]),
      size: match[3].trim(),
      href: href === '' ? null : (href.startsWith('http') ? href : LEARN_BASE + href),
    });
  }
  return files;
}

/** 标签 → 结构化字段名。没在表里的标签仍然会出现在 `sections` 里，不会丢。 */
const DETAIL_FIELD_OF = {
  作业标题: 'title',
  作业说明: 'description',
  作业附件: 'attachments',
  答案说明: 'answerNote',
  答案附件: 'answerFiles',
  发布对象: 'audience',
  完成方式: 'mode',
  截止日期: 'due',
  学号: 'student',
  提交日期: 'submittedAt',
  上交作业内容: 'submission',
  上交作业附件: 'submissionFiles',
  批阅老师: 'grader',
  批阅时间: 'gradedAt',
  成绩: 'score',
  评语: 'comment',
  评语附件: 'commentFiles',
};

/** 值是文件列表的字段（其余按纯文本收）。 */
const DETAIL_FILE_FIELDS = new Set(['attachments', 'answerFiles', 'submissionFiles', 'commentFiles']);

/**
 * 解析「查看作业」详情页。
 *
 * 页面结构（三段，各自 `<div class="ttee">段名</div>` 开头，段内是若干
 * `<div class="left">标签</div><div class="right">值</div>`）：
 *   作业内容及要求：作业标题 / 作业说明 / 作业附件 / 答案说明 / 答案附件 / 发布对象 / 完成方式 / 截止日期
 *   学生提交作业情况：学号 / 提交日期 / 上交作业内容 / 上交作业附件
 *   老师批阅结果：批阅老师 / 批阅时间 / 成绩 / 评语 / 评语附件
 *
 * 解析策略是**先按标签切段、再按标签取值**，不依赖任何固定下标 —— 平台少一段、
 * 多一段都只会让对应字段变成 null。原始标签对同时留在 `sections` 里，
 * 万一平台改文案，界面还能把没认出来的标签原样显示出来，而不是白屏。
 */
export function parseHomeworkDetail(html) {
  const text = String(html ?? '');
  const marks = [...text.matchAll(/<div class="ttee"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, title: normalizeDetailLabel(match[1]) }));
  const anchors = detailLabelAnchors(text);

  const rowsBetween = (from, to) => {
    const inside = anchors.filter((anchor) => anchor.start >= from && anchor.start < to);
    return inside.map((anchor, index) => {
      const hardEnd = index + 1 < inside.length ? inside[index + 1].start : to;
      const valueEnd = valueSliceEnd(text, anchor.end, hardEnd);
      const valueHtml = text.slice(anchor.end, valueEnd);
      return { label: anchor.label, text: htmlToText(valueHtml), files: detailFiles(valueHtml) };
    });
  };

  const sections = [];
  if (marks.length === 0) {
    // 没有段标记（页面结构变了）也要尽量解析：整页当成一段
    sections.push({ title: '', rows: rowsBetween(0, text.length) });
  } else {
    marks.forEach((mark, index) => {
      const to = index + 1 < marks.length ? marks[index + 1].start : text.length;
      sections.push({ title: mark.title, rows: rowsBetween(mark.end, to) });
    });
  }

  const fields = {};
  for (const section of sections) {
    for (const row of section.rows) {
      const field = DETAIL_FIELD_OF[row.label];
      if (field === undefined || fields[field] !== undefined) continue;
      if (DETAIL_FILE_FIELDS.has(field)) fields[field] = row.files;
      else fields[field] = row.text === '' ? null : row.text;
    }
  }

  return {
    title: fields.title ?? null,
    description: fields.description ?? null,
    due: fields.due ?? null,
    audience: fields.audience ?? null,
    mode: fields.mode ?? null,
    answerNote: fields.answerNote ?? null,
    attachments: fields.attachments ?? [],
    answerFiles: fields.answerFiles ?? [],
    student: fields.student ?? null,
    submittedAt: fields.submittedAt ?? null,
    submission: fields.submission ?? null,
    submissionFiles: fields.submissionFiles ?? [],
    grader: fields.grader ?? null,
    gradedAt: fields.gradedAt ?? null,
    score: fields.score ?? null,
    comment: fields.comment ?? null,
    commentFiles: fields.commentFiles ?? [],
    sections,
  };
}

/**
 * 拉并解析一条作业的详情页。
 *
 * 不抛异常：把「Cookie 失效」「HTTP 500」都写进返回值，让界面能退回本地字段
 * 并说清原因。200 但拿不到 `id="userid"` 视为 Cookie 失效 —— 平台会把登录页
 * 用 200 返回，只看状态码会把它当成功。
 */
export async function fetchHomeworkDetail(wlkcid, xszyid, cookie, options = {}) {
  const out = await learnGet(learnHomeworkViewPath(wlkcid, xszyid), cookie, options);
  if (out.status !== 200) {
    return { ok: false, status: out.status, error: `http-${out.status}`, authUsed: out.authUsed, location: out.location ?? null, detail: null };
  }
  if (!/id="userid"/.test(out.text)) {
    return { ok: false, status: 200, error: 'cookie-invalid', authUsed: out.authUsed, location: out.location ?? null, detail: null };
  }
  const detail = parseHomeworkDetail(out.text);
  detail.wlkcid = wlkcid;
  detail.xszyid = xszyid;
  detail.url = learnHomeworkViewUrl(wlkcid, xszyid);
  return { ok: true, status: 200, error: null, authUsed: out.authUsed, location: null, detail };
}
