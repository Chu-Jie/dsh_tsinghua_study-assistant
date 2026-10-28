// 把 client.full.js 上的三处改动搬到发布件 client.js 上（逐块精确替换）。
//
// 为什么不用手改：client.js 是唯一会被真机加载的那份（package.json 的 files
// 只发布它），改动必须精确命中；本脚本每块都断言"恰好命中一次"，任何一块
// 对不上就整体不写盘。
//
// 用法：node tools/apply-client-features.mjs [--check] [--only <编号前缀>]
//
// 默认把 ①②③… 全部补丁按顺序打一遍（适用于从空 client.js 重建）。
// 已经打过补丁的 client.js 上再跑全量会因"命中 0 次"整体失败——这是刻意的保护。
// 要只打其中一块（例如功能上线后再追加一个小改动），用 --only 指定编号前缀：
//   node tools/apply-client-features.mjs --only ⑫
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = `${import.meta.dirname}/../client.js`;
const CHECK = process.argv.includes('--check');
const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex === -1 ? null : (process.argv[onlyIndex + 1] ?? '');
let source = readFileSync(FILE, 'utf8');
const before = source.length;

const patches = [
  {
    name: '① KIND_LABEL 提到组件之前（否则 DDL 页首次渲染就 TDZ 报错）',
    from: `      periods: '第 {a}-{b} 节',
    };
`,
    to: `      periods: '第 {a}-{b} 节',
    };

    // 任务类型的中文名。必须定义在页签组件**之前**：
    // 组件函数体在渲染时才求值，若把它放在组件下方，首次渲染就会踩进 TDZ 报
    // "Cannot access 'KIND_LABEL' before initialization"。
    const KIND_LABEL = { homework: '作业', lab: '实验', report: '报告', paper: '论文', exam: '考试', group: '小组', other: '其他' };
`,
  },
  {
    name: '② 删掉组件下面那份重复的 KIND_LABEL 声明',
    from: `    const KIND_LABEL = { homework: '作业', lab: '实验', report: '报告', paper: '论文', exam: '考试', group: '小组', other: '其他' };

    function DeadlinesTab(`,
    to: `    function DeadlinesTab(`,
  },
];

// ---- 内联逻辑：教学周→日期 + DDL 文本解析（与 lib/core.js 同步） ----
const INLINE_LOGIC = `    // --- 教学周 ↔ 具体日期（与 lib/core.js 同步，课表表头要靠它显示日期） ---

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
      return \`\${d.getMonth() + 1}/\${d.getDate()}\`;
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

      const timeMatch = /(\\d{1,2}):(\\d{2})/.exec(raw);
      let time = null;
      if (timeMatch !== null) {
        const h = Number(timeMatch[1]);
        const mi = Number(timeMatch[2]);
        if (h <= 23 && mi <= 59) time = \`\${pad2(h)}:\${pad2(mi)}\`;
      }
      const body = raw.replace(/\\d{1,2}:\\d{2}/, '').trim();
      const withTime = (date) => {
        if (date === null) return null;
        const day = formatDay(date);
        return time === null ? day : \`\${day} \${time}\`;
      };

      const full = /^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})$/.exec(body);
      if (full !== null) {
        const date = parseDay(\`\${full[1]}-\${pad2(Number(full[2]))}-\${pad2(Number(full[3]))}\`);
        if (date === null) return { value: null, ok: false, reason: 'bad-date' };
        return { value: withTime(date), ok: true };
      }
      const short = /^(\\d{1,2})[-/.](\\d{1,2})$/.exec(body);
      if (short !== null) {
        const month = Number(short[1]);
        const day = Number(short[2]);
        if (month < 1 || month > 12 || day < 1 || day > 31) return { value: null, ok: false, reason: 'bad-date' };
        let date = parseDay(\`\${base.getFullYear()}-\${pad2(month)}-\${pad2(day)}\`);
        if (date === null) return { value: null, ok: false, reason: 'bad-date' };
        if (date.getTime() < base.getTime()) date = parseDay(\`\${base.getFullYear() + 1}-\${pad2(month)}-\${pad2(day)}\`);
        return { value: withTime(date), ok: true };
      }
      if (Object.prototype.hasOwnProperty.call(DATE_ALIASES, body)) {
        const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + DATE_ALIASES[body]);
        return { value: withTime(date), ok: true };
      }
      const wd = /^(下?)(?:周|星期|礼拜)\\s*([一二三四五六日天1-7])$/.exec(body);
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
      const lines = String(text ?? '').split(/\\r?\\n/);

      const matchCourse = (name) => {
        const needle = name.trim();
        if (needle === '') return { id: null, ok: true };
        const lower = needle.toLowerCase();
        const exact = courses.find((c) => String(c?.name ?? '').toLowerCase() === lower);
        if (exact !== undefined) return { id: exact.id ?? null, ok: true };
        const partial = courses.filter((c) => String(c?.name ?? '').toLowerCase().includes(lower));
        if (partial.length === 1) return { id: partial[0].id ?? null, ok: true };
        if (partial.length > 1) return { id: null, ok: false, reason: \`科目「\${needle}」匹配到多门课：\${partial.map((c) => c.name).join('、')}\` };
        return { id: null, ok: false, reason: \`找不到科目「\${needle}」\` };
      };
      const matchKind = (name) => {
        const needle = name.trim();
        if (needle === '') return { kind: 'homework', ok: true };
        if (KIND_ALIASES[needle] !== undefined) return { kind: KIND_ALIASES[needle], ok: true };
        return { kind: 'homework', ok: false, reason: \`类型「\${needle}」无法识别\` };
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
          errors.push({ line: lineNo, text: line, reason: \`日期「\${parts[2]}」无法识别\` });
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
            errors.push({ line: lineNo, text: line, reason: \`优先级「\${prioRaw}」无法识别（可写 高/中/低）\` });
            return;
          }
          draft.priority = prio;
        }
        items.push({ ...draft, _line: lineNo });
      });

      return { items, errors, ok: errors.length === 0 };
    }

`;

