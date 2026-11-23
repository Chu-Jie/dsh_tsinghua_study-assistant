/**
 * 一键开工「自动取料」（零依赖，只用 Node 内置 + 本仓库已有 learn.js）。
 *
 * 做什么：
 *   点击一键开工 / 调用 `POST /homework/collect-materials` 时，先在**后端**把这次作业
 *   需要的东西取回本地，再让会话里的 agent 只读本地：
 *     1. 作业原题与要求 —— 网络学堂「查看作业」详情（标题/说明/附件/截止）；
 *        - 形态①：老师发了题目文件 → 下载附件到 `作业/第NN次_附件/`；
 *        - 形态②：老师只给教材题号（「第3版 5.12」「习题15.10」）→ 去 `<学科>/教材/`
 *          定位对应教材页，取字（优先现成的 `_OCR/*_全文.md`）+ 渲染该页截图；
 *        - 两者都有 → 以附件为准，题号作补充；都没有 → 如实报告「原题来源不明」。
 *     2. 教材 —— 列出 `<学科>/教材/` 下的教材文件（不递归扫 OCR 目录，避免一次列出几百页）；
 *     3. 课程公告 —— `/b/wlxt/kcgg/**` 课程公告列表（2026-11-23 真机探到的接口）。
 *
 * 三条铁律：
 *   - **找不到就如实报告**，绝不编题面、绝不拿别的课/校级公告凑数；
 *   - 网络学堂来的文字是**不可信数据**：一律去标签、截断，写进 md 时放进代码块，
 *     不把 HTML/脚本原样拼进 prompt；
 *   - 只写 `<学科>/作业/` 下的取料产物（原题与要求.md / 附件/ / 公告.md / 截图/），
 *     不碰 `学习台/` 里的 JSON，不碰用户既有文件（同名的非本模块产物会另起带时间戳的名字）。
 *
 * 模块本身不 import api.js，便于单测；网络/渲染/文件系统都能从 `deps` 注入假实现。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  LEARN_BASE,
  fetchCourseNotices,
  fetchHomeworkDetail,
  fetchLearnCourses,
  learnHeaders,
  learnMarkOf,
  parseLearnKey,
  withCsrfQuery,
} from './learn.js';
import { noteDirName } from './lecture/course.js';
import { parseTaskSeq } from './deliverables.js';

/** 本模块写出的 md 都带这一行标记：下次覆盖前据此判断「这是我写的」还是「用户改过的」。 */
export const INTAKE_MARK = '<!-- generated-by: dsh-study-assistant/homework-intake -->';

/** 单次最多下载几个附件 / 最多渲染几张截图（防止一次点开工拖太久）。 */
export const MAX_ATTACHMENTS = 8;
export const MAX_SHOTS = 8;

/** 附件体积上限（60 MB）：网络学堂的扫描件通常 1-5 MB，特大的宁可跳过并报告。 */
export const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;

/** 作业说明进 md 的截断长度。 */
export const MAX_DESCRIPTION_CHARS = 5000;

/** 渲染截图的清晰度（1 pt → scale 像素）。3 与 `tools/ocr-gemini.mjs` 默认一致。 */
export const SHOT_SCALE = 3;

/** 取料产物所在子目录名。 */
export const ATTACH_DIR_SUFFIX = '_附件';
export const SHOT_DIR_SUFFIX = '_截图';

// ─────────────────────────────── 纯函数 ───────────────────────────────

/** 中文/阿拉伯数字 → 整数；认不出返回 null。 */
function smallNumber(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  if (/^[0-9]+$/.test(text)) return Number(text);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === '十') {
      if (current === 0) current = 1;
      total += current * 10;
      current = 0;
      continue;
    }
    if (ch === '百') {
      if (current === 0) current = 1;
      total += current * 100;
      current = 0;
      continue;
    }
    const digit = digits[ch];
    if (digit === undefined) return null;
    current = current === 0 ? digit : current * 10 + digit;
  }
  return total + current;
}

/** 把一段外部文本清成「可安全写进 md / prompt」的纯文本：去控制字符、压空白、截断。 */
export function sanitizeUntrustedText(value, maxChars = MAX_DESCRIPTION_CHARS) {
  const text = String(value ?? '')
    // 控制字符（保留换行/制表）与零宽字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limited = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_DESCRIPTION_CHARS;
  return text.length > limited ? `${text.slice(0, limited)}\n…（原文过长，已截断）` : text;
}

/** 文件名安全化：去路径分隔符与 Windows 非法字符，限长。 */
export function safeFileName(name, fallback = 'file') {
  const base = String(name ?? '').replace(/^[.]+/, '').trim();
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[ \t]+/g, ' ')
    .replace(/_+/g, '_')
    .trim();
  const out = cleaned === '' || cleaned === '.' ? fallback : cleaned;
  return out.length > 80 ? out.slice(0, 80) : out;
}

/**
 * 从任务标题推「第几」次。
 *
 * 真机上标题五花八门：`hw2` / `第二周作业` / `3、4` / `周次： 1` / `2`。
 * `parseTaskSeq` 已经处理了这些写法；这里只取**第一个**序号作为交付目录的次号，
 * 并明确记一句说明 —— 「3、4」这种多半是两章一起交，按第 3 次归档是用户的既有习惯
 * （提交件叫「物理第三次作业」），但次号判断不了时绝不硬编。
 *
 * @returns {{seq:number|null, label:string|null, note:string}}
 */
export function deriveHomeworkLabel(task) {
  const title = typeof task?.title === 'string' ? task.title : '';
  const seqs = parseTaskSeq(title);
  if (Array.isArray(seqs) && seqs.length > 0 && Number.isFinite(seqs[0])) {
    const seq = seqs[0];
    return {
      seq,
      label: `第${String(seq).padStart(2, '0')}次`,
      note: seqs.length > 1 ? `题目标题为「${title}」，含多个序号（${seqs.join('、')}），按第 ${seq} 次归档。` : '',
    };
  }
  const direct = /第\s*([0-9]{1,2})\s*次/.exec(title);
  if (direct !== null) {
    const seq = Number(direct[1]);
    return { seq, label: `第${String(seq).padStart(2, '0')}次`, note: '' };
  }
  return { seq: null, label: null, note: `题目标题「${title}」里判断不出第几次，需用户指明。` };
}

/**
 * 课程 → 工作区目录名（纯函数）。
 *
 * 依据 `课程.json` 的 `note`（「工作区目录：物理/」）优先，其次课程名、别名。
 * 都不中返回 null —— 绝不在用户目录里凭空建课程文件夹。
 */
export function subjectDirName(course, dirNames) {
  const dirs = Array.isArray(dirNames) ? dirNames : [];
  const has = (name) => typeof name === 'string' && name !== '' && dirs.includes(name);
  const fromNote = noteDirName(course?.note);
  if (has(fromNote)) return { dirName: fromNote, via: 'note' };
  if (has(course?.name)) return { dirName: course.name, via: 'name' };
  const aliases = Array.isArray(course?.aliases) ? course.aliases : [];
  for (const alias of aliases) {
    if (has(alias)) return { dirName: alias, via: 'alias' };
  }
  return { dirName: null, via: '' };
}

