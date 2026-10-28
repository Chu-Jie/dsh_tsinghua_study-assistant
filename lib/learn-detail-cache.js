/**
 * 作业详情的落盘缓存。
 *
 * 为什么要有它：详情只能从网络学堂现拉，而会话 Cookie 一定会过期。
 * 「拉不到就只剩一行错误」对用户没有价值 —— 上一次看过的原文（老师的要求、
 * 附件名、成绩、评语）本身是静态的，留着总比空着强。于是：
 *   拉到 → 顺手存一份；拉不到 → 把上次那份还给界面，并标注是缓存。
 *
 * 它只是缓存，不进学习台的四份数据：损坏、丢失、被删都不该影响别的功能，
 * 所以这里的读一律「读不动就当空的」，写一律原子写且失败不抛。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 缓存文件名（放在 dataDir 下，和 `网络学堂.json` 并列）。 */
export const DETAIL_CACHE_FILE = '任务详情.json';

/** 最多留多少条：一条详情不到 10 KB，300 条足够把一学期看过的都留下。 */
export const DETAIL_CACHE_LIMIT = 300;

/** 缓存文件路径。 */
export function detailCachePath(dataDir) {
  return path.join(dataDir, DETAIL_CACHE_FILE);
}

/** 只认字符串，顺带把空串当成没值。 */
function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 读整份缓存。
 *
 * 返回 `{ ok, items, updatedAt, missing? }`；文件不存在是正常状态（还没看过详情），
 * 损坏也只记 `ok:false` 并把 items 当空 —— 调用方据此退回「没有缓存」这条路。
 */
export async function readDetailCache(dataDir) {
  try {
    const text = await fs.readFile(detailCachePath(dataDir), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'bad-detail-cache', items: {}, updatedAt: null };
    }
    const items = parsed.items !== null && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
      ? parsed.items
      : {};
    return { ok: true, items, updatedAt: str(parsed.updatedAt) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, items: {}, updatedAt: null, missing: true };
    return { ok: false, reason: 'detail-cache-unreadable', items: {}, updatedAt: null };
  }
}

/**
 * 从缓存里取一条，形状固定（缺字段一律 null），供接口原样返回。
 * 拿不到或形状不对就返回 null —— 宁可报错，也别把半截数据渲染出来。
 */
export function pickDetailEntry(cache, taskId) {
  const item = cache?.items?.[taskId];
  if (item === null || typeof item !== 'object') return null;
  if (item.detail === null || typeof item.detail !== 'object') return null;
  return {
    fetchedAt: str(item.fetchedAt),
    wlkcid: str(item.wlkcid),
    xszyid: str(item.xszyid),
    courseName: str(item.courseName),
    detail: item.detail,
  };
}

/** 读一条（读不动等于没有）。 */
export async function readDetailEntry(dataDir, taskId) {
  const cache = await readDetailCache(dataDir);
  return pickDetailEntry(cache, taskId);
}

/** 按 fetchedAt 从新到旧裁剪，超出的丢掉。 */
function pruneItems(items, limit = DETAIL_CACHE_LIMIT) {
  const keys = Object.keys(items);
  if (keys.length <= limit) return items;
  const ordered = keys.slice().sort((a, b) => {
    const ta = Date.parse(items[a]?.fetchedAt ?? '') || 0;
    const tb = Date.parse(items[b]?.fetchedAt ?? '') || 0;
    return tb - ta;
  });
  const kept = {};
  for (const key of ordered.slice(0, limit)) kept[key] = items[key];
  return kept;
}

/**
 * 存一条详情。
 *
 * 读-改-写会覆盖并发写入，但这里写的只是缓存、冲突最多丢一条旧快照，
 * 不值得为它引入锁；真出问题下次拉取会补回来。
 */
export async function writeDetailEntry(dataDir, taskId, entry) {
  try {
    const cache = await readDetailCache(dataDir);
    const items = { ...cache.items };
    items[taskId] = {
      fetchedAt: str(entry?.fetchedAt) ?? new Date().toISOString(),
      wlkcid: str(entry?.wlkcid),
      xszyid: str(entry?.xszyid),
      courseName: str(entry?.courseName),
      detail: entry?.detail ?? null,
    };
    const payload = {
      version: 1,
      note: '学习台插件的作业详情缓存（拉不到平台原文时界面拿它兜底），删掉只会丢缓存。',
      updatedAt: new Date().toISOString(),
      items: pruneItems(items),
    };
    await fs.mkdir(dataDir, { recursive: true });
    const file = detailCachePath(dataDir);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return { ok: true, count: Object.keys(payload.items).length };
  } catch (error) {
    return { ok: false, reason: 'detail-cache-unwritable', detail: String(error?.message ?? error) };
  }
}
