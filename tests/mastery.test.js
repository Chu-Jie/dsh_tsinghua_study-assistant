/**
 * 掌握度算法 + 学习行为口径的单测（v2-B 卡，2026-11-20）。
 *
 * 全部合成数据：**不读 `学习台/`、不碰真数据、不写盘**（这个模块本身也是纯的，
 * 所以这里连临时目录都不用建）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MINUTES_FOR_ADVANCE,
  MASTERY_LABELS,
  MASTERY_MAX,
  applySuggestedMastery,
  behaviorOf,
  clampMastery,
  collectLearnedEvidence,
  describeMasteryPreview,
  emptyBehavior,
  masteryLabel,
  normalizeBehavior,
  parseMasteryIntent,
  recordVisit,
  settleStayMinutes,
  suggestMastery,
} from '../lib/mastery.js';
import { LEARNING_BEHAVIOR_FIELDS, validateDoc, defaultDoc, DOC_VERSION } from '../lib/core.js';

/** 造一条行为记录。 */
function behavior(patch = {}) {
  return { ...emptyBehavior(), ...patch };
}

/** 造一份最小的知识网络（只带算分要用的字段）。 */
function network(nodes) {
  return { version: DOC_VERSION, nodes, edges: [], updatedAt: null };
}

function node(id, name, mastery, patch = {}) {
  return {
    id,
    name,
    courseId: 'c_phy',
    chapter: '第12章 静电场',
    section: '12.1',
    subsection: '',
    aliases: [],
    mastery,
    marked: false,
    reviewedAt: null,
    note: '',
    evidence: [],
    createdAt: '2026-10-20T14:09:12.982Z',
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// suggestMastery：六种情形
// ---------------------------------------------------------------------------

test('suggestMastery：没打开过、没批注、没时长 → 0（未学）', () => {
  assert.equal(suggestMastery(null, 0, 0), 0);
  assert.equal(suggestMastery(emptyBehavior(), 0, 0), 0);
  assert.equal(suggestMastery(undefined, undefined, undefined), 0, '全空也必须回 0，不抛');
});

test('suggestMastery：打开过 1 次 → 1（学过）', () => {
  assert.equal(suggestMastery(behavior({ visitCount: 1 }), 0, 0), 1);
  assert.equal(suggestMastery(behavior({ visitCount: 9 }), 0, 0), 1, '次数再多也只有 +1，不是线性涨');
});

test('suggestMastery：打开 + 一条 learned 批注 → 2（熟练）', () => {
  assert.equal(suggestMastery(behavior({ visitCount: 1 }), 1, 0), 2);
  // 只认「有没有」，不按条数线性加权
  assert.equal(suggestMastery(behavior({ visitCount: 1 }), 5, 0), 2);
  // 直接传批注数组也认
  assert.equal(suggestMastery(behavior({ visitCount: 1 }), [{ markKind: 'learned' }], 0), 2);
});

test('suggestMastery：再加时长 ≥ 30 分钟 → 3（精通），封顶 3', () => {
  assert.equal(MINUTES_FOR_ADVANCE, 30, '阈值是 30 分钟（写成具名常量）');
  assert.equal(suggestMastery(behavior({ visitCount: 1, totalMinutes: 30 }), 1, 0), 3);
  assert.equal(suggestMastery(behavior({ visitCount: 1, totalMinutes: 29 }), 1, 0), 2, '差一分钟就还是 2');
  assert.equal(suggestMastery(behavior({ visitCount: 1, totalMinutes: 999 }), 3, 3), 3, '封顶 3');
  assert.equal(MASTERY_MAX, 3);
});

test('suggestMastery：manual（人改过的）→ 原值返回，一点不算', () => {
  const manualZero = behavior({ visitCount: 5, totalMinutes: 120, masterySource: 'manual' });
  assert.equal(suggestMastery(manualZero, 3, 0), 0, '人把 3 档降回 0，算法不许再推上去');
  assert.equal(suggestMastery(manualZero, 3, 1), 1);
  const manualHigh = behavior({ masterySource: 'manual' });
  assert.equal(suggestMastery(manualHigh, 0, 3), 3);
});

test('suggestMastery：mastery ≥ 2 的老数据、没有任何行为 → 保留不降级', () => {
  assert.equal(suggestMastery(null, 0, 2), 2, '手动标过的 2 档不该被算成 0');
  assert.equal(suggestMastery(emptyBehavior(), 0, 3), 3);
  assert.equal(suggestMastery(behavior({ visitCount: 1 }), 0, 2), 2, '只有 +1 的分数也不许把 2 拉回 1');
});

test('suggestMastery：脏入参不崩（越界等级/负次数/NaN）', () => {
  assert.equal(clampMastery(99), 0);
  assert.equal(clampMastery(-1), 0);
  assert.equal(clampMastery('2'), 0, '字符串不算整数（宁可当未学，也不猜）');
  assert.equal(clampMastery(2.5), 0);
  assert.equal(suggestMastery(behavior({ visitCount: -3, totalMinutes: -1 }), 0, 1), 1);
});

test('masteryLabel：0–3 与文案一一对应，越界按未学', () => {
  assert.deepEqual(MASTERY_LABELS, ['未学', '学过', '熟练', '精通']);
  assert.equal(masteryLabel(2), '熟练');
  assert.equal(masteryLabel(9), '未学');
});

// ---------------------------------------------------------------------------
// recordVisit：打开一次的口径
// ---------------------------------------------------------------------------

test('recordVisit：首次打开填 firstLearnedAt = lastLearnedAt = now，次数 +1', () => {
  const now = '2026-11-20T01:05:00.000Z';
  const first = recordVisit(null, now);
  assert.equal(first.counted, true);
  assert.equal(first.behavior.visitCount, 1);
  assert.equal(first.behavior.firstLearnedAt, now);
  assert.equal(first.behavior.lastLearnedAt, now);
  assert.equal(first.behavior.totalMinutes, 0, '本步不测停留时长，恒 0');
  assert.equal(first.behavior.masterySource, 'auto');

  const second = recordVisit(first.behavior, '2026-11-20T01:09:00.000Z');
  assert.equal(second.counted, true);
  assert.equal(second.behavior.visitCount, 2);
  assert.equal(second.behavior.firstLearnedAt, now, '首次时间不许被后续覆盖');
  assert.equal(second.behavior.lastLearnedAt, '2026-11-20T01:09:00.000Z');
});

test('recordVisit：同一分钟内重复上报只算一次；跨分钟才再 +1', () => {
  const now = '2026-11-20T01:05:00.000Z';
  const first = recordVisit(null, now);
  const sameMinute = recordVisit(first.behavior, '2026-11-20T01:05:59.000Z');
  assert.equal(sameMinute.counted, false);
  assert.equal(sameMinute.reason, 'same-minute');
  assert.equal(sameMinute.behavior.visitCount, 1, '同一分钟不涨次数');

  const nextMinute = recordVisit(first.behavior, '2026-11-20T01:06:00.000Z');
  assert.equal(nextMinute.counted, true);
  assert.equal(nextMinute.behavior.visitCount, 2);
});

test('recordVisit：时间为空 → 不计数（不编一个时间出来）', () => {
  const result = recordVisit(null, '');
  assert.equal(result.counted, false);
  assert.equal(result.reason, 'bad-now');
  assert.equal(result.behavior.visitCount, 0);
  assert.equal(result.behavior.firstLearnedAt, null);
});

test('settleStayMinutes：本卡只是签名占位 —— 加 0 分钟，不造假时长', () => {
  const before = behavior({ visitCount: 2, totalMinutes: 0 });
  const settled = settleStayMinutes(before, 45);
  assert.equal(settled.added, 0);
  assert.equal(settled.behavior.totalMinutes, 0, '第二步实现前，停留时长一律 0');
});

// ---------------------------------------------------------------------------
// applySuggestedMastery：只改 auto、跳过 manual、别的字段原样
// ---------------------------------------------------------------------------

test('applySuggestedMastery：manual 节点不动，auto 节点按算法升，其他字段原样', () => {
  const doc = network([
    node('k_a', '电偶极子', 0, { evidence: [{ type: 'page', file: '物理/教材/x.pdf', page: 22 }] }),
    node('k_b', '电荷', 2, { note: '这个点要背', mastery: 2 }),
    node('k_c', '高斯定理', 1, { aliases: ['高斯定律'] }),
  ]);
  const behaviors = {
    version: DOC_VERSION,
    nodes: {
      k_a: behavior({ visitCount: 1 }),
      k_b: behavior({ visitCount: 3, masterySource: 'manual' }),
      k_c: behavior({ visitCount: 1 }),
    },
    updatedAt: null,
  };

  const result = applySuggestedMastery(doc, behaviors, { version: DOC_VERSION, notes: [], updatedAt: null }, { nowIso: '2026-11-20T02:00:00.000Z' });
  assert.deepEqual(result.changes, [{ nodeId: 'k_a', name: '电偶极子', from: 0, to: 1 }],
    '只有 auto 的 k_a 从 0 升到 1；manual 的 k_b 与已经 1 档的 k_c 都不产生变更');

  const byId = new Map(result.network.nodes.map((item) => [item.id, item]));
  assert.equal(byId.get('k_a').mastery, 1);
  assert.equal(byId.get('k_a').reviewedAt, '2026-11-20T02:00:00.000Z', '变了才刷 reviewedAt');
  assert.deepEqual(byId.get('k_a').evidence, doc.nodes[0].evidence, 'evidence 原样');
  assert.equal(byId.get('k_b').mastery, 2, 'manual 的等级绝对不动');
  assert.equal(byId.get('k_b').reviewedAt, null, '没变的节点不刷 reviewedAt');
  assert.equal(byId.get('k_b').note, '这个点要背', 'note 原样');
  assert.deepEqual(byId.get('k_c').aliases, ['高斯定律'], 'aliases 原样');
  assert.equal(byId.get('k_a').name, '电偶极子');
  assert.equal(byId.get('k_a').chapter, '第12章 静电场');
});

test('applySuggestedMastery：一个行为都没有的文档 → 零变更（不会白写盘、不会留备份）', () => {
  const doc = network([node('k_a', '电偶极子', 0), node('k_b', '电荷', 3)]);
  const result = applySuggestedMastery(doc, { version: DOC_VERSION, nodes: {}, updatedAt: null }, { version: DOC_VERSION, notes: [] });
  assert.deepEqual(result.changes, []);
  assert.equal(result.network.nodes[0].mastery, 0);
  assert.equal(result.network.nodes[1].mastery, 3);
});

test('applySuggestedMastery：learned 批注能把节点推到 2（访问 +1、批注 +1）', () => {
  const doc = network([node('k_339c6529a0', '电荷', 0)]);
  const behaviors = { version: DOC_VERSION, nodes: { k_339c6529a0: behavior({ visitCount: 1 }) }, updatedAt: null };
  const annotations = {
    version: DOC_VERSION,
    notes: [{ id: 'a_1', type: 'note', file: 'kp:k_339c6529a0', markKind: 'learned', content: '', createdAt: 'x', updatedAt: 'x' }],
    updatedAt: null,
  };
  const result = applySuggestedMastery(doc, behaviors, annotations);
  assert.equal(result.network.nodes[0].mastery, 2);
  assert.deepEqual(result.changes, [{ nodeId: 'k_339c6529a0', name: '电荷', from: 0, to: 2 }]);
});

test('applySuggestedMastery：没有 nowIso 时不改 reviewedAt（纯函数、时间由调用方给）', () => {
  const doc = network([node('k_a', '电偶极子', 0, { reviewedAt: '2026-10-01T00:00:00.000Z' })]);
  const behaviors = { version: DOC_VERSION, nodes: { k_a: behavior({ visitCount: 1 }) }, updatedAt: null };
  const result = applySuggestedMastery(doc, behaviors, null);
  assert.equal(result.network.nodes[0].mastery, 1);
  assert.equal(result.network.nodes[0].reviewedAt, '2026-10-01T00:00:00.000Z', '没给时间就保留旧值');
});

test('applySuggestedMastery：空/坏文档不崩', () => {
  assert.deepEqual(applySuggestedMastery(null, null, null).changes, []);
  assert.deepEqual(applySuggestedMastery({ version: DOC_VERSION, nodes: null }, null, null).changes, []);
});

// ---------------------------------------------------------------------------
// collectLearnedEvidence：学过证据的两种来源
// ---------------------------------------------------------------------------

test('collectLearnedEvidence：只认 markKind=learned，kp:<nodeId> 直挂', () => {
  const doc = network([node('k_a', '电偶极子', 0), node('k_b', '电荷', 0)]);
  const annotations = {
    notes: [
      { file: 'kp:k_a', markKind: 'learned' },
      { file: 'kp:k_a', markKind: 'learned' },
      { file: 'kp:k_b', markKind: 'key' },
      { file: 'kp:不存在的节点', markKind: 'learned' },
      { file: '数电/讲义/第02章.md', markKind: 'learned' },
    ],
  };
  const counts = collectLearnedEvidence(doc, annotations);
  assert.equal(counts.get('k_a'), 2);
  assert.equal(counts.get('k_b'), undefined, 'key 标记不算学过');
  assert.equal(counts.has('不存在的节点'), false, '网络里没有的 id 不收');
});

test('collectLearnedEvidence：落在「该知识点讲义文件」上的 learned 也算（归属看节点 evidence）', () => {
  const lecture = '数电/讲义/第02章-逻辑代数基础-C-问题驱动式.md';
  const doc = network([
    node('k_a', '逻辑代数基本定律', 0, { evidence: [{ type: 'lecture', file: '数电\\讲义\\第02章-逻辑代数基础-C-问题驱动式.md' }] }),
  ]);
  const counts = collectLearnedEvidence(doc, { notes: [{ file: lecture, markKind: 'learned' }] });
  assert.equal(counts.get('k_a'), 1, '反斜杠/正斜杠两种写法都归一');
});

test('collectLearnedEvidence：讲义文件没被任何节点引用 → 不算给任何人（不脑补归属）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  const counts = collectLearnedEvidence(doc, { notes: [{ file: '数电/讲义/第99章.md', markKind: 'learned' }] });
  assert.equal(counts.size, 0);
});

// ---------------------------------------------------------------------------
// parseMasteryIntent：经聊天改掌握度的意图
// ---------------------------------------------------------------------------

test('parseMasteryIntent：点名 + 中文档位 → 唯一命中', () => {
  const doc = network([node('k_a', '电偶极子', 0, { aliases: ['偶极子'] }), node('k_b', '电荷', 0)]);
  const intent = parseMasteryIntent('把电偶极子设为精通', doc);
  assert.equal(intent.ok, true);
  assert.equal(intent.level, 3);
  assert.equal(intent.nodeId, 'k_a');
  assert.equal(intent.nodeName, '电偶极子');
});

test('parseMasteryIntent：别名也认，且取最长命中（「偶极子」不会抢「电偶极子」）', () => {
  const doc = network([
    node('k_a', '电偶极子', 0),
    node('k_b', '偶极子', 0),
  ]);
  const intent = parseMasteryIntent('把电偶极子改成熟练', doc);
  assert.equal(intent.ok, true);
  assert.equal(intent.nodeId, 'k_a');
  assert.equal(intent.level, 2);
});

test('parseMasteryIntent：数字写法（改成 2 / 掌握度 3）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  assert.equal(parseMasteryIntent('把电偶极子改成 2', doc).level, 2);
  assert.equal(parseMasteryIntent('电偶极子的掌握度 3', doc).level, 3);
  assert.equal(parseMasteryIntent('把电偶极子设为9', doc).ok, false, '9 越界，不当命令');
});

