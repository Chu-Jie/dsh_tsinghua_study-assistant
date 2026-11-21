/**
 * 大学生学习辅助系统 · 同构核心逻辑（零依赖）
 *
 * 本文件同时被三个环境使用：
 *   1. 宿主半边 `index.js`（ESM，`import`）；
 *   2. Node 测试（本文件由 package.json 的 `"type": "module"` 视为 ESM，
 *      测试脚本因此也用 ESM 编写）；
 *   3. 客户端 bundle —— 客户端的 `require` 无法解析相对路径，所以所需函数
 *      被内联进 `client.js`；`tests/core.test.js` 用同一组固定用例钉住
 *      `lib/core.js` 与 `client.js` 的算法一致性，防止两边漂移。
 *
 * 约束：不改动入参对象、不在模块加载期读写磁盘、不依赖当前时间以外的环境。
 */

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 深拷贝纯 JSON 数据；用于保证调用方拿到的默认值互不影响。 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 判断是否为普通对象（排除 null、数组）。 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 是否是一个有意义的日期对象。
 *
 * 刻意**不用 `value instanceof Date`**：跨 realm（vm / iframe / 不同 window）时
 * 构造函数不同，instanceof 会返回 false，把合法 Date 误判成非法输入。
 * 客户端半边在 vm 里跑测试时正是这样踩到的：宿主传入的 Date 被判为非法，
 * parseDay 走进字符串分支返回 null，逾期天数退化成毫秒差、算出 −21 天。
 * 鸭子类型没有这个坑，单 realm 下行为完全等价。
 */
export function isDateLike(value) {
  return value !== null && typeof value === 'object'
    && typeof value.getTime === 'function'
    && !Number.isNaN(value.getTime());
}

/**
 * 是不是一个可解析的日期/时间文本（`YYYY-MM-DD` 或带时间的 ISO 串）。
 *
 * 只用于 `资料分析.json` 里 `generatedAt` / `supersededAt` 这类**记录时刻**的字段校验：
 * 老数据只到日（`2026-10-29`），新数据是本机时区带偏移的完整 ISO，两种都必须放行；
 * 空串与乱写的字符串则要拦下来——否则面板会显示一个不存在的生成时间。
 */
export function isDateText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '') return false;
  return !Number.isNaN(Date.parse(text));
}

