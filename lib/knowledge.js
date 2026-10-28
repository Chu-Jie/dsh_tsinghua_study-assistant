/**
 * 知识点网络：把「候选」（取字批次产出的 `知识点候选.json`）织成「网络节点」（`知识点网络.json`）。
 *
 * 为什么单独一层：候选是流水线写的批处理结果（同名可能在不同批次里重复出现、没有 id、没有掌握度），
 * 网络是**面板上能点的人看的数据**（有稳定 id、有掌握度/重点、能挂证据）。两者之间需要一个
 * 确定性的合并步骤，而且必须是纯函数——同一份输入跑两次得到同一份输出，才谈得上「重跑安全」。
 *
 * 设计取舍：
 * - **id 由内容派生**（`k_` + 课程与名字的短哈希），不靠随机数 ⇒ 重跑不会复制出第二个「循环队列」。
 * - **只增不夺**：掌握度、重点、备注、最近复习时间这些「人写下的东西」一律不覆盖；合并只做
 *   「补空字段 + 并集证据 + 别名去重」。
 * - 候选里没写 `chapter` 的，节点就留空章——面板会归到「未分章」，比瞎猜一章诚实。
 */
import crypto from 'node:crypto';

/** 与 `lib/api.js` 的 `KNOWLEDGE_MASTERY_MAX` 同口径（四档 0–3）。 */
export const MASTERY_MAX = 3;

