/**
 * 知识点「讲解通道」的纯逻辑：三档固定指令、证据摘要、缓存文件的读写格式。
 *
 * 三档指令是 `_工具/任务单-全量资料取字与知识点索引.md` §7 阶段 E 定下的，
 * 用户明确要求**原样使用、不要改写** —— 所以它们在这里是常量字符串，一个字都不动；
 * 拼接时只在后面追加「资料片段」块（讲解必须只用资料里的内容，否则就成了模型自由发挥）。
 *
 * 与模型、磁盘无关的部分全在这里，方便单测：`lib/api.js` 只负责「读数据 → 拼 → 写缓存」。
 */

/** 风格键 → 面板上的按钮文字。顺序即按钮顺序。 */
export const EXPLAIN_STYLES = [
  {
    key: 'assistant',
    label: '助教推导',
    instruction: [
      '你是这门课的助教。针对「{知识点}」，只用资料里的内容，分步推导：',
      '先给结论，再给 3–5 步过程（每步一句），最后点出这一步的考点与常见错法。',
      '资料里没有的内容不要编，缺什么直接说「资料未覆盖」。',
    ].join('\n'),
  },
  {
    key: 'exam',
    label: '考前速通',
    instruction: [
      '针对「{知识点}」，三分钟内能看完：一句话定义、一个必背公式/结论、',
      '两个最容易错的点、一道最典型的题（只给题号，不展开）。不要推导过程。',
    ].join('\n'),
  },
  {
    key: 'hint',
    label: '只给提示',
    instruction: [
      '针对「{知识点}」，我卡住了。只给我第一步做什么和一个方向性提示，',
      '不要给答案、不要给完整步骤。如果我追问，再逐级多给一点。',
    ].join('\n'),
  },
];

/** 资料片段的总预算：再长就会把上下文吃光，而且讲解不需要整本教材。 */
export const EVIDENCE_MAX_CHARS = 6000;

/** 单个片段的上限（一页 OCR 通常 300–800 字）。 */
export const EVIDENCE_ITEM_MAX_CHARS = 1800;

/** 缓存文件正文上限（读回时超了就截断，防止手改出个巨大文件把面板卡住）。 */
export const EXPLAIN_MAX_CHARS = 200 * 1024;

/** 缓存目录名（相对数据目录 `学习台/`）。 */
export const EXPLAIN_DIR_NAME = '讲解缓存';

/**
 * 知识点内嵌聊天（2026-10-24）：学生就某一个知识点连续提问。
 *
 * 与「讲解」的区别是**多轮**：讲解是一次性生成的成品，聊天要带上下文。
 * 但两者守同一条底线——**只依据资料作答**，资料没覆盖就说没有，不许自由发挥。
 */
export const CHAT_MAX_MESSAGES = 20;
export const CHAT_MESSAGE_MAX_CHARS = 2000;

/** 聊天的固定开场（不进对话历史，只是拼在 prompt 最前面）。 */
export const CHAT_SYSTEM_ROLE = [
  '你是这门课的助教，正在和一名基础不太好的大二学生就「{知识点}」这个知识点对话。',
  '要求：',
  '1. 只依据下面【资料片段】里的内容回答；资料没覆盖的，直接说「资料里没找到，我按常识补一点」并标明是常识补充。',
  '2. 用通俗的话讲，先给一句人话结论，再展开；术语第一次出现要解释。',
  '3. 需要算式时写成一行，紧跟着用一句话说明它在算什么。',
  '4. 回答尽量短（3–8 句），学生追问再深入；不要一次把整章内容倒出来。',
  '5. 引用资料时带上来源标注（文件名 + 页码）。',
].join('\n');

/**
 * 校验并规整聊天消息。
 *
 * @param {unknown} raw
 * @returns {{ok: true, messages: Array<{role: 'user'|'assistant', content: string}>} | {ok: false, error: string}}
 */
export function normalizeChatMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'bad-messages' };
  if (raw.length > CHAT_MAX_MESSAGES) return { ok: false, error: 'too-many-messages' };
  const messages = [];
  for (const item of raw) {
    const role = String(item?.role ?? '').trim();
    if (role !== 'user' && role !== 'assistant') return { ok: false, error: 'bad-role' };
    const content = String(item?.content ?? '').replace(/\r\n/g, '\n').trim();
    if (content === '') return { ok: false, error: 'empty-message' };
    if (content.length > CHAT_MESSAGE_MAX_CHARS) return { ok: false, error: 'message-too-long' };
    messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== 'user') return { ok: false, error: 'last-must-be-user' };
  return { ok: true, messages };
}

/**
 * 拼聊天 prompt：固定角色 → 资料片段 → 对话历史（最后一条是本次提问）。
 *
 * @param {{name: string, evidence: string, messages: Array<{role: string, content: string}>}} input
 * @returns {string}
 */