patches.push({
  name: '③ 插入教学周→日期换算与 DDL 文本解析（插在 isoWeekday 之后）',
  from: `    function isoWeekday(date) {
      const day = parseDay(date);
      if (day === null) return 0;
      return day.getDay() === 0 ? 7 : day.getDay();
    }

    function parseWeeks(expr) {`,
  to: `    function isoWeekday(date) {
      const day = parseDay(date);
      if (day === null) return 0;
      return day.getDay() === 0 ? 7 : day.getDay();
    }

${INLINE_LOGIC}    function parseWeeks(expr) {`,
});

patches.push({
  name: '④ 课表表头：日期 + 今天高亮（含修复被合并的 cellFor 行）',
  from: `      const cellFor = (period, weekday) => courses.flatMap((course) =>
        (Array.isArray(course.sessions) ? course.sessions : [])`,
  to: `      // 表头展示这一周每天的日期，并高亮「今天」所在列
      const isTodayColumn = (weekday) => isSameDay(dateOfWeekday(term, shownWeek, weekday), now);
      const weekMonday = teachingWeekStart(term, shownWeek);
      const weekSunday = weekMonday === null ? null : new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() + 6);
      const weekRangeText = weekMonday === null || weekSunday === null
        ? ''
        : \`\${formatMonthDay(weekMonday)} – \${formatMonthDay(weekSunday)}\`;

      const cellFor = (period, weekday) => courses.flatMap((course) =>
        (Array.isArray(course.sessions) ? course.sessions : [])`,
});

patches.push({
  name: '⑤ 周标题旁边显示这一周的日期区间',
  from: `          h('span', null, \`第 \${shownWeek} 周\`),`,
  to: `          h('span', null,
            \`第 \${shownWeek} 周\`,
            weekRangeText === '' ? null : h('span', { className: 'sa-muted' }, \`　\${weekRangeText}\`),
          ),`,
});

patches.push({
  name: '⑥ 表头每列渲染日期',
  from: `            ...TEXT.weekdays.slice(1).map((name) => h('div', { className: 'sa-cell head', key: name }, name)),`,
  to: `            ...TEXT.weekdays.slice(1).map((name, index) => {
              const weekday = index + 1;
              const date = dateOfWeekday(term, shownWeek, weekday);
              const text = formatMonthDay(date);
              return h('div', { className: \`sa-cell head\${isTodayColumn(weekday) ? ' today' : ''}\`, key: name },
                h('div', null, name),
                text === '' ? null : h('div', { className: 'sa-cell-date' }, text),
              );
            }),`,
});