test('parseMasteryIntent：没点名时用「当前选中的点」（界面上下文）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  const intent = parseMasteryIntent('把这个设为学过', doc, { nodeId: 'k_a' });
  assert.equal(intent.ok, true);
  assert.equal(intent.nodeId, 'k_a');
  assert.equal(intent.level, 1);
});

test('parseMasteryIntent：没点名、也没有上下文 → no-node（不猜）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  const intent = parseMasteryIntent('把它设为学过', doc);
  assert.equal(intent.ok, false);
  assert.equal(intent.reason, 'no-node');
});

test('parseMasteryIntent：同名多义 → ambiguous，把候选返回', () => {
  const doc = network([
    node('k_a', '电荷', 0, { chapter: '第12章 静电场' }),
    node('k_b', '电荷', 0, { chapter: '第13章 电势' }),
  ]);
  const intent = parseMasteryIntent('把电荷设为熟练', doc);
  assert.equal(intent.ok, false);
  assert.equal(intent.reason, 'ambiguous');
  assert.deepEqual(intent.candidates, [
    { nodeId: 'k_a', name: '电荷', chapter: '第12章 静电场' },
    { nodeId: 'k_b', name: '电荷', chapter: '第13章 电势' },
  ]);
});

test('parseMasteryIntent：提问不是命令（「怎么才能学到精通」不许被当成改库指令）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  assert.equal(parseMasteryIntent('电偶极子怎么才能学到精通？', doc).ok, false);
  assert.equal(parseMasteryIntent('精通的判定标准是什么', doc).ok, false);
  assert.equal(parseMasteryIntent('帮我解释一下电荷', doc).reason, 'no-level');
});

