/**
 * 资料树扫描（`scanSubjectMaterials` + 分类函数）的测试。
 *
 * 这套断言对应的不是「能不能列出来」，而是**用户看得见的四件事**：
 *   1. 分组顺序固定（教材 → PPT → 习题 → 讲义 → 其他），0 条的组不出现；
 *   2. `作业/*_OCR文本` 是**该次作业的取字结果**，不能被算进「教材 OCR」；
 *      教材 `_OCR` 下的页级 md 只折成一行（本机有四科 4124 个页级文件，平铺必炸）；
 *   3. 噪音（`.bak-*` / `.old` / `~$*`）、`提交文件/`、`.` 开头目录、`node_modules`
 *      一律不进树 —— 但**要计数**，否则「少了的文件去哪了」永远说不清；
 *   4. 自然序（`第2次` 在 `第10次` 前）与白名单集合（`open` 只认集合里的路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  MATERIAL_SUBJECTS,
  classifyMaterialPath,
  isMaterialNoiseName,
  isMaterialOcrSegment,
  materialKey,
  materialPageNo,
  naturalCompare,
  scanSubjectMaterials,
} from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

const PHYSICS = MATERIAL_SUBJECTS.find((subject) => subject.id === 'c_phy');

/** 建一个空文件（内容无所谓，扫描只看名字与大小）。 */
async function touch(abs, bytes = 'x') {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes, 'utf8');
}

/** 一套刻意塞满边角情况的临时工作区。 */
async function buildFixture() {
  const root = await makeTempDir('study-assistant-scan-');
  const dir = (rel) => path.join(root, rel);
  await touch(dir('物理/教材/大学物理.pdf'), 'pdf');
  await touch(dir('物理/教材/往年扫描/旧版扫描.pdf'), 'pdf');
  await touch(dir('物理/教材/ppt/L1 绪论.pptx'), 'pptx');
  await touch(dir('物理/教材/旧资料.zip'), 'zip');
  await touch(dir('物理/教材/大学物理.pdf.bak-20260101'), 'bak');
  await touch(dir('物理/教材/_OCR/大学物理/page0001.md'), '#1');
  await touch(dir('物理/教材/_OCR/大学物理/page0002.md'), '#2');
  await touch(dir('物理/教材/_OCR/大学物理/page0003.md'), '#3');
  await touch(dir('物理/教材/_OCR/大学物理/page0010.md'), '#10');
  await touch(dir('物理/教材/_OCR/大学物理/_目录.md'), 'toc');
  await touch(dir('物理/教材/ppt/_TEXT/L1 绪论.md'), '#L1');
  await touch(dir('物理/作业/第01次作业_原题.pdf'), 'pdf');
  await touch(dir('物理/作业/第01次作业_OCR文本/page0001.md'), '#1');
  await touch(dir('物理/作业/第01次作业_OCR文本/page0002.md'), '#2');
  await touch(dir('物理/答案/第01次/a.md'), 'a');
  await touch(dir('物理/答案/第02次/c.md'), 'c');
  await touch(dir('物理/答案/第10次/b.md'), 'b');
  await touch(dir('物理/教材习题解法/第01章.md'), '#ch1');
  await touch(dir('物理/往年试题/2024 期中.pdf'), 'pdf');
  await touch(dir('物理/讲义/L0 导论.md'), '#L0');
  await touch(dir('物理/讲义/知识点/A.md'), '#A');
  await touch(dir('物理/EDA讲义/L2.md'), '#L2');
  await touch(dir('物理/_上传/note.txt'), 'n');
  await touch(dir('物理/zz 杂项/其他.pdf'), 'pdf');
  await touch(dir('物理/提交文件/第01次/hw.pdf'), 'pdf');
  await touch(dir('物理/node_modules/pkg/index.js'), 'js');
  await touch(dir('物理/.learn-edge/state.json'), '{}');
  await touch(dir('物理/深/1/2/3/4/5/6/太深了.pdf'), 'pdf');
  return root;
}

