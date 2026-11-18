import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANNOTATION_TYPES,
  FINGERPRINT_CHARS,
  MIN_QUOTE_CHARS,
  buildAnchor,
  buildAnchorExact,
  expandToParagraph,
  makeFingerprint,
  relocateAnchor,
  resolveAnchorFromText,
} from '../lib/annotation-anchor.js';
import { defaultDoc, validateDoc, ANNOTATION_STYLE_COLORS, ANNOTATION_STYLE_HIGHLIGHTS, ANNOTATION_STYLE_UNDERLINES, ANNOTATION_MARK_KINDS } from '../lib/core.js';

const DOC = [
  '# 第01章 绪论',
  '',
  '## 1.1 计算机与算法【印刷页 2–7】',
  '',
  '算法是解决特定问题的一系列清晰指令。一个好的算法应当具备有穷性、确定性、可行性。',
  '',
  '输入：有 0 个或多个外部输入。输出：有一个或多个输出。',
  '',
  '## 1.2 数据结构的基本概念',
  '',
  '数据是信息的载体。数据结构是相互之间存在一种或多种特定关系的数据元素的集合。',
].join('\n');

/** 取子串在 DOC 里的偏移。 */
function at(sub) {
  const index = DOC.indexOf(sub);
  assert.notEqual(index, -1, `样例里应包含：${sub}`);
  return index;
}

test('buildAnchor：正常选区得到首尾指纹与前后上下文', () => {
  const selection = '算法是解决特定问题的一系列清晰指令。';
  const start = at(selection);
  const end = start + selection.length;
  const anchor = buildAnchor(DOC, start, end);
  assert.equal(anchor.quote, selection);
  assert.equal(anchor.len, selection.length);
  assert.equal(anchor.start, start);
  assert.equal(anchor.end, end);
  assert.equal(anchor.expanded, false);
  // 前 12 字上下文（选区紧跟在标题行之后）
  assert.equal(anchor.prefix, DOC.slice(start - 12, start));
  assert.equal(anchor.suffix, DOC.slice(end, end + 12));
});

test('buildAnchor：选中不足 8 字自动扩到整段并置 expanded', () => {
  const start = at('算法是');
  const end = start + '算法是'.length;
  assert.ok(end - start < MIN_QUOTE_CHARS);
  const anchor = buildAnchor(DOC, start, end);
  assert.equal(anchor.expanded, true);
  // 整段 = 该行（前后都是空行）
  assert.equal(anchor.quote, '算法是解决特定问题的一系列清晰指令。一个好的算法应当具备有穷性、确定性、可行性。');
  assert.equal(anchor.start, at('算法是解决特定问题'));
});

test('expandToParagraph：不会越过空行或标题', () => {
  const start = at('输入：有');
  const block = expandToParagraph(DOC, start, start + 3);
  assert.equal(block.start, at('输入：有'));
  assert.equal(block.end, at('输入：有') + '输入：有 0 个或多个外部输入。输出：有一个或多个输出。'.length);
});

test('makeFingerprint：取首尾 24 字', () => {
  const long = '甲'.repeat(30) + '乙'.repeat(30);
  const fp = makeFingerprint(long);
  assert.equal(fp.head, long.slice(0, FINGERPRINT_CHARS));
  assert.equal(fp.tail, long.slice(long.length - FINGERPRINT_CHARS));
});

test('relocateAnchor：同一份原文 → found（快路径）', () => {
  const selection = '数据结构是相互之间存在一种或多种特定关系的数据元素的集合。';
  const start = at(selection);
  const anchor = buildAnchor(DOC, start, start + selection.length);
  const result = relocateAnchor(DOC, anchor);
  assert.equal(result.status, 'found');
  assert.equal(result.start, anchor.start);
  assert.equal(result.end, anchor.end);
});

test('relocateAnchor：前文插入内容导致偏移变化 → 仍 found 且刷新偏移', () => {
  const selection = '一个好的算法应当具备有穷性、确定性、可行性。';
  const start = at(selection);
  const anchor = buildAnchor(DOC, start, start + selection.length);
  const prefixInsert = '# 开篇导语\n\n本章从直觉出发。\n\n';
  const shifted = prefixInsert + DOC;
  const result = relocateAnchor(shifted, anchor);
  assert.equal(result.status, 'found');
  assert.equal(result.start, anchor.start + prefixInsert.length);
  // 新位置确实指向同一段
  assert.equal(shifted.slice(result.start, result.end), selection);
});

