/**
 * 提交件扫描与匹配（零依赖，仅 Node 标准库）
 *
 * 学习台的 DDL 任务只有在「用户本人把带姓名 + 学号的提交件放进
 * `<学科目录>\提交文件\`」时才应该被归档（标成 done）。本模块只做**只读判定**：
 *   扫描工作区 → 解析提交件文件名 → 目录名 / 文件名两路解析课程与序号 → 给出可归档的任务；
 * **绝不写任何文件**，实际写盘（改 tasks[].status / note）由调用方负责。
 *
 * 判定原则（宁可漏判，也不误判 —— 误判会把没做的事标成已完成）：
 *   - 身份：文件名必须**同时**含姓名与学号，否则根本不算提交件（连扫描都不收）；
 *   - 位置：只有 `<学科>\提交文件\` 下的文件参与归档；工作区根目录下的同名件记为
 *     stray（放错位置），只提示不归档；
 *   - 课程：目录名（如 `数电实验`）与文件名（如 `数电`）两路线索都命中时取交集，
 *     交集为空即课程不符 → unmatched；线索不唯一也不归档；
 *   - 序号：两边都解析出序号时必须相交；缺一边时该维度不参与（只用 kind 兜底）；
 *   - kind 必须相等：`实验报告` 不得归档到 kind 为 `homework` 的「第三周作业」
 *     （这正是回归用例要挡住的错配）。
 *
 * 与 store.js 的分工：本模块不 import store，也不依赖任何写盘能力。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 工作区根下不当作学科目录的目录。
 *
 * 只跳过「一定不是学科目录」的三类：依赖、版本库、下划线开头的内部目录
 * （技能包/插件/工具/模板之类习惯上这样命名）。不再写死作者本机的中文目录名，
 * 换一套工作区布局也能用。
 */
function shouldSkipDir(name) {
  return name === 'node_modules' || name === '.git' || name.startsWith('_');
}

/** 学科目录里放提交件的固定子目录名。 */
const SUBMIT_DIR = '提交文件';

/** 提交件目录内的递归深度上限。 */
const MAX_DEPTH = 3;

/** findings 条数上限（超出的宁可截断，也不让面板一次吃进整个工作区）。 */
const MAX_FINDINGS = 500;

/** 「报告」类关键词：命中即 kind=report（纯「报告」也算）。 */
const KIND_REPORT = /实验报告|预习报告|实验预习|小测|预习小测|报告/;
/** 「考试」类关键词：仅在不是 report 时才生效。 */
const KIND_EXAM = /测验|考试|quiz/i;
/** 算 subjectToken 时要去掉的 kind 关键词（长的写在前面，避免先吃掉半个词）。 */
const KIND_WORDS = /预习小测|实验报告|预习报告|实验预习|小测|报告|测验|考试|quiz/gi;

/** 序号表达式：第 3 次 / 第 3 周 / 第 3 讲。 */
const SEQ_ORDINAL = /第\s*([0-9零〇一二三四五六七八九十百]+)\s*[次周讲]/;
/** 序号表达式：HW2 / hw 03。 */
const SEQ_HOMEWORK = /[Hh][Ww]\s*0*([0-9]+)/;
/** 序号表达式：作业 3（只用于提交件文件名，任务标题按规格不认这种写法）。 */
const SEQ_AFTER_WORK = /作业\s*0*([0-9]+)/;
/** 序号表达式：周次：1（只用于任务标题）。 */
const SEQ_WEEK_FIELD = /周次\s*[:：]\s*0*([0-9]+)/;
/** 整个标题只由数字与 `、,，和` 组成（如 `3、4`）。 */
const SEQ_BARE_LIST = /^[0-9]+(?:\s*[、,，和]\s*[0-9]+)+$/;
/** 整个标题就是一个数字（如 `2`）。 */
const SEQ_BARE_ONE = /^[0-9]+$/;