test('分类：PPT 扩展名 / 教材 zip / 习题取字 / 教材 OCR / 提交件 各归其位', () => {
  assert.equal(classifyMaterialPath('物理/教材/ppt/L1.pptx').group, 'ppt');
  assert.equal(classifyMaterialPath('物理/教材/大学物理.pdf').group, 'textbook');
  assert.equal(classifyMaterialPath('物理/教材/旧资料.zip').group, 'other');
  assert.equal(classifyMaterialPath('物理/教材/_OCR/大学物理/page0001.md').group, 'textbookOcr');
  assert.equal(classifyMaterialPath('物理/教材/ppt/_TEXT/L1.md').group, 'textbookOcr');
  const homework = classifyMaterialPath('物理/作业/第01次作业_OCR文本/page0001.md');
  assert.equal(homework.group, 'exercise', '作业取字页要留在习题组，不能算教材 OCR');
  assert.equal(homework.hasOcr, true);
  assert.equal(classifyMaterialPath('物理/作业/第01次作业_原题.pdf').hasOcr, false);
  assert.equal(classifyMaterialPath('物理/往年试题/2024.pdf').group, 'exercise');
  assert.equal(classifyMaterialPath('物理/教材习题解法/第01章.md').group, 'exercise');
  assert.equal(classifyMaterialPath('物理/答案/第01次/a.md').group, 'exercise');
  assert.equal(classifyMaterialPath('物理/讲义/知识点/A.md').group, 'lecture');
  assert.equal(classifyMaterialPath('物理/EDA讲义/L2.md').group, 'lecture');
  assert.equal(classifyMaterialPath('物理/zz 杂项/其他.pdf').group, 'other');
  assert.equal(classifyMaterialPath('物理/提交文件/第01次/hw.pdf'), null, '提交件整目录不展示');
  assert.equal(classifyMaterialPath('物理/README.md').group, 'other', '学科根下的散文件归其他');
  assert.equal(classifyMaterialPath('物理'), null);
});

test('分类：噪音文件名与 OCR 段/页码的判定', () => {
  assert.equal(isMaterialNoiseName('第12章_静电场.md.bak-20261124-000719'), true);
  assert.equal(isMaterialNoiseName('L01.2026.md.bak2-20261118'), true);
  assert.equal(isMaterialNoiseName('讲义.pre-20260101.md'), true);
  assert.equal(isMaterialNoiseName('旧版.old'), true);
  assert.equal(isMaterialNoiseName('~$第一章.docx'), true);
  assert.equal(isMaterialNoiseName('第12章_静电场.md'), false);
  assert.equal(isMaterialNoiseName('L01.2026.md'), false);

  assert.equal(isMaterialOcrSegment('_OCR'), true);
  assert.equal(isMaterialOcrSegment('_ocr'), true);
  assert.equal(isMaterialOcrSegment('_TEXT'), true);
  assert.equal(isMaterialOcrSegment('第01次作业_OCR文本'), true);
  assert.equal(isMaterialOcrSegment('OCR文本'), true);
  assert.equal(isMaterialOcrSegment('答案'), false);

  assert.equal(materialPageNo('page0001.md'), 1);
  assert.equal(materialPageNo('page0010.md'), 10);
  assert.equal(materialPageNo('tier-gemini-page07.md'), 7);
  assert.equal(materialPageNo('_目录.md'), null);
  assert.equal(materialPageNo('page1.png'), null);
});

test('自然序：第2次在第10次前，页2在页10前', () => {
  const names = ['第10次', '第2次', '第1次'];
  assert.deepEqual([...names].sort(naturalCompare), ['第1次', '第2次', '第10次']);
  const pages = ['page0010.md', 'page0002.md', 'page0001.md'];
  assert.deepEqual([...pages].sort(naturalCompare), ['page0001.md', 'page0002.md', 'page0010.md']);
  assert.equal(naturalCompare('a', 'a'), 0);
  assert.equal(naturalCompare('', 'b') < 0, true);
});

