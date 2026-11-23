/**
 * 课程公告解析测试（零依赖）。
 * 运行：node tests/learn-notices.test.js
 *
 * 只测纯函数（`parseCourseNotices` / `decodeNoticeBody`）与「接口探测结论」的契约：
 * 行在 `object.aaData`、正文是 base64 HTML、缺字段不炸。
 * 真实的网络请求不在这里跑 —— 真机验收写在任务卡回执里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeNoticeBody, parseCourseNotices } from '../lib/learn.js';

const b64 = (html) => Buffer.from(html, 'utf8').toString('base64');

const ROW = {
  ggid: 'gg1',
  wlkcid: '2026-2027-1152226501',
  bt: '期中考试安排（更新考试地点）',
  fbr: 'ZHAO HONG',
  fbsj: '2026-11-03 09:50',
  jzsj: null,
  ggnr: b64('<div><p>考试地点改为<b>三教 3201</b>。</p><script>alert(1)</script></div>'),
};

test('decodeNoticeBody：base64 HTML → 纯文本，脚本/标签都被剥掉', () => {
  const text = decodeNoticeBody(ROW.ggnr);
  assert.equal(text, '考试地点改为三教 3201。');
  assert.ok(!text.includes('alert'));
  assert.equal(decodeNoticeBody(''), '');
  assert.equal(decodeNoticeBody('不是base64!!!'), '');
});

test('parseCourseNotices：行在 object.aaData，字段齐全、正文截断、链接拼对', () => {
  const payload = { result: 'success', msg: null, object: { iTotalRecords: '1', aaData: [ROW] } };
  const notices = parseCourseNotices(payload, { maxBodyChars: 200 });
  assert.equal(notices.length, 1);
  const item = notices[0];
  assert.equal(item.id, 'gg1');
  assert.equal(item.title, '期中考试安排（更新考试地点）');
  assert.equal(item.publisher, 'ZHAO HONG');
  assert.equal(item.publishedAt, '2026-11-03 09:50');
  assert.equal(item.deadline, null);
  assert.equal(item.body, '考试地点改为三教 3201。');
  assert.equal(
    item.url,
    'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=2026-2027-1152226501&id=gg1',
  );
});

test('parseCourseNotices：正文超过 maxBodyChars 时截断并标注', () => {
  const long = '一'.repeat(300);
  const rows = [{ ...ROW, ggnr: b64(`<p>${long}</p>`) }];
  const [item] = parseCourseNotices({ object: { aaData: rows } }, { maxBodyChars: 50 });
  assert.ok(item.body.length <= 50 + '…（已截断）'.length);
  assert.ok(item.body.endsWith('…（已截断）'));
});

test('parseCourseNotices：没有正文、没有 ggid、空 payload 都不炸', () => {
  const rows = [
    { ggid: 'x', wlkcid: 'w', bt: '只有标题', fbr: '', fbsj: '', ggnr: '' },
    { bt: '', ggnr: '' }, // 无标题 → 丢弃
  ];
  const notices = parseCourseNotices({ object: { aaData: rows } });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].body, '');
  assert.equal(notices[0].url, 'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=w&id=x');
  assert.deepEqual(parseCourseNotices(null), []);
  assert.deepEqual(parseCourseNotices({}), []);
});

test('parseCourseNotices：标题里的 HTML 实体与标签也要清掉', () => {
  const rows = [{ ggid: 'y', wlkcid: 'w', bt: '&lt;p&gt;作业&lt;/p&gt;提醒', fbr: 'A&amp;B', fbsj: '2026-10-01' }];
  const [item] = parseCourseNotices({ object: { aaData: rows } });
  assert.equal(item.title, '作业提醒');
  assert.equal(item.publisher, 'A&B');
});