/** 合法数字字符集：中文数字解析前先卡一遍，避免把乱码算成数字。 */
const SEQ_NUMERIC_CHARS = /[^0-9零〇一二三四五六七八九十百两]/;

/** subjectToken 的分隔：中文 / 拉丁字母以外的都算分隔符。 */
const TOKEN_SPLIT = /[^A-Za-z\u4e00-\u9fff]+/u;
/** 收尾的无信息词（不包含「实验」——`数电实验` 是课程令牌本身）。 */
const TRAILING_NOISE = /(?:作业|习题|练习|报告|小测|测验|考试|答案)+$/;
/** 收尾的中文序号（`数电实验二` → `数电实验`）。 */
const TRAILING_CN_NUMERIC = /[零〇一二三四五六七八九十百]+$/;

/** findings 的排序权重：越可操作越靠前。 */
const STATUS_ORDER = { ready: 0, ambiguous: 1, done: 2, unmatched: 3, stray: 4 };

/** 非 open（不再等待提交）的任务状态：这些任务不参与「可归档」候选。 */
const CLOSED_STATUS = new Set(['done', 'dropped']);

/** 去掉扩展名；以 `.` 开头的隐藏文件整名保留。 */
function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 中文 / 阿拉伯数字片段 → 整数；无法解析返回 null。 */
function seqNumberToInt(raw) {
  const text = String(raw ?? '');
  if (text === '') return null;
  if (SEQ_BARE_ONE.test(text)) return Number(text);
  if (SEQ_NUMERIC_CHARS.test(text)) return null;

  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100 };
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (SEQ_BARE_ONE.test(ch)) {
      current = current * 10 + Number(ch);
      continue;
    }
    const digit = digits[ch];
    if (digit !== undefined) {
      current = digit;
      continue;
    }
    const unit = units[ch];
    if (unit === undefined) return null;
    // 「十一」的十前面没有数字，按 1 算
    if (current === 0 && unit === 10) current = 1;
    total += current * unit;
    current = 0;
  }
  return total + current;
}

/**
 * 在文本里按给定顺序找第一个命中的序号。
 * @param {string} text
 * @param {RegExp[]} patterns 各自第 1 个捕获组是数字片段
 * @returns {{value: number, text: string}|null} text 是命中的整段，用于从 subjectToken 里剔除
 */
function matchSeq(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = seqNumberToInt(match[1]);
    if (value === null || !Number.isInteger(value)) continue;
    return { value, text: match[0] };
  }
  return null;
}

/** 从文件名里判定提交件类型：报告 / 考试 / 作业。 */
function detectKind(text) {
  if (KIND_REPORT.test(text)) return 'report';
  if (KIND_EXAM.test(text)) return 'exam';
  return 'homework';
}

/**
 * 剥掉序号片段与 kind 关键词之后剩下的课程令牌。
 * `物理第一次作业` → `物理`；`数电实验第三次实验报告` → `数电实验`；剩不下东西则返回 ''。
 */
function extractSubjectToken(text) {
  const cleaned = String(text ?? '').replace(KIND_WORDS, '');
  const parts = cleaned.split(TOKEN_SPLIT).filter((part) => part !== '');
  if (parts.length === 0) return '';
  let token = parts[0];
  for (;;) {
    const withoutNoise = token.replace(TRAILING_NOISE, '');
    if (withoutNoise !== token) {
      token = withoutNoise;
      continue;
    }
    const withoutNumeric = token.replace(TRAILING_CN_NUMERIC, '');
    if (withoutNumeric !== token && withoutNumeric.length >= 2) {
      token = withoutNumeric;
      continue;
    }
    return token;
  }
}

/** 文件名（可带扩展名）里是否同时含姓名与学号。 */
function hasIdentity(basename, studentName, studentId) {
  return basename.includes(studentId) && basename.includes(studentName);
}