test('扫描：五组顺序固定、0 条组不出现、页码折叠成一行', async () => {
  const root = await buildFixture();
  try {
    const scan = await scanSubjectMaterials({ rootAbs: root, subject: PHYSICS });
    const payload = scan.payload;
    assert.equal(payload.courseId, 'c_phy');
    assert.equal(payload.courseName, '物理');

    assert.deepEqual(payload.groups.map((group) => group.id), ['textbook', 'ppt', 'exercise', 'lecture', 'other']);

    // 教材组：原件 + OCR 两个子节，顺序固定
    const textbook = payload.groups[0];
    assert.deepEqual(textbook.sections.map((section) => section.id), ['textbook', 'textbookOcr']);
    assert.equal(textbook.sections[0].count, 2, '教材原件只算原件（zip/bak 都不算）');
    assert.deepEqual(textbook.sections[0].root.files.map((file) => file.name), ['大学物理.pdf']);
    assert.deepEqual(textbook.sections[0].root.nodes.map((node) => node.name), ['往年扫描'], '教材这一层要被剥掉');

    // 教材 OCR：页级 md 折成「根目录 → 书」，页码按自然序排、不逐条平铺
    const ocr = textbook.sections[1];
    assert.equal(ocr.kind, 'ocr');
    assert.equal(ocr.count, 6, '4 页 + 1 个 _目录.md + 1 个 _TEXT 文件');
    const ocrRoot = ocr.roots.find((item) => item.path === '教材/_OCR');
    assert.ok(ocrRoot !== undefined);
    assert.equal(ocrRoot.pageCount, 4);
    assert.equal(ocrRoot.count, 5);
    assert.equal(ocrRoot.books.length, 1);
    assert.deepEqual(ocrRoot.books[0].pages, [1, 2, 3, 10]);
    assert.equal(ocrRoot.books[0].files, 1, '_目录.md 是文件不是页');
    assert.equal(ocrRoot.books[0].firstPage, 1);
    assert.equal(ocrRoot.books[0].lastPage, 10);
    const textRoot = ocr.roots.find((item) => item.path === '教材/ppt/_TEXT');
    assert.equal(textRoot.pageCount, 0, '_TEXT 里是整份 md，不是页码文件');

    // 习题组：作业 / 答案 / 教材习题解法 / 往年试题 四个节点，取字结果挂在作业节点上
    const exercise = payload.groups[2];
    const exerciseRoot = exercise.sections[0].root;
    assert.deepEqual(exerciseRoot.nodes.map((node) => node.name), ['作业', '往年试题', '教材习题解法', '答案'], '四类目录按「题目→往年→解法→答案」摆');
    const homework = exerciseRoot.nodes[0];    assert.deepEqual(homework.files.map((file) => file.name), ['第01次作业_原题.pdf']);
    assert.equal(homework.texts.length, 1);
    assert.equal(homework.texts[0].name, '第01次作业_OCR文本');
    assert.equal(homework.texts[0].count, 2);
    const answers = exerciseRoot.nodes[3];
    assert.deepEqual(answers.nodes.map((node) => node.name), ['第01次', '第02次', '第10次'], '答案要按自然序');

    // 讲义 / 其他
    const lecture = payload.groups[3];
    assert.deepEqual(lecture.sections[0].root.nodes.map((node) => node.name), ['讲义', 'EDA讲义']);

    assert.deepEqual(payload.counts, {
      textbook: 2,
      textbookOcr: 6,
      textbookOcrPages: 4,
      ppt: 1,
      exercise: 6,
      exerciseTextFiles: 2,
      exerciseTextPages: 2,
      lecture: 3,
      other: 3,
    });
    assert.equal(payload.total, 2 + 1 + 6 + 8 + 3 + 3);
  } finally {
    await removeTempDir(root);
  }
});

test('扫描：噪音 / 提交件 / 点目录 / 超深 都不进树但要计数，白名单里也没有', async () => {
  const root = await buildFixture();
  try {
    const scan = await scanSubjectMaterials({ rootAbs: root, subject: PHYSICS });
    assert.equal(scan.skipped.noise, 1, '.bak-20260101 只算一个噪音');
    assert.equal(scan.skipped.hidden, 1, '提交文件 目录整目录跳过');
    assert.equal(scan.skipped.dot, 2, 'node_modules 与 .learn-edge 都算点目录');
    assert.equal(scan.skipped.tooDeep, 1, '第 7 层的那份不进树');

    const flat = scan.paths;
    assert.equal(flat.has(materialKey('物理/教材/大学物理.pdf.bak-20260101')), false);
    assert.equal(flat.has(materialKey('物理/提交文件/第01次/hw.pdf')), false);
    assert.equal(flat.has(materialKey('物理/教材/大学物理.pdf')), true);
    assert.equal(scan.dirs.has(materialKey('物理/教材')), true, '目录集合要能定位到目录本身（reveal 用）');
    assert.equal(scan.dirs.has(materialKey('物理/教材/_OCR/大学物理')), true);
  } finally {
    await removeTempDir(root);
  }
});

test('扫描：文件数超上限时报错而不是静默截断', async () => {
  const root = await buildFixture();
  try {
    const scan = await scanSubjectMaterials({ rootAbs: root, subject: PHYSICS, maxFiles: 6 });
    assert.equal(scan.tooMany, true);
    assert.equal(scan.payload, null);
    assert.ok(scan.count > 6);
  } finally {
    await removeTempDir(root);
  }
});

test('扫描：学科目录不存在时回空树而不是抛错', async () => {
  const root = await makeTempDir('study-assistant-scan-empty-');
  try {
    const scan = await scanSubjectMaterials({ rootAbs: root, subject: PHYSICS });
    assert.equal(scan.payload.total, 0);
    assert.deepEqual(scan.payload.groups, []);
    assert.equal(scan.payload.counts.textbook, 0);
  } finally {
    await removeTempDir(root);
  }
});
