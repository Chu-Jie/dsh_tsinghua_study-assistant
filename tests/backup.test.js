/**
 * 全量导出 / 恢复的纯逻辑测试：包格式、校验和、坏包拒绝、逐份结构校验。
 *
 * 这些断言守的是「出事能盖回来」这条底线 —— 校验和一旦形同虚设，
 * 恢复就会把半份坏数据写进九份文档里，比不提供恢复更危险。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUNDLE_FORMAT, BUNDLE_VERSION, buildBundle, bundleChecksum, verifyBundle } from '../lib/backup.js';

const DOCS = {
  term: { version: 1, terms: [{ id: 't1', name: '2026 秋', startDate: '2026-09-14', endDate: '2027-01-10', totalWeeks: 16, isCurrent: true }], currentId: 't1', updatedAt: null },
  courses: { version: 1, courses: [{ id: 'c1', name: '大学物理' }], updatedAt: null },
  grades: { version: 1, courses: [], rules: { mode: '4.0-weighted', formula: 'linear-50' }, targets: [], updatedAt: null },
};

test('导出包：格式、版本、导出时间、校验和都在，且只收认识的文档键', () => {
  const bundle = buildBundle(DOCS, { exportedAt: '2026-10-21T12:00:00.000Z', app: { name: 'study-assistant' } });
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.equal(bundle.version, BUNDLE_VERSION);
  assert.equal(bundle.exportedAt, '2026-10-21T12:00:00.000Z');
  assert.equal(bundle.app.name, 'study-assistant');
  assert.equal(JSON.stringify(Object.keys(bundle.docs)), JSON.stringify(['term', 'courses', 'grades']), '只收九份主文档里存在的键，顺序固定');
  assert.match(bundle.checksum, /^sha256:[0-9a-f]{64}$/);
  // 九份文档之外的东西不进包（防止把缓存/日志当成数据带走）
  const withExtra = buildBundle({ ...DOCS, junk: { a: 1 } });
  assert.equal('junk' in withExtra.docs, false, '不认识的键必须丢掉');
});

test('校验和只看内容：键序不同的同一份数据算同一个包', () => {
  const a = { version: 1, courses: [{ id: 'c1', name: '物理' }], updatedAt: null };
  const b = { courses: [{ name: '物理', id: 'c1' }], version: 1, updatedAt: null };
  assert.equal(bundleChecksum({ courses: a }), bundleChecksum({ courses: b }), '同一份数据、不同键序，校验和必须一致');
  const changed = { version: 1, courses: [{ id: 'c1', name: '物理（改）' }], updatedAt: null };
  assert.notEqual(bundleChecksum({ courses: a }), bundleChecksum({ courses: changed }), '内容一改就必须变');
});

test('坏包逐类拒绝，不许「看起来恢复了」', () => {
  const good = buildBundle(DOCS);

  const notJson = verifyBundle('{这不是 JSON');
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error, 'not-json');

  assert.equal(verifyBundle([]).error, 'not-an-object');
  assert.equal(verifyBundle(null).error, 'not-an-object');

  const badFormat = verifyBundle({ ...good, format: 'something-else' });
  assert.equal(badFormat.error, 'bad-format');
  assert.equal(badFormat.detail, 'something-else');

  const badVersion = verifyBundle({ ...good, version: 99 });
  assert.equal(badVersion.error, 'bad-version');

  const noDocs = verifyBundle({ ...good, docs: {} });
  assert.equal(noDocs.error, 'no-docs');
  assert.equal(noDocs.ok, false);

  const noChecksum = verifyBundle({ ...good, checksum: '' });
  assert.equal(noChecksum.error, 'no-checksum');

  const tampered = JSON.parse(JSON.stringify(good));
  tampered.docs.courses.courses[0].name = '被改过的课程';
  const mismatch = verifyBundle(tampered);
  assert.equal(mismatch.error, 'checksum-mismatch');
  assert.match(mismatch.expected, /^sha256:/);
  assert.match(mismatch.actual, /^sha256:/);
  assert.notEqual(mismatch.expected, mismatch.actual);

  const invalidDoc = JSON.parse(JSON.stringify(good));
  invalidDoc.docs.tasks = { version: 1, tasks: '不是数组' };
  invalidDoc.checksum = bundleChecksum(invalidDoc.docs);
  const badDoc = verifyBundle(invalidDoc);
  assert.equal(badDoc.error, 'invalid-doc');
  assert.equal(badDoc.key, 'tasks');
  assert.match(badDoc.detail, /bad-field/);
});

test('好包能验回去：键清单、docs、导出时间都还原，字符串形态也认', () => {
  const good = buildBundle(DOCS, { exportedAt: '2026-10-21T12:00:00.000Z' });
  const parsed = verifyBundle(good);
  assert.equal(parsed.ok, true);
  assert.equal(JSON.stringify(parsed.keys), JSON.stringify(['term', 'courses', 'grades']));
  assert.equal(parsed.docs.courses.courses[0].name, '大学物理');
  assert.equal(parsed.exportedAt, '2026-10-21T12:00:00.000Z');

  const fromText = verifyBundle(JSON.stringify(good, null, 2));
  assert.equal(fromText.ok, true, '导出文件（带缩进）也要能直接验');
  assert.equal(fromText.exportedAt, '2026-10-21T12:00:00.000Z');
  assert.equal(verifyBundle(JSON.stringify(good)).ok, true, '紧凑 JSON 也要能验');
});

test('只带部分文档的包也合法（比如只导出过成绩）', () => {
  const partial = buildBundle({ grades: DOCS.grades });
  const checked = verifyBundle(partial);
  assert.equal(checked.ok, true);
  assert.equal(JSON.stringify(checked.keys), JSON.stringify(['grades']));
});