test('relocateAnchor：片段重复且上下文失配 → fuzzy（取最近的一处）', () => {
  const quote = '这是一句在本文件里重复出现的话。';
  const text = `引言。\n\n${quote}\n\n中间隔了很长的一段其他内容，用来把两处拉开距离。\n\n${quote}\n\n结尾。`;
  const first = text.indexOf(quote);
  const second = text.indexOf(quote, first + 1);
  assert.ok(second > first);
  // 旧偏移靠近第二处；给一个文中不存在的 prefix/suffix，使消歧失败 → 走「最近」
  const oldStart = second + 3;
  const result = relocateAnchor(text, {
    quote,
    start: oldStart,
    prefix: '根本不存在的上文',
    suffix: '根本不存在的下文',
  });
  assert.equal(result.status, 'fuzzy');
  assert.equal(result.start, Math.abs(first - oldStart) <= Math.abs(second - oldStart) ? first : second);
});

test('relocateAnchor：整段被删除 → lost（不删不猜）', () => {
  const selection = '数据是信息的载体。';
  const start = at(selection);
  const anchor = buildAnchor(DOC, start, start + selection.length);
  const removed = DOC.replace(selection, '');
  const result = relocateAnchor(removed, anchor);
  assert.equal(result.status, 'lost');
  assert.equal(result.start, null);
  assert.equal(result.end, null);
});

test('三种批注类型共用同一套锚点数据，都能正常找回', () => {
  assert.deepEqual(ANNOTATION_TYPES, ['note', 'highlight', 'insert']);
  const selection = '数据结构是相互之间存在一种或多种特定关系的数据元素的集合。';
  const start = at(selection);
  const anchor = buildAnchor(DOC, start, start + selection.length);
  for (const type of ANNOTATION_TYPES) {
    const note = { id: `a_${type}`, file: '数据结构/讲义/第01章.md', type, content: 'x', anchor };
    const result = relocateAnchor(DOC, note.anchor);
    assert.equal(result.status, 'found', `type=${type} 应能找回`);
    assert.equal(result.start, anchor.start);
  }
});

test('resolveAnchorFromText：精确偏移可信 → ok', () => {
  const selection = '数据是信息的载体。数据结构';
  const start = at(selection);
  const resolved = resolveAnchorFromText(DOC, { quote: selection, start, end: start + selection.length });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'found');
  assert.equal(resolved.anchor.start, start);
  assert.equal(resolved.anchor.quote, selection);
});

test('resolveAnchorFromText：偏移不可信但片段仍在 → 用指纹重算', () => {
  const selection = '数据结构是相互之间存在一种或多种特定关系的数据元素的集合。';
  const start = at(selection);
  const resolved = resolveAnchorFromText(DOC, { quote: selection, start: 0, end: selection.length });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'found');
  assert.equal(resolved.anchor.start, start);
});

test('resolveAnchorFromText：片段不存在 → anchor-not-found', () => {
  const resolved = resolveAnchorFromText(DOC, { quote: '这句话在原文里根本不存在', start: 0, end: 4 });
  assert.deepEqual(resolved, { ok: false, reason: 'anchor-not-found' });
});

test('resolveAnchorFromText：空 quote → bad-anchor', () => {
  assert.deepEqual(resolveAnchorFromText(DOC, { quote: '', start: 0, end: 0 }), { ok: false, reason: 'bad-anchor' });
});

