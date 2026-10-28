import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTES_DIR,
  normalizeCourseName,
  noteDirName,
  matchCourse,
  pickCourseDir,
} from '../lib/lecture/course.js';

/**
 * 这一层值得钉死的原因：课后总结要写进「这门课自己的目录」，而开课时敲的
 * 课程名是自由的（「数据结构」「数构」「数据结构习题课」都可能）。选错目录
 * 的后果是把笔记扔进别的课、或者在作业目录里凭空建一个课程文件夹 —— 前者
 * 用户过几天才发现，后者会污染他整个学期的目录结构。
 */

const courses = [
  {
    id: 'c_ds',
    name: '数据结构',
    aliases: ['数构', 'DS'],
    note: '工作区目录：数据结构/；截图里占 3-5 节（连堂）',
  },
  {
    id: 'c_phy',
    name: '大学物理B(2)',
    aliases: ['物理', '大学物理', '大物'],
    note: '工作区目录：物理/',
  },
  {
    id: 'c_digital',
    name: '数字电子技术基础',
    aliases: ['数电', '数电实验', '数字电子技术实验', '数字电路'],
    note: '工作区目录：数电/；周三 6-7 节是实验',
  },
  {
    id: 'c_marx',
    name: '马克思主义基本原理',
    aliases: ['马原', '马克思', '马基'],
    note: '',
  },
];

test('课程名归一化：去首尾空白、压连续空格', () => {
  assert.equal(normalizeCourseName('  数据 结构 '), '数据 结构');
  assert.equal(normalizeCourseName(null), '');
  assert.equal(normalizeCourseName(undefined), '');
});

test('noteDirName 抠得出「工作区目录：物理/」，抠不出就返回空串', () => {
  assert.equal(noteDirName('工作区目录：物理/'), '物理');
  assert.equal(noteDirName('工作区目录: 数电/；周三 6-7 节是实验'), '数电');
  assert.equal(noteDirName('截图里占 6-9 节（连堂）'), '');
  assert.equal(noteDirName(''), '');
  assert.equal(noteDirName(undefined), '');
});

test('matchCourse：课程名全等优先，其次别名，最后互相包含', () => {
  assert.equal(matchCourse(courses, '数据结构')?.id, 'c_ds');
  assert.equal(matchCourse(courses, ' 数据结构 ')?.id, 'c_ds');
  assert.equal(matchCourse(courses, '数构')?.id, 'c_ds');
  assert.equal(matchCourse(courses, 'DS')?.id, 'c_ds');
  assert.equal(matchCourse(courses, '数据结构习题课')?.id, 'c_ds');
  assert.equal(matchCourse(courses, '大物')?.id, 'c_phy');
  assert.equal(matchCourse(courses, '数电实验')?.id, 'c_digital');
  // 「数字电子技术」是课程名的一部分，也该认
  assert.equal(matchCourse(courses, '数字电子技术')?.id, 'c_digital');
  assert.equal(matchCourse(courses, '毛概'), null);
  assert.equal(matchCourse(courses, ''), null);
  assert.equal(matchCourse(null, '数据结构'), null);
});

test('pickCourseDir：note 里点名的目录最优先', () => {
  const dirNames = ['数据结构', '数电', '数电实验', '物理', '英语', '离散数学'];
  assert.deepEqual(pickCourseDir({ typed: '数据结构', courses, dirNames }), { dirName: '数据结构', via: 'note' });
  assert.deepEqual(pickCourseDir({ typed: '数构', courses, dirNames }), { dirName: '数据结构', via: 'note' });
  assert.deepEqual(pickCourseDir({ typed: '数据结构习题课', courses, dirNames }), { dirName: '数据结构', via: 'note' });
  assert.deepEqual(pickCourseDir({ typed: '大学物理B(2)', courses, dirNames }), { dirName: '物理', via: 'note' });
  // note 说「数电/」，即使工作区里还有个「数电实验」也不能被抢走
  assert.deepEqual(pickCourseDir({ typed: '数电', courses, dirNames }), { dirName: '数电', via: 'note' });
});

test('pickCourseDir：note 点的目录不存在时，退回课程名 / 别名', () => {
  // 只存在「数字电子技术基础」这个完整目录名
  const full = ['数字电子技术基础', '数据结构'];
  assert.deepEqual(pickCourseDir({ typed: '数电', courses, dirNames: full }), { dirName: '数字电子技术基础', via: 'name' });

  // 课程名叫「大学物理B(2)」但目录只有别名「大物」
  const aliasOnly = ['大物'];
  assert.deepEqual(pickCourseDir({ typed: '大学物理B(2)', courses, dirNames: aliasOnly }), { dirName: '大物', via: 'alias' });

  // note 点的「数电」不存在，别名里只有「数电实验」在
  assert.deepEqual(pickCourseDir({ typed: '数字电子技术基础', courses, dirNames: ['数电实验'] }), { dirName: '数电实验', via: 'alias' });

  // note 里的目录在，就轮不到别名 —— 哪怕别名更具体
  assert.deepEqual(pickCourseDir({ typed: '数字电子技术基础', courses, dirNames: ['数电', '数电实验'] }), { dirName: '数电', via: 'note' });
});

test('pickCourseDir：课程表里没有这门课时，认「敲的名字里包含的目录名」', () => {
  assert.deepEqual(
    pickCourseDir({ typed: '数据结构习题课', courses: [], dirNames: ['数据结构', '数电'] }),
    { dirName: '数据结构', via: 'scan' },
  );
  // 多个目录名同时被包含时，取更长的（更具体）
  assert.deepEqual(
    pickCourseDir({ typed: '数电实验答疑', courses: [], dirNames: ['数电', '数电实验'] }),
    { dirName: '数电实验', via: 'scan' },
  );
});

test('pickCourseDir：都不中就返回空串 —— 由调用方退回 dataDir/笔记，绝不凭空建课程目录', () => {
  const dirNames = ['数据结构', '数电', '物理'];
  assert.deepEqual(pickCourseDir({ typed: '毛概', courses, dirNames }), { dirName: '', via: '' });
  assert.deepEqual(pickCourseDir({ typed: '', courses, dirNames }), { dirName: '', via: '' });
  assert.deepEqual(pickCourseDir({ typed: '数据结构', courses, dirNames: [] }), { dirName: '', via: '' });
  // 课程表认得出这门课，但它的目录根本不存在（用户还没建）
  assert.deepEqual(pickCourseDir({ typed: '马克思', courses, dirNames }), { dirName: '', via: '' });
  assert.deepEqual(pickCourseDir({ typed: '数据结构', courses: null, dirNames: null }), { dirName: '', via: '' });
});

test('NOTES_DIR 是「笔记」', () => {
  assert.equal(NOTES_DIR, '笔记');
});
