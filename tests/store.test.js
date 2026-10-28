/**
 * 数据层测试（零依赖）
 * 运行：node tests/store.test.js
 *
 * 全部读写都发生在 os.tmpdir() 下自建的临时目录里，
 * 绝不触碰真实的「学习台」数据目录。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createStore, docPath, BACKUP_DIR } from '../lib/store.js';
import { DOC_KEYS, DOC_FILES, defaultDoc } from '../lib/core.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

/**
 * 一个「工作区里早就存在的状态文件」：整轮测试期间它的 sha256 必须不变。
 *
 * 早先这里指向作者本机的 `_工具/作业台状态.json`（仓库外），换台机器语义就丢了；
 * 现在自己在临时目录里造一个同形状的文件，断言一样成立、且不依赖仓库布局。
 */
const STATE_DIR = await makeTempDir('study-assistant-state-');
const REAL_STATE_FILE = path.join(STATE_DIR, '作业台状态.json');
await fs.writeFile(REAL_STATE_FILE, '{"probe":true,"note":"测试哨兵"}\n', 'utf8');
after(() => removeTempDir(STATE_DIR));

async function hashFile(file) {
  try {
    const raw = await fs.readFile(file);
    return createHash('sha256').update(raw).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 每个测试一个独立临时数据目录。 */
async function makeStore() {
  const dir = await makeTempDir('study-assistant-test-');
  const store = createStore(dir);
  await store.init();
  return { dir, store, cleanup: () => removeTempDir(dir) };
}

const stateBefore = await hashFile(REAL_STATE_FILE);

test('init：创建四份文档，内容为合法默认结构', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    for (const key of DOC_KEYS) {
      const result = await store.readDocument(key);
      assert.equal(result.ok, true, `${key} 应可读`);
      assert.equal(result.doc.version, 1);
    }
    const entries = await fs.readdir(dir);
    for (const key of DOC_KEYS) assert.ok(entries.includes(DOC_FILES[key]), `缺少文件 ${DOC_FILES[key]}`);
  } finally {
    await cleanup();
  }
});

test('init：重复调用不覆盖已有数据', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const read = await store.readDocument('tasks');
    const doc = { ...read.doc, tasks: [{ id: 't1', title: '保留我', due: '2026-09-10', status: 'todo' }] };
    const written = await store.writeDocument('tasks', doc, { expectedHash: read.hash });
    assert.equal(written.ok, true);

    await store.init();
    const again = await store.readDocument('tasks');
    assert.equal(again.doc.tasks.length, 1);
    assert.equal(again.doc.tasks[0].title, '保留我');
  } finally {
    await cleanup();
  }
});

test('readDocument：缺失返回 missing，损坏返回 corrupt:json', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    await fs.rm(docPath(dir, 'courses'));
    assert.equal((await store.readDocument('courses')).reason, 'missing');

    await fs.writeFile(docPath(dir, 'tasks'), '{ 这不是 JSON', 'utf8');
    const broken = await store.readDocument('tasks');
    assert.equal(broken.ok, false);
    assert.equal(broken.reason, 'corrupt:json');
    assert.ok(broken.hash, '损坏文件也要给出 hash 以便上层展示');
  } finally {
    await cleanup();
  }
});

test('readDocument：结构不符也算损坏', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    await fs.writeFile(docPath(dir, 'courses'), JSON.stringify({ version: 1, courses: 'not-an-array' }), 'utf8');
    const result = await store.readDocument('courses');
    assert.equal(result.ok, false);
    assert.match(result.reason, /^corrupt:bad-field/);
  } finally {
    await cleanup();
  }
});

test('写入：内容合法时成功，并且 updatedAt 被刷新', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const read = await store.readDocument('grades');
    const doc = { ...read.doc, courses: [{ courseId: 'c1', score: 90, credit: 3 }] };
    const written = await store.writeDocument('grades', doc, { expectedHash: read.hash, backupKeep: 3 });
    assert.equal(written.ok, true);
    assert.ok(written.hash);

    const after = await store.readDocument('grades');
    assert.equal(after.doc.courses.length, 1);
    assert.equal(after.hash, written.hash);
    assert.notEqual(after.doc.updatedAt, null);
  } finally {
    await cleanup();
  }
});

test('冲突检测：外部改动后写入被拒绝，且不覆盖对方内容', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    const read = await store.readDocument('courses');
    // 模拟「其他程序」改了磁盘上的文件
    const external = { version: 1, courses: [{ id: 'c9', name: '别人写的课' }], updatedAt: '2026-01-01T00:00:00.000Z' };
    await fs.writeFile(docPath(dir, 'courses'), JSON.stringify(external, null, 2), 'utf8');

    const written = await store.writeDocument('courses', { ...read.doc, courses: [{ id: 'c1', name: '我写的课' }] }, { expectedHash: read.hash });
    assert.equal(written.ok, false);
    assert.equal(written.reason, 'conflict');

    const onDisk = JSON.parse(await fs.readFile(docPath(dir, 'courses'), 'utf8'));
    assert.equal(onDisk.courses[0].name, '别人写的课', '冲突时必须保留对方内容');
  } finally {
    await cleanup();
  }
});