/**
 * 从作业说明里解析「教材题号」。
 *
 * 支持的写法（真机出现过的都在内）：
 *   - `第3版 5.12` / `第 2 版习题 15.10` → 版本 + 章.题
 *   - `习题15.10` / `习题 15.10` / `15.10` / `14.2`
 *   - `第15章第10题` / `第 10 题`
 *   - `P123 第5题` / `P123页` → 页码线索
 *
 * 只抽题号线索，不猜题意；解析不到就返回空。
 *
 * @returns {{version:number|null, refs:Array<{chapter:number|null,exercise:number|null,page:number|null,raw:string}>}}
 */
export function parseTextbookRefs(value) {
  const text = String(value ?? '');
  const versionMatch = /第\s*([0-9一二三四五六七八九十]+)\s*版/.exec(text);
  const version = versionMatch === null ? null : smallNumber(versionMatch[1]);
  const refs = [];
  const seen = new Set();
  const push = (ref, raw) => {
    const key = `${ref.chapter ?? '-'}|${ref.exercise ?? '-'}|${ref.page ?? '-'}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ...ref, raw: raw.trim().slice(0, 40) });
  };

  // ① 章.题（最可靠）。注意点号后**不能有空格**：题号写成「14.2」，
  //    而「1. 14.2」里的「1.」是列表编号，不能把 14 吃掉变成「1.14」。
  for (const match of text.matchAll(/([0-9]{1,2})\s*[\.．]([0-9]{1,3})(?![0-9])/g)) {
    const chapter = Number(match[1]);
    const exercise = Number(match[2]);
    if (chapter <= 0 || exercise <= 0) continue;
    push({ chapter, exercise, page: null }, match[0]);
  }
  // ② 第X章 第Y题
  for (const match of text.matchAll(/第\s*([0-9一二三四五六七八九十]+)\s*章\s*(?:的)?\s*第?\s*([0-9一二三四五六七八九十]+)\s*题/g)) {
    push({ chapter: smallNumber(match[1]), exercise: smallNumber(match[2]), page: null }, match[0]);
  }
  // ③ 只有「第Y题」（没有章）
  for (const match of text.matchAll(/第\s*([0-9]{1,3})\s*题/g)) {
    push({ chapter: null, exercise: Number(match[1]), page: null }, match[0]);
  }
  // ④ 页码线索
  for (const match of text.matchAll(/[Pp]\s*\.?\s*([0-9]{1,4})\s*页?/g)) {
    const page = Number(match[1]);
    if (page > 0) push({ chapter: null, exercise: null, page }, match[0]);
  }

  // 只保留「有章有题 / 有题 / 有页」的，最多 12 条
  return { version, refs: refs.slice(0, 12) };
}

/** 去掉题号/编号/标点后还剩多少「有意义」的字 —— 用来判「说明里只有题号」。 */
function residualTextLength(text) {
  return String(text ?? '')
    .replace(/[0-9]{1,2}\s*[\.．\-、]\s*[0-9]{1,3}/g, ' ')
    .replace(/第\s*[0-9一二三四五六七八九十]+\s*[版章节题次]/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[、,，;；:：\.．\-\(\)（）\s]/g, '')
    .length;
}

/**
 * 判作业原题的形态（纯函数）。
 *
 * - `attachment`：有附件（老师直接发题目文件）；若说明里同时有教材题号，`textbookSupplement=true`；
 * - `textbook`：没附件，说明里只有教材题号（「1. 14.2 2. 14.4 …」这类）；
 * - `text`：没附件，说明里有成段题面文字（老师把题目写在说明里）；
 * - `unknown`：两者都没有 —— 必须停下问用户。
 *
 * @param {{attachments?:Array, description?:string|null}} detail
 * @returns {{mode:'attachment'|'textbook'|'text'|'unknown', refs:Array, version:number|null, textbookSupplement:boolean}}
 */
export function classifyHomeworkSource(detail) {
  const description = typeof detail?.description === 'string' ? detail.description : '';
  const attachments = Array.isArray(detail?.attachments) ? detail.attachments : [];
  const parsed = parseTextbookRefs(description);
  const residual = residualTextLength(description);
  const hasRefs = parsed.refs.length > 0;
  if (attachments.length > 0) {
    return { mode: 'attachment', refs: parsed.refs, version: parsed.version, textbookSupplement: hasRefs };
  }
  if (hasRefs && residual <= 12) {
    return { mode: 'textbook', refs: parsed.refs, version: parsed.version, textbookSupplement: false };
  }
  if (description.trim() !== '' && residual >= 10) {
    return { mode: 'text', refs: parsed.refs, version: parsed.version, textbookSupplement: false };
  }
  if (hasRefs) return { mode: 'textbook', refs: parsed.refs, version: parsed.version, textbookSupplement: false };
  return { mode: 'unknown', refs: [], version: parsed.version, textbookSupplement: false };
}

/**
 * 把 `_OCR/*_全文.md` 拆成「页号 → 文本」。
 *
 * 现成取字文件的格式是 `# 第 N 页` 一段一段（`tools/ocr-text` 与既有教材 OCR 都是这套）；
 * 整本视觉 OCR 写成 `## 第 N 页（PDF 页 N，印刷页 N-13）` 也照样认（标题级别与括注不敏感）。
 * 页号等于 PDF 物理页号，可以直接拿去渲染截图。格式不符就返回空数组（上层如实报告）。
 *
 * @param {string} markdown
 * @returns {Array<{no:number,text:string}>}
 */
export function parseFullTextPages(markdown) {
  const text = String(markdown ?? '');
  const pages = [];
  const pattern = /^#{1,6}\s*第\s*([0-9]+)\s*页\s*(?:[（(][^\n]*[）)])?\s*$/gm;
  const marks = [...text.matchAll(pattern)];
  for (let i = 0; i < marks.length; i += 1) {
    const no = Number(marks[i][1]);
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    // 视觉 OCR 把题号加粗成 `**5.12**`，去掉粗体记号，题号才落回行首。
    pages.push({ no, text: text.slice(start, end).trim().replace(/\*\*/g, '') });
  }
  return pages;
}

/** 目录/行是否像「目录页」（题号后面跟着一串点或页码）。 */
function looksLikeTocLine(line) {
  return /(?:…{2,}|\.{4,}|\s{3,}[0-9]{1,3}\s*$)/.test(line);
}

/**
 * 在教材全文里定位一道题（纯函数）。
 *
 * 三级置信度：
 *   - `high`：正文里出现以 `章.题` 开头的行（排除目录页的点线行）；
 *   - `medium`：找到该章「习题」段，再在随后几页里找到以 `题号.` 开头的行；
 *   - `low`：只找到该章「习题」段，页码需人工核对（附整段页截图，不硬凑）。
 *
 * @param {Array<{no:number,text:string}>} pages
 * @param {{chapter:number|null,exercise:number|null,page:number|null}} ref
 * @returns {{page:number|null,pages:number[],confidence:'high'|'medium'|'low'|'',snippet:string}}
 */
export function locateExercise(pages, ref) {
  const list = Array.isArray(pages) ? pages : [];
  const chapter = Number.isFinite(ref?.chapter) ? ref.chapter : null;
  const exercise = Number.isFinite(ref?.exercise) ? ref.exercise : null;
  const explicitPage = Number.isFinite(ref?.page) ? ref.page : null;

  const snippetOf = (page, token) => {
    const text = String(page?.text ?? '');
    const at = token === '' ? 0 : Math.max(0, text.indexOf(token));
    return sanitizeUntrustedText(text.slice(at, at + 600), 600);
  };

  if (explicitPage !== null) {
    const page = list.find((item) => item.no === explicitPage) ?? null;
    return { page: explicitPage, pages: [explicitPage], confidence: 'high', snippet: snippetOf(page, '') };
  }

  /**
   * 找「习题段」：标题行可能是 `习题 15`（离散）、`习    题    15`（OCR 空格）、
   * 也可能只是 `习题`（物理，章号靠题目本身的 `22.13` 看出来）。
   * 所以：先读标题里的章号；读不到就从标题后第一道编号题反推章号（`22.13` → 章 22）。
   */
  const sections = [];
  for (let i = 0; i < list.length; i += 1) {
    const page = list[i];
    const heading = /^\s*习\s*题\s*([0-9]{1,2})?\s*$/m.exec(String(page.text));
    if (heading === null) continue;
    let sectionChapter = heading[1] === undefined || heading[1] === '' ? null : Number(heading[1]);
    if (sectionChapter === null) {
      for (const probe of list.slice(i, i + 3)) {
        const item = /^\s*0*([0-9]{1,2})\s*[.．]\s*0*([0-9]{1,3})(?![0-9])/m.exec(String(probe.text));
        if (item !== null) {
          sectionChapter = Number(item[1]);
          break;
        }
      }
    }
    sections.push({ page: page.no, chapter: sectionChapter, at: i });
  }

  const matchedSections = chapter === null ? sections : sections.filter((section) => section.chapter === chapter);

  // 1) 优先按「该章习题段里的第几题」找 —— 离散/物理这类教材的题号常是段内 1、2、3…
  //    （「15.10」指习题 15 的第 10 题，正文并不写 15.10；只认 `章.题` 会误中「图 15.12」这种）
  if (matchedSections.length > 0 && exercise !== null) {
    const section = matchedSections[0];
    const candidates = list.slice(section.at, section.at + 4);
    const chapterToken = chapter === null ? null : `${chapter}.${exercise}`;
    for (const page of candidates) {
      for (const line of String(page.text).split('\n')) {
        const trimmed = line.trim();
        const plain = new RegExp(`^0*${exercise}\\s*[\\.．、]`).test(trimmed);
        const withChapter = chapterToken !== null && new RegExp(`^0*${chapter}\\s*[.．]\\s*0*${exercise}(?![0-9])`).test(trimmed);
        if (!plain && !withChapter) continue;
        if (looksLikeTocLine(trimmed)) continue;
        return { page: page.no, pages: [page.no], confidence: 'high', snippet: snippetOf(page, trimmed.slice(0, 8)) };
      }
    }
  }

  // 2) 正文里出现 `章.题` 行（不是目录点线、也不是「图/例 章.题」这种引用）
  if (chapter !== null && exercise !== null) {
    const token = `${chapter}.${exercise}`;
    const bodyHits = [];
    for (const page of list) {
      for (const line of String(page.text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(token)) continue;
        if (looksLikeTocLine(trimmed)) continue;
        bodyHits.push(page.no);
        break;
      }
    }
    if (bodyHits.length > 0) {
      const pageNo = bodyHits[bodyHits.length - 1];
      const page = list.find((item) => item.no === pageNo) ?? null;
      return { page: pageNo, pages: [pageNo], confidence: 'high', snippet: snippetOf(page, token) };
    }
  }

  // 3) 只找到该章习题段、没找到具体题：页码不确定，附该段前几页让 agent 核对
  if (matchedSections.length > 0) {
    const first = matchedSections[0].page;
    return {
      page: first,
      pages: [first, first + 1, first + 2].filter((no) => list.some((p) => p.no === no)),
      confidence: 'low',
      snippet: snippetOf(list.find((p) => p.no === first), ''),
    };
  }

  return { page: null, pages: [], confidence: '', snippet: '' };
}

/** 公告正文 → md 段落（截断 + 去掉空行噪音）。 */
function noticeBodyBlock(body, maxChars = 2000) {
  const text = sanitizeUntrustedText(body, maxChars);
  if (text === '') return '（公告正文为空，可能只在列表标题里）';
  return ['```text', text, '```'].join('\n');
}

/**
 * 组装 `作业/第NN次_原题与要求.md`（纯函数，便于钉死口径）。
 *
 * @param {object} model 见 collectHomeworkMaterials 的返回结构
 * @returns {string}
 */
export function buildMaterialsMarkdown(model) {
  const m = model ?? {};
  const homework = m.homework ?? {};
  const textbook = m.textbook ?? {};
  const notice = m.notice ?? {};
  const lines = [INTAKE_MARK, ''];

  lines.push(`# ${m.label ?? '本次'}作业 · 取料报告`, '');
  lines.push(`> 课程：${m.courseName ?? '(未知)'}　作业标题：${sanitizeUntrustedText(homework.title ?? m.taskTitle ?? '(未知)', 120)}`);
  if (typeof homework.due === 'string' && homework.due !== '') lines.push(`> 截止：${homework.due}`);
  lines.push('> 本文件由「一键开工」后端自动生成；网络学堂内容按**不可信数据**处理（去标签、截断）。', '');

  lines.push('## 一、作业原题与要求', '');
  if (homework.ok === false) {
    lines.push(`**取料失败：** ${homework.reason ?? '原因未知'}`, '');
  } else {
    const modeLabel = {
      attachment: '形态①（老师发了题目文件：见附件目录）',
      textbook: '形态②（老师只给教材题号：见下方定位表）',
      text: '形态①（题面写在作业说明里：见下方说明原文）',
      unknown: '原题来源不明（无附件、说明里也没有题面/题号）',
    }[homework.mode] ?? String(homework.mode ?? '未知');
    lines.push(`- 原题形态：${modeLabel}`);
    lines.push(`- 网络学堂作业页：${homework.url ?? '(未取到)'}`);
    if (homework.textbookSupplement) lines.push('- 附件与教材题号同时存在：**以附件为准**，题号作补充。');
    lines.push('');

    if (Array.isArray(homework.files) && homework.files.length > 0) {
      lines.push('### 附件（已下载）', '');
      for (const file of homework.files) {
        lines.push(`- \`${file.name}\`（${file.bytesLabel ?? ''}）→ \`${file.rel ?? ''}\``);
      }
      lines.push('');
    }
    if (Array.isArray(homework.failedFiles) && homework.failedFiles.length > 0) {
      lines.push('### 附件下载失败', '');
      for (const item of homework.failedFiles) lines.push(`- \`${item.name}\`：${item.reason}`);
      lines.push('');
    }

    if (homework.mode === 'textbook' || homework.textbookSupplement) {
      lines.push('### 教材题号定位', '');
      if (Array.isArray(homework.refs) && homework.refs.length > 0) {
        lines.push('| 题号 | 教材版本 | PDF 物理页 | 置信度 | 截图 |');
        lines.push('|---|---|---|---|---|');
        for (const ref of homework.refs) {
          const token = ref.chapter !== null && ref.exercise !== null ? `${ref.chapter}.${ref.exercise}` : (ref.raw ?? '?');
          const shot = Array.isArray(ref.shots) && ref.shots.length > 0 ? ref.shots.map((s) => `\`${s.rel}\``).join('、') : '无';
          lines.push(`| ${token} | ${ref.versionLabel ?? '—'} | ${ref.page ?? '未定位'} | ${ref.confidence || '—'} | ${shot} |`);
        }
        lines.push('');
        const lowCount = homework.refs.filter((ref) => ref.confidence === 'low').length;
        if (lowCount > 0) {
          lines.push(`> 有 ${lowCount} 条题号只定位到「该章习题段」、页码不确定：请对照书上习题核对后再截图/作答，不要照抄页码。`, '');
        }
      } else {
        lines.push('说明里有「教材/习题」字样但解析不出题号 —— 请用户指明具体题号。', '');
      }
      if (Array.isArray(homework.refTexts) && homework.refTexts.length > 0) {
        for (const item of homework.refTexts) {
          const tokens = Array.isArray(item.tokens) && item.tokens.length > 0 ? item.tokens.join('、') : (item.token ?? '?');
          lines.push(`#### 题号 ${tokens} 所在页取字（${item.page ?? '页码未知'}，置信度 ${item.confidence || '—'}）`, '');
          lines.push('```text', item.snippet, '```', '');
        }
      }
    }

    if (typeof homework.description === 'string' && homework.description !== '') {
      lines.push('### 作业说明原文（不可信数据，已去标签并截断）', '');
      lines.push('```text', homework.description, '```', '');
    }
  }

  lines.push('## 二、教材', '');
  if (textbook.ok === true) {
    lines.push(`教材目录：\`${textbook.dir ?? ''}\``, '');
    for (const file of textbook.files ?? []) lines.push(`- ${file.rel}${file.note ? `（${file.note}）` : ''}`);
    lines.push('');
    if (textbook.pdf !== null && textbook.pdf !== undefined) lines.push(`- 形态②定位所用教材：\`${textbook.pdfRel}\``);
    if (textbook.fullText !== null && textbook.fullText !== undefined) lines.push(`- 取字全文：\`${textbook.fullTextRel}\``);
    lines.push('');
  } else {
    lines.push(`**教材：** ${textbook.reason ?? '未找到'}`, '');
  }

  lines.push('## 三、课程公告', '');
  if (notice.ok === true) {
    lines.push(`${notice.count} 条，已落 \`${notice.rel ?? ''}\`；未取到的公告不影响作答。`, '');
  } else {
    lines.push(`**课程公告：** ${notice.reason ?? '未取到'}`, '');
  }

  if (Array.isArray(m.problems) && m.problems.length > 0) {
    lines.push('## 四、缺失与待确认', '');
    for (const problem of m.problems) lines.push(`- ${problem}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 把取料结果压成给 prompt 的几行摘要（纯函数）。
 */
export function describeIntake(intake) {
  const m = intake?.materials ?? {};
  const out = [];
  const homework = m.homework ?? {};
  if (homework.ok === true) {
    const files = Array.isArray(homework.files) && homework.files.length > 0
      ? `附件 ${homework.files.length} 个 → \`${homework.attachRel}\``
      : '无附件';
    const shots = Array.isArray(homework.shots) && homework.shots.length > 0
      ? `题目/教材页截图 ${homework.shots.length} 张 → \`${homework.shotRel}\``
      : '无截图';
    out.push(`- 原题与要求：已取（${homework.mode}）；${files}；${shots}；见 \`${homework.mdRel}\``);
  } else {
    out.push(`- 原题与要求：**未取到** —— ${homework.reason ?? '原因未知'}`);
  }
  const textbook = m.textbook ?? {};
  if (textbook.ok === true) {
    out.push(`- 教材：\`${textbook.dir}\`（${(textbook.files ?? []).length} 个条目）`);
  } else {
    out.push(`- 教材：**未找到** —— ${textbook.reason ?? '原因未知'}`);
  }
  const notice = m.notice ?? {};
  if (notice.ok === true) out.push(`- 课程公告：已取 ${notice.count} 条 → \`${notice.rel}\``);
  else out.push(`- 课程公告：**未取到** —— ${notice.reason ?? '原因未知'}（不阻塞作答）`);
  if (Array.isArray(intake?.problems) && intake.problems.length > 0) {
    out.push(`- 待确认：${intake.problems.length} 项（详见 \`${homework.mdRel ?? '取料报告'}\`）`);
  }
  return out.join('\n');
}

// ─────────────────────────────── IO：文件与渲染 ───────────────────────────────

async function readDirSafe(dir, options) {
  try {
    return await fs.readdir(dir, options);
  } catch {
    return [];
  }
}

async function statSafe(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/** 工作区根下看起来像「学科目录」的目录名（与 deliverables.js 的口径一致）。 */
async function listSubjectDirs(workspaceRoot) {
  const entries = await readDirSafe(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'node_modules' && name !== '.git' && !name.startsWith('_') && !name.startsWith('.'));
}

const TEXTBOOK_DIR = '教材';
const HOMEWORK_DIR = '作业';

/**
 * 列教材目录（只列两层：顶层文件 + 一级子目录的条目数/样例 PDF）。
 *
 * 刻意**不递归**：物理/教材/_OCR 下有 450+ 个 pageXXXX.md，一次列进 md 既没用又慢；
 * 而教材 PDF 经常放在 `教材/教材/xxx.pdf` 这类一层子目录里，所以再往下一层找 PDF。
 */
export async function listTextbookFiles(textbookDir, options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 40;
  const entries = await readDirSafe(textbookDir, { withFileTypes: true });
  if (entries.length === 0) return { ok: false, files: [], reason: '教材目录为空或不存在' };
  const files = [];
  const pdfs = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const size = (await statSafe(path.join(textbookDir, entry.name)))?.size ?? 0;
      files.push({ rel: entry.name, size, note: /\.pdf$/i.test(entry.name) ? 'PDF 教材' : '' });
      if (/\.pdf$/i.test(entry.name)) pdfs.push({ rel: entry.name, abs: path.join(textbookDir, entry.name), name: entry.name, size });
    }
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_OCR') continue;
    const sub = path.join(textbookDir, entry.name);
    const inner = await readDirSafe(sub, { withFileTypes: true });
    if (inner.length === 0) continue;
    const innerFiles = inner.filter((item) => item.isFile());
    const sample = innerFiles.slice(0, 3).map((item) => item.name).join('、');
    files.push({ rel: `${entry.name}/`, size: 0, note: `${inner.length} 个条目${sample === '' ? '' : `：${sample}`}` });
    for (const item of innerFiles) {
      if (!/\.pdf$/i.test(item.name)) continue;
      const size = (await statSafe(path.join(sub, item.name)))?.size ?? 0;
      pdfs.push({ rel: `${entry.name}/${item.name}`, abs: path.join(sub, item.name), name: item.name, size });
    }
  }
  return { ok: files.length > 0, files: files.slice(0, maxFiles), pdfs, reason: files.length > 0 ? null : '教材目录为空' };
}

/**
 * 挑形态②要用的教材 PDF（纯选择逻辑 + 传进来的清单）。
 *
 * 真机教训（物理）：`物理/教材/` 下既有 `ppt/12. 静电场.pdf`（课件），
 * 又有 `教材/大学物理学下.pdf`（真教材）。若只按「第一个没标版本的 PDF」取，
 * 会拿 20 页的课件去翻 239 页的习题 —— 页码全废。所以先**排除课件/幻灯目录**，
 * 再在剩下的里按「名字像教材」+ 体积排序。
 *
 * 离散数学有三本：题号写明「第3版」就取第 3 版，否则默认第 2 版。
 */
export function pickTextbookPdf(pdfs, version) {
  const list = Array.isArray(pdfs) ? pdfs : [];
  if (list.length === 0) return null;

  const isSlide = (item) => /(^|\/)(ppt|课件|slides?|lecture)(\/|$)/i.test(String(item.rel ?? ''))
    || /课件|幻灯|讲义|slide/i.test(String(item.name ?? ''));
  const isTextbook = (item) => /教材|课本|教科书/.test(String(item.rel ?? ''))
    || /教材|课本|教科书|大学物理|离散数学|数据结构|数字电子技术|物理学/.test(String(item.name ?? ''));

  const nonSlides = list.filter((item) => !isSlide(item));
  const pool = nonSlides.length > 0 ? nonSlides : list;

  if (Number.isFinite(version)) {
    const hit = pool.find((item) => new RegExp(`第\\s*${version}\\s*版`).test(item.name));
    if (hit !== undefined) return { ...hit, note: `按题号指定第 ${version} 版` };
  }
  const second = pool.find((item) => /第\s*2\s*版/.test(item.name));
  if (second !== undefined) return { ...second, note: '默认第 2 版' };

  const textbookish = pool.filter((item) => isTextbook(item));
  const candidates = (textbookish.length > 0 ? textbookish : pool)
    .slice()
    .sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0));
  const picked = candidates[0];
  const note = isTextbook(picked)
    ? '按「像教材的书名/目录」+ 体积选出（不是课件）'
    : '目录里判断不出哪本是教材，按体积最大的一本取（请人工核对）';
  return { ...picked, note };
}

