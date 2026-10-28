/**
 * 课后笔记的渲染层（纯函数，不碰网络也不碰磁盘）。
 *
 * 模型只负责产出**结构化事实**（概览 / 要点 / 问答 / 术语 / 待办），Markdown
 * 由这里拼 —— 理由是格式稳定：模型换个版本、多打一个星号，笔记的骨架不该跟着变。
 * 模型给不出 JSON 时也不报错，降级成「头部 + 逐字稿摘录 + 提醒记录」，
 * 至少不丢东西。
 */

/** 交给模型的任务说明（把 JSON 形状写死，省得来回猜）。 */
export const SUMMARY_SCHEMA_HINT = `{
  "overview": "这节课整体讲了什么，3-5 句，写成可以一眼看懂的段落",
  "points": [{ "title": "要点标题", "detail": "这一点的具体内容、公式、结论" }],
  "questions": [{ "question": "课上提出的问题（老师提问或自己没懂的）", "answer": "答案或思路；没解决就写还没解决的原因", "status": "answered" }],
  "terms": ["这节课出现的新术语 / 公式 / 英文缩写，带一句解释"],
  "todos": ["要交的作业、要复习的内容、下节课要带的东西"],
  "followups": ["值得再追问老师的 2-3 个问题"]
}`;

/** 时间戳 → `HH:MM`（用本地时间，别用 UTC，否则会差 8 小时）。 */
export function hm(iso) {
  const date = iso instanceof Date ? iso : new Date(String(iso));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 表格单元格里的 `|` 会把 Markdown 表格撕开，必须先转义。 */
export function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 从模型的回话里抠出 JSON。
 *
 * 常见污染：```json 围栏、前后各一段客套话、末尾多一个逗号。这里只做
 * 「找第一个 { 到最后一个 }」这种粗切，不做语法修补 —— 修不好的话，
 * 调用方会降级成纯文本，不影响笔记生成。
 */
export function parseSummaryJson(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/```[a-zA-Z]*\n?/g, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

/** 结构化结果兜底成「合法形状」：模型少给字段、给错类型都不该让渲染崩。 */
export function normalizeSummary(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : []);
  const points = Array.isArray(raw.points)
    ? raw.points
      .map((item) => ({
        title: typeof item?.title === 'string' ? item.title.trim() : '',
        detail: typeof item?.detail === 'string' ? item.detail.trim() : '',
      }))
      .filter((item) => item.title !== '' || item.detail !== '')
    : [];
  const questions = Array.isArray(raw.questions)
    ? raw.questions
      .map((item) => ({
        question: typeof item?.question === 'string' ? item.question.trim() : '',
        answer: typeof item?.answer === 'string' ? item.answer.trim() : '',
        status: item?.status === 'answered' ? 'answered' : 'open',
      }))
      .filter((item) => item.question !== '')
    : [];
  return {
    overview: typeof raw.overview === 'string' ? raw.overview.trim() : '',
    points,
    questions,
    terms: strings(raw.terms),
    todos: strings(raw.todos),
    followups: strings(raw.followups),
  };
}

/** 这节课有没有实际内容 —— 空课不必生成笔记。 */
export function isSummaryEmpty(summary) {
  if (summary === null) return true;
  return summary.overview === '' && summary.points.length === 0 && summary.questions.length === 0
    && summary.terms.length === 0 && summary.todos.length === 0 && summary.followups.length === 0;
}

/**
 * 渲染课后笔记 Markdown。
 *
 * @param {object} input
 * @param {string} input.course 课程名
 * @param {string} input.date `YYYY-MM-DD`
 * @param {string} [input.startedAt] ISO
 * @param {string} [input.stoppedAt] ISO
 * @param {string} [input.studentName]
 * @param {object|null} input.summary 结构化总结（可为 null）
 * @param {string} [input.rawSummary] 模型没给出 JSON 时的原始回话
 * @param {object} [input.stats] `{frames, chars, alerts, dropped}`
 * @param {Array} [input.alerts]
 * @param {string} [input.transcriptPath] 逐字稿文件路径（写进笔记，方便回头查）
 * @param {string} [input.transcriptText] 逐字稿正文（只在没有总结时用作摘录）
 * @param {string[]} [input.rolling] 滚动小结的历史
 * @param {string} [input.note] 渲染时想额外说明的一句话（例如「自动总结失败，原因是…」）
 */
