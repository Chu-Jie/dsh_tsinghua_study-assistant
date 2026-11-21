/**
 * 掌握度自动计算 + 学习行为口径（v2-B 卡，2026-11-20）。
 *
 * 这个模块**纯**：不读盘、不写盘、不取 `new Date()`、不打日志。
 * 时间一律由调用方以 ISO 字符串传进来，所以每一行都能拿合成数据单测。
 *
 * 三件事分清楚（最容易混淆的地方，见任务卡 ②）：
 *   1. **行为**（打开几次、什么时候学的、累计多久）存在 `学习行为.json`（第 16 份文档）；
 *   2. **等级**（0 未学 / 1 学过 / 2 熟练 / 3 精通）**只**写 `知识点网络.json` 的 `mastery` ——
 *      面板、章节统计、复习提醒、导出的都是那一份，这里绝不另造第二套真源；
 *   3. **谁说了算**：人改的（面板点、经聊天确认）记 `masterySource: 'manual'`，算法一律跳过；
 *      算法算的记 `auto`，下一次算法还能继续推进。**不自动降级**，只会往上补。
 */

import {
  LEARNING_BEHAVIOR_DEFAULT_SOURCE,
  LEARNING_BEHAVIOR_SOURCES,
  isPlainObject,
} from './core.js';

// ---------------------------------------------------------------------------
// 阈值与权重：要调口径只改这一段（写成具名常量就是为了「可调 + 可单测」）
// ---------------------------------------------------------------------------

/** 等级上限（用户 2026-10-20 定的四档：0 未学 / 1 学过 / 2 熟练 / 3 精通）。 */
export const MASTERY_MAX = 3;
/** 等级下限。 */
export const MASTERY_MIN = 0;
/** 后端用的等级文案；前端 `client.full.js` 的 `MASTERY_LABELS` 是同一套说法（两边都改才一致）。 */
export const MASTERY_LABELS = ['未学', '学过', '熟练', '精通'];

/** 打开过（visitCount）加分：+1。 */
export const VISIT_BONUS = 1;
/** 有 `learned` 批注加分：+1。 */
export const LEARNED_BONUS = 1;
/** 累计时长够久加分：+1（第二步做真停留计时后才可能触发；这一步 totalMinutes 恒 0）。 */
export const MINUTES_BONUS = 1;

/** 触发「访问 +1」所需的最小打开次数（1 = 打开过就算）。 */
export const MIN_VISITS_FOR_ADVANCE = 1;
/** 触发「批注 +1」所需的 learned 批注条数（1 = 有一条就算）。 */
export const MIN_LEARNED_FOR_ADVANCE = 1;
/** 触发「时长 +1」所需的最短累计分钟（30 分钟）。 */
export const MINUTES_FOR_ADVANCE = 30;

/** 同一条行为记录里，两次「打开」落在同一分钟内只算一次（见 recordVisit）。 */
export const VISIT_DEDUPE_GRANULARITY = 'minute';

// ---------------------------------------------------------------------------
// 行为记录（`学习行为.json` 的单个节点）
// ---------------------------------------------------------------------------

/**
 * 一条空行为。**没有记录的节点**就用它参与计算 —— 所以「没学过」不是靠缺字段判断，
 * 而是靠这里给出的 0 次 / 0 分钟 / auto。
 */
export function emptyBehavior() {
  return {
    firstLearnedAt: null,
    lastLearnedAt: null,
    visitCount: 0,
    totalMinutes: 0,
    masterySource: LEARNING_BEHAVIOR_DEFAULT_SOURCE,
    masteryUpdatedAt: null,
  };
}

/** 等级归一到 0–3 的整数；越界/非整数/非数字一律当 0（与 `lib/kp-notes-export.js` 的先例一致）。
 *
 * 刻意**不做字符串强转**（`'2'` → 0）：等级只该是磁盘上的数字，字符串一律当脏数据，
 * 宁可显示成「未学」也不要猜成「熟练」。
 */
export function clampMastery(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MASTERY_MIN || value > MASTERY_MAX) {
    return MASTERY_MIN;
  }
  return value;
}

/** 等级 → 中文文案（拿不到就按「未学」说，别让界面出现 undefined）。 */
export function masteryLabel(level) {
  return MASTERY_LABELS[clampMastery(level)] ?? MASTERY_LABELS[0];
}

/**
 * 把磁盘上读到的行为记录归一成完整六字段。
 *
 * 宽容但不脑补：缺字段补默认值、类型不对也退回默认值；**不知道的一律不编**。
 * 这个函数只处理「单条记录」，编排与整份文档的校验在 `core.js` 的 `validateDoc`。
 */
export function normalizeBehavior(raw) {
  const base = emptyBehavior();
  if (!isPlainObject(raw)) return base;
  const isoText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const count = Number(raw.visitCount);
  const minutes = Number(raw.totalMinutes);
  return {
    firstLearnedAt: isoText(raw.firstLearnedAt),
    lastLearnedAt: isoText(raw.lastLearnedAt),
    visitCount: Number.isInteger(count) && count >= 0 ? count : 0,
    totalMinutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : 0,
    masterySource: LEARNING_BEHAVIOR_SOURCES.includes(raw.masterySource) ? raw.masterySource : base.masterySource,
    masteryUpdatedAt: isoText(raw.masteryUpdatedAt),
  };
}