test('relocateAnchor：前文被改动导致上下文失配 → fuzzy（不静默当 found）', () => {
  const quote = '这一句在文件里出现了两次。';
  const original = `甲段落。\n\n${quote}\n\n乙段落。\n\n${quote}\n\n`;
  const first = original.indexOf(quote);
  const anchor = buildAnchor(original, first, first + quote.length);
  assert.equal(relocateAnchor(original, anchor).status, 'found');
  // 前文改了一个词：第一处的 prefix 不再匹配，第二处的 prefix 也从未匹配过 ⇒ 消歧失败
  const edited = original.replace('甲段落。', '甲段落（改过）。');
  const result = relocateAnchor(edited, anchor);
  assert.equal(result.status, 'fuzzy', '上下文失配 + 片段重复 ⇒ fuzzy，交界面提示而不是静默套用');
  assert.equal(edited.slice(result.start, result.end), quote);
});

test('buildAnchorExact：任意短选（2 字）精确出 quote、不扩段、置 exact', () => {
  const start = at('算法');
  const end = start + 2;
  const result = buildAnchorExact(DOC, start, end);
  assert.equal(result.ok, true);
  assert.equal(result.anchor.quote, '算法');
  assert.equal(result.anchor.start, start);
  assert.equal(result.anchor.end, end);
  assert.equal(result.anchor.expanded, false);
  assert.equal(result.anchor.exact, true);
  assert.equal(result.anchor.len, 2);
});

test('buildAnchorExact：1 字也能精确标注；空选/纯空白拒绝', () => {
  const start = at('算法');
  assert.equal(buildAnchorExact(DOC, start, start + 1).anchor.quote, '算');
  assert.deepEqual(buildAnchorExact(DOC, start, start), { ok: false, reason: 'empty-selection' });
  // 换行/空格区间的纯空白选区
  const blank = DOC.indexOf('\n\n');
  assert.equal(buildAnchorExact(DOC, blank, blank + 2).ok, false);
});