export function renderNoteMarkdown(input = {}) {
  const course = String(input.course ?? '未命名课程');
  const date = String(input.date ?? '');
  const stats = input.stats ?? {};
  const alerts = Array.isArray(input.alerts) ? input.alerts : [];
  const summary = normalizeSummary(input.summary);
  const lines = [];

  lines.push(`# ${course} · ${date} 听课笔记`);
  lines.push('');

  const head = [];
  if (typeof input.startedAt === 'string' && input.startedAt !== '') {
    head.push(`${hm(input.startedAt)}${typeof input.stoppedAt === 'string' && input.stoppedAt !== '' ? '–' + hm(input.stoppedAt) : ''}`);
  }
  head.push(`${stats.frames ?? 0} 帧 / ${stats.chars ?? 0} 字`);
  head.push(`${stats.alerts ?? 0} 条提醒`);
  if (typeof input.studentName === 'string' && input.studentName !== '') head.push(`学生：${input.studentName}`);
  lines.push('> ' + head.join(' · '));
  if (typeof input.transcriptPath === 'string' && input.transcriptPath !== '') {
    lines.push('> 逐字稿：`' + input.transcriptPath + '`');
  }
  lines.push('');

  if (typeof input.note === 'string' && input.note !== '') {
    lines.push('> ⚠️ ' + input.note);
    lines.push('');
  }

  if (summary !== null && summary.overview !== '') {
    lines.push('## 这节课讲了什么');
    lines.push('');
    lines.push(summary.overview);
    lines.push('');
  }

  if (summary !== null && summary.points.length > 0) {
    lines.push('## 要点');
    lines.push('');
    summary.points.forEach((point, index) => {
      const title = point.title === '' ? `第 ${index + 1} 点` : point.title;
      lines.push(`${index + 1}. **${title}**${point.detail === '' ? '' : ' —— ' + point.detail}`);
    });
    lines.push('');
  }

  if (summary !== null && summary.questions.length > 0) {
    lines.push('## 课堂问答');
    lines.push('');
    for (const item of summary.questions) {
      lines.push(`- **${item.question}**${item.status === 'answered' ? '' : '（仍未解决）'}`);
      if (item.answer !== '') lines.push(`  - ${item.answer}`);
    }
    lines.push('');
  }

  if (summary !== null && summary.terms.length > 0) {
    lines.push('## 术语 / 公式');
    lines.push('');
    for (const term of summary.terms) lines.push(`- ${term}`);
    lines.push('');
  }

  if (summary !== null && summary.todos.length > 0) {
    lines.push('## 待办');
    lines.push('');
    for (const todo of summary.todos) lines.push(`- [ ] ${todo}`);
    lines.push('');
  }

  if (summary !== null && summary.followups.length > 0) {
    lines.push('## 值得追问');
    lines.push('');
    for (const item of summary.followups) lines.push(`- ${item}`);
    lines.push('');
  }

  if (alerts.length > 0) {
    lines.push('## 点名与提问记录');
    lines.push('');
    lines.push('| 时间 | 类型 | 命中 | 上下文 |');
    lines.push('|---|---|---|---|');
    for (const alert of alerts) {
      lines.push(`| ${hm(alert.at)} | ${cell(alert.label)} | ${cell(alert.matched)} | ${cell(alert.snippet)} |`);
    }
    lines.push('');
  }

  if (Array.isArray(input.rolling) && input.rolling.length > 0) {
    lines.push('## 课堂进程（滚动小结）');
    lines.push('');
    for (const item of input.rolling) lines.push(`- ${String(item).replace(/\r?\n/g, ' ')}`);
    lines.push('');
  }

  const noStructured = summary === null || isSummaryEmpty(summary);
  if (noStructured) {
    const raw = typeof input.rawSummary === 'string' && input.rawSummary.trim() !== '' ? input.rawSummary.trim() : '';
    if (raw !== '') {
      lines.push('## 自动总结（未结构化的原文）');
      lines.push('');
      lines.push(raw);
      lines.push('');
    } else {
      lines.push('## 自动总结');
      lines.push('');
      lines.push('（这次没有生成结构化的总结 —— 逐字稿已经完整落盘，可以拿它单独再问一次。）');
      lines.push('');
    }
    const transcript = typeof input.transcriptText === 'string' ? input.transcriptText.trim() : '';
    if (transcript !== '') {
      lines.push('## 逐字稿摘录');
      lines.push('');
      lines.push(transcript.length > 4000 ? transcript.slice(0, 4000) + '\n\n…（后面还有 ' + String(transcript.length - 4000) + ' 字，见逐字稿文件）' : transcript);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * 课后交给新会话的「交接词」。
 *
 * 目的是把那节课的上下文塞进一个新会话：让它自己知道这是哪门课、笔记和
 * 逐字稿在哪、可以怎么接着问。写成一篇明确的任务说明，而不是把逐字稿
 * 整段倒进去（太长会吃满上下文，也让模型抓不住重点）。
 */
export function renderHandoffPrompt(input = {}) {
  const course = String(input.course ?? '未命名课程');
  const date = String(input.date ?? '');
  const summary = normalizeSummary(input.summary);
  const lines = [];
  lines.push(`我刚上完「${course}」这节课（${date}）。下面是这节课的自动笔记，逐字稿在 \`${String(input.transcriptPath ?? '')}\`，笔记在 \`${String(input.notePath ?? '')}\`。`);
  lines.push('');
  if (summary !== null && summary.overview !== '') {
    lines.push('## 这节课讲了什么');
    lines.push(summary.overview);
    lines.push('');
  }
  if (summary !== null && summary.points.length > 0) {
    lines.push('## 要点');
    summary.points.forEach((point, index) => {
      lines.push(`${index + 1}. **${point.title}**${point.detail === '' ? '' : ' —— ' + point.detail}`);
    });
    lines.push('');
  }
  if (summary !== null && summary.questions.length > 0) {
    lines.push('## 课上没弄明白的地方');
    for (const item of summary.questions) {
      lines.push(`- ${item.question}${item.answer === '' ? '' : '（课上的说法：' + item.answer + '）'}`);
    }
    lines.push('');
  }
  if (summary !== null && summary.followups.length > 0) {
    lines.push('## 我想搞清楚的');
    for (const item of summary.followups) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push('请先读完笔记文件，然后：① 把这节课的脉络用我能听懂的话讲一遍；② 回答上面「想搞清楚」的问题；③ 给我几道检验自己有没有听懂的题。');
  return lines.join('\n');
}

/**
 * 拼「滚动小结」的提示词：只给增量窗口 + 上一版小结，让模型做**增量更新**，
 * 而不是把整节课重讲一遍（一节课几十次调用，重讲既慢又贵还容易漂）。
 */
export function buildRollingPrompt(input = {}) {
  const previous = typeof input.previous === 'string' && input.previous.trim() !== '' ? input.previous.trim() : '（还没有，这是第一段）';
  return [
    `这是「${String(input.course ?? '')}」这节课的实时转写片段。`,
    '',
    '## 到目前为止的课堂脉络',
    previous,
    '',
    '## 新听到的一段',
    String(input.window ?? '').trim(),
    '',
    '请把「课堂脉络」更新成包含新内容的新版本：不超过 200 字，按时间顺序写老师讲到哪了、正在讲什么问题，不要罗列无关细节，不要加标题。',
  ].join('\n');
}

/** 拼课后总结的提示词。要求严格 JSON，省去解析自由文本的麻烦。 */
export function buildSummaryPrompt(input = {}) {
  return [
    `下面是一节课的完整转写稿（课程：${String(input.course ?? '')}，日期：${String(input.date ?? '')}）。`,
    '有些字是 OCR 认错的，按上下文理解即可，不要照抄错字。',
    '',
    '请输出**一个 JSON 对象**，不要写任何解释、不要加代码围栏，字段如下：',
    SUMMARY_SCHEMA_HINT,
    '',
    '要求：',
    '- 中文作答；术语保留英文原文（如 struct、B+ 树）。',
    '- 只写转写稿里真的出现过的内容，不要补充你自己的知识。',
    '- 如果转写稿里某一块信息确实没有（例如没有布置作业），对应字段给空数组。',
    '',
    '## 转写稿',
    String(input.transcript ?? '').trim(),
  ].join('\n');
}

/** 拼「提问时秒出答案」的提示词：给脉络 + 上下文 + 那道题本身。 */
export function buildAnswerPrompt(input = {}) {
  return [
    `这是「${String(input.course ?? '')}」课上老师正在问的一道题。请直接给答案或解法，控制在 150 字以内。`,
    '如果材料不足以确定答案，就说清楚缺什么、并给出最可能的思路，不要编。',
    '',
    '## 到目前为止的课堂脉络',
    typeof input.summary === 'string' && input.summary.trim() !== '' ? input.summary.trim() : '（暂无）',
    '',
    '## 出题前后的原话',
    String(input.context ?? '').trim(),
    '',
    '## 这道题',
    String(input.question ?? '').trim(),
  ].join('\n');
}
