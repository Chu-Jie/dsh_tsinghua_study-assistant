/**
 * 大学生学习辅助系统 · 客户端半边（自包含单文件）
 *
 * 约束（来自 Harness 插件规范，逐条遵守）：
 *   - 只用 `require('react')`，不 require 任何 @deepseek-ai/dsh-client-ui-* 包；
 *   - 不用 iframe；不写 document.body；不动别的插件的 DOM；
 *   - 样式只用主题令牌 --dsw-alias-*，不写死颜色，自动跟随明暗主题；
 *   - 所有注册与资源都放在 ctx.effect / ctx.slots.inject 的回调里，卸载时释放；
 *   - 界面文案内置中文（locale 服务接入留到 v0.5）。
 *
 * 四个落点：
 *   1. sidebar.panellist  —— 侧栏图标（id 自动寻址同名 main 面板）
 *   2. main (key)         —— 中央主面板，六个页签
 *   3. conversation.composer.dock —— 会话输入框下方的 DDL 提醒
 *   4. sidebar.right.pane.tab (+ .title) —— 右侧栏「学习台详情」标签页
 *
 * 数据通道：同源 fetch 到宿主注册的 /api/study-assistant/*（见 lib/api.js）。
 * 写操作的算法与 lib/core.js 保持一致，由 tests/core.test.js 的同一组用例钉住。
 */

window.__ModuleLoader__.load({
  id: 'dsh-study-assistant',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    // ---------------------------------------------------------------------
    // 常量与文案
    // ---------------------------------------------------------------------

    const PANEL_ID = 'study-assistant';
    const API = '/api/study-assistant';
    const REQUEST_HEADER = 'X-Study-Request';
    const CACHE_TTL_MS = 15000;
    const NOTICE_WINDOW_DAYS = 3; // 会话提醒只显示逾期与 3 天内到期

    const TEXT = {
      panel: '学习辅助',
      title: '大学生学习辅助系统',
      tabs: { today: '今日', schedule: '课表', deadlines: 'DDL', grades: '成绩', materials: '资料', knowledge: '知识点', settings: '设置' },
      loading: '正在读取学习台数据…',
      error: '读取失败',
      retry: '重试',
      empty: '还没有数据。先在「课表」页添加课程，或在会话里让我帮你录入。',
      noTerm: '还没有设置学期，先去「设置」页添加一个。',
      noCourseToday: '今天没有课',
      noDeadline: '没有临近的截止日',
      overdue: '已逾期',
      today: '今天',
      soon: '即将',
      later: '之后',
      unknown: '无日期',
      done: '已完成',
      weekdays: ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      periods: '第 {a}-{b} 节',
    };

    // 任务类型的中文名。必须定义在页签组件**之前**：
    // 组件函数体在渲染时才求值，若把它放在组件下方，首次渲染就会踩进 TDZ 报
    // "Cannot access 'KIND_LABEL' before initialization"。
    const KIND_LABEL = { homework: '作业', lab: '实验', report: '报告', paper: '论文', exam: '考试', group: '小组', other: '其他' };

    // 提交件归档：宿主 lib/deliverables.js 给出的判定状态与理由的中文说法。
    // 状态一共五种 —— ready 会被自动归档掉，剩下的都只是「提示」，界面绝不据此改任务状态。
    const DELIVER_STATUS_LABEL = {
      ready: '待归档',
      ambiguous: '待确认',
      done: '已归档',
      unmatched: '没对上',
      stray: '放错位置',
    };
    const DELIVER_REASON_LABEL = {
      'unique-task': '唯一命中一条未完成任务',
      'task-ambiguous': '有多条任务都能对上，不敢自动归档',
      'course-ambiguous': '科目名同时对上多门课',
      'course-mismatch': '目录与文件名说的不是同一门课',
      'course-unknown': '认不出属于哪门课',
      'no-task': '这门课没有序号 / 类型能对上的任务',
      'not-in-submit-dir': '不在 <学科>/提交文件/ 里',
      'already-noted': '备注里已记着这份提交件',
      'task-done': '对应任务已经是完成状态',
      'missing-identity': '文件名里没有姓名或学号',
    };

    // ---------------------------------------------------------------------
    // 与 lib/core.js 一致的纯逻辑（同一组测试用例钉住一致性）
    // ---------------------------------------------------------------------

    const pad2 = (n) => String(n).padStart(2, '0');

    /**
     * 是否是一个「有意义的日期对象」。
     *
     * 刻意**不用 `value instanceof Date`**：跨 realm（vm / iframe / 不同 window）时
     * 构造函数不同，instanceof 会返回 false，把合法 Date 误判成非法输入。
     * 本会话的测试就撞到过这一条：client 在 vm realm 里，宿主传入的 Date
     * `instanceof Date` 为 false，于是 parseDay 走进字符串分支返回 null，
     * 逾期天数退化成毫秒差、算出 −21 天。
     * 鸭子类型没有这个坑，且行为在单 realm 下完全等价。
     */
    function isDateLike(value) {
      return value !== null && typeof value === 'object'
        && typeof value.getTime === 'function'
        && !Number.isNaN(value.getTime());
    }

    function parseDay(value) {
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
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
      return date;
    }

    function formatDay(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    /**
     * 把「本该是对象数组」的字段安全地读成数组（2026-10-23 凌晨）。
     *
     * 为什么需要：真实数据被别的脚本/旧版本写坏时，数组里会留下 `null`（`[null, {...}]`），
     * 一旦某处 `.find((item) => item.id === x)` / `.map((item) => item.name)` 碰到 null 就是整页白屏。
     * 这类问题的根子是「数据层校验通过、界面层假设成立」，所以统一在读取处过滤掉非对象项。
     */
    function objectList(value) {
      return (Array.isArray(value) ? value : []).filter((item) => item !== null && typeof item === 'object');
    }

    function isoWeekday(date) {
      const day = parseDay(date);
      if (day === null) return 0;
      return day.getDay() === 0 ? 7 : day.getDay();
    }

    // --- 教学周 ↔ 具体日期（与 lib/core.js 同步，课表表头要靠它显示日期） ---

    function teachingWeekStart(term, week) {
      const start = parseDay(term?.startDate);
      const n = Number(week);
      if (start === null || !Number.isFinite(n) || n < 1) return null;
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      date.setDate(date.getDate() + (Math.floor(n) - 1) * 7);
      return date;
    }

    function dateOfWeekday(term, week, weekday) {
      const monday = teachingWeekStart(term, week);
      const wd = Number(weekday);
      if (monday === null || !Number.isFinite(wd) || wd < 1 || wd > 7) return null;
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
      date.setDate(date.getDate() + (Math.floor(wd) - 1));
      return date;
    }

    function formatMonthDay(date) {
      const d = parseDay(date);
      if (d === null) return '';
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    // --- 批量导入 DDL 的文本解析（与 lib/core.js 同步） ---

    const DATE_ALIASES = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
    const WEEKDAY_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    const KIND_ALIASES = {
      作业: 'homework', 平时作业: 'homework', 习题: 'homework',
      实验: 'lab', 实验报告: 'lab', 上机: 'lab',
      报告: 'report', 大作业: 'report', 项目: 'report',
      论文: 'paper', 文献: 'paper',
      考试: 'exam', 测验: 'exam', 小测: 'exam', 期中: 'exam', 期末: 'exam', 随堂测验: 'exam',
      小组: 'group', 展示: 'group', 讨论: 'group', 汇报: 'group',
      其他: 'other',
    };

    function parseQuickDay(text, now) {
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

      const full = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(body);
      if (full !== null) {
        const date = parseDay(`${full[1]}-${pad2(Number(full[2]))}-${pad2(Number(full[3]))}`);
        if (date === null) return { value: null, ok: false, reason: 'bad-date' };
        return { value: withTime(date), ok: true };
      }
      const short = /^(\d{1,2})[-/.](\d{1,2})$/.exec(body);
      if (short !== null) {
        const month = Number(short[1]);
        const day = Number(short[2]);
        if (month < 1 || month > 12 || day < 1 || day > 31) return { value: null, ok: false, reason: 'bad-date' };
        let date = parseDay(`${base.getFullYear()}-${pad2(month)}-${pad2(day)}`);
        if (date === null) return { value: null, ok: false, reason: 'bad-date' };
        if (date.getTime() < base.getTime()) date = parseDay(`${base.getFullYear() + 1}-${pad2(month)}-${pad2(day)}`);
        return { value: withTime(date), ok: true };
      }
      if (Object.prototype.hasOwnProperty.call(DATE_ALIASES, body)) {
        const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + DATE_ALIASES[body]);
        return { value: withTime(date), ok: true };
      }
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

    function parseQuickTasks(text, options = {}) {
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

    function parseWeeks(expr) {
      const empty = { weeks: [], parity: 'all', ok: false };
      if (typeof expr !== 'string') return empty;
      let text = expr.trim();
      if (text === '') return empty;
      let parity = 'all';
      if (/[（(]?\s*单\s*周?\s*[)）]?\s*$/.test(text)) {
        parity = 'odd';
        text = text.replace(/[（(]?\s*单\s*周?\s*[)）]?\s*$/, '');
      } else if (/[（(]?\s*双\s*周?\s*[)）]?\s*$/.test(text)) {
        parity = 'even';
        text = text.replace(/[（(]?\s*双\s*周?\s*[)）]?\s*$/, '');
      }
      const weeks = new Set();
      const parts = text.split(/[,，、;；\s]+/).filter((p) => p !== '');
      if (parts.length === 0) return empty;
      for (const part of parts) {
        const range = /^(\d{1,2})\s*[-–~至]\s*(\d{1,2})$/.exec(part);
        if (range !== null) {
          const start = Number(range[1]);
          const end = Number(range[2]);
          if (start < 1 || end < 1 || end < start || end > 60) return { ...empty, parity };
          for (let w = start; w <= end; w += 1) weeks.add(w);
          continue;
        }
        const single = /^(\d{1,2})$/.exec(part);
        if (single !== null) {
          const week = Number(single[1]);
          if (week < 1 || week > 60) return { ...empty, parity };
          weeks.add(week);
          continue;
        }
        return { ...empty, parity };
      }
      const list = [...weeks].sort((a, b) => a - b).filter((w) => (parity === 'odd' ? w % 2 === 1 : parity === 'even' ? w % 2 === 0 : true));
      if (list.length === 0) return { ...empty, parity };
      return { weeks: list, parity, ok: true };
    }

    /**
     * 把用户输入的别名串拆成数组。
     *
     * 只按标点拆（逗号、顿号、分号），**不按空格拆**：别名里带空格是正常的
     * （例如「大学 物理」），按空格拆会把它变成两个无意义的别名。
     * 去空、去重、限长交给服务端 `normalizeAliases` 再兜一遍，这里只求「不丢内容」。
     */
    function parseAliasInput(text) {
      if (typeof text !== 'string') return [];
      return text.split(/[,，、;；]+/).map((part) => part.trim()).filter((part) => part !== '');
    }

    function isWeekActive(course, week) {
      if (!Number.isInteger(week) || week < 1) return false;
      // 与 lib/core.js 的 isWeekActive 保持一致：有 sessions 就按 sessions 判，
      // 没有 sessions 时回退到课程自己顶层声明的 weeks。
      // （手改 课程.json 成 {"id":"c1","weeks":"1-16"} 时，宿主工具会认为今天有课，
      //   客户端若不回退就会说没课 —— 两边结论不一致。）
      if (Array.isArray(course?.sessions)) {
        return course.sessions.some((session) => {
          const parsed = parseWeeks(session?.weeks);
          return parsed.ok && parsed.weeks.includes(week);
        });
      }
      const parsed = parseWeeks(course?.weeks);
      return parsed.ok && parsed.weeks.includes(week);
    }

    function currentTeachingWeek(term, date) {
      const start = parseDay(term?.startDate);
      const day = parseDay(date);
      if (start === null || day === null) return { week: 0, inTerm: false, reason: 'bad-date' };
      const totalWeeks = Number.isInteger(term?.totalWeeks) && term.totalWeeks > 0 ? term.totalWeeks : 0;
      const offset = Math.floor((day.getTime() - start.getTime()) / 86400000);
      if (offset < 0) return { week: 0, inTerm: false, reason: 'before-term' };
      const week = Math.floor(offset / 7) + 1;
      if (totalWeeks > 0 && week > totalWeeks) return { week: totalWeeks + 1, inTerm: false, reason: 'after-term' };
      return { week, inTerm: true };
    }

    function parseDue(value) {
      if (isDateLike(value)) return value;
      if (typeof value !== 'string') return null;
      const day = parseDay(value);
      if (day === null) return null;
      const time = /(\d{1,2}):(\d{2})/.exec(value);
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

    function isSameDay(a, b) {
      const x = parseDay(a);
      const y = parseDay(b);
      return x !== null && y !== null && x.getTime() === y.getTime();
    }

    function deadlineUrgency(task, now) {
      if (task?.status === 'done' || task?.status === 'dropped') return { level: 'done', days: null };
      const due = parseDue(task?.due);
      if (due === null) return { level: 'unknown', days: null };
      const current = isDateLike(now) ? now : new Date();
      const diffMs = due.getTime() - current.getTime();

      // ⚠️ `days` 的口径必须与 lib/core.js 完全一致，否则同一件事在宿主工具
      //    和界面上会显示成不同数字。core 的口径是
      //        Math.floor((due 时刻 − now) / 一天)
      //    即「不足一天算一天」：截止今天 23:59、现在今天 09:00 → 0（今天到期）；
      //    截止今天 08:00（已过）、现在今天 09:00 → −1（逾期 1 天）；
      //    截止昨天 → −1；截止前天 → −2。
      //    注意 due 只有日期时会被 parseDue 解析成当日 23:59:59（见 parseDue）。
      const days = Math.floor(diffMs / 86400000);

      if (diffMs < 0) return { level: 'overdue', days };
      if (isSameDay(due, current)) return { level: 'today', days: 0 };
      if (days <= 3) return { level: 'soon', days };
      return { level: 'later', days };
    }

    const URGENCY_RANK = { overdue: 0, today: 1, soon: 2, later: 3, unknown: 4, done: 5 };

    function compareTasksByDue(a, b, now) {
      const ua = deadlineUrgency(a, now);
      const ub = deadlineUrgency(b, now);
      if (URGENCY_RANK[ua.level] !== URGENCY_RANK[ub.level]) return URGENCY_RANK[ua.level] - URGENCY_RANK[ub.level];
      const da = parseDue(a?.due);
      const db = parseDue(b?.due);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da.getTime() - db.getTime();
    }

    // ---- 已完结条目的排序：与 lib/core.js 的同名算法逐项一致（tests/client.test.js 会比对） ----

    /** status 为 done/dropped 的任务算「已完结」（与 deadlineUrgency 的判定同一口径）。 */
    function isClosedTask(task) {
      return task?.status === 'done' || task?.status === 'dropped';
    }

    /**
     * 解析带时间的戳（`doneAt` 这类 ISO 串，也接受「YYYY-MM-DD HH:mm」）。
     * 返回**毫秒数**：core 版也返回数字，逐项比对才稳（返回 Date 会因对象身份而假失败）。
     */
    function parseTimestamp(value) {
      if (isDateLike(value)) return value.getTime();
      if (typeof value !== 'string' || value.trim() === '') return null;
      const ms = Date.parse(value.trim());
      return Number.isNaN(ms) ? null : ms;
    }

    /**
     * 已完结条目的排序：按完成时间**倒序**（最近完成的排最前）。
     *
     * 缺 doneAt 的排在后面，仍分不出先后时按截止日倒序，最后返回 0 保持原序 ——
     * 宁可少排一层，也不要把顺序打乱成随机的。
     */
    function compareClosedTasksByDoneAtDesc(a, b) {
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
     * 「截止列表」的统一比较器：未完结的按紧急度排（逾期最前），
     * 已完结的沉底、组内按完成时间倒序 —— 刚做完的那条排在最上面。
     */
    function compareDeadlineList(a, b, now) {
      if (isClosedTask(a) && isClosedTask(b)) return compareClosedTasksByDoneAtDesc(a, b);
      return compareTasksByDue(a, b, now);
    }

    /**
     * 已完结条目显示的完成时间（界面专用，core.js 没有对应版：
     * core 只被宿主工具用，不需要给用户看「什么时候做完的」）。
     * 解析不了就返回空串，行里自然不会多出一段空白。
     */
    function formatDoneAt(value) {
      const ms = parseTimestamp(value);
      if (ms === null) return '';
      const at = new Date(ms);
      return `完成 ${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    }

    // 任务里只存 courseId，科目名每次从课程.json 现算。
    // 不把课名冗余写进任务：课名改了以后，冗余字段不会跟着改，列表里就会出现旧名字。
    function courseNameIndex(docs) {
      const list = Array.isArray(docs?.courses?.courses) ? docs.courses.courses : [];
      return new Map(list.map((course) => [course.id, course.name]));
    }

    // 名字故意不叫 courseNameOf：学习台相关组件里各自有一个同名单参版本，
    // 重名会让人以为它们是同一个函数。
    function courseNameIn(index, courseId) {
      if (courseId === null || courseId === undefined) return '';
      return index.get(courseId) ?? '';
    }

    function scoreToGpa4(score) {
      if (typeof score !== 'number' || !Number.isFinite(score)) return null;
      if (score < 60) return 0;
      return Math.min(4, Math.round(((score - 50) / 10) * 100) / 100);
    }

    function gradeToGpa4(grade) {
      switch (grade) {
        case '优秀': case 'A': case 'A+': return 4;
        case '良好': case 'B': case 'B+': return 3;
        case '中等': case 'C': case 'C+': return 2;
        case '及格': case 'D': return 1;
        case '不及格': case 'F': return 0;
        default: return null;
      }
    }

    function computeGpa(grades) {
      const list = Array.isArray(grades?.courses) ? grades.courses : [];
      let weighted = 0;
      let creditSum = 0;
      let scoreWeighted = 0;
      let scoreCreditSum = 0;
      const skipped = [];
      for (const item of list) {
        if (item === null || typeof item !== 'object') {
          // 与 core.js 一致：坏条目也要带 courseId 字段，
          // 否则 GradesTab 的 nameOf(s.courseId) 会把它渲染成「—（缺分数）」，误导用户。
          skipped.push({ courseId: null, reason: 'bad-entry' });
          continue;
        }
        const gpa = typeof item.score === 'number' ? scoreToGpa4(item.score) : gradeToGpa4(item.grade);
        if (gpa === null) {
          skipped.push({ courseId: item.courseId ?? null, reason: 'no-score' });
          continue;
        }
        // Number.isFinite 是必需的：JSON 里的 1e999 会被解析成 Infinity，
        // core.js 会把它当「缺学分」跳过，客户端若只看 > 0 就会算出 credits: Infinity。
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
        skipped,
      };
    }

    // ---------------------------------------------------------------------
    // 数据通道
    // ---------------------------------------------------------------------

    const cache = { at: 0, value: null };
    // 文档级 sha256 单独保存：写操作要用它做乐观并发控制，
    // 不能跟着数据缓存一起失效（否则「读-改-写」第二次起就会误报冲突）。
    const hashes = {};

    function rememberHashes(payload) {
      for (const key of ['term', 'courses', 'tasks', 'grades', 'homework']) {
        if (typeof payload?.hashes?.[key] === 'string') hashes[key] = payload.hashes[key];
      }
    }

    /**
     * 非 JSON 响应的统一措辞。
     *
     * 404 必须单独说清楚：它几乎从来不是「网络抖动」，而是**请求的路径在宿主上没挂** ——
     * 插件没加载成功，或者插件改完还没重启 DSH（宿主只在启动时装配路由，改代码不会热更）。
     * 真机吃过这一口：`/learn/*` 的路由没注册，界面只报「接口返回了非 JSON 内容（HTTP 404）」，
     * 完全看不出该往哪儿查。
     */
    function nonJsonError(response) {
      if (response.status === 404) {
        return new Error('接口不存在（HTTP 404）：插件可能没加载成功，或改动后还没重启 DSH。');
      }
      return new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
    }

    async function fetchState(options = {}) {
      if (!options.force && cache.value !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
      const response = await fetch(`${API}/state`, { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => null);
      if (payload === null) throw nonJsonError(response);
      // 降级容错：HTTP 200 + `ok:false` 且**带着 docs** 说明是「部分文档有问题」，
      // 而不是「整次请求失败」。这种情况要把完好的数据渲染出来，靠 problems 提示，
      // 而不是抛错把三份好数据一起挡在门外。
      const degraded = payload.ok !== true && payload.docs !== undefined && payload.docs !== null;
      if (payload.ok !== true && !degraded) throw new Error(payload.error ?? `HTTP ${response.status}`);
      cache.at = Date.now();
      cache.value = payload;
      rememberHashes(payload);
      return payload;
    }

    async function mutate(doc, action, body) {
      const payload = { doc, action, ...body };
      // 带上最近一次读取到的 hash 做乐观并发控制
      if (payload.expectedHash === undefined && typeof hashes[doc] === 'string') payload.expectedHash = hashes[doc];
      const response = await fetch(`${API}/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (!result.ok) {
        const messages = {
          conflict: '数据已被其他程序修改，请点「重试」重新读取后再操作。',
          'course-in-use': '该课程仍被任务或成绩引用，先处理引用再删除。',
          'need-request-header': '请求被拒绝：缺少安全请求头。',
          'cross-site-rejected': '请求被拒绝：来源不可信。',
          'title-required': '任务标题不能为空。',
          'name-required': '名称不能为空。',
          'courseId-required': '请先选择课程。',
        };
        throw new Error(messages[result.error] ?? result.error ?? `HTTP ${response.status}`);
      }
      cache.value = null; // 让下一次读取回到磁盘
      if (typeof result.hash === 'string') hashes[doc] = result.hash; // 让下一次写仍能带上正确的前置条件
      return result;
    }

    async function resetDoc(doc) {
      const response = await fetch(`${API}/reset-doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ doc, confirm: true }),
      });
      const result = await response.json().catch(() => null);
      if (result === null || !result.ok) throw new Error(result?.error ?? `HTTP ${response.status}`);
      cache.value = null;
      return result;
    }

    /**
     * 网络学堂同步请求。
     *
     * 走的是 `/learn/*` 而不是 `/mutate`，因为一次同步在服务端是**一次读、一次写**的
     * 事务；逐条走 mutate 会在中途失败时留下半截结果。
     */
    async function learnPost(route, body) {
      const response = await fetch(`${API}/learn/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify(body ?? {}),
      });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (!result.ok) throw new Error(learnErrorText(result.error, response.status));
      return result;
    }

    /**
     * `/learn/*` 的错误码 → 界面上的中文。
     *
     * 抽成函数是因为「检查更新」用 GET、其余用 POST，但错误码是同一套；
     * 两处各抄一份表迟早会漂。
     */
    function learnErrorText(error, status) {
      const code = String(error ?? '');
      const messages = {
          'need-cookie': '请先粘贴网络学堂的 Cookie。',
          'cookie-too-short': 'Cookie 看起来不完整，请把整条（要含 JSESSIONID）复制过来。',
          'cookie-invalid': 'Cookie 已失效，或请求被重定向到了登录页。请重新登录网络学堂后再复制。',
          'not-connected': '还没有连接网络学堂。',
          'need-semester': '没有指定要切换到哪个学期。',
          'learn-timeout': '访问网络学堂超时，检查网络后重试。',
          'learn-unreachable': '连不上网络学堂，确认当前能打开 learn.tsinghua.edu.cn。',
          'cross-site-rejected': '请求被拒绝：来源不可信。',
          'need-request-header': '请求被拒绝：缺少安全请求头。',
          // —— 会话自愈（续期 / 弹登录窗 / 关浏览器）专属 ——
          'edge-not-found': '没找到 Edge：自动续期靠它完成。也可以手动重新复制一次 Cookie。',
          'needs-manual-login': '学堂要求手动登录一次：点「打开登录窗口」登进去，勾上「信任浏览器」，之后就不用再管了。',
          'sso-timeout': '登录页迟迟没回到网络学堂，稍后再试，或点「打开登录窗口」手动登一次。',
          'browser-exited': '后台浏览器意外退出了，再点一次「立即续期」。',
          'no-websocket': '当前运行环境没有 WebSocket，没法驱动后台浏览器。',
          'profile-unusable': '专用浏览器目录不可用（可能被别的 Edge 占着），关掉残留窗口后重试。',
          'cdp-timeout': '后台浏览器响应超时，稍后重试。',
          'cdp-connect-failed': '连不上后台浏览器的调试端口，稍后重试。',
          'spawn-failed': '没能启动 Edge 进程。',
          'login-page-shape': '登录页结构和预期不一样（学堂可能改版了）。',
          'renewing': '上一次续期还在进行中，稍等一下。',
        };
        if (messages[code] !== undefined) return messages[code];
        if (code.startsWith('learn-http-')) return `网络学堂返回 HTTP ${code.slice('learn-http-'.length)}`;
        return code === '' ? `HTTP ${status}` : code;
    }

    async function learnStatus() {
      const response = await fetch(`${API}/learn/status`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null || result.ok !== true) return null;
      return result;
    }

    /**
     * 检查更新（只读）：平台上**改过截止时间**、本地还是旧值的那几条。
     *
     * 同步只做「补新条目 + todo 升级成 done」，已导入条目的 due 永远不会被平台纠正
     * —— 老师把截止日期往后放（补课作业 10-18 → 10-26）时界面会一直显示错的日期，
     * 所以单独开一个比对入口。写回走 `/learn/apply-updates`。
     */
    async function learnUpdates() {
      const response = await fetch(`${API}/learn/updates`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (result.ok !== true) throw new Error(learnErrorText(result.error, response.status));
      return result;
    }

    /**
     * 作业详情（只读，点开某条 DDL 时才调）。
     *
     * 详情页由宿主去网络学堂拉：客户端只递任务 id，不碰 Cookie、也不自己拼平台 URL。
     * 失败同样回 200 + `{ok:false,error}`（Cookie 过期、平台改版都算「正常返回」），
     * 所以这里**不抛异常**，把结果原样交给界面，让它在行内说清原因、退回本地字段。
     */
    async function learnDetail(taskId) {
      const response = await fetch(`${API}/learn/detail?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: 'bad-response', detail: null, local: null };
      return result;
    }

    /**
     * 一键开工：只负责「点火」——让宿主建一个新会话，把固定指令投进去。
     *
     * 面板这边不生成、不轮询、不存答案：会话里的 agent 会自己扫原题、取字、分题、
     * 出两份文件到 `<学科>/答案/`，中途回来找用户确认一轮。所以这里成功只代表「会话开起来了」。
     */
    async function homeworkSpawn(taskId) {
      const response = await fetch(`${API}/homework/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ taskId }),
      });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (result.ok !== true) throw new Error(homeworkSpawnError(result, response));
      return result;
    }

    /** 一键开工的错因翻成人话；认不出的码原样带出来，不编。 */
    function homeworkSpawnError(result, response) {
      const error = typeof result?.error === 'string' ? result.error : '';
      const map = {
        'missing-task': '没带上要处理的任务编号。',
        'bad-id': '任务编号不合法。',
        'unknown-task': '这条任务已经不在了，刷新页面再试。',
        'course-not-found': '这条任务没挂课程，先在学习台里给它选一门课。',
        'sessions-unavailable': '宿主没开放会话接口，一键开工用不了（重启 DSH 再试）。',
        'need-request-header': '请求被拒绝：缺少安全请求头。刷新页面再试。',
        'bad-json': '请求体不是合法 JSON。',
      };
      if (map[error] !== undefined) return map[error];
      if (response !== undefined && response.status === 403) return '请求被拒绝：缺少安全请求头。刷新页面再试。';
      if (error !== '') return `没能开起会话（${error}）`;
      return `没能开起会话（HTTP ${response?.status ?? '?'}）`;
    }

    /**
     * 会话状态（只读，不回 Cookie）。
     *
     * 插件里的 Cookie 是「一段时间不操作就失效」的那种，宿主每 30 分钟拿它验一次；
     * 这里读的就是那次验活的结果，另外附上「专用 Edge 在不在跑」。
     */
    async function learnSession() {
      const response = await fetch(`${API}/learn/session`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null || result.ok !== true) return null;
      return result;
    }

    /**
     * 提交件扫描（只读）。
     *
     * 判据写在 AGENTS.md：一条 DDL 只有在**用户本人**把「文件名同时含姓名与学号」的提交件
     * 放进 `<学科>/提交文件/` 时才该归档，我交付解答不算。扫描由宿主做，客户端只负责显示，
     * 因此这里没有任何写操作 —— 误判会把没做的事标成已完成，比漏判严重得多。
     */
    async function deliverablesScan() {
      const response = await fetch(`${API}/deliverables`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (result.ok !== true) throw new Error(result.error ?? `HTTP ${response.status}`);
      return result;
    }

    /**
     * 提交件归档（写 tasks）。
     *
     * items 省略时由宿主自己挑「唯一命中的 ready」并**一次事务写完**：逐条写会在中途失败时
     * 留下半截归档结果，用户还不知道哪条成了。返回的 archived / skipped 都要显示出来。
     */
    async function deliverablesArchive(items) {
      const response = await fetch(`${API}/deliverables/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify(items === undefined ? {} : { items }),
      });
      const result = await response.json().catch(() => null);
      if (result === null) throw nonJsonError(response);
      if (!result.ok) {
        const messages = {
          'need-request-header': '请求被拒绝：缺少安全请求头。',
          'cross-site-rejected': '请求被拒绝：来源不可信。',
          'bad-payload': '归档请求格式不对。',
          'too-many-items': '一次归档的条数过多，请分批处理。',
          conflict: '数据已被其他程序修改，请刷新后重试。',
        };
        throw new Error(messages[result.error] ?? result.error ?? `HTTP ${response.status}`);
      }
      cache.value = null; // 归档改了 tasks，下一次读取必须回磁盘
      if (typeof result.hash === 'string') hashes.tasks = result.hash;
      return result;
    }

    /**
     * 资料正文（只读，点开某份资料时才调）。
     *
     * `path` 用的是 `资料索引.json` 里那条记录的原样 `path`（不是 md 路径）——
     * md 到底在哪（全文 / 逐页 / 哪个档）由宿主按命名规则自己找，客户端不猜。
     * 一页一取：教材全文几百页，一次全塞进面板既慢又没必要。
     */
    async function materialText(materialPath, page) {
      const query = new URLSearchParams({ path: materialPath });
      if (Number.isInteger(page) && page > 0) query.set('page', String(page));
      const response = await fetch(`${API}/materials/text?${query.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: 'bad-response' };
      return result;
    }

    /**
     * 讲解：让宿主用「这一个知识点」的资料现场生成一档讲解，结果落盘缓存。
     *
     * 后端先看缓存：已有就直接回 `cached: true`（面板连点两下不会重复烧 token），
     * 要重生成显式传 `force`。三档指令原文在服务端，客户端只发档位键。
     */
    async function explainNode(nodeId, style, options = {}) {
      const response = await fetch(`${API}/knowledge/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ node: nodeId, style, force: options.force === true }),
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /**
     * 读某一份已生成的讲解正文（只读缓存）。
     *
     * 讲解清单只回元信息（档位/字数/时间），正文按需再取一次——
     * 9 份缓存还行，将来上百份时列表不该一次把全文拉完。
     */
    async function explainCached(nodeId, style) {
      const query = new URLSearchParams({ node: String(nodeId ?? '') });
      if (typeof style === 'string' && style !== '') query.set('style', style);
      const response = await fetch(`${API}/knowledge/explain?${query.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /**
     * 已生成讲解清单（只读）：`GET /knowledge/explain` 不带 node 的形态。
     *
     * 面板「讲解」视图用它一屏列出所有缓存，避免逐节点点三档才发现生成过什么。
     */
    async function explainList() {
      const response = await fetch(`${API}/knowledge/explain`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /**
     * 就某一个知识点提问（内嵌聊天，2026-10-24）。
     *
     * 与「讲解」不同：要带整段对话历史，服务端不落盘。面板每次把当前线程整段发过去，
     * 好处是无状态、刷新页面即清空，也不用担心两处写入打架。
     */
    async function chatNode(nodeId, messages) {
      const response = await fetch(`${API}/knowledge/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ node: nodeId, messages }),
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /** 聊天出错的说法：复用讲解那套人话，再补几条聊天专有的。 */
    function chatErrorMessage(result) {
      const error = String(result?.error ?? 'unknown');
      const extra = {
        'bad-messages': '消息格式不对，刷新面板再试',
        'too-many-messages': '这一轮对话太长了（上限 20 条），点「重新开始」清一下',
        'message-too-long': '单条消息太长了（上限 2000 字），拆短一点',
        'empty-message': '消息不能是空的',
        'last-must-be-user': '最后一条应该是你的提问',
        'llm-empty-response': '模型这次没说话，再问一次',
      };
      if (extra[error] !== undefined) return extra[error];
      return explainErrorMessage(result).split('讲解').join('聊天');
    }

    /** 讲解接口的错误说法：把错误码翻成「人话」，别把 `llm-xxx` 直接甩给用户。 */
    function explainErrorMessage(result) {
      const error = String(result?.error ?? 'unknown');
      const messages = {
        'llm-unavailable': '宿主没有挂模型，讲解通道不可用',
        'llm-rate-limit': '模型排队中（429），等一两分钟再点',
        'llm-timeout': '模型超时了，等一会儿再试',
        'llm-server': '模型服务出错，稍后再试',
        'llm-failed': '模型没有给出结果，再试一次',
        'node-missing': '这个节点在 知识点网络.json 里找不到了，刷新一下页面',
        'bad-style': '讲解档位不认识（只有 助教推导 / 考前速通 / 只给提示）',
        'cache-write-failed': '讲解生成好了，但缓存写不进磁盘',
      };
      const base = messages[error] ?? `讲解失败：${error}`;
      const detail = typeof result?.detail === 'string' && result.detail !== '' ? `（${result.detail.slice(0, 120)}）` : '';
      return base + detail;
    }

    /**
     * 全量导出：十一份文档 → 一个带校验和的 JSON（只读，不写盘）。
     *
     * 面板拿到 `bundle` 后自己存成文件；恢复时原样投回来。
     * 校验和在服务端算（`lib/backup.js`），客户端不掺和 —— 浏览器里没有可信的 sha256，
     * 而且「包坏没坏」这件事应该由写盘的那一方先验。
     */
    async function exportBackup() {
      const response = await fetch(`${API}/backup/export`, { headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /** 恢复：把导出的包写回十一份文档（覆盖同名文档，写前自动进 学习台/备份/）。 */
    async function restoreBackup(bundle) {
      const response = await fetch(`${API}/backup/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ bundle }),
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /** 读取全部数据；active 为 false 时不轮询（面板不在前台就停）。 */
    function useStudyData(active) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null });
      const alive = useRef(true);

      const load = useCallback(async (options) => {
        try {
          const payload = await fetchState(options);
          if (!alive.current) return;
          setState({ status: 'ready', data: payload, error: null });
        } catch (error) {
          if (!alive.current) return;
          setState((prev) => ({ status: 'error', data: prev.data, error: String(error?.message ?? error) }));
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load({});
        return () => {
          alive.current = false;
        };
      }, [load]);

      useEffect(() => {
        if (active !== true) return undefined;
        const timer = setInterval(() => load({ force: true }), 30000);
        return () => clearInterval(timer);
      }, [active, load]);

      const refresh = useCallback(() => {
        cache.value = null;
        return load({ force: true });
      }, [load]);

      return { ...state, refresh };
    }

    // ---------------------------------------------------------------------
    // 样式：只用主题令牌，跟随明暗主题
    // ---------------------------------------------------------------------

    const CSS = `
.sa-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:16px;line-height:1.75;font-family:inherit;position:relative;z-index:1;isolation:isolate;container-type:inline-size}
.sa-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.sa-head h2{margin:0;font-size:22px;font-weight:700;line-height:1.4;letter-spacing:.02em}
.sa-spacer{flex:1 1 auto}
.sa-tabs{display:flex;gap:4px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap}
.sa-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 13px;border-radius:max(var(--dsw-radius-md,8px),10px);cursor:pointer;font-size:14px;font-family:inherit;line-height:1.5;position:relative;transition:color .18s ease,background .18s ease,transform .22s cubic-bezier(.2,.8,.2,1)}
.sa-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:650}
.sa-tab::after{content:"";position:absolute;left:13px;right:13px;bottom:2px;height:2px;border-radius:999px;background:var(--dsw-alias-brand-primary);transform:scaleX(0);opacity:0;transition:transform .24s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
.sa-tab[aria-selected="true"]::after{transform:scaleX(1);opacity:1}
.sa-body{flex:1 1 auto;min-height:0;overflow:auto;padding:18px;scrollbar-gutter:stable}
.sa-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:max(var(--dsw-radius-md,8px),10px);padding:6px 11px;min-height:36px;cursor:pointer;font-size:14px;line-height:1.5;font-family:inherit;transition:background .18s ease,border-color .18s ease,color .18s ease,box-shadow .2s ease,transform .24s cubic-bezier(.2,.9,.25,1.25)}
.sa-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.sa-btn:active:not(:disabled),.sa-tab:active{transform:translateY(0) scale(.97);transition-duration:.08s}
.sa-btn:disabled{opacity:.5;cursor:default}
/* 强调态：不填品牌色底。系统主题里 brand-primary 与 label-primary 都偏深，
   填上去就是黑底黑字（用户 2026-10-21 明确说不要这种颜色），改成描边 + 加粗。 */
.sa-btn.primary{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);font-weight:600;box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.sa-card{border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-lg,12px),14px);padding:20px;margin-bottom:18px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.sa-card h3{margin:0 0 16px;font-size:19px;font-weight:700;line-height:1.5;letter-spacing:.015em;color:var(--dsw-alias-label-primary)}
.sa-muted{color:var(--dsw-alias-label-secondary)}
.sa-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sa-row:last-child{border-bottom:0}
.sa-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:14px;line-height:1.5;font-weight:500;border:1px solid currentColor;white-space:nowrap;flex-shrink:0}
.sa-pill.overdue{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
.sa-pill.today{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary))}
.sa-pill.soon{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary))}
.sa-pill.later,.sa-pill.unknown{color:var(--dsw-alias-label-secondary)}
.sa-pill.done{color:var(--dsw-alias-label-secondary)}
.sa-grid{display:grid;grid-template-columns:44px repeat(7,minmax(0,1fr));gap:6px;min-width:620px}
.sa-cell{min-height:60px;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);padding:5px;font-size:14px;overflow:hidden}
.sa-cell.head{min-height:auto;border:0;text-align:center;color:var(--dsw-alias-label-secondary);padding:2px}
.sa-cell.head.today{color:var(--dsw-alias-brand-primary);font-weight:600}
.sa-cell-date{font-size:14px;line-height:1.5}
.sa-cell.period{min-height:auto;border:0;color:var(--dsw-alias-label-secondary);text-align:right;padding-right:4px}
.sa-cell.empty{background:transparent}
.sa-course{background:var(--dsw-alias-bg-layer-2);border-radius:max(var(--dsw-radius-sm,4px),6px);padding:5px 6px;margin-bottom:4px;line-height:1.5}
.sa-stat{display:flex;gap:12px 26px;flex-wrap:wrap;margin-bottom:16px;padding:4px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.sa-stat div{min-width:76px;padding-right:22px;border-right:1px solid var(--dsw-alias-border-l1)}
.sa-stat div:last-child{border-right:0;padding-right:0}
.sa-stat b{display:block;font-size:32px;font-weight:700;line-height:1.3;margin-bottom:4px;letter-spacing:-.025em}
.sa-stat .sa-muted{font-size:14px}
.sa-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:max(var(--dsw-radius-md,8px),10px);padding:7px 10px;font-size:14px;line-height:1.5;font-family:inherit;min-width:0;max-width:100%;box-sizing:border-box;transition:border-color .18s ease,box-shadow .18s ease}
.sa-dock{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--dsw-alias-label-secondary);padding:2px 2px 0;flex-wrap:wrap}
.sa-kg-wrap{overflow:auto;max-height:52vh;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-lg,12px),14px);background:var(--dsw-alias-bg-base)}
.sa-kp-bar{display:flex;gap:2px;height:6px;margin-top:4px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;overflow:hidden}
.sa-kp-seg{background:var(--dsw-alias-label-primary);min-width:0}
.sa-kp-caret{flex:none;width:14px;opacity:.8;font-size:14px;text-align:center;transition:transform .22s cubic-bezier(.2,.8,.2,1)}
.sa-tree-row[data-open="true"]>.sa-kp-caret{transform:rotate(90deg)}
.sa-tree-row{border-radius:max(var(--dsw-radius-sm,4px),6px);transition:background .18s ease}
.sa-tree-row[data-depth="0"]>.sa-grow{font-size:15px;font-weight:650}
.sa-tree-row[data-depth="1"]>.sa-grow{font-weight:600}
.sa-kp-children{margin-left:7px;padding-left:7px;border-left:1px solid var(--dsw-alias-border-l1)}
/* 动效（2026-10-21 夜批3）：都做「短、小位移」——用户要的是丝滑，不是晃眼。
   页签切换淡入、树/章展开上浮、生成中的转圈、批量进度条平滑推进；
   系统设了「减少动态效果」就全关，只保留状态文字。 */
@keyframes sa-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes sa-rise{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
@keyframes sa-reveal{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
@keyframes sa-spin{to{transform:rotate(360deg)}}
@keyframes sa-indet{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
.sa-body>div{animation:sa-fade .26s cubic-bezier(.2,.8,.2,1)}
/* 视图切换过渡（2026-10-24）：树 / 导图 / 图 / 列表 / 讲解之间切换时重放一次淡入，
   比「整块瞬间换掉」更容易看出「我换了视图」。 */
.sa-kp-view{animation:sa-fade .2s cubic-bezier(.2,.8,.2,1)}
.sa-kp-children{animation:sa-rise .24s cubic-bezier(.2,.8,.2,1)}
.sa-kp-leaf,.sa-tree-row{animation:sa-reveal .2s cubic-bezier(.2,.8,.2,1) both}
.sa-spinner{display:inline-block;width:10px;height:10px;box-sizing:border-box;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-label-primary);border-radius:999px;animation:sa-spin .7s linear infinite;vertical-align:-1px;margin-right:5px}
.sa-progress{position:relative;height:4px;margin-top:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.sa-progress>i{display:block;height:100%;background:var(--dsw-alias-label-primary);transition:width .2s ease}
.sa-progress.indet>i{width:40% !important;animation:sa-indet 1.1s ease-in-out infinite}
/* 导图动效（2026-10-24）：连线像被「画」出来、节点错峰淡入。
   用 pathLength=1 让 dashoffset 与真实路径长度无关；错峰延迟由渲染层按顺序给。 */
@keyframes sa-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes sa-pop{from{opacity:0;transform:translateY(3px) scale(.94)}to{opacity:1;transform:translateY(0) scale(1)}}
.sa-mind-link{stroke-dasharray:1;animation:sa-draw .55s cubic-bezier(.2,.8,.2,1) both}
.sa-mind-node{animation:sa-pop .28s cubic-bezier(.2,.8,.2,1) both}
@media (prefers-reduced-motion: reduce){
.sa-body>div,.sa-kp-view,.sa-kp-children,.sa-spinner,.sa-progress.indet>i,.sa-mind-link,.sa-mind-node{animation:none !important}
.sa-root *,.sa-dock *{animation:none !important;transition:none !important;scroll-behavior:auto !important}
.sa-btn:hover,.sa-btn:active,.sa-tab:hover,.sa-tab:active{transform:none !important}
}
/* 2026-10-23：保留背景与主题色；层次由字重、间距、细线建立。 */
.sa-root :is(button,input,select,textarea,a,summary):focus-visible,.sa-dock button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.sa-input:focus-visible{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.sa-root summary{cursor:pointer;line-height:1.6;padding:6px 0;font-weight:600}
.sa-root details[open]>summary{margin-bottom:8px}
.sa-root :is(p,pre){line-height:1.75}
.sa-root pre{overflow-wrap:anywhere}
.sa-row>.sa-grow{font-weight:500}
.sa-row>.sa-muted{font-size:14px;line-height:1.5}
.sa-card .sa-dock{margin-bottom:8px}
.sa-card .sa-dock h3{margin-bottom:0}
@media (hover:hover) and (prefers-reduced-motion:no-preference){
  .sa-btn:hover:not(:disabled),.sa-tab:hover{transform:translateY(-1px)}
  .sa-btn:active:not(:disabled),.sa-tab:active{transform:translateY(0) scale(.97)}
}
@media (hover:hover){
  .sa-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 32%,var(--dsw-alias-border-l1));box-shadow:0 2px 6px color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
  .sa-tree-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
}
@container (max-width:560px){
  .sa-head{padding:12px;flex-wrap:wrap}
  .sa-head h2{font-size:20px}
  .sa-tabs{padding:6px 8px;gap:2px}
  .sa-tab{padding:7px 10px}
  .sa-body{padding:12px}
  .sa-card{padding:12px;margin-bottom:12px}
  .sa-row{flex-wrap:wrap;gap:6px 8px}
  .sa-row>.sa-grow{white-space:normal;overflow-wrap:anywhere;flex-basis:45%}
  .sa-stat{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  .sa-stat div{min-width:0;padding-right:8px}
  .sa-stat b{font-size:24px}
}
.sa-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
.sa-textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;font-family:inherit;white-space:pre-wrap}

/* 阅读与层级升级：保留背景，用文字层级与细线组织内容。 */
.sa-section-title{font-size:18px;font-weight:700;line-height:1.5;color:var(--dsw-alias-label-primary);margin:20px 0 10px;display:block}
.sa-dock>.sa-section-title{margin:0 12px 0 0}
.sa-node-detail>.sa-dock:first-child{padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}
.sa-card.sa-node-detail>.sa-dock:first-child>h3.sa-detail-title{font-size:22px;font-weight:700;line-height:1.45;color:var(--dsw-alias-label-primary);white-space:normal;overflow-wrap:anywhere}
.sa-reading{max-width:80ch;font-size:16px;line-height:1.85;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sa-reading p{margin:12px 0 0!important;font-size:16px!important;line-height:1.85!important}
.sa-reading .sa-section-title{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-reading .sa-dock:first-child>.sa-section-title{border:0;padding-top:0}
.sa-reading .sa-example{padding:16px!important;margin-top:12px!important;border-radius:max(var(--dsw-radius-md,8px),10px)!important}
.sa-example-step{font-size:16px!important;line-height:1.85;color:var(--dsw-alias-label-primary);margin-top:8px!important}
.sa-example-answer{font-size:17px!important;font-weight:700;line-height:1.7;margin-top:12px!important;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-reading .sa-grow{white-space:normal;overflow:visible;overflow-wrap:anywhere}
.sa-reading .sa-formula{font-size:16px!important;line-height:1.8;padding:12px 14px!important;overflow:auto}
.sa-reading-pre{font-size:16px!important;line-height:1.85!important;font-family:inherit!important;padding:16px!important;max-width:80ch;box-sizing:border-box;overflow-wrap:anywhere}
.sa-chat-message{font-size:16px!important;line-height:1.8!important;padding:12px 16px!important;border-radius:max(var(--dsw-radius-md,8px),10px)!important;overflow-wrap:anywhere}
.sa-textarea{font-size:16px;padding:10px 12px;border-radius:max(var(--dsw-radius-md,8px),10px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.sa-card>.sa-dock:first-child>.sa-grow:first-child{font-size:18px;font-weight:700;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:normal}
.sa-tree-canvas{padding:16px;min-width:0;box-sizing:border-box}
.sa-tree-canvas .sa-tree-row{padding:10px 8px;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:0}
.sa-tree-canvas .sa-kp-branch,.sa-tree-canvas .sa-kp-leaf{position:relative}
.sa-kp-children{margin-left:18px;padding-left:24px;border-left:2px solid var(--dsw-alias-border-l1)}
.sa-kp-children>.sa-kp-branch::before,.sa-kp-children>.sa-kp-leaf::before{content:"";position:absolute;left:-24px;top:25px;width:22px;border-top:2px solid var(--dsw-alias-border-l1)}
.sa-tree-canvas .sa-tree-row>.sa-grow{white-space:normal;overflow-wrap:anywhere;flex-basis:180px}
.sa-tree-canvas .sa-tree-row[data-depth="0"]{margin-top:10px;border-bottom:2px solid var(--dsw-alias-border-l1)}
.sa-tree-canvas .sa-tree-row[data-depth="0"]>.sa-grow{font-size:20px;font-weight:700}
.sa-tree-canvas .sa-tree-row[data-depth="1"]>.sa-grow{font-size:18px;font-weight:700}
.sa-tree-canvas .sa-tree-row[data-depth="2"]>.sa-grow{font-size:17px;font-weight:600}
.sa-tree-canvas .sa-tree-row[data-depth="3"]>.sa-grow{font-size:16px;font-weight:600}
.sa-tree-kind{font-size:14px;color:var(--dsw-alias-label-secondary);min-width:2.5em}
.sa-tree-canvas .sa-kp-leaf>.sa-row{padding:10px 8px;border-bottom:0}
.sa-tree-canvas .sa-kp-leaf .sa-grow{white-space:normal;overflow-wrap:anywhere;font-size:16px;font-weight:500}
.sa-mind-node:focus-visible{outline:none}
.sa-mind-node:focus-visible rect{stroke:var(--dsw-alias-brand-primary);stroke-width:3}
@container (max-width:560px){
 .sa-tree-canvas{padding:10px}
 .sa-kp-children{margin-left:10px;padding-left:14px}
 .sa-kp-children>.sa-kp-branch::before,.sa-kp-children>.sa-kp-leaf::before{left:-14px;width:12px}
 .sa-reading{max-width:100%}
 .sa-card.sa-node-detail>.sa-dock:first-child>h3.sa-detail-title{font-size:20px}
}


/* 左树右文：独立滚动，窄屏选点后折叠目录，不缩小正文。 */
.sa-learning-layout{display:grid;grid-template-columns:minmax(270px,32%) minmax(0,1fr);gap:16px;align-items:stretch;height:clamp(420px,72vh,860px);margin-bottom:18px;min-width:0}
.sa-browser-pane{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-lg,12px),14px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sa-browser-head{display:flex;flex-wrap:wrap;gap:8px;padding:14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center}
.sa-browser-caption{width:100%;display:flex;flex-direction:column;gap:4px}
.sa-browser-caption strong{font-size:17px;line-height:1.5}
.sa-browser-caption .sa-muted{font-size:14px}
.sa-browser-content{display:flex;flex-direction:column;min-height:0;flex:1}
.sa-compact-scroll{overflow:auto;flex:1;min-height:0;padding:10px 12px;scrollbar-gutter:stable;overscroll-behavior:auto}
.sa-compact-tree,.sa-compact-children{margin:0;padding:0;list-style:none}
.sa-compact-children{margin-left:8px;padding-left:12px;border-left:1px solid var(--dsw-alias-border-l1)}
.sa-compact-toggle,.sa-compact-point{display:flex;align-items:flex-start;gap:6px;width:100%;box-sizing:border-box;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:15px;line-height:1.6;padding:7px 5px;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.sa-compact-toggle:hover,.sa-compact-point:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.sa-compact-name,.sa-compact-point>span:last-child{flex:1;min-width:0;overflow-wrap:anywhere}
.sa-compact-arrow,.sa-compact-dot{flex:none;width:12px;color:var(--dsw-alias-label-secondary)}
.sa-compact-count{font-size:13px;color:var(--dsw-alias-label-secondary);flex:none;padding-top:2px}
.sa-compact-branch[data-kind="course"]>.sa-compact-toggle{font-size:17px;font-weight:700;padding-bottom:10px}
.sa-compact-branch[data-kind="chapter"]>.sa-compact-toggle{font-size:16px;font-weight:650}
.sa-compact-branch[data-kind="section"]>.sa-compact-toggle{font-weight:600}
.sa-compact-point[aria-current="true"]{box-shadow:inset 3px 0 var(--dsw-alias-brand-primary);font-weight:650;padding-left:8px}
.sa-reader-pane{overflow:auto;min-width:0;min-height:0;scrollbar-gutter:stable;overscroll-behavior:auto;border-radius:max(var(--dsw-radius-lg,12px),14px)}
.sa-reader-pane>.sa-node-detail{margin-bottom:0;min-height:100%;box-sizing:border-box}
.sa-reader-pane .sa-reading{max-width:100%}
.sa-reader-pane .sa-reading-pre{max-height:none!important;overflow:visible!important;max-width:100%}
.sa-reader-pane .sa-reading img{max-width:100%;height:auto}
.sa-reader-empty{min-height:100%;box-sizing:border-box;margin-bottom:0;padding:28px}
.sa-reader-empty p{line-height:1.8;max-width:45ch}
.sa-browser-toggle{display:none}
.sa-learning-layout[data-full-browser="true"]{grid-template-columns:minmax(0,1fr)}
.sa-learning-layout[data-full-browser="true"]>.sa-reader-pane{display:none}
.sa-full-browser{min-height:0;height:100%;display:flex;flex-direction:column}
.sa-full-browser>.sa-card{border:0;box-shadow:none;margin:0;min-height:0;height:100%;box-sizing:border-box;display:flex;flex-direction:column}
.sa-full-browser .sa-kg-wrap{flex:1;min-height:0;max-height:none!important}
@container (max-width:860px){
 .sa-learning-layout{display:flex;flex-direction:column;height:auto;gap:12px}
 .sa-browser-toggle{display:inline-flex}
 .sa-browser-content{height:clamp(160px,32vh,320px);flex:none}
 .sa-learning-layout[data-browser-collapsed="true"]:not([data-full-browser="true"]) .sa-browser-content{display:none}
 .sa-learning-layout[data-full-browser="true"] .sa-browser-content{height:62vh}
 .sa-reader-pane{overflow:visible;max-height:none}
 .sa-reader-empty{min-height:180px}
}
@media print{
 .sa-learning-layout{display:block!important;height:auto!important}
 .sa-browser-pane{display:none!important}
 .sa-reader-pane{display:block!important;overflow:visible!important}
.sa-learning-layout[data-full-browser="true"] .sa-browser-pane{display:block!important}
.sa-learning-layout[data-full-browser="true"] .sa-reader-pane{display:none!important}
.sa-full-browser,.sa-browser-content,.sa-compact-scroll{height:auto!important;overflow:visible!important}
}

/* 打印：只印当前页签的内容。页签栏、按钮、输入框、内嵌滚动区在纸上没有意义，
   一律藏掉；卡片不让跨页断开，「资料正文/知识画布」这类限高容器在纸上要全展开。 */
@media print{
  .sa-tabs,.sa-btn,.sa-input,.sa-textarea,.sa-muted.sa-print-hide{display:none !important}
  .sa-root{height:auto !important;min-height:0 !important;background:#fff !important;color:#000 !important}
  .sa-body{overflow:visible !important}
  .sa-card{break-inside:avoid;page-break-inside:avoid;border-color:#bbb !important;box-shadow:none !important;background:#fff !important}
  .sa-kg-wrap{max-height:none !important;overflow:visible !important}
  .sa-head{border-bottom:1px solid #bbb}
  .sa-pill{border:1px solid #999 !important;background:#fff !important;color:#000 !important}
}
`;

    // ---------------------------------------------------------------------
    // 小工具组件
    // ---------------------------------------------------------------------

    /**
     * 把样式表挂到 document.head，而不是渲染进槽位。
     *
     * 为什么必须这样：把样式表当作 JSX 节点渲染进 main 槽时，这个 style 元素
     * 会成为**主面板列的直接子元素**。实测（用户探针 m02223）它被 flex 拉伸成
     * `1152×928` —— 和整列一样大，于是主面板那一格在视觉上只剩一片空白，
     * 而且 `document.querySelector('.sa-root')` 会先命中它（style 也能带 class），
     * 让后续排查一直指向错误的节点。
     *
     * 副作用改为「渲染期注入」：React 的渲染阶段本该纯净，但这里的目标是
     * 让样式表彻底离开布局树，且不依赖 useEffect（离线测试环境里 effect 被跳过）。
     *
     * ⚠️ DSH 3 的客户端模块系统会回收「插件自己的样式」（`@deepseek-ai/dsh-client-modules`
     * `lib/client.js`）：`materialize()` 里 `claimStyles(id)` 把文档中**所有还没有
     * `data-plugin` 的 `<style>`** 认领给当时正在物化的那个插件，之后
     * `removeOwnedStyles(id)` 在该条目被替换（HMR）/回收（prune）时把它们删掉。
     * 老实现只用一个模块级布尔量记住「已经注入过」，样式一旦被别的插件认领走再删掉，
     * 重新渲染也不会再注入 —— 面板就永久裸奔（用户 m05520 的截图：整块没有任何样式）。
     *
     * 所以照官方包（`dsh-client-ui-locale` 等每个官方客户端包都这么写）的约定：
     *   1. `data-plugin` 预先写上自己的包名 —— 声明归属，别的插件认领不走；
     *   2. `data-plugin-css` 写 `<包名>/<组件名>` 当清单键，官方机制据此登记/恢复；
     *   3. 幂等判断看 **DOM 里这个节点还在不在**，而不是永不回退的布尔量：
     *      被删了就重新注入，任何清理路径都能自愈。
     */
    const STYLE_OWNER = 'dsh-study-assistant';
    const STYLE_TAG_ID = STYLE_OWNER + '/Style';
    let styleEl = null;

    /** 已注入的样式表还挂在文档上吗？（离线测试的假 DOM 没有 isConnected，按「还在」处理） */
    function styleAttached(el) {
      return el !== null && el.isConnected !== false;
    }

    function injectStyleOnce() {
      const doc = typeof document === 'undefined' ? undefined : document;
      if (doc === undefined || doc.head === null || doc.head === undefined) return;
      if (styleAttached(styleEl)) return;
      const existing = typeof doc.querySelector === 'function'
        ? doc.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')
        : null;
      if (existing !== null && existing !== undefined) {
        styleEl = existing;
        return;
      }
      const el = doc.createElement('style');
      el.setAttribute('data-study-assistant', '');
      el.setAttribute('data-plugin', STYLE_OWNER);
      el.setAttribute('data-plugin-css', STYLE_TAG_ID);
      el.textContent = CSS;
      doc.head.appendChild(el);
      styleEl = el;
    }

    function Style() {
      injectStyleOnce();
      return null;
    }

    function Pill({ level, children }) {
      return h('span', { className: `sa-pill ${level}` }, children);
    }

    function urgencyText(urgency) {
      if (urgency.level === 'overdue') return urgency.days === null ? TEXT.overdue : `逾期 ${-urgency.days} 天`;
      if (urgency.level === 'today') return TEXT.today;
      if (urgency.level === 'soon') return `还有 ${urgency.days} 天`;
      if (urgency.level === 'later') return `还有 ${urgency.days} 天`;
      if (urgency.level === 'done') return TEXT.done;
      return TEXT.unknown;
    }

    /** 课程选择框（成绩页、任务页共用）。 */
    function CourseSelect({ courses, value, onChange }) {
      return h(
        'select',
        { className: 'sa-input', value: value ?? '', onChange: (event) => onChange(event.target.value || null) },
        h('option', { value: '' }, '（不关联课程）'),
        ...courses.map((course) => h('option', { key: course.id, value: course.id }, course.name)),
      );
    }

    // ---------------------------------------------------------------------
    // 页签：今日
    // ---------------------------------------------------------------------

    function TodayTab({ docs, now, refresh, onOpenKnowledgeReview, onOpenKnowledge, onOpenKnowledgeCoverage }) {
      const term = docs.term?.terms?.find((t) => t.id === docs.term?.currentId) ?? docs.term?.terms?.[0] ?? null;
      const week = currentTeachingWeek(term, now);
      const gpa = useMemo(() => computeGpa(docs.grades), [docs.grades]);
      const tasks = useMemo(() => (objectList(docs.tasks?.tasks)), [docs.tasks]);
      const active = useMemo(() => tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped'), [tasks]);
      const sorted = useMemo(() => [...active].sort((a, b) => compareTasksByDue(a, b, now)), [active, now]);
      const overdueCount = sorted.filter((t) => deadlineUrgency(t, now).level === 'overdue').length;
      const courseIndex = useMemo(() => courseNameIndex(docs), [docs.courses]);
      // 待复习知识点（2026-10-22 凌晨）：和「知识点」页签的待复习队列同一个纯函数，规则不会两处不一致
      const knowledgeDue = useMemo(() => {
        const nodes = objectList(docs.knowledgeNetwork?.nodes);
        return knowledgeReviewQueue(nodes);
      }, [docs.knowledgeNetwork]);
      // 队列空的时候也要能自证「规则在跑」：算出下一批什么时候到期
      const nextReviewAt = useMemo(() => {
        const nodes = objectList(docs.knowledgeNetwork?.nodes);
        return nextReviewDueAt(nodes, now instanceof Date ? now.getTime() : Date.now());
      }, [docs.knowledgeNetwork, now]);
      // 知识点详解进度（2026-10-24 傍晚）：分析线写一批、这里涨一格；第一屏就能看到还剩多少
      const analysisCoverageSummary = useMemo(() => {
        const nodes = objectList(docs.knowledgeNetwork?.nodes);
        const index = buildAnalysisPoints(docs.knowledgeAnalysis);
        return analysisCoverage(nodes, index);
      }, [docs.knowledgeNetwork, docs.knowledgeAnalysis]);
      // 本周复习了几个（2026-10-22 深夜）：复习完卡片会变空，没有回声；这行数字就是回声
      const reviewedThisWeek = useMemo(() => {
        const nodes = objectList(docs.knowledgeNetwork?.nodes);
        return countReviewedWithin(nodes, now instanceof Date ? now.getTime() : Date.now());
      }, [docs.knowledgeNetwork, now]);

      const todayCourses = useMemo(() => {
        if (!week.inTerm) return [];
        const weekday = isoWeekday(now);
        const courses = objectList(docs.courses?.courses);
        return courses
          .filter((course) => isWeekActive(course, week.week))
          .flatMap((course) => (Array.isArray(course.sessions) ? course.sessions : []).map((session) => ({ course, session })))
          .filter(({ session }) => Number(session?.weekday) === weekday)
          .sort((a, b) => Number(a.session?.startPeriod ?? 0) - Number(b.session?.startPeriod ?? 0));
      }, [docs.courses, week.inTerm, week.week, now]);

      return h(
        'div',
        null,
        h(Style),
        h(
          'div',
          { className: 'sa-stat' },
          h('div', null, h('b', null, week.inTerm ? String(week.week) : '—'), h('span', { className: 'sa-muted' }, '教学周')),
          h('div', null, h('b', null, String(active.length)), h('span', { className: 'sa-muted' }, '未完成')),
          h('div', null, h('b', { className: overdueCount > 0 ? 'sa-error' : undefined }, String(overdueCount)), h('span', { className: 'sa-muted' }, '已逾期')),
          h('div', null, h('b', null, gpa.gpa === null ? '—' : String(gpa.gpa)), h('span', { className: 'sa-muted' }, 'GPA')),
        ),
        term === null
          ? h('div', { className: 'sa-card sa-muted' }, TEXT.noTerm)
          : h('div', { className: 'sa-muted', style: { marginBottom: 10 } },
              `${term.name}　${formatDay(now)}　${TEXT.weekdays[isoWeekday(now)] ?? ''}` + (week.inTerm ? '' : term.startDate && parseDay(now) < parseDay(term.startDate) ? '（尚未开学）' : '（已放假）')),

        h('div', { className: 'sa-card' },
          h('h3', null, '今日课程'),
          todayCourses.length === 0
            ? h('div', { className: 'sa-muted' }, TEXT.noCourseToday)
            : todayCourses.map(({ course, session }, index) => h('div', { className: 'sa-row', key: `${course.id}-${index}` },
                h('span', { className: 'sa-grow' }, course.name),
                h('span', { className: 'sa-muted' }, session.startPeriod === session.endPeriod ? `第 ${session.startPeriod} 节` : `第 ${session.startPeriod}-${session.endPeriod} 节`),
                h('span', { className: 'sa-muted' }, session.location ?? ''),
              )),
        ),

        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock' },
            h('h3', { className: 'sa-grow' }, '待复习知识点'),
            h('span', { className: 'sa-muted' }, `${knowledgeDue.length} 个`),
            knowledgeDue.length > 0 && typeof onOpenKnowledgeReview === 'function'
              ? h('button', { className: 'sa-btn', onClick: onOpenKnowledgeReview }, '去复习')
              : null),
          knowledgeDue.length === 0
            ? h('div', { className: 'sa-muted' },
                '没有到期的知识点：掌握度到「精通」的不再提醒，其余距上次复习满 7 天才进队列（从没复习过的按建点时间算）。'
                + (nextReviewAt === null ? '' : ` 下一批 ${formatMonthDay(new Date(nextReviewAt))} 到期。`))
            : knowledgeDue.slice(0, 5).map((node) => h('div', {
                className: 'sa-row',
                key: node.id,
                // 点条目直接跳到那个知识点（以前只能「去复习」落在筛选结果里再找）
                style: typeof onOpenKnowledge === 'function' ? { cursor: 'pointer' } : null,
                title: typeof onOpenKnowledge === 'function' ? '点一下打开这个知识点' : null,
                onClick: typeof onOpenKnowledge === 'function' ? () => onOpenKnowledge(node.id) : undefined,
              },
                h('span', { className: `sa-pill ${node.marked ? 'today' : 'soon'}` }, node.marked ? '★' : `掌握度 ${Number(node.mastery) || 0}`),
                h('span', { className: 'sa-grow' }, node.name),
                h('span', { className: 'sa-muted', style: { fontSize: 14 } }, node.chapter ?? ''),
              )),
          knowledgeDue.length > 5
            ? h('div', { className: 'sa-muted', style: { fontSize: 14 } }, `还有 ${knowledgeDue.length - 5} 个，去「知识点」页签按待复习筛选看全部`)
            : null,
          // 复习的「回声」（2026-10-22 深夜）：复习完队列变短甚至清空，只剩「没有到期」会让人以为白干
          reviewedThisWeek > 0
            ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } }, `近 7 天复习过 ${reviewedThisWeek} 个`)
            : null,
        ),

        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock' },
            h('h3', { className: 'sa-grow' }, '知识点详解进度'),
            h('span', { className: 'sa-muted' },
              `${analysisCoverageSummary.covered} / ${analysisCoverageSummary.total}`),
            analysisCoverageSummary.missing > 0 && typeof onOpenKnowledgeCoverage === 'function'
              ? h('button', { className: 'sa-btn', onClick: onOpenKnowledgeCoverage }, '去写没写的')
              : null),
          h('div', { className: 'sa-progress' },
            h('i', { style: { width: `${analysisCoverageSummary.total === 0 ? 0 : Math.round((analysisCoverageSummary.covered / analysisCoverageSummary.total) * 100)}%` } })),
          h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
            analysisCoverageSummary.total === 0
              ? '知识网络里还没有知识点。'
              : analysisCoverageSummary.missing === 0
                ? '每个知识点都有预生成详解了。'
                : `还有 ${analysisCoverageSummary.missing} 个知识点没有详解（分析线下一批照着这个数往下写）。`),
        ),

        h('div', { className: 'sa-card' },
          h('h3', null, '临近截止'),
          sorted.length === 0
            ? h('div', { className: 'sa-muted' }, TEXT.noDeadline)
            : sorted.slice(0, 8).map((task) => {
                const urgency = deadlineUrgency(task, now);
                const subject = courseNameIn(courseIndex, task.courseId);
                return h('div', { className: 'sa-row', key: task.id },
                  h(Pill, { level: urgency.level }, urgencyText(urgency)),
                  h('span', { className: 'sa-grow' }, task.title),
                  // 科目单独占一格、且不参与伸缩：挤的时候先截断标题，而不是把科目吃掉
                  subject === '' ? null : h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, subject),
                  h('span', { className: 'sa-muted' }, task.due ?? '无截止日'),
                );
              }),
        ),
        h('div', null, h('button', { className: 'sa-btn', onClick: refresh }, '刷新')),
      );
    }

    // ---------------------------------------------------------------------
    // 页签：课表（周视图 + 录入）
    // ---------------------------------------------------------------------

    function ScheduleTab({ docs, now, refresh, busy, run, setBusy }) {
      const [week, setWeek] = useState(null);
      const term = docs.term?.terms?.find((t) => t.id === docs.term?.currentId) ?? docs.term?.terms?.[0] ?? null;
      const current = currentTeachingWeek(term, now);
      const shownWeek = week ?? (current.inTerm ? current.week : 1);
      const courses = objectList(docs.courses?.courses);

      const [draft, setDraft] = useState({ name: '', aliases: '', teacher: '', credits: '', weekday: '1', startPeriod: '1', endPeriod: '2', weeks: '1-16', location: '' });

      const grid = useMemo(() => {
        const maxPeriod = Math.max(12, ...courses.flatMap((c) => (c.sessions ?? []).map((s) => Number(s.endPeriod) || 0)));
        return { maxPeriod, rows: Array.from({ length: maxPeriod }, (_, i) => i + 1) };
      }, [courses]);

      // 表头展示这一周每天的日期，并高亮「今天」所在列
      const isTodayColumn = (weekday) => isSameDay(dateOfWeekday(term, shownWeek, weekday), now);
      const weekMonday = teachingWeekStart(term, shownWeek);
      const weekSunday = weekMonday === null ? null : new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() + 6);
      const weekRangeText = weekMonday === null || weekSunday === null
        ? ''
        : `${formatMonthDay(weekMonday)} – ${formatMonthDay(weekSunday)}`;

      const cellFor = (period, weekday) => courses.flatMap((course) =>
        (Array.isArray(course.sessions) ? course.sessions : [])
          .filter((session) => Number(session.weekday) === weekday
            && isWeekActive(course, shownWeek)
            && Number(session.startPeriod) <= period
            && Number(session.endPeriod) >= period)
          .map((session) => ({ course, session })));

      const addCourse = async () => {
        if (draft.name.trim() === '') return;
        setBusy(true);
        try {
          await run(() => mutate('courses', 'create', {
            item: {
              name: draft.name.trim(),
              aliases: parseAliasInput(draft.aliases),
              teacher: draft.teacher.trim(),
              credits: draft.credits === '' ? 0 : Number(draft.credits),
              sessions: [{
                weekday: Number(draft.weekday),
                startPeriod: Number(draft.startPeriod),
                endPeriod: Number(draft.endPeriod),
                weeks: draft.weeks,
                location: draft.location.trim(),
              }],
            },
          }));
          // 清掉别名：它和课程名一样是「这一门课的身份」，留给下一门课会静默挂错
          setDraft({ ...draft, name: '', aliases: '', location: '' });
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      /**
       * 改别名。用 prompt 而不是表单：别名是「偶尔补一条」的东西，
       * 为它常驻一个输入框会把添加课程那一行挤得更长。
       * 取消（null）与清空（''）要分开——取消不能把已有别名抹掉。
       */
      const editAliases = async (course) => {
        const current = Array.isArray(course.aliases) ? course.aliases : [];
        const input = window.prompt(
          `为「${course.name}」设置别名，用逗号或顿号分隔（例如：数电、数电实验）。\n留空则清除别名。`,
          current.join('、'),
        );
        if (input === null) return;
        setBusy(true);
        try {
          await run(() => mutate('courses', 'update', { id: course.id, item: { aliases: parseAliasInput(input) } }));
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const removeCourse = (course) => {
        if (!window.confirm(`删除课程「${course.name}」？`)) return;
        setBusy(true);
        // run() 会在设置顶部横幅后 rethrow；这里必须自己吞掉，
        // 否则失败时会变成未处理的 promise rejection（控制台报错）。
        run(() => mutate('courses', 'delete', { id: course.id }))
          .then(refresh)
          .catch(() => {})
          .finally(() => setBusy(false));
      };

      return h(
        'div',
        null,
        h(Style),
        h('div', { className: 'sa-row', style: { borderBottom: 0 } },
          h('button', { className: 'sa-btn', onClick: () => setWeek(Math.max(1, shownWeek - 1)) }, '上一周'),
          h('span', null,
            `第 ${shownWeek} 周`,
            weekRangeText === '' ? null : h('span', { className: 'sa-muted' }, `　${weekRangeText}`),
          ),
          h('button', { className: 'sa-btn', onClick: () => setWeek(shownWeek + 1) }, '下一周'),
          h('span', { className: 'sa-spacer' }),
          current.inTerm ? h('button', { className: 'sa-btn', onClick: () => setWeek(null) }, '回到本周') : null,
        ),
        h('div', { className: 'sa-card', style: { overflowX: 'auto' } },
          h('div', { className: 'sa-grid' },
            h('div', { className: 'sa-cell period' }),
            ...TEXT.weekdays.slice(1).map((name, index) => {
              const weekday = index + 1;
              const date = dateOfWeekday(term, shownWeek, weekday);
              const text = formatMonthDay(date);
              return h('div', { className: `sa-cell head${isTodayColumn(weekday) ? ' today' : ''}`, key: name },
                h('div', null, name),
                text === '' ? null : h('div', { className: 'sa-cell-date' }, text),
              );
            }),
            ...grid.rows.flatMap((period) => [
              h('div', { className: 'sa-cell period', key: `p${period}` }, String(period)),
              ...TEXT.weekdays.slice(1).map((_, index) => {
                const weekday = index + 1;
                const items = cellFor(period, weekday);
                return h('div', { className: `sa-cell${items.length === 0 ? ' empty' : ''}`, key: `c${period}-${weekday}` },
                  items.map(({ course, session }) => h('div', { className: 'sa-course', key: `${course.id}-${period}` },
                    h('div', null, course.name),
                    h('div', { className: 'sa-muted' }, session.location ?? ''),
                  )));
              }),
            ]),
          ),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '添加课程'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('input', { className: 'sa-input', placeholder: '课程名', value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '别名 如 数电、数电实验', style: { width: 170 }, value: draft.aliases, onChange: (e) => setDraft({ ...draft, aliases: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '教师', style: { width: 90 }, value: draft.teacher, onChange: (e) => setDraft({ ...draft, teacher: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '学分', style: { width: 60 }, value: draft.credits, onChange: (e) => setDraft({ ...draft, credits: e.target.value }) }),
            h('select', { className: 'sa-input', value: draft.weekday, onChange: (e) => setDraft({ ...draft, weekday: e.target.value }) },
              ...TEXT.weekdays.slice(1).map((name, index) => h('option', { key: name, value: String(index + 1) }, name))),
            h('input', { className: 'sa-input', placeholder: '起始节', style: { width: 66 }, value: draft.startPeriod, onChange: (e) => setDraft({ ...draft, startPeriod: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '结束节', style: { width: 66 }, value: draft.endPeriod, onChange: (e) => setDraft({ ...draft, endPeriod: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '周次 如 1-16 或 1-16单', style: { width: 170 }, value: draft.weeks, onChange: (e) => setDraft({ ...draft, weeks: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '地点', style: { width: 110 }, value: draft.location, onChange: (e) => setDraft({ ...draft, location: e.target.value }) }),
            h('button', { className: 'sa-btn primary', disabled: busy || draft.name.trim() === '', onClick: addCourse }, busy ? '保存中…' : '添加'),
          ),
          (() => {
            const parsed = parseWeeks(draft.weeks);
            if (draft.weeks.trim() !== '' && !parsed.ok) return h('div', { className: 'sa-error', style: { marginTop: 6 } }, '周次表达式无法识别，请用如 1-16、1-8,10-16、1-16单 的写法。');
            if (parsed.ok) return h('div', { className: 'sa-muted', style: { marginTop: 6 } }, `共 ${parsed.weeks.length} 周上课`);
            return null;
          })(),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, `课程列表（${courses.length}）`),
          courses.length === 0
            ? h('div', { className: 'sa-muted' }, TEXT.empty)
            : courses.map((course) => {
                const conflicts = [];
                for (const session of course.sessions ?? []) {
                  for (const other of courses) {
                    if (other.id === course.id) continue;
                    for (const otherSession of other.sessions ?? []) {
                      if (Number(otherSession.weekday) !== Number(session.weekday)) continue;
                      if (Number(otherSession.startPeriod) > Number(session.endPeriod) || Number(otherSession.endPeriod) < Number(session.startPeriod)) continue;
                      const a = parseWeeks(session.weeks);
                      const b = parseWeeks(otherSession.weeks);
                      if (a.ok && b.ok && a.weeks.some((w) => b.weeks.includes(w))) conflicts.push(other.name);
                    }
                  }
                }
                const unique = [...new Set(conflicts)];
                return h('div', { className: 'sa-row', key: course.id },
                  h('span', { className: 'sa-grow' },
                    course.name,
                    h('span', { className: 'sa-muted' }, `　${course.teacher ?? ''}${course.credits ? `　${course.credits} 学分` : ''}`),
                    (course.sessions ?? []).map((session, index) => h('span', { className: 'sa-muted', key: index },
                      `　${TEXT.weekdays[Number(session.weekday)] ?? ''} 第${session.startPeriod}-${session.endPeriod}节（${session.weeks}）${session.location ? ` ${session.location}` : ''}`,
                    )),
                    Array.isArray(course.aliases) && course.aliases.length > 0
                      ? h('span', { className: 'sa-muted' }, `　别名：${course.aliases.join('、')}`)
                      : null,
                  ),
                  unique.length > 0 ? h(Pill, { level: 'soon' }, `冲突：${unique.join('、')}`) : null,
                  h('button', { className: 'sa-btn', disabled: busy, onClick: () => editAliases(course) }, '别名'),
                  h('button', { className: 'sa-btn', disabled: busy, onClick: () => removeCourse(course) }, '删除'),
                );
              }),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 网络学堂同步卡片（挂在 DDL 页签顶部）
    // ---------------------------------------------------------------------

    /**
     * 连接网络学堂并把作业同步成本地任务。
     *
     * 交互刻意做成「先预览、再导入」两步：
     * 远端作业名和本地课程对不上的情况很常见，直接导入会让用户在一堆
     * courseId 为空的任务里自己找原因。预览把「会导入什么、哪门课没匹配上」
     * 摆在按钮前面，用户可以先补别名（设置页）或手动选课再导。
     */
    function LearnCard({ courses, busy, setBusy, refresh, run }) {
      const [status, setStatus] = useState(null);     // null = 还没读到
      const [session, setSession] = useState(null);   // 会话是否还有效 + 后台浏览器状态
      const [cookie, setCookie] = useState('');
      const [preview, setPreview] = useState(null);   // 预览结果
      const [updates, setUpdates] = useState(null);   // 「检查更新」的结果（null = 还没查过）
      const [notice, setNotice] = useState(null);

      const reloadStatus = useCallback(async () => {
        const next = await learnStatus();
        if (next !== null) {
          setStatus(next);
          if (next.session !== undefined) setSession(next.session);
        }
      }, []);

      const reloadSession = useCallback(async () => {
        const next = await learnSession();
        if (next !== null) setSession(next);
      }, []);

      useEffect(() => { reloadStatus(); }, [reloadStatus]);

      // 会话状态每 60 秒自己刷一次：心跳是服务端跑的（每 30 分钟一次），
      // 界面上看到的「几点验过」不该停在我打开面板的那一刻。
      // 正在等你手动登录时改 10 秒一次：那边一收到新票，这行字就该立刻
      // 从「等你登完」变成「已经接上」，不然你还得自己刷页面。
      const harvesting = session?.loginHarvesting === true;
      useEffect(() => {
        const timer = setInterval(() => { reloadSession(); }, harvesting ? 10000 : 60000);
        return () => clearInterval(timer);
      }, [reloadSession, harvesting]);

      const connected = status?.connected === true;

      const connect = async () => {
        if (cookie.trim() === '') return;
        setBusy(true);
        setNotice(null);
        setPreview(null);
        try {
          const result = await run(() => learnPost('connect', { cookie: cookie.trim() }));
          setCookie('');
          await reloadStatus();
          const unmatched = result.unmatched?.length ?? 0;
          setNotice({
            kind: unmatched > 0 ? 'warn' : 'ok',
            text: `已连接，识别到 ${result.counts.courses} 门课，其中 ${result.counts.matched} 门对应上了本地课程。`,
          });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const doFetch = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await run(() => learnPost('fetch', {}));
          setPreview(result);
          const bad = (result.diagnostics ?? []).filter((d) => d.error !== null && d.error !== undefined);
          if (bad.length > 0) {
            setNotice({ kind: 'warn', text: `${bad.length} 个接口没取到数据（${bad.map((d) => d.label).join('、')}），其余已正常读取。` });
          } else {
            setNotice({ kind: 'ok', text: `读到 ${result.counts.candidates} 条作业，其中 ${result.counts.fresh} 条还没导入过。` });
          }
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const doSync = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await run(() => learnPost('sync', {}));
          setPreview(null);
          const parts = [`已导入 ${result.imported} 条`];
          if (result.completed > 0) parts.push(`${result.completed} 条早就交过的补标为完成`);
          if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 条已导入过的`);
          if (result.rejected?.length > 0) parts.push(`${result.rejected.length} 条被拒绝`);
          setNotice({ kind: result.imported > 0 || result.completed > 0 ? 'ok' : 'warn', text: `${parts.join('，')}。` });
          await refresh();
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 检查更新：平台把截止时间改过、本地还留着旧值的条目。
       *
       * 只查不写 —— 差异列出来、用户点头之后才走 `applyUpdates`。
       * 同步本身不会纠正 due（它只补新条目、单向升级状态），所以这件事必须单开一步。
       */
      const checkUpdates = async () => {
        setBusy(true);
        setNotice(null);
        setUpdates(null);
        try {
          const result = await run(() => learnUpdates());
          setUpdates(result);
          setNotice(result.diffs.length === 0
            ? { kind: 'ok', text: `平台和本地的截止时间一致（比对了 ${result.compared} 条已导入的作业）。` }
            : { kind: 'warn', text: `平台的截止时间改过 ${result.diffs.length} 条，确认无误后点「按平台更新」。` });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 按平台更新截止时间。
       *
       * 服务端会**当场再拉一次**平台数据，所以这里传的 taskIds 只是「用户看过的那几条」，
       * 不是要写进去的日期 —— 写进去的一律以落盘那一刻的平台值为准。
       */
      const applyUpdates = async () => {
        if (updates === null || updates.diffs.length === 0) return;
        setBusy(true);
        setNotice(null);
        try {
          const result = await run(() => learnPost('apply-updates', { taskIds: updates.diffs.map((d) => d.taskId) }));
          setUpdates(null);
          if (result.updated > 0) {
            setNotice({ kind: 'ok', text: `已按平台更新 ${result.updated} 条的截止时间。` });
          } else {
            setNotice({ kind: 'muted', text: '再查一遍已经没有差异了（平台可能又改回去了）。' });
          }
          await refresh();
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const disconnect = async () => {
        if (!window.confirm('断开网络学堂连接？已导入的任务会保留，只是不再自动同步。')) return;
        setBusy(true);
        setNotice(null);
        setPreview(null);
        try {
          await run(() => learnPost('disconnect', {}));
          setNotice({ kind: 'ok', text: '已断开。已导入的任务都保留着。' });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        }
        await reloadStatus();
        setBusy(false);
      };

      /**
       * 换学期：让服务端用它**自己存的** Cookie 重拉课程并重做匹配。
       *
       * 界面拿不到 Cookie（`/learn/status` 刻意不回传），所以这件事只能服务端做。
       * 换完必须清掉预览 —— 那是上一个学期的清单，留着会让人以为已经读过新学期了。
       */
      const switchSemester = async (next) => {
        if (next === '' || next === (status?.semesterId ?? '')) return;
        setBusy(true);
        setNotice(null);
        setPreview(null);
        try {
          const result = await run(() => learnPost('semester', { semesterId: next }));
          await reloadStatus();
          const unmatched = result.counts.courses - result.counts.matched;
          setNotice({
            kind: unmatched > 0 ? 'warn' : 'ok',
            text: `已切到 ${result.semesterId}，识别到 ${result.counts.courses} 门课，其中 ${result.counts.matched} 门对应上了本地课程。`,
          });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 会话自愈：立刻续期 / 弹一个可见的登录窗口 / 关掉后台浏览器。
       *
       * 续期是让「专用 Edge」自己再走一遍统一身份认证换张新 Cookie。第一次（以及
       * 学堂那边的信任过期）时，登录页要图形验证码，这个必须人来 —— 所以留一个
       * 「打开登录窗口」的按钮兜底；登过一次并勾了「信任浏览器」之后，就能长时间
       * 静默续期了。
       */
      const renewSession = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await run(() => learnPost('renew', {}));
          await reloadStatus();
          await reloadSession();
          setNotice({
            kind: 'ok',
            text: result.source === 'existing'
              ? '当前会话还有效，验证时间已刷新（不用再粘 Cookie）。'
              : '已经换到新的会话了，之后照常同步即可。',
          });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
          await reloadSession();
        } finally {
          setBusy(false);
        }
      };

      const openLoginWindow = async () => {
        setBusy(true);
        setNotice(null);
        try {
          await run(() => learnPost('login-window', {}));
          await reloadSession();
          setNotice({ kind: 'warn', text: '已打开登录窗口：在那边登录网络学堂并勾选「信任浏览器」就行，这边会自动把新会话收下来。' });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const stopBrowser = async () => {
        setBusy(true);
        setNotice(null);
        try {
          await run(() => learnPost('browser-stop', {}));
          await reloadSession();
          setNotice({ kind: 'ok', text: '已关掉后台浏览器（登录态留在它的专用目录里，下次续期会接着用）。' });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 会话那行字：有效 / 失效 / 未知三态 + 后台浏览器在不在跑。
       *
       * 「失效」不是要用户做什么 —— 心跳会自己续期；只有学堂要验证码的那种失效才
       * 需要人点一下「打开登录窗口」，所以那句话要指向按钮，而不是「请重新复制 Cookie」。
       */
      const sessionLine = () => {
        if (session === null) return null;
        const when = typeof session.checkedAt === 'string' ? session.checkedAt.slice(11, 16) : '';
        const browser = session.browser?.running === true
          ? `后台浏览器在跑（${session.browser.mode === 'visible' ? '可见窗口' : '后台'}）`
          : '后台浏览器没在跑（用时会自动起）';
        // 正在盯着你手动登录：这时候最该说清「登完不用再点任何按钮」
        if (session.loginHarvesting === true) {
          return { kind: 'muted', text: '登录窗口开着：在那边登完（勾上「信任浏览器」）就行，这边会自动把新会话收下来，不用再点按钮。' };
        }
        if (session.alive === true) {
          // `cookie-only` = 票是好的，只是后台浏览器那条喂不动 SSO 了（SSO 掉得快、
          // 票的寿命长得多）。这时候照实说「能用」—— 判红是 2026-10-12 修掉的误报
          if (session.reason === 'cookie-only') {
            return { kind: 'muted', text: `会话有效${when === '' ? '' : `（${when} 验过）`}：学堂那边照样能同步（走直连）。后台浏览器那条要你哪天顺手点一次「打开登录窗口」登一遍，不登也不影响用。` };
          }
          return { kind: 'muted', text: `会话有效${when === '' ? '' : `（${when} 验过）`}；${browser}。` };
        }
        if (session.alive === false) {
          const why = session.reason === undefined || session.reason === 'ok' ? '' : `（${session.reason}）`;
          // 学堂那边也要人工：这时「立即续期」白试，得让人去登录窗口
          if (session.reason === 'needs-manual-login') {
            return { kind: 'error', text: '会话已失效，而且学堂要求人工登录一次：点「打开登录窗口」登一次并勾「信任浏览器」，登完这边会自动接上。' };
          }
          return { kind: 'error', text: `会话已失效${why}：点「立即续期」让专用浏览器自己换一张新的。` };
        }
        return { kind: 'muted', text: `会话状态未知（这会儿连不上学堂？），下一次心跳会再试；${browser}。` };
      };

      const courseNameOf = (id) => courses.find((c) => c.id === id)?.name ?? '';
      const sessionInfo = sessionLine();

      return h('div', { className: 'sa-card' },
        h('h3', null, '网络学堂同步'),
        h('div', { className: 'sa-muted', style: { marginBottom: 8 } },
          connected
            ? `已连接${status.updatedAt ? `（${String(status.updatedAt).slice(0, 10)}）` : ''}，对应上 ${status.counts?.matched ?? status.courses?.filter((c) => c.matched).length ?? 0} / ${status.counts?.courses ?? status.courses?.length ?? 0} 门课。${status.semesterId ? `当前学期 ${status.semesterId}。` : ''}`
            : '粘贴网络学堂的 Cookie 即可自动把作业同步进来（只读，不改学堂里的任何东西）。'),

        connected
          ? null
          : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('input', {
                className: 'sa-input',
                style: { flex: '1 1 320px', minWidth: 240 },
                placeholder: 'JSESSIONID=...; XSRF-TOKEN=...',
                value: cookie,
                disabled: busy,
                onChange: (e) => { setCookie(e.target.value); setNotice(null); },
              }),
              h('button', { className: 'sa-btn primary', disabled: busy || cookie.trim() === '', onClick: connect }, busy ? '连接中…' : '连接'),
            ),

        // 断线时的救命按钮。以前这几个只在「已连接」分支里渲染，于是票一失效
        // （2026-10-18 12:50 那次被写成空串）界面上就只剩「粘贴 Cookie」，
        // 用户根本没地方点「让它自己去换票」—— 那九个小时就是这么干耗的。
        connected
          ? null
          : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
              h('button', {
                className: 'sa-btn primary',
                disabled: busy || session?.edgeAvailable !== true,
                title: session?.edgeAvailable === true
                  ? '让专用浏览器自己去换一张新票（SSO 还认这台机器时不用你输密码）'
                  : '没找到 Edge，自动续期用不了；只能手动粘贴一次 Cookie',
                onClick: renewSession,
              }, '立即续期'),
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: '学堂要图形验证码时，在这里手动登录一次并勾「信任浏览器」',
                onClick: openLoginWindow,
              }, '打开登录窗口'),
              h('span', { className: 'sa-muted' }, '票失效先点「立即续期」，多半能自己接回来'),
            ),

        connected
          ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              // 学期只在有得选的时候才出现：只有一个学期时摆个下拉框纯属噪音
              (status.semesters?.length ?? 0) > 1
                ? h('select', {
                    className: 'sa-input',
                    style: { width: 132 },
                    value: status.semesterId ?? '',
                    disabled: busy,
                    title: '换学期：会按该学期重拉课程并重做匹配',
                    onChange: (e) => switchSemester(e.target.value),
                  }, status.semesters.map((s) => h('option', { key: s, value: s }, s)))
                : null,
              h('button', { className: 'sa-btn primary', disabled: busy, onClick: doFetch }, busy ? '读取中…' : '预览要导入的作业'),
              h('button', {
                className: 'sa-btn primary',
                disabled: busy || preview === null || preview.counts.fresh === 0,
                onClick: doSync,
              }, busy ? '同步中…' : preview === null ? '导入' : `导入 ${preview.counts.fresh} 条`),
              // 同步不会回头改已导入任务的截止时间，这条是唯一的补救入口
              h('button', {
                className: 'sa-btn',
                disabled: busy,
                title: '老师改过截止日期的作业（同步只补新条目，不会纠正旧日期）',
                onClick: checkUpdates,
              }, busy ? '检查中…' : '检查更新'),
              h('span', { className: 'sa-spacer' }),
              // 会话自愈：平时不用管（心跳自己续），失效时这两个按钮就是出路
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: session?.edgeAvailable === true
                  ? '用专用 Edge 立刻换一张新会话（不用手动复制 Cookie）'
                  : '没找到 Edge，自动续期用不了；可以手动重新复制一次 Cookie',
                onClick: renewSession,
              }, '立即续期'),
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: '学堂要图形验证码时，在这里手动登录一次并勾「信任浏览器」',
                onClick: openLoginWindow,
              }, '打开登录窗口'),
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.browser?.running !== true,
                title: '关掉后台浏览器省内存（下次续期会自动再起）',
                onClick: stopBrowser,
              }, '关闭后台浏览器'),
              h('button', { className: 'sa-btn', disabled: busy, onClick: disconnect }, '断开'),
            )
          : null,

        // 会话那行字放在按钮下面：失效时它会指向「立即续期」，就近更好点
        sessionInfo === null
          ? null
          : h('div', {
              className: sessionInfo.kind === 'error' ? 'sa-error' : 'sa-muted',
              style: { marginTop: 6 },
            }, sessionInfo.text),

        notice === null ? null : h('div', {
          className: notice.kind === 'error' ? 'sa-error' : 'sa-muted',
          style: { marginTop: 8 },
        }, notice.text),

        // 检查更新的差异清单：把「旧 → 新」逐条摆出来，用户看得见才点得下去
        updates !== null && updates.diffs.length > 0
          ? h('div', { style: { marginTop: 10 } },
              updates.diffs.map((d) => h('div', {
                key: d.taskId,
                className: 'sa-muted',
                style: { padding: '2px 0' },
              }, `${d.title || d.taskId}：${d.from ?? '（原来没写）'} → ${d.to}`)),
              h('button', {
                className: 'sa-btn primary',
                style: { marginTop: 6 },
                disabled: busy,
                onClick: applyUpdates,
              }, busy ? '更新中…' : `按平台更新 ${updates.diffs.length} 条`),
            )
          : null,

        // 课程对不上的要明确列出来：这是「同步成功了但任务没挂到课上」的唯一线索
        preview !== null && (preview.ambiguous?.length ?? 0) > 0
          ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'sa-error' }, `${preview.ambiguous.length} 门课没能对应上本地课程，这些作业会以「未选科目」导入：`),
              preview.ambiguous.map((a) => h('div', { key: a.wlkcid, className: 'sa-muted', style: { padding: '2px 0' } },
                `${a.learnName || a.wlkcid}　`,
                a.how === 'ambiguous' && a.candidates?.length > 0
                  ? `（本地有多个同名/近名课程：${a.candidates.map((c) => c.name).join('、')}，请到「课表」页把学堂课程名加为其中一门课的别名）`
                  : '（本地没有同名课程：到「课表」页给对应课程点「别名」，把上面的学堂课程名加进去即可自动对应）',
              )),
            )
          : null,

        preview === null
          ? null
          : h('div', { style: { marginTop: 10 } },
              h('div', { className: 'sa-muted' }, `${preview.semesterId ? `学期 ${preview.semesterId}，` : ''}共读到 ${preview.candidates.length} 条，按截止时间排序：`),
              [...preview.candidates]
                .sort((a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')))
                .slice(0, 20)
                .map((item) => h('div', { className: 'sa-row', key: item.key, style: { borderBottom: 0, padding: '3px 0' } },
                  h('span', { className: 'sa-muted', style: { minWidth: 132 } }, item.due ?? '无截止时间'),
                  h('span', { className: 'sa-grow' }, item.title),
                  h('span', { className: 'sa-muted' }, courseNameOf(item.courseId) || '未选科目'),
                  h(Pill, { level: item.expired ? 'overdue' : 'later' }, item.expired ? '已过期' : '待完成'),
                )),
              preview.candidates.length > 20
                ? h('div', { className: 'sa-muted' }, `（只显示前 20 条，实际会导入 ${preview.counts.fresh} 条）`)
                : null,
              (preview.diagnostics ?? []).some((d) => (d.rows ?? 0) > 0)
                ? h('details', { style: { marginTop: 8 } },
                    h('summary', { className: 'sa-muted' }, '接口明细'),
                    preview.diagnostics.map((d, index) => h('div', { key: `${d.wlkcid}-${d.list}-${index}`, className: 'sa-muted', style: { padding: '2px 0' } },
                      `${d.name || d.wlkcid}　${d.list}　${d.error === null || d.error === undefined
                        // total 是服务端报的记录总数：比 rows 多说明这次没取全，值得写出来
                        ? `${d.rows} 条${typeof d.total === 'number' && d.total > d.rows ? `（服务端共 ${d.total} 条）` : ''}`
                        : `失败：${d.error}${d.message ? ` ${d.message}` : ''}`}`,
                    )),
                  )
                : null,
            ),
      );
    }

    // ---------------------------------------------------------------------
    // 页签：DDL
    // ---------------------------------------------------------------------

    /** 详情失败的文案表：失败是常态（Cookie 会过期），每条都要说清「下一步做什么」。 */
    const LEARN_DETAIL_ERRORS = {
      'not-connected': '还没连接网络学堂：先在上面「网络学堂」卡片里连一次。',
      'cookie-invalid': '网络学堂的 Cookie 已失效：重新登录后复制新 Cookie，再连一次。',
      'no-learn-mark': '这条是手工加的任务，网络学堂里没有对应记录。',
      'course-unmapped': '这门课还没和网络学堂对上号，先跑一次「同步」。',
      'needs-sync': '这条任务缺网络学堂的作业编号，先跑一次「同步」。',
      'no-task': '任务已经不在数据里了，刷新一下页面。',
      'bad-response': '宿主没有按预期返回数据，稍后重试。',
    };

    function learnDetailErrorText(error) {
      const code = String(error ?? '');
      if (LEARN_DETAIL_ERRORS[code] !== undefined) return LEARN_DETAIL_ERRORS[code];
      if (code.startsWith('http-')) return `网络学堂返回 HTTP ${code.slice('http-'.length)}。`;
      if (code.startsWith('learn-http-')) return `网络学堂返回 HTTP ${code.slice('learn-http-'.length)}。`;
      if (code === 'timeout' || code === 'learn-timeout') return '访问网络学堂超时，检查网络后重试。';
      if (code === 'learn-unreachable') return '连不上网络学堂，确认现在能打开 learn.tsinghua.edu.cn。';
      return code === '' ? '取详情失败。' : `取详情失败：${code}`;
    }

    /** 一行「标签 + 值」；值为空就不渲染，免得整片空白。 */
    function detailLine(label, value, options = {}) {
      if (value === null || value === undefined || value === '') return null;
      return h('div', { key: options.key ?? label, style: { display: 'flex', gap: 8, padding: '1px 0' } },
        h('span', { className: 'sa-muted', style: { flex: '0 0 auto', minWidth: 72 } }, label),
        h('span', {
          style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', whiteSpace: options.pre === true ? 'pre-wrap' : 'normal' },
        }, String(value)),
      );
    }

    /** 附件列表：名字 + 大小；有链接就点开网络学堂自己的查看器。 */
    function detailFilesLine(label, files) {
      const list = Array.isArray(files) ? files : [];
      if (list.length === 0) return null;
      return h('div', { key: `files-${label}`, style: { display: 'flex', gap: 8, padding: '1px 0' } },
        h('span', { className: 'sa-muted', style: { flex: '0 0 auto', minWidth: 72 } }, label),
        h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          ...list.map((file, index) => {
            const text = `${file.name}${file.size === '' || file.size === undefined ? '' : `（${file.size}）`}`;
            return file.href === null || file.href === undefined
              ? h('span', { key: `f${index}` }, text)
              : h('a', { key: `f${index}`, href: file.href, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', textDecoration: 'underline' } }, text);
          }),
        ),
      );
    }

    /**
     * 一键开工：只放一个按钮。
     *
     * 点了之后宿主会开一个**新会话**，真正的找原题、取字、分题、出答案都在那边做，
     * 所以这里不做进度条，只把「开没开起来」说清楚——开起来之后用户去侧栏接着聊。
     */
    function renderHomeworkSpawnRow(task, ops) {
      if (ops === null || ops === undefined) return [];
      const busy = ops.busy === true;
      const out = [
        h('div', { key: 'hw-spawn', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingTop: 4 } },
          h('button', { key: 'spawn', className: 'sa-btn', disabled: busy, onClick: () => ops.onSpawn(task) },
            busy ? '正在开新对话…' : '一键开工（新对话）'),
          h('span', { className: 'sa-muted' }, '新对话会自动找原题、取字、分题，先回来问你一句再出答案。'),
        ),
      ];
      if (ops.error) out.push(h('div', { key: 'hw-spawn-error', className: 'sa-error' }, ops.error));
      if (ops.notice) out.push(h('div', { key: 'hw-spawn-notice', className: 'sa-muted' }, ops.notice));
      return out;
    }

    /**
     * 行内展开的作业详情面板。
     *
     * 平台原文优先、本地字段兜底（用户 2026-10-09 定的口径）：拉不到时把原因说清楚，
     * 并把本地已有的标题/截止摆出来，而不是只留一块红字。正文一律按**纯文本**渲染
     * （`pre-wrap` 保留换行），平台返回的 HTML 永远不进 DOM。
     */
    function renderLearnDetail(task, state, ops) {
      if (state === null || state === undefined || state.status === 'loading') {
        return h('div', { className: 'sa-muted', style: { padding: '2px 0 8px' } }, '正在从网络学堂取原文…');
      }
      const data = state.data ?? {};
      const detail = data.detail ?? null;
      const shell = (children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 0 8px' } }, ...children);

      if (state.status !== 'ok' || detail === null) {
        return shell([
          h('div', { key: 'error', className: 'sa-error' }, learnDetailErrorText(state.error)),
          detailLine('本地标题', task.title, { key: 'local-title' }),
          detailLine('本地截止', task.due, { key: 'local-due' }),
          ...renderHomeworkSpawnRow(task, ops),
        ].filter(Boolean));
      }

      const rows = [
        detailLine('平台标题', detail.title, { key: 'title' }),
        detailLine('截止时间', detail.due, { key: 'due' }),
        detailLine('发布对象', detail.audience, { key: 'audience' }),
        detailLine('完成方式', detail.mode, { key: 'mode' }),
        detailLine('作业说明', detail.description, { key: 'description', pre: true }),
        detailLine('答案说明', detail.answerNote, { key: 'answer', pre: true }),
        detailFilesLine('作业附件', detail.attachments),
        detailFilesLine('答案附件', detail.answerFiles),
        detailLine('提交时间', detail.submittedAt, { key: 'submitted-at' }),
        detailLine('我交的内容', detail.submission, { key: 'submission', pre: true }),
        detailFilesLine('我交的附件', detail.submissionFiles),
        detailLine('批阅老师', detail.grader, { key: 'grader' }),
        detailLine('批阅时间', detail.gradedAt, { key: 'graded-at' }),
        detailLine('成绩', detail.score, { key: 'score' }),
        detailLine('评语', detail.comment, { key: 'comment', pre: true }),
        detailFilesLine('评语附件', detail.commentFiles),
      ].filter(Boolean);

      return shell([
        ...renderHomeworkSpawnRow(task, ops),
        rows.length === 0
          ? h('div', { key: 'nothing', className: 'sa-muted' }, '平台这一页没解析出可显示的字段（页面结构可能变了）。')
          : h('div', { key: 'rows' }, ...rows),
        h('div', { key: 'links', style: { display: 'flex', gap: 10, alignItems: 'center', paddingTop: 4 } },
          typeof detail.url === 'string' && detail.url !== ''
            ? h('a', { href: detail.url, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', textDecoration: 'underline' } }, '去网络学堂看原文')
            : null,
          h('span', { className: 'sa-muted' }, data.stale === true
            // 拉不到平台时把上次存下来的原文还给界面：这时必须说清「这是旧的一份」
            ? `（这是 ${String(data.fetchedAt ?? '').slice(0, 16).replace('T', ' ')} 拉到的原文，现在还连不上学堂，先看这份）`
            : data.cached === true ? '（三分钟内重复点开，用的是上次拉到的原文）' : ''),
        ),
      ]);
    }

    function DeadlinesTab({ docs, now, refresh, busy, run, setBusy }) {
      const [filter, setFilter] = useState('active');
      const [draft, setDraft] = useState({ title: '', kind: 'homework', due: '', courseId: null, estimateHours: '' });
      const [importer, setImporter] = useState('single');   // single = 单条快录，batch = 批量粘贴
      const [text, setText] = useState('');
      const [notice, setNotice] = useState(null);
      // 提交件归档：deliver 是宿主扫描结果（null = 还没扫过），deliverNotice 只报归档动作的结果
      const [deliver, setDeliver] = useState(null);
      const [deliverNotice, setDeliverNotice] = useState(null);
      const deliverRun = useRef(false);
      // 作业详情：一次只展开一条（避免连点刷出一堆请求）；detailOf 按任务 id 存结果
      const [openDetail, setOpenDetail] = useState(null);
      const [detailOf, setDetailOf] = useState({});
      const courses = objectList(docs.courses?.courses);
      const tasks = objectList(docs.tasks?.tasks);

      // 一键导入的实时预览：每次输入都按当前课程表解析一遍，导入前就能看到结果
      const parsed = useMemo(
        () => parseQuickTasks(text, { courses, now }),
        [text, courses, now],
      );

      const courseNameOf = (id) => courses.find((c) => c.id === id)?.name ?? '';

      /**
       * 扫一遍 `提交文件/`，auto 为真时把「唯一命中」的那些直接归档。
       *
       * 自动归档只做一次「扫描 → 一次 POST → 重新扫描」：宿主按文件名与任务做唯一性判定，
       * 不唯一就只留在 ambiguous 里等人确认，绝不动任务状态。deliverRun 防重入，避免
       * 面板重渲染时叠出几个并发扫描。
       */
      const scanDeliverables = useCallback(async ({ auto }) => {
        if (deliverRun.current) return;
        deliverRun.current = true;
        try {
          let report = await deliverablesScan();
          if (auto && report.enabled === true) {
            const ready = report.findings.filter((item) => item.status === 'ready');
            if (ready.length > 0) {
              const result = await deliverablesArchive(); // 不传 items：宿主只挑 ready 的唯一命中
              if (result.archived.length > 0) {
                setDeliverNotice({
                  kind: 'ok',
                  text: `已归档 ${result.archived.length} 条：${result.archived.map((item) => item.title).join('、')}`,
                });
                await refresh();
                report = await deliverablesScan();
              }
            }
          }
          setDeliver(report);
        } catch (error) {
          setDeliverNotice({ kind: 'error', text: `提交件扫描失败：${error?.message ?? error}` });
        } finally {
          deliverRun.current = false;
        }
      }, [refresh]);

      // 打开 DDL 页就扫一次并自动归档。refresh 是 useCallback（只依赖 load），身份稳定，
      // 所以这个 effect 不会因为父组件重渲染而反复触发。
      useEffect(() => { scanDeliverables({ auto: true }); }, [scanDeliverables]);

      /**
       * 取一条任务的详情（宿主去网络学堂现拉，服务端缓存 3 分钟）。
       *
       * 失败也照存进 detailOf：平台不通时反复点不该反复打请求，重试交给面板里的按钮。
       */
      const loadDetail = useCallback(async (id) => {
        setDetailOf((prev) => ({ ...prev, [id]: { status: 'loading' } }));
        const result = await learnDetail(id);
        setDetailOf((prev) => ({
          ...prev,
          [id]: result.ok === true
            ? { status: 'ok', data: result }
            : { status: 'error', error: result.error ?? 'unknown', data: result },
        }));
      }, []);

      /** 点标题或「详情」按钮：展开/收起；第一次展开才去取。 */
      const toggleDetail = useCallback((id) => {
        if (openDetail === id) { setOpenDetail(null); return; }
        setOpenDetail(id);
        if (detailOf[id] === undefined) loadDetail(id);
      }, [openDetail, detailOf, loadDetail]);

      /**
       * 一键开工的状态：只有一件事，所以只有「忙着 / 报错 / 提示」三个。
       *
       * 刻意不做进度：真正的活在会话里跑，面板这边轮询只会骗人。
       */
      const [spawnBusy, setSpawnBusy] = useState(null);
      const [spawnError, setSpawnError] = useState(null);
      const [spawnNotice, setSpawnNotice] = useState(null);

      /** 点火：让宿主建新会话并投固定指令；成功之后用户去侧栏跟进。 */
      const spawnHomework = async (task) => {
        setSpawnError(null);
        setSpawnNotice(null);
        setSpawnBusy(task.id);
        try {
          const result = await homeworkSpawn(task.id);
          setSpawnNotice(`已开新对话（${result.course ?? '本课程'} · ${task.title}）。它会先回来问你一次，再出答案。`);
        } catch (error) {
          setSpawnError(String(error?.message ?? error));
        } finally {
          setSpawnBusy(null);
        }
      };

      const homeworkOps = {
        busy: spawnBusy !== null,
        error: spawnError,
        notice: spawnNotice,
        onSpawn: spawnHomework,
      };

      const runImport = async () => {
        if (parsed.items.length === 0) return;
        setBusy(true);
        setNotice(null);
        try {
          // 逐条写入。任一条被宿主拒绝就立刻停下，并把已经写成功的条数报告出来
          // —— 不做「静默部分成功」，否则用户不知道任务有没有进库。
          let created = 0;
          for (const item of parsed.items) {
            const payload = { ...item };
            delete payload._line;
            await run(() => mutate('tasks', 'create', { item: payload }));
            created += 1;
          }
          setNotice({ kind: 'ok', text: `已导入 ${created} 条任务。` });
          setText('');
          await refresh();
        } catch (error) {
          setNotice({ kind: 'error', text: `导入中断：${error?.message ?? error}` });
        } finally {
          setBusy(false);
        }
      };

      const addQuick = async () => {
        if (text.trim() === '') return;
        setBusy(true);
        setNotice(null);
        try {
          const parsedOne = parseQuickTasks(text, { courses, now });
          if (!parsedOne.ok) {
            setNotice({ kind: 'error', text: parsedOne.errors.map((e) => e.reason).join('；') });
            return;
          }
          if (parsedOne.items.length === 0) return;
          const payload = { ...parsedOne.items[0] };
          delete payload._line;
          await run(() => mutate('tasks', 'create', { item: payload }));
          setNotice({ kind: 'ok', text: '已新增 1 条任务。' });
          setText('');
          await refresh();
        } catch (error) {
          setNotice({ kind: 'error', text: `新增失败：${error?.message ?? error}` });
        } finally {
          setBusy(false);
        }
      };

      const shown = useMemo(() => {
        const list = tasks.filter((task) => {
          if (filter === 'active') return task.status !== 'done' && task.status !== 'dropped';
          if (filter === 'done') return task.status === 'done';
          return true;
        });
        // 未完结的按紧急度/截止时间排（逾期最前）；已完结的沉底、组内按**完成时间倒序**
        // —— 用户要看的是「我刚做完的那条在最上面」，而不是按截止日排在最下面。
        return [...list].sort((a, b) => compareDeadlineList(a, b, now));
      }, [tasks, filter, now]);

      const cycleStatus = async (task) => {
        const next = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
        setBusy(true);
        try {
          await run(() => mutate('tasks', 'update', { id: task.id, item: { status: next } }));
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const addTask = async () => {
        if (draft.title.trim() === '') return;
        setBusy(true);
        try {
          await run(() => mutate('tasks', 'create', {
            item: {
              title: draft.title.trim(),
              kind: draft.kind,
              due: draft.due.trim(),
              courseId: draft.courseId,
              estimateHours: draft.estimateHours === '' ? 0 : Number(draft.estimateHours),
            },
          }));
          setDraft({ title: '', kind: draft.kind, due: '', courseId: null, estimateHours: '' });
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const remove = (task) => {
        if (!window.confirm(`删除「${task.title}」？`)) return;
        setBusy(true);
        run(() => mutate('tasks', 'delete', { id: task.id })).then(refresh).catch(() => {}).finally(() => setBusy(false));
      };

      const courseName = (id) => courses.find((c) => c.id === id)?.name ?? '';
      const taskTitleOf = (id) => tasks.find((task) => task.id === id)?.title ?? id;

      return h(
        'div',
        null,
        h(Style),
        // 网络学堂同步放在最顶部：它是自动来源，下面的手动录入是补充手段
        h(LearnCard, { courses, busy, setBusy, refresh, run }),
        h('div', { className: 'sa-row', style: { borderBottom: 0 } },
          ...['active', 'done', 'all'].map((key) => h('button', {
            key,
            className: 'sa-btn',
            'aria-pressed': filter === key,
            style: filter === key ? { fontWeight: 600 } : undefined,
            onClick: () => setFilter(key),
          }, key === 'active' ? '未完成' : key === 'done' ? '已完成' : '全部')),
          h('span', { className: 'sa-spacer' }),
          h('span', { className: 'sa-muted' }, `共 ${shown.length} 条`),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '一键导入 DDL'),
          h('div', { className: 'sa-row', style: { borderBottom: 0, padding: '0 0 8px' } },
            h('button', {
              className: 'sa-btn',
              'aria-pressed': importer === 'single',
              style: importer === 'single' ? { fontWeight: 600 } : undefined,
              onClick: () => { setImporter('single'); setNotice(null); },
            }, '单条快录'),
            h('button', {
              className: 'sa-btn',
              'aria-pressed': importer === 'batch',
              style: importer === 'batch' ? { fontWeight: 600 } : undefined,
              onClick: () => { setImporter('batch'); setNotice(null); },
            }, '批量粘贴'),
            h('span', { className: 'sa-spacer' }),
            h('span', { className: 'sa-muted' }, importer === 'single' ? '一行一条，直接回车' : '每行一条，用 | 分隔'),
          ),
          h('textarea', {
            className: 'sa-input sa-textarea',
            rows: importer === 'batch' ? 6 : 2,
            placeholder: importer === 'batch'
              ? '标题 | 科目 | 日期 | 类型\n例：第 3 次作业 | 数据结构 | 10/20 | 作业\n　　实验二预习报告 | 数电 | 明天 | 实验\n日期支持 2026-10-20 / 10/20 / 今天 / 周五；类型支持 作业/实验/报告/考试/小组\n科目可写全名或简称（如 数电 = 数字电子技术基础）'
              : '例：第 3 次作业 | 数据结构 | 10/20 | 作业',
            value: text,
            disabled: busy,
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (importer === 'single') addQuick(); else runImport();
              }
            },
            onChange: (e) => { setText(e.target.value); setNotice(null); },
          }),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
            importer === 'single'
              ? h('button', { className: 'sa-btn primary', disabled: busy || text.trim() === '', onClick: addQuick }, busy ? '保存中…' : '新增这一条')
              : h('button', { className: 'sa-btn primary', disabled: busy || parsed.items.length === 0, onClick: runImport },
                busy ? '导入中…' : `导入 ${parsed.items.length} 条`),
            h('span', { className: 'sa-muted' }, importer === 'single' ? '' : 'Ctrl + Enter 执行'),
          ),
          notice === null ? null : h('div', { className: notice.kind === 'ok' ? 'sa-muted' : 'sa-error', style: { marginTop: 6 } }, notice.text),
          text.trim() === '' ? null : h('div', { style: { marginTop: 8 } },
            h('div', { className: 'sa-muted' },
              `识别到 ${parsed.items.length} 条`
              + (parsed.errors.length > 0 ? `，${parsed.errors.length} 行有问题（有问题时不会导入，避免只写一半）` : ''),
            ),
            parsed.items.slice(0, 10).map((item) => h('div', { className: 'sa-row', key: item._line, style: { borderBottom: 0, padding: '3px 0' } },
              h('span', { className: 'sa-muted' }, `第 ${item._line} 行`),
              h('span', { className: 'sa-grow' }, item.title),
              h('span', { className: 'sa-muted' }, courseNameOf(item.courseId) || '未选科目'),
              h('span', { className: 'sa-muted' }, item.due || '无截止日'),
              h(Pill, { level: 'later' }, KIND_LABEL[item.kind] ?? item.kind),
            )),
            parsed.errors.map((err) => h('div', { className: 'sa-error', key: `e${err.line}` }, `第 ${err.line} 行：${err.reason}`)),
          ),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '新增任务（表单）'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('input', { className: 'sa-input', placeholder: '任务标题', style: { minWidth: 180 }, value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }) }),
            h('select', { className: 'sa-input', value: draft.kind, onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
              ...Object.entries(KIND_LABEL).map(([value, label]) => h('option', { key: value, value }, label))),
            h('input', { className: 'sa-input', type: 'date', value: draft.due, onChange: (e) => setDraft({ ...draft, due: e.target.value }) }),
            h(CourseSelect, { courses, value: draft.courseId, onChange: (value) => setDraft({ ...draft, courseId: value }) }),
            h('input', { className: 'sa-input', placeholder: '预估工时', style: { width: 84 }, value: draft.estimateHours, onChange: (e) => setDraft({ ...draft, estimateHours: e.target.value }) }),
            h('button', { className: 'sa-btn primary', disabled: busy || draft.title.trim() === '', onClick: addTask }, '添加'),
          ),
        ),
        h('div', { className: 'sa-card' },
          shown.length === 0
            ? h('div', { className: 'sa-muted' }, TEXT.noDeadline)
            : shown.map((task) => {
                const urgency = deadlineUrgency(task, now);
                // 已完成的行把「什么时候做完的」显示出来 —— 倒序排列一眼就能验证
                const doneLabel = isClosedTask(task) ? formatDoneAt(task.doneAt) : '';
                const open = openDetail === task.id;
                const row = h('div', { className: 'sa-row' },
                  h(Pill, { level: urgency.level }, urgencyText(urgency)),
                  // 标题区可点：点 DDL 本身就展开详情，不必先找按钮
                  h('span', {
                    className: 'sa-grow',
                    title: '点一下看网络学堂的作业详情',
                    onClick: () => toggleDetail(task.id),
                    style: { cursor: 'pointer' },
                  },
                    task.title,
                    h('span', { className: 'sa-muted' }, `　${KIND_LABEL[task.kind] ?? task.kind}${courseName(task.courseId) ? `　${courseName(task.courseId)}` : ''}`),
                  ),
                  h('span', { className: 'sa-muted' }, task.due || '无截止日'),
                  doneLabel === '' ? null : h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, doneLabel),
                  h('button', { className: 'sa-btn', onClick: () => toggleDetail(task.id) }, open ? '收起 ▴' : '详情 ▾'),
                  h('button', { className: 'sa-btn', disabled: busy, onClick: () => cycleStatus(task) },
                    task.status === 'todo' ? '未开始' : task.status === 'doing' ? '进行中' : '已完成'),
                  h('button', { className: 'sa-btn', disabled: busy, onClick: () => remove(task) }, '删除'),
                );
                return h(React.Fragment, { key: task.id },
                  row,
                  open
                    ? h('div', { className: 'sa-row', style: { borderBottom: 0, alignItems: 'flex-start' } },
                        h('span', { className: 'sa-muted', style: { flex: '0 0 auto', minWidth: 72 } }, '作业详情'),
                        h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
                          // detailOf 里还没有这条时按「加载中」渲染，展开的瞬间不会闪空白
                          renderLearnDetail(task, detailOf[task.id] ?? { status: 'loading' }, homeworkOps),
                          h('button', { className: 'sa-btn', style: { marginTop: 4 }, onClick: () => loadDetail(task.id) }, '重新拉取'),
                        ),
                      )
                    : null,
                );
              }),
        ),
        // 提交件归档放在所有卡片之后：它是「事后核对」，不该顶在 DDL 列表前面挡视线。
        // 判据是「用户本人把带姓名 + 学号的提交件放进 <学科>/提交文件/」。
        // 自动归档只在「唯一命中一条未完成任务」时发生；其余状态一律只展示，绝不替用户勾完成。
        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-row', style: { borderBottom: 0, padding: '0 0 8px' } },
            h('h3', { style: { margin: 0 } }, '提交件归档'),
            h('span', { className: 'sa-spacer' }),
            h('button', {
              className: 'sa-btn',
              disabled: busy || deliver === null,
              onClick: () => { setDeliverNotice(null); scanDeliverables({ auto: true }); },
            }, '重新扫描并归档'),
          ),
          deliver === null
            ? h('div', { className: 'sa-muted' }, '正在扫描 提交文件/ …')
            : deliver.enabled !== true
              ? h('div', { className: 'sa-muted' }, '未启用：插件配置里没写 studentName / studentId，或工作区目录不存在。')
              : h('div', null,
                h('div', { className: 'sa-muted', style: { marginBottom: 6 } },
                  `认文件名同时含「${deliver.studentName ?? ''}」与「${deliver.studentId ?? ''}」、且放在 <学科>/提交文件/ 里的件；`
                  + '只有唯一命中一条未完成任务时才自动归档。'),
                h('div', { className: 'sa-muted' },
                  ['ready', 'ambiguous', 'done', 'unmatched', 'stray']
                    .map((key) => ({ key, count: deliver.findings.filter((item) => item.status === key).length }))
                    .filter((row) => row.count > 0)
                    .map((row) => `${DELIVER_STATUS_LABEL[row.key] ?? row.key} ${row.count}`)
                    .join('　·　') || '没有找到带本人姓名 + 学号的提交件'),
                deliver.findings.length === 0 ? null : h('div', { style: { marginTop: 6 } },
                  deliver.findings.slice(0, 50).map((item) => h('div', { className: 'sa-row', key: item.file },
                    h('span', { className: `sa-pill ${item.status === 'ready' ? 'soon' : item.status === 'ambiguous' ? 'today' : item.status === 'stray' ? 'later' : 'done'}` },
                      DELIVER_STATUS_LABEL[item.status] ?? item.status),
                    h('span', { className: 'sa-grow' },
                      item.basename,
                      h('span', { className: 'sa-muted' }, `　${DELIVER_REASON_LABEL[item.reason] ?? item.reason ?? ''}`),
                    ),
                    h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, courseName(item.courseId) || '科目未定'),
                    item.taskId === null ? null : h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, taskTitleOf(item.taskId)),
                    item.candidates.length === 0 ? null : h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } },
                      `候选：${item.candidates.map((c) => c.title).join('、')}`),
                  )),
                  deliver.findings.length > 50 ? h('div', { className: 'sa-muted' }, `还有 ${deliver.findings.length - 50} 条未显示`) : null,
                ),
              ),
          deliverNotice === null ? null : h('div', { className: deliverNotice.kind === 'ok' ? 'sa-muted' : 'sa-error', style: { marginTop: 6 } }, deliverNotice.text),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 页签：成绩
    // ---------------------------------------------------------------------

    function GradesTab({ docs, refresh, busy, run, setBusy }) {
      const courses = objectList(docs.courses?.courses);
      const entries = objectList(docs.grades?.courses);
      const [draft, setDraft] = useState({ courseId: null, score: '', credit: '' });
      const [target, setTarget] = useState('');
      const [remaining, setRemaining] = useState('');

      const summary = useMemo(() => computeGpa(docs.grades), [docs.grades]);

      const nameOf = (id) => courses.find((c) => c.id === id)?.name ?? id ?? '—';

      const upsert = async () => {
        if (!draft.courseId) return;
        setBusy(true);
        try {
          const existing = entries.find((item) => item.courseId === draft.courseId);
          const item = {
            courseId: draft.courseId,
            score: draft.score === '' ? null : Number(draft.score),
            credit: draft.credit === '' ? (courses.find((c) => c.id === draft.courseId)?.credits ?? 0) : Number(draft.credit),
          };
          const course = courses.find((c) => c.id === draft.courseId);
          if (item.credit === 0 && course?.credits) item.credit = course.credits;
          if (existing) await run(() => mutate('grades', 'update', { id: existing.courseId, item }));
          else await run(() => mutate('grades', 'create', { item }));
          setDraft({ courseId: null, score: '', credit: '' });
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const remove = async (courseId) => {
        setBusy(true);
        try {
          await run(() => mutate('grades', 'delete', { id: courseId }));
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      // 目标反推（与 lib/core.js 同一公式）
      const projection = useMemo(() => {
        const targetValue = Number(target);
        const remainingValue = Number(remaining);
        if (summary.gpa === null || !Number.isFinite(targetValue) || !Number.isFinite(remainingValue) || remainingValue <= 0) return null;
        const total = summary.credits + remainingValue;
        const need = (targetValue * total - summary.gpa * summary.credits) / remainingValue;
        return { need: Math.round(need * 100) / 100, reachable: need <= 4 };
      }, [summary, target, remaining]);

      return h(
        'div',
        null,
        h(Style),
        h('div', { className: 'sa-stat' },
          h('div', null, h('b', null, summary.gpa === null ? '—' : String(summary.gpa)), h('span', { className: 'sa-muted' }, '加权 GPA（4.0）')),
          h('div', null, h('b', null, summary.average === null ? '—' : String(summary.average)), h('span', { className: 'sa-muted' }, '加权均分')),
          h('div', null, h('b', null, String(summary.credits)), h('span', { className: 'sa-muted' }, '已计入学分')),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '录入成绩'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            h(CourseSelect, { courses, value: draft.courseId, onChange: (value) => setDraft({ ...draft, courseId: value, credit: String(courses.find((c) => c.id === value)?.credits ?? '') }) }),
            h('input', { className: 'sa-input', placeholder: '分数', style: { width: 70 }, value: draft.score, onChange: (e) => setDraft({ ...draft, score: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '学分', style: { width: 70 }, value: draft.credit, onChange: (e) => setDraft({ ...draft, credit: e.target.value }) }),
            h('button', { className: 'sa-btn primary', disabled: busy || !draft.courseId, onClick: upsert }, '保存'),
          ),
          courses.length === 0 ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '先在「课表」页添加课程，才能录成绩。') : null,
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '成绩明细'),
          entries.length === 0
            ? h('div', { className: 'sa-muted' }, '还没有成绩。')
            : entries.map((item) => h('div', { className: 'sa-row', key: item.courseId },
                h('span', { className: 'sa-grow' }, nameOf(item.courseId)),
                h('span', null, item.score === null || item.score === undefined ? (item.grade ?? '—') : `${item.score} 分`),
                h('span', { className: 'sa-muted' }, `${item.credit ?? 0} 学分`),
                h('span', { className: 'sa-muted' }, `绩点 ${typeof item.score === 'number' ? (scoreToGpa4(item.score) ?? '—') : (gradeToGpa4(item.grade) ?? '—')}`),
                h('button', { className: 'sa-btn', disabled: busy, onClick: () => remove(item.courseId) }, '删除'),
              )),
          summary.skipped.length > 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 8 } },
                `未计入 GPA：${summary.skipped.map((s) => `${nameOf(s.courseId)}（${s.reason === 'no-credit' ? '缺学分' : '缺分数'}）`).join('、')}`)
            : null,
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '目标反推'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            h('input', { className: 'sa-input', placeholder: '目标 GPA 如 3.5', style: { width: 130 }, value: target, onChange: (e) => setTarget(e.target.value) }),
            h('input', { className: 'sa-input', placeholder: '剩余学分', style: { width: 100 }, value: remaining, onChange: (e) => setRemaining(e.target.value) }),
          ),
          projection === null
            ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '填入目标 GPA 与剩余学分后给出反推结果。')
            : h('div', { style: { marginTop: 6 } },
                projection.reachable
                  ? `剩余课程平均绩点需达到 ${projection.need}（满分 4.0）。`
                  : h('span', { className: 'sa-error' }, `即使剩余课程全部满分也达不到目标（需要 ${projection.need}，超过 4.0）。`),
              ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 页签：资料（占位，v1.1 实现）与设置
    // ---------------------------------------------------------------------

    /**
     * 页签：资料。
     *
     * 三块内容都来自 `/state` 里已经带回来的三份文档（`资料索引.json` / `题目.json` /
     * `知识点候选.json`），所以这里**没有写操作**、也不做轮询。点开某份资料时才调一次
     * `GET /materials/text` 拿那一页的 md 正文（浏览器读不了磁盘）。
     *
     * 空态必须说清楚「等谁来填」：这三份是取字批次写的，面板只负责读——
     * 不写清楚的话，用户看到空白只会以为功能坏了。
     */
    // ---------------------------------------------------------------------
    // 知识网络：层级布局（纯函数）
    // ---------------------------------------------------------------------

    /** 掌握度四档（用户 2026-10-20 定）。0 未学 / 1 学过 / 2 熟练 / 3 精通。 */
    const MASTERY_LABELS = ['未学', '学过', '熟练', '精通'];

    /**
     * 讲解三档（键与标签必须与服务端 `EXPLAIN_STYLES` 一致；指令原文只在服务端）。
     * 顺序就是任务单里的顺序：先讲透、再速通、最后只给提示。
     */
    const EXPLAIN_STYLE_OPTIONS = [
      { key: 'assistant', label: '助教推导' },
      { key: 'exam', label: '考前速通' },
      { key: 'hint', label: '只给提示' },
    ];

    /**
     * 把 `知识点网络.json` 的 nodes 排成三列：课程 → 章 → 知识点。
     *
     * 为什么不用力导向：节点数在几十到几百之间，力导向每次刷新位置都会变、还会重叠，
     * 找「这章讲了什么」反而更慢；层级布局是确定的，同一份数据每次画出来一模一样。
     * 真关系（前置 / 跨章）等「织网」回合补进 `edges[]` 后，再在这张图上叠加跨列曲线。
     *
     * 纯函数、不碰 DOM：`tests/client.test.js` 直接拿它验坐标单调与父子对齐。
     */
    function buildKnowledgeLayout(nodes, labels = {}) {
      const ROW = 26;
      const BOX = 20;
      const GAP = 56;
      const cols = [110, 130, 200];
      const xs = [8, 8 + cols[0] + GAP, 8 + cols[0] + GAP + cols[1] + GAP];
      const byCourse = new Map();

      for (const node of nodes) {
        const courseKey = node.courseId ?? '__none__';
        if (!byCourse.has(courseKey)) {
          byCourse.set(courseKey, {
            key: courseKey,
            label: labels.course?.(node.courseId) ?? '未匹配课程',
            chapters: new Map(),
          });
        }
        const course = byCourse.get(courseKey);
        const chapterKey = String(node.chapter ?? '').trim() || '__none__';
        if (!course.chapters.has(chapterKey)) {
          course.chapters.set(chapterKey, {
            key: chapterKey,
            label: chapterKey === '__none__' ? '未分章' : chapterKey,
            nodes: [],
          });
        }
        course.chapters.get(chapterKey).nodes.push(node);
      }

      const outNodes = [];
      const links = [];
      const link = (from, to) => links.push({
        key: `${from.id}>${to.id}`,
        d: `M${from.x + from.w},${from.y + BOX / 2} C${from.x + from.w + GAP / 2},${from.y + BOX / 2} ${to.x - GAP / 2},${to.y + BOX / 2} ${to.x},${to.y + BOX / 2}`,
      });
      let cursor = 8;

      for (const course of byCourse.values()) {
        const chapterBoxes = [];
        for (const chapter of course.chapters.values()) {
          const points = chapter.nodes
            .slice()
            .sort((a, b) => String(a.section ?? '').localeCompare(String(b.section ?? ''), 'zh')
              || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'))
            .map((node) => {
              const box = {
                id: node.id,
                level: 'point',
                x: xs[2],
                y: cursor,
                w: cols[2],
                h: BOX,
                label: String(node.name ?? ''),
                mastery: Number(node.mastery) || 0,
                marked: node.marked === true,
                ref: node,
              };
              cursor += ROW;
              outNodes.push(box);
              return box;
            });
          const chapterBox = {
            id: `${course.key}|${chapter.key}`,
            level: 'chapter',
            x: xs[1],
            y: (points[0].y + points[points.length - 1].y) / 2,
            w: cols[1],
            h: BOX,
            label: chapter.label,
          };
          outNodes.push(chapterBox);
          chapterBoxes.push(chapterBox);
          for (const point of points) link(chapterBox, point);
        }
        const courseBox = {
          id: course.key,
          level: 'course',
          x: xs[0],
          y: (chapterBoxes[0].y + chapterBoxes[chapterBoxes.length - 1].y) / 2,
          w: cols[0],
          h: BOX,
          label: course.label,
        };
        outNodes.push(courseBox);
        for (const chapterBox of chapterBoxes) link(courseBox, chapterBox);
        cursor += 12;
      }

      return {
        nodes: outNodes,
        links,
        width: xs[2] + cols[2] + 12,
        height: Math.max(cursor + 4, 60),
      };
    }

    // ---------------------------------------------------------------------
    // 知识网络：复习可用性（搜索 / 筛选 / 待复习 / 章节分组）——纯函数
    // ---------------------------------------------------------------------

    /** 「待复习」的默认间隔：7 天。够短，能在一学期里滚一遍；够长，不至于天天提醒。 */
    const REVIEW_DUE_MS = 7 * 24 * 60 * 60 * 1000;

    /**
     * 是否到了该复习的时候。
     *
     * 到「精通」（3）的节点不再提醒——复习的意义是把没掌握的捞上来，
     * 已经精通的还天天催，只会让队列变成噪音、被整体忽略。
     * 其余节点：标过复习 ⇒ 按 reviewedAt 起算 7 天；没标过 ⇒ 按 createdAt（建点时间）起算 7 天；
     * 两个时间都没有才兜底算到期。从「建点」算而不是「立即到期」，是为了别把刚织出来的
     * 知识网络整片倒进待复习队列（2026-10-21 口径，不改数据）。
     */
    function isReviewDue(node, now = Date.now()) {
      if ((Number(node?.mastery) || 0) >= 3) return false;
      const reviewedAt = typeof node?.reviewedAt === 'string' ? Date.parse(node.reviewedAt) : Number.NaN;
      if (Number.isFinite(reviewedAt)) return now - reviewedAt >= REVIEW_DUE_MS;
      const createdAt = typeof node?.createdAt === 'string' ? Date.parse(node.createdAt) : Number.NaN;
      if (Number.isFinite(createdAt)) return now - createdAt >= REVIEW_DUE_MS;
      return true;
    }

    /**
     * 哪些章「值得一打开就展开」（2026-10-24，A 块第三刀的前置）。
     *
     * 用户嫌 68 个知识点一屏铺满、又说「要能按熟练度自选展开」。折中成：
     * 默认只展开到「章」，但**有未学（mastery<2）或到期待复习节点的章**自动铺开——
     * 打开导图先看到该复习的那几块，其余仍收着。手动点过章之后以手动为准（调用方管）。
     */
    function chaptersNeedingReview(nodes, now = Date.now()) {
      const list = Array.isArray(nodes) ? nodes.filter((node) => node !== null && typeof node === 'object') : [];
      const picked = [];
      const seen = new Set();
      for (const node of list) {
        const unlearned = (Number(node.mastery) || 0) < 2;
        if (!unlearned && !isReviewDue(node, now)) continue;
        const label = String(node.chapter ?? '').trim() || '未分章';
        if (seen.has(label)) continue;
        seen.add(label);
        picked.push(label);
      }
      return picked;
    }

    /**
     * 按 id 在题目表里查一道题（证据行要用它的题干与来源页）。
     *
     * 2026-10-21 深夜修 bug：知识点页从资料页抽出来后，`findQuestion` 还闭包着
     * 资料页里的 `questions`，一点开带证据的节点就 `ReferenceError: questions is not defined`。
     * 改成顶层纯函数、题目表由调用方传进来，两个页面都只认这条路径。
     */
    function findQuestionById(questions, id) {
      if (id === undefined || id === null || String(id) === '') return null;
      const list = Array.isArray(questions) ? questions : [];
      return list.find((item) => item?.id !== undefined && item?.id !== null && String(item.id) === String(id)) ?? null;
    }

    /**
     * 证据统计：题证据 / 资料页证据各几条。
     *
     * 掌握度是手动四档（2026-10-21 拍板不改），证据只做**只读辅助**：
     * 告诉你这个点有没有题支撑、支撑它的题在哪，不参与算分、不改档。
     */
    function summarizeKnowledgeEvidence(evidence) {
      const list = Array.isArray(evidence) ? evidence : [];
      let questions = 0;
      let pages = 0;
      for (const item of list) {
        if (item?.type === 'question') questions += 1;
        else pages += 1;
      }
      return { total: list.length, questions, pages };
    }

    /**
     * 知识点的搜索 + 筛选，图与列表共用同一份结果。
     *
     * `filter` 取值：
     *   all        全部
     *   unlearned  掌握度 < 2（还没到「熟练」）
     *   marked     ★ 重点
     *   due        待复习（见 isReviewDue）
     *
     * 搜索命中名称、章名、节名与别名；大小写不敏感，空串即不筛。
     */
    function filterKnowledgeNodes(nodes, options = {}) {
      const list = Array.isArray(nodes) ? nodes : [];
      const query = String(options.query ?? '').trim().toLowerCase();
      const filter = options.filter ?? 'all';
      const now = Number.isFinite(options.now) ? options.now : Date.now();
      // 掌握度多选（2026-10-24）：用户要「自选熟练度展开」——四档可以任意勾选组合，
      // 空数组 = 不筛。与上面的 filter 是**与**关系（先按档筛，再按「只看未学」之类筛）。
      const levels = Array.isArray(options.masteryLevels)
        ? options.masteryLevels
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item >= 0 && item <= 3)
        : [];
      return list.filter((node) => {
        const rawMastery = Number(node?.mastery);
        const mastery = Number.isFinite(rawMastery) ? Math.min(3, Math.max(0, Math.trunc(rawMastery))) : 0;
        if (levels.length > 0 && !levels.includes(mastery)) return false;
        if (filter === 'unlearned' && mastery >= 2) return false;
        if (filter === 'marked' && node?.marked !== true) return false;
        if (filter === 'due' && !isReviewDue(node, now)) return false;
        // 未分节（2026-10-22 深夜）：还没挂到教材节上的节点。大纲树里它们堆在「未分节 / 未归类」，
        // 数电那种 PPT 骨架下会有一批，得能一键捞出来逐条「改挂靠」。
        // 2026-10-23 凌晨：体检算出的「可挂节点」集合传进来时以它为准——没有教材大纲的课
        // （物理整门）section 永远空，算进「未分节」只会让人以为挂得上去。
        if (filter === 'unmounted') {
          const mountable = Array.isArray(options.mountableIds) ? options.mountableIds : null;
          const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
          if (mountable !== null) {
            // 两个条件都要：这门课有大纲（挂得上去）+ 这个节点还没挂
            if (!mountable.includes(id) || String(node?.section ?? '').trim() !== '') return false;
          } else if (String(node?.section ?? '').trim() !== '') return false;
        }
        // 有问题（2026-10-23 凌晨）：未归类 / 未分节 / 无证据 / 证据悬空，四类合一，
        // 具体是哪类看工具条上的计数（点计数也能筛）
        if (filter === 'issues') {
          const ids = Array.isArray(options.issueIds) ? options.issueIds : [];
          const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
          if (!ids.includes(id)) return false;
        }
        // 没详解（2026-10-24 傍晚）：资料分析.json 里还没有这个知识点的条目。
        // 分析线是一批批写盘，这个档用来盯「还剩多少没写」，写完自然消失。
        if (filter === 'noanalysis') {
          const ids = Array.isArray(options.analysisIds) ? options.analysisIds : [];
          const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
          if (!ids.includes(id)) return false;
        }
        if (query === '') return true;
        const haystack = [
          node?.name,
          node?.chapter,
          node?.section,
          // 小节号也进搜索（2026-10-22 深夜）：搜「2.5.7」能直接落到 subsection
          node?.subsection,
          // 备注也进搜索（2026-10-23 凌晨）：自己写的「易错点/记法」是最想搜到的东西
          node?.note,
          ...(Array.isArray(node?.aliases) ? node.aliases : []),
        ]
          .filter((part) => typeof part === 'string')
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    /**
     * 待复习队列：重点 → 掌握度低 → 久未复习。
     *
     * 只排序不截断，显示几条由调用方决定；同样标重点时，掌握度更低的排前面——
     * 「未学 + 重点」比「学过 + 重点」更该先看。
     */
    function knowledgeReviewQueue(nodes, options = {}) {
      const now = Number.isFinite(options.now) ? options.now : Date.now();
      const idleMs = (node) => {
        const reviewedAt = typeof node?.reviewedAt === 'string' ? Date.parse(node.reviewedAt) : Number.NaN;
        if (Number.isFinite(reviewedAt)) return now - reviewedAt;
        const createdAt = typeof node?.createdAt === 'string' ? Date.parse(node.createdAt) : Number.NaN;
        return Number.isFinite(createdAt) ? now - createdAt : Number.MAX_SAFE_INTEGER;
      };
      return (Array.isArray(nodes) ? nodes : [])
        .filter((node) => isReviewDue(node, now))
        .sort((a, b) => Number(b?.marked === true) - Number(a?.marked === true)
          || (Number(a?.mastery) || 0) - (Number(b?.mastery) || 0)
          || idleMs(b) - idleMs(a)
          || String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'zh'));
    }

    /**
     * 下一批复习什么时候到期（毫秒时间戳），没有可提醒的节点就回 null。
     *
     * 用途：「今日」页那张卡在刚织完网的几天里必然是 0 条（所有节点都还没满 7 天），
     * 只写「没有到期的知识点」会让人以为坏了。这里直接算出最近一次到期时刻，
     * 卡片上写「下一批 10-27 到期」，一眼就知道规则在跑、只是还没轮上。
     * 时间不全、算不出起点的节点按「已到期」处理，不计入「下一批」。
     */
    function nextReviewDueAt(nodes, now = Date.now()) {
      let earliest = null;
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if ((Number(node?.mastery) || 0) >= 3) continue;
        const reviewedAt = typeof node?.reviewedAt === 'string' ? Date.parse(node.reviewedAt) : Number.NaN;
        const createdAt = typeof node?.createdAt === 'string' ? Date.parse(node.createdAt) : Number.NaN;
        const base = Number.isFinite(reviewedAt) ? reviewedAt : Number.isFinite(createdAt) ? createdAt : null;
        if (base === null) continue;
        const due = base + REVIEW_DUE_MS;
        if (due <= now) continue;
        if (earliest === null || due < earliest) earliest = due;
      }
      return earliest;
    }

    /**
     * 最近一段时间里复习过多少个节点（默认 7 天窗口）。
     *
     * 用途：「今日」页的待复习卡只有「还没到期」一种反馈，复习完反而看不出自己干了活。
     * 这里数 `reviewedAt` 落在窗口内的节点，卡片上写「本周复习 N 个」，让动作有回声。
     * 没有 `reviewedAt` / 时间非法 / 时间在未来（时钟歪了）都不计；窗口外的也不计。
     */
    function countReviewedWithin(nodes, now = Date.now(), windowMs = REVIEW_DUE_MS) {
      const limit = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : REVIEW_DUE_MS;
      let count = 0;
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const reviewedAt = typeof node?.reviewedAt === 'string' ? Date.parse(node.reviewedAt) : Number.NaN;
        if (!Number.isFinite(reviewedAt)) continue;
        const age = now - reviewedAt;
        if (age >= 0 && age <= limit) count += 1;
      }
      return count;
    }

    /**
     * 把知识点按「课程 → 章」分组，供列表视图折叠展示。
     *
     * 顺序刻意跟层级图一致（Map 插入序 = 数据里的出现序），这样图与列表
     * 同一章的位置对得上，来回切换不会「刚看的那章跑别处去了」。
     */
    function groupKnowledgeByChapter(nodes, labels = {}) {
      const out = new Map();
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const courseKey = node?.courseId ?? '__none__';
        const courseLabel = labels.course?.(node?.courseId) ?? '未匹配课程';
        const chapterKey = String(node?.chapter ?? '').trim() || '未分章';
        const key = `${courseKey}|${chapterKey}`;
        if (!out.has(key)) out.set(key, { key, courseKey, courseLabel, chapter: chapterKey, nodes: [] });
        out.get(key).nodes.push(node);
      }
      return [...out.values()].map((group) => ({
        ...group,
        nodes: group.nodes.slice().sort((a, b) => String(a.section ?? '').localeCompare(String(b.section ?? ''), 'zh')
          || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh')),
      }));
    }

    /**
     * 题目 → 知识点 的反向索引（纯函数）。
     *
     * 知识网络里节点的 `evidence[]` 指向题目（`{type:'question', id}`），但题目侧的
     * `knowledgeNames` 一直是空的。这里不改数据，只在客户端把关系反过来建一份索引，
     * 让「题目」视图能直接看到「这题考了哪几个点」，点一下跳到那个节点。
     */
    function knowledgeByQuestion(nodes) {
      const index = Object.create(null);
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const id = node?.id;
        if (typeof id !== 'string' || id === '') continue;
        const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
        for (const item of evidence) {
          if (!item || item.type !== 'question') continue;
          const questionId = typeof item.id === 'string' ? item.id : '';
          if (questionId === '') continue;
          if (!index[questionId]) index[questionId] = [];
          if (index[questionId].some((row) => row.id === id)) continue;
          index[questionId].push({
            id,
            name: String(node.name ?? id),
            mastery: Number(node.mastery) || 0,
            marked: node.marked === true,
          });
        }
      }
      // 重点在前、掌握度低的在前（和待复习队列同一套口味），同档按名称
      for (const key of Object.keys(index)) {
        index[key].sort((a, b) => Number(b.marked) - Number(a.marked) || a.mastery - b.mastery
          || a.name.localeCompare(b.name, 'zh'));
      }
      return index;
    }

    /**
     * `资料分析.json`（第 11 份文档）→ 「节点 id → 详解」的索引（纯函数）。
     *
     * 详解是离线批量预生成的（用户 2026-10-23 拍板：提前全部生成好，不现场跑），
     * 面板只按 id 查，查不到就明说「未分析」——绝不假装有内容。
     * 同 id 重复时后者覆盖前者（与 `tools/analysis.mjs` 的合并语义一致）。
     */
    function buildAnalysisPoints(doc) {
      const index = Object.create(null);
      const courses = Array.isArray(doc?.courses) ? doc.courses : [];
      for (const course of courses) {
        if (course === null || typeof course !== 'object') continue;
        const points = Array.isArray(course.points) ? course.points : [];
        for (const point of points) {
          if (point === null || typeof point !== 'object') continue;
          const id = typeof point.id === 'string' ? point.id.trim() : '';
          if (id === '') continue;
          index[id] = point;
        }
      }
      return index;
    }

    /**
     * 一章（或任意一组节点）的掌握度分布（纯函数）。
     *
     * 只做统计、不参与算分：`counts[0..3]` 是四档各几个，`mastered` 是「到熟练」
     * （`mastery >= 2`）的个数。列表页拿它画四段小条形图——以前的「到熟练 M」
     * 看不出分布，6 个节点里 5 个未学还是 5 个熟练都是一句话。
     */
    /**
     * 详解覆盖（2026-10-24 傍晚）：有多少知识点已经有预生成详解。
     *
     * 背景：分析线一批一批往 资料分析.json 里写 points[]，面板原来只能逐个点开看「未分析」，
     * 看不出「68 个里已经写了几个」。这里给工具条一个数字，点了就筛出「还没详解」的那批。
     *
     * 入参 index 是 buildAnalysisPoints 的产物（知识点 id → 详解条目）；空/坏输入一律按「一个都没有」算。
     */
    function analysisCoverage(nodes, index) {
      const list = Array.isArray(nodes) ? nodes : [];
      const table = index !== null && typeof index === 'object' ? index : {};
      let covered = 0;
      const missingIds = [];
      for (const node of list) {
        const raw = node?.id;
        const id = raw === undefined || raw === null ? '' : String(raw);
        const hit = id !== '' && table[id] !== undefined && table[id] !== null;
        if (hit) covered += 1;
        else if (id !== '') missingIds.push(id);
      }
      const total = list.length;
      return { total, covered, missing: total - covered, missingIds };
    }

    function chapterMasteryStats(nodes) {
      const counts = [0, 0, 0, 0];
      let marked = 0;
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const level = Math.min(3, Math.max(0, Math.round(Number(node?.mastery) || 0)));
        counts[level] += 1;
        if (node?.marked === true) marked += 1;
      }
      return {
        total: counts.reduce((sum, n) => sum + n, 0),
        counts,
        mastered: counts[2] + counts[3],
        marked,
      };
    }

    /**
     * 知识点树（纯函数）：学科 → 章 → 节 → 知识点（→ 子知识点，等数据带 parentId 后自动长出）。
     *
     * 用户要的是能一层层点开的树，而不是一屏平铺的节点。层级完全由数据算：
     * `courseId` → `chapter` → `section`；`section` 目前 68/68 都是空的，
     * 所以现在节点直接挂在章下面（等价于「学科 → 章 → 知识点」），
     * 等按教材目录重建、`section` 有值了，节这一层会自动出现——渲染代码不用改。
     *
     * 返回 `[{ key, kind:'course'|'chapter'|'section'|'node', label, children, count?, stats? }]`：
     * 分支层带 `count`（旗下节点数）与 `stats`（四档分布，给进度条），叶子带 `node` 原对象。
     */
    function buildKnowledgeTree(nodes, labels = {}) {
      const forest = new Map();
      const ensure = (map, key, init) => {
        if (!map.has(key)) map.set(key, init());
        return map.get(key);
      };
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const courseKey = String(node?.courseId ?? '').trim() || '__none__';
        const courseLabel = labels.course?.(node?.courseId) ?? '未匹配课程';
        const chapterLabel = String(node?.chapter ?? '').trim() || '未分章';
        const sectionLabel = String(node?.section ?? '').trim();
        const course = ensure(forest, courseKey, () => ({ key: `course:${courseKey}`, kind: 'course', label: courseLabel, children: new Map() }));
        const chapter = ensure(course.children, chapterLabel, () => ({ key: `chapter:${courseKey}|${chapterLabel}`, kind: 'chapter', label: chapterLabel, children: new Map() }));
        const holder = sectionLabel === ''
          ? chapter
          : ensure(chapter.children, sectionLabel, () => ({ key: `section:${courseKey}|${chapterLabel}|${sectionLabel}`, kind: 'section', label: sectionLabel, children: new Map() }));
        const nodeId = typeof node?.id === 'string' && node.id !== '' ? node.id : `anon:${holder.children.size}`;
        ensure(holder.children, nodeId, () => ({ key: `node:${nodeId}`, kind: 'node', label: String(node?.name ?? '(未命名)'), node, children: new Map() }));
      }
      const finish = (entry) => {
        if (entry.kind === 'node') {
          return { key: entry.key, kind: 'node', label: entry.label, node: entry.node, children: [] };
        }
        const children = [...entry.children.values()].map(finish);
        const leaves = [];
        const collect = (rows) => {
          for (const row of rows) {
            if (row.kind === 'node') leaves.push(row.node);
            else collect(row.children);
          }
        };
        collect(children);
        return { key: entry.key, kind: entry.kind, label: entry.label, children, count: leaves.length, stats: chapterMasteryStats(leaves) };
      };
      return [...forest.values()].map(finish);
    }

    /** 树里所有分支节点的 key（「全部展开」用）。 */
    function knowledgeTreeBranchKeys(tree) {
      const keys = [];
      const walk = (rows) => {
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row.kind === 'node') continue;
          keys.push(row.key);
          walk(row.children);
        }
      };
      walk(tree);
      return keys;
    }

    /**
     * 搜索命中分段（2026-10-22 深夜）：把 text 按 query 切成 [{text, hit}]。
     *
     * 为什么单独做纯函数：树/列表/讲解三处都要高亮，而「按什么规则切」一旦各写一份，
     * 就会出现「筛选命中了但视觉上没标出来」的不一致。大小写不敏感；query 去首尾空格；
     * 空词或无命中时返回**整段一个 hit:false**，调用方据此判断「要不要包 h()」。
     */
    function splitByQuery(text, query) {
      const source = String(text ?? '');
      const needle = String(query ?? '').trim().toLowerCase();
      if (needle === '' || source === '') return [{ text: source, hit: false }];
      const lower = source.toLowerCase();
      const parts = [];
      let at = 0;
      while (at < source.length) {
        const hit = lower.indexOf(needle, at);
        if (hit < 0) break;
        if (hit > at) parts.push({ text: source.slice(at, hit), hit: false });
        parts.push({ text: source.slice(hit, hit + needle.length), hit: true });
        at = hit + needle.length;
      }
      if (parts.length === 0) return [{ text: source, hit: false }];
      if (at < source.length) parts.push({ text: source.slice(at), hit: false });
      return parts;
    }

    /**
     * 大纲树（纯函数）：教材骨架 + 知识点挂靠。
     *
     * 数据来源是 `学习台/知识点大纲.json`（由 `tools/knowledge-outline.mjs` 从教材目录页解析生成）：
     * `courses[].chapters[].sections[].subs[]` 只是「章 / 节 / 小节」骨架，自身不带知识点。
     * 知识点（`知识点网络.json` 的节点）靠 `courseId + section + subsection` 挂到骨架上：
     * - `section: '2.6'` + `subsection: '2.6.5'` ⇒ 挂在 §2.6 下的 2.6.5 小节里；
     * - 只有 `section` ⇒ 直接挂在节下；
     * - 章对得上但节对不上 ⇒ 挂在这一章的「未分节」分支；
     * - 章也对不上 ⇒ 挂在课程的「未归类」分支；
     * - 课程完全没有大纲（数电/离散/物理目前就是这样）⇒ 退回 `buildKnowledgeTree` 的老算法，整门课接在后面。
     *
     * 返回形状与 `buildKnowledgeTree` 一致（`{key, kind, label, children, count, stats}`），
     * 额外给分支加 `empty: true`（旗下没有知识点）与 `page`（教材页码，有就显示）。
     */
    function buildOutlineTree(outline, nodes, labels = {}) {
      const rows = Array.isArray(nodes) ? nodes : [];
      const outlineCourses = Array.isArray(outline?.courses) ? outline.courses.filter((c) => c && typeof c.courseId === 'string') : [];
      if (outlineCourses.length === 0) return buildKnowledgeTree(rows, labels);

      const chapterNoOf = (chapterText) => {
        const hit = String(chapterText ?? '').match(/第\s*(\d+)\s*章/);
        return hit === null ? null : Number(hit[1]);
      };
      const sectionNoOf = (text) => String(text ?? '').trim().replace(/^§\s*/, '');

      const usedNodeIds = new Set();
      const finish = (entry) => {
        if (entry.kind === 'node') {
          return { key: entry.key, kind: 'node', label: entry.label, node: entry.node, children: [] };
        }
        const children = entry.children.map(finish);
        const leaves = [];
        const collect = (list) => {
          for (const row of list) {
            if (row.kind === 'node') leaves.push(row.node);
            else collect(row.children);
          }
        };
        collect(children);
        return {
          key: entry.key,
          kind: entry.kind,
          label: entry.label,
          page: entry.page ?? null,
          // 分支上带「在这一层加知识点」要预填的东西（课程/章/节/小节），叶子不需要
          ctx: entry.ctx ?? null,
          children,
          count: leaves.length,
          empty: leaves.length === 0,
          stats: chapterMasteryStats(leaves),
        };
      };

      const forest = outlineCourses.map((course) => {
        const courseKey = String(course.courseId);
        const courseLabel = labels.course?.(course.courseId) ?? course.name ?? courseKey;
        const courseRows = rows.filter((node) => String(node?.courseId ?? '') === courseKey);
        // 先把节点按 (章号, 节号, 小节号) 建索引，避免每层反复遍历
        const byChapter = new Map();
        const bucket = (map, key, init) => {
          if (!map.has(key)) map.set(key, init());
          return map.get(key);
        };
        for (const node of courseRows) {
          const no = chapterNoOf(node?.chapter);
          const list = bucket(byChapter, no === null ? 'none' : no, () => []);
          list.push(node);
        }
        const chapters = (Array.isArray(course.chapters) ? course.chapters : []).map((chap) => {
          const nodesHere = byChapter.get(Number(chap.no)) ?? [];
          byChapter.delete(Number(chap.no));
          const chapterLabel = `第${chap.no}章 ${String(chap.title ?? '').trim()}`;
          // ctx：这一层「＋」按钮要预填的章/节/小节，点一下就不用再手打章名
          const chapterCtx = { courseId: courseKey, chapter: chapterLabel, section: '', subsection: '' };
          const chapterRow = () => ({ key: `chapter:${courseKey}|${chap.no}`, kind: 'chapter', label: chapterLabel, page: chap.page ?? null, ctx: chapterCtx, children: [] });
          const chapterNode = chapterRow();
          chapterNode.children = (Array.isArray(chap.sections) ? chap.sections : []).map((sec) => {
            const secNo = sectionNoOf(sec.no);
            const secNodes = nodesHere.filter((node) => sectionNoOf(node?.section) === secNo);
            const subRows = (Array.isArray(sec.subs) ? sec.subs : []).map((sub) => {
              const subNo = sectionNoOf(sub.no);
              const inSub = secNodes.filter((node) => sectionNoOf(node?.subsection) === subNo);
              for (const node of inSub) usedNodeIds.add(node);
              return {
                key: `sub:${courseKey}|${chap.no}|${secNo}|${subNo}`,
                kind: 'sub',
                label: `${subNo} ${String(sub.title ?? '').trim()}`,
                page: sub.page ?? null,
                ctx: { courseId: courseKey, chapter: chapterLabel, section: secNo, subsection: subNo },
                children: inSub.map((node) => ({ key: `node:${node.id}`, kind: 'node', label: String(node.name ?? '(未命名)'), node, children: [] })),
              };
            });
            // 节下但没挂小节（或小节号对不上）的节点，直接挂在节里
            const rest = secNodes.filter((node) => !usedNodeIds.has(node));
            for (const node of rest) usedNodeIds.add(node);
            const sectionLeaves = rest.map((node) => ({ key: `node:${node.id}`, kind: 'node', label: String(node.name ?? '(未命名)'), node, children: [] }));
            /**
             * 一节既有小节、又有「只挂到节」的节点时，把后者收进一个分组行（2026-10-26）。
             * 不收的话它们会和小节下拉**并排**摆着，用户看到的就是「小节下拉全是空、知识点却掉在外面」——
             * 数据侧 221 个节点里只有 33 个填了 subsection，这个形状在前端必须兜住。
             */
            const grouped = subRows.length > 0 && sectionLeaves.length > 0;
            return {
              key: `section:${courseKey}|${chap.no}|${secNo}`,
              kind: 'section',
              label: `§${secNo} ${String(sec.title ?? '').trim()}`,
              page: sec.page ?? null,
              ctx: { courseId: courseKey, chapter: chapterLabel, section: secNo, subsection: '' },
              children: [
                ...(grouped
                  ? [{
                    key: `section-nodes:${courseKey}|${chap.no}|${secNo}`,
                    kind: 'group',
                    label: '本节知识点（未分到小节）',
                    page: null,
                    ctx: { courseId: courseKey, chapter: chapterLabel, section: secNo, subsection: '' },
                    children: sectionLeaves,
                  }]
                  : []),
                ...subRows,
                ...(grouped ? [] : sectionLeaves),
              ],
            };
          });
          // 章里没对上任何节的节点 → 「未分节」
          const unmatched = nodesHere.filter((node) => !usedNodeIds.has(node));
          if (unmatched.length > 0) {
            for (const node of unmatched) usedNodeIds.add(node);
            chapterNode.children.push({
              key: `section:${courseKey}|${chap.no}|~`,
              kind: 'section',
              label: '没归到节（这章里还没对上某一节）',
              page: null,
              ctx: chapterCtx,
              children: unmatched.map((node) => ({ key: `node:${node.id}`, kind: 'node', label: String(node.name ?? '(未命名)'), node, children: [] })),
            });
          }
          return chapterNode;
        });
        // 章号对不上大纲的节点（如离散第 14 章、数据结构第 2 章这类在教材里找不到的）→ 「未归类」
        const orphans = [];
        for (const list of byChapter.values()) orphans.push(...list);
        const children = [...chapters];
        if (orphans.length > 0) {
          children.push({
            key: `chapter:${courseKey}|~`,
            kind: 'chapter',
            label: '章号对不上（教材目录里没这一章）',
            page: null,
            children: orphans.map((node) => ({ key: `node:${node.id}`, kind: 'node', label: String(node.name ?? '(未命名)'), node, children: [] })),
          });
        }
        return { key: `course:${courseKey}`, kind: 'course', label: courseLabel, page: null, children };
      });

      // 没有大纲的课程照旧用老算法，整门课接在后面
      const outlineCourseIds = new Set(outlineCourses.map((course) => String(course.courseId)));
      const legacyNodes = rows.filter((node) => !outlineCourseIds.has(String(node?.courseId ?? '')));
      const legacy = legacyNodes.length === 0 ? [] : buildKnowledgeTree(legacyNodes, labels);
      return [...forest, ...legacy].map(finish);
    }

    /**
     * 知识点体检（2026-10-23 凌晨）：把「挂靠看起来对、实际挂空」的节点挑出来。
     *
     * 为什么要有：树把问题**藏起来了**——章名差一个字的节点不会报错，只是悄悄堆进「未归类」；
     * `evidence` 指向不存在的题号，点开只显示「题干缺失」。68 个节点逐个点开看不现实，
     * 所以先机算一遍，给个数字 + 一键筛出来。（`tools/knowledge-audit.mjs` 是同一件事的
     * 命令行版，那份给「改完挂靠后自检」，这份给面板上当场看。）
     *
     * 口径（四个计数可以重叠，同一个节点可能既未分节又无证据）：
     *   - unclassified：这门课有教材大纲，但节点的 `chapter` 章号在大纲里找不到
     *   - unmounted：`section` 为空（只挂到章，没挂到节）
     *   - noEvidence：`evidence` 为空
     *   - dangling：有题证据，但 `题目.json` 里查不到那个 id（点开只能是「题干缺失」）
     */
    function knowledgeHealth(nodes, options = {}) {
      const list = Array.isArray(nodes) ? nodes : [];
      const outlineCourses = Array.isArray(options.outline?.courses)
        ? options.outline.courses.filter((course) => course && typeof course.courseId === 'string')
        : [];
      const chapterIndex = new Map(); // courseId → Set<章号>
      for (const course of outlineCourses) {
        const numbers = new Set();
        for (const chap of Array.isArray(course.chapters) ? course.chapters : []) {
          const no = Number(chap?.no);
          if (Number.isFinite(no)) numbers.add(no);
        }
        chapterIndex.set(String(course.courseId), numbers);
      }
      const knownQuestions = new Set(
        (Array.isArray(options.questions) ? options.questions : [])
          .map((item) => (item?.id === undefined || item?.id === null ? '' : String(item.id)))
          .filter((id) => id !== ''),
      );
      const chapterNoOf = (chapterText) => {
        const hit = String(chapterText ?? '').match(/第\s*(\d+)\s*章/);
        return hit === null ? null : Number(hit[1]);
      };

      const issues = { unclassified: [], unmounted: [], noEvidence: [], dangling: [] };
      const mountableIds = new Set(); // 有教材大纲课程的节点：只有它们「挂节」才落得下去
      let noOutline = 0; // 课程在《知识点大纲》里没有条目 ⇒ 整门退回老树，挂节也无处可挂
      const seen = new Map();
      for (const node of list) {
        const id = node?.id === undefined || node?.id === null ? '' : String(node.id);
        if (id !== '') seen.set(id, (seen.get(id) ?? 0) + 1);
        const numbers = chapterIndex.get(String(node?.courseId ?? ''));
        if (numbers !== undefined) {
          mountableIds.add(id);
          const no = chapterNoOf(node?.chapter);
          if (no === null || !numbers.has(no)) issues.unclassified.push(node);
        } else {
          noOutline += 1;
        }
        // 「未分节」只算**有教材大纲**的课：物理整门没大纲，它的节点永远是空 section，
        // 把它算进来会让体检行写着「未分节 41」，可那 29 个根本没地方挂（2026-10-23 凌晨修）
        if (numbers !== undefined && String(node?.section ?? '').trim() === '') issues.unmounted.push(node);
        const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
        if (evidence.length === 0) issues.noEvidence.push(node);
        else if (evidence.some((item) => item?.type === 'question'
          && !knownQuestions.has(String(item?.id ?? '')))) issues.dangling.push(node);
      }
      const duplicateIds = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
      const issueIds = new Set();
      for (const bucket of Object.values(issues)) {
        for (const node of bucket) {
          if (node?.id !== undefined && node?.id !== null) issueIds.add(String(node.id));
        }
      }
      return {
        total: list.length,
        unclassified: issues.unclassified.length,
        unmounted: issues.unmounted.length,
        noEvidence: issues.noEvidence.length,
        dangling: issues.dangling.length,
        duplicateIds,
        issueIds: [...issueIds],
        mountableIds: [...mountableIds],
        noOutline,
      };
    }

    // 掌握度的视觉编码（2026-10-23 夜，A 块）：符号 + 颜色，图/导图/列表共用一套。
    // 只用字面色值（不新造主题令牌）；主题换肤时这几个色仍可读，不会出现「黑底黑字」。
    const MASTERY_STYLE = [
      { label: '未学', symbol: '○', color: '#9aa0a6' },
      { label: '学过', symbol: '◔', color: '#4a7cf7' },
      { label: '熟练', symbol: '◑', color: '#e8a33d' },
      { label: '精通', symbol: '●', color: '#2fa84f' },
    ];

    // 思维导图布局（2026-10-23 夜，A 块）：把「全部 → 课程 → 章 → 知识点」排成横向树，
    // 叶子按顺序占行、父节点取子节点竖直中心；连线交给渲染层画贝塞尔，纯函数、可测。
    // 以同一份教材树生成导图；补齐节、小节与本节知识点分组。
    function buildMindMap(nodes, labels = {}, options = {}) {
      const list = objectList(nodes).filter(node => !options.courseRoot || (String(node.courseId ?? '').trim() || '__none__') === options.courseId);
      if (list.length === 0) return { width: 0, height: 0, nodes: [], links: [], points: 0, collapsed: 0 };
      const expanded = options.expanded == null ? null : new Set(Array.isArray(options.expanded) ? options.expanded : []);
      const forest = buildOutlineTree(options.outline, list, labels).filter(entry => !options.courseRoot || entry.key === 'course:' + options.courseId);
      const result = [], links = [];
      let points = 0, collapsed = 0;
      const widths = {root:150,course:200,chapter:230,section:230,sub:230,group:240,point:310};
      const wrap = (value, limit) => {
        const parts = []; let line = '', size = 0;
        for (const char of String(value ?? '')) {
          const next = char.charCodeAt(0) > 255 ? 16 : 9;
          if (line && size + next > limit) { parts.push(line); line = ''; size = 0; }
          line += char; size += next;
        }
        if (line || !parts.length) parts.push(line);
        return parts;
      };
      const make = (entry, depth, parent) => {
        const point = entry.kind === 'node';
        if (!point && !entry.count) return null;
        const kind = point ? 'point' : entry.kind;
        const key = 'mind:' + entry.key;
        const node = { key,kind,label:entry.label,depth,x:0,y:0,id:point ? entry.node?.id ?? null : null,
          mastery:point ? Number(entry.node?.mastery)||0 : null,marked:point && entry.node?.marked === true,
          total:point ? 1 : entry.count,children:0,width:widths[kind] || 230 };
        node.lines = wrap(node.label, node.width - 36);
        node.height = Math.max(56, node.lines.length * 24 + 34);
        const compact = text => String(text ?? '').split(' ').join('');
        const legacyMatch = expanded !== null && [...expanded].some(value => !String(value).startsWith('mind:') && compact(value) === compact(node.label));
        node.open = kind !== 'chapter' || expanded === null || expanded.has(key) || legacyMatch;
        if (kind === 'chapter' && !node.open) collapsed += 1;
        result.push(node);
        if (parent) links.push({key:parent.key+'>'+key,from:parent.key,to:key});
        if (point) points += 1;
        const children = node.open ? (entry.children || []).map(c=>make(c,depth+1,node)).filter(Boolean) : [];
        node.children = children.length;
        return {node,children};
      };
      let tree;
      if (options.courseRoot) {
        tree = forest.length ? make(forest[0], 0, null) : null;
        if (!tree) return { width: 0, height: 0, nodes: [], links: [], points: 0, collapsed: 0 };
      } else {
        const root = {key:'mind:root',kind:'root',label:'全部知识点',depth:0,x:0,y:0,id:null,mastery:null,marked:false,total:list.length,width:150,height:66,lines:['全部知识点'],open:true,children:0};
        result.push(root);
        const children = forest.map(e=>make(e,1,root)).filter(Boolean);root.children=children.length;
        tree = {node:root,children};
      }
      const measure = entry => {
        const sum = entry.children.reduce((n,c)=>n+measure(c),0)+Math.max(0,entry.children.length-1)*18;
        entry.span = Math.max(entry.node.height,sum); return entry.span;
      };
      const height = measure(tree);
      const columnWidths = [];
      for (const n of result) columnWidths[n.depth] = Math.max(columnWidths[n.depth] || 0,n.width);
      const offsets = [24];
      for (let i=1;i<columnWidths.length;i++) offsets[i]=offsets[i-1]+columnWidths[i-1]+64;
      const position = (entry,top) => {
        entry.node.x=offsets[entry.node.depth];entry.node.y=top+entry.span/2;
        const total=entry.children.reduce((n,c)=>n+c.span,0)+Math.max(0,entry.children.length-1)*18;
        let y=top+(entry.span-total)/2;
        for (const child of entry.children) {position(child,y);y+=child.span+18;}
        if (entry.children.length) entry.node.y = entry.children[0].node.y;
      };
      position(tree,24);
      return {width:offsets[offsets.length-1]+columnWidths[columnWidths.length-1]+24,height:height+48,nodes:result,links,points,collapsed};
    }

    function MaterialsTab({ docs = {}, view: initialView = 'files', refresh, onOpenKnowledge, focus = null, onFocusConsumed }) {
      const files = objectList(docs.materials?.files);
      const questions = objectList(docs.questions?.questions);
      const candidates = objectList(docs.knowledgeCandidates?.candidates);
      // 2026-10-23 凌晨：文档被外部改坏时 nodes 里可能出现 null / 非对象（真实渲染探针抓到过），
      // 这里统一先剔掉——树、体检、图、列表都靠这份 netNodes，任何一处拿到 null 都会整页白屏。
      const netNodes = objectList(docs.knowledgeNetwork?.nodes);
      const courses = objectList(docs.courses?.courses);

      // 资料页界面记忆（2026-10-24 傍晚）：切走再回来保持原处，也是「返回上一页」能复位的前提
      const restoredMat = readMaterialsUi();
      const [view, setView] = useState(initialView === 'questions' ? 'questions' : restoredMat.view);
      const [courseId, setCourseId] = useState(restoredMat.courseId);
      const [openPath, setOpenPath] = useState(restoredMat.openPath);
      const [detail, setDetail] = useState(null); // { status, data }

      const courseName = (id) => courses.find((item) => item.id === id)?.name ?? (id || '未匹配课程');
      const keep = (item) => courseId === '' || item?.courseId === courseId;

      const showMaterial = async (materialPath, page) => {
        setOpenPath(materialPath);
        setDetail({ status: 'loading', data: null });
        const result = await materialText(materialPath, page).catch(() => ({ ok: false, error: 'network' }));
        setDetail({ status: result.ok ? 'ready' : 'error', data: result });
      };

      const pill = (text, level) => h('span', { className: `sa-pill ${level}` }, text);

      // 跨页签联动（2026-10-21 夜批3）：知识点页点「去资料页看」时带着 path/page 过来，
      // 这里直接打开那份资料的正文——不然用户得自己去长列表里翻同一份文件。
      useEffect(() => {
        const target = focus?.path;
        if (typeof target !== 'string' || target === '') return;
        setView('files');
        setCourseId('');
        showMaterial(target, focus?.page);
        onFocusConsumed?.();
      }, [focus]);

      // 记回界面记忆；顺带把当前页号也记下，恢复时能回到同一页
      useEffect(() => {
        readMaterialsUi({ view, courseId, openPath, openPage: detail?.data?.page ?? null });
      }, [view, courseId, openPath, detail]);

      // 恢复上次打开的文件（返回/切页签回来时用）。有 focus 时以 focus 为准，别互相打架。
      useEffect(() => {
        if (typeof focus?.path === 'string' && focus.path !== '') return;
        const restored = readMaterialsUi();
        if (restored.openPath !== null) showMaterial(restored.openPath, restored.openPage ?? undefined);
      }, []);

      const materialRows = files.filter(keep);
      const questionRows = questions.filter(keep);
      const candidateRows = candidates.filter(keep);
      // 题目 → 知识点：从节点的 evidence 反查，题目视图用它显示「这题考了哪些点」
      const knowledgeIndex = knowledgeByQuestion(netNodes);

      const emptyText = {
        files: '还没有资料索引。跑一次取字批次后会写进 学习台/资料索引.json。',
        questions: '还没有题目台账。取字批次分题后写进 学习台/题目.json。',
        knowledge: '还没有知识点候选。分题后由批次写进 学习台/知识点候选.json，再确认。',
      };
      const head = h('div', { className: 'sa-card' },
        h('h3', null, '课程资料与复习'),
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-muted' }, '课程'),
          h('select', {
            className: 'sa-input',
            value: courseId,
            onChange: (event) => setCourseId(event.target.value),
          }, h('option', { value: '' }, '全部'),
          ...courses.map((course) => h('option', { key: course.id, value: course.id }, course.name))),
          h('span', { className: 'sa-muted' },
            `资料 ${materialRows.length} · 题目 ${questionRows.length} · 候选 ${candidateRows.length}`),
          h('span', { className: 'sa-spacer' }),
          ...[['files', '资料'], ['questions', '题目']].map(([key, label]) =>
            h('button', {
              key,
              className: `sa-btn${view === key ? ' primary' : ''}`,
              onClick: () => setView(key),
            }, label)),
        ),
      );

      const materialList = materialRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' }, emptyText.files)
        : h('div', { className: 'sa-card' }, materialRows.map((item) => {
          const donePages = Array.isArray(item?.ocr?.donePages) ? item.ocr.donePages.length : 0;
          const totalPages = Number(item?.ocr?.pages) || 0;
          const isText = typeof item?.text?.outFile === 'string' && item.text.outFile !== '';
          const state = isText
            ? pill('文字层', 'soon')
            : item?.ocr?.done === true
              ? pill(`${donePages}/${totalPages || donePages} 页`, 'later')
              : pill('未取字', 'today');
          const isOpen = openPath === item.path;
          return h('div', {
            key: item.path,
            className: 'sa-row',
            style: { cursor: 'pointer', alignItems: 'flex-start' },
            onClick: () => (isOpen ? (setOpenPath(null), setDetail(null)) : showMaterial(item.path)),
          },
          h('span', { className: 'sa-grow', title: item.path },
            item.path,
            h('div', { className: 'sa-muted', style: { fontSize: 14 } },
              `${courseName(item.courseId)} · ${item.kind ?? '未标类型'}`)),
          state,
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, isOpen ? '收起' : '看内容'));
        }));


      const detailCard = openPath === null ? null : h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-grow', title: openPath }, detail?.data?.file ?? openPath),
          detail?.data?.truncated === true ? pill('已截断', 'today') : null,
          h('button', {
            className: 'sa-btn',
            title: '关上这份正文（也可以按左上角「返回」回到上一个位置）',
            onClick: () => {
              setOpenPath(null);
              setDetail(null);
              readMaterialsUi({ openPath: null, openPage: null });
            },
          }, '关闭')),
        detail?.status === 'loading' ? h('div', { className: 'sa-muted' }, '正在读取…') : null,
        detail?.status === 'error'
          ? h('div', null,
            h('div', { className: 'sa-error' },
              detail.data?.error === 'no-text'
                ? '这份资料还没有取字产物（扫描件要先跑取字）。'
                : detail.data?.error === 'page-missing'
                  ? `第 ${detail.data?.page} 页还没有取字产物。`
                  : detail.data?.error === 'not-indexed'
                    ? '这份资料不在索引里，可能索引刚被改过，刷新试试。'
                    : `读取失败：${detail.data?.error ?? '未知原因'}`),
            Array.isArray(detail.data?.pages) && detail.data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { marginTop: 6 } },
                h('span', { className: 'sa-muted' }, `已有的页：${detail.data.pages.join('、')}`))
              : null)
          : null,
        detail?.status === 'ready'
          ? h('div', null,
            Array.isArray(detail.data.pages) && detail.data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'sa-muted' }, '页'),
                ...detail.data.pages.map((no) => h('button', {
                  key: no,
                  className: `sa-btn${no === detail.data.page ? ' primary' : ''}`,
                  onClick: () => showMaterial(openPath, no),
                }, String(no))))
              : null,
            h('pre', {
              className: 'sa-reading-pre',
              style: {
                margin: 0,
                maxHeight: '46vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 14,
                lineHeight: 1.6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 'var(--dsw-radius-sm)',
                padding: 10,
              },
            }, detail.data.text ?? ''))
          : null);


      const questionList = questionRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' }, emptyText.questions)
        : h('div', { className: 'sa-card' }, questionRows.map((item, index) => h('div', {
          key: item.id ?? `${item.sourceFile ?? ''}#${item.no ?? index}`,
          className: 'sa-row',
          style: { alignItems: 'flex-start' },
        },
        pill(String(item.no ?? '?'), 'later'),
        h('span', { className: 'sa-grow', title: item.prompt ?? '' },
          (item.prompt ?? '').slice(0, 120),
          h('div', { className: 'sa-muted', style: { fontSize: 14 } },
            [courseName(item.courseId), item.sourceFile, item.page === undefined ? '' : `第 ${item.page} 页`]
              .filter((part) => typeof part === 'string' && part !== '').join(' · '))),
        ...((knowledgeIndex[item.id] ?? []).length > 0
          ? (knowledgeIndex[item.id] ?? []).map((node) => h('span', {
            key: node.id,
            className: `sa-pill ${node.marked ? 'today' : 'soon'}`,
            title: `${node.marked ? '★ 重点 · ' : ''}掌握度：${MASTERY_LABELS[node.mastery] ?? '未学'} · 点一下跳到这个知识点`,
            style: { cursor: 'pointer' },
            onClick: () => onOpenKnowledge?.(node.id),
          }, node.name))
          : (Array.isArray(item.knowledgeNames) ? item.knowledgeNames.slice(0, 3).map((name) => pill(name, 'soon')) : [])))));

      return h('div', null,
        head,
        view === 'files' ? materialList : questionList,
        detailCard);
    }
    /**
     * 知识点页签（2026-10-21 夜，第七个页签）：从「资料」页抽出来的独立大板块。
     *
     * 为什么独立：知识点是复习主线，塞在资料页第三视图里既看不见、也没法跟题目/资料联动。
     * 抽出来后资料页只管「看原文、看题目」，这里只管「浏览树、标掌握度、看/生成讲解」。
     * 这一批只搬家不改行为：图 / 列表 / 讲解三种视图与批量标记原样保留，数据与接口都不动。
     */
    // 页签界面状态（2026-10-22 凌晨）：切到别的页签再回来时，展开到哪、搜了什么、选中哪个节点
    // 不该丢——React 组件卸载后 useState 会重置。这份状态没有跨会话价值（也不该进 学习台/ 数据），
    // 所以只放在模块内存里：关掉面板或重启宿主就自然清空。
    // 学科树独立记忆开合和滚动；仅存内存，不可变更新保护历史快照。
    function knowledgeTreeCourses(nodes, outline, courses) {
      const ids = new Set();
      for (const n of objectList(nodes)) ids.add(String(n.courseId ?? '').trim() || '__none__');
      for (const c of objectList(outline?.courses)) if (c.courseId) ids.add(String(c.courseId));
      const known = objectList(courses);
      const order = [...known.map(c => String(c.id)).filter(id => ids.has(id)), ...ids, ...known.filter(c => c.id).map(c => String(c.id))];
      return [...new Set(order)].map(id => ({ id, name: known.find(c => String(c.id) === id)?.name
        || objectList(outline?.courses).find(c => String(c.courseId) === id)?.name || (id === '__none__' ? '未匹配学科' : id) }));
    }
    function subjectTreeState(memory, courseId) {
      const saved = memory && Object.prototype.hasOwnProperty.call(memory, courseId) ? memory[courseId] : null;
      const keys = (value, fallback) => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x !== '').slice(0,1000) : fallback;
      const coord = value => Number.isFinite(Number(value)) ? Math.max(0,Number(value)) : 0;
      const point = value => ({ left: coord(value?.left), top: coord(value?.top) });
      return { openTree: keys(saved?.openTree, ['course:' + courseId]), mindOpen: keys(saved?.mindOpen, []),
        scroll: { mind: point(saved?.scroll?.mind), tree: point(saved?.scroll?.tree) } };
    }
    function patchSubjectTree(memory, courseId, patch = {}) {
      const previous = subjectTreeState(memory, courseId);
      return { ...(memory || {}), [courseId]: subjectTreeState({ [courseId]: { ...previous, ...patch,
        scroll: { ...previous.scroll, ...(patch.scroll || {}) } } }, courseId) };
    }

    const KP_UI_DEFAULTS = Object.freeze({ courseId: '', query: '', filter: 'all', view: 'mind', selected: null, openTree: [], mindOpen: null, masteryLevels: [], detailPath: null, treeCourseId: '', subjectTrees: {} });
    const KP_UI_FILTERS = ['all', 'unlearned', 'marked', 'due', 'unmounted', 'issues', 'noanalysis'];
    const KP_UI_VIEWS = ['tree', 'mind', 'graph', 'list', 'explain'];
    let kpUiMemory = { ...KP_UI_DEFAULTS, openTree: [], mindOpen: null };
    // 服务端 `/mutate items` 一次最多 500 条（超了直接 400 `too-many-items`，不再静默截断）。
    // 面板这边先拦一道：命中太多时给一句人话，而不是让用户看到后端错误码。
    const BATCH_LIMIT = 500;

    /** 读界面状态；传 patch 则先合并再返回（坏值一律夹回默认，别把界面卡死在非法状态）。 */
    function readKnowledgeUi(patch = null) {
      if (patch && typeof patch === 'object') {
        const next = { ...kpUiMemory, ...patch };
        kpUiMemory = {
          courseId: typeof next.courseId === 'string' ? next.courseId : '',
          treeCourseId: typeof next.treeCourseId === 'string' ? next.treeCourseId : '',
          subjectTrees: Object.fromEntries(Object.keys(next.subjectTrees && typeof next.subjectTrees === 'object' && !Array.isArray(next.subjectTrees) ? next.subjectTrees : {}).slice(0,100).map(id => [id, subjectTreeState(next.subjectTrees, id)])),
          query: typeof next.query === 'string' ? next.query : '',
          filter: KP_UI_FILTERS.includes(next.filter) ? next.filter : 'all',
          view: KP_UI_VIEWS.includes(next.view) ? next.view : 'mind',
          selected: typeof next.selected === 'string' && next.selected !== '' ? next.selected : null,
          openTree: Array.isArray(next.openTree)
            ? next.openTree.filter((item) => typeof item === 'string' && item !== '').slice(0, 400)
            : [],
          mindOpen: next.mindOpen === null
            ? null
            : (Array.isArray(next.mindOpen)
              ? next.mindOpen.filter((item) => typeof item === 'string' && item !== '').slice(0, 400)
              : null),
          // 掌握度多选（2026-10-24）：只收 0–3 的整数、去重、升序，空数组表示不筛
          masteryLevels: Array.isArray(next.masteryLevels)
            ? [...new Set(next.masteryLevels
              .map((item) => Number(item))
              .filter((item) => Number.isInteger(item) && item >= 0 && item <= 3))].sort((a, b) => a - b)
            : [],
          // 正文卡打开的文件（2026-10-24 傍晚）：返回时要能复原「看原页」，所以一起记
          detailPath: typeof next.detailPath === 'string' && next.detailPath !== '' ? next.detailPath : null,
        };
      }
      return kpUiMemory;
    }

    /** 清空界面记忆（测试用；用户在面板里没有入口）。 */
    function resetKnowledgeUi() {
      kpUiMemory = { ...KP_UI_DEFAULTS, openTree: [], subjectTrees: {} };
      return kpUiMemory;
    }

    // ── 资料页界面记忆（2026-10-24 傍晚）──────────────────────────────
    // 以前资料页切走再回来会重置（看的是资料还是题目、筛了哪门课、「看内容」打开哪份文件全丢）。
    // 加了「返回上一页」以后这些必须记住、也必须能被写回去，所以一并搬进模块内存。
    const MATERIALS_UI_DEFAULTS = Object.freeze({ view: 'files', courseId: '', openPath: null, openPage: null });
    let materialsUiMemory = { ...MATERIALS_UI_DEFAULTS };

    function readMaterialsUi(patch = null) {
      if (patch && typeof patch === 'object') {
        const next = { ...materialsUiMemory, ...patch };
        const page = Number(next.openPage);
        materialsUiMemory = {
          view: next.view === 'questions' ? 'questions' : 'files',
          courseId: typeof next.courseId === 'string' ? next.courseId : '',
          openPath: typeof next.openPath === 'string' && next.openPath !== '' ? next.openPath : null,
          openPage: Number.isFinite(page) && page > 0 ? Math.floor(page) : null,
        };
      }
      return materialsUiMemory;
    }

    /** 清空资料页记忆（测试用）。 */
    function resetMaterialsUi() {
      materialsUiMemory = { ...MATERIALS_UI_DEFAULTS };
      return materialsUiMemory;
    }

    // ── 返回 / 前进（2026-10-24 傍晚，用户报「没有上一页，点进去回不来」）──
    // 面板里到处是「跳到别处」：资料页点题目里的知识点、知识点页点「看原页」、今日页点待复习项……
    // 跳过去之后没有任何回来的路（正文卡连关闭按钮都没有），只能靠页签绕回。
    // 这里做最小的浏览器式历史：一次「位置」= 页签 + 资料页记忆 + 知识点页记忆的快照；
    // 返回/前进就是把快照写回模块内存，再 bump 一个版本号让子组件重挂载
    // ——子组件挂载时本来就从内存恢复初值，等于原路返回。
    const NAV_LIMIT = 40;
    let navHistory = [];
    let navIndex = -1;
    let navTabMemory = 'today';

    function navSnapshot(tab) {
      return {
        tab,
        materials: { ...readMaterialsUi() },
        knowledge: { ...readKnowledgeUi() },
      };
    }

    function navSame(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    /** 记下「现在在哪」；和栈顶一样就不重复记（避免连点页签堆一长串空历史）。 */
    function navPush(entry) {
      if (navIndex >= 0 && navSame(navHistory[navIndex], entry)) return;
      navHistory = navHistory.slice(0, navIndex + 1);
      navHistory.push(entry);
      if (navHistory.length > NAV_LIMIT) navHistory = navHistory.slice(navHistory.length - NAV_LIMIT);
      navIndex = navHistory.length - 1;
    }

    function navCanBack() {
      return navIndex > 0;
    }

    function navCanForward() {
      return navIndex >= 0 && navIndex < navHistory.length - 1;
    }

    /** 后退/前进：把目标位置的记忆写回去并返回它；到头了回 null。 */
    function navMove(step) {
      if (navHistory.length === 0) return null;
      const next = navIndex + step;
      if (next < 0 || next >= navHistory.length) return null;
      navIndex = next;
      const entry = navHistory[navIndex];
      readMaterialsUi({ ...entry.materials });
      readKnowledgeUi({ ...entry.knowledge });
      navTabMemory = entry.tab;
      return entry;
    }

    function navBack() {
      return navMove(-1);
    }

    function navForward() {
      return navMove(1);
    }

    /** 清空导航历史（测试用；用户在面板里没有入口）。 */
    function resetNavigation() {
      navHistory = [];
      navIndex = -1;
      navTabMemory = 'today';
    }

    const analysisParagraphs = (text) => String(text ?? '')
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    /**
     * 详解正文的**行内**轻量 Markdown（2026-10-26 加）：`**粗体**`、`*斜体*`、
     * `` `代码` ``、`$公式$` 四种。
     *
     * 为什么自己写而不用库：面板是零依赖单文件客户端，引一个 markdown 解析器等于把几万行
     * 塞进 client.js；生成侧实际只产出这几种最轻的标记（全库 840 条正文里 `**` 158 条、
     * 反引号 22 条、`$` 11 条、单星号斜体 13 条、竖线表格 42 条，没有嵌套、没有 HTML）。
     *
     * 安全口径：**先切分、再建 React 节点**，任何一段都走文本节点，绝不拼 innerHTML ——
     * 所以正文里出现 `<script>` 也只会被当成字面量显示。
     */
    const INLINE_MARK_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\$[^$\n]{2,}\$)/gu;
    const analysisInline = (text, keyPrefix = 'in') => String(text ?? '')
      .split(INLINE_MARK_PATTERN)
      .filter((part) => part !== '')
      .map((part, index) => {
        const key = `${keyPrefix}-${index}`;
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h('strong', { key }, part.slice(2, -2));
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return h('em', { key }, part.slice(1, -1));
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return h('code', { key, style: { fontFamily: 'Consolas, monospace', fontSize: '0.95em', padding: '0 2px' } }, part.slice(1, -1));
        }
        if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) {
          return h('span', { key, style: { fontFamily: 'Georgia, "Times New Roman", serif', fontSize: '1.04em' } },
            ...latexNodes(part.slice(1, -1), `${key}-math`));
        }
        return part;
      });
    /** 列表行：`- x` / `* x` / `1. x`（够用就好，不认缩进层级、不认嵌套）。 */
    const LIST_LINE_PATTERN = /^(?:[-*+]|\d+[.、)])\s+/u;
    const isListLine = (line) => LIST_LINE_PATTERN.test(line);
    /**
     * 公式渲染：LaTeX → 符号（2026-10-26 深夜，第二版）。
     *
     * 第一版把 `$…$` 当等宽斜体文字、把 `formulas[].tex` 原样贴在 Consolas 里 ——
     * 结果读者看到的是一串 `V_{IL} \Rightarrow V_{OH}\approx V_{DD}` 的**源码**。
     * 这里改成真排版：
     *   - 上下标真的变小、分式真的上下叠、根号带横线、上划线用 `text-decoration`；
     *   - 希腊字母与关系符换成字符（`\Rightarrow` → ⇒、`\approx` → ≈）；
     *   - `\text{}` / `\mathrm{}` / `\mathbf{}` 等只保留内容（粗体那几种加粗）；
     *   - **认不出的命令只保留名字、绝不把反斜杠露出去**；
     *   - `\begin{cases}` 这类环境不排版（真实数据里只 15 处），内容平铺、外层退回 `plain` 说明。
     *
     * 为什么不是 KaTeX / MathJax：面板是零依赖单文件客户端，引库等于再塞几十万字符 +
     * 字体文件 + 一条静态资源路由；而课件公式实际只用到「上下标 + 分式 + 希腊字母 + 关系符」
     * 这几样（全库 1115 条 tex，命令 153 种）。要更漂亮的排版可以另开一轮换 KaTeX，但不是必须。
     */
    const LATEX_GREEK = {
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε',
      zeta: 'ζ', eta: 'η', theta: 'θ', Theta: 'Θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
      xi: 'ξ', pi: 'π', Pi: 'Π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', varphi: 'φ',
      Phi: 'Φ', varPhi: 'Φ', chi: 'χ', psi: 'ψ', Psi: 'Ψ', omega: 'ω', Omega: 'Ω', Gamma: 'Γ',
      ell: 'ℓ', hbar: 'ħ', aleph: 'ℵ',
    };
    const LATEX_SYMBOL = {
      to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Longrightarrow: '⟹',
      Longleftrightarrow: '⟺', Leftrightarrow: '⇔', iff: '⇔', implies: '⇒', mapsto: '↦',
      approx: '≈', le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', ne: '≠',
      neq: '≠', equiv: '≡', cong: '≅', sim: '∼', simeq: '≃', propto: '∝', lesssim: '≲', gg: '≫', ll: '≪',
      in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', subsetneq: '⊊', supset: '⊃', supseteq: '⊇',
      setminus: '∖', cup: '∪', cap: '∩', bigcup: '⋃', bigcap: '⋂', varnothing: '∅', emptyset: '∅',
      land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬', oplus: '⊕', otimes: '⊗',
      times: '×', cdot: '·', cdots: '⋯', ldots: '…', dots: '…', div: '÷', pm: '±', mp: '∓', circ: '∘',
      infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', therefore: '∴', because: '∵',
      angle: '∠', perp: '⊥', parallel: '∥', mid: '|', nmid: '∤', langle: '⟨', rangle: '⟩',
      lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮',
      prime: '′', colon: '：', backslash: '＼', rhd: '⊳', models: '⊨', preccurlyeq: '≼', star: '⋆',
      '\\': ' ', '|': '‖', '%': '%', '&': '&', '{': '{', '}': '}', '$': '$', '#': '#', '_': '_',
    };
    const LATEX_SPACING = { quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ' };
    const LATEX_IGNORED = new Set(['left', 'right', 'bigl', 'bigr', 'big', 'Big', 'Bigg', 'biggl', 'biggr',
      'displaystyle', 'textstyle', 'limits', 'nolimits', 'mathstrut', 'begin', 'end', 'nonumber', 'notag']);
    const LATEX_UPRIGHT = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lg', 'exp',
      'min', 'max', 'gcd', 'deg', 'arg', 'sup', 'inf', 'lim', 'det', 'dim', 'sgn', 'arcsin', 'arctan']);
    const LATEX_FONT_TEXT = new Set(['text', 'mathrm', 'textrm', 'textnormal', 'operatorname', 'mathsf', 'mathtt', 'mbox']);
    const LATEX_FONT_BOLD = new Set(['mathbf', 'boldsymbol', 'textbf', 'bm', 'pmb']);
    const LATEX_FONT_SCRIPT = new Set(['mathcal', 'mathscr', 'mathbb', 'mathfrak']);
    const LATEX_BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ' };
    const LATEX_ACCENT = { hat: '\u0302', widehat: '\u0302', vec: '\u20D7', dot: '\u0307', ddot: '\u0308', tilde: '\u0303', check: '\u030C' };
    /**
     * 把一段 LaTeX 排成节点数组。返回值里**不会出现反斜杠**（认不出的命令只留名字）。
     */
    const latexRender = (tex, keyPrefix = 'm') => {
      const source = String(tex ?? '').replace(/\r/gu, ' ');
      let cursor = 0;
      let serial = 0;
      const nextKey = () => `${keyPrefix}-${serial += 1}`;
      const skipSpace = () => {
        while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      };
      const fractionNode = (numerator, denominator) => h('span', {
        key: nextKey(),
        style: { display: 'inline-flex', flexDirection: 'column', verticalAlign: 'middle', textAlign: 'center', margin: '0 3px', lineHeight: 1.25 },
      },
      h('span', { style: { borderBottom: '1px solid currentColor', padding: '0 3px' } }, ...numerator),
      h('span', { style: { padding: '0 3px' } }, ...denominator));
      const readArgument = () => {
        skipSpace();
        if (cursor >= source.length) return [];
        if (source[cursor] === '{') {
          cursor += 1;
          return parse(true);
        }
        if (source[cursor] === '\\') {
          cursor += 1;
          return readCommand();
        }
        const ch = source[cursor];
        cursor += 1;
        return [ch];
      };
      const readCommand = () => {
        const letters = /^[A-Za-z]+/u.exec(source.slice(cursor));
        let name;
        if (letters !== null) {
          name = letters[0];
          cursor += name.length;
        } else {
          name = source[cursor] ?? '';
          cursor += 1;
        }
        if (name === 'begin' || name === 'end') {
          // 环境名（`{cases}` / `{array}`）要吃掉，否则会把「cases」当正文印出来；
          // 环境本身不排版，内容继续平铺（行分隔的 `\\` 由 LATEX_SYMBOL 转成空格）
          readArgument();
          return [];
        }
        if (LATEX_IGNORED.has(name)) return [];
        if (LATEX_SPACING[name] !== undefined) return [LATEX_SPACING[name]];
        if (LATEX_GREEK[name] !== undefined) return [LATEX_GREEK[name]];
        if (LATEX_SYMBOL[name] !== undefined) return [LATEX_SYMBOL[name]];
        if (LATEX_UPRIGHT.has(name)) return [name];
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const numerator = readArgument();
          const denominator = readArgument();
          return [fractionNode(numerator, denominator)];
        }
        if (name === 'sqrt') {
          const body = readArgument();
          return [h('span', { key: nextKey(), style: { whiteSpace: 'nowrap' } }, '√',
            h('span', { style: { borderTop: '1px solid currentColor', padding: '0 2px' } }, ...body))];
        }
        if (name === 'binom') {
          const top = readArgument();
          const bottom = readArgument();
          return [h('span', { key: nextKey(), style: { whiteSpace: 'nowrap' } }, '('), fractionNode(top, bottom), h('span', null, ')')];
        }
        if (name === 'overline' || name === 'bar' || name === 'underline') {
          const body = readArgument();
          const style = name === 'underline' ? { textDecoration: 'underline' } : { textDecoration: 'overline' };
          return [h('span', { key: nextKey(), style: { ...style, textDecorationThickness: '1px' } }, ...body)];
        }
        if (LATEX_ACCENT[name] !== undefined) {
          const body = readArgument();
          return [h('span', { key: nextKey() }, ...body, LATEX_ACCENT[name])];
        }
        if (LATEX_FONT_BOLD.has(name)) return [h('strong', { key: nextKey() }, ...readArgument())];
        if (LATEX_FONT_TEXT.has(name)) return readArgument();
        if (LATEX_FONT_SCRIPT.has(name)) {
          const body = readArgument();
          // 黑板体（`\mathbb{R}`）直接换字符；手写体统一用斜体衬线
          if (name === 'mathbb' && body.length === 1 && typeof body[0] === 'string' && LATEX_BLACKBOARD[body[0]] !== undefined) {
            return [LATEX_BLACKBOARD[body[0]]];
          }
          return [h('span', { key: nextKey(), style: { fontStyle: 'italic', fontFamily: 'Georgia, "Times New Roman", serif' } }, ...body)];
        }
        if (name === 'pmod') {
          const body = readArgument();
          return [h('span', { key: nextKey(), style: { whiteSpace: 'nowrap' } }, '（mod ', ...body, '）')];
        }
        if (name === 'bmod') return [' mod '];
        if (name === 'not') return ['¬'];
        // 认不出的命令：只留名字（反斜杠绝不外露）；单字符命令（如 `\,` `\;`）落空
        if (name.length <= 1) return [];
        return [name];
      };
      const parse = (stopAtBrace) => {
        const out = [];
        while (cursor < source.length) {
          const ch = source[cursor];
          if (stopAtBrace && ch === '}') {
            cursor += 1;
            return out;
          }
          if (ch === '}') {
            cursor += 1;
            continue;
          }
          if (ch === '{') {
            cursor += 1;
            out.push(...parse(true));
            continue;
          }
          if (ch === '_' || ch === '^') {
            cursor += 1;
            const body = readArgument();
            out.push(h(ch === '_' ? 'sub' : 'sup', { key: nextKey(), style: { fontSize: '0.72em', lineHeight: '1' } }, ...body));
            continue;
          }
          if (ch === '\\') {
            cursor += 1;
            out.push(...readCommand());
            continue;
          }
          if (ch === '~') {
            cursor += 1;
            out.push(' ');
            continue;
          }
          cursor += 1;
          out.push(ch);
        }
        return out;
      };
      return parse(false);
    };
    /** 对外只暴露「排好版的节点」，测试直接调它。 */
    const latexNodes = (tex, keyPrefix = 'm') => latexRender(tex, keyPrefix);
    /**
     * `formulas[]` 一条的渲染：`plain` 是给人看的一句话，`tex` 是排好版的式子。
     *
     * 顺序上**先 tex 后 plain**（看图读式、再读解释）。任何一条 tex 排不出来也不会
     * 露出源码：最差情况只剩 `plain`。
     */
    const formulaCard = (formula, index) => {
      const tex = typeof formula?.tex === 'string' ? formula.tex.trim() : '';
      const plain = typeof formula?.plain === 'string' ? formula.plain.trim() : '';
      const rendered = tex === '' ? [] : latexNodes(tex, `f${index}`);
      return h('div', {
        key: `f${index}`,
        className: 'sa-formula',
        style: {
          marginTop: 6,
          fontSize: 14,
          background: 'var(--dsw-alias-bg-base)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 'var(--dsw-radius-sm)',
          padding: '6px 8px',
        },
      },
      rendered.length > 0
        ? h('div', { style: { fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 17, lineHeight: 1.7, letterSpacing: '0.2px' } }, ...rendered)
        : null,
      plain !== '' ? h('div', { className: 'sa-muted', style: { marginTop: rendered.length > 0 ? 4 : 0 } }, plain) : null);
    };
    /** 表格行：`| a | b |`。分隔行（`|---|:--:|`）只用来告诉解析器「上一行是表头」，渲染时丢掉。 */
    const isTableRow = (line) => /^\|.*\|$/u.test(line);
    const isTableRule = (line) => /^\|[\s:|-]+\|$/u.test(line);
    const tableCells = (line) => line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    const ANALYSIS_CELL_STYLE = {
      border: '1px solid var(--dsw-alias-border-l1, #d9d9d9)',
      padding: '4px 8px',
      textAlign: 'left',
      verticalAlign: 'top',
    };
    /**
     * 详解正文的**块级**渲染：空行切段（沿用 `analysisParagraphs`），段内再认
     * `### 小标题`（独占一段）、竖线表格（整段都是 `| … |`）、列表（整段或与正文混排都行），
     * 其余按段落。
     *
     * 生成侧习惯写「一句话定调 + 几条并列」，数字电路还会整段贴真值表；以前这些一律按
     * 纯文本贴出来，读者看到的是挤在一起的字和一堆竖线。这里只做「够用就好」的解析：
     * 不认嵌套、不认 HTML、不认脚注。
     */
    const analysisBlockNodes = (text, keyPrefix) => {
      const nodes = [];
      /** 一组成员行 → `<ul>` 或 `<ol>`（首行是数字就用 ol）。 */
      const listNode = (items, key) => {
        const tag = /^\d/u.test(items[0].raw) ? 'ol' : 'ul';
        return h(tag, { key, style: { margin: '6px 0 0', paddingLeft: 20, fontSize: 16, lineHeight: 1.65 } },
          items.map((item, index) => h('li', { key: `${key}-li${index}` }, ...analysisInline(item.text, `${key}-li${index}`))));
      };
      analysisParagraphs(text).forEach((part, blockIndex) => {
        const key = `${keyPrefix}-${blockIndex}`;
        const lines = part.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        if (lines.length === 0) return;
        // ① 表格：整段都是竖线行（至少两行，含一行分隔），否则会误伤正文里的 `a|b`
        if (lines.length >= 2 && lines.every(isTableRow) && lines.some(isTableRule)) {
          const rows = lines.filter((line) => !isTableRule(line)).map(tableCells);
          const head = rows.shift() ?? [];
          const headRow = h('tr', { key: `${key}-head-row` },
            ...head.map((cell, index) => h('th', { key: `${key}-th${index}`, style: { ...ANALYSIS_CELL_STYLE, fontWeight: 600 } }, ...analysisInline(cell, `${key}-th${index}`))));
          const bodyRows = rows.map((row, rowIndex) => h('tr', { key: `${key}-r${rowIndex}` },
            ...row.map((cell, index) => h('td', { key: `${key}-r${rowIndex}c${index}`, style: ANALYSIS_CELL_STYLE },
              ...analysisInline(cell, `${key}-r${rowIndex}c${index}`)))));
          const tableNode = h('table', { style: { borderCollapse: 'collapse', fontSize: 14, lineHeight: 1.5 } },
            head.length > 0 ? h('thead', { key: `${key}-head` }, headRow) : null,
            h('tbody', { key: `${key}-body` }, ...bodyRows));
          nodes.push(h('div', { key, style: { margin: '8px 0 0', overflowX: 'auto' } }, tableNode));
          return;
        }
        // ② 小标题：`### 一、结构` 独占一段；与正文同段时按普通文字渲染（不猜）
        const heading = /^#{1,6}\s+(.*)$/u.exec(lines[0]);
        if (heading !== null && lines.length === 1) {
          nodes.push(h('div', { key, style: { margin: '10px 0 0', fontSize: 15, fontWeight: 600 } }, ...analysisInline(heading[1], `${key}-h`)));
          return;
        }
        // ③ 没有列表行：普通段落（pre-wrap 保留段内换行）
        if (!lines.some(isListLine)) {
          nodes.push(h('p', { key, style: { margin: '6px 0 0', fontSize: 16, lineHeight: 1.65, whiteSpace: 'pre-wrap' } },
            ...analysisInline(part, key)));
          return;
        }
        // ④ 有列表行：连续的列表行成一组，其余行成段落，**保持原顺序**
        let buffer = [];
        const flushParagraph = () => {
          if (buffer.length === 0) return;
          const textPart = buffer.join('\n');
          nodes.push(h('p', { key: `${key}-p${nodes.length}`, style: { margin: '6px 0 0', fontSize: 16, lineHeight: 1.65, whiteSpace: 'pre-wrap' } },
            ...analysisInline(textPart, `${key}-p${nodes.length}`)));
          buffer = [];
        };
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (isListLine(line)) {
            flushParagraph();
            const items = [];
            while (i < lines.length && isListLine(lines[i])) {
              items.push({ raw: lines[i], text: lines[i].replace(LIST_LINE_PATTERN, '') });
              i += 1;
            }
            nodes.push(listNode(items, `${key}-list${nodes.length}`));
            i -= 1;
          } else {
            buffer.push(line);
          }
        }
        flushParagraph();
      });
      return nodes;
    };

    function KnowledgeTab({ docs = {}, refresh, focus = null, onFocusConsumed, initialView = null, onOpenMaterial }) {
      // 2026-10-23 凌晨：文档被外部改坏时 nodes 里可能出现 null / 非对象（真实渲染探针抓到过），
      // 这里统一先剔掉——树、体检、图、列表都靠这份 netNodes，任何一处拿到 null 都会整页白屏。
      const netNodes = objectList(docs.knowledgeNetwork?.nodes);
      const candidates = objectList(docs.knowledgeCandidates?.candidates);
      const courses = objectList(docs.courses?.courses);
      // 题目只用来看证据题干（`findQuestion`）；知识点页签不再显示题目列表，但证据行要能查到 prompt
      const questions = objectList(docs.questions?.questions);

      // 界面记忆：上排这几个 state 的初值都从模块内存里恢复（切页签回来还在原处）
      const restoredUi = readKnowledgeUi();
      const treeCourses = knowledgeTreeCourses(netNodes, docs.knowledgeOutline, courses);
      const selectedCourse = netNodes.find(item => item.id === restoredUi.selected)?.courseId;
      const [wantedTreeCourse, setTreeCourseId] = useState(restoredUi.treeCourseId || restoredUi.courseId || selectedCourse || '');
      const treeCourseId = treeCourses.some(item => item.id === wantedTreeCourse) ? wantedTreeCourse : (treeCourses[0]?.id || '');
      const subjectTreesRef = useRef(restoredUi.subjectTrees || {});
      const [, redrawTree] = useState(0);
      const savedTree = subjectTreeState(subjectTreesRef.current, treeCourseId);
      const updateSubjectTree = (patch, redraw = true) => {
        subjectTreesRef.current = patchSubjectTree(subjectTreesRef.current, treeCourseId, patch);
        readKnowledgeUi({ subjectTrees: subjectTreesRef.current, treeCourseId });
        if (redraw) redrawTree(value => value + 1);
      };
      const [courseId, setCourseId] = useState(restoredUi.courseId);
      const [openPath, setOpenPath] = useState(restoredUi.detailPath);
      const [detail, setDetail] = useState(null); // { status, data }：证据里「看原页」用
      const [fullBrowser, setFullBrowser] = useState(false);
      const [browserCollapsed, setBrowserCollapsed] = useState(false);
      const readerRef = useRef(null);
      const [selected, setSelected] = useState(restoredUi.selected); // 知识网络里选中的节点 id
      const [markBusy, setMarkBusy] = useState(false);
      const [markError, setMarkError] = useState('');
      const [markNote, setMarkNote] = useState('');
      // 加节点表单：树上的「＋」会把课程/章/节/小节预填进来，省得手打章名挂不上大纲
      const [draft, setDraft] = useState({ name: '', chapter: '', section: '', subsection: '', courseId: null });
      // 「改挂靠」行内编辑：{ id, chapter, section, subsection }，null = 没在编辑
      const [mountDraft, setMountDraft] = useState(null);
      // 备注行内编辑（2026-10-23 凌晨）：{ id, text }，null = 没在编辑。
      // node.note 一直有字段但没有入口，而「这个点我总错在哪」恰恰是最值得自己写下来的东西。
      const [noteDraft, setNoteDraft] = useState(null);
      // 批量改挂靠（2026-10-22 深夜）：把当前命中的节点一次挂到同一层
      const [batchMount, setBatchMount] = useState({ chapter: '', section: '', subsection: '' });
      // 讲解：当前看的那一档 + 结果（结果带 cached 标记，重生成走 force）
      const [explainStyle, setExplainStyle] = useState('assistant');
      const [explainBusy, setExplainBusy] = useState(false);
      const [explainError, setExplainError] = useState('');
      const [explainData, setExplainData] = useState(null);
      // 复习可用性（2026-10-21）：搜索 / 筛选 / 树-图-列表切换 / 折叠的章
      const [kpQuery, setKpQuery] = useState(restoredUi.query);
      const [kpFilter, setKpFilter] = useState(restoredUi.filter);
      // 掌握度多选（2026-10-24）：[] = 四档都要；勾了某几档就只留那几档（与筛选档是「与」关系）
      const [kpMastery, setKpMastery] = useState(restoredUi.masteryLevels);
      const [kpView, setKpView] = useState(initialView === null ? restoredUi.view : initialView);
      const [collapsedChapters, setCollapsedChapters] = useState([]);
      // 树（2026-10-21 夜批2）：哪些分支是展开的；搜索时自动全展开，不用手点
      const openTree = savedTree.openTree;
      const setOpenTree = value => updateSubjectTree({ openTree: value });
      // 导图（2026-10-23 夜第二刀）：默认只展开到「章」，点章才铺出该章的知识点。
      // 68 个节点一屏铺满没法读；这里存的是**已展开的章名**，搜索/筛选非默认时自动全展开。
      const mindOpen = savedTree.mindOpen;
      const setMindOpen = value => updateSubjectTree({ mindOpen: value });
      // 证据交互（2026-10-21 夜）：展开的是哪一条（键 = 前缀#序号），空串全收
      const [openEvidence, setOpenEvidence] = useState('');
      // 讲解清单（2026-10-21 夜）：切到「讲解」视图才拉接口；正文按需再取
      const [explainListState, setExplainListState] = useState({ status: 'idle', items: [], error: '' });
      const [explainOpen, setExplainOpen] = useState('');
      const [explainBody, setExplainBody] = useState({ status: 'idle', data: null, error: '' });
      const explainListAt = useRef(0);
      // 批量生成一章的讲解（2026-10-21 夜第二段）：按章串行跑，进度写在按钮旁边
      const [batchChapter, setBatchChapter] = useState('');
      const [batchStyle, setBatchStyle] = useState('assistant');
      const [batchState, setBatchState] = useState({ status: 'idle', done: 0, total: 0, skipped: 0, failed: [] });
      // 内嵌聊天（2026-10-24）：线程留在内存、按节点隔离，关面板即清（服务端不落盘）
      const [chatThread, setChatThread] = useState([]);
      const [chatInput, setChatInput] = useState('');
      const [chatBusy, setChatBusy] = useState(false);
      const [chatError, setChatError] = useState('');
      const [chatSources, setChatSources] = useState([]);
      // 换节点就清空对话；用 ref 记住「现在选的是谁」，避免慢响应回来贴错节点
      const selectedChatRef = useRef(selected);
      selectedChatRef.current = selected;
      useEffect(() => {
        setChatThread([]);
        setChatInput('');
        setChatError('');
        setChatSources([]);
      }, [selected]);

      // 把界面状态记回模块内存（下次切回本页签时恢复）；只记显示状态，不记接口结果
      useEffect(() => {
        readKnowledgeUi({ courseId, query: kpQuery, filter: kpFilter, view: kpView, selected, openTree, mindOpen, masteryLevels: kpMastery, detailPath: openPath, treeCourseId, subjectTrees: subjectTreesRef.current });
      }, [courseId, kpQuery, kpFilter, kpView, selected, openTree, mindOpen, kpMastery, openPath, treeCourseId]);

      // 恢复上次用「看原页」打开的那份资料（返回/切页签回来时）
      useEffect(() => {
        const restored = readKnowledgeUi();
        if (restored.detailPath !== null) showMaterial(restored.detailPath);
      }, []);

      const courseName = (id) => courses.find((item) => item.id === id)?.name ?? (id || '未匹配课程');
      const isTreeView = kpView === 'mind' || kpView === 'tree';
      const effectiveCourseId = isTreeView ? treeCourseId : courseId;
      const keep = item => effectiveCourseId === '' || (String(item?.courseId ?? '').trim() || '__none__') === effectiveCourseId;
      const chooseTreeCourse = id => {
        setFullBrowser(false); setBrowserCollapsed(false);
        setTreeCourseId(id); setCourseId(id); setSelected(null); setOpenPath(null); setDetail(null);
        setChatBusy(false); setChatError(''); setChatSources([]); setChatThread([]);
        setKpQuery(''); setKpFilter('all'); setKpMastery([]); setMarkNote(''); setMarkError('');
      };
      const selectForReading = id => {
        setSelected(id); setFullBrowser(false); setBrowserCollapsed(id !== null);
      };
      const restoreCompactScroll = useCallback(box => {
        if (!box) return;
        const scroll = subjectTreeState(subjectTreesRef.current, treeCourseId).scroll.tree;
        box.scrollLeft = scroll.left; box.scrollTop = scroll.top;
      }, [treeCourseId]);
      const saveTreeScroll = (view, event) => {
        const box = event.currentTarget;
        updateSubjectTree({ scroll: { [view]: { left: box.scrollLeft, top: box.scrollTop } } }, false);
      };
      const restoreTreeScroll = useCallback(box => {
        if (!box || (kpView !== 'mind' && kpView !== 'tree')) return;
        const scroll = subjectTreeState(subjectTreesRef.current, treeCourseId).scroll[kpView];
        box.scrollLeft = scroll.left; box.scrollTop = scroll.top;
      }, [treeCourseId, kpView]);

      const showMaterial = async (materialPath, page) => {
        setOpenPath(materialPath);
        setDetail({ status: 'loading', data: null });
        const result = await materialText(materialPath, page).catch(() => ({ ok: false, error: 'network' }));
        setDetail({ status: result.ok ? 'ready' : 'error', data: result });
      };

      const pill = (text, level) => h('span', { className: `sa-pill ${level}` }, text);

      const netRows = netNodes.filter(keep);
      // 《知识点大纲》（2026-10-21 深夜批5）：教材目录骨架；树与体检都要用，所以提到派生最前面
      const fullOutline = docs.knowledgeOutline ?? {};
      const outlineDoc = isTreeView ? { ...fullOutline, courses: objectList(fullOutline.courses).filter(item => String(item.courseId) === treeCourseId) } : fullOutline;
      // 详解查表（2026-10-24 傍晚）：从节点详情卡挪到这里——工具条的「详解覆盖」与「没详解」筛选也要用
      const analysisPoints = useMemo(() => buildAnalysisPoints(docs.knowledgeAnalysis), [docs.knowledgeAnalysis]);
      const coverage = analysisCoverage(netRows, analysisPoints);
      // 体检（2026-10-23 凌晨）：先算一遍问题清单，工具条上的数字和「有问题」筛选共用它
      const health = knowledgeHealth(netRows, { outline: outlineDoc, questions });
      // 搜索/筛选后的节点：图与列表都只画这一份，切换视图不会看到两套结果
      const kpFiltered = filterKnowledgeNodes(netRows, {
        query: kpQuery,
        filter: kpFilter,
        // 掌握度多选（2026-10-24）：四档任意组合，空数组不筛
        masteryLevels: kpMastery,
        issueIds: health.issueIds,
        // 「未分节」只用可挂的节点（有教材大纲的课），和体检行的数字同源
        mountableIds: health.mountableIds,
        // 「没详解」按 coverage 的 missingIds 筛，和工具条上那个数字同源
        analysisIds: coverage.missingIds,
      });
      const dueRows = knowledgeReviewQueue(netRows);
      const chapterGroups = groupKnowledgeByChapter(kpFiltered, {
        course: (id) => courses.find((item) => item.id === id)?.name,
      });
      const chapterName = (node) => String(node?.chapter ?? '').trim() || '未分章';
      const isChapterCollapsed = (key) => collapsedChapters.includes(key);
      const toggleChapter = (key) => setCollapsedChapters(isChapterCollapsed(key)
        ? collapsedChapters.filter((item) => item !== key)
        : [...collapsedChapters, key]);
      const layout = useMemo(
        () => buildKnowledgeLayout(kpFiltered, { course: (id) => courses.find((item) => item.id === id)?.name }),
        [kpFiltered, courses],
      );
      // 树（2026-10-21 夜批2 / 深夜批5）：有《知识点大纲》时按教材「章 → 节 → 小节」挂靠，
      // 没有大纲的课程（数电/离散/物理）自动退回老算法整门接在后面
      const tree = useMemo(
        () => buildOutlineTree(outlineDoc, kpFiltered, { course: (id) => courses.find((item) => item.id === id)?.name }).filter(entry => !isTreeView || entry.key === 'course:' + treeCourseId),
        [outlineDoc, kpFiltered, courses, isTreeView, treeCourseId],
      );
      const allTreeKeys = useMemo(() => knowledgeTreeBranchKeys(tree), [tree]);
      // 思维导图（2026-10-23 夜，A 块）：全部 → 课程 → 章 → 知识点，横向树 + 掌握度符号/颜色。
      // 第二刀：**默认只展开到章**（68 个点铺满没法读）；有关键词或选了筛选档时自动全展开——
      // 那时候用户明确在找一小撮节点，再让他一章章点开是添乱。规则与树视图的「搜索自动展开」一致。
      // 搜索有词、选了任一筛选档、或勾了掌握度档 ⇒ 用户明确在找一小撮节点，树/导图直接全展开
      // （2026-10-24：掌握度多选也算「在找特定子集」，不然还得一章章点开找）
      const mindAutoExpand = kpQuery.trim() !== '' || kpFilter !== 'all' || kpMastery.length > 0;
      // 每科首次只显示学科和章；搜索/筛选临时展开，不改该科手动记忆。
      const mindExpanded = mindAutoExpand ? null : mindOpen;
      const mind = useMemo(
        () => buildMindMap(kpFiltered, { course: (id) => courses.find((item) => item.id === id)?.name },
          { expanded: mindExpanded, outline: outlineDoc, courseRoot: true, courseId: treeCourseId }),
        [kpFiltered, courses, mindExpanded, outlineDoc, treeCourseId],
      );
      const mindChapterKeys = useMemo(
        () => mind.nodes.filter((entry) => entry.kind === 'chapter').map((entry) => entry.key),
        [mind],
      );
      const toggleMindChapter = (label) => {
        const key = String(label ?? '').trim();
        if (key === '') return;
        const effective = mind.nodes.filter((item) => item.kind === 'chapter' && item.open).map((item) => item.key);
        setMindOpen(effective.includes(key) ? effective.filter((item) => item !== key) : [...effective, key]);
      };
      // 大纲规模（只用于树卡抬头的「按教材目录」说明）
      const outlineStats = useMemo(() => {
        const list = Array.isArray(outlineDoc?.courses) ? outlineDoc.courses : [];
        let chapters = 0;
        let sections = 0;
        let subs = 0;
        for (const course of list) {
          for (const chap of Array.isArray(course?.chapters) ? course.chapters : []) {
            chapters += 1;
            for (const sec of Array.isArray(chap?.sections) ? chap.sections : []) {
              sections += 1;
              subs += Array.isArray(sec?.subs) ? sec.subs.length : 0;
            }
          }
        }
        return { courses: list.length, chapters, sections, subs };
      }, [outlineDoc]);
      const toggleTreeNode = (key) => setOpenTree(openTree.includes(key)
        ? openTree.filter((item) => item !== key)
        : [...openTree, key]);
      const candidateRows = candidates.filter(keep);

      /** 标记落盘：只送要改的字段，服务端把其余字段从磁盘那条继承。 */
      const patchNode = async (id, item, note = '') => {
        setMarkBusy(true);
        setMarkError('');
        try {
          await mutate('knowledgeNetwork', 'update', { id, item });
          if (note !== '') setMarkNote(note);
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /**
       * 复习打卡：只写 `reviewedAt`，掌握度不动。
       * 之所以有用：待复习队列算的是「距上次复习满 7 天」，可 `reviewedAt` 原本只会在
       * 改掌握度时被服务端顺手写一次——复习完但掌握度没变（本来就会做）就没法打卡。
       */
      const markReviewed = async (node) => {
        if (node === null || node === undefined) return;
        const at = new Date().toISOString();
        await patchNode(node.id, { reviewedAt: at }, `已记下「${node.name ?? '(未命名)'}」今天复习过（${at.slice(0, 10)}）`);
      };

      /**
       * 批量标记：把**当前筛选出来的**节点一次改成同一档掌握度。
       *
       * 为什么不用循环调 patchNode：一次 /mutate 只写一次盘、只留一份备份；
       * 68 次串行请求会写 68 次磁盘，中途失败还会留下「标了一半」的状态。
       * 服务端那边是「全成或全不成」，失败时一个都没动。
       */
      const markFiltered = async (level) => {
        if (kpFiltered.length === 0) return;
        if (kpFiltered.length > BATCH_LIMIT) {
          setMarkError(`一次最多改 ${BATCH_LIMIT} 个节点（当前命中 ${kpFiltered.length} 个），先多筛几次`);
          return;
        }
        setMarkBusy(true);
        setMarkError('');
        setMarkNote('');
        try {
          const result = await mutate('knowledgeNetwork', 'update', {
            items: kpFiltered.map((node) => ({ id: node.id, item: { mastery: level } })),
          });
          const done = Number(result?.updated);
          setMarkNote(`已把 ${Number.isFinite(done) ? done : kpFiltered.length} 个节点标为「${MASTERY_LABELS[level]}」`);
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /**
       * 批量改「同一个值」的其它字段（2026-10-23 凌晨）：★ 重点、复习打卡这类整批动作。
       *
       * 和 markFiltered 共用同一条 `/mutate items` 通道（一次请求、一次落盘、全成或全不成），
       * 但刻意不碰掌握度——掌握度是逐节点判断的事，整批套同一个值只会把数据弄得更假。
       */
      const patchFiltered = async (patch, describe) => {
        if (kpFiltered.length === 0) return;
        if (kpFiltered.length > BATCH_LIMIT) {
          setMarkError(`一次最多改 ${BATCH_LIMIT} 个节点（当前命中 ${kpFiltered.length} 个），先多筛几次`);
          return;
        }
        setMarkBusy(true);
        setMarkError('');
        setMarkNote('');
        try {
          const result = await mutate('knowledgeNetwork', 'update', {
            items: kpFiltered.map((node) => ({ id: node.id, item: patch })),
          });
          const done = Number(result?.updated);
          setMarkNote(`已把 ${Number.isFinite(done) ? done : kpFiltered.length} 个节点${describe}`);
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /**
       * 批量改挂靠（2026-10-22 深夜）：把**当前命中的**节点一次挂到同一层。
       *
       * 为什么需要它：数电 PPT 骨架下有 12 个节点只能待在「未分节」里，逐条点「改挂靠」
       * 要开 12 次表单、12 次请求；而它们往往本来就属于同一节。走和批量标记同一条
       * `/mutate items` 通道——一次请求、一次落盘、全成或全不成。
       * 节/小节允许留空（只挂到章），所以至少要有章名才发请求。
       */
      const mountFiltered = async () => {
        if (kpFiltered.length === 0) return;
        if (kpFiltered.length > BATCH_LIMIT) {
          setMarkError(`一次最多改 ${BATCH_LIMIT} 个节点（当前命中 ${kpFiltered.length} 个），先多筛几次`);
          return;
        }
        const chapter = batchMount.chapter.trim();
        const section = batchMount.section.trim();
        const subsection = batchMount.subsection.trim();
        if (chapter === '') {
          setMarkError('批量归位至少要填章名（例：第 2 章 逻辑代数基础）');
          return;
        }
        setMarkBusy(true);
        setMarkError('');
        setMarkNote('');
        try {
          const result = await mutate('knowledgeNetwork', 'update', {
            items: kpFiltered.map((node) => ({ id: node.id, item: { chapter, section, subsection } })),
          });
          const done = Number(result?.updated);
          const where = [chapter, section, subsection].filter((part) => part !== '').join(' › ');
          setMarkNote(`已把 ${Number.isFinite(done) ? done : kpFiltered.length} 个节点挂到「${where}」`);
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /**
       * 点某一档讲解：先问后端缓存（后端已有就直接回），没有再现场生成。
       * `force` 只在「重新生成」按钮上给 true。
       */
      // 分栏阅读只重置右侧正文，不让外层页面滚离目录。
      useEffect(() => {
        if (selected === null || selected === undefined || selected === '') return;
        if (isTreeView) {
          setBrowserCollapsed(true);
          if (readerRef.current) readerRef.current.scrollTop = 0;
          return;
        }
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const target = document.getElementById(kpView === 'graph' ? 'sa-kp-detail' : 'sa-kp-selected');
        if (target === null || typeof target.scrollIntoView !== 'function') return;
        const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: kpView === 'graph' ? 'start' : 'center', behavior: reduced ? 'auto' : 'smooth' });
      }, [selected, kpView, kpFilter, isTreeView]);

      const openExplain = async (style, options = {}) => {
        if (selected === null) return;
        setExplainStyle(style);
        setExplainBusy(true);
        setExplainError('');
        try {
          const result = await explainNode(selected, style, options);
          if (result.ok !== true) {
            setExplainData(null);
            setExplainError(explainErrorMessage(result));
          } else {
            setExplainData(result);
          }
        } catch (error) {
          setExplainData(null);
          setExplainError(String(error?.message ?? error));
        } finally {
          setExplainBusy(false);
        }
      };

      /**
       * 发一条消息给「就问这个知识点」的聊天框（2026-10-24）。
       *
       * 把整段线程一起发过去（服务端不存历史）；等待期间锁住输入框。
       * 慢响应回来时如果学生已经换了节点，就把结果丢掉，别贴到别人身上。
       */
      const sendChat = async () => {
        const nodeId = selected;
        const text = chatInput.trim();
        if (nodeId === null || text === '' || chatBusy) return;
        const nextThread = [...chatThread, { role: 'user', content: text }];
        setChatThread(nextThread);
        setChatInput('');
        setChatError('');
        setChatBusy(true);
        try {
          const result = await chatNode(nodeId, nextThread);
          if (selectedChatRef.current !== nodeId) return;
          if (result.ok !== true) {
            setChatError(chatErrorMessage(result));
          } else {
            setChatThread([...nextThread, { role: 'assistant', content: String(result.reply ?? '') }]);
            setChatSources(Array.isArray(result.sources) ? result.sources.map((item) => String(item)) : []);
          }
        } catch (error) {
          if (selectedChatRef.current !== nodeId) return;
          setChatError(String(error?.message ?? error));
        } finally {
          if (selectedChatRef.current === nodeId) setChatBusy(false);
        }
      };

      /**
       * 树分支上的「＋」：把这一层的课程/章/节/小节塞进加节点表单。
       * 以前加节点要自己手打「第 2 章 向量」这种章名，打错一个字就挂不上大纲、掉进「未归类」。
       */
      const prefillAdd = (ctx) => {
        if (ctx === null || ctx === undefined) return;
        const chapter = String(ctx.chapter ?? '');
        const section = String(ctx.section ?? '');
        const subsection = String(ctx.subsection ?? '');
        setDraft({ name: '', chapter, section, subsection, courseId: ctx.courseId ?? null });
        setMarkError('');
        const where = [chapter, section, subsection].filter((part) => part !== '').join(' › ');
        setMarkNote(where === ''
          ? '已填好课程，在下面「＋ 新建知识点」写个名字就行。'
          : `已填好「${where}」，在下面「＋ 新建知识点」写个名字就行。`);
      };

      const addNode = async () => {
        const name = draft.name.trim();
        if (name === '') return;
        setMarkBusy(true);
        setMarkError('');
        try {
          await mutate('knowledgeNetwork', 'create', {
            item: {
              name,
              chapter: draft.chapter.trim(),
              section: draft.section.trim(),
              subsection: draft.subsection.trim(),
              courseId: draft.courseId ?? (courseId === '' ? null : courseId),
            },
          });
          setDraft({ name: '', chapter: '', section: '', subsection: '', courseId: null });
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /**
       * 「织网」与「导出画布」都是 POST 一个空体、由服务端读磁盘写磁盘。
       * 成功时把服务端给的数字摘要成一行字，失败照常显示在 markError。
       */
      const runKnowledgeJob = async (kind) => {
        setMarkBusy(true);
        setMarkError('');
        setMarkNote('');
        try {
          const response = await fetch(`${API}/knowledge/${kind}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
            body: '{}',
          });
          const result = await response.json().catch(() => null);
          if (result === null) throw nonJsonError(response);
          if (result.ok !== true) {
            const messages = {
              'need-request-header': '请求被拒绝：缺少安全请求头。',
              'cross-site-rejected': '请求被拒绝：来源不可信。',
              'network-corrupt': '知识点网络文件损坏，先修好 知识点网络.json 再试。',
            };
            throw new Error(messages[result.error] ?? result.error ?? `HTTP ${response.status}`);
          }
          if (kind === 'weave') {
            const stats = result.stats ?? {};
            setMarkNote(`织网完成：新增 ${stats.created ?? 0}、合并 ${stats.merged ?? 0}、无变化 ${stats.unchanged ?? 0}`);
          } else if (kind === 'export') {
            const summary = result.summary ?? {};
            setMarkNote(`已导出到 ${result.outDir ?? '知识画布'}：章 ${summary.chapters ?? 0} · 笔记 ${summary.notes ?? 0} · 题目文件 ${summary.files ?? 0}`);
          }
          await refresh?.();
        } catch (error) {
          setMarkError(String(error?.message ?? error));
        } finally {
          setMarkBusy(false);
        }
      };

      /** 拉讲解清单：5 分钟内不重复请求，避免每次切视图都打接口。 */
      const loadExplainList = async (force) => {
        if (force !== true && Date.now() - explainListAt.current < 5 * 60 * 1000) return;
        setExplainListState((prev) => ({ ...prev, status: 'loading', error: '' }));
        const result = await explainList().catch(() => ({ ok: false, error: 'network' }));
        if (result.ok !== true) {
          setExplainListState((prev) => ({ ...prev, status: 'error', error: String(result.error ?? 'unknown') }));
          return;
        }
        explainListAt.current = Date.now();
        setExplainListState({ status: 'ready', items: Array.isArray(result.items) ? result.items : [], error: '' });
      };

      /** 展开/收起某一份讲解：正文按需取一次，收起不缓存、重开再取（缓存本来就是本地的）。 */
      const toggleExplainBody = async (item) => {
        const key = `${item.node}|${item.style}`;
        if (explainOpen === key) {
          setExplainOpen('');
          return;
        }
        setExplainOpen(key);
        setExplainBody({ status: 'loading', data: null, error: '' });
        const result = await explainCached(item.node, item.style).catch(() => ({ ok: false, error: 'network' }));
        if (result.ok !== true) {
          setExplainBody({ status: 'error', data: null, error: String(result.error ?? 'unknown') });
          return;
        }
        setExplainBody({ status: 'ready', data: result, error: '' });
      };

      /**
       * 批量生成一章的讲解（2026-10-21 夜第二段）：串行排队，一次只烧一份。
       *
       * 不并发：宿主那边是一条模型通道，同时发 6 个只会互相排队、还容易撞 429；
       * 串行还让进度条有真实意义（第 k 个正在生成）。已生成的档默认跳过——
       * 要重生成请去单节点卡里点「重新生成」，避免手滑把 9 份好缓存全冲掉。
       */
      const runChapterBatch = async (group) => {
        if (batchState.status === 'running') return;
        const nodes = Array.isArray(group?.nodes) ? group.nodes : [];
        const listed = await explainList().catch(() => ({ ok: false, error: 'network' }));
        const known = listed.ok === true && Array.isArray(listed.items) ? listed.items : explainListState.items;
        const generated = new Set(known.filter((item) => item.style === batchStyle).map((item) => item.node));
        const targets = nodes.filter((node) => generated.has(node.id) !== true);
        const skipped = nodes.length - targets.length;
        if (targets.length === 0) {
          setBatchState({ status: 'done', done: 0, total: 0, skipped, failed: [] });
          return;
        }
        setBatchState({ status: 'running', done: 0, total: targets.length, skipped, failed: [] });
        const failed = [];
        for (const node of targets) {
          const result = await explainNode(node.id, batchStyle, { force: false })
            .catch(() => ({ ok: false, error: 'network' }));
          if (result?.ok !== true) {
            failed.push(`${node.name ?? node.id}（${explainErrorMessage(result).slice(0, 40)}）`);
          }
          setBatchState((prev) => ({ ...prev, done: prev.done + 1, failed: [...failed] }));
        }
        setBatchState({ status: 'done', done: targets.length, total: targets.length, skipped, failed });
        await loadExplainList(true);
      };

      useEffect(() => {
        if (kpView === 'explain') loadExplainList(false);
      }, [kpView]);

      // 跨页签联动：从「资料 → 题目」点知识点跳过来时，选中那个节点并切到列表。
      // 从「今日」页点的「去复习」只带 filter，不选中具体节点。
      useEffect(() => {
        const nodeId = focus?.nodeId;
        const wantedFilter = focus?.filter;
        if (typeof nodeId === 'string' && nodeId !== '') {
          const targetNode = netNodes.find(item => item.id === nodeId);
          if (targetNode) { const id = String(targetNode.courseId ?? '').trim() || '__none__'; setCourseId(id); setTreeCourseId(id); }
          setKpMastery([]);
          setKpQuery('');
          setKpFilter('all');
          setKpView('list');
          setSelected(nodeId);
          onFocusConsumed?.();
          return;
        }
        if (KP_UI_FILTERS.includes(wantedFilter)) {
          setCourseId(''); setKpMastery([]);
          setKpQuery('');
          setKpFilter(wantedFilter);
          setKpView('list');
          setSelected(null);
          onFocusConsumed?.();
        }
      }, [focus]);

      const detailCard = openPath === null ? null : h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-grow', title: openPath }, detail?.data?.file ?? openPath),
          detail?.status === 'ready'
            ? h('button', {
              className: 'sa-btn',
              title: '带着这一页跳到「资料」页签继续翻',
              onClick: () => onOpenMaterial?.(openPath, detail.data?.page),
            }, '去资料页看')
            : null,
          detail?.data?.truncated === true ? pill('已截断', 'today') : null,
          h('button', {
            className: 'sa-btn',
            title: '关上这份正文（也可以按左上角「返回」或 Alt+←）',
            onClick: () => {
              setOpenPath(null);
              setDetail(null);
              readKnowledgeUi({ detailPath: null });
            },
          }, '关闭')),
        detail?.status === 'loading' ? h('div', { className: 'sa-muted' }, '正在读取…') : null,
        detail?.status === 'error'
          ? h('div', null,
            h('div', { className: 'sa-error' },
              detail.data?.error === 'no-text'
                ? '这份资料还没有取字产物（扫描件要先跑取字）。'
                : detail.data?.error === 'page-missing'
                  ? `第 ${detail.data?.page} 页还没有取字产物。`
                  : detail.data?.error === 'not-indexed'
                    ? '这份资料不在索引里，可能索引刚被改过，刷新试试。'
                    : `读取失败：${detail.data?.error ?? '未知原因'}`),
            Array.isArray(detail.data?.pages) && detail.data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { marginTop: 6 } },
                h('span', { className: 'sa-muted' }, `已有的页：${detail.data.pages.join('、')}`))
              : null)
          : null,
        detail?.status === 'ready'
          ? h('div', null,
            Array.isArray(detail.data.pages) && detail.data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'sa-muted' }, '页'),
                ...detail.data.pages.map((no) => h('button', {
                  key: no,
                  className: `sa-btn${no === detail.data.page ? ' primary' : ''}`,
                  onClick: () => showMaterial(openPath, no),
                }, String(no))))
              : null,
            h('pre', {
              className: 'sa-reading-pre',
              style: {
                margin: 0,
                maxHeight: '46vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 14,
                lineHeight: 1.6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 'var(--dsw-radius-sm)',
                padding: 10,
              },
            }, detail.data.text ?? ''))
          : null);


      // ---- 知识网络：图 + 选中节点详情 + 手加节点 ----
      const truncate = (text, width) => {
        const chars = Math.max(4, Math.floor((width - 16) / 13));
        const value = String(text ?? '');
        return value.length > chars ? `${value.slice(0, chars - 1)}…` : value;
      };

      const graphCard = netRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' },
          netNodes.length === 0 ? '还没有知识网络。知识点候选.json 整理后可在这里查看。' : '当前学科还没有知识点，可切换其他学科查看。')
        : h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock' },
            h('span', { className: 'sa-muted' }, `节点 ${kpFiltered.length}${kpFiltered.length === netRows.length ? '' : ` / ${netRows.length}`} · 章 ${new Set(kpFiltered.map((item) => String(item.chapter ?? '').trim() || '未分章')).size}`),
            h('span', { className: 'sa-spacer' }),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '点节点看详情；颜色越实 = 掌握度越高')),
          kpFiltered.length === 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 8 } }, '当前搜索/筛选没有命中节点，清空关键词或切回「全部」。')
            : h('div', { className: 'sa-kg-wrap', style: { marginTop: 8 } },
              h('svg', {
              width: layout.width,
              height: layout.height,
              role: 'img',
              'aria-label': '知识点网络',
              style: { display: 'block' },
            },
            ...layout.links.map((item) => h('path', {
              key: item.key,
              d: item.d,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l1)',
              strokeWidth: 1,
            })),
            ...layout.nodes.map((item) => {
              const isSelected = item.id === selected;
              const isPoint = item.level === 'point';
              return h('g', {
                key: item.id,
                onClick: isPoint ? () => setSelected(isSelected ? null : item.id) : undefined,
                style: { cursor: isPoint ? 'pointer' : 'default' },
              },
              h('rect', {
                x: item.x,
                y: item.y,
                width: item.w,
                height: item.h,
                rx: 4,
                fill: isPoint ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                stroke: isSelected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
                strokeWidth: isSelected ? 2 : 1,
              }),
              h('text', {
                x: item.x + 8,
                y: item.y + 14,
                fill: isPoint ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                fontSize: 14,
                style: { userSelect: 'none' },
              }, truncate(item.label, item.w)),
              // 掌握度用点的实心程度表达：0 空心 → 3 满色（不新造颜色，只用品牌色 + 透明）
              isPoint
                ? h('circle', {
                  cx: item.x + item.w - 10,
                  cy: item.y + 10,
                  r: 4,
                  fill: item.mastery > 0 ? 'var(--dsw-alias-brand-primary)' : 'none',
                  stroke: 'var(--dsw-alias-brand-primary)',
                  strokeWidth: 1,
                  opacity: item.mastery > 0 ? 0.3 + item.mastery * 0.2 : 0.5,
                })
                : null,
              isPoint && item.marked
                ? h('text', {
                  x: item.x + item.w - 22,
                  y: item.y + 14,
                  fill: 'var(--dsw-alias-brand-primary)',
                  fontSize: 14,
                }, '★')
                : null);
            }))));

      const selectedNode = netRows.find((item) => item.id === selected) ?? null;
      const selectedMastery = selectedNode === null ? 0 : Number(selectedNode.mastery) || 0;
      /**
       * 「改挂靠」的候选：从《知识点大纲》里取这门课的章名/节号/小节号，做成 datalist。
       * 手打「第 2 章 向量」错一个字节点就挂不上，有候选就不用背章名。
       */
      const mountOptions = useMemo(() => {
        // 没选中节点时退回「课程下拉选的那门课」，好让批量改挂靠也有候选
        const mountedCourseId = selectedNode?.courseId ?? (courseId === '' ? null : courseId);
        const course = (Array.isArray(outlineDoc?.courses) ? outlineDoc.courses : [])
          .find((item) => String(item?.courseId ?? '') === String(mountedCourseId ?? ''));
        const chapters = [];
        const sections = [];
        const subs = [];
        for (const chap of Array.isArray(course?.chapters) ? course.chapters : []) {
          chapters.push(`第${chap.no}章 ${String(chap.title ?? '').trim()}`);
          for (const sec of Array.isArray(chap.sections) ? chap.sections : []) {
            sections.push(String(sec.no));
            for (const sub of Array.isArray(sec.subs) ? sec.subs : []) subs.push(String(sub.no));
          }
        }
        return { chapters, sections, subs };
      }, [outlineDoc, selectedNode?.courseId, courseId]);
      const selectedEvidence = summarizeKnowledgeEvidence(selectedNode?.evidence);
      // 详解（离线预生成）的查表在派生区统一算好了（见 analysisPoints / coverage），这里只取当前选中那条
      const selectedPoint = selectedNode === null ? null : (analysisPoints[selectedNode.id] ?? null);
      const reviewedText = selectedNode !== null && typeof selectedNode.reviewedAt === 'string' && selectedNode.reviewedAt !== ''
        ? `最近复习 ${new Date(selectedNode.reviewedAt).toLocaleString('zh-CN', { hour12: false })}`
        : '还没标记过';

      /**
       * 一条证据：默认一行摘要，点开才显示题干/引文（避免节点卡被长题面撐爆）。
       *
       * 题证据用 `/state` 里的 `questions` 现查题干（数据里 102/102 都能命中；
       * 命中不了就明说「题干缺失」，不假装有内容）。「看原页」复用资料页那条
       * `GET /materials/text`，只读，不写任何东西。
       */
      const findQuestion = (id) => findQuestionById(questions, id);
      const evidenceRow = (ev, index, prefix) => {
        const key = `${prefix}#${index}`;
        const isQuestion = ev?.type === 'question';
        const question = isQuestion ? findQuestion(ev?.id) : null;
        const expanded = openEvidence === key;
        const target = isQuestion ? question?.sourceFile : ev?.file;
        const targetPage = isQuestion ? question?.page : ev?.page;
        const summary = isQuestion
          ? (question === null
            ? `题目 ${ev?.id ?? ''}（题干缺失）`
            : `题目 ${question.no ?? ev?.id ?? ''} · ${question.sourceFile ?? ''}`)
          : `${ev?.file ?? ''} 第 ${ev?.page ?? '?'} 页`;
        return h('div', { key, style: { padding: '2px 0' } },
          h('div', { className: 'sa-dock', style: { gap: 6, flexWrap: 'wrap' } },
            pill(isQuestion ? '题' : '页', 'soon'),
            h('button', {
              className: 'sa-btn',
              title: expanded ? '收起' : (isQuestion ? '展开题干' : '展开引文'),
              style: { textAlign: 'left', flexShrink: 1, minWidth: 0 },
              onClick: () => setOpenEvidence(expanded ? '' : key),
            }, `${expanded ? '▾' : '▸'} ${summary}`),
            typeof target === 'string' && target !== ''
              ? h('button', {
                className: 'sa-btn',
                title: '读这一页的原文',
                style: { padding: '0 6px', fontSize: 14 },
                onClick: () => showMaterial(target, targetPage),
              }, '看原页')
              : null),
          expanded
            ? (isQuestion
              ? (question === null
                ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
                  `题干缺失：题目.json 里没有 ${ev?.id ?? ''}`)
                : h('pre', {
              className: 'sa-reading-pre',
                  style: {
                    margin: '4px 0 0',
                    maxHeight: '30vh',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    fontSize: 14,
                  },
                }, String(question.prompt ?? '')))
              : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
                typeof ev?.quote === 'string' && ev.quote !== '' ? `「${ev.quote}」` : '（没存引文，点「看原页」读那一页）'))
            : null);
      };
      const evidenceRows = (evidence, prefix) => (Array.isArray(evidence) ? evidence : [])
        .map((ev, index) => evidenceRow(ev, index, prefix));

      /**
       * 「详解」块（2026-10-23 夜，批 0）：内容来自 `资料分析.json`，离线预生成、点开即读。
       *
       * 三条纪律：① 没分析过就写「未分析」，绝不拿三档讲解冒充详解；
       * ② 每块内容后面都尽量带出处（`sources`），点「看原文页」直接读那一页；
       * ③ 讲解（三档）保持用户当初的认定原样不动，详解是**新增**的一层。
       */
      // 详解正文的渲染小工具（行内 Markdown / 块级切分）已提到工厂作用域：
      // 测试要直接调 analysisInline / analysisBlockNodes，写在组件内部是拿不到的。
      /**
       * 详解插图（2026-10-26 加）：`figures: [{path, caption, page}]`。
       *
       * 图不是模型生成的，是**从教材页裁出来的派生产物**（裁切与登记见
       * `_工具/学习台-插图裁切规范.md`）：数据里只存相对路径，字节由 `/materials/image`
       * 按 `学习台/图片/_index.json` 白名单下发。所以删掉图片目录只会让图消失，
       * 不会让知识点坏掉 —— 这也是为什么它不进 `资料索引.json`。
       */
      const detailFigures = selectedPoint === null ? [] : (Array.isArray(selectedPoint.figures) ? selectedPoint.figures : [])
        .filter((figure) => figure !== null && typeof figure === 'object'
          && typeof figure.path === 'string' && figure.path.trim() !== '');
      const analysisBlock = selectedPoint === null
        ? h('div', { className: 'sa-reading', style: { marginTop: 16 } },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('h3', { className: 'sa-section-title' }, '详解'),
            pill('未分析', 'soon')),
          h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
            '这个知识点还没有预生成详解（资料分析.json 里没有它的条目）。可以先用下面的「讲解」三档现场生成一份。'))
        : h('div', { className: 'sa-reading', style: { marginTop: 16 } },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('h3', { className: 'sa-section-title' }, '详解'),
            typeof selectedPoint.level === 'string' && selectedPoint.level !== '' ? pill(selectedPoint.level, 'later') : null,
            ...(Array.isArray(selectedPoint.keywords) ? selectedPoint.keywords.slice(0, 8) : [])
              .filter((word) => typeof word === 'string' && word !== '')
              .map((word, index) => pill(word, 'soon'))),
          ...analysisBlockNodes(selectedPoint.explain, 'exp'),
          detailFigures.length > 0
            ? h('div', { className: 'sa-reading', style: { marginTop: 8 } },
              ...detailFigures.map((figure, index) => {
                const page = Number(figure.page);
                const caption = typeof figure.caption === 'string' ? figure.caption.trim() : '';
                const hasPage = Number.isFinite(page) && page > 0;
                return h('figure', { key: `fig${index}`, style: { margin: '8px 0 0' } },
                  h('img', {
                    src: `${API}/materials/image?path=${encodeURIComponent(figure.path)}`,
                    alt: caption,
                    loading: 'lazy',
                    style: {
                      display: 'block',
                      maxWidth: '100%',
                      background: '#fff',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 'var(--dsw-radius-sm)',
                    },
                    // 图没了（索引登记过但文件被删）就收起，不留一个破图框
                    onError: (event) => {
                      if (event !== null && event !== undefined && event.currentTarget !== null) event.currentTarget.style.display = 'none';
                    },
                  }),
                  caption !== '' || hasPage
                    ? h('figcaption', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
                      `${caption}${hasPage ? `${caption !== '' ? ' · ' : ''}教材第 ${page} 页` : ''}`)
                    : null);
              }))
            : null,
          typeof selectedPoint.analogy === 'string' && selectedPoint.analogy.trim() !== ''
            ? h('div', { style: { marginTop: 8, fontSize: 16, lineHeight: 1.6 } },
              h('strong', null, '打个比方：'), selectedPoint.analogy.trim())
            : null,
          ...(Array.isArray(selectedPoint.formulas) ? selectedPoint.formulas : [])
            .filter((formula) => formula !== null && typeof formula === 'object')
            .map((formula, index) => formulaCard(formula, index)),
          (Array.isArray(selectedPoint.pitfalls) ? selectedPoint.pitfalls : []).filter((item) => typeof item === 'string' && item.trim() !== '').length > 0
            ? h('div', { className: 'sa-reading', style: { marginTop: 16 } },
              h('h4', { className: 'sa-section-title' }, '易错'),
              ...selectedPoint.pitfalls.filter((item) => typeof item === 'string' && item.trim() !== '')
                .map((item, index) => h('div', { key: `pf${index}`, style: { fontSize: 16, lineHeight: 1.6 } }, `✗ ${item.trim()}`)))
            : null,
          (Array.isArray(selectedPoint.examples) ? selectedPoint.examples : []).filter((item) => item !== null && typeof item === 'object').length > 0
            ? h('div', { className: 'sa-reading', style: { marginTop: 16 } },
              h('h4', { className: 'sa-section-title' }, '例题'),
              ...selectedPoint.examples.filter((item) => item !== null && typeof item === 'object').map((example, index) => h('div', {
                key: `ex${index}`,
                className: 'sa-example',
                style: {
                  marginTop: 6,
                  padding: '6px 8px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 'var(--dsw-radius-sm)',
                },
              },
              h('div', { style: { fontSize: 16, whiteSpace: 'pre-wrap' } }, String(example.prompt ?? '')),
              ...(Array.isArray(example.steps) ? example.steps : [])
                .filter((step) => typeof step === 'string' && step.trim() !== '')
                .map((step, stepIndex) => h('div', { key: `st${stepIndex}`, className: 'sa-example-step', style: { fontSize: 14, marginTop: 2 } }, `${stepIndex + 1}. ${step.trim()}`)),
              typeof example.answer === 'string' && example.answer.trim() !== ''
                ? h('div', { className: 'sa-example-answer', style: { fontSize: 16, marginTop: 4 } }, `答：${example.answer.trim()}`)
                : null,
              typeof example.method === 'string' && example.method.trim() !== ''
                ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } }, `套路：${example.method.trim()}`)
                : null)))
            : null,
          (Array.isArray(selectedPoint.sources) ? selectedPoint.sources : []).filter((item) => item !== null && typeof item === 'object').length > 0
            ? h('div', { className: 'sa-reading', style: { marginTop: 16 } },
              h('h4', { className: 'sa-section-title' }, '来历'),
              ...selectedPoint.sources.filter((item) => item !== null && typeof item === 'object').map((source, index) => {
                const file = typeof source.file === 'string' ? source.file : '';
                const page = Number(source.page);
                return h('div', { key: `src${index}`, className: 'sa-dock', style: { gap: 6, flexWrap: 'wrap', marginTop: 2 } },
                  h('span', { className: 'sa-grow', style: { fontSize: 14 } },
                    `${file}${Number.isFinite(page) && page > 0 ? ` · 第 ${page} 页` : ''}`
                    + (typeof source.quote === 'string' && source.quote !== '' ? ` —— 「${source.quote}」` : '')),
                  file !== ''
                    ? h('button', {
                      className: 'sa-btn',
                      style: { padding: '0 6px', fontSize: 14 },
                      title: '读这一页的原文（只读）',
                      onClick: () => showMaterial(file, Number.isFinite(page) && page > 0 ? page : undefined),
                    }, '看原文页')
                    : null);
              }))
            : null);

      const nodeCard = selectedNode === null ? null : h('div', { className: 'sa-card sa-node-detail', id: 'sa-kp-detail' },
        h('div', { className: 'sa-dock' },
          h('h3', { className: 'sa-grow sa-detail-title' }, selectedNode.name ?? '(未命名)'),
          h('button', {
            className: 'sa-btn',
            title: '收起这个知识点的详情（回到列表本身）',
            onClick: () => selectForReading(null),
          }, '收起'),
          pill(MASTERY_LABELS[selectedMastery] ?? MASTERY_LABELS[0], selectedMastery >= 2 ? 'later' : 'soon'),
          selectedEvidence.total === 0 ? pill('未验证', 'soon') : null,
          selectedNode.marked === true ? pill('重点', 'today') : null),
        h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
          [courseName(selectedNode.courseId), selectedNode.chapter, selectedNode.section, selectedNode.subsection, reviewedText]
            .filter((part) => typeof part === 'string' && part !== '').join(' · ')),
        h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
          selectedEvidence.total === 0
            ? '还没有任何题目或资料页支持它（未验证）'
            : `有 ${selectedEvidence.total} 条依据（题目 ${selectedEvidence.questions} / 资料页 ${selectedEvidence.pages}）· 点开能看题干和原文`),
        h('div', { className: 'sa-dock', style: { marginTop: 8, flexWrap: 'wrap' } },
          h('span', { className: 'sa-muted' }, '掌握度'),
          ...MASTERY_LABELS.map((label, level) => h('button', {
            key: label,
            className: `sa-btn${level === selectedMastery ? ' primary' : ''}`,
            title: `把这条的掌握度记成「${label}」（0 未学 / 1 学过 / 2 熟练 / 3 精通）`,
            disabled: markBusy,
            onClick: () => patchNode(selectedNode.id, { mastery: level }),
          }, label)),
          h('span', { className: 'sa-spacer' }),
          h('button', {
            className: `sa-btn${selectedNode.marked === true ? ' primary' : ''}`,
            disabled: markBusy,
            onClick: () => patchNode(selectedNode.id, { marked: selectedNode.marked !== true }),
          }, selectedNode.marked === true ? '取消重点' : '★ 标重点')),
        // 复习打卡 + 改挂靠：这两件都不用改掌握度，但都是「复习时真正要做的事」
        h('div', { className: 'sa-dock', style: { marginTop: 6, flexWrap: 'wrap' } },
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            title: '把这条的「上次复习」记成现在，待复习队列据此往后推 7 天',
            onClick: () => markReviewed(selectedNode),
          }, '今天复习过了'),
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            title: '改这个知识点在教材里的位置（章 / 节 / 小节），改完树里就归到那一节',
            onClick: () => setMountDraft({
              id: selectedNode.id,
              chapter: selectedNode.chapter ?? '',
              section: selectedNode.section ?? '',
              subsection: selectedNode.subsection ?? '',
            }),
          }, mountDraft !== null && mountDraft.id === selectedNode.id ? '收起位置' : '改位置'),
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            title: '给这个知识点写一句自己的话（易错点 / 记法 / 注意），存进 node.note',
            onClick: () => setNoteDraft({ id: selectedNode.id, text: typeof selectedNode.note === 'string' ? selectedNode.note : '' }),
          }, noteDraft !== null && noteDraft.id === selectedNode.id ? '收起备注' : '写备注'),
          noteDraft !== null && noteDraft.id === selectedNode.id
            ? h('button', {
              className: 'sa-btn',
              onClick: () => setNoteDraft(null),
            }, '取消')
            : null,
          mountDraft !== null && mountDraft.id === selectedNode.id
            ? h('button', {
              className: 'sa-btn',
              onClick: () => setMountDraft(null),
            }, '取消')
            : null),
        mountDraft !== null && mountDraft.id === selectedNode.id
          ? h('div', { className: 'sa-dock', style: { marginTop: 4, flexWrap: 'wrap' } },
            h('input', {
              className: 'sa-input',
              style: { minWidth: 190 },
              placeholder: '章，如 第 2 章 向量',
              list: 'sa-kp-mount-chapter',
              value: mountDraft.chapter,
              onChange: (event) => setMountDraft({ ...mountDraft, chapter: event.target.value }),
            }),
            h('input', {
              className: 'sa-input',
              style: { width: 96 },
              placeholder: '节 2.5',
              list: 'sa-kp-mount-section',
              value: mountDraft.section,
              onChange: (event) => setMountDraft({ ...mountDraft, section: event.target.value }),
            }),
            h('input', {
              className: 'sa-input',
              style: { width: 110 },
              placeholder: '小节 2.5.7',
              list: 'sa-kp-mount-sub',
              value: mountDraft.subsection,
              onChange: (event) => setMountDraft({ ...mountDraft, subsection: event.target.value }),
            }),
            h('datalist', { id: 'sa-kp-mount-chapter' }, ...mountOptions.chapters.map((option) => h('option', { key: option, value: option }))),
            h('datalist', { id: 'sa-kp-mount-section' }, ...mountOptions.sections.map((option) => h('option', { key: option, value: option }))),
            h('datalist', { id: 'sa-kp-mount-sub' }, ...mountOptions.subs.map((option) => h('option', { key: option, value: option }))),
            h('button', {
              className: 'sa-btn primary',
              disabled: markBusy,
              onClick: async () => {
                const next = {
                  chapter: mountDraft.chapter.trim(),
                  section: mountDraft.section.trim(),
                  subsection: mountDraft.subsection.trim(),
                };
                const where = [next.chapter, next.section, next.subsection].filter((part) => part !== '').join(' › ');
                await patchNode(selectedNode.id, next, where === '' ? '已清空位置（会回到「没归到节」）' : `已改位置：${where}`);
                setMountDraft(null);
              },
            }, '保存挂靠'),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '章名要写成「第 2 章 向量」；节/小节只填号（2.5 / 2.5.7）'))
          : null,
        // 备注行内编辑（2026-10-23 凌晨）：保存走单条 /mutate，清空 = 传空串（不删字段）
        noteDraft !== null && noteDraft.id === selectedNode.id
          ? h('div', { className: 'sa-dock', style: { marginTop: 4, flexWrap: 'wrap' } },
            h('textarea', {
              className: 'sa-textarea',
              style: { minHeight: 44, flex: '1 1 260px' },
              placeholder: '一句话：这个点最容易错在哪 / 我的记法 / 注意什么…',
              value: noteDraft.text,
              onChange: (event) => setNoteDraft({ ...noteDraft, text: event.target.value }),
            }),
            h('button', {
              className: 'sa-btn primary',
              disabled: markBusy,
              onClick: async () => {
                const text = noteDraft.text.trim();
                await patchNode(selectedNode.id, { note: text }, text === '' ? '已清空备注' : '备注已保存');
                setNoteDraft(null);
              },
            }, '保存备注'))
          : null,
        typeof selectedNode.note === 'string' && selectedNode.note !== ''
          ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, selectedNode.note)
          : null,
        evidenceRows(selectedNode.evidence, 'sel').length === 0
          ? null
          : h('div', { style: { marginTop: 6 } },
            h('div', { className: 'sa-muted' }, '证据'),
            ...evidenceRows(selectedNode.evidence, 'sel')),
        analysisBlock,
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('h3', { className: 'sa-section-title' }, '讲解'),
            ...EXPLAIN_STYLE_OPTIONS.map((option) => h('button', {
              key: option.key,
              className: `sa-btn${explainStyle === option.key ? ' primary' : ''}`,
              disabled: explainBusy,
              onClick: () => openExplain(option.key),
            }, option.label)),
            h('span', { className: 'sa-spacer' }),
            explainData !== null && explainData.node === selectedNode.id
              ? h('button', {
                className: 'sa-btn',
                disabled: explainBusy,
                onClick: () => openExplain(explainStyle, { force: true }),
              }, '重新生成')
              : null),
          h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
            '讲解只用这个节点的证据（题干 / 资料原文），结果存 学习台/讲解缓存/，同一档不会重复生成'),
          explainBusy
            ? h('div', { className: 'sa-muted', style: { marginTop: 4 } },
              h('span', { className: 'sa-spinner' }), '生成中…（首次走模型，通常十几秒）')
            : null,
          explainError === '' ? null : h('div', { className: 'sa-error', style: { marginTop: 4 } }, explainError),
          explainData !== null && explainData.node === selectedNode.id
            ? h('div', null,
              h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
                [explainData.styleLabel, explainData.cached === true ? '缓存' : '刚生成', explainData.chars === undefined ? '' : `${explainData.chars} 字`]
                  .filter((part) => typeof part === 'string' && part !== '').join(' · ')
                + (Array.isArray(explainData.evidence?.notes) && explainData.evidence.notes.length > 0 ? ` · 跳过 ${explainData.evidence.notes.length} 条证据` : '')),
              h('pre', {
              className: 'sa-reading-pre',
                style: {
                  margin: '4px 0 0',
                  maxHeight: '38vh',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  fontSize: 14,
                  lineHeight: 1.55,
                  background: 'var(--dsw-alias-bg-base)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 'var(--dsw-radius-sm)',
                  padding: 8,
                },
              }, explainData.text ?? ''))
            : null),
        // 内嵌聊天（2026-10-24）：专读这个知识点的题目与资料原文，多轮问答不落盘
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('h3', { className: 'sa-section-title' }, '就问这个知识点'),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '只读它的题目与资料原文 · 对话不存档'),
            h('span', { className: 'sa-spacer' }),
            chatThread.length > 0
              ? h('button', {
                className: 'sa-btn',
                disabled: chatBusy,
                onClick: () => {
                  setChatThread([]);
                  setChatError('');
                  setChatSources([]);
                },
              }, '重新开始')
              : null),
          chatThread.length === 0
            ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } },
              '没听懂就接着问，比如「这步为什么能这么跳」「和前面那个概念什么区别」。答案由模型生成，务必对着来源页核一遍。')
            : h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
              ...chatThread.map((message, index) => h('div', {
                key: `chat-${index}`,
                className: 'sa-chat-message',
                style: {
                  alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  padding: '6px 8px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  fontSize: 14,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  background: message.role === 'user' ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                },
              }, message.content))),
          h('div', { className: 'sa-dock', style: { marginTop: 6, flexWrap: 'wrap', alignItems: 'flex-end' } },
            h('textarea', {
              className: 'sa-textarea',
              style: { minHeight: 40, flex: '1 1 260px' },
              placeholder: '问这个知识点的具体问题…（Enter 发送，Shift+Enter 换行）',
              value: chatInput,
              disabled: chatBusy,
              onChange: (event) => setChatInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && event.shiftKey !== true) {
                  event.preventDefault();
                  sendChat();
                }
              },
            }),
            h('button', {
              className: 'sa-btn primary',
              disabled: chatBusy || chatInput.trim() === '',
              onClick: sendChat,
            }, chatBusy ? '想…' : '发送')),
          chatBusy
            ? h('div', { className: 'sa-muted', style: { marginTop: 4 } },
              h('span', { className: 'sa-spinner' }), '正在读资料…（十几秒）')
            : null,
          chatError === '' ? null : h('div', { className: 'sa-error', style: { marginTop: 4 } }, chatError),
          chatSources.length === 0
            ? null
            : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
              `这次依据：${chatSources.slice(0, 4).join(' · ')}`)),
        markError === '' ? null : h('div', { className: 'sa-error', style: { marginTop: 6 } }, markError));

      const addNodeCard = h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
          h('input', {
            className: 'sa-input',
            style: { minWidth: 160 },
            placeholder: '知识点名称',
            value: draft.name,
            onChange: (event) => setDraft({ ...draft, name: event.target.value }),
          }),
          h('input', {
            className: 'sa-input',
            style: { minWidth: 160 },
            placeholder: '章（可选，例如 第 2 章）',
            value: draft.chapter,
            onChange: (event) => setDraft({ ...draft, chapter: event.target.value }),
          }),
          h('button', {
            className: 'sa-btn',
            disabled: markBusy || draft.name.trim() === '',
            onClick: addNode,
          }, '＋ 新建知识点'),
          h('span', { className: 'sa-spacer' }),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } },
            candidateRows.length === 0 ? '候选 0 条' : `候选 ${candidateRows.length} 条待固化`)),
        draft.chapter === '' && draft.section === '' && draft.subsection === ''
          ? null
          : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
            `挂到：${[courseName(draft.courseId), draft.chapter, draft.section, draft.subsection]
              .filter((part) => typeof part === 'string' && part !== '').join(' › ')}（在树上点「＋ 新建」可换一层）`),
        markError !== '' && selectedNode === null ? h('div', { className: 'sa-error', style: { marginTop: 6 } }, markError) : null);

      // 「候选 → 网络」与「网络 → 画布」都靠服务端整份读改写；按钮只发信号，不在前端拼内容。
      const jobCard = h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            title: '把 知识点候选.json 里的候选合并进网络（同名合并、证据去重，只增不夺）',
            onClick: () => runKnowledgeJob('weave'),
          }, '织网'),
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            title: '把网络写成 kp-notes 能认的 md（notes/ 与 questions/ 与 _manifest.json）',
            onClick: () => runKnowledgeJob('export'),
          }, '导出到画布'),
          h('span', { className: 'sa-spacer' }),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '画布目录：学习台/知识画布'),
          h('button', {
            className: 'sa-btn',
            disabled: markBusy,
            onClick: () => refresh?.(),
          }, '刷新')),
        markBusy ? h('div', { className: 'sa-progress indet' }, h('i', null)) : null,
        markNote === '' ? null : h('div', { className: 'sa-muted', style: { marginTop: 6 } }, markNote),
        markError !== '' && selectedNode === null && markNote === ''
          ? h('div', { className: 'sa-error', style: { marginTop: 6 } }, markError)
          : null);

      // ---- 复习可用性：工具条 / 待复习 / 列表 / 批量（2026-10-21） ----
      const KP_FILTERS = [
        { key: 'all', label: '全部', title: '不筛，显示全部节点' },
        { key: 'unlearned', label: '未学', title: '掌握度还没到「熟练」（0～1）的节点' },
        { key: 'marked', label: '★ 重点', title: '标了重点的节点' },
        { key: 'due', label: '待复习', title: '掌握度没到「精通」、且距上次复习满 7 天（从没复习过的按建点时间起算）' },
        { key: 'unmounted', label: '没归到节', title: '还没归到教材某一节的知识点（点开节点用「改位置」指定章/节）' },
        { key: 'issues', label: '有问题', title: '下面四类里占其一的：章号对不上教材 / 没归到节 / 没有依据 / 题目找不到' },
        { key: 'noanalysis', label: '没详解', title: '还没有预生成详解的知识点（资料分析.json 里没有它的条目）' },
      ];

      // 掌握度四档各有多少个（当前课程范围内）——筛选按钮上的数字用它，符号/颜色用 MASTERY_STYLE
      const masteryCounts = (() => {
        const counts = [0, 0, 0, 0];
        for (const node of netRows) {
          const raw = Number(node?.mastery);
          const level = Number.isFinite(raw) ? Math.min(3, Math.max(0, Math.trunc(raw))) : 0;
          counts[level] += 1;
        }
        return counts;
      })();
      // 点一下加进/移出；保持升序，界面记忆里也只存升序（见 readKnowledgeUi）
      const toggleMastery = (level) => setKpMastery(kpMastery.includes(level)
        ? kpMastery.filter((item) => item !== level)
        : [...kpMastery, level].sort((left, right) => left - right));

      const kpToolbar = h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
          h('label', { className: 'sa-dock', style: { gap: 8 } },
            h('span', null, isTreeView ? '选择学科' : '课程'),
            h('select', { className: 'sa-input', style: { minWidth: 180, maxWidth: '100%' },
              'aria-label': isTreeView ? '选择学科树' : '筛选课程',
              value: isTreeView ? treeCourseId : courseId,
              onChange: event => { if (isTreeView) chooseTreeCourse(event.target.value); else { setCourseId(event.target.value); setSelected(null); if(event.target.value) setTreeCourseId(event.target.value); } },
            }, isTreeView ? (treeCourses.length === 0 ? h('option', { value: '' }, '暂无学科树') : null) : h('option', { value: '' }, '全部课程'),
            ...(isTreeView ? treeCourses : courses).map(course => h('option', { key: course.id, value: course.id }, course.name)))),
          h('input', {
            className: 'sa-input',
            style: { minWidth: 180 },
            placeholder: '搜知识点 / 别名 / 章名',
            value: kpQuery,
            onChange: (event) => setKpQuery(event.target.value),
          }),
          ...KP_FILTERS.map((item) => h('button', {
            key: item.key,
            className: `sa-btn${kpFilter === item.key ? ' primary' : ''}`,
            title: item.title,
            onClick: () => setKpFilter(item.key),
          }, item.label)),
          h('span', { className: 'sa-spacer' }),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `命中 ${kpFiltered.length} / ${netRows.length}`),
          // 视图切换（2026-10-23 夜加「导图」：真思维导图 + 掌握度符号/颜色）
          ...[
            ['mind', '知识树', '左侧选知识点，右侧读详解；完整思维导图可展开查看'],
            ['tree', '目录树', '逐级缩进、连接线和字重区分课程、章、节与知识点'],
            ['graph', '图', '三列层级图，一屏看完整门课'],
            ['list', '列表', '平铺成列表，一章一块、可以折叠'],
            ['explain', '讲解', '已经生成好的讲解，按课程 / 章分组'],
          ].map(([key, label, title]) => h('button', {
            key,
            className: `sa-btn${kpView === key ? ' primary' : ''}`,
            title,
            onClick: () => { if ((key === 'mind' || key === 'tree') && selected) { const item = netNodes.find(n => n.id === selected); if(item) setTreeCourseId(String(item.courseId ?? '').trim() || '__none__'); } setFullBrowser(false); setBrowserCollapsed(false); setKpView(key); },
          }, label)),
          // 清空筛选（2026-10-22 深夜）：关键词 + 筛选一起复位。搜索之后想回到全量时，
          // 以前得先删词再点「全部」——两下操作、还容易忘掉其中一半。
          kpQuery.trim() !== '' || kpFilter !== 'all' || kpMastery.length > 0
            ? h('button', {
              className: 'sa-btn',
              title: '清空搜索词、把筛选切回「全部」、掌握度回到四档都要',
              onClick: () => { setKpQuery(''); setKpFilter('all'); setKpMastery([]); },
            }, '清空筛选')
            : null,
        ),
        markNote === '' ? null : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } }, markNote),
        // 体检行（2026-10-23 凌晨）：树会把「章名差一个字」「题号悬空」藏起来，这里先给数字
        netRows.length === 0 ? null : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
          '体检：',
          h('button', {
            className: 'sa-btn',
            style: { padding: '0 6px', fontSize: 14 },
            title: '这门课有教材目录，但知识点的「第 N 章」在目录里找不到（多半是章名写错了）',
            onClick: () => { setKpQuery(''); setKpFilter('issues'); },
          }, `章号对不上 ${health.unclassified}`),
          ` · 没归到节 ${health.unmounted}`,
          ` · 没依据 ${health.noEvidence}`,
          ` · 题目找不到 `,
          h('button', {
            className: 'sa-btn',
            style: { padding: '0 6px', fontSize: 14 },
            title: '依据里写的题号在《题目.json》里查不到，点开只会显示「题干缺失」',
            onClick: () => { setKpQuery(''); setKpFilter('issues'); },
          }, String(health.dangling)),
          health.duplicateIds.length > 0 ? ` · id 重复 ${health.duplicateIds.length}` : null,
          health.noOutline > 0
            ? ` · 没教材目录 ${health.noOutline}（这门课只能按老结构看，归不了节）`
            : null,
          health.unclassified + health.dangling + health.noEvidence + health.unmounted === 0
            ? '（很干净）'
            : h('button', {
              className: 'sa-btn',
              style: { padding: '0 6px', fontSize: 14 },
              title: '把有问题的知识点挑出来（四类合一）',
              onClick: () => { setKpQuery(''); setKpFilter('issues'); },
            }, `挑出有问题的 ${health.issueIds.length} 个`)),
        // 详解覆盖（2026-10-24 傍晚）：分析线一批批写 资料分析.json，这里给个「写了多少」的数
        netRows.length === 0 ? null : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
          '详解：',
          h('button', {
            className: 'sa-btn',
            style: { padding: '0 6px', fontSize: 14 },
            title: '已经有预生成详解的知识点数 / 总知识点数。点一下筛出还没写的那些',
            onClick: () => { setKpQuery(''); setKpFilter('noanalysis'); },
          }, `${coverage.covered} / ${coverage.total}`),
          coverage.missing > 0
            ? h('button', {
              className: 'sa-btn',
              style: { padding: '0 6px', fontSize: 14 },
              title: '把还没有详解的知识点挑出来（分析线下一批优先写它们）',
              onClick: () => { setKpQuery(''); setKpFilter('noanalysis'); },
            }, `还有 ${coverage.missing} 个没写`)
            : ' （都写完了）'),
        // 掌握度多选（2026-10-24）：用户要「自选熟练度展开」，所以把这排图例做成可点的筛选——
        // 勾哪几档就只铺哪几档（树/导图/图/列表全跟着变），再点一下取消。
        // 数字来自「当前课程范围」的 netRows，不随关键词变化，方便一眼看出哪档最多。
        netRows.length === 0 ? null : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('span', null, '掌握度：'),
          ...MASTERY_STYLE.map((item, level) => h('button', {
            key: item.label,
            className: `sa-btn${kpMastery.includes(level) ? ' primary' : ''}`,
            style: { padding: '0 6px', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 4 },
            title: `只看「${item.label}」的节点（可多选，再点一下取消）——当前 ${masteryCounts[level]} 个`,
            onClick: () => toggleMastery(level),
          },
          h('span', { style: { color: item.color, fontSize: 16 } }, item.symbol),
          `${item.label} ${masteryCounts[level]}`)),
          kpMastery.length > 0
            ? h('button', {
              className: 'sa-btn',
              style: { padding: '0 6px', fontSize: 14 },
              title: '取消掌握度筛选，回到四档都要',
              onClick: () => setKpMastery([]),
            }, '四档都要')
            : null,
          kpMastery.length > 0
            ? h('span', null, `（只看 ${kpMastery.length} 档）`)
            : null));

      /**
       * 待复习卡：只显示前 5 条，避免一屏刷不完。
       * 数量为 0 时也保留这张卡——空队列本身就是「复习节奏正常」的信息，
       * 顺手把判定规则写在下面，省得用户猜为什么没有。
       */
      const dueCard = netRows.length === 0 ? null : h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-grow' }, `待复习 ${dueRows.length} 个`),
          dueRows.length === 0 ? null : h('button', {
            className: 'sa-btn',
            onClick: () => {
              setKpFilter('due');
              setKpView('list');
            },
          }, '去列表看')),
        dueRows.length === 0
          ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
            '没有到期的节点：掌握度到「精通」的不再提醒；其余节点距上次复习满 7 天才会进这个队列，从没复习过的从建点时间起算 7 天。')
          : h('div', { style: { marginTop: 4 } },
            ...dueRows.slice(0, 5).map((node) => h('div', {
              key: node.id,
              className: 'sa-row',
              style: { cursor: 'pointer' },
              onClick: () => {
                setSelected(node.id);
                setKpView('list');
              },
            },
            node.marked === true ? pill('★', 'today') : null,
            h('span', { className: 'sa-grow' }, node.name ?? '(未命名)'),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, chapterName(node)),
            pill(MASTERY_LABELS[Number(node.mastery) || 0] ?? MASTERY_LABELS[0], 'soon'))),
            dueRows.length > 5
              ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } }, `还有 ${dueRows.length - 5} 个…`)
              : null));

      /** 列表行里的掌握度 4 小按钮：点一下立即落盘，与详情卡的能力一致。 */
      const masteryButtons = (node) => MASTERY_LABELS.map((label, level) => h('button', {
        key: label,
        className: `sa-btn${(Number(node.mastery) || 0) === level ? ' primary' : ''}`,
        title: `标为「${label}」`,
        style: { padding: '0 6px', fontSize: 14 },
        disabled: markBusy,
        onClick: (event) => {
          event.stopPropagation();
          patchNode(node.id, { mastery: level });
        },
      }, label));

      /**
       * 命中加粗（2026-10-22 深夜）：树/列表/讲解共用，切法由纯函数 splitByQuery 决定。
       * 没有命中时直接回字符串——别为了统一而给每个名字包一层 <b>，DOM 会白白翻倍。
       */
      const renderMatched = (text, query) => {
        const parts = splitByQuery(text, query);
        if (parts.length === 1 && parts[0].hit === false) return parts[0].text;
        return parts.map((part, index) => (part.hit ? h('b', { key: `m${index}` }, part.text) : part.text));
      };

      const knowledgeRow = (node) => h('div', {
        key: node.id,
        // 选中行带 id（2026-10-24 傍晚）：从今日页/搜索结果跳过来时，把这一行滚到视野中间，
        // 否则长树里根本不知道自己跳到哪了
        id: selected === node.id ? 'sa-kp-selected' : undefined,
        className: 'sa-row',
        // 选中的那一行给个底色，长树里点完才知道自己刚才点的是哪条
        style: selected === node.id ? { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 'var(--dsw-radius-sm)' } : null,
      },
        h('span', {
          className: 'sa-grow',
          style: { cursor: 'pointer' },
          title: Array.isArray(node.aliases) && node.aliases.length > 0 ? `别名：${node.aliases.join('、')}` : undefined,
          onClick: () => setSelected(node.id),
        },
        renderMatched(node.name ?? '(未命名)', kpQuery),
        Array.isArray(node.aliases) && node.aliases.length > 0
          ? h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `　${node.aliases.join('、')}`)
          : null),
        // 详解标记（2026-10-24 傍晚）：分析线写过的点直接标出来，不用一个个点开看「未分析」
        analysisPoints[String(node?.id ?? '')] === undefined
          ? null
          : h('span', {
              className: 'sa-pill soon',
              style: { fontSize: 14 },
              title: '这个点已经有预生成详解，点行首的名字就能看',
            }, '有详解'),
        h('span', { className: 'sa-muted', style: { fontSize: 14, minWidth: 52 },
          title: summarizeKnowledgeEvidence(node.evidence).total === 0 ? '没有任何题目或资料页支持这个点' : undefined },
        summarizeKnowledgeEvidence(node.evidence).total > 0
          ? `依据 ${summarizeKnowledgeEvidence(node.evidence).total}`
          : '没依据'),
        h('button', {
          className: 'sa-btn',
          title: node.marked === true ? '取消重点' : '标为重点',
          style: { padding: '0 6px' },
          disabled: markBusy,
          onClick: (event) => {
            event.stopPropagation();
            patchNode(node.id, { marked: node.marked !== true });
          },
        }, node.marked === true ? '★' : '☆'),
        ...masteryButtons(node));

      /** 四段掌握度小条：段宽按个数、透明度按档位（和图里圆点的实心程度一套口径）。 */
      const masteryBar = (stats) => h('div', {
        className: 'sa-kp-bar',
        title: `未学 ${stats.counts[0]} · 学过 ${stats.counts[1]} · 熟练 ${stats.counts[2]} · 精通 ${stats.counts[3]}`,
      }, [0.25, 0.5, 0.75, 1].map((opacity, level) => h('div', {
        key: `seg-${level}`,
        className: 'sa-kp-seg',
        style: { flexGrow: stats.counts[level], opacity },
      })));

      /**
       * 一章的批量讲解面板：先告诉「还要生成几份」，串行跑并就地显示进度。
       *
       * 默认跳过已生成的档（否则点一次就把全章缓存重烧一遍，token 与时间都是浪费），
       * 重生成走单节点卡里的「重新生成」，那条路径才会显式带 force。
       */
      const batchPanel = (group) => {
        const nodes = Array.isArray(group.nodes) ? group.nodes : [];
        const generated = new Set(explainListState.items
          .filter((item) => item.style === batchStyle)
          .map((item) => item.node));
        const pending = nodes.filter((node) => generated.has(node.id) !== true).length;
        const running = batchState.status === 'running';
        const failed = Array.isArray(batchState.failed) ? batchState.failed : [];
        const note = batchState.status === 'done'
          ? `完成：成功 ${Math.max(0, batchState.total - failed.length)} 份${failed.length > 0 ? `，失败 ${failed.length} 份` : ''}。`
          : running ? `进度 ${batchState.done}/${batchState.total}…` : '';
        return h('div', { style: {
          marginTop: 6,
          padding: '6px 8px',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: 'var(--dsw-radius-sm)',
        } },
        h('div', { className: 'sa-row', style: { flexWrap: 'wrap' } },
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '档位'),
          ...EXPLAIN_STYLE_OPTIONS.map((option) => h('button', {
            key: option.key,
            className: `sa-btn${batchStyle === option.key ? ' primary' : ''}`,
            style: { padding: '0 6px', fontSize: 14 },
            disabled: running,
            onClick: (event) => {
              event.stopPropagation();
              setBatchStyle(option.key);
            },
          }, option.label)),
          h('span', { className: 'sa-spacer' }),
          h('button', {
            className: 'sa-btn primary',
            style: { padding: '0 8px', fontSize: 14 },
            disabled: running || pending === 0,
            onClick: (event) => {
              event.stopPropagation();
              runChapterBatch(group);
            },
          }, running
            ? h('span', null, h('span', { className: 'sa-spinner' }), `生成中 ${batchState.done}/${batchState.total}`)
            : pending === 0 ? '这一章都已生成' : `生成缺的 ${pending} 份`)),
        running
          ? h('div', { className: 'sa-progress' },
            h('i', { style: { width: `${batchState.total > 0 ? Math.round((batchState.done / batchState.total) * 100) : 0}%` } }))
          : null,
        h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
          '串行生成（一次一份，避免撞限流），只补还没生成的档；要重生成请点单个节点。',
          batchState.skipped > 0 ? ` 本次跳过已有 ${batchState.skipped} 份。` : ''),
        note === '' ? null : h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } }, note),
        failed.length > 0
          ? h('div', { className: 'sa-error', style: { fontSize: 14, marginTop: 2 } }, failed.join('；').slice(0, 240))
          : null);
      };

      /** 列表里的一章：点标题折叠；折叠只影响显示，不影响批量与统计。 */
      const knowledgeChapter = (group) => {
        const collapsed = isChapterCollapsed(group.key);
        const stats = chapterMasteryStats(group.nodes);
        const batchOpen = batchChapter === group.key;
        return h('div', { key: group.key, style: { marginBottom: 10 } },
          h('div', {
            className: 'sa-row',
            style: {
              cursor: 'pointer',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderRadius: 'var(--dsw-radius-sm)',
            },
            onClick: () => toggleChapter(group.key),
          },
          h('span', { className: 'sa-grow' }, `${collapsed ? '▸' : '▾'} `, renderMatched(group.chapter, kpQuery)),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } },
            `${group.courseLabel} · ${group.nodes.length} 个 · 到熟练 ${stats.mastered}`),
          h('button', {
            className: `sa-btn${batchOpen ? ' primary' : ''}`,
            title: '批量生成这一章的讲解（只补还没生成的档）',
            style: { padding: '0 6px', fontSize: 14 },
            onClick: (event) => {
              event.stopPropagation();
              setBatchChapter(batchOpen ? '' : group.key);
              // 换一章就清掉上一章的进度，否则「完成 3/3」会挂在新章头下面误导人
              if (batchOpen !== true) setBatchState({ status: 'idle', done: 0, total: 0, skipped: 0, failed: [] });
              loadExplainList(false);
            },
          }, batchOpen ? '收起' : '讲解')),
          masteryBar(stats),
          batchOpen ? batchPanel(group) : null,
          collapsed ? null : group.nodes.map(knowledgeRow));
      };

      /**
       * 树视图（2026-10-21 夜批2）：学科 → 章 → 节 → 知识点，一层层点开。
       *
       * 搜索框有词时所有分支强制展开——用户要找的是「命中在哪一章哪一节」，
       * 一边搜一边还要手点开路径就太费劲；清空关键词后回到用户手动展开的状态。
       */
      const treeRow = (entry, depth, delay = 0) => {
        // 错开淡入（2026-10-24 夜）：整段子行同时出现像刷新，按序号错 14ms 才像「展开」
        const reveal = delay > 0 ? { animationDelay: `${delay}ms` } : null;
        if (entry.kind === 'node') {
          return h('div', {
            key: entry.key,
            className: 'sa-kp-leaf', 'data-depth': depth,
            style: { paddingLeft: 0, ...reveal },
          }, knowledgeRow(entry.node));
        }
        const open = kpFilter !== 'all' || kpQuery.trim() !== '' || kpMastery.length > 0 || openTree.includes(entry.key);
        const empty = entry.empty === true;
        return h('div', { key: entry.key, className: 'sa-kp-branch' },
          h('div', {
            className: 'sa-row sa-tree-row',
            'data-depth': depth,
            'data-open': open,
            style: { cursor: 'pointer', paddingLeft: 0, opacity: empty ? 0.8 : 1, ...reveal },
            onClick: () => toggleTreeNode(entry.key),
          },
          h('span', { className: 'sa-kp-caret', 'aria-hidden': true }, '▸'),
          h('span', { className: 'sa-tree-kind' }, ({ course: '课程', chapter: '章', section: '节', sub: '小节', group: '分组' })[entry.kind] || ''),
          h('span', { className: 'sa-grow' }, renderMatched(entry.label, kpQuery)),
          entry.page ? h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `p.${entry.page}`) : null,
          // 只有分支（章/节/小节）有 ctx；课程层太粗不加
          entry.kind === 'course' || entry.ctx === null || entry.ctx === undefined
            ? null
            : h('button', {
              className: 'sa-btn',
              title: '在这一层新建一个知识点：自动把课程/章/节/小节填好，你只写名字',
              style: { padding: '0 6px', fontSize: 14 },
              onClick: (event) => { event.stopPropagation(); prefillAdd(entry.ctx); },
            }, '＋ 新建'),
          /**
           * 「挂」：把**这门课所有未分节的节点**筛出来，并把这一层（章/节/小节）预填进批量改挂靠。
           * 顺序不能反——先切课程 + 筛「未分节」，否则批量会把别的课的未分节点一起挂到这一章。
           * 2026-10-22 深夜加：数电 12 个「未分节」节点逐条改太慢。
           */
          entry.kind === 'course' || entry.ctx === null || entry.ctx === undefined
            ? null
            : h('button', {
              className: 'sa-btn',
              title: '归位：把这门课还没归到章/节的知识点列出来，并把这一层填到下面的「批量归位」',
              style: { padding: '0 6px', fontSize: 14 },
              onClick: (event) => {
                event.stopPropagation();
                setCourseId(entry.ctx.courseId ?? '');
                setKpQuery('');
                setKpFilter('unmounted');
                setKpView('list');
                setBatchMount({
                  chapter: entry.ctx.chapter ?? '',
                  section: entry.ctx.section ?? '',
                  subsection: entry.ctx.subsection ?? '',
                });
                setMarkNote(`已列出「${entry.ctx.courseId ?? ''}」里还没归位的知识点，并把这一层填到下面的「批量归位」——确认后点「归位这 N 个」。`);
              },
            }, '归位'),
          entry.stats.marked > 0 ? pill(`★ ${entry.stats.marked}`, 'soon') : null,
          empty
            ? h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '暂无知识点')
            : h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `${entry.count} 个`),
          empty ? null : h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `熟练 ${entry.stats.mastered}`)),
          depth === 0 ? null : h('div', { style: { paddingLeft: 0 } }, masteryBar(entry.stats)),
          open
            ? h('div', { className: 'sa-kp-children' },
              entry.children.map((child, index) => treeRow(child, depth + 1, Math.min(index, 12) * 14)))
            : null);
      };

      const treeCard = netRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' },
          '还没有知识网络。先在下面手加一两个节点试试，或等「织网」把 知识点候选.json 固化成网络。')
        : h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('span', { className: 'sa-grow' }, (treeCourses.find(item => item.id === treeCourseId)?.name || '学科') + ' · 目录树 · ' + kpFiltered.length + ' 个知识点'),
            outlineStats.chapters > 0
              ? h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `按教材目录：${outlineStats.chapters} 章 / ${outlineStats.sections} 节 / ${outlineStats.subs} 小节`)
              : h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '还没有《知识点大纲》，暂时只按知识网络分层'),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '一次查看一门学科；首次只展开到章，点章继续阅读'),
            h('button', { className: 'sa-btn', onClick: () => setOpenTree(allTreeKeys) }, '全部展开'),
            h('button', { className: 'sa-btn', onClick: () => setOpenTree([]) }, '全部收起'),
            // 打印树（2026-10-22 深夜）：@media print 藏了按钮，但**藏不掉折叠**——
            // 树是收起的时候直接打印，纸上只剩一串学科名。先全部展开再调 window.print()。
            h('button', {
              className: 'sa-btn',
              title: '先全部展开再打印，否则纸上只有收起的学科名',
              onClick: () => { setOpenTree(allTreeKeys); setTimeout(() => window.print(), 80); },
            }, '打印树')),
          kpFiltered.length === 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '当前搜索/筛选没有命中节点，清空关键词或切回「全部」。')
            : h('div', { className: 'sa-kg-wrap sa-tree-canvas', key: treeCourseId, ref: restoreTreeScroll, 'data-tree-course': treeCourseId, onScroll: event => saveTreeScroll('tree', event), style: { marginTop: 8 } }, tree.map((entry) => treeRow(entry, 0))));

      // 思维导图卡（2026-10-23 夜，A 块）：横向树 + 贝塞尔连线；点圆点选中，
      // 圆点颜色/符号表示掌握度（与工具条图例同一套）。渲染层只做摆放，布局在 buildMindMap 里。
      const mindCard = netRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' },
          netNodes.length === 0 ? '还没有知识网络。知识点候选.json 整理后可在这里查看。' : '当前学科还没有知识点，可切换其他学科查看。')
        : h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
            h('span', { className: 'sa-grow' }, (treeCourses.find(item => item.id === treeCourseId)?.name || '学科') + ' · 导图 · 共 ' + kpFiltered.length + ' 个知识点 · 已展开 ' + mind.points + ' 个' + (mind.collapsed > 0 ? ' · ' + mind.collapsed + ' 章未展开' : '')),
            h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '以当前学科为起点；点章展开，点知识点看详解；各学科独立记忆'),
            h('button', {
              className: 'sa-btn',
              title: '把所有章的知识点都铺出来（节点多时图会很长）',
              onClick: () => setMindOpen(mindChapterKeys),
            }, '全部展开'),
            h('button', {
              className: 'sa-btn',
              title: '收回到「章」这一层，只看骨架',
              onClick: () => setMindOpen([]),
            }, '全部收起'),
            h('button', {
              className: 'sa-btn',
              title: '把导图缩到一屏宽（内容太长时横向滚动）',
              onClick: () => { if (typeof document !== 'undefined') { const box = document.getElementById('sa-mind-wrap'); if (box) { box.scrollLeft = 0; box.scrollTop = 0; saveTreeScroll('mind', { currentTarget: box }); } } },
            }, '回到开头')),
          kpFiltered.length === 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '当前搜索/筛选没有命中节点，清空关键词或切回「全部」。')
            : h('div', {
              className: 'sa-kg-wrap',
              id: 'sa-mind-wrap', key: treeCourseId, ref: restoreTreeScroll, 'data-tree-course': treeCourseId, onScroll: event => saveTreeScroll('mind', event),
              style: { marginTop: 8, overflow: 'auto', maxHeight: '62vh' },
            },
            h('svg', {
              width: mind.width,
              height: mind.height,
              role: 'img',
              'aria-label': (treeCourses.find(item => item.id === treeCourseId)?.name || '学科') + '知识点思维导图',
              style: { display: 'block' },
            },
            ...mind.links.map((link) => {
              const from=mind.nodes.find(n=>n.key===link.from),to=mind.nodes.find(n=>n.key===link.to);
              if (!from || !to) return null;
              const x1=from.x+from.width,x2=to.x,mid=(x1+x2)/2;
              return h('path',{key:link.key,className: 'sa-mind-link',pathLength: 1,
                d:'M '+x1+' '+from.y+' C '+mid+' '+from.y+', '+mid+' '+to.y+', '+x2+' '+to.y,
                fill:'none',stroke:'var(--dsw-alias-border-l1)',strokeWidth:2});
            }),
            ...mind.nodes.map((item,mindIndex) => {
              const isPoint=item.kind==='point',isChapter=item.kind==='chapter';
              const selectedPoint=isPoint && item.id===selected;
              const state=MASTERY_STYLE[isPoint ? Math.min(Math.max(item.mastery||0,0),3) : 0];
              const activate=()=>isPoint ? selectForReading(item.id) : toggleMindChapter(item.key);
              const level=({root:'总览',course:'课程',chapter:'章',section:'节',sub:'小节',group:'分组',point:'知识点'})[item.kind] || '';
              return h('g',{key:item.key,className: 'sa-mind-node',
                role:isPoint||isChapter?'button':undefined,tabIndex:isPoint||isChapter?0:undefined,
                'aria-label':item.label,'aria-expanded':isChapter?item.open:undefined,
                onClick:isPoint||isChapter?activate:undefined,
                onKeyDown:isPoint||isChapter?(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}}:undefined,
                style:{cursor:isPoint||isChapter?'pointer':'default',animationDelay:Math.min(mindIndex,20)*10+'ms'}},
                h('title',null,item.label),
                h('rect',{x:item.x,y:item.y-item.height/2,width:item.width,height:item.height,rx:12,
                  fill:'var(--dsw-alias-bg-layer-1)',stroke:selectedPoint?'var(--dsw-alias-brand-primary)':'var(--dsw-alias-border-l1)',strokeWidth:selectedPoint?2.5:1}),
                h('text',{x:item.x+14,y:item.y-item.height/2+19,fontSize:14,fill:'var(--dsw-alias-label-secondary)'},
                  level+(isPoint?' '+state.symbol+' '+state.label:'')+(isChapter?' '+(item.open?'▾':'▸')+' '+item.total+' 个':'')+(item.marked?' ★':'')),
                isPoint?h('circle',{cx:item.x+item.width-16,cy:item.y-item.height/2+16,r:4,fill:state.color}):null,
                ...item.lines.map((line,index)=>h('text',{key:index,x:item.x+14,y:item.y-item.height/2+43+index*24,
                  fontSize:item.kind==='course'||item.kind==='root'?18:16,fontWeight:item.kind==='point'?500:650,fill:'var(--dsw-alias-label-primary)'},line)));
            }))));

      const knowledgeListCard = netRows.length === 0 ? null : h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-muted' }, `列表 · ${chapterGroups.length} 章 · ${kpFiltered.length} 个节点`),
          h('span', { className: 'sa-spacer' }),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '点章标题折叠；点名称看详情')),
        kpFiltered.length === 0
          ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '当前搜索/筛选没有命中节点。')
          : h('div', { className: 'sa-kg-wrap', style: { marginTop: 8 } }, ...chapterGroups.map(knowledgeChapter)));

      /**
       * 讲解视图（2026-10-21 夜）：一屏列出所有已生成的讲解。
       *
       * 以前只能「选中节点 → 逐档点」，生成过什么全靠记忆；这里把 9 份缓存摊开，
       * 搜索框与工具条共用，正文点开才取（清单只回元信息）。
       */
      const explainKeyword = kpQuery.trim().toLowerCase();
      const explainItems = explainListState.items.filter((item) => explainKeyword === ''
        || `${item.name} ${item.styleLabel} ${item.style}`.toLowerCase().includes(explainKeyword));
      // 按「课程 › 章」分组：讲解越攒越多，平铺一列看不出哪几章已经铺满、哪几章还空着
      const explainGroups = (() => {
        const byNodeId = new Map(netRows.map((node) => [node.id, node]));
        const groups = new Map();
        for (const item of explainItems) {
          const nodeRow = byNodeId.get(item.node);
          const courseLabel = nodeRow === undefined || nodeRow === null ? '（节点已删）' : (courseName(nodeRow.courseId) || '未分课程');
          const chapterLabel = nodeRow === undefined || nodeRow === null ? '' : String(nodeRow.chapter ?? '');
          const key = `${courseLabel}|${chapterLabel}`;
          if (!groups.has(key)) groups.set(key, { key, courseLabel, chapterLabel, items: [] });
          groups.get(key).items.push(item);
        }
        return [...groups.values()];
      })();
      const explainCovered = new Set(explainListState.items.map((item) => item.node));
      // 三种状态（2026-10-24 夜）：详解（资料分析.json）和旧「讲解缓存」是两套东西，
      // 只有摆在一起才知道某个点是「压根没生成」还是「只是还没有详解」。
      const explainDetailCount = netRows.filter((node) => analysisPoints[String(node?.id ?? '')] !== undefined).length;
      const explainOnlyCache = netRows.filter((node) => analysisPoints[String(node?.id ?? '')] === undefined
        && explainCovered.has(node.id)).length;
      const explainNeither = Math.max(0, netRows.length - explainDetailCount - explainOnlyCache);
      const explainCard = h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
          h('span', { className: 'sa-grow' },
            explainListState.status === 'loading'
              ? '讲解清单读取中…'
              : `已生成 ${explainListState.items.length} 份 · 覆盖 ${explainCovered.size} 个节点`
                + (netRows.length === 0 ? '' : `（知识网络 ${netRows.length} 个节点，还差 ${Math.max(0, netRows.length - explainCovered.size)} 个没生成）`)),
          netRows.length === 0
            ? null
            : h('span', { className: 'sa-muted', style: { fontSize: 14 } },
              `有详解 ${explainDetailCount} · 只有旧讲解 ${explainOnlyCache} · 都没有 ${explainNeither}`),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, '搜索框对名称/档位生效'),
          h('button', {
            className: 'sa-btn',
            disabled: explainListState.status === 'loading',
            onClick: () => loadExplainList(true),
          }, explainListState.status === 'loading' ? '读取中…' : '刷新')),
        explainListState.error === ''
          ? null
          : h('div', { className: 'sa-error', style: { marginTop: 4 } }, `清单读取失败：${explainListState.error}`),
        explainListState.status === 'ready' && explainItems.length === 0
          ? h('div', { className: 'sa-muted', style: { marginTop: 6 } },
            explainListState.items.length === 0
              ? '还没有生成过讲解：在「树 / 图 / 列表」里选中一个知识点，点「助教推导 / 考前速通 / 只给提示」生成第一份。'
              : '当前搜索没有命中已生成的讲解。')
          : null,
        ...explainGroups.flatMap((group) => [
          h('div', {
            key: `group:${group.key}`,
            className: 'sa-row',
            style: { marginTop: 8, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 2 },
          },
          h('span', { className: 'sa-grow', style: { fontSize: 14 } },
            [group.courseLabel, group.chapterLabel].filter((part) => part !== '').join(' · ')),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } }, `${group.items.length} 份`)),
          ...group.items.map((item) => {
          const key = `${item.node}|${item.style}`;
          const expanded = explainOpen === key;
          return h('div', { key, style: { padding: '3px 0' } },
            h('div', { className: 'sa-row' },
              h('button', {
                className: 'sa-btn',
                title: expanded ? '收起正文' : '展开正文',
                style: { textAlign: 'left', flexShrink: 1, minWidth: 0 },
                onClick: () => toggleExplainBody(item),
              }, `${expanded ? '▾' : '▸'} `, renderMatched(item.name === '' ? item.node : item.name, kpQuery)),
              h('span', { className: 'sa-muted', style: { fontSize: 14 } }, item.styleLabel),
              h('span', { className: 'sa-muted', style: { fontSize: 14, minWidth: 52, textAlign: 'right' } }, `${item.chars} 字`),
              h('span', { className: 'sa-muted', style: { fontSize: 14, minWidth: 128 } }, item.generatedAt === '' ? '时间未知' : item.generatedAt),
              item.stale === true ? pill('节点已删', 'soon') : null,
              analysisPoints[String(item.node ?? '')] === undefined ? null : pill('有详解', 'soon'),
              h('span', { className: 'sa-spacer' }),
              h('button', {
                className: 'sa-btn',
                title: '回到列表并选中这个节点',
                style: { padding: '0 6px', fontSize: 14 },
                onClick: () => {
                  setSelected(item.node);
                  setKpView('list');
                },
              }, '跳到节点')),
            expanded
              ? (explainBody.status === 'loading'
                ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 2 } }, '读取正文…')
                : (explainBody.status === 'error'
                  ? h('div', { className: 'sa-error', style: { marginTop: 2 } }, `正文读取失败：${explainBody.error}`)
                  : h('pre', {
              className: 'sa-reading-pre',
                    style: {
                      margin: '4px 0 0',
                      maxHeight: '38vh',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      fontSize: 14,
                    },
                  }, String(explainBody.data?.text ?? ''))))
              : null);
          }),
        ]));

      /**
       * 批量卡：只在命中 ≥2 个时出现。
       * 文案必须写清「当前筛选结果」——这是最容易误伤的操作，
       * 用户以为标的是「这一章」，实际生效的是搜索/筛选后的集合。
       */
      const batchCard = kpFiltered.length < 2 ? null : h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock', style: { flexWrap: 'wrap' } },
          h('span', { className: 'sa-grow' }, `批量：把当前命中的 ${kpFiltered.length} 个知识点标为`),
          ...MASTERY_LABELS.map((label, level) => h('button', {
            key: label,
            className: 'sa-btn',
            title: `把这 ${kpFiltered.length} 个的掌握度都记成「${label}」`,
            disabled: markBusy,
            onClick: () => markFiltered(level),
          }, label)),
        ),
        h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
          '只影响「搜索 + 筛选」命中的知识点，一次请求、一次落盘；失败则一个都不改。'),
        // 整批同一个值的操作（2026-10-23 凌晨）：重点与复习打卡，都不碰掌握度
        h('div', { className: 'sa-dock', style: { gap: 6, flexWrap: 'wrap', marginTop: 8 } },
          h('button', {
            className: 'sa-btn',
            title: '把这批都标成重点（★），方便以后只看重点',
            disabled: markBusy,
            onClick: () => patchFiltered({ marked: true }, '标为 ★ 重点'),
          }, '全标★'),
          h('button', {
            className: 'sa-btn',
            title: '把这批的「重点」标记去掉',
            disabled: markBusy,
            onClick: () => patchFiltered({ marked: false }, '取消 ★ 重点'),
          }, '取消★'),
          h('button', {
            className: 'sa-btn',
            title: '把这批的「上次复习」都记成今天，待复习队列据此往后推 7 天',
            disabled: markBusy,
            onClick: () => patchFiltered({ reviewedAt: new Date().toISOString() }, '记成今天复习过'),
          }, '都打卡'),
          h('span', { className: 'sa-muted', style: { fontSize: 14 } },
            '打卡只写时间，不改掌握度——「今天翻过了」不等于「会了」。'),
        ),
        // 批量改挂靠（2026-10-22 深夜）：和上面那排掌握度同一批节点，一次挂到同一层
        h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          h('div', { className: 'sa-muted', style: { fontSize: 14, marginBottom: 4 } },
            '批量归位：把命中的这些知识点一起归到这同一层（章必填，节/小节可留空）'),
          h('div', { className: 'sa-dock', style: { gap: 6, flexWrap: 'wrap' } },
            h('input', {
              className: 'sa-input',
              style: { maxWidth: 210 },
              placeholder: '第 2 章 逻辑代数基础',
              list: 'sa-kp-batch-chapter',
              value: batchMount.chapter,
              onInput: (event) => setBatchMount({ ...batchMount, chapter: event.target.value }),
            }),
            h('input', {
              className: 'sa-input',
              style: { maxWidth: 90 },
              placeholder: '节 2.5',
              list: 'sa-kp-batch-section',
              value: batchMount.section,
              onInput: (event) => setBatchMount({ ...batchMount, section: event.target.value }),
            }),
            h('input', {
              className: 'sa-input',
              style: { maxWidth: 100 },
              placeholder: '小节 2.5.7',
              list: 'sa-kp-batch-sub',
              value: batchMount.subsection,
              onInput: (event) => setBatchMount({ ...batchMount, subsection: event.target.value }),
            }),
            h('button', {
              className: 'sa-btn',
              disabled: markBusy,
              onClick: () => mountFiltered(),
            }, `归位这 ${kpFiltered.length} 个`),
          ),
          h('datalist', { id: 'sa-kp-batch-chapter' },
            ...mountOptions.chapters.map((option) => h('option', { key: option, value: option }))),
          h('datalist', { id: 'sa-kp-batch-section' },
            ...mountOptions.sections.map((option) => h('option', { key: option, value: option }))),
          h('datalist', { id: 'sa-kp-batch-sub' },
            ...mountOptions.subs.map((option) => h('option', { key: option, value: option }))),
        ));


      // 紧凑目录用于日常选择；完整导图/目录按需展开。
      const compactTreeRow = entry => {
        if (entry.kind === 'node') {
          const active = selected === entry.node.id;
          return h('li', { key: entry.key, className: 'sa-compact-leaf' },
            h('button', { type: 'button', className: 'sa-compact-point', 'aria-current': active ? 'true' : undefined,
              title: entry.label, onClick: () => selectForReading(entry.node.id) },
              h('span', { className: 'sa-compact-dot', 'aria-hidden': true }, active ? '●' : '·'),
              h('span', null, renderMatched(entry.label, kpQuery))));
        }
        const open = kpFilter !== 'all' || kpQuery.trim() !== '' || kpMastery.length > 0 || openTree.includes(entry.key);
        return h('li', { key: entry.key, className: 'sa-compact-branch', 'data-kind': entry.kind },
          h('button', { type: 'button', className: 'sa-compact-toggle', 'aria-expanded': open,
            title: entry.label, onClick: () => toggleTreeNode(entry.key) },
            h('span', { className: 'sa-compact-arrow', 'aria-hidden': true }, open ? '▾' : '▸'),
            h('span', { className: 'sa-compact-name' }, renderMatched(entry.label, kpQuery)),
            h('span', { className: 'sa-compact-count' }, String(entry.count || 0))),
          open && entry.children?.length ? h('ul', { className: 'sa-compact-children' }, entry.children.map(compactTreeRow)) : null);
      };
      const compactTree = h('div', { className: 'sa-compact-scroll', key: treeCourseId, ref: restoreCompactScroll,
        'data-tree-course': treeCourseId, onScroll: event => saveTreeScroll('tree', event), tabIndex: 0,
        'aria-label': '当前学科知识目录' },
        netRows.length === 0 ? h('p', { className: 'sa-muted' }, netNodes.length === 0 ? '还没有知识网络，可先整理知识点候选.json。' : '当前学科还没有知识点，可切换学科查看。')
          : kpFiltered.length === 0 ? h('p', { className: 'sa-muted' }, '没有匹配的知识点，请调整搜索或筛选。')
          : h('ul', { className: 'sa-compact-tree' }, tree.map(compactTreeRow)));
      const browsingHeader = h('div', { className: 'sa-browser-head' },
        h('div', { className: 'sa-browser-caption' },
          h('strong', null, (treeCourses.find(item => item.id === treeCourseId)?.name || '学科') + ' · 知识树'),
          h('span', { className: 'sa-muted' }, '点名称阅读，点箭头展开')),
        h('button', { type: 'button', className: 'sa-btn sa-browser-toggle',
          'aria-expanded': !browserCollapsed, 'aria-controls': 'sa-browser-content',
          onClick: () => setBrowserCollapsed(value => !value) }, browserCollapsed ? '更换知识点' : '收起目录'),
        h('button', { type: 'button', className: 'sa-btn', 'aria-expanded': fullBrowser,
          onClick: () => { setFullBrowser(value => !value); setBrowserCollapsed(false); } },
          fullBrowser ? '返回分栏阅读' : (kpView === 'tree' ? '展开完整目录' : '展开完整导图')));
      const treeWorkspace = h('div', { className: 'sa-learning-layout', 'data-full-browser': fullBrowser ? 'true' : 'false',
        'data-browser-collapsed': browserCollapsed ? 'true' : 'false' },
        h('section', { className: 'sa-browser-pane', 'aria-label': '选择知识点' }, browsingHeader,
          h('div', { className: 'sa-browser-content', id: 'sa-browser-content' },
            fullBrowser ? h('div', { key: kpView, className: 'sa-kp-view sa-full-browser' }, kpView === 'tree' ? treeCard : mindCard) : compactTree)),
        h('section', { className: 'sa-reader-pane', ref: readerRef, tabIndex: 0,
          'aria-label': selectedNode ? '知识点阅读：' + selectedNode.name : '知识点阅读区' },
          nodeCard || h('div', { className: 'sa-card sa-reader-empty' },
            h('h3', null, '选一个知识点开始阅读'),
            h('p', null, '展开知识树中的章、节，点击知识点名称。详解、例题和配图会显示在这里。'),
            h('p', { className: 'sa-muted' }, '查看全章关系时，可展开完整导图；点选后自动回到阅读布局。')),
          detailCard));

      return h('div', { className: 'sa-knowledge-page' },
        kpToolbar,
        isTreeView ? treeWorkspace : h('div', null,
          h('div', { key: kpView, className: 'sa-kp-view' }, kpView === 'graph' ? graphCard : kpView === 'list' ? knowledgeListCard : explainCard),
          nodeCard, detailCard),
        kpView === 'explain' ? null : dueCard,
        kpView === 'explain' ? null : batchCard,
        addNodeCard, jobCard);
    }

    function SettingsTab({ docs, refresh, busy, run, setBusy }) {
      const terms = Array.isArray(docs.term?.terms) ? docs.term.terms : [];
      const [draft, setDraft] = useState({ name: '', startDate: '', endDate: '', totalWeeks: '16' });
      const [health, setHealth] = useState(null);
      // 分析批次展开（2026-10-24 夜）：runs[] 里除了点数/模型，还有 note（这一批做了什么）
      // 和失败原因，默认折叠会让「为什么这一批是红的」无从查起。
      const [openRun, setOpenRun] = useState('');

      useEffect(() => {
        let alive = true;
        fetch(`${API}/health`, { headers: { Accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (alive) setHealth(payload);
          })
          .catch(() => {
            if (alive) setHealth({ ok: false, error: 'unreachable' });
          });
        return () => {
          alive = false;
        };
      }, []);

      // 数据备份 / 生成记录（2026-10-21 夜）
      // 三源：作业.json 的 records[].model、讲解缓存的元信息、知识点网络的更新时间。
      const [backupBusy, setBackupBusy] = useState(false);
      const [backupNote, setBackupNote] = useState('');
      const [records, setRecords] = useState({ status: 'loading', explain: [], error: '' });

      useEffect(() => {
        let alive = true;
        explainList()
          .then((result) => {
            if (!alive) return;
            if (result?.ok === true) {
              setRecords({ status: 'ready', explain: Array.isArray(result.items) ? result.items : [], error: '' });
            } else {
              setRecords({ status: 'error', explain: [], error: String(result?.error ?? 'unknown') });
            }
          })
          .catch(() => {
            if (alive) setRecords({ status: 'error', explain: [], error: 'unreachable' });
          });
        return () => {
          alive = false;
        };
      }, []);

      const downloadBackup = async () => {
        setBackupBusy(true);
        setBackupNote('');
        try {
          const result = await exportBackup().catch(() => ({ ok: false, error: 'unreachable' }));
          if (result?.ok !== true) {
            setBackupNote(`导出失败：${result?.error ?? 'unknown'}`);
            return;
          }
          const text = JSON.stringify(result.bundle, null, 2);
          const blob = new Blob([text], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          const stamp = String(result.bundle?.exportedAt ?? '').slice(0, 19).replace(/[:T]/g, '');
          anchor.href = url;
          anchor.download = `学习台备份-${stamp || 'export'}.json`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          const skipped = Array.isArray(result.skipped) && result.skipped.length > 0
            ? `，跳过 ${result.skipped.length} 份（缺失或损坏）`
            : '';
          setBackupNote(`已导出 ${result.count ?? 0} 份 · 校验和 ${String(result.bundle?.checksum ?? '').slice(0, 20)}…${skipped}`);
        } finally {
          setBackupBusy(false);
        }
      };

      const pickBackupFile = async (event) => {
        const file = event?.target?.files?.[0];
        if (event?.target) event.target.value = '';
        if (!file) return;
        setBackupBusy(true);
        setBackupNote('');
        try {
          const text = await file.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            setBackupNote('这个文件不是 JSON，可能选错了。');
            return;
          }
          const bundle = parsed?.bundle ?? parsed;
          const when = bundle?.exportedAt ? String(bundle.exportedAt).slice(0, 19).replace('T', ' ') : '未知';
          if (!window.confirm(`恢复会用这个包覆盖同名数据文档（写前自动备份一份）。\n导出时间：${when}\n确认恢复？`)) return;
          const result = await restoreBackup(bundle).catch(() => ({ ok: false, error: 'unreachable' }));
          if (result?.ok !== true) {
            const expected = result?.expected ? `（包校验和 ${String(result.expected).slice(0, 20)}…，实际 ${String(result.actual ?? '').slice(0, 20)}…）` : '';
            setBackupNote(`恢复失败：${result?.error ?? 'unknown'}${expected}`);
            return;
          }
          const failed = Array.isArray(result.failed) && result.failed.length > 0 ? `，失败 ${result.failed.length} 份` : '';
          setBackupNote(`已恢复 ${result.restored?.length ?? 0} 份${failed}，旧版都在「学习台/备份」。`);
          await refresh();
        } finally {
          setBackupBusy(false);
        }
      };

      const addTerm = async () => {
        if (draft.name.trim() === '') return;
        setBusy(true);
        try {
          await run(() => mutate('term', 'create', {
            item: {
              name: draft.name.trim(),
              startDate: draft.startDate,
              endDate: draft.endDate,
              totalWeeks: Number(draft.totalWeeks) || 16,
              isCurrent: terms.length === 0,
            },
          }));
          setDraft({ name: '', startDate: '', endDate: '', totalWeeks: '16' });
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const setCurrent = async (term) => {
        setBusy(true);
        try {
          await run(() => mutate('term', 'update', { id: term.id, item: { ...term, isCurrent: true } }));
          // 其余学期取消当前标记
          for (const other of terms) {
            if (other.id !== term.id && other.isCurrent) {
              await run(() => mutate('term', 'update', { id: other.id, item: { ...other, isCurrent: false } }));
            }
          }
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const clearDoc = (doc, label) => {
        if (!window.confirm(`确定清空「${label}」？会先自动备份一份。`)) return;
        setBusy(true);
        run(() => resetDoc(doc)).then(refresh).catch(() => {}).finally(() => setBusy(false));
      };

      return h('div', null, h(Style),
        h('div', { className: 'sa-card' },
          h('h3', null, '学期'),
          terms.length === 0 ? h('div', { className: 'sa-muted' }, '还没有学期。') : terms.map((term) => h('div', { className: 'sa-row', key: term.id },
            h('span', { className: 'sa-grow' }, `${term.name}　${term.startDate} → ${term.endDate}　共 ${term.totalWeeks} 周`),
            term.isCurrent ? h(Pill, { level: 'later' }, '当前') : h('button', { className: 'sa-btn', disabled: busy, onClick: () => setCurrent(term) }, '设为当前'),
          )),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
            h('input', { className: 'sa-input', placeholder: '学期名 如 2026 秋', value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }) }),
            h('input', { className: 'sa-input', type: 'date', value: draft.startDate, onChange: (e) => setDraft({ ...draft, startDate: e.target.value }) }),
            h('input', { className: 'sa-input', type: 'date', value: draft.endDate, onChange: (e) => setDraft({ ...draft, endDate: e.target.value }) }),
            h('input', { className: 'sa-input', placeholder: '总周数', style: { width: 76 }, value: draft.totalWeeks, onChange: (e) => setDraft({ ...draft, totalWeeks: e.target.value }) }),
            h('button', { className: 'sa-btn primary', disabled: busy || draft.name.trim() === '', onClick: addTerm }, '添加学期'),
          ),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '数据健康'),
          health === null
            ? h('div', { className: 'sa-muted' }, '检查中…')
            : h('div', null,
                h('div', { className: 'sa-muted' }, `数据目录：${health.dataDir ?? '未知'}`),
                ...(Array.isArray(health.files) ? health.files : []).map((file) => h('div', { className: 'sa-row', key: file.key },
                  h('span', { className: file.ok ? 'sa-grow' : 'sa-grow sa-error' }, `${file.file}　${file.ok ? '正常' : file.reason ?? '异常'}`),
                  h('span', { className: 'sa-muted' }, file.bytes === null ? '—' : `${file.bytes} 字节`),
                )),
                h('button', { className: 'sa-btn', onClick: () => { setHealth(null); fetch(`${API}/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({ ok: false })); } }, '重新检查'),
              ),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '数据备份'),
          h('div', { className: 'sa-muted', style: { marginBottom: 8 } },
            '把十一份数据打成一个带校验和的 JSON 存到别处；出事时选这个文件恢复（覆盖同名文档，写前自动备份到「学习台/备份」）。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', { className: 'sa-btn primary', disabled: busy || backupBusy, onClick: downloadBackup }, backupBusy ? '处理中…' : '导出全部数据'),
            h('label', { className: 'sa-btn', style: { cursor: 'pointer' }, title: '选一个由「导出全部数据」生成的 JSON' },
              '选择备份文件恢复',
              h('input', {
                type: 'file',
                accept: 'application/json,.json',
                style: { display: 'none' },
                disabled: busy || backupBusy,
                onChange: pickBackupFile,
              })),
          ),
          backupNote === '' ? null : h('div', { className: 'sa-muted', style: { marginTop: 8 } }, backupNote),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '生成记录'),
          h('div', { className: 'sa-muted', style: { marginBottom: 6 } },
            '哪些内容是模型生成的、用了什么模型、什么时候 —— 三处来源都列在这里。'),
          (() => {
            const homeworkRecords = objectList(docs.homework?.records);
            const withModel = homeworkRecords.filter((item) => item?.model && item.model.model);
            const courses = objectList(docs.courses?.courses);
            const courseName = (id) => courses.find((item) => item.id === id)?.name ?? id ?? '未挂课程';
            const network = docs.knowledgeNetwork;
            const nodes = Array.isArray(network?.nodes) ? network.nodes.length : 0;
            return h('div', null,
              h('div', { className: 'sa-row' },
                h('span', { className: 'sa-grow' }, '作业分题（作业.json）'),
                h('span', { className: 'sa-muted' }, homeworkRecords.length === 0
                  ? '没有记录'
                  : `${homeworkRecords.length} 份来源 · 带模型记录 ${withModel.length} 份`),
              ),
              ...homeworkRecords.map((record) => h('div', { className: 'sa-row', key: record.id },
                h('span', { className: 'sa-grow' }, `${courseName(record.courseId)} · ${record.title ?? record.sourceFile ?? record.id}`),
                h('span', { className: 'sa-muted', style: { fontSize: 14 } },
                  record.model?.model
                    ? `${record.model.model}${record.model.at ? ` · ${String(record.model.at).slice(0, 16).replace('T', ' ')}` : ''}`
                    : '未记录模型（人工/取字批次）'),
              )),
              h('div', { className: 'sa-row' },
                h('span', { className: 'sa-grow' }, '知识点讲解（讲解缓存/）'),
                h('span', { className: records.status === 'error' ? 'sa-error' : 'sa-muted' },
                  records.status === 'loading'
                    ? '读取中…'
                    : records.status === 'error'
                      ? `读不到（${records.error}）`
                      : `${records.explain.length} 份 · 带模型名 ${records.explain.filter((item) => item.model && item.model !== '宿主默认模型（未回传）').length} 份`),
              ),
              ...records.explain.slice(0, 6).map((item) => h('div', { className: 'sa-row', key: `${item.node}-${item.style}` },
                h('span', { className: 'sa-grow' }, `${item.name ?? item.node} · ${item.styleLabel ?? item.style}`),
                h('span', { className: 'sa-muted', style: { fontSize: 14 } },
                  `${item.chars ?? 0} 字 · ${item.model && item.model !== '宿主默认模型（未回传）' ? item.model : '模型未回传'} · ${item.generatedAt ? String(item.generatedAt).slice(0, 16).replace('T', ' ') : '时间未知'}`),
              )),
              records.status === 'ready' && records.explain.length > 6
                ? h('div', { className: 'sa-muted', style: { fontSize: 14 } }, `…还有 ${records.explain.length - 6} 份，去「资料 → 知识点 → 讲解」看全部`)
                : null,
              h('div', { className: 'sa-row' },
                h('span', { className: 'sa-grow' }, '知识网络（知识点网络.json）'),
                h('span', { className: 'sa-muted' }, `${nodes} 个节点 · 更新于 ${network?.updatedAt ? String(network.updatedAt).slice(0, 16).replace('T', ' ') : '未知'}`),
              ),
              // 第四处来源（2026-10-24）：教材/PPT/作业的「分析流水线」跑了哪些批次、产出了多少点。
              // 这些是另一个会话按 `_工具/资料分析会话-执行命令` 写进 资料分析.json 的，用户要求
              // 「所有分析都要有生成记录和报告」，所以 runs[] 必须在这里露出来。
              (() => {
                const analysis = docs.knowledgeAnalysis;
                const runs = objectList(analysis?.runs);
                const analysisCourses = objectList(analysis?.courses);
                const pointCount = analysisCourses.reduce((sum, course) => sum + objectList(course?.points).length, 0);
                const latest = runs.reduce((best, run) => {
                  const at = typeof run?.at === 'string' ? run.at : '';
                  return at > best ? at : best;
                }, '');
                // 失败批次要在抬头就报个数（2026-10-24 夜）：摘要里看不到「有几批是坏的」，
                // 得一条条展开才发现，等于没报。
                const failedRuns = runs.filter((run) => run?.ok === false).length;
                return h('div', null,
                  h('div', { className: 'sa-row' },
                    h('span', { className: 'sa-grow' }, '资料分析（资料分析.json）'),
                    h('span', { className: 'sa-muted' }, runs.length === 0
                      ? '还没有分析批次（详解卡会显示「未分析」）'
                      : `${runs.length} 个批次${failedRuns > 0 ? ` · 其中 ${failedRuns} 个失败` : ''} · ${analysisCourses.length} 门课 · ${pointCount} 个知识点详解${latest === '' ? '' : ` · 最近 ${latest.slice(0, 16).replace('T', ' ')}`}`),
                  ),
                  ...runs.slice().reverse().slice(0, 6).map((run) => {
                    const key = String(run.id ?? '');
                    const open = openRun !== '' && openRun === key;
                    const note = typeof run.note === 'string' ? run.note.trim() : '';
                    return h('div', { key },
                      h('div', {
                        className: 'sa-row',
                        style: { cursor: 'pointer' },
                        title: open ? '收起这一批的详情' : '展开看这一批做了什么（note / 失败原因 / 模型）',
                        onClick: () => setOpenRun(open ? '' : key),
                      },
                        h('span', { className: 'sa-muted', style: { fontSize: 14, width: 12 } }, open ? '▾' : '▸'),
                        h('span', { className: 'sa-grow' }, `${courseName(run.courseId)} · ${run.unit ?? run.id}`),
                        h('span', { className: run?.ok === false ? 'sa-error' : 'sa-muted', style: { fontSize: 14 } },
                          `${run.kind ?? '分析'} · ${run.points ?? 0} 点${run.exercises ? ` · ${run.exercises} 题` : ''}${run.chars ? ` · ${run.chars} 字` : ''} · ${run.model ?? '模型未记录'} · ${run.at ? String(run.at).slice(0, 16).replace('T', ' ') : '时间未知'}`),
                      ),
                      open
                        ? h('div', { className: 'sa-muted', style: { fontSize: 14, lineHeight: 1.7, padding: '4px 0 8px 18px' } },
                          h('div', null, `批次 id：${key === '' ? '（未记）' : key}`),
                          h('div', null, `产出：${run.points ?? 0} 个知识点${run.exercises ? ` · ${run.exercises} 道习题` : ''}${run.chars ? ` · 正文 ${run.chars} 字` : ''}`),
                          h('div', null, `模型：${run.model ?? '未记录'}${run.provider ? `（${run.provider}）` : ''}`),
                          h('div', null, `时间：${run.at ? String(run.at).replace('T', ' ').slice(0, 19) : '未记录'}`),
                          h('div', { className: run?.ok === false ? 'sa-error' : null },
                            `结果：${run?.ok === false ? '失败' : '成功'}`),
                          note === '' ? null : h('div', null, `这一批做了什么：${note}`),
                          run?.error === undefined || run?.error === null || run?.error === ''
                            ? null
                            : h('div', { className: 'sa-error' }, `失败原因：${String(run.error).slice(0, 240)}`),
                        )
                        : null,
                    );
                  }),
                  runs.length > 6
                    ? h('div', { className: 'sa-muted', style: { fontSize: 14 } }, `…还有 ${runs.length - 6} 个批次`)
                    : null,
                );
              })(),
            );
          })(),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '危险操作'),
          h('div', { className: 'sa-muted', style: { marginBottom: 8 } }, '清空某份数据（会先自动备份到「学习台/备份」）。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', { className: 'sa-btn', disabled: busy, onClick: () => clearDoc('courses', '课程') }, '清空课程'),
            h('button', { className: 'sa-btn', disabled: busy, onClick: () => clearDoc('tasks', '任务') }, '清空任务'),
            h('button', { className: 'sa-btn', disabled: busy, onClick: () => clearDoc('grades', '成绩') }, '清空成绩'),
            h('button', { className: 'sa-btn', disabled: busy, onClick: () => clearDoc('term', '学期') }, '清空学期'),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 主面板
    // ---------------------------------------------------------------------

    function MainPanel(props) {
      const openDetail = props?.openDetail;

      // ⚠️ usePanelInfo 是 useSyncExternalStoreWithSelector 的绑定（见
      //    dsh-client-ui-renderer 的 bindSnapshotSelector → useSyncExternalStoreWithSelector），
      //    它第 107 行**无条件调用传入的 selector**：不传 selector 时渲染期直接抛 TypeError。
      //    所以这里必须始终传一个 selector，并且 hook 调用次数恒定（不能放进 if）。
      //    没有这个 prop 时用一个只认 props?.panelInfo 的兜底实现，保持 hook 顺序稳定。
      const fallbackPanelInfo = (selector) => {
        const info = { activePanelId: props?.panelInfo?.activePanelId ?? null };
        return typeof selector === 'function' ? selector(info) : info;
      };
      const usePanelInfo = typeof props?.usePanelInfo === 'function' ? props.usePanelInfo : fallbackPanelInfo;
      const panelActive = usePanelInfo((info) => info?.activePanelId === PANEL_ID);
      // 有真实 usePanelInfo 时以它为准；没有时（宿主形态变化）退回 props.panelInfo，
      // 两者都拿不到才默认轮询——否则面板会永远不刷新（此前的默认值就是永久 active）。
      const hasRealPanelInfo = typeof props?.usePanelInfo === 'function';
      const active = hasRealPanelInfo ? panelActive === true : props?.panelInfo?.activePanelId === PANEL_ID;
      const selected = props?.panelInfo?.activePanelId === PANEL_ID;

      // 页签位置也进导航记忆：返回时能连页签一起复原
      const [tab, setTab] = useState(() => navTabMemory);
      // 返回/前进后 +1：资料页与知识点页用它当 key 重挂载，挂载时从模块内存恢复初值
      const [navVersion, setNavVersion] = useState(0);

      /** 跳转前先把「现在在哪」压栈，再切页签（页签点击也走这里）。 */
      const goto = useCallback((nextTab) => {
        navPush(navSnapshot(tab));
        navTabMemory = nextTab;
        setTab(nextTab);
      }, [tab]);

      const goBack = useCallback(() => {
        const entry = navBack();
        if (entry === null) return;
        setTab(entry.tab);
        setNavVersion((value) => value + 1);
      }, []);

      const goForward = useCallback(() => {
        const entry = navForward();
        if (entry === null) return;
        setTab(entry.tab);
        setNavVersion((value) => value + 1);
      }, []);

      // 起点入栈 + Alt+← / Alt+→ 键盘来回（鼠标不去找按钮也能退）
      useEffect(() => {
        if (navIndex < 0) navPush(navSnapshot(tab));
      }, []);
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.altKey !== true || event.ctrlKey === true || event.metaKey === true) return;
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            goBack();
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            goForward();
          }
        };
        // 静态渲染/烟测环境里没有 window.addEventListener，别让整页挂掉
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [goBack, goForward]);

      // 跨页签联动：资料页点知识点 → 切到知识点页并选中它
      const [kpFocus, setKpFocus] = useState(null);
      const onOpenKnowledge = (nodeId) => {
        goto('knowledge');
        setKpFocus({ nodeId });
      };
      // 今日页「去复习」→ 知识点页直接落在「待复习」筛选上
      // 今日页「去写没写的」：跳到知识点页签并切到「没详解」筛选
      const onOpenKnowledgeCoverage = () => {
        setKpFocus({ filter: 'noanalysis' });
        goto('knowledge');
      };
      const onOpenKnowledgeReview = () => {
        goto('knowledge');
        setKpFocus({ filter: 'due' });
      };
      // 反方向：知识点页的「看原页 / 去资料页看」→ 切到资料页并直接打开那一页
      const [materialFocus, setMaterialFocus] = useState(null);
      const onOpenMaterial = (path, page) => {
        goto('materials');
        setMaterialFocus({ path, page });
      };
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [detailNote, setDetailNote] = useState(null);
      const { status, data, error: loadError, refresh } = useStudyData(active || selected);

      /** 统一的写操作包装：捕获错误并显示在顶部。 */
      const run = useCallback(async (operation) => {
        setError(null);
        try {
          return await operation();
        } catch (err) {
          setError(String(err?.message ?? err));
          throw err;
        }
      }, []);

      const docs = data?.docs ?? {
        term: null,
        courses: null,
        tasks: null,
        grades: null,
        materials: null,
        questions: null,
        knowledgeCandidates: null,
        knowledgeNetwork: null,
      };
      const now = useMemo(() => new Date(), [data]);

      const tabDefs = [
        ['today', TEXT.tabs.today],
        ['schedule', TEXT.tabs.schedule],
        ['deadlines', TEXT.tabs.deadlines],
        ['grades', TEXT.tabs.grades],
        ['materials', TEXT.tabs.materials],
        ['knowledge', TEXT.tabs.knowledge],
        ['settings', TEXT.tabs.settings],
      ];

      let body = null;
      if (status === 'loading' && data === null) {
        body = h('div', { className: 'sa-muted' }, TEXT.loading);
      } else if (status === 'error' && data === null) {
        body = h('div', null,
          h('div', { className: 'sa-error' }, `${TEXT.error}：${loadError}`),
          h('button', { className: 'sa-btn', style: { marginTop: 8 }, onClick: refresh }, TEXT.retry),
        );
      } else if (tab === 'today') {
        body = h(TodayTab, { docs, now, refresh, onOpenKnowledgeReview, onOpenKnowledge, onOpenKnowledgeCoverage });
      } else if (tab === 'schedule') {
        body = h(ScheduleTab, { docs, now, refresh, busy, run, setBusy });
      } else if (tab === 'deadlines') {
        body = h(DeadlinesTab, { docs, now, refresh, busy, run, setBusy });
      } else if (tab === 'grades') {
        body = h(GradesTab, { docs, refresh, busy, run, setBusy });
      } else if (tab === 'materials') {
        body = h(MaterialsTab, { key: `materials-${navVersion}`, docs, refresh, onOpenKnowledge, focus: materialFocus, onFocusConsumed: () => setMaterialFocus(null) });
      } else if (tab === 'knowledge') {
        body = h(KnowledgeTab, { key: `knowledge-${navVersion}`, docs, refresh, focus: kpFocus, onFocusConsumed: () => setKpFocus(null), onOpenMaterial });
      } else {
        body = h(SettingsTab, { docs, refresh, busy, run, setBusy });
      }

      return h('div', { className: 'sa-root', 'data-sa-panel': true },
        h(Style),
        h('div', { className: 'sa-head' },
          h('h2', null, TEXT.title),
          // 返回 / 前进（2026-10-24 傍晚）：面板里到处是「跳到别处」，没有回程就只能绕页签
          h('button', {
            className: 'sa-btn',
            title: '回到上一个位置（Alt+←）。会连页签、筛选、展开的章、打开的文件一起复原',
            disabled: !navCanBack(),
            style: navCanBack() ? { padding: '2px 8px' } : { padding: '2px 8px', opacity: 0.45, cursor: 'default' },
            onClick: goBack,
          }, '← 返回'),
          h('button', {
            className: 'sa-btn',
            title: '回到下一个位置（Alt+→）',
            disabled: !navCanForward(),
            style: navCanForward() ? { padding: '2px 8px' } : { padding: '2px 8px', opacity: 0.45, cursor: 'default' },
            onClick: goForward,
          }, '前进 →'),
          h('span', { className: 'sa-spacer' }),
          data?.problems?.length > 0 ? h(Pill, { level: 'overdue' }, `数据问题 ${data.problems.length}`) : null,
          detailNote !== null ? h('span', { className: 'sa-muted' }, detailNote) : null,
          typeof openDetail === 'function'
            ? h('button', {
                className: 'sa-btn',
                onClick: () => setDetailNote(openDetail() ? '已开到右侧栏' : '需要先打开一个会话'),
              }, '详情开右侧栏')
            : null,
          // 打印：只印当前页签的内容，@media print 里把页签栏/按钮/输入框藏掉
          h('button', { className: 'sa-btn', onClick: () => window.print() }, '打印'),
          h('button', { className: 'sa-btn', onClick: refresh }, '刷新'),
        ),
        h('div', { className: 'sa-tabs', role: 'tablist' },
          ...tabDefs.map(([key, label]) => h('button', {
            key,
            role: 'tab',
            className: 'sa-tab',
            'aria-selected': tab === key,
            onClick: () => goto(key),
          }, label)),
        ),
        error !== null
          ? h('div', { style: { padding: '8px 14px' } }, h('span', { className: 'sa-error' }, error))
          : null,
        h('div', { className: 'sa-body' }, body),
      );
    }

    /**
     * 面板自带的错误边界。
     *
     * 为什么需要：槽位渲染器只在 React 树里报错，并把这一格退化成
     * `<div data-slot-error="main">` 空壳 —— 界面上就是「点了没反应 / 一片空白」，
     * 原因只出现在控制台里。上线阶段没有 DevTools 就完全瞎了。
     * 这里把异常就地渲染成可读文字，同时上报给渲染器的 entry-error 通道。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: null };
      }

      static getDerivedStateFromError(failure) {
        return { failure };
      }

      componentDidCatch(failure) {
        this.props.onFailure?.(failure);
      }

      render() {
        if (this.state.failure !== null) {
          const detail = String(this.state.failure?.stack ?? this.state.failure?.message ?? this.state.failure);
          return h('div', { className: 'sa-root', 'data-sa-panel': true },
            h('div', { className: 'sa-head' }, h('h2', null, TEXT.title)),
            h('div', { className: 'sa-body' },
              h('div', { className: 'sa-error' }, '面板渲染失败：'),
              h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 14, marginTop: 8 } }, detail),
            ),
          );
        }
        return this.props.children;
      }
    }

    // ---------------------------------------------------------------------
    // 侧栏图标（尺寸与选中态由 owner 提供）
    // ---------------------------------------------------------------------

    function PanelIcon(props) {
      const size = Number(props?.size) || 18;
      const active = props?.active === true;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
        h('rect', { x: 3.2, y: 5, width: 17.6, height: 15, rx: 2.6 }),
        h('path', { d: 'M3.2 9.6h17.6' }),
        h('path', { d: 'M8 5V2.8M16 5V2.8' }),
        h('path', { d: 'M7.6 13.4h3.2M12.4 13.4h3.2M7.6 16.8h7.9' }),
      );
    }

    // ---------------------------------------------------------------------
    // 会话内嵌：输入框下方的 DDL 提醒
    // ---------------------------------------------------------------------

    function ComposerDock() {
      const [alerts, setAlerts] = useState(null);

      useEffect(() => {
        let alive = true;
        const tick = () => {
          fetch(`${API}/overview`, { headers: { Accept: 'application/json' } })
            .then((response) => response.json())
            .then((payload) => {
              if (!alive || !payload?.ok) return;
              const now = new Date();
              const upcoming = (payload.overview?.upcoming ?? []).filter((task) => {
                const days = task.days;
                return task.level === 'overdue' || task.level === 'today' || task.level === 'soon' || (typeof days === 'number' && days <= NOTICE_WINDOW_DAYS);
              });
              setAlerts({ upcoming, overdue: payload.overview?.overdueCount ?? 0, week: payload.overview?.week ?? 0 });
            })
            .catch(() => {
              if (alive) setAlerts({ upcoming: [], overdue: 0, week: 0, unreachable: true });
            });
        };
        tick();
        // 提交前读取的额度有限，这里用较长间隔，避免不必要的请求
        const timer = setInterval(tick, 120000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      if (alerts === null) return null;
      if (alerts.unreachable === true) return null;
      if (alerts.upcoming.length === 0) return null;

      const first = alerts.upcoming[0];
      const more = alerts.upcoming.length - 1;
      return h('div', { className: 'sa-dock' },
        h(Style),
        alerts.overdue > 0 ? h(Pill, { level: 'overdue' }, `逾期 ${alerts.overdue}`) : null,
        h('span', null, `学习台：${first.title}${first.days === null ? '' : first.days < 0 ? `（逾期 ${-first.days} 天）` : first.days === 0 ? '（今天截止）' : `（还有 ${first.days} 天）`}`),
        more > 0 ? h('span', { className: 'sa-muted' }, `另有 ${more} 项临近`) : null,
      );
    }

    // ---------------------------------------------------------------------
    // 右侧栏标签页
    // ---------------------------------------------------------------------

    /**
     * 安全地读取一个可选服务。
     *
     * **这是本插件第一次上线时客户端半边激活失败的直接原因。**
     * cordis 4 的 ctx 代理对「读取未在 inject 里声明过的服务属性」会**抛错**：
     *   `cannot get property "X" without inject`
     * 而不是返回 undefined；抛出会把该插件的 fiber 置为 FAILED，
     * 渲染进程于是报 `web boot: 1 entry did not activate`。
     *
     * `ctx.get(name)` 才是安全的属性读取：服务不存在时返回 undefined，不抛。
     * （官方 client-ui-chat 也是这么用的：`ctx.get("chatFileMentions")?.…`。）
     */
    function safeService(ctx, name) {
      if (ctx === undefined || ctx === null) return undefined;
      if (typeof ctx.get !== 'function') return undefined;
      try {
        return ctx.get(name);
      } catch {
        // 连 get 都不可用的宿主形态：当作服务缺失处理，绝不因此让激活失败
        return undefined;
      }
    }

    /**
     * 右侧栏标签页的身份。
     *
     * 关键契约（已核实 client-ui-sidebar-right 与 ui-schedule 的实现）：
     * `sidebar.right.pane.tab` 槽位的 key 是**标签类型的 id**，不是 kind。
     * 只注册渲染体而不注册标签类型，这一格永远不会被派发——宿主会显示
     * 「nothing can view this」而不是内容。所以必须两步都做：
     *   1. `ctx.sidebarRightTabs.register({ id, kind, priority, title })`
     *   2. 槽位注册用 `key: id`
     * 打开入口是 `ctx.sidebarRight.openTab(kind)`，它在没有活跃会话时会抛错，
     * 因此调用方必须容错。
     */
    const DETAIL_TAB_ID = 'study-assistant/detail';
    const DETAIL_TAB_KIND = 'studyDetail';

    function detailTitle() {
      return TEXT.panel;
    }

    /** 把学习台详情开到右侧栏；服务缺失或无活跃会话时返回 false 而不是抛错。 */
    function openDetailTab(ctx) {
      const api = safeService(ctx, 'sidebarRight');
      if (api === undefined || api === null || typeof api.openTab !== 'function') return false;
      try {
        api.openTab(DETAIL_TAB_KIND);
        return true;
      } catch {
        // 空白会话没有可放置标签的会话上下文
        return false;
      }
    }

    function RightTab() {
      const { status, data, error, refresh } = useStudyData(true);
      if (status === 'loading' && data === null) return h('div', { className: 'sa-root', 'data-sa-panel': true }, h(Style), h('div', { className: 'sa-body sa-muted' }, TEXT.loading));
      if (data === null) return h('div', { className: 'sa-root', 'data-sa-panel': true }, h(Style), h('div', { className: 'sa-body sa-error' }, `${TEXT.error}：${error}`));
      const docs = data.docs ?? {};
      const courses = objectList(docs.courses?.courses);
      const tasks = objectList(docs.tasks?.tasks);
      const gpa = computeGpa(docs.grades);
      const now = new Date();
      const courseIndex = courseNameIndex(docs);
      const active = tasks.filter((task) => task.status !== 'done' && task.status !== 'dropped').sort((a, b) => compareTasksByDue(a, b, now));
      return h('div', { className: 'sa-root', 'data-sa-panel': true },
        h(Style),
        h('div', { className: 'sa-body' },
          h('div', { className: 'sa-card' },
            h('h3', null, '概况'),
            h('div', null, `课程 ${courses.length} 门，未完成任务 ${active.length} 个`),
            h('div', { className: 'sa-muted' }, `加权 GPA：${gpa.gpa === null ? '暂无成绩' : gpa.gpa}`),
          ),
          h('div', { className: 'sa-card' },
            h('h3', null, '最近截止'),
            active.length === 0 ? h('div', { className: 'sa-muted' }, TEXT.noDeadline) : active.slice(0, 8).map((task) => {
              const urgency = deadlineUrgency(task, now);
              const subject = courseNameIn(courseIndex, task.courseId);
              return h('div', { className: 'sa-row', key: task.id },
                h(Pill, { level: urgency.level }, urgencyText(urgency)),
                h('span', { className: 'sa-grow' }, task.title),
                subject === '' ? null : h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, subject),
                h('span', { className: 'sa-muted' }, task.due ?? ''),
              );
            }),
          ),
          h('button', { className: 'sa-btn', onClick: refresh }, '刷新'),
        ),
      );
    }

    function RightTabTitle() {
      return h('span', null, '学习台');
    }

    // ---------------------------------------------------------------------
    // 注册
    // ---------------------------------------------------------------------

    /**
     * 对外暴露的身份与契约描述符。
     *
     * 存在的理由：右侧栏那条契约要求「标签类型的 id」必须等于「渲染体槽位的 key」，
     * 两者是分开写的两个字符串，写错不会报错、只会让这一格永远不被派发。
     * 把它们导出后，测试就能直接断言这种一致性，而不必靠肉眼比对。
     */
    const DESCRIPTORS = {
      panel: PANEL_ID,
      detailTabId: DETAIL_TAB_ID,
      detailTabKind: DETAIL_TAB_KIND,
      detailTabDefinition: { id: DETAIL_TAB_ID, kind: DETAIL_TAB_KIND },
      panelSlots: ['sidebar.panellist', 'main', 'conversation.composer.dock'],
      detailSlots: ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
      openDetailTab,
      /**
       * 内联的纯算法，供测试与 lib/core.js 做**真正的**逐项比对。
       *
       * client.js 是自包含单文件（`require` 只解析模块表，无法相对 import），
       * 所以这些函数是 core.js 的副本，天然有漂移风险。
       * 导出它们之后，tests/client.test.js 才能用同一组输入同时跑两边并断言结果一致
       * —— 否则所谓「防漂移」的测试其实只测了 core.js 自己（本会话修正过这个假测试）。
       */
      internals: {
        parseWeeks,
        isWeekActive,
        currentTeachingWeek,
        deadlineUrgency,
        compareTasksByDue,
        isClosedTask,
        parseTimestamp,
        compareClosedTasksByDoneAtDesc,
        compareDeadlineList,
        scoreToGpa4,
        gradeToGpa4,
        computeGpa,
        parseDay,
        parseDue,
        teachingWeekStart,
        dateOfWeekday,
        formatMonthDay,
        parseQuickDay,
        parseQuickTasks,
        parseAliasInput,
        // 资料页（2026-10-20 夜间）：把面板与取正文的 helper 交给测试，
        // 否则「索引有数据、界面渲染成空白」这种问题只能靠重启宿主以后肉眼发现。
        materialsTab: MaterialsTab,
        knowledgeTab: KnowledgeTab,
        // 今日页（2026-10-22 凌晨）：待复习知识点卡要能单独渲染
        todayTab: TodayTab,
        materialText,
        // 设置页（2026-10-21 夜）：数据备份与生成记录卡，测试要能单独渲染
        settingsTab: SettingsTab,
        // 整个面板（2026-10-23 凌晨）：tools/panel-smoke.mjs 用真实数据把 7 个页签全渲一遍，
        // 在用户看见白屏之前先抓运行时异常（之前 MDX 的 `outlineDoc` TDZ 就是这么漏出去的）
        mainPanel: MainPanel,
        // 知识网络（2026-10-20 夜里）：布局是纯函数，单独交给测试验「坐标单调 / 父子对齐」
        buildKnowledgeLayout,
        MASTERY_LABELS,
        // 复习可用性（2026-10-21）：搜索/筛选、待复习判定与排序、章节分组都是纯函数
        filterKnowledgeNodes,
        isReviewDue,
        knowledgeReviewQueue,
        nextReviewDueAt,
        // 复习回声（2026-10-22 深夜）：近 7 天复习过几个，今日页拿它给一行数字
        countReviewedWithin,
        groupKnowledgeByChapter,
        // 证据交互（2026-10-21 夜）：只读证据统计，供「未验证」徽标与证据状态行复用
        summarizeKnowledgeEvidence,
        findQuestionById,
        // 题目 → 知识点反向索引（2026-10-21 夜第二段）：题目视图据此显示「这题考了哪些点」
        knowledgeByQuestion,
        // 知识点体检（2026-10-23 凌晨）：未归类 / 未分节 / 无证据 / 题证据悬空，工具条给数字
        knowledgeHealth,
        // 详解索引（2026-10-23 夜批0）：知识点 id → 资料分析.json 里的详解条目
        buildAnalysisPoints,
        // 详解覆盖（2026-10-24 傍晚）：工具条「详解 X / Y」与「没详解」筛选共用
        analysisCoverage,
        // 详解渲染（2026-10-26）：正文的轻量 Markdown（行内 + 块级）与插图区块
        analysisInline,
        analysisBlockNodes,
        // 公式排版（2026-10-26 深夜）：LaTeX → 符号（上下标/分式/根号/希腊字母），
        // 保证界面上不再出现 `\Rightarrow` 这种源码
        latexNodes,
        latexRender,
        formulaCard,
        // 章节进度（2026-10-21 夜第三段）：四档分布 + 到熟练数，列表章头用它画小条
        chapterMasteryStats,
        // 知识点树（2026-10-21 夜批2）：学科→章→节→知识点，树视图与「全部展开」用它
        buildKnowledgeTree,
        knowledgeTreeBranchKeys,
        // 大纲树（2026-10-21 深夜批5）：教材目录骨架 + 节点按 section/subsection 挂靠
        buildOutlineTree,
        // 搜索命中高亮（2026-10-22 深夜）：树/列表/讲解共用同一套切法
        splitByQuery,
        // 思维导图（2026-10-23 夜，A 块）：布局纯函数 + 掌握度的符号/颜色编码
        buildMindMap,
        knowledgeTreeCourses,
        subjectTreeState,
        patchSubjectTree,
        MASTERY_STYLE,
        // 讲解通道（2026-10-21 凌晨）：档位键必须与服务端一致，错误码要翻成人话
        EXPLAIN_STYLE_OPTIONS,
        explainNode,
        explainCached,
        explainList,
        explainErrorMessage,
        // 内嵌聊天（2026-10-24）：多轮问答的请求助手与错误翻译
        chatNode,
        chatErrorMessage,
        // 数据备份（2026-10-21 夜）：导出/恢复两个请求助手，测试直接验 URL 与请求头
        exportBackup,
        restoreBackup,
        // 页签界面记忆（2026-10-22 凌晨）：切页签回来时恢复展开/搜索/选中，坏值夹回默认
        readKnowledgeUi,
        resetKnowledgeUi,
        // 资料页界面记忆 + 返回/前进（2026-10-24 傍晚）：用户报「没有上一页、点进去回不来」
        readMaterialsUi,
        resetMaterialsUi,
        navSnapshot,
        navPush,
        navBack,
        navForward,
        navCanBack,
        navCanForward,
        resetNavigation,
      },
    };

    /**
     * 注册一格槽位，并把任何异常降级成一条日志。
     *
     * 为什么必须这样：`ctx.slots.inject` 的回调**在 apply 内同步执行**，
     * 回调里抛出会被原样 rethrow → fiber FAILED → 渲染进程
     * `web boot: 1 entry did not activate` → 桌面端可能反复自愈甚至卸载插件。
     * 教训是「一格坏掉不该让整个插件死掉」：把 5 处注册各自包起来，
     * 任何一处失败只损失那一格界面，其余照常工作，而且日志里能看到是哪一格。
     */
    function safeSlotRegister(ctx, disposers, slotName, options, component) {
      try {
        const dispose = ctx.slots.inject(slotName, () => ctx.slots.register(options, component));
        disposers.push(typeof dispose === 'function' ? dispose : () => {});
      } catch (error) {
        ctx.logger?.warn?.(`[study-assistant] 槽位注册失败，已跳过 ${slotName}：${error?.message ?? error}`);
      }
    }

    return {
      inject: ['slots'],
      DESCRIPTORS,
      apply(ctx) {
        const disposers = [];

        // 1) 侧栏图标：id 与 main 面板的 key 相同，侧栏自动寻址到本面板
        safeSlotRegister(ctx, disposers, 'sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => TEXT.panel,
        }, PanelIcon);

        // 2) 中央主面板（外面套自带错误边界，崩溃就地显示原因而不是留白）
        safeSlotRegister(ctx, disposers, 'main', {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            openDetail: () => openDetailTab(ctx),
          }),
        }, function BoundedMainPanel(props) {
          return h(PanelBoundary, {
            onFailure: (failure) => {
              ctx.logger?.error?.(`[study-assistant] 主面板渲染崩溃：${failure?.stack ?? failure}`);
            },
          }, h(MainPanel, props));
        });

        // 3) 会话输入框下方的 DDL 提醒
        safeSlotRegister(ctx, disposers, 'conversation.composer.dock', {
          name: 'conversation.composer.dock',
          id: 'study-due',
          order: 10,
        }, ComposerDock);

        // 4) 右侧栏标签页：先注册标签类型，再用同 id 注册渲染体与标题。
        //    只做后者的话这一格永远不会被派发（见 DETAIL_TAB_ID 处的说明）。
        //
        // ⚠️ 这里**必须**用 ctx.get('sidebarRightTabs')，不能写 ctx.sidebarRightTabs。
        //    cordis 4 的 ctx 代理对「读取未在 inject 里声明过的服务属性」是**抛错**
        //    （`cannot get property "X" without inject`），不是返回 undefined；
        //    而那会把本插件的 fiber 置为 FAILED —— 渲染进程报
        //    `web boot: 1 entry did not activate / @study-assistant: failed`。
        //    这正是本插件第一次上线时客户端半边激活失败的原因。
        //    ctx.get(name) 是安全的属性读取：不存在时返回 undefined，不抛。
        const tabsApi = safeService(ctx, 'sidebarRightTabs');
        if (tabsApi !== undefined && tabsApi !== null && typeof tabsApi.register === 'function') {
          disposers.push(ctx.effect(
            () => {
              // ⚠️ ctx.effect 的回调是**同步立即执行**的，所以它抛错同样算激活失败。
              //    sidebarRight 的注册表在 id / kind 已被占用时会抛：
              //      `tab type id "..." is already registered`
              //      `tab kind "..." is already registered`
              //    触发条件：同一 renderer 内第二份实例同时激活（HMR、或 loader 重复激活
              //    而前一个 disposer 还没跑）。注释里写"不可能发生"没有意义 —— 包一层
              //    既不痛也不会掩盖问题，反而能把一条自愈循环换成一条日志。
              try {
                return tabsApi.register({
                  id: DETAIL_TAB_ID,
                  kind: DETAIL_TAB_KIND,
                  priority: 'extension',
                  title: detailTitle,
                });
              } catch (error) {
                ctx.logger?.warn?.(`[study-assistant] 右侧栏标签类型注册失败（可能已注册过），已跳过：${error?.message ?? error}`);
                return () => {};
              }
            },
            'study-assistant: detail tab type',
          ));
        } else {
          ctx.logger?.info?.('[study-assistant] 未提供 sidebarRightTabs，右侧栏详情标签页已跳过');
        }

        safeSlotRegister(ctx, disposers, 'sidebar.right.pane.tab', {
          name: 'sidebar.right.pane.tab',
          key: DETAIL_TAB_ID,
        }, RightTab);
        safeSlotRegister(ctx, disposers, 'sidebar.right.pane.tab.title', {
          name: 'sidebar.right.pane.tab.title',
          key: DETAIL_TAB_ID,
        }, RightTabTitle);

        // 6) 自诊断：槽位里的条目渲染崩溃时，渲染器不会抛到 apply 里，而是在
        //    React 树里报错并退化成 `<div data-slot-error="main">` 空壳 ——
        //    界面上看起来就是「点了没反应 / 一片空白」，控制台里才有错误。
        //    这里把崩溃写进页面上的一个固定横幅，不必开 DevTools 也能看到原因。
        //    只在出问题时出现，不参与正常渲染。
        try {
          const diagnose = (slotKey, registration, cause) => {
            try {
              const message = String(cause?.stack ?? cause?.message ?? cause);
              ctx.logger?.error?.(`[study-assistant] 槽位 ${slotKey} 条目渲染崩溃：${message}`);
              if (typeof document === 'undefined') return;
              const id = 'sa-crash-banner';
              const previous = document.getElementById(id);
              if (previous) previous.remove();
              const banner = document.createElement('div');
              banner.id = id;
              banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
                'background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,monospace;' +
                'padding:8px 12px;white-space:pre-wrap;max-height:45vh;overflow:auto;';
              banner.textContent = `[study-assistant] 槽位 ${slotKey} 渲染失败\n` +
                `条目：${String(registration?.options?.id ?? registration?.options?.key ?? '?')}\n` +
                `${message}`;
              (document.body ?? document.documentElement).appendChild(banner);
            } catch {
              // 诊断本身绝不能再抛
            }
          };
          const unsubscribe = ctx.slots.onEntryError?.(diagnose);
          if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
        } catch (error) {
          ctx.logger?.warn?.(`[study-assistant] 自诊断订阅失败，已跳过：${error?.message ?? error}`);
        }

        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // 卸载阶段的清理失败不应影响其它注册
            }
          }
        }, 'study-assistant: slot registrations');
      },
    };
  },
});