/** 从整份 `学习行为.json` 里取某节点的行为（没有就是空行为）。 */
export function behaviorOf(behaviorDoc, nodeId) {
  const nodes = isPlainObject(behaviorDoc?.nodes) ? behaviorDoc.nodes : {};
  return normalizeBehavior(nodes[nodeId]);
}

/** ISO 字符串截到分钟（`2026-11-20T09:31:07.123Z` → `2026-11-20T09:31`），用于「同一分钟去重」。 */
export function minuteStamp(isoText) {
  const text = typeof isoText === 'string' ? isoText.trim() : '';
  return text.length >= 16 ? text.slice(0, 16) : '';
}

/**
 * 记一次「打开知识点」。
 *
 * 约定（任务卡 ⑥ 前端一节「节流」二选一，这里选了**后端按分钟去重**）：
 *   - 第一次：`firstLearnedAt = now`、`lastLearnedAt = now`、`visitCount + 1`；
 *   - 同一分钟内重复上报：**不计数**（`counted:false`），也不改时间，防前端一次打开连发几次把次数刷上去；
 *   - `totalMinutes` 不动（这一步不测停留时长，第二步的结算函数才会写它）。
 *
 * @param {object|null} behavior 现有行为记录（可为空）
 * @param {string} nowIso 本次访问时刻（ISO 字符串，调用方给）
 * @returns {{behavior: object, counted: boolean, reason?: string}}
 */
export function recordVisit(behavior, nowIso) {
  const base = normalizeBehavior(behavior);
  const now = typeof nowIso === 'string' ? nowIso.trim() : '';
  if (now === '') return { behavior: base, counted: false, reason: 'bad-now' };
  if (base.lastLearnedAt !== null && minuteStamp(base.lastLearnedAt) === minuteStamp(now)) {
    return { behavior: base, counted: false, reason: 'same-minute' };
  }
  return {
    behavior: {
      ...base,
      firstLearnedAt: base.firstLearnedAt ?? now,
      lastLearnedAt: now,
      visitCount: base.visitCount + 1,
    },
    counted: true,
  };
}

/**
 * 第二步（停留时长埋点）的结算函数**签名占位**，本卡不实现。
 *
 * 之所以先放一个会返回原值、且只加 0 分钟的函数，是为了让第二步只需要改这里一处，
 * 而不是回头去动 api 的写盘逻辑。**不要**用它凑出非零时长 —— 没有真实计时就是 0。
 *
 * @param {object|null} behavior
 * @param {number} _minutes 真实计时得到的分钟数（第二步才会有 >0 的值）
 * @returns {{behavior: object, added: number}}
 */
export function settleStayMinutes(behavior, _minutes) {
  const base = normalizeBehavior(behavior);
  return { behavior: base, added: 0 };
}

// ---------------------------------------------------------------------------
// 掌握度算法
// ---------------------------------------------------------------------------

/**
 * 由一个节点的行为 + 学过的证据 + 当前等级，算出**建议等级**。
 *
 * 计分（0 起加）：
 *   - 打开过（`visitCount ≥ MIN_VISITS_FOR_ADVANCE`）              → +VISIT_BONUS（1）
 *   - 有 `learned` 批注（条数 ≥ MIN_LEARNED_FOR_ADVANCE）          → +LEARNED_BONUS（1）
 *   - 累计时长 ≥ MINUTES_FOR_ADVANCE（30 分钟）                    → +MINUTES_BONUS（1）
 * 封顶 3、封底 0。
 *
 * 两条「人说了算」的规矩（任务卡 ⑤ / ⑪）：
 *   1. `masterySource === 'manual'` → **直接返回 currentMastery**，一点不算（人改的永远不被冲掉）；
 *   2. **不自动降级** → 返回 `max(currentMastery, 分数)`。所以老数据里手动标过的 2/3 档，
 *      哪怕一个行为都没有，也不会被算成 0。
 *
 * @param {object|null} behavior 行为记录（缺省按空行为算）
 * @param {number|Array} learnedAnnotations learned 批注条数（也容忍直接传批注数组）
 * @param {number} currentMastery 当前等级（0–3）
 * @returns {number} 0–3 的建议等级
 */
export function suggestMastery(behavior, learnedAnnotations, currentMastery) {
  const record = normalizeBehavior(behavior);
  const current = clampMastery(currentMastery);
  // 人改过的：原值返回，不参与计算
  if (record.masterySource === 'manual') return current;

  const learnedCount = Array.isArray(learnedAnnotations)
    ? learnedAnnotations.length
    : Number(learnedAnnotations);
  const learned = Number.isFinite(learnedCount) ? learnedCount : 0;

  let score = 0;
  if (record.visitCount >= MIN_VISITS_FOR_ADVANCE) score += VISIT_BONUS;
  if (learned >= MIN_LEARNED_FOR_ADVANCE) score += LEARNED_BONUS;
  if (record.totalMinutes >= MINUTES_FOR_ADVANCE) score += MINUTES_BONUS;

  const clamped = Math.min(MASTERY_MAX, Math.max(MASTERY_MIN, score));
  return Math.max(current, clamped);
}

/** 一份文件是不是「讲义」md（`.../讲义/....md`）。 */
function isLectureFile(file) {
  const text = String(file ?? '');
  return /(^|\/)讲义\//.test(text) && text.toLowerCase().endsWith('.md');
}

