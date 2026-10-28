/**
 * 找出「真机正在用的」DSH 包目录 —— 校验脚本的取证来源。
 *
 * 解决的问题（假绿）：
 *   DSH 的客户端代码通常被塞进 `resources/app.asar`（磁盘上没有解包副本），
 *   这时校验脚本若把路径写死成某个安装目录，就会「全部通过」——其实是在拿旧副本取证。
 *   这类假绿比不跑还危险。
 *
 * 顺序（先可信、后兼容）：
 *   1. 环境变量 `DSH_PACKAGE_ROOT`（或旧的 `DSH_UNPACKED_ROOT`）—— 显式指定，最高优先；
 *   2. 工作区里的 `_工具/_dsh3-src/dsh/node_modules` —— 自己从 app.asar 里解出来的副本；
 *   3. 环境变量 `DSH_INSTALL_DIR` 对应的 `resources/app.asar.unpacked/node_modules`
 *      （原生依赖目录，通常不含 web 端包）。
 *
 * 找不到就返回 null，由调用方判「跳过」而不是判失败。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
/** 工作区根：<工作区>/_plugins/study-assistant → 上两级。 */
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

const EXTRACT_HINT = `请先解包客户端代码（或用环境变量指定）：
  DSH_PACKAGE_ROOT=<包含 node_modules 的目录> node tools/verify-tool-output.mjs
  DSH_INSTALL_DIR="<DSH 安装目录（其下有 resources/）>" node tools/verify-tool-output.mjs`;

/** 候选根目录（都指到 node_modules 那一层），按可信度从高到低。 */
export function dshModuleCandidates() {
  const list = [];
  const env = process.env.DSH_PACKAGE_ROOT ?? process.env.DSH_UNPACKED_ROOT;
  if (env !== undefined && env !== '') {
    list.push({ root: path.join(env, 'node_modules'), label: `环境变量指定：${env}`, legacy: false });
  }
  // 旧脚本用过的名字：这个变量的值**直接就是** node_modules 目录，不是它的父目录。
  const legacyEnv = process.env.DSH_DESKTOP_NODE_MODULES;
  if (legacyEnv !== undefined && legacyEnv !== '') {
    list.push({ root: legacyEnv, label: `环境变量指定：${legacyEnv}`, legacy: false });
  }
  list.push({
    root: path.join(WORKSPACE_ROOT, '_工具', '_dsh3-src', 'dsh', 'node_modules'),
    label: '从 app.asar 解包到 _工具/_dsh3-src 的副本',
    legacy: false,
  });
  const installDir = process.env.DSH_INSTALL_DIR;
  if (installDir !== undefined && installDir !== '') {
    list.push({
      root: path.join(installDir, 'resources', 'app.asar.unpacked', 'node_modules'),
      label: `app.asar.unpacked（${installDir}）`,
      legacy: false,
    });
  }
  return list;
}

/** 第一个含有 @deepseek-ai 的候选根；都没有则返回 null。 */
export function resolveDshModules() {
  for (const candidate of dshModuleCandidates()) {
    if (existsSync(path.join(candidate.root, '@deepseek-ai'))) return candidate;
  }
  return null;
}

/**
 * 在候选根里找某个具体文件的第一个存在者。
 * @param {string[]} segments 相对 node_modules 的路径段，如 ['@deepseek-ai','dsh-tools','lib','index.js']
 * @returns {{file: string, root: string, label: string, legacy: boolean}|null}
 */
export function findDshPackageFile(segments) {
  for (const candidate of dshModuleCandidates()) {
    const file = path.join(candidate.root, ...segments);
    if (existsSync(file)) return { file, root: candidate.root, label: candidate.label, legacy: candidate.legacy };
  }
  return null;
}

/** 把取证来源打印出来；旧安装要显眼地警告，避免「假绿」。 */
export function describeSource(source) {
  const lines = [`取证来源：${source.label}`, `          ${source.file ?? source.root}`];
  if (source.legacy === true) {
    lines.push('⚠ 这是旧版安装：本次结果只能说明旧版兼容，不能说明当前版本兼容。');
    lines.push(`  要拿到当前版本的证据，${EXTRACT_HINT}`);
  }
  return lines.join('\n');
}

export { EXTRACT_HINT, PLUGIN_ROOT, WORKSPACE_ROOT };
