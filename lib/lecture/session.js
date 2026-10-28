/**
 * 一节课的会话状态：累积逐字稿、跑检测、去重、落盘。
 *
 * 这里**不做识别**（识别在 `asr.js` 或读屏适配器里），只负责「文本进来之后
 * 怎么管」。所以它同时服务于三条输入源：腾讯会议读屏、手动粘贴、本地麦克风。
 *
 * 落盘位置：`<dataDir>/听课记录/<YYYY-MM-DD>-<课程名>.json`
 *   - 运行中每累计 `FLUSH_EVERY_SEGMENTS` 段刷一次盘，崩溃最多丢一小段；
 *   - `stop()` 时写最终版。
 *
 * 跨帧去重：字幕是滚动窗口，同一句话可能因为重叠修正被重复识别。所以
 * `DEDUP_WINDOW_MS` 内出现过的「同 kind + 同命中词 + 同片段」只报一次。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { buildNameMatcher, DEFAULT_STUDENT_NAME } from './dict.js';
import { detectAlerts } from './rollcall.js';
import { absorbCaption, clampTail, normalizeFrame, tailOf } from './text.js';

/** 听课记录子目录。 */
export const LECTURE_DIR = '听课记录';
/** 累积逐字稿在内存里最多留多少字符（约一节课）。 */
export const MAX_TRANSCRIPT_CHARS = 400000;
/** 检测窗口：只在末尾这么大的一段里找线索（够覆盖跨帧截断的名字）。 */
export const DETECT_WINDOW_CHARS = 800;
/** 每累计这么多段刷一次盘。 */
export const FLUSH_EVERY_SEGMENTS = 25;
/** 同一提醒多久之内不重复报。 */
export const DEDUP_WINDOW_MS = 60000;
/** 内存里最多保留多少段 / 多少条提醒。 */
export const MAX_SEGMENTS = 4000;
export const MAX_ALERTS = 500;

