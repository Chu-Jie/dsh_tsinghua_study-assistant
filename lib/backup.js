/**
 * 全量导出 / 恢复：把九份数据文档打成一个**带校验和的 JSON**，并能验回去。
 *
 * 为什么需要：数据目录是纯文件，用户手滑、两个宿主互相覆盖、某次脚本写坏一份，
 * 都是「整个学期的记录」级别的损失。conflict 检测只能挡住并发写，挡不住误删与损坏。
 * 所以给一个「导出一个文件、出事能盖回来」的兜底。
 *
 * 设计取舍：
 *  - **校验和覆盖的是 docs 内容本身**，不是文件字节：导出后有人用编辑器改缩进/顺序不该算坏，
 *    但内容一改就必须报错（所以用「键排序 + 紧凑 JSON」的规范序列化再 sha256）。
 *  - 只认本模块认识的 `format` / `version`：将来结构升级时老包要能被明确拒绝，
 *    而不是「看起来恢复了」结果写进半份数据。
 *  - 纯函数、不碰磁盘：读盘/写盘留在 `lib/api.js`（那里有 store 的备份与冲突保护）。
 */
import { createHash } from 'node:crypto';
import { DOC_KEYS, validateDoc } from './core.js';

export const BUNDLE_FORMAT = 'study-assistant.bundle';
export const BUNDLE_VERSION = 1;

/**
 * 规范序列化：对象键按字典序递归排序，数组保持原序。
 *
 * 同一个对象无论 `JSON.stringify` 出来是哪种键序，这里得到的字符串都一样——
 * 否则「导出→保存→再导入」会因为 `JSON.parse` 的键序变化而误报校验和不符。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/** 把 docs 收成「只含 DOC_KEYS 里真正有内容的键」的对象（顺序固定）。 */
function pickDocs(docs) {
  const out = {};
  for (const key of DOC_KEYS) {
    const doc = docs?.[key];
    if (doc !== undefined && doc !== null) out[key] = doc;
  }
  return out;
}

/** docs 的校验和：`sha256:<hex>`。 */
export function bundleChecksum(docs) {
  const text = canonicalJson(pickDocs(docs));
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 造一个导出包。
 * @param {object} docs 九份文档（可以缺键；缺的不进包）
 * @param {{exportedAt?: string, hashes?: object, app?: object}} [options]
 */
export function buildBundle(docs, options = {}) {
  const included = pickDocs(docs);
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: typeof options.exportedAt === 'string' ? options.exportedAt : new Date().toISOString(),
    app: options.app ?? null,
    docs: included,
    checksum: bundleChecksum(included),
  };
  if (options.hashes !== undefined) bundle.hashes = options.hashes;
  return bundle;
}

/**
 * 验一个导出包（字符串或已 parse 的对象都行）。
 *
 * @returns {{ok: true, keys: string[], docs: object, exportedAt: string|null}
 *   | {ok: false, error: string, key?: string, detail?: string, expected?: string, actual?: string}}
 *   `error` 取值：`not-json` / `not-an-object` / `bad-format` / `bad-version` / `no-docs` /
 *   `no-checksum` / `checksum-mismatch` / `invalid-doc`。
 */
export function verifyBundle(raw) {
  let bundle = raw;
  if (typeof raw === 'string') {
    try {
      bundle = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'not-json' };
    }
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { ok: false, error: 'not-an-object' };
  }
  if (bundle.format !== BUNDLE_FORMAT) {
    return { ok: false, error: 'bad-format', detail: String(bundle.format ?? '') };
  }
  if (bundle.version !== BUNDLE_VERSION) {
    return { ok: false, error: 'bad-version', detail: String(bundle.version ?? '') };
  }
  const included = pickDocs(bundle.docs);
  const keys = Object.keys(included);
  if (keys.length === 0) return { ok: false, error: 'no-docs' };
  if (typeof bundle.checksum !== 'string' || bundle.checksum === '') {
    return { ok: false, error: 'no-checksum' };
  }
  const actual = bundleChecksum(included);
  if (actual !== bundle.checksum) {
    return { ok: false, error: 'checksum-mismatch', expected: bundle.checksum, actual };
  }
  for (const key of keys) {
    const checked = validateDoc(key, included[key]);
    if (!checked.ok) return { ok: false, error: 'invalid-doc', key, detail: checked.reason };
  }
  return {
    ok: true,
    keys,
    docs: included,
    exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null,
  };
}
