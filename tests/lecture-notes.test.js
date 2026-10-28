/**
 * 落盘这一层最怕两件事：**写错地方**（在用户作业目录里到处建文件夹）
 * 和**覆盖人家已有的笔记**。这两条都用真临时目录钉死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeTempDir, removeTempDir } from './_tmpdir.js';
import { writeLectureNote, listWorkspaceDirs, uniquePath, isIgnoredDir } from '../lib/lecture/notes.js';

const COURSES = [
  { id: 'c_ds', name: '数据结构', aliases: ['DS'], note: '工作区目录：数据结构/；连堂' },
  { id: 'c_phy', name: '大学物理B(2)', aliases: ['大物'], note: '工作区目录：物理/' },
  { id: 'c_math', name: '离散数学', aliases: ['离散'], note: '' },
];

/** 工作区一级目录，按码点排序（JS 默认 sort）。 */
const WORKSPACE_DIRS = ['学习台', '数据结构', '物理', '离散数学'];

async function makeWorkspace() {
  const root = await makeTempDir('lecture-notes-');
  const workspace = path.join(root, '作业');
  const dataDir = path.join(workspace, '学习台');
  await fs.mkdir(dataDir, { recursive: true });
  for (const name of ['数据结构', '物理', '离散数学', '.dsh', '_工具', '_plugins']) {
    await fs.mkdir(path.join(workspace, name), { recursive: true });
  }
  return { root, workspace, dataDir };
}

test('listWorkspaceDirs：只列真正的科目目录，跳过点开头与下划线开头的', async () => {
  const { root, workspace } = await makeWorkspace();
  try {
    const dirs = await listWorkspaceDirs(workspace);
    assert.deepEqual(dirs, WORKSPACE_DIRS);
    assert.equal(isIgnoredDir('.dsh'), true);
    assert.equal(isIgnoredDir('_工具'), true);
    assert.equal(isIgnoredDir('数据结构'), false);
    assert.deepEqual(await listWorkspaceDirs(path.join(root, '不存在')), []);
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：课程 note 点了目录，笔记就进那个目录', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const result = await writeLectureNote({
      dataDir,
      workspaceRoot: workspace,
      courses: COURSES,
      courseName: '数据结构',
      date: '2026-10-09',
      markdown: '# 数据结构 · 2026-10-09 听课笔记\n\n讲了红黑树。',
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'note');
    assert.equal(result.fallback, false);
    assert.equal(result.dirName, '数据结构');
    assert.equal(path.relative(workspace, result.file), path.join('数据结构', '笔记', '2026-10-09-数据结构.md'));
    const text = await fs.readFile(result.file, 'utf8');
    assert.match(text, /讲了红黑树/);
    assert.equal(text.endsWith('\n'), true);
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：note 没写目录，就按课程名对到同名目录', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const result = await writeLectureNote({
      dataDir,
      workspaceRoot: workspace,
      courses: COURSES,
      courseName: '离散数学',
      date: '2026-10-09',
      markdown: '讲了偏序关系。',
    });
    assert.equal(result.ok, true);
    assert.equal(result.dirName, '离散数学');
    assert.equal(result.via, 'name');
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：课程名对不上任何目录时退回学习台/笔记，绝不乱建文件夹', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const result = await writeLectureNote({
      dataDir,
      workspaceRoot: workspace,
      courses: COURSES,
      courseName: '量子力学导论',
      date: '2026-10-09',
      markdown: '这门课根本不在课程表里。',
    });
    assert.equal(result.ok, true);
    assert.equal(result.dirName, '');
    assert.equal(result.via, '');
    assert.equal(result.fallback, true);
    assert.equal(path.relative(dataDir, result.file), path.join('笔记', '2026-10-09-量子力学导论.md'));
    // 工作区里没多出任何新目录
    assert.deepEqual((await listWorkspaceDirs(workspace)), WORKSPACE_DIRS);
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：同一天同一门课再来一次，加 -2，绝不覆盖', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const base = { dataDir, workspaceRoot: workspace, courses: COURSES, courseName: '数据结构', date: '2026-10-09' };
    const first = await writeLectureNote({ ...base, markdown: '第一遍：讲了红黑树。' });
    const second = await writeLectureNote({ ...base, markdown: '第二遍：习题课。' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.file, second.file);
    assert.match(path.basename(second.file), /^2026-10-09-数据结构-2\.md$/);
    assert.match(await fs.readFile(first.file, 'utf8'), /第一遍/);
    assert.match(await fs.readFile(second.file, 'utf8'), /第二遍/);
    // 临时文件不留残渣
    const files = await fs.readdir(path.dirname(first.file));
    assert.equal(files.some((name) => name.endsWith('.tmp')), false);
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：空内容 / 没数据目录都拒绝，别写出一个空文件', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const empty = await writeLectureNote({ dataDir, workspaceRoot: workspace, courseName: '数据结构', markdown: '   \n ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'empty-note');
    const noDir = await writeLectureNote({ dataDir: '', courseName: '数据结构', markdown: '有内容' });
    assert.equal(noDir.ok, false);
    assert.equal(noDir.error, 'no-data-dir');
  } finally {
    await removeTempDir(root);
  }
});

test('writeLectureNote：课程名里的斜杠不会跑出目录', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  try {
    const result = await writeLectureNote({
      dataDir,
      workspaceRoot: workspace,
      courses: [],
      courseName: '高等数学/习题课',
      date: '2026-10-09',
      markdown: '正文',
    });
    assert.equal(result.ok, true);
    assert.equal(path.basename(result.file), '2026-10-09-高等数学_习题课.md');
  } finally {
    await removeTempDir(root);
  }
});

test('uniquePath：被占用就一直往上加，直到找到空位', async () => {
  const root = await makeTempDir('lecture-unique-');
  try {
    const file = path.join(root, 'a.md');
    assert.equal(await uniquePath(file), file);
    await fs.writeFile(file, 'x', 'utf8');
    assert.equal(await uniquePath(file), path.join(root, 'a-2.md'));
    await fs.writeFile(path.join(root, 'a-2.md'), 'x', 'utf8');
    assert.equal(await uniquePath(file), path.join(root, 'a-3.md'));
  } finally {
    await removeTempDir(root);
  }
});