/**
 * 统计每个知识点的「学过证据」条数。
 *
 * 两种来源（任务卡 ⑤）：
 *   1. 批注 `file === 'kp:<nodeId>'` —— 知识点虚拟文件上的 learned 标记（现在真实数据就是这个形态）；
 *   2. 落在**该知识点讲义文件**上的 learned 标记 —— 归属靠节点自己的 `evidence[].file`：
 *      节点证据里明确引用了这份讲义 md，才算「这个点的讲义」。一个节点都没引用过它就不算，
 *      宁可少算也不乱算（不脑补归属）。
 * 另外容忍批注自带显式 `nodeId`（将来前端若带上就直接可用，不必再解析 file）。
 *
 * @param {object} networkDoc `知识点网络.json`
 * @param {object} annotationsDoc `批注.json`
 * @returns {Map<string, number>} nodeId → 条数（没有的节点不在 map 里）
 */
export function collectLearnedEvidence(networkDoc, annotationsDoc) {
  const counts = new Map();
  const bump = (nodeId) => counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);

  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  const knownIds = new Set();
  const lectureOwners = new Map(); // 讲义文件 → 引用它的 nodeId 集合
  for (const node of nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || node.id === '') continue;
    knownIds.add(node.id);
    for (const evidence of Array.isArray(node.evidence) ? node.evidence : []) {
      const file = typeof evidence?.file === 'string' ? evidence.file.replace(/\\/g, '/').trim() : '';
      if (file === '' || !isLectureFile(file)) continue;
      if (!lectureOwners.has(file)) lectureOwners.set(file, new Set());
      lectureOwners.get(file).add(node.id);
    }
  }

  const notes = Array.isArray(annotationsDoc?.notes) ? annotationsDoc.notes : [];
  for (const note of notes) {
    if (!isPlainObject(note) || note.markKind !== 'learned') continue;
    const file = typeof note.file === 'string' ? note.file.replace(/\\/g, '/').trim() : '';
    if (file.startsWith('kp:')) {
      const nodeId = file.slice('kp:'.length).trim();
      if (knownIds.has(nodeId)) bump(nodeId);
      continue;
    }
    const owners = lectureOwners.get(file);
    if (owners !== undefined) {
      for (const nodeId of owners) bump(nodeId);
      continue;
    }
    if (typeof note.nodeId === 'string' && knownIds.has(note.nodeId)) bump(note.nodeId);
  }
  return counts;
}

/**
 * 把「建议等级」批量落到知识网络文档上（**纯**：返回新文档 + 变更清单，不做 IO）。
 *
 * 只改三样东西：该节点的 `mastery`、它变了之后的 `reviewedAt`（沿用 `normalizeKnowledgeNode`
 * 的口径「变了才刷」）、以及 nodes 数组本身。其余字段（name/evidence/chapter/…）原样带过去。
 *
 * @param {object} networkDoc
 * @param {object} behaviorDoc
 * @param {object} annotationsDoc
 * @param {{nowIso?: string}} [options] `nowIso` 给了才刷 `reviewedAt`；不给就保留旧值（便于测）
 * @returns {{network: object, changes: Array<{nodeId: string, name: string, from: number, to: number}>}}
 */
export function applySuggestedMastery(networkDoc, behaviorDoc, annotationsDoc, options = {}) {
  const nowIso = typeof options.nowIso === 'string' && options.nowIso.trim() !== '' ? options.nowIso.trim() : null;
  const evidence = collectLearnedEvidence(networkDoc, annotationsDoc);
  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  const changes = [];

  const nextNodes = nodes.map((node) => {
    if (!isPlainObject(node)) return node;
    const current = clampMastery(node.mastery);
    const suggested = suggestMastery(behaviorOf(behaviorDoc, node.id), evidence.get(node.id) ?? 0, current);
    // 不降级：建议 ≤ 现状就一个字节都不动（也就不会白写盘、白留备份）
    if (suggested <= current) return node;
    changes.push({ nodeId: node.id, name: typeof node.name === 'string' ? node.name : '', from: current, to: suggested });
    return {
      ...node,
      mastery: suggested,
      reviewedAt: nowIso ?? node.reviewedAt ?? null,
    };
  });

  return { network: { ...networkDoc, nodes: nextNodes }, changes };
}

// ---------------------------------------------------------------------------
// 「经聊天改掌握度」的意图解析（只解析，**绝不写库**）
// ---------------------------------------------------------------------------

/** 「设为某个等级」的动词。必须出现在等级词之前，才算一句命令。 */
const SET_VERBS = [
  '设为', '设成', '设置成', '设置', '改成', '改为', '改到',
  '调成', '调到', '标记为', '标为', '标成', '定为', '定成',
  '弄成', '弄到', '写成', '记成', '变成',
];

/**
 * 等级词 → 等级。**长的写在前面**，且匹配时按「出现位置最靠右、同位置取更长」取，
 * 所以「没学过」不会被「学过」抢先命中，而「我已经学过了，想标成精通」会取到后面的「精通」。
 */
const LEVEL_WORDS = [
  [0, ['未学过', '没有学过', '没学过', '未学', '没学', '还没学', '零基础']],
  [1, ['学过了', '学过', '看过', '粗学过']],
  [2, ['比较熟练', '很熟练', '熟练', '熟悉']],
  [3, ['完全掌握', '已精通', '精通', '掌握', '全会']],
];

