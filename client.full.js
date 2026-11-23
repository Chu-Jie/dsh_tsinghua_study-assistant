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
      tabs: { today: '今日', schedule: '课表', deadlines: 'DDL', grades: '成绩', materials: '资料', knowledge: '知识点', records: '记录', settings: '设置' },
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

    /** ISO 时间戳 → `YYYY-MM-DD HH:MM`（学习记录时间线用；解析不了就原样返回）。 */
    function formatStamp(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso ?? '').trim());
      if (m === null) return String(iso ?? '');
      return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
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
     * 打开知识点时上报一次「学习行为」（v2-B 卡，2026-11-20）。
     *
     * 口径（与任务卡 ⑥ 前端一节对应）：
     *   - 只送 `{nodeId}`：次数 +1、首次/最后学习时间都由**服务端**算（不信客户端时钟）；
     *   - **停留时长本卡不报**：第二步才做真计时，这里一个分钟数都不编；
     *   - **两层去重**：这里按 nodeId 做 5 秒节流（一次打开可能触发多次渲染），
     *     服务端再按「同一分钟」去重 —— 两层一起兜，次数不会被刷上去；
     *   - **失败静默**：行为记录是后台数据，失败不该弹错误打断学习；
     *   - 服务端顺手推进了掌握度（`mastery.changed`）时，把缓存作废，
     *     让下一次读取拿到新等级 —— 否则面板还显示「未学」，而磁盘上已经是「学过」。
     */
    const BEHAVIOR_THROTTLE_MS = 5000;
    const behaviorReportedAt = new Map(); // nodeId → 上次上报时刻（ms）
    function reportKnowledgeBehavior(nodeId) {
      const id = typeof nodeId === 'string' ? nodeId.trim() : '';
      if (id === '') return Promise.resolve(null);
      const now = Date.now();
      const last = behaviorReportedAt.get(id);
      if (typeof last === 'number' && now - last < BEHAVIOR_THROTTLE_MS) return Promise.resolve(null);
      behaviorReportedAt.set(id, now);
      return fetch(`${API}/assistant/behavior`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ nodeId: id }),
      })
        .then((response) => response.json().catch(() => null))
        .then((result) => {
          if (result === null || result.ok !== true) return null;
          if (result.mastery !== null && result.mastery !== undefined && result.mastery.changed === true) {
            cache.value = null;
            // 知识网络被服务端改过：丢掉旧 hash，下一次写会用服务端现读的 hash 做乐观并发
            if (typeof result.networkHash === 'string') hashes.knowledgeNetwork = result.networkHash;
            else delete hashes.knowledgeNetwork;
          }
          return result;
        })
        .catch(() => null);
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
          'edge-not-found': '没找到 Edge：自动重连靠它完成。也可以手动重新复制一次 Cookie。',
          'needs-manual-login': '这轮没自动接回来（可能要图形验证码）。点「一键重连」再试，还不行就点「打开登录窗口」手动登一次。',
          'sso-timeout': '登录页迟迟没回到网络学堂，稍后再点「一键重连」，或点「打开登录窗口」手动登一次。',
          'browser-exited': '后台浏览器意外退出了，再点一次「一键重连」。',
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
     * 正文缓存（2026-10-29 晚，用户报障「点章/换讲义整块白闪一下，像整页刷新」）。
     *
     * 以前每次换正文都 `setDetail({status:'loading'})` → 正文组件整个卸载 → 「正在读取…」→
     * 接口回来再重新挂载重排一遍 22KB 的讲义，于是肉眼看到「白一下」。
     * 这里只缓存**成功**的取字结果（本地接口，体量小）：同一份资料来回点（讲义 A/B/C 互切、
     * 章来回点、资料页翻回来）同步出内容，连加载帧都不会有；未命中才真的去取。
     */
    const MATERIAL_TEXT_CACHE = new Map();
    const MATERIAL_CACHE_LIMIT = 12;
    function materialCacheKey(materialPath, page) {
      return `${String(materialPath ?? '')}::${Number.isInteger(page) && page > 0 ? page : ''}`;
    }
    function peekMaterialText(materialPath, page) {
      return MATERIAL_TEXT_CACHE.get(materialCacheKey(materialPath, page));
    }
    async function materialTextCached(materialPath, page) {
      const key = materialCacheKey(materialPath, page);
      const hit = MATERIAL_TEXT_CACHE.get(key);
      if (hit !== undefined) return hit;
      const result = await materialText(materialPath, page);
      if (result?.ok === true) {
        MATERIAL_TEXT_CACHE.set(key, result);
        if (MATERIAL_TEXT_CACHE.size > MATERIAL_CACHE_LIMIT) {
          const oldest = MATERIAL_TEXT_CACHE.keys().next().value;
          MATERIAL_TEXT_CACHE.delete(oldest);
        }
      }
      return result;
    }

    /**
     * 行内格式调色板（2026-11-17 D 卡）：语义键 → 实际 CSS 值。
     *
     * 数据里只存语义键（见 lib/core.js ANNOTATION_STYLE_*），换主题不改数据。
     * 每档都给出「浅色主题下可读」的实色，高光用半透明底叠加正文背景。
     */
    const ANNOTATION_STYLE_PALETTE = {
      color: { red: '#c0392b', blue: '#2c6fd1', green: '#1e8449', black: '#1f2328', gray: '#8a8f98' },
      highlight: {
        yellow: 'rgba(255,214,64,.45)', green: 'rgba(99,211,132,.45)', blue: 'rgba(94,164,255,.42)',
        pink: 'rgba(255,133,192,.42)', orange: 'rgba(255,164,64,.42)',
      },
      underline: { red: '#c0392b', blue: '#2c6fd1', gray: '#8a8f98' },
    };

    /**
     * AI 材料标记类型（2026-11-18 E1）：英文键存数据，中文只做展示层文案。
     * 与 lib/core.js 的 ANNOTATION_MARK_KINDS 白名单一一对应；缺省（无此字段）=普通。
     */
    const ANNOTATION_MARK_KINDS = ['key', 'question', 'review', 'learned'];
    const ANNOTATION_MARK_LABELS = { key: '重点', question: '疑问', review: '待复习', learned: '已学会' };

    /**
     * 类型按钮行（2026-11-18 E1）：普通 / 重点 / 疑问 / 待复习。
     * onPick(kind) —— kind=null 表示「普通」（清除 markKind），其余是白名单键。
     * data-mark-kind 供样式与测试定位；keepOpen 由调用方处理（view 态走 update 不关面板）。
     */
    function markKindButtons(current, onPick, rowClass, btnClass, disabled, labelClass) {
      const items = [{ key: null, label: '普通' }, ...ANNOTATION_MARK_KINDS.map((k) => ({ key: k, label: ANNOTATION_MARK_LABELS[k] }))];
      return h('div', { className: rowClass, 'data-role': 'annotation-mark-kind' },
        h('span', { className: labelClass ?? 'sa-annotation-style-label' }, '类型'),
        ...items.map((item) => {
          const selected = (current ?? null) === item.key;
          return h('button', {
            key: `mk-${item.key ?? 'normal'}`,
            type: 'button',
            className: `${btnClass}${selected ? ' is-selected' : ''}`,
            'data-mark-kind': item.key ?? 'normal',
            'aria-pressed': selected ? 'true' : 'false',
            disabled: disabled === true,
            title: item.key === null ? '普通（无类型标记）' : `标记为${item.label}`,
            onClick: () => onPick(item.key),
          }, item.label);
        }));
    }

    /**
     * AI 材料标记徽标文案（2026-11-18 E1，纯函数）：英文键 → 中文标签；未知/空 → null。
     * 索引条 chip 用它给「疑问/重点/待复习」加一眼可见的前缀。
     */
    function annotationMarkBadge(markKind) {
      return Object.prototype.hasOwnProperty.call(ANNOTATION_MARK_LABELS, markKind) ? ANNOTATION_MARK_LABELS[markKind] : null;
    }

    /**
     * 导出 AI 材料的查询串（2026-11-18 E1，纯函数）：format 固定白名单，file 非空才带上。
     * 与 lib/api.js 的 canonicalAnnotationFile 过滤口径一致（空 file = 全部）。
     */
    function aiExportQuery(format, file) {
      const query = new URLSearchParams({ format: format === 'json' ? 'json' : 'md' });
      if (file !== '' && file !== null && file !== undefined) query.set('file', String(file));
      return query.toString();
    }

    /** 导出结果 → 下载/展示文本（纯函数）：md 用服务端正文，json 用带缩进的整包。 */
    function aiExportText(format, result) {
      if (format === 'json') return JSON.stringify(result?.notes ?? [], null, 2);
      return String(result?.markdown ?? '');
    }

    /**
     * 纯文本另存为文件（2026-11-18 E1）：Blob + createObjectURL + <a download>，与 downloadBackup 同款。
     * 返回 false 表示当前环境不给下载（DSH 内嵌 webview 常见），调用方据此退化为 <pre> + 复制。
     */
    function downloadTextFile(text, filename, mime) {
      try {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * `style` 对象 → React 内联 style 对象（纯函数）。
     * 只认白名单键，非法/缺省一律忽略；返回 `null` 表示无任何可落样式。
     * 注意 `bold`/`italic` 走 fontWeight/fontStyle，其余走颜色。
     */
    function annotationStyleToCss(style) {
      if (style === null || typeof style !== 'object' || Array.isArray(style)) return null;
      const css = {};
      if (typeof style.color === 'string' && ANNOTATION_STYLE_PALETTE.color[style.color]) {
        css.color = ANNOTATION_STYLE_PALETTE.color[style.color];
      }
      if (typeof style.highlight === 'string' && ANNOTATION_STYLE_PALETTE.highlight[style.highlight]) {
        css.backgroundColor = ANNOTATION_STYLE_PALETTE.highlight[style.highlight];
      }
      const decorations = [];
      if (typeof style.underline === 'string' && ANNOTATION_STYLE_PALETTE.underline[style.underline]) {
        decorations.push('underline');
        css.textDecorationColor = ANNOTATION_STYLE_PALETTE.underline[style.underline];
      }
      if (decorations.length > 0) css.textDecorationLine = decorations.join(' ');
      if (style.bold === true) css.fontWeight = 700;
      if (style.italic === true) css.fontStyle = 'italic';
      return Object.keys(css).length === 0 ? null : css;
    }

    /**
     * 批注渲染计划（纯函数，2026-10-30 B1）。
     *
     * 输入「某文件的批注数组 + 当前完整原文」，输出每条批注该以什么状态显示、高亮到哪里。
     * 读接口 `GET /annotations?file=` 只回落盘时的锚点（不重算），所以文件被重新生成后，
     * 「还在不在原位 / 定位到哪 / 是否进待处理」必须由客户端自己判断——口径与后端
     * `lib/annotation-anchor.js` 的 relocateAnchor 完全一致：
     *   1. 快路径：`text.slice(start, start+quote.length) === quote` → found；
     *   2. 全文检索 quote：唯一命中 → found（刷新偏移）；零命中 → lost（不删、不猜）；
     *   3. 多处命中 → 用 prefix/suffix 消歧；消歧成功或仍多义，一律标 fuzzy（取离旧 start 最近）；
     * 这样界面能稳定区分「精确命中 / 多义待确认 / 已失效」，lost 只进待处理列表、绝不自动套别处。
     *
     * @param {Array} notes 某文件的批注数组（每条形如 {id,type,content,anchor:{quote,start,end,prefix,suffix}}）
     * @param {string} text 当前完整原文
     * @returns {Array<{id,type,content,quote,state:'found'|'fuzzy'|'lost',start:number|null,end:number|null}>}
     */
    function buildAnnotationRenderPlan(notes, text) {
      const source = typeof text === 'string' ? text : '';
      const list = Array.isArray(notes) ? notes : [];
      const plan = [];
      for (const note of list) {
        if (note === null || typeof note !== 'object') continue;
        const anchor = note.anchor !== null && typeof note.anchor === 'object' ? note.anchor : {};
        const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
        const oldStart = Number.isInteger(anchor.start) && anchor.start >= 0 ? anchor.start : 0;
        const base = { id: note.id, type: note.type, content: note.content, quote, style: note.style };
        if (quote === '' || source === '') {
          plan.push({ ...base, state: 'lost', start: null, end: null });
          continue;
        }
        // 1) 快路径：偏移可信、逐字相等
        if (source.slice(oldStart, oldStart + quote.length) === quote) {
          plan.push({ ...base, state: 'found', start: oldStart, end: oldStart + quote.length });
          continue;
        }
        // 2) 全文检索 quote 的所有出现位置
        const hits = [];
        let from = 0;
        while (from <= source.length) {
          const at = source.indexOf(quote, from);
          if (at === -1) break;
          hits.push(at);
          from = at + 1;
        }
        if (hits.length === 0) {
          plan.push({ ...base, state: 'lost', start: null, end: null });
          continue;
        }
        if (hits.length === 1) {
          plan.push({ ...base, state: 'found', start: hits[0], end: hits[0] + quote.length });
          continue;
        }
        // 3) prefix / suffix 消歧；消歧后仍是 fuzzy（与后端一致：命中的是「可能位置」，要人确认）
        const prefix = typeof anchor.prefix === 'string' ? anchor.prefix : '';
        const suffix = typeof anchor.suffix === 'string' ? anchor.suffix : '';
        const scoreOf = (at) => {
          let score = 0;
          if (prefix !== '' && source.slice(Math.max(0, at - prefix.length), at) === prefix) score += 2;
          if (suffix !== '' && source.slice(at + quote.length, at + quote.length + suffix.length) === suffix) score += 2;
          return score;
        };
        const scored = hits.map((at) => ({ at, score: scoreOf(at) }));
        const bestScore = Math.max(...scored.map((item) => item.score));
        const top = scored.filter((item) => item.score === bestScore);
        if (bestScore > 0 && top.length === 1) {
          plan.push({ ...base, state: 'fuzzy', start: top[0].at, end: top[0].at + quote.length });
          continue;
        }
        // 4) 仍多义：取离旧偏移最近的一处
        const nearest = hits.reduce((a, b) => (Math.abs(a - oldStart) <= Math.abs(b - oldStart) ? a : b));
        plan.push({ ...base, state: 'fuzzy', start: nearest, end: nearest + quote.length });
      }
      return plan;
    }

    /** 一段文本里 quote 的所有出现位置（纯函数，F2 同句多命中消歧用）。 */
    function annotationQuoteHits(text, quote) {
      const source = String(text ?? '');
      const needle = String(quote ?? '');
      const hits = [];
      if (needle === '') return hits;
      let from = 0;
      while (from <= source.length) {
        const at = source.indexOf(needle, from);
        if (at === -1) break;
        hits.push(at);
        from = at + 1;
      }
      return hits;
    }

    /**
     * 选区 → 批注锚点（2026-10-31 F2，纯函数）。
     *
     * 旧实现（B1）只认 `body.indexOf(quote)`：同一句话在正文里出现两次时永远锚在第一处，
     * 用户在第 3 段加批注、标记却跑到第 1 段。F2 改成按「选区在渲染文本里的序号」对齐：
     * 选区前面出现过几次这句话，就取原文里的第几处。两边出现次数一致 ⇒ found（位置可信）；
     * 不一致（例如插入段落把同一句又抄了一遍）⇒ 降级 fuzzy，并退回按相对位置就近取。
     *
     * @param {object} input `{ body, renderedText, quote, renderedStart }`
     *   body = 服务端原文；renderedText = 当前 DOM 里那份排版后的纯文本；
     *   renderedStart = 选区起点在 renderedText 里的偏移（拿不到就传 -1）。
     * @returns {null|{state:'found'|'fuzzy'|'lost', start:number|null, end:number|null, quote, prefix, suffix}}
     */
    function resolveAnnotationAnchor({ body, renderedText, quote, renderedStart } = {}) {
      const source = String(body ?? '');
      const rendered = String(renderedText ?? '');
      const needle = String(quote ?? '');
      if (needle.trim() === '') return null;
      // 行内格式（2026-11-17 D 卡）：<8 字短选按精确选区出锚点（服务端会据此不扩段），
      // exact 标志随 anchor 一路带到提交参数，保证 2–3 字短词只给这几个字上色，不扩到整段。
      const exact = needle.length < 8;
      const decorate = (start, state) => ({
        state,
        start,
        end: start + needle.length,
        quote: needle,
        prefix: source.slice(Math.max(0, start - 24), start),
        suffix: source.slice(start + needle.length, start + needle.length + 24),
        exact,
      });
      const hits = annotationQuoteHits(source, needle);
      if (hits.length === 0) {
        return { state: 'lost', start: null, end: null, quote: needle, prefix: '', suffix: '' };
      }
      if (hits.length === 1) return decorate(hits[0], 'found');
      if (Number.isInteger(renderedStart) && renderedStart >= 0) {
        const renderedHits = annotationQuoteHits(rendered, needle);
        const ordinal = renderedHits.filter((at) => at < renderedStart).length;
        if (ordinal < hits.length) {
          // 序号对齐：两边出现次数一样多时最可信；渲染文本里句子多了（插入段落）就标待确认
          return decorate(hits[ordinal], renderedHits.length === hits.length ? 'found' : 'fuzzy');
        }
        const ratio = rendered.length === 0 ? 0 : renderedStart / rendered.length;
        const target = Math.round(ratio * source.length);
        const nearest = hits.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
        return decorate(nearest, 'fuzzy');
      }
      // 拿不到 DOM 偏移（旧接口/纯函数直调）：只能取第一处，并如实标成待确认
      return decorate(hits[0], 'fuzzy');
    }

    /**
     * 浮动气泡定位（2026-10-31 F2，纯函数）。
     *
     * 默认贴在选区右上角；上方放不下就翻到选区下方，右侧越界就往左收，最后夹在视口内。
     * 输入输出全是纯数字，DOM 只在调用方取 rect / 视口尺寸，方便直接单测。
     *
     * @param {{top?:number,left?:number,right?:number,bottom?:number,width?:number,height?:number}} rect 选区矩形
     * @param {{width:number,height:number}} viewport 视口尺寸
     * @param {{width:number,height:number}} size 气泡尺寸
     * @returns {{top:number,left:number,placement:'above'|'below'}}
     */
    function placeAnnotationBubble(rect, viewport, size) {
      const box = rect !== null && typeof rect === 'object' ? rect : {};
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {};
      const own = size !== null && typeof size === 'object' ? size : {};
      const margin = 8;
      const gap = 6;
      const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
      const width = Math.max(0, num(own.width));
      const height = Math.max(0, num(own.height));
      const vw = Math.max(0, num(view.width));
      const vh = Math.max(0, num(view.height));
      // 没有 rect（点已有标记、拿不到矩形）时贴着顶部居中，别弹到左上角去
      if (!Number.isFinite(Number(box.top)) && !Number.isFinite(Number(box.left))) {
        const centerLeft = vw > 0 ? Math.max(margin, Math.round((vw - width) / 2)) : margin;
        return { top: margin, left: centerLeft, placement: 'below' };
      }
      const top = num(box.top);
      const left = num(box.left);
      const right = Number.isFinite(Number(box.right)) ? Number(box.right) : left + Math.max(0, num(box.width));
      const bottom = Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : top + Math.max(0, num(box.height));
      let placement = 'above';
      let y = top - height - gap;
      if (y < margin) {
        y = bottom + gap;
        placement = 'below';
      }
      let x = right - width;
      if (x + width > vw - margin) x = vw - margin - width;
      if (x < margin) x = margin;
      if (y + height > vh - margin) y = Math.max(margin, vh - margin - height);
      if (y < margin) y = margin;
      return { top: Math.round(y), left: Math.round(x), placement };
    }

    /** 渲染节点数组的纯文本（2026-10-31 F2，纯函数）：把 h(...) 树里的字符串按顺序接起来。 */
    function annotationRenderedText(nodes) {
      let out = '';
      const walk = (node) => {
        if (typeof node === 'string') { out += node; return; }
        if (typeof node === 'number') { out += String(node); return; }
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node === null || typeof node !== 'object') return;
        // 2026-11-12：真 React 把 children 放在 `props.children` 上，旧替身挂在元素对象上 —— 两边都认
        // （原先只认后者，导致真 React 下渲染文本恒为空、批注一条都画不出来）。
        if (Array.isArray(node.children)) node.children.forEach(walk);
        else if (node.props !== null && typeof node.props === 'object') walk(node.props.children);
      };
      walk(nodes);
      return out;
    }

    /**
     * 批注渲染计划（原文偏移）→ 渲染文本偏移（2026-10-31 F2，纯函数）。
     *
     * 排版器会改写文本（去掉 markdown 记号、拆公式），所以原文偏移不能直接拿来切渲染节点；
     * 这里按 quote 在两边各自的出现序号把位置映射过去。lost 不进正文（只在待处理列表出现）。
     */
    function annotationMarkOffsets(body, renderedText, plan) {
      const source = String(body ?? '');
      const rendered = String(renderedText ?? '');
      const out = [];
      for (const item of (Array.isArray(plan) ? plan : [])) {
        if (item === null || typeof item !== 'object') continue;
        if (item.state !== 'found' && item.state !== 'fuzzy') continue;
        if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) continue;
        const quote = String(item.quote ?? '');
        if (quote === '') continue;
        const renderedHits = annotationQuoteHits(rendered, quote);
        if (renderedHits.length === 0) continue;
        const ordinal = annotationQuoteHits(source, quote).filter((at) => at < item.start).length;
        const at = ordinal < renderedHits.length ? renderedHits[ordinal] : renderedHits[renderedHits.length - 1];
        out.push({ id: item.id, type: item.type, content: item.content, state: item.state, start: at, end: at + quote.length, style: item.style });
      }
      return out;
    }

    /**
     * 把渲染节点按 mark 切段包 `<mark>`（2026-10-31 F2，纯函数）。
     *
     * 只切字符串叶子，元素结构原样保留（所以段落、公式块、列表都不会被拆坏）；
     * 一句话跨段落时，每段各自包一层同 id 的 mark。叠区只留前一段，避免嵌套 mark。
     * `insert` 类型不写进正文：在锚点所在的那个顶层节点后面插一段 `.sa-annotation-insert`。
     */
    function annotationMarkedNodes(nodes, marks, options = {}) {
      const list = Array.isArray(nodes) ? nodes : [];
      const kept = [];
      const sorted = (Array.isArray(marks) ? marks : [])
        .filter((mark) => mark !== null && typeof mark === 'object')
        .filter((mark) => Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.end > mark.start)
        .sort((a, b) => a.start - b.start);
      for (const mark of sorted) {
        if (kept.length > 0 && mark.start < kept[kept.length - 1].end) continue;
        kept.push(mark);
      }
      // `found` 但映射不到的批注也要留在正文里（只是不包 mark），否则「已写盘却看不见」。
      if (kept.length === 0) return list.slice();
      const onMarkClick = typeof options.onMarkClick === 'function' ? options.onMarkClick : null;
      const markNode = (mark, text) => {
        const css = annotationStyleToCss(mark.style);
        // 有显式 highlight 色时，用内联底色盖过 .is-highlight 的默认淡色；否则按类型沿用默认外观
        const hasOwnFill = css !== null && css.backgroundColor !== undefined;
        const openEditor = onMarkClick === null ? undefined : (event) => onMarkClick(mark, event);
        const markEl = h('mark', {
          key: `sa-ann-${String(mark.id ?? '')}-${mark.start}`,
          className: `sa-annotation-mark sa-annotation-${mark.state}${(mark.type === 'highlight' || mark.type === 'note') && !hasOwnFill ? ' is-highlight' : ''}${hasOwnFill ? ' sa-annotation-filled' : ''}`,
          'data-annotation-id': String(mark.id ?? ''),
          'data-annotation-mark-id': String(mark.id ?? ''),
          'data-state': mark.state,
          'data-type': String(mark.type ?? ''),
          title: mark.content ? `批注：${mark.content}` : (mark.state === 'fuzzy' ? '批注（位置可能已变，待确认）' : '批注'),
          onClick: openEditor,
          style: css === null ? undefined : css,
        }, text);
        // 行内格式（2026-11-17 D 卡第二轮反馈）：高亮/批注文字第一个字的左上角挂一个小角标按钮，
        // 点它就地改色/删除（openEditor 打开的就是该条标记的编辑气泡）。lost 定位不到的标记不挂。
        if (openEditor === undefined || mark.state === 'lost') return markEl;
        const badge = h('button', {
          key: `sa-ann-badge-${String(mark.id ?? '')}-${mark.start}`,
          className: 'sa-annotation-badge',
          type: 'button',
          'data-annotation-badge': String(mark.id ?? ''),
          title: '编辑这条高亮/批注（改色或删除）',
          onMouseDown: (event) => { try { event.stopPropagation(); if (typeof event.preventDefault === 'function') event.preventDefault(); } catch (error) { /* 拦不住不影响 */ } },
          onClick: (event) => { try { event.stopPropagation(); } catch (error) { /* ignore */ } openEditor(event); },
        }, '⚙');
        return h('span', {
          key: `sa-ann-wrap-${String(mark.id ?? '')}-${mark.start}`,
          className: 'sa-annotation-hit',
          'data-annotation-id': String(mark.id ?? ''),
        }, markEl, badge);
      };
      // insert 类型不改原文（只在自己那段位置后面长出一块），所以不参与正文切段
      const textMarks = kept.filter((mark) => mark.type !== 'insert');
      const splitText = (text, from) => {
        const pieces = [];
        let at = 0;
        const sortedMarks = textMarks.slice().sort((a, b) => a.start - b.start);
        const starts = sortedMarks.map((mark) => mark.start);
        while (at < text.length) {
          const abs = from + at;
          const cover = sortedMarks.find((mark) => mark.start <= abs && mark.end > abs);
          if (cover === undefined) {
            const nextIndex = starts.findIndex((value) => value > abs);
            const nextStart = nextIndex < 0 ? undefined : starts[nextIndex];
            const stop = nextStart === undefined ? text.length : Math.min(nextStart - from, text.length);
            pieces.push(text.slice(at, Math.max(at + 1, stop)));
            at = Math.max(at + 1, stop);
            continue;
          }
          const stop = Math.min(cover.end - from, text.length);
          pieces.push(markNode(cover, text.slice(at, Math.max(at + 1, stop))));
          at = Math.max(at + 1, stop);
        }
        return pieces;
      };
      const out = [];
      const inserts = [];
      let cursor = 0;
      // 2026-11-18 紧急修（公式区高亮删除后正文重复/公式错乱）：
      // 行内/块级公式是 KaTeX 渲染出来的多层 span，其「渲染文本」与「视觉排布」并不一一对应
      // （上标会重复出现一次基准文本，见用户截图 `e=1.602×10` 出现两遍）。旧实现会钻进这些 span
      // 里按字符偏移切段，切出来的偏移必然错位；一旦高亮覆盖公式、再删掉它，React 重渲染时就
      // 把一段正文拼成了两遍。这里把「公式子树」当成**不可切分的最小单元**：整块原样返回，
      // 只把游标按它的渲染文本长度前进，绝不往公式内部塞 `<mark>`。
      const isFormulaSubtree = (node) => {
        if (node === null || typeof node !== 'object') return false;
        const props = node.props !== null && typeof node.props === 'object' ? node.props : null;
        const cls = props !== null ? String(props.className ?? '') : '';
        if (cls.split(/\s+/).some((name) => name.indexOf('katex') !== -1 || name.indexOf('sa-formula') !== -1)) return true;
        // 行内公式统一用 MATH_INLINE_STYLE 包裹（见 mixedTextNodes :7161）。优先按 style 对象同一性认；
        // 但同一性太脆（别的路径可能用等值的新对象），再按「衬线斜体 + 含 sup/sub」的特征兜底识别。
        const st = props !== null ? props.style : null;
        if (st === MATH_INLINE_STYLE) return true;
        if (st !== null && typeof st === 'object' && st.fontStyle === 'italic' && /Georgia/i.test(String(st.fontFamily ?? ''))) return true;
        return false;
      };
      const walk = (node) => {
        if (isFormulaSubtree(node)) {
          // 2026-11-18 二修：公式子树整块不可切（避免上标被拆坏），但也不能「高亮了却看不见」。
          // 这里的做法：若某条高亮/批注的渲染区间与这棵公式子树有交集，就把**整棵公式子树**
          // 用一层带底色的 <span class="sa-annotation-formula-hit"> 包起来（外加角标按钮），
          // 既能把高亮视觉落在公式块上，又绝不改动公式内部结构。
          const from = cursor;
          const len = annotationRenderedText([node]).length;
          cursor += len;
          const to = cursor;
          const covering = textMarks.find((mark) => mark.start < to && mark.end > from);
          if (covering === undefined) return [node];
          const css = annotationStyleToCss(covering.style) ?? {};
          // 公式块高亮：默认给一层淡黄底（和普通高亮一致），有显式高亮色则用其 background
          const bg = css.backgroundColor !== undefined ? css.backgroundColor : 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent)';
          const style = {
            backgroundColor: bg,
            borderRadius: 'var(--dsw-radius-sm)',
            boxShadow: 'none',
            color: css.color,
            textDecorationLine: css.textDecorationLine,
            textDecorationColor: css.textDecorationColor,
            fontWeight: css.fontWeight,
            fontStyle: css.fontStyle,
          };
          const openEditor2 = onMarkClick === null ? undefined : (event) => onMarkClick(covering, event);
          // 2026-11-18 四修（用户 m02300：公式高亮波及一整行、太宽）：`.sa-formula` 是块级 div（占满整行宽），
          // 把高亮底色/描边直接加在它身上必然横贯整行。这里改成**只把高亮套在公式内容外面的一层
          // inline-block 里**（宽度随内容收缩 = 只框住公式本身），外层 .sa-formula 的块级布局/居中/内边距不变。
          // 之前两版（包 display:inline-block 的 span 替换整块 → 靠左；并 style 到块级 div → 整行）都有副作用，故用本方案。
          const isBlockFormula = String((node.props && node.props.className) || '').split(/\s+/).some((n) => n === 'sa-formula');
          const baseProps = node.props !== null && typeof node.props === 'object' ? node.props : {};
          const baseStyle = baseProps.style !== null && typeof baseProps.style === 'object' ? baseProps.style : {};
          const hlBg = css.backgroundColor !== undefined
            ? css.backgroundColor
            : (isBlockFormula ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)' : 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent)');
          // 内层高亮壳：inline-block 让宽度收缩到公式内容本身；环形描边 + 半透明叠加色表达高亮。
          const innerHitStyle = {
            display: 'inline-block',
            backgroundColor: hlBg,
            borderRadius: 'var(--dsw-radius-sm)',
            boxShadow: 'inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)',
            padding: isBlockFormula ? '2px 6px' : '0 1px',
            color: css.color !== undefined ? css.color : undefined,
            fontWeight: css.fontWeight !== undefined ? css.fontWeight : undefined,
            fontStyle: css.fontStyle !== undefined ? css.fontStyle : undefined,
            textDecorationLine: css.textDecorationLine,
            textDecorationColor: css.textDecorationColor,
            position: 'relative',
            cursor: 'pointer',
          };
          const hitProps = {
            'data-annotation-id': String(covering.id ?? ''),
            'data-annotation-mark-id': String(covering.id ?? ''),
            'data-state': covering.state,
            'data-type': String(covering.type ?? ''),
            title: covering.content ? `批注：${covering.content}` : (baseProps.title ?? '批注'),
            className: 'sa-annotation-formula-hit',
            style: innerHitStyle,
            onClick: openEditor2,
          };
          const baseChildren = baseProps.children;
          const kids = (baseChildren === undefined || baseChildren === null)
            ? []
            : (Array.isArray(baseChildren) ? baseChildren : [baseChildren]);
          if (openEditor2 === undefined) {
            return [h(node.type, baseProps, h('span', { key: `sa-ann-formula-hit-${from}`, ...hitProps }, ...kids))];
          }
          const badge = h('button', {
            key: `sa-ann-formula-badge-${String(covering.id ?? '')}-${from}`,
            className: 'sa-annotation-badge',
            type: 'button',
            'data-annotation-badge': String(covering.id ?? ''),
            title: '编辑这条高亮/批注（改色或删除）',
            onMouseDown: (event) => { try { event.stopPropagation(); if (typeof event.preventDefault === 'function') event.preventDefault(); } catch (error) { /* 拦不住不影响 */ } },
            onClick: (event) => { try { event.stopPropagation(); } catch (error) { /* ignore */ } openEditor2(event); },
          }, '⚙');
          // 外层还是原来的 .sa-formula 块级 div（不改 display/背景/内边距/居中），高亮只在里面那层 inline-block 壳上。
          return [h(node.type, baseProps, h('span', { key: `sa-ann-formula-hit-${from}`, ...hitProps }, ...kids, badge))];
        }
        if (typeof node === 'string') { const from = cursor; cursor += node.length; return splitText(node, from); }
        if (typeof node === 'number') { cursor += String(node).length; return [node]; }
        if (Array.isArray(node)) return node.map(walk).flat(Infinity);
        if (node !== null && typeof node === 'object') {
          // 2026-11-18 真 React 崩溃修复（面板渲染失败 / React #137 args[]=img）：
          // 旧实现无脑给每个元素重设 children，连 `<img>` 这种自闭合标签也被塞进
          // `children:[undefined]`，真 React 直接抛「img is a self-closing tag and must neither
          // have children」。只有当原元素本身确有 children 时才递归重建，否则原样返回。
          const hasLegacyChildren = Array.isArray(node.children) && node.children.length > 0;
          if (hasLegacyChildren) return [{ ...node, children: node.children.map(walk).flat(Infinity) }];
          if (node.props !== null && typeof node.props === 'object') {
            const kids = node.props.children;
            const hasKids = kids !== undefined && kids !== null && !(Array.isArray(kids) && kids.length === 0);
            if (!hasKids) return [node]; // 无 children 的元素（img/input/br 等自闭合）保持原样
            return [{ ...node, props: { ...node.props, children: walk(kids) } }];
          }
        }
        return [node];
      };
      for (const node of list) {
        const before = cursor;
        out.push(...walk(node));
        const afterIndex = out.length - 1;
        for (const mark of kept) {
          if (mark.type !== 'insert') continue;
          if (mark.start < before || mark.start >= cursor) continue;
          if (inserts.some((item) => item.id === mark.id)) continue;
          inserts.push({ afterIndex, id: mark.id, content: mark.content });
        }
      }
      inserts.sort((a, b) => b.afterIndex - a.afterIndex);
      for (const insert of inserts) {
        out.splice(insert.afterIndex + 1, 0, h('div', {
          className: 'sa-annotation-insert',
          key: `sa-ins-${String(insert.id ?? '')}`,
          'data-annotation-id': String(insert.id ?? ''),
        }, String(insert.content ?? '')));
      }
      return out;
    }

    /** create 的提交参数（2026-10-31 F2，纯函数）：一条批注落盘时到底发什么，测试直接断言它。 */
    function annotationCreateItem({ file = '', type = 'note', content = '', anchor = {}, style = undefined, kpText = undefined, markKind = undefined } = {}) {
      const source = anchor !== null && typeof anchor === 'object' ? anchor : {};
      const quote = String(source.quote ?? '');
      const start = Number.isInteger(source.start) ? source.start : -1;
      const end = Number.isInteger(source.end) ? source.end : (start >= 0 ? start + quote.length : -1);
      const item = {
        file: String(file ?? ''),
        type,
        content: String(content ?? ''),
        quote,
        start,
        end,
        prefix: String(source.prefix ?? ''),
        suffix: String(source.suffix ?? ''),
      };
      // 行内格式：短选精确锚点标志（服务端据此不扩段），仅 true 时带出
      if (source.exact === true) item.exact = true;
      // 知识点虚拟文件（kp:<nodeId>）的正文不在磁盘上，随请求附上客户端渲染出的正文，
      // 由服务端对它做 resolveAnchorFromText 的自洽校验（只有这样才锚得上）。
      if (String(file ?? '').startsWith('kp:') && typeof kpText === 'string' && kpText !== '') item.kpText = kpText;
      // 行内格式：只传合法语义键组成的 style 对象（undefined 时不带，旧行为不变）
      if (style !== null && typeof style === 'object' && !Array.isArray(style) && Object.keys(style).length > 0) {
        item.style = { ...style };
      }
      // AI 材料标记类型（E1）：只把合法英文键带到服务端，缺省/普通不写（旧行为不变）
      if (ANNOTATION_MARK_KINDS.includes(markKind)) item.markKind = markKind;
      return item;
    }

    /** 选区起点在渲染文本里的偏移（2026-10-31 F2）：按文本节点累计长度，拿不到返回 -1。 */
    function annotationRenderedOffsetOfRange(root, range) {
      try {
        if (root === null || root === undefined || range === null || range === undefined) return -1;
        const startNode = range.startContainer;
        if (startNode === null || startNode === undefined) return -1;
        let offset = 0;
        let found = false;
        const walk = (node) => {
          if (node === startNode) { found = true; return true; }
          if (node !== null && typeof node === 'object' && node.nodeType === 3) {
            offset += String(node.nodeValue ?? '').length;
            return false;
          }
          const children = node !== null && typeof node === 'object' ? node.childNodes : null;
          if (children !== null && children !== undefined && typeof children.length === 'number') {
            for (let index = 0; index < children.length; index += 1) {
              if (walk(children[index])) return true;
            }
          }
          return false;
        };
        if (!walk(root)) return -1;
        const startOffset = Number.isInteger(range.startOffset) ? range.startOffset : 0;
        return found ? offset + startOffset : -1;
      } catch (error) {
        return -1;
      }
    }

    /**
     * 公式 / 表格区域判定（2026-11-17 D 卡，纯函数把 DOM 遍历换成纯「探测函数」便于单测）。
     *
     * 为什么公式与表格不支持行内标注：渲染文本经 `annotationRenderedText` 拼出来的串与
     * markdown 原文对不上（KaTeX 分式取文本会变形、表格单元格分隔在 DOM 里是独立盒子），
     * 强行按偏移着色必然标偏。这里只做「向上找祖先看有没有公式/表格容器」——
     * 命中就返回 true，调用方据此不弹工具条、给轻提示。
     *
     * @param {object} node DOM 节点（一般是 range.commonAncestorContainer）
     * @returns {boolean}
     */
    function annotationUnsupportedRegion(node) {
      try {
        let current = node;
        let guard = 0;
        while (current !== null && current !== undefined && guard < 200) {
          guard += 1;
          if (typeof current.nodeType === 'number' && current.nodeType === 1) {
            const tag = String(current.tagName ?? '').toUpperCase();
            if (tag === 'MATH' || tag === 'TABLE' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TR' || tag === 'TD' || tag === 'TH') return true;
            const cls = String(current.className ?? '');
            if (cls.indexOf('katex') !== -1 || cls.indexOf('sa-formula') !== -1) return true;
          }
          current = current.parentNode;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    /**
     * 选区锚点解析（2026-11-18 修 user m01508「跨段落选中后左侧不弹编辑/不高亮」）：
     * `window.getSelection().toString()` 在跨块级元素时会**插入 `\n`**，而批注正文
     * `annotationRenderedText` 是把各段字符串直接拼起来的（段间没有换行）——直接拿带 `\n`
     * 的 quote 去锚定必然 0 命中 → state='lost' → 不弹气泡、也落不了高亮。
     * 策略：先用原样 quote 锚；失败且 quote 含换行时，把换行折平再锚一次（折平后的 quote
     * 是正文里真实存在的连续子串，锚点偏移/原文片段都正确）。折平只动 `\r`/`\n`，不动空格，
     * 避免把「a b」和「ab」混成一个锚点。纯函数，测试直接验。
     *
     * @returns {{anchor:object, quote:string}} anchor 可能是 lost（调用方据此不弹气泡）
     */
    function resolveSelectionAnchor(body, renderedText, quote, renderedStart) {
      const raw = String(quote ?? '');
      const original = resolveAnnotationAnchor({ body, renderedText, quote: raw, renderedStart });
      if (original !== null && original.state !== 'lost') return { anchor: original, quote: raw };
      const flat = raw.replace(/[\r\n]+/g, '');
      if (flat === raw || flat.trim() === '') return { anchor: original, quote: raw };
      const flattened = resolveAnnotationAnchor({ body, renderedText, quote: flat, renderedStart });
      if (flattened !== null && flattened.state !== 'lost') return { anchor: flattened, quote: flat };
      return { anchor: original, quote: raw };
    }

    /**
     * 当前选区快照（2026-10-31 F2）：quote + 选区矩形 + 渲染偏移，一次取齐。
     * 选区不在阅读面里、或选中的字在原文里找不到（例如选了插入段落）→ 返回 null，不弹气泡。
     */
    function annotationSelectionSnapshot(rootEl, body, renderedText) {
      try {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (sel === null || sel === undefined) return null;
        const quote = String(sel.toString() || '');
        if (quote.trim() === '') return null;
        let rect = null;
        let renderedStart = -1;
        if (typeof sel.getRangeAt === 'function' && Number(sel.rangeCount) > 0) {
          const range = sel.getRangeAt(0);
          if (range !== null && range !== undefined && typeof range.getBoundingClientRect === 'function') {
            const box = range.getBoundingClientRect();
            if (box !== null && box !== undefined && Number.isFinite(Number(box.top))) {
              const left = Number(box.left) || 0;
              const top = Number(box.top) || 0;
              const width = Number(box.width) || 0;
              const height = Number(box.height) || 0;
              rect = {
                top,
                left,
                width,
                height,
                right: Number.isFinite(Number(box.right)) ? Number(box.right) : left + width,
                bottom: Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : top + height,
              };
            }
          }
          const inside = rootEl !== null && rootEl !== undefined && range !== null && range !== undefined
            && typeof rootEl.contains === 'function' && range.commonAncestorContainer !== null
            && range.commonAncestorContainer !== undefined && rootEl.contains(range.commonAncestorContainer);
          // 行内格式（2026-11-17 D 卡）：公式 / 表格区域不支持细划选，命中就不弹工具条（不崩、不误标）
          if (inside && annotationUnsupportedRegion(range.commonAncestorContainer)) return null;
          if (inside) renderedStart = annotationRenderedOffsetOfRange(rootEl, range);
        }
        const resolved = resolveSelectionAnchor(body, renderedText, quote, renderedStart);
        if (resolved.anchor === null || resolved.anchor.state === 'lost') return null;
        return { quote: resolved.quote, anchor: resolved.anchor, rect };
      } catch (error) {
        return null;
      }
    }

    /**
     * 批注读取（只读，点开某份资料/知识点时调）。
     *
     * `GET /annotations?file=<path>` → `{ ok, key:'annotations', count, notes }`。
     * `file` 用 `资料索引.json` 里那条记录的原样 path（服务端负责白名单与 text 材料过滤）。
     * notes 只回落盘时的锚点，三态由 `buildAnnotationRenderPlan` 在本地按当前原文判断。
     * 结果按 file 缓存：同一份资料来回点不重复发请求；写盘成功后用 invalidateAnnotations 失效。
     */
    const ANNOTATIONS_CACHE = new Map();
    function peekAnnotations(file) {
      return ANNOTATIONS_CACHE.get(String(file ?? ''));
    }
    function invalidateAnnotations(file) {
      if (file === undefined) ANNOTATIONS_CACHE.clear();
      else ANNOTATIONS_CACHE.delete(String(file ?? ''));
    }
    async function annotationsFor(file, options = {}) {
      const key = String(file ?? '');
      if (options.force !== true && ANNOTATIONS_CACHE.has(key)) return ANNOTATIONS_CACHE.get(key);
      const query = new URLSearchParams({ file: key });
      const response = await fetch(`${API}/annotations?${query.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: 'bad-response', notes: [] };
      const normalized = Array.isArray(result.notes) ? result : { ...result, notes: [] };
      if (normalized.ok === true) ANNOTATIONS_CACHE.set(key, normalized);
      return normalized;
    }

    /**
     * 把原文按「位置已确定」的批注切段，命中段包一层 <mark>（2026-10-30 B1 渲染层，纯函数）。
     * 只画 found / fuzzy（fuzzy 标成待确认色）；lost 定位不到，不进正文，只在待处理列表出现。
     */
    function annotationHighlightNodes(text, plan) {
      const source = String(text ?? '');
      const marks = (Array.isArray(plan) ? plan : [])
        .filter((p) => (p.state === 'found' || p.state === 'fuzzy')
          && Number.isInteger(p.start) && Number.isInteger(p.end)
          && p.end > p.start && p.start >= 0 && p.end <= source.length)
        .sort((a, b) => a.start - b.start);
      const kept = [];
      for (const mark of marks) {
        if (kept.length > 0 && mark.start < kept[kept.length - 1].end) continue; // 叠区只留前一段
        kept.push(mark);
      }
      const out = [];
      let cursor = 0;
      kept.forEach((mark, index) => {
        if (mark.start > cursor) out.push(source.slice(cursor, mark.start));
        out.push(h('mark', {
          key: `sa-ann-${index}`,
          className: `sa-annotation-mark sa-annotation-${mark.state}${mark.type === 'highlight' ? ' is-highlight' : ''}`,
          'data-annotation-id': String(mark.id ?? ''),
          'data-state': mark.state,
          title: mark.content ? `批注：${mark.content}` : (mark.state === 'fuzzy' ? '批注（位置可能已变，待确认）' : '批注'),
        }, source.slice(mark.start, mark.end)));
        cursor = mark.end;
      });
      if (cursor < source.length) out.push(source.slice(cursor));
      return out.length > 0 ? out : [source];
    }

    /** 待处理批注（B1）：fuzzy + lost，界面单独列出（纯函数）。 */
    function annotationPendingList(plan, marks) {
      // 2026-11-12：传了 marks 时，`found` 却没落进正文的批注也要列出来（之前会静默消失）。
      const placed = new Set((Array.isArray(marks) ? marks : []).map((mark) => String(mark?.id ?? '')));
      return (Array.isArray(plan) ? plan : []).filter((p) => p.state === 'fuzzy' || p.state === 'lost' || (Array.isArray(marks) && p.state === 'found' && !placed.has(String(p.id ?? ''))));
    }

    /**
     * 「高亮N」自动命名（2026-11-18 用户定）：每份讲义各自从 1 数。
     * 取本文件已存在的「高亮<数字>」里最大的 N 再加 1；没有则从 1 起。
     * 只认纯「高亮+数字」名字，用户自己写的批注（如「高亮这一句」）不会被误数进去。
     */
    function nextHighlightLabel(notes) {
      const list = Array.isArray(notes) ? notes : [];
      let max = 0;
      for (const note of list) {
        if (note === null || typeof note !== 'object') continue;
        const matched = /^高亮(\d+)$/.exec(String(note.content ?? '').trim());
        if (matched !== null) {
          const n = Number(matched[1]);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
      return `高亮${max + 1}`;
    }

    /**
     * 批注交互层（2026-10-31 F2 改版）：Word 式浮动气泡。
     *
     * 用户定的三条口径（2026-10-31 拍板）：
     *   1) 标记落在**正文里**（内联 `<mark>`），下方列表保留，点标记就地改；
     *   2) 同一句话出现多处时按「选区在渲染文本里的序号」对齐（`resolveAnnotationAnchor`）；
     *   3) 保存只留**自动保存**：气泡失焦 / 点完成就提交，不再有显式「保存」按钮。
     *
     * 主路径：正文里拖选 → 选区右上角浮出气泡（批注 / 高亮 / 插入段落）→ 点一个 →
     * 小 popover 里写（插入段落是多行 textarea）→ 失焦即写盘。失败时草稿留在气泡里，
     * 状态栏提示「保存失败：…」，不会把用户写的东西弄丢。
     * 兜底路径：下方工具条那三颗按钮（气泡没弹出来、或者用键盘选字时用）。
     *
     * 正文仍然只读：批注内容只进 `学习台/批注.json`，不改原文一个字。
     */
    function AnnotationLayer({ file = '', text = '', mode = 'preview', nodes = null, onNotesChange = null, dockPanel = false, onDockChange = null } = {}) {
      const body = String(text ?? '');
      const fileKey = String(file ?? '');
      const [notes, setNotes] = useState(() => peekAnnotations(fileKey)?.notes ?? []);
      const [bubble, setBubble] = useState(null);
      const [status, setStatus] = useState('');
      const [saving, setSaving] = useState(false);
      const [history, setHistory] = useState([]);
      const rootRef = useRef(null);
      // 同一个气泡「失焦 + 点完成」会连着提交两次；用 ref 记住上一次提交过的气泡，别重复写盘
      const submittedRef = useRef('');
      // 2026-11-17 D 卡第二轮：气泡内按下（按钮/色块）时置 true，让这一轮 selectionchange 别把气泡拆了。
      const suppressBubbleCloseRef = useRef(false);
      useEffect(() => {
        if (fileKey === '') return undefined;
        let alive = true;
        annotationsFor(fileKey).then((result) => {
          if (alive && result && result.ok === true) setNotes(result.notes);
        });
        return () => { alive = false; };
      }, [fileKey]);
      // 行内格式（2026-11-17 D 卡）：把当前文件的批注列表同步给外层（学习模式的 marks 插槽要列出来）。
      // 单独一个 effect 报告，避免把 onNotesChange 塞进上面的加载 effect 依赖里反复触发。
      useEffect(() => {
        if (typeof onNotesChange === 'function') onNotesChange(fileKey, notes);
      }, [fileKey, notes, onNotesChange]);
      // 气泡的关闭策略（2026-11-17 D 卡第二轮重写，彻底去掉「点按钮被拆气泡」）：
      //   旧版靠 selectionchange —— 选区一空就 setBubble(null)。可是鼠标按下气泡按钮会先清掉正文选区，
      //   于是 selectonchange 把气泡拆了、click 到不了，表现为「点什么都没反应、连选项框都不消失」。
      //   现改为：唯一关闭途径是 ① 显式 ×/Esc ② 动作完成后代码自己 closeBubble()
      //   ③ 在气泡外部按下鼠标（下方 mousedown 监听，判断 e.target 不在 [data-annotation-guard] 内才关）。
      //   不再监听 selectionchange，就不可能因为选区变化被误拆。
      useEffect(() => {
        try {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
          const onDown = (event) => {
            try {
              const target = event !== null && event !== undefined ? event.target : null;
              if (target !== null && target !== undefined && typeof target.closest === 'function'
                && target.closest('[data-annotation-guard]') !== null) { return; } // 点在气泡/面板里 → 不关
              // 点在正文选区上（要重新划选）也不急着关——由 mouseup 的 openSelectionBubble 重开
              if (target !== null && target !== undefined && typeof target.closest === 'function'
                && target.closest('.sa-reading, .sa-reading-pre, .sa-annotation-layer') !== null) return;
              setBubble(null);
            } catch (error) { /* 判断不了就不关 */ }
          };
          document.addEventListener('mousedown', onDown, true);
          return () => { if (typeof document.removeEventListener === 'function') document.removeEventListener('mousedown', onDown, true); };
        } catch (error) {
          return undefined;
        }
      }, []);

      const plan = buildAnnotationRenderPlan(notes, body);
      const previewNodes = Array.isArray(nodes) && nodes.length > 0 ? nodes : materialPreviewNodes(body, 'mat-ann');
      const renderedText = annotationRenderedText(previewNodes);
      const marks = annotationMarkOffsets(body, renderedText, plan);
      // 2026-11-18 用户定：学习模式把「选中后的选项」整合进左侧栏，不再弹浮动气泡。
      // dockPanel=true 时不渲染 renderBubble()，而是把当前气泡状态 + 动作回传给外层（KnowledgeTab 的竖条）。
      // 动作闭包都定义在本组件里（函数声明会提升），外层只负责渲染按钮、调用这些函数，逻辑单点不重复。
      useEffect(() => {
        if (typeof onDockChange !== 'function') return;
        onDockChange(fileKey, {
          bubble,
          saving,
          status,
          size: bubble === null || bubble === undefined ? { width: 0, height: 0 } : (bubble.mode === 'menu' ? { width: 190, height: 200 } : (bubble.type === 'insert' ? { width: 190, height: 150 } : { width: 190, height: 120 })),
          actions: {
            quickHighlight: applyQuickHighlight,
            compose: (type) => startCompose(type),
            inlineStyle: (patch) => applyInlineStyle(patch),
            // 2026-11-18 十三轮：菜单态点色块只改预览（累积 pendingStyle），点「完成」才落库
            queueInlineStyle: (patch) => queueInlineStyle(patch),
            commitInlineStyle: () => commitInlineStyle(),
            viewStyle: (style) => submitViewStyle(bubble, style),
            // 2026-11-18（q1）：再编辑已有标记时也要能改 字色/下划线/粗/斜 —— 以当前 style 为底做 toggle 合并再提交。
            viewInline: (patch) => {
              viewInlineApply(bubble, patch);
            },
            // 2026-11-18 十一轮：点「完成」显式收尾（连续编辑期间面板常驻，只有它/删除/× 会关）
            // 2026-11-18 E1：类型标记（普通/重点/疑问/待复习）。view 走 update 不关面板；compose 先记在本地，随「完成」落库。
            viewMarkKind: (kind) => submitMarkKind(bubble, kind),
            setMarkKind: (kind) => setBubble((prev) => (prev === null || prev === undefined ? prev : { ...prev, markKind: (kind === null || kind === undefined) ? undefined : kind })),
            viewDone: () => closeBubble(),
            // 2026-11-18 十三轮：「无色」——去掉 highlight 维度、其余(字色/下划线/粗斜)保留，连续编辑不关面板
            viewClear: () => {
              const base = bubble !== null && bubble !== undefined && bubble.style !== null && typeof bubble.style === 'object' ? { ...bubble.style } : {};
              delete base.highlight;
              submitViewStyle(bubble, Object.keys(base).length === 0 ? {} : base, { replace: true, keepOpen: true });
            },
            setDraft: (value) => setBubble((prev) => (prev === null || prev === undefined ? prev : { ...prev, draft: value })),
            setStyle: (style) => setBubble((prev) => (prev === null || prev === undefined ? prev : { ...prev, style: { ...(prev.style ?? {}), ...style } })),
            commit: () => submitBubble(bubble),
            cancel: () => closeBubble(),
            removeNote: (id) => removeNote(id),
          },
        });
      }, [fileKey, bubble, saving, status, onDockChange]);

      // 2026-11-12：把 marks 传进去 —— `found` 但正文里没落成 `<mark>` 的批注不能静默消失。
      const pending = annotationPendingList(plan, marks);
      const placedIds = new Set(marks.map((item) => String(item.id ?? '')));

      async function refreshNotes() {
        invalidateAnnotations(fileKey);
        const refreshed = await annotationsFor(fileKey, { force: true });
        if (refreshed && refreshed.ok === true) setNotes(refreshed.notes);
      }
      function pushHistory(action) {
        setHistory((prev) => prev.concat([action]).slice(-20));
      }
      function rememberBubbleKey(next) {
        submittedRef.current = '';
        setBubble(next);
      }

      /** 正文里拖选 → 弹出「批注 / 高亮 / 插入段落」气泡。 */
      function openSelectionBubble() {
        const snapshot = annotationSelectionSnapshot(rootRef.current, body, renderedText);
        if (snapshot === null) { return; }
        rememberBubbleKey({ mode: 'menu', anchor: snapshot.anchor, rect: snapshot.rect });
      }
      function surfaceKeyUp(event) {
        const key = event !== null && event !== undefined ? String(event.key ?? '') : '';
        if (key === 'Escape') { setBubble(null); setStatus(''); return; }
        if (key === 'Shift' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') openSelectionBubble();
      }
      function startCompose(type) {
        const current = bubble;
        if (current === null || current === undefined || current.anchor === undefined) {
          setStatus('先在正文里选中一段文字');
          return;
        }
        rememberBubbleKey({ mode: 'compose', anchor: current.anchor, rect: current.rect, type, draft: '' });
      }
      // 行内格式（2026-11-17 D 卡第二轮）：选区内点按钮/色块直接把格式落成一条
      // type='note'（有文字批注时）或 type='highlight'（纯色/线/粗斜）的标记。
      // 与旧版差异：不再 setBubble(null) 后再等 selectionchange；这里显式关气泡即可。
      // 2026-11-18 十三轮（用户 m02352「第一次选中时只能点一次」）：菜单（首次选中）态下，点色块/B/I
      // 不再「点了就建一条并关面板」，而是只累积到 bubble.pendingStyle（同值再点取消），用户可把
      // 高光+字色+下划线+粗/斜 叠加好后点「完成」一次性落库。见 commitInlineStyle。
      function queueInlineStyle(patch) {
        setBubble((prev) => {
          if (prev === null || prev === undefined) return prev;
          const next = { ...(prev.pendingStyle ?? {}) };
          for (const key of Object.keys(patch)) {
            const value = patch[key];
            if (key === 'bold' || key === 'italic') {
              if (next[key] === value) delete next[key]; else next[key] = value;
            } else if (next[key] === value) {
              delete next[key];
            } else {
              next[key] = value;
            }
          }
          return { ...prev, pendingStyle: next };
        });
      }
      // 菜单态「完成」：把累积的 pendingStyle 落成一条批注（内容用高亮N，不把选中原文当批注），落库后关面板。
      async function commitInlineStyle() {
        const current = bubble;
        if (current === null || current === undefined || current.anchor === undefined) {
          setStatus('先在正文里选中一段文字');
          return;
        }
        const anchor = current.anchor;
        if (String(anchor.quote ?? '').trim() === '') { setStatus('选中的文字为空，无法标注'); return; }
        const style = { ...(current.pendingStyle ?? {}) };
        const content = nextHighlightLabel(notes);
        const item = annotationCreateItem({ file: fileKey, type: 'highlight', content, anchor, style: Object.keys(style).length === 0 ? undefined : style, kpText: fileKey.startsWith('kp:') ? renderedText : undefined });
        setSaving(true);
        setStatus('正在保存…');
        try {
          const result = await mutate('annotations', 'create', { item });
          const createdId = result !== null && result !== undefined && result.item !== null && result.item !== undefined
            ? String(result.item.id ?? '')
            : '';
          pushHistory({ kind: 'create', id: createdId, markKind: item.markKind });
          closeBubble();
          setStatus('已加行内格式（已保存）');
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      async function applyInlineStyle(patch, baseType) {
        const current = bubble;
        if (current === null || current === undefined || current.anchor === undefined) {
          setStatus('先在正文里选中一段文字');
          return;
        }
        const anchor = current.anchor;
        const prev = current.pendingStyle ?? {};
        const next = { ...prev };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          // 与当前同值 → 视为取消该维度（toggle）
          if (key === 'bold' || key === 'italic') {
            if (next[key] === value) delete next[key]; else next[key] = value;
          } else if (next[key] === value) {
            delete next[key];
          } else {
            next[key] = value;
          }
        }
        const content = String(current.draft ?? '').trim() || String(anchor.quote ?? '').trim();
        if (content === '') { setStatus('选中的文字为空，无法标注'); return; }
        const type = baseType ?? (content !== String(anchor.quote ?? '').trim() ? 'note' : 'highlight');
        const item = annotationCreateItem({ file: fileKey, type, content, anchor, style: next, kpText: fileKey.startsWith('kp:') ? renderedText : undefined });
        setSaving(true);
        setStatus('正在保存…');
        try {
          const result = await mutate('annotations', 'create', { item });
          const createdId = result !== null && result !== undefined && result.item !== null && result.item !== undefined
            ? String(result.item.id ?? '')
            : '';
          pushHistory({ kind: 'create', id: createdId, markKind: item.markKind });
          closeBubble();
          setStatus('已加行内格式（已保存）');
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      // 「高亮」按钮：一键默认淡黄，不弹输入框（用户 2026-11-17 拍板）
      // 2026-11-18 用户定：不再把选中原文当批注内容，直接命名「高亮N」（每份讲义各自从 1 数）。
      async function applyQuickHighlight() {
        const current = bubble;
        if (current === null || current === undefined || current.anchor === undefined) {
          setStatus('先在正文里选中一段文字');
          return;
        }
        const anchor = current.anchor;
        if (String(anchor.quote ?? '').trim() === '') { setStatus('选中的文字为空，无法标注'); return; }
        const content = nextHighlightLabel(notes);
        const item = annotationCreateItem({ file: fileKey, type: 'highlight', content, anchor, style: { highlight: 'yellow' }, kpText: fileKey.startsWith('kp:') ? renderedText : undefined });
        setSaving(true);
        setStatus('正在保存…');
        try {
          const result = await mutate('annotations', 'create', { item });
          const createdId = result !== null && result !== undefined && result.item !== null && result.item !== undefined
            ? String(result.item.id ?? '')
            : '';
          pushHistory({ kind: 'create', id: createdId, markKind: item.markKind });
          closeBubble();
          setStatus('已加高亮（淡黄）');
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      /** 点已有标记 → 就地查看/编辑/删除。 */
      function openNoteBubble(mark, event) {
        const id = String(mark !== null && mark !== undefined ? mark.id ?? '' : '');
        if (id === '') return;
        if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
        let rect = null;
        try {
          const target = event !== null && event !== undefined ? event.currentTarget : null;
          if (target !== null && target !== undefined && typeof target.getBoundingClientRect === 'function') {
            const box = target.getBoundingClientRect();
            if (box !== null && box !== undefined) {
              const left = Number(box.left) || 0;
              const top = Number(box.top) || 0;
              const width = Number(box.width) || 0;
              const height = Number(box.height) || 0;
              rect = {
                top,
                left,
                width,
                height,
                right: Number.isFinite(Number(box.right)) ? Number(box.right) : left + width,
                bottom: Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : top + height,
              };
            }
          }
        } catch (error) {
          rect = null;
        }
        const note = notes.find((item) => item !== null && typeof item === 'object' && String(item.id) === id) ?? null;
        const content = note === null ? String(mark.content ?? '') : String(note.content ?? '');
        rememberBubbleKey({
          mode: 'view',
          id,
          type: note === null ? mark.type : note.type,
          content,
          draft: content,
          style: note !== null && note.style !== undefined ? note.style : (mark.style !== undefined ? mark.style : undefined),
          markKind: note !== null && note.markKind !== undefined ? note.markKind : (mark.markKind !== undefined ? mark.markKind : undefined),
          state: String(mark.state ?? 'found'),
          rect,
        });
      }
      function fallbackEntry(type) {
        const snapshot = annotationSelectionSnapshot(rootRef.current, body, renderedText);
        if (snapshot === null) { setStatus('先在正文里选中一段文字，再点这里'); return; }
        rememberBubbleKey({ mode: 'compose', anchor: snapshot.anchor, rect: snapshot.rect, type, draft: '' });
      }
      function closeBubble() {
        submittedRef.current = '';
        setBubble(null);
        setStatus('');
      }

      async function submitCreate(current) {
        const anchor = current.anchor ?? {};
        const type = current.type ?? 'note';
        const raw = String(current.draft ?? '');
        // 2026-11-17 D 卡第二轮：高亮/批注都允许留空 —— 留空时用选中原文当锚点文字（纯色高光/纯色批注）。
        const content = raw.trim() !== '' ? raw.trim() : String(anchor.quote ?? '');
        if (content === '') { setStatus('选中的文字为空，无法标注'); return; }
        const style = (current.style !== null && typeof current.style === 'object') ? current.style : undefined;
        const item = annotationCreateItem({ file: fileKey, type, content, anchor, style, markKind: current.markKind, kpText: fileKey.startsWith('kp:') ? renderedText : undefined });
        setSaving(true);
        setStatus('正在保存…');
        try {
          const result = await mutate('annotations', 'create', { item });
          const createdId = result !== null && result !== undefined && result.item !== null && result.item !== undefined
            ? String(result.item.id ?? '')
            : '';
          pushHistory({ kind: 'create', id: createdId, markKind: item.markKind });
          setBubble(null);
          setStatus(type === 'insert' ? '已插入一段（已保存）' : (type === 'highlight' ? '已加高亮（已保存）' : '已加批注（已保存）'));
          await refreshNotes();
        } catch (error) {
          // 失败不丢草稿：气泡留着、内容还在，用户改完可以直接再失焦一次
          setStatus(`保存失败：${error.message ?? error}`);
          setBubble(current);
        } finally {
          setSaving(false);
        }
      }
      // 点角标改已有标记的颜色（2026-11-17 D 卡第二轮）：style=null 表示清掉颜色，内容不动。
      // 2026-11-18（q1）：options.replace=true 时 style 视为「完整的最终 style」，不再与旧 style 合并
      //   （用于字色/下划线/粗斜的 toggle —— 取消某维度时要真删掉，不能靠合并留下旧值）。
      // 2026-11-18 十一轮（m02078「每次编辑只能点一次」）：改成**连续编辑**——
      //   options.keepOpen=true 时保存成功后不关面板，而是把最新 style 写回 bubble（并把 bubble.style 更新为
      //   已落库的最终样式），这样用户能接着点下一个色块 / B / I，直到点「完成」或删除或 ×。
      async function submitViewStyle(current, style, options) {
        if (current === null || current === undefined) return;
        const id = String(current.id ?? '');
        if (id === '') return;
        const replace = options !== null && options !== undefined && options.replace === true;
        const keepOpen = options !== null && options !== undefined && options.keepOpen === true;
        // 计算实际要落库的最终 style（replace 时用传入的完整 style，否则与旧 style 合并）
        let finalStyle;
        if (style === null) finalStyle = null;
        else if (replace) finalStyle = Object.keys(style).length === 0 ? null : { ...style };
        else finalStyle = { ...(current.style ?? {}), ...style };
        setSaving(true);
        setStatus('正在保存…');
        try {
          const item = { content: String(current.content ?? current.draft ?? '') };
          item.style = finalStyle;
          await mutate('annotations', 'update', { id, item });
          pushHistory({ kind: 'update', id, before: String(current.content ?? '') });
          if (keepOpen) {
            // 连续编辑：面板留着，bubble.style 换成刚落库的最终样式，供下一次 toggle 以此为底
            submittedRef.current = '';
            setBubble((prev) => (prev === null || prev === undefined ? prev : { ...prev, style: finalStyle === null ? undefined : { ...finalStyle } }));
            setStatus('已改颜色');
          } else {
            closeBubble();
            setStatus('已改颜色');
          }
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      // AI 材料标记类型（E1）：view 态点「普通/重点/疑问/待复习」→ 更新 note.markKind，不关面板。
      // markKind=null 走服务端清除；合法键写入；label 只做展示。
      async function submitMarkKind(current, markKind) {
        if (current === null || current === undefined) return;
        const id = String(current.id ?? '');
        if (id === '') return;
        const value = ANNOTATION_MARK_KINDS.includes(markKind) ? markKind : null;
        setSaving(true);
        setStatus('正在保存…');
        try {
          await mutate('annotations', 'update', { id, item: { markKind: value } });
          pushHistory({ kind: 'update', id, before: String(current.content ?? '') });
          submittedRef.current = '';
          setBubble((prev) => (prev === null || prev === undefined ? prev : { ...prev, markKind: value === null ? undefined : value }));
          setStatus(value === null ? '已设为普通' : `已标记为${ANNOTATION_MARK_LABELS[value]}`);
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      // 以当前 bubble.style 为底做 toggle（同值删、粗斜取反），得到完整最终 style 后连续保存。
      function viewInlineApply(cur, patch) {
        if (cur === null || cur === undefined) return;
        const base = cur.style !== null && typeof cur.style === 'object' ? { ...cur.style } : {};
        const next = { ...base };
        for (const k of Object.keys(patch)) {
          const v = patch[k];
          if (k === 'bold' || k === 'italic') {
            if (next[k] === v) delete next[k]; else next[k] = v;
          } else if (next[k] === v) {
            delete next[k];
          } else {
            next[k] = v;
          }
        }
        submitViewStyle(cur, next, { replace: true, keepOpen: true });
      }
      async function submitUpdate(current) {        const content = String(current.draft ?? '').trim();
        // 2026-11-18 十一轮：允许留空 —— 留空时保留原内容（高亮N 或原批注），不报「不能为空」，只是不改文字。
        if (content === '' && String(current.content ?? '').trim() === '') { closeBubble(); return; }
        if (content === '') { closeBubble(); return; }
        setSaving(true);
        setStatus('正在保存…');
        try {
          await mutate('annotations', 'update', { id: current.id, item: { content } });
          pushHistory({ kind: 'update', id: current.id, before: String(current.content ?? '') });
          setBubble(null);
          setStatus('已保存');
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
          setBubble(current);
        } finally {
          setSaving(false);
        }
      }
      async function removeNote(id) {
        const key = String(id ?? '');
        if (key === '') return;
        const target = notes.find((item) => item !== null && typeof item === 'object' && String(item.id) === key) ?? null;
        setSaving(true);
        setStatus('正在保存…');
        try {
          await mutate('annotations', 'delete', { id: key });
          pushHistory({
            kind: 'delete',
            id: key,
            type: target === null ? 'note' : target.type,
            content: target === null ? '' : String(target.content ?? ''),
            anchor: target === null ? {} : { ...(target.anchor ?? {}) },
            markKind: target === null ? undefined : target.markKind,
          });
          setBubble(null);
          setStatus('已删除');
          await refreshNotes();
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`);
        } finally {
          setSaving(false);
        }
      }
      async function undo() {
        if (history.length === 0) { setStatus('没有可撤销的操作'); return; }
        const action = history[history.length - 1];
        setHistory((prev) => prev.slice(0, -1));
        try {
          if (action.kind === 'create') {
            if (action.id !== '') await mutate('annotations', 'delete', { id: action.id });
          } else if (action.kind === 'update') {
            await mutate('annotations', 'update', { id: action.id, item: { content: String(action.before ?? '') } });
          } else if (action.kind === 'delete') {
            const item = annotationCreateItem({ file: fileKey, type: action.type, content: action.content, anchor: action.anchor, markKind: action.markKind, kpText: fileKey.startsWith('kp:') ? renderedText : undefined });
            await mutate('annotations', 'create', { item });
          }
          setStatus('已撤销一步');
          await refreshNotes();
        } catch (error) {
          setStatus(`撤销失败：${error.message ?? error}`);
        }
      }
      function submitBubble(current) {
        if (current === null || current === undefined) return;
        if (current.mode !== 'compose' && current.mode !== 'view') return;
        const key = `${current.mode}|${String(current.id ?? '')}|${String(current.type ?? '')}|${String(current.draft ?? '').length}`;
        if (submittedRef.current === key) return;
        submittedRef.current = key;
        if (current.mode === 'compose') { submitCreate(current); return; }
        // 只是点开看一眼、没动内容 → 不写盘（否则每次点标记都会多一条 update）
        if (String(current.draft ?? '').trim() === String(current.content ?? '').trim()) { closeBubble(); return; }
        submitUpdate(current);
      }
      function stopBubbleMouseDown(event) {
        try {
          // 气泡内任何按下都先打标：这一轮 selectionchange 不要拆气泡（见上面的监听）。
          suppressBubbleCloseRef.current = true;
          const tag = event !== null && event !== undefined && event.target !== null && event.target !== undefined
            ? String(event.target.tagName ?? '').toUpperCase()
            : '';
          // 输入框自己要能获得焦点，不能拦 mousedown；其余按钮拦一下，免得点一下选区就没了
          if (tag === 'TEXTAREA' || tag === 'INPUT') return;
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        } catch (error) { /* 拦不住也不影响功能 */ }
      }

      const surface = mode === 'raw'
        ? h('pre', {
          className: 'sa-reading-pre',
          style: MATERIAL_PRE_STYLE,
          ref: rootRef,
          onMouseUp: openSelectionBubble,
          onKeyUp: surfaceKeyUp,
        }, ...annotationHighlightNodes(body, plan))
        : h('div', {
          className: 'sa-reading',
          style: MATERIAL_READING_STYLE,
          ref: rootRef,
          onMouseUp: openSelectionBubble,
          onKeyUp: surfaceKeyUp,
        }, ...annotationMarkedNodes(previewNodes, marks, { onMarkClick: openNoteBubble }));

      function renderBubble() {
        if (bubble === null || bubble === undefined) return null;
        const viewport = typeof window !== 'undefined' && Number(window.innerWidth) > 0
          ? { width: Number(window.innerWidth), height: Number(window.innerHeight) || 0 }
          : { width: 0, height: 0 };
        const size = bubble.mode === 'menu'
          ? { width: 320, height: 132 }
          : (bubble.type === 'insert' ? { width: 330, height: 150 } : { width: 330, height: 108 });
        const placed = placeAnnotationBubble(bubble.rect, viewport, size);
        const style = viewport.width > 0 ? { top: `${placed.top}px`, left: `${placed.left}px` } : { top: '12px', left: '12px' };
        const head = (label) => h('span', { className: 'sa-annotation-bubble-title' }, label);
        const input = (placeholder) => h('textarea', {
          className: 'sa-annotation-bubble-input',
          'data-role': 'annotation-draft',
          placeholder,
          rows: bubble.type === 'insert' ? 4 : 2,
          value: String(bubble.draft ?? ''),
          onChange: (event) => {
            const value = event !== null && event !== undefined && event.target !== null && event.target !== undefined
              ? String(event.target.value ?? '')
              : '';
            submittedRef.current = '';
            setBubble({ ...bubble, draft: value });
          },
          onBlur: () => submitBubble(bubble),
        });
        if (bubble.mode === 'menu') {
          const button = (type, label, title, onClick) => h('button', {
            className: 'sa-btn sa-annotation-bubble-entry',
            key: `bb-${type}`,
            'data-type': type,
            title,
            onClick,
          }, label);
          // 行内格式工具条（2026-11-17 D 卡）：2026-11-18 十三轮改为「先预览累积、点完成才落库」——
          //   点色块/B/I 只更新 bubble.pendingStyle（同值再点取消），可叠加好再点「完成」一次性创建。
          const pendF = bubble.pendingStyle !== null && bubble.pendingStyle !== undefined && typeof bubble.pendingStyle === 'object' ? bubble.pendingStyle : {};
          const swatch = (kind, value, label, title) => {
            // 2026-11-18（同左侧栏修复）：按 kind 取正确颜色当色块底色，highlight→backgroundColor、
            //   color→color、underline→textDecorationColor。旧代码一律 ?.backgroundColor，字色/下划线取不到 → 全白。
            const css = annotationStyleToCss(kind === 'highlight' ? { highlight: value } : (kind === 'underline' ? { underline: value } : { color: value }));
            const chipColor = css === null ? undefined : (kind === 'highlight' ? css.backgroundColor : (kind === 'underline' ? css.textDecorationColor : css.color));
            const selected = pendF[kind] === value;
            return h('button', {
              className: `sa-btn sa-annotation-swatch sa-annotation-swatch-${kind}${selected ? ' is-selected' : ''}`,
              key: `sw-${kind}-${value}`,
              'data-kind': kind,
              'data-value': value,
              'aria-pressed': selected ? 'true' : 'false',
              title,
              disabled: saving,
              style: { backgroundColor: chipColor ?? undefined },
              onClick: () => queueInlineStyle({ [kind]: value }),
            }, label);
          };
          const flagBtn = (flag, glyph, title) => h('button', {
            className: `sa-btn sa-annotation-flag${pendF[flag] === true ? ' is-selected' : ''}`,
            'data-flag': flag,
            'aria-pressed': pendF[flag] === true ? 'true' : 'false',
            title,
            disabled: saving,
            onClick: () => queueInlineStyle({ [flag]: true }),
          }, glyph);
          const swatches = (kind, values, titles) => h('div', { className: 'sa-annotation-swatches', 'data-kind': kind },
            ...values.map((value) => swatch(kind, value, '', titles[value] ?? value)));
          return h('div', {
            className: 'sa-annotation-bubble',
            'data-mode': 'menu',
            'data-annotation-guard': '1',
            style,
            onMouseDown: stopBubbleMouseDown,
          },
          h('div', { className: 'sa-annotation-bubble-row' },
            // 高亮：一键默认淡黄，不弹输入框（用户 2026-11-17 拍板）
            button('highlight', '高亮', '把选中的文字标成淡黄高亮（不弹输入框；要换色用下面色块）', applyQuickHighlight),
            // 批注：可打字、可选色、允许留空（留空＝纯色高光）
            button('note', '批注', '给选中的文字加一条可打字的彩色批注（可留空＝纯色高光）', () => startCompose('note')),
            button('insert', '插入段落', '在这段文字后面插一段自己的话', () => startCompose('insert'))),
          h('div', { className: 'sa-annotation-bubble-row sa-annotation-style-row' },
            h('span', { className: 'sa-annotation-style-label' }, '高光'),
            swatches('highlight', ['yellow', 'green', 'blue', 'pink', 'orange'], { yellow: '黄', green: '绿', blue: '蓝', pink: '粉', orange: '橙' }),
            h('span', { className: 'sa-annotation-style-label' }, '字色'),
            swatches('color', ['red', 'blue', 'green', 'black', 'gray'], { red: '红', blue: '蓝', green: '绿', black: '黑', gray: '灰' })),
          h('div', { className: 'sa-annotation-bubble-row sa-annotation-style-row' },
            h('span', { className: 'sa-annotation-style-label' }, '下划线'),
            swatches('underline', ['red', 'blue', 'gray'], { red: '红', blue: '蓝', gray: '灰' }),
            flagBtn('bold', 'B', '加粗'),
            flagBtn('italic', 'I', '斜体'),
            h('button', { className: 'sa-btn sa-annotation-bubble-close', title: '关掉气泡（Esc）', onClick: closeBubble }, '×')),
          h('div', { className: 'sa-annotation-bubble-row' },
            h('button', { className: 'sa-btn primary', 'data-action': 'apply-inline', disabled: saving, title: '把上面选的高光/字色/下划线/粗斜一次性加到这段文字', onClick: () => commitInlineStyle() }, saving ? '保存中…' : '完成')));
        }
        if (bubble.mode === 'compose') {
          const type = bubble.type ?? 'note';
          const label = type === 'insert'
            ? '插入的段落（失焦即保存）'
            : '批注（可打字，也可留空＝纯色高光；失焦即保存）';
          // 批注 compose 里也带一排高光色块：点是给「这条批注」定色（不是给正文选区）
          const composeSwatch = (value, title) => h('button', {
            className: 'sa-btn sa-annotation-swatch sa-annotation-swatch-highlight',
            key: `csw-${value}`,
            'data-compose-color': value,
            title,
            style: { backgroundColor: annotationStyleToCss({ highlight: value })?.backgroundColor ?? undefined },
            onClick: () => { setBubble({ ...bubble, style: { ...(bubble.style ?? {}), highlight: value } }); },
          }, '');
          return h('div', {
            className: 'sa-annotation-bubble',
            'data-mode': 'compose',
            'data-type': type,
            'data-annotation-guard': '1',
            style,
            onMouseDown: stopBubbleMouseDown,
          },
          head(label),
          type === 'insert' ? null : h('div', { className: 'sa-annotation-bubble-row sa-annotation-style-row' },
            h('span', { className: 'sa-annotation-style-label' }, '颜色'),
            composeSwatch('yellow', '黄'), composeSwatch('green', '绿'), composeSwatch('blue', '蓝'), composeSwatch('pink', '粉'), composeSwatch('orange', '橙')),
          markKindButtons(bubble.markKind, (kind) => setBubble((prev) => ({ ...(prev ?? {}), markKind: kind === null ? undefined : kind })),
            'sa-annotation-bubble-row sa-annotation-style-row', 'sa-btn sa-annotation-mark-btn', saving),
          input(type === 'insert' ? '写一段要插在这段文字后面的内容…' : '写点自己的话（可留空，留空就是纯色高光）…'),
          h('div', { className: 'sa-annotation-bubble-actions' },
            h('button', { className: 'sa-btn primary', 'data-action': 'commit', disabled: saving, onClick: () => submitBubble(bubble) }, saving ? '保存中…' : '完成'),
            h('button', { className: 'sa-btn', 'data-action': 'cancel', onClick: closeBubble }, '取消')));
        }
        return h('div', {
          className: 'sa-annotation-bubble',
          'data-mode': 'view',
          'data-annotation-guard': '1',
          'data-annotation-id': String(bubble.id ?? ''),
          style,
          onMouseDown: stopBubbleMouseDown,
        },
        head(bubble.state === 'fuzzy' ? '批注（位置待确认）' : '批注'),
        h('div', { className: 'sa-annotation-bubble-row sa-annotation-style-row' },
          h('span', { className: 'sa-annotation-style-label' }, '颜色'),
          ...['yellow', 'green', 'blue', 'pink', 'orange'].map((value) => h('button', {
            className: 'sa-btn sa-annotation-swatch sa-annotation-swatch-highlight',
            key: `vsw-${value}`,
            'data-view-color': value,
            title: `改成${{ yellow: '黄', green: '绿', blue: '蓝', pink: '粉', orange: '橙' }[value]}色`,
            style: { backgroundColor: annotationStyleToCss({ highlight: value })?.backgroundColor ?? undefined },
            onClick: () => submitViewStyle(bubble, { highlight: value }),
          }, '')),
          h('button', {
            className: 'sa-btn sa-annotation-flag',
            'data-view-clear': '1',
            title: '去掉颜色（保留批注文字）',
            onClick: () => submitViewStyle(bubble, null),
          }, '无色')),
        markKindButtons(bubble.markKind, (kind) => submitMarkKind(bubble, kind),
          'sa-annotation-bubble-row sa-annotation-style-row', 'sa-btn sa-annotation-mark-btn', saving),
        input('批注内容（失焦即保存）'),
        h('div', { className: 'sa-annotation-bubble-actions' },
          h('button', { className: 'sa-btn primary', 'data-action': 'commit', disabled: saving, onClick: () => submitBubble(bubble) }, saving ? '保存中…' : '完成'),
          h('button', { className: 'sa-btn', 'data-action': 'delete', onClick: () => removeNote(bubble.id) }, '删除'),
          h('button', { className: 'sa-btn', 'data-action': 'cancel', onClick: closeBubble }, '取消')));
      }

      const entryButton = (type, label, title) => h('button', {
        className: 'sa-btn sa-annotation-entry',
        'data-type': type,
        title,
        onClick: () => fallbackEntry(type),
      }, label);
      const typeLabel = (type) => (type === 'highlight' ? '高亮' : (type === 'insert' ? '插入' : '注释'));

      return h('div', { className: 'sa-annotation-layer', 'data-file': fileKey },
        surface,
        dockPanel ? null : renderBubble(),
        h('div', { className: 'sa-annotation-tools' },
          h('div', { className: 'sa-annotation-toolbar' },
            entryButton('note', '＋注释', '兜底入口：选中文字后点这里加批注（浮动气泡没弹出来时用）'),
            entryButton('highlight', '高亮', '兜底入口：把选中的文字标成高亮'),
            entryButton('insert', '插入段落', '兜底入口：在选中的文字处插入一段'),
            h('button', {
              className: 'sa-btn sa-annotation-undo',
              disabled: history.length === 0,
              title: '撤销最近一步（会话内最多 20 步，不建版本库）',
              onClick: undo,
            }, `撤销 (${history.length})`)),
          status === '' ? null : h('div', { className: 'sa-annotation-status' }, status)),
        pending.length === 0 ? null : h('div', { className: 'sa-annotation-pending', 'data-count': String(pending.length) },
          h('div', { className: 'sa-annotation-pending-title' }, `待处理批注 (${pending.length})`),
          ...pending.map((item, index) => h('div', {
            className: `sa-annotation-pending-item is-${item.state}${item.state === 'found' ? ' is-unplaced' : ''}`,
            key: `pd-${index}`,
            'data-state': item.state,
          },
          h('span', { className: 'sa-annotation-badge' }, item.state === 'lost' ? '已失效' : (item.state === 'found' ? '未落到正文' : '待确认')),
          h('span', { className: 'sa-annotation-content' }, item.content ?? '')))),
        notes.length === 0
          ? h('div', { className: 'sa-annotation-empty' }, '还没有批注。在正文里选中一段文字，右上角会浮出「批注 / 高亮 / 插入段落」。')
          : h('div', { className: 'sa-annotation-list' },
            ...notes.map((note, index) => {
              const stateOf = (plan.find((item) => item.id === note.id) ?? {}).state ?? 'found';
              const unplaced = stateOf === 'found' && !placedIds.has(String(note.id ?? ''));
              return h('div', {
                className: `sa-annotation-item is-${stateOf}${unplaced ? ' is-unplaced' : ''}`,
                key: `an-${index}`,
                'data-annotation-id': String(note.id ?? ''),
                'data-state': stateOf,
                'data-type': note.type,
              },
              h('span', { className: 'sa-annotation-type' }, typeLabel(note.type)),
              h('span', {
                className: 'sa-annotation-content',
                title: '点这里就地改这条批注',
                onClick: (event) => openNoteBubble({ id: note.id, type: note.type, content: note.content, state: stateOf }, event),
              }, note.content ?? ''),
              h('button', { className: 'sa-btn sa-annotation-del', onClick: () => removeNote(note.id) }, '删除'));
            })));
    }

    /**
     * 学习记录（P3）：时间线 + 阅读位置一次性取齐（只读）。
     *
     * 这些数据全部旁挂在 `学习台/学习记录/`，不进 /state、不进备份包，
     * 也不作为任何模型调用的证据（批注不回流，决策 E2）。
     * 对话索引随「交互助手对话」一起下线（2026-11-18），响应里不再有 `chats`。
     */
    async function fetchStudyLog(courseId) {
      const query = new URLSearchParams();
      if (typeof courseId === 'string' && courseId !== '') query.set('courseId', courseId);
      const suffix = query.toString();
      const response = await fetch(`${API}/study-log${suffix === '' ? '' : `?${suffix}`}`, {
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (result === null) return { ok: false, error: `http-${response.status}` };
      return result;
    }

    /** 记阅读位置（节流 + 原子写；失败不打断阅读，静默忽略）。 */
    async function saveReadingPosition(position) {
      try {
        await fetch(`${API}/reading-position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify(position),
        });
      } catch {
        /* 阅读位置只是锦上添花，写不进不影响看正文 */
      }
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

    /**
     * AI 材料导出（2026-11-18 E1）：GET /annotations/export?format=md|json&file=…（只读，不写盘）。
     * format/file 的拼装交给纯函数 aiExportQuery；返回服务端原样的 { ok, markdown|notes, count, file }。
     */
    async function exportAnnotationsMaterial(format, file) {
      const response = await fetch(`${API}/annotations/export?${aiExportQuery(format, file)}`, { headers: { Accept: 'application/json' } });
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
/* 视图切换过渡（2026-10-24）：树 / 导图 / 图 / 列表之间切换时重放一次淡入，
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
/* 「今日日程」三小节（2026-11-19 A 卡）：卡片内部的分组线，别把整张卡拆成三张 */
.sa-sub{margin-top:16px;padding-top:14px;border-top:1px dashed var(--dsw-alias-border-l1)}
.sa-sub-first{margin-top:8px;padding-top:0;border-top:0}
.sa-sub h4{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.5;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.sa-sub .sa-dock h4{margin-bottom:0}
/* 「今日日程」四分类横向版块（2026-11-19 A2 卡）：一张卡里横排 4 个版块，窄了就降 2 / 1 列。
   容器查询按**面板宽度**算（.sa-root 已经是 inline-size 容器），不是浏览器窗口宽度 ——
   插件停靠在侧边栏时窗口很宽但面板很窄，用 @media 会一直以为是 4 列而挤成一团。 */
.sa-cat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
.sa-cat{border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);padding:10px 10px 6px;background:var(--dsw-alias-bg-base);min-width:0}
.sa-cat-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}
.sa-cat-item{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 0}
.sa-cat-row{display:flex;align-items:center;gap:4px;min-width:0}
.sa-cat-main{flex:1 1 auto;min-width:0;display:flex;align-items:flex-start;gap:6px;background:none;border:0;padding:2px 0;cursor:pointer;text-align:left;color:var(--dsw-alias-label-primary);font:inherit;border-radius:max(var(--dsw-radius-sm,4px),6px)}
.sa-cat-time{flex:none;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;max-width:9.5em;overflow:hidden;text-overflow:ellipsis}
.sa-cat-title{flex:1 1 auto;min-width:0;font-size:14px;line-height:1.6;white-space:normal;overflow-wrap:anywhere}
.sa-cat-caret{flex:none;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary);opacity:.85}
.sa-cat-select{flex:none;max-width:6.4em;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-sm,4px),6px);font-size:12px;line-height:1.5;padding:1px 2px;font-family:inherit}
.sa-cat-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:4px 0 8px}
.sa-cat-detail{margin:6px 0 2px;padding:8px 9px;border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.65;display:flex;flex-direction:column;gap:4px;animation:sa-reveal .18s ease}
.sa-cat-note{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.sa-cat-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between}
/* 分类徽标：只借 .sa-pill 的形态，色调全部落在已有语义令牌上（品牌 / 业务 / 成功 / 次级文字），不新增颜色。 */
.sa-pill.cat-study{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.sa-pill.cat-innovation{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)) 8%,transparent)}
.sa-pill.cat-life{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary)) 8%,transparent)}
.sa-pill.cat-work{color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}
/* AI 识别条 + 预览条：识别结果只进表单，所以预览看起来要像「草稿」——虚线框，不是卡片。 */
.sa-ai{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.sa-ai-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sa-ai-preview{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);font-size:14px;line-height:1.6;background:var(--dsw-alias-bg-base)}
.sa-form{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
.sa-form .sa-form-title{flex:1 1 220px}
@container (max-width:900px){
  .sa-cat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@container (max-width:560px){
  .sa-cat-grid{grid-template-columns:minmax(0,1fr)}
}
/* 提醒结果条：成功/失败都停在这张卡里，不弹窗 */
.sa-note{margin:10px 0 0;padding:9px 11px;border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sa-note-error{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.sa-note pre{margin:8px 0 0;padding:0;font-family:inherit;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
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
.sa-section-title{font-size:1.125em;font-weight:700;line-height:1.5;color:var(--dsw-alias-label-primary);margin:20px 0 10px;display:block}
.sa-dock>.sa-section-title{margin:0 12px 0 0}
.sa-node-detail>.sa-dock:first-child{padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}
/* 详情卡标题（2026-10-30）：原来写死 22px，专注阅读里调 A+/A− 时正文变了、标题不动，
   看着像没生效。这里不敢用 em：父级 .sa-dock 是 14px，em 会按 14 算，所以直接 calc 乘 22/16=1.375。 */
.sa-card.sa-node-detail>.sa-dock:first-child>h3.sa-detail-title{font-size:calc(var(--dsh-content-font-size, 16px) * var(--sa-read-scale, 1) * 1.375);font-weight:700;line-height:1.45;color:var(--dsw-alias-label-primary);white-space:normal;overflow-wrap:anywhere}
/* 正文字号（2026-10-29）：基准听 DSH 设置里的「内容字号」（宿主把它发布成 body 上的
   --dsh-content-font-size），再乘 --sa-read-scale（专注阅读里的 A−/A+）。子规则改用 em，
   才能跟着一起缩放——原来全是写死的 16px !important，调字号完全没反应。 */
.sa-reading{font-size:calc(var(--dsh-content-font-size, 16px) * var(--sa-read-scale, 1));line-height:1.85;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sa-reading p{margin:12px 0 0!important;font-size:1em!important;line-height:1.85!important}
.sa-reading .sa-section-title{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-reading .sa-dock:first-child>.sa-section-title{border:0;padding-top:0}
.sa-reading .sa-example{padding:16px!important;margin-top:12px!important;border-radius:max(var(--dsw-radius-md,8px),10px)!important}
.sa-example-step{font-size:1em!important;line-height:1.85;color:var(--dsw-alias-label-primary);margin-top:8px!important}
.sa-example-answer{font-size:1.0625em!important;font-weight:700;line-height:1.7;margin-top:12px!important;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-reading .sa-grow{white-space:normal;overflow:visible;overflow-wrap:anywhere}
.sa-reading .sa-formula{font-size:1em!important;line-height:1.8;padding:12px 14px!important;overflow:auto}
.sa-reading-pre{font-size:calc(var(--dsh-content-font-size, 16px) * var(--sa-read-scale, 1))!important;line-height:1.85!important;font-family:inherit!important;padding:16px!important;box-sizing:border-box;overflow-wrap:anywhere}
/* 批注覆盖层（B1 2026-10-30 / F2 2026-10-31）：标记叠在正文字面上，不改原文。全部走主题令牌。
   F2 起正文本身就由批注层渲染（内联 <mark> 要画在正文里），所以这一层不再自带分隔线，
   分隔线挪到下方「兜底工具条 + 列表」那一块（.sa-annotation-tools）。
   字号一律用 em 相对正文，不写裸 px——正文跟着 --sa-read-scale 缩放时批注也要跟着变。 */
.sa-annotation-layer{font-size:.875em;line-height:1.6;min-width:0}
/* 浮动气泡（F2）：position:fixed 贴在选区右上角，位置由 placeAnnotationBubble 算好写进 style。
   宽度用 min() 夹住，320px 窄面板里也不会把页面撑出横向滚动。 */
.sa-annotation-bubble{position:fixed;z-index:60;display:flex;flex-direction:column;gap:.4em;box-sizing:border-box;width:min(20em, calc(100vw - 2em));padding:.6em .7em;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:.875em;line-height:1.5;box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.sa-annotation-bubble-title{font-weight:650;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sa-annotation-bubble-menu{display:flex;gap:.4em;flex-wrap:wrap}
.sa-annotation-bubble-input{width:100%;box-sizing:border-box;min-height:4.5em;max-height:12em;resize:vertical;padding:.4em .55em;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.sa-annotation-bubble-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-annotation-bubble-actions{display:flex;gap:.4em;flex-wrap:wrap;justify-content:flex-end}
.sa-annotation-bubble-close{flex:none}
.sa-annotation-tools{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-annotation-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.sa-annotation-entry{min-height:2.2em;padding:.25em .7em}
.sa-annotation-status{color:var(--dsw-alias-label-secondary);margin:.25em 0}
.sa-annotation-mark{border-radius:var(--dsw-radius-sm);padding:0 1px;cursor:pointer;background:transparent;color:inherit}
.sa-annotation-mark.sa-annotation-found{box-shadow:inset 0 -2px var(--dsw-alias-brand-primary)}
/* 2026-11-18：有自带底色的标记（选了色的高亮/纯色批注）不要再叠一条「等下划线」的 inset 阴影，
   否则用户会以为高亮自带了橘色/蓝色下划线、还删不掉（那条下划线根本不是 underline 样式，是阴影）。 */
.sa-annotation-mark.sa-annotation-filled{box-shadow:none}
/* 2026-11-18 四修：公式子树整体高亮——高亮套在内层 span.sa-annotation-formula-hit（display:inline-block
   由内联样式给出，宽度随内容收缩=只框公式本身），外层 .sa-formula 块级 div 布局/居中不受影响。 */
.sa-annotation-formula-hit{position:relative;cursor:pointer}
.sa-annotation-formula-hit:hover{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-annotation-mark.is-highlight{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);box-shadow:none}
.sa-annotation-mark.sa-annotation-fuzzy{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,var(--dsw-alias-brand-primary)) 20%,transparent);box-shadow:none;text-decoration:underline dotted}
/* 行内格式工具条（2026-11-17 D 卡）：气泡里两排色块 + B/I 按钮 */
.sa-annotation-bubble-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.sa-annotation-style-row{gap:3px}
.sa-annotation-style-label{font-size:.8em;color:var(--dsw-alias-label-tertiary);margin-right:1px;flex:none}
.sa-annotation-swatches{display:inline-flex;gap:3px;flex-wrap:wrap;margin-right:6px}
.sa-annotation-swatch{width:18px;height:18px;min-width:18px;padding:0;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);font-size:0;line-height:0;flex:none}
.sa-annotation-swatch.sa-annotation-swatch-underline{border-bottom-width:3px}
.sa-annotation-swatch:hover{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sa-annotation-flag{width:24px;min-width:24px;padding:0;font-weight:700;flex:none}
.sa-annotation-flag[data-flag="italic"]{font-style:italic}
/* AI 材料标记类型按钮（2026-11-18 E1）：普通/重点/疑问/待复习，选中态用主题色描边 */
.sa-annotation-mark-btn{padding:.15em .5em;min-width:auto;font-size:.8em;line-height:1.4;flex:none}
.sa-annotation-mark-btn.is-selected{outline:2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1));outline-offset:1px;color:var(--dsw-alias-brand-primary, inherit);font-weight:650}
.sa-annotation-mark:hover{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* 行内格式角标（2026-11-17 D 卡第二轮反馈）：高亮/批注文字左侧挂一个小齿轮按钮，点它就改色/删除 */
.sa-annotation-hit{position:relative;display:inline}
.sa-annotation-badge{position:absolute;left:-2px;top:-0.72em;display:none;align-items:center;justify-content:center;width:15px;height:15px;padding:0;font-size:.72em;line-height:1;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;z-index:5;box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.sa-annotation-hit:hover .sa-annotation-badge,.sa-annotation-badge:focus{display:inline-flex}
.sa-annotation-badge:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sa-annotation-insert{display:block;border-left:3px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-radius:var(--dsw-radius-sm);padding:.4em .7em;margin:.5em 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);cursor:pointer}
.sa-annotation-highlight{border:1px dashed var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);padding:8px 10px;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sa-annotation-foot{display:flex;gap:8px;justify-content:flex-end;margin:8px 0}
.sa-annotation-pending{border:1px solid var(--dsw-alias-state-warn-primary,var(--dsw-alias-border-l1));border-radius:max(var(--dsw-radius-md,8px),10px);padding:8px 10px;margin:8px 0;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,var(--dsw-alias-brand-primary)) 8%,transparent)}
.sa-annotation-pending-title{font-weight:650;margin-bottom:6px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary))}
.sa-annotation-pending-item{display:flex;gap:8px;align-items:baseline;padding:3px 0;overflow-wrap:anywhere}
.sa-annotation-badge{font-size:.86em;padding:1px 7px;border-radius:999px;border:1px solid currentColor;flex:none;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.sa-annotation-pending-item.is-lost .sa-annotation-badge{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
/* 2026-11-12：found 但正文里没落成 mark（渲染文本对不上）—— 别静默藏起来 */
.sa-annotation-pending-item.is-unplaced .sa-annotation-badge{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.sa-annotation-item.is-unplaced{border-style:dashed}
.sa-annotation-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.sa-annotation-item{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--dsw-alias-bg-layer-2)}
.sa-annotation-item.is-fuzzy{border-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-border-l1))}
.sa-annotation-item.is-lost{opacity:.72;border-style:dashed}
.sa-annotation-type{font-weight:600;flex:none;color:var(--dsw-alias-label-secondary)}
.sa-annotation-content{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sa-annotation-del{flex:none}
.sa-annotation-empty{color:var(--dsw-alias-label-secondary);padding:6px 0}
/* 学习记录（P3，2026-10-30）：时间线行（对话气泡随交互助手下线，2026-11-18） */
.sa-log-row{align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sa-log-row:last-child{border-bottom:0}
.sa-log-icon{flex:none;width:1.6em;text-align:center;font-size:16px;line-height:1.6}
.sa-log-title{font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sa-btn.disabled{opacity:.55;pointer-events:none}
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
 .sa-card.sa-node-detail>.sa-dock:first-child>h3.sa-detail-title{font-size:calc(var(--dsh-content-font-size, 16px) * var(--sa-read-scale, 1) * 1.25)}
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
/* 章行拆成「箭头按钮 + 名称按钮」（2026-10-29 用户定）：左边管展开，右边点一下在阅读区打开该章讲义，两件事互不干扰 */
.sa-compact-row{display:flex;align-items:flex-start;gap:2px}
.sa-compact-arrow-btn{flex:none;appearance:none;border:0;background:transparent;color:inherit;font:inherit;width:22px;min-height:32px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.sa-compact-arrow-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.sa-compact-row>.sa-compact-point{flex:1;min-width:0}
/* 树视图的章行：点名称读讲义，箭头单独负责展开；打开着的章用左侧竖条标出来 */
.sa-tree-row[data-active="true"]{box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}
.sa-tree-row[data-active="true"]>.sa-grow{font-weight:650}
.sa-tree-row[data-chapter="true"]>.sa-kp-caret{cursor:pointer;border-radius:var(--dsw-radius-sm);padding:0 2px}
.sa-tree-row[data-chapter="true"]>.sa-kp-caret:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.sa-reader-pane{overflow:auto;min-width:0;min-height:0;scrollbar-gutter:stable;overscroll-behavior:auto;border-radius:max(var(--dsw-radius-lg,12px),14px)}
.sa-reader-pane>.sa-node-detail{margin-bottom:0;min-height:100%;box-sizing:border-box}
/* 讲义正文挪到详情卡上面后（2026-10-29），详情卡不再独占整栏高度，否则要滚过一整屏空白才看到它 */
.sa-reader-pane>.sa-card+.sa-node-detail{min-height:0}
.sa-reader-pane .sa-reading{max-width:100%}
/* 横向滚动（2026-11-17 C1 并入 B 卡修复）：正文本体已去掉写死 80ch，宽面板里铺满可用宽度；
   真正的宽内容（多层表格、超长公式、长代码）交给容器横向滚动，而不是把字挤成一列或裁掉。
   fitReadScale/measureReadColumnWidth 的 80ch「设计行宽」保持不动——「适应窗口」仍按它反算倍率。 */
.sa-reader-pane .sa-reading .sa-formula,.sa-reader-pane .sa-reading-pre{overflow-x:auto;max-width:100%}
.sa-reading table{max-width:100%;overflow-x:auto;display:block}
.sa-reader-pane .sa-reading-pre{max-height:none!important;overflow:visible!important;max-width:100%}
.sa-reader-pane .sa-reading img{max-width:100%;height:auto}
.sa-reader-empty{min-height:100%;box-sizing:border-box;margin-bottom:0;padding:28px}
.sa-reader-empty p{line-height:1.8;max-width:45ch}
.sa-lecture-links{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:5px 0 6px}
.sa-lecture-links.compact{margin:3px 0 4px;padding-left:24px}
.sa-lecture-links .sa-btn{min-height:26px;padding:2px 7px;font-size:12px}
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

/* 普通模式让正文随整页滚动；仅专注阅读建立独立滚动区。 */
.sa-learning-layout{height:auto;align-items:start}
.sa-browser-pane{position:sticky;top:0;height:clamp(300px,64vh,720px)}
.sa-reader-pane{overflow:visible;min-height:0;max-height:none}
.sa-reader-pane .sa-reading{max-height:none!important;overflow:visible!important}
.sa-reader-pane .sa-reader-empty{min-height:320px}
.sa-learning-layout[data-full-browser="true"]{height:clamp(420px,72vh,860px)}
.sa-learning-layout[data-full-browser="true"]>.sa-browser-pane{position:static;height:100%}
/* 专注阅读的底必须是**不透明纸面**（2026-10-29 用户反馈「背景透明，无法阅读」）：
   壁纸插件（dsh-plugin-wallpaper-engine）启用时恒挂 body[data-we-glass-page]，把
   --dsw-alias-bg-layer-1/2/3 改写成半透明玻璃配方（可读性地板浅 45% / 深 59%）——
   平时看不出来，可专注面是直接盖在目录/正文上的，那 41~55% 的透明就把下面的字透了上来。
   所以这里在玻璃色下面垫一层宿主静态调色板的实色（浅 neutral-bluish-00 / 深 -875，
   字面量兜底）：普通主题下两层同色，观感不变；玻璃主题下玻璃色叠在白/深底上，不透但仍有釉光。 */
/* 学习模式（2026-11-17 C1）：把「专注阅读」从「占满面板」升级成「全屏覆盖整个 DSH 窗口」。
   覆盖范围用 position:fixed;inset:0 直接盖住视口（含侧边栏），不再只盖 .sa-root 主面板。
   层级：.sa-root 自身 isolation:isolate + z-index:1 会形成层叠上下文，其子元素 z-index 只能在
   .sa-root 内部比较、盖不过侧边栏；所以这里①把根临时抬到极大 z-index（:has 见下一条），
   ②面本身也取大 z-index 兜底。旧 data-focus-reader 选择器全部保留（测试与降级仍用），
   新增 data-study-mode 覆盖全屏行为。 */
.sa-reader-pane[data-study-mode="true"]{position:fixed;inset:0;z-index:2147483000;display:block;height:100%;width:100%;overflow:auto;overscroll-behavior:contain;--sa-focus-paper:var(--dsw-static-neutral-bluish-00, #fff);--sa-focus-paper-base:#fff;background-color:var(--sa-focus-paper);background-image:linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1));padding:18px 18px 18px 212px;box-sizing:border-box;border-radius:var(--dsw-radius-sm)}
/* 抬根：学习模式下 .sa-root 要盖过兄弟（侧边栏等）；:has 不支持的旧浏览器下由上面的面 z-index 兜底。 */
.sa-root:has(.sa-reader-pane[data-study-mode="true"]){z-index:2147483000}
body[data-ds-dark-theme] .sa-reader-pane[data-study-mode="true"]{--sa-focus-paper:var(--dsw-static-neutral-bluish-875, #232324);--sa-focus-paper-base:#232324}
/* 护眼模式（2026-11-17 C1feat）：只作用于学习模式面。开＝在 [data-study-mode="true"] 上再挂 data-eye-care="true"，
   用 --sa-eye-bg / --sa-eye-fg 覆盖纸底色与文字色；关＝属性不出现，完全沿用上面的默认纸底（零影响）。
   浅色主题：米黄底 + 暖黑字（减轻蓝光、久看不累）。暗色主题：暖深底 + 暖米字，避免暗色下铺亮米黄刺眼。
   竖条 .sa-focus-header 背景引用 --sa-focus-paper-base，会自动跟随米黄/暖深底，与正文同色系。 */
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"]{--sa-eye-bg:#f5ebd0;--sa-eye-fg:#2b2b26;--sa-focus-paper:var(--sa-eye-bg);--sa-focus-paper-base:var(--sa-eye-bg);background-color:var(--sa-eye-bg);background-image:none;color:var(--sa-eye-fg)}
body[data-ds-dark-theme] .sa-reader-pane[data-study-mode="true"][data-eye-care="true"]{--sa-eye-bg:#2e2a20;--sa-eye-fg:#e8e2cf;--sa-focus-paper:var(--sa-eye-bg);--sa-focus-paper-base:var(--sa-eye-bg);background-color:var(--sa-eye-bg);background-image:none;color:var(--sa-eye-fg)}
/* 正文容器让位（2026-11-17 C1feat 返修）：正文卡 .sa-card / .sa-node-detail 自带 background:var(--dsw-alias-bg-layer-1)（:2082），
   会把下层米黄纸底盖成白/灰 —— 这是「中间颜色基本没变」的成因。护眼时把这些卡的背景改成透明/竖条纸色，
   让米黄（浅）/暖深（暗）纸底透出来，文字与标题也统一成暖黑/暖米色；边框改暖色调降突兀。 */
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-node-detail{background:transparent;border-color:color-mix(in srgb,var(--sa-eye-fg) 18%,transparent);box-shadow:none;color:var(--sa-eye-fg)}
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card *,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-node-detail *{color:inherit}
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-detail-title,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card h1,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card h2,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card h3,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card h4,
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-card strong{color:var(--sa-eye-fg)}
.sa-reader-pane[data-study-mode="true"][data-eye-care="true"] .sa-muted{color:color-mix(in srgb,var(--sa-eye-fg) 65%,transparent)}
/* 兼容旧标记 data-focus-reader（既有测试断言这些选择器；降级/回退时也用）。与 data-study-mode 同款纸底。 */
.sa-reader-pane[data-focus-reader="true"]{position:fixed;inset:0;z-index:2147483000;display:block;height:100%;overflow:auto;overscroll-behavior:contain;--sa-focus-paper:var(--dsw-static-neutral-bluish-00, #fff);--sa-focus-paper-base:#fff;background-color:var(--sa-focus-paper);background-image:linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1));padding:18px 18px 18px 212px;box-sizing:border-box;border-radius:var(--dsw-radius-sm)}
.sa-root:has(.sa-reader-pane[data-focus-reader="true"]){z-index:2147483000}
body[data-ds-dark-theme] .sa-reader-pane[data-focus-reader="true"]{--sa-focus-paper:var(--dsw-static-neutral-bluish-875, #232324);--sa-focus-paper-base:#232324}
.sa-root:has(.sa-reader-pane[data-focus-reader="true"])>.sa-body{overflow:hidden}
.sa-root:has(.sa-reader-pane[data-study-mode="true"])>.sa-body{overflow:hidden}
/* 学习模式是全屏 fixed 层（z-index 2147483000），而助手浮层只有 absolute/z-index 40，
   用户报「一进学习模式按钮就没了」。把浮层一并抬到同一层之上，并改成同样的视口定位；
   浮层自身 pointer-events:none、只有按钮/面板接收点击，不会挡住阅读。 */
.sa-root:has(.sa-reader-pane[data-study-mode="true"]) .sa-assist,
.sa-root:has(.sa-reader-pane[data-focus-reader="true"]) .sa-assist{position:fixed;inset:0;z-index:2147483001}
.sa-knowledge-page:has([data-focus-reader="true"]){animation:none!important;transform:none!important}
.sa-knowledge-page:has([data-study-mode="true"]){animation:none!important;transform:none!important}
.sa-reader-pane[data-focus-reader="true"]>.sa-node-detail,.sa-reader-pane[data-focus-reader="true"]>.sa-card{max-width:90ch;margin-left:auto;margin-right:auto}
.sa-reader-pane[data-study-mode="true"]>.sa-node-detail,.sa-reader-pane[data-study-mode="true"]>.sa-card{max-width:90ch;margin-left:auto;margin-right:auto}
/* v2-H（2026-11-23）：用户拖过正文宽度后，用内联 --sa-read-col 覆盖上面的 90ch 限宽。
   2026-11-23 用户反馈「一拖就贴左」→ 修正为始终居中（margin-left/right 都 auto），只改宽度不改对齐。
   只在 data-read-col-dragged="true"（真拖过一次）时生效；未拖动仍是 :3059/:3060 的 90ch 居中，默认观感一字不动。
   左侧 200px 竖条 .sa-focus-header 不动，改的只是正文列的 max-width。 */
.sa-reader-pane[data-study-mode="true"][data-read-col-dragged="true"]>.sa-node-detail,
.sa-reader-pane[data-study-mode="true"][data-read-col-dragged="true"]>.sa-card,
.sa-reader-pane[data-focus-reader="true"][data-read-col-dragged="true"]>.sa-node-detail,
.sa-reader-pane[data-focus-reader="true"][data-read-col-dragged="true"]>.sa-card{max-width:var(--sa-read-col, none);margin-left:auto;margin-right:auto}
/* 三栏正文宽度（2026-11-23 缺陷修复）：三栏态下正文卡**吃掉左右栏之间剩余的整个宽度**。
   两种控宽机制原来打架：三栏用 .sa-reader-pane 的 padding 让位（--sa-focus-rail / --sa-focus-chat，见 :3257），
   而 v2-H 用 max-width（90ch 或内联 --sa-read-col）卡死页宽 → 拖边界只动 padding，正文宽毫无反应。
   这里在 [data-focus-three-col="true"] 门控下把 max-width 放开（max-width:none + width:auto + 两侧 margin 归零），
   宽度完全由 padding 夹出来 —— 拖左栏右缘 / 右栏左缘，页宽立刻跟着变。
   · 门控严格：普通专注（非三栏）不命中，:3059/:3060 的 90ch 居中与 :3065 的 --sa-read-col 覆盖照旧生效（观感一字不动）。
   · 特异性：本选择器与 :3065 同为 4 个类/属性选择器（相同特异性），靠书写顺序（本段在 :3065-3068 之后）取胜；
     与 data-read-col-dragged="true" 同时为真时也走这里，普通态不受影响。 */
.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]>.sa-node-detail,
.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]>.sa-card,
.sa-reader-pane[data-focus-reader="true"][data-focus-three-col="true"]>.sa-node-detail,
.sa-reader-pane[data-focus-reader="true"][data-focus-three-col="true"]>.sa-card{max-width:none;width:auto;margin-left:0;margin-right:0}
/* 专注阅读标题条（2026-10-31 F1：修「正文从标题条上方/两侧透出来」）。两个成因，都实测过：
   ① sticky 只会贴到滚动容器**内容盒**的上边缘（Chrome 实测：容器 padding-top 12/18px 时，
      条子 sticky 后 top 仍是 12，正文从那一条带子里滚上来；负 margin-top 也压不上去，
      因为 sticky 元素不许越过父级内容盒）。所以**去掉专注面的上内边距**（改成 0 18px 18px），
      让条子自己用 padding 撑出呼吸感；左右仍用负 margin 外扩到内边距边缘，盖满整条。
   ② 原来用 background-image 铺 --dsw-alias-bg-layer-1，玻璃主题（壁纸插件）下这个层叠色
      带透明度（实测 alpha 0.45），等于把条子本身做成半透明 —— 改成「实色底 + 纸面色」两层：
      实色底（--sa-focus-paper-base，浅 #fff / 深 #232324）保证任何主题下都不透字，
      纸面色（--sa-focus-paper）保留釉光，且不再引用 alias 层叠色。 */
/* C1fix（2026-11-17）：学习模式工具栏从"顶部 sticky 横条"改为"窗口左侧竖条"。
   原因：顶部 sticky 横条与 DSH 自身顶部栏重叠、按键点不灵。只改定位，功能/DOM/文案全不动。
   竖条 fixed 在视口左缘整列到底，避开顶部栏；正文容器用 padding-left 让位（见 .sa-reader-pane[data-study-mode]）。
   旧 data-focus-reader 的横条样式分支也一并改成左侧竖条，保持降级一致。 */
.sa-focus-header{position:fixed;left:0;top:0;bottom:0;width:200px;z-index:2147483000;display:flex;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:10px;padding:12px;overflow-y:auto;box-sizing:border-box;background-color:var(--sa-focus-paper-base, #fff);background-image:linear-gradient(var(--sa-focus-paper, #fff),var(--sa-focus-paper, #fff));border-right:1px solid var(--dsw-alias-border-l1)}
.sa-focus-header>strong{flex:0 0 auto;min-width:0;font-size:18px;line-height:1.3;word-break:break-word}
.sa-focus-header .sa-muted{font-size:14px}
/* 竖条底部区：Esc 提示 + 退出按钮贴底（margin-top:auto 把剩余空隙吃掉，让它们沉到竖条底）。 */
.sa-study-footer{margin-top:auto;display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 学习模式顶部三功能位（2026-11-17 C1）：时钟 / 切文档 / 高光索引。本阶段只占位：虚线框 + 灰字提示，
   不接任何逻辑；阶段二/三往 .sa-study-slot 内渲染即可，结构与 data-slot 值固定不变。 */
.sa-study-slots{display:flex;flex-direction:column;align-items:stretch;gap:8px;flex-wrap:nowrap}
.sa-study-slot{display:inline-flex;align-items:center;justify-content:center;min-height:26px;min-width:52px;padding:2px 8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);font-size:12px;color:var(--dsw-alias-label-tertiary);background:transparent}
.sa-study-slot-hint{white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.sa-study-slot{transition:border-color .15s ease}}
/* 左侧栏行内格式面板（2026-11-18 用户定）：选中文字后选项出现在竖条里，不再浮气泡被左栏挡。
   竖条只有 200px 宽，面板用竖排、色块换行，尽量塞得下。 */
.sa-dock-annotation{display:flex;flex-direction:column;gap:6px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--sa-focus-paper-base, var(--dsw-alias-bg-layer-2));box-sizing:border-box}
.sa-dock-panel{display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
.sa-dock-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.3}
.sa-dock-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.sa-dock-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.sa-dock-swatches{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.sa-dock-panel .sa-annotation-swatch{width:18px;height:18px;min-width:18px;padding:0}
.sa-dock-panel .sa-annotation-swatch.is-selected{outline:2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1));outline-offset:1px}
.sa-dock-panel .sa-annotation-flag.is-selected{outline:2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1));outline-offset:1px}
.sa-dock-panel .sa-annotation-bubble-input{width:100%;box-sizing:border-box;font-size:12px;resize:vertical}
.sa-dock-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
/* 已填充的插槽（C2）：clock/switch 有内容后不再用虚线占位框，改成常规容器 */
.sa-study-slot.sa-study-clock,.sa-study-slot.sa-study-switch,.sa-study-slot.sa-study-marks{border-style:solid;justify-content:flex-start;align-items:stretch;color:var(--dsw-alias-label-secondary)}
/* marks 插槽（2026-11-17 D 卡）：本页高光/行内格式索引 —— 横排小色片，点击滚动定位 */
.sa-marks-list{display:flex;flex-wrap:wrap;gap:4px;width:100%;align-items:center}
.sa-marks-chip{max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer}
.sa-marks-chip:hover{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* AI 材料徽标（2026-11-18 E1）：chip 上的中文角标，颜色按 markKind 分。 */
.sa-marks-badge{font-weight:650;margin-right:2px}
.sa-marks-badge[data-mark-kind='key']{color:#b8860b}
.sa-marks-badge[data-mark-kind='question']{color:#1f6feb}
.sa-marks-badge[data-mark-kind='review']{color:#a371f7}
/* AI 材料导出区（2026-11-18 E1）：竖条底部，展开后范围切换 + 两格式入口 + 失败 <pre> 展示。 */
.sa-ai-export{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}
.sa-ai-export-toggle{justify-content:flex-start;text-align:left}
.sa-ai-export-body{display:flex;flex-direction:column;gap:6px}
.sa-ai-export-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.sa-ai-export-label{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:2.5em}
.sa-ai-export-scope.is-selected{outline:2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1));outline-offset:1px;font-weight:650}
.sa-ai-export-auto{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);padding:2px 0}
.sa-ai-export-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.4}
.sa-ai-export-fallback{display:flex;flex-direction:column;gap:4px}
.sa-ai-export-pre{max-height:220px;overflow:auto;padding:6px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.sa-annotation-mark.is-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* 学习时钟（C2）：模式切换 + 预设 + 时间 + 按钮 + 今日累计 */
.sa-clock{display:flex;flex-direction:column;gap:6px;width:100%}
.sa-clock-tabs,.sa-clock-presets{display:flex;gap:4px;flex-wrap:wrap}
.sa-clock-tab,.sa-clock-preset{flex:1 1 auto;min-height:24px;padding:2px 6px;font-size:12px}
.sa-clock-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sa-clock-time{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;min-width:64px;letter-spacing:.5px}
.sa-clock-phase{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.sa-clock-phase[data-phase="studying"]{color:var(--dsw-alias-state-success-primary)}
.sa-clock-phase[data-phase="break"]{color:var(--dsw-alias-label-secondary)}
.sa-clock-btn{min-height:24px;padding:2px 8px;font-size:12px}
.sa-clock-today{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 翻页（C2）：上/下篇 + 计数 + 下拉 */
.sa-pager{display:flex;flex-direction:column;gap:6px;width:100%}
.sa-pager-row{display:flex;align-items:center;gap:6px}
.sa-pager-btn{min-height:24px;padding:2px 6px;font-size:12px;flex:1 1 0;white-space:nowrap}
.sa-pager-btn:disabled{opacity:.45;cursor:not-allowed}
.sa-pager-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.sa-pager-select{width:100%;box-sizing:border-box;font-size:12px;min-height:24px;padding:2px 4px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1, #fff);color:inherit}
.sa-zoom-controls{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.sa-read-size{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.sa-read-size .sa-btn{min-height:26px;padding:2px 8px;font-size:13px}
.sa-zoom-value{min-width:50px;text-align:center;font-size:14px;font-variant-numeric:tabular-nums}
@container (max-width:860px){
 .sa-browser-pane{position:static;height:auto}
 .sa-learning-layout[data-full-browser="true"]{height:auto}
 .sa-reader-pane[data-focus-reader="true"]{padding:12px 12px 12px 132px}
 .sa-reader-pane[data-study-mode="true"]{padding:12px 12px 12px 132px}
 /* C1fix：窄屏竖条收窄到 120px，正文让位 132px；字号控件在竖条里自然折行。 */
 .sa-focus-header{width:120px;padding:10px;gap:8px}
 .sa-focus-header>strong{font-size:15px}
}
@media print{
 .sa-browser-pane,.sa-focus-header,.sa-zoom-controls,.sa-read-size{display:none!important}
 .sa-reader-pane[data-focus-reader="true"]{position:static;height:auto;overflow:visible;padding:0}
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

/* 学习助手浮层（2026-11-19 MVP 卡）：只活在 .sa-root 面板里，不越出到全窗。
   定位用 absolute + inset:0 铺满**面板**（.sa-root 自身 position:relative），
   圆按钮与聊天面板贴在右下角；⚠️ 刻意不用 position:fixed —— fixed 会相对整个
   窗口定位，盖到 DSH 外层顶栏上（原卡第 ② 节点名不许这么干）。
   外层 pointer-events:none，只有按钮/面板本身接事件，铺满的那层不挡面板内容。 */
.sa-assist{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;align-items:flex-end;justify-content:flex-end;gap:10px;padding:14px;pointer-events:none}
.sa-assist>*{pointer-events:auto}
.sa-assist-fab{width:38px;height:38px;flex:0 0 auto;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-overlay);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);transition:background .18s ease,border-color .18s ease,box-shadow .2s ease}
.sa-assist-fab:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.sa-assist-fab[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 2px 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.sa-assist-dot{display:block;width:11px;height:11px;border-radius:999px;background:var(--dsw-alias-brand-primary)}
/* v2-G（2026-11-22）：面板自管一套配色，彻底摆脱宿主的半透明 alias 令牌。
   宿主 --dsw-alias-bg-overlay 带 alpha，后面的讲义会从面板底下透上来（用户报「看字不清晰」）。
   改成面板自有变量 --sa-assist-*：浅色默认一套、深色（data-sa-assist-theme="dark"）覆盖一套，
   两套全是不透明实色；正文色对各自底色对比度均在 12:1 以上，次级字也 ≥ 5.9:1。
   宽高由 state 给（拖拽改），这里只留 min/max 兜底：最大别撑破 .sa-assist（父 padding 14px，
   底下还要给 38px 的圆按钮 + 10px gap 让位，所以高上限扣 76px）。 */
.sa-assist-panel{--sa-assist-surface:#ffffff;--sa-assist-surface-2:#f4f5f7;--sa-assist-surface-3:#e8ebf0;--sa-assist-fg:#1a1d23;--sa-assist-fg-soft:#59616e;--sa-assist-border:#d3d8e0;--sa-assist-bubble-user:#e9f1fe;--sa-assist-bubble-user-border:#9dbcee;--sa-assist-bubble-assistant:#f4f5f7;--sa-assist-input:#ffffff;--sa-assist-input-border:#c9cfd9;--sa-assist-danger:#b3261e;--sa-assist-btn:#f4f5f7;--sa-assist-btn-border:#d3d8e0;--sa-assist-accent:#1f6feb;width:min(360px,calc(100cqw - 28px));height:460px;min-width:min(280px,calc(100cqw - 28px));min-height:min(320px,calc(100% - 76px));max-width:calc(100cqw - 28px);max-height:calc(100% - 76px);position:relative;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:var(--sa-assist-surface);color:var(--sa-assist-fg);border:1px solid var(--sa-assist-border);border-radius:max(var(--dsw-radius-lg,12px),14px);box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);animation:sa-fade .18s cubic-bezier(.2,.8,.2,1)}
.sa-assist-panel[data-sa-assist-theme="dark"]{--sa-assist-surface:#1e2024;--sa-assist-surface-2:#25282d;--sa-assist-surface-3:#30343a;--sa-assist-fg:#eceef2;--sa-assist-fg-soft:#a9b1bd;--sa-assist-border:#3c424b;--sa-assist-bubble-user:#2a3a52;--sa-assist-bubble-user-border:#4d6f9f;--sa-assist-bubble-assistant:#2a2d33;--sa-assist-input:#22252a;--sa-assist-input-border:#464d57;--sa-assist-danger:#ff8b7f;--sa-assist-btn:#2a2d33;--sa-assist-btn-border:#40464f;--sa-assist-accent:#8ab4ff;color-scheme:dark;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.sa-assist-head{flex:0 0 auto;display:flex;align-items:center;flex-wrap:nowrap;gap:8px;padding:9px 12px;border-bottom:1px solid var(--sa-assist-border);font-size:14px;line-height:1.5;min-width:0}
.sa-assist-head strong{font-size:15px;font-weight:650;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-assist-hint{color:var(--sa-assist-fg-soft);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}
.sa-assist-head .sa-btn{width:28px;height:28px;min-width:28px;min-height:28px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;line-height:1;border-radius:max(var(--dsw-radius-sm,6px),8px)}
.sa-assist-head .sa-btn svg{display:block;width:16px;height:16px;pointer-events:none}
.sa-assist-log{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--sa-assist-surface);scrollbar-gutter:stable}
.sa-assist-empty{font-size:14px;line-height:1.7}
.sa-assist-msg{display:flex;flex-direction:column;gap:3px;min-width:0}
.sa-assist-msg.user{align-items:flex-end}
.sa-assist-msg.assistant{align-items:flex-start}
.sa-assist-who{font-size:12px;line-height:1.4;color:var(--sa-assist-fg-soft)}
.sa-assist-bubble{max-width:86%;padding:8px 10px;border:1px solid var(--sa-assist-border);border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--sa-assist-bubble-assistant);color:var(--sa-assist-fg);font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box}
.sa-assist-msg.user .sa-assist-bubble{background:var(--sa-assist-bubble-user);border-color:var(--sa-assist-bubble-user-border)}
.sa-assist-msg.assistant .sa-assist-bubble{background:var(--sa-assist-bubble-assistant);border-color:var(--sa-assist-border)}
.sa-assist-error{flex:0 0 auto;margin:0 12px 6px;font-size:13px;line-height:1.6;color:var(--sa-assist-danger)}
.sa-assist-compose{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-top:1px solid var(--sa-assist-border);background:var(--sa-assist-surface-2)}
.sa-assist-input{width:100%;min-height:64px;max-height:132px;resize:none;box-sizing:border-box;line-height:1.6}
.sa-assist-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.sa-assist-actions .sa-muted{font-size:12px;margin-right:auto}
.sa-assist-actions .sa-btn{min-height:32px;padding:4px 14px}
/* v2-G（2026-11-22）：面板内部的按钮 / 输入框 / 次要文字 / 会话条也吃面板变量。
   不这么做的话，深色面板里会露出宿主浅色主题的 .sa-btn / .sa-input / .sa-muted（白底黑字、对比崩）。
   选择器统一带 .sa-assist-panel 前缀，只为浮层面板生效，主界面其它 .sa-btn 一点不改。 */
.sa-assist-panel .sa-btn{background:var(--sa-assist-btn);border-color:var(--sa-assist-btn-border);color:var(--sa-assist-fg)}
.sa-assist-panel .sa-btn:hover{background:var(--sa-assist-surface-3)}
.sa-assist-panel .sa-btn.primary{border-color:var(--sa-assist-accent);color:var(--sa-assist-fg);box-shadow:inset 0 0 0 1px var(--sa-assist-accent)}
.sa-assist-panel .sa-muted{color:var(--sa-assist-fg-soft)}
.sa-assist-panel .sa-input{background:var(--sa-assist-input);border-color:var(--sa-assist-input-border);color:var(--sa-assist-fg)}
.sa-assist-panel .sa-input::placeholder{color:var(--sa-assist-fg-soft)}
/* 聚焦描边要留着（.sa-input:focus-visible 在原文件更靠前、同权重，会被上面的 border-color 盖掉）。 */
.sa-assist-panel .sa-input:focus-visible{border-color:var(--sa-assist-accent)}
.sa-assist-panel .sa-spinner{border-color:var(--sa-assist-border);border-top-color:var(--sa-assist-fg-soft)}
.sa-assist-panel .sa-assist-proposal{border-color:var(--sa-assist-accent)}
.sa-assist-panel .sa-assist-proposal .sa-btn.primary{border-color:var(--sa-assist-accent);color:var(--sa-assist-accent)}
.sa-assist-panel .sa-assist-proposal[data-resolved="true"]{border-color:var(--sa-assist-border)}
.sa-assist-panel .sa-asst-sessions,.sa-assist-panel .sa-asst-list{background:var(--sa-assist-surface-2);border-bottom-color:var(--sa-assist-border)}
.sa-assist-panel .sa-asst-item:hover,.sa-assist-panel .sa-asst-item[data-active="true"]{background:var(--sa-assist-surface-3)}
.sa-assist-panel .sa-asst-item-title{color:var(--sa-assist-fg)}
.sa-assist-panel .sa-asst-item-meta,.sa-assist-panel .sa-asst-list-empty,.sa-assist-panel .sa-asst-list-foot,.sa-assist-panel .sa-assist-summary-line{color:var(--sa-assist-fg-soft)}
.sa-assist-panel .sa-asst-sessions .sa-asst-cur-sub{color:var(--sa-assist-fg-soft)}
/* 左上角缩放手柄（v2-G 补丁，2026-11-23）：14px 直角三角，cursor:nwse-resize。
   面板锚右下角（.sa-assist 是 flex-end/flex-end），手柄放左上才能往左/上拖变大——
   原来贴右下时鼠标一往右下就出屏幕边界。三角只有 8px、从 2px 处起画，不压标题文字；
   顶部图标按钮在 head 右侧，与左上角手柄天然不冲突。 */
.sa-assist-resize{position:absolute;left:0;top:0;width:14px;height:14px;display:flex;align-items:flex-start;justify-content:flex-start;padding:2px 0 0 2px;box-sizing:border-box;cursor:nwse-resize;touch-action:none;color:var(--sa-assist-fg-soft);background:transparent;z-index:3}
.sa-assist-resize::after{content:'';width:8px;height:8px;border-left:2px solid currentColor;border-top:2px solid currentColor;border-top-left-radius:2px;opacity:.55}
.sa-assist-resize:hover::after{opacity:1}
/* v2-H 返工（2026-11-23）：专注阅读可见分隔条。挂在 .sa-knowledge-page 直接子级（不被 reader-pane 的 overflow 裁剪），
   fixed 贴视口，left 由 JS 按正文卡右边界算；常态可见、20px 热区、中间一条 2px 竖线。 */
.sa-read-splitter{position:fixed;top:0;bottom:0;width:20px;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:2147483003;background:transparent}
.sa-read-splitter::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:2px;transform:translateX(-50%);background:var(--dsw-alias-border-l1);opacity:.55;transition:opacity .15s ease,background .15s ease}
.sa-read-splitter:hover::before,.sa-read-splitter[data-dragging="true"]::before{opacity:1;background:var(--dsw-alias-brand-primary)}
.sa-read-splitter:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
/* 两根轴合并（2026-11-23 用户 m02542 反馈 2）：专注三栏且右栏张开时，右侧只留「右栏左缘」那一根；
   v2-H 的正文手柄退场（display:none + 不吃指针，免得留一条看不见的热区），右栏关掉时它自己回来 ——
   v2-H 的能力与测试断言都不丢。
   注意 display 必须 !important：手柄的 display:block 是拖拽时写进 style 的内联值，内联优先于普通规则。 */
.sa-read-splitter[data-sa-axis="merged"]{display:none !important;pointer-events:none}
/* 三栏态正文手柄退场（2026-11-23 缺陷修复，用户口径「三栏只留左栏右缘 + 右栏左缘两根轴」）：
   专注态恒为三栏（reader-pane 的 data-focus-three-col 由 focusReading 决定，见渲染段），正文宽已由
   padding 夹出、随两根边界轴变化，v2-H 的正文手柄再留一根只会与右栏轴打架（它还按 max-width 改宽，与三栏冲突）。
   所以只要三栏态，手柄就不显示也不吃指针 —— display:none 必须 !important，手柄的 display:block 是拖拽时写进 style 的内联值。
   注意：只停「显示」，JSX 渲染与 startColResize / colWidth / --sa-read-col / data-read-col-dragged 全部保留，
   既有 http-assistant-reader-width 测试与 v2-H 能力（非三栏时）都不动。 */
.sa-knowledge-page:has(.sa-reader-pane[data-focus-three-col="true"])>.sa-read-splitter{display:none !important;pointer-events:none}
/* 三栏（2026-11-23，探针跑通后产品化）：只在 data-focus-three-col="true" 时改布局，
   默认态与既有选择器一字不动（:2022/:3047 的 padding、.sa-focus-header 的 200px 仍在）。 */
.sa-focus-header[data-focus-three-col="true"]{width:var(--sa-focus-rail,200px)}
.sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]{padding:18px calc(var(--sa-focus-chat,0px) + 18px) 18px calc(var(--sa-focus-rail,200px) + 12px)}
@media (max-width:720px){
 .sa-focus-header[data-focus-three-col="true"]{width:var(--sa-focus-rail,120px)}
 .sa-reader-pane[data-study-mode="true"][data-focus-three-col="true"]{padding:12px calc(var(--sa-focus-chat,0px) + 12px) 12px calc(var(--sa-focus-rail,120px) + 0px)}
}
/* 右栏（专注三栏的第三列）：顶部偏移走 --sa-focus-chat-top —— 进专注时按宿主顶栏高度让位，
   否则头部的「收起 ⟩」正好压在 DSH 顶栏下面点不到（用户 m02542 反馈 1）。 */
.sa-focus-chat{position:fixed;right:0;top:var(--sa-focus-chat-top,48px);bottom:0;z-index:2147483000;display:flex;flex-direction:column;gap:0;padding:0;box-sizing:border-box;overflow:hidden;width:var(--sa-focus-chat,360px);background-color:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm)}
.sa-focus-chat-inner{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;box-sizing:border-box}
.sa-focus-chat-head{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-2)}
.sa-focus-chat-head>strong{flex:1 1 auto;min-width:0;font-size:15px;line-height:1.4;word-break:break-word}
.sa-focus-chat-head .sa-btn{min-height:26px;padding:1px 8px;font-size:12px}
.sa-focus-chat-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:0 0 auto;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sa-focus-chat-model{flex:1 1 120px;min-width:0;font-size:12px;min-height:26px;box-sizing:border-box}
.sa-focus-chat-tools .sa-btn{min-height:26px;padding:1px 8px;font-size:12px}
.sa-focus-chat-log{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:10px}
.sa-focus-chat-msg{display:flex;flex-direction:column;gap:3px;min-width:0}
.sa-focus-chat-msg.user{align-items:flex-end}
.sa-focus-chat-msg.assistant{align-items:flex-start}
.sa-focus-chat-who{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-caption)}
.sa-focus-chat-bubble{max-width:88%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:max(var(--dsw-radius-md,8px),10px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box}
.sa-focus-chat-msg.user .sa-focus-chat-bubble{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-border-l2)}
.sa-focus-chat-compose{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-2)}
.sa-focus-chat-input{width:100%;min-height:56px;max-height:132px;resize:none;box-sizing:border-box;font-size:13px;line-height:1.6}
.sa-focus-chat-actions{display:flex;align-items:center;gap:8px}
.sa-focus-chat-actions .sa-focus-chat-note{margin-right:auto}
.sa-focus-chat-actions .sa-btn{min-height:30px;padding:3px 12px}
.sa-focus-chat-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-caption);padding:2px 0}
/* 三栏边界轴（2026-11-23 缺陷修复）：热区从 14px 提到 20px，与 .sa-read-splitter 同一手感
   （20px 宽居中在边界线上，够抓又不挡正文；竖线仍是中间 2px 的 ::before）。 */
.sa-focus-boundary{position:fixed;top:0;bottom:0;width:20px;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:2147483004;background:transparent}
.sa-focus-boundary::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:2px;transform:translateX(-50%);background:var(--dsw-alias-border-l1);opacity:.55;transition:opacity .15s ease,background .15s ease}
.sa-focus-boundary:hover::before,.sa-focus-boundary[data-dragging="true"]::before{opacity:1;background:var(--dsw-alias-brand-primary)}
.sa-focus-stub{position:fixed;top:50%;transform:translateY(-50%);z-index:2147483003;padding:7px 3px;font-size:12px;line-height:1.4;writing-mode:vertical-rl;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);cursor:pointer}
.sa-focus-stub[data-side="left"]{left:6px}
.sa-focus-stub[data-side="right"]{right:6px}
/* 掌握度预览的「确认修改 / 取消」（v2-B 卡，2026-11-20）。
   只在助手发出的预览消息下面出现一行按钮：**预览不落库，点了确认才发第二个请求**。
   刻意不加任何「处理中」式的可见状态文案（沿用 A1 精神：界面不替用户下结论）。 */
.sa-assist-proposal{display:flex;align-items:center;flex-wrap:wrap;gap:8px;max-width:86%;padding:6px 8px;border:1px dashed var(--dsw-alias-brand-primary);border-radius:max(var(--dsw-radius-sm,6px),8px);box-sizing:border-box}
.sa-assist-proposal .sa-muted{font-size:12px;margin-right:auto;line-height:1.5}
.sa-assist-proposal .sa-btn{min-height:28px;padding:2px 10px;font-size:13px}
.sa-assist-proposal .sa-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sa-assist-proposal[data-resolved="true"]{opacity:.5;border-style:solid;border-color:var(--dsw-alias-border-l1)}
.sa-assist-proposal .sa-btn[disabled]{cursor:default}
/* 批量清单（v2-B2 卡，2026-11-21）：一张可勾选的清单，超过 5 个折成「… 共 N 个」。
   与单点预览同一个「预览不落库」的壳，只是纵向排：清单 → 状态行 → 确认/取消。 */
.sa-assist-proposal-batch{flex-direction:column;align-items:stretch;gap:6px}
.sa-assist-batch-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.sa-assist-batch-head .sa-muted{font-size:12px;line-height:1.5;margin-right:auto}
.sa-assist-batch-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
.sa-assist-batch-row{display:flex;align-items:center;gap:6px;font-size:13px;line-height:1.6}
.sa-assist-batch-row input{flex:0 0 auto;margin:0;cursor:pointer}
.sa-assist-batch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-assist-batch-row .sa-muted{margin-left:auto;font-size:12px;white-space:nowrap}
.sa-assist-batch-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.sa-assist-batch-actions .sa-muted{font-size:12px;line-height:1.5;margin-right:auto}
/* 多会话（v2-C 卡，2026-11-21）：全局会话列表 + 新建/改名/归档。
   刻意不按主界面 4 大页签分，就是一个全局列表。归档=archived 标记位，默认隐藏、可切回。 */
.sa-asst-sessions{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);font-size:13px;line-height:1.5}
.sa-asst-sessions .sa-asst-cur{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sa-asst-sessions .sa-asst-cur .sa-asst-cur-sub{font-weight:400;color:var(--dsw-alias-label-caption);font-size:12px}
.sa-asst-sessions .sa-btn{min-height:26px;padding:1px 9px;font-size:12px}
.sa-asst-list{flex:0 0 auto;max-height:230px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:2px;padding:6px 8px}
.sa-asst-list-empty{font-size:13px;color:var(--dsw-alias-label-caption);padding:4px 2px}
.sa-asst-item{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:max(var(--dsw-radius-sm,6px),8px);cursor:pointer;border:1px solid transparent}
.sa-asst-item:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-asst-item[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.sa-asst-item[data-archived="true"]{opacity:.62}
.sa-asst-item-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.5}
.sa-asst-item-meta{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.sa-asst-item-acts{flex:0 0 auto;display:flex;gap:4px;opacity:0;transition:opacity .15s ease}
.sa-asst-item:hover .sa-asst-item-acts,.sa-asst-item:focus-within .sa-asst-item-acts{opacity:1}
.sa-asst-item-acts .sa-btn{min-height:22px;padding:0 7px;font-size:11px}
.sa-asst-rename{flex:1 1 auto;min-width:0;display:flex;gap:4px}
.sa-asst-rename input{flex:1 1 auto;min-width:0;font-size:13px;padding:2px 6px;box-sizing:border-box}
.sa-asst-list-foot{display:flex;align-items:center;gap:8px;padding:5px 8px 2px;font-size:12px;color:var(--dsw-alias-label-caption)}
.sa-asst-list-foot .sa-btn{min-height:24px;padding:1px 9px;font-size:12px;margin-left:auto}
.sa-assist-summary-line{font-size:12px;color:var(--dsw-alias-label-caption);line-height:1.5;padding:2px 0}
@media print{.sa-assist{display:none !important}}
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

    /**
     * 日程条目排序：有时间的按 `HH:mm` 升序，「全天」（time 为 null）排最后。
     * 与 `lib/core.js` 的 `buildDailyBrief` 同一口径——面板列表和推送文本的顺序不能两样。
     */
    function compareScheduleEntry(a, b) {
      if (a?.time === null && b?.time === null) return String(a?.title ?? '').localeCompare(String(b?.title ?? ''));
      if (a?.time === null) return 1;
      if (b?.time === null) return -1;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return String(a?.title ?? '').localeCompare(String(b?.title ?? ''));
    }

    // ---------------------------------------------------------------------
    // 「今日日程」四个分类版块（2026-11-19 A2 卡）
    // ---------------------------------------------------------------------
    //
    // 一张大卡里横排 4 个版块（学习 / 科创 / 生活 / 工作其他），课程、DDL、自定义日程
    // 都按分类塞进对应版块：
    //   - 自定义条目：分类存在 `日程.json` 的 `category`（缺省 work），用户可以改；
    //   - 课程 / DDL：分类是**渲染层算的**（关键词），用户改过的结果只写 localStorage
    //     覆盖表，**绝不写回 课程.json / 任务.json**（用户 2026-11-19 定）。
    // 空文档、旧数据、坏条目都在这里被挡掉，别把 undefined 渲染成一行。

    /** 分类键（与 lib/core.js 的 SCHEDULE_CATEGORIES 一字不差）。 */
    const SCHEDULE_CATEGORIES = ['study', 'innovation', 'life', 'work'];
    /** 分类的中文名：版块头、下拉选项、条目徽标共用这一份。 */
    const SCHEDULE_CATEGORY_LABEL = { study: '学习', innovation: '科创', life: '生活', work: '工作其他' };
    /**
     * 每个分类的配色**只用一个语义键**，样式表里映射到已有的 `.sa-pill` 色调令牌
     * （brand / business / success / secondary），不硬编码新颜色。
     */
    const SCHEDULE_CATEGORY_TONE = { study: 'cat-study', innovation: 'cat-innovation', life: 'cat-life', work: 'cat-work' };

    /**
     * 关键词表（用户 2026-11-19 定案的那份）。顺序有意义：**先判科创 / 生活 / 工作，
     * 都不命中才兜底「学习」**——「课程设计比赛」应该进科创，而「课程复习」进学习。
     */
    const SCHEDULE_KEYWORDS = {
      innovation: ['比赛', '竞赛', '大创', '挑战杯', '星火', '项目', '科研', '论文', '专利', '路演', '答辩', '创新创业'],
      life: ['社团', '聚会', '运动', '体育', '电影', '生日', '聚餐', '娱乐', '健身'],
      work: ['实习', '兼职', '面试', '招聘', '宣讲', '工作', '会议', '杂项'],
    };

    /**
     * 按关键词判一个标题属于哪个分类；**兜底 study**。
     *
     * 纯函数、不读存储：课程 / DDL 的「自动归类」和测试都直接调它。
     * @param {string} text 标题（可带科目名）
     * @returns {'study'|'innovation'|'life'|'work'}
     */
    function classifyByKeyword(text) {
      const hay = String(text ?? '');
      if (hay.trim() === '') return 'study';
      // 顺序：科创 → 生活 → 工作；学习是兜底，不单独匹配（否则「课程设计比赛」会被抢走）
      for (const category of ['innovation', 'life', 'work']) {
        for (const word of SCHEDULE_KEYWORDS[category]) {
          if (hay.includes(word)) return category;
        }
      }
      return 'study';
    }

    /**
     * 课程 / DDL 分类的本地覆盖表（localStorage）。
     *
     * 键形如 `course:c_ds` / `ddl:t_1`，值必须是四个分类之一；坏值一律丢掉（下次读时自愈）。
     * **不写回任务 / 课程数据**：覆盖只影响这张卡的摆放，换台机器就回到关键词判断。
     */
    const SCHEDULE_OVERRIDE_STORAGE_KEY = 'study-assistant:schedule-category-override';

    function safeLocalStorage() {
      try {
        return window?.localStorage ?? null;
      } catch {
        return null; // 隐私模式下读 localStorage 会抛，覆盖表就退化成「没有覆盖」
      }
    }

    function readCategoryOverrides(storage) {
      const target = storage === undefined ? safeLocalStorage() : storage;
      if (target === null || target === undefined || typeof target.getItem !== 'function') return {};
      let parsed = null;
      try {
        parsed = JSON.parse(target.getItem(SCHEDULE_OVERRIDE_STORAGE_KEY) ?? '{}');
      } catch {
        return {};
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key !== 'string' || !SCHEDULE_CATEGORIES.includes(value)) continue;
        out[key] = value;
      }
      return out;
    }

    function writeCategoryOverride(storage, key, category) {
      const target = storage === undefined ? safeLocalStorage() : storage;
      const next = { ...readCategoryOverrides(target) };
      if (SCHEDULE_CATEGORIES.includes(category)) next[key] = category;
      else delete next[key];
      if (target !== null && target !== undefined && typeof target.setItem === 'function') {
        try {
          target.setItem(SCHEDULE_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // 写不进去（配额满 / 隐私模式）就算了：界面这一次照样按新分类摆放
        }
      }
      return next;
    }

    /**
     * 板块内排序用的「一天中的第几分钟」。
     *
     * 课程数据只有节次（没有钟点），要跟自定义日程 / DDL 排在同一条时间轴上，
     * 只能按一张**近似作息表**把节次折算成分钟。它**只用于排序**：不显示、不入库、
     * 不参与任何判断；与实际作息不符时改这一处即可（其余代码不用动）。
     * 索引 = 节次（第 1 节 → 08:00，第 12 节 → 19:20）。
     */
    const PERIOD_START_MINUTES = [null, 480, 530, 590, 640, 690, 810, 860, 910, 960, 1010, 1110, 1160];

    /** `HH:mm` → 分钟；不是合法时刻返回 null。 */
    function minuteOfClock(value) {
      const matched = /^(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
      if (matched === null) return null;
      const hour = Number(matched[1]);
      const minute = Number(matched[2]);
      if (hour > 23 || minute > 59) return null;
      return hour * 60 + minute;
    }

    /** 课程节次 → 排序分钟（超出表的节次按第 12 节算，不造新值）。 */
    function minuteOfPeriod(period) {
      const slot = Number(period);
      if (!Number.isInteger(slot) || slot <= 0) return null;
      return PERIOD_START_MINUTES[slot] ?? PERIOD_START_MINUTES[PERIOD_START_MINUTES.length - 1];
    }

    /** 一条日程的时刻文案：`09:30–11:00` / `09:30` / `全天`。 */
    function scheduleTimeLabel(time, endTime) {
      if (typeof time !== 'string' || time === '') return '全天';
      return typeof endTime === 'string' && endTime !== '' ? `${time}–${endTime}` : time;
    }

    /**
     * 组装「今日日程」的四个版块（纯函数）。
     *
     * @param {{courses?: Array, tasks?: Array, entries?: Array, overrides?: object, now?: Date}} input
     *   `courses` —— 与 `todayCourses` 同形状（`{course, session}`）
     *   `tasks`   —— 已经按紧迫度排好的未完成任务（调用方决定取前几条）
     *   `entries` —— `日程.json` 里今天的条目
     *   `overrides` —— localStorage 覆盖表（`course:<id>` / `ddl:<id>` → category）
     * @returns {{blocks: Array<{category: string, label: string, tone: string, rows: Array<object>}>, total: number}}
     */
    function buildScheduleBoard(input) {
      const courses = Array.isArray(input?.courses) ? input.courses : [];
      const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
      const entries = Array.isArray(input?.entries) ? input.entries : [];
      const overrides = input?.overrides !== null && typeof input?.overrides === 'object' ? input.overrides : {};

      const rows = [];
      for (const item of courses) {
        const course = item?.course ?? null;
        const session = item?.session ?? null;
        if (course === null || session === null) continue;
        const id = String(course.id ?? '');
        if (id === '') continue;
        const start = Number(session.startPeriod);
        const end = Number(session.endPeriod);
        const span = Number.isInteger(start) && start > 0
          ? (Number.isInteger(end) && end > start ? `第 ${start}-${end} 节` : `第 ${start} 节`)
          : '节次未填';
        const category = SCHEDULE_CATEGORIES.includes(overrides[`course:${id}`])
          ? overrides[`course:${id}`]
          : classifyByKeyword(`${course.name ?? ''} ${Array.isArray(course.aliases) ? course.aliases.join(' ') : ''}`);
        rows.push({
          key: `course:${id}`,
          kind: 'course',
          id,
          category,
          title: String(course.name ?? ''),
          timeLabel: span,
          minutes: minuteOfPeriod(start),
          detail: {
            lines: [
              `${span}`,
              typeof session.location === 'string' && session.location.trim() !== '' ? `地点：${session.location.trim()}` : '',
              typeof course.teacher === 'string' && course.teacher.trim() !== '' ? `教师：${course.teacher.trim()}` : '',
              typeof session.weeks === 'string' && session.weeks.trim() !== '' ? `周次：${session.weeks.trim()}` : '',
            ].filter((line) => line !== ''),
            note: '',
            location: '',
            source: '',
          },
        });
      }

      for (const task of tasks) {
        if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue;
        const due = typeof task.due === 'string' ? task.due.trim() : '';
        const clock = /(\d{1,2}):(\d{2})/.exec(due);
        const clockText = clock === null ? '' : `${String(Number(clock[1])).padStart(2, '0')}:${clock[2]}`;
        const category = SCHEDULE_CATEGORIES.includes(overrides[`ddl:${task.id}`])
          ? overrides[`ddl:${task.id}`]
          : classifyByKeyword(`${task.title ?? ''} ${task.subjectName ?? ''}`);
        const urgency = deadlineUrgency(task, input?.now ?? new Date());
        rows.push({
          key: `ddl:${task.id}`,
          kind: 'ddl',
          id: task.id,
          category,
          title: String(task.title ?? ''),
          timeLabel: clockText !== '' ? clockText : (due === '' ? '无截止' : due),
          minutes: clockText === '' ? null : minuteOfClock(clockText),
          detail: {
            lines: [
              `截止：${due === '' ? '无截止日' : due}`,
              typeof task.subjectName === 'string' && task.subjectName !== '' ? `科目：${task.subjectName}` : '',
              `紧迫度：${urgencyText(urgency)}`,
            ].filter((line) => line !== ''),
            note: typeof task.note === 'string' ? task.note : '',
            location: '',
            source: '',
          },
        });
      }

      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
        const time = typeof entry.time === 'string' && entry.time.trim() !== '' ? entry.time.trim() : null;
        const endTime = typeof entry.endTime === 'string' && entry.endTime.trim() !== '' ? entry.endTime.trim() : null;
        const category = SCHEDULE_CATEGORIES.includes(entry.category) ? entry.category : 'work';
        rows.push({
          key: `entry:${entry.id}`,
          kind: 'entry',
          id: entry.id,
          category,
          title: String(entry.title ?? ''),
          timeLabel: scheduleTimeLabel(time, endTime),
          minutes: time === null ? null : minuteOfClock(time),
          detail: {
            lines: [
              typeof entry.date === 'string' ? `日期：${entry.date}` : '',
              typeof entry.location === 'string' && entry.location.trim() !== '' ? `地点：${entry.location.trim()}` : '',
            ].filter((line) => line !== ''),
            note: typeof entry.note === 'string' ? entry.note : '',
            location: typeof entry.location === 'string' ? entry.location : '',
            source: entry.source === 'auto-ai' ? 'auto-ai' : 'manual',
          },
        });
      }

      // 同一版块内：有钟点的按时间升序在前，没有钟点的（课程按节次、全天、无时刻 DDL）按
      // 「分钟为 null → 节次分钟 → 兜底」排在后面；再按标题稳定排序，避免每次渲染跳行。
      const sorted = rows.sort((a, b) => {
        const ka = a.minutes === null ? null : a.minutes;
        const kb = b.minutes === null ? null : b.minutes;
        if (ka !== kb) {
          if (ka === null) return 1;
          if (kb === null) return -1;
          return ka - kb;
        }
        return String(a.title).localeCompare(String(b.title));
      });

      const blocks = SCHEDULE_CATEGORIES.map((category) => ({
        category,
        label: SCHEDULE_CATEGORY_LABEL[category],
        tone: SCHEDULE_CATEGORY_TONE[category],
        rows: sorted.filter((row) => row.category === category),
      }));
      return { blocks, total: sorted.length };
    }

    /**
     * 把 `/schedule/parse` 的失败结果翻成一句人话（面板里直接显示）。
     *
     * 密钥相关的分支**只说「没读到密钥」和该看哪个文件**：密钥本身永远不出现在界面上。
     */
    function aiFailureText(result) {
      const code = typeof result?.error === 'string' ? result.error : '';
      const detail = typeof result?.detail === 'string' ? result.detail : '';
      if (code === 'ai-key-missing' || code === 'ai-key-unreadable') {
        return '没读到 AI 密钥（~/.dsh/.credentials.yaml 的 refs.PARATERA_API_KEY），智能识别暂不可用；手填表单不受影响。';
      }
      if (code === 'ai-bad-output' || code === 'ai-bad-title') {
        return `AI 没抽出可用的日程${detail === '' ? '' : `（${detail}）`}。表单已清空，请手动填。`;
      }
      if (code === 'ai-unavailable' || code === 'ai-timeout' || code === 'ai-rejected') {
        return `AI 通道暂时不通${detail === '' ? '' : `（${detail}）`}。表单已清空，请手动填或稍后再试。`;
      }
      if (code === 'schedule-parse-empty') return '先把要识别的那段话贴进来再点识别。';
      return `识别失败${detail === '' && code === '' ? '' : `（${detail || code}）`}。表单已清空，请手动填。`;
    }


    /** 某一天的日程条目（坏日期直接丢掉，别把 `undefined` 渲染成一行）。 */
    function scheduleEntriesOf(docs, day) {
      const target = formatDay(parseDay(day) ?? new Date());
      return objectList(docs?.schedule?.entries)
        .filter((entry) => typeof entry.date === 'string' && parseDay(entry.date) !== null && formatDay(parseDay(entry.date)) === target)
        .sort(compareScheduleEntry);
    }

    /** 今天之后 `days` 天内（不含今天）的日程条目，按日期 + 时间排：给「接下来」那一小段用。 */
    function upcomingScheduleEntries(docs, day, days = 7) {
      const today = parseDay(day);
      if (today === null) return [];
      const from = today.getTime();
      const until = from + days * 24 * 60 * 60 * 1000;
      return objectList(docs?.schedule?.entries)
        .filter((entry) => {
          const date = parseDay(entry?.date);
          if (date === null) return false;
          const t = date.getTime();
          return t > from && t <= until;
        })
        .sort((a, b) => {
          const da = parseDay(a.date).getTime();
          const db = parseDay(b.date).getTime();
          return da !== db ? da - db : compareScheduleEntry(a, b);
        });
    }

    /**
     * 复制文本到剪贴板。
     *
     * 面板挂在宿主的内网 http 页面上，`navigator.clipboard` 在非安全上下文里可能不存在，
     * 所以留一条 `textarea + execCommand` 的老路；两条都失败就返回 false，
     * 由调用方把文本原样摊开给用户手动复制——**不能假装复制成功了**。
     */
    async function copyTextToClipboard(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // 落到下面的兜底路径
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        area.style.top = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok === true;
      } catch {
        return false;
      }
    }

    // ---------------------------------------------------------------------
    // 页签：今日
    // ---------------------------------------------------------------------

    function TodayTab({ docs, now, refresh, busy, run, setBusy, onOpenKnowledgeReview, onOpenKnowledge, onOpenKnowledgeCoverage }) {
      const term = docs.term?.terms?.find((t) => t.id === docs.term?.currentId) ?? docs.term?.terms?.[0] ?? null;
      const week = currentTeachingWeek(term, now);
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

      // ---- 今日日程（2026-11-19 A 卡）：自定义日程 + 今日 DDL + 一键提醒 ----
      // 课程仍是上面那个 todayCourses；这里补第 14 份文档 `schedule` 的今日条目，
      // 以及推送按钮的状态。表单默认日期就是「今天」，改日期只影响这一条落在哪天。
      const todayEntries = useMemo(() => scheduleEntriesOf(docs, now), [docs.schedule, now]);
      const upcomingEntries = useMemo(() => upcomingScheduleEntries(docs, now, 7), [docs.schedule, now]);
      const todayDeadlineCount = useMemo(
        () => sorted.filter((task) => deadlineUrgency(task, now).level === 'today').length,
        [sorted, now],
      );

      const [draft, setDraft] = useState({
        date: '',
        time: '',
        endTime: '',
        title: '',
        note: '',
        location: '',
        category: 'study',
        source: 'manual',
      });
      const [scheduleNote, setScheduleNote] = useState(null);
      const [remindBusy, setRemindBusy] = useState(false);
      const [remindNote, setRemindNote] = useState(null);
      // 分类版块的展开状态（按条目 key 记，刷新后自然重置）与课程 / DDL 的本地覆盖表
      const [openRows, setOpenRows] = useState({});
      const [overrides, setOverrides] = useState(() => readCategoryOverrides());
      // AI 识别：粘贴框、状态提示、忙碌
      const [aiText, setAiText] = useState('');
      const [aiNote, setAiNote] = useState(null);
      const [aiBusy, setAiBusy] = useState(false);

      // 日期输入框的展示值：空串表示「没动过」，跟今天走（跨天刷新后自动落到新的一天）
      const draftDate = draft.date === '' ? formatDay(now) : draft.date;

      /**
       * 把草稿写回**空白表单**（失败路径用）。
       *
       * 「AI 失败 → 表单留空 + 报错」是用户 2026-11-19 定的第一硬规矩：宁可让用户从零手填，
       * 也不许把半截识别结果当成事实留在表单里被顺手提交。
       */
      const blankDraft = () => setDraft({
        date: '',
        time: '',
        endTime: '',
        title: '',
        note: '',
        location: '',
        category: 'study',
        source: 'manual',
      });

      const addScheduleEntry = () => {
        const title = draft.title.trim();
        if (title === '') {
          setScheduleNote({ kind: 'error', message: '日程标题不能为空。' });
          return;
        }
        if (draft.endTime !== '' && draft.time === '') {
          setScheduleNote({ kind: 'error', message: '填了结束时间，也要填开始时间；只想到一个钟点就把它填在「开始」。' });
          return;
        }
        if (draft.endTime !== '' && draft.time !== '' && draft.endTime <= draft.time) {
          setScheduleNote({ kind: 'error', message: '结束时间要晚于开始时间。' });
          return;
        }
        setScheduleNote(null);
        setBusy(true);
        // 与服务端 normalizeScheduleEntry 同一套字段：time 留空 → null（全天），
        // category / location / endTime / source 都是 A2 卡新增的可选字段。
        run(() => mutate('schedule', 'create', {
          item: {
            title,
            date: draftDate,
            time: draft.time === '' ? null : draft.time,
            endTime: draft.endTime === '' ? null : draft.endTime,
            location: draft.location.trim(),
            category: draft.category,
            source: draft.source,
            note: draft.note.trim(),
          },
        }))
          .then(async () => {
            setDraft({
              date: draftDate,
              time: '',
              endTime: '',
              title: '',
              note: '',
              location: '',
              category: 'study',
              source: 'manual',
            });
            setAiNote(null);
            setScheduleNote({ kind: 'ok', message: '已加进日程。' });
            await refresh();
          })
          .catch(() => {}) // run() 已经把错误挂到顶部横幅了，这里吞掉避免未处理 rejection
          .finally(() => setBusy(false));
      };

      const removeScheduleEntry = (entry) => {
        if (!window.confirm(`删除日程「${entry.title}」？`)) return;
        setBusy(true);
        run(() => mutate('schedule', 'delete', { id: entry.id }))
          .then(() => refresh())
          .catch(() => {})
          .finally(() => setBusy(false));
      };

      /**
       * 改一条的分类。
       *
       * - 自定义条目：分类是**数据**，直接 `POST /mutate` 改 `日程.json`；
       * - 课程 / DDL：分类是**渲染层的判断**，只写 localStorage 覆盖表 ——
       *   绝不写回 `课程.json` / `任务.json`（用户 2026-11-19 定的边界）。
       */
      const changeRowCategory = (row, category) => {
        if (!SCHEDULE_CATEGORIES.includes(category)) return;
        if (row.kind !== 'entry') {
          setOverrides(writeCategoryOverride(safeLocalStorage(), row.key, category));
          return;
        }
        setBusy(true);
        run(() => mutate('schedule', 'update', { id: row.id, item: { category } }))
          .then(() => refresh())
          .catch(() => {})
          .finally(() => setBusy(false));
      };

      const toggleRow = (key) => setOpenRows((previous) => ({ ...previous, [key]: previous[key] !== true }));

      /**
       * AI 识别：一段话 → 草稿 → **填进表单**。
       *
       * 只调 `POST /schedule/parse`，前端不拼 prompt、不碰密钥；返回 `ok:false` 时
       * 清空表单并报错，成功也只是「填表单」——入库永远要用户再点一次「添加」。
       */
      const parseWithAi = () => {
        const text = aiText.trim();
        if (text === '') {
          setAiNote({ kind: 'error', message: '先把要识别的那段话贴进上面的框。' });
          return;
        }
        if (aiBusy) return;
        setAiBusy(true);
        setAiNote(null);
        fetch(`${API}/schedule/parse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ text }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            return result;
          })
          .then((result) => {
            if (result.ok !== true) {
              blankDraft();
              setAiNote({ kind: 'error', message: aiFailureText(result) });
              return;
            }
            const item = result.draft ?? {};
            setDraft({
              date: typeof item.date === 'string' ? item.date : '',
              time: typeof item.time === 'string' ? item.time : '',
              endTime: typeof item.endTime === 'string' ? item.endTime : '',
              title: typeof item.title === 'string' ? item.title : '',
              note: '',
              location: typeof item.location === 'string' ? item.location : '',
              category: SCHEDULE_CATEGORIES.includes(item.category) ? item.category : 'study',
              source: 'auto-ai',
            });
            setAiNote({
              kind: 'ok',
              message: '识别完成：结果已填进下面表单，核对 / 改完再点「添加」才入库。没识别到的字段留空。',
            });
          })
          .catch((error) => {
            blankDraft();
            setAiNote({ kind: 'error', message: `识别请求失败：${String(error?.message ?? error)}。表单已清空，可手动填。` });
          })
          .finally(() => setAiBusy(false));
      };

      // 四个版块（学习 / 科创 / 生活 / 工作其他）：课程 + DDL（按紧迫度前 8 条）+ 今日自定义日程
      const board = useMemo(() => buildScheduleBoard({
        courses: todayCourses,
        tasks: sorted.slice(0, 8).map((task) => ({ ...task, subjectName: courseNameIn(courseIndex, task.courseId) })),
        entries: todayEntries,
        overrides,
        now,
      }), [todayCourses, sorted, todayEntries, overrides, now, courseIndex]);

      /**
       * AI 草稿预览条：只有「AI 刚填过、标题非空」时才出现。
       *
       * 它是**预览**而不是一条日程：虚线框 + 「AI 草稿，确认后入库」，提醒用户还没落盘。
       */
      const draftPreview = draft.source === 'auto-ai' && draft.title.trim() !== '' ? draft.title.trim() : null;

      /**
       * 一键提醒：只调后端 `POST /remind`，前端不碰任何 botId / token。
       * 后端回 `{ ok, channel, text }`；失败时 text 也带回来，这里先复制到剪贴板再提示
       * （用户 2026-11-19 定的兜底方案：复制 + 提示，复制不成就把文本摊开手动选）。
       */
      const remind = () => {
        if (remindBusy) return;
        setRemindBusy(true);
        setRemindNote(null);
        fetch(`${API}/remind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: '{}',
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok === true) {
              setRemindNote({
                kind: 'ok',
                message: result.channel === 'weixin'
                  ? '已推到微信（本人私聊）。'
                  : '微信没发出去，已回退 QQ（本人私聊）。',
              });
              return;
            }
            const text = typeof result.text === 'string' ? result.text : '';
            const copied = text === '' ? false : await copyTextToClipboard(text);
            setRemindNote({
              kind: 'error',
              message: [
                result.detail ?? result.error ?? '推送失败',
                copied ? '日程文本已复制到剪贴板，可直接粘贴发送。' : '没能自动复制，请手动全选下面的文本复制。',
              ].join('\n'),
              fallbackText: text,
              showText: text !== '' && !copied,
            });
          })
          .catch((error) => setRemindNote({ kind: 'error', message: `推送请求失败：${String(error?.message ?? error)}` }))
          .finally(() => setRemindBusy(false));
      };

      // ---- 今日要闻（2026-11-19 B 卡）----
      // 数据不是面板写出来的：插件外的 tools/fetch-news.mjs 由 Windows 计划任务每天 7:00 跑一次，
      // 抓公开源写进第 15 份文档 `要闻.json`；这里只读展示，点标题去原文。
      const [news, setNews] = useState(null);
      const [newsError, setNewsError] = useState(null);

      useEffect(() => {
        let alive = true;
        fetch(`${API}/news?days=7`, { headers: { Accept: 'application/json' } })
          .then((response) => response.json().catch(() => null))
          .then((payload) => {
            if (!alive || payload === null) return;
            if (payload.ok !== true) {
              setNewsError(payload.error === 'news-unreadable'
                ? '要闻文件读不出来（结构不符），请检查 学习台/要闻.json。'
                : `要闻读取失败：${String(payload.error ?? '未知原因')}`);
              return;
            }
            setNews(payload.board);
          })
          .catch(() => {
            if (alive) setNewsError('要闻暂时读不到（接口不通），不影响其它板块。');
          });
        return () => { alive = false; };
      }, []);

      // 来源徽标：用户 2026-11-19 定案「只做来源徽标」，不加上下文筛选、不做分类徽标
      const newsSources = useMemo(() => {
        if (news === null) return [];
        const counts = new Map();
        for (const item of news.items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
      }, [news]);

      const todaySummary = `${todayCourses.length} 节课 · ${todayEntries.length} 条日程 · ${todayDeadlineCount} 个今天到期`
        + (overdueCount > 0 ? ` · ${overdueCount} 个逾期` : '');

      return h(
        'div',
        null,
        h(Style),
        // 顶部那条「教学周 / 未完成 / 已逾期 / GPA」四格统计已按用户 2026-11-19 的要求删掉：
        // 这页是「今天该干什么」，周次与 GPA 属于「概况」，留在成绩页签看，不占今日页第一屏。
        term === null
          ? h('div', { className: 'sa-card sa-muted' }, TEXT.noTerm)
          : h('div', { className: 'sa-muted', style: { marginBottom: 10 } },
              `${term.name}　${formatDay(now)}　${TEXT.weekdays[isoWeekday(now)] ?? ''}` + (week.inTerm ? '' : term.startDate && parseDay(now) < parseDay(term.startDate) ? '（尚未开学）' : '（已放假）')),

        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock' },
            h('h3', { className: 'sa-grow' }, '今日日程'),
            h('span', { className: 'sa-muted' }, todaySummary),
            h('button', {
              className: 'sa-btn',
              disabled: busy || remindBusy,
              title: '把这份日程推到本人微信；微信不通自动改发 QQ',
              onClick: remind,
            }, remindBusy ? '推送中…' : '一键提醒'),
          ),
          remindNote === null
            ? null
            : h('div', { className: remindNote.kind === 'error' ? 'sa-note sa-note-error' : 'sa-note' },
                h('div', null, remindNote.message),
                remindNote.showText === true && typeof remindNote.fallbackText === 'string'
                  ? h('pre', null, remindNote.fallbackText)
                  : null),

          // 一、四个分类版块（2026-11-19 A2 卡）：课程 / DDL / 自定义日程统一摊进这张版块图。
          // 每条只占一行「起-止时间 + 标题」，点这一行展开详情（备注 / 地点 / 来源 / 删除），
          // 行右侧的小下拉改分类；课程与 DDL 的改动只落 localStorage，不写回数据文件。
          h('div', { className: 'sa-sub sa-sub-first' },
            h('div', { className: 'sa-dock' },
              h('h4', { className: 'sa-grow' }, '今日安排（按分类）'),
              h('span', { className: 'sa-muted' },
                `课程 ${todayCourses.length} · 日程 ${todayEntries.length} · DDL ${Math.min(sorted.length, 8)}`
                + (week.inTerm ? '' : ' · 今天不在教学周内'))),
            h('div', { className: 'sa-cat-grid' },
              board.blocks.map((block) => h('div', { className: 'sa-cat', key: block.category },
                h('div', { className: 'sa-cat-head' },
                  h('span', { className: `sa-pill ${block.tone}` }, block.label),
                  h('span', { className: 'sa-muted' }, `${block.rows.length} 条`),
                ),
                block.rows.length === 0
                  ? h('div', { className: 'sa-cat-empty' }, '—')
                  : block.rows.map((row) => {
                      const open = openRows[row.key] === true;
                      return h('div', { className: 'sa-cat-item', key: row.key },
                        h('div', { className: 'sa-cat-row' },
                          h('button', {
                            type: 'button',
                            className: 'sa-cat-main',
                            'aria-expanded': open ? 'true' : 'false',
                            title: open ? '收起详情' : '展开详情',
                            onClick: () => toggleRow(row.key),
                          },
                            h('span', { className: 'sa-cat-time', title: row.timeLabel }, row.timeLabel),
                            h('span', { className: 'sa-cat-title' }, row.title),
                            h('span', { className: 'sa-cat-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                          ),
                          h('select', {
                            className: 'sa-cat-select',
                            value: row.category,
                            disabled: busy,
                            title: row.kind === 'entry'
                              ? '改这条日程的分类（会写进 日程.json）'
                              : '改分类只影响这张卡的摆放，不改 课程.json / 任务.json',
                            'aria-label': `${row.title} 的分类`,
                            onClick: (e) => e.stopPropagation(),
                            onChange: (e) => changeRowCategory(row, e.target.value),
                          }, SCHEDULE_CATEGORIES.map((category) => h('option', { value: category, key: category }, SCHEDULE_CATEGORY_LABEL[category]))),
                        ),
                        open
                          ? h('div', { className: 'sa-cat-detail' },
                              row.detail.lines.map((line, index) => h('div', { className: 'sa-muted', key: index }, line)),
                              row.detail.note === '' ? null : h('div', { className: 'sa-cat-note' }, row.detail.note),
                              h('div', { className: 'sa-cat-meta' },
                                h('span', { className: 'sa-muted' },
                                  row.kind === 'entry'
                                    ? (row.detail.source === 'auto-ai' ? '来源：AI 识别后确认' : '来源：手动添加')
                                    : (row.kind === 'ddl' ? '来自「DDL」页签' : '来自课表')),
                                row.kind === 'entry'
                                  ? h('button', {
                                      className: 'sa-btn',
                                      disabled: busy,
                                      onClick: () => removeScheduleEntry(todayEntries.find((item) => item.id === row.id) ?? { id: row.id, title: row.title }),
                                    }, '删除')
                                  : null,
                              ),
                            )
                          : null,
                      );
                    }),
              )),
            ),
            sorted.length > 8
              ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 8 } },
                  `DDL 只摆紧迫度前 8 条（共 ${sorted.length} 个未完成），全量在「DDL」页签；今天到期 ${todayDeadlineCount}、逾期 ${overdueCount}。`)
              : null,
          ),

          // 二、自定义日程 + AI 识别：第 14 份文档 日程.json，增删改都走通用 /mutate（没有专用路由）。
          // AI 只负责把一段话填进下面的表单，入库要用户再点「添加」——绝不自动写盘。
          h('div', { className: 'sa-sub' },
            h('div', { className: 'sa-dock' },
              h('h4', { className: 'sa-grow' }, '自定义日程'),
              h('span', { className: 'sa-muted' }, `${todayEntries.length} 条`)),
            h('div', { className: 'sa-ai' },
              h('textarea', {
                className: 'sa-input sa-textarea',
                rows: 3,
                placeholder: '粘贴一段话，例如「明天下午三点在六教 3204 开小组会，讨论挑战杯初赛」。点「AI 识别」只会把结果填进下面的表单，不会自动入库。',
                value: aiText,
                onChange: (e) => setAiText(e.target.value),
              }),
              h('div', { className: 'sa-ai-bar' },
                h('button', { className: 'sa-btn', disabled: busy || aiBusy, onClick: parseWithAi }, aiBusy ? '识别中…' : 'AI 识别'),
                h('span', { className: 'sa-muted' }, '识别结果先进表单；没识别到的字段留空。失败时表单保持空白，不拿半成品入库。'),
              ),
            ),
            aiNote === null
              ? null
              : h('div', { className: aiNote.kind === 'error' ? 'sa-note sa-note-error' : 'sa-note' }, aiNote.message),
            draftPreview === null
              ? null
              : h('div', { className: 'sa-ai-preview' },
                  h('span', { className: `sa-pill ${SCHEDULE_CATEGORY_TONE[draft.category]}` }, SCHEDULE_CATEGORY_LABEL[draft.category]),
                  h('span', null, `${draftDate}　${draft.time === '' ? '全天' : scheduleTimeLabel(draft.time, draft.endTime)}`),
                  h('span', { className: 'sa-grow' }, draft.title.trim()),
                  draft.location.trim() === '' ? null : h('span', { className: 'sa-muted' }, draft.location.trim()),
                  h('span', { className: 'sa-muted' }, 'AI 草稿，确认后入库'),
                ),
            h('div', { className: 'sa-form' },
              h('select', {
                className: 'sa-input',
                title: '分类（必选）',
                'aria-label': '日程分类',
                value: draft.category,
                onChange: (e) => setDraft({ ...draft, category: e.target.value }),
              }, SCHEDULE_CATEGORIES.map((category) => h('option', { value: category, key: category }, SCHEDULE_CATEGORY_LABEL[category]))),
              h('input', {
                type: 'date', className: 'sa-input', value: draftDate, title: '日期',
                onChange: (e) => setDraft({ ...draft, date: e.target.value }),
              }),
              h('input', {
                type: 'time', className: 'sa-input', title: '开始时间；不填就是「全天」', style: { width: 108 }, value: draft.time,
                onChange: (e) => setDraft({ ...draft, time: e.target.value }),
              }),
              h('input', {
                type: 'time', className: 'sa-input', title: '结束时间（可选）', style: { width: 108 }, value: draft.endTime,
                onChange: (e) => setDraft({ ...draft, endTime: e.target.value }),
              }),
              h('input', {
                className: 'sa-input', placeholder: '地点（可选）', style: { width: 130 }, value: draft.location,
                onChange: (e) => setDraft({ ...draft, location: e.target.value }),
              }),
              h('input', {
                className: 'sa-input sa-form-title', placeholder: '日程标题（必填）', value: draft.title,
                onChange: (e) => setDraft({ ...draft, title: e.target.value }),
                onKeyDown: (e) => { if (e.key === 'Enter') addScheduleEntry(); },
              }),
              h('input', {
                className: 'sa-input', placeholder: '备注（可选）', style: { width: 130 }, value: draft.note,
                onChange: (e) => setDraft({ ...draft, note: e.target.value }),
              }),
              h('button', { className: 'sa-btn', disabled: busy, onClick: addScheduleEntry }, '添加'),
            ),
            scheduleNote === null
              ? null
              : h('div', { className: scheduleNote.kind === 'error' ? 'sa-note sa-note-error' : 'sa-note' }, scheduleNote.message),
            draftDate !== formatDay(now)
              ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 6 } }, `这条会记到 ${draftDate}，不会出现在今天的版块里。`)
              : null,
            upcomingEntries.length === 0
              ? null
              : h('div', { style: { marginTop: 10 } },
                  h('div', { className: 'sa-muted', style: { fontSize: 14 } }, `接下来 7 天还有 ${upcomingEntries.length} 条：`),
                  upcomingEntries.map((entry) => h('div', { className: 'sa-row', key: entry.id },
                    h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } },
                      `${formatMonthDay(parseDay(entry.date))}${entry.time === null ? '' : ` ${entry.time}`}`),
                    h('span', { className: 'sa-grow' }, entry.title),
                  )),
                ),
          ),
        ),

        // 今日要闻（2026-11-19 B 卡）：数据由计划任务每天 7:00 抓进 要闻.json，这里只读展示。
        // 标题行给「最近 N 天 M 条 + 抓取时间」与来源徽标；条目标题可点开原文（新标签、noopener）。
        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock' },
            h('h3', { className: 'sa-grow' }, '今日要闻'),
            h('span', { className: 'sa-muted' },
              news === null
                ? (newsError === null ? '读取中…' : '读取失败')
                : `最近 ${news.days} 天 ${news.shown} 条`
                  + (news.todayCount > 0 ? ` · 今天 ${news.todayCount}` : '')
                  + (news.fetchedClock === null ? '' : ` · 抓取于 ${news.fetchedClock}`)),
          ),
          newsError === null
            ? null
            : h('div', { className: 'sa-note sa-note-error' }, newsError),
          newsSources.length === 0
            ? null
            : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
                newsSources.map(([source, count]) => h('span', {
                  key: source,
                  className: 'sa-pill later',
                  style: { whiteSpace: 'nowrap' },
                  title: `${source}：${count} 条`,
                }, `${source} ${count}`)),
              ),
          news === null
            ? h('div', { className: 'sa-muted' }, newsError === null ? '正在读取要闻…' : '要闻读取失败，其它板块不受影响。')
            : news.items.length === 0
              ? h('div', { className: 'sa-muted' },
                  '最近 7 天没有抓到要闻。抓取脚本每天 7:00 跑一次（公开源：学发中心 / 清华新闻 / iCenter / 挑战杯），'
                  + `库里现存 ${news.total} 条。`)
              : news.items.slice(0, 20).map((item) => h('div', { className: 'sa-row', key: item.id },
                  h('span', { className: 'sa-pill later', style: { whiteSpace: 'nowrap' }, title: item.publishedAt },
                    item.publishedAt.slice(5)),
                  h('span', { className: 'sa-grow' },
                    h('a', {
                      href: item.url,
                      target: '_blank',
                      rel: 'noopener',
                      style: { color: 'inherit', textDecoration: 'underline' },
                    }, item.title),
                    item.excerpt === ''
                      ? null
                      : h('div', { className: 'sa-muted', style: { fontSize: 13, marginTop: 2 } }, item.excerpt)),
                  h('span', { className: 'sa-muted', style: { whiteSpace: 'nowrap' } }, item.source),
                )),
          news !== null && news.items.length > 20
            ? h('div', { className: 'sa-muted', style: { fontSize: 14, marginTop: 6 } }, `先给最近 20 条，共 ${news.items.length} 条。`)
            : null,
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
      const [credUser, setCredUser] = useState('');   // 统一身份认证账号（一键重连接口）
      const [credPass, setCredPass] = useState('');   // 统一身份认证密码（只活在本组件内存里，存完即清）

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
       * 会话自愈：一键重连 / 打开登录窗口（应急手动）/ 关掉后台浏览器。
       *
       * 「一键重连」是让「专用 Edge」自己再走一遍统一身份认证换张新 Cookie。
       * 2026-11-12 起它**静默**工作：信任浏览器的票过期时，插件会在后台（headless）
       * 打开 SSO、模拟点击登录（账号密码若存了就直接填），全程不弹窗 —— 除非风控
       * 弹了图形验证码，那种程序过不去，才需要「打开登录窗口」人工兜底。
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
              : result.source === 'silent-relogin'
                ? '已在后台模拟点击登录、换到了新会话，之后照常同步即可。'
                : '已经换到新的会话了，之后照常同步即可。',
          });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
          await reloadSession();
        } finally {
          setBusy(false);
        }
      };

      /** 存/清统一身份认证账号密码（供一键重连静默填表）。两个都空 = 撤销存储。 */
      const saveCredential = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await run(() => learnPost('credential', { user: credUser.trim(), pass: credPass }));
          setCredPass(''); // 存完就把明文密码从界面状态里清掉，别让它一直挂在内存里
          await reloadSession();
          setNotice({
            kind: 'ok',
            text: result.present === true
              ? '已保存账号密码：以后「一键重连」能在后台自动填表，全程不弹窗。'
              : '已清除保存的账号密码：「一键重连」将退回「只点登录按钮」或需要你手动登一次。',
          });
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
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
       * 「失效」不是要用户做什么 —— 心跳会自己静默重连；只有风控弹图形验证码那种
       * 极端情况才需要人点一下「打开登录窗口」，所以那句话指向按钮，而不是「请重新
       * 复制 Cookie」。2026-11-12 起一律**不红不弹**，失效也只温和地标一句。
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
            return { kind: 'muted', text: `会话有效${when === '' ? '' : `（${when} 验过）`}：学堂那边照样能同步（走直连）。后台那条哪天不顺了，点一下「一键重连」就能修复，不点也不影响用。` };
          }
          return { kind: 'muted', text: `会话有效${when === '' ? '' : `（${when} 验过）`}；${browser}。` };
        }
        if (session.alive === false) {
          // 一律不红（用户 2026-11-12 明确要彻底静默，不突然弹窗也不嚣张报红）。
          // 失效信息温和标一句，并指出「一键重连」；只有真需要人登（风控验证码）时
          // 才提示「打开登录窗口」。
          if (session.reason === 'needs-manual-login') {
            return { kind: 'muted', text: '这轮没自动接回来（可能要图形验证码）。点「一键重连」再试一次；还不行就点「打开登录窗口」手动登一次。' };
          }
          return { kind: 'muted', text: `会话这会儿没接上：点「一键重连」让后台静默换一张新的，多半就回来了（不弹窗）。` };
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
                  ? '后台静默重连：打开登录页，能自动填就填、能点就点（不弹窗）'
                  : '没找到 Edge，自动重连用不了；只能手动粘贴一次 Cookie',
                onClick: renewSession,
              }, busy ? '重连中…' : '一键重连'),
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: '风控弹了图形验证码、程序过不去时，在这里手动登录一次并勾「信任浏览器」',
                onClick: openLoginWindow,
              }, '打开登录窗口'),
              h('span', { className: 'sa-muted' }, '会话断了先点「一键重连」，多半在后台就自己接回来了'),
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
              // 会话自愈：平时不用管（心跳自己静默重连），失效时这几个按钮就是出路
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: session?.edgeAvailable === true
                  ? '后台静默重连：打开登录页，能自动填就填、能点就点（不弹窗）'
                  : '没找到 Edge，自动重连用不了；可以手动重新复制一次 Cookie',
                onClick: renewSession,
              }, busy ? '重连中…' : '一键重连'),
              h('button', {
                className: 'sa-btn',
                disabled: busy || session?.edgeAvailable !== true,
                title: '风控弹了图形验证码、程序过不去时，在这里手动登录一次并勾「信任浏览器」',
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

        // 会话那行字放在按钮下面：失效时它会指向「一键重连」，就近更好点
        sessionInfo === null
          ? null
          : h('div', {
              className: sessionInfo.kind === 'error' ? 'sa-error' : 'sa-muted',
              style: { marginTop: 6 },
            }, sessionInfo.text),

        // 统一身份认证账号密码（给「一键重连」静默填表用）。
        // 只在连着学堂时展示；存了会显示「已保存」，密码框永远不回显。
        connected
          ? h('details', { style: { marginTop: 8 } },
              h('summary', { className: 'sa-muted', style: { cursor: 'pointer' } },
                session?.credentialPresent === true
                  ? '账号密码：已保存（一键重连可全自动填表）'
                  : '账号密码：未保存（一键重连只能「点登录按钮」，风控时可手填）'),
              h('div', { className: 'sa-muted', style: { margin: '6px 0' } },
                '存一份统一身份认证的账号密码，掉登录时「一键重连」就能在后台自动填表、点登录，全程不弹窗。只存在本机（0600 独立文件），不进仓库、不进备份、不外传。'),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                h('input', {
                  className: 'sa-input',
                  style: { flex: '1 1 160px', minWidth: 140 },
                  placeholder: '学号 / 账号',
                  value: credUser,
                  disabled: busy,
                  autoComplete: 'username',
                  onChange: (e) => { setCredUser(e.target.value); setNotice(null); },
                }),
                h('input', {
                  className: 'sa-input',
                  style: { flex: '1 1 160px', minWidth: 140 },
                  type: 'password',
                  placeholder: '密码',
                  value: credPass,
                  disabled: busy,
                  autoComplete: 'current-password',
                  onChange: (e) => { setCredPass(e.target.value); setNotice(null); },
                }),
                h('button', {
                  className: 'sa-btn primary',
                  disabled: busy || credUser.trim() === '' || credPass === '',
                  onClick: saveCredential,
                }, '保存'),
                h('button', {
                  className: 'sa-btn',
                  disabled: busy || session?.credentialPresent !== true,
                  title: '清除已保存的账号密码（一键重连将退回只点登录按钮）',
                  onClick: async () => { setCredUser(''); setCredPass(''); await saveCredential(); },
                }, '清除'),
              ),
            )
          : null,

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
      // 老文案是「先跑一次同步」—— 2026-11-04 的故障证明那条建议无效：同步当时
      // 根本不写课程映射，用户照做之后还是这条错误。现在详情自己会补一次映射，
      // 能走到这里说明真补不上（课程名对不上），下一步应当是去核对课程名/加别名。
      'course-unmapped': '这门课还没和网络学堂对上号：去「网络学堂」里核对课程名，或换一次学期重新匹配。',
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
     * 为什么单独做纯函数：树/列表两处都要高亮，而「按什么规则切」一旦各写一份，
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
        node.expandable = !point && kind !== 'course';
        node.open = !node.expandable || expanded === null || expanded.has(key) || (kind === 'chapter' && legacyMatch);
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

    // ── 资料树（2026-10-30 W3b）──────────────────────────────────────
    // 资料页从平铺长列表升级成「学科 → 路径文件夹 → 文件」可折叠树。
    // 分组只从 item.path 的目录段派生（决策 D-W3-2 / D2：不改 资料索引.json schema），
    // kind 只作类型标签辅助；未知路径统一进「其他」，不丢文件。
    const MATERIAL_KIND_LABELS = Object.freeze({ homework: '作业', textbook: '教材', material: '资料', lecture: '讲义' });
    function materialKindLabel(kind) {
      const key = String(kind ?? '').trim();
      return MATERIAL_KIND_LABELS[key] ?? (key === '' ? '未标类型' : key);
    }
    function materialBaseName(p) {
      const norm = String(p ?? '').replace(/\\/gu, '/');
      const parts = norm.split('/').filter((s) => s !== '');
      return parts.length > 0 ? parts[parts.length - 1] : norm;
    }
    // 路径的目录段（去掉文件名，再去掉第一段「<学科>」目录）→ 分组键；没有目录段的落到「其他」
    function materialFolderKey(p) {
      const norm = String(p ?? '').replace(/\\/gu, '/').replace(/^\.\/+/u, '');
      const parts = norm.split('/').filter((s) => s !== '');
      const dirs = parts.slice(0, -1).slice(1); // 最后一段是文件名，第一段是学科目录
      return dirs.length === 0 ? '其他' : dirs.join('/');
    }
    // 悬停元信息（决策 D-W3-1：只显示类型 / 页数 / 更新时间；摘要暂无字段，不编造、不阻塞渲染）
    function materialMeta(item) {
      const donePages = Array.isArray(item?.ocr?.donePages) ? item.ocr.donePages.length : 0;
      const pages = Number(item?.ocr?.pages) || donePages;
      const updated = String(item?.ocr?.updatedAt ?? item?.updatedAt ?? '').trim();
      return [materialKindLabel(item?.kind), pages > 0 ? `${pages} 页` : '页数未知', updated === '' ? '' : `更新 ${updated}`]
        .filter((part) => part !== '').join(' · ');
    }
    /**
     * 把扁平 files 派生成「学科 → 路径文件夹 → 文件」。纯函数，测试直接验分组与「其他」兜底。
     * 返回 [{ id, name, count, groups: [{ id, name, count, files: [...] }] }]。
     */
    function buildMaterialsTree(files, courses) {
      const courseName = (id) => objectList(courses).find((c) => String(c?.id) === String(id))?.name ?? (id || '未匹配课程');
      const rankOrder = { '作业': 0, '教材': 1, '课件': 2, '课件PPT': 2, '讲义': 3, '其他': 99 };
      const courseMap = new Map();
      for (const item of objectList(files)) {
        if (!item || typeof item.path !== 'string' || item.path === '') continue;
        const cid = String(item.courseId ?? '');
        if (!courseMap.has(cid)) courseMap.set(cid, { id: cid, name: courseName(item.courseId), groups: new Map() });
        const entry = courseMap.get(cid);
        const folder = materialFolderKey(item.path);
        if (!entry.groups.has(folder)) entry.groups.set(folder, []);
        entry.groups.get(folder).push(item);
      }
      const rank = (name) => (Object.prototype.hasOwnProperty.call(rankOrder, name) ? rankOrder[name] : 50);
      return [...courseMap.values()].map((entry) => {
        const groups = [...entry.groups.entries()].map(([name, items]) => ({
          id: name,
          name,
          count: items.length,
          files: items.slice().sort((a, b) => materialBaseName(a.path).localeCompare(materialBaseName(b.path), 'zh')),
        })).sort((a, b) => (rank(a.name) - rank(b.name)) || a.name.localeCompare(b.name, 'zh'));
        return { id: entry.id, name: entry.name, groups, count: groups.reduce((n, g) => n + g.count, 0) };
      });
    }
    // expand 记忆的规范化：只保留 { 课程id: [分组键...] }；坏值一律丢掉（缺省不破坏旧快照）
    function cloneMaterialsExpand(value) {
      const out = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
      for (const [cid, list] of Object.entries(value)) {
        if (typeof cid !== 'string' || !Array.isArray(list)) continue;
        out[cid] = list.filter((x) => typeof x === 'string' && x !== '');
      }
      return out;
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
      // 资料树：搜索词（只筛文件名 + 科目，纯前端，决策 F2）与展开状态（按学科记，复用 readMaterialsUi）
      const [query, setQuery] = useState('');
      const [expand, setExpand] = useState(() => cloneMaterialsExpand(restoredMat.expand));

      const courseName = (id) => courses.find((item) => item.id === id)?.name ?? (id || '未匹配课程');
      const keep = (item) => courseId === '' || item?.courseId === courseId;

      // 换正文不卸旧内容（2026-10-29 晚，用户报障「点章/换讲义整块白闪，像换了一页」）：
      // detail 里留着上一份正文，新正文到之前只在标题栏挂一个「读取中…」；命中正文缓存就同步替换，
      // 一帧空窗都没有。后点的赢：慢响应回来时如果用户已经换了别的，就丢掉（seq 比大小）。
      const materialSeqRef = useRef(0);
      const showMaterial = async (materialPath, page) => {
        const seq = (materialSeqRef.current += 1);
        setOpenPath(materialPath);
        const cached = peekMaterialText(materialPath, page);
        if (cached !== undefined) {
          setDetail({ status: 'ready', data: cached, pending: false });
          return;
        }
        setDetail((current) => (current?.data === null || current?.data === undefined
          ? { status: 'loading', data: null, pending: false }
          : { ...current, pending: true }));
        const result = await materialTextCached(materialPath, page).catch(() => ({ ok: false, error: 'network' }));
        if (seq !== materialSeqRef.current) return;
        setDetail({ status: result.ok ? 'ready' : 'error', data: result, pending: false });
      };

      const pill = (text, level) => h('span', { className: `sa-pill ${level}` }, text);

      // 资料树文件夹展开/收起：某学科没有记录 = 默认全展开（老快照没有 expand 也照常显示全部文件）
      const isGroupOpen = (cid, gid) => {
        const stored = expand[cid];
        if (!Array.isArray(stored)) return true;
        return stored.includes(gid);
      };
      const toggleGroup = (cid, gid, allGids) => {
        const base = Array.isArray(expand[cid]) ? expand[cid].slice() : allGids.slice();
        const nextList = base.includes(gid) ? base.filter((x) => x !== gid) : base.concat(gid);
        const merged = { ...expand, [cid]: nextList };
        setExpand(merged);
        readMaterialsUi({ expand: merged });
      };

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

      // 记阅读位置（P3，决策 F2）：读到哪一份、哪一页 → POST /reading-position，
      // 落到 `学习台/学习记录/阅读位置.json`（节流 + 原子写，不进 /state、不进备份）。
      // 只记「真正渲染出来的页」，pending/loading 阶段不写；写失败静默，不打扰阅读。
      useEffect(() => {
        if (typeof openPath !== 'string' || openPath === '') return;
        if (detail?.status !== 'ready') return;
        const page = detail?.data?.page;
        if (!Number.isInteger(page) || page < 1) return;
        const owner = files.find((item) => item.path === openPath);
        saveReadingPosition({
          courseId: String(owner?.courseId ?? courseId ?? ''),
          path: openPath,
          page,
          scopeType: 'material',
        });
      }, [openPath, detail]);

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

      // ── 资料树（W3b）：学科 → 路径文件夹 → 文件，可折叠；叶子点击 = 打开正文（再点收起）──
      const leafRow = (item) => {
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
          className: 'sa-row sa-mat-leaf',
          // 悬停只给元信息（kind · 页数 · 更新时间），摘要暂无字段，不编造（决策 D-W3-1）
          title: materialMeta(item),
          style: { cursor: 'pointer', alignItems: 'flex-start', paddingLeft: 24 },
          onClick: () => (isOpen ? (setOpenPath(null), setDetail(null)) : showMaterial(item.path)),
        },
        h('span', { className: 'sa-grow', title: item.path },
          materialBaseName(item.path),
          h('div', { className: 'sa-muted', style: { fontSize: 13 } }, item.path)),
        h('span', { className: 'sa-pill soon' }, materialKindLabel(item.kind)),
        state,
        h('span', { className: 'sa-muted', style: { fontSize: 14 } }, isOpen ? '收起' : '看内容'));
      };
      // 搜索框只筛文件名 + 科目（决策 D-W3-3 / F2：不做路径关键字、不做全文检索）
      const q = query.trim().toLowerCase();
      const queryMatch = (item) => {
        if (q === '') return true;
        return materialBaseName(item.path).toLowerCase().includes(q)
          || courseName(item.courseId).toLowerCase().includes(q);
      };
      const treeSource = q === '' ? materialRows : materialRows.filter(queryMatch);
      const materialsTree = buildMaterialsTree(treeSource, courses);

      const materialList = materialRows.length === 0
        ? h('div', { className: 'sa-card sa-muted' }, emptyText.files)
        : h('div', { className: 'sa-card' },
          h('div', { className: 'sa-dock', style: { marginBottom: 8 } },
            h('input', {
              className: 'sa-input',
              type: 'search',
              value: query,
              placeholder: '搜索文件名 / 科目',
              'aria-label': '搜索资料文件名或科目',
              onChange: (event) => setQuery(event.target.value),
            }),
            q === '' ? null : h('span', { className: 'sa-muted', style: { fontSize: 13 } }, `命中 ${treeSource.length} 份`)),
          materialsTree.length === 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 8 } }, '没有匹配的资料，换个关键词试试。')
            : materialsTree.map((course) => h('div', { key: `course:${course.id}`, className: 'sa-mat-tree' },
              h('div', {
                className: 'sa-row sa-mat-course-row',
                style: { fontWeight: 650, borderBottom: '1px solid var(--dsw-alias-border-l1)' },
              },
              h('span', { className: 'sa-grow' }, course.name),
              h('span', { className: 'sa-muted', style: { fontSize: 13 } }, `${course.count} 份`)),
              course.groups.map((group) => {
                const open = q !== '' || isGroupOpen(course.id, group.id);
                const allGids = course.groups.map((g) => g.id);
                return h('div', { key: `group:${course.id}::${group.id}` },
                  h('div', {
                    className: 'sa-row sa-mat-folder-row',
                    style: { cursor: 'pointer', paddingLeft: 12 },
                    title: `${group.name}（${group.count} 份）`,
                    onClick: () => toggleGroup(course.id, group.id, allGids),
                  },
                  h('span', { className: 'sa-grow' },
                    `${open ? '▾' : '▸'} ${group.name}`,
                    h('span', { className: 'sa-muted', style: { fontSize: 13, marginLeft: 6 } }, `${group.count} 份`))),
                  open ? group.files.map(leafRow) : null);
              }))));


      // 正文卡改用共用的阅读面（W3a）：视图与知识点页同一套，状态仍留在本页签。
      const detailCard = MaterialReadingCard({
        detail,
        openPath,
        onPage: (no) => showMaterial(openPath, no),
        onClose: () => {
          setOpenPath(null);
          setDetail(null);
          readMaterialsUi({ openPath: null, openPage: null });
        },
        closeTitle: '关上这份正文（也可以按左上角「返回」回到上一个位置）',
      });


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
     * 抽出来后资料页只管「看原文、看题目」，这里只管「浏览树、标掌握度、读详解」。
     * 这一批只搬家不改行为：图 / 列表两种视图与批量标记原样保留，数据与接口都不动。
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
    function clampMindZoom(value) {
      const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(2, Math.max(0.001, n)) : 1;
    }
    function fitMindZoom(width, height, viewportWidth, viewportHeight) {
      if (![width,height,viewportWidth,viewportHeight].every(v => Number.isFinite(v) && v > 0)) return 1;
      return clampMindZoom(Math.min(1, Math.max(1,viewportWidth-24)/width, Math.max(1,viewportHeight-24)/height));
    }
    function subjectTreeState(memory, courseId) {
      const saved = memory && Object.prototype.hasOwnProperty.call(memory, courseId) ? memory[courseId] : null;
      const keys = (value, fallback) => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x !== '').slice(0,1000) : fallback;
      const coord = value => Number.isFinite(Number(value)) ? Math.max(0,Number(value)) : 0;
      const point = value => ({ left: coord(value?.left), top: coord(value?.top) });
      return { mindZoom: clampMindZoom(saved?.mindZoom), openTree: keys(saved?.openTree, ['course:' + courseId]), mindOpen: keys(saved?.mindOpen, []),
        scroll: { mind: point(saved?.scroll?.mind), tree: point(saved?.scroll?.tree) } };
    }
    function patchSubjectTree(memory, courseId, patch = {}) {
      const previous = subjectTreeState(memory, courseId);
      return { ...(memory || {}), [courseId]: subjectTreeState({ [courseId]: { ...previous, ...patch,
        scroll: { ...previous.scroll, ...(patch.scroll || {}) } } }, courseId) };
    }

    // 正文字号倍率（2026-10-29）：专注阅读里 A−/A+ 调的是这个倍率，1 = 完全跟随 DSH 设置里的
    // 「内容字号」。步长 1/16 在 16px 基准下正好 1px 一格，界面显示的是「基准 × 倍率」的整数 px。
    const READ_SCALE_STEP = 0.0625;
    // 学习时长最短落盘秒数（C2，2026-11-17）：与 lib/study-log.js 的 DURATION_MIN_SECONDS 同值。
    // 客户端只做提前拦截，服务端仍独立校验（<5 秒一律拒）。
    const DURATION_MIN_SECONDS = 5;
    const READ_SCALE_MIN = 0.75;
    const READ_SCALE_MAX = 1.75;
    /** 夹到合法区间并对齐步长（坏值一律回 1）。 */
    function clampReadScale(value) {
      const size = Number(value);
      if (!Number.isFinite(size)) return 1;
      const clamped = Math.min(READ_SCALE_MAX, Math.max(READ_SCALE_MIN, size));
      return Math.round(clamped / READ_SCALE_STEP) * READ_SCALE_STEP;
    }
    /** DSH 把设置里的「内容字号」发布在 body 的 --dsh-content-font-size 上（theme-presenter），取不到按 16px。 */
    function dshContentFontSize() {
      try {
        if (typeof document === 'undefined' || !document.body || typeof getComputedStyle !== 'function') return 16;
        const size = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size'));
        return Number.isFinite(size) && size >= 8 && size <= 48 ? size : 16;
      } catch (error) {
        return 16;
      }
    }
    /**
     * 「适应窗口」（2026-10-30）：把正文栏拉回设计行宽 80ch —— 窄面板缩小、宽面板放大，
     * 让一行还是 80 个字符上下，而不是跟着窗口一起变得又宽又挤。
     * 上下限沿用 A+/A− 那对常量：否则「适应窗口」能到的倍率 A+ 到不了，用户接着按 A+ 会莫名其妙跳一下。
     * 宽度量不到就返回 1（＝什么都不做），绝不把正文搞成 0 号字。
     */
    function fitReadScale(availableWidth, columnWidth) {
      const available = Number(availableWidth);
      const column = Number(columnWidth);
      if (!Number.isFinite(available) || !Number.isFinite(column) || available <= 0 || column <= 0) return 1;
      return clampReadScale(available / column);
    }
    /** 80ch 在当前基准字号下折成多少像素：让浏览器自己量（ch 随字体变），量不到按 1ch≈0.5em 估。 */
    function measureReadColumnWidth(basePx) {
      const fallback = basePx * 40;
      try {
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return fallback;
        const probe = document.createElement('span');
        if (!probe || !probe.style) return fallback;
        probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;width:80ch;font-size:${basePx}px`;
        probe.textContent = '0';
        document.body.appendChild(probe);
        const width = Number(probe.getBoundingClientRect?.().width);
        document.body.removeChild(probe);
        return Number.isFinite(width) && width > 0 ? width : fallback;
      } catch (error) {
        return fallback;
      }
    }
    /** 阅读区可用宽度（要减掉左右 padding，专注模式左右各 18px）；量不到就退回「等于栏宽」＝比例 1。 */
    function measureReadAvailableWidth(pane, columnWidth) {
      try {
        const width = Number(pane?.clientWidth);
        if (!Number.isFinite(width) || width <= 0) return columnWidth;
        let padding = 0;
        try {
          if (typeof getComputedStyle === 'function') {
            const style = getComputedStyle(pane);
            const left = Number.parseFloat(style?.paddingLeft);
            const right = Number.parseFloat(style?.paddingRight);
            if (Number.isFinite(left)) padding += left;
            if (Number.isFinite(right)) padding += right;
          }
        } catch (error) { /* 拿不到 padding 就按 0 算，宁可差几像素也不要抛错 */ }
        return Math.max(1, width - padding);
      } catch (error) {
        return columnWidth;
      }
    }

    const KP_UI_DEFAULTS = Object.freeze({ courseId: '', query: '', filter: 'all', view: 'mind', selected: null, openTree: [], mindOpen: null, masteryLevels: [], detailPath: null, treeCourseId: '', subjectTrees: {}, readScale: 1 });
    const KP_UI_FILTERS = ['all', 'unlearned', 'marked', 'due', 'unmounted', 'issues', 'noanalysis'];
    const KP_UI_VIEWS = ['tree', 'mind', 'graph', 'list'];
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
          // 旧会话可能存着已下线的 'explain'（2026-11-18 E 卡），落到「列表」而不是默认导图
          view: next.view === 'explain' ? 'list' : (KP_UI_VIEWS.includes(next.view) ? next.view : 'mind'),
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
          // 正文字号倍率（2026-10-29）：只记在内存里（刷新页面回默认），和上面这些界面状态同口径
          readScale: clampReadScale(next.readScale),
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
    // 2026-10-30 W3b：新增 expand 字段（{ [courseId]: string[] } 已展开分组键）。
    // 缺省 {} = 全部展开；坏值 / 旧快照没有该字段时按 {} 处理，不破坏 navSame 等值判断。
    const MATERIALS_UI_DEFAULTS = Object.freeze({ view: 'files', courseId: '', openPath: null, openPage: null, expand: {} });
    let materialsUiMemory = { ...MATERIALS_UI_DEFAULTS, expand: {} };

    function readMaterialsUi(patch = null) {
      if (patch && typeof patch === 'object') {
        const next = { ...materialsUiMemory, ...patch };
        const page = Number(next.openPage);
        materialsUiMemory = {
          view: next.view === 'questions' ? 'questions' : 'files',
          courseId: typeof next.courseId === 'string' ? next.courseId : '',
          openPath: typeof next.openPath === 'string' && next.openPath !== '' ? next.openPath : null,
          openPage: Number.isFinite(page) && page > 0 ? Math.floor(page) : null,
          expand: cloneMaterialsExpand(next.expand),
        };
      }
      return materialsUiMemory;
    }

    /** 清空资料页记忆（测试用）。 */
    function resetMaterialsUi() {
      materialsUiMemory = { ...MATERIALS_UI_DEFAULTS, expand: {} };
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
    // v2-E（2026-11-22）：专注学习模式的开关快照。`focusReading` 是 KnowledgeTab 里的 state，
    // 浮层的 buildAssistantContext 看不到它，所以学 navTabMemory 的做法在模块内存里记一份：
    // 进入专注置真，退出（Esc / 收起 / 切课程 / 切走页签导致组件卸载）一律置假；拿不到就当 false。
    let studyModeMemory = false;
    // v2-G（2026-11-22）：浮层聊天面板的深浅主题与「用户拖过的大小」。与 navTabMemory 同款做法：
    // 只活在模块内存里，**不落盘、不写学习台 JSON**（刷新页面 / 重启 DSH 即回默认 light + 360×460）。
    // 面板配色本来就是自己一套（--sa-assist-*，不跟宿主主题走），这两个变量就是它唯一的记忆。
    let assistThemeMemory = 'light';
    const ASSIST_SIZE_DEFAULT = Object.freeze({ w: 360, h: 460 });
    const ASSIST_SIZE_MIN = Object.freeze({ w: 280, h: 320 });
    let assistSizeMemory = { w: ASSIST_SIZE_DEFAULT.w, h: ASSIST_SIZE_DEFAULT.h };
    // v2-H（2026-11-23）：专注阅读正文列宽。null＝自动（沿用 CSS 的 90ch 居中，默认观感一字不动）；
    // 数字＝用户拖过之后的像素宽度。和 assistSizeMemory 同款：**只活在模块内存里，不落盘、不写学习台 JSON**。
    // 退出专注仍记住（再进去还是上次拖的宽度），刷新页面 / 重启 DSH 回 null＝90ch 居中。
    let readColumnWidthMemory = null;
    const READ_COLUMN_DEFAULT_CH = 90; // 现状上限（见 :3059/:3060 的 90ch），量不到真实列宽时按它换算起点
    const READ_COLUMN_MIN = 360;       // 最窄像素宽：再窄正文就挤成一条，读不下去

    /** 把一次拖拽算出的列宽夹进 [READ_COLUMN_MIN, 屏宽让位后的上限]；坏值（NaN/负数）一律回最窄，宁可小不撑破。 */
    function clampReadColumn(value, max) {
      const lo = READ_COLUMN_MIN;
      const hi = Math.max(lo, Math.round(Number(max) || lo));
      const num = Number(value);
      if (!Number.isFinite(num)) return lo;
      return Math.min(hi, Math.max(lo, Math.round(num)));
    }

    // 三栏探针（2026-11-23，最小可行性验证用，可弃）：专注学习模式左/中/右三栏的宽度与显隐。
    // 与 readColumnWidthMemory 同款：**只活在模块内存里，不落盘、不写学习台 JSON**；
    // 退出专注仍记住（再进去还是上次拖的宽度），刷新页面/重启 DSH 回默认。
    const FOCUS_RAIL_DEFAULT = 200;
    const FOCUS_RAIL_MIN = 120;
    const FOCUS_RAIL_MAX = 420;
    const FOCUS_CHAT_DEFAULT = 360;
    const FOCUS_CHAT_MIN = 260;
    const FOCUS_CHAT_MAX = 640;
    let focusLayoutMemory = { rail: FOCUS_RAIL_DEFAULT, chat: FOCUS_CHAT_DEFAULT, left: true, right: true };

    /** 把一次拖拽算出的栏宽夹进 [min, max]；坏值回 min，宁可小不撑破整个视口。 */
    function clampFocusSize(value, min, max) {
      const lo = Math.round(Number(min) || 0);
      const hi = Math.max(lo, Math.round(Number(max) || lo));
      const num = Number(value);
      if (!Number.isFinite(num)) return lo;
      return Math.min(hi, Math.max(lo, Math.round(num)));
    }

    // 块 A（2026-11-23）：右栏头顶要让出宿主顶栏的高度。
    // 为什么：专注面是 `inset:0` 的 fixed 覆盖层，右栏贴顶时头部的「收起 ⟩」正好落在 DSH 顶栏下面
    // （用户 m02542 反馈 1：按钮和顶栏重合、点不到）。进专注时先量一次，量不到用初值 64 兜底
    // —— 宁可多让一条空白，也不让按钮被顶栏吃掉；真机若还有偏差，只改这一个常量。
    const FOCUS_CHAT_TOP_FALLBACK = 64;
    const FOCUS_CHAT_TOP_MIN = 0;
    const FOCUS_CHAT_TOP_MAX = 96;
    // 量到的顶栏高度只留一份：窗口在专注中被拖动/缩放也不至于每帧重新量 DOM。
    let focusChatTopCache = null;

    /** 把让位高度夹进 [0, 96]；坏值/超范围一律回初值 48（宁可多让一条空白，也不把右栏顶到看不见）。 */
    function clampFocusChatTop(value) {
      const num = Number(value);
      if (!Number.isFinite(num) || num < FOCUS_CHAT_TOP_MIN || num > FOCUS_CHAT_TOP_MAX) return FOCUS_CHAT_TOP_FALLBACK;
      return Math.round(num);
    }

    /**
     * 量一次「宿主顶栏占掉的高度」（块 A）。
     *
     * 做法：取窗口顶边中点的那个元素，沿祖先链找**横贯大半屏、贴着顶、高度 24–96px**的那一层 ——
     * 专注面是 fixed 覆盖层，顶栏压在它上面，所以顶边中点命中的就是顶栏本身。
     * 量不到（顶栏不是 DOM 覆盖层 / 假 DOM / 宿主换皮）返回初值 48，**绝不抛错**：
     * 让位少了顶多按钮还贴着顶，让位多了只是多一条空白，都比渲染期抛错白屏好。
     */
    function readHostTopInset() {
      try {
        if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return FOCUS_CHAT_TOP_FALLBACK;
        if (typeof window === 'undefined') return FOCUS_CHAT_TOP_FALLBACK;
        const width = Number(window.innerWidth) || 0;
        if (width <= 0) return FOCUS_CHAT_TOP_FALLBACK;
        let node = document.elementFromPoint(Math.round(width / 2), 4);
        for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
          const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          const height = Number(rect?.height);
          const top = Number(rect?.top);
          const rWidth = Number(rect?.width);
          if (Number.isFinite(height) && Number.isFinite(top) && Number.isFinite(rWidth)
            && top <= 2 && height >= 24 && height <= FOCUS_CHAT_TOP_MAX && rWidth >= width * 0.5) {
            return clampFocusChatTop(height);
          }
          node = typeof node.parentElement === 'object' ? node.parentElement : null;
        }
        return FOCUS_CHAT_TOP_FALLBACK;
      } catch (error) {
        return FOCUS_CHAT_TOP_FALLBACK;
      }
    }

    /** 右栏 `--sa-focus-chat-top` 的值（带单位）。只量一次，之后吃缓存。 */
    function focusChatTopPx() {
      if (focusChatTopCache === null) focusChatTopCache = clampFocusChatTop(readHostTopInset()) + 'px';
      return focusChatTopCache;
    }

    /**
     * 量正文卡**当前的 max-width**（像素）。为什么要单量它：`.sa-card` 是 content-box（padding 20 + border 1），
     * 矩形宽 = max-width + 42px；`.sa-node-detail` 是 border-box（:2962），矩形宽 = max-width。
     * 拖拽起点若直接拿矩形宽当 max-width，`.sa-card` 会凭空多长 42px —— 分隔条跑在光标前面、拖起来发飘。
     * 统一按 max-width 折算，两种卡都是 1:1 跟手。量不到（max-width:none / 刚进专注没布局）回 0，调用方退回矩形宽。
     */
    function measureReadCardMaxWidth(pane) {
      try {
        if (!pane || !pane.children || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
        const kids = pane.children;
        for (let i = 0; i < kids.length; i += 1) {
          const kid = kids[i];
          const cls = typeof kid?.className === 'string' ? kid.className.split(/\s+/) : [];
          if (cls.indexOf('sa-node-detail') < 0 && cls.indexOf('sa-card') < 0) continue;
          const maxWidth = parseFloat(window.getComputedStyle(kid).maxWidth);
          if (Number.isFinite(maxWidth) && maxWidth > 0) return maxWidth;
        }
        return 0;
      } catch (error) {
        return 0; // 拿不到 computed style 就当没有：起点退回矩形宽，绝不抛错打断拖拽
      }
    }

    /** 量专注面里第一张正文卡（`.sa-node-detail` / `.sa-card` 直接子节点）的真实像素宽。
        这是 measureReadCardMaxWidth 拿不到 max-width 时的兜底口径；量不到回 0，调用方退回 90ch 换算。 */
    function measureReadPaneColumnWidth(pane) {
      try {
        if (!pane || typeof pane.getBoundingClientRect !== 'function') return 0;
        const kids = pane.children;
        if (!kids || typeof kids.length !== 'number') return 0;
        for (let i = 0; i < kids.length; i += 1) {
          const kid = kids[i];
          const cls = typeof kid?.className === 'string' ? kid.className.split(/\s+/) : [];
          if (cls.indexOf('sa-node-detail') < 0 && cls.indexOf('sa-card') < 0) continue;
          const rect = typeof kid.getBoundingClientRect === 'function' ? kid.getBoundingClientRect() : null;
          const width = Number(rect?.width);
          if (Number.isFinite(width) && width > 0) return width;
        }
        return 0;
      } catch (error) {
        return 0; // 量不到就当没有：起点退回换算值，绝不抛错打断拖拽
      }
    }

    /** 把一次拖拽算出的边长夹进 [min, max]；拿不到数字就退回 min（宁可小，也不撑破外层）。 */
    function clampAssistSize(value, min, max) {
      const lo = Math.max(1, Math.round(Number(min) || 0));
      const hi = Math.max(lo, Math.round(Number(max) || lo));
      const num = Number(value);
      if (!Number.isFinite(num)) return lo;
      return Math.min(hi, Math.max(lo, Math.round(num)));
    }

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
    // 2026-10-27 晚：`{2,}` → `+?`（非贪婪、允许 1 个字）、并补 `$$…$$`。
    // 缘由：物理与数据结构里大量单字母公式（`$v$`、`$s$`、`$n$`）原先落选，
    // 于是 `$` 与**后一个** `$` 跨段配对（`$s$ 到 $v$` → 把「到」当公式），
    // 真正的公式段反而留在外面，`\rho`、`\Omega` 全以源码露出来 —— 实测 150/982 个点中招。
    const INLINE_MARK_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\$\$[^$\n]+\$\$|\$[^$\n]+?\$)/gu;
    const analysisInline = (text, keyPrefix = 'in') => String(text ?? '')
      .split(INLINE_MARK_PATTERN)
      .filter((part) => part !== '')
      .map((part, index) => {
        const key = `${keyPrefix}-${index}`;
        // 2026-10-27 晚：粗体/斜体内部**再解析一遍**。原先这里直接塞纯文本，于是
        // `**对长度 $n$ 的查找链…**` 这类「粗体里套公式」会把 `$n$` 原样印出来。
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h('strong', { key }, ...analysisInline(part.slice(2, -2), `${key}-b`));
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return h('em', { key }, ...analysisInline(part.slice(1, -1), `${key}-i`));
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return backtickNodes(part.slice(1, -1), key);
        }
        // 2026-10-31（修「$$…$$ 漏一个 $」）：INLINE_MARK_PATTERN 会把 `$$…$$` 整体匹配成一个
        // part，但以前这里只 slice(1,-1) 剥掉一层 `$`，剩下的 `$…$` 首尾还各留一个字面 `$`；
        // 而 latexRender 的 LATEX_SYMBOL 把字面 `$` 原样输出，屏幕上就变成 `$Y = A ⊕ …$`——
        // 数电第02章讲义那句「代码原文」正是它（行内 `$…$` 正常，只有 `$$…$$` 中招）。
        // `$$…$$` 必须先于单个 `$` 判断，且剥两层（slice(2,-2)）。
        if (part.length > 4 && part.startsWith('$$') && part.endsWith('$$')) {
          return h('span', { key, style: MATH_INLINE_STYLE },
            ...latexNodes(part.slice(2, -2), `${key}-math`));
        }
        if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) {
          return h('span', { key, style: MATH_INLINE_STYLE },
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
      times: '×', cdot: '·', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱', dotsb: '…', div: '÷', pm: '±', mp: '∓', circ: '∘',
      infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', therefore: '∴', because: '∵',
      angle: '∠', perp: '⊥', parallel: '∥', mid: '|', nmid: '∤', langle: '⟨', rangle: '⟩',
      lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮',
      prime: '′', colon: '：', backslash: '＼', rhd: '⊳', models: '⊨', preccurlyeq: '≼', star: '⋆',
      // 2026-10-29：箭头系与零散符号以前会落到「认不出的命令只留名字」把名字印出来
      longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷', Longleftarrow: '⟸', Leftarrow: '⇐',
      uparrow: '↑', downarrow: '↓', updownarrow: '↕', nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖',
      longmapsto: '⟼', leadsto: '⇝', hookrightarrow: '↪', rightleftharpoons: '⇌', leftrightharpoons: '⇋',
      odot: '⊙', ominus: '⊖', oslash: '⊘', bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀',
      lvert: '|', rvert: '|', vert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
      checkmark: '✓', blacksquare: '∎', square: '□', triangle: '△', bigtriangleup: '△',
      gtrsim: '≳', lessapprox: '⪅', gtrapprox: '⪆', prec: '≺', succ: '≻', precsim: '≾', succsim: '≿',
      sqcup: '⊔', sqcap: '⊓', uplus: '⊎', supsetneq: '⊋', varpi: 'ϖ', wp: '℘', ell: 'ℓ', hbar: 'ℏ',
      '\\': ' ', '|': '‖', '%': '%', '&': '&', '{': '{', '}': '}', '$': '$', '#': '#', '_': '_',
    };
    const LATEX_SPACING = { quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ' };
    /** 2026-10-29：带注解的箭头（`A \xrightarrow{\text{舍去进位}} B`），注解排在箭头上方。 */
    const XARROW_SYMBOL = {
      xrightarrow: '→', xleftarrow: '←', xleftrightarrow: '↔', xRightarrow: '⇒', xLeftarrow: '⇐',
      xLeftrightarrow: '⇔', xlongequal: '=', xlongrightarrow: '⟶', xlongleftarrow: '⟵',
    };
    const LATEX_IGNORED = new Set(['left', 'right', 'bigl', 'bigr', 'big', 'Big', 'Bigg', 'biggl', 'biggr',
      'Bigl', 'Bigr', 'Biggl', 'Biggr', 'bigm', 'Bigm',
      'displaystyle', 'textstyle', 'limits', 'nolimits', 'mathstrut', 'begin', 'end', 'nonumber', 'notag',
      // 2026-10-29：环境的横线/表尾命令，以前会落到「认不出的命令只留名字」把 hline 印出来
      'hline', 'cline', 'toprule', 'midrule', 'bottomrule', 'endhead', 'endfirsthead', 'endfoot',
      'tabularnewline', 'arraybackslash', 'centering', 'raggedright']);
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
    /**
     * 正体（非斜体）的**公式外壳**：∫、Σ、∏、√ 这类符号要直立，不能跟着变量斜。
     * 2026-11-12：行内公式改成「衬线斜体」之后，这些符号得反着标回去。
     */
    const MATH_UPRIGHT_STYLE = { fontStyle: 'normal', fontFamily: 'Georgia, "Times New Roman", serif' };
    const mathUpright = (text) => h('span', { style: MATH_UPRIGHT_STYLE }, text);
    /** `∫`、`∮` 这类积分符号再大一号、不跟着变量斜。 */
    const mathBigOp = (text) => h('span', { style: { ...MATH_UPRIGHT_STYLE, fontSize: '1.18em', lineHeight: '1' } }, text);
    /** 叠在积分号右边上下角的限（`∫_{-π/2}^{π/2}`）：小一号、正体、不斜。 */
    const mathLimit = (body) => h('span', { style: { ...MATH_UPRIGHT_STYLE, fontSize: '0.72em', lineHeight: '1' } }, ...body);
    /** 2026-11-12：大算子分两档——`\sum` 一类限写在正上下，`\int` 一类限落在右边上下角。 */
    const LATEX_BIGOP_STACK = new Set(['sum', 'prod', 'coprod', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigodot', 'bigvee', 'bigwedge']);
    const LATEX_BIGOP_SIDE = new Set(['int', 'iint', 'iiint', 'oint']);
    const latexRender = (tex, keyPrefix = 'm', options = {}) => {
      const source = String(tex ?? '').replace(/\r/gu, ' ');
      let cursor = 0;
      let serial = 0;
      const nextKey = () => `${keyPrefix}-${serial += 1}`;
      const skipSpace = () => {
        while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      };
      const fractionNode = (numerator, denominator) => h('span', {
        key: nextKey(),
        // `whiteSpace: 'nowrap'`：分式的分子/分母内部一律不折行（否则窄栏里分子会掉到横线下面）。
        style: { display: 'inline-flex', flexDirection: 'column', verticalAlign: 'middle', textAlign: 'center', margin: '0 3px', lineHeight: 1.25, whiteSpace: 'nowrap' },
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
      // ── 环境排版（2026-10-29）───────────────────────────────────────────────────────
      // 以前 `\begin`/`\end` 只吃掉环境名、内容平铺，于是数电讲义第01章第 105/144 行被印成
      // `[N]原 = N & (0 ≤ N < 2ⁿ⁻¹) …`、`r@ l & 10101011 (-85) + … hline 1 & 01111001`。
      // 这里按 LaTeX 语义真排版：`\\` 断行、`&` 分列、`\hline` 画横线、列格式串决定对齐与竖线，
      // `cases` 加可伸缩大括号，`pmatrix` 系加可伸缩括号，`aligned` 按 `&` 右侧对齐。
      /** 读一个 `{…}` 组并**原样**返回（环境名、列格式串这类不该当正文排的东西）。 */
      const readRawGroup = () => {
        skipSpace();
        if (cursor >= source.length || source[cursor] !== '{') return '';
        const start = cursor + 1;
        let depth = 1;
        let index = start;
        while (index < source.length) {
          const ch = source[index];
          if (ch === '\\') { index += 2; continue; }
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) { cursor = index + 1; return source.slice(start, index); }
          }
          index += 1;
        }
        cursor = source.length;
        return source.slice(start);
      };
      /** `\left` 的落点：按 `\left`/`\right` 配对计数，返回配对 `\right` 的下标（不配对给 -1）。 */
      const findMatchingRight = (from) => {
        const pattern = /\\(left|right)(?![A-Za-z])/gu;
        pattern.lastIndex = from;
        let depth = 1;
        let match;
        while ((match = pattern.exec(source)) !== null) {
          if (match[1] === 'left') depth += 1;
          else { depth -= 1; if (depth === 0) return match.index; }
        }
        return -1;
      };
      /** `\left` / `\right` / `\middle` 后面那**一个**定界符，原样返回（`\{` `(` `|` `\|` `.` …）。 */
      const readDelimiter = () => {
        skipSpace();
        if (cursor >= source.length) return '';
        if (source[cursor] !== '\\') { cursor += 1; return source[cursor - 1]; }
        const word = /^\\([A-Za-z]+)/u.exec(source.slice(cursor));
        if (word !== null) { cursor += 1 + word[1].length; return `\\${word[1]}`; }
        cursor += 2;
        return source.slice(cursor - 2, cursor);
      };
      /** 可伸缩定界符的路径（viewBox 固定 10×100，靠 preserveAspectRatio 拉高）。 */
      const DELIMITER_PATHS = {
        // 2026-11-12：`paren` 一族以前漏了（只有字符兜底），`\left( … \right)` 整对括号消失。
        paren: ['M8.6,2 C2.6,18 2.6,82 8.6,98', 'M1.4,2 C7.4,18 7.4,82 1.4,98'],
        bracket: ['M8.4,2 L3.4,2 L3.4,98 L8.4,98', 'M1.6,2 L6.6,2 L6.6,98 L1.6,98'],
        lbrace: ['M8.6,2 C4.2,2 4.8,5 4.8,11 L4.8,40 C4.8,47 3.6,50 1.6,50 C3.6,50 4.8,53 4.8,60 L4.8,89 C4.8,95 4.2,98 8.6,98',
          'M1.4,2 C5.8,2 5.2,5 5.2,11 L5.2,40 C5.2,47 6.4,50 8.4,50 C6.4,50 5.2,53 5.2,60 L5.2,89 C5.2,95 5.8,98 1.4,98'],
        vert: ['M5,0 L5,100', 'M5,0 L5,100'],
        doublevert: ['M3.4,0 L3.4,100', 'M6.6,0 L6.6,100'],
        angle: ['M8.4,2 L2.6,50 L8.4,98', 'M1.6,2 L7.4,50 L1.6,98'],
        floor: ['M8.4,2 L3.4,2 L3.4,98', 'M1.6,2 L6.6,2 L6.6,98'],
        ceil: ['M8.4,98 L3.4,98 L3.4,2', 'M1.6,98 L6.6,98 L6.6,2'],
      };
      /** 没有 SVG 路径时的**字符兜底**（括号这种一字宽的没必要画矢量）。 */
      const DELIMITER_TEXT = {
        paren: ['(', ')'], bracket: ['[', ']'], lbrace: ['{', '}'], vert: ['|', '|'],
        doublevert: ['‖', '‖'], angle: ['⟨', '⟩'], floor: ['⌊', '⌋'], ceil: ['⌈', '⌉'],
      };
      const DELIMITER_KINDS = {
        '(': 'paren', ')': 'paren', '[': 'bracket', ']': 'bracket', '|': 'vert',
        '\\|': 'doublevert', '\\{': 'lbrace', '\\}': 'lbrace',
        '\\langle': 'angle', '\\rangle': 'angle',
        '\\lfloor': 'floor', '\\rfloor': 'floor', '\\lceil': 'ceil', '\\rceil': 'ceil',
        '\\lvert': 'vert', '\\rvert': 'vert', '\\lVert': 'doublevert', '\\rVert': 'doublevert',
      };
      /** 画一个可伸缩定界符；`side` 决定左右（同一族的两条路径是镜像）。 */
      const delimiterNode = (kind, side) => {
        const paths = DELIMITER_PATHS[kind];
        const plain = DELIMITER_TEXT[kind];
        // 2026-11-12 修：`\left( … \right)` 以前没有 `paren` 一族的路径 → `delimiterNode` 返回 null，
        // 整对括号在屏幕上凭空消失（`(4π ε₀ r²)` 印成 `4π ε₀ r²`）。
        // 现在：**小写括号类**（`(` `[` `|` `{`）直接用字符（随字号缩放，最稳）；
        // **大括号/bmatrix 那种要包多行的高定界符**才画 SVG（字符拉伸后下缘会掉到基线以下）。
        const smallKind = kind === 'paren' || kind === 'bracket' || kind === 'vert' || kind === 'lbrace' || kind === 'floor' || kind === 'ceil';
        if (smallKind || paths === undefined) {
          if (plain === undefined) return null;
          if (plain[0] === plain[1]) return plain[side === 'left' ? 0 : 1];
          return h('span', {
            key: nextKey(),
            style: { display: 'inline-block', transform: 'scaleY(1.15)', transformOrigin: 'center', lineHeight: 1 },
          }, plain[side === 'left' ? 0 : 1]);
        }
        return h('svg', {
          key: nextKey(),
          viewBox: '0 0 10 100',
          preserveAspectRatio: 'none',
          // 2026-11-12：`width: 9` 少了单位 → 被当成非法值忽略，SVG 退化成 300×150 的默认尺寸，
          // 分式右半截被撑出屏幕。改成 `9px`；`alignSelf: center` + `height: 1em` 不让它撑高父容器。
          style: { width: '9px', height: '1em', alignSelf: 'center', flex: '0 0 auto', overflow: 'visible', color: 'currentColor' },
        }, h('path', {
          key: nextKey(),
          d: side === 'left' ? paths[0] : paths[1],
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }));
      };
      /** 「定界符 + 内容 + 定界符」；两边都没有就只返回内容本身。 */
      const wrapDelimiters = (openKind, closeKind, content) => {
        const open = openKind === null ? null : delimiterNode(openKind, 'left');
        const close = closeKind === null ? null : delimiterNode(closeKind, 'right');
        // 2026-11-12 修：`\left(` 的 kind 是 `(`；除号是 `/`。以前 `content` 与 `open`/`close` 之外
        // 还有一段「把内容再拼一次」的旧分支，导致 `(4π ε₀ r²` 后面多出一个 `)`（屏幕上就是
        // 「(4π ε₀ r²)  )」）。这里只渲 open + content + close 各一次，直接返回。
        if (open === null && close === null) return content;
        // 定界符只拉伸到内容高度（`alignItems: center` + `nowrap`）。**不要**在这里用
        // `inline-block` 包内容：那会让 `(4π ε₀ r²)` 变成一个整体不可断行的块，
        // 行内公式一长就把整行撑成两行（用户截图里 `E =` 孤零零一行、分式掉到下一行）。
        return h('span', {
          key: nextKey(),
          style: { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', gap: '1px', whiteSpace: 'nowrap' },
        }, open, content, close);
      };
      /**
       * 按 `\\`（mode='row'）或 `&`（mode='cell'）切分，**只在顶层**切：
       * 花括号里、嵌套环境里（`cases` 里套 `matrix`）的一律不动。
       */
      const scanTopLevel = (text, mode) => {
        const parts = [];
        let current = '';
        let braces = 0;
        let envs = 0;
        for (let index = 0; index < text.length; index += 1) {
          const ch = text[index];
          if (ch === '\\') {
            const nest = /^\\(begin|end)\s*\{([^{}]*)\}/u.exec(text.slice(index, index + 48));
            if (nest !== null) {
              envs += nest[1] === 'begin' ? 1 : -1;
              current += nest[0];
              index += nest[0].length - 1;
              continue;
            }
            if (mode === 'row' && text[index + 1] === '\\' && braces === 0 && envs === 0) {
              parts.push(current);
              current = '';
              index += 1;
              const gap = /^\s*\[[^\]\n]*\]/u.exec(text.slice(index + 1));
              if (gap !== null) index += gap[0].length;
              continue;
            }
            current += ch;
            continue;
          }
          if (ch === '{') braces += 1;
          else if (ch === '}') braces = Math.max(0, braces - 1);
          if (mode === 'cell' && ch === '&' && braces === 0 && envs === 0) {
            parts.push(current);
            current = '';
            continue;
          }
          current += ch;
        }
        parts.push(current);
        return parts;
      };
      /** 环境体 → 行（每行带「上边有没有横线」的标记），`\hline` 单独成行也算。 */
      const collectEnvRows = (body) => {
        const rows = [];
        let pendingTop = false;
        for (const raw of scanTopLevel(body, 'row')) {
          let text = raw;
          let matchedTop = false;
          let rule;
          while ((rule = /^\s*(?:\\hline\b|\\toprule\b|\\midrule\b|\\bottomrule\b|\\cline\s*\{[^{}]*\})/u.exec(text)) !== null) {
            matchedTop = true;
            text = text.slice(rule[0].length);
          }
          const tail = /\s*(?:\\hline\b|\\toprule\b|\\midrule\b|\\bottomrule\b)+$/u.exec(text);
          let tailRule = false;
          if (tail !== null) { tailRule = true; text = text.slice(0, tail.index); }
          const top = pendingTop || matchedTop;
          pendingTop = tailRule;
          if (text.trim() === '') {
            if (top) pendingTop = true;
            continue;
          }
          rows.push({ cells: scanTopLevel(text, 'cell').map((cell) => cell.trim()), top });
        }
        return { rows, bottomRule: pendingTop };
      };
      /** `array` 的列格式串：`l/c/r` 对齐、`|` 竖线、`p{…}` 按左对齐、`@{}` 只吃掉不留痕。 */
      const parseColumnSpec = (spec) => {
        const cols = [];
        let pendingRule = false;
        let index = 0;
        const skipGroup = () => {
          let depth = 0;
          while (index < spec.length) {
            const ch = spec[index];
            if (ch === '{') depth += 1;
            else if (ch === '}') {
              depth -= 1;
              index += 1;
              if (depth === 0) return;
              continue;
            }
            index += 1;
          }
        };
        while (index < spec.length) {
          const ch = spec[index];
          if (ch === '|') { pendingRule = true; index += 1; continue; }
          if (ch === '{' || ch === '}') { index += 1; continue; }
          if (ch === '@' || ch === '!' || ch === '>' || ch === '<' || ch === '*') {
            index += 1;
            while (index < spec.length && /\s/u.test(spec[index])) index += 1;
            if (spec[index] === '{') skipGroup();
            continue;
          }
          if (ch === 'p' || ch === 'm' || ch === 'b' || ch === 'X' || ch === 'S') {
            index += 1;
            while (index < spec.length && /\s/u.test(spec[index])) index += 1;
            if (spec[index] === '{') skipGroup();
            cols.push({ align: 'left', rule: pendingRule });
            pendingRule = false;
            continue;
          }
          if (ch === 'l' || ch === 'c' || ch === 'r') {
            cols.push({ align: ch === 'r' ? 'right' : ch === 'c' ? 'center' : 'left', rule: pendingRule });
            pendingRule = false;
            index += 1;
            continue;
          }
          index += 1;
        }
        return { cols, endRule: pendingRule };
      };
      /** 二维格子（`cases` / `aligned` / `matrix` 都用它）：真对齐，不是空格凑。 */
      const gridNode = (cellRows, options) => {
        const colCount = Math.max(1, ...cellRows.map((row) => row.length));
        const columns = Array.from({ length: colCount }, (unused, index) => (options.track === undefined ? 'auto' : options.track(index))).join(' ');
        const children = [];
        cellRows.forEach((cells) => {
          for (let column = 0; column < colCount; column += 1) {
            const align = options.align === undefined ? 'center' : options.align(column);
            children.push(h('span', {
              key: nextKey(),
              style: {
                justifySelf: align === 'right' ? 'end' : align === 'left' ? 'start' : 'center',
                textAlign: align,
                whiteSpace: 'nowrap',
                lineHeight: 1.65,
              },
            }, ...latexRender(cells[column] ?? '', nextKey())));
          }
        });
        return h('span', {
          key: nextKey(),
          style: {
            display: 'inline-grid',
            gridTemplateColumns: columns,
            columnGap: options.columnGap ?? '1.2em',
            rowGap: options.rowGap ?? '2px',
            alignItems: 'baseline',
            justifyItems: 'start',
            verticalAlign: 'middle',
            textAlign: 'left',
          },
        }, ...children);
      };
      /** `array` / `tabular`：按列格式串排成真表格（竖式加法、真值表都靠它）。 */
      const tableNode = (body, spec) => {
        const { cols, endRule } = parseColumnSpec(spec);
        const { rows, bottomRule } = collectEnvRows(body);
        if (rows.length === 0) return null;
        const colCount = Math.max(1, cols.length, ...rows.map((row) => row.cells.length));
        const cellStyle = (column, row) => {
          const style = {
            textAlign: cols[column]?.align ?? 'left',
            padding: '1px 7px',
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            verticalAlign: 'middle',
          };
          if (cols[column]?.rule === true) style.borderLeft = '1px solid currentColor';
          if (column === colCount - 1 && endRule) style.borderRight = '1px solid currentColor';
          if (row.top) style.borderTop = '1px solid currentColor';
          if (row === rows[rows.length - 1] && bottomRule) style.borderBottom = '1px solid currentColor';
          return style;
        };
        const bodyRows = rows.map((row) => h('tr', { key: nextKey() },
          ...Array.from({ length: colCount }, (unused, column) => h('td', { key: nextKey(), style: cellStyle(column, row) },
            ...latexRender(row.cells[column] ?? '', nextKey())))));
        return h('table', {
          key: nextKey(),
          // tabular-nums：竖式加法靠等宽数字才对得上进位，衬线字体的数字默认不等宽
          style: { borderCollapse: 'collapse', margin: '6px auto', lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' },
        }, h('tbody', { key: nextKey() }, ...bodyRows));
      };
      /** 从 cursor 扫到配对的 `\end{env}`，返回环境体原文（不吃外层）；不配对就吃到末尾。 */
      const readEnvBody = (envName) => {
        const start = cursor;
        let depth = 1;
        let index = cursor;
        while (index < source.length) {
          const at = source.indexOf('\\', index);
          if (at < 0) break;
          const nest = /^\\(begin|end)\s*\{([^{}]*)\}/u.exec(source.slice(at, at + 48));
          if (nest !== null && nest[2].trim() === envName) {
            if (nest[1] === 'begin') depth += 1;
            else {
              depth -= 1;
              if (depth === 0) { cursor = at + nest[0].length; return source.slice(start, at); }
            }
            index = at + nest[0].length;
            continue;
          }
          index = at + 1;
        }
        cursor = source.length;
        return source.slice(start);
      };
      const MATRIX_ENV_DELIMITERS = {
        matrix: null, smallmatrix: null, pmatrix: ['(', ')'], bmatrix: ['[', ']'],
        Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'],
      };
      const ENV_ALIGNED = new Set(['aligned', 'align', 'alignat', 'alignedat', 'gather', 'gathered',
        'split', 'eqnarray', 'flalign', 'multline']);
      const ENV_TABLE = new Set(['array', 'tabular', 'tabularx', 'longtable']);
      const charDelimiterKind = (ch) => ({ '(': 'paren', ')': 'paren', '[': 'bracket', ']': 'bracket',
        '{': 'lbrace', '}': 'lbrace', '|': 'vert', '‖': 'doublevert' })[ch] ?? null;
      /**
       * `\begin{env}` 的排版入口。认得的四种：
       * `cases` 系（左侧大括号 + 两列）、`array`/`tabular`（列格式串）、`matrix` 系（括号网格）、
       * `aligned` 系（按 `&` 右/左交替对齐）；其余环境内容照排、环境名一律不印。
       */
      const renderEnvironment = (envName) => {
        const bare = envName.replace(/\*$/u, '');
        let columnSpec = '';
        if (ENV_TABLE.has(bare)) {
          skipSpace();
          if (source[cursor] === '[') {
            const close = source.indexOf(']', cursor);
            if (close >= 0) cursor = close + 1;
          }
          columnSpec = readRawGroup();
        }
        const body = readEnvBody(envName);
        if (bare === 'cases' || bare === 'dcases' || bare === 'rcases') {
          const cellRows = collectEnvRows(body).rows.map((row) => row.cells);
          if (cellRows.length === 0) return [];
          const grid = gridNode(cellRows, { columnGap: '1.6em', rowGap: '4px', align: () => 'left' });
          if (bare === 'rcases') return [wrapDelimiters(null, 'lbrace', grid)];
          return [wrapDelimiters('lbrace', null, grid)];
        }
        if (Object.prototype.hasOwnProperty.call(MATRIX_ENV_DELIMITERS, bare) === true) {
          const cellRows = collectEnvRows(body).rows.map((row) => row.cells);
          if (cellRows.length === 0) return [];
          const grid = gridNode(cellRows, { columnGap: '0.9em', rowGap: '3px', align: () => 'center' });
          const pair = MATRIX_ENV_DELIMITERS[bare];
          if (pair === null) return [grid];
          return [wrapDelimiters(charDelimiterKind(pair[0]), charDelimiterKind(pair[1]), grid)];
        }
        if (ENV_ALIGNED.has(bare) === true) {
          const cellRows = collectEnvRows(body).rows.map((row) => row.cells);
          if (cellRows.length === 0) return [];
          return [gridNode(cellRows, {
            columnGap: '0.6em',
            rowGap: '3px',
            align: (column) => (column % 2 === 0 ? 'right' : 'left'),
          })];
        }
        if (ENV_TABLE.has(bare) === true) {
          const node = tableNode(body, columnSpec);
          return node === null ? [] : [node];
        }
        // 其余环境（equation / figure / 未知）：内容照排，环境名不印出来
        return latexRender(body, nextKey());
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
        if (name === 'begin') {
          // 环境名（`{cases}` / `{array}`）先吃掉，交给 renderEnvironment 真排版
          return renderEnvironment(readRawGroup().trim());
        }
        if (name === 'end') {
          // 落单的 `\end`（正常不会走到，配对的已在 renderEnvironment 里消费干净）
          readRawGroup();
          return [];
        }
        if (name === 'left') {
          const openRaw = readDelimiter();
          const rightAt = findMatchingRight(cursor);
          if (rightAt < 0) {
            const kind = DELIMITER_KINDS[openRaw];
            return kind === undefined ? [] : [delimiterNode(kind, 'left')];
          }
          const innerTex = source.slice(cursor, rightAt);
          cursor = rightAt + '\\right'.length;
          const closeRaw = readDelimiter();
          const openKind = DELIMITER_KINDS[openRaw] ?? null;
          const closeKind = DELIMITER_KINDS[closeRaw] ?? null;
          const inner = latexRender(innerTex, nextKey());
          if (openKind === null && closeKind === null) return inner;
          return [wrapDelimiters(openKind, closeKind,
            h('span', { key: nextKey(), style: { display: 'inline-block' } }, ...inner))];
        }
        if (name === 'right') {
          // 没配对的 `\right`：吃掉定界符就行，别把「right」印出来
          readDelimiter();
          return [];
        }
        if (name === 'middle') {
          const raw = readDelimiter();
          const kind = DELIMITER_KINDS[raw];
          const node = kind === undefined ? '|' : delimiterNode(kind, 'mid');
          return [h('span', { key: nextKey(), style: { display: 'inline-flex', alignItems: 'center', margin: '0 8px' } }, node)];
        }
        if (name === 'tag' || name === 'label') {
          // 2026-10-27 晚：教材 OCR 的整段公式常带 `\tag{12.11}`（编号）。以前会把
          // 「tag」当正文印在式子末尾（`…e_r tag12.11`），这里把编号排成跟在后头的小字。
          const tagBody = readArgument();
          const tagText = tagBody.filter((part) => typeof part === 'string').join('');
          if (tagText === '') return [];
          return [h('span', { key: nextKey(), style: { marginLeft: 8, fontSize: 12, opacity: 0.75 } }, `(${tagText})`)];
        }
        if (name === 'boxed' || name === 'fbox') {
          // 2026-10-29：`\boxed{…}` 以前印成「boxed…」（讲义里 184 处），现在画个框
          const body = readArgument();
          return [h('span', {
            key: nextKey(),
            style: {
              display: 'inline-flex', alignItems: 'center', border: '1.2px solid currentColor',
              borderRadius: 3, padding: '1px 7px', margin: '0 2px',
            },
          }, ...body)];
        }
        if (XARROW_SYMBOL[name] !== undefined) {
          // 2026-10-29：`A \xrightarrow[下注]{上注} B` —— 注解排在箭头上方，可选的下注排在下方
          skipSpace();
          let below = null;
          if (source[cursor] === '[') {
            const close = source.indexOf(']', cursor);
            if (close >= 0) { below = source.slice(cursor + 1, close); cursor = close + 1; }
          }
          const above = readArgument();
          const annotation = (nodes) => h('span', {
            key: nextKey(),
            style: { fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap', opacity: 0.9 },
          }, ...nodes);
          const stack = [annotation(above), h('span', { key: nextKey(), style: { lineHeight: 1.1 } }, XARROW_SYMBOL[name])];
          if (below !== null && below.trim() !== '') stack.push(annotation(latexRender(below, nextKey())));
          return [h('span', {
            key: nextKey(),
            style: {
              display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
              verticalAlign: 'middle', margin: '0 3px',
            },
          }, ...stack)];
        }
        if (name === 'underbrace' || name === 'overbrace') {
          // 2026-10-29：`\underbrace{X}_{说明}` —— 内容 + 花括号 + 小字说明竖排（以前印出「underbrace」）
          const body = readArgument();
          skipSpace();
          let label = null;
          if (source[cursor] === '_' || source[cursor] === '^') {
            cursor += 1;
            skipSpace();
            label = readArgument();
          }
          const brace = h('span', {
            key: nextKey(),
            style: { fontSize: '1.1em', lineHeight: 1 },
          }, name === 'underbrace' ? '⏟' : '⏞');
          const labelNode = label === null ? null : h('span', {
            key: nextKey(),
            style: { fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap', opacity: 0.9 },
          }, ...label);
          const content = h('span', { key: nextKey() }, ...body);
          const stack = name === 'underbrace' ? [content, brace] : [brace, content];
          if (labelNode !== null) {
            if (name === 'underbrace') stack.push(labelNode);
            else stack.unshift(labelNode);
          }
          return [h('span', {
            key: nextKey(),
            style: {
              display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', verticalAlign: 'middle', margin: '0 2px',
            },
          }, ...stack)];
        }
        if (LATEX_IGNORED.has(name)) return [];
        if (LATEX_SPACING[name] !== undefined) return [LATEX_SPACING[name]];
        if (LATEX_GREEK[name] !== undefined) return [LATEX_GREEK[name]];
        if (LATEX_SYMBOL[name] !== undefined) return [LATEX_SYMBOL[name]];
        // 2026-11-12：`\sum_{i=1}^{n}` 的上下限以前被吃掉（只印一个 Σ）。带上下限时上下叠，不带时单字。
        if (LATEX_UPRIGHT.has(name)) {
          skipSpace();
          let uprightUpper = null;
          let uprightLower = null;
          let guard = 0;
          while (guard < 2 && (source[cursor] === '_' || source[cursor] === '^')) {
            const isUpper = source[cursor] === '^';
            cursor += 1;
            if (isUpper) uprightUpper = readArgument();
            else uprightLower = readArgument();
            skipSpace();
            guard += 1;
          }
          const uprightBody = mathUpright(name);
          if (uprightUpper === null && uprightLower === null) return [uprightBody];
          return [h('span', { key: nextKey(), style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', verticalAlign: 'middle', margin: '0 2px', lineHeight: 1.15 } },
            uprightUpper === null ? null : h('span', { key: nextKey(), style: mathLimit }, ...uprightUpper),
            uprightBody,
            uprightLower === null ? null : h('span', { key: nextKey(), style: mathLimit }, ...uprightLower))];
        }
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const numerator = readArgument();
          const denominator = readArgument();
          return [fractionNode(numerator, denominator)];
        }
        // 2026-11-12：`\sqrt[n]{x}` 的方根指数以前被当正文吃掉（`\sqrt[3]{x}` 印成 `√[3]x`）
        if (name === 'sqrt') {
          skipSpace();
          let rootIndex = null;
          if (source[cursor] === '[') {
            const closeBracket = source.indexOf(']', cursor + 1);
            if (closeBracket > 0) {
              rootIndex = latexRender(source.slice(cursor + 1, closeBracket), nextKey());
              cursor = closeBracket + 1;
            }
          }
          const body = readArgument();
          return [h('span', { key: nextKey(), style: { whiteSpace: 'nowrap' } },
            mathUpright('√'),
            rootIndex === null ? null : h('sup', { style: { ...MATH_UPRIGHT_STYLE, fontSize: '0.66em', lineHeight: '1' } }, ...rootIndex),
            h('span', { style: { borderTop: '1px solid currentColor', padding: '0 2px' } }, ...body))];
        }
        // 2026-11-12：求和/求积/积分的上下限按 LaTeX 语义排（`\sum_{i=1}^{n}` 上下叠，`\int_a^b` 限在右下右上）
        if (LATEX_BIGOP_SIDE.has(name) || LATEX_BIGOP_STACK.has(name)) {
          const operator = mathBigOp(LATEX_SYMBOL[name] ?? name);
          const stacked = LATEX_BIGOP_STACK.has(name);
          let lower = null;
          let upper = null;
          for (let picked = 0; picked < 2; picked += 1) {
            skipSpace();
            const mark = source[cursor];
            if (mark !== '_' && mark !== '^') break;
            cursor += 1;
            const body = readArgument();
            if (mark === '_') lower = body;
            else upper = body;
          }
          if (lower === null && upper === null) return [operator];
          if (stacked && lower !== null) {
            return [h('span', {
              key: nextKey(),
              style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', verticalAlign: 'middle', margin: '0 3px', lineHeight: '1.05' },
            },
            mathLimit(upper === null ? [] : upper),
            operator,
            mathLimit(lower))];
          }
          return [h('span', { key: nextKey(), style: { whiteSpace: 'nowrap' } },
            operator,
            upper === null ? null : h('sup', { style: { ...MATH_UPRIGHT_STYLE, fontSize: '0.7em', lineHeight: '1' } }, ...upper),
            lower === null ? null : h('sub', { style: { ...MATH_UPRIGHT_STYLE, fontSize: '0.7em', lineHeight: '1', marginLeft: upper === null ? 0 : '-0.34em' } }, ...lower))];
        }
        if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
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
            if (options.textOnly === true) {
              // 纯文本模式：`x_1` 里的 `_` 就是字面字符，不排上下标（`\text{}` 里的内容也走这里）
              out.push(ch);
              continue;
            }
            return out;
          }
          if (ch === '}') {
            // 纯文本模式（`\text{…}` 里的中文）必须**原样保留花括号**：
            // 以前这里无条件吞掉 `}`，`\text{库仑定律写作 F}` 会把收尾的 `}` 也吃掉，
            // 结果整句中文被吞进公式、外面只剩一个孤零零的 `，用矢量…`。
            cursor += 1;
            if (options.textOnly === true) { out.push(ch); continue; }
            continue;
          }
          if (ch === '{') {
            if (options.textOnly === true) { cursor += 1; out.push(ch); continue; }
            cursor += 1;
            out.push(...parse(true));
            continue;
          }
          if (ch === '_' || ch === '^') {
            if (options.textOnly === true) {
              cursor += 1;
              out.push(ch);
              continue;
            }
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
    /** 对外只暴露「排好版的节点」，测试直接调它。 */
    const latexNodes = (tex, keyPrefix = 'm', options = {}) => latexRender(tex, keyPrefix, options);
    // ── 纯文本公式规范化（2026-11-12）───────────────────────────────────────────
    // 起因：用户报「`E = Q / (4π ε₀ r²)`、`A_12` 这样的符号很难看」。四门课讲义里公式的写法
    // 实际有三种：① 真 LaTeX（`$…$`，数电 777 处）；② 反引号里包的纯文本（物理 5818 处）；
    // ③ 正文里裸着写的纯文本（`F_x`、`∫_{-π/2}^{π/2}`、`ε₀`）。②③ 里带 `_` `^` 的那一档以前
    // 要么把下划线和尖号原样露出、要么当代码排成等宽字 —— 这里统一转成 LaTeX 再交给
    // latexRender：下标真的变小下降、`/` 分式真的上下叠、∫ Σ 带上限、变量用衬线斜体。
    // 保守口径：**只在「整行有公式特征」或「反引号里」触发**，中文段落中间的单个字母不动；
    // 换不动的字符原样留在公式外面（→「一个字都不吞」）。
    /** 有这几个符号之一才值得怀疑是公式（`r = 5.3 m` 这种纯等号不算）。 */
    const PLAIN_MATH_MARK_PATTERN = /[_^∫∮∑∏√]|[\u0370-\u03ff]/u;
    /**
     * 上一行漏掉的一类：**只用 Unicode 上下标字形写的公式**（`Q₁ Q₂ / r²`、`10⁻¹⁹ C`）。
     * 这类写法在物理讲义里极常见，光看 `_ ^ ∫ ∑` 认不出来，得连上下标字形一起认。
     */
    const MATH_SCRIPTOID_PATTERN = /[\u00b2\u00b3\u00b9\u2070-\u2079\u207b\u2080-\u2089\u2090-\u209c]/u;
    /** 公式里允许出现的 ASCII 外壳字（能拼成一段 `{…}` 的只有这些；中文原样留在公式外面）。 */
    const MATH_BARE_CHUNK = /^[0-9A-Za-z.,;:!?+\-*/=<>()[\]{}|#%&~\u00d7\u00f7\u00b1\u2208\u2209\u2282\u2286\u2283\u2287\u2192\u2190\u2194\u21d2\u21d4\u2264\u2265\u2260\u2248\u2261\u221d\u2202\u2207\u221e\u2032\u00b7\u3001]+$/u;
    /** 公式里允许出现的单字符（其余一律留在公式外面，保证「一个字都不吞」）。 */
    const MATH_BARE_CHAR = /[0-9A-Za-z.\u0370-\u03ff\u00c0-\u024f\u2070-\u209c\u00b2\u00b3\u00b9\u00b0\u221a\u2211\u220f\u222b\u222e]/u;
    /** Unicode 上下标字形 → 普通字符（物理讲义全是这种写法：`ε₀`、`10⁻¹⁹`、`x²`）。 */
    const MATH_UNICODE_SCRIPTS = {
      '\u2070': '0', '\u00b9': '1', '\u00b2': '2', '\u00b3': '3', '\u2074': '4', '\u2075': '5',
      '\u2076': '6', '\u2077': '7', '\u2078': '8', '\u2079': '9', '\u207a': '+', '\u207b': '-',
      '\u207c': '=', '\u207d': '(', '\u207e': ')', '\u207f': 'n',
      '\u2080': '0', '\u2081': '1', '\u2082': '2', '\u2083': '3', '\u2084': '4', '\u2085': '5',
      '\u2086': '6', '\u2087': '7', '\u2088': '8', '\u2089': '9', '\u208a': '+', '\u208b': '-',
      '\u208c': '=', '\u208d': '(', '\u208e': ')', '\u2090': 'a', '\u2091': 'e', '\u2092': 'o',
      '\u2093': 'x', '\u2095': 'h', '\u2096': 'k', '\u2097': 'l', '\u2098': 'm', '\u2099': 'n',
      '\u209a': 'p', '\u209b': 's', '\u209c': 't',
    };
    /** 上下标字形（`₀`、`²`）：按 Unicode 区块区分下/上。 */
    const MATH_SCRIPT_CHAR = /^[\u2070-\u209c\u00b2\u00b3\u00b9\u00b0]$/u;
    const MATH_SCRIPT_KIND = (ch) => (/[\u2080-\u209c]/u.test(ch) ? '_' : '^');
    /** 关系符 → LaTeX 命令（两边都是公式时用命令排，字体才和变量一致）。 */
    const MATH_TOKEN_REL = {
      '\u2264': '\\le', '\u2265': '\\ge', '\u2260': '\\ne', '\u2248': '\\approx', '\u2261': '\\equiv',
      '\u221d': '\\propto', '\u2192': '\\to', '\u21d2': '\\Rightarrow', '\u21d4': '\\Leftrightarrow',
      '\u2190': '\\leftarrow', '\u2194': '\\leftrightarrow', '\u2208': '\\in', '\u2229': '\\cap',
      '\u222a': '\\cup', '\u00d7': '\\times', '\u00b7': '\\cdot', '\u00b1': '\\pm', '\u221e': '\\infty',
    };
    const MATH_TOKEN_INTEGRAL = /^[\u222b\u222e\u222f\u2230]$/u;
    /** 一小段 LaTeX 是否「值得排」（`x_1` 这种孤零零的不排，省得把中文段落搞花）。 */
    const mathTexLooksReal = (tex) => {
      const body = String(tex ?? '').replace(/\{\\text\{[^}]*\}\}/gu, '');
      if (body.trim() === '') return false;
      if (PLAIN_MATH_MARK_PATTERN.test(body) || MATH_SCRIPTOID_PATTERN.test(body)) return true;
      return /[=<>×÷+-]/u.test(body) && /[0-9]/u.test(body) && /[A-Za-zͰ-Ͽ]/u.test(body);
    };
    /** 读一段 `_` / `^` 的作用对象：字母数字、Unicode 上下标字形，或一个 ASCII `(…)` / `{…}` 组。 */
    const readMathScript = (text, from) => {
      let index = from;
      let body = '';
      while (index < text.length) {
        const ch = text[index];
        if (MATH_SCRIPT_CHAR.test(ch) || /[0-9A-Za-z]/u.test(ch)) { body += ch; index += 1; continue; }
        if (ch === '(' || ch === '{') {
          const end = text.indexOf(ch === '(' ? ')' : '}', index + 1);
          if (end > index + 1) {
            const inner = text.slice(index + 1, end);
            if (MATH_BARE_CHUNK.test(inner) || /^[0-9A-Za-z\u0370-\u03ff{},.\-+ ]+$/u.test(inner)) {
              body += `{${inner}}`;
              index = end + 1;
              continue;
            }
          }
        }
        break;
      }
      return { body, next: index };
    };
    /** 读 `√(…)` / `√{…}` / `√123`：能读成组就上横线，读不动就只留根号。 */
    const readMathRadical = (text, from) => {
      if (text[from] === '(' || text[from] === '{') {
        const end = text.indexOf(text[from] === '(' ? ')' : '}', from + 1);
        if (end > from + 1) {
          const inner = text.slice(from + 1, end);
          if (MATH_BARE_CHUNK.test(inner) || /^[0-9A-Za-z\u0370-\u03ff{},.\-+ ]+$/u.test(inner)) return { body: `\\sqrt{${inner}}`, next: end + 1 };
        }
        return { body: '\\sqrt', next: from };
      }
      const run = /^[0-9A-Za-z.]+/u.exec(text.slice(from));
      if (run === null) return { body: '\\sqrt', next: from };
      return { body: `\\sqrt{${run[0]}}`, next: from + run[0].length };
    };
    /**
     * 纯文本 → LaTeX 词法。**规则很窄**：调用方已经判定「这段有公式特征」，这里再逐字符
     * 决定能不能进公式；中文、引号、破折号这类留在公式外面（宁愿少排，也不改字）。
     */
    /** 公式里「不带空格连在一起的一串」是否全是公式字符。 */
    /** 中文字符、全角标点、`，。；：！？（）【】「」` 之类：公式的边界。 */
    /**
     * 把一个**不含空白的公式片段**转成 LaTeX（2026-11-12）。
     * 做四件事：Unicode 上下标 → `_{}`/`^{}`；`F_x`/`n^(…)`/`∫_{a}^{b}` 的脚本；
     * `√(…)` → `\sqrt{}`；希腊字母与关系符 → 对应命令。认不出的字符原样留下。
     */
    /** 2026-11-12：纯文本里直接出现的希腊小写/大写、积分号、关系符 → LaTeX 命令，
     *  否则 `∮`/`θ` 这类字符会被当普通文字原样排（`\int` 一类还能靠大字库补，`∮` 不能）。 */
    const PLAIN_MATH_MAP = {
      'π': '\\pi ', 'τ': '\\tau ', 'φ': '\\varphi ', 'ϕ': '\\phi ', 'θ': '\\theta ', 'λ': '\\lambda ',
      'μ': '\\mu ', 'σ': '\\sigma ', 'Σ': '\\Sigma ', 'Δ': '\\Delta ', 'δ': '\\delta ', 'ρ': '\\rho ',
      'ω': '\\omega ', 'Ω': '\\Omega ', 'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'η': '\\eta ',
      'ν': '\\nu ', 'κ': '\\kappa ', 'ψ': '\\psi ', 'Ψ': '\\Psi ', 'Φ': '\\Phi ', 'Λ': '\\Lambda ',
      '∮': '\\oint ', '∬': '\\iint ', '∭': '\\iiint ', '∫': '\\int ',
      '≈': '\\approx ', '≠': '\\neq ', '≤': '\\le ', '≥': '\\ge ', '→': '\\to ', '⇒': '\\Rightarrow ',
      '∞': '\\infty ', '∂': '\\partial ', '∇': '\\nabla ', '⇌': '\\rightleftharpoons ',
    };
    const plainMathWordToTex = (word) => {
      const clean = String(word ?? '').replace(/[\s\u3000\u00a0]/gu, '');
      let index = 0;
      let token = '';
      while (index < word.length) {
        const ch = word[index];
        if (MATH_SCRIPT_CHAR.test(ch)) {
          const mark = MATH_SCRIPT_KIND(ch);
          let run = '';
          while (index < word.length && MATH_SCRIPT_CHAR.test(word[index]) && MATH_SCRIPT_KIND(word[index]) === mark) {
            run += MATH_UNICODE_SCRIPTS[word[index]] ?? '';
            index += 1;
          }
          if (run !== '') token += `${mark}{${run}}`;
          continue;
        }
        if (ch === '^' || ch === '_') {
          const script = readMathScript(word, index + 1);
          if (script.body === '') { index += 1; continue; }
          // 2026-11-12：剥离脚标本体的希腊小写/拉丁小写（`F_ix` 的 `i`、`e_r21` 的 `r`），
          // 中文与运算符一律不当斜体（`\text{}`），否则 `_{0}` 之类会渲染成斜体冒充正文。
          const rawBody = script.body;
          const strippedBody = rawBody.replace(/([\u0370-\u03ff]|[A-Za-z])+$/u, '');
          if (strippedBody !== '' && /^\s*$/u.test(strippedBody) === false) {
            token += `${ch}{\\text{${strippedBody}}}`;
          }
          const letterBody = rawBody.slice(strippedBody.length);
          if (letterBody !== '') token += `${ch}{${letterBody}}`;
          else if (strippedBody === '') token += `${ch}{\\text{${rawBody}}}`;
          index = script.next;
          continue;
        }
        if (ch === '∮') token += '\\oint ';
        else if (ch === '∬') token += '\\iint ';
        else if (ch === '∫') token += '\\int ';
        else if (ch === '∑') token += '\\sum ';
        else if (ch === '∏') token += '\\prod ';
        else if (ch === '√') {
          const radical = readMathRadical(word, index + 1);
          token += radical.body;
          index = radical.next;
          continue;
        } else if (ch === 'ε') token += '\\varepsilon';
        else if (PLAIN_MATH_MAP[ch] !== undefined) token += PLAIN_MATH_MAP[ch]
        else if (ch === '·') token += '\\cdot '
        // 2026-11-12：`Σ`(U+03A3)/`Π`(U+03A4 系) 是希腊字母大写，字面渲染成普通字重很难看 → 一律转大算子
        else if (ch === 'Σ') token += '\\sum '
        else if (ch === '∏' || ch === 'Π') token += '\\prod '
        else if (MATH_TOKEN_REL[ch] !== undefined) token += MATH_TOKEN_REL[ch];
        else token += ch;
        index += 1;
      }
      return token;
    };
    /** 全角标点 → 半角（公式里的 `，`、`（` 等按英文标点排）。 */
    const PLAIN_MATH_PUNCT = { '，': ',', '。': '.', '；': ';', '：': ':', '（': '(', '）': ')', '、': ',', '！': '!', '？': '?', '＝': '=', '＋': '+' };
    /** 公式片段之间的分隔符（`×`、`≤`、`=`…）：转换后左右补空格。 */
    const PLAIN_MATH_SPACED = new Set(['×', '÷', '·', '≤', '≥', '≠', '≈', '∝', '→', '←', '↔', '⇒', '∈']);
    /** 能进入一个公式片段的单字符（其余字符一律留在公式外面，保证「一个字都不吞」）。 */
    /** 公式里「可以连在一起」的字符（字符码判断，不用 charset 正则：`/[.../u` 里没转义的 `/` 会提前结束字面量）。 */
    const PLAIN_MATH_WORD = new Set('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._^()+[],{}\\-*/=<>|,;:'.split(''));
    const isPlainMathWordChar = (ch) => {
      if (ch === undefined || ch === '') return false;
      if (PLAIN_MATH_WORD.has(ch)) return true;
      const code = ch.codePointAt(0);
      if (code >= 0x0370 && code <= 0x03ff) return true;
      if (code >= 0x00c0 && code <= 0x024f) return true;
      if (code >= 0x2070 && code <= 0x209c) return true;
      return '²³¹°√∑∏∫∮∯∰×·±∞≤≥≈≡≠∝→⇒⇔←↔∈∩∪'.includes(ch);
    };
    /** 公式里出现这些符号才算「真公式」（`x_1` 这种孤零零的不算）。 */
    const PLAIN_MATH_MARK = '∫∮∑∏√_^';
    /**
     * 纯文本公式 → LaTeX（2026-11-12 定稿）。
     *
     * 三条硬规矩：① 只搬运不改字 —— 认不出的字符（中文、引号）原样包进 `\text{}`；
     * ② `_` / `^` 的脚本体先于 `/` 处理（`∫_{-π/2}^{π/2}` 的整体不能当分式的分子）；
     * ③ `/` 只吃**紧邻**的一个因子（括号组或一串字母数字），`Q / (…)` 靠跳过空格实现。
     */
    const plainMathToTex = (text) => {
      const source = String(text ?? '').replace(/\r/gu, ' ');
      // 读一个「因子」：括号组（递归）或一串公式字符（`_`/`^`/`/` 除外）
      const readFactor = (from) => {
        if (source[from] === '(') {
          let depth = 0;
          for (let i = from; i < source.length; i += 1) {
            if (source[i] === '(') depth += 1;
            else if (source[i] === ')') {
              depth -= 1;
              if (depth === 0) return { tex: `\\left(${plainMathToTex(source.slice(from + 1, i))}\\right)`, next: i + 1 };
            }
          }
          return null;
        }
        let run = '';
        let i = from;
        while (i < source.length && isPlainMathWordChar(source[i]) && !'_^/,;|'.includes(source[i])) { run += source[i]; i += 1; }
        if (run === '') return null;
        return { tex: plainMathWordToTex(run), next: i };
      };
      const chunks = []; // { text, math }
      let plainBuf = '';
      const flushPlain = () => {
        if (plainBuf !== '') { chunks.push({ text: plainBuf, math: false }); plainBuf = ''; }
      };
      const emitMath = (tex) => { chunks.push({ text: tex, math: true }); };
      // 最近一个「可当分子」的数学块下标（中间不能隔普通文字）
      const lastMathIndex = () => {
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          if (chunks[i].math === true) return i;
          if (chunks[i].text.trim() !== '') return -1;
        }
        return -1;
      };
      let index = 0;
      while (index < source.length) {
        const ch = source[index];
        if (ch === ' ') { flushPlain(); if (chunks.length > 0 && chunks[chunks.length - 1].text !== ' ') chunks.push({ text: ' ', math: false }); index += 1; continue; }
        if (ch === '_' || ch === '^') {
          let factor = null;
          if (source[index + 1] === '{') {
            const close = source.indexOf('}', index + 2);
            if (close > index + 2) factor = { tex: `${plainMathToTex(source.slice(index + 2, close))}`, next: close + 1 };
          }
          if (factor === null) factor = readFactor(index + 1);
          if (factor === null) { flushPlain(); plainBuf += ch; index += 1; continue; }
          flushPlain();
          const target = lastMathIndex();
          const scriptTex = ch + '{' + factor.tex + '}';
          if (target >= 0) chunks[target] = { text: chunks[target].text + scriptTex, math: true };
          else emitMath(scriptTex);
          index = factor.next;
          continue;
        }
        if (ch === '/') {
          // `/` 只吃**紧邻**的因子：`Q/r`、`C²/(N·m²)` 直接叠；`… / 5 m/s` 这种带空格的
          // 不硬叠（否则单位斜杠会被吃掉后面的词），退回普通斜杠。
          let from = index + 1;
          if (source[from] === ' ') from += 1;
          const factor = readFactor(from);
          const target = lastMathIndex();
          if (factor !== null && target >= 0) {
            const numerator = chunks[target].text;
            chunks[target] = { text: `\\frac{${numerator}}{${factor.tex}}`, math: true };
            index = factor.next;
            continue;
          }
          flushPlain();
          plainBuf += '/';
          index += 1;
          continue;
        }
        if (ch === '∑' || ch === '∏' || ch === 'Σ' || ch === 'Π') {
          flushPlain();
          // 2026-11-12：末尾留一个空格，`\sumF` 会被渲染器当成一个大命令名。
          emitMath(ch === '∑' || ch === 'Σ' ? '\\sum ' : '\\prod ');
          index += 1;
          continue;
        }
        if (isPlainMathWordChar(ch)) {
          const factor = readFactor(index);
          if (factor !== null) {
            flushPlain();
            emitMath(factor.tex);
            index = factor.next;
            continue;
          }
        }
        flushPlain();
        plainBuf += ch;
        index += 1;
      }
      flushPlain();
      return chunks.map((chunk) => (chunk.math === true ? chunk.text : `\\text{${chunk.text}}`)).join('')
        .replace(/\\text\{\s*\}/gu, ' ').replace(/ {2,}/gu, ' ')
        .trim() || `\\text{}`;
    };
    /** 行内公式的衬线斜体外观（数字与 `\text{}` 里的中文仍按正体排）。 */
    const MATH_INLINE_STYLE = { fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontSize: '1.02em', letterSpacing: '0.01em' };
    /** 整行公式：再大一号、上下留白，读起来像书上的行间公式。 */
    const MATH_BLOCK_STYLE = { fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontSize: '1.0625em', lineHeight: 1.75, letterSpacing: '0.01em' };
    /** 带公式特征的一段文本 → 排好版的节点；没有公式特征就返回 `null`（调用方原样显示）。 */
    const plainMathNodes = (text, keyPrefix, options = {}) => {
      const source = String(text ?? '');
      if (!PLAIN_MATH_MARK_PATTERN.test(source) && !MATH_SCRIPTOID_PATTERN.test(source)) return null;
      // 2026-11-12 修：以前一有下标特征就整段转公式，结果中文句子里的
      // `F = k Q₁ Q₂ / r²` 被排成一个超大分式，把整行撑高、旁边的字飞到两边。
      // 现在只有「公式占大半、且不含中文句读」的片段整段转；否则逐段排。
      const hanCount = (source.match(/[\u4e00-\u9fff]/gu) ?? []).length;
      const body = source.replace(/\s/gu, '');
      if (hanCount > 0 && hanCount * 2 >= body.length) return null;
      if (/[。！？]/u.test(source)) return null;
      const tex = plainMathToTex(source);
      if (tex.trim() === '' || !mathTexLooksReal(tex)) return null;
      return latexRender(tex, keyPrefix, options);
    };
    /** 反引号里的内容按**内容**判型：像公式就按公式排，其余照旧当代码。 */
    const backtickNodes = (raw, key) => {
      const content = String(raw ?? '');
      const math = content.trim() === '' || /^[*`]{1,2}.+[*`]{1,2}$/u.test(content.trim()) ? null : plainMathNodes(content, `${key}-bm`, {});
      if (math !== null) return h('span', { key, style: MATH_INLINE_STYLE }, ...math);
      return h('code', { key, style: { fontFamily: 'Consolas, monospace', fontSize: '0.95em', padding: '0 2px' } }, content);
    };
    /** 整个段落都像公式（`F_x = Σ F_ix, F_y = Σ F_iy`）→ 整行居中放大，当作行间公式。 */
    const PLAIN_MATH_BLOCK_LINE = /^[^。！？；：]{2,80}$/u;
    const plainMathLineNodes = (line, keyPrefix) => {
      const source = String(line ?? '').trim();
      // 2026-11-16（续修 v2）：两条「不是裸公式行」的硬拦截——
      //   ① 表格行（`| … |`）：它属于表格分支（analysisBlockNodes:6876），
      //      以前表头里带 `_`/`=`（`| 情形 | … $L_1=S\cdot A$ … |`）会被这里误判成
      //      「整行公式」抢走，导致表格少表头、竖线裸印。← 2.1 表格裸印的真凶。
      //   ② 含字面 `$` 的行（`$$…$$` 或行内 `$…$`）：`plainMathToTex` 会把 `$$` 译成
      //      `\text{$}`、latexRender 再原样输出 `$`，屏幕上就是 `$$L_1=S· A$$`。
      //      这类行交给 `$` 分支（mixedTextNodes / analysisInline）剥两层后排版。
      if (/^\|.*\|$/u.test(source)) return null;
      if (source.includes('$')) return null;
      if (source.length < 6 || !/[=]/u.test(source)) return null;
      if (source === '' || !PLAIN_MATH_BLOCK_LINE.test(source)) return null;
      if (!PLAIN_MATH_MARK_PATTERN.test(source) && !MATH_SCRIPTOID_PATTERN.test(source)) return null;
      const tex = plainMathToTex(source);
      if (tex.trim() === '' || !mathTexLooksReal(tex)) return null;
      // 中文占比太高的大概率是「一句话里的一个公式」，交给行内处理，别整行放大
      const han = (source.match(/[\u4e00-\u9fff]/gu) ?? []).length;
      if (han > 0 && han * 3 > source.length) return null;
      return latexRender(tex, keyPrefix, {});
    };
    /**
     * 段落文本的**混合**排版（2026-11-12）：先按 Markdown 行内标记切开，公式形态的片段走
     * `plainMathNodes`，其余仍走 `analysisInline`。中文句子里的公式因此有了衬线斜体、下标
     * 真的下降，而 `**粗体**`、反引号、`$…$` 的既有行为一点没变。
     */
    /**
     * 把一段「**同一行里**的正文」拆成三类片段（2026-11-12 二修）：
     *   - 反引号 / 粗体 / 斜体 / 中文：原样当文字（`analysisInline` 会处理标记）；
     *   - 一段连续的公式字符（允许中间的空格）：整段交 `plainMathToTex`。
     *
     * 以前一有下标特征就**整段**（哪怕半句中文）转公式，结果中文被包进 `\text{}`、行内空格
     * 变成数学空档 —— 屏幕上就是反引号露出来、`E = \frac{Q}{4π ε₀ r²}` 把整行撑高。
     * 现在只有公式字符才进公式，中文永远留在公式外面。
     */
    const PLAIN_MATH_RUN_CHAR = /[0-9A-Za-z.,_^()+\-*/=<>\u0370-\u03ff\u00c0-\u024f\u2070-\u209c\u00b2\u00b3\u00b9\u00b0\u221a\u2211\u220f\u222b\u222e\u00d7\u00b7\u00b1\u221e\u2264\u2265\u2260\u2248\u221d\u2192\u2190\u2194\u21d2\u2208]/u;
    /** 公式片段里允许夹的空格（`Q / (…)`、`∫ … dθ` 里的那一个）。 */
    const isMathRunChar = (ch) => ch === ' ' || PLAIN_MATH_RUN_CHAR.test(ch);
    const splitMathRuns = (text) => {
      const pieces = [];
      let index = 0;
      while (index < text.length) {
        const ch = text[index];
        if (!isMathRunChar(ch)) {
          let plain = '';
          while (index < text.length && !isMathRunChar(text[index])) { plain += text[index]; index += 1; }
          pieces.push({ text: plain, math: false });
          continue;
        }
        let run = '';
        while (index < text.length && isMathRunChar(text[index])) { run += text[index]; index += 1; }
        // 开头/结尾的空格还给文字（别让公式左右各多一个空档）
        const lead = /^ */u.exec(run)[0];
        const tail = / *$/u.exec(run)[0];
        const core = run.slice(lead.length, run.length - tail.length);
        if (lead !== '' && pieces.length > 0) pieces.push({ text: lead, math: false });
        if (core !== '') pieces.push({ text: core, math: true });
        if (tail !== '') pieces.push({ text: tail, math: false });
      }
      return pieces;
    };
    const mixedTextNodes = (text, keyPrefix) => {
      let source = String(text ?? '');
      // 2026-11-16：生成侧截断常留下孤零零的一个 `$`（`… ) $(f(v_i), f(v_j)) \in E_2`），
      // 它让整段行内公式配不成对，`$` 会裸露。照抄 mathInlineNodes:7095-7096：奇数个 `$` 全剥掉。
      const dollarCount = (source.match(/\$/gu) ?? []).length;
      if (dollarCount % 2 === 1) source = source.replace(/\$/gu, '');
      if (!PLAIN_MATH_MARK_PATTERN.test(source) && !MATH_SCRIPTOID_PATTERN.test(source)) return analysisInline(source, keyPrefix);
      const out = [];
      const push = (...nodes) => { out.push(...nodes); };
      source.split(INLINE_MARK_PATTERN).filter((piece) => piece !== '').forEach((piece, index) => {
        const key = `${keyPrefix}-x${index}`;
        // 反引号、粗体与 `$` 公式块整块交给 analysisInline（`$` 块由 :5510-5517 的剥两层/
        // 单层逻辑正确走 latexNodes；此前只认 ` 和 *，`$…$` / `$$…$$` 落到 splitMathRuns 被
        // PLAIN_MATH_RUN_CHAR 不含 `$` 拆成字面 `$` 输出 —— explain 详解段绕过 :5510 修复的回归）
        if (/^[`*$]/u.test(piece.trim())) { out.push(...analysisInline(piece, key)); return; }
        splitMathRuns(piece).forEach((seg, segIndex) => {
          if (!seg.math) { out.push(...analysisInline(seg.text, `${key}-p${segIndex}`)); return; }
          const math = plainMathNodes(seg.text, `${key}-m${segIndex}`, {});
          if (math === null) { out.push(...analysisInline(seg.text, `${key}-p${segIndex}`)); return; }
          out.push(h('span', { key: `${key}-m${segIndex}`, style: MATH_INLINE_STYLE }, ...math));
        });
      });
      // 相邻的纯文字片段并成一段（否则「库仑定律写作」+「 」会分成两个文本节点）
      const merged = [];
      out.forEach((node) => {
        const last = merged[merged.length - 1];
        if (typeof node === 'string' && typeof last === 'string') { merged[merged.length - 1] = last + node; return; }
        merged.push(node);
      });
      return merged;
    };
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
      plain !== '' ? h('div', { className: 'sa-muted', style: { marginTop: rendered.length > 0 ? 4 : 0 } },
        // 2026-10-27 晚：`plain` 是「一句人话」，但生成侧偶尔在里面写裸 LaTeX
        // （`V_1 \sim V_2 只表示同态像`），直接当纯文本贴会露出反斜杠命令
        ...mathInlineNodes(plain, `f${index}-plain`)) : null);
    };
    /**
     * 标题层级 → 视觉分级（2026-11-04）。
     *
     * 起因：讲义正文（物理 38 份章级讲义等）里有 `# 第 12 章` / `## 12.1 电荷` / `### 概念先行`
     * / `#### 题目` 四级结构，但原先只给「≤2 级 1.0625em、3 级 1em、≥4 级 0.9375em」一点点字号差，
     * 用户实测「整页只有一个加粗结构，很不清晰」。这里把字级、字重、间距、分隔线一起拉开：
     *   - 1 级（章）：1.375em / 700 粗 / 上方粗分隔线；
     *   - 2 级（节）：1.1875em / 700 粗 / 上方细分隔线；
     *   - 3 级（知识块）：1.0625em / 700 粗 / 左侧色条；
     *   - 4 级（要点）：1em / 700 粗 / 强调色；
     *   - 5~6 级：0.9375em / 600 粗（少见，退化成弱化的小标签）。
     * 全部用 em，跟着 .sa-reading 的 A+/A− 一起缩放。
     */
    const HEADING_STYLE = (level) => {
      if (level <= 1) {
        return {
          margin: '20px 0 8px', fontSize: '1.375em', fontWeight: 700, lineHeight: 1.45,
          paddingTop: 12, borderTop: '2px solid var(--dsw-alias-border-l1)',
        };
      }
      if (level === 2) {
        return {
          margin: '20px 0 6px', fontSize: '1.1875em', fontWeight: 700, lineHeight: 1.5,
          paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)',
        };
      }
      if (level === 3) {
        return {
          margin: '16px 0 4px', fontSize: '1.0625em', fontWeight: 700, lineHeight: 1.55,
          paddingLeft: 8, borderLeft: '3px solid var(--dsw-alias-label-primary, #4b5563)',
        };
      }
      if (level === 4) {
        return {
          margin: '12px 0 2px', fontSize: '1em', fontWeight: 700, lineHeight: 1.6,
          color: 'var(--dsw-alias-label-primary, #374151)',
        };
      }
      return { margin: '10px 0 2px', fontSize: '0.9375em', fontWeight: 600, lineHeight: 1.6 };
    };
    /**
     * 「`**标签**：内容`」独占一段时 → 小标题式的一条要点（2026-11-04）。
     *
     * 讲义生成侧把每条要点写成 `准确定义：…` / `**题目**：…` / `**解答**：…`，一行一条、标签在前。
     * 原先整段按普通 `<p>` 排出来，19 条要点长得一模一样，读者抓不到骨架；这里把标签拆成
     * 独占一行的强调，内容另起，深浅两档分开了。只认「行首标签 + 冒号 + 内容」这个形状，
     * 段内多行（`whiteSpace: pre-wrap` 的普通段落）不参与判定。
     */
    const LEAD_LABEL_PATTERN = /^(\*\*[^*\n]{1,20}\*\*|[^\s*#|>`，。；：！？、]{1,12})\s*[：:]/u;
    const leadLabelOf = (part) => {
      const line = String(part ?? '');
      if (line === '' || line.includes('\n')) return null;
      if (/^[#`>|*]/u.test(line) || isListLine(line) || isTableRow(line)) return null;
      const hit = LEAD_LABEL_PATTERN.exec(line);
      if (hit === null) return null;
      const label = hit[1];
      const raw = label.startsWith('**') ? label.slice(2, -2) : label;
      if (raw === '' || raw.length > 12) return null;
      return { raw, end: hit[0].length };
    };
    /** 表格行：`| a | b |`。分隔行（`|---|:--:|`）只用来告诉解析器「上一行是表头」，渲染时丢掉。 */
    const isTableRow = (line) => /^\|.*\|$/u.test(line);
    const isTableRule = (line) => /^\|[\s:|-]+\|$/u.test(line);
    const tableCells = (line) => line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    /**
     * 表格**列宽校正**（2026-11-12）。
     *
     * 起因：用户截图里数电的真值表 / 物理的对比表被渲成「一格一格错开的高高低低的块」——
     * 因为少数几行多写（或少写）了竖线，后面所有单元格整体错位。只认一眼能判定的情况：
     * 中间某行比表头**多**一格、且多出来的那一格是空的（`||`）→ 去掉空格；
     * 表格各行列数取**众数**，只在「参差不齐」时才整体裁/补到众数。
     */
    const normalizeTableRows = (rows) => {
      if (rows.length === 0) return rows;
      const counts = new Map();
      rows.forEach((row) => counts.set(row.length, (counts.get(row.length) ?? 0) + 1));
      let width = rows[0].length;
      let best = 0;
      counts.forEach((n, w) => { if (n > best || (n === best && w > width)) { best = n; width = w; } });
      return rows.map((row) => {
        const cells = row.slice();
        // 多出来的空格先删（`| 甲 | | 乙 |` → `| 甲 | 乙 |`）
        while (cells.length > width) {
          const emptyAt = cells.lastIndexOf('');
          if (emptyAt < 0) break;
          cells.splice(emptyAt, 1);
        }
        while (cells.length < width) cells.push('');
        return cells;
      });
    };
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
     *
     * 字号（2026-10-30）：这里全部用 em，基准交给外层 .sa-reading 的 calc(--dsh-content-font-size
     * × --sa-read-scale)。原来写死 16/15/14px，专注阅读里调 A+/A− 时只有正文动、标题与表格不动。
     */
    /**
     * 一组成员行 → `<ul>` 或 `<ol>`（首行是数字就用 ol）。
     *
     * 2026-11-22（v2-F）：从 `analysisBlockNodes` 里提到模块顶层 —— 浮层气泡也要渲染列表，
     * 复用同一份标记，别复制第二份「ul/ol + li 前缀」规则。第三个参数是行内渲染器，
     * 默认仍是 `analysisInline`（详解正文一个字都没变）；气泡传 `mixedTextNodes`，
     * 这样列表项里的裸公式（`- q=ne`）也能排版。
     */
    const listNode = (items, key, inline = analysisInline) => {
      const tag = /^\d/u.test(items[0].raw) ? 'ol' : 'ul';
      return h(tag, { key, style: { margin: '6px 0 0', paddingLeft: 20, fontSize: '1em', lineHeight: 1.65 } },
        items.map((item, index) => h('li', { key: `${key}-li${index}` }, ...inline(item.text, `${key}-li${index}`))));
    };
    const analysisBlockNodes = (text, keyPrefix) => {
      const nodes = [];
      let afterHeading = false;
      // 2026-11-12：先按空行切段；再把「整行就是一条公式」的行**单独成段**。
      // 以前它们和上下文同处一段，段内换行按 pre-wrap 显示 ——：
      // 大分式把整行撑高、旁边的字被挤到分式上下两端（用户实测截图里最难看的一处）。
      const splitMathBlocks = (parts) => {
        const out = [];
        parts.forEach((part) => {
          let buffer = [];
          const flush = () => { if (buffer.length > 0) { out.push(buffer.join("\n")); buffer = []; } };
          part.split("\n").forEach((line) => {
            // 2026-11-16（续修 v2）：独立成段的 `$$…$$`（如 `$$L_1 = S\cdot A$$`）当**居中块级公式**。
            // 以前它被 plainMathLineNodes 抓走、而 plainMathToTex 不剥 `$$`，屏幕上是 `$$L_1=S· A$$`。
            // 这里先认 `$$…$$`（允许同一行内首尾成对），剥掉两层 `$` 再喂 latexNodes；公式为空则退回纯文本。
            const dollars = /^\$\$(.*)\$\$$/u.exec(String(line).trim());
            if (dollars !== null && dollars[1].trim() !== '') {
              flush();
              out.push({ formula: latexNodes(dollars[1], `??bb-${out.length}`), source: String(line).trim() });
              return;
            }
            // 注意：整行公式的节点**在这里就要拿住**。以前只判了 `!== null` 就又塞回纯文本，
            // 后面再走一遍段落渲染，于是 `E = \frac{Q}{…}` 被拆成「E」「=」「大分式」三块 ——
            // 屏幕上就是分式悬在行外、上下撑出大片空白。
            const formula = plainMathLineNodes(line, `??-${out.length}`);
            if (formula !== null) { flush(); out.push({ formula, source: line.trim() }); return; }
            buffer.push(line);
          });
          flush();
        });
        return out.filter((part) => (typeof part === 'string' ? part.trim() !== '' : true));
      };
      splitMathBlocks(analysisParagraphs(text)).forEach((part, blockIndex) => {
        const key = `${keyPrefix}-${blockIndex}`;
        const prevWasHeading = afterHeading;
        // 整行公式：直接用它自己的节点（居中放大的行间公式），不再拆成「E」「=」「分式」三块
        if (typeof part === 'object' && part !== null && part.formula) {
          nodes.push(h('div', { key, style: { ...MATH_BLOCK_STYLE, margin: '10px 0', textAlign: 'center', maxWidth: '100%', overflowX: 'auto' } }, ...part.formula));
          return;
        }
        const lines = part.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        if (lines.length === 0) return;
        // ① 表格：整段都是竖线行（至少两行，含一行分隔），否则会误伤正文里的 `a|b`
        if (lines.length >= 2 && lines.every(isTableRow) && lines.some(isTableRule)) {
          const rows = normalizeTableRows(lines.filter((line) => !isTableRule(line)).map(tableCells));
          const head = rows.shift() ?? [];
          const headRow = h('tr', { key: `${key}-head-row` },
            ...head.map((cell, index) => h('th', { key: `${key}-th${index}`, style: { ...ANALYSIS_CELL_STYLE, fontWeight: 600 } }, ...analysisInline(cell, `${key}-th${index}`))));
          const bodyRows = rows.map((row, rowIndex) => h('tr', { key: `${key}-r${rowIndex}` },
            ...row.map((cell, index) => h('td', { key: `${key}-r${rowIndex}c${index}`, style: ANALYSIS_CELL_STYLE },
              ...analysisInline(cell, `${key}-r${rowIndex}c${index}`)))));
          const tableNode = h('table', { style: { borderCollapse: 'collapse', fontSize: '0.875em', lineHeight: 1.5 } },
            head.length > 0 ? h('thead', { key: `${key}-head` }, headRow) : null,
            h('tbody', { key: `${key}-body` }, ...bodyRows));
          nodes.push(h('div', { key, style: { margin: '8px 0 0', overflowX: 'auto' } }, tableNode));
          return;
        }
        // ② 小标题：`### 一、结构` 独占一段；与正文同段时按普通文字渲染（不猜）
        // ② 标题：原只认 `###` 且只有一点点字号差（用户报「一根加粗结构，不清晰」），
        // 2026-11-04 起认 `#`~`######` 并分级，见 HEADING_STYLE。
        // 2026-11-12 修：以前要求「这一整段只有一行」。可讲义里标题后**很少有空行**
        // （`# 第12章…` 紧接 `## 12.1…` 紧接正文），整段被并成一大块，`#` 就原样露出来了 ——
        // 用户报的「只有一个加粗结构」根子在这儿。现在按行逐条收：认得的行各自成块，其余并段。
        /** 生成节点：以 `#`~`######` 开头的一行 → 分级标题；否则 null（交给后面的分支）。 */
        const headingNodeOf = (line, key) => {
          const match = /^(#{1,6})\s+(.*)$/u.exec(line);
          if (match === null) return null;
          return h('div', { key, style: HEADING_STYLE(match[1].length) }, ...mixedTextNodes(match[2], `${key}-h`));
        };
        if (headingNodeOf(lines[0], `${key}-h0`) !== null && lines.length > 1) {
          let group = [];
          let headingIndex = 0;
          const flushGroup = () => {
            if (group.length === 0) return;
            const textPart = group.join('\n');
            nodes.push(h('p', { key: `${key}-gp${headingIndex}`, style: { margin: '6px 0 0', fontSize: '1em', lineHeight: '1.65', whiteSpace: 'pre-wrap' } },
              ...analysisInline(textPart, `${key}-gp${headingIndex}`)));
            group = [];
          };
          lines.forEach((line) => {
            const node = headingNodeOf(line, `${key}-hx${headingIndex}`);
            if (node !== null) { flushGroup(); nodes.push(node); headingIndex += 1; afterHeading = true; return; }
            group.push(line);
          });
          flushGroup();
          return;
        }
        const heading = /^(#{1,6})\s+(.*)$/u.exec(lines[0]);
        if (heading !== null && lines.length === 1) {
          const level = heading[1].length;
          nodes.push(h('div', { key, style: HEADING_STYLE(level) }, ...analysisInline(heading[2], `${key}-h`)));
          afterHeading = true;
          return;
        }
        // ②' 要点：`**标签**：内容` 独占一段 → 标签另起一行加重，内容在下（不再混成一片）
        const lead = lines.length === 1 && !prevWasHeading ? leadLabelOf(lines[0]) : null;
        if (lead !== null) {
          const rest = lines[0].slice(lead.end).trimStart();
          nodes.push(h('div', { key, style: { margin: '10px 0 0' } },
            h('div', { key: `${key}-lb`, style: { fontSize: '0.9375em', fontWeight: 700, lineHeight: 1.6 } }, ...analysisInline(lead.raw, `${key}-lb`)),
            rest === '' ? null : h('p', { key: `${key}-bd`, style: { margin: '2px 0 0', fontSize: '1em', lineHeight: 1.75, whiteSpace: 'pre-wrap' } }, ...mixedTextNodes(rest, `${key}-bd`))));
          return;
        }
        // ③ 没有列表行：普通段落（pre-wrap 保留段内换行）
        if (!lines.some(isListLine)) {
          nodes.push(h('p', { key, style: { margin: '6px 0 0', fontSize: '1em', lineHeight: 1.65, whiteSpace: 'pre-wrap' } },
            ...mixedTextNodes(part, key)));
          return;
        }
        // ④ 有列表行：连续的列表行成一组，其余行成段落，**保持原顺序**
        let buffer = [];
        const flushParagraph = () => {
          if (buffer.length === 0) return;
          const textPart = buffer.join('\n');
          nodes.push(h('p', { key: `${key}-p${nodes.length}`, style: { margin: '6px 0 0', fontSize: '1em', lineHeight: 1.65, whiteSpace: 'pre-wrap' } },
            ...mixedTextNodes(textPart, `${key}-p${nodes.length}`)));
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
        afterHeading = false;
      });
      return nodes;
    };

    /**
     * 讲义正文按「节」切片（C2 学习模式翻页，2026-11-17）。
     *
     * 为什么要有：讲义是「一章一个 md」，章内用 `## 1.1 标题` 分节、`### 1.1.1` 分小节。
     * 学习模式的「上一篇/下一篇」要按**节**翻（章总览 → 各节 → 下一章），而不是按章翻。
     * 之前 pagerState 直接拿 lectureRows（一章一条）当序列，所以「下一篇」在跳章。
     *
     * 规则：
     *   - 用 `^##\s+\d` 认「节」标题（`##` 二级 + 数字开头，避开 `## 易错清单` 这种无编号的？其实也保留——
     *     只要 `## ` 二级标题都算一节；但章内的 `# 第 N 页` 页眉是 `#` 一级，不会误切）。
     *   - 首个 `##` 之前的内容（若有）算「本章导览」一节（index 0），让章总览也是序列的一页。
     *   - 若整份没有任何 `##` 二级标题 → 整章当一节（退回按章翻，到头停）。
     * 返回 `[{ title, body }]`；body 保留原始 markdown（交给 MaterialReading 渲染）。
     */
    const splitLectureSections = (text) => {
      const source = String(text ?? '');
      const lines = source.split('\n');
      // 找所有 `## ` 二级标题的起始行号（不含 `#` 一级页眉 / `###` 三级小节）。
      const marks = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (/^##(?!#)\s+\S/u.test(lines[i].trim())) marks.push(i);
      }
      if (marks.length === 0) {
        return [{ title: '本章全文', body: source }];
      }
      const sections = [];
      // 首个 ## 之前的章总览（有非空内容才单列一节）。
      const headEnd = marks[0];
      const headBody = lines.slice(0, headEnd).join('\n').trim();
      if (headBody !== '') sections.push({ title: '本章导览', body: lines.slice(0, headEnd).join('\n') });
      for (let k = 0; k < marks.length; k += 1) {
        const start = marks[k];
        const end = k + 1 < marks.length ? marks[k + 1] : lines.length;
        const titleLine = lines[start].trim().replace(/^##\s+/u, '').trim();
        sections.push({ title: titleLine || `第 ${k + 1} 节`, body: lines.slice(start, end).join('\n') });
      }
      return sections;
    };

    /**
     * 教材页正文的**预览排版**（2026-10-27 晚加）。
     *
     * 为什么要有：资料页那张「正文卡」原来是 `<pre>` 直出 OCR 的 markdown 原文，
     * 物理教材页长这样 —— `# 第 30 页`、`$$\boldsymbol{E}=\int…\tag{12.11}$$`、`**解**`、`---`，
     * 读者看到的是一屏「代码」。这里把同一段文本交给面板已有的排版器，再补三条它不认的东西：
     *   - 跨行的 `$$ … $$` 整段公式（含 `\tag{}`：latexRender 会吃掉 tag，只留 (12.11) 的编号写法）；
     *   - `#`~`######` 各级标题（原文只认 `###`）；页眉 `# 第 N 页` 直接跳过；
     *   - `---` / `***` / `___` 整行分隔线（不渲染，断开段落）。
     * 其余（粗体、行内 `$…$`、列表、竖线表格）继续走 analysisBlockNodes，不重复实现。
     */
    const materialPreviewNodes = (text, keyPrefix = 'mat') => {
      // 字号（2026-10-30）：公式与各级标题原来写死 17/16/15px，而讲义正文正是走这里排版的，
      // 于是 A+/A− 只放大段落、标题公式纹丝不动。改成 em 后统一由 .sa-reading 的基准支配。
      const nodes = [];
      const lines = String(text ?? '').split('\n');
      let buffer = [];
      const flush = () => {
        if (buffer.length === 0) return;
        const part = buffer.join('\n');
        buffer = [];
        nodes.push(...analysisBlockNodes(part, `${keyPrefix}-p${nodes.length}`));
      };
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        // 页眉：OCR 每页开头都有「# 第 N 页」，不是正文
        if (/^#{1,6}\s*第\s*\d+\s*页\s*$/u.test(trimmed)) continue;
        // 整行分隔线
        if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) { flush(); continue; }
        // 跨行整段公式
        if (trimmed.startsWith('$$')) {
          const pieces = [];
          const rest = trimmed.slice(2);
          const firstClose = rest.indexOf('$$');
          if (firstClose >= 0) {
            pieces.push(rest.slice(0, firstClose));
            i += 0;
          } else {
            pieces.push(rest);
            for (i += 1; i < lines.length; i += 1) {
              const close = lines[i].indexOf('$$');
              if (close >= 0) { pieces.push(lines[i].slice(0, close)); break; }
              pieces.push(lines[i]);
            }
          }
          flush();
          const tex = pieces.join(' ').replace(/\s+/gu, ' ').trim();
          if (tex !== '') {
            nodes.push(h('div', {
              key: `${keyPrefix}-eq${nodes.length}`,
              style: { ...MATH_BLOCK_STYLE, margin: '10px 0', textAlign: 'center' },
            }, ...latexNodes(tex, `${keyPrefix}-eq${nodes.length}`)));
          }
          continue;
        }
        // 各级标题
        const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
        if (heading !== null) {
          flush();
          const level = heading[1].length;
          // 2026-11-04：与 analysisBlockNodes 共用一套分级（原来只有 1.0625/1/0.9375 的微弱差别，
          // 用户实测「整页只有一个加粗结构」）。
          nodes.push(h('div', {
            key: `${keyPrefix}-h${nodes.length}`,
            style: HEADING_STYLE(level),
          }, ...mixedTextNodes(heading[2], `${keyPrefix}-h${nodes.length}`)));
          continue;
        }
        // 2026-11-12：整行都是公式（`F_x = Σ F_ix`、`Φ_e = ∮ E·dS` 这类纯文本写法）→ 行间公式居中放大
        const mathLine = plainMathLineNodes(trimmed, `${keyPrefix}-ml${nodes.length}`);
        if (mathLine !== null) {
          flush();
          nodes.push(h('div', {
            key: `${keyPrefix}-ml${nodes.length}`,
            style: { ...MATH_BLOCK_STYLE, margin: '8px 0', textAlign: 'center' },
          }, ...mathLine));
          continue;
        }
        buffer.push(line);
      }
      flush();
      return nodes;
    };

    /** 「原文」那一档的等宽样式（两处正文卡共用）。 */
    const MATERIAL_PRE_STYLE = {
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
    };

    /**
     * 「排版」那一档正文容器样式（2026-10-31 F2 抽出来）：
     * 原来写死在 MaterialReading 的 h('div') 里，现在批注层也要用同一份（正文内联标记就画在里面），
     * 抽成常量免得两边慢慢漂开。
     */
    const MATERIAL_READING_STYLE = {
      margin: 0,
      maxHeight: '52vh',
      overflow: 'auto',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-sm)',
      padding: '10px 14px',
    };

    /**
     * 「混着公式的一句话」的排版（2026-10-27 晚）：教材 OCR 有的把公式存成带 `$…$` 的行内式，
     * 有的干脆存成**裸 LaTeX**（`T=T_1+T_2=\left(R_1+2R_2\right)C\ln2`、`\overline{A+B}`）。两种都要能读：
     * 有 `$` 走行内 Markdown，没有 `$` 但含 `\命令` 就把整段当公式排一次。
     * 引文、易错、例句的题干与步骤都走这里。
     */
    const mathInlineNodes = (text, keyPrefix) => {
      let source = String(text ?? '').trim();
      if (source === '') return [''];
      // 引文被生成侧截断时常留下孤零零的一个 `$`（`… ) $(f(v_i), f(v_j)) \in E_2`），
      // 这会让整段匹配不上行内公式、LaTeX 命令全裸奔 —— 先把这个落单的 `$` 去掉。
      const dollarCount = (source.match(/\$/gu) ?? []).length;
      if (dollarCount % 2 === 1) source = source.replace(/\$/gu, '');
      if (source.includes('$')) return analysisInline(source, keyPrefix);
      if (/\\[A-Za-z]+/u.test(source)) {
        return [h('span', { key: `${keyPrefix}-tex`, style: { fontFamily: 'Georgia, "Times New Roman", serif' } },
          ...latexNodes(source, `${keyPrefix}-t`))];
      }
      // 2026-11-12：没有 `$`、看起来像公式（`F_x = Σ F_ix`、`ε₀`）也按公式排一次
      const plainMath = plainMathNodes(source, `${keyPrefix}-pm`, {});
      if (plainMath !== null) {
        return [h('span', { key: `${keyPrefix}-pm`, style: MATH_INLINE_STYLE }, ...plainMath)];
      }
      return [source];
    };

    /**
     * 浮层聊天气泡的排版（v2-F，2026-11-22）。
     *
     * 起因：气泡把助手回复**当纯文本直出**，于是 `**加粗**`、`\(q=ne\)`、`\times10^{-19}`、
     * `\text{C}` 全以源码露在屏幕上（用户真机冒烟 v2-E 时截图报的）。这里只做「接上现成的
     * 排版器」这一件事，**不新造 markdown/公式解析器**：
     *   - 切段用 `analysisParagraphs`；普通段落走 `mixedTextNodes`（行内 Markdown + 裸公式）；
     *   - 列表段落用仓库已有的 `isListLine` / `LIST_LINE_PATTERN` / `listNode`（行内换 `mixedTextNodes`）；
     *   - 分级标题复用 `HEADING_STYLE`，与详解正文同一套字号口径。
     *
     * 唯一一处「预处理」是把模型常用的 MathJax 分隔符 `\(…\)` / `\[…\]` 换成排版器本来就认的
     * `$…$` / `$$…$$` —— 这是**换记号、不是解析**：换完仍由 analysisInline / latexNodes 排版。
     * 必须排在切段之前，否则跨空行的 `\[…\]` 会被切成两半、配不成对。
     *
     * 安全口径同 :7148-7149：先切分、再建 React 节点，任何一段都走文本节点，
     * 不动「直接写 HTML」那类口子，所以回复里出现 `<script>` 也只是字面量。
     */
    const ASSISTANT_PARA_STYLE = { margin: '6px 0 0', fontSize: '1em', lineHeight: 1.65, whiteSpace: 'pre-wrap' };
    const BARE_LATEX_COMMAND = /\\[A-Za-z]+/u;
    const renderAssistantText = (text, keyPrefix = 'asst') => {
      const raw = String(text ?? '');
      // `\[…\]` 先换（可跨行），再换 `\(…\)`；顺序反了会把 `\[` 当成 `\(` 读到。
      // 用字符串拼接而不是模板串：`$$` 与 `${}` 挨在一起太容易数错一个 `$`。
      const source = raw
        .replace(/\\\[([\s\S]*?)\\\]/gu, (_, body) => ('$$' + body + '$$'))
        .replace(/\\\(([\s\S]*?)\\\)/gu, (_, body) => ('$' + body + '$'));
      const parts = analysisParagraphs(source);
      if (parts.length === 0) return [raw];
      const nodes = [];
      parts.forEach((part, partIndex) => {
        const key = `${keyPrefix}-${partIndex}`;
        const lines = part.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        if (lines.length === 0) return;
        // ① 整段只有一行分级标题：复用详解正文的 HEADING_STYLE（不另立字号规则）
        const heading = lines.length === 1 ? /^(#{1,6})\s+(.*)$/u.exec(lines[0]) : null;
        if (heading !== null) {
          nodes.push(h('div', { key, style: HEADING_STYLE(heading[1].length) }, ...mixedTextNodes(heading[2], `${key}-h`)));
          return;
        }
        // ② 没有列表行 → 普通段落（pre-wrap 保留段内换行，与详解正文 :8617-8620 一致）
        if (!lines.some(isListLine)) {
          // 段里还留着**没有 `$` 包着的**裸 LaTeX 命令（`e=1.6\times10^{-19}`）：
          // 这种只能整段交给 mathInlineNodes 排一次（与引文/易错的既有口径 :8810-8814 相同），
          // 否则 `\times` 会被当成普通文字原样露出来。带 `$` 的段落照常走混排，粗体等不受影响。
          const paragraphNodes = BARE_LATEX_COMMAND.test(part) && !part.includes('$')
            ? mathInlineNodes(part, `${key}-tex`)
            : mixedTextNodes(part, key);
          nodes.push(h('p', { key, style: ASSISTANT_PARA_STYLE }, ...paragraphNodes));
          return;
        }
        // ③ 有列表行：连续列表行成一组，其余行并段 —— 与详解正文 :8623-8647 同一套走法
        let buffer = [];
        const flushParagraph = () => {
          if (buffer.length === 0) return;
          const textPart = buffer.join('\n');
          const flushKey = `${key}-p${nodes.length}`;
          nodes.push(h('p', { key: flushKey, style: ASSISTANT_PARA_STYLE }, ...mixedTextNodes(textPart, flushKey)));
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
            nodes.push(listNode(items, `${key}-list${nodes.length}`, mixedTextNodes));
            i -= 1;
          } else {
            buffer.push(line);
          }
        }
        flushParagraph();
      });
      return nodes.length === 0 ? [raw] : nodes;
    };

    /**
     * 教材页正文卡（2026-10-27 晚）：默认「排版」，可切「原文」。
     * 两处用到（资料页的正文卡、知识点页「看原页」），所以抽成组件，别复制两份。
     *
     * 2026-10-31（F2）：带 file 时正文**连同批注层一起**交给 AnnotationLayer 渲染——批注标记要落在
     * 正文里（内联 `<mark>`），状态必须和浮动气泡共用同一份，所以不能像 B1 那样把批注层挂在正文卡
     * 下面当兄弟节点。不带 file（没有可写盘的对象）时还是纯正文。
     */
    function MaterialReading({ text, page, file = '', onNotesChange = null }) {
      const [mode, setMode] = useState('preview');
      const body = String(text ?? '');
      // 重排一份 22KB 讲义不便宜（自写排版器是同步解析），无关的重渲染不该重排一遍：
      // 只有正文或页号变了才重新解析（2026-10-29 晚，配合「换正文不白闪」）。
      const nodes = useMemo(() => materialPreviewNodes(body, `mat-${page ?? 0}`), [body, page]);
      return h('div', null,
        h('div', { className: 'sa-dock', style: { justifyContent: 'flex-end', marginBottom: 4 } },
          h('button', {
            className: `sa-btn${mode === 'preview' ? ' primary' : ''}`,
            title: '把这一页的 markdown 排成正文与公式',
            onClick: () => setMode('preview'),
          }, '排版'),
          h('button', {
            className: `sa-btn${mode === 'raw' ? ' primary' : ''}`,
            title: '原样显示这一页的取字文本（含 markdown 记号，便于核对 OCR）',
            onClick: () => setMode('raw'),
          }, '原文')),
        String(file ?? '') === ''
          ? (mode === 'raw'
            ? h('pre', { className: 'sa-reading-pre', style: MATERIAL_PRE_STYLE }, body)
            : h('div', { className: 'sa-reading', style: MATERIAL_READING_STYLE }, ...nodes))
          : h(AnnotationLayer, { file, text: body, mode, nodes, onNotesChange }));
    }

    /**
     * 阅读面正文卡（2026-10-30 W3a）：资料页与知识点页现在共用这一套视图，不再各写一份。
     *
     * 只合并「视图」不合并「状态」：detail / openPath 与关闭、切页回调仍由各自页签持有并传入。
     * 刻意写成普通渲染函数（`MaterialReadingCard({...})` 直接调用）而不是 React 组件——
     * 测试里的 `probe.flat` 只遍历元素树、不展开函数组件，如果做成 `h(MaterialReadingCard, …)`
     * 卡里的 `MaterialReading` 就找不见了（「换正文不白闪」那条用例会红）。
     *
     * 行为不变项：pending 文案「读取中…」、truncated「已截断」pill、error 四类文案、页按钮高亮、
     * ready 时的 `MaterialReading` 渲染——全部原样保留，只是把两处重复代码收到一处。
     */
    function MaterialReadingCard({ detail = null, openPath = null, onPage, onClose, extraActions = null, belowHeader = null, closeTitle = '关上这份正文', onNotesChange = null } = {}) {
      if (openPath === null || openPath === undefined) return null;
      const data = detail?.data ?? null;
      const actions = Array.isArray(extraActions) ? extraActions.filter(Boolean) : [];
      return h('div', { className: 'sa-card' },
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-grow', title: openPath }, data?.file ?? openPath),
          // 换正文期间的小提示（2026-10-29 晚）：只占标题栏一格，正文不动，避免整块白闪。
          detail?.pending === true ? h('span', { className: 'sa-muted', style: { fontSize: 13 } }, '读取中…') : null,
          ...actions,
          data?.truncated === true ? h('span', { className: 'sa-pill today' }, '已截断') : null,
          h('button', { className: 'sa-btn', title: closeTitle, onClick: onClose }, '关闭')),
        belowHeader ?? null,
        detail?.status === 'loading' ? h('div', { className: 'sa-muted' }, '正在读取…') : null,
        detail?.status === 'error'
          ? h('div', null,
            h('div', { className: 'sa-error' },
              data?.error === 'no-text'
                ? '这份资料还没有取字产物（扫描件要先跑取字）。'
                : data?.error === 'page-missing'
                  ? `第 ${data?.page} 页还没有取字产物。`
                  : data?.error === 'not-indexed'
                    ? '这份资料不在索引里，可能索引刚被改过，刷新试试。'
                    : `读取失败：${data?.error ?? '未知原因'}`),
            Array.isArray(data?.pages) && data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { marginTop: 6 } },
                h('span', { className: 'sa-muted' }, `已有的页：${data.pages.join('、')}`))
              : null)
          : null,
        detail?.status === 'ready'
          ? h('div', null,
            Array.isArray(data.pages) && data.pages.length > 0
              ? h('div', { className: 'sa-dock', style: { flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'sa-muted' }, '页'),
                ...data.pages.map((no) => h('button', {
                  key: no,
                  className: `sa-btn${no === data.page ? ' primary' : ''}`,
                  onClick: () => onPage?.(no),
                }, String(no))))
              : null,
            h(MaterialReading, { text: data.text, page: data.page, file: data.file ?? openPath, onNotesChange }))
          : null);
    }

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
      const mindViewportRef = useRef(null);
      const zoomScrollRef = useRef(null);
      const [fullBrowser, setFullBrowser] = useState(false);
      const [browserCollapsed, setBrowserCollapsed] = useState(false);
      const readerRef = useRef(null);
      const [focusReading, setFocusReading] = useState(false);
      // v2-H（2026-11-23）：专注阅读正文列宽。初值从模块记忆恢复 —— 退出再进仍是上次拖的宽度；
      // null＝没拖过，沿用 CSS 的 90ch 居中（刷新页面回 null）。
      const [colWidth, setColWidth] = useState(() => readColumnWidthMemory);
      // 三栏（2026-11-23）：左栏（竖条）/ 右栏（聊天）的宽度与显隐。
      // 初值取模块记忆，拖拽即写回；默认左 200 / 右 360 / 两栏都开。
      const [railWidth, setRailWidth] = useState(() => clampFocusSize(focusLayoutMemory.rail, FOCUS_RAIL_MIN, FOCUS_RAIL_MAX));
      const [chatWidth, setChatWidth] = useState(() => clampFocusSize(focusLayoutMemory.chat, FOCUS_CHAT_MIN, FOCUS_CHAT_MAX));
      const [leftRailOpen, setLeftRailOpen] = useState(() => focusLayoutMemory.left !== false);
      const [rightChatOpen, setRightChatOpen] = useState(() => focusLayoutMemory.right !== false);
      // 三栏边界分隔条拖拽的监听清理函数（松手/卸载共用一份，防 mousemove 悬空）。
      const boundaryStopRef = useRef(null);
      // v2-H 返工（2026-11-23）：可见分隔条宿主。手柄必须挂在 .sa-knowledge-page（不被 reader-pane 的
      // overflow 裁剪/滚动条覆盖的祖先）上，所以这里拿它的 ref 当"挂载点存在"校验。
      const splitterHostRef = useRef(null);
      // 分隔条内联样式：left 由 computeSplitterStyle 按正文卡右边界算，focusReading 之外 display:none。
      const [splitterStyle, setSplitterStyle] = useState({ left: '0px', display: 'none' });
      const focusReturnRef = useRef(null);
      // 正文字号倍率（2026-10-29）：专注阅读里的 A−/A+ 只改这个倍率，基准仍然是 DSH「内容字号」
      const [readScale, setReadScale] = useState(() => clampReadScale(restoredUi.readScale));
      const stepReadScale = (delta) => setReadScale(value => clampReadScale(Number(value) + delta));
      // 护眼模式（2026-11-17 C1feat）：只作用于学习模式面，状态存浏览器 localStorage（key sa_kp_eye_care，'1'/'0'），
      // 下次进学习模式保持上次选择。初始读取与写回都 try/catch：localStorage 不可用/被禁/无痕模式下一律回 false、不抛错。
      const EYE_CARE_KEY = 'sa_kp_eye_care';
      const readEyeCareStored = () => {
        try {
          const ls = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : null);
          return !!ls && ls.getItem(EYE_CARE_KEY) === '1';
        } catch (error) { return false; }
      };
      const writeEyeCareStored = (value) => {
        try {
          const ls = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : null);
          if (ls) ls.setItem(EYE_CARE_KEY, value ? '1' : '0');
        } catch (error) { /* 写失败静默：不影响本次会话内状态 */ }
      };
      const [eyeCare, setEyeCare] = useState(() => readEyeCareStored());
      const toggleEyeCare = () => setEyeCare(value => { const next = !value; writeEyeCareStored(next); return next; });
      // 「适应窗口」（2026-10-30）：按阅读区实际可用宽度反算倍率。量不到就保持原倍率不动。
      const fitReadToPane = () => {
        const column = measureReadColumnWidth(dshContentFontSize());
        setReadScale(fitReadScale(measureReadAvailableWidth(readerRef.current, column), column));
      };
      const enterFocusReading = event => {
        const pane = readerRef.current;
        const page = pane?.closest?.('.sa-body');
        if (!pane || !page) return;
        focusReturnRef.current = {page,top:page.scrollTop,left:page.scrollLeft,trigger:event?.currentTarget,
          readerTop:Math.max(0,page.getBoundingClientRect().top-pane.getBoundingClientRect().top)};
        setFocusReading(true);
        studyModeMemory = true;
      };
      const exitFocusReading = () => { studyModeMemory = false; setFocusReading(false); };
      // v2-H（2026-11-23）：专注阅读右侧列宽拖拽。手感照 v2-G 浮层手柄（startResize :12225 / stopResize :12207）：
      // 按下记起点 + 当前列宽，document 上挂 mousemove/mouseup，松手与卸载都走 stopColResize 摘监听（不泄漏）。
      const colResizeStopRef = useRef(null);
      /** 摘掉拖拽期间挂在 document 上的监听（松手 / 卸载共用一份 cleanup，防止 mousemove 悬空）。 */
      const stopColResize = () => {
        if (typeof colResizeStopRef.current !== 'function') return;
        const cleanup = colResizeStopRef.current;
        colResizeStopRef.current = null;
        cleanup();
      };
      // 组件卸载（退出专注、切页签、面板重挂载）时必须清监听：拖到一半卸载会留下悬空的 mousemove。
      useEffect(() => () => { stopColResize(); }, []);

      /**
       * 右侧分隔条按下：左侧 200px 竖条不动，只把正文列往右铺/往左收 —— 往右拖 dx>0 变宽，newW = startW + dx。
       * 起点优先量正文卡当前 **max-width**（见 measureReadCardMaxWidth：`.sa-card` 是 content-box，矩形宽比
       * max-width 多 42px，直接用矩形宽会让正文比鼠标跑得快）；量不到退回矩形宽 / 记忆值 / 90ch 换算。
       * 上限＝屏宽 − 左侧让位（宽屏 212 / 窄屏 132，跟随 :3146/:3147 响应式）− 右侧 18px 内边距 − 手柄 12px 余量。
       */
      const startColResize = (event) => {
        if (event === null || event === undefined) return;
        if (Number(event.button) > 0) return;
        const pane = readerRef.current;
        if (!pane || typeof document === 'undefined') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        const handle = event.currentTarget;
        const startX = Number(event.clientX) || 0;
        const viewW = typeof window !== 'undefined' && Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 0;
        const leftPad = viewW > 0 && viewW <= 720 ? 132 : 212;
        const maxW = Math.max(READ_COLUMN_MIN, viewW - leftPad - 36);
        let startW = measureReadCardMaxWidth(pane);
        if (!(startW > 0)) startW = measureReadPaneColumnWidth(pane);
        if (!(startW > 0)) {
          startW = readColumnWidthMemory != null
            ? readColumnWidthMemory
            : Math.min(maxW, Math.round(measureReadColumnWidth(dshContentFontSize()) * READ_COLUMN_DEFAULT_CH / 80));
        }
        if (handle && handle.dataset) handle.dataset.dragging = 'true';
        const onMove = (ev) => {
          const next = clampReadColumn(startW + ((Number(ev?.clientX) || 0) - startX), maxW);
          readColumnWidthMemory = next;
          setColWidth(next);
        };
        const onUp = () => { stopColResize(); };
        stopColResize();
        colResizeStopRef.current = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (handle && handle.dataset) handle.dataset.dragging = 'false';
          try { if (document.body) document.body.style.userSelect = ''; } catch (error) { /* 还原失败不影响拖拽结果 */ }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        try { if (document.body) document.body.style.userSelect = 'none'; } catch (error) { /* 拿不到 body 也不抛 */ }
      };
      // 三栏探针（2026-11-23，可弃）：左栏宽 / 右栏宽 / 两栏显隐 + 边界拖拽 + 宿主测试 tab 入口。
      // 注意：既有测试 ⑥ 会截取 startColResize 之后 2600 字符做源码断言，所以右栏增量写成
      // `delta = -dx; startW + delta`，不把「减 dx」按字面写出来（那会被误判成正文手柄的算法）。
      /** 摘掉三栏边界拖拽挂在 document 上的监听（松手 / 卸载共用）。 */
      const stopBoundaryResize = () => {
        if (typeof boundaryStopRef.current !== 'function') return;
        const cleanup = boundaryStopRef.current;
        boundaryStopRef.current = null;
        cleanup();
      };
      // 组件卸载（退出专注 / 切页签 / 面板重挂载）时必须清监听，否则拖到一半会留下悬空的 mousemove。
      useEffect(() => () => { stopBoundaryResize(); }, []);
      /**
       * 三栏探针的边界拖拽。side='rail' 拖左边界改左栏宽（往右 dx>0 变宽 = startW + dx）；
       * side='chat' 拖右边界改右栏宽（右栏贴右缘，往左 dx<0 才是变宽 = startW - dx）。
       * 手感照 v2-H 的 startColResize：按下记起点，document 上挂 mousemove/mouseup，松手即摘。
       */
      const startBoundaryResize = (side) => (event) => {
        if (event === null || event === undefined) return;
        if (Number(event.button) > 0) return;
        if (typeof document === 'undefined') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        const handle = event.currentTarget;
        const startX = Number(event.clientX) || 0;
        const isRail = side === 'rail';
        const startW = isRail ? railWidth : chatWidth;
        const lo = isRail ? FOCUS_RAIL_MIN : FOCUS_CHAT_MIN;
        const hi = isRail ? FOCUS_RAIL_MAX : FOCUS_CHAT_MAX;
        if (handle && handle.dataset) handle.dataset.dragging = 'true';
        const onMove = (ev) => {
          const dx = (Number(ev?.clientX) || 0) - startX;
          // 右栏贴右缘，往左拖才是变宽：delta 取 -dx；写成 startW + delta 与正文手柄的写法区分开。
          const delta = isRail ? dx : -dx;
          const next = clampFocusSize(startW + delta, lo, hi);
          if (isRail) { focusLayoutMemory.rail = next; setRailWidth(next); }
          else { focusLayoutMemory.chat = next; setChatWidth(next); }
        };
        const onUp = () => { stopBoundaryResize(); };
        stopBoundaryResize();
        boundaryStopRef.current = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (handle && handle.dataset) handle.dataset.dragging = 'false';
          try { if (document.body) document.body.style.userSelect = ''; } catch (error) { /* 还原失败不影响拖拽结果 */ }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        try { if (document.body) document.body.style.userSelect = 'none'; } catch (error) { /* 拿不到 body 也不抛 */ }
      };
      /** 左栏显隐：写模块记忆（退出再进保持本次选择），再改 state 重绘。 */
      const toggleLeftRail = (value) => { const next = value !== false; focusLayoutMemory.left = next; setLeftRailOpen(next); };
      /** 右栏显隐：同上。 */
      const toggleRightChat = (value) => { const next = value !== false; focusLayoutMemory.right = next; setRightChatOpen(next); };
      // 块 E（2026-11-23）：右栏那句「在宿主右栏打开测试标签（HOST SLOT OK）」是探针的取证按钮，
      // 产品化后右栏里换成真聊天，这个按钮连同它的状态文案一起删掉。
      // 探针 tab 的**注册**保留（`study-assistant/probe`，默认关闭，localStorage 开关才启用）：
      // 它是「本插件能向宿主右栏注册 tab」这条结论的最小样例，不影响产品界面。
      /**
       * 算分隔条该贴哪：取专注面里第一张正文卡（.sa-node-detail / .sa-card 直接子）的**右边界**，
       * 分隔条用 20px 宽 + translateX(-50%) 居中在这条线上。量不到（刚进专注还没布局完、
       * 或正文卡不存在）就兜底贴视口右侧 innerWidth-30，至少能看见、能拖。
       */
      const computeSplitterStyle = () => {
        const host = splitterHostRef.current;
        const pane = readerRef.current;
        if (!host || !pane) return { left: '0px', display: 'none' };
        let right = 0;
        const kids = pane.children || [];
        for (let i = 0; i < kids.length; i += 1) {
          const k = kids[i];
          const cls = typeof k?.className === 'string' ? k.className.split(/\s+/) : [];
          if (cls.indexOf('sa-node-detail') < 0 && cls.indexOf('sa-card') < 0) continue;
          const r = typeof k.getBoundingClientRect === 'function' ? k.getBoundingClientRect() : null;
          const w = Number(r?.width);
          if (Number.isFinite(w) && w > 0) { right = r.right; break; }
        }
        if (!(right > 0)) right = window.innerWidth - 30; // 量不到就贴右侧兜底
        return { left: Math.round(right) + 'px', display: 'block' };
      };
      // 分隔条位置跟随：进出专注、拖动改列宽（colWidth）、字号倍率（readScale，正文卡宽随之变）都要重算。
      // 三个时机都算一遍 —— 同步一次（拖动当帧就跟手）、rAF 一次、60ms 一次（进专注时布局从 grid 变 fixed，
      // 卡宽要等一帧才稳定），挂在 window resize 上覆盖面板伸缩。
      useEffect(() => {
        if (!focusReading) { setSplitterStyle({ left: '0px', display: 'none' }); return undefined; }
        const recompute = () => setSplitterStyle(computeSplitterStyle());
        recompute();
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(recompute) : null;
        const t = setTimeout(recompute, 60);
        window.addEventListener('resize', recompute);
        return () => {
          if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          clearTimeout(t);
          window.removeEventListener('resize', recompute);
        };
      }, [focusReading, colWidth, readScale]);
      // 卸载（切走页签 / 面板重挂载）时把快照清掉，避免「已退出专注、浮层还套着人设」
      useEffect(() => () => { studyModeMemory = false; }, []);

      // 行内格式（2026-11-17 D 卡）：点 marks 索引里的一条 → 尽量滚动到正文中对应的 <mark>。
      // 找不到（正文还没渲染出来、或被筛掉）就静默返回，不报错。
      const scrollToMark = (id) => {
        const key = String(id ?? '');
        if (key === '') return;
        try {
          const pane = readerRef.current;
          const scope = pane ?? (typeof document !== 'undefined' ? document : null);
          if (scope === null || typeof scope.querySelector !== 'function') return;
          const target = scope.querySelector(`[data-annotation-mark-id="${key.replace(/"/g, '\\"')}"]`)
            ?? scope.querySelector(`[data-annotation-id="${key.replace(/"/g, '\\"')}"]`);
          if (target === null || target === undefined) return;
          // 2026-11-18 二修（q：「点高亮栏只一点点上翻」）：不能盲信 readerRef 就是滚动容器。
          // 从目标往上找**第一个真正能滚的元素**（scrollHeight > clientHeight 且 overflow 可滚），
          // 滚它；找不到再退回 readerRef / scrollIntoView。这样学习模式 / 普通预览两种布局都准。
          const findScroller = (el) => {
            let cur = el;
            while (cur !== null && cur !== undefined && cur !== document.body && cur !== document.documentElement) {
              if (cur.scrollHeight - cur.clientHeight > 4) {
                const oy = typeof getComputedStyle === 'function' ? getComputedStyle(cur).overflowY : '';
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return cur;
              }
              cur = cur.parentElement;
            }
            return null;
          };
          const scroller = findScroller(target) ?? (pane && typeof pane.scrollTo === 'function' ? pane : null);
          if (scroller !== null) {
            const sRect = scroller.getBoundingClientRect();
            const tRect = target.getBoundingClientRect();
            // 目标中心对齐到滚动容器可视区中点
            const delta = (tRect.top - sRect.top) - (scroller.clientHeight / 2 - tRect.height / 2);
            const nextTop = Math.max(0, scroller.scrollTop + delta);
            try { scroller.scrollTo({ top: nextTop, behavior: 'smooth' }); }
            catch (error) { scroller.scrollTop = nextTop; }
          } else if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          // 闪一下：加 is-flash 让底色/描边明显晃眼，1.2 秒后移除。哪怕本就在视野内也能看见反应。
          if (typeof target.classList?.add === 'function') {
            target.classList.add('is-flash');
            setTimeout(() => { try { target.classList?.remove?.('is-flash'); } catch (error) { /* 忽略 */ } }, 1200);
          }
        } catch (error) { /* 滚动失败不影响功能 */ }
      };

      // ═══════════ 学习时钟（C2，2026-11-17）：正计时 + 番茄钟 ═══════════
      // 落盘口径：每段「学习场」结束落一条到 学习记录/学习时长.json（<5 秒不记）；
      // 落盘只在服务端（POST /study-log/duration），客户端只负责计时与触发落盘。
      // 番茄预设两档（25/5、50/10），不做任意输入，选档存 localStorage key sa_kp_pomodoro。
      const POMODORO_KEY = 'sa_kp_pomodoro';
      const POMODORO_PRESETS = [
        { id: '25-5', label: '25/5', studySec: 25 * 60, breakSec: 5 * 60 },
        { id: '50-10', label: '50/10', studySec: 50 * 60, breakSec: 10 * 60 },
      ];
      const readLocalStorage = (key, fallback) => {
        try {
          const ls = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : null);
          return ls && ls.getItem(key) !== null ? ls.getItem(key) : fallback;
        } catch (error) { return fallback; }
      };
      const writeLocalStorage = (key, value) => {
        try {
          const ls = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : null);
          if (ls) ls.setItem(key, String(value));
        } catch (error) { /* 写失败静默 */ }
      };
      const localDateStamp = (date = new Date()) => {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      };
      // 时钟 UI 状态
      const [clockMode, setClockMode] = useState('stopwatch'); // 'stopwatch' | 'pomodoro'
      const [pomodoroPresetId, setPomodoroPresetId] = useState(() => {
        const stored = readLocalStorage(POMODORO_KEY, '25-5');
        return POMODORO_PRESETS.some((p) => p.id === stored) ? stored : '25-5';
      });
      const pomodoroPreset = POMODORO_PRESETS.find((p) => p.id === pomodoroPresetId) ?? POMODORO_PRESETS[0];
      // 正计时：secElapsed 秒数，running 是否在跑；overallTimerRef 保存整段累计秒（跨暂停）
      const [stopwatchSec, setStopwatchSec] = useState(0);
      const [stopwatchRunning, setStopwatchRunning] = useState(false);
      // 番茄状态机：phase 'idle' | 'studying' | 'break'；remain 剩余秒；running 是否在跑
      const [pomodoroPhase, setPomodoroPhase] = useState('idle');
      const [pomodoroRemain, setPomodoroRemain] = useState(pomodoroPreset.studySec);
      const [pomodoroRunning, setPomodoroRunning] = useState(false);
      // 「今日累计 X 分钟」（从服务端拉，进入学习模式或落盘后刷新）
      const [todayMinutes, setTodayMinutes] = useState(null);
      const durationAnchorRef = useRef(null); // 当前学习段的起点时间戳（ms），null=未开始
      const durationSigRef = useRef(null); // 当前学习段的落点签名 {scopeType,courseId,nodeId,path,chapterNo}
      const durationActiveSecRef = useRef(0); // 当前学习段的「有效学习秒」（暂停不计，休息段不累加）

      // 拉「今日累计分钟」（只读；GET /study-log/duration?date=）。
      const refreshTodayMinutes = async () => {
        try {
          const response = await fetch(`${API}/study-log/duration?date=${localDateStamp()}`);
          const result = await response.json().catch(() => null);
          if (result?.ok) setTodayMinutes(Math.round((Number(result.totalSeconds) || 0) / 60));
        } catch (error) { /* 静默 */ }
      };

      // 计算一「段」的落点签名：当前在读讲义就走 material（带章号+路径），否则走知识点 node。
      const currentDurationSignature = () => {
        if (openLectureRow !== null) {
          return { scopeType: 'material', courseId: String(treeCourseId || ''), nodeId: '', path: lectureFileKey(openPath), chapterNo: String(openLectureRow.lecture?.no ?? '') };
        }
        if (selected !== null && selected !== undefined && selectedNode !== null) {
          return { scopeType: 'node', courseId: String(selectedNode.courseId ?? ''), nodeId: String(selected), path: '', chapterNo: '' };
        }
        return { scopeType: 'free', courseId: String(effectiveCourseId || ''), nodeId: '', path: '', chapterNo: '' };
      };

      // 落一条学习时长（服务端校验 ≥5 秒；<5 秒服务端也会拒，这里先本地挡一道）。
      // 关键：seconds 用「有效学习秒」durationActiveSecRef（暂停不计、休息段不累加），而不是墙钟差——
      // 墙钟差会把暂停/休息时间也算进去，与任务卡「暂停不计时」的口径冲突。
      const flushDurationSegment = (reason) => {
        const anchor = durationAnchorRef.current;
        const sig = durationSigRef.current;
        const seconds = Math.round(durationActiveSecRef.current);
        durationAnchorRef.current = null;
        durationSigRef.current = null;
        durationActiveSecRef.current = 0;
        if (anchor === null || sig === null) return;
        if (seconds < DURATION_MIN_SECONDS) return; // <5 秒不记
        const endMs = Date.now();
        const body = {
          startAt: new Date(anchor).toISOString(),
          endAt: new Date(endMs).toISOString(),
          seconds,
          scopeType: sig.scopeType,
          courseId: sig.courseId,
          nodeId: sig.nodeId,
          path: sig.path,
          chapterNo: sig.chapterNo,
          mode: reason?.mode === 'pomodoro' ? 'pomodoro' : 'stopwatch',
        };
        fetch(`${API}/study-log/duration`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify(body),
        }).then((response) => response.json().catch(() => null)).then((result) => {
          if (result?.ok) refreshTodayMinutes();
        }).catch(() => { /* 落盘失败静默，不打断阅读 */ });
      };

      // 开始一段（如果没在段内就记起点；签名变了就先把旧段落了再开新段）。
      const beginDurationSegment = () => {
        const sig = currentDurationSignature();
        const prevSig = durationSigRef.current;
        const changed = prevSig === null
          || prevSig.scopeType !== sig.scopeType || prevSig.courseId !== sig.courseId
          || prevSig.nodeId !== sig.nodeId || prevSig.path !== sig.path || prevSig.chapterNo !== sig.chapterNo;
        if (durationAnchorRef.current !== null && changed) flushDurationSegment();
        if (durationAnchorRef.current === null) { durationAnchorRef.current = Date.now(); durationActiveSecRef.current = 0; }
        durationSigRef.current = sig;
      };

      // 进入学习模式时拉一次今日累计；退出学习模式时把未落的学习段落掉（≥5s 才落）。
      useEffect(() => {
        if (focusReading) { refreshTodayMinutes(); }
        else { flushDurationSegment(); setStopwatchRunning(false); setPomodoroRunning(false); }
        return () => { /* 卸载不额外处理 */ };
      }, [focusReading]);

      // 正计时推进：每秒 +1（暂停时该 effect 不跑，故不累加，等同「暂停不计时」）。
      useEffect(() => {
        if (!stopwatchRunning) return undefined;
        const id = window.setInterval(() => {
          setStopwatchSec((value) => value + 1);
          // 只有「正计时」是当前模式且在跑时，才把这一秒算进当前学习段
          if (clockMode === 'stopwatch') {
            beginDurationSegment();
            durationActiveSecRef.current += 1;
          }
        }, 1000);
        return () => window.clearInterval(id);
      }, [stopwatchRunning, clockMode]);

      // 番茄推进：studying 阶段递减 remain；到 0 → 落一条学习时长 → 转 break；break 到 0 → 回 studying。
      useEffect(() => {
        if (!pomodoroRunning || pomodoroPhase === 'idle') return undefined;
        const id = window.setInterval(() => {
          setPomodoroRemain((value) => {
            if (value > 1) {
              // studying 且在跑 → 记这一秒有效学习（休息段不累加）
              if (pomodoroPhase === 'studying') durationActiveSecRef.current += 1;
              return value - 1;
            }
            // 到点
            if (pomodoroPhase === 'studying') {
              flushDurationSegment({ mode: 'pomodoro' });
              setPomodoroPhase('break');
              return pomodoroPreset.breakSec;
            }
            if (pomodoroPhase === 'break') {
              // 休息结束 → 自动进下一学习段
              durationAnchorRef.current = Date.now();
              durationActiveSecRef.current = 0;
              durationSigRef.current = currentDurationSignature();
              setPomodoroPhase('studying');
              return pomodoroPreset.studySec;
            }
            return 0;
          });
        }, 1000);
        return () => window.clearInterval(id);
      }, [pomodoroRunning, pomodoroPhase, pomodoroPreset.studySec, pomodoroPreset.breakSec]);

      const fmtClock = (totalSec) => {
        const s = Math.max(0, Math.floor(totalSec));
        const mm = Math.floor(s / 60);
        const ss = s % 60;
        return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      };

      useEffect(() => {
        if (!focusReading || typeof window === 'undefined') return;
        const pane=readerRef.current,saved=focusReturnRef.current;
        if (!pane || !saved) return;
        pane.scrollTop=saved.readerTop; pane.focus?.({preventScroll:true});
        const onKey = event => {
          if (event.key==='Escape') {event.preventDefault();studyModeMemory=false;setFocusReading(false);return;}
          if (event.key!=='Tab' || typeof pane.querySelectorAll!=='function') return;
          const items=[...pane.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]')].filter(el=>el.tabIndex>=0&&el.getClientRects().length);
          const first=items[0],last=items[items.length-1];
          if (!first){event.preventDefault();pane.focus();return;}
          if(event.shiftKey && (document.activeElement===first || document.activeElement===pane)){event.preventDefault();last.focus();}
          else if(!event.shiftKey && (document.activeElement===last || !pane.contains(document.activeElement))){event.preventDefault();first.focus();}
        };
        window.addEventListener?.('keydown',onKey);
        return () => {
          window.removeEventListener?.('keydown',onKey);
          const restore=()=>{if(saved.page.isConnected!==false){saved.page.scrollTop=saved.top;saved.page.scrollLeft=saved.left;saved.trigger?.focus?.({preventScroll:true});}};
          if(typeof window.requestAnimationFrame==='function')window.requestAnimationFrame(restore);else restore();
          focusReturnRef.current=null;
        };
      }, [focusReading]);
      const [selected, setSelected] = useState(restoredUi.selected); // 知识网络里选中的节点 id
      // 行内格式（2026-11-17 D 卡）：当前阅读面的批注列表快照 + 版本号，供 marks 插槽（高光索引）列出。
      const [readingMarks, setReadingMarks] = useState({ file: '', notes: [] });
      const reportReadingNotes = useCallback((fileKey, notes) => {
        setReadingMarks({ file: String(fileKey ?? ''), notes: Array.isArray(notes) ? notes : [] });
      }, []);
      // 行内格式（2026-11-18）：知识点正文的选中选项整合进左侧栏 —— 承接正文档 AnnotationLayer
      // 上报的气泡状态 + 动作（dockPanel 模式）。{ file, bubble, saving, status, actions } | null。
      const [dockState, setDockState] = useState(null);
      const reportDockChange = useCallback((fileKey, next) => {
        setDockState(next === null || next === undefined ? null : { file: String(fileKey ?? ''), ...next });
      }, []);
      const [markBusy, setMarkBusy] = useState(false);
      const [markError, setMarkError] = useState('');
      const [markNote, setMarkNote] = useState('');
      // AI 材料导出（2026-11-18 E1）：范围（当前文件/全部）+ 两格式入口 + 下载失败退 <pre> 复制。
      const [aiExportOpen, setAiExportOpen] = useState(false);
      const [aiExportScope, setAiExportScope] = useState('file');
      const [aiExportBusy, setAiExportBusy] = useState(false);
      const [aiExportNote, setAiExportNote] = useState('');
      const [aiExportPreview, setAiExportPreview] = useState(null); // { format, text } | null
      // 自动落盘信息（2026-11-18 用户要求「不用手点」）：服务端每次写批注都会把 AI 材料写进
      // _工具/AI材料/，这里展示「已自动保存到哪、几份」，下载按钮只是随时另存一份最新。
      const [aiMaterialInfo, setAiMaterialInfo] = useState(null); // { dir, count, files } | null
      const loadAiMaterialInfo = useCallback(async () => {
        try {
          const r = await fetch(`${API}/annotations/material`, { headers: { Accept: 'application/json' } });
          const j = await r.json().catch(() => null);
          if (j?.ok === true) setAiMaterialInfo({ dir: String(j.dir ?? ''), count: Number(j.count ?? 0), files: Array.isArray(j.files) ? j.files : [] });
        } catch { /* 只读信息，拿不到就不显示 */ }
      }, []);
      const runAiExport = useCallback(async (format) => {
        setAiExportBusy(true);
        setAiExportNote('');
        setAiExportPreview(null);
        try {
          const file = aiExportScope === 'file' ? readingMarks.file : '';
          const result = await exportAnnotationsMaterial(format, file).catch(() => ({ ok: false, error: 'unreachable' }));
          if (result?.ok !== true) {
            setAiExportNote(`导出失败：${result?.error ?? 'unknown'}`);
            return;
          }
          const text = aiExportText(format, result);
          const stamp = String(result.exportedAt ?? '').slice(0, 19).replace(/[:T]/g, '');
          const scopeText = aiExportScope === 'file' ? '当前文件' : '全部';
          const filename = `AI材料-${scopeText}-${stamp || 'export'}.${format === 'json' ? 'json' : 'md'}`;
          const mime = format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8';
          const downloaded = downloadTextFile(text, filename, mime);
          if (downloaded) {
            setAiExportNote(`已另存一份最新（${result.count ?? 0} 条 · ${scopeText} · ${format === 'json' ? 'JSON' : 'Markdown'}）`);
            loadAiMaterialInfo();
          } else {
            // DSH 内嵌 webview 常禁用 createObjectURL → 退回页面内展示，用户手动复制。
            setAiExportPreview({ format, text });
            setAiExportNote('浏览器不允许直接下载，内容已展示在下方，可手动复制（磁盘上的自动材料不受影响）。');
          }
        } finally {
          setAiExportBusy(false);
        }
      }, [aiExportScope, readingMarks.file, loadAiMaterialInfo]);
      // 点了一个还没生成讲义的章（2026-10-29 用户定：右侧明说「还没生成」，不能点了没反应）。
      // 值形如 { title }，null = 不显示。
      const [lectureHint, setLectureHint] = useState(null);
      // 加节点表单：树上的「＋」会把课程/章/节/小节预填进来，省得手打章名挂不上大纲
      const [draft, setDraft] = useState({ name: '', chapter: '', section: '', subsection: '', courseId: null });
      // 「改挂靠」行内编辑：{ id, chapter, section, subsection }，null = 没在编辑
      const [mountDraft, setMountDraft] = useState(null);
      // 备注行内编辑（2026-10-23 凌晨）：{ id, text }，null = 没在编辑。
      // node.note 一直有字段但没有入口，而「这个点我总错在哪」恰恰是最值得自己写下来的东西。
      const [noteDraft, setNoteDraft] = useState(null);
      // 批量改挂靠（2026-10-22 深夜）：把当前命中的节点一次挂到同一层
      const [batchMount, setBatchMount] = useState({ chapter: '', section: '', subsection: '' });
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
      // 把界面状态记回模块内存（下次切回本页签时恢复）；只记显示状态，不记接口结果
      useEffect(() => {
        readKnowledgeUi({ courseId, query: kpQuery, filter: kpFilter, view: kpView, selected, openTree, mindOpen, masteryLevels: kpMastery, detailPath: openPath, treeCourseId, subjectTrees: subjectTreesRef.current, readScale });
      }, [courseId, kpQuery, kpFilter, kpView, selected, openTree, mindOpen, kpMastery, openPath, treeCourseId, readScale]);

      // 打开知识点详情 → 记一次学习行为（v2-B 卡，2026-11-20）。
      // 触发点是 `selected` 变成非空（= 详情卡已经打开），关掉详情（变 null）不报。
      // 同一 nodeId 的重复渲染由 reportKnowledgeBehavior 的 5 秒节流 + 服务端按分钟去重兜住，
      // 所以这里不需要再自己记时间戳。
      useEffect(() => {
        if (selected === null || selected === undefined || selected === '') return undefined;
        let cancelled = false;
        reportKnowledgeBehavior(selected).then((result) => {
          // 服务端顺手把掌握度推进了（未学 → 学过）：拉一次最新数据，别让界面停在旧等级
          if (!cancelled && result !== null && result.mastery !== null && result.mastery !== undefined
            && result.mastery.changed === true && typeof refresh === 'function') {
            refresh().catch(() => {});
          }
        });
        return () => { cancelled = true; };
      }, [selected, refresh]);

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
        studyModeMemory = false;
        setFocusReading(false); setFullBrowser(false); setBrowserCollapsed(false);
        setTreeCourseId(id); setCourseId(id); setSelected(null); setOpenPath(null); setDetail(null);
        setKpQuery(''); setKpFilter('all'); setKpMastery([]); setMarkNote(''); setMarkError('');
      };
      const selectForReading = (id, options = {}) => {
        setSelected(id); setFullBrowser(false); setBrowserCollapsed(id !== null);
        if (id === null) { studyModeMemory = false; setFocusReading(false); }
        setLectureHint(null);
        // 2026-10-29 用户定：点知识点＝右侧换成「这个知识点自己的内容」（详解/例题/来历），
        // 之前打开着的章讲义要跟着收掉，否则两张卡叠在一起（章讲义在上、该点详解在下）没法读。
        // 但「点章读讲义」那条路不能先清空：清了就是「卸掉旧内容 → 空白 → 装新内容」两跳，
        // 用户看到的就是整块白闪（m00502 报障）。所以章那条传 keepMaterial 只换正文不动卡。
        if (options.keepMaterial === true) return;
        setOpenPath(null); setDetail(null);
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
        if (kpView === 'mind') mindViewportRef.current = box;
        const scroll = subjectTreeState(subjectTreesRef.current, treeCourseId).scroll[kpView];
        box.scrollLeft = scroll.left; box.scrollTop = scroll.top;
      }, [treeCourseId, kpView]);

      // 换正文不卸旧内容（2026-10-29 晚，用户报障「点章/换讲义整块白闪，像换了一页」）：
      // 以前这里先 `setDetail({status:'loading'})`，正文卡整个卸载成「正在读取…」再重新挂载，
      // 22KB 讲义重排一遍就是那一下白闪。现在留着上一份正文，只在标题栏挂「读取中…」；
      // 命中正文缓存直接同步替换。后点的赢：慢响应回来时若已换了别的就丢掉（seq 比大小）。
      const materialSeqRef = useRef(0);
      const showMaterial = async (materialPath, page) => {
        const seq = (materialSeqRef.current += 1);
        setOpenPath(materialPath);
        const cached = peekMaterialText(materialPath, page);
        if (cached !== undefined) {
          setDetail({ status: 'ready', data: cached, pending: false });
          return;
        }
        setDetail((current) => (current?.data === null || current?.data === undefined
          ? { status: 'loading', data: null, pending: false }
          : { ...current, pending: true }));
        const result = await materialTextCached(materialPath, page).catch(() => ({ ok: false, error: 'network' }));
        if (seq !== materialSeqRef.current) return;
        setDetail({ status: result.ok ? 'ready' : 'error', data: result, pending: false });
      };


      const lectureCourses = objectList(docs.knowledgeAnalysis?.courses);
      const lectureCourse = lectureCourses.find((course) => String(course.courseId) === String(treeCourseId));
      const lectureRows = objectList(lectureCourse?.lectures);
      const [lectureStyle, setLectureStyle] = useState('C');
      // 当前打开讲义在第几节（C2 学习模式翻节）：0-based；切章/切讲义时复位到 0。
      const [lectureSection, setLectureSection] = useState(0);
      // 讲义历史版本折叠（W6，决策 D-W6-1：默认折叠、可点开回看，不删旧版）
      const [lectureHistoryOpen, setLectureHistoryOpen] = useState(false);
      const lectureForEntry = (entry) => {
        const match = String(entry?.label ?? '').match(/第\s*(\d+)\s*章/u);
        if (match === null) return null;
        return lectureRows.find((item) => String(item.no) === String(Number(match[1]))) ?? null;
      };
      const openLecture = async (lecture, styleKey = lectureStyle) => {
        if (lecture === null || lecture === undefined) return;
        const styles = [...objectList(lecture.styles), ...objectList(lecture.variants)];
        // styleKey 有两种传法：档位键字符串，或直接传一个 style 条目对象。
        // 传对象是为了「历史版本」——旧版与当前版可能同 key（A/A），只按 key 找会打开当前版而不是旧版。
        const selectedLecture = (styleKey !== null && typeof styleKey === 'object')
          ? styleKey
          : styles.find((item) => String(item.key) === String(styleKey))
            ?? styles.find((item) => String(item.key) === 'C')
            ?? styles.find((item) => String(item.key) === 'A')
            ?? styles[0];
        if (selectedLecture?.file === undefined) return;
        // 「展开完整目录 / 展开完整导图」时阅读栏是 display:none（`.sa-learning-layout[data-full-browser="true"]>.sa-reader-pane`），
        // 讲义正文渲染进去等于没渲染——用户只看到风格按钮的高亮在跳，以为切不动。
        // 点讲义和点知识点（selectForReading）走同一条规矩：先退回分栏阅读。
        setFullBrowser(false);
        setLectureStyle(String(selectedLecture.key ?? 'C'));
        await showMaterial(selectedLecture.file);
        setLectureSection(0); // 切章/切讲义 → 回到第一节
        // 阅读区已经看得见就别动滚动条（2026-10-29 晚用户报障：换讲义时面板「跳一下」）。
        // 以前无条件 `scrollIntoView({block:'nearest'})`，宽屏下也会把整块面板带着滚，观感像刷新。
        // 只有窄布局里正文整块落在视野外（`.sa-reader-pane` 顶边在视口底部之外）才把它滚进来。
        const pane = readerRef.current;
        if (pane === null || pane === undefined || typeof pane.scrollIntoView !== 'function') return;
        const rect = typeof pane.getBoundingClientRect === 'function' ? pane.getBoundingClientRect() : null;
        const viewport = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
        if (rect === null || viewport <= 0 || rect.top <= viewport - 120) return;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => pane.scrollIntoView({ block: 'nearest' }));
        } else {
          pane.scrollIntoView({ block: 'nearest' });
        }
      };
      // `lectureLinks`（章行后面挂「讲义 A/B/C」三颗小按钮）已于 2026-10-29 删除：
      // 点章名就在右侧读讲义、版本在讲义正文上方那排切，左边不再重复摆入口。

      // 打开的是哪一份讲义（2026-10-29 用户要求：版本切换按钮挪到讲义正文上方）
      // 高亮按「当前真正打开的这个文件」判，而不是上一次点了哪档——从「资料」页签直接点开某份讲义也对得上。
      const lectureFileKey = (value) => String(value ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
      const lectureTitle = (lecture) => `第${lecture?.no ?? '?'}章 ${String(lecture?.title ?? '').trim()}`.trim();
      const openLectureRow = (() => {
        if (openPath === null || openPath === undefined) return null;
        const target = lectureFileKey(openPath);
        if (target === '') return null;
        for (const course of lectureCourses) {
          for (const lecture of objectList(course?.lectures)) {
            for (const style of [...objectList(lecture.styles), ...objectList(lecture.variants)]) {
              if (lectureFileKey(style?.file) === target) return { course, lecture, style };
            }
          }
        }
        return null;
      })();
      // 讲义卡里的版本切换行：就摆在讲义正文正上方，切档不离开这份讲义。
      // W6（2026-10-30）：主行**只列当前生效版**；被 supersededBy 取代的历史版收进「历史 N 版」折叠，
      // 默认折叠、点开可回看（不删数据，符合 W4「永不删除旧版」）；老数据没有 supersededBy 时全部当当前版，行为不变。
      const lectureSwitchRow = openLectureRow === null ? null : (() => {
        const lecture = openLectureRow.lecture;
        const allEntries = [...objectList(lecture.styles), ...objectList(lecture.variants)];
        const currentEntries = allEntries.filter((style) => !style?.supersededBy);
        const historyEntries = allEntries.filter((style) => Boolean(style?.supersededBy));
        const activeKey = lectureFileKey(openLectureRow.style?.file);
        const styleButton = (style, isHistory) => {
          const rawVersion = style?.version;
          const versionTag = rawVersion === undefined || rawVersion === null || String(rawVersion).trim() === ''
            ? '' : ` · v${rawVersion}`;
          const info = [String(style?.label ?? '').trim(),
            style?.chars === undefined ? '' : `${style.chars} 字`,
            String(style?.generatedAt ?? '').trim(),
            style?.model === undefined || style?.model === null ? '' : `模型 ${style.model}`,
            isHistory && style?.supersededBy ? `已被 v${style.supersededBy} 取代` : ''].filter((part) => part !== '').join(' · ');
          return h('button', {
            key: `${isHistory ? 'history' : 'current'}-${style.key}`,
            type: 'button',
            className: `sa-btn${lectureFileKey(style?.file) === activeKey ? ' primary' : ''}${isHistory ? ' sa-lecture-history-btn' : ''}`,
            title: info === '' ? `切到讲义 ${style.key}` : `切到讲义 ${style.key} · ${info}`,
            // 传条目对象而不是 key：旧版和当前版可能同 key，只按 key 会打开错的版本
            onClick: () => openLecture(lecture, style),
          }, `讲义 ${style.key}${versionTag}`);
        };
        return h('div', {
            className: 'sa-dock sa-lecture-switch',
            style: { flexWrap: 'wrap', marginTop: 2, marginBottom: 8 },
          },
          h('span', { className: 'sa-muted' }, `${lectureTitle(lecture)} · 讲义版本`),
          h('span', { className: 'sa-lecture-links' }, ...currentEntries.map((style) => styleButton(style, false))),
          historyEntries.length === 0 ? null : h('button', {
            type: 'button',
            className: 'sa-btn sa-lecture-history-toggle',
            'aria-expanded': lectureHistoryOpen ? 'true' : 'false',
            title: lectureHistoryOpen ? '收起历史版本' : `展开看 ${historyEntries.length} 个已被取代的历史版本`,
            onClick: () => setLectureHistoryOpen((value) => !value),
          }, `历史 ${historyEntries.length} 版`),
          historyEntries.length === 0 || !lectureHistoryOpen ? null : h('span', {
            className: 'sa-lecture-history',
            style: { display: 'flex', flexWrap: 'wrap', gap: 4, width: '100%' },
          }, ...historyEntries.map((style) => styleButton(style, true))));
      })();

      /**
       * 章 → 讲义（2026-10-29 用户定；2026-11-23 方案 C 改「点章名」这一半）。
       *
       * 讲义的天然粒度就是「一章一篇」（`数电/讲义/第NN章-…`），所以「章」这一级本身就是「章详解」。
       * 2026-11-23 用户拍板方案 C：点章名 = **先展开这一层**（已展开就保持不折叠）→ 有讲义顺带在右侧读，
       * 没讲义只展开、安静不弹空卡；展开/收起仍可直接点左边那个箭头（两件事互不干扰）。
       * `options.silentIfEmpty`：只有章名点击这条路径传 true；知识点详情卡里那条跳转（`openChapter({label})`）不传，保持旧行为。
       */
      const isOpenChapter = (lecture) => lecture !== null && lecture !== undefined
        && openLectureRow !== null && String(openLectureRow.lecture?.no) === String(lecture.no);
      const openChapter = (entry, options = {}) => {
        const lecture = lectureForEntry(entry);
        // 点章不清空已打开的正文（2026-10-29 晚 m00502）：清了就是「卸掉旧内容 → 空白 → 装新内容」两跳，
        // 用户看到整块白闪。这里只把选中清掉（收起知识点详情卡），正文留着，由新讲义原地覆盖。
        selectForReading(null, { keepMaterial: true });
        if (lecture === null) {
          // 方案 C（2026-11-23）：从章名点进来时只展开、不弹「讲义还没生成」空卡；
          // 别的调用点（详情卡跳转）不传这个开关，仍旧给说明卡，行为一字不动。
          if (options.silentIfEmpty) { setLectureHint(null); return; }
          setOpenPath(null); setDetail(null);
          setLectureHint({ title: String(entry?.label ?? '').trim() });
          return;
        }
        setLectureHint(null);
        openLecture(lecture);
      };
      /**
       * 点章名的统一入口（方案 C，2026-11-23 用户定）。
       *
       * 顺序要紧：先判「这一层是不是已经展开」（手动展开或搜索态强制展开都算），
       * 未展开才 toggle 一次把它打开；已展开**不折叠**（用户选①：点章名不该把内容收起来）。
       * 随后交给 openChapter：有讲义读讲义，没讲义只展开不弹空卡。左箭头不经过这里。
       */
      const handleChapterClick = (entry) => {
        const expanded = openTree.includes(entry.key) || kpQuery.trim() !== '';
        if (!expanded) toggleTreeNode(entry.key);
        openChapter(entry, { silentIfEmpty: true });
      };
      // 右侧阅读区顶部：点到的章还没有讲义
      const lectureHintCard = lectureHint === null ? null : h('div', { className: 'sa-card sa-lecture-empty' },
        h('h3', { className: 'sa-section-title' }, String(lectureHint.title ?? '').trim() || '本章讲义'),
        h('p', null, '这一章的讲义还没生成。'),
        h('p', { className: 'sa-muted', style: { fontSize: 14, marginTop: 4 } },
          '生成流程见各科「讲义/_讲义索引.md」；生成后由 tools/lectures-sync.mjs 写进学习台。'));

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
      const mindAutoExpand = kpQuery.trim() !== ''; // 搜索命中才临时展开，普通筛选不再铺满所有节。
      // 每科首次只显示学科和章；搜索/筛选临时展开，不改该科手动记忆。
      const mindExpanded = mindAutoExpand ? null : mindOpen;
      const mind = useMemo(
        () => buildMindMap(kpFiltered, { course: (id) => courses.find((item) => item.id === id)?.name },
          { expanded: mindExpanded, outline: outlineDoc, courseRoot: true, courseId: treeCourseId }),
        [kpFiltered, courses, mindExpanded, outlineDoc, treeCourseId],
      );
      const mindZoom = savedTree.mindZoom;
      const changeMindZoom = value => {
        const zoom = clampMindZoom(value), box = mindViewportRef.current;
        if (box) { const ratio=zoom/mindZoom; zoomScrollRef.current={course:treeCourseId,left:Math.max(0,(box.scrollLeft+box.clientWidth/2)*ratio-box.clientWidth/2),top:Math.max(0,(box.scrollTop+box.clientHeight/2)*ratio-box.clientHeight/2)}; }
        updateSubjectTree({mindZoom:zoom});
      };
      const fitMindToWindow = () => {
        const box=mindViewportRef.current;if(!box)return;
        const zoom=fitMindZoom(mind.width,mind.height,box.clientWidth,box.clientHeight);
        zoomScrollRef.current={course:treeCourseId,left:0,top:0};box.scrollLeft=0;box.scrollTop=0;
        updateSubjectTree({mindZoom:zoom,scroll:{mind:{left:0,top:0}}});
      };
      useEffect(() => {
        const pending=zoomScrollRef.current,box=mindViewportRef.current;
        if(!pending||!box||pending.course!==treeCourseId||!fullBrowser||kpView!=='mind')return;
        box.scrollLeft=pending.left;box.scrollTop=pending.top;zoomScrollRef.current=null;
        updateSubjectTree({scroll:{mind:{left:box.scrollLeft,top:box.scrollTop}}},false);
      }, [mindZoom, fullBrowser, kpView, treeCourseId]);
      const mindBranchKeys = useMemo(() => allTreeKeys.filter(key => !key.startsWith('course:')).map(key => 'mind:' + key), [allTreeKeys]);
      const toggleMindChapter = (label) => {
        const key = String(label ?? '').trim();
        if (key === '') return;
        const effective = mindAutoExpand ? mindBranchKeys : mindOpen;
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

      // 分栏阅读只重置右侧正文，不让外层页面滚离目录。
      useEffect(() => {
        if (selected === null || selected === undefined || selected === '') return;
        if (isTreeView) {
          setBrowserCollapsed(true);
          if (focusReading && readerRef.current) readerRef.current.scrollTop = 0;
          return;
        }
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const target = document.getElementById(kpView === 'graph' ? 'sa-kp-detail' : 'sa-kp-selected');
        if (target === null || typeof target.scrollIntoView !== 'function') return;
        const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: kpView === 'graph' ? 'start' : 'center', behavior: reduced ? 'auto' : 'smooth' });
      }, [selected, kpView, kpFilter, isTreeView]);

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

      // 讲义按节切片（C2，2026-11-17）：读到的是某章讲义时，阅读区只渲染「当前这一节」的 markdown；
      // 非讲义资料照旧整份渲染。切片只改喂给 MaterialReading 的 text，不动 detail 本身（批注、页号等仍按原 detail）。
      const lectureSections = openLectureRow !== null && detail?.status === 'ready' && typeof detail?.data?.text === 'string'
        ? splitLectureSections(detail.data.text)
        : null;
      const safeSectionIndex = lectureSections === null ? 0 : Math.min(Math.max(lectureSection, 0), lectureSections.length - 1);
      const displayDetail = (lectureSections !== null && lectureSections.length > 0)
        ? { ...detail, data: { ...detail.data, text: lectureSections[safeSectionIndex].body } }
        : detail;

      // 正文卡与资料页共用同一个阅读面（W3a）；知识点页额外挂「去资料页看 / 专注阅读」与讲义版本行。
      const detailCard = MaterialReadingCard({
        detail: displayDetail,
        openPath,
        onNotesChange: reportReadingNotes,
        onPage: (no) => showMaterial(openPath, no),
        onClose: () => {
          setOpenPath(null);
          setDetail(null);
          readKnowledgeUi({ detailPath: null });
        },
        extraActions: [
          detail?.status === 'ready'
            ? h('button', {
              className: 'sa-btn',
              title: '带着这一页跳到「资料」页签继续翻',
              onClick: () => onOpenMaterial?.(openPath, detail.data?.page),
            }, '去资料页看')
            : null,
          isTreeView && !focusReading
            ? h('button', {
              className: 'sa-btn',
              title: '全屏进入沉浸式学习模式，Esc 退出并回到原阅读位置',
              onClick: enterFocusReading,
            }, '进入学习模式')
            : null,
        ],
        belowHeader: lectureSwitchRow,
        closeTitle: '关上这份正文（也可以按左上角「返回」或 Alt+←）',
      });


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
                ...(typeof ev?.quote === 'string' && ev.quote !== ''
                  // 2026-10-27 晚：引文里也有公式（教材 OCR 把 `$\boldsymbol{D}$` 原样存下来），
                  // 直接当纯文本贴会露出源码，这里走一遍行内排版
                  ? ['「', ...mathInlineNodes(ev.quote, `evq-${prefix}-${index}`), '」']
                  : ['（没存引文，点「看原页」读那一页）'])))
            : null);
      };
      const evidenceRows = (evidence, prefix) => (Array.isArray(evidence) ? evidence : [])
        .map((ev, index) => evidenceRow(ev, index, prefix));

      /**
       * 「详解」块（2026-10-23 夜，批 0）：内容来自 `资料分析.json`，离线预生成、点开即读。
       *
       * 三条纪律：① 没分析过就写「未分析」，不拿别的来源冒充详解；
       * ② 每块内容后面都尽量带出处（`sources`），点「看原文页」直接读那一页；
       * ③ 详解只读 `资料分析.json`，不在面板上现场生成（生成走 `tools/analysis.mjs`）。
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
          h('div', { className: 'sa-muted', style: { fontSize: '0.875em', marginTop: 2 } },
            '这个知识点还没有预生成详解（资料分析.json 里没有它的条目）。详解由 `tools/analysis.mjs` 离线生成后再回来读。'))
        : (() => {
          // 详解正文的子节点（2026-11-17 C1 并入 B 卡修复③：接入 AnnotationLayer，虚拟 key 用 kp:<nodeId>）。
          // 先把整块内容组织成子节点数组，再整体交给 AnnotationLayer 渲染——
          // 批注标记要落在正文里（内联 <mark>），状态与浮动气泡共用同一份，与 MaterialReading 一致。
          const analysisChildren = [
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
                      ? h('figcaption', { className: 'sa-muted', style: { fontSize: '0.875em', marginTop: 2 } },
                        `${caption}${hasPage ? `${caption !== '' ? ' · ' : ''}教材第 ${page} 页` : ''}`)
                      : null);
                }))
              : null,
            typeof selectedPoint.analogy === 'string' && selectedPoint.analogy.trim() !== ''
              ? h('div', { style: { marginTop: 8, fontSize: '1em', lineHeight: 1.6 } },
                h('strong', null, '打个比方：'), ...mathInlineNodes(selectedPoint.analogy.trim(), 'ana'))
              : null,
            ...(Array.isArray(selectedPoint.formulas) ? selectedPoint.formulas : [])
              .filter((formula) => formula !== null && typeof formula === 'object')
              .map((formula, index) => formulaCard(formula, index)),
            (Array.isArray(selectedPoint.pitfalls) ? selectedPoint.pitfalls : []).filter((item) => typeof item === 'string' && item.trim() !== '').length > 0
              ? h('div', { className: 'sa-reading', style: { marginTop: 16 } },
                h('h4', { className: 'sa-section-title' }, '易错'),
                ...selectedPoint.pitfalls.filter((item) => typeof item === 'string' && item.trim() !== '')
                  .map((item, index) => h('div', { key: `pf${index}`, style: { fontSize: '1em', lineHeight: 1.6 } },
                    '✗ ', ...mathInlineNodes(item.trim(), `pf${index}`))))
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
                h('div', { style: { fontSize: '1em', whiteSpace: 'pre-wrap' } }, ...mathInlineNodes(String(example.prompt ?? ''), 'exp')),
                ...(Array.isArray(example.steps) ? example.steps : [])
                  .filter((step) => typeof step === 'string' && step.trim() !== '')
                  .map((step, stepIndex) => h('div', { key: `st${stepIndex}`, className: 'sa-example-step', style: { fontSize: '0.875em', marginTop: 2 } },
                    `${stepIndex + 1}. `, ...mathInlineNodes(step.trim(), `st${stepIndex}`))),
                typeof example.answer === 'string' && example.answer.trim() !== ''
                  ? h('div', { className: 'sa-example-answer', style: { fontSize: '1em', marginTop: 4 } }, '答：', ...mathInlineNodes(example.answer.trim(), 'ans'))
                  : null,
                typeof example.method === 'string' && example.method.trim() !== ''
                  ? h('div', { className: 'sa-muted', style: { fontSize: '0.875em', marginTop: 2 } }, '套路：', ...mathInlineNodes(example.method.trim(), 'mtd'))
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
                      `${file}${Number.isFinite(page) && page > 0 ? ` · 第 ${page} 页` : ''}`,
                      // 2026-10-27 晚：引文里的公式同样要排版，否则 `$\boldsymbol{D}$` 这种会原样露出
                      ...(typeof source.quote === 'string' && source.quote !== ''
                        ? [' —— 「', ...mathInlineNodes(source.quote, `srcq${index}`), '」']
                        : [])),
                    file !== ''
                      ? h('button', {
                        className: 'sa-btn',
                        style: { padding: '0 6px', fontSize: 14 },
                        title: '读这一页的原文（只读）',
                        onClick: () => showMaterial(file, Number.isFinite(page) && page > 0 ? page : undefined),
                      }, '看原文页')
                      : null);
                }))
              : null,
          ];
          // 正文纯文本（供批注锚点定位）：取渲染后的叶子文本，保证与界面显示一致。
          const analysisBody = annotationRenderedText(analysisChildren);
          const kpFile = `kp:${selectedNode?.id ?? ''}`;
          // 用 kp:<nodeId> 作为虚拟文件键走批注层；没有节点 id 时退回纯正文，别写到空键上。
          if (kpFile === 'kp:') {
            return h('div', { className: 'sa-reading', style: { marginTop: 16 } }, ...analysisChildren);
          }
          return h('div', { style: { marginTop: 16 } },
            h(AnnotationLayer, { file: kpFile, text: analysisBody, mode: 'preview', nodes: analysisChildren, onNotesChange: reportReadingNotes, dockPanel: true, onDockChange: reportDockChange }));
        })();

      const nodeCard = selectedNode === null ? null : h('div', { className: 'sa-card sa-node-detail', id: 'sa-kp-detail' },
        h('div', { className: 'sa-dock' },
          h('h3', { className: 'sa-grow sa-detail-title' }, selectedNode.name ?? '(未命名)'),
          // 有正文打开时，专注阅读按钮挂在上面那张讲义/正文卡上，详情卡不再重复放一个
          isTreeView && !focusReading && detailCard === null ? h('button', {type:'button',className:'sa-btn',onClick:enterFocusReading,title:'全屏进入沉浸式学习模式，Esc退出并回到原阅读位置'}, '进入学习模式') : null,
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
        // 章讲义入口（2026-10-29 用户定）：列表/图视图没有章行可点，就在这儿放一颗「章名」按钮——
        // 点它右侧出该章讲义，版本在右侧讲义正文上方那排切，所以按钮上不写「讲义」二字。
        !isTreeView && lectureForEntry({ label: selectedNode.chapter }) !== null
          ? h('div', { className: 'sa-dock', style: { marginTop: 8, flexWrap: 'wrap' } },
            h('button', {
              className: 'sa-btn',
              title: '在右侧打开这一章的讲义（版本在讲义正文上方切）',
              onClick: () => openChapter({ label: selectedNode.chapter }),
            }, String(selectedNode.chapter).trim()))
          : null,
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
        analysisBlock,
        // 证据块放详情卡最末尾（详解正文之后）：先看详解，再看支撑它的题目/资料页
        evidenceRows(selectedNode.evidence, 'sel').length === 0
          ? null
          : h('div', { style: { marginTop: 6 } },
            h('div', { className: 'sa-muted' }, '证据'),
            ...evidenceRows(selectedNode.evidence, 'sel')),
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
       * 命中加粗（2026-10-22 深夜）：树/列表共用，切法由纯函数 splitByQuery 决定。
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

      /** 列表里的一章：点标题折叠；折叠只影响显示，不影响批量与统计。 */
      const knowledgeChapter = (group) => {
        const collapsed = isChapterCollapsed(group.key);
        const stats = chapterMasteryStats(group.nodes);
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
          masteryBar(stats)),
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
        const open = kpQuery.trim() !== '' || openTree.includes(entry.key);
        const empty = entry.empty === true;
        const lecture = entry.kind === 'chapter' ? lectureForEntry(entry) : null;
        // 章行（2026-10-29 用户定，2026-11-23 方案 C 修订）：点名称＝展开这一层并读该章讲义（无讲义只展开）；
        // 展开/收起仍可直接点左边那个箭头。点名称不再「只读讲义、不展开」。
        const isChapter = entry.kind === 'chapter';
        return h('div', { key: entry.key, className: 'sa-kp-branch' },
          h('div', {
            className: 'sa-row sa-tree-row',
            'data-depth': depth,
            'data-open': open,
            'data-chapter': isChapter ? 'true' : undefined,
            'data-active': isOpenChapter(lecture) ? 'true' : undefined,
            style: { cursor: 'pointer', paddingLeft: 0, opacity: empty ? 0.8 : 1, ...reveal },
            title: isChapter ? `在右侧读「${String(entry.label ?? '').trim()}」的讲义` : undefined,
            onClick: () => (isChapter ? handleChapterClick(entry) : toggleTreeNode(entry.key)),
          },
          h('span', {
            className: 'sa-kp-caret',
            role: 'button',
            tabIndex: 0,
            'aria-label': `${open ? '收起' : '展开'} ${String(entry.label ?? '').trim()}`,
            'aria-expanded': open,
            title: open ? '收起这一层' : '展开这一层',
            onClick: (event) => { event.stopPropagation(); toggleTreeNode(entry.key); },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleTreeNode(entry.key); }
            },
          }, '▸'),
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
          // 左边不再放「讲义 A/B/C」小按钮（2026-10-29 用户定：版本切换统一在右侧讲义正文上方）
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
              onClick: () => setMindOpen(mindBranchKeys),
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
            }, '回到开头'),
            h('span', {className:'sa-zoom-controls',role:'group','aria-label':'导图缩放'},
              h('button',{type:'button',className:'sa-btn','aria-label':'缩小导图',disabled:mindZoom<=0.001,onClick:()=>changeMindZoom(mindZoom/1.25)},'−'),
              h('output',{className:'sa-zoom-value','aria-live':'polite'},(Math.round(mindZoom*1000)/10)+'%'),
              h('button',{type:'button',className:'sa-btn','aria-label':'放大导图',disabled:mindZoom>=2,onClick:()=>changeMindZoom(mindZoom*1.25)},'+'),
              h('button',{type:'button',className:'sa-btn',onClick:()=>changeMindZoom(1)},'100%'),
              h('button',{type:'button',className:'sa-btn',onClick:fitMindToWindow},'适应窗口'))),
          kpFiltered.length === 0
            ? h('div', { className: 'sa-muted', style: { marginTop: 6 } }, '当前搜索/筛选没有命中节点，清空关键词或切回「全部」。')
            : h('div', {
              className: 'sa-kg-wrap',
              id: 'sa-mind-wrap', key: treeCourseId, ref: restoreTreeScroll, 'data-tree-course': treeCourseId, onScroll: event => saveTreeScroll('mind', event),
              style: { marginTop: 8, overflow: 'auto', maxHeight: '62vh' },
            },
            h('svg', {
              width: mind.width * mindZoom,
              height: mind.height * mindZoom,
              viewBox: '0 0 '+mind.width+' '+mind.height,
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
              const isPoint=item.kind==='point',isChapter=item.kind==='chapter',isBranch=item.expandable===true;
              const selectedPoint=isPoint && item.id===selected;
              const state=MASTERY_STYLE[isPoint ? Math.min(Math.max(item.mastery||0,0),3) : 0];
              // 导图/图视图里点章节点只管展开/收起（2026-10-29 定）：
              // 导图上「点一下」本来就是展开，若顺带把讲义拉到右侧会把人从图里踢出去（整图被分栏取代）。
              // 读章讲义走树/目录那侧的章名，以及详情卡上的章名按钮。
              const activate=()=>isPoint ? selectForReading(item.id) : toggleMindChapter(item.key);
              const level=({root:'总览',course:'课程',chapter:'章',section:'节',sub:'小节',group:'分组',point:'知识点'})[item.kind] || '';
              return h('g',{key:item.key,className: 'sa-mind-node',
                role:isPoint||isBranch?'button':undefined,tabIndex:isPoint||isBranch?0:undefined,
                'aria-label':item.label,'aria-expanded':isBranch?item.open:undefined,
                onClick:isPoint||isBranch?activate:undefined,
                onKeyDown:isPoint||isBranch?(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}}:undefined,
                style:{cursor:isPoint||isBranch?'pointer':'default',animationDelay:Math.min(mindIndex,20)*10+'ms'}},
                h('title',null,item.label),
                h('rect',{x:item.x,y:item.y-item.height/2,width:item.width,height:item.height,rx:12,
                  fill:'var(--dsw-alias-bg-layer-1)',stroke:selectedPoint?'var(--dsw-alias-brand-primary)':'var(--dsw-alias-border-l1)',strokeWidth:selectedPoint?2.5:1}),
                h('text',{x:item.x+14,y:item.y-item.height/2+19,fontSize:14,fill:'var(--dsw-alias-label-secondary)'},
                  level+(isPoint?' '+state.symbol+' '+state.label:'')+(isBranch?' '+(item.open?'▾':'▸')+' '+item.total+' 个':'')+(item.marked?' ★':'')),
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
        const open = kpQuery.trim() !== '' || openTree.includes(entry.key);
        const lecture = entry.kind === 'chapter' ? lectureForEntry(entry) : null;
        const isChapter = entry.kind === 'chapter';
        // 章行拆成两个按钮（2026-10-29 用户定，2026-11-23 方案 C 修订）：左边箭头管展开/收起；
        // 右边名称点一下＝先展开这一层、再在阅读区读该章讲义（无讲义只展开，不弹空卡）。
        // 讲义版本不再堆在左边（`讲义 A/B/C` 三颗），统一在右侧讲义正文上方那排切。
        const active = isOpenChapter(lecture);
        return h('li', { key: entry.key, className: 'sa-compact-branch', 'data-kind': entry.kind },
          h('div', { className: 'sa-compact-row' },
            h('button', { type: 'button', className: 'sa-compact-arrow-btn', 'aria-expanded': open,
              'aria-label': `${open ? '收起' : '展开'} ${String(entry.label ?? '').trim()}`,
              title: open ? '收起这一层' : '展开这一层',
              onClick: (event) => { event.stopPropagation(); toggleTreeNode(entry.key); } },
              h('span', { className: 'sa-compact-arrow', 'aria-hidden': true }, open ? '▾' : '▸')),
            h('button', { type: 'button', className: 'sa-compact-point', 'aria-current': active ? 'true' : undefined,
              title: isChapter ? `在右侧读「${String(entry.label ?? '').trim()}」的讲义` : entry.label,
              onClick: () => (isChapter ? handleChapterClick(entry) : toggleTreeNode(entry.key)) },
              h('span', { className: 'sa-compact-name' }, renderMatched(entry.label, kpQuery)),
              h('span', { className: 'sa-compact-count' }, active ? '讲义' : String(entry.count || 0)))),
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
      // 专注阅读顶部标题（2026-10-29）：读的是讲义就报讲义（章名 + 档位），否则回落到知识点名
      // 专注阅读顶部的字号控件（2026-10-29 用户要求「能自由选择字体大小」）：
      // 显示的是「DSH 内容字号 × 倍率」的整数 px；A−/A+ 一格 1px（16px 基准下）。
      const readFontPx = Math.round(dshContentFontSize() * readScale);
      const focusReadingTitle = openLectureRow !== null
        ? `${lectureTitle(openLectureRow.lecture)} · 讲义 ${openLectureRow.style?.key ?? ''}`
        : openPath !== null
          ? String(detail?.data?.file ?? openPath)
          : (selectedNode?.name ?? '专注阅读');

      // ═══════════ clock 插槽渲染（C2）：正计时 + 番茄钟 ═══════════
      // 开关/档位都只看 clockMode/pomodoroPreset；点开始/暂停驱动上面那几条 useEffect。
      const clockActions = clockMode === 'stopwatch'
        ? (() => {
            const running = stopwatchRunning;
            return [
              h('output', { className: 'sa-clock-time', 'aria-live': 'polite', title: '本次正计时（暂停不累加）' }, fmtClock(stopwatchSec)),
              h('button', { type: 'button', className: 'sa-btn sa-clock-btn', onClick: () => {
                setStopwatchRunning((value) => {
                  const next = !value;
                  if (next) beginDurationSegment(); else flushDurationSegment();
                  return next;
                });
              } }, running ? '暂停' : '开始'),
              h('button', { type: 'button', className: 'sa-btn sa-clock-btn', title: '清零计时（会把当前这段落了再归零）', onClick: () => {
                flushDurationSegment();
                setStopwatchRunning(false); setStopwatchSec(0);
              } }, '归零'),
            ];
          })()
        : (() => {
            const running = pomodoroRunning;
            const phaseLabel = pomodoroPhase === 'studying' ? '学习' : pomodoroPhase === 'break' ? '休息' : '待开始';
            return [
              h('output', { className: 'sa-clock-time', 'aria-live': 'polite', title: `番茄钟 · ${phaseLabel}` }, fmtClock(pomodoroRemain)),
              h('span', { className: 'sa-clock-phase', 'data-phase': pomodoroPhase }, phaseLabel),
              h('button', { type: 'button', className: 'sa-btn sa-clock-btn', onClick: () => {
                if (pomodoroPhase === 'idle') {
                  // 首次启动：进 studying，记学习段起点
                  durationAnchorRef.current = Date.now();
                  durationSigRef.current = currentDurationSignature();
                  setPomodoroPhase('studying');
                  setPomodoroRemain(pomodoroPreset.studySec);
                  setPomodoroRunning(true);
                  return;
                }
                setPomodoroRunning((value) => {
                  const next = !value;
                  if (!next && pomodoroPhase === 'studying') flushDurationSegment({ mode: 'pomodoro' });
                  return next;
                });
              } }, running ? '暂停' : '开始'),
              h('button', { type: 'button', className: 'sa-btn sa-clock-btn', title: '重置番茄钟（会把当前学习段落了）', onClick: () => {
                flushDurationSegment({ mode: 'pomodoro' });
                setPomodoroRunning(false); setPomodoroPhase('idle'); setPomodoroRemain(pomodoroPreset.studySec);
              } }, '重置'),
            ];
          })();
      // ═══════════ marks 插槽渲染（2026-11-17 D 卡）：高光/行内格式索引横条 ═══════════
      // 数据来自当前阅读面 AnnotationLayer 通过 onNotesChange 上报的 readingMarks（file + notes）。
      // 列出每条带行内格式或高亮的批注；点击调用 scrollToMark 尽量滚动到正文里那条 <mark>。
      const marksSlotContent = (() => {
        const notes = Array.isArray(readingMarks.notes) ? readingMarks.notes : [];
        // 只列「看得见的」标记：有 style 的行内格式，或 type=highlight 的高亮。普通 note 不进索引。
        const visible = notes.filter((note) => note !== null && typeof note === 'object'
          && ((note.style !== null && note.style !== undefined && typeof note.style === 'object' && Object.keys(note.style).length > 0) || note.type === 'highlight'));
        if (visible.length === 0) return h('span', { className: 'sa-study-slot-hint' }, '高光索引（暂无）');
        return h('div', { className: 'sa-marks-list', role: 'list', 'aria-label': '本页高光与行内格式' },
          ...visible.map((note, index) => {
            const css = annotationStyleToCss(note.style);
            // 2026-11-18 修（q2）：索引条优先显示批注内容（如「高亮1」），内容为空才回落到选中原文。
            // 之前反过来（先 anchor.quote），于是高亮即使命名成「高亮1」也显示成原文，用户以为「又自动填了原文」。
            const label = String(note.content ?? '').trim() || String(note?.anchor?.quote ?? '');
            const quote = label;
            const shortQuote = quote.length > 8 ? `${quote.slice(0, 8)}…` : quote;
            // AI 材料徽标（2026-11-18 E1）：有 markKind 就在 chip 上加一个中文角标，一眼看出哪些是疑问。
            // 无标记（含旧数据）不加角标，保持 D 卡原样。
            const markBadge = annotationMarkBadge(note.markKind);
            return h('button', {
              key: `mk-${String(note.id ?? index)}`,
              type: 'button',
              className: 'sa-marks-chip',
              'data-annotation-id': String(note.id ?? ''),
              'data-mark-kind': note.markKind === undefined || note.markKind === null ? 'normal' : String(note.markKind),
              role: 'listitem',
              title: quote === '' ? '这条标记' : quote,
              style: css === null ? undefined : { backgroundColor: css.backgroundColor ?? undefined, color: css.color ?? undefined, textDecorationColor: css.textDecorationColor ?? undefined, textDecorationLine: css.textDecorationLine ?? undefined, fontWeight: css.fontWeight ?? undefined, fontStyle: css.fontStyle ?? undefined },
              onClick: () => scrollToMark(note.id),
            }, markBadge !== null
              ? h('span', { className: 'sa-marks-badge', 'data-mark-kind': String(note.markKind) }, `${markBadge} `)
              : null, shortQuote === '' ? '标记' : shortQuote);
          }));
      })();

      // ═══════════ 左侧栏行内格式面板（2026-11-18 用户定：整合进左侧栏，不再弹浮动气泡）═══════════
      // 承接知识点正文 AnnotationLayer（dockPanel 模式）上报的 dockState = { file, bubble, saving, status, actions }。
      // 气泡的 menu/compose/view 三种状态在这里用竖排按钮重画，动作全部转调 AnnotationLayer 的 actions（逻辑单点）。
      const dockSW = (kind, value, label, title, onPick, selected) => {
        // 2026-11-18（用户：初次选中时左侧「字色/下划线」色块全空白）：annotationStyleToCss 对
        //   highlight 返回 backgroundColor、对 color 返回 color、对 underline 返回 textDecorationColor。
        //   旧代码一律取 ?.backgroundColor，导致字色/下划线两类色块取不到值 → 全白。
        //   这里按 kind 取正确的那个颜色当色块底色。
        const css = annotationStyleToCss(kind === 'highlight' ? { highlight: value } : (kind === 'underline' ? { underline: value } : { color: value }));
        const chipColor = css === null ? undefined : (kind === 'highlight' ? css.backgroundColor : (kind === 'underline' ? css.textDecorationColor : css.color));
        return h('button', {
          key: `dsw-${kind}-${value}`,
          type: 'button',
          className: `sa-btn sa-annotation-swatch sa-annotation-swatch-${kind}${selected === true ? ' is-selected' : ''}`,
          'data-kind': kind,
          'data-value': value,
          'aria-pressed': selected === true ? 'true' : 'false',
          title,
          disabled: dockState.saving,
          style: { backgroundColor: chipColor ?? undefined },
          onClick: onPick,
        }, label);
      };
      const dockPanelContent = (() => {
        const b = dockState !== null && dockState !== undefined ? dockState.bubble : null;
        if (b === null || b === undefined) {
          return h('div', { className: 'sa-dock-hint sa-study-slot-hint' }, '在正文里选中文字，这里出现高亮/批注选项');
        }
        const saving = dockState.saving === true;
        const actions = dockState.actions ?? {};
        const head = (label) => h('div', { className: 'sa-dock-head' }, label);
        if (b.mode === 'menu') {
          // 2026-11-18 十三轮（用户 m02352）：首次选中态点色块/B/I 只累积 pendingStyle 预览（不落库、不关面板），
          // 可把 高光+字色+下划线+粗/斜 叠加好，点「完成」一次性保存；「高亮」大按钮仍是一键淡黄立即保存。
          const pend = b.pendingStyle !== null && b.pendingStyle !== undefined && typeof b.pendingStyle === 'object' ? b.pendingStyle : {};
          const flagBtn = (flag, glyph, title) => h('button', {
            type: 'button',
            className: `sa-btn sa-annotation-flag${pend[flag] === true ? ' is-selected' : ''}`,
            'data-flag': flag,
            'aria-pressed': pend[flag] === true ? 'true' : 'false',
            title,
            disabled: saving,
            onClick: () => actions.queueInlineStyle({ [flag]: true }),
          }, glyph);
          return h('div', { className: 'sa-dock-panel', 'data-mode': 'menu', 'data-annotation-guard': '1' },
            h('div', { className: 'sa-dock-row' },
              h('button', { type: 'button', className: 'sa-btn primary', 'data-type': 'highlight', title: '把选中文字标成淡黄高亮（不弹输入框；要换色用下面色块）', disabled: saving, onClick: () => actions.quickHighlight() }, '高亮'),
              h('button', { type: 'button', className: 'sa-btn', 'data-type': 'note', title: '可打字、可选色的批注（可留空＝纯色高光）', disabled: saving, onClick: () => actions.compose('note') }, '批注'),
              h('button', { type: 'button', className: 'sa-btn', 'data-type': 'insert', title: '在这段文字后面插一段自己的话', disabled: saving, onClick: () => actions.compose('insert') }, '插入段落')),
            h('div', { className: 'sa-dock-label' }, '高光'),
            h('div', { className: 'sa-dock-swatches' },
              ...['yellow', 'green', 'blue', 'pink', 'orange'].map((v) => dockSW('highlight', v, '', `高亮${{ yellow: '黄', green: '绿', blue: '蓝', pink: '粉', orange: '橙' }[v]}色（再点取消）`, () => actions.queueInlineStyle({ highlight: v }), pend.highlight === v))),
            h('div', { className: 'sa-dock-label' }, '字色'),
            h('div', { className: 'sa-dock-swatches' },
              ...['red', 'blue', 'green', 'black', 'gray'].map((v) => dockSW('color', v, '', `字色${{ red: '红', blue: '蓝', green: '绿', black: '黑', gray: '灰' }[v]}（再点取消）`, () => actions.queueInlineStyle({ color: v }), pend.color === v))),
            h('div', { className: 'sa-dock-label' }, '下划线'),
            h('div', { className: 'sa-dock-swatches' },
              ...['red', 'blue', 'gray'].map((v) => dockSW('underline', v, '', `下划线${{ red: '红', blue: '蓝', gray: '灰' }[v]}（再点取消）`, () => actions.queueInlineStyle({ underline: v }), pend.underline === v)),
              flagBtn('bold', 'B', '加粗'),
              flagBtn('italic', 'I', '斜体')),
            h('div', { className: 'sa-dock-row' },
              h('button', { type: 'button', className: 'sa-btn primary', 'data-action': 'apply-inline', disabled: saving, title: '把上面选的高光/字色/下划线/粗斜一次性加到这段文字', onClick: () => actions.commitInlineStyle() }, saving ? '保存中…' : '完成'),
              h('button', { type: 'button', className: 'sa-btn', 'data-action': 'cancel', onClick: () => actions.cancel() }, '取消')));
        }
        const type = b.type ?? 'note';
        const isInsert = type === 'insert';
        if (b.mode === 'view') {
          const curHl = b.style !== null && b.style !== undefined ? b.style.highlight : null;
          return h('div', { className: 'sa-dock-panel', 'data-mode': 'view', 'data-annotation-guard': '1', 'data-annotation-id': String(b.id ?? '') },
            h('div', { className: 'sa-dock-head' }, b.state === 'fuzzy' ? '批注（位置待确认）' : '批注'),
            h('div', { className: 'sa-dock-label' }, '颜色'),
            h('div', { className: 'sa-dock-swatches' },
              ...['yellow', 'green', 'blue', 'pink', 'orange'].map((v) => h('button', {
                key: `dvsw-${v}`,
                type: 'button',
                className: `sa-btn sa-annotation-swatch sa-annotation-swatch-highlight${curHl === v ? ' is-selected' : ''}`,
                'data-view-color': v,
                'aria-pressed': curHl === v ? 'true' : 'false',
                title: `改成${{ yellow: '黄', green: '绿', blue: '蓝', pink: '粉', orange: '橙' }[v]}色`,
                style: { backgroundColor: annotationStyleToCss({ highlight: v })?.backgroundColor ?? undefined },
                // 2026-11-18 十三轮（用户 m02352：编辑时点到高光颜色就退出编辑）：与字色/下划线一致，走 viewInline
                // 以当前 style 为底 toggle 并在面板内连续保存（keepOpen），只有点「完成」/删除/× 才关。
                onClick: () => actions.viewInline({ highlight: v }),
              })),
              h('button', { type: 'button', className: 'sa-btn sa-annotation-flag', 'data-view-clear': '1', title: '去掉颜色（保留批注文字）', onClick: () => actions.viewClear() }, '无色')),
            // 2026-11-18（q1）：再编辑也支持 字色 / 下划线 / 粗 / 斜（与第一次选字一致）。
            h('div', { className: 'sa-dock-label' }, '字色'),
            h('div', { className: 'sa-dock-swatches' },
              ...['red', 'blue', 'green', 'black', 'gray'].map((v) => h('button', {
                key: `dvcol-${v}`,
                type: 'button',
                className: `sa-btn sa-annotation-swatch sa-annotation-swatch-color${b.style !== null && b.style !== undefined && b.style.color === v ? ' is-selected' : ''}`,
                'data-view-color-text': v,
                'aria-pressed': b.style !== null && b.style !== undefined && b.style.color === v ? 'true' : 'false',
                title: `字色${{ red: '红', blue: '蓝', green: '绿', black: '黑', gray: '灰' }[v]}`,
                disabled: saving,
                style: { backgroundColor: annotationStyleToCss({ color: v })?.color ?? undefined },
                onClick: () => actions.viewInline({ color: v }),
              }))),
            h('div', { className: 'sa-dock-label' }, '下划线'),
            h('div', { className: 'sa-dock-swatches' },
              ...['red', 'blue', 'gray'].map((v) => h('button', {
                key: `dvul-${v}`,
                type: 'button',
                className: `sa-btn sa-annotation-swatch sa-annotation-swatch-underline${b.style !== null && b.style !== undefined && b.style.underline === v ? ' is-selected' : ''}`,
                'data-view-underline': v,
                'aria-pressed': b.style !== null && b.style !== undefined && b.style.underline === v ? 'true' : 'false',
                title: `下划线${{ red: '红', blue: '蓝', gray: '灰' }[v]}（再点一次去掉）`,
                disabled: saving,
                style: { backgroundColor: annotationStyleToCss({ underline: v })?.textDecorationColor ?? undefined },
                onClick: () => actions.viewInline({ underline: v }),
              }))),
            // 2026-11-18（q4）：加粗/斜体单独一行，放在「下划线颜色」下方，不与色块并列。
            h('div', { className: 'sa-dock-row' },
              h('button', { type: 'button', className: `sa-btn sa-annotation-flag${b.style !== null && b.style !== undefined && b.style.bold === true ? ' is-selected' : ''}`, 'data-view-flag': 'bold', 'aria-pressed': b.style !== null && b.style !== undefined && b.style.bold === true ? 'true' : 'false', title: '加粗', disabled: saving, onClick: () => actions.viewInline({ bold: true }) }, 'B'),
              h('button', { type: 'button', className: `sa-btn sa-annotation-flag${b.style !== null && b.style !== undefined && b.style.italic === true ? ' is-selected' : ''}`, 'data-view-flag': 'italic', 'aria-pressed': b.style !== null && b.style !== undefined && b.style.italic === true ? 'true' : 'false', title: '斜体', disabled: saving, onClick: () => actions.viewInline({ italic: true }) }, 'I')),
            markKindButtons(b.markKind, (kind) => actions.viewMarkKind(kind), 'sa-dock-row', 'sa-btn sa-annotation-mark-btn', saving, 'sa-dock-label'),
            h('textarea', {
              className: 'sa-annotation-bubble-input',
              'data-role': 'annotation-draft',
              placeholder: '批注内容（点完成保存）',
              rows: 3,
              value: String(b.draft ?? ''),
              onChange: (event) => actions.setDraft(event !== null && event.target !== null ? String(event.target.value ?? '') : ''),
            }),
            h('div', { className: 'sa-dock-row' },
              h('button', { type: 'button', className: 'sa-btn primary', 'data-action': 'commit', disabled: saving, onClick: () => actions.commit() }, saving ? '保存中…' : '完成'),
              h('button', { type: 'button', className: 'sa-btn', 'data-action': 'delete', onClick: () => actions.removeNote(b.id) }, '删除'),
              h('button', { type: 'button', className: 'sa-btn', 'data-action': 'cancel', onClick: () => actions.cancel() }, '取消')));
        }
        const curColor = b.style !== null && b.style !== undefined ? b.style.highlight : null;
        // 批注（可打字）的颜色在 bubble.style.highlight 里，点色块走 setStyle；「完成」时随 content 一起落库。
        const colorRow = isInsert ? null : h('div', null,
          h('div', { className: 'sa-dock-label' }, '颜色'),
          h('div', { className: 'sa-dock-swatches' },
            ...['yellow', 'green', 'blue', 'pink', 'orange'].map((v) => h('button', {
              key: `dcsw-${v}`,
              type: 'button',
              className: `sa-btn sa-annotation-swatch sa-annotation-swatch-highlight${curColor === v ? ' is-selected' : ''}`,
              'data-compose-color': v,
              'aria-pressed': curColor === v ? 'true' : 'false',
              title: `${{ yellow: '黄', green: '绿', blue: '蓝', pink: '粉', orange: '橙' }[v]}色`,
              style: { backgroundColor: annotationStyleToCss({ highlight: v })?.backgroundColor ?? undefined },
              onClick: () => actions.setStyle({ highlight: v }),
            }))));
        return h('div', { className: 'sa-dock-panel', 'data-mode': b.mode, 'data-type': type, 'data-annotation-guard': '1' },
          head(isInsert ? '插入的段落（点完成保存）' : '批注（可打字、可留空＝纯色高光；点完成保存）'),
          colorRow,
          markKindButtons(b.markKind, (kind) => actions.setMarkKind(kind), 'sa-dock-row', 'sa-btn sa-annotation-mark-btn', saving, 'sa-dock-label'),
          h('textarea', {
            className: 'sa-annotation-bubble-input',
            'data-role': 'annotation-draft',
            placeholder: isInsert ? '写一段要插在这段文字后面的内容…' : '写点自己的话（可留空，留空就是纯色高光）…',
            rows: isInsert ? 4 : 3,
            value: String(b.draft ?? ''),
            onChange: (event) => actions.setDraft(event !== null && event.target !== null ? String(event.target.value ?? '') : ''),
          }),
          h('div', { className: 'sa-dock-row' },
            h('button', { type: 'button', className: 'sa-btn primary', 'data-action': 'commit', disabled: saving, onClick: () => actions.commit() }, saving ? '保存中…' : '完成'),
            h('button', { type: 'button', className: 'sa-btn', 'data-action': 'cancel', onClick: () => actions.cancel() }, '取消')));
      })();

      const clockSlotContent = h('div', { className: 'sa-clock' },
        h('div', { className: 'sa-clock-tabs', role: 'group', 'aria-label': '计时模式' },
          h('button', { type: 'button', className: `sa-btn sa-clock-tab${clockMode === 'stopwatch' ? ' primary' : ''}`, 'aria-pressed': clockMode === 'stopwatch' ? 'true' : 'false', onClick: () => setClockMode('stopwatch') }, '正计时'),
          h('button', { type: 'button', className: `sa-btn sa-clock-tab${clockMode === 'pomodoro' ? ' primary' : ''}`, 'aria-pressed': clockMode === 'pomodoro' ? 'true' : 'false', onClick: () => setClockMode('pomodoro') }, '番茄钟')),
        clockMode === 'pomodoro'
          ? h('div', { className: 'sa-clock-presets', role: 'group', 'aria-label': '番茄时长' },
              ...POMODORO_PRESETS.map((preset) => h('button', {
                key: preset.id, type: 'button',
                className: `sa-btn sa-clock-preset${preset.id === pomodoroPresetId ? ' primary' : ''}`,
                'aria-pressed': preset.id === pomodoroPresetId ? 'true' : 'false',
                onClick: () => {
                  // 换档：重置番茄钟并把 remain 设为该档学习时长
                  flushDurationSegment({ mode: 'pomodoro' });
                  setPomodoroPresetId(preset.id); writeLocalStorage(POMODORO_KEY, preset.id);
                  setPomodoroRunning(false); setPomodoroPhase('idle'); setPomodoroRemain(preset.studySec);
                },
              }, preset.label)))
          : null,
        h('div', { className: 'sa-clock-row' }, ...clockActions),
        todayMinutes === null ? null : h('span', { className: 'sa-clock-today', title: '今日在本学习台累计的学习分钟数' }, `今日累计 ${todayMinutes} 分钟`));

      // ═══════════ switch 插槽渲染（C2）：上/下篇 + 下拉跳转（仅本课程内，到头停）═══════════
      // 序列来源（2026-11-17 改为按节翻）：
      //   - 打开的是讲义 → 本章讲义正文按「节」切片（splitLectureSections），序列=节；本章最后一节
      //     「下一篇」跨到下一章讲义的第一节；第一章第一节「上一篇」/ 最后一章最后一节「下一篇」灰（到头停）。
      //   - 否则 → 知识点序列（netRows 顺序），保持原样。
      const pagerState = (() => {
        if (openLectureRow !== null) {
          // 本章讲义正文（detail.data.text）→ 节切片；detail 未就绪时给一节占位，避免闪 0/0。
          const chapterText = detail?.status === 'ready' && typeof detail?.data?.text === 'string' ? detail.data.text : '';
          const sections = splitLectureSections(chapterText);
          const idx = Math.min(Math.max(lectureSection, 0), sections.length - 1);
          // 兄弟章（本课程讲义按章号升序）用于跨章翻。
          const ordered = [...lectureRows].sort((a, b) => Number(a?.no ?? 0) - Number(b?.no ?? 0));
          const chapterIdx = ordered.findIndex((item) => String(item?.no) === String(openLectureRow.lecture?.no));
          return { kind: 'lecture', list: sections, index: idx, labelOf: (item) => String(item?.title ?? ''), ordered, chapterIdx };
        }
        const list = netRows;
        const idx = list.findIndex((item) => String(item?.id) === String(selected));
        return { kind: 'node', list, index: idx, labelOf: (item) => String(item?.name ?? '未命名') };
      })();
      const pagerGoto = (state, targetIndex) => {
        if (state.kind === 'lecture') {
          if (targetIndex >= 0 && targetIndex < state.list.length) { setLectureSection(targetIndex); return; }
          // 越界 → 跨章：下一篇进下一章第一节；上一篇进上一章最后一节。
          const nextChapter = state.ordered[state.chapterIdx + (targetIndex >= state.list.length ? 1 : -1)];
          if (nextChapter === undefined || nextChapter === null) return; // 到头停
          const dir = targetIndex >= state.list.length ? 'next' : 'prev';
          openLecture(nextChapter).then(() => {
            // openLecture 里已把 lectureSection 复位到 0；进上一章最后一节时需再定位到末节。
            if (dir === 'prev') {
              const styles = [...objectList(nextChapter.styles), ...objectList(nextChapter.variants)];
              const styleFile = (styles.find((item) => String(item.key) === String(lectureStyle))
                ?? styles.find((item) => String(item.key) === 'C')
                ?? styles.find((item) => String(item.key) === 'A')
                ?? styles[0])?.file ?? '';
              const prevSecs = splitLectureSections(peekMaterialText(styleFile)?.text ?? '');
              setLectureSection(Math.max(prevSecs.length - 1, 0));
            }
          });
          return;
        }
        const item = state.list[targetIndex];
        if (item === undefined || item === null) return;
        selectForReading(item.id);
      };
      const pagerCanPrev = pagerState.kind === 'lecture'
        ? (pagerState.index > 0 || pagerState.chapterIdx > 0)
        : pagerState.index > 0;
      const pagerCanNext = pagerState.kind === 'lecture'
        ? (pagerState.index >= 0 && (pagerState.index < pagerState.list.length - 1 || pagerState.chapterIdx < pagerState.ordered.length - 1))
        : (pagerState.index >= 0 && pagerState.index < pagerState.list.length - 1);
      const switchSlotContent = pagerState.list.length === 0
        ? h('span', { className: 'sa-study-slot-hint' }, pagerState.kind === 'lecture' ? '本课程无讲义' : '本课程无知识点')
        : h('div', { className: 'sa-pager' },
            h('div', { className: 'sa-pager-row' },
              h('button', { type: 'button', className: 'sa-btn sa-pager-btn', disabled: !pagerCanPrev, title: pagerCanPrev ? `上一篇：${pagerState.labelOf(pagerState.list[pagerState.index - 1])}` : '已经是第一篇', onClick: () => pagerGoto(pagerState, pagerState.index - 1) }, '上一篇'),
              h('span', { className: 'sa-pager-count', title: pagerState.kind === 'lecture' ? '当前节 / 本章总节数' : '当前篇 / 总篇数' }, pagerState.index >= 0 ? `${pagerState.index + 1} / ${pagerState.list.length}` : `— / ${pagerState.list.length}`),
              h('button', { type: 'button', className: 'sa-btn sa-pager-btn', disabled: !pagerCanNext, title: pagerCanNext ? `下一篇：${pagerState.labelOf(pagerState.list[pagerState.index + 1])}` : '已经是最后一篇', onClick: () => pagerGoto(pagerState, pagerState.index + 1) }, '下一篇')),
            h('select', {
              className: 'sa-pager-select',
              'aria-label': pagerState.kind === 'lecture' ? '跳转到本节' : '跳转到知识点',
              value: pagerState.index >= 0 ? String(pagerState.index) : '',
              onChange: (event) => {
                const nextIndex = Number(event.target.value);
                if (Number.isInteger(nextIndex) && nextIndex >= 0) pagerGoto(pagerState, nextIndex);
              },
            },
              pagerState.index < 0 ? h('option', { value: '' }, '跳转…') : null,
              ...pagerState.list.map((item, i) => h('option', { key: String(item?.id ?? item?.no ?? i), value: String(i) }, pagerState.labelOf(item)))));


      const treeWorkspace = h('div', { className: 'sa-learning-layout', 'data-full-browser': fullBrowser ? 'true' : 'false',
        'data-browser-collapsed': browserCollapsed ? 'true' : 'false' },
        h('section', { className: 'sa-browser-pane', 'aria-label': '选择知识点' }, browsingHeader,
          h('div', { className: 'sa-browser-content', id: 'sa-browser-content' },
            fullBrowser ? h('div', { key: kpView, className: 'sa-kp-view sa-full-browser' }, kpView === 'tree' ? treeCard : mindCard) : compactTree)),
        h('section', { className: 'sa-reader-pane', ref: readerRef, tabIndex: focusReading ? -1 : 0, 'data-focus-reader': focusReading ? 'true' : 'false',
          'data-study-mode': focusReading ? 'true' : 'false',
          'data-eye-care': focusReading && eyeCare ? 'true' : 'false',
          // 三栏探针（可弃）：进专注才挂，默认态一个字都不改。
          'data-focus-three-col': focusReading ? 'true' : 'false',
          // v2-H：只有真拖过（colWidth != null）才挂 dragged，CSS 才覆盖 90ch 并取消居中；没拖过仍是 90ch 居中。
          'data-read-col-dragged': focusReading && colWidth != null ? 'true' : 'false',
          style: { '--sa-read-scale': String(readScale), ...(focusReading && colWidth != null ? { '--sa-read-col': colWidth + 'px' } : {}),
            ...(focusReading ? { '--sa-focus-rail': (leftRailOpen ? railWidth : 0) + 'px', '--sa-focus-chat': (rightChatOpen ? chatWidth : 0) + 'px',
              // 块 A：右栏顶部的让位值（宿主顶栏高度，进专注时量一次，量不到 48px）
              '--sa-focus-chat-top': focusChatTopPx() } : {}) },
          'aria-label': selectedNode ? '知识点阅读：' + selectedNode.name : '知识点阅读区' },
          focusReading && leftRailOpen ? h('div',{className:'sa-focus-header sa-study-header','data-focus-three-col':'true',style:{ '--sa-focus-rail': railWidth + 'px' }},
            h('strong',null,focusReadingTitle),
            // 三栏探针：左栏可隐藏（隐藏后左侧浮出「显示左栏」）；Esc 仍可退出学习模式。
            h('button',{type:'button',className:'sa-btn','data-sa-hide':'left','aria-label':'隐藏左栏','title':'隐藏左栏（隐藏后点左侧浮标恢复；Esc 退出学习模式）',onClick:()=>toggleLeftRail(false)},'⟨ 收起左栏'),
            // 学习模式顶部三功能位（2026-11-17 C1）：本阶段只占位空壳，阶段二/三往三个 slot 里填内容。
            // data-slot 值固定为 clock|switch|marks，供后续复用与测试锚定。
            h('div',{className:'sa-study-slots','aria-label':'学习模式工具栏'},
              h('div',{className:'sa-study-slot sa-study-clock','data-slot':'clock'}, clockSlotContent),
              h('div',{className:'sa-study-slot sa-study-switch','data-slot':'switch'}, switchSlotContent),
              h('div',{className:'sa-study-slot sa-study-marks','data-slot':'marks'}, marksSlotContent)),
            // AI 材料导出区（2026-11-18 E1）：一条入口，展开后选范围（当前文件/全部）+ 两格式（md/json）。
            // 下载走 Blob；webview 禁用 createObjectURL 时退页面内 <pre> 展示 + 复制。
            h('div',{className:'sa-ai-export','data-slot':'ai-export'},
              h('button',{type:'button',className:'sa-btn sa-ai-export-toggle','aria-expanded':aiExportOpen?'true':'false','aria-controls':'sa-ai-export-body',onClick:()=>{setAiExportOpen(v=>{const next=!v;if(next)loadAiMaterialInfo();return next;});}},
                aiExportOpen ? '▾ AI 材料（自动收集）' : '▸ AI 材料（自动收集）'),
              aiExportOpen ? h('div',{id:'sa-ai-export-body',className:'sa-ai-export-body'},
                h('div',{className:'sa-ai-export-auto',role:'status'},
                  aiMaterialInfo === null
                    ? '标注变动会自动保存，无需手动操作。'
                    : `✓ 已自动保存 ${aiMaterialInfo.count} 份到 _工具/AI材料/（无需手动下载）`),
                h('div',{className:'sa-ai-export-row','aria-label':'导出范围'},
                  h('span',{className:'sa-ai-export-label'},'范围'),
                  h('button',{type:'button',className:'sa-btn sa-ai-export-scope'+(aiExportScope==='file'?' is-selected':''),'data-export-scope':'file','aria-pressed':aiExportScope==='file'?'true':'false',onClick:()=>setAiExportScope('file')},'当前文件'),
                  h('button',{type:'button',className:'sa-btn sa-ai-export-scope'+(aiExportScope==='all'?' is-selected':''),'data-export-scope':'all','aria-pressed':aiExportScope==='all'?'true':'false',onClick:()=>setAiExportScope('all')},'全部')),
                h('div',{className:'sa-ai-export-row','aria-label':'另存一份'},
                  h('span',{className:'sa-ai-export-label'},'另存'),
                  h('button',{type:'button',className:'sa-btn','data-export-format':'md',disabled:aiExportBusy,title:'再另存一份最新 Markdown 到下载目录（含 [重点]/[疑问]/[待复习] 与时间）',onClick:()=>runAiExport('md')},aiExportBusy?'处理中…':'另存 Markdown'),
                  h('button',{type:'button',className:'sa-btn','data-export-format':'json',disabled:aiExportBusy,title:'再另存一份最新 JSON（原始批注数据）',onClick:()=>runAiExport('json')},aiExportBusy?'处理中…':'另存 JSON')),
                aiExportNote !== '' ? h('div',{className:'sa-ai-export-note',role:'status'},aiExportNote) : null,
                aiExportPreview !== null ? h('div',{className:'sa-ai-export-fallback'},
                  h('button',{type:'button',className:'sa-btn',onClick:()=>{try{if(navigator?.clipboard?.writeText)navigator.clipboard.writeText(aiExportPreview.text).then(()=>setAiExportNote('已复制到剪贴板')).catch(()=>setAiExportNote('复制失败，请手动选中下方文字'));else setAiExportNote('浏览器不支持复制，请手动选中');}catch(e){setAiExportNote('复制失败，请手动选中');}}},'复制内容'),
                  h('pre',{className:'sa-ai-export-pre'},aiExportPreview.text)) : null
              ) : null),
            // 左侧栏行内格式面板（2026-11-18 用户定：选中后选项出现在左栏，不再浮气泡被挡）
            (dockState !== null && dockState !== undefined && dockState.bubble !== null && dockState.bubble !== undefined)
              ? h('div',{className:'sa-dock-annotation','data-slot':'annotation-dock'}, dockPanelContent)
              : null,
            h('span',{className:'sa-read-size',role:'group','aria-label':'正文字号'},
              h('button',{type:'button',className:'sa-btn','aria-label':'减小字号',title:'字号减 1px',onClick:()=>stepReadScale(-READ_SCALE_STEP)},'A−'),
              h('output',{className:'sa-zoom-value','aria-live':'polite',title:'正文字号：DSH 内容字号 × 本次倍率'},String(readFontPx)+'px'),
              h('button',{type:'button',className:'sa-btn','aria-label':'增大字号',title:'字号加 1px',onClick:()=>stepReadScale(READ_SCALE_STEP)},'A+'),
              // 2026-10-30：「重置」改成「100%」，同时补「适应窗口」。原来叫「重置」太含糊
              // （重置什么？），而 100% 跟导图那排缩放一个口径、也直接说清了「倍率回到 1」；
              // 两颗按钮都做 setReadScale(1) 只会让人猜区别，所以合并成一颗。
              h('button',{type:'button',className:'sa-btn','aria-label':'字号 100%',title:`100%：完全跟随 DSH 设置里的「内容字号」（${Math.round(dshContentFontSize())}px）`,onClick:()=>setReadScale(1)},'100%'),
              h('button',{type:'button',className:'sa-btn','aria-label':'字号适应窗口',title:'按阅读区宽度把正文栏拉回 80 字一行：窄面板缩小、宽面板放大',onClick:fitReadToPane},'适应窗口')),
            // 护眼模式开关（2026-11-17 C1feat）：新增独立控件，放字号控件下方、竖条底部区上方。
            // 不占 data-slot（三插槽 clock/switch/marks 结构不动），aria-pressed 反映开关状态，点击切换并写 localStorage。
            h('button',{type:'button',className:'sa-btn sa-eye-toggle','aria-pressed':eyeCare?'true':'false',title:'护眼模式：米黄/暖深底 + 暖黑字，减轻蓝光。状态会记住，下次进学习模式保持',onClick:toggleEyeCare},eyeCare?'护眼：开':'护眼：关'),
            // C1fix：Esc 提示 + 退出按钮收进竖条底部区（.sa-study-footer 用 margin-top:auto 沉底）。
            h('div',{className:'sa-study-footer'},
              h('span',{className:'sa-muted'},'Esc 退出'),
              h('button',{type:'button',className:'sa-btn',onClick:exitFocusReading},'退出学习模式'))) : null,
          // 顺序（2026-10-29 用户定）：讲义正文在上、知识点详情在下。
          // 讲义是「点进来的那一份」，先读它；详情卡（标题/掌握度/详解…）跟在后头当背景资料。
          // 点知识点时 detailCard 会被收掉（见 selectForReading），所以这里是「一份内容」而不是两张卡叠着。
          lectureHintCard,
          detailCard,
          nodeCard || (detailCard === null && lectureHintCard === null ? h('div', { className: 'sa-card sa-reader-empty' },
            h('h3', null, '选一个知识点开始阅读'),
            h('p', null, '点章名读该章讲义；展开章/节，点知识点名称读它自己的详解、例题和配图。'),
            h('p', { className: 'sa-muted' }, '查看全章关系时，可展开完整导图；点选后自动回到阅读布局。')) : null)));

      /**
       * 右栏聊天的界面上下文（卡 ③ D-1）：就在专注模式里，所以 `studyMode` 恒为 true。
       *
       * 页签写死 `knowledge`：这一栏只长在知识点页的专注态里；节点标题按当前选中的节点查，
       * 查不到就只带 id（`buildAssistantContext` 自己会跳过空值）。
       */
      const buildFocusChatContext = () => {
        const context = buildAssistantContext('knowledge', (nodeId) => (
          selectedNode !== null && selectedNode !== undefined && String(selectedNode.id) === String(nodeId)
            ? String(selectedNode.name ?? '')
            : ''
        ));
        context.studyMode = true;
        return context;
      };

      return h('div', { className: 'sa-knowledge-page', ref: splitterHostRef },
        kpToolbar,
        // v2-H 返工（2026-11-23）：专注阅读可见竖向分隔条。挂在 .sa-knowledge-page 直接子级（它是 reader-pane
        // 的父级、专注态 transform:none 且不滚动），所以不会被 reader-pane 的 overflow 裁剪、也不会被其右侧
        // 滚动条盖住（上一版挂 reader-pane 内部拖不动的根因）。常态可见（display:block），拖动改正文列宽。
        // 块 B（2026-11-23 反馈 2）：右栏张开时它退场（`data-sa-axis="merged"` → CSS display:none），
        // 右侧只留「右栏左缘」那一根轴；右栏关掉时它自己回来 —— v2-H 能力与既有断言都不丢。
        focusReading ? h('div', {
          className: 'sa-read-splitter',
          onMouseDown: startColResize,
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整正文宽度',
          title: '拖动调整正文宽度（往右变宽 / 往左变窄）',
          'data-sa-read-splitter': true,
          'data-sa-axis': rightChatOpen ? 'merged' : 'split',
          style: splitterStyle,
        }) : null,
        // 三栏（2026-11-23）：左/右两条边界分隔条 + 隐藏后的恢复浮标。
        // 位置直接用栏宽算（不量 DOM），拖拽只改 state 与模块记忆；z-index 高过专注面。
        focusReading && leftRailOpen ? h('div', {
          className: 'sa-focus-boundary',
          'data-sa-boundary': 'rail',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整左栏宽度',
          title: '拖动调整左栏宽度（往右变宽 / 往左变窄）',
          onMouseDown: startBoundaryResize('rail'),
          style: { left: railWidth + 'px' },
        }) : null,
        focusReading && rightChatOpen ? h('div', {
          className: 'sa-focus-boundary',
          'data-sa-boundary': 'chat',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整右栏宽度',
          title: '拖动调整右栏宽度（往左变宽 / 往右变窄）',
          onMouseDown: startBoundaryResize('chat'),
          // 轴从右栏的头顶（宿主顶栏以下）拉到窗口底，跟右栏本身对齐，别跑到顶栏里去
          style: { left: 'calc(100vw - ' + chatWidth + 'px)', top: focusChatTopPx() },
        }) : null,
        focusReading && !leftRailOpen ? h('button', { type: 'button', className: 'sa-focus-stub', 'data-side': 'left', 'data-sa-stub': 'left', 'aria-label': '显示左栏', title: '显示左栏', onClick: () => toggleLeftRail(true) }, '显示左栏') : null,
        focusReading && !rightChatOpen ? h('button', { type: 'button', className: 'sa-focus-stub', 'data-side': 'right', 'data-sa-stub': 'right', 'aria-label': '显示右栏', title: '显示右栏', onClick: () => toggleRightChat(true) }, '显示右栏') : null,
        isTreeView ? treeWorkspace : h('div', null,
          h('div', { key: kpView, className: 'sa-kp-view' }, kpView === 'graph' ? graphCard : knowledgeListCard),
          // 与树视图同一顺序：讲义正文在前，详情卡在后
          lectureHintCard, detailCard, nodeCard),
        // 右栏（2026-11-23 块 D）：真聊天。fixed 贴右缘，宽度走 --sa-focus-chat，
        // 头顶让出 --sa-focus-chat-top；放在最后渲染，保证它与 .sa-reader-pane 同 z-index 时叠在纸面之上。
        focusReading && rightChatOpen ? h('aside', {
          className: 'sa-focus-chat',
          'data-sa-focus-chat': 'true',
          'aria-label': '学习助手（专注阅读右栏）',
          style: { '--sa-focus-chat': chatWidth + 'px', '--sa-focus-chat-top': focusChatTopPx() },
        },
          h(FocusChatPanel, {
            onHide: () => toggleRightChat(false),
            buildContext: buildFocusChatContext,
            // 经聊天改完掌握度后让知识网络立刻反映（等级、章节统计读的都是同一份数据）。
            // `refresh()` 可能同步返回也可能返回 Promise，两种都接住；刷新失败不影响聊天回执。
            onMasteryChanged: typeof refresh === 'function' ? () => {
              try {
                const pending = refresh();
                if (pending !== null && pending !== undefined && typeof pending.then === 'function') pending.catch(() => {});
              } catch (error) { /* 刷新失败不影响聊天 */ }
            } : null,
          }),
        ) : null,
        dueCard,
        batchCard,
        addNodeCard, jobCard);
    }

    // ---------------------------------------------------------------------
    // 学习记录（P3，2026-10-30）：时间线
    // ---------------------------------------------------------------------
    /**
     * 「学习记录」页签：把「读过 / 批注过 / 标了什么知识点」按时间摊开成时间线。
     *
     * 边界（决策 E1）：
     * - 时间线只用 阅读位置.json / 批注.json / 知识点网络.json 里已有的事实，**不埋点、不统计时长**；
     * - 交互助手对话面板已于 2026-11-18（E2 卡）下线，这里只剩头卡 + 时间线；
     *   磁盘上 `学习记录/对话/` 的旧文件保留只读，不再有入口。
     */
    function RecordsTab({ docs = {}, refresh }) {
      const courses = objectList(docs.courses?.courses);
      const [courseId, setCourseId] = useState('');
      const [log, setLog] = useState(null);
      const [status, setStatus] = useState('loading');
      const [error, setError] = useState('');

      const loadLog = async (cid) => {
        setStatus('loading');
        setError('');
        const result = await fetchStudyLog(cid);
        if (result.ok !== true) {
          setStatus('error');
          setError(`读取失败（${result.error ?? 'unknown'}）`);
          return;
        }
        setLog(result);
        setStatus('ready');
      };
      useEffect(() => {
        loadLog(courseId);
      }, [courseId]);

      const head = h('div', { className: 'sa-card' },
        h('h3', null, '学习记录'),
        h('div', { className: 'sa-dock' },
          h('span', { className: 'sa-muted' }, '课程'),
          h('select', {
            className: 'sa-input',
            value: courseId,
            onChange: (event) => setCourseId(event.target.value),
          }, h('option', { value: '' }, '全部'),
          ...courses.map((course) => h('option', { key: course.id, value: course.id }, course.name))),
          h('span', { className: 'sa-spacer' }),
          h('button', { className: 'sa-btn', onClick: () => loadLog(courseId) }, '刷新')));

      const errorBanner = error === '' ? null : h('div', { className: 'sa-error', style: { margin: '6px 0' } }, error);

      // ── 时间线：只用现有 JSON 的事实，不埋点、不编造时长 ──
      const kindIcon = { read: '📖', annotation: '✏️', knowledge: '★' };
      const timelineEvents = status === 'ready' ? objectList(log?.timeline) : [];
      const timelineSection = h('div', { className: 'sa-card' },
        h('h3', null, '时间线'),
        h('div', { className: 'sa-muted', style: { fontSize: 12, marginBottom: 6 } },
          '数据只来自 阅读位置.json、批注.json、知识点网络.json——不统计时长，也不埋点。'),
        status === 'loading' ? h('div', { className: 'sa-muted' }, '读取中…') : null,
        status === 'ready' && timelineEvents.length === 0
          ? h('div', { className: 'sa-muted' }, '还没有学习记录。读一份资料、写一条批注、或复习一个知识点，这里就会出现条目。')
          : null,
        ...timelineEvents.map((ev, index) => h('div', { key: `${ev.kind}-${index}`, className: 'sa-row sa-log-row' },
          h('span', { className: 'sa-log-icon', title: String(ev.kind ?? '') }, kindIcon[ev.kind] ?? '•'),
          h('div', { className: 'sa-grow' },
            h('div', { className: 'sa-log-title' }, String(ev.title ?? '')),
            typeof ev.detail === 'string' && ev.detail !== ''
              ? h('div', { className: 'sa-muted', style: { fontSize: 12 } }, ev.detail)
              : null),
          h('div', { style: { textAlign: 'right' } },
            h('div', { className: 'sa-muted', style: { fontSize: 12 } }, formatStamp(ev.at)),
            h('div', { className: 'sa-muted', style: { fontSize: 11 }, title: '数据来源' }, `来源：${ev.basis ?? '—'}`)))));

      return h('div', null, head, errorBanner, timelineSection);
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
      // 两源：作业.json 的 records[].model、知识点网络的更新时间。
      const [backupBusy, setBackupBusy] = useState(false);
      const [backupNote, setBackupNote] = useState('');

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

    // ---------------------------------------------------------------------
    // 学习助手浮层（2026-11-19 MVP 卡）：面板内的置顶答疑
    // ---------------------------------------------------------------------

    /**
     * `/assistant/reply` 的失败码 → 界面上的中文。
     *
     * 只翻错误码，**绝不把响应里的任何密钥/原文再显示一遍**：服务端的 detail
     * 本身就只留错误类型与 HTTP 码（见 lib/api.js 的 handleAssistantReply）。
     */
    function assistantFailureText(result, status) {
      const code = String(result?.error ?? '');
      const detail = typeof result?.detail === 'string' ? result.detail : '';
      const messages = {
        'bad-request': detail === '' ? '请求不合法，检查一下问的内容。' : `请求不合法：${detail}`,
        'assistant-key-missing': '没有读到 magpie 密钥（~/.dsh/.credentials.yaml 的 refs.MAGPIE_GATEWAY_KEY），学习助手暂不可用。',
        'assistant-unavailable': '通道没通（超时 / 限流 / 网络），这次没有回复，稍后再试。',
        'bad-json': '请求体不是合法 JSON。',
        'too-large': '这次贴的内容太长了，拆成几次问。',
        'need-request-header': '请求被拒绝：缺少安全请求头（插件可能还没重启）。',
        'cross-site-rejected': '请求被拒绝：来源不可信。',
        // v2-B 卡（2026-11-20）：改掌握度写路由的错误码。措辞要让人一眼看出「改没改」。
        'bad-mastery': '掌握度只能是 0–3（未学 / 学过 / 熟练 / 精通），这次没改。',
        'confirm-required': '这是写操作，要先确认再落库；这次没改（可能插件还没重启）。',
        'unknown-node': '这个知识点不在知识点网络里，这次没改。',
        'bad-node-id': '知识点 id 不合法，这次没改。',
        conflict: '数据刚被别处改过（可能另一个窗口在写），这次没改，刷新后重试。',
      };
      if (messages[code] !== undefined) return messages[code];
      return detail !== '' ? detail : `请求失败（HTTP ${status}）`;
    }

    /**
     * 采集「当前界面」→ `/assistant/reply` 的可选 `context`（v2-A，B3 两级）。
     *
     * 真源就是面板现有的三处状态，**不新造「当前在哪」**：
     *   - 页签：调用方传进来的 `tab`（MainPanel 的 state），退回模块里的 `navTabMemory`；
     *   - 知识点：`readKnowledgeUi().selected`（string node id）；
     *   - 资料：`readMaterialsUi().openPath` / `openPage`。
     *
     * 两条门控很重要（否则会把"上次看过"当成"现在在看"）：
     *   1. 只有当前就在 `knowledge` 页签时才带节点；离开后 `selected` 仍留在内存里；
     *   2. 只有当前就在 `materials` 页签、且处在文件视图时才带资料；`openPath`
     *      是跨页签保留的记忆，题目视图下也不代表"正在读这份文件"。
     *
     * 取不到的一律不填（空字符串 / 非正整数 / null 都跳过），**绝不为取不到而抛错**。
     * `nodeTitle` 由调用方用现成知识网络数据查（`getKnowledgeTitle`），查不到就只带 id，
     * 不为标题额外拉接口。
     */
    function buildAssistantContext(tab, getKnowledgeTitle) {
      const context = {};
      const currentTab = typeof tab === 'string' && tab !== '' ? tab : navTabMemory;
      if (currentTab !== '') context.tab = currentTab;

      if (currentTab === 'knowledge') {
        const knowledge = readKnowledgeUi();
        if (knowledge.selected !== null && knowledge.selected !== undefined && knowledge.selected !== '') {
          context.nodeId = knowledge.selected;
          if (typeof knowledge.courseId === 'string' && knowledge.courseId !== '') {
            context.courseId = knowledge.courseId;
          }
          if (typeof getKnowledgeTitle === 'function') {
            const title = getKnowledgeTitle(knowledge.selected);
            if (typeof title === 'string' && title.trim() !== '') context.nodeTitle = title.trim();
          }
        }
      }

      if (currentTab === 'materials') {
        const materials = readMaterialsUi();
        // 文件视图：openPath 非空 = 正在读这份资料；页码只认 1-based 正整数
        if (materials.view === 'files'
          && typeof materials.openPath === 'string'
          && materials.openPath !== '') {
          context.materialPath = materials.openPath;
          if (Number.isInteger(materials.openPage) && materials.openPage > 0) {
            context.materialPage = materials.openPage;
          }
        }
        // 题目视图：没有"当前第几题"的状态，按卡 ⑤ 取不到就不填 questionNo，只带课程 id
        if (materials.view === 'questions'
          && typeof materials.courseId === 'string'
          && materials.courseId !== '') {
          context.courseId = materials.courseId;
        }
      }

      // v2-E：只有专注学习模式（「学习搭子」人设）才带这个字段；非专注不出现，
      // 保持与 v2-A / v2-D 逐字一致（不多出字段）。拿不到就当 false，绝不抛错。
      if (studyModeMemory === true) context.studyMode = true;

      return context;
    }

    // ---------------------------------------------------------------------
    // 专注三栏 · 右栏聊天（2026-11-23 路线二：复用 /assistant/reply 多轮链路）
    // ---------------------------------------------------------------------
    //
    // 为什么不去嵌宿主原生聊天（路线一）：探针结论是 client-ui-chat 没有公开的组件入口，
    // 硬塞进去只会拿到一个「看着像聊天但发不出话」的空壳。所以这里复用**已经在跑**的链路：
    //   `/assistant/reply`（多轮 + 会话落盘）、`/assistant/session/*`（列表/新建/改名/归档）、
    //   `/assistant/models`（模型下拉；服务端转网关，前端不经手密钥）。
    //
    // 与旧浮层（AssistantOverlay）的关系：浮层入口已删（卡 ③ 块 C），组件本体暂留不删。
    // 右栏这份**有意不共享**浮层的 state：它的生命周期跟着「进出专注」走，
    // 与浮层「关掉面板再打开」不是一回事。

    /** 模型下拉的初值：与后端 `ASSISTANT_MODEL_DEFAULT` / `MAGPIE_MODEL` 是同一个字符串。 */
    const FOCUS_CHAT_MODEL_DEFAULT = 'group/wb';

    /**
     * 把 `/assistant/models` 的返回归一成下拉选项。
     *
     * 只认非空字符串 id、去重、默认模型排第一（下拉第一项就是「不改模型」那一项）；
     * 一个都拿不到就给默认一个 —— 下拉永远不空（卡 ⑧ 风险预案）。
     */
    function normalizeChatModels(value) {
      const list = Array.isArray(value) ? value : [];
      const seen = {};
      const models = [];
      for (const item of list) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        if (id === '' || seen[id] === true) continue;
        seen[id] = true;
        models.push({ id, owned_by: typeof item?.owned_by === 'string' ? item.owned_by.trim() : '' });
      }
      if (models.length === 0) return [{ id: FOCUS_CHAT_MODEL_DEFAULT, owned_by: '' }];
      return models.filter((item) => item.id === FOCUS_CHAT_MODEL_DEFAULT)
        .concat(models.filter((item) => item.id !== FOCUS_CHAT_MODEL_DEFAULT));
    }

    /** 把 `/assistant/session/get` 的 messages 归一成右栏的消息状态（确认状态字段一起带上）。 */
    function mapSessionMessages(list) {
      return (Array.isArray(list) ? list : []).map((item) => ({
        role: item?.role === 'user' ? 'user' : 'assistant',
        content: typeof item?.content === 'string' ? item.content : '',
        action: item?.action !== null && typeof item?.action === 'object' ? item.action : null,
        actionState: null,
        batchSelected: null,
        batchExpanded: false,
      }));
    }

    /**
     * 后端回的 `proposedAction` 只认两种「改掌握度」的预览，别的形状一律当没有。
     *
     * 认错形状的后果是界面上出现一排点了没用的按钮，所以这里宁可少认。
     */
    function pickAssistantProposal(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null;
      if (value.kind !== 'set-mastery' && value.kind !== 'set-mastery-batch') return null;
      return value;
    }

    /**
     * 专注三栏的右栏聊天面板（卡 ③ 块 D）。
     *
     * 能力对齐用户拍板（「完整可用」）：多轮对话 + 选模型 + 会话列表（新建/切换/改名/归档）。
     * 完全权限：`/assistant/reply` 本来就是直接答、没有工具确认环节，所以这一栏不需要权限选择器。
     * 所有网络失败都走 `assistantFailureText` 的中文口径，**不把响应原文倒给用户**。
     *
     * props:
     *   - `onHide()`：收起右栏（右栏头部那颗「收起 ⟩」）。
     *   - `buildContext()`：发送那一刻现算界面上下文（由 KnowledgeTab 提供，含 `studyMode:true`）。
     *   - `onMasteryChanged()`：经聊天改完掌握度后让面板刷新知识网络（可选）。
     */
    function FocusChatPanel(props = {}) {
      const onHide = typeof props.onHide === 'function' ? props.onHide : () => {};
      const buildContext = typeof props.buildContext === 'function' ? props.buildContext : () => ({ studyMode: true });
      const onMasteryChanged = typeof props.onMasteryChanged === 'function' ? props.onMasteryChanged : null;

      const [draft, setDraft] = useState('');
      const [messages, setMessages] = useState([]);
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState('');
      // 模型：选中值随每次 /assistant/reply 发出去（后端只做类型/长度校验，非法回退默认）
      const [model, setModel] = useState(FOCUS_CHAT_MODEL_DEFAULT);
      const [models, setModels] = useState(() => [{ id: FOCUS_CHAT_MODEL_DEFAULT, owned_by: '' }]);
      const [modelsNote, setModelsNote] = useState('');
      // 多会话（复用 v2-C 那套接口）：conversationId 带进请求才会落盘
      const [conversationId, setConversationId] = useState('');
      const [sessions, setSessions] = useState([]);
      const [sessionsShown, setSessionsShown] = useState(false);
      const [includeArchived, setIncludeArchived] = useState(false);
      const [renamingId, setRenamingId] = useState('');
      const [renameDraft, setRenameDraft] = useState('');
      const [sessionError, setSessionError] = useState('');
      const [hasSummary, setHasSummary] = useState(false);
      const logRef = useRef(null);

      // 模型下拉的选项：进右栏拉一次（服务端转网关 /models）。拿不到就留在默认模型上并提示一句，
      // 绝不因为下拉没选项就把聊天拦住。
      useEffect(() => {
        if (typeof fetch !== 'function') return undefined;
        let disposed = false;
        fetch(`${API}/assistant/models`)
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (disposed) return;
            if (result === null || result.ok !== true) return;
            setModels(normalizeChatModels(result.models));
            setModelsNote(result.degraded === true ? '网关的模型清单没取到，先用默认模型。' : '');
          })
          .catch(() => { if (disposed !== true) setModelsNote('网关的模型清单没取到，先用默认模型。'); });
        return () => { disposed = true; };
      }, []);

      /** 拉一次会话列表（归档是否一起列由 includeArchived 决定）。只读，失败只提示不打断。 */
      const refreshSessions = (withArchived) => {
        if (typeof fetch !== 'function') return;
        const flag = withArchived === true;
        fetch(`${API}/assistant/session/list${flag ? '?includeArchived=1' : ''}`)
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) return;
            setSessions(Array.isArray(result.sessions) ? result.sessions : []);
          })
          .catch(() => { /* 列表拉不到不影响问答 */ });
      };

      // 进右栏、切换「显示已归档」时拉一次列表：会话切换条上的标题与条数就靠它
      useEffect(() => { refreshSessions(includeArchived); }, [includeArchived]);

      // 新消息进来 / 展开会话列表 / 从「思考中」回到回答时，把对话区滚到底。
      // 假 DOM 里没有 scrollHeight 数字，直接跳过，别让整页挂掉。
      useEffect(() => {
        const el = logRef.current;
        if (el === null || el === undefined || typeof el.scrollHeight !== 'number') return;
        el.scrollTop = el.scrollHeight;
      }, [messages, busy, sessionsShown]);

      /** 新开会话：清空本地对话并置空 conversationId（下一次发送会新建一条落盘会话）。 */
      const startNewSession = () => {
        setConversationId('');
        setMessages([]);
        setDraft('');
        setFailure('');
        setSessionError('');
        setHasSummary(false);
        setSessionsShown(false);
      };

      /** 切到某个历史会话：从磁盘读回全文（含 summary 提示），并置 conversationId。 */
      const openSession = (id) => {
        if (busy) return;
        const sid = String(id ?? '').trim();
        if (sid === '') return;
        fetch(`${API}/assistant/session/get?id=${encodeURIComponent(sid)}`)
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true || result.session === undefined) {
              throw new Error('会话读不出来，可能已损坏。');
            }
            return result.session;
          })
          .then((session) => {
            setMessages(mapSessionMessages(session.messages));
            setHasSummary(typeof session.summary === 'string' && session.summary.trim() !== '');
            setConversationId(sid);
            setSessionsShown(false);
            setSessionError('');
            setFailure('');
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      /** 改名：置 titleCustom=true（服务端拍板），成功后就地刷新列表。 */
      const commitRename = (id) => {
        const sid = String(id ?? '').trim();
        const title = renameDraft.trim();
        if (sid === '' || title === '') { setRenamingId(''); return; }
        fetch(`${API}/assistant/session/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ id: sid, title }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) throw new Error('改名没成功，稍后再试。');
            return result;
          })
          .then(() => {
            setRenamingId('');
            setRenameDraft('');
            refreshSessions(includeArchived);
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      /** 归档 / 取消归档：只改标记位（服务端不删磁盘），成功后刷新列表。 */
      const toggleArchive = (id, archived) => {
        const sid = String(id ?? '').trim();
        if (sid === '') return;
        fetch(`${API}/assistant/session/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ id: sid, archived: archived === true }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) throw new Error('操作没成功，稍后再试。');
            return result;
          })
          .then(() => {
            // 归档了当前正在看的会话 → 切回「新会话」，避免显示已藏起来的会话
            if (archived === true && sid === conversationId) {
              setConversationId('');
              setMessages([]);
            }
            refreshSessions(includeArchived);
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      /**
       * 发一次问答：先把用户这句追加进对话再发请求（失败时也能看到自己问了什么），
       * 成功后把回复追加进同一条对话；**失败不自动重发**，避免一次手滑变成重复扣额度。
       */
      const send = () => {
        if (busy) return;
        const text = draft.trim();
        if (text === '') return;
        if (typeof fetch !== 'function') { setFailure('当前环境没法发请求。'); return; }
        const history = messages.concat([{ role: 'user', content: text }]);
        setMessages(history);
        setDraft('');
        setFailure('');
        setBusy(true);
        // 界面上下文：取不到就是空对象（后端归一为空串，不会凭空多出一条 system）
        let context = {};
        try {
          const built = buildContext();
          if (built !== null && typeof built === 'object') context = built;
        } catch (error) {
          context = {};
        }
        const payload = {
          messages: history.map((item) => ({ role: item.role, content: item.content })),
          model,
        };
        if (Object.keys(context).length > 0) payload.context = context;
        // 带上 conversationId 才落盘；没有就先建一条空会话（拿到 id 再发），首条消息后端会顺手命名
        const ensureSession = conversationId !== ''
          ? Promise.resolve(conversationId)
          : fetch(`${API}/assistant/session/new`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify({}),
            })
              .then(async (response) => {
                const result = await response.json().catch(() => null);
                if (result === null || result.ok !== true || result.session === undefined) {
                  throw new Error('新建会话没成功，稍后再试。');
                }
                return String(result.session.id);
              });
        ensureSession
          .then((sid) => {
            setConversationId(sid);
            payload.conversationId = sid;
            return fetch(`${API}/assistant/reply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify(payload),
            });
          })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            const reply = typeof result.reply === 'string' ? result.reply : '';
            if (reply.trim() === '') throw new Error('助手没有返回内容，稍后再试。');
            // 后端可能回一条「改掌握度的预览」：这里只是把它显示成待确认的按钮，
            // 一个字节都没落库；落库要等用户点「确认修改」再发第二个请求。
            const proposal = pickAssistantProposal(result.proposedAction);
            const batch = proposal !== null && proposal.kind === 'set-mastery-batch' ? proposal : null;
            setMessages((current) => current.concat([{
              role: 'assistant',
              content: reply,
              action: proposal,
              actionState: proposal === null ? null : 'pending',
              batchSelected: batch === null ? null : (Array.isArray(batch.nodes) ? batch.nodes.map((item) => item.nodeId) : []),
              batchExpanded: false,
            }]));
            // 会话已落盘/更新：刷新列表（首条消息后标题也会变成自动命名）
            refreshSessions(includeArchived);
          })
          .catch((error) => setFailure(String(error?.message ?? error)))
          .finally(() => setBusy(false));
      };

      /**
       * 确认落库（单点）：这是**第二次请求**，与预览严格分开。
       * 服务端没有 `confirm:true` 就 400 `confirm-required`，所以这里显式带上。
       */
      const confirmMastery = (index) => {
        if (busy) return;
        const message = messages[index];
        const action = message !== null && message !== undefined ? message.action : null;
        if (!action || message.actionState !== 'pending') return;
        setBusy(true);
        setFailure('');
        fetch(`${API}/assistant/mastery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ nodeId: action.nodeId, mastery: action.to, confirm: true }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            const receipt = result.changed === true
              ? `已更新「${action.nodeName}」为 ${action.toLabel}。`
              : `「${action.nodeName}」本来就是 ${action.toLabel}，等级没动；已记下这是你定的。`;
            setMessages((current) => current
              .map((item, at) => (at === index ? { ...item, actionState: 'done' } : item))
              .concat([{ role: 'assistant', content: receipt, action: null, actionState: null }]));
            if (onMasteryChanged !== null) {
              try { onMasteryChanged(); } catch { /* 刷新失败不影响回执 */ }
            }
          })
          .catch((error) => setFailure(String(error?.message ?? error)))
          .finally(() => setBusy(false));
      };

      /** 取消：什么都不改（连请求都不发），只把这条预览收起并说明一句。 */
      const cancelMastery = (index) => {
        setMessages((current) => current
          .map((item, at) => (at === index ? { ...item, actionState: 'cancelled' } : item))
          .concat([{ role: 'assistant', content: '好，这次没改。', action: null, actionState: null }]));
      };

      /** 批量失败原因 → 一句人话（只翻错误码，不回显服务端 detail）。 */
      const describeBatchFailures = (failures) => {
        const list = Array.isArray(failures) ? failures : [];
        const reasons = [...new Set(list.map((item) => String(item?.reason ?? '')))]
          .filter((item) => item !== '');
        const text = reasons.map((reason) => ({
          'unknown-node': '知识点已不在网络里',
          'bad-mastery': '等级不合法',
          'bad-node-id': '知识点 id 不合法',
          'bad-item': '清单条目损坏',
        }[reason] ?? '原因未知')).join('、');
        return text === '' ? '原因未知' : text;
      };

      /** 勾/取消清单里的一个节点（只改本地状态，**不发请求**）。 */
      const toggleBatchNode = (index, nodeId) => {
        setMessages((current) => current.map((item, at) => {
          if (at !== index) return item;
          const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
          const next = selected.includes(nodeId)
            ? selected.filter((id) => id !== nodeId)
            : selected.concat([nodeId]);
          return { ...item, batchSelected: next };
        }));
      };

      /** 全选 / 全不选（只改本地状态，**不发请求**）。 */
      const toggleBatchAll = (index) => {
        setMessages((current) => current.map((item, at) => {
          if (at !== index) return item;
          const nodes = Array.isArray(item.action?.nodes) ? item.action.nodes : [];
          const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
          const allOn = nodes.length > 0 && selected.length === nodes.length;
          return { ...item, batchSelected: allOn ? [] : nodes.map((node) => node.nodeId) };
        }));
      };

      /** 展开/收起清单（默认只渲染前 5 个 + 「… 共 N 个」，与浮层同口径）。 */
      const toggleBatchExpand = (index) => {
        setMessages((current) => current.map((item, at) => (
          at === index ? { ...item, batchExpanded: item.batchExpanded !== true } : item
        )));
      };

      /**
       * 批量确认落库：与单点同一套两步走，只是**一批只发一个请求**。
       * 只带当前勾选的 nodeId，等级统一用预览里的 `action.level`。
       */
      const confirmMasteryBatch = (index) => {
        if (busy) return;
        const message = messages[index];
        const action = message !== null && message !== undefined ? message.action : null;
        if (!action || message.actionState !== 'pending') return;
        const selected = Array.isArray(message.batchSelected) ? message.batchSelected : [];
        if (selected.length === 0) return;
        setBusy(true);
        setFailure('');
        fetch(`${API}/assistant/mastery-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({
            items: selected.map((nodeId) => ({ nodeId, mastery: action.level })),
            confirm: true,
          }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            const changed = Number.isFinite(result.changed) ? result.changed : 0;
            const skipped = Number.isFinite(result.skipped) ? result.skipped : 0;
            const failed = Number.isFinite(result.failed) ? result.failed : 0;
            let receipt = `已把 ${changed} 个知识点更新为 ${action.toLabel}`;
            if (skipped > 0) receipt += `（另有 ${skipped} 个本来就是 ${action.toLabel}，等级没动）`;
            if (failed > 0) receipt += `；${failed} 个没改成（${describeBatchFailures(result.failures)}）`;
            receipt += '。';
            setMessages((current) => current
              .map((item, at) => (at === index ? { ...item, actionState: 'done' } : item))
              .concat([{ role: 'assistant', content: receipt, action: null, actionState: null }]));
            if (onMasteryChanged !== null) {
              try { onMasteryChanged(); } catch { /* 刷新失败不影响回执 */ }
            }
          })
          .catch((error) => setFailure(String(error?.message ?? error)))
          .finally(() => setBusy(false));
      };

      const onKeyDown = (event) => {
        // 输入法组合中的 Enter 是「选词」，不是发送
        if (event?.nativeEvent?.isComposing === true || event?.isComposing === true) return;
        if (event?.key !== 'Enter' || event?.shiftKey === true) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        send();
      };

      /** 批量清单渲染（可勾选、可全选、超过 5 个折起来），与浮层同一套口径。 */
      const renderBatchProposal = (item, index) => {
        const action = item.action;
        const nodes = Array.isArray(action?.nodes) ? action.nodes : [];
        const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
        const expanded = item.batchExpanded === true;
        const pending = item.actionState === 'pending';
        const visible = expanded ? nodes : nodes.slice(0, 5);
        const allOn = nodes.length > 0 && selected.length === nodes.length;
        return h('div', {
          className: 'sa-assist-proposal sa-assist-proposal-batch',
          'data-resolved': pending ? 'false' : 'true',
          'data-sa-batch': true,
          key: `sa-focus-batch-${index}`,
        },
          h('div', { className: 'sa-assist-batch-head' },
            h('span', { className: 'sa-muted' },
              `待改 ${nodes.length} 个 · 已选 ${selected.length} 个${action.skipped > 0 ? ` · ${action.skipped} 个已是「${action.toLabel}」，会跳过` : ''}`),
            h('button', {
              className: 'sa-btn',
              type: 'button',
              disabled: !pending || nodes.length === 0,
              onClick: () => toggleBatchAll(index),
            }, allOn ? '全不选' : '全选'),
          ),
          h('div', { className: 'sa-assist-batch-list' },
            visible.map((node) => h('label', {
              key: `sa-focus-batch-${index}-${node.nodeId}`,
              className: 'sa-assist-batch-row',
            },
              h('input', {
                type: 'checkbox',
                className: 'sa-batch-selected',
                checked: selected.includes(node.nodeId),
                disabled: !pending,
                onChange: () => toggleBatchNode(index, node.nodeId),
              }),
              h('span', { className: 'sa-assist-batch-name' }, node.nodeName),
              h('span', { className: 'sa-muted' }, `${node.fromLabel} → ${action.toLabel}`),
            )),
            nodes.length > visible.length
              ? h('div', { className: 'sa-muted' }, `… 共 ${nodes.length} 个（点「展开全部」看完整清单）`)
              : null,
            nodes.length > 5
              ? h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  onClick: () => toggleBatchExpand(index),
                }, expanded ? '收起清单' : `展开全部 ${nodes.length} 个`)
              : null,
          ),
          h('div', { className: 'sa-assist-batch-actions' },
            h('span', { className: 'sa-muted' },
              item.actionState === 'pending'
                ? '这一步还没落库'
                : item.actionState === 'done' ? '已落库' : '已取消'),
            h('button', {
              className: 'sa-btn primary',
              type: 'button',
              disabled: busy || item.actionState !== 'pending' || selected.length === 0,
              onClick: () => confirmMasteryBatch(index),
            }, selected.length === 0 ? '确认修改（未选）' : `确认修改（${selected.length} 个）`),
            h('button', {
              className: 'sa-btn',
              type: 'button',
              disabled: busy || item.actionState !== 'pending',
              onClick: () => cancelMastery(index),
            }, '取消'),
          ),
        );
      };

      /** 会话切换条（收起列表时）：当前会话标题 + 条数。没有 conversationId 就是「新会话」。 */
      const renderSessionBarCurrent = () => {
        const current = conversationId === ''
          ? null
          : sessions.find((item) => item.id === conversationId) ?? null;
        const title = current !== null ? current.title : (messages.length === 0 ? '新会话' : '当前会话');
        return h('div', { className: 'sa-asst-sessions', 'data-sa-focus-bar': true },
          h('span', { className: 'sa-asst-cur' },
            title,
            current !== null && current.messageCount > 0
              ? h('span', { className: 'sa-asst-cur-sub' }, ` · ${current.messageCount} 条`)
              : null,
          ),
          sessionError !== ''
            ? h('span', { className: 'sa-muted', style: { color: 'var(--dsw-alias-state-error-primary)' } }, sessionError)
            : null,
        );
      };

      /**
       * 会话列表（展开时）：全局列表（不按主界面页签分）。
       * 每行可点开、改名（titleCustom）、归档/取消归档；归档项只在 includeArchived 时出现。
       */
      const renderSessionList = () => {
        const rows = sessions.map((item) => {
          const renaming = renamingId === item.id;
          return h('div', {
            key: `sa-focus-session-${item.id}`,
            className: 'sa-asst-item',
            'data-active': item.id === conversationId,
            'data-archived': item.archived === true,
          },
            renaming
              ? h('span', { className: 'sa-asst-rename' },
                  h('input', {
                    type: 'text',
                    value: renameDraft,
                    autoFocus: true,
                    'aria-label': '会话新标题',
                    onChange: (event) => setRenameDraft(String(event?.target?.value ?? '')),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitRename(item.id); }
                      else if (event.key === 'Escape') { setRenamingId(''); setRenameDraft(''); }
                    },
                  }),
                  h('button', { className: 'sa-btn primary', type: 'button', onClick: () => commitRename(item.id) }, '存'),
                  h('button', { className: 'sa-btn', type: 'button', onClick: () => { setRenamingId(''); setRenameDraft(''); } }, '取消'),
                )
              : h('span', {
                  className: 'sa-asst-item-title',
                  title: '点开这条会话',
                  onClick: () => openSession(item.id),
                }, item.title),
            renaming
              ? null
              : h('span', { className: 'sa-asst-item-meta' }, `${item.messageCount} 条`),
            renaming
              ? null
              : h('span', { className: 'sa-asst-item-acts' },
                  h('button', {
                    className: 'sa-btn', type: 'button', title: '改名',
                    onClick: (event) => { event.stopPropagation(); setRenamingId(item.id); setRenameDraft(item.title); },
                  }, '改名'),
                  item.archived === true
                    ? h('button', {
                        className: 'sa-btn', type: 'button', title: '取消归档，放回列表',
                        onClick: (event) => { event.stopPropagation(); toggleArchive(item.id, false); },
                      }, '取消归档')
                    : h('button', {
                        className: 'sa-btn', type: 'button', title: '归档（只隐藏，不删磁盘，可切回）',
                        onClick: (event) => { event.stopPropagation(); toggleArchive(item.id, true); },
                      }, '归档'),
                ),
          );
        });
        return h('div', { className: 'sa-asst-list', 'data-sa-focus-list': true },
          h('div', { className: 'sa-asst-list-foot' },
            h('button', { className: 'sa-btn', type: 'button', onClick: startNewSession }, '＋ 新会话'),
            h('label', { style: { marginLeft: 'auto', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: includeArchived,
                onChange: (event) => setIncludeArchived(event?.target?.checked === true),
                style: { marginRight: '4px' },
              }),
              '显示已归档',
            ),
          ),
          rows.length === 0
            ? h('div', { className: 'sa-asst-list-empty' }, '还没有会话，发一句话就会自动建一条。')
            : rows,
          sessionError !== ''
            ? h('div', { className: 'sa-asst-list-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, sessionError)
            : null,
        );
      };

      return h('div', { className: 'sa-focus-chat-inner', 'data-sa-focus-chat-inner': true },
        h('div', { className: 'sa-focus-chat-head' },
          h('strong', null, '学习助手'),
          // 收起按钮在头部右侧：头顶已经让出宿主顶栏（--sa-focus-chat-top），点得到
          h('button', {
            type: 'button',
            className: 'sa-btn',
            'data-sa-hide': 'right',
            'aria-label': '隐藏右栏',
            title: '隐藏右栏（隐藏后点右侧浮标恢复）',
            onClick: () => onHide(),
          }, '收起 ⟩'),
        ),
        h('div', { className: 'sa-focus-chat-tools' },
          h('select', {
            className: 'sa-input sa-focus-chat-model',
            'aria-label': '选择模型',
            title: '选这次对话用的模型（选项来自网关的模型清单）',
            'data-sa-chat-model': true,
            value: model,
            disabled: busy,
            onChange: (event) => setModel(String(event?.target?.value ?? FOCUS_CHAT_MODEL_DEFAULT)),
          }, models.map((item) => h('option', { key: `sa-focus-model-${item.id}`, value: item.id }, item.id))),
          h('button', {
            type: 'button', className: 'sa-btn', title: '新会话', 'aria-label': '新会话',
            'data-sa-chat': 'new', onClick: startNewSession,
          }, '＋'),
          h('button', {
            type: 'button', className: 'sa-btn', title: '我的会话', 'aria-label': '我的会话',
            'aria-expanded': sessionsShown === true, 'data-sa-chat': 'sessions',
            onClick: () => setSessionsShown((value) => value !== true),
          }, '会话'),
        ),
        modelsNote !== '' ? h('div', { className: 'sa-focus-chat-note', role: 'status' }, modelsNote) : null,
        sessionsShown ? renderSessionList() : renderSessionBarCurrent(),
        h('div', {
          className: 'sa-focus-chat-log',
          ref: logRef,
          role: 'log',
          'aria-live': 'polite',
          'data-sa-focus-chat-log': true,
        },
          hasSummary
            ? h('div', { className: 'sa-focus-chat-note', 'data-sa-focus-summary': true }, '（更早的对话已摘要）')
            : null,
          messages.length === 0 && busy !== true
            ? h('div', { className: 'sa-focus-chat-note' },
                '把要问的题目、看不懂的段落或课件文字贴进来，我给出解答。对话会存进「会话」，随时切回。')
            : messages.map((item, index) => h('div', {
                key: `sa-focus-msg-${index}`,
                className: `sa-focus-chat-msg ${item.role === 'user' ? 'user' : 'assistant'}`,
              },
                h('div', { className: 'sa-focus-chat-who' }, item.role === 'user' ? '我' : '助手'),
                // 助手回复走渲染器（Markdown/公式不再裸露）；用户自己的话保持纯文本
                h('div', { className: 'sa-focus-chat-bubble' }, item.role === 'user'
                  ? item.content
                  : renderAssistantText(item.content, `sa-focus-${index}`)),
                item.action !== null && item.action !== undefined
                  ? item.action.kind === 'set-mastery-batch'
                    ? renderBatchProposal(item, index)
                    : h('div', {
                        className: 'sa-assist-proposal',
                        'data-resolved': item.actionState === 'pending' ? 'false' : 'true',
                        key: `sa-focus-action-${index}`,
                      },
                        h('span', { className: 'sa-muted' },
                          item.actionState === 'pending'
                            ? '这一步还没落库'
                            : item.actionState === 'done' ? '已落库' : '已取消'),
                        h('button', {
                          className: 'sa-btn primary',
                          type: 'button',
                          disabled: busy || item.actionState !== 'pending',
                          onClick: () => confirmMastery(index),
                        }, '确认修改'),
                        h('button', {
                          className: 'sa-btn',
                          type: 'button',
                          disabled: busy || item.actionState !== 'pending',
                          onClick: () => cancelMastery(index),
                        }, '取消'),
                      )
                  : null,
              )),
          busy
            ? h('div', { className: 'sa-focus-chat-msg assistant' },
                h('div', { className: 'sa-focus-chat-who' }, '助手'),
                h('div', { className: 'sa-focus-chat-bubble sa-muted' },
                  h('span', { className: 'sa-spinner', 'aria-hidden': true }),
                  '思考中…',
                ),
              )
            : null,
        ),
        failure !== ''
          ? h('div', { className: 'sa-focus-chat-note', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `出错了：${failure}`)
          : null,
        h('div', { className: 'sa-focus-chat-compose' },
          h('textarea', {
            className: 'sa-input sa-focus-chat-input',
            value: draft,
            rows: 3,
            placeholder: '粘贴要问的文本…（Enter 发送，Shift+Enter 换行）',
            'aria-label': '向学习助手提问',
            disabled: busy,
            onChange: (event) => setDraft(String(event?.target?.value ?? '')),
            onKeyDown,
          }),
          h('div', { className: 'sa-focus-chat-actions' },
            h('span', { className: 'sa-focus-chat-note' }, 'Enter 发送 · Shift+Enter 换行'),
            h('button', {
              className: 'sa-btn primary',
              type: 'button',
              disabled: busy || draft.trim() === '',
              onClick: send,
            }, busy ? '思考中…' : '发送'),
          ),
        ),
      );
    }

    /**
     * 学习助手浮层头部的图标（v2-D 卡，2026-11-22）。
     *
     * **零依赖**：手写 SVG，不引图标库（引库要么整库内联撞 EDR，要么多一个 npm 依赖）。
     * 颜色一律 `currentColor`，尺寸由 CSS 的 `.sa-assist-head .sa-btn svg` 统一收口；
     * `aria-hidden` 让读屏只念按钮的 `aria-label`，不会把图标再念一遍。
     */
    function AssistHeadIcon(props = {}) {
      const name = props?.name;
      const size = Number(props?.size) || 16;
      const common = {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      };
      if (name === 'plus') {
        return h('svg', common, h('path', { d: 'M12 5v14' }), h('path', { d: 'M5 12h14' }));
      }
      if (name === 'list') {
        return h('svg', common,
          h('path', { d: 'M4 6h16' }),
          h('path', { d: 'M4 12h16' }),
          h('path', { d: 'M4 18h16' }),
        );
      }
      // v2-G（2026-11-22）：深浅主题按钮的两个图标。都是手写路径，风格与上面两个一致
      // （同一 viewBox / stroke / 1.8 线宽），不引入任何图标库。
      // moon = 月牙（浅色面板显示，点一下转深色）；sun = 太阳（深色面板显示，点一下转浅色）。
      if (name === 'moon') {
        return h('svg', common,
          h('path', { d: 'M20.3 14.6a8.3 8.3 0 1 1-9.6-11.1 6.7 6.7 0 0 0 9.6 11.1z' }),
        );
      }
      if (name === 'sun') {
        return h('svg', common,
          h('circle', { cx: 12, cy: 12, r: 4.1 }),
          h('path', { d: 'M12 2.7v2.4' }),
          h('path', { d: 'M12 18.9v2.4' }),
          h('path', { d: 'M2.7 12h2.4' }),
          h('path', { d: 'M18.9 12h2.4' }),
          h('path', { d: 'M5.6 5.6l1.7 1.7' }),
          h('path', { d: 'M16.7 16.7l1.7 1.7' }),
          h('path', { d: 'M18.4 5.6l-1.7 1.7' }),
          h('path', { d: 'M7.3 16.7l-1.7 1.7' }),
        );
      }
      // 缺省：向下箭头（收起）
      return h('svg', common, h('path', { d: 'M5.5 8.5l6.5 6.5 6.5-6.5' }));
    }

    /**
     * 学习助手浮层（MVP）。
     *
     * 形态与边界（原卡第 ⑥/② 节）：
     *   - 只渲染在 `.sa-root` 内部，定位用 `position:absolute`（不是 fixed，不盖 DSH 顶栏）；
     *   - 一个纯 CSS 圆按钮（无 emoji、无图片），点开 320–380px 的聊天面板，再点收起；
     *   - 多轮对话：前端维护整段 `messages`，每次把**全量历史**发给后端；
     *   - **不落盘**：对话只在这个组件的 state 里，刷新/关掉面板即消失；
     *   - 发送中禁用输入与按钮，按钮文案变「思考中…」；失败只显示可读的中文错误。
     *
     * 为什么把状态放在这里而不是模块级全局：关掉面板、刷新页面都自然清空，
     * 也避免两处渲染（主面板 / 右侧栏）共享一份对话而互相串味。
     */
    function AssistantOverlay(props = {}) {
      // 页签与标题查询都由 MainPanel 传进来：前者是 React state（比模块记忆更即时），
      // 后者在发送那一刻按 id 查现成知识网络数据（拿不到标题就只带 id）。
      const panelTab = typeof props.tab === 'string' && props.tab !== '' ? props.tab : navTabMemory;
      const getKnowledgeTitle = props.getKnowledgeTitle;
      const [open, setOpen] = useState(false);
      const [draft, setDraft] = useState('');
      const [messages, setMessages] = useState([]);
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState('');
      const logRef = useRef(null);

      // v2-C（2026-11-21）多会话：一个全局会话列表，与主界面 4 大页签无关。
      // conversationId 带进 /assistant/reply 才会落盘；不带则维持 MVP「不落盘」。
      const [conversationId, setConversationId] = useState('');
      const [sessions, setSessions] = useState([]);
      const [sessionsShown, setSessionsShown] = useState(false);
      const [includeArchived, setIncludeArchived] = useState(false);
      const [renamingId, setRenamingId] = useState('');
      const [renameDraft, setRenameDraft] = useState('');
      const [sessionError, setSessionError] = useState('');
      const [hasSummary, setHasSummary] = useState(false);

      // v2-G（2026-11-22）：面板自己一套深浅主题 + 用户拖过的大小。
      // 初值都从模块记忆里取（关掉再打开、切页签重挂载，仍是上次那套），改完立刻写回。
      const [theme, setTheme] = useState(() => assistThemeMemory);
      const [size, setSize] = useState(() => ({ w: assistSizeMemory.w, h: assistSizeMemory.h }));
      const panelRef = useRef(null);
      const resizeStopRef = useRef(null);

      /** 深/浅切换：先写模块记忆再改 state。按钮纯图标（月亮=转深色 / 太阳=转浅色）。 */
      const toggleTheme = () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        assistThemeMemory = next;
        setTheme(next);
      };

      /** 摘掉拖拽期间挂在 document 上的两个监听（松手/卸载都走这里，防止 mousemove 泄漏）。 */
      const stopResize = () => {
        if (typeof resizeStopRef.current !== 'function') return;
        const cleanup = resizeStopRef.current;
        resizeStopRef.current = null;
        cleanup();
      };

      // 组件卸载（收起面板、切页签）时必须清监听：否则拖到一半卸载会留下悬空的 mousemove。
      useEffect(() => () => { stopResize(); }, []);

      /**
       * 左上角手柄按下：记起点 + 当前尺寸，挂 document 的 mousemove/mouseup。
       * 面板是右下角对齐的（.sa-assist 的 align-items/justify-content:flex-end），
       * 手柄却挪到了左上角，所以**往左拖 = 变宽、往上拖 = 变高**：
       * newW = startW - dx，newH = startH - dy。右下角当锚点，放大不会把面板顶出边界。
       * 上限按父容器实测：宽扣左右 padding 28px，高再扣上下 padding 与底部 38px 圆按钮 + 10px gap
       * （合计 76px），不把 .sa-root 撑破；拿不到父容器就退回保守值，CSS 的 max/min 还会再兜一层。
       */
      const startResize = (event) => {
        if (event === null || event === undefined) return;
        if (Number(event.button) > 0) return;
        const panel = panelRef.current;
        if (!panel || typeof document === 'undefined') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        const startX = Number(event.clientX) || 0;
        const startY = Number(event.clientY) || 0;
        const rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
        const startW = rect !== null && rect.width > 0 ? rect.width : size.w;
        const startH = rect !== null && rect.height > 0 ? rect.height : size.h;
        const boxEl = panel.parentElement;
        const box = boxEl && typeof boxEl.getBoundingClientRect === 'function' ? boxEl.getBoundingClientRect() : null;
        const maxW = box !== null && box.width > 0 ? box.width - 28 : 640;
        const maxH = box !== null && box.height > 0 ? box.height - 76 : 760;
        const onMove = (ev) => {
          const dx = (Number(ev?.clientX) || 0) - startX;
          const dy = (Number(ev?.clientY) || 0) - startY;
          const next = {
            w: clampAssistSize(startW - dx, ASSIST_SIZE_MIN.w, maxW),
            h: clampAssistSize(startH - dy, ASSIST_SIZE_MIN.h, maxH),
          };
          assistSizeMemory = next;
          setSize(next);
        };
        const onUp = () => {
          // 松手时尺寸已经逐帧写进 assistSizeMemory 了，这里只负责摘监听。
          stopResize();
        };
        stopResize();
        resizeStopRef.current = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      /** 拉一次会话列表（归档是否一起列由 includeArchived 决定）。只读，失败只提示不打断。 */
      const refreshSessions = (withArchived) => {
        const flag = withArchived === true;
        fetch(`${API}/assistant/session/list${flag ? '?includeArchived=1' : ''}`)
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) return;
            setSessions(Array.isArray(result.sessions) ? result.sessions : []);
          })
          .catch(() => { /* 列表拉不到不影响问答 */ });
      };

      /** 展开面板时把会话列表拉一次（只拉一次，opening 后不重复抖动）。 */
      useEffect(() => {
        if (open !== true) return;
        refreshSessions(includeArchived);
      }, [open, includeArchived]);

      /** 新开会话：清空本地对话并置空 conversationId（下一次发送会新建一条落盘会话）。 */
      const startNewSession = () => {
        setConversationId('');
        setMessages([]);
        setDraft('');
        setFailure('');
        setSessionError('');
        setHasSummary(false);
      };

      /** 切到某个历史会话：从磁盘读回全文（含 summary 提示），并置 conversationId。 */
      const openSession = (id) => {
        if (busy) return;
        const sid = String(id ?? '').trim();
        if (sid === '') return;
        fetch(`${API}/assistant/session/get?id=${encodeURIComponent(sid)}`)
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true || result.session === undefined) {
              throw new Error('会话读不出来，可能已损坏。');
            }
            return result.session;
          })
          .then((session) => {
            const list = Array.isArray(session.messages) ? session.messages : [];
            setMessages(list.map((item) => ({
              role: item.role === 'user' ? 'user' : 'assistant',
              content: typeof item.content === 'string' ? item.content : '',
              action: item.action !== null && typeof item.action === 'object' ? item.action : null,
              actionState: null,
              batchSelected: null,
              batchExpanded: false,
            })));
            // 摘要行：有 summary 就在最前面插一条不可编辑的说明行（④ 拍板：显示小字「更早的对话已摘要」）
            setHasSummary(typeof session.summary === 'string' && session.summary.trim() !== '');
            setConversationId(sid);
            setSessionsShown(false);
            setSessionError('');
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      /** 改名：置 titleCustom=true（服务端拍板），成功后就地更新列表条目。 */
      const commitRename = (id) => {
        const sid = String(id ?? '').trim();
        const title = renameDraft.trim();
        if (sid === '' || title === '') { setRenamingId(''); return; }
        fetch(`${API}/assistant/session/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ id: sid, title }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) throw new Error('改名没成功，稍后再试。');
            return result;
          })
          .then(() => {
            setRenamingId('');
            setRenameDraft('');
            refreshSessions(includeArchived);
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      /** 归档 / 取消归档：只改标记位（服务端不删磁盘），成功后刷新列表。 */
      const toggleArchive = (id, archived) => {
        const sid = String(id ?? '').trim();
        if (sid === '') return;
        fetch(`${API}/assistant/session/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ id: sid, archived: archived === true }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null || result.ok !== true) throw new Error('操作没成功，稍后再试。');
            return result;
          })
          .then(() => {
            // 归档了当前正在看的会话 → 切回「新会话」，避免显示已藏起来的会话
            if (archived === true && sid === conversationId) {
              setConversationId('');
              setMessages([]);
            }
            refreshSessions(includeArchived);
          })
          .catch((error) => setSessionError(String(error?.message ?? error)));
      };

      // 新消息进来 / 展开面板 / 从「思考中」回到回答时，把对话区滚到底。
      // 假 DOM 里没有 scrollHeight 数字，直接跳过，别让整页挂掉。
      useEffect(() => {
        const el = logRef.current;
        if (el === null || el === undefined || typeof el.scrollHeight !== 'number') return;
        el.scrollTop = el.scrollHeight;
      }, [messages, busy, open]);

      /**
       * 发一次问答。
       *
       * 先把用户这句追加进对话再发请求（失败时用户仍能看到自己问了什么），
       * 成功后把助手回复追加进同一条对话；**失败不自动重发**，避免一次手滑
       * 变成重复扣额度。
       */
      const send = () => {
        if (busy) return;
        const text = draft.trim();
        if (text === '') return;
        const history = messages.concat([{ role: 'user', content: text }]);
        setMessages(history);
        setDraft('');
        setFailure('');
        setBusy(true);
        // v2-A（A1 隐式）：多带一个 context 给后端拼 system，界面与回复都不显式说破。
        // 取不到就是空对象，后端归一为空串、不会多出 system —— 与 MVP 行为一致。
        const context = buildAssistantContext(panelTab, getKnowledgeTitle);
        const payload = { messages: history.map((item) => ({ role: item.role, content: item.content })) };
        if (Object.keys(context).length > 0) payload.context = context;
        // v2-C：带上 conversationId 才落盘。没有就先建一条空会话（拿到 id 再发），
        // 这样首条消息发送时后端就有会话可追加 + 自动命名。
        const ensureSession = conversationId !== ''
          ? Promise.resolve(conversationId)
          : fetch(`${API}/assistant/session/new`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify({}),
            })
              .then(async (response) => {
                const result = await response.json().catch(() => null);
                if (result === null || result.ok !== true || result.session === undefined) {
                  throw new Error('新建会话没成功，稍后再试。');
                }
                return String(result.session.id);
              });
        ensureSession
          .then((sid) => {
            setConversationId(sid);
            payload.conversationId = sid;
            return fetch(`${API}/assistant/reply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify(payload),
            });
          })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            const reply = typeof result.reply === 'string' ? result.reply : '';
            if (reply.trim() === '') throw new Error('助手没有返回内容，稍后再试。');
            // v2-B 卡（2026-11-20）：后端可能回一条「改掌握度的预览」。
            // **这里只是把它显示成一行待确认的按钮，一个字节都没落库**；
            // 落库要等用户点「确认修改」→ confirmMastery 再发第二个请求。
            // v2-B2（2026-11-21）：范围批量用另一个 kind（`set-mastery-batch`），
            // 预览里带一整个清单 → 界面渲染成可勾选列表，默认全选（用户 m00484 拍板「不限条数」）。
            const proposal = result.proposedAction !== null && typeof result.proposedAction === 'object'
              && (result.proposedAction.kind === 'set-mastery' || result.proposedAction.kind === 'set-mastery-batch')
              ? result.proposedAction
              : null;
            const batch = proposal !== null && proposal.kind === 'set-mastery-batch' ? proposal : null;
            setMessages((current) => current.concat([{
              role: 'assistant',
              content: reply,
              action: proposal,
              actionState: proposal === null ? null : 'pending',
              // 批量清单的勾选状态放在这条消息里：关掉面板/刷新即消失，与对话自身的生命周期一致
              batchSelected: batch === null ? null : (Array.isArray(batch.nodes) ? batch.nodes.map((item) => item.nodeId) : []),
              batchExpanded: false,
            }]));
            // 会话已落盘/更新：刷新列表（首条消息后标题也会变成自动命名）
            refreshSessions(includeArchived);
          })
          .catch((error) => {
            setFailure(String(error?.message ?? error));
          })
          .finally(() => setBusy(false));
      };

      /**
       * 确认落库（v2-B 卡）：这是**第二次请求**，与上面的预览严格分开。
       *
       * 服务端没有 `confirm: true` 就 400 `confirm-required`，所以这里显式带上 ——
       * 「预览与落库不能合并成一次」这条红线在两端各有一道锁。
       */
      const confirmMastery = (index) => {
        if (busy) return;
        const message = messages[index];
        const action = message !== null && message !== undefined ? message.action : null;
        if (!action || message.actionState !== 'pending') return;
        setBusy(true);
        setFailure('');
        fetch(`${API}/assistant/mastery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({ nodeId: action.nodeId, mastery: action.to, confirm: true }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            // 落库成功：这条预览的按钮置灰收起，再追一条回执（说清到底改没改）
            const receipt = result.changed === true
              ? `已更新「${action.nodeName}」为 ${action.toLabel}。`
              : `「${action.nodeName}」本来就是 ${action.toLabel}，等级没动；已记下这是你定的。`;
            setMessages((current) => current
              .map((item, at) => (at === index ? { ...item, actionState: 'done' } : item))
              .concat([{ role: 'assistant', content: receipt, action: null, actionState: null }]));
            // 知识网络的显示要跟着变（面板上的掌握度徽标、章节统计都读同一份数据）
            if (typeof props.onMasteryChanged === 'function') {
              try { props.onMasteryChanged(); } catch { /* 刷新失败不影响回执 */ }
            }
          })
          .catch((error) => {
            setFailure(String(error?.message ?? error));
          })
          .finally(() => setBusy(false));
      };

      /** 取消：什么都不改（连请求都不发），只把这条预览收起并说明一句。 */
      const cancelMastery = (index) => {
        setMessages((current) => current
          .map((item, at) => (at === index ? { ...item, actionState: 'cancelled' } : item))
          .concat([{ role: 'assistant', content: '好，这次没改。', action: null, actionState: null }]));
      };

      /**
       * 批量失败原因 → 一句人话。
       *
       * 只翻**错误码**，不回显服务端的 detail：与 `assistantFailureText` 同一条纪律，
       * 界面上的字必须是我们自己写得出来的（别把响应体原样倒给用户）。
       */
      const describeBatchFailures = (failures) => {
        const list = Array.isArray(failures) ? failures : [];
        const reasons = [...new Set(list.map((item) => String(item?.reason ?? '')))].filter((item) => item !== '');
        const text = reasons.map((reason) => ({
          'unknown-node': '知识点已不在网络里',
          'bad-mastery': '等级不合法',
          'bad-node-id': '知识点 id 不合法',
          'bad-item': '清单条目损坏',
        }[reason] ?? '原因未知')).join('、');
        return text === '' ? '原因未知' : text;
      };

      /** 勾/取消清单里的一个节点（只改本地状态，**不发请求**）。 */
      const toggleBatchNode = (index, nodeId) => {
        setMessages((current) => current.map((item, at) => {
          if (at !== index) return item;
          const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
          const next = selected.includes(nodeId)
            ? selected.filter((id) => id !== nodeId)
            : selected.concat([nodeId]);
          return { ...item, batchSelected: next };
        }));
      };

      /** 全选 / 全不选（只改本地状态，**不发请求**）。 */
      const toggleBatchAll = (index) => {
        setMessages((current) => current.map((item, at) => {
          if (at !== index) return item;
          const nodes = Array.isArray(item.action?.nodes) ? item.action.nodes : [];
          const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
          const allOn = nodes.length > 0 && selected.length === nodes.length;
          return { ...item, batchSelected: allOn ? [] : nodes.map((node) => node.nodeId) };
        }));
      };

      /** 展开/收起清单（默认只渲染前 5 个 + 「… 共 N 个」）。 */
      const toggleBatchExpand = (index) => {
        setMessages((current) => current.map((item, at) => (
          at === index ? { ...item, batchExpanded: item.batchExpanded !== true } : item
        )));
      };

      /**
       * 批量确认落库（v2-B2 卡）：与 `confirmMastery` 是同一套两步走，只是**一批只发一个请求**。
       *
       * 只带**当前勾选**的 nodeId（清单里取消勾选的那几个这次就不改），动作等级统一用预览里的
       * `action.level`。回执如实写「改了 M 个 / 失败 K 个」，并说明已有几个本来就是这个等级。
       */
      const confirmMasteryBatch = (index) => {
        if (busy) return;
        const message = messages[index];
        const action = message !== null && message !== undefined ? message.action : null;
        if (!action || message.actionState !== 'pending') return;
        const selected = Array.isArray(message.batchSelected) ? message.batchSelected : [];
        if (selected.length === 0) return;
        setBusy(true);
        setFailure('');
        fetch(`${API}/assistant/mastery-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [REQUEST_HEADER]: '1' },
          body: JSON.stringify({
            items: selected.map((nodeId) => ({ nodeId, mastery: action.level })),
            confirm: true,
          }),
        })
          .then(async (response) => {
            const result = await response.json().catch(() => null);
            if (result === null) throw nonJsonError(response);
            if (result.ok !== true) throw new Error(assistantFailureText(result, response.status));
            return result;
          })
          .then((result) => {
            const changed = Number.isFinite(result.changed) ? result.changed : 0;
            const skipped = Number.isFinite(result.skipped) ? result.skipped : 0;
            const failed = Number.isFinite(result.failed) ? result.failed : 0;
            let receipt = `已把 ${changed} 个知识点更新为 ${action.toLabel}`;
            if (skipped > 0) receipt += `（另有 ${skipped} 个本来就是 ${action.toLabel}，等级没动）`;
            if (failed > 0) receipt += `；${failed} 个没改成（${describeBatchFailures(result.failures)}）`;
            receipt += '。';
            setMessages((current) => current
              .map((item, at) => (at === index ? { ...item, actionState: 'done' } : item))
              .concat([{ role: 'assistant', content: receipt, action: null, actionState: null }]));
            // 知识网络的显示要跟着变（面板上的掌握度徽标、章节统计都读同一份数据）
            if (typeof props.onMasteryChanged === 'function') {
              try { props.onMasteryChanged(); } catch { /* 刷新失败不影响回执 */ }
            }
          })
          .catch((error) => {
            setFailure(String(error?.message ?? error));
          })
          .finally(() => setBusy(false));
      };

      const clear = () => {
        setMessages([]);
        setDraft('');
        setFailure('');
      };

      const onKeyDown = (event) => {
        // 输入法组合中的 Enter 是「选词」，不是发送
        if (event?.nativeEvent?.isComposing === true || event?.isComposing === true) return;
        if (event?.key !== 'Enter' || event?.shiftKey === true) return;
        event.preventDefault();
        send();
      };

      /**
       * 批量清单的渲染（v2-B2 卡）：可勾选、可全选、超过 5 个折成「… 共 N 个」。
       *
       * 默认只渲染前 5 个（用户 m00484 拍板）；后端**不截断**数组（他明确不接受上限），
       * 所以这里只是「显示折叠」，点「展开全部」能看到整批。
       * 状态文案与单点预览同口径：只说 pending/done/cancelled，不替用户下结论。
       */
      const renderBatchProposal = (item, index) => {
        const action = item.action;
        const nodes = Array.isArray(action?.nodes) ? action.nodes : [];
        const selected = Array.isArray(item.batchSelected) ? item.batchSelected : [];
        const expanded = item.batchExpanded === true;
        const pending = item.actionState === 'pending';
        const visible = expanded ? nodes : nodes.slice(0, 5);
        const allOn = nodes.length > 0 && selected.length === nodes.length;
        return h('div', {
          className: 'sa-assist-proposal sa-assist-proposal-batch',
          'data-resolved': pending ? 'false' : 'true',
          'data-sa-batch': true,
        },
          h('div', { className: 'sa-assist-batch-head' },
            h('span', { className: 'sa-muted' },
              `待改 ${nodes.length} 个 · 已选 ${selected.length} 个${action.skipped > 0 ? ` · ${action.skipped} 个已是「${action.toLabel}」，会跳过` : ''}`),
            h('button', {
              className: 'sa-btn',
              type: 'button',
              disabled: !pending || nodes.length === 0,
              onClick: () => toggleBatchAll(index),
            }, allOn ? '全不选' : '全选'),
          ),
          h('div', { className: 'sa-assist-batch-list' },
            visible.map((node) => h('label', {
              key: `sa-batch-${node.nodeId}`,
              className: 'sa-assist-batch-row',
            },
              h('input', {
                type: 'checkbox',
                className: 'sa-batch-selected',
                checked: selected.includes(node.nodeId),
                disabled: !pending,
                onChange: () => toggleBatchNode(index, node.nodeId),
              }),
              h('span', { className: 'sa-assist-batch-name' }, node.nodeName),
              h('span', { className: 'sa-muted' }, `${node.fromLabel} → ${action.toLabel}`),
            )),
            nodes.length > visible.length
              ? h('div', { className: 'sa-muted' }, `… 共 ${nodes.length} 个（点「展开全部」看完整清单）`)
              : null,
            nodes.length > 5
              ? h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  onClick: () => toggleBatchExpand(index),
                }, expanded ? '收起清单' : `展开全部 ${nodes.length} 个`)
              : null,
          ),
          h('div', { className: 'sa-assist-batch-actions' },
            h('span', { className: 'sa-muted' },
              item.actionState === 'pending'
                ? '这一步还没落库'
                : item.actionState === 'done' ? '已落库' : '已取消'),
            h('button', {
              className: 'sa-btn primary',
              type: 'button',
              disabled: busy || item.actionState !== 'pending' || selected.length === 0,
              onClick: () => confirmMasteryBatch(index),
            }, selected.length === 0 ? '确认修改（未选）' : `确认修改（${selected.length} 个）`),
            h('button', {
              className: 'sa-btn',
              type: 'button',
              disabled: busy || item.actionState !== 'pending',
              onClick: () => cancelMastery(index),
            }, '取消'),
          ),
        );
      };

      /**
       * 会话条（收起列表时）：显示当前会话标题 + 「我的会话」按钮在位（按钮在 head 里）。
       * 没有 conversationId 就是「新会话」。
       */
      const renderSessionBarCurrent = () => {
        const current = conversationId === ''
          ? null
          : sessions.find((item) => item.id === conversationId) ?? null;
        const title = current !== null ? current.title : (messages.length === 0 ? '新会话' : '当前会话');
        return h('div', { className: 'sa-asst-sessions', 'data-sa-asst-barbar': true },
          h('span', { className: 'sa-asst-cur' },
            title,
            current !== null && current.messageCount > 0
              ? h('span', { className: 'sa-asst-cur-sub' }, ` · ${current.messageCount} 条`)
              : null,
          ),
          sessionError !== ''
            ? h('span', { className: 'sa-muted', style: { color: 'var(--dsw-alias-state-error-primary)' } }, sessionError)
            : null,
        );
      };

      /**
       * 会话列表（展开时）：全局列表（不按主界面 4 大页签分）。
       * 每行可点开、改名（titleCustom）、归档/取消归档。归档项只在 includeArchived 时出现。
       */
      const renderSessionList = () => {
        const rows = sessions.map((item) => {
          const renaming = renamingId === item.id;
          return h('div', {
            key: `sa-asst-item-${item.id}`,
            className: 'sa-asst-item',
            'data-active': item.id === conversationId,
            'data-archived': item.archived === true,
          },
            renaming
              ? h('span', { className: 'sa-asst-rename' },
                  h('input', {
                    type: 'text',
                    value: renameDraft,
                    autoFocus: true,
                    'aria-label': '会话新标题',
                    onChange: (event) => setRenameDraft(String(event?.target?.value ?? '')),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitRename(item.id); }
                      else if (event.key === 'Escape') { setRenamingId(''); setRenameDraft(''); }
                    },
                  }),
                  h('button', { className: 'sa-btn primary', type: 'button', onClick: () => commitRename(item.id) }, '存'),
                  h('button', { className: 'sa-btn', type: 'button', onClick: () => { setRenamingId(''); setRenameDraft(''); } }, '取消'),
                )
              : h('span', {
                  className: 'sa-asst-item-title',
                  title: '点开这条会话',
                  onClick: () => openSession(item.id),
                }, item.title),
            renaming
              ? null
              : h('span', { className: 'sa-asst-item-meta' },
                  `${item.messageCount} 条`),
            renaming
              ? null
              : h('span', { className: 'sa-asst-item-acts' },
                  h('button', {
                    className: 'sa-btn', type: 'button', title: '改名',
                    onClick: (event) => { event.stopPropagation(); setRenamingId(item.id); setRenameDraft(item.title); },
                  }, '改名'),
                  item.archived === true
                    ? h('button', {
                        className: 'sa-btn', type: 'button', title: '取消归档，放回列表',
                        onClick: (event) => { event.stopPropagation(); toggleArchive(item.id, false); },
                      }, '取消归档')
                    : h('button', {
                        className: 'sa-btn', type: 'button', title: '归档（只隐藏，不删磁盘，可切回）',
                        onClick: (event) => { event.stopPropagation(); toggleArchive(item.id, true); },
                      }, '归档'),
                ),
          );
        });
        return h('div', { className: 'sa-asst-list', 'data-sa-asst-list': true },
          h('div', { className: 'sa-asst-list-foot' },
            h('button', { className: 'sa-btn', type: 'button', onClick: startNewSession }, '＋ 新会话'),
            h('label', { style: { marginLeft: 'auto', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: includeArchived,
                onChange: (event) => setIncludeArchived(event?.target?.checked === true),
                style: { marginRight: '4px' },
              }),
              '显示已归档',
            ),
          ),
          rows.length === 0
            ? h('div', { className: 'sa-asst-list-empty' }, '还没有会话，发一句话就会自动建一条。')
            : rows,
          sessionError !== ''
            ? h('div', { className: 'sa-asst-list-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, sessionError)
            : null,
        );
      };

      return h('div', { className: 'sa-assist' },
        open
          ? h('div', {
              className: 'sa-assist-panel',
              role: 'dialog',
              'aria-label': '学习助手',
              'data-sa-assist-panel': true,
              // v2-G：主题标记挂在面板根上，深色那一套 --sa-assist-* 由 CSS 按这个属性覆盖。
              'data-sa-assist-theme': theme,
              ref: panelRef,
              // 宽高由 state 给（拖拽改），CSS 里只留 min/max 兜底；这里不写任何颜色。
              style: { width: `${size.w}px`, height: `${size.h}px` },
            },
              h('div', { className: 'sa-assist-head' },
                h('strong', null, '学习助手'),
                h('span', { className: 'sa-assist-hint' }, '粘贴题目或段落直接问'),
                h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  title: '新会话',
                  'aria-label': '新会话',
                  onClick: startNewSession,
                }, h(AssistHeadIcon, { name: 'plus' })),
                h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  title: '我的会话',
                  'aria-label': '我的会话',
                  'aria-expanded': sessionsShown,
                  onClick: () => { setSessionsShown((v) => v !== true); },
                }, h(AssistHeadIcon, { name: 'list' })),
                h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  // v2-G：纯图标深浅切换（无文字）。浅色面板显示月亮=去深色，深色面板显示太阳=回浅色。
                  title: theme === 'dark' ? '切换浅色' : '切换深色',
                  'aria-label': theme === 'dark' ? '切换浅色' : '切换深色',
                  'data-sa-assist-theme-toggle': theme,
                  onClick: toggleTheme,
                }, h(AssistHeadIcon, { name: theme === 'dark' ? 'sun' : 'moon' })),
                h('button', {
                  className: 'sa-btn',
                  type: 'button',
                  title: '收起面板',
                  'aria-label': '收起面板',
                  onClick: () => setOpen(false),
                }, h(AssistHeadIcon, { name: 'chevron-down' })),
              ),
              // 会话切换条（v2-C）：全局列表 + 归档开关。归档的默认隐藏，点开关可切回。
              sessionsShown
                ? renderSessionList()
                : renderSessionBarCurrent(),
              h('div', {
                className: 'sa-assist-log',
                ref: logRef,
                role: 'log',
                'aria-live': 'polite',
                'data-sa-assist-log': true,
              },
                // 摘要行（④ 拍板）：这个会话的早期消息已被摘要，显示一行小字提示
                hasSummary
                  ? h('div', { className: 'sa-assist-summary-line', 'data-sa-asst-summary': true },
                      '（更早的对话已摘要）')
                  : null,
                messages.length === 0 && busy !== true
                  ? h('div', { className: 'sa-muted sa-assist-empty' },
                      '把要问的题目、看不懂的段落或课件文字贴进来，我给出解答。对话会存进「我的会话」，随时切回。')
                  : messages.map((item, index) => h('div', {
                      key: `sa-assist-${index}`,
                      className: `sa-assist-msg ${item.role === 'user' ? 'user' : 'assistant'}`,
                    },
                      h('div', { className: 'sa-assist-who' }, item.role === 'user' ? '我' : '助手'),
                      h('div', { className: 'sa-assist-bubble' }, item.role === 'user'
                        // v2-F（2026-11-22）：助手回复走渲染器（Markdown/公式不再裸露）；
                        // 用户自己的话**保持纯文本**：`mixedTextNodes` 会把落单的 `$` 整个剥掉
                        // （:8342-8343 为「截断留半个 $」设计），贴一段「价格 $5」「变量 $x」就会
                        // 少一个字符；渲染是给模型输出做的，不该改用户原话。
                        ? item.content
                        : renderAssistantText(item.content, `sa-assist-${index}`)),
                      // 改掌握度预览的确认行（v2-B 卡）：只有后端回了 proposedAction 才出现。
                      // 文案只说状态、不替用户下结论：pending=还没落库，done=已落库，cancelled=已取消。
                      // v2-B2（2026-11-21）：范围批量（`set-mastery-batch`）走可勾选清单那一套，
                      // 单点（`set-mastery`）仍是这一行按钮 —— 两种 kind 的确认接口也不同。
                      item.action !== null && item.action !== undefined
                        ? item.action.kind === 'set-mastery-batch'
                          ? renderBatchProposal(item, index)
                          : h('div', {
                              className: 'sa-assist-proposal',
                              'data-resolved': item.actionState === 'pending' ? 'false' : 'true',
                            },
                              h('span', { className: 'sa-muted' },
                                item.actionState === 'pending'
                                  ? '这一步还没落库'
                                  : item.actionState === 'done' ? '已落库' : '已取消'),
                              h('button', {
                                className: 'sa-btn primary',
                                type: 'button',
                                disabled: busy || item.actionState !== 'pending',
                                onClick: () => confirmMastery(index),
                              }, '确认修改'),
                              h('button', {
                                className: 'sa-btn',
                                type: 'button',
                                disabled: busy || item.actionState !== 'pending',
                                onClick: () => cancelMastery(index),
                              }, '取消'),
                            )
                        : null,
                    )),
                busy
                  ? h('div', { className: 'sa-assist-msg assistant' },
                      h('div', { className: 'sa-assist-who' }, '助手'),
                      h('div', { className: 'sa-assist-bubble sa-muted' },
                        h('span', { className: 'sa-spinner', 'aria-hidden': true }),
                        '思考中…',
                      ),
                    )
                  : null,
              ),
              failure !== ''
                ? h('div', { className: 'sa-assist-error', role: 'alert' }, `出错了：${failure}`)
                : null,
              h('div', { className: 'sa-assist-compose' },
                h('textarea', {
                  className: 'sa-input sa-assist-input',
                  value: draft,
                  rows: 3,
                  placeholder: '粘贴要问的文本…（Enter 发送，Shift+Enter 换行）',
                  'aria-label': '向学习助手提问',
                  disabled: busy,
                  onChange: (event) => setDraft(String(event?.target?.value ?? '')),
                  onKeyDown,
                }),
                h('div', { className: 'sa-assist-actions' },
                  h('span', { className: 'sa-muted' }, 'Enter 发送 · Shift+Enter 换行'),
                  h('button', {
                    className: 'sa-btn primary',
                    type: 'button',
                    disabled: busy || draft.trim() === '',
                    onClick: send,
                  }, busy ? '思考中…' : '发送'),
                ),
              ),
              // v2-G 补丁（2026-11-23）：左上角拖拽手柄。放在面板最外层、压住面板左上角（z-index:3），
              // 面板锚右下角，往左/上拖才在屏幕内变大；不带文字/图标语义（无障碍上当装饰元素处理）。
              h('div', {
                className: 'sa-assist-resize',
                onMouseDown: startResize,
                title: '拖动调整面板大小',
                'aria-hidden': true,
                'data-sa-assist-resize': true,
              }),
            )
          : null,
        // 块 C（2026-11-23 用户 m02542 反馈 4）：右下角那颗圆点入口（.sa-assist-fab）已删 ——
        // 学习助手只在专注阅读的三栏里出现（右栏真聊天，见 FocusChatPanel）。
        // 组件本体暂留不删，避免一大坨删除引入风险；确认无引用后由下一张卡处理。
      );
    }

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
        ['records', TEXT.tabs.records],
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
        body = h(TodayTab, { docs, now, refresh, busy, run, setBusy, onOpenKnowledgeReview, onOpenKnowledge, onOpenKnowledgeCoverage });
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
      } else if (tab === 'records') {
        body = h(RecordsTab, { key: `records-${navVersion}`, docs, refresh });
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
        // 块 C（2026-11-23）：右下角浮层挂载点已删 —— 学习助手搬进专注阅读三栏的右栏
        // （KnowledgeTab 里的 `h(FocusChatPanel, …)`）。`AssistantOverlay` 组件本体暂留，
        // 等确认无引用后随下一张卡一起清；现在这里**不再渲染任何浮层**。
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
    // 三栏探针（2026-11-23，可弃）：一个最小右栏 tab，只显示 HOST SLOT OK。
    // 它证明「本插件 client 侧能拿到 ctx.slots.register，并往 sidebar.right.pane.tab 注册可被派发的 tab」。
    const PROBE_TAB_ID = 'study-assistant/probe';
    const PROBE_TAB_KIND = 'studyProbe';

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

    /**
     * 三栏探针的右栏测试 tab。
     *
     * 存在的唯一理由：把「本插件能往宿主右栏注册 tab」这件事变成一眼可见的事实。
     * 内容刻意只有一行 HOST SLOT OK —— 不做产品界面，验证完即弃。
     */
    function ProbeRightTab() {
      return h('div', { className: 'sa-root', 'data-sa-probe-tab': 'true' },
        h(Style),
        h('div', { className: 'sa-body' },
          h('div', { className: 'sa-card' },
            h('h3', null, 'HOST SLOT OK'),
            h('div', { className: 'sa-muted' }, 'dsh-study-assistant 通过 ctx.slots.register 注册到了 sidebar.right.pane.tab。'),
            h('div', { className: 'sa-muted' }, '这一格只证明槽位能力可用，不是产品界面。'))));
    }

    function ProbeRightTabTitle() {
      return h('span', null, '探针');
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
      // 三栏探针（可弃）：测试据此断言 tab 类型的 id/kind 与槽位 key 一致。
      // 默认不注册（既有契约测试要求 sidebarRightTabs 只有一个类型）；开关见 enableHint。
      probeTab: { id: PROBE_TAB_ID, kind: PROBE_TAB_KIND, hostSlot: 'sidebar.right.pane.tab', defaultEnabled: false, enableHint: "localStorage.setItem('sa_probe_host_tab','1') 后重启 DSH" },
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
        // 三栏：栏宽夹取与边界常量交给测试，拖拽手感不必靠重启宿主才验得了。
        focusLayout: {
          clamp: clampFocusSize,
          railDefault: FOCUS_RAIL_DEFAULT,
          railMin: FOCUS_RAIL_MIN,
          railMax: FOCUS_RAIL_MAX,
          chatDefault: FOCUS_CHAT_DEFAULT,
          chatMin: FOCUS_CHAT_MIN,
          chatMax: FOCUS_CHAT_MAX,
          // 块 A：右栏顶部的让位高度（量不到回 48）
          clampChatTop: clampFocusChatTop,
          chatTopFallback: FOCUS_CHAT_TOP_FALLBACK,
          chatTopMax: FOCUS_CHAT_TOP_MAX,
          readHostTopInset,
        },
        // 块 D：右栏聊天里可测的那几块纯逻辑（下拉选项、会话消息归一、预览识别）
        focusChat: {
          modelDefault: FOCUS_CHAT_MODEL_DEFAULT,
          normalizeModels: normalizeChatModels,
          mapSessionMessages,
          pickProposal: pickAssistantProposal,
          panel: FocusChatPanel,
        },
        probeRightTab: ProbeRightTab,
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
        // 资料树（2026-10-30 W3b）：纯函数派生，测试直接验「从 path 目录段分组」「其他兜底」「不读新 schema 字段」
        buildMaterialsTree,
        materialFolderKey,
        materialMeta,
        materialKindLabel,
        materialBaseName,
        // 阅读面正文卡（2026-10-30 W3a）：资料页 / 知识点页共用
        materialReadingCard: MaterialReadingCard,
        // 今日页（2026-10-22 凌晨）：待复习知识点卡要能单独渲染
        todayTab: TodayTab,
        // 今日日程四分类（2026-11-19 A2 卡）：分类判定、覆盖表、版块组装、失败文案都是纯函数，
        // 测试直接拿它们验「关键词命中 / 兜底 / 覆盖优先 / 旧条目缺省 work」。
        classifyByKeyword,
        buildScheduleBoard,
        readCategoryOverrides,
        writeCategoryOverride,
        SCHEDULE_CATEGORIES,
        SCHEDULE_CATEGORY_LABEL,
        SCHEDULE_OVERRIDE_STORAGE_KEY,
        aiFailureText,
        materialText,
        // 正文缓存（2026-10-29 晚）：测试要能验「同一份资料第二次打开不再发请求」与缓存上限
        materialTextCached,
        peekMaterialText,
        MATERIAL_TEXT_CACHE,
        // 批注渲染计划（2026-10-30 B1）：纯函数，测试直接验 found/fuzzy/lost 三态与偏移刷新
        buildAnnotationRenderPlan,
        // 批注读取（2026-10-30 B1）：按 file 拉取 + 缓存 + 失效
        annotationsFor,
        peekAnnotations,
        invalidateAnnotations,
        // 批注渲染（2026-10-30 B1）：高亮切段、待处理列表、覆盖层组件
        annotationHighlightNodes,
        annotationPendingList,
        nextHighlightLabel,
        annotationLayer: AnnotationLayer,
        // 批注交互（2026-10-31 F2）：选区→锚点、气泡定位、正文内联标记、提交参数
        annotationQuoteHits,
        resolveAnnotationAnchor,
        resolveSelectionAnchor,
        placeAnnotationBubble,
        annotationRenderedText,
        annotationMarkOffsets,
        annotationMarkedNodes,
        annotationCreateItem,
        // AI 材料导出（2026-11-18 E1）：纯函数，测试直接验徽标/查询串/文本/下载退化
        annotationMarkBadge,
        aiExportQuery,
        aiExportText,
        // 行内格式（2026-11-17 D 卡）：语义键→CSS 白名单映射
        annotationStyleToCss,
        ANNOTATION_STYLE_PALETTE,
        annotationRenderedOffsetOfRange,
        annotationSelectionSnapshot,
        // 行内格式（2026-11-17 D 卡）：公式/表格区域判定
        annotationUnsupportedRegion,
        // 正文组件（2026-10-29 晚）：测试要断言「换正文时不卸载、旧正文还在」，
        // 但假 React 不会展开函数组件，只能从元素节点上看它拿到的 text
        materialReading: MaterialReading,
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
        // 教材页正文卡的排版预览（2026-10-27 晚）：跨行 `$$…$$`、`#` 标题、分隔线，
        // 其余交给 analysisBlockNodes；「排版 / 原文」两档由 MaterialReading 组件切换
        materialPreviewNodes,
        // 讲义按「节」切片（2026-11-17 C2）：学习模式上/下篇翻节用
        splitLectureSections,
        // 公式排版（2026-10-26 深夜）：LaTeX → 符号（上下标/分式/根号/希腊字母），
        // 保证界面上不再出现 `\Rightarrow` 这种源码
        latexNodes,
        plainMathToTex,
        plainMathNodes,
        plainMathLineNodes,
        mixedTextNodes,
        // 浮层气泡排版（v2-F，2026-11-22）：纯函数，测试直接验「**粗体** / 公式 / 列表」三种产出，
        // 不必靠重启宿主看气泡；组件里只多一次调用，渲染口径全在这个函数里。
        renderAssistantText,
        listNode,
        backtickNodes,
        MATH_INLINE_STYLE,
        latexRender,
        formulaCard,
        // 章节进度（2026-10-21 夜第三段）：四档分布 + 到熟练数，列表章头用它画小条
        chapterMasteryStats,
        // 知识点树（2026-10-21 夜批2）：学科→章→节→知识点，树视图与「全部展开」用它
        buildKnowledgeTree,
        knowledgeTreeBranchKeys,
        // 大纲树（2026-10-21 深夜批5）：教材目录骨架 + 节点按 section/subsection 挂靠
        buildOutlineTree,
        // 搜索命中高亮（2026-10-22 深夜）：树/列表共用同一套切法
        splitByQuery,
        // 思维导图（2026-10-23 夜，A 块）：布局纯函数 + 掌握度的符号/颜色编码
        buildMindMap,
        clampMindZoom,
        fitMindZoom,
        // 阅读区缩放（2026-10-30）：倍率夹取 + 「适应窗口」反算，测试直接验纯函数与按钮
        clampReadScale,
        fitReadScale,
        knowledgeTreeCourses,
        subjectTreeState,
        patchSubjectTree,
        MASTERY_STYLE,
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

        // 5) 三栏探针（2026-11-23，可弃）：第二个右栏 tab 类型 + 渲染体 + 标题。
        //    它的唯一作用是证明 B：本插件拿得到 ctx.slots.register，且注册的 tab 会被右栏派发。
        //    **默认关闭**：既有契约测试要求 sidebarRightTabs 只注册一个类型，且探针不该给产品
        //    多留一个永久 tab。验收时在控制台执行下面这行、重启 DSH 即可看到「探针」标签：
        //      localStorage.setItem('sa_probe_host_tab', '1')
        let probeHostTabEnabled = false;
        try {
          probeHostTabEnabled = typeof window !== 'undefined' && window.localStorage !== null && window.localStorage !== undefined
            && window.localStorage.getItem('sa_probe_host_tab') === '1';
        } catch (error) { /* 无 localStorage（隐私模式 / 离线测试）＝不启用，不抛 */ }
        if (probeHostTabEnabled) {
          if (tabsApi !== undefined && tabsApi !== null && typeof tabsApi.register === 'function') {
            disposers.push(ctx.effect(
              () => {
                try {
                  return tabsApi.register({
                    id: PROBE_TAB_ID,
                    kind: PROBE_TAB_KIND,
                    priority: 'extension',
                    title: () => '探针',
                  });
                } catch (error) {
                  ctx.logger?.warn?.(`[study-assistant] 探针标签类型注册失败（可能已注册过），已跳过：${error?.message ?? error}`);
                  return () => {};
                }
              },
              'study-assistant: probe tab type',
            ));
          }
          safeSlotRegister(ctx, disposers, 'sidebar.right.pane.tab', {
            name: 'sidebar.right.pane.tab',
            key: PROBE_TAB_ID,
          }, ProbeRightTab);
          safeSlotRegister(ctx, disposers, 'sidebar.right.pane.tab.title', {
            name: 'sidebar.right.pane.tab.title',
            key: PROBE_TAB_ID,
          }, ProbeRightTabTitle);
          // 块 E（2026-11-23）：探针里那句「在宿主右栏打开测试标签」的入口随右栏产品化一起删了，
          // 所以这里不再挂 focusProbeOpenHostTab。tab 的**注册**保留：它是「能往宿主右栏注册 tab」
          // 这条结论的最小样例（默认关闭，localStorage 开关启用），不妨碍产品界面。
        }

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