patches.push({
  name: '⑦ CSS：日期与今天高亮',
  from: `.sa-cell.head{min-height:auto;border:0;text-align:center;color:var(--dsw-alias-label-secondary);padding:2px}`,
  to: `.sa-cell.head{min-height:auto;border:0;text-align:center;color:var(--dsw-alias-label-secondary);padding:2px}
.sa-cell.head.today{color:var(--dsw-alias-brand-primary);font-weight:600}
.sa-cell-date{font-size:10px;opacity:.75;line-height:1.4}`,
});

patches.push({
  name: '⑧ CSS：多行文本域',
  from: `.sa-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}`,
  to: `.sa-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
.sa-textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;font-family:inherit;white-space:pre-wrap}`,
});

patches.push({
  name: '⑨ DDL 页：导入状态 + 实时预览（替换组件的状态声明段）',
  from: `    function DeadlinesTab({ docs, now, refresh, busy, run, setBusy }) {
      const [filter, setFilter] = useState('active');
      const [draft, setDraft] = useState({ title: '', kind: 'homework', due: '', courseId: null, estimateHours: '' });
      const courses = Array.isArray(docs.courses?.courses) ? docs.courses.courses : [];
      const tasks = Array.isArray(docs.tasks?.tasks) ? docs.tasks.tasks : [];

      const shown = useMemo(() => {`,
  to: `    function DeadlinesTab({ docs, now, refresh, busy, run, setBusy }) {
      const [filter, setFilter] = useState('active');
      const [draft, setDraft] = useState({ title: '', kind: 'homework', due: '', courseId: null, estimateHours: '' });
      const [importer, setImporter] = useState('single');   // single = 单条快录，batch = 批量粘贴
      const [text, setText] = useState('');
      const [notice, setNotice] = useState(null);
      const courses = Array.isArray(docs.courses?.courses) ? docs.courses.courses : [];
      const tasks = Array.isArray(docs.tasks?.tasks) ? docs.tasks.tasks : [];

      // 一键导入的实时预览：每次输入都按当前课程表解析一遍，导入前就能看到结果
      const parsed = useMemo(
        () => parseQuickTasks(text, { courses, now }),
        [text, courses, now],
      );

      const courseNameOf = (id) => courses.find((c) => c.id === id)?.name ?? '';

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
          setNotice({ kind: 'ok', text: \`已导入 \${created} 条任务。\` });
          setText('');
          await refresh();
        } catch (error) {
          setNotice({ kind: 'error', text: \`导入中断：\${error?.message ?? error}\` });
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
          setNotice({ kind: 'error', text: \`新增失败：\${error?.message ?? error}\` });
        } finally {
          setBusy(false);
        }
      };

      const shown = useMemo(() => {`,
});

patches.push({
  name: '⑩ DDL 页：一键导入卡片插在表单之前',
  from: `        h('div', { className: 'sa-card' },
          h('h3', null, '新增任务'),`,
  to: `        h('div', { className: 'sa-card' },
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
              ? '标题 | 科目 | 日期 | 类型\\n例：第 3 次作业 | 数据结构 | 10/20 | 作业\\n　　实验二预习报告 | 数电 | 明天 | 实验\\n日期支持 2026-10-20 / 10/20 / 今天 / 周五；类型支持 作业/实验/报告/考试/小组\\n科目可写全名或简称（如 数电 = 数字电子技术基础）'
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
                busy ? '导入中…' : \`导入 \${parsed.items.length} 条\`),
            h('span', { className: 'sa-muted' }, importer === 'single' ? '' : 'Ctrl + Enter 执行'),
          ),
          notice === null ? null : h('div', { className: notice.kind === 'ok' ? 'sa-muted' : 'sa-error', style: { marginTop: 6 } }, notice.text),
          text.trim() === '' ? null : h('div', { style: { marginTop: 8 } },
            h('div', { className: 'sa-muted' },
              \`识别到 \${parsed.items.length} 条\`
              + (parsed.errors.length > 0 ? \`，\${parsed.errors.length} 行有问题（有问题时不会导入，避免只写一半）\` : ''),
            ),
            parsed.items.slice(0, 10).map((item) => h('div', { className: 'sa-row', key: item._line, style: { borderBottom: 0, padding: '3px 0' } },
              h('span', { className: 'sa-muted' }, \`第 \${item._line} 行\`),
              h('span', { className: 'sa-grow' }, item.title),
              h('span', { className: 'sa-muted' }, courseNameOf(item.courseId) || '未选科目'),
              h('span', { className: 'sa-muted' }, item.due || '无截止日'),
              h(Pill, { level: 'later' }, KIND_LABEL[item.kind] ?? item.kind),
            )),
            parsed.errors.map((err) => h('div', { className: 'sa-error', key: \`e\${err.line}\` }, \`第 \${err.line} 行：\${err.reason}\`)),
          ),
        ),
        h('div', { className: 'sa-card' },
          h('h3', null, '新增任务（表单）'),`,
});

