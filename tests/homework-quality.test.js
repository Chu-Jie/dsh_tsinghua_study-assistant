/**
 * 文字层质量门的测试。
 *
 * 用的是现场真实的两份样本：
 *   - 数据结构第 01 次作业：数学符号全被压成 U+1D400（`𝐀`），NFKC 后一律 `A`；
 *   - 数据结构第 02 次作业：文字层正常，英文字母分布正常。
 * 这两份的判断如果反过来（正常的被判可疑 / 坏掉的被放行），质量门就等于没做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeTextQuality, QUALITY_MIN_LETTERS, QUALITY_TOP_RATIO } from '../lib/homework.js';
import { normalizeText } from '../lib/questions.js';

test('analyzeTextQuality：正常题面不报警', () => {
  const text = normalizeText(
    '1. 计算以下 C++ 程序段的时间复杂度：\n'
    + 'a) for(int i = 2; i < n; i = i * i) { continue; }\n'
    + 'b) for(int j = n; j > 1; j = j / 3) { sum += j; }\n'
    + 'c) while (low <= high) { mid = (low + high) / 2; if (a[mid] < key) low = mid + 1; else high = mid - 1; }\n'
    + 'd) 请利用 Master Theorem 求解下列递推式，并指出对应算法。',
  );
  const result = analyzeTextQuality(text);
  assert.equal(result.suspect, false);
  assert.ok(result.letters >= QUALITY_MIN_LETTERS);
  assert.ok(result.ratio < QUALITY_TOP_RATIO);
});

test('analyzeTextQuality：数学符号被压成同一个字母时报警', () => {
  // 真实取字结果（第 01 次作业，109 个字母里 96 个是 A，占 88%）
  const text = normalizeText(
    '1. 证明：\n3\n2A3 −\n3\n3A4 − 4A5 + 5A6 + 6A7 + 7A8 + 8A9 + A2019\n'
    + 'A6 − 5A3 + 1970 = A(A7)\n'
    + '2. 设A(A) = A(A2), A(A) = A(A)。证明或证伪以下命题：\n'
    + 'a) A(A) = A(A(A))\nb) A(A) + A(A) = A(A + A)\n'
    + 'c) 若A(A) ≤ A(A)，则A(A) ≤ A(A)\n'
    + '3. 已知A(A) = A(A)，A(A) = A(A)，求A(A + A) 与 A(A · A)。',
  );
  const result = analyzeTextQuality(text);
  assert.equal(result.letters >= QUALITY_MIN_LETTERS, true);
  assert.equal(result.suspect, true);
  assert.equal(result.char, 'A');
  assert.ok(result.ratio >= QUALITY_TOP_RATIO);
});

test('analyzeTextQuality：字母太少时不下结论', () => {
  const result = analyzeTextQuality(normalizeText('1. 证明：A = A2'));
  assert.equal(result.suspect, false);
  assert.ok(result.letters < QUALITY_MIN_LETTERS);
  assert.equal(result.char, '');
  assert.equal(result.ratio, 0);
});

test('analyzeTextQuality：非字符串输入不抛异常', () => {
  for (const input of [undefined, null, 42, {}]) {
    const result = analyzeTextQuality(input);
    assert.deepEqual(result, { suspect: false, letters: 0, char: '', ratio: 0 });
  }
});