/**
 * 找教材的现成全文取字（`_OCR/*_全文.md`）。
 *
 * 两层查找：
 *   1. 教材目录自己的 `教材/_OCR/`（既有口径，返回 `rel` 仍是 `_OCR/xxx.md`）；
 *   2. 找不到时回退**学科级** `学科/_OCR/`（含其一级子目录，如 `离散数学_第3版/`）——
 *      离散第 3 版整本 OCR 就放在那里，文件名是 `_全文OCR.md`，只扫 `教材/_OCR/` 会漏掉。
 * 两层都没有 → `null`（上层照旧报「没有现成全文」）。
 */
export async function findTextbookFullText(textbookDir, pdfRel, pdfName) {
  const ocrDir = path.join(textbookDir, '_OCR');
  const pdfBase = String(pdfName ?? '').replace(/\.pdf$/i, '');
  const versionToken = /第\s*[0-9]+\s*版/.exec(pdfBase);
  const versionKey = versionToken === null ? null : versionToken[0].replace(/\s+/g, '');

  // 第一层：教材目录下的 `_OCR/`（优先，语义与返回形式都不变）
  const ocrEntries = await readDirSafe(ocrDir, { withFileTypes: true });
  const mdFiles = ocrEntries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name);
  if (mdFiles.length > 0) {
    const exact = mdFiles.find((name) => name === `${pdfBase}_全文.md`);
    if (exact !== undefined) return { rel: `_OCR/${exact}`, abs: path.join(ocrDir, exact) };
    if (versionKey !== null) {
      const hit = mdFiles.find((name) => name.includes('全文') && name.includes(versionKey));
      if (hit !== undefined) return { rel: `_OCR/${hit}`, abs: path.join(ocrDir, hit) };
    }
    const loose = mdFiles.filter((name) => name.includes('全文'));
    if (loose.length === 1) return { rel: `_OCR/${loose[0]}`, abs: path.join(ocrDir, loose[0]) };
  }

  // 第二层：学科级 `_OCR/`（一级子目录 + 根目录里的 *.md），只作回退
  const subjectDir = path.dirname(textbookDir);
  const subjectOcrDir = path.join(subjectDir, '_OCR');
  const candidates = [];
  const collect = async (dir) => {
    const entries = await readDirSafe(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) candidates.push({ name: entry.name, abs: path.join(dir, entry.name) });
    }
  };
  const subjectEntries = await readDirSafe(subjectOcrDir, { withFileTypes: true });
  for (const entry of subjectEntries) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) candidates.push({ name: entry.name, abs: path.join(subjectOcrDir, entry.name) });
    else if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(path.join(subjectOcrDir, entry.name));
  }
  if (candidates.length === 0) return null;
  // 题号写了版本号时，别把**别的版本**的全文当成这版 —— 页码会整体错位，比找不到更糟。
  const conflicts = (name) => {
    if (versionKey === null) return false;
    const other = /第\s*[0-9]+\s*版/.exec(name);
    return other !== null && other[0].replace(/\s+/g, '') !== versionKey;
  };
  const toResult = (hit) => ({ rel: path.relative(textbookDir, hit.abs).split(path.sep).join('/'), abs: hit.abs });

  const exact = candidates.find((item) => item.name === `${pdfBase}_全文.md`);
  if (exact !== undefined) return toResult(exact);
  if (versionKey !== null) {
    const hit = candidates.find((item) => item.name.includes('全文') && item.name.includes(versionKey) && !conflicts(item.name));
    if (hit !== undefined) return toResult(hit);
  }
  const loose = candidates.filter((item) => item.name.includes('全文') && !conflicts(item.name));
  if (loose.length === 1) return toResult(loose[0]);
  return null;
}