/** 本地日期（不是 UTC —— 课表是按本地时间排的）。 */
export function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本地时间戳，用于文件名排序。 */
export function localStamp(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${localDate(date).replace(/-/g, '')}-${hh}${mm}${ss}`;
}

/** 课程名 → 能当文件名的形式。Windows 的非法字符一律换成下划线。 */
export function safeFileName(name) {
  const text = String(name ?? '').trim() || '未命名课程';
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const sliced = [...cleaned].slice(0, 40).join('');
  return sliced === '' ? '未命名课程' : sliced;
}

/**
 * 建听课会话管理器。
 *
 * @param {{dataDir: string, logger?: object, clock?: () => Date, studentName?: string,
 *   studentNameVariants?: string|string[], summarizer?: object,
 *   reporting?: {render: Function, write: Function, handoffPrompt?: Function, handoff?: Function}}} deps
 *        `summarizer` 是可选的总结引擎（`lib/lecture/summarize.js`）。它只提供
 *        「滚动小结」和「提问秒答」，**慢且可能失败**，所以这里一律**不 await**：
 *        喂帧、快照、结束都照常返回，AI 结果回到后再回填进会话。模型抽风也
 *        绝不能卡住上课。
 *        `reporting` 是课后收尾用的四个函数（渲染笔记 / 落盘 / 写交接词 / 投给新会话）。
 *        故意做成注入的：本模块不认得工作区目录，也不该自己去猜笔记该放哪。
 */
export function createLectureSession(deps) {
  const dataDir = deps.dataDir;
  const log = deps.logger ?? console;
  const clock = typeof deps.clock === 'function' ? deps.clock : () => new Date();
  const studentName = String(deps.studentName ?? '').trim() || DEFAULT_STUDENT_NAME;
  // 匹配器建一次就够：每帧都重建正则既慢又容易漏掉 lastIndex 复位。
  const nameMatcher = buildNameMatcher(studentName, deps.studentNameVariants);
  const engine = deps.summarizer ?? null;
  const reporting = deps.reporting ?? null;

  let current = null;
  let seq = 0;
  /** 所有改动串行执行 —— 两个并发 POST 不能同时改同一份累积文本。 */
  let queue = Promise.resolve();
  /** 在飞的 AI 任务：`stop()` 要等它们落地，否则最后一段小结会丢。 */
  const pending = new Set();
  /** 最近一次课后收尾的进展。面板下课之后轮询它（`/lecture/report`）。 */
  let lastReport = null;

  function enqueue(operation) {
    const next = queue.then(operation, operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 把 AI 任务挂到「在飞」清单上，并保证它永远不会抛出。 */
  function track(promise) {
    const wrapped = Promise.resolve(promise).catch((error) => {
      log.error?.('[study-assistant] 后台 AI 任务异常：', error);
    });
    pending.add(wrapped);
    wrapped.then(() => pending.delete(wrapped), () => pending.delete(wrapped));
    return wrapped;
  }

  async function settlePending() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  function engineReady() {
    return engine !== null && typeof engine.available === 'function' && engine.available();
  }

  /**
   * 攒够字数且过了间隔，就在后台更新一次滚动小结。
   *
   * 只在 `current === session` 时回填：课已经结束（甚至换了下一节）就别再往里写。
   */
  function maybeRoll(session, at, charsAdded) {
    if (!engineReady()) return;
    if (typeof engine.shouldRoll !== 'function' || !engine.shouldRoll(charsAdded, at.getTime())) return;
    track((async () => {
      const result = await engine.roll({ text: session.text, at: at.getTime() });
      if (!result?.ok || current !== session) return;
      session.rolling = String(result.text ?? '');
      session.updatedAt = clock().toISOString();
    })());
  }

  /** 提问类提醒：后台去问模型要一个简短答案，回填到那条提醒上。 */
  function maybeAnswer(session, alert, at) {
    if (!engineReady()) return;
    if (alert.kind !== 'question' && alert.kind !== 'question-strong') return;
    track((async () => {
      const result = await engine.answer({ alert, text: session.text, at: at.getTime() });
      if (current !== session) return;
      const stored = session.alerts.find((item) => item.id === alert.id);
      if (stored === undefined) return;
      if (result?.ok) {
        stored.answer = String(result.text ?? '');
        stored.answerAt = clock().toISOString();
      } else if (result?.error !== undefined) {
        stored.answerError = String(result.error);
      }
    })());
  }

  /** 面板看到的课后收尾状态。`stage` 让面板知道该显示「正在总结」还是「已写盘」。 */
  function reportState() {
    return lastReport === null ? { ok: true, report: null } : { ok: true, report: { ...lastReport } };
  }

  /**
   * 课后收尾：结构化总结 → 渲染并写 md 笔记 → 交接给一个新会话。
   *
   * 全程在后台跑（`stop()` 只把它登记进 pending），因为一步模型调用就可能几十秒。
   * 每一步失败都只记进 `lastReport`，绝不让一次失败的总结吞掉已经写好的逐字稿。
   */
  async function buildReport(session, at) {
    const report = lastReport;
    const date = localDate(new Date(session.startedAt));
    if (reporting === null || typeof reporting.render !== 'function') {
      report.stage = 'no-reporting';
      return;
    }

    let summary = null;
    let rawSummary = '';
    let summaryError = '';
    if (engineReady() && typeof engine.summarize === 'function') {
      report.stage = 'summarizing';
      const result = await engine.summarize({ text: session.text, course: session.course, date });
      if (result?.ok) {
        summary = result.summary ?? null;
        rawSummary = String(result.raw ?? '');
        report.summaryOk = summary !== null;
      } else {
        summaryError = String(result?.error ?? 'failed');
      }
    } else {
      summaryError = 'llm-unavailable';
    }
    report.summaryError = summaryError;

    const markdown = reporting.render({
      course: session.course,
      date,
      startedAt: session.startedAt,
      stoppedAt: at.toISOString(),
      studentName,
      summary,
      rawSummary,
      stats: session.stats,
      alerts: session.alerts,
      transcriptPath: session.file,
      transcriptText: session.text,
      rolling: session.rolling === '' ? [] : [session.rolling],
      note: summaryError === '' ? '' : `自动总结没成（${summaryError}），这份笔记只有逐字稿摘录。`,
    });

    report.stage = 'writing';
    let written = null;
    if (typeof reporting.write === 'function') {
      try {
        written = await reporting.write({ courseName: session.course, date, markdown });
      } catch (error) {
        written = { ok: false, error: 'write-threw', detail: String(error?.message ?? error) };
      }
    } else {
      written = { ok: false, error: 'no-writer' };
    }
    report.note = written;
    if (written === null || written.ok !== true) {
      report.stage = 'note-failed';
      return;
    }

    report.stage = 'handoff';
    if (typeof reporting.handoff === 'function' && typeof reporting.handoffPrompt === 'function') {
      try {
        const prompt = reporting.handoffPrompt({
          course: session.course,
          date,
          summary,
          transcriptPath: session.file,
          notePath: String(written.file ?? ''),
        });
        report.handoff = await reporting.handoff({ prompt, title: `${session.course} · 课后追问` });
      } catch (error) {
        report.handoff = { ok: false, error: 'handoff-threw', detail: String(error?.message ?? error) };
      }
    } else {
      report.handoff = { ok: false, error: 'no-handoff' };
    }
    report.stage = report.handoff?.ok === true ? 'done' : 'done-no-session';
  }

  function dirPath() {
    return path.join(dataDir, LECTURE_DIR);
  }

  /** 原子写：临时文件 → fsync → rename（与 store.js 同一套做法）。 */
  async function writeAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    let handle;
    try {
      handle = await fs.open(tmp, 'w');
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      if (handle !== undefined) await handle.close();
    }
    await fs.rename(tmp, file);
  }

  function payload(session, stoppedAt) {
    return {
      version: 1,
      kind: 'lecture-transcript',
      id: session.id,
      course: session.course,
      source: session.source,
      profile: session.profile,
      studentName,
      startedAt: session.startedAt,
      stoppedAt: stoppedAt ?? null,
      updatedAt: session.updatedAt,
      stats: { ...session.stats },
      alerts: session.alerts,
      rolling: session.rolling ?? '',
      text: session.text,
      segments: session.segments,
    };
  }

  async function flush(session, stoppedAt) {
    await writeAtomic(session.file, JSON.stringify(payload(session, stoppedAt), null, 2));
  }

  /** 对外的会话摘要（不带完整逐字稿）。 */
  function summarize(session) {
    return {
      id: session.id,
      course: session.course,
      source: session.source,
      profile: session.profile,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      file: session.file,
      rolling: session.rolling ?? '',
      ai: typeof engine?.available === 'function' ? engine.available() : false,
      stats: { ...session.stats },
    };
  }

  function running() {
    return current !== null;
  }

  return {
    running,

    /** 当前用于点名匹配的姓名。面板要回显它 —— 名字配错了，整个提醒功能都是白搭。 */
    studentName() {
      return studentName;
    },

    /** 当前会话概况 + 尾部逐字稿与提醒。 */
    snapshot(options = {}) {
      if (current === null) return { ok: true, running: false, session: null, rolling: '', segments: [], alerts: [], textTail: '' };
      const tailSegments = Number.isInteger(options.tailSegments) ? options.tailSegments : 40;
      const tailAlerts = Number.isInteger(options.tailAlerts) ? options.tailAlerts : 30;
      return {
        ok: true,
        running: true,
        session: summarize(current),
        rolling: current.rolling ?? '',
        segments: current.segments.slice(-tailSegments),
        alerts: current.alerts.filter((a) => a.ack !== true).slice(-tailAlerts),
        textTail: tailOf(current.text, Number.isInteger(options.textTail) ? options.textTail : 1200),
      };
    },

    /** 开始一节课。已有会话在跑时拒绝（避免把两节课的逐字稿混在一起）。 */
    start(options = {}) {
      return enqueue(async () => {
        if (current !== null) {
          return { ok: false, error: 'session-active', session: summarize(current) };
        }
        const at = clock();
        const course = safeFileName(options.course);
        // 文本来源只认这四种；面板上的「手动粘贴」也是真来源，别把它记成读屏
        const source = options.source === 'mic' || options.source === 'tab' || options.source === 'paste'
          ? options.source
          : 'screen';
        const file = path.join(dirPath(), `${localDate(at)}-${course}.json`);
        if (engine !== null) {
          engine.setCourse?.(course);
          engine.reset?.();
        }
        current = {
          id: `${localStamp(at)}`,
          course,
          source,
          profile: typeof options.profile === 'string' ? options.profile : 'normal',
          startedAt: at.toISOString(),
          updatedAt: at.toISOString(),
          text: '',
          rolling: '',
          segments: [],
          alerts: [],
          seen: new Map(),
          stats: { frames: 0, chars: 0, alerts: 0, dropped: 0 },
          file,
          sinceFlush: 0,
        };
        seq = 0;
        return { ok: true, session: summarize(current) };
      });
    },

    /**
     * 喂一帧文本。
     *
     * @param {{text?: string, source?: string, at?: string}} input
     */
    feed(input = {}) {
      return enqueue(async () => {
        if (current === null) return { ok: false, error: 'no-session' };

        const raw = String(input.text ?? '');
        if (raw.trim() === '') return { ok: true, appended: '', alerts: [], session: summarize(current) };

        const frame = normalizeFrame(raw);
        if (frame === '') return { ok: true, appended: '', alerts: [], session: summarize(current) };

        const at = clock();
        const merged = absorbCaption(current.text, frame);
        current.stats.frames += 1;
        if (merged.appended === '') {
          current.updatedAt = at.toISOString();
          return { ok: true, appended: '', overlap: merged.overlap, alerts: [], session: summarize(current) };
        }

        const before = current.text.length;
        current.text = clampTail(merged.text, MAX_TRANSCRIPT_CHARS);
        current.updatedAt = at.toISOString();
        current.stats.chars = current.text.length;

        // 在末尾窗口里检测：这样跨帧被截断的名字（「示例」+「同学」）也能拼上。
        // 只有「结束位置越过本帧起点」的命中才算新命中，否则会把上一帧已经
        // 报过的提醒反复报一遍。
        const window = tailOf(current.text, DETECT_WINDOW_CHARS);
        const newStart = Math.max(0, window.length - merged.appended.length);
        const detected = detectAlerts(window, { matcher: nameMatcher });

        const fresh = [];
        for (const alert of detected) {
          if (alert.offset + alert.matched.length <= newStart) continue;
          const lastAt = current.seen.get(alert.key);
          if (lastAt !== undefined && at.getTime() - lastAt < DEDUP_WINDOW_MS) {
            current.stats.dropped += 1;
            continue;
          }
          current.seen.set(alert.key, at.getTime());
          seq += 1;
          fresh.push({
            id: `a${seq}`,
            at: at.toISOString(),
            kind: alert.kind,
            severity: alert.severity,
            matched: alert.matched,
            label: alert.label,
            snippet: alert.snippet,
            key: alert.key,
            ack: false,
          });
        }
        // 去重表不能无限长，否则一节课下来内存里全是字符串
        if (current.seen.size > 400) {
          for (const [key, ts] of current.seen) {
            if (at.getTime() - ts >= DEDUP_WINDOW_MS) current.seen.delete(key);
          }
        }

        current.alerts.push(...fresh);
        if (current.alerts.length > MAX_ALERTS) current.alerts.splice(0, current.alerts.length - MAX_ALERTS);
        current.stats.alerts += fresh.length;

        // 提醒先入列表再起 AI 任务：`maybeAnswer` 回填时要按 id 找得到它
        for (const alert of fresh) maybeAnswer(current, alert, at);
        // 滚动小结按「新增字数 + 间隔」双闸门决定要不要更新（引擎自己判定）
        maybeRoll(current, at, merged.appended.length);

        current.segments.push({
          at: at.toISOString(),
          source: typeof input.source === 'string' ? input.source : current.source,
          text: merged.appended,
          from: before,
        });
        if (current.segments.length > MAX_SEGMENTS) current.segments.splice(0, current.segments.length - MAX_SEGMENTS);

        current.sinceFlush += 1;
        if (current.sinceFlush >= FLUSH_EVERY_SEGMENTS) {
          current.sinceFlush = 0;
          try {
            await flush(current, null);
          } catch (error) {
            log.error?.('[study-assistant] 听课记录刷盘失败：', error);
          }
        }

        return {
          ok: true,
          appended: merged.appended,
          overlap: merged.overlap,
          alerts: fresh,
          session: summarize(current),
        };
      });
    },

    /** 确认（关掉）一条提醒。 */
    ack(id) {
      return enqueue(async () => {
        if (current === null) return { ok: false, error: 'no-session' };
        const alert = current.alerts.find((a) => a.id === id);
        if (alert === undefined) return { ok: false, error: 'unknown-alert', id };
        alert.ack = true;
        return { ok: true, id };
      });
    },

    /** 结束这节课：等 AI 收尾 → 写逐字稿 → 后台生成笔记并交接新会话。 */
    stop() {
      return enqueue(async () => {
        if (current === null) return { ok: false, error: 'no-session' };
        const session = current;
        const at = clock();
        // 先等在飞的滚动小结/秒答落地，否则最后一段小结只留在内存里、写不进文件
        await settlePending();
        let file = session.file;
        try {
          await flush(session, at.toISOString());
        } catch (error) {
          log.error?.('[study-assistant] 听课记录写入失败：', error);
          return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) };
        }
        current = null;
        lastReport = {
          sessionId: session.id,
          course: session.course,
          date: localDate(new Date(session.startedAt)),
          transcriptFile: file,
          startedAt: session.startedAt,
          stoppedAt: at.toISOString(),
          stats: { ...session.stats },
          alertCount: session.alerts.length,
          stage: 'queued',
          summaryOk: false,
          summaryError: '',
          note: null,
          handoff: null,
        };
        // 总结 + 写笔记 + 开新会话可能要几十秒，**绝不能**卡住这个 HTTP 请求；
        // 面板下课之后轮询 `/lecture/report` 拿进展。
        track(buildReport(session, at));
        return {
          ok: true,
          file,
          course: session.course,
          startedAt: session.startedAt,
          stoppedAt: at.toISOString(),
          stats: { ...session.stats },
          alerts: session.alerts,
          rolling: session.rolling ?? '',
          report: { ...lastReport },
        };
      });
    },

    /** 课后收尾的最新进展（结构化总结 / 笔记路径 / 新会话 id）。 */
    report() {
      return reportState();
    },

    /** 往期听课记录列表。 */
    async list() {
      let entries;
      try {
        entries = await fs.readdir(dirPath(), { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: true, dir: dirPath(), items: [] };
        return { ok: false, error: 'read-failed', detail: String(error?.message ?? error) };
      }
      const items = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(dirPath(), entry.name);
        let stat;
        try {
          stat = await fs.stat(file);
        } catch {
          continue;
        }
        items.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
      }
      items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      return { ok: true, dir: dirPath(), items };
    },
  };
}
