#!/usr/bin/env node
// 作业流命令行工具（2026-10-20 起）
//
// 面板不再自己生成答案，改由「一键开工」建一个会话，让 agent 干活。
// 这个工具把原来藏在 HTTP 接口里的取字/分题/扫描逻辑暴露成命令行，
// 让会话里的 agent 不用重写一遍，也不会因为随手写脚本而把原题读坏。
//
// 用法（工作区根目录下）：
//   node _plugins/study-assistant/tools/homework-cli.mjs courses
//   node _plugins/study-assistant/tools/homework-cli.mjs scan c_ds
//   node _plugins/study-assistant/tools/homework-cli.mjs extract "数据结构/作业/第01次作业_原题.pdf"
//   node _plugins/study-assistant/tools/homework-cli.mjs split "数据结构/作业/第01次作业_原题.pdf" --json
//
// 设计约束：
//   - 只读：不改原题、不写学习台（台账由 agent 决定写不写）。
//   - 失败用退出码 1 + stderr 一行中文说明；成功输出 JSON 到 stdout。
//   - 零依赖：只用 node: 内置模块 + 本插件 lib/ 下的纯函数。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { analyzeTextQuality, extractText, listCourseDirs, scanCourseHomework } from '../lib/homework.js';
import { splitQuestions } from '../lib/questions.js';

// 本文件在 `_plugins/study-assistant/tools/`，往上三层就是工作区根目录（`学习台` 的父目录）
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA_DIR = path.join(WORKSPACE_ROOT, '学习台');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readCourses() {
  try {
    const text = await readFile(path.join(DATA_DIR, '课程.json'), 'utf8');
    const doc = JSON.parse(text);
    return Array.isArray(doc.courses) ? doc.courses : [];
  } catch (error) {
    fail(`读不到课程表：${path.join(DATA_DIR, '课程.json')}（${error.message}）`);
    return [];
  }
}

/** 把课程 id 或名字（含别名、目录名）解析成课程对象；解析不到就报错，不猜。 */
function resolveCourse(courses, token) {
  const key = String(token ?? '').trim();
  if (key === '') return null;
  return (
    courses.find((item) => item?.id === key) ??
    courses.find((item) => item?.name === key) ??
    courses.find((item) => Array.isArray(item?.aliases) && item.aliases.includes(key)) ??
    null
  );
}

function toAbsolute(raw) {
  return path.isAbsolute(raw) ? raw : path.resolve(WORKSPACE_ROOT, raw);
}

async function commandCourses() {
  const courses = await readCourses();
  const dirs = await listCourseDirs(WORKSPACE_ROOT, courses);
  process.stdout.write(`${JSON.stringify({ ok: true, workspaceRoot: WORKSPACE_ROOT, dirs }, null, 2)}\n`);
}

async function commandScan(token) {
  const courses = await readCourses();
  const course = resolveCourse(courses, token);
  if (course === null) fail(`认不出这门课：${token}（可选：courses 子命令查看）`);
  const scan = await scanCourseHomework(WORKSPACE_ROOT, courses, course.id);
  if (!scan.ok) fail(`扫描失败：${scan.reason}`);
  process.stdout.write(`${JSON.stringify({ ok: true, course: { id: course.id, name: course.name }, ...scan }, null, 2)}\n`);
}

async function commandExtract(rawPath) {
  const full = toAbsolute(rawPath);
  const result = await extractText(full);
  if (!result.ok) fail(`取字失败：${result.reason}（${full}）`);
  const quality = analyzeTextQuality(result.text);
  process.stdout.write(
    `${JSON.stringify({ ok: true, path: full, kind: result.kind, chars: result.chars, truncated: result.truncated, quality, text: result.text }, null, 2)}\n`,
  );
}

async function commandSplit(rawPath) {
  const full = toAbsolute(rawPath);
  const result = await extractText(full);
  if (!result.ok) fail(`取字失败：${result.reason}（${full}）`);
  const split = splitQuestions(result.text);
  process.stdout.write(
    `${JSON.stringify({ ok: true, path: full, chars: result.chars, quality: analyzeTextQuality(result.text), ...split }, null, 2)}\n`,
  );
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'courses') return commandCourses();
  if (command === 'scan') return commandScan(arg);
  if (command === 'extract') return commandExtract(arg);
  if (command === 'split') return commandSplit(arg);
  fail('用法：homework-cli.mjs <courses|scan|extract|split> [参数]');
}

await main();
