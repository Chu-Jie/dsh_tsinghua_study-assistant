/**
 * `lib/knowledge.js` 的单测：候选 → 网络节点的「织网」逻辑。
 *
 * 这一层最要紧的性质是**确定性**：同一份候选重跑必须得到同一份网络（id 不变、掌握度不丢、
 * 证据不重复）。所以这里的用例基本都在演「跑第二遍」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeId, knowledgeKey, normalizeEvidenceEntries, weaveCandidates } from '../lib/knowledge.js';

const courses = { courses: [{ id: 'c_ds', name: '数据结构' }, { id: 'c_dg', name: '数字电子技术基础' }] };

const base = { network: { version: 1, nodes: [], edges: [] }, courses };

test('新建：节点带稳定 id，重跑同一份候选完全不变', () => {
  const candidates = {
    candidates: [
      { courseId: 'c_ds', name: '循环队列', aliases: ['环形队列'], chapter: '第 3 章 栈与队列' },
      { courseId: 'c_ds', name: '时间复杂度' },
    ],
  };
  const first = weaveCandidates({ ...base, candidates, now: '2026-10-20T13:00:00.000Z' });
  assert.equal(first.changed, true);
  assert.equal(first.stats.created, 2);
  assert.equal(first.network.nodes.length, 2);
  const queue = first.network.nodes.find((node) => node.name === '循环队列');
  assert.equal(queue.id, knowledgeId('c_ds', '循环队列'), 'id 由课程 + 名字派生');
  assert.deepEqual(queue.aliases, ['环形队列']);
  assert.equal(queue.mastery, 0);
  assert.equal(queue.marked, false);
  assert.equal(queue.chapter, '第 3 章 栈与队列');
  assert.equal(first.network.updatedAt, '2026-10-20T13:00:00.000Z');

  const second = weaveCandidates({ network: first.network, candidates, courses, now: '2026-10-20T14:00:00.000Z' });
  assert.equal(second.changed, false);
  assert.equal(second.stats.unchanged, 2);
  assert.deepEqual(second.network.nodes.map((node) => node.id), first.network.nodes.map((node) => node.id), '重跑不能换 id');
  assert.equal(second.network.updatedAt, first.network.updatedAt, '没有变化时不刷 updatedAt');
});

test('合并：人写下的东西（掌握度/重点/备注/复习时间）不被覆盖，只补空字段与并集', () => {
  const network = {
    version: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    nodes: [{
      id: 'k_existing',
      name: '循环队列',
      courseId: 'c_ds',
      chapter: '',
      section: '',
      aliases: [],
      mastery: 2,
      marked: true,
      reviewedAt: '2026-10-19T08:00:00.000Z',
      note: '队满判断要留一格',
      evidence: [{ type: 'question', id: 'q_old' }],
      createdAt: '2026-10-19T07:00:00.000Z',
    }],
    edges: [{ from: 'k_existing', to: 'k_x', type: 'prereq' }],
  };
  const candidates = {
    candidates: [{
      courseId: 'c_ds',
      name: '循环队列',
      aliases: ['环形队列'],
      chapter: '第 3 章 栈与队列',
      evidence: [{ type: 'material', file: '数据结构/教材/数据结构教材.pdf', page: 58, quote: '循环队列把数组首尾相连' }],
    }],
  };
  const result = weaveCandidates({ network, candidates, courses, now: '2026-10-20T13:00:00.000Z' });
  const node = result.network.nodes[0];
  assert.equal(result.stats.created, 0);
  assert.equal(result.stats.merged, 1);
  assert.equal(node.id, 'k_existing', '合并不改 id');
  assert.equal(node.mastery, 2);
  assert.equal(node.marked, true);
  assert.equal(node.note, '队满判断要留一格');
  assert.equal(node.reviewedAt, '2026-10-19T08:00:00.000Z');
  assert.equal(node.chapter, '第 3 章 栈与队列', '空章被补上');
  assert.deepEqual(node.aliases, ['环形队列']);
  assert.deepEqual(node.evidence.map((item) => item.type), ['question', 'material'], '旧证据在前、新证据在后');
  assert.equal(result.stats.evidenceAdded, 1);
  assert.deepEqual(result.network.edges, network.edges, '边原样保留');

  // 再跑一遍：证据与别名都已在，不该算「变了」
  const again = weaveCandidates({ network: result.network, candidates, courses, now: '2026-10-20T15:00:00.000Z' });
  assert.equal(again.changed, false);
  assert.equal(again.network.nodes[0].evidence.length, 2, '证据不能因重跑而重复');
});

test('别名命中：候选名是既有节点的别名时合并，不新建', () => {
  const network = {
    version: 1,
    nodes: [{ id: 'k_1', name: '循环队列', courseId: 'c_ds', chapter: '', section: '', aliases: ['环形队列'], mastery: 0, marked: false, reviewedAt: null, note: '', evidence: [], createdAt: '2026-10-19T00:00:00.000Z' }],
    edges: [],
  };
  const result = weaveCandidates({ network, candidates: { candidates: [{ courseId: 'c_ds', name: '环形队列' }] }, courses });
  assert.equal(result.network.nodes.length, 1);
  assert.equal(result.stats.created, 0);
  assert.equal(result.stats.merged + result.stats.unchanged, 1);
});

test('题目补证据：同课同名的题才补，跨课不串', () => {
  const questions = {
    questions: [
      { id: 'q_ds_1', courseId: 'c_ds', knowledgeNames: ['循环队列'] },
      { id: 'q_dg_1', courseId: 'c_dg', knowledgeNames: ['循环队列'] },
      { id: 'q_ds_2', courseId: 'c_ds', knowledgeNames: ['时间复杂度'] },
    ],
  };
  const result = weaveCandidates({ ...base, candidates: { candidates: [{ courseId: 'c_ds', name: '循环队列' }] }, questions });
  const node = result.network.nodes[0];
  assert.deepEqual(node.evidence, [{ type: 'question', id: 'q_ds_1' }], '别的课程的题不能挂过来');
});

test('脏数据：无名字/非对象跳过，课程认不出就置空，空候选不改文档', () => {
  const result = weaveCandidates({
    network: { version: 1, updatedAt: '2026-10-20T12:00:00.000Z', nodes: [], edges: [] },
    candidates: { candidates: [{ name: '' }, null, { courseId: 'c_missing', name: '概念 X' }, { name: '概念 Y', courseId: 'c_ds' }] },
    courses,
    now: '2026-10-20T13:00:00.000Z',
  });
  assert.equal(result.stats.skipped, 2);
  const [x, y] = result.network.nodes;
  assert.equal(x.courseId, null, '认不出的课程不硬塞');
  assert.equal(y.courseId, 'c_ds');

  const empty = weaveCandidates({ ...base, candidates: { candidates: [] }, now: '2026-10-20T13:00:00.000Z' });
  assert.equal(empty.changed, false);
  assert.equal(empty.network.updatedAt, null);
});

test('小的归一化工具：键折叠空白与大小写，证据去重并封顶 24 条', () => {
  assert.equal(knowledgeKey('  TCP   协议 '), 'tcp 协议');
  assert.equal(knowledgeId('c_ds', '循环队列'), knowledgeId('c_ds', ' 循环队列 '));
  assert.notEqual(knowledgeId('c_ds', '循环队列'), knowledgeId('c_dg', '循环队列'));

  const many = Array.from({ length: 40 }, (_, index) => ({ type: 'question', id: `q${index}` }));
  const list = normalizeEvidenceEntries([{ type: 'question', id: 'q0' }, { type: 'question', id: 'q0' }, ...many]);
  assert.equal(list.length, 24);
  assert.deepEqual(list[0], { type: 'question', id: 'q0' });
});
