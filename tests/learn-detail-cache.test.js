/**
 * 作业详情落盘缓存的行为约定。
 *
 * 这东西是「拉不到平台原文时的兜底」，所以最要紧的两条是：**读不动的当空的**、
 * **写失败不许抛** —— 它坏掉只能让详情退回一行错误，绝不能牵连别的功能。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  DETAIL_CACHE_FILE,
  DETAIL_CACHE_LIMIT,
  detailCachePath,
  readDetailCache,
  readDetailEntry,
  writeDetailEntry,
  pickDetailEntry,
} from '../lib/learn-detail-cache.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

test('详情缓存：路径固定放在数据目录下，与网络学堂.json 并列', () => {
  assert.equal(DETAIL_CACHE_FILE, '任务详情.json');
  assert.equal(detailCachePath('D:\\data'), path.join('D:\\data', '任务详情.json'));
});

test('详情缓存：还没看过详情时读得到空缓存，不算错误', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    const cache = await readDetailCache(dir);
    assert.equal(cache.ok, true);
    assert.equal(cache.missing, true);
    assert.deepEqual(cache.items, {});
    assert.equal(await readDetailEntry(dir, 't1'), null);
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：存一条再读回来，字段齐全且 fetchedAt 自动补上', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    const entry = {
      wlkcid: 'W-BASE',
      xszyid: 'abc',
      courseName: '数据结构',
      detail: { title: 'HW3', due: '2026-10-16 00:00' },
    };
    const written = await writeDetailEntry(dir, 't_ds_hw3', entry);
    assert.equal(written.ok, true);
    assert.equal(written.count, 1);

    const back = await readDetailEntry(dir, 't_ds_hw3');
    assert.equal(back.wlkcid, 'W-BASE');
    assert.equal(back.xszyid, 'abc');
    assert.equal(back.courseName, '数据结构');
    assert.equal(back.detail.title, 'HW3');
    assert.equal(typeof back.fetchedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(back.fetchedAt)));

    // 落盘的是合法 JSON，且带用途说明（万一用户翻到它，看得懂能删）
    const raw = JSON.parse(await fs.readFile(detailCachePath(dir), 'utf8'));
    assert.equal(raw.version, 1);
    assert.match(raw.note, /详情缓存/);
    assert.equal(raw.items.t_ds_hw3.detail.title, 'HW3');
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：文件损坏时读成「没有缓存」，并且还能重新写进去', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    await fs.writeFile(detailCachePath(dir), '{这不是 json', 'utf8');
    const cache = await readDetailCache(dir);
    assert.equal(cache.ok, false);
    assert.equal(cache.reason, 'detail-cache-unreadable');
    assert.deepEqual(cache.items, {});
    assert.equal(await readDetailEntry(dir, 't1'), null);

    const written = await writeDetailEntry(dir, 't1', { detail: { title: '重新来过' } });
    assert.equal(written.ok, true);
    assert.equal((await readDetailEntry(dir, 't1')).detail.title, '重新来过');
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：顶层不是对象（数组/字符串）判为坏缓存，不当成 items', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    await fs.writeFile(detailCachePath(dir), JSON.stringify(['x']), 'utf8');
    assert.equal((await readDetailCache(dir)).reason, 'bad-detail-cache');

    await fs.writeFile(detailCachePath(dir), JSON.stringify('x'), 'utf8');
    assert.equal((await readDetailCache(dir)).reason, 'bad-detail-cache');
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：形状不对的条目不还给界面（宁可报错也不渲染半截）', () => {
  const cache = { items: { a: { detail: { title: 'ok' } }, b: { wlkcid: 'W' }, c: 'x', d: null } };
  assert.equal(pickDetailEntry(cache, 'b'), null, '没有 detail 的条目不算缓存');
  assert.equal(pickDetailEntry(cache, 'c'), null);
  assert.equal(pickDetailEntry(cache, 'd'), null);
  assert.equal(pickDetailEntry(cache, '没这条'), null);
  assert.equal(pickDetailEntry({}, 'a'), null);

  const ok = pickDetailEntry(cache, 'a');
  assert.equal(ok.detail.title, 'ok');
  assert.equal(ok.wlkcid, null, '缺字段一律 null，不留 undefined');
  assert.equal(ok.courseName, null);
});

test('详情缓存：超过上限按 fetchedAt 裁掉最旧的，留下最新的', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    // 先直接铺满一整个缓存（顺序写 300 条太慢），再写两条最新的把它顶到上限之外
    const items = {};
    for (let i = 0; i < DETAIL_CACHE_LIMIT; i += 1) {
      items[`t${i}`] = {
        fetchedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        wlkcid: null,
        xszyid: null,
        courseName: null,
        detail: { title: `第${i}` },
      };
    }
    await fs.writeFile(
      detailCachePath(dir),
      `${JSON.stringify({ version: 1, updatedAt: null, items }, null, 2)}\n`,
      'utf8',
    );

    const first = await writeDetailEntry(dir, '最新1', {
      fetchedAt: new Date(Date.UTC(2026, 1, 1)).toISOString(),
      detail: { title: '最新1' },
    });
    assert.equal(first.ok, true);
    assert.equal(first.count, DETAIL_CACHE_LIMIT, '刚好超一条，立刻裁回上限');
    const second = await writeDetailEntry(dir, '最新2', {
      fetchedAt: new Date(Date.UTC(2026, 1, 2)).toISOString(),
      detail: { title: '最新2' },
    });
    assert.equal(second.count, DETAIL_CACHE_LIMIT);

    const cache = await readDetailCache(dir);
    const keys = Object.keys(cache.items);
    assert.equal(keys.length, DETAIL_CACHE_LIMIT);
    assert.equal(cache.items.t0, undefined, '最旧的两条应被裁掉');
    assert.equal(cache.items.t1, undefined);
    assert.equal(cache.items['最新2'].detail.title, '最新2');
    assert.equal(cache.items[`t${DETAIL_CACHE_LIMIT - 1}`].detail.title, `第${DETAIL_CACHE_LIMIT - 1}`);
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：原子写不留 .tmp 残留，数据目录不存在时自己建', async () => {
  const dir = await makeTempDir('study-detail-cache-');
  try {
    const nested = path.join(dir, '还没有的目录');
    const written = await writeDetailEntry(nested, 't1', { detail: { title: 'x' } });
    assert.equal(written.ok, true);
    const files = await fs.readdir(nested);
    assert.deepEqual(files, [DETAIL_CACHE_FILE]);
  } finally {
    await removeTempDir(dir);
  }
});

test('详情缓存：数据目录写不进去时回 ok:false 而不是抛异常', async () => {
  // 拿一个「父级是文件」的路径当数据目录，mkdir 必然失败
  const dir = await makeTempDir('study-detail-cache-');
  try {
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'x', 'utf8');
    const result = await writeDetailEntry(path.join(blocker, '子目录'), 't1', { detail: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'detail-cache-unwritable');
    assert.equal(typeof result.detail, 'string');
  } finally {
    await removeTempDir(dir);
  }
});