/** 每条节点最多挂多少条证据（与 API 的 normalizeKnowledgeEvidence 一致）。 */
export const MAX_EVIDENCE = 24;

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 知识点名字的归一化键：全半角空白折叠、大小写不敏感（「TCP 协议」与「tcp 协议」算一个）。 */
export function knowledgeKey(name) {
  return String(name ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 由内容派生稳定 id：同一门课 + 同一个名字永远得到同一个 id。 */
export function knowledgeId(courseId, name) {
  const digest = crypto
    .createHash('sha1')
    .update(`${courseId ?? ''}\u0000${knowledgeKey(name)}`, 'utf8')
    .digest('hex');
  return `k_${digest.slice(0, 10)}`;
}

function normalizeAliases(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = cleanText(raw, 60);
    if (text === '') continue;
    const key = knowledgeKey(text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

/** 证据归一化 + 按内容去重（同一道题/同一页引文只留一条）。 */
export function normalizeEvidenceEntries(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const type = cleanText(raw.type, 20);
    if (type === '') continue;
    const entry = { type };
    if (typeof raw.id === 'string' && raw.id !== '') entry.id = raw.id.slice(0, 80);
    if (typeof raw.file === 'string' && raw.file !== '') entry.file = raw.file.slice(0, 220);
    const page = Number(raw.page);
    if (Number.isInteger(page) && page > 0) entry.page = page;
    if (typeof raw.quote === 'string' && raw.quote.trim() !== '') entry.quote = raw.quote.trim().slice(0, 200);
    if (entry.id === undefined && entry.file === undefined) continue;
    const key = JSON.stringify([entry.type, entry.id ?? '', entry.file ?? '', entry.page ?? 0, entry.quote ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/** 把节点里已有的证据与新增证据合并：已有的在前，新证据补到后面，总量封顶。 */
function mergeEvidence(existing, incoming) {
  return normalizeEvidenceEntries([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
}

/**
 * 织网：候选 → 网络节点。
 *
 * @param {object} input
 * @param {object} input.network    现有 `知识点网络.json`
 * @param {object} input.candidates `知识点候选.json`
 * @param {object} [input.questions] `题目.json`（用于把「名字对得上的题」补成证据）
 * @param {object} [input.courses]  `课程.json`（用于校验 courseId 与给默认章）
 * @param {string} [input.now]      ISO 时间，测试注入
 * @returns {{network: object, stats: object, details: object}}
 */
export function weaveCandidates({ network, candidates, questions, courses, now } = {}) {
  const source = network && typeof network === 'object' ? network : {};
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.filter((node) => node !== null && typeof node === 'object' && !Array.isArray(node))
    : [];
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const courseIds = new Set(
    (Array.isArray(courses?.courses) ? courses.courses : [])
      .map((course) => (course && typeof course === 'object' ? course.id : null))
      .filter((id) => typeof id === 'string' && id !== ''),
  );
  const timestamp = typeof now === 'string' && now !== '' ? now : new Date().toISOString();

  // 建索引：名字 / 别名 → 节点下标（同一门课内才互认）。
  const byName = new Map();
  nodes.forEach((node, index) => {
    const courseId = typeof node.courseId === 'string' && node.courseId !== '' ? node.courseId : null;
    if (node.name) byName.set(`${courseId ?? ''}\u0000${knowledgeKey(node.name)}`, index);
    for (const alias of Array.isArray(node.aliases) ? node.aliases : []) {
      const key = `${courseId ?? ''}\u0000${knowledgeKey(alias)}`;
      if (!byName.has(key)) byName.set(key, index);
    }
  });

  const questionList = Array.isArray(questions?.questions) ? questions.questions : [];
  const candidateList = Array.isArray(candidates?.candidates) ? candidates.candidates : [];
  const stats = { candidates: candidateList.length, created: 0, merged: 0, unchanged: 0, skipped: 0, evidenceAdded: 0 };
  const details = { created: [], merged: [], skipped: [] };

  for (const candidate of candidateList) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      stats.skipped += 1;
      continue;
    }
    const name = cleanText(candidate.name, 120);
    if (name === '') {
      stats.skipped += 1;
      details.skipped.push({ name: '', reason: 'name-required' });
      continue;
    }
    const rawCourse = typeof candidate.courseId === 'string' && candidate.courseId !== '' ? candidate.courseId : null;
    // 课程认不出就当「无课程」，不硬塞到某门课里（宁可少归一处，不要错归）。
    const courseId = rawCourse !== null && (courseIds.size === 0 || courseIds.has(rawCourse)) ? rawCourse : null;
    const key = `${courseId ?? ''}\u0000${knowledgeKey(name)}`;

    // 候选自己的证据 + 名字对得上的题（题侧课程为空时放宽，与镜像导出的口径一致）。
    const evidence = normalizeEvidenceEntries(candidate.evidence);
    for (const question of questionList) {
      if (question === null || typeof question !== 'object') continue;
      const names = Array.isArray(question.knowledgeNames) ? question.knowledgeNames : [];
      if (!names.some((item) => knowledgeKey(item) === knowledgeKey(name))) continue;
      const questionCourse = typeof question.courseId === 'string' && question.courseId !== '' ? question.courseId : null;
      if (questionCourse !== null && courseId !== null && questionCourse !== courseId) continue;
      if (typeof question.id === 'string' && question.id !== '') evidence.push({ type: 'question', id: question.id });
    }

    const aliases = normalizeAliases(candidate.aliases);
    const chapter = cleanText(candidate.chapter, 120);
    const section = cleanText(candidate.section, 120);
    // 查找顺序：同课程同名 → 「没有课程的」同名节点（面板手建的节点常常没选课程）。
    // 后者命中时把课程补上——空字段被填满是「只增不夺」，不算覆盖人的选择。
    let existingIndex = byName.has(key) ? byName.get(key) : -1;
    let adoptCourse = false;
    if (existingIndex < 0 && courseId !== null) {
      const loose = `\u0000${knowledgeKey(name)}`;
      if (byName.has(loose)) {
        existingIndex = byName.get(loose);
        adoptCourse = true;
      }
    }

    if (existingIndex >= 0) {
      const existing = nodes[existingIndex];
      const beforeAliases = Array.isArray(existing.aliases) ? existing.aliases : [];
      const beforeEvidence = Array.isArray(existing.evidence) ? existing.evidence : [];
      const mergedAliases = normalizeAliases([...beforeAliases, name, ...aliases]).filter((alias) => knowledgeKey(alias) !== knowledgeKey(existing.name));
      const mergedEvidence = mergeEvidence(beforeEvidence, evidence);
      const nextChapter = cleanText(existing.chapter, 120) || chapter;
      const nextSection = cleanText(existing.section, 120) || section;
      const nextCourse = adoptCourse ? courseId : existing.courseId ?? null;
      const changed = mergedAliases.length !== beforeAliases.length
        || mergedEvidence.length !== beforeEvidence.length
        || nextChapter !== (existing.chapter ?? '')
        || nextSection !== (existing.section ?? '')
        || nextCourse !== (existing.courseId ?? null);
      if (!changed) {
        stats.unchanged += 1;
        continue;
      }
      nodes[existingIndex] = {
        ...existing,
        courseId: nextCourse,
        chapter: nextChapter,
        section: nextSection,
        aliases: mergedAliases,
        evidence: mergedEvidence,
      };
      stats.merged += 1;
      stats.evidenceAdded += mergedEvidence.length - beforeEvidence.length;
      details.merged.push({ id: existing.id ?? null, name: existing.name ?? name, added: mergedEvidence.length - beforeEvidence.length });
      // 新名字也进索引（同一个候选可能用别名再出现一次）
      byName.set(key, existingIndex);
      continue;
    }

    const node = {
      id: knowledgeId(courseId, name),
      name,
      courseId,
      chapter,
      section,
      aliases,
      mastery: 0,
      marked: false,
      reviewedAt: null,
      note: '',
      evidence: mergeEvidence([], evidence),
      createdAt: timestamp,
    };
    // id 撞车（理论上只有哈希前 10 位相同时才会）就顺延，别让两个节点共用一个 id。
    const usedIds = new Set(nodes.map((item) => item.id));
    if (usedIds.has(node.id)) {
      let suffix = 2;
      while (usedIds.has(`${node.id}-${suffix}`)) suffix += 1;
      node.id = `${node.id}-${suffix}`;
    }
    nodes.push(node);
    byName.set(key, nodes.length - 1);
    stats.created += 1;
    stats.evidenceAdded += node.evidence.length;
    details.created.push({ id: node.id, name, courseId, chapter });
  }

  stats.skipped = candidateList.length - stats.created - stats.merged - stats.unchanged;
  const changed = stats.created > 0 || stats.merged > 0;
  return {
    network: {
      ...source,
      version: 1,
      nodes,
      edges,
      updatedAt: changed ? timestamp : source.updatedAt ?? null,
    },
    stats,
    details,
    changed,
  };
}