test('resolveAnchorFromText：exact 短选不扩段，quote 保持原样', () => {
  const start = at('算法');
  const resolved = resolveAnchorFromText(DOC, { quote: '算法', start, end: start + 2, exact: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.anchor.quote, '算法', 'exact 不得扩到整段');
  assert.equal(resolved.anchor.expanded, false);
  assert.equal(resolved.anchor.exact, true);
  assert.equal(resolved.anchor.start, start);
});

test('resolveAnchorFromText：exact 短选偏移不可信时用指纹重定位仍不扩段', () => {
  const quote = '算法';
  const start = at(quote);
  // 前文插入内容使原偏移失效
  const shifted = '# 新的开篇\n\n' + DOC;
  const resolved = resolveAnchorFromText(shifted, { quote, start: 0, end: 2, prefix: DOC.slice(start - 12, start), suffix: DOC.slice(start + 2, start + 14), exact: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.anchor.quote, '算法', '重定位后仍是 2 字精确选区，不扩段');
  assert.equal(shifted.slice(resolved.anchor.start, resolved.anchor.end), '算法');
});

test('非 exact 的 <8 字提交仍走旧扩段语义（不破坏旧断言）', () => {
  const start = at('算法');
  const resolved = resolveAnchorFromText(DOC, { quote: '算法', start, end: start + 2 });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.anchor.expanded, true, '不带 exact 的短选仍扩段，与旧行为一致');
});


test('validateDoc：批注文档（第 12 份主文档）合法结构通过，缺字段/坏结构被拒', () => {
  // 默认空结构必须合法（store.init 用它补空文件，坏了就永远写不进去）
  assert.deepEqual(validateDoc('annotations', defaultDoc('annotations')), { ok: true });
  assert.deepEqual(defaultDoc('annotations'), { version: 1, notes: [], updatedAt: null });

  const start = at('数据是信息的载体。');
  const note = {
    id: 'a_20261030_000001',
    file: '数据结构/讲义/第01章.md',
    type: 'note',
    content: '我的笔记',
    page: null,
    anchor: buildAnchor(DOC, start, start + '数据是信息的载体。'.length),
    createdAt: '2026-10-30T06:30:12.000Z',
    updatedAt: '2026-10-30T06:30:12.000Z',
  };
  const good = { version: 1, notes: [note], updatedAt: '2026-10-30T06:30:12.000Z' };
  assert.deepEqual(validateDoc('annotations', good), { ok: true });
  // 三种类型共用同一套锚点数据，都必须是合法结构
  for (const type of ANNOTATION_TYPES) {
    assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, type }] }), { ok: true }, `type=${type}`);
  }
  // 可选字段缺省也合法（page / weak / expanded）
  assert.equal(validateDoc('annotations', {
    ...good,
    notes: [{ ...note, page: undefined, anchor: { ...note.anchor, expanded: undefined } }],
  }).ok, true);

  const cases = [
    ['缺 notes 数组', { version: 1, updatedAt: null }, 'bad-field:notes'],
    ['版本不对', { version: 2, notes: [], updatedAt: null }, 'bad-version:2'],
    ['不是对象', [], 'not-an-object'],
    ['坏 id', { ...good, notes: [{ ...note, id: '../逃逸' }] }, 'annotation-bad-id'],
    ['id 重复', { ...good, notes: [note, { ...note }] }, 'annotation-duplicate-id'],
    ['未知类型', { ...good, notes: [{ ...note, type: 'comment' }] }, 'annotation-bad-type'],
    ['缺 file', { ...good, notes: [{ ...note, file: '' }] }, 'annotation-missing-file'],
    ['content 非字符串', { ...good, notes: [{ ...note, content: null }] }, 'annotation-bad-content'],
    ['page 非法', { ...good, notes: [{ ...note, page: 0 }] }, 'annotation-bad-page'],
    ['缺 anchor', { ...good, notes: [{ ...note, anchor: undefined }] }, 'annotation-missing-anchor'],
    ['quote 为空', { ...good, notes: [{ ...note, anchor: { ...note.anchor, quote: '' } }] }, 'annotation-bad-quote'],
    ['start 为负', { ...good, notes: [{ ...note, anchor: { ...note.anchor, start: -1 } }] }, 'annotation-bad-range'],
    ['end 小于 start', { ...good, notes: [{ ...note, anchor: { ...note.anchor, end: 0 } }] }, 'annotation-bad-range'],
    ['quote 与区间长度不符', { ...good, notes: [{ ...note, anchor: { ...note.anchor, end: note.anchor.end + 5 } }] }, 'annotation-quote-range-mismatch'],
    ['prefix/suffix 非字符串', { ...good, notes: [{ ...note, anchor: { ...note.anchor, prefix: null } }] }, 'annotation-bad-context'],
    ['expanded 非布尔', { ...good, notes: [{ ...note, anchor: { ...note.anchor, expanded: 'yes' } }] }, 'annotation-bad-expanded'],
    ['exact 非布尔', { ...good, notes: [{ ...note, anchor: { ...note.anchor, exact: 'yes' } }] }, 'annotation-bad-exact'],
    ['缺 createdAt', { ...good, notes: [{ ...note, createdAt: '' }] }, 'annotation-bad-createdAt'],
    ['缺 updatedAt', { ...good, notes: [{ ...note, updatedAt: undefined }] }, 'annotation-bad-updatedAt'],
    ['weak 非对象', { ...good, notes: [{ ...note, weak: [] }] }, 'annotation-bad-weak'],
  ];
  for (const [name, doc, reason] of cases) {
    const checked = validateDoc('annotations', doc);
    assert.equal(checked.ok, false, `${name} 必须被拒`);
    assert.equal(checked.reason, reason, `${name} 的拒绝理由`);
  }
});