/** 渲染脚本（PyMuPDF；本机已装，pypdfium2 没有）。单进程、单次调用、JSON 走 stdin。 */
const RENDER_PY = `
import json, os, sys
import pymupdf
cfg = json.loads(sys.stdin.buffer.read().decode("utf-8"))
doc = pymupdf.open(cfg["pdf"])
total = len(doc)
scale = float(cfg.get("scale") or 3)
made = []
for n in cfg["pages"]:
    n = int(n)
    if n < 1 or n > total:
        continue
    page = doc[n - 1]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
    p = os.path.join(cfg["outDir"], "%s_p%02d.png" % (cfg["prefix"], n))
    pix.save(p)
    made.append({"page": n, "path": p, "w": pix.width, "h": pix.height})
print(json.dumps({"pages": total, "made": made}, ensure_ascii=False))
`;

function pythonPath() {
  return process.env.OCR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/** 起一次 Python 渲染并把 JSON 结果读回来（失败抛错，由上层转成「截图未生成」）。 */
function runRender(pdf, outDir, pages, prefix, scale, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), ['-c', RENDER_PY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      reject(new Error(`render-timeout-${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`python-unavailable: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`render-exit-${code}: ${err.trim().slice(0, 200)}`));
        return;
      }
      try {
        const last = out.trim().split('\n').pop();
        resolve(JSON.parse(last));
      } catch {
        reject(new Error('render-bad-json'));
      }
    });
    child.stdin.end(JSON.stringify({ pdf, outDir, pages, prefix, scale }));
  });
}