/** 当前时间；测试可注入 now 以避免依赖真实时钟。 */
function nowDate(now) {
  if (isDateLike(now)) return now;
  if (typeof now === 'number') return new Date(now);
  return new Date();
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/**
 * 把 'YYYY-MM-DD'（或带时间）解析为本地时间 Date。
 * 只取日期部分，时间部分固定为 00:00 本地时间，避免 UTC 偏移把日期挪一天。
 * @returns {Date|null} 无法解析时返回 null
 */
export function parseDay(value) {
  if (isDateLike(value)) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  // 回读校验，挡住 2026-02-31 这类被 Date 自动进位的非法日期
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** 格式化为 'YYYY-MM-DD'（本地时区）。 */
export function formatDay(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * `HH:mm`（00:00–23:59）是否合法。
 *
 * 日程条目的 `time`、以及「一键提醒」文本里的时刻都用这一条规则，
 * 避免校验层与展示层对「9:5」这种写法各判一次。
 */
export function isClockTime(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (m === null) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** 两个日期之间的整天数（to - from）。 */
export function daysBetween(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 两个日期是否同一天。 */
export function isSameDay(a, b) {
  const x = parseDay(a);
  const y = parseDay(b);
  if (x === null || y === null) return false;
  return x.getTime() === y.getTime();
}

/** 中文星期名；weekday 为 1(周一)..7(周日)。 */
export function weekdayName(weekday) {
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return names[weekday] ?? '';
}

// ---------------------------------------------------------------------------
// 教学周
// ---------------------------------------------------------------------------

/**
 * 解析周次表达式。
 * 支持：'1-16'、'1-8,10-16'、'3'、'1-16(单)'、'1-16单'、'1-16(双)'、'2-16双'
 * 单双周也可用独立后缀 `单周` / `双周`。
 * @param {string} expr
 * @returns {{weeks: number[], parity: 'all'|'odd'|'even', ok: boolean, reason?: string}}
 *   ok 为 false 表示表达式非法，调用方应把该课程标记为「周次待修正」而不是抛异常。
 */
export function parseWeeks(expr) {
  const empty = { weeks: [], parity: 'all', ok: false };
  if (typeof expr !== 'string') return { ...empty, reason: 'empty' };
  let text = expr.trim();
  if (text === '') return { ...empty, reason: 'empty' };

  // 提取单双周标记
  let parity = 'all';
  const parityPatterns = [
    [/[（(]?\s*单\s*周?\s*[)）]?\s*$/, 'odd'],
    [/[（(]?\s*双\s*周?\s*[)）]?\s*$/, 'even'],
  ];
  for (const [pattern, kind] of parityPatterns) {
    if (pattern.test(text)) {
      parity = kind;
      text = text.replace(pattern, '');
      break;
    }
  }

  const weeks = new Set();
  const parts = text.split(/[,，、;；\s]+/).filter((part) => part !== '');
  if (parts.length === 0) return { ...empty, reason: 'empty' };

  for (const part of parts) {
    const range = /^(\d{1,2})\s*[-–~至]\s*(\d{1,2})$/.exec(part);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || end < start || end > 60) {
        return { ...empty, parity, reason: `bad-range:${part}` };
      }
      for (let w = start; w <= end; w += 1) weeks.add(w);
      continue;
    }
    const single = /^(\d{1,2})$/.exec(part);
    if (single !== null) {
      const week = Number(single[1]);
      if (week < 1 || week > 60) return { ...empty, parity, reason: `bad-week:${part}` };
      weeks.add(week);
      continue;
    }
    return { ...empty, parity, reason: `unparsed:${part}` };
  }

  const list = [...weeks].sort((a, b) => a - b).filter((week) => {
    if (parity === 'odd') return week % 2 === 1;
    if (parity === 'even') return week % 2 === 0;
    return true;
  });
  if (list.length === 0) return { ...empty, parity, reason: 'no-week-after-parity' };
  return { weeks: list, parity, ok: true };
}

/** 该课程在第 week 周是否上课。 */
export function isWeekActive(course, week) {
  if (!Number.isInteger(week) || week < 1) return false;
  if (Array.isArray(course?.sessions)) {
    return course.sessions.some((session) => {
      const parsed = parseWeeks(session?.weeks);
      return parsed.ok && parsed.weeks.includes(week);
    });
  }
  const parsed = parseWeeks(course?.weeks);
  return parsed.ok && parsed.weeks.includes(week);
}

/**
 * 计算某天属于第几教学周（以学期开始日为第 1 周第 1 天）。
 * @returns {{week: number, inTerm: boolean, reason?: string}}
 *   inTerm 为 false 时 week 为 0（未开学）或 totalWeeks+1（已放假）。
 */
export function currentTeachingWeek(term, date) {
  const start = parseDay(term?.startDate);
  const day = parseDay(date);
  if (start === null || day === null) return { week: 0, inTerm: false, reason: 'bad-date' };
  const totalWeeks = Number.isInteger(term?.totalWeeks) && term.totalWeeks > 0 ? term.totalWeeks : 0;

  const offset = Math.floor((day.getTime() - start.getTime()) / 86400000);
  if (offset < 0) return { week: 0, inTerm: false, reason: 'before-term' };
  const week = Math.floor(offset / 7) + 1;
  if (totalWeeks > 0 && week > totalWeeks) {
    return { week: totalWeeks + 1, inTerm: false, reason: 'after-term' };
  }
  return { week, inTerm: true };
}

/**
 * 第 week 教学周的周一。
 * 约定：term.startDate 就是第 1 教学周的周一（currentTeachingWeek 也按这个口径算）。
 * @returns {Date|null}
 */
export function teachingWeekStart(term, week) {
  const start = parseDay(term?.startDate);
  const n = Number(week);
  if (start === null || !Number.isFinite(n) || n < 1) return null;
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  date.setDate(date.getDate() + (Math.floor(n) - 1) * 7);
  return date;
}

/**
 * 把「第几教学周 + 星期几」换算成具体日期。
 * @param {object} term 学期对象（用 startDate）
 * @param {number} week 教学周，从 1 开始
 * @param {number} weekday 1=周一 … 7=周日
 * @returns {Date|null}
 */
export function dateOfWeekday(term, week, weekday) {
  const monday = teachingWeekStart(term, week);
  const wd = Number(weekday);
  if (monday === null || !Number.isFinite(wd) || wd < 1 || wd > 7) return null;
  const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  date.setDate(date.getDate() + (Math.floor(wd) - 1));
  return date;
}

/** 格式化为 'M/D'（课表表头用）。 */
export function formatMonthDay(date) {
  const d = parseDay(date);
  if (d === null) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** ISO 星期：周一 1 … 周日 7。 */
export function isoWeekday(date) {
  const day = parseDay(date);
  if (day === null) return 0;
  return day.getDay() === 0 ? 7 : day.getDay();
}

// ---------------------------------------------------------------------------
// DDL 紧急度
// ---------------------------------------------------------------------------

export const URGENCY = {
  OVERDUE: 'overdue',
  TODAY: 'today',
  SOON: 'soon',
  LATER: 'later',
  DONE: 'done',
  UNKNOWN: 'unknown',
};

/**
 * 判断任务的紧急度。
 * `due` 只有日期时按当日 23:59 计；只有时间时按当天该时刻。
 * @param {object} task
 * @param {Date|number} [now]
 * @returns {{level: string, days: number|null, hours: number|null}}
 */
export function deadlineUrgency(task, now) {
  if (task?.status === 'done' || task?.status === 'dropped') {
    return { level: URGENCY.DONE, days: null, hours: null };
  }
  const due = parseDue(task?.due);
  if (due === null) return { level: URGENCY.UNKNOWN, days: null, hours: null };

  const current = nowDate(now);
  const diffMs = due.getTime() - current.getTime();
  const hours = diffMs / 3600000;
  const days = Math.floor(diffMs / 86400000);

  if (diffMs < 0) return { level: URGENCY.OVERDUE, days, hours };
  if (isSameDay(due, current)) return { level: URGENCY.TODAY, days: 0, hours };
  if (days <= 3) return { level: URGENCY.SOON, days, hours };
  return { level: URGENCY.LATER, days, hours };
}

/**
 * 把 `due` 解析为具体时刻。
 * 只给日期 → 当日 23:59:59；带 `HH:MM` → 当天该时刻。
 * @returns {Date|null}
 */
export function parseDue(value) {
  if (isDateLike(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const day = parseDay(text);
  if (day === null) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(text);
  if (time !== null) {
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      day.setHours(hour, minute, 0, 0);
      return day;
    }
  }
  day.setHours(23, 59, 59, 0);
  return day;
}

/** 紧急度排序权重：逾期最前，其余按截止时刻升序；已完成沉底。 */
export function compareTasksByDue(a, b, now) {
  const ua = deadlineUrgency(a, now);
  const ub = deadlineUrgency(b, now);
  const rank = (level) => {
    switch (level) {
      case URGENCY.OVERDUE: return 0;
      case URGENCY.TODAY: return 1;
      case URGENCY.SOON: return 2;
      case URGENCY.LATER: return 3;
      case URGENCY.UNKNOWN: return 4;
      default: return 5;
    }
  };
  const ra = rank(ua.level);
  const rb = rank(ub.level);
  if (ra !== rb) return ra - rb;
  const da = parseDue(a?.due);
  const db = parseDue(b?.due);
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return da.getTime() - db.getTime();
}

/** status 为 done/dropped 的任务算「已完结」（与 deadlineUrgency 的判定同一口径）。 */
export function isClosedTask(task) {
  return task?.status === 'done' || task?.status === 'dropped';
}

/**
 * 解析带时间的戳（`doneAt` 这类 ISO 串，也接受「YYYY-MM-DD HH:mm」）。
 *
 * 返回**毫秒数**而不是 Date：客户端内联版与 core 版的逐项比对用 deepEqual，
 * 数字比 Date 更稳（见 tests/client.test.js 的 assertSame）。
 */
export function parseTimestamp(value) {
  if (isDateLike(value)) return value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 已完结条目的排序：按完成时间**倒序**（最近完成的排最前）。
 *
 * `doneAt` 由宿主在 status 转 done 时写下（lib/api.js 的 normalizeTask）；
 * 老数据可能没有这个字段 —— 缺 doneAt 的排在后面，仍分不出先后时按截止日倒序，
 * 最后返回 0 保持原序：宁可少排一层，也不要把顺序打乱成随机的。
 */
export function compareClosedTasksByDoneAtDesc(a, b) {
  const ta = parseTimestamp(a?.doneAt);
  const tb = parseTimestamp(b?.doneAt);
  if (ta !== null && tb !== null) {
    if (ta !== tb) return tb - ta;
  } else if (ta !== null) {
    return -1;
  } else if (tb !== null) {
    return 1;
  }
  const da = parseDue(a?.due);
  const db = parseDue(b?.due);
  if (da !== null && db !== null && da.getTime() !== db.getTime()) return db.getTime() - da.getTime();
  return 0;
}

/**
 * 「截止列表」的统一比较器：未完结的按紧急度排（compareTasksByDue，逾期最前），
 * 已完结的沉底、组内按完成时间倒序 —— 刚做完的那条排在最上面。
 */
export function compareDeadlineList(a, b, now) {
  if (isClosedTask(a) && isClosedTask(b)) return compareClosedTasksByDoneAtDesc(a, b);
  return compareTasksByDue(a, b, now);
}

// ---------------------------------------------------------------------------
// 批量导入 DDL（一键导入的文本解析）
// ---------------------------------------------------------------------------

/** 快速录入时允许的中文类型别名 → 任务 kind。 */
export const KIND_ALIASES = {
  作业: 'homework', 平时作业: 'homework', 习题: 'homework',
  实验: 'lab', 实验报告: 'lab', 上机: 'lab',
  报告: 'report', 大作业: 'report', 项目: 'report',
  论文: 'paper', 文献: 'paper',
  考试: 'exam', 测验: 'exam', 小测: 'exam', 期中: 'exam', 期末: 'exam', 随堂测验: 'exam',
  小组: 'group', 展示: 'group', 讨论: 'group', 汇报: 'group',
  其他: 'other',
};

/** 快速录入时允许的中文日期别名 → 相对 now 的偏移天数。 */
const DATE_ALIASES = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };

const WEEKDAY_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/**
 * 解析快速录入用的日期写法。
 * 支持：'2026-10-15'、'10/15'、'10-15'、'今天'/'明天'/'后天'、'周五'/'周5'、'下周周三'、'10/15 14:00'。
 * @param {string} text
 * @param {Date|number} [now]
 * @returns {{value: string|null, ok: boolean, reason?: string}}
 *   value 形如 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM'
 */
export function parseQuickDay(text, now) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { value: null, ok: true };
  const base = isDateLike(now) ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : parseDay(now);
  if (base === null) return { value: null, ok: false, reason: 'bad-now' };

  const timeMatch = /(\d{1,2}):(\d{2})/.exec(raw);
  let time = null;
  if (timeMatch !== null) {
    const h = Number(timeMatch[1]);
    const mi = Number(timeMatch[2]);
    if (h <= 23 && mi <= 59) time = `${pad2(h)}:${pad2(mi)}`;
  }
  const body = raw.replace(/\d{1,2}:\d{2}/, '').trim();

  const withTime = (date) => {
    if (date === null) return null;
    const day = formatDay(date);
    return time === null ? day : `${day} ${time}`;
  };

  // 绝对日期：2026-10-15 / 2026/10/15
  const full = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(body);
  if (full !== null) {
    const date = parseDay(`${full[1]}-${pad2(Number(full[2]))}-${pad2(Number(full[3]))}`);
    if (date === null) return { value: null, ok: false, reason: 'bad-date' };
    return { value: withTime(date), ok: true };
  }
  // 省略年份：10/15 或 10-15（若已过则算明年）
  const short = /^(\d{1,2})[-/.](\d{1,2})$/.exec(body);
  if (short !== null) {
    const month = Number(short[1]);
    const day = Number(short[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return { value: null, ok: false, reason: 'bad-date' };
    let date = parseDay(`${base.getFullYear()}-${pad2(month)}-${pad2(day)}`);
    if (date === null) return { value: null, ok: false, reason: 'bad-date' };
    if (date.getTime() < base.getTime()) {
      date = parseDay(`${base.getFullYear() + 1}-${pad2(month)}-${pad2(day)}`);
    }
    return { value: withTime(date), ok: true };
  }
  // 相对别名
  if (Object.prototype.hasOwnProperty.call(DATE_ALIASES, body)) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + DATE_ALIASES[body]);
    return { value: withTime(date), ok: true };
  }
  // 星期：周三 / 周3 / 下周三（今天算「本周」，已过的星期几顺延到本周之后的下一个）
  const wd = /^(下?)(?:周|星期|礼拜)\s*([一二三四五六日天1-7])$/.exec(body);
  if (wd !== null) {
    const target = WEEKDAY_WORDS[wd[2]] ?? Number(wd[2]);
    if (!Number.isFinite(target)) return { value: null, ok: false, reason: 'bad-weekday' };
    const current = isoWeekday(base);
    let delta = target - current;
    if (wd[1] === '下') delta += 7;
    else if (delta < 0) delta += 7;
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
    return { value: withTime(date), ok: true };
  }
  return { value: null, ok: false, reason: 'unparsed-date' };
}

/**
 * 解析批量导入的多行文本。每行一个 DDL，字段用 `|` 分隔：
 *
 *   标题 | 科目 | 日期 | 类型
 *
 * 只有标题是必填的；科目可写课程名（支持唯一前缀匹配），日期可用
 * `2026-10-15` / `10/15` / `今天` / `周五`，类型可写中文别名（作业/实验/考试…）。
 * `#` 开头的行按注释跳过。
 *
 * @param {string} text
 * @param {{courses?: object[], now?: Date|number}} [options]
 * @returns {{items: object[], errors: {line: number, text: string, reason: string}[], ok: boolean}}
 *   items 元素为可直接交给 /mutate 的任务草稿（未含 id，由宿主生成）。
 */
export function parseQuickTasks(text, options = {}) {
  const courses = Array.isArray(options.courses) ? options.courses : [];
  const now = options.now;
  const items = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);

  // 科目匹配：课程名与别名一视同仁。
  // 别名用来吸收简称/习惯叫法（例如「数电」= 数字电子技术基础），
  // 这样用户在导入时不必写课程表上的全名。
  const haystacks = courses.map((course) => {
    const names = [course?.name, ...(Array.isArray(course?.aliases) ? course.aliases : [])]
      .filter((n) => typeof n === 'string' && n.trim() !== '')
      .map((n) => n.trim().toLowerCase());
    return { course, names };
  });

  const matchCourse = (name) => {
    const needle = name.trim();
    if (needle === '') return { id: null, ok: true };
    const lower = needle.toLowerCase();
    // 1) 精确命中课程名或别名
    const exact = haystacks.find((h) => h.names.includes(lower));
    if (exact !== undefined) return { id: exact.course.id ?? null, ok: true };
    // 2) 唯一前缀/子串命中
    const partial = haystacks.filter((h) => h.names.some((n) => n.includes(lower)));
    if (partial.length === 1) return { id: partial[0].course.id ?? null, ok: true };
    if (partial.length > 1) {
      return {
        id: null,
        ok: false,
        reason: `科目「${needle}」匹配到多门课：${partial.map((h) => h.course.name).join('、')}，请写得更具体`,
      };
    }
    // 3) 认不出来时，顺手提示可用的写法（含别名），免得用户猜
    const available = courses
      .map((c) => {
        const alias = Array.isArray(c?.aliases) ? c.aliases.filter((a) => typeof a === 'string' && a.trim() !== '') : [];
        return alias.length > 0 ? `${c?.name}（或 ${alias.join('/')}）` : String(c?.name ?? '');
      })
      .filter((s) => s !== '');
    const hint = available.length > 0 ? `。可用的科目：${available.join('、')}` : '';
    return { id: null, ok: false, reason: `找不到科目「${needle}」${hint}` };
  };

  const matchKind = (name) => {
    const needle = name.trim();
    if (needle === '') return { kind: 'homework', ok: true };
    if (KIND_ALIASES[needle] !== undefined) return { kind: KIND_ALIASES[needle], ok: true };
    return { kind: 'homework', ok: false, reason: `类型「${needle}」无法识别` };
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) return;
    const lineNo = index + 1;
    const parts = line.split('|').map((part) => part.trim());
    const title = parts[0] ?? '';
    if (title === '') {
      errors.push({ line: lineNo, text: line, reason: '标题为空' });
      return;
    }
    const draft = { title, kind: 'homework', due: null, courseId: null, priority: 'normal' };

    const course = matchCourse(parts[1] ?? '');
    if (!course.ok) {
      errors.push({ line: lineNo, text: line, reason: course.reason });
      return;
    }
    draft.courseId = course.id;

    const day = parseQuickDay(parts[2] ?? '', now);
    if (!day.ok) {
      errors.push({ line: lineNo, text: line, reason: `日期「${parts[2]}」无法识别` });
      return;
    }
    draft.due = day.value;

    const kind = matchKind(parts[3] ?? '');
    if (!kind.ok) {
      errors.push({ line: lineNo, text: line, reason: kind.reason });
      return;
    }
    draft.kind = kind.kind;

    // 第 5 个字段可选：优先级 low/normal/high 或 高/中/低
    const prioRaw = (parts[4] ?? '').trim();
    if (prioRaw !== '') {
      const prioMap = { low: 'low', normal: 'normal', high: 'high', 高: 'high', 中: 'normal', 低: 'low' };
      const prio = prioMap[prioRaw.toLowerCase()] ?? prioMap[prioRaw];
      if (prio === undefined) {
        errors.push({ line: lineNo, text: line, reason: `优先级「${prioRaw}」无法识别（可写 高/中/低）` });
        return;
      }
      draft.priority = prio;
    }
    items.push({ ...draft, _line: lineNo });
  });

  return { items, errors, ok: errors.length === 0 };
}

// ---------------------------------------------------------------------------
// 成绩与 GPA
// ---------------------------------------------------------------------------

/**
 * 把百分制分数换算为 4.0 制绩点（国内高校通用线性式：(分数-50)/10，上限 4.0）。
 * 不及格（<60）计 0。
 * @returns {number|null} 无法换算时返回 null（调用方应列为「未计入」而不是当 0）
 */
export function scoreToGpa4(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 60) return 0;
  return Math.min(4, Math.round(((score - 50) / 10) * 100) / 100);
}

