// 第 13 份主文档「知识映射」的 schema 测试：
// DOC_KEYS/DOC_FILES 已登记、defaultDoc 给出空骨架、validateDoc 对空/有值都能放行、坏结构拒收。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DOC_KEYS, DOC_FILES, DOC_VERSION, defaultDoc, validateDoc } from '../lib/core.js';

test('knowledgeMap：已登记为第 13 份文档', () => {
  assert.ok(DOC_KEYS.includes('knowledgeMap'), 'DOC_KEYS 应含 knowledgeMap');
  assert.equal(DOC_KEYS.indexOf('knowledgeMap'), DOC_KEYS.length - 1, 'knowledgeMap 应排在最后');
  assert.equal(DOC_FILES.knowledgeMap, '知识映射.json');
});

test('knowledgeMap：defaultDoc 是空骨架 {version,updatedAt,points:{}} 且可校验', () => {
  const doc = defaultDoc('knowledgeMap');
  assert.equal(doc.version, DOC_VERSION);
  assert.equal(doc.updatedAt, null);
  assert.deepEqual(doc.points, {});
  assert.deepEqual(Object.keys(doc).sort(), ['points', 'updatedAt', 'version'].sort());
  assert.deepEqual(validateDoc('knowledgeMap', doc), { ok: true });
});

test('knowledgeMap：validateDoc 放行有映射值的文档', () => {
  const doc = {
    version: DOC_VERSION,
    updatedAt: '2026-11-01T00:00:00.000Z',
    points: {
      k_abc123: { textbook: { file: '数据结构/教材/数据结构教材.pdf', page: 50 }, ppt: [{ lecture: 'L03', slide: 12 }] },
    },
  };
  assert.deepEqual(validateDoc('knowledgeMap', doc), { ok: true });
});

test('knowledgeMap：validateDoc 拒绝坏结构（非对象 / points 不是对象 / version 不对）', () => {
  assert.equal(validateDoc('knowledgeMap', 'oops').ok, false);
  assert.equal(validateDoc('knowledgeMap', { version: DOC_VERSION, updatedAt: null, points: [] }).ok, false);
  assert.equal(validateDoc('knowledgeMap', { version: DOC_VERSION, updatedAt: null }).ok, false);
  assert.equal(validateDoc('knowledgeMap', { version: 999, updatedAt: null, points: {} }).ok, false);
});