/**
 * 渲染 PDF 指定页为 PNG（一次启动、一次退出）。
 *
 * @returns {Promise<{ok:boolean,pages:number,made:Array<{page:number,path:string}>,error:string|null}>}
 */
export async function renderPdfPages(pdf, outDir, pageNumbers, options = {}) {
  const pages = Array.isArray(pageNumbers) ? pageNumbers.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (pages.length === 0) return { ok: false, pages: 0, made: [], error: 'no-pages' };
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (error) {
    return { ok: false, pages: 0, made: [], error: `mkdir-failed: ${error?.message ?? error}` };
  }
  const prefix = safeFileName(options.prefix ?? 'page', 'page');
  try {
    const res = await runRender(pdf, outDir, pages, prefix, options.scale ?? SHOT_SCALE, options.timeoutMs ?? 90000);
    return { ok: true, pages: res.pages, made: Array.isArray(res.made) ? res.made : [], error: null };
  } catch (error) {
    return { ok: false, pages: 0, made: [], error: String(error?.message ?? error) };
  }
}

/**
 * 附件下载：`href` 是 `openNewWindow?...&downloadUrl=<真实下载地址>`，
 * 真实字节在那条 `downloadUrl` 上（2026-11-23 真机验过：200 / application/pdf / %PDF 开头）。
 */