/**
 * 五级制等级换算为 4.0 制绩点。
 */
export function gradeToGpa4(grade) {
  switch (grade) {
    case '优秀': case 'A': case 'A+': return 4;
    case '良好': case 'B': case 'B+': return 3;
    case '中等': case 'C': case 'C+': return 2;
    case '及格': case 'D': return 1;
    case '不及格': case 'F': return 0;
    default: return null;
  }
}

/**
 * 计算加权 GPA 与均分。
 * 无法换算的条目进入 `skipped`，绝不静默按 0 计入。
 * @param {object} grades - 成绩文档
 * @param {number} [creditsFallback] - 缺学分时使用的默认学分，默认 0 表示不计入权重
 * @returns {{gpa: number|null, average: number|null, credits: number, counted: number, skipped: Array}}
 */
export function computeGpa(grades) {
  const list = Array.isArray(grades?.courses) ? grades.courses : [];
  let weighted = 0;
  let creditSum = 0;
  let scoreWeighted = 0;
  let scoreCreditSum = 0;
  const skipped = [];

  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      skipped.push({ courseId: null, reason: 'bad-entry' });
      continue;
    }
    const gpa = typeof item.score === 'number' ? scoreToGpa4(item.score) : gradeToGpa4(item.grade);
    if (gpa === null) {
      skipped.push({ courseId: item.courseId ?? null, reason: 'no-score' });
      continue;
    }
    const credit = typeof item.credit === 'number' && Number.isFinite(item.credit) && item.credit > 0 ? item.credit : 0;
    if (credit === 0) {
      skipped.push({ courseId: item.courseId ?? null, reason: 'no-credit' });
      continue;
    }
    weighted += gpa * credit;
    creditSum += credit;
    if (typeof item.score === 'number') {
      scoreWeighted += item.score * credit;
      scoreCreditSum += credit;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    gpa: creditSum > 0 ? round2(weighted / creditSum) : null,
    average: scoreCreditSum > 0 ? round2(scoreWeighted / scoreCreditSum) : null,
    credits: round2(creditSum),
    counted: creditSum > 0 ? list.length - skipped.length : 0,
    skipped,
  };
}

/**
 * 目标 GPA 反推：在已有成绩基础上，把剩余学分拿到的平均绩点需要多少。
 * @param {object} grades
 * @param {number} targetGpa
 * @param {number} remainingCredits
 * @returns {{requiredGpa: number|null, reachable: boolean, reason?: string}}
 */
export function requiredGpaForTarget(grades, targetGpa, remainingCredits) {
  const base = computeGpa(grades);
  if (base.gpa === null || base.credits <= 0) {
    return { requiredGpa: null, reachable: false, reason: 'no-existing-credits' };
  }
  if (typeof targetGpa !== 'number' || !Number.isFinite(targetGpa)) {
    return { requiredGpa: null, reachable: false, reason: 'bad-target' };
  }
  if (typeof remainingCredits !== 'number' || !Number.isFinite(remainingCredits) || remainingCredits <= 0) {
    return { requiredGpa: null, reachable: false, reason: 'no-remaining-credits' };
  }
  const total = base.credits + remainingCredits;
  const need = (targetGpa * total - base.gpa * base.credits) / remainingCredits;
  const round2 = (n) => Math.round(n * 100) / 100;
  if (need > 4) return { requiredGpa: round2(need), reachable: false, reason: 'above-max' };
  if (need <= 0) return { requiredGpa: 0, reachable: true };
  return { requiredGpa: round2(need), reachable: true };
}

// ---------------------------------------------------------------------------
// 文档 schema 与默认值
// ---------------------------------------------------------------------------

/**
 * 全部数据文档的键名。
 * 后三个（2026-10-20 起）由「全量资料取字」批次生成、面板只读：
 * 资料索引 / 题目 / 知识点候选 —— 它们与 term…homework 一起被 store 读取、备份与健康检查，
 * 但没有通用 /mutate 路由（`/mutate` 对它们回 `use-dedicated-route`，与 homework 同待遇）。
 * `knowledgeNetwork`（2026-10-20 夜里加）是**面板可写**的第四份新文档：节点掌握度与「重点」
 * 标记都由人在面板上点，所以它有 /mutate 路由（见 lib/api.js 的 DOC_ROUTES）。
 * `knowledgeOutline`（2026-10-21 深夜加）是**取字产物衍生的只读大纲**：从教材目录页解析出的
 * 「章 → 节 → 小节」骨架，面板只读展示，写入由 `tools/knowledge-outline.mjs` 直接落盘，
 * 因此它跟 materials/questions/knowledgeCandidates 一样**没有** /mutate 路由。
 * `knowledgeAnalysis`（2026-10-23 夜加）是**扫描产物分析结果**：每知识点的详解/例题/出处、
 * 教材习题清单、PPT 考点、作业原题标注、生成记录 runs[]。体积大（数百 KB 起），
 * 与会变动的学习状态（knowledgeNetwork）分开存；写入只走 `POST /analysis/run` 一条专用路由，
 * 同样**没有** /mutate（对 /mutate 回 `use-dedicated-route`）。
 * `annotations`（2026-10-30 加，**第 12 份**）是**个人编辑层**：教材/PPT/讲义原文只读，用户的批注 /
 * 高亮 / 正文追加作为覆盖层存在这一份里。它是面板可写的（`POST /mutate` + `doc === 'annotations'`
 * 的专用分支：锚点一律按服务端完整原文重算，见 `lib/annotation-anchor.js`），并自动进
 * `/state`、`/backup/export` 与健康检查。
 * `knowledgeMap`（2026-11-01 加，**第 13 份**）是**知识点 ↔ 教材页/PPT 页的映射表**：内容线 v3 的
 * C2 扫描任务把 982 个知识点逐个查教材页/PPT 页后写进 `points{}`。它只是「出处映射」，不是学习状态，
 * 写入由 C2 会话直接落盘（不走 /mutate）；同样自动进 `/state`、`/backup/export` 与健康检查。
 * 骨架故意极简 `{version, updatedAt, points:{}}`：`points` 是自由 map（知识点 id → 映射记录），
 * 结构由写入方约定，本层只保证顶层三键在位、可空。
 * `schedule`（2026-11-19 加，**第 14 份**）是**「今日日程」里的自定义日程**：一次性、带日期时间的条目
 * （`{id, title, date:'YYYY-MM-DD', time:'HH:mm'|null, note?, createdAt, updatedAt}`）。它是面板可写的
 * 普通文档（走通用 `POST /mutate`，见 lib/api.js 的 DOC_ROUTES.schedule），自动进 `/state`、
 * `/backup/export` 与健康检查；`time` 为 null 表示全天条目。
 * A2 卡（2026-11-19）给每条 entry 追加**四个可选字段**，全部向后兼容（旧条目没有也照常渲染）：
 *   `category` —— `study|innovation|life|work`，缺省 `work`（工作其他）；
 *   `location` —— 地点字符串，可空，缺省 `''`；
 *   `endTime`  —— 结束时刻 `HH:mm`，可空，缺省 `null`（只显示起点 / 全天）；
 *   `source`   —— `manual|auto-ai`，缺省 `manual`（AI 识别后由用户确认入库的记 `auto-ai`）。
 * 面板只对**自定义条目**写这四字段；课程与 DDL 的分类是渲染层算的，不进 `任务.json` / `课程.json`。
 * `news`（2026-11-19 加，**第 15 份**）是**「今日要闻」**：由插件外的抓取脚本
 * `tools/fetch-news.mjs`（Windows 计划任务每天 7:00 跑）从**公开源**抓来的标题/日期/链接/来源/首段，
 * 每天按保留策略覆盖写一次。它是**只读展示文档**：面板只读，**没有** /mutate 路由（对 /mutate 回
 * `use-dedicated-route`），写入只由脚本按 `lib/store.js` 的原子写 + 备份范式落盘；
 * 自动进 `/state`、`/backup/export` 与健康检查。
 * `learningBehavior`（2026-11-20 加，**第 16 份**）是**学习行为**：每个知识点的
 * 打开次数 / 首次·最后一次学习时间 / 累计学习分钟（本步恒 0，第二步做真停留计时后才会涨）/
 * 掌握度来源（`auto` 算法算的、`manual` 人改的）。
 * ⚠️ **它不含掌握等级**：等级仍然只写 `知识点网络.json` 的 `mastery` —— 面板、章节统计、
 * 复习提醒、导出读的都是那一份，换真源会大面积打架。这份文档只回答「学过多久、打开过几次」。
 * `nodes` 是 **nodeId → 行为** 的对象 map（982 个节点按 id 直取，不用数组线性扫）；
 * 某节点没有记录 = 没有任何行为（按默认值算，不是错误）。
 * 写入只走两条专用路由（`POST /assistant/behavior` / `POST /assistant/mastery`），
 * **没有** `/mutate`（对 /mutate 回 `use-dedicated-route`）；自动进 `/state`、`/backup/export` 与健康检查。
 */
