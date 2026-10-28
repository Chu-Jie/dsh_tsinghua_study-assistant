/**
 * 听课文本层测试（零依赖）
 * 运行：node tests/lecture-text.test.js
 *
 * 这一层的输入是**别人识别出来的文字**，不是音频。要钉死的三件事：
 *   1. OCR 在汉字之间插的空格必须被清掉，否则后面按词匹配全废；
 *   2. 字幕是滚动窗口，只取新增部分，不能把重叠区重复追加成复读机；
 *   3. 重叠判定必须容忍少量错字 —— 要求逐字相等的话，一旦错一个字就退化成
 *      「完全不重叠」，逐字稿立刻就花了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absorbCaption,
  clampTail,
  countMismatch,
  frameLines,
  isNoise,
  normalizeFrame,
  overlapLength,
  splitSentences,
  stripCjkSpaces,
  tailOf,
} from '../lib/lecture/text.js';

test('stripCjkSpaces：清掉汉字之间被 OCR 插进来的空格', () => {
  // 实测自 Windows 内置 OCR（zh-Hans-CN）：`新 会 话` 其实是「新会话」
  assert.equal(stripCjkSpaces('新 会 话'), '新会话');
  assert.equal(stripCjkSpaces('啭 写 答 题 提 醒'), '啭写答题提醒');
  assert.equal(stripCjkSpaces('转 写\n答 题'), '转写\n答题');
});

test('stripCjkSpaces：中英之间的空格要留着', () => {
  assert.equal(stripCjkSpaces('的 CPU 很快'), '的 CPU 很快');
  assert.equal(stripCjkSpaces('用 Node 跑'), '用 Node 跑');
});

test('stripCjkSpaces：多余连续空格收敛成一个', () => {
  assert.equal(stripCjkSpaces('a    b'), 'a b');
});

test('isNoise：纯标点 / 纯空白算噪音', () => {
  assert.equal(isNoise('。，、'), true);
  assert.equal(isNoise('——'), true);
  assert.equal(isNoise('   '), true);
  assert.equal(isNoise('第三章'), false);
  assert.equal(isNoise('abc'), false);
});

test('normalizeFrame：去噪音行、保留分行', () => {
  assert.equal(normalizeFrame('新 会 话\n\n。，\n转 写'), '新会话\n转写');
  assert.equal(normalizeFrame('\u200b零宽\n正文'), '零宽\n正文');
  assert.equal(normalizeFrame('   '), '');
});

test('frameLines：给出规范化后的每一行', () => {
  assert.deepEqual(frameLines('第一行\n\n第二行'), ['第一行', '第二行']);
  assert.deepEqual(frameLines('  '), []);
});

test('splitSentences：按句末标点切，没标点就整段一句', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句'), ['第一句', '第二句', '第三句']);
  assert.deepEqual(splitSentences('没有标点的一整段'), ['没有标点的一整段']);
  assert.deepEqual(splitSentences('。，、'), []);
});

test('countMismatch：等长比较 + 长度差计入', () => {
  assert.equal(countMismatch('abc', 'abc'), 0);
  assert.equal(countMismatch('abc', 'abd'), 1);
  assert.equal(countMismatch('abc', 'ab'), 1);
});

test('overlapLength：找回上一帧结尾与这一帧开头的重叠', () => {
  const prev = '今天我们讲函数的连续性';
  const next = '函数的连续性非常重要';
  // 重叠的是「函数的连续性」6 个字（不是 7 —— 「讲」不在新帧里）
  assert.equal(overlapLength(prev, next), 6);
});

test('overlapLength：重叠区里有一个错字也要认（否则退化成不复读机的反面）', () => {
  const prev = '今天我们讲函数的连续性';
  const next = '函数的连継性非常重要'; // 续 → 継，模拟 OCR 错字
  assert.equal(overlapLength(prev, next), 6);
});

test('overlapLength：两帧无关时返回 0', () => {
  assert.equal(overlapLength('第一段内容', '完全不同的第二段'), 0);
  assert.equal(overlapLength('', '任何内容'), 0);
});

test('absorbCaption：只取新增部分', () => {
  const merged = absorbCaption('今天我们讲函数的连续性', '函数的连续性非常重要');
  assert.equal(merged.appended, '非常重要');
  assert.equal(merged.reset, false);
  assert.equal(merged.text, '今天我们讲函数的连续性非常重要');
});

test('absorbCaption：同一帧重复到达不产生新内容', () => {
  assert.equal(absorbCaption('已经有的内容', '已经有的内容').appended, '');
  // 整帧是旧文本的结尾 —— 同样不算新增
  assert.equal(absorbCaption('前面很长的一段已经有的内容', '已经有的内容').appended, '');
});

test('absorbCaption：字幕窗口重启时用换行隔开', () => {
  const merged = absorbCaption('第一段内容', '完全不同的第二段');
  assert.equal(merged.appended, '完全不同的第二段');
  assert.equal(merged.reset, true);
  assert.equal(merged.text, '第一段内容\n完全不同的第二段');
  assert.equal(merged.text.includes('内容完全不同'), false, '不能把无关的两句粘成一句');
});

test('absorbCaption：空帧不动原文', () => {
  const merged = absorbCaption('原文', '');
  assert.equal(merged.appended, '');
  assert.equal(merged.text, '原文');
});

test('tailOf / clampTail：只保留末尾若干字符', () => {
  assert.equal(tailOf('abcdef', 3), 'def');
  assert.equal(tailOf('ab', 3), 'ab');
  assert.equal(clampTail('abcdef', 3), 'def');
  assert.equal(clampTail('ab', 3), 'ab');
});