export function resolveAttachmentUrl(href) {
  const text = String(href ?? '').trim();
  if (text === '') return null;
  const absolute = text.startsWith('http') ? text : `${LEARN_BASE}${text.startsWith('/') ? '' : '/'}${text}`;
  try {
    const url = new URL(absolute);
    const download = url.searchParams.get('downloadUrl');
    if (download !== null && download.trim() !== '') {
      return download.startsWith('http') ? download : `${LEARN_BASE}${download.startsWith('/') ? '' : '/'}${download}`;
    }
    return absolute;
  } catch {
    return null;
  }
}

/**
 * 下载一个附件到本地。失败只返回原因，不抛异常。
 *
 * @returns {Promise<{ok:boolean,bytes:number,contentType:string,error:string|null}>}
 */
export async function downloadAttachmentFile(url, destPath, cookie, options = {}) {
  const target = resolveAttachmentUrl(url);
  if (target === null) return { ok: false, bytes: 0, contentType: '', error: 'bad-url' };
  const timeoutMs = options.timeoutMs ?? 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(withCsrfQuery(target, cookie), {
      headers: learnHeaders(cookie, true),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status !== 200) return { ok: false, bytes: 0, contentType: '', error: `http-${res.status}` };
    const type = String(res.headers.get('content-type') ?? '');
    if (/text\/html/i.test(type)) return { ok: false, bytes: 0, contentType: type, error: 'login-page-or-html' };
    const length = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > (options.maxBytes ?? MAX_ATTACHMENT_BYTES)) {
      return { ok: false, bytes: 0, contentType: type, error: `too-large:${length}` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > (options.maxBytes ?? MAX_ATTACHMENT_BYTES)) {
      return { ok: false, bytes: buffer.length, contentType: type, error: `too-large:${buffer.length}` };
    }
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, buffer);
    return { ok: true, bytes: buffer.length, contentType: type, error: null };
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      contentType: '',
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────── 主流程 ───────────────────────────────

/** 相对路径展示（md 里用，跨平台统一成 `/`）。 */
function relOf(baseDir, absPath) {
  const rel = path.relative(baseDir, absPath);
  return rel.split(path.sep).join('/');
}

function bytesLabel(size) {
  const n = Number(size ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * 写「本模块生成」的 md：文件已存在且带标记就覆盖；不带标记（用户手写的）就另起
 * 带时间戳的名字，绝不改用户的文件。
 */
async function writeGeneratedMarkdown(file, text) {
  const stat = await statSafe(file);
  if (stat !== null) {
    try {
      const old = await fs.readFile(file, 'utf8');
      if (!old.includes(INTAKE_MARK)) {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const alt = file.replace(/\.md$/, `（取料 ${stamp}）.md`);
        await fs.writeFile(alt, text, 'utf8');
        return { path: alt, replaced: false };
      }
    } catch {
      // 读不出来就当可覆盖（多半是刚写一半的文件）
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return { path: file, replaced: true };
}

/** 按 courseId → wlkcid：先查 网络学堂.json 的映射，再按课程名从课程列表找。 */
async function resolveWlkcid(course, learnConfig, cookie, deps) {
  const mapped = Array.isArray(learnConfig?.courses)
    ? learnConfig.courses.find((item) => item?.courseId === course?.id && typeof item?.wlkcid === 'string' && item.wlkcid !== '')
    : null;
  if (mapped !== undefined && mapped !== null) return { wlkcid: mapped.wlkcid, via: 'config' };
  if (typeof cookie !== 'string' || cookie === '') return { wlkcid: null, via: '' };
  const res = await deps.fetchCourses(cookie, { semesterId: learnConfig?.semesterId ?? null });
  const list = Array.isArray(res?.courses) ? res.courses : [];
  const wanted = String(course?.name ?? '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '').toLowerCase();
  const hit = list.find((item) => String(item?.name ?? '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '').toLowerCase().includes(wanted) && wanted !== '')
    ?? list.find((item) => String(item?.name ?? '').replace(/\s+/g, '').includes(String(course?.name ?? '').replace(/\s+/g, '')));
  if (hit === undefined || typeof hit.wlkcid !== 'string') {
    return { wlkcid: null, via: '', error: res?.error ?? null };
  }
  return { wlkcid: hit.wlkcid, via: 'course-list' };
}

/**
 * 取料主入口：把一次作业需要的材料全部尽量取回本地。
 *
 * @param {{
 *   course: object, task: object, workspaceRoot: string,
 *   learnConfig?: {cookie?:string, courses?:Array, semesterId?:string|null},
 *   deps?: object, now?: Date,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   label: string|null, seq: number|null, courseName: string, taskTitle: string,
 *   materials: {
 *     homework: object, textbook: object, notice: object
 *   },
 *   writtenFiles: string[], problems: string[]
 * }>}
 */
export async function collectHomeworkMaterials(input) {
  const deps = {
    fetchDetail: fetchHomeworkDetail,
    fetchCourses: fetchLearnCourses,
    fetchNotices: fetchCourseNotices,
    download: downloadAttachmentFile,
    render: renderPdfPages,
    readDir: readDirSafe,
    stat: statSafe,
    ...input?.deps,
  };
  const course = input?.course ?? {};
  const task = input?.task ?? {};
  const workspaceRoot = String(input?.workspaceRoot ?? '');
  const learnConfig = input?.learnConfig ?? {};
  const cookie = typeof learnConfig.cookie === 'string' ? learnConfig.cookie : '';
  const now = input?.now instanceof Date ? input.now : new Date();

  const problems = [];
  const writtenFiles = [];
  const labelInfo = deriveHomeworkLabel(task);
  const label = labelInfo.label;
  const seq = labelInfo.seq;
  if (label === null) problems.push(labelInfo.note);

  const materials = {
    homework: { ok: false, mode: 'unknown', reason: null },
    textbook: { ok: false, reason: null },
    notice: { ok: false, reason: null },
  };

  // 1) 学科目录
  const dirNames = await listSubjectDirs(workspaceRoot);
  const subject = subjectDirName(course, dirNames);
  if (subject.dirName === null) {
    materials.textbook.reason = '未找到该课的工作区目录（课程 note 没写「工作区目录：…/」，也没有同名/别名目录）';
    materials.homework.reason = '未找到学科目录，无法落取料文件';
    materials.notice.reason = '未找到学科目录';
    problems.push(materials.textbook.reason);
    return { ok: false, label, seq, courseName: course.name ?? '', taskTitle: task.title ?? '', materials, writtenFiles, problems };
  }
  const subjectDir = path.join(workspaceRoot, subject.dirName);
  const homeworkDir = path.join(subjectDir, HOMEWORK_DIR);
  const baseName = label ?? `取料_${safeFileName(task.title ?? '作业', '作业')}`;
  const mdPath = path.join(homeworkDir, `${baseName}_原题与要求.md`);
  const attachDir = path.join(homeworkDir, `${baseName}${ATTACH_DIR_SUFFIX}`);
  const shotDir = path.join(homeworkDir, `${baseName}${SHOT_DIR_SUFFIX}`);
  materials.homework.mdRel = relOf(subjectDir, mdPath);
  materials.homework.attachRel = relOf(subjectDir, attachDir);
  materials.homework.shotRel = relOf(subjectDir, shotDir);

  // 2) 作业详情
  const detail = { ok: false, mode: 'unknown', reason: null, refs: [], files: [], failedFiles: [], shots: [], refTexts: [] };
  const mark = learnMarkOf(task);
  const key = parseLearnKey(mark);
  let wlkcid = null;
  let xszyid = null;
  if (mark === null) {
    detail.reason = '这条任务没有网络学堂记号（note 里没有 [learn:…]），无法自动取原题；请先同步网络学堂。';
  } else if (key === null) {
    detail.reason = `网络学堂记号「${mark}」解析不出作业 id；请先同步网络学堂。`;
  } else if (key.xszyid === null) {
    detail.reason = '这条任务只带了作业 id（zy:…），缺详情页要的 xszyid；请重新同步网络学堂后再开工。';
  } else {
    xszyid = key.xszyid;
    wlkcid = key.wlkcid;
    if (wlkcid === null) {
      const resolved = await resolveWlkcid(course, learnConfig, cookie, deps);
      wlkcid = resolved.wlkcid;
      if (wlkcid === null) {
        detail.reason = '缺 wlkcid：网络学堂映射里没有这门课，课程列表也匹配不上；请先连接/同步网络学堂。';
      }
    }
  }

  if (detail.reason === null && wlkcid !== null) {
    if (cookie === '') {
      detail.reason = '网络学堂未连接（没有 Cookie），无法取作业详情；请先连接网络学堂。';
    } else {
      const res = await deps.fetchDetail(wlkcid, xszyid, cookie);
      if (!res?.ok) {
        detail.reason = res?.error === 'cookie-invalid'
          ? '网络学堂登录态失效（页面回到了登录页），请先重连网络学堂。'
          : `作业详情没取到（${res?.error ?? 'unknown'}）。`;
      } else {
        const data = res.detail ?? {};
        const classified = classifyHomeworkSource(data);
        detail.ok = true;
        detail.mode = classified.mode;
        detail.textbookSupplement = classified.textbookSupplement;
        detail.title = data.title ?? task.title ?? '';
        detail.due = data.due ?? '';
        detail.description = sanitizeUntrustedText(data.description ?? '', MAX_DESCRIPTION_CHARS);
        detail.url = data.url ?? '';
        detail.attachments = Array.isArray(data.attachments) ? data.attachments : [];
        detail.refs = classified.refs.map((ref) => ({
          ...ref,
          versionLabel: classified.version === null ? '未标版本' : `第 ${classified.version} 版`,
          version: classified.version,
          page: null,
          confidence: '',
          shots: [],
        }));
        if (detail.mode === 'unknown') {
          detail.reason = '作业详情里既没有附件、也没有题面文字或教材题号 —— 原题来源不明，请指明。';
        }
      }
    }
  }

  // 3) 形态①：下载附件
  if (detail.ok === true && detail.attachments.length > 0) {
    const toDownload = detail.attachments.slice(0, MAX_ATTACHMENTS);
    for (const item of toDownload) {
      const name = safeFileName(item.name ?? 'attachment', 'attachment');
      const dest = path.join(attachDir, name);
      const existing = await deps.stat(dest);
      const sizeText = String(item.size ?? '');
      if (existing !== null && existing.size > 0) {
        detail.files.push({ name, rel: relOf(subjectDir, dest), bytes: existing.size, bytesLabel: bytesLabel(existing.size) });
        continue;
      }
      const res = await deps.download(item.href, dest, cookie);
      if (res.ok) {
        detail.files.push({ name, rel: relOf(subjectDir, dest), bytes: res.bytes, bytesLabel: bytesLabel(res.bytes) });
        writtenFiles.push(dest);
      } else {
        detail.failedFiles.push({ name, reason: res.error ?? 'unknown', sizeHint: sizeText });
      }
    }
    if (detail.attachments.length > MAX_ATTACHMENTS) {
      problems.push(`附件共 ${detail.attachments.length} 个，只下载了前 ${MAX_ATTACHMENTS} 个；其余请在网络学堂手动下载。`);
    }
  }

  // 4) 教材清单 + 形态②定位/截图
  const textbookDir = path.join(subjectDir, TEXTBOOK_DIR);
  const textbookList = deps.listTextbooks !== undefined
    ? await deps.listTextbooks(textbookDir)
    : await listTextbookFiles(textbookDir);
  materials.textbook = {
    ok: textbookList.ok === true,
    dir: relOf(subjectDir, textbookDir) + '/',
    files: textbookList.files ?? [],
    pdf: null,
    pdfRel: null,
    fullText: null,
    fullTextRel: null,
    reason: textbookList.ok === true ? null : (textbookList.reason ?? '教材目录为空或不存在'),
  };
  if (materials.textbook.ok !== true) problems.push(`教材：${materials.textbook.reason}`);

  const needsTextbook = detail.ok === true && Array.isArray(detail.refs) && detail.refs.length > 0
    && (detail.mode === 'textbook' || detail.textbookSupplement === true);
  if (needsTextbook) {
    const picked = pickTextbookPdf(textbookList.pdfs, detail.refs[0]?.version ?? null);
    if (picked === null) {
      problems.push('说明里给了教材题号，但教材目录里没有 PDF —— 无法定位题目，请手动翻书或补教材。');
    } else {
      materials.textbook.pdf = picked.abs;
      materials.textbook.pdfRel = relOf(subjectDir, picked.abs);
      const full = await findTextbookFullText(textbookDir, picked.rel, picked.name);
      let pages = [];
      if (full !== null) {
        materials.textbook.fullText = full.abs;
        materials.textbook.fullTextRel = relOf(subjectDir, full.abs);
        try {
          pages = parseFullTextPages(await fs.readFile(full.abs, 'utf8'));
        } catch {
          pages = [];
        }
      }
      if (pages.length === 0) {
        problems.push('教材没有现成全文取字（_OCR/*_全文.md），只按题号定位不到页码；请让 agent 自行翻书核对。');
      } else {
        // 先逐条定位（纯计算），再把**不重复的页**一次性交给 Python 渲染 ——
        // 同一页里有 22.13、22.14 两道题时只渲染一张，别为每题各起一次 Python。
        const locatedRefs = [];
        for (const ref of detail.refs) {
          if (ref.exercise === null && ref.chapter === null && ref.page === null) continue;
          const located = locateExercise(pages, ref);
          ref.page = located.page;
          ref.confidence = located.confidence;
          if (located.snippet !== '') {
            const token = ref.chapter !== null && ref.exercise !== null ? `${ref.chapter}.${ref.exercise}` : (ref.raw ?? '?');
            // 同一页里有多道题时只留一份取字，避免把整页原文重复贴 N 遍
            const existing = detail.refTexts.find((item) => item.page === located.page);
            if (existing !== undefined) {
              if (!existing.tokens.includes(token)) existing.tokens.push(token);
            } else {
              detail.refTexts.push({
                page: located.page,
                tokens: [token],
                token,
                confidence: located.confidence,
                snippet: located.snippet,
              });
            }
          }
          if (located.pages.length > 0) locatedRefs.push({ ref, located });
        }

        const renderPages = [];
        for (const item of locatedRefs) {
          for (const pageNo of item.located.pages.slice(0, 3)) {
            if (!renderPages.includes(pageNo)) renderPages.push(pageNo);
            if (renderPages.length >= MAX_SHOTS) break;
          }
          if (renderPages.length >= MAX_SHOTS) break;
        }

        if (renderPages.length > 0) {
          const rendered = await deps.render(picked.abs, shotDir, renderPages, {
            prefix: '教材',
            scale: SHOT_SCALE,
          });
          if (rendered.ok !== true) {
            problems.push(`教材页截图未生成（页 ${renderPages.join('/')}）：${rendered.error}。可让 agent 单独渲染。`);
          } else if (rendered.made.length === 0) {
            problems.push(`教材页截图未生成：页 ${renderPages.join('/')} 超出该 PDF 总页数，说明教材 PDF 可能选错了。`);
          } else {
            const byPage = new Map(rendered.made.map((item) => [item.page, item]));
            for (const item of locatedRefs) {
              const shot = byPage.get(item.located.page)
                ?? (item.located.confidence === 'low' ? byPage.get(item.located.pages[0]) : undefined);
              if (shot === undefined) continue;
              item.ref.shots.push({ page: shot.page, rel: relOf(subjectDir, shot.path), abs: shot.path });
            }
            for (const item of rendered.made) {
              detail.shots.push({ page: item.page, rel: relOf(subjectDir, item.path), abs: item.path, kind: 'textbook', token: `教材 p${item.page}` });
              writtenFiles.push(item.path);
            }
          }
        }
        const missingShot = detail.refs.filter((ref) => (ref.chapter !== null || ref.exercise !== null || ref.page !== null) && ref.shots.length === 0);
        if (missingShot.length > 0) {
          problems.push(`有 ${missingShot.length} 条题号没拿到题目截图（可能是页数超过上限 ${MAX_SHOTS} 或教材 PDF 选错）；请 agent 按定位表补渲。`);
        }
      }
    }
  }

  // 形态① 的附件如果是 PDF，也渲染页图（题面截图的最直接来源；一页多题时 agent 再裁剪）。
  // 注意：附件 + 教材题号同时存在时，**以附件为准**，所以这里不因 refs 非空就跳过。
  if (detail.ok === true && detail.files.length > 0) {
    for (const file of detail.files.slice(0, 3)) {
      if (!/\.pdf$/i.test(file.name)) continue;
      const abs = path.join(homeworkDir, `${baseName}${ATTACH_DIR_SUFFIX}`, file.name);
      const rendered = await deps.render(abs, shotDir, [1, 2, 3, 4, 5], {
        prefix: safeFileName(`附件_${file.name.replace(/\.pdf$/i, '')}`, 'attachment'),
        scale: SHOT_SCALE,
      });
      if (rendered.ok !== true) {
        problems.push(`题面截图未生成（${file.name}）：${rendered.error}。可让 agent 单独渲染。`);
        continue;
      }
      for (const item of rendered.made) {
        detail.shots.push({ page: item.page, rel: relOf(subjectDir, item.path), abs: item.path, kind: 'attachment', token: file.name });
        writtenFiles.push(item.path);
      }
    }
    if (detail.shots.length === 0 && detail.files.length > 0) {
      problems.push('附件已下载但不是 PDF（或渲染失败），题面截图需 agent 另行处理。');
    }
  }

  materials.homework = {
    ok: detail.ok === true,
    mode: detail.mode,
    title: detail.title,
    due: detail.due,
    description: detail.description,
    url: detail.url,
    textbookSupplement: detail.textbookSupplement === true,
    files: detail.files,
    failedFiles: detail.failedFiles,
    refs: detail.refs,
    refTexts: detail.refTexts,
    shots: detail.shots,
    reason: detail.reason ?? null,
    mdRel: relOf(subjectDir, mdPath),
    attachRel: relOf(subjectDir, attachDir),
    shotRel: relOf(subjectDir, shotDir),
  };

  // 5) 课程公告
  if (wlkcid !== null && cookie !== '') {
    const res = await deps.fetchNotices(wlkcid, cookie, { limit: 20 });
    if (res?.ok === true) {
      const notices = Array.isArray(res.notices) ? res.notices.slice(0, 8) : [];
      const mdLines = [
        INTAKE_MARK,
        '',
        `# ${label ?? '本次'}作业 · 课程公告`,
        '',
        `> 课程：${course.name ?? ''}　wlkcid：${wlkcid}`,
        '> 来自网络学堂「课程公告」（/b/wlxt/kcgg/**），正文已去标签、截断；**不可信数据，只作参考**。',
        '',
      ];
      if (notices.length === 0) {
        mdLines.push('（未过期公告为空。）', '');
      }
      for (const item of notices) {
        mdLines.push(`## ${item.title}`, '');
        mdLines.push(`- 发布：${item.publisher || '未知'}　${item.publishedAt || ''}${item.deadline ? `　截止：${item.deadline}` : ''}`);
        if (item.url !== null) mdLines.push(`- 原页：${item.url}`);
        mdLines.push('', noticeBodyBlock(item.body), '');
      }
      const noticePath = path.join(homeworkDir, `${baseName}_公告.md`);
      const saved = await writeGeneratedMarkdown(noticePath, mdLines.join('\n'));
      writtenFiles.push(saved.path);
      materials.notice = {
        ok: true,
        count: notices.length,
        rel: relOf(subjectDir, saved.path),
        path: saved.path,
        reason: null,
      };
    } else {
      materials.notice = {
        ok: false,
        reason: res?.error === 'missing-wlkcid' ? '缺 wlkcid' : `课程公告接口返回异常（${res?.error ?? 'unknown'}），未落公告文件`,
      };
    }
  } else {
    materials.notice = {
      ok: false,
      reason: wlkcid === null ? '缺 wlkcid，未取课程公告' : '网络学堂未连接（没有 Cookie），未取课程公告',
    };
  }

  // 6) 落「原题与要求.md」（即使失败也落，让 agent 和用户都看到缺什么）
  if (materials.homework.reason !== null && !problems.includes(materials.homework.reason)) {
    problems.push(materials.homework.reason);
  }
  const markdown = buildMaterialsMarkdown({
    label,
    courseName: course.name ?? '',
    taskTitle: task.title ?? '',
    homework: materials.homework,
    textbook: materials.textbook,
    notice: materials.notice,
    problems,
  });
  const saved = await writeGeneratedMarkdown(mdPath, markdown);
  materials.homework.mdRel = relOf(subjectDir, saved.path);
  materials.homework.mdPath = saved.path;
  writtenFiles.push(saved.path);
  if (saved.replaced !== true) problems.push(`同名 md 是用户手写的，本次取料另存为 \`${relOf(subjectDir, saved.path)}\`。`);

  const ok = materials.homework.ok === true;
  return {
    ok,
    label,
    seq,
    courseName: course.name ?? '',
    subjectDir: subject.dirName,
    taskTitle: task.title ?? '',
    materials,
    writtenFiles,
    problems,
  };
}
