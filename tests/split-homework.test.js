import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  splitFileText,
  splitPages,
  splitQuestions,
  toQuestionRecord,
} from '../tools/split-homework.mjs';

// 三种实测风格的混合样本：物理（章.题号）、数电（［题 x.y］）、离散（纯数字 + 子题号）
const PHYSICS = `# 第02次作业_原题.pdf · 转写全文

- 目录：\`D:\\workspace\\作业\\物理\\作业\\第02次作业_OCR文本\`
- 页数：3
## 第 1 页

> 通道：gemini

13.2 一质点作简谐振动，求周期。
(1) 振幅 0.1 m；(2) 初相 0。

13.3 两简谐振动合成，求合振幅。
## 第 2 页

> 通道：gemini

13.15 阻尼振动方程，求衰减系数。
`;

const CIRCUIT = `# 第01次作业_原题.pdf · 转写全文
## 第 1 页

> 通道：gemini

［题 1.1］ 用节点电压法求图中各支路电流。
解：设参考节点为 0。

［题 1.2］ 用叠加定理求电流 $I$。
## 第 2 页

> 通道：gemini

［题 1.7］ 一阶电路，求换路后的 $u_C(t)$。
`;

const DISCRETE = `# 第02次作业_原题.pdf · 转写全文
## 第 1 页

> 通道：gemini

1. 第 2 版教材第 14 章习题 39、40(1)(2)。
39. 若无向图 $G$ 中恰有两个奇度顶点，证明这两个奇度顶点必然连通。
40. (1) 设 $u,v$ 为无向完全图 $K_n$ 中的任意两个不同的顶点，问 $d(u,v)$ 等于多少？

## 第 2 页

> 通道：gemini

2. $\\mathrm{K}_4$ 生成子图中有几个不同构的连通图？
`;

test('splitPages：按 `## 第 N 页` 切页，行按原顺序保留', () => {
  const pages = splitPages(PHYSICS);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((item) => item.page), [1, 2]);
  assert.ok(pages[0].lines.join('\n').includes('13.2 一质点作简谐振动'));
  assert.ok(!pages[0].lines.join('\n').includes('13.15 阻尼振动方程'));
});

test('splitQuestions：三种题号风格都能切，子问 (1)(2) 不另起一题', () => {
  const physics = splitQuestions(splitPages(PHYSICS));
  assert.deepEqual(physics.questions.map((item) => item.no), ['13.2', '13.3', '13.15']);
  assert.deepEqual(physics.styles, ['chapter.no']);
  assert.ok(physics.questions[0].lines.join('\n').includes('(1) 振幅 0.1 m'));

  const circuit = splitQuestions(splitPages(CIRCUIT));
  assert.deepEqual(circuit.questions.map((item) => item.no), ['1.1', '1.2', '1.7']);
  assert.deepEqual(circuit.styles, ['bracket']);

  // 离散：`39.` / `40.` 是题目 1 点名的教材习题号，必须并进第 1 题，不能算两题
  const discrete = splitQuestions(splitPages(DISCRETE));
  assert.deepEqual(discrete.questions.map((item) => item.no), ['1', '2']);
  const first = discrete.questions[0].lines.join('\n');
  assert.ok(first.includes('39. 若无向图'));
  assert.ok(first.includes('40. (1) 设'));
});

test('splitPages/splitQuestions：元信息行（> 通道 / - 目录 / 标题）不算题目正文', () => {
  const { records } = splitFileText(PHYSICS, { path: '物理/作业/第02次作业_原题.pdf', courseId: 'physics', homeworkSeq: 2 });
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.ok(!record.prompt.includes('通道：'), `题干里不该出现元信息：${record.prompt}`);
    assert.ok(!record.prompt.includes('目录：'));
  }
});

test('splitFileText：页号跟着题目走（跨页题目算起始页）', () => {
  const { records } = splitFileText(PHYSICS, { path: '物理/作业/第02次作业_原题.pdf', courseId: 'physics', homeworkSeq: 2 });
  assert.deepEqual(records.map((item) => item.page), [1, 1, 2]);
});

test('splitFileText：字段按题目.json 契约，id 稳定、sourceHash 透传、题干太短标待核', () => {
  const { records } = splitFileText(PHYSICS, {
    path: '物理/作业/第02次作业_原题.pdf',
    courseId: 'physics',
    homeworkSeq: 2,
    sourceHash: 'abcdef0123456789',
  });
  const first = records[0];
  assert.equal(first.id, 'q_physics_hw2_13.2');
  assert.equal(first.courseId, 'physics');
  assert.equal(first.sourceFile, '物理/作业/第02次作业_原题.pdf');
  assert.equal(first.sourceHash, 'abcdef0123456789');
  assert.equal(first.homeworkSeq, 2);
  assert.equal(first.kind, 'homework');
  assert.deepEqual(first.knowledgeNames, []);
  assert.equal(first.confidence, 'high');

  const short = toQuestionRecord({ no: '9', style: 'plain', page: 1, lines: ['9. 求值。'] }, {
    path: 'x.pdf', courseId: 'x', homeworkSeq: 1, nos: ['9'], seen: new Map(),
  });
  assert.equal(short.confidence, 'low', '题干不足 12 字要标待核');
});

