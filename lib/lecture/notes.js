/**
 * 把课后总结写成一份真的 md 文件，放进对应科目的目录里。
 *
 * 路径怎么定：`<工作区>/<科目目录>/笔记/<日期>-<课程>.md`。
 * 「工作区」从 `dataDir`（= `<工作区>/学习台`）推出来，「科目目录」由 `course.js`
 * 按「课程 note 里点名的目录 > 课程名 > 别名 > 扫描」四档去猜。
 *
 * 两条小心处：
 *   1. **猜不出来就退回 `<dataDir>/笔记/`**，绝不在用户的作业目录里凭空建文件夹。
 *   2. **绝不覆盖同名文件** —— 同一天同一门课上两次是常事，第二份自动加 `-2`。
 *      写文件用「临时文件 + rename」，中途断电不会留下一份半截笔记。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { NOTES_DIR, normalizeCourseName, pickCourseDir } from './course.js';
import { safeFileName } from './session.js';

/** 扫描工作区时忽略这些目录：点开头的是工具目录，下划线开头的是插件/工具区。 */
export function isIgnoredDir(name) {
  const text = String(name ?? '');
  return text === '' || text.startsWith('.') || text.startsWith('_') || text.startsWith('$');
}

/** 列出工作区里的一级目录名（用来把课程名对到目录名上）。 */
export async function listWorkspaceDirs(root) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !isIgnoredDir(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 同名文件存在就换 `-2`、`-3`… */
export async function uniquePath(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let index = 1; index <= 200; index += 1) {
    const candidate = index === 1 ? file : path.join(dir, `${base}-${index}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

/**
 * @param {object} input
 * @param {string} input.dataDir       学习台数据目录（`<工作区>/学习台`）
 * @param {string} input.workspaceRoot 工作区根目录（默认取 dataDir 的上一级）
 * @param {Array}  input.courses       课程表（`课程.json` 里的 courses）
 * @param {string} input.courseName    这节课的课程名
 * @param {string} input.date          `YYYY-MM-DD`
 * @param {string} input.markdown      笔记正文
 * @returns {Promise<{ok: boolean, file?: string, dirName?: string, via?: string, fallback?: boolean, error?: string}>}
 */
export async function writeLectureNote(input = {}) {
  const dataDir = String(input.dataDir ?? '');
  if (dataDir === '') return { ok: false, error: 'no-data-dir' };
  const workspaceRoot = typeof input.workspaceRoot === 'string' && input.workspaceRoot !== ''
    ? input.workspaceRoot
    : path.dirname(dataDir);
  const courseName = normalizeCourseName(input.courseName) || '未命名课程';
  const date = String(input.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  const markdown = String(input.markdown ?? '');
  if (markdown.trim() === '') return { ok: false, error: 'empty-note' };

  const dirNames = (await listWorkspaceDirs(workspaceRoot))
    .filter((name) => name !== path.basename(dataDir));
  const picked = pickCourseDir({ typed: courseName, courses: input.courses ?? [], dirNames });
  const fallback = picked.dirName === '';
  const targetDir = fallback
    ? path.join(dataDir, NOTES_DIR)
    : path.join(workspaceRoot, picked.dirName, NOTES_DIR);
  const wanted = path.join(targetDir, `${date}-${safeFileName(courseName)}.md`);

  try {
    await fs.mkdir(targetDir, { recursive: true });
    const file = await uniquePath(wanted);
    await writeFileAtomic(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    return { ok: true, file, dirName: picked.dirName, via: picked.via, fallback };
  } catch (error) {
    input.logger?.error?.('[study-assistant] 写笔记失败：', error);
    return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) };
  }
}