/** 「设为 3 / 改成 2」这种数字写法。 */
const NUMERIC_LEVEL = /(?:设为|设成|设置成|改成|改为|改到|调成|调到|标记为|标为|标成|定为|定成|弄成|弄到)\s*(?:等级|掌握度)?\s*(?:为|到|成)?\s*([0-3])(?!\d)/;
/** 「掌握度 3」这种省掉动词的写法。 */
const LOOSE_NUMERIC_LEVEL = /掌握度\s*(?:改成|设为|调成|改为|调到|到|为|=)?\s*([0-3])(?!\d)/;

/**
 * 从一句话里读出目标等级（**单点与批量共用这一份口径**，v2-B2 卡）。
 *
 * 顺序与 v2-B 完全一致：先数字写法（「改成 2」），再中文档位（取「最靠右、同位置更长」），
 * 中文档位还要求动词在它前面 —— 否则「精通怎么学」这种提问会被当成命令。
 *
 * @returns {{ok: true, level: number} | {ok: false, reason: 'no-level'|'no-command'}}
 */
function readCommandLevel(message) {
  const numeric = NUMERIC_LEVEL.exec(message) ?? LOOSE_NUMERIC_LEVEL.exec(message);
  if (numeric !== null) return { ok: true, level: clampMastery(Number(numeric[1])) };

  // 取「最靠右、同位置更长」的档位词
  let best = null;
  for (const [value, words] of LEVEL_WORDS) {
    for (const word of words) {
      const at = message.lastIndexOf(word);
      if (at < 0) continue;
      const end = at + word.length;
      if (best === null || end > best.end || (end === best.end && word.length > best.word.length)) {
        best = { level: value, word, end };
      }
    }
  }
  if (best === null) return { ok: false, reason: 'no-level' };

  // 中文档位也必须配一个「设/改/调…」动词，且动词在档位词前面
  const verbAt = SET_VERBS
    .map((verb) => message.indexOf(verb))
    .filter((at) => at >= 0 && at < message.lastIndexOf(best.word))
    .sort((left, right) => left - right)[0];
  if (verbAt === undefined) return { ok: false, reason: 'no-command' };
  return { ok: true, level: best.level };
}

/** 文本里出现「设/改/调…」这类动词 + 等级词，就算一句命令（用于区分提问与命令）。 */
export function looksLikeMasteryCommand(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim() === '') return false;
  if (NUMERIC_LEVEL.test(value) || LOOSE_NUMERIC_LEVEL.test(value)) return true;
  let levelIndex = -1;
  for (const [, words] of LEVEL_WORDS) {
    for (const word of words) {
      const at = value.lastIndexOf(word);
      if (at >= 0) levelIndex = Math.max(levelIndex, at);
    }
  }
  if (levelIndex < 0) return false;
  return SET_VERBS.some((verb) => value.indexOf(verb) >= 0 && value.indexOf(verb) < levelIndex);
}

/** 在知识点网络里按名字/别名找被提到的那一个（取最长命中，同名多义时把候选全返回）。 */
function findMentionedNodes(text, networkDoc) {
  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  const hits = new Map(); // nodeId → { nodeId, name, length }
  for (const node of nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string') continue;
    const names = [node.name, ...(Array.isArray(node.aliases) ? node.aliases : [])];
    for (const raw of names) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      // 单字名太容易误命中（「力」「电」「和」），一律不认
      if (name.length < 2) continue;
      if (!text.includes(name)) continue;
      const previous = hits.get(node.id);
      if (previous === undefined || name.length > previous.length) {
        hits.set(node.id, {
          nodeId: node.id,
          name: typeof node.name === 'string' ? node.name : name,
          chapter: typeof node.chapter === 'string' ? node.chapter : '',
          length: name.length,
        });
      }
    }
  }
  let longest = 0;
  for (const hit of hits.values()) longest = Math.max(longest, hit.length);
  // 短名常常是最长名的子串（「偶极子」⊂「电偶极子」），只留最长那批
  return [...hits.values()].filter((hit) => hit.length === longest);
}

/**
 * 解析一句「把 X 设为 Y」的掌握度命令。
 *
 * **只解析，不写库**：调用方拿到 `ok:true` 后必须先回预览、等用户确认，才允许调写路由
 * （任务卡 ② / ⑤ 的红线：预览与落库必须分成两步）。
 *
 * 命中顺序：
 *   1. 等级：先认数字写法（「改成 2」），再认中文档位（「精通」）；
 *   2. 节点：按名字/别名在消息里找最长命中；一个都找不到时，才退回 `options.nodeId`
 *      （= 用户当前在知识页选中的那个点，v2-A 界面上下文带过来的）。
 *
 * @param {string} text 用户这一句原话
 * @param {object} networkDoc `知识点网络.json`
 * @param {{nodeId?: string|null}} [options]
 * @returns {{ok: true, level: number, nodeId: string, nodeName: string}
 *          | {ok: false, reason: 'no-level'|'no-command'|'no-node'|'ambiguous'|'network-unavailable', candidates?: Array}}
 */
