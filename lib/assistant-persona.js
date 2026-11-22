/**
 * 学习画像（v2-D 卡，2026-11-22）：把「我是谁、在学什么、学到哪」压成一段隐式提示。
 *
 * 设计口径（任务卡 §二①）：
 *   - **纯函数**：不读盘、不取 `new Date()`、不打日志；磁盘数据由 `lib/api.js` 现读后传进来。
 *   - **拿不到身份就返回空串**：空串意味着调用方一条 system 都不加，消息与 v2-A 逐字一致。
 *   - **空数据也返回空串**：有姓名但没有学期/课程/学习记录时，只写一句「你是 X」没有价值，
 *     还会让「空数据与现状逐字一致」的验收门失效。
 *   - **总长固定**：≤ `PERSONA_MAX_CHARS`（600）字，不随知识点数量膨胀。
 *   - **防注入**：所有读入字段一律当数据 —— 换行/控制字符压成空格、超长截断，绝不拼成指令。
 *   - **学号绝不进文本**：`studentId` 只用于调用方判空，画像里只写「学号已隐去」占位。
 */

import { MASTERY_LABELS, clampMastery } from './mastery.js';

/** 画像总长上限（含换行与标点）。任务卡拍板「约 300–600 字」，固定取上限。 */
export const PERSONA_MAX_CHARS = 600;

/** 单个字段的缺省截断长度：姓名/学期/课程偏短，知识点名稍长。 */
const NAME_MAX = 24;
const TERM_MAX = 32;
const COURSE_MAX = 24;
const NODE_MAX = 48;
const EXCERPT_MAX = 18;
/** 课程最多列几个名字，多出来的折成「等 N 门」。 */
const MAX_COURSE_NAMES = 6;
/** 批注类型 → 中文（只用于「最近一条」的摘要，不贴原文）。 */
const ANNOTATION_TYPE_LABELS = { note: '笔记', highlight: '高亮', insert: '插入' };

/**
 * 把任意读入值压成「一行、有上限」的纯文本。
 *
 * 换行（`\n`/`\r`）、制表符、控制字符、Unicode 行分隔符全部折叠成单个空格 ——
 * 这样外部数据不可能在 system 里另起一段假装是新指令。
 */
function personaText(value, max = NAME_MAX) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** 只认 ISO 日期的前 10 位（`2026-11-21T...` → `2026-11-21`），别的格式一律不猜。 */
function personaDay(value) {
  if (typeof value !== 'string') return '';
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return matched === null ? '' : matched[1];
}

/** 取当前学期名：优先 `currentId` 对上的那一条，其次 `isCurrent:true` 的兜底。 */
function pickTermName(term) {
  const terms = Array.isArray(term?.terms) ? term.terms : [];
  const currentId = typeof term?.currentId === 'string' ? term.currentId : '';
  const byId = currentId === '' ? null : terms.find((item) => item?.id === currentId);
  const fallback = terms.find((item) => item?.isCurrent === true);
  const picked = byId ?? fallback ?? null;
  return picked === null ? '' : personaText(picked.name, TERM_MAX);
}