/** 扫描时统一跳过的名字：以 `.` 或 `~$` 开头（Office 临时文件 / 隐藏项）。 */
function isSkippedName(name) {
  return name.startsWith('.') || name.startsWith('~$');
}

/** 相对路径统一成正斜杠（findings.file 的形状）。 */
function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

/** 任务 → candidates 项。 */
function toCandidate(task) {
  return { taskId: task.id, title: task.title ?? '', seq: parseTaskSeq(task.title) };
}

/** 任务 title 里的序号与提交件是否相容（缺一边则跳过这一维）。 */
function seqCompatible(fileSeq, taskSeq) {
  if (fileSeq === null || taskSeq === null) return true;
  return fileSeq.some((n) => taskSeq.includes(n));
}

/** 任务与提交件是否算同一条（序号 + kind + 课程范围）。 */
function taskMatchesFile(task, file, scope) {
  if (!scope.includes(task.courseId)) return false;
  if (task.kind !== file.kind) return false;
  return seqCompatible(file.seq, parseTaskSeq(task.title));
}

/**
 * 解析一个提交件文件名。
 * @param {string} basename 文件名，可带扩展名（如 `2025000000_示例同学_物理第一次作业.pdf`）
 * @param {{name: string, studentId: string}} identity 本人的姓名与学号
 * @returns {{ok: true, subjectToken: string, seq: number[]|null, kind: 'homework'|'report'|'exam'}
 *          |{ok: false, reason: 'missing-identity'}}
 *   basename / name / studentId 任一缺失，或文件名里不含姓名/学号 → `missing-identity`。
 */
export function parseDeliverableName(basename, { name, studentId } = {}) {
  const base = typeof basename === 'string' ? basename.trim() : '';
  const person = typeof name === 'string' ? name.trim() : '';
  const id = typeof studentId === 'string' ? studentId.trim() : '';
  if (base === '' || person === '' || id === '') return { ok: false, reason: 'missing-identity' };

  const stem = stripExtension(base);
  if (!hasIdentity(stem, person, id)) return { ok: false, reason: 'missing-identity' };

  // 去掉身份信息后剩下的部分才是「课程 + 序号 + 类型」的载体
  const rest = stem.split(id).join('').split(person).join('');
  const hit = matchSeq(rest, [SEQ_ORDINAL, SEQ_HOMEWORK, SEQ_AFTER_WORK]);
  const seq = hit === null ? null : [hit.value];
  const withoutSeq = hit === null ? rest : rest.split(hit.text).join('');

  return { ok: true, subjectToken: extractSubjectToken(withoutSeq), seq, kind: detectKind(rest) };
}

/**
 * 从任务标题里解析序号。
 * @param {string} title
 * @returns {number[]|null} 解析不出返回 null（null 表示「该维度未知」，不是「没有作业」）
 */
export function parseTaskSeq(title) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (text === '') return null;

  const hit = matchSeq(text, [SEQ_ORDINAL, SEQ_HOMEWORK, SEQ_WEEK_FIELD]);
  if (hit !== null) return [hit.value];

  if (SEQ_BARE_LIST.test(text)) {
    return text.split(/[、,，和]/).map((part) => Number(part.trim())).filter((n) => Number.isInteger(n));
  }
  if (SEQ_BARE_ONE.test(text)) return [Number(text)];
  return null;
}

/**
 * 目录名 / 文件名里的课程令牌 → 命中的 courseId 数组（可能多个）。
 * 命中条件：与课程名或别名**完全相同**优先；没有完全相同的，才退回「课程名/别名以该令牌开头」
 * （`物理实验` → `物理实验B(1)`）。分两档是因为真实课表里 `物理` 与 `物理实验B(1)` 同时存在，
 * 混在一起会让 `物理/提交文件/…物理第一次作业.pdf` 变成「课程不唯一」，从而永远不自动归档。
 * @param {string} token
 * @param {Array<{id: string, name?: string, aliases?: string[]}>} courses
 * @returns {string[]} 去重后的 courseId；认不出来返回 []
 */