export const DOC_KEYS = ['term', 'courses', 'tasks', 'grades', 'homework', 'materials', 'questions', 'knowledgeCandidates', 'knowledgeNetwork', 'knowledgeOutline', 'knowledgeAnalysis', 'annotations', 'knowledgeMap', 'schedule', 'news', 'learningBehavior'];

/**
 * 批注类型：`note`（选中段落的文字批注）/ `highlight`（仅高亮，无正文）/ `insert`（在段落间插入的个人段落）。
 * 三种类型**共用同一套锚点数据**（见 lib/annotation-anchor.js），区别只在 `type`。
 */
export const ANNOTATION_TYPES = ['note', 'highlight', 'insert'];

/**
 * 行内格式（2026-11-17 D 卡）：批注 note 上可选 `style` 的**颜色白名单**。
 *
 * 只存语义键，不存十六进制色值——主题可换，数据稳定。前端用同键的调色板映射到 CSS。
 * 每个字段独立可选，缺省即「不改变该维度」。
 *   color     改字色（前景）
 *   highlight 高光底色（背景）
 *   underline 下划线颜色
 *   bold/italic 布尔
 * 旧数据（无 style 字段）照样合法——这是不动旧断言的前提。
 */
export const ANNOTATION_STYLE_COLORS = ['red', 'blue', 'green', 'black', 'gray'];
export const ANNOTATION_STYLE_HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'orange'];
export const ANNOTATION_STYLE_UNDERLINES = ['red', 'blue', 'gray'];
export const ANNOTATION_STYLE_KEYS = ['color', 'highlight', 'underline', 'bold', 'italic'];

/**
 * 主观标记类型的语义键（E1，2026-11-18）。只存英文键，不存中文（与 style 一致）。
 * key=重点 / question=疑问 / review=待复习；缺省或 null=普通/无（旧数据无此字段照样合法）。
 * 导出 md 与前端徽标都按此表译中文，展示层自行映射。
 */
export const ANNOTATION_MARK_KINDS = ['key', 'question', 'review', 'learned'];

/**
 * 学习行为的「掌握度来源」白名单（第 16 份文档 `learningBehavior`，2026-11-20）。
 *
 *   auto   —— 由 `lib/mastery.js` 的算法算出来的，**允许**被下一次算法更新；
 *   manual —— 人在面板改的、或经学习助手聊天确认改的，**算法一律跳过**（尊重人的修改）。
 *
 * 没有行为记录 = 没有来源字段 = 按 `auto` 处理（算法可以写）。这条缺省值放在这里，
 * 是为了让 core 的校验、api 的写入、mastery 的计算三处读同一份口径。
 */
export const LEARNING_BEHAVIOR_SOURCES = ['auto', 'manual'];
/** 缺记录时的缺省来源（= 算法可写）。 */
export const LEARNING_BEHAVIOR_DEFAULT_SOURCE = 'auto';

/**
 * 每条学习行为**只允许**这六个字段（第 16 份文档的写入口）。
 *
 * 不在这里字段白名单里的话，`POST /assistant/behavior` 与 `POST /assistant/mastery`
 * 都在 `store.writeDocument` 之前就被 `validateDoc` 拒掉（`behavior-unknown-field`）——
 * 这是「绝不另造第二套掌握度真源」的机器保证：想往这份文档里塞 `mastery: 3`
 * 的写法根本落不了盘，等级只能写回 `知识点网络.json`。
 */
export const LEARNING_BEHAVIOR_FIELDS = [
  'firstLearnedAt',
  'lastLearnedAt',
  'visitCount',
  'totalMinutes',
  'masterySource',
  'masteryUpdatedAt',
];

/**
 * 日程的四个分类（2026-11-19 A2 卡）：`日程.json` 每条 entry 的 `category` 白名单。
 *
 * 「今日日程」把课程 / DDL / 自定义条目摊成一张大卡里的 4 个横向版块，版块就是这四个键。
 * **只存英文键、不存中文**（与批注的 style / markKind 同一约定）：中文名是展示层的事，
 * 改文案不该动数据。旧条目没有 `category` 时按 `work`（「工作其他」）算，见 validateDoc。
 */
export const SCHEDULE_CATEGORIES = ['study', 'innovation', 'life', 'work'];
/** 分类的中文显示名；面板版块头、下拉选项与回执共用这一份说法。 */
export const SCHEDULE_CATEGORY_LABEL = {
  study: '学习',
  innovation: '科创',
  life: '生活',
  work: '工作其他',
};
/** 条目来源白名单（`manual` 手动录入 / `auto-ai` 由 AI 识别后确认入库）。 */
export const SCHEDULE_SOURCES = ['manual', 'auto-ai'];
/** 旧条目 / 缺字段时的缺省分类（用户 2026-11-19 定：兜底进「工作其他」）。 */
export const SCHEDULE_DEFAULT_CATEGORY = 'work';
/** 旧条目 / 缺字段时的缺省来源。 */
export const SCHEDULE_DEFAULT_SOURCE = 'manual';

/** 每份文档的文件名（中文，人类可读，可手改）。 */
export const DOC_FILES = {
  term: '学期.json',
  courses: '课程.json',
  tasks: '任务.json',
  grades: '成绩.json',
  homework: '作业.json',
  materials: '资料索引.json',
  questions: '题目.json',
  knowledgeCandidates: '知识点候选.json',
  knowledgeNetwork: '知识点网络.json',
  knowledgeOutline: '知识点大纲.json',
  knowledgeAnalysis: '资料分析.json',
  annotations: '批注.json',
  knowledgeMap: '知识映射.json',
  schedule: '日程.json',
  news: '要闻.json',
  learningBehavior: '学习行为.json',
};

/** 数据文件格式版本；结构不兼容变更时递增，用于迁移与损坏判定。 */
export const DOC_VERSION = 1;

/** 每份文档的默认空结构。 */
export function defaultDoc(key) {
  switch (key) {
    case 'term':
      return { version: DOC_VERSION, terms: [], currentId: null, updatedAt: null };
    case 'courses':
      return { version: DOC_VERSION, courses: [], updatedAt: null };
    case 'tasks':
      return { version: DOC_VERSION, tasks: [], updatedAt: null };
    case 'grades':
      return {
        version: DOC_VERSION,
        courses: [],
        rules: { mode: '4.0-weighted', formula: 'linear-50' },
        targets: [],
        updatedAt: null,
      };
    case 'homework':
      return { version: DOC_VERSION, records: [], updatedAt: null };
    // 三份取字产物：字段名是数据契约（任务单 §5），不要改
    case 'materials':
      return { version: DOC_VERSION, files: [], updatedAt: null };
    case 'questions':
      return { version: DOC_VERSION, questions: [], updatedAt: null };
    case 'knowledgeCandidates':
      return { version: DOC_VERSION, candidates: [], updatedAt: null };
    // 知识网络：nodes = 知识点节点（带掌握度/重点标记），edges = 关系（第一版留空，由会话织网补）
    case 'knowledgeNetwork':
      return { version: DOC_VERSION, nodes: [], edges: [], updatedAt: null };
    // 知识点大纲：教材目录骨架（课程 → 章 → 节 → 小节），由取字产物解析生成，面板只读
    case 'knowledgeOutline':
      return { version: DOC_VERSION, courses: [], updatedAt: null };
    // 资料分析：扫描产物（教材/PPT/作业）分析出的详解、例题、习题清单与生成记录，面板读、专用路由写
    case 'knowledgeAnalysis':
      return { version: DOC_VERSION, courses: [], runs: [], updatedAt: null };
    // 批注（第 12 份主文档）：个人编辑层，原文只读，批注是覆盖层；三种类型共用一套锚点
    case 'annotations':
      return { version: DOC_VERSION, notes: [], updatedAt: null };
    // 知识映射（第 13 份主文档）：知识点 id → 教材页/PPT 页映射表；点骨架故意极简，可空
    case 'knowledgeMap':
      return { version: DOC_VERSION, updatedAt: null, points: {} };
    // 今日日程（第 14 份主文档）：一次性、带日期时间的自定义条目；面板走通用 /mutate 增删改
    case 'schedule':
      return { version: DOC_VERSION, entries: [], updatedAt: null };
    // 今日要闻（第 15 份主文档）：抓取脚本每天按保留策略覆盖写；面板只读，不走 /mutate
    case 'news':
      return { version: DOC_VERSION, items: [], fetchedAt: null, updatedAt: null };
    // 学习行为（第 16 份主文档）：nodeId → 行为 的 map。空 map 就是「还没有任何学习行为」。
    // 注意 `nodes` 是**对象**（不是数组）：982 个节点按 id 直取，缺记录按默认值算。
    case 'learningBehavior':
      return { version: DOC_VERSION, nodes: {}, updatedAt: null };
    default:
      return null;
  }
}

