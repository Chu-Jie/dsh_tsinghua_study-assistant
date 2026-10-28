/**
 * 校验安装件里的 cordis.patch.yml：编码是否完好、能否被 YAML 解析、dataDir 实际解析成什么。
 *
 * 背景：PowerShell 控制台会按 CP936 渲染 UTF-8，伪造出乱码假象（踩过一次），
 * 所以判断文件编码只能读字节/码点，不能看 shell 的输出。
 *
 * 用法：
 *   node tools/check-patch-yaml.mjs [patch.yml 路径]
 *   DSH_MODULES_DIR=/path/to/app.asar.unpacked/node_modules node tools/check-patch-yaml.mjs <patch>
 *
 * 不给路径时按「本机 DSH 的 profile 里装的 dsh-study-assistant」猜一个。
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'dsh-study-assistant';
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

const defaultPatch = [
  path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', PACKAGE, 'cordis.patch.yml'),
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', PACKAGE, 'cordis.patch.yml'),
  path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'profiles', 'web', 'node_modules', PACKAGE, 'cordis.patch.yml'),
].find((p) => existsSync(p));

const file = process.argv[2] ?? defaultPatch ?? path.join(process.cwd(), 'cordis.patch.yml');

if (!existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
console.log(`文件：${file}`);
console.log(`字节数：${readFileSync(file).length}   码点数：${[...raw].length}`);
console.log(`含替换字符 U+FFFD（真损坏标志）：${raw.includes('\uFFFD')}`);
console.log('');

// 找 YAML 解析器：优先宿主自带的（与宿主同款解析器，行为才一致）。
// 依次试 DSH_MODULES_DIR / DSH_PACKAGE_ROOT 指向的 node_modules，都没有就只做文本检查。
const MODULE_DIRS = [
  process.env.DSH_MODULES_DIR,
  process.env.DSH_PACKAGE_ROOT === undefined ? undefined : path.join(process.env.DSH_PACKAGE_ROOT, 'node_modules'),
  process.env.DSH_UNPACKED_ROOT ?? undefined,
].filter((p) => typeof p === 'string' && p !== '');

let yaml = null;
for (const dir of MODULE_DIRS) {
  for (const candidate of ['yaml', 'js-yaml']) {
    const pkgDir = path.join(dir, candidate);
    if (!existsSync(pkgDir)) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const entry = path.join(pkgDir, pkgJson.main ?? 'index.js');
      yaml = { name: candidate, mod: await import(pathToFileURL(entry).href) };
      break;
    } catch (error) {
      console.log(`（试 ${candidate} 失败：${error?.message}）`);
    }
  }
  if (yaml !== null) break;
}

if (yaml === null) {
  console.log('未找到可用的 YAML 解析器（可用 DSH_MODULES_DIR 指向宿主自带的 node_modules）；仅做文本检查。');
  process.exit(0);
}

console.log(`使用 YAML 解析器：${yaml.name}`);
const parse = yaml.mod.parse ?? yaml.mod.default?.parse;
if (typeof parse !== 'function') {
  console.log('解析器没有 parse 方法');
  process.exit(1);
}

let doc = null;
try {
  doc = parse(raw);
} catch (error) {
  console.log(`✗ YAML 解析失败：${error?.message ?? error}`);
  process.exit(1);
}

const rows = Array.isArray(doc) ? doc : (doc?.patch ?? []);
const row = rows.find((r) => r?.insert?.[0]?.id === 'study-assistant');
const entry = row?.insert?.[0];
console.log('✓ YAML 解析成功');
console.log(`  entry id   = ${entry?.id}`);
console.log(`  entry name = ${entry?.name}`);
console.log(`  config     = ${JSON.stringify(entry?.config)}`);
console.log('');

// dataDir 省略是**推荐**写法（交给插件默认值 ${HOME}/study-assistant-data）。
// 如果写了，只关心它有没有夹带某台机器的绝对路径。
const dataDir = entry?.config?.dataDir;
if (dataDir === undefined) {
  console.log('dataDir：未写 → 使用插件默认值（推荐）✓');
} else if (typeof dataDir !== 'string') {
  console.log(`dataDir：类型不对（${typeof dataDir}）✗`);
} else {
  const looksAbsolute = path.isAbsolute(dataDir) || /^[A-Za-z]:[\\/]/.test(dataDir);
  console.log(`dataDir：${JSON.stringify(dataDir)}`);
  console.log(`  是否为绝对路径：${looksAbsolute ? '是（换台机器就失效，建议改成相对路径或省略）' : '否 ✓'}`);
  console.log(`  是否含个人信息式路径（用户名/中文工作区名）：${/[\\/](Users|用户)[\\/]|大学|作业/.test(dataDir) ? '是 ✗' : '否 ✓'}`);
}