test('损坏保护：磁盘 JSON 损坏时拒绝写入，原文件保持原样', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    const brokenText = '{ 坏掉的内容';
    await fs.writeFile(docPath(dir, 'tasks'), brokenText, 'utf8');

    const read = await store.readDocument('tasks');
    const written = await store.writeDocument('tasks', {
      ...defaultDoc('tasks'),
      tasks: [{ id: 't1', title: '不该写进去' }],
    }, { expectedHash: read.hash });

    assert.equal(written.ok, false);
    assert.match(written.reason, /^refuse-corrupt-on-disk/);
    assert.equal(await fs.readFile(docPath(dir, 'tasks'), 'utf8'), brokenText, '原文件必须原样保留');
  } finally {
    await cleanup();
  }
});

test('结构校验：非法文档一律拒绝', async () => {
  const { store, cleanup } = await makeStore();
  try {
    for (const bad of [null, {}, [], { version: 1, tasks: 'nope' }, { version: 99, tasks: [] }]) {
      const result = await store.writeDocument('tasks', bad, {});
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`);
      assert.match(result.reason, /^refuse-invalid/);
    }
  } finally {
    await cleanup();
  }
});

test('备份：写入前留存上一版，并按 backupKeep 轮转', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    for (let i = 0; i < 5; i += 1) {
      const read = await store.readDocument('tasks');
      const doc = { ...read.doc, tasks: [{ id: `t${i}`, title: `第 ${i} 版` }] };
      const written = await store.writeDocument('tasks', doc, { expectedHash: read.hash, backupKeep: 3 });
      assert.equal(written.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // 备份名精确到秒，需要拉开时间戳
    }
    const backups = (await fs.readdir(path.join(dir, BACKUP_DIR))).filter((n) => n.startsWith(DOC_FILES.tasks));
    assert.equal(backups.length, 3, `应只保留 3 份备份，实际 ${backups.length}`);

    // 备份内容应是上一版（第 3 版），而不是最新版
    const latest = backups.sort().at(-1);
    const content = JSON.parse(await fs.readFile(path.join(dir, BACKUP_DIR, latest), 'utf8'));
    assert.equal(content.tasks[0].title, '第 3 版');
  } finally {
    await cleanup();
  }
});

test('并发写：同一文档的写被串行化，不丢更新', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // 先并发追加 10 条：每次都在前一次结果上追加（模拟真实读-改-写）
    let queue = Promise.resolve();
    for (let i = 0; i < 10; i += 1) {
      queue = queue.then(async () => {
        const read = await store.readDocument('tasks');
        const list = read.doc.tasks;
        const written = await store.writeDocument('tasks', { ...read.doc, tasks: [...list, { id: `t${i}`, title: `任务${i}` }] }, { expectedHash: read.hash });
        assert.equal(written.ok, true, `第 ${i} 次写失败：${written.reason}`);
      });
    }
    // 再一次性并发发起 10 个写，验证队列不会交错破坏文件
    await queue;
    const read = await store.readDocument('tasks');
    assert.equal(read.doc.tasks.length, 10);
    for (let i = 0; i < 10; i += 1) assert.ok(read.doc.tasks.some((t) => t.id === `t${i}`));
  } finally {
    await cleanup();
  }
});

test('原子写：目录里不残留临时文件', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    const read = await store.readDocument('tasks');
    await store.writeDocument('tasks', { ...read.doc, tasks: [] }, { expectedHash: read.hash });
    const entries = await fs.readdir(dir);
    assert.equal(entries.filter((n) => n.includes('.tmp-')).length, 0, `不应残留临时文件：${entries.join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('health：报告每份文件的状态', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    let health = await store.health();
    assert.equal(health.healthy, true);
    assert.equal(health.files.length, DOC_KEYS.length);

    await fs.rm(docPath(dir, 'term'));
    health = await store.health();
    assert.equal(health.healthy, false);
    assert.equal(health.files.find((f) => f.key === 'term').reason, 'missing');
  } finally {
    await cleanup();
  }
});

test('resetDocument：需要 confirm，且会先备份', async () => {
  const { dir, store, cleanup } = await makeStore();
  try {
    const read = await store.readDocument('courses');
    await store.writeDocument('courses', { ...read.doc, courses: [{ id: 'c1', name: '要保留在备份里的课' }] }, { expectedHash: read.hash, backupKeep: 5 });

    const withoutConfirm = await store.resetDocument('courses', {});
    assert.equal(withoutConfirm.ok, false);
    assert.equal(withoutConfirm.reason, 'need-confirm');

    const after = await store.readDocument('courses');
    const done = await store.resetDocument('courses', { confirm: true, expectedHash: after.hash, backupKeep: 5 });
    assert.equal(done.ok, true);
    const cleared = await store.readDocument('courses');
    assert.deepEqual(cleared.doc.courses, []);

    const backups = await fs.readdir(path.join(dir, BACKUP_DIR));
    assert.ok(backups.some((n) => n.startsWith(DOC_FILES.courses)), '重置前应有备份');
  } finally {
    await cleanup();
  }
});

test('回归保护：整个测试期间 _工具/作业台状态.json 的 sha256 未变', async () => {
  const stateAfter = await hashFile(REAL_STATE_FILE);
  assert.equal(stateAfter, stateBefore, '学习台插件不得改动已有作业台的状态文件');
});