test('validateDoc：批注可选 style（行内格式）——合法值通过、白名单外的键/值被拒、缺省照样合法', () => {
  const start = at('数据是信息的载体。');
  const note = {
    id: 'a_20261117_000001',
    file: '数据结构/讲义/第01章.md',
    type: 'highlight',
    content: '',
    page: null,
    anchor: buildAnchor(DOC, start, start + '数据是信息的载体。'.length),
    createdAt: '2026-11-17T06:30:12.000Z',
    updatedAt: '2026-11-17T06:30:12.000Z',
  };
  const good = { version: 1, notes: [note], updatedAt: '2026-11-17T06:30:12.000Z' };

  // 缺省（不写 style）必须合法——不动旧数据
  assert.deepEqual(validateDoc('annotations', good), { ok: true });
  assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, style: undefined }] }), { ok: true });
  // 白名单里的每个合法值都通过；空对象也算合法（全缺省）
  assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, style: {} }] }), { ok: true });
  for (const c of ANNOTATION_STYLE_COLORS) {
    assert.equal(validateDoc('annotations', { ...good, notes: [{ ...note, style: { color: c } }] }).ok, true, `color=${c}`);
  }
  for (const c of ANNOTATION_STYLE_HIGHLIGHTS) {
    assert.equal(validateDoc('annotations', { ...good, notes: [{ ...note, style: { highlight: c } }] }).ok, true, `highlight=${c}`);
  }
  for (const c of ANNOTATION_STYLE_UNDERLINES) {
    assert.equal(validateDoc('annotations', { ...good, notes: [{ ...note, style: { underline: c } }] }).ok, true, `underline=${c}`);
  }
  assert.equal(validateDoc('annotations', { ...good, notes: [{ ...note, style: { bold: true, italic: false } }] }).ok, true);
  assert.equal(validateDoc('annotations', { ...good, notes: [{ ...note, style: { color: 'red', highlight: 'yellow', underline: 'blue', bold: true, italic: true } }] }).ok, true);

  const styleCases = [
    ['style 不是对象', { ...note, style: 'red' }, 'annotation-bad-style'],
    ['style 是数组', { ...note, style: [] }, 'annotation-bad-style'],
    ['color 不在白名单', { ...note, style: { color: 'purple' } }, 'annotation-bad-style-color'],
    ['highlight 不在白名单', { ...note, style: { highlight: 'cyan' } }, 'annotation-bad-style-highlight'],
    ['underline 不在白名单', { ...note, style: { underline: 'green' } }, 'annotation-bad-style-underline'],
    ['bold 非布尔', { ...note, style: { bold: 'yes' } }, 'annotation-bad-style-flag'],
    ['italic 非布尔', { ...note, style: { italic: 1 } }, 'annotation-bad-style-flag'],
    ['未知键', { ...note, style: { backgroundColor: 'red' } }, 'annotation-bad-style-key'],
  ];
  for (const [name, overridden, reason] of styleCases) {
    const checked = validateDoc('annotations', { ...good, notes: [overridden] });
    assert.equal(checked.ok, false, `${name} 必须被拒`);
    assert.equal(checked.reason, reason, `${name} 的拒绝理由`);
  }
});

test('validateDoc：批注可选 markKind（主观标记类型）——白名单值通过、非法值被拒、缺省/null 照样合法（旧数据不破）', () => {
  const start = at('数据是信息的载体。');
  const note = {
    id: 'a_20261118_000001',
    file: '数据结构/讲义/第01章.md',
    type: 'highlight',
    content: '',
    page: null,
    anchor: buildAnchor(DOC, start, start + '数据是信息的载体。'.length),
    createdAt: '2026-11-18T06:30:12.000Z',
    updatedAt: '2026-11-18T06:30:12.000Z',
  };
  const good = { version: 1, notes: [note], updatedAt: '2026-11-18T06:30:12.000Z' };

  // 缺省（无 markKind）/ undefined / null 必须合法——不动旧数据
  assert.deepEqual(validateDoc('annotations', good), { ok: true });
  assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, markKind: undefined }] }), { ok: true });
  assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, markKind: null }] }), { ok: true });
  // 白名单里每个值都通过
  for (const kind of ANNOTATION_MARK_KINDS) {
    assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, markKind: kind }] }), { ok: true }, `markKind=${kind}`);
  }
  // 与 style 共存也合法
  assert.deepEqual(validateDoc('annotations', { ...good, notes: [{ ...note, markKind: 'key', style: { highlight: 'yellow' } }] }), { ok: true });

  const badCases = [
    ['未知字符串', 'important'],
    ['中文值', '重点'],
    ['数字', 1],
    ['布尔', true],
    ['对象', { kind: 'key' }],
    ['数组', ['key']],
  ];
  for (const [name, markKind] of badCases) {
    const checked = validateDoc('annotations', { ...good, notes: [{ ...note, markKind }] });
    assert.equal(checked.ok, false, `${name} 必须被拒`);
    assert.equal(checked.reason, 'annotation-bad-mark-kind', `${name} 的拒绝理由`);
  }
});
