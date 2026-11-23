// 学习助手 v2-I（2026-11-23 方案 C）：点章名 → 未展开就展开（已展开不折叠）→ 有讲义读讲义、无讲义只展开。
//
// 为什么这么测：项目零依赖、没有 DOM 测试栈，KnowledgeTab 也没导出内部函数。
// 所以这里分两层：
//   ① 源码结构钉子（两棵树章名都走同一个入口、左箭头一字未动、旧的详情卡跳转不受影响）；
//   ② 把 `handleChapterClick` / `openChapter` 的真实源码抽出来、用 mock 依赖跑一遍分支
//      （展开顺序、silentIfEmpty 不弹空卡、旧调用点仍给说明卡）。
// 第 ② 层跑的是 client.full.js 里的原文，不是测试里另抄一份逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.full.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/** 截一段源码：[start, end)。找不到标记就直接失败，免得静默退化成「在全文里碰巧命中」。 */
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到终点标记：${endMarker}`);
  return text.slice(start, end);
}

/** 从 `const xxx = ...` 起抽出整条箭头函数源码 `(params) => { ... }`（花括号配平扫描）。 */
function extractArrow(text, startMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到函数起点：${startMarker}`);
  const eq = text.indexOf('=', start);
  const arrow = text.indexOf('=>', eq);
  assert.ok(eq > start && arrow > eq, `${startMarker} 不是箭头函数？`);
  const params = text.slice(eq + 1, arrow).trim();
  let depth = 0;
  let i = text.indexOf('{', arrow);
  assert.ok(i > arrow, `${startMarker} 没有函数体`);
  for (; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `${startMarker} 的花括号没配平`);
  const body = text.slice(arrow + 2, i + 1);
  return `${params} => ${body}`;
}

const HANDLE = extractArrow(SOURCE, 'const handleChapterClick = (entry)');
const OPEN = extractArrow(SOURCE, 'const openChapter = (entry, options = {})');

/** 用假 state 跑真实的 handleChapterClick 源码。 */
function makeHandle(openTree, kpQuery) {
  const calls = [];
  const toggleTreeNode = (key) => { calls.push({ call: 'toggle', key }); openTree.push(key); };
  const openChapter = (entry, options) => { calls.push({ call: 'open', key: entry.key, options }); };
  const handle = new Function('openTree', 'kpQuery', 'toggleTreeNode', 'openChapter', `return (${HANDLE});`)(
    openTree, kpQuery, toggleTreeNode, openChapter);
  return { handle, calls };
}

/** 用假的 setter 跑真实的 openChapter 源码，返回按顺序记下的事件。 */
function runOpenChapter(lecture, options) {
  const events = [];
  const openChapter = new Function(
    'lectureForEntry', 'selectForReading', 'setOpenPath', 'setDetail', 'setLectureHint', 'openLecture',
    `return (${OPEN});`,
  )(
    () => lecture,
    () => events.push(['selectForReading', null]),
    (value) => events.push(['setOpenPath', value]),
    (value) => events.push(['setDetail', value]),
    (value) => events.push(['setLectureHint', value]),
    (value) => events.push(['openLecture', value]),
  );
  openChapter({ label: '第3章 组合逻辑电路' }, options);
  return events;
}

test('① 章名点击统一入口：未展开才 toggle、随后 openChapter 走 silentIfEmpty；已展开不折叠', () => {
  assert.ok(SOURCE.includes('const handleChapterClick = (entry) => {'),
    'handleChapterClick 必须存在（两棵树共用的章名入口）');
  assert.equal(SOURCE.split('handleChapterClick').length - 1, 3,
    'handleChapterClick 出现 3 次：定义 1 + 两处章名 onClick 各 1');
  assert.ok(HANDLE.includes("const expanded = openTree.includes(entry.key) || kpQuery.trim() !== ''"),
    '已展开判定＝手动展开 ∪ 搜索态强制展开（与渲染侧 open 同口径）');
  assert.ok(HANDLE.includes('if (!expanded) toggleTreeNode(entry.key);'),
    '只有未展开时 toggle；已展开保持不折叠（用户选①）');
  assert.equal(HANDLE.split('toggleTreeNode').length - 1, 1, '函数体里只允许一次 toggle（不许再补折叠分支）');
  assert.ok(HANDLE.includes('openChapter(entry, { silentIfEmpty: true });'),
    '开完层再读讲义，且传 silentIfEmpty（无讲义不弹空卡）');
  assert.ok(HANDLE.indexOf('toggleTreeNode') < HANDLE.indexOf('openChapter'),
    '顺序：先展开、后读讲义（渲染依赖 open，不能反）');
});