export function resolveCourseIds(token, courses) {
  const needle = typeof token === 'string' ? token.trim() : '';
  if (needle === '' || !Array.isArray(courses)) return [];

  const exact = [];
  const prefixed = [];
  for (const course of courses) {
    if (course === null || typeof course !== 'object' || typeof course.id !== 'string') continue;
    const names = [course.name, ...(Array.isArray(course.aliases) ? course.aliases : [])]
      .filter((label) => typeof label === 'string' && label !== '');
    if (names.some((label) => label === needle)) {
      if (!exact.includes(course.id)) exact.push(course.id);
      continue;
    }
    if (names.some((label) => label.startsWith(needle)) && !prefixed.includes(course.id)) {
      prefixed.push(course.id);
    }
  }
  return exact.length > 0 ? exact : prefixed;
}

/** 递归收集一个「提交文件」目录下的常规文件（深度 ≤ MAX_DEPTH）。 */
async function walkSubmitDir(dir, depth, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录读不动（权限/竞态）就当没有，绝不让扫描整体失败
  }
  for (const entry of entries) {
    if (isSkippedName(entry.name)) continue;
    if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
      continue;
    }
    if (entry.isDirectory() && depth < MAX_DEPTH) await walkSubmitDir(path.join(dir, entry.name), depth + 1, out);
  }
}

/**
 * 扫描 + 匹配。只读，不写任何文件。
 *
 * 启用条件（任一不满足即 `{enabled:false, reason:'disabled'}`）：
 * `studentName` 与 `studentId` 都非空，且 `workspaceRoot` 存在并且是目录。
 *
 * @param {{workspaceRoot: string, studentName: string, studentId: string,
 *          courses: Array, tasks: Array}} opts
 *   tasks 是 `学习台/任务.json` 的 `tasks[]`；courses 是 `课程.json` 的 `courses[]`。
 * @returns {Promise<{enabled: boolean, root: string, findings: Array, reason?: string}>}
 *   findings 按 ready → ambiguous → done → unmatched → stray 排序，同级按 file 升序，最多 500 条。
 */