export function parseMasteryIntent(text, networkDoc, options = {}) {
  const message = typeof text === 'string' ? text : '';
  if (message.trim() === '') return { ok: false, reason: 'no-command' };

  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  if (nodes.length === 0) return { ok: false, reason: 'network-unavailable' };

  // 1) 等级（单点与批量共用同一份口径，见 readCommandLevel）
  const levelResult = readCommandLevel(message);
  if (levelResult.ok !== true) return levelResult;
  const level = levelResult.level;

  // 2) 节点：先按名字找
  const mentioned = findMentionedNodes(message, networkDoc);
  if (mentioned.length === 1) {
    return { ok: true, level, nodeId: mentioned[0].nodeId, nodeName: mentioned[0].name };
  }
  if (mentioned.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: mentioned.slice(0, 5).map((hit) => ({ nodeId: hit.nodeId, name: hit.name, chapter: hit.chapter })),
    };
  }

  // 3) 没点名才用「当前选中的那个点」
  const fallbackId = typeof options.nodeId === 'string' && options.nodeId !== '' ? options.nodeId : null;
  if (fallbackId !== null) {
    const node = nodes.find((item) => isPlainObject(item) && item.id === fallbackId);
    if (node !== undefined) {
      return { ok: true, level, nodeId: node.id, nodeName: typeof node.name === 'string' ? node.name : '' };
    }
  }
  return { ok: false, reason: 'no-node' };
}

/**
 * 预览话术（「将把「X」掌握度从 2（熟练）改为 3（精通），确认吗？」）。
 *
 * 单独抽出来是为了让 api 与测试说同一句话 —— 用户看到的文案和回执里引用的文案必须是同一份。
 */
export function describeMasteryPreview(nodeName, from, to) {
  const before = clampMastery(from);
  const after = clampMastery(to);
  const name = typeof nodeName === 'string' && nodeName.trim() !== '' ? nodeName.trim() : '这个知识点';
  return `将把「${name}」掌握度从 ${before}（${masteryLabel(before)}）改为 ${after}（${masteryLabel(after)}），确认吗？`;
}

// ---------------------------------------------------------------------------
// 「同理」继承 + 范围批量改（v2-B2 卡，2026-11-21）
//
// 这一段同样只做**解析与算清单**：不读盘、不写盘、不自己取 new Date()（时间由调用方传）。
//   - 「同理」= 继承**上一条**掌握度命令的「等级 + 目标范围」，它自己不含等级、不含点名；
//   - 「今天学过的」= 按 `学习行为.json` 的 `lastLearnedAt`（**本地时区**的今天）+ `visitCount ≥ 1` 筛；
//   - 「某一整章」= 按 `知识点网络.json` 的 `chapter` 筛，跨课程同号章报 ambiguous 让人说清。
// 三者的落库都只走 `/assistant/mastery-batch`，且必须带 `confirm: true`（见 lib/api.js）。
// ---------------------------------------------------------------------------

/** 「同理」类触发词：整句恰为其一才算（卡 5.1「宁严勿宽」）。 */
export const INHERIT_WORDS = ['同理', '同上', '也一样', '这个也', '那个也', '同样', '一样'];

/** 句末标点：判定「整句就是这个词」之前先剔掉（「同理。」「同上！」都算）。 */
const EDGE_PUNCT = /[。．.！!？?~～、,，;；:：]+$/;

/** 判定用的紧凑文本：去所有空白 + 去句末标点。 */
function compactCommand(text) {
  const value = typeof text === 'string' ? text : '';
  return value.replace(/\s+/g, '').replace(EDGE_PUNCT, '');
}

/**
 * 这句话是不是「光秃秃的同理」。
 *
 * **只认整句**：`同理心是什么意思`、`同理，第 3 章讲什么` 都不算 —— 前者是提问，后者自带目标，
 * 交给单点解析或模型更安全。这条也是卡 ② 说的落点：「同理」单独解析必然没有等级、没有目标，
 * 只把 `looksLikeMasteryCommand` 改宽是没用的，必须靠 `resolveInheritedCommand` 回看历史。
 */
export function looksLikeInheritCommand(text) {
  const compact = compactCommand(text);
  if (compact === '') return false;
  return INHERIT_WORDS.includes(compact);
}

/** 「今天学过的」的两个必要成分：时间词 + 学过词，缺一不可。 */
const TODAY_WORDS = ['今天', '今日'];
const LEARNED_HINTS = ['学过的', '学过', '学习的', '学习过', '有学习记录', '看过'];

/** 「一整章」的口径词：说了整章却没说是哪一章时给提示，不瞎猜一章。 */
const WHOLE_CHAPTER_WORDS = ['一整章', '整章', '这一章', '这章', '全章'];

/** 「第N章」：阿拉伯数字与中文数字都认（真机数据里「第12章」「第 2 章」「第十二章」三种写法都有）。 */
const CHAPTER_NO_SOURCE = '第([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})章';
const CHAPTER_NO_RE = new RegExp(CHAPTER_NO_SOURCE);

/** 中文数字 → 阿拉伯数字（只处理章节号这种 1–99 的小数，够用且好测）。 */
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function chapterNumber(token) {
  if (/^[0-9]+$/.test(token)) return Number(token);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const ch of token) {
    if (CN_DIGITS[ch] !== undefined) { current = CN_DIGITS[ch]; seen = true; continue; }
    if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; seen = true; continue; }
    return null;
  }
  return seen ? total + current : null;
}