/** 取在学课程名（去重、去空、最多 6 个，其余折成「等 N 门」）。 */
function pickCourseNames(courses) {
  const list = Array.isArray(courses?.courses) ? courses.courses : [];
  const names = [];
  for (const item of list) {
    const name = personaText(item?.name, COURSE_MAX);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 统计掌握度分布：只数「学过及以上」（mastery ≥ 1），未学不计入「已完成学习」。 */
function countMastery(nodes) {
  const counts = [0, 0, 0, 0];
  for (const item of nodes) {
    const level = clampMastery(item?.mastery);
    if (level >= 1) counts[level] += 1;
  }
  return {
    total: counts[1] + counts[2] + counts[3],
    studied: counts[1],
    skilled: counts[2],
    mastered: counts[3],
  };
}

/** 找当前节点：优先请求里的 `context.nodeId`；找不到就返回 null（不脑补标题）。 */
function findContextNode(nodes, context) {
  const nodeId = typeof context?.nodeId === 'string' ? context.nodeId : '';
  if (nodeId === '') return null;
  const node = nodes.find((item) => item !== null && typeof item === 'object' && item.id === nodeId);
  if (node === undefined) return null;
  return { node, nodeId };
}

/** 该节点挂在 `kp:<nodeId>` 虚拟文件上的批注：数量 + 最近一条的类型/短摘要。 */
function collectNodeAnnotations(annotations, nodeId) {
  const notes = Array.isArray(annotations?.notes) ? annotations.notes : [];
  const file = `kp:${nodeId}`;
  const own = notes.filter((item) => item !== null && typeof item === 'object' && item.file === file);
  if (own.length === 0) return null;
  const sorted = own.slice().sort((left, right) => {
    const leftAt = String(left?.updatedAt ?? left?.createdAt ?? '');
    const rightAt = String(right?.updatedAt ?? right?.createdAt ?? '');
    return rightAt.localeCompare(leftAt);
  });
  const latest = sorted[0];
  const type = typeof latest?.type === 'string' ? latest.type : '';
  return {
    count: own.length,
    typeLabel: ANNOTATION_TYPE_LABELS[type] ?? '',
    excerpt: personaText(latest?.content, EXCERPT_MAX),
  };
}

/**
 * 拼「当前知识点」那一行；节点不存在时返回空串。
 *
 * 形如：`当前知识点：「电荷守恒…」— 掌握等级 学过（1/3），累计学习 12 分钟，最近 2026-11-21 学，批注 2 条（最近：高亮）。`
 */
function buildNodeLine(node, nodeId, behavior, annotations) {
  const name = personaText(node?.name, NODE_MAX);
  if (name === '') return '';
  const level = clampMastery(node?.mastery);
  const label = MASTERY_LABELS[level] ?? MASTERY_LABELS[0];
  const segments = [`掌握等级 ${label}（${level}/3）`];

  const records = behavior?.nodes !== null && typeof behavior?.nodes === 'object' ? behavior.nodes : {};
  const record = nodeId !== '' && records !== null && typeof records[nodeId] === 'object' ? records[nodeId] : null;
  const minutes = Number(record?.totalMinutes);
  if (Number.isFinite(minutes) && minutes > 0) segments.push(`累计学习 ${Math.round(minutes)} 分钟`);
  const day = personaDay(record?.lastLearnedAt);
  if (day !== '') segments.push(`最近 ${day} 学`);

  const ownNotes = collectNodeAnnotations(annotations, nodeId);
  if (ownNotes !== null) {
    let noteText = `批注 ${ownNotes.count} 条`;
    const extras = [ownNotes.typeLabel, ownNotes.excerpt].filter((item) => item !== '');
    if (extras.length > 0) noteText += `（最近：${extras.join(' · ')}）`;
    segments.push(noteText);
  }

  return `当前知识点：「${name}」— ${segments.join('，')}。`;
}

/**
 * 拼整段画像；无身份或无任何可用数据时返回空串。
 *
 * @param {{studentName?: string, studentId?: string, term?: object, courses?: object,
 *   behavior?: object, network?: object, annotations?: object, context?: object}} input
 * @returns {string} 以 `【用户画像】` 开头的多行文本（≤ `PERSONA_MAX_CHARS` 字），或空串
 */
export function buildPersonaHint(input) {
  if (input === null || typeof input !== 'object') return '';
  const studentName = personaText(input.studentName, NAME_MAX);
  if (studentName === '') return '';

  const termName = pickTermName(input.term);
  const courseNames = pickCourseNames(input.courses);
  const nodes = Array.isArray(input.network?.nodes) ? input.network.nodes : [];
  const distribution = countMastery(nodes);
  const currentNode = findContextNode(nodes, input.context);
  const nodeLine = currentNode === null
    ? ''
    : buildNodeLine(currentNode.node, currentNode.nodeId, input.behavior, input.annotations);

  // 只有姓名、其余全空 → 不注入（保证「空数据与现状逐字一致」）
  if (termName === '' && courseNames.length === 0 && distribution.total === 0 && nodeLine === '') return '';

  const lines = [];
  const identity = `【用户画像】你是${studentName}（学号已隐去）`;
  lines.push(termName === '' ? `${identity}。` : `${identity}，当前学期「${termName}」。`);

  if (courseNames.length > 0) {
    const shown = courseNames.slice(0, MAX_COURSE_NAMES).join('、');
    const suffix = courseNames.length > MAX_COURSE_NAMES ? ` 等 ${courseNames.length} 门` : '';
    lines.push(`在学课程：${shown}${suffix}。`);
  }

  if (distribution.total === 0) {
    lines.push('整体掌握：还没有标记为学过的知识点。');
  } else {
    lines.push(
      `整体掌握：已完成学习 ${distribution.total} 个知识点，其中 精通 ${distribution.mastered} / `
      + `熟练 ${distribution.skilled} / 学过 ${distribution.studied}。`,
    );
  }

  if (nodeLine !== '') lines.push(nodeLine);
  // 最后一行是给模型的用法约束：画像只用来贴合回答，绝不向用户复述
  lines.push('（画像只用于让回答贴合用户，不要向对方复述，也不要提学号。）');

  const text = lines.join('\n');
  const chars = Array.from(text);
  if (chars.length <= PERSONA_MAX_CHARS) return text;
  return `${chars.slice(0, PERSONA_MAX_CHARS - 1).join('')}…`;
}

/**
 * 专注学习模式的固定人设（v2-E 卡 §4.3，2026-11-22）。
 *
 * 只在专注学习模式（`context.studyMode === true`）下注入；普通浮层答疑**不套** ——
 * 「学长讲课」的口气放在日常问答里会显得端着，也没必要。
 * 文案照卡定稿，改口径请先改卡；总长固定，不随数据变化。
 */
export const STUDY_TUTOR_PERSONA = [
  '【身份】你是这位学生的「学习搭子」——一位比 TA 高一两届、学得扎实又耐心的学长/学姐。',
  '【怎么讲】说人话，不堆术语；遇到抽象概念先用直觉和生活中的比方讲清楚，再给必要的推导和公式。',
  '【语气】鼓励式、不居高临下；学生卡住时先肯定再点拨，不打击。',
  '【收尾】每次讲完，用一句话给一个 TA 马上能做的小动作（比如「先自己默一遍这条守恒式的三个量」）。',
  '【边界】只围绕课程学习答疑；不编造教材没有的内容，拿不准就说不确定。',
].join('\n');

/**
 * 专注学习模式人设开关（纯函数，不读盘、不取时间）。
 *
 * @param {unknown} context `/assistant/reply` 请求体里的可选 `context`
 * @returns {string} `context.studyMode === true` 时返回 {@link STUDY_TUTOR_PERSONA}，否则空串
 */
export function buildStudyModePersona(context) {
  if (context === null || typeof context !== 'object') return '';
  return context.studyMode === true ? STUDY_TUTOR_PERSONA : '';
}