export async function collectDeliverables(opts = {}) {
  const workspaceRoot = typeof opts.workspaceRoot === 'string' ? opts.workspaceRoot : '';
  const studentName = typeof opts.studentName === 'string' ? opts.studentName.trim() : '';
  const studentId = typeof opts.studentId === 'string' ? opts.studentId.trim() : '';
  const courses = Array.isArray(opts.courses) ? opts.courses.filter((c) => c !== null && typeof c === 'object') : [];
  const tasks = Array.isArray(opts.tasks) ? opts.tasks.filter((t) => t !== null && typeof t === 'object') : [];

  const disabled = { enabled: false, root: workspaceRoot, findings: [], reason: 'disabled' };
  if (workspaceRoot === '' || studentName === '' || studentId === '') return disabled;

  let stat;
  try {
    stat = await fs.stat(workspaceRoot);
  } catch {
    return disabled;
  }
  if (!stat.isDirectory()) return disabled;

  let entries;
  try {
    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return disabled;
  }

  /** 待判定的提交件：{ abs, dirName }；dirName 为 null 表示直接躺在工作区根下（stray）。 */
  const collected = [];
  const seenPaths = new Set();
  const push = (abs, dirName) => {
    if (seenPaths.has(abs)) return; // 同一路径只保留一条
    seenPaths.add(abs);
    collected.push({ abs, dirName });
  };

  for (const entry of entries) {
    if (isSkippedName(entry.name)) continue;
    if (entry.isFile()) {
      // 工作区根下的直接文件：位置不对，只提示不归档
      if (hasIdentity(entry.name, studentName, studentId)) push(path.join(workspaceRoot, entry.name), null);
      continue;
    }
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;

    // 只看 <学科目录>\提交文件\，递归收集带本人身份的常规文件
    const submitDir = path.join(workspaceRoot, entry.name, SUBMIT_DIR);
    let isDir = false;
    try {
      isDir = (await fs.stat(submitDir)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const files = [];
    await walkSubmitDir(submitDir, 1, files);
    for (const abs of files) {
      if (hasIdentity(path.basename(abs), studentName, studentId)) push(abs, entry.name);
    }
  }

  const findings = [];
  for (const { abs, dirName } of collected) {
    const basename = path.basename(abs);
    const file = toPosix(path.relative(workspaceRoot, abs));
    const parsed = parseDeliverableName(basename, { name: studentName, studentId });

    if (!parsed.ok) {
      // 理论上到不了这里（收集阶段已经卡过身份），留一条兜底而不是抛异常
      findings.push({
        file, basename, courseId: null, seq: null, kind: 'homework',
        status: 'unmatched', taskId: null, candidates: [], reason: parsed.reason,
      });
      continue;
    }

    const common = { file, basename, seq: parsed.seq, kind: parsed.kind };
    const subjIds = resolveCourseIds(parsed.subjectToken, courses);
    const out = (status, reason, extra = {}) => {
      findings.push({ ...common, courseId: null, taskId: null, candidates: [], status, reason, ...extra });
    };

    // 放错位置：不参与归档，只把能解析出来的信息展示给用户
    if (dirName === null) {
      out('stray', 'not-in-submit-dir', { courseId: subjIds.length === 1 ? subjIds[0] : null });
      continue;
    }

    // 两路课程线索：目录名（如 `数电实验`）与文件名令牌（如 `数电`）
    const dirIds = resolveCourseIds(dirName, courses);
    let scope;
    if (dirIds.length > 0 && subjIds.length > 0) {
      scope = dirIds.filter((id) => subjIds.includes(id));
      if (scope.length === 0) {
        out('unmatched', 'course-mismatch');
        continue;
      }
    } else if (dirIds.length > 0) {
      scope = dirIds;
    } else if (subjIds.length > 0) {
      scope = subjIds;
    } else {
      out('unmatched', 'course-unknown');
      continue;
    }
    if (scope.length > 1) {
      out('ambiguous', 'course-ambiguous');
      continue;
    }
    const courseId = scope[0];

    const scoped = tasks.filter((task) => scope.includes(task.courseId));

    // 已归档判据（优先）：候选课程内任一任务（含 done/dropped）的备注里已经写着这个文件名
    const noted = scoped.find((task) => typeof task.note === 'string' && task.note.includes(basename));
    if (noted !== undefined) {
      out('done', 'already-noted', { courseId, candidates: [toCandidate(noted)] });
      continue;
    }

    const open = scoped.filter((task) => !CLOSED_STATUS.has(task.status));
    const matchedOpen = open.filter((task) => taskMatchesFile(task, parsed, scope));
    if (matchedOpen.length === 1) {
      out('ready', 'unique-task', { courseId, taskId: matchedOpen[0].id });
      continue;
    }
    if (matchedOpen.length > 1) {
      out('ambiguous', 'task-ambiguous', { courseId, candidates: matchedOpen.map(toCandidate) });
      continue;
    }

    // 没有 open 任务匹配：已完成的任务里能对上，说明这份提交件其实早就归档了
    const closed = scoped.filter((task) => task.status === 'done');
    const matchedDone = closed.filter((task) => taskMatchesFile(task, parsed, scope));
    if (matchedDone.length > 0) {
      out('done', 'task-done', { courseId, candidates: matchedDone.map(toCandidate) });
      continue;
    }
    out('unmatched', 'no-task', { courseId });
  }

  findings.sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });

  return { enabled: true, root: workspaceRoot, findings: findings.slice(0, MAX_FINDINGS) };
}