/** 每份文档的顶层必需字段类型（用于损坏判定与写入校验）。 */
const DOC_SHAPE = {
  term: { terms: 'array' },
  courses: { courses: 'array' },
  tasks: { tasks: 'array' },
  grades: { courses: 'array' },
  homework: { records: 'array' },
  materials: { files: 'array' },
  questions: { questions: 'array' },
  knowledgeCandidates: { candidates: 'array' },
  knowledgeNetwork: { nodes: 'array', edges: 'array' },
  knowledgeOutline: { courses: 'array' },
  knowledgeAnalysis: { courses: 'array', runs: 'array' },
  annotations: { notes: 'array' },
  knowledgeMap: { points: 'object' },
  schedule: { entries: 'array' },
  news: { items: 'array' },
  // `nodes` 是 nodeId → 行为的 **对象 map**（不是数组），逐个节点在 validateDoc 里细查
  learningBehavior: { nodes: 'object' },
};

/**
 * 校验一份文档结构是否可用。
 * 损坏保护依赖它：结构不符时**拒绝写入**，而不是当成空数据。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateDoc(key, doc) {
  if (!(key in DOC_SHAPE)) return { ok: false, reason: `unknown-doc:${key}` };
  if (!isPlainObject(doc)) return { ok: false, reason: 'not-an-object' };
  if (doc.version !== DOC_VERSION) return { ok: false, reason: `bad-version:${String(doc.version)}` };
  for (const [field, type] of Object.entries(DOC_SHAPE[key])) {
    if (type === 'array' && !Array.isArray(doc[field])) return { ok: false, reason: `bad-field:${field}` };
    if (type === 'object' && !isPlainObject(doc[field])) return { ok: false, reason: `bad-field:${field}` };
  }
  if (key === 'grades' && !isPlainObject(doc.rules)) return { ok: false, reason: 'bad-field:rules' };
  // 批注文档：逐条校验，坏结构一律拒绝（写不进去），保证面板拿到的每条都能直接渲染
  if (key === 'annotations') {
    const seenIds = new Set();
    for (const note of Array.isArray(doc.notes) ? doc.notes : []) {
      if (!isPlainObject(note)) return { ok: false, reason: 'annotation-not-an-object' };
      if (typeof note.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(note.id)) return { ok: false, reason: 'annotation-bad-id' };
      if (seenIds.has(note.id)) return { ok: false, reason: 'annotation-duplicate-id' };
      seenIds.add(note.id);
      if (!ANNOTATION_TYPES.includes(note.type)) return { ok: false, reason: 'annotation-bad-type' };
      if (typeof note.file !== 'string' || note.file.trim() === '') return { ok: false, reason: 'annotation-missing-file' };
      if (typeof note.content !== 'string') return { ok: false, reason: 'annotation-bad-content' };
      if (note.page !== undefined && note.page !== null && !(Number.isInteger(note.page) && note.page >= 1)) {
        return { ok: false, reason: 'annotation-bad-page' };
      }
      const anchor = note.anchor;
      if (!isPlainObject(anchor)) return { ok: false, reason: 'annotation-missing-anchor' };
      if (typeof anchor.quote !== 'string' || anchor.quote === '') return { ok: false, reason: 'annotation-bad-quote' };
      if (!Number.isInteger(anchor.start) || anchor.start < 0) return { ok: false, reason: 'annotation-bad-range' };
      if (!Number.isInteger(anchor.end) || anchor.end < anchor.start) return { ok: false, reason: 'annotation-bad-range' };
      if (anchor.end - anchor.start !== anchor.quote.length) return { ok: false, reason: 'annotation-quote-range-mismatch' };
      if (typeof anchor.prefix !== 'string' || typeof anchor.suffix !== 'string') return { ok: false, reason: 'annotation-bad-context' };
      if (anchor.expanded !== undefined && typeof anchor.expanded !== 'boolean') return { ok: false, reason: 'annotation-bad-expanded' };
      // 行内格式（2026-11-17 D 卡）：exact 标志（短选精确锚点，可选）；非布尔拒
      if (anchor.exact !== undefined && typeof anchor.exact !== 'boolean') return { ok: false, reason: 'annotation-bad-exact' };
      if (typeof note.createdAt !== 'string' || note.createdAt.trim() === '') return { ok: false, reason: 'annotation-bad-createdAt' };
      if (typeof note.updatedAt !== 'string' || note.updatedAt.trim() === '') return { ok: false, reason: 'annotation-bad-updatedAt' };
      if (note.weak !== undefined && !isPlainObject(note.weak)) return { ok: false, reason: 'annotation-bad-weak' };
      // 行内格式 style（可选）：缺省容忍，写了必须合法（白名单外的键/值一律拒，防脏数据）
      if (note.style !== undefined && note.style !== null) {
        if (!isPlainObject(note.style)) return { ok: false, reason: 'annotation-bad-style' };
        for (const field of Object.keys(note.style)) {
          if (!ANNOTATION_STYLE_KEYS.includes(field)) return { ok: false, reason: 'annotation-bad-style-key' };
        }
        if (note.style.color !== undefined && !ANNOTATION_STYLE_COLORS.includes(note.style.color)) {
          return { ok: false, reason: 'annotation-bad-style-color' };
        }
        if (note.style.highlight !== undefined && !ANNOTATION_STYLE_HIGHLIGHTS.includes(note.style.highlight)) {
          return { ok: false, reason: 'annotation-bad-style-highlight' };
        }
        if (note.style.underline !== undefined && !ANNOTATION_STYLE_UNDERLINES.includes(note.style.underline)) {
          return { ok: false, reason: 'annotation-bad-style-underline' };
        }
        if (note.style.bold !== undefined && typeof note.style.bold !== 'boolean') {
          return { ok: false, reason: 'annotation-bad-style-flag' };
        }
        if (note.style.italic !== undefined && typeof note.style.italic !== 'boolean') {
          return { ok: false, reason: 'annotation-bad-style-flag' };
        }
      }
      // 主观标记类型 markKind（E1，可选）：缺省/null 合法（=普通，旧数据无此字段）；写了必须白名单内。
      if (note.markKind !== undefined && note.markKind !== null && !ANNOTATION_MARK_KINDS.includes(note.markKind)) {
        return { ok: false, reason: 'annotation-bad-mark-kind' };
      }
    }
  }
  // 今日日程：逐条校验，坏条目一律拒写（面板拿到的每条都要能直接渲染成一行）
  if (key === 'schedule') {
    const seenIds = new Set();
    for (const entry of Array.isArray(doc.entries) ? doc.entries : []) {
      if (!isPlainObject(entry)) return { ok: false, reason: 'schedule-not-an-object' };
      if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)) {
        return { ok: false, reason: 'schedule-bad-id' };
      }
      if (seenIds.has(entry.id)) return { ok: false, reason: 'schedule-duplicate-id' };
      seenIds.add(entry.id);
      if (typeof entry.title !== 'string' || entry.title.trim() === '') {
        return { ok: false, reason: 'schedule-missing-title' };
      }
      if (typeof entry.date !== 'string' || parseDay(entry.date) === null || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date.trim())) {
        return { ok: false, reason: 'schedule-bad-date' };
      }
      if (entry.time !== null && entry.time !== undefined) {
        if (typeof entry.time !== 'string' || !isClockTime(entry.time)) {
          return { ok: false, reason: 'schedule-bad-time' };
        }
      }
      if (entry.note !== undefined && entry.note !== null && typeof entry.note !== 'string') {
        return { ok: false, reason: 'schedule-bad-note' };
      }
      // A2 卡（2026-11-19）的四个可选字段：**缺省一律放行**（旧条目就是没有），
      // 但只要写了一个非法值就整份拒写 —— 否则面板会渲染出「工作其他」以外的第 5 个版块、
      // 或者把 `9:5` 这种时刻原样印在行首。
      if (entry.category !== undefined && entry.category !== null && !SCHEDULE_CATEGORIES.includes(entry.category)) {
        return { ok: false, reason: 'schedule-bad-category' };
      }
      if (entry.location !== undefined && entry.location !== null && typeof entry.location !== 'string') {
        return { ok: false, reason: 'schedule-bad-location' };
      }
      if (entry.endTime !== undefined && entry.endTime !== null) {
        if (typeof entry.endTime !== 'string' || !isClockTime(entry.endTime)) {
          return { ok: false, reason: 'schedule-bad-end-time' };
        }
      }
      if (entry.source !== undefined && entry.source !== null && !SCHEDULE_SOURCES.includes(entry.source)) {
        return { ok: false, reason: 'schedule-bad-source' };
      }
      if (typeof entry.createdAt !== 'string' || entry.createdAt.trim() === '') {
        return { ok: false, reason: 'schedule-bad-createdAt' };
      }
      if (typeof entry.updatedAt !== 'string' || entry.updatedAt.trim() === '') {
        return { ok: false, reason: 'schedule-bad-updatedAt' };
      }
    }
  }
  // 今日要闻（第 15 份）：逐条校验 —— 面板要把每条直接渲染成「可点开的标题 + 来源 + 日期 + 灰字首段」，
  // 所以坏条目一律拒写，绝不让一条缺 url / 缺日期 / url 不是 http(s) 的条目混进面板。
  // 顶层 fetchedAt 允许 null（还没抓过），写了就必须是可解析的时间文本。
  if (key === 'news') {
    if (doc.fetchedAt !== undefined && doc.fetchedAt !== null && !isDateText(doc.fetchedAt)) {
      return { ok: false, reason: 'news-bad-fetched-at' };
    }
    const seenNewsIds = new Set();
    for (const item of Array.isArray(doc.items) ? doc.items : []) {
      if (!isPlainObject(item)) return { ok: false, reason: 'news-not-an-object' };
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) {
        return { ok: false, reason: 'news-bad-id' };
      }
      if (seenNewsIds.has(item.id)) return { ok: false, reason: 'news-duplicate-id' };
      seenNewsIds.add(item.id);
      if (typeof item.title !== 'string' || item.title.trim() === '') {
        return { ok: false, reason: 'news-missing-title' };
      }
      // url 协议白名单：只放 http/https（挡住 javascript: / data: / 相对路径这些面板点开会出事的写法）
      if (typeof item.url !== 'string' || !/^https?:\/\/[^/\s]+/i.test(item.url.trim())) {
        return { ok: false, reason: 'news-bad-url' };
      }
      if (typeof item.source !== 'string' || item.source.trim() === '') {
        return { ok: false, reason: 'news-missing-source' };
      }
      // 日期必须可解析：抓不到日期就不该进库（不编日期），抓取脚本在入口就把它丢掉
      if (typeof item.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt.trim()) || parseDay(item.publishedAt) === null) {
        return { ok: false, reason: 'news-bad-date' };
      }
      if (typeof item.excerpt !== 'string') return { ok: false, reason: 'news-bad-excerpt' };
      if (item.excerpt.length > NEWS_EXCERPT_MAX) return { ok: false, reason: 'news-excerpt-too-long' };
      if (!NEWS_CATEGORIES.includes(item.category)) return { ok: false, reason: 'news-bad-category' };
      if (typeof item.fetchedAt !== 'string' || !isDateText(item.fetchedAt)) {
        return { ok: false, reason: 'news-bad-item-fetched-at' };
      }
    }
  }
  if (key === 'knowledgeAnalysis') {
    for (const course of Array.isArray(doc.courses) ? doc.courses : []) {
      if (course?.lectures !== undefined && !Array.isArray(course.lectures)) return { ok: false, reason: 'bad-field:lectures' };
      const seen = new Set();
      for (const lecture of Array.isArray(course?.lectures) ? course.lectures : []) {
        const no = lecture?.no === undefined || lecture?.no === null ? '' : String(lecture.no).trim();
        if (no === '') return { ok: false, reason: 'lecture-without-no' };
        if (seen.has(no)) return { ok: false, reason: 'lecture-duplicate-no' };
        seen.add(no);
        // 适用范围（可选）：写了就必须是对象，字段类型要能直接给面板用
        if (lecture.applicability !== undefined) {
          if (!isPlainObject(lecture.applicability)) return { ok: false, reason: 'lecture-applicability-invalid' };
          for (const field of ['chapter', 'textbook', 'book']) {
            const value = lecture.applicability[field];
            if (value !== undefined && typeof value !== 'string') return { ok: false, reason: 'lecture-applicability-invalid' };
          }
          if (lecture.applicability.points !== undefined && !Array.isArray(lecture.applicability.points)) {
            return { ok: false, reason: 'lecture-applicability-invalid' };
          }
        }
        // 可追溯字段：缺字段容忍（老数据），写了就必须合法 —— 否则面板会显示假版本号/假模型名
        const styleKeys = new Set();
        for (const style of [...(Array.isArray(lecture.styles) ? lecture.styles : []), ...(Array.isArray(lecture.variants) ? lecture.variants : [])]) {
          if (style?.file !== undefined && !String(style.file).toLowerCase().endsWith('.md')) return { ok: false, reason: 'lecture-style-file-missing' };
          if (style?.version !== undefined && !(Number.isInteger(style.version) && style.version > 0)) return { ok: false, reason: 'lecture-style-version-invalid' };
          if (style?.model !== undefined && typeof style.model !== 'string') return { ok: false, reason: 'lecture-style-model-invalid' };
          if (style?.generatedAt !== undefined && !isDateText(style.generatedAt)) return { ok: false, reason: 'lecture-style-generatedAt-invalid' };
          if (style?.supersededBy !== undefined && !(Number.isInteger(style.supersededBy) && style.supersededBy > 0)) return { ok: false, reason: 'lecture-style-superseded-invalid' };
          if (style?.supersededAt !== undefined && !isDateText(style.supersededAt)) return { ok: false, reason: 'lecture-style-superseded-invalid' };
        }
        for (const style of Array.isArray(lecture.styles) ? lecture.styles : []) {
          const styleKey = style?.key === undefined || style?.key === null ? '' : String(style.key).trim();
          if (styleKey === '') continue;
          if (styleKeys.has(styleKey)) return { ok: false, reason: 'lecture-style-duplicate-key' };
          styleKeys.add(styleKey);
        }
        // 不许静默覆盖：当前版本号 > 1 的档，variants[] 里必须留着被它取代的每一版
        const archived = new Map();
        for (const style of Array.isArray(lecture.variants) ? lecture.variants : []) {
          const target = Number.isInteger(style?.supersededBy) && style.supersededBy > 0 ? style.supersededBy : 0;
          if (target === 0) continue;
          const styleKey = style?.key === undefined || style?.key === null ? '' : String(style.key).trim();
          if (!archived.has(styleKey)) archived.set(styleKey, new Set());
          archived.get(styleKey).add(style.version);
        }
        for (const style of Array.isArray(lecture.styles) ? lecture.styles : []) {
          const version = Number.isInteger(style?.version) && style.version > 0 ? style.version : 0;
          if (version <= 1) continue;
          const styleKey = style?.key === undefined || style?.key === null ? '' : String(style.key).trim();
          const kept = archived.get(styleKey) ?? new Set();
          for (let older = 1; older < version; older += 1) {
            if (!kept.has(older)) return { ok: false, reason: 'lecture-silent-overwrite' };
          }
        }
      }
    }
  }
  // 学习行为（第 16 份）：`nodes` 是 nodeId → 行为 的 map，**逐条校验，坏一条整份拒写**。
  // 理由与批注/日程/要闻同一套：这份文档会被面板、算法、复习提醒反复读，
  // 写进去一条半截记录，就等于让后面每一个读它的人都要自己再兜一遍底 —— 不如在入口拒收。
  if (key === 'learningBehavior') {
    for (const [nodeId, behavior] of Object.entries(doc.nodes ?? {})) {
      // 键就是知识点 id，走与文档键同一套白名单（这也顺手挡住路径穿越式怪 id）
      if (!isValidId(nodeId)) return { ok: false, reason: 'behavior-bad-node-id' };
      if (!isPlainObject(behavior)) return { ok: false, reason: 'behavior-not-an-object' };
      for (const field of ['firstLearnedAt', 'lastLearnedAt']) {
        const value = behavior[field];
        if (value !== undefined && value !== null && !isDateText(value)) {
          return { ok: false, reason: `behavior-bad-${field === 'firstLearnedAt' ? 'first' : 'last'}-at` };
        }
      }
      if (!Number.isInteger(behavior.visitCount) || behavior.visitCount < 0) {
        return { ok: false, reason: 'behavior-bad-visit-count' };
      }
      // 第二步的停留计时会往这里累加分钟；这一步恒 0，但允许任何非负数（将来可能带小数）
      if (typeof behavior.totalMinutes !== 'number' || !Number.isFinite(behavior.totalMinutes) || behavior.totalMinutes < 0) {
        return { ok: false, reason: 'behavior-bad-total-minutes' };
      }
      if (!LEARNING_BEHAVIOR_SOURCES.includes(behavior.masterySource)) {
        return { ok: false, reason: 'behavior-bad-mastery-source' };
      }
      const updated = behavior.masteryUpdatedAt;
      if (updated !== undefined && updated !== null && !isDateText(updated)) {
        return { ok: false, reason: 'behavior-bad-mastery-updated-at' };
      }
      // 白名单外的字段一律拒收：这份文档只存「行为」，谁想往这里塞一个 `mastery` 等级，
      // 在入口就被挡回去 —— 掌握等级的唯一真源是 `知识点网络.json`。
      for (const field of Object.keys(behavior)) {
        if (!LEARNING_BEHAVIOR_FIELDS.includes(field)) return { ok: false, reason: 'behavior-unknown-field' };
      }
    }
  }
  return { ok: true };
}

/** 生成稳定 id（不依赖随机库，冲突风险由调用方的集合去重兜底）。 */
export function makeId(prefix, seed) {
  const base = String(seed ?? Date.now().toString(36));
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${base}${rand}`;
}

/** id 字符合法性：只允许字母数字、下划线、连字符，挡住路径穿越。 */
export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// ---------------------------------------------------------------------------
// 业务组合函数（宿主工具与面板共用同一套结果）
// ---------------------------------------------------------------------------

/** 取当前学期对象。 */
export function currentTerm(termDoc) {
  const terms = Array.isArray(termDoc?.terms) ? termDoc.terms : [];
  if (terms.length === 0) return null;
  const byId = terms.find((t) => t?.id === termDoc?.currentId);
  if (byId !== undefined) return byId;
  return terms.find((t) => t?.isCurrent === true) ?? terms[terms.length - 1] ?? null;
}

/** 汇总当前进行中的任务（未完成且未放弃）。 */
export function activeTasks(taskDoc) {
  const tasks = Array.isArray(taskDoc?.tasks) ? taskDoc.tasks : [];
  return tasks.filter((task) => task?.status !== 'done' && task?.status !== 'dropped');
}

/**
 * 当天要上的课（`buildOverview` 与 `buildDailyBrief` 共用这一条规则，别各算一遍）。
 * @param {object[]} courses 课程文档里的 courses[]
 * @param {{week: number, inTerm: boolean}} week
 * @param {number} weekday 1(周一)..7(周日)
 */
function collectTodayCourses(courses, week, weekday) {
  if (!week.inTerm) return [];
  return (Array.isArray(courses) ? courses : [])
    .filter((course) => isWeekActive(course, week.week))
    .flatMap((course) => (Array.isArray(course.sessions) ? course.sessions : []).map((session) => ({ course, session })))
    .filter(({ session }) => Number(session?.weekday) === weekday)
    .sort((a, b) => Number(a.session?.startPeriod ?? 0) - Number(b.session?.startPeriod ?? 0))
    .map(({ course, session }) => ({
      courseId: course?.id ?? null,
      name: course?.name ?? '',
      location: session?.location ?? '',
      startPeriod: session?.startPeriod ?? null,
      endPeriod: session?.endPeriod ?? null,
    }));
}

/**
 * 生成概览，供 `study_overview` 工具与面板「今日」页共用。
 * @param {{term: object, courses: object, tasks: object, grades: object}} data
 * @param {Date|number} [now]
 */
export function buildOverview(data, now) {
  const current = nowDate(now);
  const term = currentTerm(data?.term);
  const week = currentTeachingWeek(term, current);
  const active = activeTasks(data?.tasks);

  const sorted = [...active].sort((a, b) => compareTasksByDue(a, b, current));
  const upcoming = sorted.slice(0, 5).map((task) => {
    const urgency = deadlineUrgency(task, current);
    return {
      id: task?.id ?? null,
      title: task?.title ?? '',
      kind: task?.kind ?? 'other',
      due: task?.due ?? null,
      level: urgency.level,
      days: urgency.days,
    };
  });

  const overdueCount = active.filter((task) => deadlineUrgency(task, current).level === URGENCY.OVERDUE).length;

  // 今日课程
  const todayCourses = collectTodayCourses(data?.courses?.courses, week, isoWeekday(current));

  return {
    date: formatDay(current),
    weekday: isoWeekday(current),
    weekdayName: weekdayName(isoWeekday(current)),
    term: term === null ? null : { id: term.id ?? null, name: term.name ?? '', totalWeeks: term.totalWeeks ?? null },
    week: week.inTerm ? week.week : 0,
    inTerm: week.inTerm,
    termState: week.reason ?? 'in-term',
    todayCourses,
    upcoming,
    overdueCount,
    gpa: computeGpa(data?.grades),
  };
}

/**
 * 「今日日程」的数据骨架（2026-11-19 A 卡）。
 *
 * 三块内容与「今日」页那个卡一一对应：
 *   1. `courses` —— 当天要上的课（与 `buildOverview.todayCourses` 同一条规则，见 collectTodayCourses）；
 *   2. `entries` —— `日程.json` 里 `date` 等于今天的自定义条目（`time` 为 null 的「全天」排在最后）；
 *   3. `ddl` —— 未完成任务里**今天到期**与**已逾期**的两组（逾期在前、组内按紧迫度）。
 *      注意它比「临近截止」卡窄：卡片看的是未来几天的全景，推送只提醒今天必须处理的。
 *
 * 纯函数：不读磁盘、不看真实时钟（`now` 可注入），供 `/remind` 与测试共用。
 * @param {{term?: object, courses?: object, tasks?: object, schedule?: object}} data
 * @param {Date|number} [now]
 */
export function buildDailyBrief(data, now) {
  const current = nowDate(now);
  const term = currentTerm(data?.term);
  const week = currentTeachingWeek(term, current);
  const weekday = isoWeekday(current);

  const courses = collectTodayCourses(data?.courses?.courses, week, weekday);

  const rawEntries = Array.isArray(data?.schedule?.entries) ? data.schedule.entries : [];
  const entries = rawEntries
    .filter((entry) => isPlainObject(entry) && isSameDay(entry.date, current))
    .map((entry) => ({
      id: entry.id ?? null,
      title: typeof entry.title === 'string' ? entry.title : '',
      time: typeof entry.time === 'string' && isClockTime(entry.time) ? entry.time.trim() : null,
      note: typeof entry.note === 'string' ? entry.note : '',
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
      // A2 卡（2026-11-19）：新字段对推送文本**不改变现有格式**（用户 2026-11-19 定：
      // 「只保证不崩，格式不变」），这里只把它们带出来，供将来的版块化文本与测试断言使用。
      category: SCHEDULE_CATEGORIES.includes(entry.category) ? entry.category : SCHEDULE_DEFAULT_CATEGORY,
      location: typeof entry.location === 'string' ? entry.location.trim() : '',
      endTime: typeof entry.endTime === 'string' && isClockTime(entry.endTime) ? entry.endTime.trim() : null,
      source: SCHEDULE_SOURCES.includes(entry.source) ? entry.source : SCHEDULE_DEFAULT_SOURCE,
    }))
    // 有时间的按时间升序；「全天」条目排在最后（时间比较先比 null，再用字符串序，HH:mm 天然可比）
    .sort((a, b) => {
      if (a.time === null && b.time === null) return a.title < b.title ? -1 : 1;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return a.title < b.title ? -1 : 1;
    });

  const active = activeTasks(data?.tasks);
  const withUrgency = active
    .map((task) => ({ task, urgency: deadlineUrgency(task, current) }))
    .filter(({ urgency }) => urgency.level === URGENCY.OVERDUE || urgency.level === URGENCY.TODAY)
    .sort((a, b) => compareTasksByDue(a.task, b.task, current))
    .map(({ task, urgency }) => ({
      id: task?.id ?? null,
      title: task?.title ?? '',
      due: task?.due ?? null,
      level: urgency.level,
      days: urgency.days,
      courseId: task?.courseId ?? null,
    }));

  const overdue = withUrgency.filter((item) => item.level === URGENCY.OVERDUE);
  const today = withUrgency.filter((item) => item.level === URGENCY.TODAY);

  return {
    date: formatDay(current),
    weekday,
    weekdayName: weekdayName(weekday),
    monthDay: formatMonthDay(current),
    week: week.inTerm ? week.week : 0,
    inTerm: week.inTerm,
    generatedAt: current.toISOString(),
    generatedClock: `${pad2(current.getHours())}:${pad2(current.getMinutes())}`,
    courses,
    entries,
    ddl: { overdue, today, total: overdue.length + today.length },
  };
}

/** 从 `due` 里取 `HH:mm`（没有时间就返回 null）。 */
function dueClock(task) {
  const due = parseDue(task?.due);
  if (due === null) return null;
  const matched = /(\d{1,2}):(\d{2})/.exec(String(task.due ?? ''));
  return matched === null ? null : `${pad2(Number(matched[1]))}:${matched[2]}`;
}

/** 单条 DDL 的紧凑说明（`/remind` 文本用）。 */
function briefDeadlineLine(item) {
  const clock = item.level === URGENCY.TODAY ? dueClock({ due: item.due }) : null;
  const when = item.level === URGENCY.OVERDUE
    ? `逾期 ${Math.abs(Number(item.days) || 0)} 天`
    : clock === null ? '今天' : `今天 ${clock}`;
  const dueText = typeof item.due === 'string' && item.due.trim() !== '' ? `（截止 ${item.due.trim()}）` : '';
  return `[${when}] ${item.title}${dueText}`;
}

/**
 * 把 `buildDailyBrief` 的结果排成一条可直接发到微信/QQ 的纯文本。
 *
 * 纯文本、不用 Markdown：微信/AI 机器人对 Markdown 渲染不一致，而这条消息的
 * 唯一要求是「一眼扫完」。空小节也保留标题并写一句「今天没有…」——比整段消失
 * 更容易确认是「真没有」而不是「没算」。
 *
 * @param {ReturnType<typeof buildDailyBrief>} brief
 * @param {{maxDeadlines?: number, maxEntries?: number}} [options]
 */
export function formatDailyBrief(brief, options = {}) {
  const maxDeadlines = Number.isInteger(options.maxDeadlines) && options.maxDeadlines > 0 ? options.maxDeadlines : 8;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 12;

  const lines = [];
  const weekText = brief.inTerm && brief.week > 0 ? ` · 第 ${brief.week} 周` : '';
  lines.push(`【今日日程 · ${brief.monthDay} ${brief.weekdayName}${weekText}】`);

  lines.push('■ 今日课程');
  if (brief.courses.length === 0) {
    lines.push(brief.inTerm ? '今天没有课。' : '今天不在教学周内。');
  } else {
    brief.courses.forEach((course, index) => {
      const span = course.startPeriod === null || course.startPeriod === undefined
        ? ''
        : course.startPeriod === course.endPeriod
          ? `第 ${course.startPeriod} 节`
          : `第 ${course.startPeriod}-${course.endPeriod} 节`;
      const place = course.location === '' ? '' : ` · ${course.location}`;
      lines.push(`${index + 1}. ${course.name}${span === '' ? '' : `　${span}`}${place}`);
    });
  }

  lines.push('■ 自定义日程');
  if (brief.entries.length === 0) {
    lines.push('今天没有自定义日程。');
  } else {
    brief.entries.slice(0, maxEntries).forEach((entry) => {
      const when = entry.time === null ? '全天' : entry.time;
      const note = entry.note === '' ? '' : `（${entry.note}）`;
      lines.push(`${when}　${entry.title}${note}`);
    });
    if (brief.entries.length > maxEntries) {
      lines.push(`… 还有 ${brief.entries.length - maxEntries} 条，去「今日」页看全部。`);
    }
  }

  lines.push('■ 今日 DDL');
  if (brief.ddl.total === 0) {
    lines.push('今天没有到期或逾期的 DDL。');
  } else {
    const shown = [...brief.ddl.overdue, ...brief.ddl.today];
    shown.slice(0, maxDeadlines).forEach((item) => lines.push(`· ${briefDeadlineLine(item)}`));
    if (shown.length > maxDeadlines) {
      lines.push(`… 还有 ${shown.length - maxDeadlines} 条，去「DDL」页看全部。`);
    }
  }

  lines.push('');
  lines.push(`—— 学习台 · ${brief.generatedClock} 生成`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 今日要闻（第 15 份主文档 `news` / `要闻.json`）
// ---------------------------------------------------------------------------
//
// 这一节只放**纯函数**：抓取（网络、超时、重试、写盘）在插件外的 `tools/fetch-news.mjs`，
// 面板展示走 `GET /news`。核心逻辑放这里，是为了让「id 怎么生成、怎么去重、保留多少、
// 首段怎么截」只有一份实现 —— 脚本、接口、测试三方共用，不会各算一遍。
//
// ⚠️ 本文件会被内联进浏览器端的 `client.js`，所以这里**不许**用 node:crypto 之类
// 只存在于 Node 的模块；id 用的是本文件内自带的 32 位双 FNV-1a 哈希（同输入同输出，
// Node 与浏览器结果一致）。

/** 要闻分类白名单（抓取脚本按栏目映射，校验层只认这四个）。 */
export const NEWS_CATEGORIES = ['notice', 'academic', 'career', 'competition'];

/** 分类的中文名；面板的「来源」列与回执共用这一份说法。 */
export const NEWS_CATEGORY_LABEL = {
  notice: '通知公告',
  academic: '教务教学',
  career: '学习发展',
  competition: '科创赛事',
};

/**
 * 首段摘要的长度上限（含截断用的省略号）。
 *
 * 卡 §⑤ 定的是「首段 ≤200 字」，校验层与抓取脚本共用这一条，改这里只改一处。
 * 面板上它是标题下那行灰字，200 字够扫一眼、又不至于把整张卡顶满。
 */
export const NEWS_EXCERPT_MAX = 200;

/**
 * 保留策略：**14 天 且 最多 100 条**（用户 2026-11-19 定案，两个条件是交集）。
 *
 * 每天 7:00 抓一次 → 合并既有 → 按这里裁剪 → 整体覆盖写 `要闻.json`。
 * 「覆盖写」的意思是：文件里只留策略允许的条目，不是永久累加。
 */
export const NEWS_RETENTION = { days: 14, max: 100 };

/** 32 位双 FNV-1a：给 url 生成稳定 id 用；Node / 浏览器结果一致，零依赖。 */
function newsHash(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a ^= code;
    a = (a * 0x01000193) >>> 0;
    b ^= (code + index) >>> 0;
    b = (b * 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * 条目的稳定 id：`n_` + url 的 16 位十六进制哈希。
 *
 * 用 url 而不是标题当种子：同一篇稿子的标题在索引页与详情页常常不完全一样（尾部带栏目名），
 * url 才是同一性的事实依据。同 url 再次抓到 = 同 id = 覆盖旧条目，不会越抓越多。
 */
export function newsIdForUrl(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (text === '') return null;
  return `n_${newsHash(text)}`;
}

/** 从 ISO/时间文本里取 `HH:mm`（本机时区），用于「抓取时间」那行。 */
export function newsClockOf(value) {
  if (typeof value !== 'string' || !isDateText(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 归一化外部链接：只放 http/https，去掉 `#片段` 与常见的跟踪参数。
 *
 * `base` 用于把索引页上的相对链接（清华官网大量 `../info/1023/xxxx.htm`）按栏目地址解析成绝对 URL；
 * 解析不了、或者协议不是 http(s) 的一律返回 null —— 面板要把每条渲染成可点开的链接，
 * 放进来一个 `javascript:` 或相对路径就是给了个点不开（甚至危险）的入口。
 */
export function normalizeNewsUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text.startsWith('#')) return null;
  let url;
  try {
    url = base === undefined || base === null ? new URL(text) : new URL(text, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  // 索引页跳到详情页时常见的分享/统计参数，留着只会让「同一条」在 id 上分家
  for (const key of ['from', 'isappinstalled', 'scene', 'clicktime', 'enterid', 'spm', 'share_source', 'share_medium']) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * 首段摘要：压平空白 → 超长就在句末断开并补省略号。
 *
 * 句末断不开（比如整段没有一个句号）就硬截；两种结果长度都不超过 `limit`。
 */
export function newsExcerptFrom(text, max) {
  const limit = Number.isInteger(max) && max > 0 ? max : NEWS_EXCERPT_MAX;
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (flat === '') return '';
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  for (const mark of ['。', '！', '？', '；', '!', '?', ';', '.']) {
    const at = cut.lastIndexOf(mark);
    if (at >= Math.floor(limit * 0.6)) return `${cut.slice(0, at + 1)}…`;
  }
  return `${cut}…`;
}

/**
 * 把一条外部数据归一化成文档里的一条要闻；不合格返回 null（**不猜、不补**）。
 *
 * 必填：`url`（http/https 绝对地址）、`title`、`source`、`publishedAt`（`YYYY-MM-DD` 且可解析）。
 * 抓不到日期的条目直接丢 —— 一条没有日期的要闻在面板上排不进「最近 N 天」，留着只会撒谎。
 */
export function normalizeNewsItem(raw) {
  if (!isPlainObject(raw)) return null;
  const url = normalizeNewsUrl(raw.url, raw.base);
  if (url === null) return null;
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  if (title === '') return null;
  const source = typeof raw.source === 'string' ? raw.source.replace(/\s+/g, ' ').trim() : '';
  if (source === '') return null;
  const publishedText = typeof raw.publishedAt === 'string' ? raw.publishedAt.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedText) || parseDay(publishedText) === null) return null;
  const category = NEWS_CATEGORIES.includes(raw.category) ? raw.category : 'notice';
  const fetchedAt = isDateText(raw.fetchedAt) ? String(raw.fetchedAt).trim() : new Date().toISOString();
  return {
    id: newsIdForUrl(url),
    title: title.slice(0, 300),
    url,
    source: source.slice(0, 40),
    publishedAt: publishedText,
    excerpt: newsExcerptFrom(raw.excerpt, NEWS_EXCERPT_MAX),
    category,
    fetchedAt,
  };
}