/** 章节名归一：去掉所有空白再比（真机同一章可能写成「第2章 …」与「第 2 章 …」两份）。 */
function normalizeChapter(chapter) {
  return String(chapter ?? '').replace(/\s+/g, '');
}

/** courseId → 课名；认不出就原样回 courseId（候选清单里总得有个能认的标签）。 */
function courseNameOf(courseId, courses) {
  for (const course of Array.isArray(courses) ? courses : []) {
    if (isPlainObject(course) && course.id === courseId && typeof course.name === 'string') return course.name;
  }
  return typeof courseId === 'string' ? courseId : '';
}

/** 一句话里提到的课程（课名 / 简称 / 去掉括号后缀的课名）→ courseId；认不出就是 null。 */
function mentionedCourseId(compactText, courses) {
  for (const course of Array.isArray(courses) ? courses : []) {
    if (!isPlainObject(course) || typeof course.id !== 'string') continue;
    const tokens = [course.name, course.shortName]
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.replace(/\s+/g, ''));
    // 「大学物理B(2)」这种带括号的：用户一般只说「大学物理B」，去括号后再比一次
    for (const token of tokens.slice()) {
      const stripped = token.replace(/[（(].*$/, '');
      if (stripped.length >= 2 && stripped !== token) tokens.push(stripped);
    }
    if (tokens.some((token) => token.length >= 2 && compactText.includes(token))) return course.id;
  }
  return null;
}

/** 把节点的 `chapter` 归并成「章」的候选组（同一章在不同课里是不同组）。 */
function chapterGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string') continue;
    const chapter = normalizeChapter(node.chapter);
    if (chapter === '') continue;
    const courseId = typeof node.courseId === 'string' ? node.courseId : '';
    const key = `${chapter}\u0000${courseId}`;
    let group = groups.get(key);
    if (group === undefined) {
      const match = CHAPTER_NO_RE.exec(chapter);
      group = {
        chapter,
        // 展示用原文（保留真机里那点空格，回话才是用户看到的名字）
        raw: String(node.chapter),
        courseId,
        number: match === null ? null : chapterNumber(match[1]),
        // 「第12章 静电场」→「静电场」；只有章号没有标题的（「第5章」）→ ''
        title: match === null ? '' : chapter.slice(match[0].length),
        nodeIds: [],
      };
      groups.set(key, group);
    }
    group.nodeIds.push(node.id);
  }
  return [...groups.values()];
}

/**
 * 「一整章」指的是哪一章（只解析，不筛节点）。
 *
 * 收窄顺序：章号（第3章 / 第三章）→ 章名（静电场）→ 课名（数字电子技术基础）。
 * 只认**能落到具体某章**的引用；只剩一个候选就是它，多个候选一律 ambiguous（不瞎挑）。
 */
function findChapterRef(text, networkDoc, options = {}) {
  const compact = String(text ?? '').replace(/\s+/g, '');
  const groups = chapterGroups(Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : []);
  if (groups.length === 0) return { kind: 'none' };

  const wantsWhole = WHOLE_CHAPTER_WORDS.some((word) => compact.includes(word));

  const numbers = [];
  const scanner = new RegExp(CHAPTER_NO_SOURCE, 'g');
  let match = scanner.exec(compact);
  while (match !== null) {
    const number = chapterNumber(match[1]);
    if (number !== null) numbers.push(number);
    match = scanner.exec(compact);
  }

  let picked = groups;
  if (numbers.length > 0) {
    const number = numbers[numbers.length - 1];
    picked = picked.filter((group) => group.number === number);
    if (picked.length === 0) return { kind: 'missing' };
  } else {
    // 没写章号：只按「章名」收窄；名字太短的不认（避免「图」这种单字把整句误判成某一章）
    const byTitle = groups.filter((group) => group.title.length >= 2 && compact.includes(group.title));
    if (byTitle.length === 0) return { kind: wantsWhole ? 'missing' : 'none' };
    picked = byTitle;
  }

  // 写了章号又写了章名的（「第12章静电场」）：再收窄一层，别把「第12章 排序」也算进来
  const byTitle = picked.filter((group) => group.title.length >= 2 && compact.includes(group.title));
  if (byTitle.length > 0) picked = byTitle;

  const courseId = mentionedCourseId(compact, options.courses);
  if (courseId !== null) picked = picked.filter((group) => group.courseId === courseId);
  if (picked.length === 0) return { kind: 'missing' };

  if (picked.length === 1) {
    const group = picked[0];
    return {
      kind: 'found',
      chapter: group.chapter,
      courseId: group.courseId === '' ? null : group.courseId,
      label: group.raw,
      nodeCount: group.nodeIds.length,
    };
  }
  return {
    kind: 'ambiguous',
    candidates: picked.slice(0, 5).map((group) => ({
      chapter: group.raw,
      courseId: group.courseId,
      courseName: courseNameOf(group.courseId, options.courses),
      nodeCount: group.nodeIds.length,
    })),
  };
}

/**
 * 这句是不是「范围批量」命令（**只做粗筛，不读盘**）：给 api 一个便宜的分流判断。
 * 精确解析（哪一章、今天筛出谁）在 `parseMasteryBatchScope` / `collectBatchTargets`。
 */