export function buildChatPrompt(input = {}) {
  const name = String(input.name ?? '').trim();
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const head = CHAT_SYSTEM_ROLE.split('{知识点}').join(name);
  const history = messages.map((item) => `${item.role === 'user' ? '学生' : '助教'}：${item.content}`).join('\n');
  const evidenceBlock = evidence === ''
    ? '（这次没有检索到任何资料片段。请先说明「资料里没找到」，再按常识补充并明确标注。）'
    : ['【资料片段】下面是从本课程资料里摘出来的原文，每条都标了来源。只依据这些作答。', '', evidence].join('\n');
  return [head, '', evidenceBlock, '', '【对话】', history, '', '请回答学生最后这一问。'].join('\n');
}

/** 按 key 取风格；认不出回 null（接口据此回 400，而不是猜一个默认档）。 */
export function styleByKey(key) {
  const wanted = String(key ?? '').trim();
  if (wanted === '') return null;
  return EXPLAIN_STYLES.find((item) => item.key === wanted) ?? null;
}

/** 所有风格键（错误提示里用）。 */
export function styleKeys() {
  return EXPLAIN_STYLES.map((item) => item.key);
}

/** 指令里的占位符换成知识点名。只替换 `{知识点}`，别的一概不动。 */
export function instructionFor(style, name) {
  const instruction = typeof style?.instruction === 'string' ? style.instruction : '';
  return instruction.split('{知识点}').join(String(name ?? '').trim());
}

/**
 * 拼最终 prompt：固定指令（原样）+ 资料片段块。
 *
 * @param {{style: {key: string, instruction: string, label?: string}, name: string, evidence?: string}} input
 */
export function buildExplainPrompt(input = {}) {
  const style = input.style ?? null;
  const name = String(input.name ?? '').trim();
  const head = instructionFor(style, name).trim();
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
  if (evidence === '') {
    return `${head}\n\n（这次没有检索到任何资料片段。请直接说明「资料未覆盖」，不要凭印象作答。）`;
  }
  return [
    head,
    '',
    '【资料片段】下面这些是从本课程资料里摘出来的原文，每条都标了来源。',
    '只能依据这些内容作答；引用时带上来源标注，没出现的公式与结论不要补。',
    '',
    evidence,
  ].join('\n');
}

/** 把一条片段裁到上限，超了留「…」标记，方便识别被截过。 */
export function clipText(text, maxChars = EVIDENCE_ITEM_MAX_CHARS) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : EVIDENCE_ITEM_MAX_CHARS;
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…`;
}

/**
 * 把证据条目拼成「资料片段」正文。
 *
 * @param {Array<{label: string, text: string}>} items
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, used: number, dropped: number}}
 */
export function buildEvidenceDigest(items, options = {}) {
  const budget = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : EVIDENCE_MAX_CHARS;
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (const item of list) {
    const label = String(item?.label ?? '').trim();
    const text = clipText(item?.text);
    if (text === '') {
      dropped += 1;
      continue;
    }
    const block = label === '' ? `—— ${text}` : `—— ${label}\n${text}`;
    if (used + block.length + 2 > budget) {
      dropped += 1;
      continue;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return { text: parts.join('\n\n'), used, dropped };
}

/**
 * 缓存文件名：`<节点id>-<风格>.md`。
 *
 * 节点 id 是 `k_` + sha1 前 10 位（`lib/knowledge.js` 派生），本来就只有字母数字下划线；
 * 但面板允许手建节点（id 走 `makeId`），所以这里仍然白名单一遍，防止文件名带路径分隔符。
 */
export function explainFileName(nodeId, styleKey) {
  const safe = String(nodeId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 64);
  const style = String(styleKey ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  return `${safe === '' ? '_' : safe}-${style === '' ? 'unknown' : style}.md`;
}

/** 缓存文件头（YAML frontmatter：任务单要求写「知识点 / 风格 / 生成时间 / 笔记本」）。 */
export function renderExplainFile(meta = {}, text = '') {
  const lines = [
    '---',
    `知识点: ${String(meta.name ?? '').trim()}`,
    `风格: ${String(meta.styleLabel ?? meta.style ?? '').trim()}`,
    `生成时间: ${String(meta.generatedAt ?? '').trim()}`,
    `模型: ${String(meta.model ?? '').trim()}`,
    `笔记本: ${String(meta.notebook ?? '宿主内模型（无外部笔记本）').trim()}`,
    `节点: ${String(meta.nodeId ?? '').trim()}`,
    '---',
    '',
    String(text ?? '').replace(/\r\n/g, '\n').trim(),
    '',
  ];
  return lines.join('\n');
}

/**
 * 解析缓存文件；头缺失也照样把全文当正文（手改过的文件不该让面板 500）。
 *
 * @returns {{meta: Record<string, string>, text: string, hasHeader: boolean}}
 */
export function parseExplainFile(raw) {
  const source = String(raw ?? '').replace(/\r\n/g, '\n');
  const meta = {};
  if (!source.startsWith('---\n')) return { meta, text: source.trim(), hasHeader: false };
  const end = source.indexOf('\n---', 4);
  if (end < 0) return { meta, text: source.trim(), hasHeader: false };
  const header = source.slice(4, end);
  for (const line of header.split('\n')) {
    const cut = line.indexOf(':');
    if (cut <= 0) continue;
    const key = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    if (key !== '' && value !== '') meta[key] = value;
  }
  const body = source.slice(end + 4).replace(/^\n+/, '');
  return { meta, text: body.trim(), hasHeader: true };
}
