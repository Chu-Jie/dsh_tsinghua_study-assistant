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
 */
export const DOC_KEYS = ['term', 'courses', 'tasks', 'grades', 'homework', 'materials', 'questions', 'knowledgeCandidates', 'knowledgeNetwork', 'knowledgeOutline', 'knowledgeAnalysis'];

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
  }
  if (key === 'grades' && !isPlainObject(doc.rules)) return { ok: false, reason: 'bad-field:rules' };
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
  let todayCourses = [];
  if (week.inTerm) {
    const weekday = isoWeekday(current);
    const courses = Array.isArray(data?.courses?.courses) ? data.courses.courses : [];
    todayCourses = courses
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
