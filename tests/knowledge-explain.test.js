/**
 * 讲解通道的纯逻辑测试：三档固定指令、资料片段预算、缓存文件格式。
 *
 * 这三档指令是任务单 §7 阶段 E 定的原文，用户要求**不要改写** ——
 * 所以这里逐字断言，防止以后「顺手润色」把约定改掉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_MAX_CHARS,
  EXPLAIN_STYLES,
  buildEvidenceDigest,
  buildExplainPrompt,
  clipText,
  explainFileName,
  instructionFor,
  parseExplainFile,
  renderExplainFile,
  styleByKey,
  styleKeys,
} from '../lib/knowledge-explain.js';

test('三档固定指令：键、顺序、原文', () => {
  assert.equal(JSON.stringify(styleKeys()), JSON.stringify(['assistant', 'exam', 'hint']));
  assert.equal(JSON.stringify(EXPLAIN_STYLES.map((item) => item.label)), JSON.stringify(['助教推导', '考前速通', '只给提示']));
  const byKey = Object.fromEntries(EXPLAIN_STYLES.map((item) => [item.key, item.instruction]));
  // 原文逐字（任务单 §7 阶段 E）
  assert.ok(byKey.assistant.includes('你是这门课的助教。针对「{知识点}」，只用资料里的内容，分步推导：'));
  assert.ok(byKey.assistant.includes('先给结论，再给 3–5 步过程（每步一句），最后点出这一步的考点与常见错法。'));
  assert.ok(byKey.assistant.includes('资料里没有的内容不要编，缺什么直接说「资料未覆盖」。'));
  assert.ok(byKey.exam.includes('针对「{知识点}」，三分钟内能看完：一句话定义、一个必背公式/结论、'));
  assert.ok(byKey.exam.includes('两个最容易错的点、一道最典型的题（只给题号，不展开）。不要推导过程。'));
  assert.ok(byKey.hint.includes('针对「{知识点}」，我卡住了。只给我第一步做什么和一个方向性提示，'));
  assert.ok(byKey.hint.includes('不要给答案、不要给完整步骤。如果我追问，再逐级多给一点。'));
});

test('styleByKey：认不出的返回 null，空串也返回 null', () => {
  assert.equal(styleByKey('assistant').label, '助教推导');
  assert.equal(styleByKey(''), null);
  assert.equal(styleByKey('nope'), null);
  assert.equal(styleByKey(null), null);
});

test('instructionFor：只替换知识点占位符，其余原样', () => {
  const style = styleByKey('exam');
  const text = instructionFor(style, ' 卡诺图 ');
  assert.ok(text.includes('针对「卡诺图」，三分钟内能看完'));
  assert.ok(!text.includes('{知识点}'));
  // 没有被替换掉的行也要原样留着
  assert.ok(text.includes('两个最容易错的点、一道最典型的题（只给题号，不展开）。不要推导过程。'));
});

test('buildExplainPrompt：有证据时带上资料片段块，没证据时要求说未覆盖', () => {
  const style = styleByKey('assistant');
  const withEvidence = buildExplainPrompt({ style, name: '节点电压法', evidence: '—— 题目 1.1（数电第01次作业 第 1 页）\n求节点电压。' });
  assert.ok(withEvidence.startsWith('你是这门课的助教。针对「节点电压法」'));
  assert.ok(withEvidence.includes('【资料片段】'));
  assert.ok(withEvidence.includes('只能依据这些内容作答'));
  assert.ok(withEvidence.includes('求节点电压。'));

  const noEvidence = buildExplainPrompt({ style, name: '节点电压法', evidence: '' });
  assert.ok(noEvidence.includes('资料未覆盖'));
  assert.ok(!noEvidence.includes('【资料片段】'));
});

test('clipText：超长截断并留省略号，CRLF 归一', () => {
  assert.equal(clipText('a\r\nb'), 'a\nb');
  assert.equal(clipText('x'.repeat(10), 100), 'x'.repeat(10));
  const clipped = clipText('y'.repeat(50), 10);
  assert.equal(clipped.length, 11);
  assert.ok(clipped.endsWith('…'));
});

test('buildEvidenceDigest：按预算拼、超预算的丢弃并计数', () => {
  const digest = buildEvidenceDigest([
    { label: '题目 1', text: '甲'.repeat(100) },
    { label: '资料 A 第 2 页', text: '乙'.repeat(100) },
  ]);
  assert.ok(digest.text.includes('—— 题目 1'));
  assert.ok(digest.text.includes('—— 资料 A 第 2 页'));
  assert.equal(digest.dropped, 0);
  assert.ok(digest.used > 200);

  // 预算只够装一条
  const tight = buildEvidenceDigest(
    [
      { label: '一', text: 'a'.repeat(80) },
      { label: '二', text: 'b'.repeat(80) },
    ],
    { maxChars: 120 },
  );
  assert.ok(tight.text.includes('—— 一'));
  assert.ok(!tight.text.includes('—— 二'));
  assert.equal(tight.dropped, 1);

  // 空文本条目也算丢弃
  const empty = buildEvidenceDigest([{ label: '空', text: '   ' }]);
  assert.equal(empty.text, '');
  assert.equal(empty.dropped, 1);
  assert.ok(EVIDENCE_MAX_CHARS >= 2000);
});

test('explainFileName：白名单掉路径分隔符与点前缀', () => {
  assert.equal(explainFileName('k_0123456789', 'assistant'), 'k_0123456789-assistant.md');
  const evil = explainFileName('../../evil', 'exam');
  assert.ok(!evil.includes('/'));
  assert.ok(!evil.startsWith('.'));
  assert.ok(evil.endsWith('-exam.md'));
  assert.equal(explainFileName('', 'hint'), '_-hint.md');
  assert.equal(explainFileName('a b', 'unknown style'), 'a_b-unknownstyle.md');
});

test('缓存文件：render 出来的头能被 parse 回来（往返一致）', () => {
  const raw = renderExplainFile(
    { name: '卡诺图', styleLabel: '助教推导', generatedAt: '2026-10-21T01:00:00.000Z', model: '', nodeId: 'k_abc', notebook: '宿主内模型（无外部笔记本）' },
    '## 结论\n用卡诺图化简。\n',
  );
  const parsed = parseExplainFile(raw);
  assert.equal(parsed.hasHeader, true);
  assert.equal(parsed.meta['知识点'], '卡诺图');
  assert.equal(parsed.meta['风格'], '助教推导');
  assert.equal(parsed.meta['生成时间'], '2026-10-21T01:00:00.000Z');
  assert.equal(parsed.meta['节点'], 'k_abc');
  assert.equal(parsed.text, '## 结论\n用卡诺图化简。');
});

test('缓存文件：没有头（手改过）也不抛，全文当正文', () => {
  const parsed = parseExplainFile('## 随便写的东西\n正文');
  assert.equal(parsed.hasHeader, false);
  assert.equal(parsed.text, '## 随便写的东西\n正文');
  assert.equal(JSON.stringify(parsed.meta), '{}');
});