/** 按 id 去重（保留先出现的；`mergeNews` 走的是「后出现的覆盖同 id」）。 */
export function dedupeNews(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = item !== null && typeof item === 'object' ? item.id : null;
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** 排序：日期新的在前；同一天按标题稳定排序（不靠抓取顺序，免得每天重排得像换了一批）。 */
export function sortNews(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const left = String(a?.publishedAt ?? '');
    const right = String(b?.publishedAt ?? '');
    if (left !== right) return left < right ? 1 : -1;
    const leftTitle = String(a?.title ?? '');
    const rightTitle = String(b?.title ?? '');
    if (leftTitle !== rightTitle) return leftTitle < rightTitle ? -1 : 1;
    return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : 1;
  });
}

/**
 * 合并「库里已有的」与「本次新抓的」。
 *
 * 同 id 以**新抓的**为准（来源站改了标题/补了首段时，面板要跟着更新）。
 * 为什么要合并而不是直接覆盖：清华新闻首页一页只有 10 条、约合一天的量，
 * 若每天只写当次结果，「保留 14 天」这个窗口就永远只有一天的内容 —— 合并才让保留策略真正生效。
 */
export function mergeNews(existing, incoming) {
  const map = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const id = item !== null && typeof item === 'object' ? item.id : null;
    if (typeof id === 'string') map.set(id, item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const id = item !== null && typeof item === 'object' ? item.id : null;
    if (typeof id === 'string') map.set(id, item);
  }
  return sortNews([...map.values()]);
}

