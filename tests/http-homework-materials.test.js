/**
 * 一键开工「自动取料」测试（零依赖）。
 * 运行：node tests/http-homework-materials.test.js
 *
 * 两层都测：
 *   1. 取料模块（lib/homework-intake.js）：题型两形态、题号解析、落盘命名、缺料不瞎编；
 *   2. HTTP 接线：POST /homework/collect-materials 的写请求校验与响应，以及
 *      /homework/spawn 确实把取料结果拼进了固定指令。
 *
 * 所有网络与渲染都注入假实现 —— 单测绝不真的去打网络学堂，也不起 Python。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createStore } from '../lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import {
  INTAKE_MARK,
  buildMaterialsMarkdown,
  classifyHomeworkSource,
  collectHomeworkMaterials,
  deriveHomeworkLabel,
  describeIntake,
  locateExercise,
  parseFullTextPages,
  parseTextbookRefs,
  pickTextbookPdf,
  resolveAttachmentUrl,
  safeFileName,
  sanitizeUntrustedText,
  subjectDirName,
} from '../lib/homework-intake.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

// ─────────────────────────────── 纯函数 ───────────────────────────────

test('parseTextbookRefs：第X版 + 章.题、习题15.10、第Y题、页码都能抽出来', () => {
  const a = parseTextbookRefs('第3版 5.12');
  assert.equal(a.version, 3);
  assert.deepEqual(a.refs.map((r) => [r.chapter, r.exercise]), [[5, 12]]);

  const b = parseTextbookRefs('第 2 版习题 15.10');
  assert.equal(b.version, 2);
  assert.deepEqual(b.refs[0].chapter, 15);
  assert.deepEqual(b.refs[0].exercise, 10);

  const c = parseTextbookRefs('P123 第5题');
  assert.ok(c.refs.some((r) => r.page === 123));
  assert.ok(c.refs.some((r) => r.exercise === 5));

  const d = parseTextbookRefs('1. 14.2\n2. 14.4\n3. 14.7');
  assert.deepEqual(d.refs.map((r) => `${r.chapter}.${r.exercise}`), ['14.2', '14.4', '14.7']);
});

test('classifyHomeworkSource：有附件=形态①；只有题号=形态②；成段说明=text；都没有=unknown', () => {
  const withFile = classifyHomeworkSource({ attachments: [{ name: 'HW.pdf' }], description: '第3版 5.12' });
  assert.equal(withFile.mode, 'attachment');
  assert.equal(withFile.textbookSupplement, true);

  const onlyNumbers = classifyHomeworkSource({ attachments: [], description: '1. 14.2\n2. 14.4\n3. 14.7\n4. 14.14\n5. 15.2' });
  assert.equal(onlyNumbers.mode, 'textbook');
  assert.equal(onlyNumbers.refs.length, 5);

  const prose = classifyHomeworkSource({ attachments: [], description: '请证明：任意连通图的边数不少于顶点数减一，并说明等号成立的条件。' });
  assert.equal(prose.mode, 'text');

  const empty = classifyHomeworkSource({ attachments: [], description: '' });
  assert.equal(empty.mode, 'unknown');
});

test('locateExercise：正文命中=high，目录行不算；找不到正文退回该章习题段=low', () => {
  const pages = [
    { no: 3, text: '目录\n5.12 ……………… 46\n5.15 ……………… 47' },
    { no: 100, text: '习题 5\n5.12　设 G 是简单图，证明边数不少于顶点数减一\n5.13　另一题' },
    { no: 101, text: '继续\n5.15　求最小生成树。' },
  ];
  const hit = locateExercise(pages, { chapter: 5, exercise: 12, page: null });
  assert.equal(hit.page, 100, '目录页里的 5.12 不能被当成正文');
  assert.equal(hit.confidence, 'high');

  const low = locateExercise(pages, { chapter: 5, exercise: 99, page: null });
  assert.equal(low.confidence, 'low');
  assert.deepEqual(low.pages, [100, 101]);
});

test('locateExercise：段内题号（习 题 15 的第 10 题）按「题号.」定位，不被「图 15.12」误导', () => {
  const pages = [
    { no: 335, text: '例 15.7 邮递员街区如图 15.12(a) 所示，……\n15.12 图注：某街区地图' },
    { no: 336, text: '习    题    15\n1. 证明……\n2. 求……' },
    { no: 337, text: '4. 画一个有向欧拉图\n10. 证明定理 15.8.' },
  ];
  const hit = locateExercise(pages, { chapter: 15, exercise: 10, page: null });
  assert.equal(hit.page, 337);
  assert.equal(hit.confidence, 'high');
});

test('parseFullTextPages：按「# 第 N 页」切段，页号保留', () => {
  const md = '# 第 1 页\n\n封面\n\n# 第 2 页\n\n习题 5\n5.12 题干';
  const pages = parseFullTextPages(md);
  assert.equal(pages.length, 2);
  assert.equal(pages[1].no, 2);
  assert.ok(pages[1].text.includes('5.12'));
});

test('parseFullTextPages：整本视觉 OCR 的 `## 第 N 页（…）` 页头与 `**题号**` 也认，老的 `# 第 N 页` 照旧', () => {
  const md = [
    '# 离散数学（第 3 版）全文 OCR',
    '',
    '## 第 142 页（PDF 页 142，印刷页 129）',
    '',
    '**5.12**　设 $f: \\mathbf{N} \\rightarrow \\mathbf{N} \\times \\mathbf{N}$.',
    '',
    '# 第 143 页',
    '',
    '5.13　另一题',
  ].join('\n');
  const pages = parseFullTextPages(md);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].no, 142);
  assert.ok(pages[0].text.startsWith('5.12'), '去掉粗体记号后题号落回行首');
  assert.equal(pages[1].no, 143);
  assert.ok(pages[1].text.startsWith('5.13'));
});

test('deriveHomeworkLabel：hw2 / 3、4 / 周次：1 都取第一个序号；判不出返回 null', () => {
  assert.equal(deriveHomeworkLabel({ title: 'hw2' }).label, '第02次');
  assert.equal(deriveHomeworkLabel({ title: '3、4' }).label, '第03次');
  assert.equal(deriveHomeworkLabel({ title: '周次： 1' }).label, '第01次');
  assert.equal(deriveHomeworkLabel({ title: '期中成绩' }).label, null);
});

test('subjectDirName：note 里的「工作区目录：物理/」优先，其次课程名/别名', () => {
  const dirs = ['物理', '数据结构'];
  assert.equal(subjectDirName({ name: '大学物理B(2)', note: '工作区目录：物理/' }, dirs).dirName, '物理');
  assert.equal(subjectDirName({ name: '数据结构' }, dirs).dirName, '数据结构');
  assert.equal(subjectDirName({ name: '不存在的课' }, dirs).dirName, null);
});

test('pickTextbookPdf：题号写第3版就取第3版，否则默认第2版', () => {
  const pdfs = [
    { rel: '离散数学.pdf', abs: 'x/离散数学.pdf', name: '离散数学.pdf' },
    { rel: '离散数学_第2版.pdf', abs: 'x/离散数学_第2版.pdf', name: '离散数学_第2版.pdf' },
    { rel: '离散数学_第3版_单页.pdf', abs: 'x/离散数学_第3版_单页.pdf', name: '离散数学_第3版_单页.pdf' },
  ];
  assert.equal(pickTextbookPdf(pdfs, 3).name, '离散数学_第3版_单页.pdf');
  assert.equal(pickTextbookPdf(pdfs, null).name, '离散数学_第2版.pdf');
});

test('sanitizeUntrustedText / safeFileName / resolveAttachmentUrl 的边界', () => {
  assert.ok(sanitizeUntrustedText('a'.repeat(5000), 10).endsWith('已截断）'));
  const unsafe = safeFileName('../../etc/passwd');
  assert.ok(!unsafe.includes('/') && !unsafe.includes('\\'), '文件名里不能留路径分隔符');
  assert.equal(safeFileName('  '), 'file');
  const open = 'https://learn.tsinghua.edu.cn/f/wlxt/kc/wj_wjb/student/openNewWindow?fileId=a&downloadUrl=/b/wlxt/kczy/zy/student/downloadFile/1/a';
  assert.equal(resolveAttachmentUrl(open), 'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/downloadFile/1/a');
  assert.equal(resolveAttachmentUrl('/b/wlxt/x'), 'https://learn.tsinghua.edu.cn/b/wlxt/x');
  assert.equal(resolveAttachmentUrl(''), null);
});

// ─────────────────────────────── 取料主流程 ───────────────────────────────

async function makeWorkspace(options = {}) {
  const root = await makeTempDir('hw-intake-');
  await fs.mkdir(path.join(root, '数据结构', '作业'), { recursive: true });
  await fs.mkdir(path.join(root, '数据结构', '教材', '_OCR'), { recursive: true });
  await fs.writeFile(path.join(root, '数据结构', '教材', '数据结构教材.pdf'), 'dummy', 'utf8');
  await fs.writeFile(
    path.join(root, '数据结构', '教材', '_OCR', '数据结构教材_全文.md'),
    options.fullText ?? '# 第 1 页\n\n目录\n5.12 ………… 46\n\n# 第 100 页\n\n习题 5\n5.12　设 G 是简单图，证明边数不小于顶点数减一。\n',
    'utf8',
  );
  return root;
}

const COURSE = { id: 'c_ds', name: '数据结构', aliases: ['数据结构'], note: '工作区目录：数据结构/' };

function fakeRenderFor(outDir) {
  const made = [];
  return async (pdf, dir, pages, options = {}) => {
    await fs.mkdir(dir, { recursive: true });
    for (const page of pages) {
      const file = path.join(dir, `${options.prefix ?? 'page'}_p${String(page).padStart(2, '0')}.png`);
      await fs.writeFile(file, 'png', 'utf8');
      made.push({ page, path: file });
    }
    return { ok: true, pages, made, error: null };
  };
}

test('形态①（附件）：下载附件、落 md，摘要里写明「已取」', async () => {
  const root = await makeWorkspace();
  try {
    const written = [];
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't1', title: '第03次作业', courseId: 'c_ds', note: '[learn:xszyid:abc]' },
      workspaceRoot: root,
      learnConfig: { cookie: 'JSESSIONID=x', courses: [{ courseId: 'c_ds', wlkcid: 'W1' }] },
      deps: {
        fetchDetail: async () => ({
          ok: true,
          detail: {
            title: 'HW3',
            description: '请完成以下三道题。',
            due: '2026-10-10 23:59',
            url: 'https://learn.tsinghua.edu.cn/x',
            attachments: [{ name: 'HW3.pdf', size: '1.2 MB', href: 'https://learn.tsinghua.edu.cn/f/open?downloadUrl=/b/wlxt/kczy/zy/student/downloadFile/1/a' }],
            answerFiles: [],
          },
        }),
        download: async (url, dest) => {
          written.push(dest);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, 'pdf', 'utf8');
          return { ok: true, bytes: 3, contentType: 'application/pdf', error: null };
        },
        render: async () => ({ ok: true, pages: 1, made: [], error: null }),
      },
    });

    assert.equal(intake.ok, true);
    assert.equal(intake.label, '第03次');
    assert.equal(intake.materials.homework.mode, 'attachment');
    assert.equal(intake.materials.homework.files.length, 1);
    const mdPath = path.join(root, '数据结构', '作业', '第03次_原题与要求.md');
    const md = await fs.readFile(mdPath, 'utf8');
    assert.ok(md.startsWith(INTAKE_MARK));
    assert.ok(md.includes('### 附件（已下载）'));
    assert.ok(md.includes('HW3.pdf'));
    assert.ok(written.every((file) => file.includes('第03次_附件')));
    assert.ok(await fs.stat(path.join(root, '数据结构', '作业', '第03次_附件', 'HW3.pdf')));
    assert.ok(describeIntake(intake).includes('原题与要求：已取'));
  } finally {
    await removeTempDir(root);
  }
});

test('形态②（教材题号）：定位到页、渲染截图，md 里带定位表与置信度', async () => {
  const root = await makeWorkspace();
  try {
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't2', title: '第05次作业', courseId: 'c_ds', note: '[learn:xszyid:abc]' },
      workspaceRoot: root,
      learnConfig: { cookie: 'JSESSIONID=x', courses: [{ courseId: 'c_ds', wlkcid: 'W1' }] },
      deps: {
        fetchDetail: async () => ({
          ok: true,
          detail: { title: '作业5', description: '1. 5.12', due: '', url: '', attachments: [], answerFiles: [] },
        }),
        fetchNotices: async () => ({ ok: true, notices: [], expired: [], total: 0 }),
        render: fakeRenderFor(''),
      },
    });

    assert.equal(intake.ok, true);
    assert.equal(intake.materials.homework.mode, 'textbook');
    assert.equal(intake.materials.homework.refs[0].page, 100);
    assert.equal(intake.materials.homework.refs[0].confidence, 'high');
    assert.equal(intake.materials.homework.shots.length, 1);
    assert.equal(intake.materials.textbook.pdfRel, '教材/数据结构教材.pdf');
    assert.equal(intake.materials.textbook.fullTextRel, '教材/_OCR/数据结构教材_全文.md');

    const md = await fs.readFile(path.join(root, '数据结构', '作业', '第05次_原题与要求.md'), 'utf8');
    assert.ok(md.includes('| 5.12 | 未标版本 | 100 | high |'));
    assert.ok(md.includes('教材_p100.png'));
    assert.ok(md.includes('题号 5.12 所在页取字'));
  } finally {
    await removeTempDir(root);
  }
});

test('形态②（教材题号）：全文放在学科级 _OCR/<版本>/ 子目录时也要找到（离散第3版 _全文OCR.md）', async () => {
  const root = await makeTempDir('hw-intake-dm-');
  try {
    // 教材 PDF 在 教材/，教材/_OCR/ 为空；整本 OCR 在**学科级** 离散数学/_OCR/离散数学_第3版/
    await fs.mkdir(path.join(root, '离散数学', '作业'), { recursive: true });
    await fs.mkdir(path.join(root, '离散数学', '教材', '_OCR'), { recursive: true });
    await fs.writeFile(path.join(root, '离散数学', '教材', '离散数学_第2版.pdf'), 'dummy', 'utf8');
    await fs.writeFile(path.join(root, '离散数学', '教材', '离散数学_第3版_单页.pdf'), 'dummy', 'utf8');
    const ocrDir = path.join(root, '离散数学', '_OCR', '离散数学_第3版');
    await fs.mkdir(ocrDir, { recursive: true });
    await fs.writeFile(
      path.join(ocrDir, '离散数学_第3版_全文OCR.md'),
      [
        '# 离散数学（第 3 版）全文 OCR',
        '',
        '## 第 1 页（PDF 页 1，印刷页 -12）',
        '',
        '目录',
        '5.12 ……………… 46',
        '',
        '## 第 142 页（PDF 页 142，印刷页 129）',
        '',
        '**5.12**　设 $f: \\mathbf{N} \\rightarrow \\mathbf{N} \\times \\mathbf{N}$, $f(n)=\\langle n, n+1 \\rangle$.',
        '',
      ].join('\n'),
      'utf8',
    );

    const course = { id: 'c_dm', name: '离散数学', aliases: ['离散数学'], note: '工作区目录：离散数学/' };
    const intake = await collectHomeworkMaterials({
      course,
      task: { id: 't_dm', title: '第05次作业', courseId: 'c_dm', note: '[learn:xszyid:abc]' },
      workspaceRoot: root,
      learnConfig: { cookie: 'JSESSIONID=x', courses: [{ courseId: 'c_dm', wlkcid: 'W1' }] },
      deps: {
        fetchDetail: async () => ({
          ok: true,
          detail: { title: '作业5', description: '第3版 5.12', due: '', url: '', attachments: [], answerFiles: [] },
        }),
        fetchNotices: async () => ({ ok: true, notices: [], expired: [], total: 0 }),
        render: fakeRenderFor(''),
      },
    });

    assert.equal(intake.ok, true);
    assert.equal(intake.materials.homework.mode, 'textbook');
    assert.equal(intake.materials.textbook.pdfRel, '教材/离散数学_第3版_单页.pdf');
    assert.equal(
      intake.materials.textbook.fullTextRel,
      '_OCR/离散数学_第3版/离散数学_第3版_全文OCR.md',
      '学科级全文的 fullTextRel 应相对学科目录',
    );
    assert.equal(intake.materials.homework.refs[0].page, 142);
    assert.equal(intake.materials.homework.refs[0].confidence, 'high');
    assert.equal(intake.materials.homework.shots.length, 1);

    const md = await fs.readFile(path.join(root, '离散数学', '作业', '第05次_原题与要求.md'), 'utf8');
    assert.ok(md.includes('| 5.12 | 第 3 版 | 142 | high |'));
    assert.ok(md.includes('教材_p142.png'));
    assert.ok(md.includes('取字全文：`_OCR/离散数学_第3版/离散数学_第3版_全文OCR.md`'));
    assert.ok(!md.includes('没有现成全文'), '找到学科级全文后不能再报「没有现成全文」');
    assert.ok(!intake.problems.some((p) => p.includes('没有现成全文')));
  } finally {
    await removeTempDir(root);
  }
});

test('没有 learn 记号：如实报告、落「原题与要求.md」，且不去请求网络', async () => {
  const root = await makeWorkspace();
  try {
    let fetched = 0;
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't3', title: '第01次作业', courseId: 'c_ds', note: '普通备注，没有记号' },
      workspaceRoot: root,
      learnConfig: { cookie: 'JSESSIONID=x', courses: [] },
      deps: { fetchDetail: async () => { fetched += 1; throw new Error('should-not-call'); } },
    });
    assert.equal(fetched, 0);
    assert.equal(intake.ok, false);
    assert.ok(intake.problems.some((p) => p.includes('没有网络学堂记号')));
    const md = await fs.readFile(path.join(root, '数据结构', '作业', '第01次_原题与要求.md'), 'utf8');
    assert.ok(md.includes('**取料失败：**'));
    assert.ok(describeIntake(intake).includes('未取到'));
  } finally {
    await removeTempDir(root);
  }
});

test('作业详情里既没附件也没题面 → mode=unknown，并在待确认里写明', async () => {
  const root = await makeWorkspace();
  try {
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't4', title: '第02次作业', courseId: 'c_ds', note: '[learn:xszyid:abc]' },
      workspaceRoot: root,
      learnConfig: { cookie: 'JSESSIONID=x', courses: [{ courseId: 'c_ds', wlkcid: 'W1' }] },
      deps: { fetchDetail: async () => ({ ok: true, detail: { title: '作业2', description: '', attachments: [], answerFiles: [] } }) },
    });
    assert.equal(intake.materials.homework.mode, 'unknown');
    assert.ok(intake.problems.some((p) => p.includes('原题来源不明')));
  } finally {
    await removeTempDir(root);
  }
});

test('次号判不出：不硬编第NN次，落「取料_<标题>…」并提醒需用户指明', async () => {
  const root = await makeWorkspace();
  try {
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't5', title: '期中成绩', courseId: 'c_ds', note: '[learn:xszyid:abc]' },
      workspaceRoot: root,
      learnConfig: { cookie: '', courses: [] },
      deps: { fetchDetail: async () => ({ ok: false, error: 'cookie-invalid' }) },
    });
    assert.equal(intake.label, null);
    assert.ok(intake.problems.some((p) => p.includes('判断不出第几次')));
    assert.ok(intake.materials.homework.mdRel.includes('取料_期中成绩'));
  } finally {
    await removeTempDir(root);
  }
});

test('已存在的同名 md 若不是本模块写的，绝不覆盖，另存带时间戳副本', async () => {
  const root = await makeWorkspace();
  try {
    const dir = path.join(root, '数据结构', '作业');
    await fs.writeFile(path.join(dir, '第03次_原题与要求.md'), '用户手写的内容', 'utf8');
    const intake = await collectHomeworkMaterials({
      course: COURSE,
      task: { id: 't6', title: '第03次作业', courseId: 'c_ds', note: '没有记号' },
      workspaceRoot: root,
      learnConfig: { cookie: '' },
      deps: {},
    });
    assert.ok(intake.materials.homework.mdRel.includes('取料'));
    assert.ok(intake.problems.some((p) => p.includes('另存')));
    assert.equal(await fs.readFile(path.join(dir, '第03次_原题与要求.md'), 'utf8'), '用户手写的内容');
  } finally {
    await removeTempDir(root);
  }
});

test('buildMaterialsMarkdown：缺教材/缺公告也照实写进报告', () => {
  const md = buildMaterialsMarkdown({
    label: '第03次',
    courseName: '数据结构',
    taskTitle: 'HW3',
    homework: { ok: false, reason: '网络学堂未连接' },
    textbook: { ok: false, reason: '教材目录为空或不存在' },
    notice: { ok: false, reason: '缺 wlkcid，未取课程公告' },
    problems: ['网络学堂未连接'],
  });
  assert.ok(md.includes(INTAKE_MARK));
  assert.ok(md.includes('网络学堂未连接'));
  assert.ok(md.includes('教材目录为空或不存在'));
  assert.ok(md.includes('缺 wlkcid，未取课程公告'));
});

// ─────────────────────────────── HTTP 接线 ───────────────────────────────

async function startServer(options = {}) {
  const dir = await makeTempDir('study-assistant-materials-');
  const store = createStore(dir);
  await store.init();
  const handler = createApiHandler({ store, dataDir: dir, backupKeep: 3, logger: { error() {} }, ...options });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    store,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await removeTempDir(dir);
    },
  };
}

function jsonRequest(url, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withHeader !== false) headers[REQUEST_HEADER] = '1';
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function seed(store) {
  await store.writeDocument('courses', {
    version: 1,
    courses: [{ id: 'c_ds', name: '数据结构', aliases: ['数据结构'], note: '工作区目录：数据结构/' }],
    updatedAt: new Date().toISOString(),
  });
  await store.writeDocument('tasks', {
    version: 1,
    tasks: [
      { id: 't_ds_1', title: '第03次作业', courseId: 'c_ds', kind: 'homework', due: '2026-10-10', status: 'open', note: '[learn:xszyid:abc]' },
      { id: 't_orphan', title: '没有课程', courseId: null, kind: 'homework', status: 'open' },
    ],
    updatedAt: new Date().toISOString(),
  });
}

const INTAKE_FIXTURE = {
  ok: true,
  label: '第03次',
  seq: 3,
  courseName: '数据结构',
  subjectDir: '数据结构',
  taskTitle: '第03次作业',
  materials: {
    homework: {
      ok: true,
      mode: 'attachment',
      mdRel: '作业/第03次_原题与要求.md',
      attachRel: '作业/第03次_附件',
      shotRel: '作业/第03次_截图',
      files: [{ name: 'HW3.pdf', rel: '作业/第03次_附件/HW3.pdf', bytes: 3 }],
      shots: [{ rel: '作业/第03次_截图/附件_HW3_p01.png', page: 1 }],
    },
    textbook: { ok: true, dir: '教材/', files: [{ rel: '数据结构教材.pdf' }] },
    notice: { ok: true, count: 2, rel: '作业/第03次_公告.md' },
  },
  writtenFiles: ['C:/tmp/a.md'],
  problems: [],
};

test('collect-materials：缺自定义头 → 403', async () => {
  const server = await startServer({ homeworkIntake: async () => INTAKE_FIXTURE });
  try {
    await seed(server.store);
    const res = await jsonRequest(`${server.baseUrl}/homework/collect-materials`, { taskId: 't_ds_1' }, { withHeader: false });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('collect-materials：缺 taskId / 任务不存在 / 课程不存在 各自的错误码', async () => {
  const server = await startServer({ homeworkIntake: async () => INTAKE_FIXTURE });
  try {
    await seed(server.store);
    const missing = await jsonRequest(`${server.baseUrl}/homework/collect-materials`, {});
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'missing-task');

    const unknown = await jsonRequest(`${server.baseUrl}/homework/collect-materials`, { taskId: 't_nope' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown-task');

    const orphan = await jsonRequest(`${server.baseUrl}/homework/collect-materials`, { taskId: 't_orphan' });
    assert.equal(orphan.status, 409);
    assert.equal((await orphan.json()).error, 'course-not-found');
  } finally {
    await server.close();
  }
});

test('collect-materials：正常返回取料结构', async () => {
  const calls = [];
  const server = await startServer({
    homeworkIntake: async (input) => { calls.push(input); return INTAKE_FIXTURE; },
  });
  try {
    await seed(server.store);
    const res = await jsonRequest(`${server.baseUrl}/homework/collect-materials`, { taskId: 't_ds_1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.intake.label, '第03次');
    assert.equal(body.intake.materials.homework.mode, 'attachment');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].course.id, 'c_ds');
    assert.equal(calls[0].task.id, 't_ds_1');
  } finally {
    await server.close();
  }
});

test('spawn：固定指令里带取料结果与缺料停下的纪律', async () => {
  const calls = [];
  const server = await startServer({
    homeworkIntake: async () => INTAKE_FIXTURE,
    handoff: async (input) => { calls.push(input); return { ok: true, sessionId: 'sess-1' }; },
  });
  try {
    await seed(server.store);
    const res = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.intake.label, '第03次');

    assert.equal(calls.length, 1);
    const prompt = calls[0].prompt;
    assert.ok(prompt.includes('后端已经先从网络学堂取料并落成本地文件'));
    assert.ok(prompt.includes('原题与要求：已取'), 'prompt 要带取料摘要');
    assert.ok(prompt.includes('课程公告：已取 2 条'));
    assert.ok(prompt.includes('**如实告诉用户缺什么并停下来等**'));
    assert.ok(prompt.includes('题目截图（硬要求，每题都要有）'));
    assert.ok(prompt.includes('此题无 PDF 来源，无截图'));
    assert.ok(prompt.includes('不要拿「学堂公告」冒充课程公告'));
  } finally {
    await server.close();
  }
});

test('spawn：取料失败（未取到）也要把「缺什么」写进 prompt', async () => {
  const server = await startServer({
    homeworkIntake: async () => ({
      ok: false,
      label: null,
      subjectDir: null,
      materials: {
        homework: { ok: false, mode: 'unknown', reason: '网络学堂未连接（没有 Cookie），无法取作业详情' },
        textbook: { ok: false, reason: '教材目录为空或不存在' },
        notice: { ok: false, reason: '缺 wlkcid，未取课程公告' },
      },
      writtenFiles: [],
      problems: ['网络学堂未连接（没有 Cookie），无法取作业详情'],
    }),
    handoff: async () => ({ ok: true, sessionId: 'sess-2' }),
  });
  try {
    await seed(server.store);
    const res = await jsonRequest(`${server.baseUrl}/homework/spawn`, { taskId: 't_ds_1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.intake.ok, false);
    assert.ok(body.intake.problems.length >= 1);
  } finally {
    await server.close();
  }
});
