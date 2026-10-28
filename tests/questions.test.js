/**
 * lib/questions.js 的测试：分题、确认、答案对齐、泄题自检。
 *
 * 这一层是纯函数，所以测试不写盘、不起宿主；样例尽量贴真实 PDF 的怪样子
 * （数学斜体、全角括号、正文里的编号、页码冒充题号）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText,
  normalizeForMatch,
  cnToInt,
  splitQuestions,
  confirmDraft,
  alignAnswers,
  validateAnswer,
  warningFor,
} from '../lib/questions.js';

test('normalizeText：NFKC 把数学斜体变回 ASCII，全角括号与全角空格一并归一', () => {
  // U+1D400 MATHEMATICAL BOLD CAPITAL A，PDF 文字层里真实存在
  assert.equal(normalizeText('32\ud835\udc00',), '32A');
  assert.equal(normalizeText('（1）\u3000求导'), '(1) 求导');
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(123), '');
});

test('normalizeForMatch：去全部空白并小写', () => {
  assert.equal(normalizeForMatch(' A  B\nC '), 'abc');
  assert.equal(normalizeForMatch(undefined), '');
});

test('cnToInt：一位、十、十几、二十几', () => {
  assert.equal(cnToInt('一'), 1);
  assert.equal(cnToInt('两'), 2);
  assert.equal(cnToInt('十'), 10);
  assert.equal(cnToInt('十一'), 11);
  assert.equal(cnToInt('二十三'), 23);
  assert.equal(cnToInt(''), null);
  assert.equal(cnToInt('甲'), null);
});

test('splitQuestions：阿拉伯题号按行首切，题干跨行保留换行', () => {
  const text = [
    '第 01 次作业（共 3 题）',
    '1. 求函数 f(x)=x^2 在 [0,1] 上的定积分。',
    '要求写出过程。',
    '2. 证明级数收敛。',
    '3. 计算行列式。',
  ].join('\n');
  const result = splitQuestions(text);
  assert.equal(result.questions.length, 3);
  assert.deepEqual(result.questions.map((q) => q.no), [1, 2, 3]);
  assert.match(result.questions[0].prompt, /求函数/);
  assert.match(result.questions[0].prompt, /要求写出过程/);
  // NFKC 会把全角括号也归一成半角，preamble 跟着变
  assert.equal(result.preamble, '第 01 次作业(共 3 题)');
  assert.deepEqual(result.warnings, []);
});

test('splitQuestions：中文题号与全角括号题号都认', () => {
  const cn = splitQuestions('一、第一问的题干\n二、第二问的题干');
  assert.deepEqual(cn.questions.map((q) => q.no), [1, 2]);

  const paren = splitQuestions('（1）第一问\n（2）第二问');
  assert.deepEqual(paren.questions.map((q) => q.no), [1, 2]);

  const parenHalf = splitQuestions('(1) 第一问\n(2) 第二问');
  assert.deepEqual(parenHalf.questions.map((q) => q.no), [1, 2]);
});

test('splitQuestions：正文里的编号不进题号（只认行首）', () => {
  const text = '1. 计算 3.14 与 2) 的乘积，并说明 32A3 的含义。\n2. 第二题题干在这里。';
  const result = splitQuestions(text);
  assert.equal(result.questions.length, 2);
  assert.match(result.questions[0].prompt, /32A3/);
});

test('splitQuestions：跳号与重复题号进 warnings，不硬猜', () => {
  const skipped = splitQuestions('1. 一\n2. 二\n4. 四');
  assert.deepEqual(skipped.questions.map((q) => q.no), [1, 2]);
  assert.ok(skipped.warnings.some((w) => w.code === 'skipped-number' && w.no === 4));

  const dup = splitQuestions('1. 一\n1. 又一遍\n2. 二');
  assert.deepEqual(dup.questions.map((q) => q.no), [1, 2]);
  assert.ok(dup.warnings.some((w) => w.code === 'duplicate-number' && w.no === 1));
});

test('splitQuestions：过短的题干报 short-question', () => {
  const result = splitQuestions('1. 一\n2. 二\n3. 三\n4. 四\n5. 五\n6. \n7. 七');
  assert.ok(result.warnings.some((w) => w.code === 'short-question'));
});

test('splitQuestions：优先从 1 起，别把说明里的编号列表当题目', () => {
  const text = [
    '本次作业要求：',
    '1. 手写',
    '2. 拍照上传',
    '1. 第一道真正的题（题干足够长）',
    '2. 第二道真正的题（题干足够长）',
    '3. 第三道真正的题（题干足够长）',
  ].join('\n');
  const result = splitQuestions(text);
  assert.equal(result.questions.length, 3);
  assert.match(result.questions[0].prompt, /第一道真正的题/);
  assert.match(result.preamble, /本次作业要求/);
});

test('splitQuestions：没有题号时整段当一道题并报 no-numbering', () => {
  const result = splitQuestions('请证明：任意三个连续整数之积能被 6 整除。');
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].no, 1);
  assert.match(result.questions[0].prompt, /连续整数/);
  assert.deepEqual(result.warnings.map((w) => w.code), ['no-numbering']);
});

test('splitQuestions：空文本返回空题表与 empty-text', () => {
  const result = splitQuestions('   \n\n ');
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.warnings.map((w) => w.code), ['empty-text']);
});

test('confirmDraft：校验题号与题干，重复题号保留第一条并报 warning', () => {
  const ok = confirmDraft([
    { no: 2, prompt: '第二题', guide: '', answer: '答案二' },
    { no: 1, prompt: '第一题' },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.questions.map((q) => q.no), [1, 2]);
  assert.equal(ok.questions[0].guide, null);
  assert.deepEqual(ok.questions[0].kpIds, []);

  const dup = confirmDraft([{ no: 1, prompt: '甲' }, { no: 1, prompt: '乙' }]);
  assert.equal(dup.ok, true);
  assert.equal(dup.questions.length, 1);
  assert.ok(dup.warnings.some((w) => w.code === 'duplicate-number'));
});

test('confirmDraft：坏题号、空题干、空列表各自报 reason', () => {
  assert.equal(confirmDraft([]).reason, 'empty');
  assert.equal(confirmDraft([{ no: 0, prompt: '甲' }]).reason, 'bad-number');
  assert.equal(confirmDraft([{ no: 1.5, prompt: '甲' }]).reason, 'bad-number');
  assert.equal(confirmDraft([{ no: 100, prompt: '甲' }]).reason, 'bad-number');
  assert.equal(confirmDraft([{ no: 1, prompt: '   ' }]).reason, 'empty-prompt');
});

test('alignAnswers：题号对得上的贴回去，缺的与多的各自报出来', () => {
  const questions = [{ no: 1, prompt: '甲' }, { no: 2, prompt: '乙' }, { no: 3, prompt: '丙' }];
  const result = alignAnswers(questions, '1. 答案甲\n3. 答案丙\n4. 多出来的');
  assert.equal(result.matched, 2);
  assert.deepEqual(result.missing, [2]);
  assert.deepEqual(result.extra, [4]);
  assert.equal(result.questions[0].answer, '答案甲');
  assert.equal(result.questions[1].answer, null);
  assert.equal(result.questions[2].answer, '答案丙');
});

test('validateAnswer：答案原样出现在辅导版里才算泄漏', () => {
  const leaked = validateAnswer({
    prompt: '求 f(x)=x^2 在 [0,1] 上的定积分。',
    guide: '先找原函数，答案就是 1/3，代进去即可。',
    finalAnswer: '答案就是 1/3',
  });
  assert.equal(leaked.risk, true);
  assert.deepEqual(leaked.reasons, ['answer-leaked-in-guide']);

  // 答案本来就写在题干里（例如「求证 1+1=2」），不算泄漏
  const inPrompt = validateAnswer({
    prompt: '请证明 1+2=3 成立。',
    guide: '想一想加法交换律。',
    finalAnswer: '1+2=3',
  });
  assert.equal(inPrompt.risk, false);

  // 太短的答案（单个数字、单个符号）不做判断，避免 1/3 与 1/30 这种误报
  const tooShort = validateAnswer({ prompt: '甲', guide: '就是 1', finalAnswer: '1' });
  assert.equal(tooShort.risk, false);

  // 空值不炸
  assert.deepEqual(validateAnswer(null), { risk: false, reasons: [] });
});

test('warnings 都带人话 message，面板不必再翻译 code', () => {
  const noNumbering = splitQuestions('随便一段没有题号的文字，长度足够当一道题。');
  assert.ok(noNumbering.warnings.every((w) => typeof w.message === 'string' && w.message !== ''));
  assert.notEqual(noNumbering.warnings[0].message, noNumbering.warnings[0].code);

  const numbered = splitQuestions('1. 甲甲乙乙丙丙丁丁\n2. 戊戊己己庚庚辛辛\n4. 壬壬癸癸子子丑丑');
  const skipped = numbered.warnings.find((w) => w.code === 'skipped-number');
  assert.ok(skipped.message.includes('缺题'));
  assert.equal(skipped.no, 4);
});

test('warningFor：嫌疑符号字体带上比例与字符', () => {
  const warning = warningFor('suspect-symbol-font', { char: 'A', ratio: 0.7512 });
  assert.equal(warning.code, 'suspect-symbol-font');
  assert.ok(warning.message.includes('75%'));
  assert.ok(warning.message.includes('A'));
  assert.equal(warning.ratio, 0.7512);
  // 未知 code 退化成 code 本身，不抛异常
  assert.equal(warningFor('mystery').message, 'mystery');
});