/** 窗口起点：含今天在内往前数 `days` 个自然日（days=7 → 今天与之前 6 天）。 */
function newsWindowStart(days, now) {
  const current = nowDate(now);
  return new Date(current.getFullYear(), current.getMonth(), current.getDate() - (days - 1));
}

/**
 * 按保留策略裁剪：先按窗口丢太旧的，再丢未来日期的（抓错/时区错会产出未来日期），最后按条数上限截断。
 *
 * 返回的仍是副本，不改入参。
 */
export function limitNews(items, options = {}) {
  const days = Number.isInteger(options.days) && options.days > 0 ? options.days : NEWS_RETENTION.days;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : NEWS_RETENTION.max;
  const now = nowDate(options.now);
  const start = newsWindowStart(days, now);
  const startMs = start.getTime();
  const todayMs = parseDay(formatDay(now)).getTime();
  const kept = sortNews(dedupeNews(items)).filter((item) => {
    const day = parseDay(item?.publishedAt);
    if (day === null) return false;
    const value = day.getTime();
    return value >= startMs && value <= todayMs;
  });
  return kept.slice(0, max);
}

/**
 * 「今日」页要闻卡的数据骨架。
 *
 * `items` 是**最近 `days` 天**（默认 7）的条目，新的在前；`total` 是库里总共存了多少条
 * （保留策略裁过之后的量），所以卡上可以写「最近 7 天 N 条 / 库里共 M 条」。
 * @param {object} doc `news` 文档
 * @param {{days?: number, now?: Date|number}} [options]
 */
export function buildNewsBoard(doc, options = {}) {
  const days = Number.isInteger(options.days) && options.days > 0 ? options.days : 7;
  const now = nowDate(options.now);
  const all = sortNews(dedupeNews(Array.isArray(doc?.items) ? doc.items : []));
  const startMs = newsWindowStart(days, now).getTime();
  const todayMs = parseDay(formatDay(now)).getTime();
  const items = all.filter((item) => {
    const day = parseDay(item?.publishedAt);
    if (day === null) return false;
    const value = day.getTime();
    return value >= startMs && value <= todayMs;
  });
  const todayCount = items.filter((item) => item.publishedAt === formatDay(now)).length;
  return {
    days,
    windowStart: formatDay(new Date(startMs)),
    today: formatDay(now),
    total: all.length,
    shown: items.length,
    todayCount,
    items,
    fetchedAt: typeof doc?.fetchedAt === 'string' && isDateText(doc.fetchedAt) ? doc.fetchedAt : null,
    fetchedClock: newsClockOf(doc?.fetchedAt),
  };
}