test('splitFileText：同一题号出现两次时保留更长的一份并记警告', () => {
  // 用不触发人工核对表（KNOWN_NOISE）的来源路径：13.5 那条只在物理第 02 次原题里被排除
  const text = `## 第 1 页\n> 通道：gemini\n\n13.5 短题面。\n## 第 2 页\n> 通道：gemini\n\n13.5 这是更完整的题面，含条件与所求量。\n`;
  const result = splitFileText(text, { path: '物理/作业/第03次作业_原题.pdf', courseId: 'physics', homeworkSeq: 3 });
  assert.equal(result.records.length, 1);
  assert.ok(result.records[0].prompt.includes('更完整的题面'));
  assert.ok(result.warnings.some((item) => item.includes('13.5') && item.includes('两次')));
});

test('splitFileText：人工核对表里的题号被排除（物理第 02 次原题那条假 13.5）', () => {
  const text = '## 第 1 页\n> 通道：gemini\n\n13.2 两均匀带电球壳同心放置，求各区域电场。\n\n13.5 如果在一空间区域中电势是常数，对于这区域内的电场可得出什么结论？\n';
  const excluded = splitFileText(text, { path: '物理/作业/第02次作业_原题.pdf', courseId: 'physics', homeworkSeq: 2 });
  assert.deepEqual(excluded.records.map((item) => item.no), ['13.2']);
  assert.ok(excluded.warnings.some((item) => item.includes('排除题号 13.5')));

  // 附页那份是真的 13.5，不能被排除
  const kept = splitFileText(text, { path: '物理/作业/第02次作业_附_习题13.5题面.pdf', courseId: 'physics', homeworkSeq: 2 });
  assert.deepEqual(kept.records.map((item) => item.no), ['13.2', '13.5']);
});

test('parseArgs：默认 dry，--apply 才写；认得 --only/--data/--workspace', () => {
  const base = parseArgs([]);
  assert.equal(base.apply, false);
  assert.equal(base.only, null);
  const args = parseArgs(['--apply', '--only', 'a.pdf', '--data', '.', '--workspace', '..', '--json']);
  assert.equal(args.apply, true);
  assert.equal(args.only, 'a.pdf');
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
});

test('run：--apply 写题目.json、按来源覆盖、别的来源不动、可重跑', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-hw-'));
  const workspace = path.join(root, 'ws');
  const dataDir = path.join(workspace, '学习台');
  const outDir = path.join(workspace, '物理', '作业', '第02次作业_OCR文本');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '全文.md'), PHYSICS, 'utf8');
  fs.writeFileSync(path.join(workspace, '物理', '作业', '第02次作业_原题.pdf'), 'PDF', 'utf8');
  fs.writeFileSync(path.join(dataDir, '资料索引.json'), JSON.stringify({
    version: 1,
    files: [{
      path: '物理/作业/第02次作业_原题.pdf',
      courseId: 'physics',
      kind: 'homework',
      ocr: { done: true, outDir: '物理/作业/第02次作业_OCR文本' },
    }],
  }), 'utf8');
  const other = {
    id: 'q_other_hw1_1',
    courseId: 'other',
    sourceFile: '别的/作业/第01次作业_原题.pdf',
    sourceHash: 'x',
    homeworkSeq: 1,
    no: '1',
    prompt: '别人的题，不能被删。',
    page: 1,
    kind: 'homework',
    knowledgeNames: [],
    confidence: 'high',
  };
  fs.writeFileSync(path.join(dataDir, '题目.json'), JSON.stringify({ version: 1, updatedAt: null, questions: [other] }), 'utf8');

  const { run } = await import('../tools/split-homework.mjs');
  const lines = [];
  const code = await run(['--data', dataDir, '--workspace', workspace, '--apply', '--quiet'], { log: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));

  const written = JSON.parse(fs.readFileSync(path.join(dataDir, '题目.json'), 'utf8'));
  assert.equal(written.questions.length, 4, '别人 1 题 + 本次 3 题');
  assert.equal(written.questions.filter((item) => item.sourceFile.startsWith('物理/')).length, 3);
  assert.ok(written.questions.some((item) => item.id === 'q_other_hw1_1'), '别的来源必须原样保留');
  assert.equal(written.questions.find((item) => item.no === '13.2').sourceHash.length, 16);
  assert.ok(fs.readdirSync(dataDir).some((name) => name.startsWith('题目.json.bak-')), '写盘前要留备份');

  // 重跑：同参数得到同样的题（幂等），不会越写越多
  const code2 = await run(['--data', dataDir, '--workspace', workspace, '--apply', '--quiet'], { log: () => {} });
  assert.equal(code2, 0);
  const again = JSON.parse(fs.readFileSync(path.join(dataDir, '题目.json'), 'utf8'));
  assert.equal(again.questions.length, 4);
  assert.deepEqual(again.questions.map((item) => item.id).sort(), written.questions.map((item) => item.id).sort());

  fs.rmSync(root, { recursive: true, force: true });
});

test('run：dry 不写盘；没有取字文本时返回 1 并报问题', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-hw-dry-'));
  const dataDir = path.join(root, '学习台');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '资料索引.json'), JSON.stringify({
    version: 1,
    files: [{
      path: '物理/作业/第09次作业_原题.pdf',
      courseId: 'physics',
      kind: 'homework',
      ocr: { done: false, outDir: '物理/作业/第09次作业_OCR文本' },
    }],
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, '题目.json'), JSON.stringify({ version: 1, updatedAt: null, questions: [] }), 'utf8');

  const { run } = await import('../tools/split-homework.mjs');
  const lines = [];
  const code = await run(['--data', dataDir, '--workspace', root], { log: (line) => lines.push(line) });
  assert.equal(code, 1, lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('没找到取字文本')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, '题目.json'), 'utf8')).questions.length, 0, 'dry 不许写盘');
  fs.rmSync(root, { recursive: true, force: true });
});
