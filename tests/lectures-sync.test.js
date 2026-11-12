import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLectureFilename,
  isLectureNoise,
  scanLectures,
  syncMaterialsIndex,
  courseIdForSubdir,
  discoverLectureJobs,
  runSync,
} from '../tools/lectures-sync.mjs';

const LECTURE_A = '第01章-数制与码制-A-严谨体系式.md';
const LECTURE_B = '第02章-逻辑代数基础-B-速查对比式.md';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 搭一个最小工作区：`<tmp>/学习台/*.json` + `<tmp>/数电/讲义/*.md`。
 * 工作区根＝`学习台` 的父目录，与 lib/api.js 的 workspaceRoot 同一口径。
 */
function makeWorkspace(t, { files = {}, indexFiles = [], chapters = [] } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lectures-sync-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dataDir = path.join(workspace, '学习台');
  const lectureDir = path.join(workspace, '数电', '讲义');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(lectureDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(lectureDir, name), text, 'utf8');
  fs.writeFileSync(path.join(dataDir, '资料索引.json'), `${JSON.stringify({ version: 1, updatedAt: null, files: indexFiles }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, '资料分析.json'), `${JSON.stringify({ version: 1, updatedAt: null, courses: [], runs: [] }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, '知识点大纲.json'), `${JSON.stringify({ version: 1, updatedAt: null, courses: [{ courseId: 'c_digital', chapters }] }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, '课程.json'), `${JSON.stringify({ version: 1, updatedAt: null, courses: [] }, null, 2)}\n`, 'utf8');
  return { workspace, dataDir, lectureDir, materialsFile: path.join(dataDir, '资料索引.json'), analysisFile: path.join(dataDir, '资料分析.json') };
}

const silent = { log: () => {}, error: () => {} };

test('lectures-sync：文件名识别 A/B/C 与 C2/C3，跳过索引和备份', () => {
  assert.deepEqual(parseLectureFilename('第01章-数制与码制-A-严谨体系式.md'), { no: '1', fileTitle: '数制与码制', key: 'A', label: '严谨体系式' });
  assert.equal(parseLectureFilename('第01章-数制与码制-C3-零基础问题驱动-术语后置.md').key, 'C3');
  assert.equal(parseLectureFilename('_讲义索引.md'), null);
  assert.equal(parseLectureFilename('_bak-第02章-B.md.bak'), null);
  assert.equal(parseLectureFilename('README-三版对比.md'), null);
});

test('lectures-sync：黑名单挡掉手写索引、README 与编辑器残留', () => {
  assert.equal(isLectureNoise('_讲义索引.md'), true);
  assert.equal(isLectureNoise('README-三版对比与提示词.md'), true);
  assert.equal(isLectureNoise('readme.md'), true);
  assert.equal(isLectureNoise('_bak-第02章-B.md.bak'), true);
  assert.equal(isLectureNoise('第02章-甲-A-严谨体系式.md.bak'), true);
  assert.equal(isLectureNoise('第02章-甲-A-严谨体系式.md~'), true);
  assert.equal(isLectureNoise('教材.pdf'), true);
  assert.equal(isLectureNoise(LECTURE_A), false);
  assert.equal(isLectureNoise(LECTURE_B), false);
});

test('lectures-sync：按章合并、风格与变体分开、统计汉字并报未登记路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectures-sync-'));
  fs.writeFileSync(path.join(dir, '第01章-甲-A-严谨体系式.md'), '甲 abc');
  fs.writeFileSync(path.join(dir, '第01章-甲-C2-零基础问题驱动.md'), '甲乙丙');
  fs.writeFileSync(path.join(dir, '_讲义索引.md'), '不收');
  const result = scanLectures({
    dir,
    courseId: 'c_digital',
    outline: { courses: [{ courseId: 'c_digital', chapters: [{ no: 1, title: '乙' }] }] },
    materials: { files: [{ path: '数电/讲义/第01章-甲-A-严谨体系式.md' }] },
  });
  assert.equal(result.lectures.length, 1);
  assert.equal(result.lectures[0].no, '1');
  assert.equal(result.lectures[0].title, '乙');
  assert.equal(result.lectures[0].styles[0].chars, 1);
  assert.equal(result.lectures[0].variants[0].parent, 'C');
  assert.ok(result.warnings.some((item) => item.includes('标题不一致')));
  assert.ok(result.warnings.some((item) => item.includes('资料索引没有登记')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lectures-sync：磁盘上新出现的讲义会被补进 资料索引.json', (t) => {
  const { lectureDir, materialsFile } = makeWorkspace(t, {
    files: { [LECTURE_A]: '甲', [LECTURE_B]: '乙' },
    // 索引里只有第 01 章 A，第 02 章 B 是新生成的
    indexFiles: [{ path: '数电/讲义/第01章-数制与码制-A-严谨体系式.md', courseId: 'c_digital', kind: 'lecture', textLayer: true, title: '第01章-数制与码制-A-严谨体系式', text: { outFile: '数电/讲义/第01章-数制与码制-A-严谨体系式.md' } }],
  });
  const materials = readJson(materialsFile);
  const result = syncMaterialsIndex({ materials, dir: lectureDir, courseId: 'c_digital', subdir: '数电/讲义' });
  assert.deepEqual(result.added, ['数电/讲义/第02章-逻辑代数基础-B-速查对比式.md']);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.doc.files.length, 2);
  // 追加在末尾，已有条目顺序不动
  assert.equal(result.doc.files[0].path, '数电/讲义/第01章-数制与码制-A-严谨体系式.md');
  assert.deepEqual(result.doc.files[1], {
    path: '数电/讲义/第02章-逻辑代数基础-B-速查对比式.md',
    courseId: 'c_digital',
    kind: 'lecture',
    textLayer: true,
    title: '第02章-逻辑代数基础-B-速查对比式',
    text: { outFile: '数电/讲义/第02章-逻辑代数基础-B-速查对比式.md' },
  });
});

test('lectures-sync：磁盘上删掉的讲义会从索引移除，别的科目不动', (t) => {
  const { lectureDir, materialsFile } = makeWorkspace(t, {
    files: { [LECTURE_A]: '甲' },
    indexFiles: [
      { path: '数电/讲义/第01章-数制与码制-A-严谨体系式.md', courseId: 'c_digital', kind: 'lecture', textLayer: true, title: '第01章-数制与码制-A-严谨体系式', text: { outFile: '数电/讲义/第01章-数制与码制-A-严谨体系式.md' } },
      // 磁盘上已经没有这篇了
      { path: '数电/讲义/第09章-已删除章节-A-严谨体系式.md', courseId: 'c_digital', kind: 'lecture', textLayer: true, title: '第09章-已删除章节-A-严谨体系式', text: { outFile: '数电/讲义/第09章-已删除章节-A-严谨体系式.md' } },
      // 别的科目的登记：不在本次前缀内，必须原样保留
      { path: '物理/讲义/第12章-静电场-A-严谨体系式.md', courseId: 'c_phy', kind: 'lecture', textLayer: true, title: '第12章-静电场-A-严谨体系式', text: { outFile: '物理/讲义/第12章-静电场-A-严谨体系式.md' } },
      // 非 lecture 的登记也一律不动
      { path: '数电/教材/数电教材.pdf', courseId: 'c_digital', kind: 'textbook', textLayer: false, ocr: null },
    ],
  });
  const materials = readJson(materialsFile);
  const result = syncMaterialsIndex({ materials, dir: lectureDir, courseId: 'c_digital', subdir: '数电/讲义' });
  assert.deepEqual(result.removed, ['数电/讲义/第09章-已删除章节-A-严谨体系式.md']);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.doc.files.map((item) => item.path), [
    '数电/讲义/第01章-数制与码制-A-严谨体系式.md',
    '物理/讲义/第12章-静电场-A-严谨体系式.md',
    '数电/教材/数电教材.pdf',
  ]);
});

test('lectures-sync：噪音文件与不合规命名都不进索引', (t) => {
  const { lectureDir, materialsFile } = makeWorkspace(t, {
    files: {
      [LECTURE_A]: '甲',
      '_讲义索引.md': '手写索引',
      'README-三版对比与提示词.md': '说明',
      '第02章-逻辑代数基础-A-严谨体系式.md.bak': '备份',
      '随手记.md': '不符合 第NN章-标题-风格 命名',
    },
    indexFiles: [],
  });
  const materials = readJson(materialsFile);
  const result = syncMaterialsIndex({ materials, dir: lectureDir, courseId: 'c_digital', subdir: '数电/讲义' });
  assert.deepEqual(result.doc.files.map((item) => item.path), ['数电/讲义/第01章-数制与码制-A-严谨体系式.md']);
  assert.deepEqual(result.added, ['数电/讲义/第01章-数制与码制-A-严谨体系式.md']);
  assert.ok(result.warnings.some((item) => item.includes('随手记.md')), '不合规命名要留一条 warning');
  assert.ok(!result.warnings.some((item) => item.includes('_讲义索引.md')), '噪音文件连 warning 都不该有');
  assert.ok(!result.warnings.some((item) => item.includes('README-')), '噪音文件连 warning 都不该有');
});

test('lectures-sync：已有条目的派生字段漂移会就地刷新，人工字段保留', (t) => {
  const { lectureDir, materialsFile } = makeWorkspace(t, {
    files: { [LECTURE_A]: '甲' },
    indexFiles: [{
      path: '数电/讲义/第01章-数制与码制-A-严谨体系式.md',
      courseId: 'c_wrong',
      kind: 'lecture',
      textLayer: false,
      title: '旧标题',
      text: { outFile: '数电/讲义/旧路径.md', note: '人工补的字段' },
    }],
  });
  const materials = readJson(materialsFile);
  const result = syncMaterialsIndex({ materials, dir: lectureDir, courseId: 'c_digital', subdir: '数电/讲义' });
  assert.deepEqual(result.updated, ['数电/讲义/第01章-数制与码制-A-严谨体系式.md']);
  assert.deepEqual(result.added, []);
  assert.equal(result.doc.files[0].courseId, 'c_digital');
  assert.equal(result.doc.files[0].textLayer, true);
  assert.equal(result.doc.files[0].title, '第01章-数制与码制-A-严谨体系式');
  assert.deepEqual(result.doc.files[0].text, { outFile: '数电/讲义/第01章-数制与码制-A-严谨体系式.md', note: '人工补的字段' });
});

test('lectures-sync：默认 dry-run 不写盘，--apply 才写且两处一致', async (t) => {
  const { dataDir, lectureDir, materialsFile, analysisFile } = makeWorkspace(t, {
    files: { [LECTURE_A]: '甲', [LECTURE_B]: '乙' },
    indexFiles: [],
    chapters: [{ no: 1, title: '数制与码制' }, { no: 2, title: '逻辑代数基础' }],
  });
  const before = { index: fs.readFileSync(materialsFile, 'utf8'), analysis: fs.readFileSync(analysisFile, 'utf8') };

  // 1) dry-run：报告有新增，但磁盘一个字节都不许变
  const dry = await runSync(['--data', dataDir, '--dir', lectureDir, '--course', 'c_digital'], silent);
  assert.equal(dry.apply, false);
  assert.equal(dry.written.length, 0);
  assert.deepEqual(dry.jobs[0].index.added.sort(), [
    '数电/讲义/第01章-数制与码制-A-严谨体系式.md',
    '数电/讲义/第02章-逻辑代数基础-B-速查对比式.md',
  ]);
  assert.equal(fs.readFileSync(materialsFile, 'utf8'), before.index, 'dry-run 不许改 资料索引.json');
  assert.equal(fs.readFileSync(analysisFile, 'utf8'), before.analysis, 'dry-run 不许改 资料分析.json');

  // 2) --apply：两份文档都写盘，且走 writeDocument（先备份）
  const applied = await runSync(['--apply', '--data', dataDir, '--dir', lectureDir, '--course', 'c_digital'], silent);
  assert.equal(applied.apply, true);
  assert.deepEqual(applied.written, ['资料索引.json', '资料分析.json']);
  assert.ok(fs.existsSync(path.join(dataDir, '备份')), '写入前必须留备份');

  // 3) 两边一致：`资料分析.json` 里**当前生效**的讲义文件集合
  //    与 `资料索引.json` 的 kind:'lecture' path 集合逐条对应。
  //    「当前生效」= styles[] 全部 + variants[] 里没标 supersededBy 的（C2/C3 这类并列风格）；
  //    标了 supersededBy 的是 W4 的版本历史（旧文件可能已被删、索引里也没有），不参与这条比对。
  const index = readJson(materialsFile);
  const analysis = readJson(analysisFile);
  const indexPaths = index.files.filter((item) => item.kind === 'lecture').map((item) => item.path).sort();
  const analysisPaths = [...new Set((analysis.courses.find((course) => course.courseId === 'c_digital')?.lectures ?? [])
    .flatMap((lecture) => [
      ...(lecture.styles ?? []),
      ...(lecture.variants ?? []).filter((style) => style.supersededBy === undefined),
    ])
    .map((style) => style.file))].sort();
  assert.deepEqual(indexPaths, analysisPaths);
  assert.equal(indexPaths.length, 2);
});

test('lectures-sync：--all 从现有登记反推 courseId，并跳过没有讲义目录的科目', (t) => {
  const { workspace, dataDir, lectureDir } = makeWorkspace(t, {
    files: { [LECTURE_A]: '甲' },
    indexFiles: [{ path: '数电/讲义/第09章-已删除章节-A-严谨体系式.md', courseId: 'c_digital', kind: 'lecture', textLayer: true, title: '第09章-已删除章节-A-严谨体系式', text: { outFile: '数电/讲义/第09章-已删除章节-A-严谨体系式.md' } }],
  });
  // 再来一个没有讲义目录的科目目录，--all 必须忽略它
  fs.mkdirSync(path.join(workspace, '马克思主义', '教材'), { recursive: true });

  assert.deepEqual(discoverLectureJobs(workspace).map((job) => job.subdir), ['数电/讲义']);
  assert.equal(courseIdForSubdir('数电/讲义', readJson(path.join(dataDir, '资料索引.json')), { courses: [] }), 'c_digital');
  // 没有历史登记时退回 课程.json 的 note
  assert.equal(courseIdForSubdir('物理/讲义', { files: [] }, { courses: [{ id: 'c_phy', note: '工作区目录：物理/' }] }), 'c_phy');
  assert.equal(courseIdForSubdir('物理/讲义', { files: [] }, { courses: [] }), '');

  const result = runSync(['--all', '--data', dataDir], silent);
  return result.then((applied) => {
    assert.equal(applied.jobs.length, 1);
    assert.equal(applied.jobs[0].courseId, 'c_digital');
    assert.deepEqual(applied.jobs[0].index.removed, ['数电/讲义/第09章-已删除章节-A-严谨体系式.md']);
    assert.deepEqual(applied.jobs[0].index.added, ['数电/讲义/第01章-数制与码制-A-严谨体系式.md']);
    assert.ok(fs.existsSync(path.join(lectureDir, LECTURE_A)));
  });
});