test('② 两棵树章名都调 handleChapterClick；左箭头仍纯 toggleTreeNode（一字未动）', () => {
  assert.equal(SOURCE.split('isChapter ? handleChapterClick(entry) : toggleTreeNode(entry.key)').length - 1, 2,
    '完整视图 treeRow + 紧凑树 compactTreeRow 两处章名 onClick 都要改成 handleChapterClick');
  assert.equal(SOURCE.split('isChapter ? openChapter(entry)').length - 1, 0,
    '不许残留旧写法（点章名只读讲义、不展开）');

  // 左箭头：完整视图 sa-kp-caret（▸）/ 紧凑树 sa-compact-arrow-btn —— 行为一字不动
  for (const [name, start, end] of [
    ['sa-kp-caret', "className: 'sa-kp-caret'", "}, '▸'),"],
    ['sa-compact-arrow-btn', "className: 'sa-compact-arrow-btn'", "h('span', { className: 'sa-compact-arrow'"],
  ]) {
    const block = sliceBetween(SOURCE, start, end);
    assert.equal(block.split('toggleTreeNode(entry.key)').length - 1, name === 'sa-kp-caret' ? 2 : 1,
      `${name} 仍只做 toggleTreeNode（keydown 也要）`);
    assert.equal(block.split('handleChapterClick').length - 1, 0, `${name} 不许改走章名入口`);
    assert.equal(block.split('openChapter').length - 1, 0, `${name} 不许顺带读讲义`);
    assert.ok(block.includes("event.stopPropagation(); toggleTreeNode(entry.key);"),
      `${name} 要 stopPropagation，避免冒泡到整行章名 onClick`);
  }

  // 详情卡里那条旧跳转（不传 options）保持原样 —— 它只在「有讲义」时才渲染
  assert.equal(SOURCE.split('openChapter({ label: selectedNode.chapter })').length - 1, 1,
    '知识点详情卡的章讲义入口保持旧行为（不传 silentIfEmpty）');
});

test('③ 无讲义 + silentIfEmpty：只展开，不弹「讲义还没生成」空卡', () => {
  const events = runOpenChapter(null, { silentIfEmpty: true });
  assert.deepEqual(events, [['selectForReading', null], ['setLectureHint', null]],
    '只清选中 + 把 hint 置空；不许 setOpenPath/setDetail 清正文，也不许 openLecture');
  assert.ok(!events.some((event) => event[0] === 'setLectureHint' && event[1] !== null),
    '不许 setLectureHint({title}) —— 那张空卡就是它触发渲染的');

  // 无讲义但不传 options（旧调用点）：说明卡照旧
  const legacy = runOpenChapter(null, undefined);
  assert.ok(legacy.some((event) => event[0] === 'setOpenPath' && event[1] === null), '旧路径仍清正文');
  assert.ok(legacy.some((event) => event[0] === 'setLectureHint' && event[1]?.title === '第3章 组合逻辑电路'),
    '旧路径仍给「这一章讲义还没生成」说明卡（10599 跳转不受影响）');
});

test('④ 有讲义：展开后顺带读该章讲义，hint 清空', () => {
  const lecture = { no: 3, title: '组合逻辑电路', styles: [{ key: 'C', file: '数电/讲义/第03章-C.md' }] };
  const events = runOpenChapter(lecture, { silentIfEmpty: true });
  assert.deepEqual(events, [['selectForReading', null], ['setLectureHint', null], ['openLecture', lecture]],
    '清选中 → 清 hint → openLecture(该章讲义)');
  assert.ok(!events.some((event) => event[0] === 'setLectureHint' && event[1] !== null), '有讲义时不许弹空卡');
});

test('⑤ 真跑 handleChapterClick：未展开→展开+读讲义；已展开→不折叠；搜索态→不 toggle', () => {
  const key = 'chapter:数电:第3章';
  const entry = { key, kind: 'chapter', label: '第3章 组合逻辑电路' };

  // (a) 未展开：先 toggle 一次，再 openChapter(silentIfEmpty)
  const cold = makeHandle([], '');
  cold.handle(entry);
  assert.deepEqual(cold.calls.map((item) => item.call), ['toggle', 'open'], '点一次＝展开一次 + 读讲义一次');
  assert.equal(cold.calls[0].key, key, 'toggle 的是这一行自己的 key');
  assert.deepEqual(cold.calls[1].options, { silentIfEmpty: true });

  // (b) 已展开：不再 toggle（不折叠），讲义照样切
  const warm = makeHandle([key], '');
  warm.handle(entry);
  assert.deepEqual(warm.calls.map((item) => item.call), ['open'], '已展开再点章名：保持展开，只切讲义');

  // (c) 搜索态：树是强制全展开的，再 toggle 反而会把命中的章折起来
  const searching = makeHandle([], '第3章');
  searching.handle(entry);
  assert.deepEqual(searching.calls.map((item) => item.call), ['open'], '搜索态不 toggle');
});

test('⑥ 安全回归：新增代码 0 hex、0 dangerouslySetInnerHTML，两份 bundle 逐字一致', () => {
  for (const [name, text] of [['client.full.js', SOURCE], ['client.js', SHIPPED]]) {
    assert.ok(!text.includes('dangerouslySetInnerHTML'), `${name} 不许出现 dangerouslySetInnerHTML`);
  }
  for (const [name, code] of [['handleChapterClick', HANDLE], ['openChapter', OPEN]]) {
    assert.ok(!HEX.test(code), `${name} 是纯逻辑，不许引入 hex 色值：${code}`);
  }
  assert.equal(SHIPPED, SOURCE, 'client.js 必须与 client.full.js 逐字一致（sync-client-full --reverse 后再 --check）');
});