export function looksLikeMasteryBatchCommand(text) {
  const message = typeof text === 'string' ? text : '';
  if (!looksLikeMasteryCommand(message)) return false;
  const compact = message.replace(/\s+/g, '');
  const today = TODAY_WORDS.some((word) => compact.includes(word))
    && LEARNED_HINTS.some((word) => compact.includes(word));
  const chapter = CHAPTER_NO_RE.test(compact) || WHOLE_CHAPTER_WORDS.some((word) => compact.includes(word));
  return today || chapter;
}

/**
 * 把一句话解析成「批量范围 + 等级」（**只解析，不筛节点、不写库**）。
 *
 * 返回的 `scope` 是**范围定义**（`kind: 'today'` 或 `kind: 'chapter'` + 章名/课），
 * 不是上次那个 nodeId 快照 —— 这样「同理」继承批量时按**当前**重算（卡 ⑥ / ⑧ 第 2 点）。
 *
 * @returns {{ok: true, level: number, scope: object}
 *          | {ok: false, reason: 'no-command'|'no-level'|'no-range'|'no-chapter'|'ambiguous-chapter'|'network-unavailable', candidates?: Array}}
 */
export function parseMasteryBatchScope(text, networkDoc, options = {}) {
  const message = typeof text === 'string' ? text : '';
  if (message.trim() === '') return { ok: false, reason: 'no-command' };
  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  if (nodes.length === 0) return { ok: false, reason: 'network-unavailable' };
  if (!looksLikeMasteryCommand(message)) return { ok: false, reason: 'no-command' };

  const levelResult = readCommandLevel(message);
  if (levelResult.ok !== true) return levelResult;

  const compact = message.replace(/\s+/g, '');
  const mentionsToday = TODAY_WORDS.some((word) => compact.includes(word))
    && LEARNED_HINTS.some((word) => compact.includes(word));
  const ref = findChapterRef(message, networkDoc, options);

  if (ref.kind === 'ambiguous') {
    return { ok: false, reason: 'ambiguous-chapter', candidates: ref.candidates };
  }
  if (ref.kind === 'found') {
    return {
      ok: true,
      level: levelResult.level,
      scope: { kind: 'chapter', chapter: ref.chapter, courseId: ref.courseId, label: ref.label },
    };
  }
  if (ref.kind === 'missing') return { ok: false, reason: 'no-chapter' };
  if (mentionsToday) {
    return { ok: true, level: levelResult.level, scope: { kind: 'today', label: '今天学过的' } };
  }
  return { ok: false, reason: 'no-range' };
}

/**
 * ISO 时刻 → **本地时区**的日期键（`YYYY-MM-DD`）。
 *
 * 卡 ② 特别点名：不能用 UTC 直接截断。晚上 8 点后（UTC+8）的 20:00 在 UTC 那边仍是当天上午，
 * 但用户认知里的「今天」已经跨日了。`timeZone` 给了就按它算（测试用 Asia/Shanghai 固定住），
 * 没给就是本机时区；时区名不认识时退回本机时区，**不抛错**（旧运行时不认识新时区名很常见）。
 *
 * @param {Date|string} value 时刻（ISO 字符串也行）
 * @param {string} [timeZone] IANA 时区名，如 'Asia/Shanghai'
 * @returns {string} `YYYY-MM-DD`；解析不出来回空串（调用方按「不是今天」处理）
 */
export function localDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (typeof timeZone === 'string' && timeZone.trim() !== '') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone.trim(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
      const year = pick('year');
      const month = pick('month');
      const day = pick('day');
      if (year !== '' && month !== '' && day !== '') return `${year}-${month}-${day}`;
    } catch {
      // 时区名不认识：退回本机时区（宁可算错一天，也不要抛错让整句命令失败）
    }
  }
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 按范围定义筛出这一批节点（**只筛，不算等级、不写库**）。
 *
 * 「今天学过」：`visitCount ≥ 1` 且 `lastLearnedAt` 的**本地日期**等于今天；`学习行为.json` 只读。
 * 「某一章」：`chapter` 归一名相等（并限定课，若范围里带了课）。
 *
 * @param {{kind: 'today'|'chapter', chapter?: string, courseId?: string|null, label?: string}} scope
 * @param {object} networkDoc `知识点网络.json`
 * @param {object} behaviorDoc `学习行为.json`（只读）
 * @param {{now?: Date, timeZone?: string}} [options]
 * @returns {{ok: true, nodes: Array, targetLabel: string}
 *          | {ok: false, reason: 'empty-today'|'empty-chapter'|'no-range'}}
 */
export function collectBatchTargets(scope, networkDoc, behaviorDoc, options = {}) {
  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  const kind = scope?.kind;

  if (kind === 'today') {
    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
    const todayKey = localDateKey(now, options.timeZone);
    const hits = [];
    for (const node of nodes) {
      if (!isPlainObject(node) || typeof node.id !== 'string') continue;
      const behavior = behaviorOf(behaviorDoc, node.id);
      if (behavior.visitCount < 1) continue;
      if (behavior.lastLearnedAt === null) continue;
      const key = localDateKey(behavior.lastLearnedAt, options.timeZone);
      if (key !== '' && key === todayKey) hits.push(node);
    }
    if (hits.length === 0) return { ok: false, reason: 'empty-today' };
    return { ok: true, nodes: hits, targetLabel: '今天学过的' };
  }

  if (kind === 'chapter') {
    const target = normalizeChapter(scope.chapter);
    if (target === '') return { ok: false, reason: 'empty-chapter' };
    const courseId = typeof scope.courseId === 'string' && scope.courseId !== '' ? scope.courseId : null;
    const hits = nodes.filter((node) => isPlainObject(node)
      && typeof node.id === 'string'
      && normalizeChapter(node.chapter) === target
      && (courseId === null || node.courseId === courseId));
    if (hits.length === 0) return { ok: false, reason: 'empty-chapter' };
    return {
      ok: true,
      nodes: hits,
      targetLabel: typeof scope.label === 'string' && scope.label !== '' ? scope.label : target,
    };
  }
  return { ok: false, reason: 'no-range' };
}