patches.push({
  name: '⑫ 科目匹配支持别名（数电 = 数字电子技术基础），并在认不出时提示可用写法',
  from: `      const matchCourse = (name) => {
        const needle = name.trim();
        if (needle === '') return { id: null, ok: true };
        const lower = needle.toLowerCase();
        const exact = courses.find((c) => String(c?.name ?? '').toLowerCase() === lower);
        if (exact !== undefined) return { id: exact.id ?? null, ok: true };
        const partial = courses.filter((c) => String(c?.name ?? '').toLowerCase().includes(lower));
        if (partial.length === 1) return { id: partial[0].id ?? null, ok: true };
        if (partial.length > 1) return { id: null, ok: false, reason: \`科目「\${needle}」匹配到多门课：\${partial.map((c) => c.name).join('、')}\` };
        return { id: null, ok: false, reason: \`找不到科目「\${needle}」\` };
      };`,
  to: `      // 科目匹配：课程名与别名一视同仁。
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
            reason: \`科目「\${needle}」匹配到多门课：\${partial.map((h) => h.course.name).join('、')}，请写得更具体\`,
          };
        }
        // 3) 认不出来时，顺手提示可用的写法（含别名），免得用户猜
        const available = courses
          .map((c) => {
            const alias = Array.isArray(c?.aliases) ? c.aliases.filter((a) => typeof a === 'string' && a.trim() !== '') : [];
            return alias.length > 0 ? \`\${c?.name}（或 \${alias.join('/')}）\` : String(c?.name ?? '');
          })
          .filter((s) => s !== '');
        const hint = available.length > 0 ? \`。可用的科目：\${available.join('、')}\` : '';
        return { id: null, ok: false, reason: \`找不到科目「\${needle}」\${hint}\` };
      };`,
});

patches.push({
  name: '⑪ 导出 internals，供防漂移测试逐项比对',
  from: `        computeGpa,
        parseDay,
        parseDue,
      },`,
  to: `        computeGpa,
        parseDay,
        parseDue,
        teachingWeekStart,
        dateOfWeekday,
        formatMonthDay,
        parseQuickDay,
        parseQuickTasks,
      },`,
});

let ok = true;
const report = [];
for (const patch of patches) {
  if (ONLY !== null && !patch.name.startsWith(ONLY)) continue;
  const hits = source.split(patch.from).length - 1;
  if (hits !== 1) {
    ok = false;
    console.error(`✗ ${patch.name}\n    期望命中 1 次，实际 ${hits} 次${hits === 0 ? '（可能已经打过这个补丁）' : ''}`);
    continue;
  }
  source = source.replace(patch.from, patch.to);
  report.push(`✓ ${patch.name}`);
}
if (ONLY !== null && report.length === 0 && !ok) {
  console.error(`\n--only ${ONLY} 没有匹配到任何补丁编号。`);
}

if (!ok) {
  console.error('\n有补丁未命中，未写盘。');
  process.exit(1);
}

for (const line of report) console.log(line);
console.log(`\n${before} 字符 → ${source.length} 字符（+${source.length - before}）`);

if (CHECK) {
  console.log('--check：未写入。');
  process.exit(0);
}
writeFileSync(FILE, source, 'utf8');
console.log(`已写入 client.js：${readFileSync(FILE, 'utf8') === source ? '校验通过 ✓' : '校验失败 ✗'}`);
