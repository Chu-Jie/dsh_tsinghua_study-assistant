import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeBadWords } from '../tools/panel-smoke-badwords.mjs';

const tokensOf = (html) => judgeBadWords(html).map((hit) => hit.token);

// ---------------------------------------------------------------- 正例（必须绿）
// 样本全部来自 2026-11-26 真数据抽样（学习台/资料分析.json 第 39 章讲 IEEE-754 的 NaN）。

test('烟测判据/正例：<code>NaN</code> 是作者引用的字面量，不抓', () => {
  const html = '<p>这句里的 <code>NaN</code> 只是被引用的字面量，别当泄漏。</p>';
  assert.deepEqual(tokensOf(html), []);
});

test('烟测判据/正例：块级公式容器 sa-formula 里的 NaN 是数学记号，不抓', () => {
  const html = '<div class="sa-formula"><div>x&lt;NaN=false, NaN&lt;x=false</div></div>';
  assert.deepEqual(tokensOf(html), []);
});

test('烟测判据/正例：长句中间的 NaN、undefined 是正文，不抓', () => {
  const sentence = '<p>处置：排序前剔除 NaN、或自定义比较器把 NaN 映射为"最大/最小"的确定位置。</p>';
  assert.deepEqual(tokensOf(sentence), []);

  const notes = '<p>旧来源未在 资料索引.json 登记且 page 为 undefined（source-file-not-indexed / 无页码）</p>';
  assert.deepEqual(tokensOf(notes), []);
});

test('烟测判据/正例：出现在 HTML 属性值里的 NaN / undefined 不算渲染出来的值', () => {
  const html = '<div title="共 NaN 条" data-note="undefined">正常正文</div>';
  assert.deepEqual(tokensOf(html), []);
});

test('烟测判据/正例：化学式 NaNbO₃ 与「含 NaN 三个字母」这类正文，不抓', () => {
  const html = '<p>铌酸钠写作 <code>NaNbO₃</code>，里面含 NaN 三个字母。</p>';
  assert.deepEqual(tokensOf(html), []);
});

test('烟测判据/正例：行内公式（span + font-family，无 class）里的 NaN，不抓', () => {
  const html = '<span style="font-family:Georgia,serif">1∼NaN</span>';
  assert.deepEqual(tokensOf(html), []);
});

test('烟测判据/正例：带 LaTeX 命令的公式文本块，不抓', () => {
  const html = '<p>| $1\\sim\\mathrm{NaN}$（不可比） | ✔（两向都 false） |</p>';
  assert.deepEqual(tokensOf(html), []);
});

// ---------------------------------------------------------------- 负例（必须红）
// 四条硬要求（卡 §⑨）+ 四条结构位变体；这些是真泄漏，判据收紧后仍必须抓到。

test('烟测判据/负例：「NaN 分钟」这种数值位必须抓到', () => {
  assert.deepEqual(tokensOf('<span>NaN 分钟</span>'), ['NaN']);
});

test('烟测判据/负例：「共 NaN 条」必须抓到', () => {
  assert.deepEqual(tokensOf('<div>共 NaN 条</div>'), ['NaN']);
});

test('烟测判据/负例：整块只有 undefined 必须抓到', () => {
  assert.deepEqual(tokensOf('<span>undefined</span>'), ['undefined']);
});

test('烟测判据/负例：[object Object] 整块必须抓到', () => {
  assert.deepEqual(tokensOf('<div>[object Object]</div>'), ['[object Object]']);
});

test('烟测判据/负例：整块只有 NaN（表格单元格、徽标）必须抓到', () => {
  assert.deepEqual(tokensOf('<div>NaN</div>'), ['NaN']);
});

test('烟测判据/负例：「用时：NaN」冒号接数值位、坏词在块尾，必须抓到', () => {
  assert.deepEqual(tokensOf('<span>用时：NaN</span>'), ['NaN']);
});

test('烟测判据/负例：日期位 NaN-NaN-NaN 必须抓到', () => {
  assert.deepEqual(tokensOf('<div>NaN-NaN-NaN</div>'), ['NaN']);
});

test('烟测判据/负例：量词前的 undefined（共 undefined 个）必须抓到', () => {
  assert.deepEqual(tokensOf('<div>共 undefined 个</div>'), ['undefined']);
});

test('烟测判据/负例：数值被 span 包起来、后面跟量词，必须抓到', () => {
  assert.deepEqual(tokensOf('<p>共 <span>NaN</span> 条</p>'), ['NaN']);
});

test('烟测判据/负例：百分比位 NaN% 必须抓到', () => {
  assert.deepEqual(tokensOf('<div>NaN%</div>'), ['NaN']);
});

// ---------------------------------------------------------------- 兜底

test('烟测判据/空输入不报错', () => {
  assert.deepEqual(tokensOf(''), []);
  assert.deepEqual(tokensOf(undefined), []);
});