/**
 * 算出一批「要改哪几个点」的清单（预览用；**纯**，写盘在 api）。
 *
 * 已经是目标等级的节点**不进 `nodes`**（不白写盘），只计进 `skipped` 并在回话里注明。
 * `total` = 命中总数 = `nodes.length + skipped`（前端折叠显示「共 N 个」用这个）。
 *
 * @returns {{ok: true, level: number, scope: string, targetLabel: string,
 *            nodes: Array<{nodeId: string, nodeName: string, from: number, fromLabel: string}>,
 *            skipped: number, total: number}
 *          | {ok: false, reason: 'empty-today'|'empty-chapter'|'no-range'}}
 */
export function buildMasteryBatchPlan(level, scope, networkDoc, behaviorDoc, options = {}) {
  const collected = collectBatchTargets(scope, networkDoc, behaviorDoc, options);
  if (collected.ok !== true) return collected;
  const to = clampMastery(level);
  const nodes = [];
  let skipped = 0;
  for (const node of collected.nodes) {
    const from = clampMastery(node.mastery);
    if (from === to) { skipped += 1; continue; }
    nodes.push({
      nodeId: node.id,
      nodeName: typeof node.name === 'string' ? node.name : '',
      from,
      fromLabel: masteryLabel(from),
    });
  }
  return {
    ok: true,
    level: to,
    scope: scope.kind,
    targetLabel: collected.targetLabel,
    nodes,
    skipped,
    total: nodes.length + skipped,
  };
}

/** 批量预览话术（与 api 回的是同一句话，测试也断言这一份）。 */
export function describeMasteryBatchPreview(targetLabel, total, skipped, level) {
  const label = typeof targetLabel === 'string' && targetLabel.trim() !== '' ? targetLabel.trim() : '这批知识点';
  const to = masteryLabel(level);
  const skippedText = skipped > 0 ? `，其中 ${skipped} 个已经是 ${to}（会跳过）` : '';
  return `将把「${label}」里的 ${total} 个知识点设为 ${to}${skippedText}，确认吗？`;
}

/**
 * 「同理」要继承的那条命令（**从 messages 里往回扫**，卡 ⑥.2）。
 *
 * 前端每次发的是**全量历史**（`client.full.js` 的 `payload = { messages: history.map(...) }`），
 * 所以这里不需要前端另存一份「上一条命令」——纯后端回看就够，也不怕前端状态丢了。
 *
 * 扫的规矩：
 *   - 当前这句必须是一句「光秃秃的同理」（否则不继承）；
 *   - 从末尾往前跳过当前这句，只看 `role === 'user'` 的消息；
 *   - 连续喊「同理」不会自己继承自己（跳过，继续往前找）；
 *   - 一句闲聊解析不出命令时**继续往前**（它不该阻断更早那条真命令）；
 *   - 单点解析**不带界面上下文 nodeId**：历史里那句「把它设为精通」没点名时，
 *     现在界面上选中的点可能早就换了，宁可说「找不到」，也不替用户猜一个点。
 *
 * @param {Array<{role?: string, content?: string}>} messages 整段对话历史
 * @param {object} networkDoc `知识点网络.json`
 * @param {object} behaviorDoc `学习行为.json`（只读；批量继承要用它重算「今天」）
 * @param {{courses?: Array, now?: Date, timeZone?: string}} [options]
 * @returns {{ok: true, level: number, scope: object, sourceText: string, sourceIndex: number}
 *          | {ok: false, reason: 'not-inherit'|'no-previous'|'network-unavailable'}}
 */
export function resolveInheritedCommand(messages, networkDoc, behaviorDoc, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!looksLikeInheritCommand(last?.content)) return { ok: false, reason: 'not-inherit' };

  const nodes = Array.isArray(networkDoc?.nodes) ? networkDoc.nodes : [];
  if (nodes.length === 0) return { ok: false, reason: 'network-unavailable' };

  for (let index = list.length - 2; index >= 0; index -= 1) {
    const item = list[index];
    if (!isPlainObject(item) || item.role !== 'user') continue;
    const text = typeof item.content === 'string' ? item.content : '';
    if (text.trim() === '') continue;
    if (looksLikeInheritCommand(text)) continue;

    const batch = parseMasteryBatchScope(text, networkDoc, options);
    if (batch.ok === true) {
      return { ok: true, level: batch.level, scope: batch.scope, sourceText: text, sourceIndex: index };
    }
    const single = parseMasteryIntent(text, networkDoc, { nodeId: null });
    if (single.ok === true) {
      return {
        ok: true,
        level: single.level,
        scope: { kind: 'single', nodeId: single.nodeId, nodeName: single.nodeName },
        sourceText: text,
        sourceIndex: index,
      };
    }
  }
  return { ok: false, reason: 'no-previous' };
}