test('parseMasteryIntent：中文档位取「最靠右」的那个（「已经学过，想标成精通」→ 3）', () => {
  const doc = network([node('k_a', '电偶极子', 0)]);
  const intent = parseMasteryIntent('电偶极子我已经学过了，想标成精通', doc);
  assert.equal(intent.ok, true);
  assert.equal(intent.level, 3);
});

test('parseMasteryIntent：网络读不出来 → network-unavailable（不假装成功）', () => {
  assert.equal(parseMasteryIntent('把电偶极子设为精通', network([])).reason, 'network-unavailable');
});

test('describeMasteryPreview：预览话术带旧值/新值与两档文案，且明确「还没改」', () => {
  const text = describeMasteryPreview('电偶极子', 2, 3);
  assert.equal(text, '将把「电偶极子」掌握度从 2（熟练）改为 3（精通），确认吗？');
  assert.match(describeMasteryPreview('', 0, 1), /这个知识点/);
});

// ---------------------------------------------------------------------------
// 文档形状：第 16 份的登记面 + 「不许塞等级」
// ---------------------------------------------------------------------------

test('学习行为：空骨架可校验；缺 masterySource / 多了 mastery 字段一律拒收', () => {
  const empty = defaultDoc('learningBehavior');
  assert.deepEqual(empty, { version: DOC_VERSION, nodes: {}, updatedAt: null });
  assert.deepEqual(validateDoc('learningBehavior', empty), { ok: true });

  const withExtra = {
    version: DOC_VERSION,
    nodes: { k_a: { ...behavior({ masterySource: 'auto' }), mastery: 3 } },
    updatedAt: null,
  };
  const checked = validateDoc('learningBehavior', withExtra);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'behavior-unknown-field', '想在这里塞掌握等级，入口就拒');

  const noSource = { version: DOC_VERSION, nodes: { k_a: behavior() }, updatedAt: null };
  // behavior() 给了 masterySource: 'auto'，这里手动剔掉再验
  delete noSource.nodes.k_a.masterySource;
  assert.equal(validateDoc('learningBehavior', noSource).reason, 'behavior-bad-mastery-source');
});

test('学习行为：字段白名单恰好六个（多一个就落不了盘）', () => {
  assert.deepEqual(LEARNING_BEHAVIOR_FIELDS, [
    'firstLearnedAt', 'lastLearnedAt', 'visitCount', 'totalMinutes', 'masterySource', 'masteryUpdatedAt',
  ]);
  const bad = { version: DOC_VERSION, nodes: { 'k 带空格': behavior() }, updatedAt: null };
  assert.equal(validateDoc('learningBehavior', bad).reason, 'behavior-bad-node-id', 'nodeId 走同一套 id 白名单');
});

test('normalizeBehavior / behaviorOf：缺字段给默认，不编时间', () => {
  assert.deepEqual(normalizeBehavior(null), {
    firstLearnedAt: null, lastLearnedAt: null, visitCount: 0, totalMinutes: 0,
    masterySource: 'auto', masteryUpdatedAt: null,
  });
  assert.equal(behaviorOf({ nodes: { k_a: { visitCount: 3 } } }, 'k_a').visitCount, 3);
  assert.equal(behaviorOf({ nodes: {} }, 'k_b').visitCount, 0);
  assert.equal(normalizeBehavior({ visitCount: '3' }).visitCount, 3, '磁盘上的数字字符串宽容归一');
});
