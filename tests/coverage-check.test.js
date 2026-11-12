// tools/coverage-check.mjs 的纯函数测试：三类清单各造一批 fixture，验证逐类算得对，
// 且空数据/缺文档不报错（都返回空数组）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCoverage } from '../tools/coverage-check.mjs';

const ANALYSIS = {
  version: 1,
  courses: [
    {
      courseId: 'c_a',
      points: [
        { id: 'k1', no: '1.1', title: '有一点', sources: [{ file: 'x.pdf', page: 1 }] },
        { id: 'k2', no: '1.2', title: '没出处', sources: [] },
      ],
      ppt: [
        { lecture: 'L01', title: '第一讲' },
        { lecture: 'L02', title: '第二讲' },
      ],
    },
  ],
};

const OUTLINE = {
  version: 1,
  courses: [
    {
      courseId: 'c_a',
      chapters: [
        { no: 1, title: '第一章' },
        { no: 2, title: '第二章' }, // 资料分析里没有第 2 章的点 → 空章节
      ],
    },
  ],
};

const MAP = {
  version: 1,
  updatedAt: null,
  points: {
    k1: { courseId: 'c_a', ppt: [{ lecture: 'L01', slide: 3 }] }, // 只挂了 L01 → L02 漏映射
  },
};

test('noSource：列出 sources 为空的知识点', () => {
  const { noSource } = computeCoverage(ANALYSIS, OUTLINE, MAP);
  assert.deepEqual(noSource, [{ courseId: 'c_a', pointId: 'k2', no: '1.2', title: '没出处' }]);
});

test('emptySections：列出大纲声明但资料分析无点的章', () => {
  const { emptySections } = computeCoverage(ANALYSIS, OUTLINE, MAP);
  assert.deepEqual(emptySections, [{ courseId: 'c_a', chapterNo: '2', title: '第二章' }]);
});

test('pptUnmapped：列出资料分析有、但知识映射没挂的讲次', () => {
  const { pptUnmapped } = computeCoverage(ANALYSIS, OUTLINE, MAP);
  assert.deepEqual(pptUnmapped, [{ courseId: 'c_a', lecture: 'L02', title: '第二讲' }]);
});

test('--course 过滤：只算指定课程', () => {
  const other = { version: 1, courses: [{ courseId: 'c_b', points: [{ id: 'z', no: '9.9', title: '别的课', sources: [] }], ppt: [] }] };
  const analysis = { version: 1, courses: [...ANALYSIS.courses, ...other.courses] };
  const miss = computeCoverage(analysis, OUTLINE, MAP, { course: 'c_a' });
  assert.equal(miss.noSource.length, 1);
  assert.equal(miss.noSource[0].courseId, 'c_a');
  const hit = computeCoverage(analysis, OUTLINE, MAP, { course: 'c_b' });
  assert.equal(hit.noSource.length, 1);
  assert.equal(hit.noSource[0].courseId, 'c_b');
});

test('空数据/缺文档：不报错，返回空清单', () => {
  const empty = computeCoverage(null, null, null);
  assert.deepEqual(empty, { noSource: [], emptySections: [], pptUnmapped: [], pptUnrecognizedFiles: [] });
  const emptyObj = computeCoverage({}, {}, {});
  assert.deepEqual(emptyObj, { noSource: [], emptySections: [], pptUnmapped: [], pptUnrecognizedFiles: [] });
});

test('pptUnmapped：点记录用 pptSources:[{file,slide}] 时，经 file→讲次 反查应算作已映射', () => {
  const analysis = {
    version: 1,
    courses: [
      {
        courseId: 'c_ppt',
        points: [],
        ppt: [
          { lecture: 'L01', title: '第一讲', titlePoints: [{ source: { file: 'X/L01.2026.pdf', slide: 1 } }] },
          { lecture: 'L02', title: '第二讲', titlePoints: [{ source: { file: 'X/L02.2026.pdf', slide: 1 } }] },
        ],
      },
    ],
  };
  const map = {
    version: 1,
    points: {
      p1: { courseId: 'c_ppt', pptSources: [{ file: 'X/L01.2026.pdf', slide: 1, importance: '强调' }] },
    },
  };
  const { pptUnmapped, pptUnrecognizedFiles } = computeCoverage(analysis, { courses: [] }, map);
  // L01 有 p1 挂到它的文件 → 不算漏；L02 没有任何点挂 → 仍算漏
  assert.deepEqual(pptUnmapped, [{ courseId: 'c_ppt', lecture: 'L02', title: '第二讲' }]);
  assert.deepEqual(pptUnrecognizedFiles, []);
});

test('pptUnmapped：pptSources 文件在资料分析里查不到时计入未识别文件、不静默丢弃', () => {
  const analysis = {
    version: 1,
    courses: [
      { courseId: 'c_x', points: [], ppt: [{ lecture: 'L01', title: '第一讲', titlePoints: [{ source: { file: 'X/L01.pdf', slide: 1 } }] }] },
    ],
  };
  const map = {
    version: 1,
    points: { q1: { courseId: 'c_x', pptSources: [{ file: 'X/ghost.pdf', slide: 2 }] } },
  };
  const { pptUnmapped, pptUnrecognizedFiles } = computeCoverage(analysis, { courses: [] }, map);
  // ghost 文件解析不出讲次 → L01 仍没有有效映射，照常算漏；ghost 计入未识别
  assert.deepEqual(pptUnmapped, [{ courseId: 'c_x', lecture: 'L01', title: '第一讲' }]);
  assert.deepEqual(pptUnrecognizedFiles, ['X/ghost.pdf']);
});
