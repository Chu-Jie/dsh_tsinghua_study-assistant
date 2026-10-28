/**
 * `tools/ocr-text.mjs` 的单测：模型输出 → 页 的判定。
 *
 * 为什么不测 `tools/ocr-gemini.mjs` 本体：它尾部是顶层 `try/finally` + `process.exit`，
 * 一 import 就会去拉 Edge、渲染 PDF，所以纯文本处理拆到了 `tools/ocr-text.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptSinglePageText,
  extractTranscript,
  qualityOf,
  splitPages,
  stripModelNoise,
} from '../tools/ocr-text.mjs';

test('splitPages 认三种页标记写法（含 markdown 装饰）', () => {
  const a = splitPages('=== 第 1 页 ===\n甲\n=== 第 2 页 ===\n乙');
  assert.deepEqual(a.map((p) => p.no), [1, 2]);
  assert.equal(a[1].body, '乙');

  const b = splitPages('**=== 第 1 页 ===**\n丙\n> === 第 2 页 ===\n丁');
  assert.deepEqual(b.map((p) => p.no), [1, 2]);
  assert.equal(b[0].body, '丙');
});

test('stripModelNoise 只剔整行模型名，正文里的词不动', () => {
  const out = stripModelNoise('Flash\n正文提到 Flash 存储与 Flash 卡\nGemini 2.5 Pro\n');
  assert.ok(!/^Flash$/m.test(out));
  assert.ok(out.includes('正文提到 Flash 存储与 Flash 卡'));
  assert.ok(!/^Gemini 2\.5 Pro$/m.test(out));
});

test('extractTranscript 从第 1 页标记开始，并按页脚截断', () => {
  const raw = 'Gemini 说\n=== 第 1 页 ===\n正文第一页\nGemini 可以出错，请仔细核查';
  const out = extractTranscript(raw);
  assert.ok(out.startsWith('=== 第 1 页 ==='));
  assert.ok(out.includes('正文第一页'));
  assert.ok(!out.includes('Gemini 可以出错'));
  // 没有标记就是 null（老行为）
  assert.equal(extractTranscript('只有一段话，没有标记'), null);
});

test('acceptSinglePageText：单页无标记时整段收，页脚先截掉', () => {
  const body = '一、节点电压法';
  const raw = body + '\n' + 'x'.repeat(60) + '\nGemini 可以出错，请仔细核查';
  const r = acceptSinglePageText(raw, '');
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith('=== 第 1 页 ==='));
  assert.ok(!r.text.includes('Gemini 可以出错'));
  assert.equal(r.chars, body.length + 1 + 60);
  // 收下后能被 splitPages 切成 1 页（tierGemini 后续逻辑的前提）
  assert.equal(splitPages(r.text).length, 1);
});

test('acceptSinglePageText：太短、整页 innerText 带 UI 噪声都拒收', () => {
  const short = acceptSinglePageText('太短', '');
  assert.equal(short.ok, false);
  assert.equal(short.reason, 'too-short');

  // 拿不到 model-response 时退回 document.body.innerText，里面混着提问原文/按钮文案
  const page = '你说\n只做文字转写…\n' + 'y'.repeat(80) + '\n输入消息';
  const r = acceptSinglePageText('', page);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ui-noise');
});

test('qualityOf 抓「同一字母刷屏」', () => {
  assert.equal(qualityOf('abc abc abc').suspect, false);
  assert.equal(qualityOf('ABCDEFGHIJ ' + 'A'.repeat(80)).suspect, true);
});
