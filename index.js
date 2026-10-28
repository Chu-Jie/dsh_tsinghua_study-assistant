/**
 * 大学生学习辅助系统 · 宿主半边
 *
 * 导出形式（见 Harness 插件规范）：`apply(ctx, config)` + `inject` + `Config`。
 * 不引入任何第三方或 Harness 包：`ctx.tools.register` 只要求定义里带
 * `output.render` 函数（已核实 `dsh-tools` 的 register 实现），不需要 defineTool 的 marker。
 *
 * 本文件负责：
 *   1. 解析数据目录并初始化四份 JSON；
 *   2. 把 HTTP 接口注册到 DSH 自己的 Web 端口（不另起服务进程）；
 *   3. 注册 v0.1 的两个工具：study_status / study_overview。
 */

import os from 'node:os';
import path from 'node:path';

import { createStore } from './lib/store.js';
import { createApiHandler, API_PREFIX, REQUEST_HEADER } from './lib/api.js';
import { startLearnKeepAlive } from './lib/learn-keepalive.js';
import { createSpeechBridge } from './lib/lecture/asr.js';
import { createSummaryEngine } from './lib/lecture/summarize.js';
import { createLlmComplete, createSessionHandoff, resolveDefaultSelection } from './lib/lecture/llm.js';
import { buildOverview, activeTasks, currentTerm, DOC_KEYS, DOC_FILES } from './lib/core.js';

/** 插件在 Loader 里的行 id，与 cordis.patch.yml 保持一致。 */
export const name = 'study-assistant';

/** 缺少这些服务时插件不激活，而不是抛错（可选服务放 inject 的约定）。 */
export const inject = ['tools', 'webServer'];

/**
 * 行配置。
 *
 * cordis 通过 **Standard Schema** 接口读取配置：
 * `runtime.Config["~standard"].validate(rawConfig)` 必须**同步**返回
 * `{ value }` 或 `{ issues: [...] }`（已核实 cordis 的 resolveConfig 实现）。
 * 所以这里手写一个符合该规范的最小 schema，而不是引入 @deepseek-ai/schemastery，
 * 插件因此保持零外部依赖。
 */
/**
 * 数据目录的默认位置：用户主目录下的 `study-assistant-data/`。
 *
 * 旧版把默认值写死成作者本机的绝对路径，换台机器就必须改源码；现在按主目录推导，
 * 任何平台开箱可用。想在别处（例如落在作业工作区旁边）只需配 `dataDir`。
 */
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'study-assistant-data');

const CONFIG_FIELDS = {
  dataDir: {
    type: 'string',
    description: '数据目录的绝对路径，插件只读写这个目录。默认是主目录下的 study-assistant-data/。',
    fallback: DEFAULT_DATA_DIR,
  },
  backupKeep: {
    type: 'number',
    description: '每份数据文件保留的备份份数。',
    fallback: 10,
  },
  locale: {
    type: 'string',
    description: '界面语言（zh 或 en；v0.5 接入 locale 服务后生效）。',
    fallback: 'zh',
  },
  gpaMode: {
    type: 'string',
    description: '绩点制式：4.0-weighted（4.0 制加权）或 5.0-weighted。',
    fallback: '4.0-weighted',
  },
  studentName: {
    type: 'string',
    description: '学生本人姓名（改成你自己的）。听课提醒靠它的同音字做点名匹配，写错等于这个功能没用。',
    fallback: '示例同学',
  },
  studentNameVariants: {
    type: 'string',
    description: '姓名的其他常见写法，顿号或逗号分隔（如同音字、室友起的绰号）。语音识别写成这些时也算叫到你。',
    fallback: '',
  },
  studentId: {
    type: 'string',
    description: '学号。提交件归档只认「文件名同时含姓名与学号」的文件；留空则整个归档扫描不启用。',
    fallback: '',
  },
  workspaceRoot: {
    type: 'string',
    description: '作业工作区根目录（含各学科目录），留空时自动取 dataDir 的父目录。',
    fallback: '',
  },
  recordingDir: {
    type: 'string',
    description: '腾讯会议录音笔的录像根目录（每个场次一个子目录）；留空则不启用录音导入（默认关闭）。',
    fallback: '',
  },
};

/** 枚举型配置项的取值；不在此表内的字符串按键值错误处理。 */
const CONFIG_ENUMS = {
  locale: ['zh', 'en'],
  gpaMode: ['4.0-weighted', '5.0-weighted'],
};

function configIssues(raw) {
  const issues = [];
  if (raw === undefined || raw === null) return issues;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ message: '配置必须是一个对象' });
    return issues;
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CONFIG_FIELDS, key)) {
      issues.push({ message: `未知的配置项「${key}」`, path: [key] });
    }
  }
  if (raw.dataDir !== undefined && typeof raw.dataDir !== 'string') {
    issues.push({ message: 'dataDir 必须是字符串', path: ['dataDir'] });
  }
  if (raw.backupKeep !== undefined && (!Number.isInteger(raw.backupKeep) || raw.backupKeep < 0)) {
    issues.push({ message: 'backupKeep 必须是不小于 0 的整数', path: ['backupKeep'] });
  }
  if (raw.studentName !== undefined && (typeof raw.studentName !== 'string' || raw.studentName.trim() === '')) {
    issues.push({ message: 'studentName 必须是非空字符串', path: ['studentName'] });
  }
  if (raw.studentNameVariants !== undefined && typeof raw.studentNameVariants !== 'string') {
    issues.push({ message: 'studentNameVariants 必须是字符串（多个变体用顿号或逗号分隔）', path: ['studentNameVariants'] });
  }
  if (raw.studentId !== undefined && typeof raw.studentId !== 'string') {
    issues.push({ message: 'studentId 必须是字符串（不想用归档扫描就写空串）', path: ['studentId'] });
  }
  if (raw.workspaceRoot !== undefined && typeof raw.workspaceRoot !== 'string') {
    issues.push({ message: 'workspaceRoot 必须是字符串', path: ['workspaceRoot'] });
  }
  if (raw.recordingDir !== undefined && typeof raw.recordingDir !== 'string') {
    issues.push({ message: 'recordingDir 必须是字符串（不想用录音导入就写空串）', path: ['recordingDir'] });
  }
  for (const [key, allowed] of Object.entries(CONFIG_ENUMS)) {
    if (raw[key] !== undefined && !allowed.includes(raw[key])) {
      issues.push({ message: `${key} 只能是 ${allowed.join(' 或 ')}`, path: [key] });
    }
  }
  return issues;
}

/** 校验并补上默认值，返回归一化后的配置。 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = (key) => (typeof source[key] === 'string' && source[key].trim() !== '' ? source[key] : CONFIG_FIELDS[key].fallback);
  const enumerated = (key) => (CONFIG_ENUMS[key].includes(source[key]) ? source[key] : CONFIG_FIELDS[key].fallback);
  return {
    dataDir: text('dataDir'),
    backupKeep: Number.isInteger(source.backupKeep) && source.backupKeep >= 0
      ? source.backupKeep
      : CONFIG_FIELDS.backupKeep.fallback,
    locale: enumerated('locale'),
    gpaMode: enumerated('gpaMode'),
    studentName: text('studentName'),
    studentNameVariants: text('studentNameVariants'),
    studentId: text('studentId'),
    workspaceRoot: text('workspaceRoot'),
    // 这一项和别处不同：**显式写空串 = 关掉录音导入**，不写才用默认路径。
    // 所以不能走 `text()`（它把空串也当没填），得自己判一手。
    recordingDir: typeof source.recordingDir === 'string'
      ? source.recordingDir.trim()
      : CONFIG_FIELDS.recordingDir.fallback,
  };
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'study-assistant',
    validate(raw) {
      const issues = configIssues(raw);
      if (issues.length > 0) return { issues };
      return { value: normalizeConfig(raw) };
    },
  },
  /** 供插件页面与诊断使用的可读描述（非 Standard Schema 的一部分）。 */
  fields: CONFIG_FIELDS,
};

/** 统一的工具结果（工具必须返回 JSON 可序列化值，输出由 output.render 渲染）。 */
function toolResult(value) {
  return value;
}

/** 渲染工具输出为一行文本，供会话里显示。 */
function textRender(fn) {
  return (args, value) => {
    try {
      return [{ type: 'text', text: fn(args, value) }];
    } catch (error) {
      return [{ type: 'text', text: `渲染失败：${error?.message ?? 'unknown'}` }];
    }
  };
}

/**
 * 宿主插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{dataDir?: string, backupKeep?: number, locale?: string, gpaMode?: string, studentName?: string,
 *   studentNameVariants?: string, studentId?: string, workspaceRoot?: string, recordingDir?: string}} config
 */
export function apply(ctx, rawConfig = {}) {
  // cordis 已按 Config 归一化过；这里再兜一层，保证直接调用 apply 时也安全
  const config = normalizeConfig(rawConfig);
  const dataDir = path.resolve(config.dataDir);
  const backupKeep = config.backupKeep;
  const store = createStore(dataDir);

  // 语音转写桥：**故意不写进 `inject`**。
  //
  // `speechToText` 由可选的实验包 `@deepseek-ai/dsh-experimental-voice-input-bundle`
  // 提供，默认是关闭的。若把它列进 inject，实验包没启用时 cordis 会认为依赖缺失，
  // **整个学习台插件都不激活** —— 为了一个可选功能搭上全部功能，代价不对等。
  // 所以这里用 ctx.get() 惰性探测：拿不到就退化成「功能未就绪 + 引导文案」。
  const speech = createSpeechBridge({
    getService: () => ctx.get('speechToText'),
    logger: ctx.logger ?? console,
  });

  // 课后总结用的模型调用：同样**不写进 inject**（`llm` 虽然基本总在，但没必要时
  // 不拿整个插件的激活做赌注）。默认 provider/model 取用户当前选的，插件不自作主张。
  const complete = createLlmComplete({
    getLlm: () => ctx.get('llm'),
    getSelection: () => resolveDefaultSelection((key) => ctx.get(key)),
    logger: ctx.logger ?? console,
  });
  const summarizer = createSummaryEngine({
    complete,
    logger: ctx.logger ?? console,
  });
  // 课后「开一个新会话接着问」：走 sessionController（GUI 自己用的那套服务）
  const handoff = createSessionHandoff({
    getController: () => ctx.get('sessionController'),
    getSessions: () => ctx.get('sessions'),
    getTitle: () => ctx.get('sessionTitle'),
    getWorkspaceRegistry: () => ctx.get('workspaceRegistry'),
    logger: ctx.logger ?? console,
  });

  const handler = createApiHandler({
    store,
    dataDir,
    backupKeep,
    logger: ctx.logger ?? console,
    speech,
    summarizer,
    handoff,
    // 讲解通道复用同一个 `complete()`：宿主内模型调用，不另建一份
    complete,
    studentName: config.studentName,
    studentNameVariants: config.studentNameVariants,
    studentId: config.studentId,
    // 工作区根目录：默认取数据目录的父目录（`学习台` 的隔壁就是各学科目录）
    workspaceRoot: config.workspaceRoot === '' ? path.dirname(dataDir) : path.resolve(config.workspaceRoot),
    // 腾讯会议录音笔的录像根目录；空串表示用户关掉了录音导入
    recordingDir: config.recordingDir,
  });

  // 1) 数据目录与默认文档：首次使用时自动创建，不报错
  const ready = store.init().catch((error) => {
    ctx.logger?.error?.('[study-assistant] 数据目录初始化失败：', error);
    return { ok: false, dataDir, error: String(error?.message ?? error) };
  });

  // 2) HTTP 接口挂到 DSH 自己的 Web 端口
  //
  // 必须是 prefix，不能是 exact：
  //   dsh-host-webserver 的 match() 先查 exact 表（**精确匹配**），未命中才遍历
  //   prefix 表，且要求 pathname === prefix 或 pathname.startsWith(`${prefix}/`)。
  //   handler 内部按 `url.pathname.slice(API_PREFIX.length)` 分段路由，
  //   所以只要前缀注册一条 prefix 路由，下面所有子路径就都进来了。
  //
  // 踩过的坑：这里原先写成「前缀一条 exact + 6 条子路径各一条 exact」，
  // 后来 handler 里新增的 /learn/* 全部落在注册之外，真机访问拿到的是宿主对
  // 未注册路径的 404（JSON 客户端于是报「接口返回了非 JSON 内容（HTTP 404）」）。
  // 更糟的是 tests/host.test.js 当时把那份错清单写死成断言，反而锁住了缺陷；
  // 该用例现已改成从 handler 源码反推路由的契约测试。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'study-assistant: api route',
  );

  // 2.5) 网络学堂会话心跳
  //
  // 会话是「一段时间不操作就失效」的，而插件只有一张手动复制的 Cookie 快照。
  // 每 30 分钟用它请求一次学生端首页：还能用就刷新状态，失效了就立刻让
  // 「专用浏览器」自己走一次统一身份认证换张新的（见 lib/learn-browser.js）。
  // 心跳失败只记日志、绝不抛：宿主不该因为学校网站抽风而崩。
  //
  // 定时器放在这里而不是 createApiHandler 里：测试会反复调用它建 handler，
  // 写进去就等于每个用例留一个 interval。
  ctx.effect(() => {
    const keepAlive = startLearnKeepAlive({
      check: (reason) => handler.learn.checkNow(reason),
      logger: ctx.logger ?? console,
    });
    return () => keepAlive.stop();
  }, 'study-assistant: learn keep-alive');

  /** 读全部数据（工具与接口共用同一套结果）。 */
  async function loadAll() {
    await ready;
    return store.readAll();
  }

  // 3) 工具：数据健康
  ctx.effect(
    () => ctx.tools.register({
      name: 'study_status',
      description: '查看学习台数据的健康状况：数据目录、十一份 JSON（学期/课程/任务/成绩/作业/题目/知识点候选/知识点网络/知识点大纲/资料索引/资料分析）是否存在、是否有损坏或缺失。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            dataDir: { type: 'string' },
            healthy: { type: 'boolean' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  file: { type: 'string' },
                  exists: { type: 'boolean' },
                  ok: { type: 'boolean' },
                },
                required: ['key', 'file', 'exists', 'ok'],
                additionalProperties: true,
              },
            },
          },
          required: ['dataDir', 'healthy', 'files'],
          // ⚠️ 必须为 true。工具输出有两道关卡，我先后各踩了一次：
          //   1) 注册时 assertSupportedJsonSchema —— 拒绝 type 数组
          //      （`type: ['string','null']` 曾让整个 DSH 启动失败）；
          //   2) 执行后 validateJsonSchemaValue —— 按 output.schema 校验返回值，
          //      实测报过 `"value.version" is not a declared property (additionalProperties: false)`。
          // 结论：**只声明界面/渲染真正用到的字段，其余一律放行**。
          // store.health() 还会返回 version / hash / reason / bytes 等（值可为 null），
          // 它们都不在 properties 里，由 additionalProperties 放行。
          additionalProperties: true,
        },
        render: textRender((args, value) => {
          const lines = [`数据目录：${value.dataDir}`, `总体状态：${value.healthy ? '正常' : '有问题'}`];
          for (const item of value.files) {
            const mark = item.ok ? '✓' : '✗';
            // bytes / reason 不在 schema 的 properties 里（可空），所以两者都要容忍
            const size = item.bytes === null || item.bytes === undefined ? '—' : `${item.bytes} 字节`;
            const why = item.reason === null || item.reason === undefined ? '' : ` — ${item.reason}`;
            lines.push(`${mark} ${item.file}（${size}）${why}`);
          }
          return lines.join('\n');
        }),
      },
      async execute() {
        await ready;
        const health = await store.health();
        return toolResult(health);
      },
    }),
    'study-assistant: tool study_status',
  );

  // 4) 工具：概览（与面板「今日」页共用 buildOverview，保证两边一致）
  ctx.effect(
    () => ctx.tools.register({
      name: 'study_overview',
      description: '读取学习台概览：当前学期与教学周、今日课程、最近截止的任务、逾期数量、当前 GPA。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            overview: { type: 'object', additionalProperties: true },
            counts: { type: 'object', additionalProperties: true },
            problems: { type: 'array', items: { type: 'object', additionalProperties: true } },
            // ⚠️ term **刻意不声明**：它在「还没有设置学期」时是 null，而 schema
            //    不能用 type 数组表达可空，声明成 { type: 'object' } 又会被
            //    validateJsonSchemaValue 判为 `"value.term" must be an object`（本地实测过）。
            //    正确做法就是不给它声明，由 additionalProperties: true 放行，
            //    渲染侧自己判 null（见下面 render 的 `overview.term === null` 分支）。
          },
          required: ['overview', 'counts', 'problems'],
          additionalProperties: true,
        },
        render: textRender((args, value) => {
          const { overview } = value;
          const lines = [];
          if (overview.term === null) {
            lines.push('还没有设置学期。');
          } else if (overview.inTerm) {
            lines.push(`${overview.term.name}：第 ${overview.week} 教学周，${overview.date}（${overview.weekdayName}）`);
          } else {
            lines.push(`${overview.term.name}：${overview.termState === 'before-term' ? '尚未开学' : '已放假'}（${overview.date}）`);
          }
          lines.push(`课程 ${value.counts.courses} 门，未完成任务 ${value.counts.activeTasks} 个，逾期 ${overview.overdueCount} 个`);
          if (overview.todayCourses.length > 0) {
            lines.push('今日课程：');
            for (const course of overview.todayCourses) {
              const period = course.startPeriod === null ? '' : `第 ${course.startPeriod}${course.endPeriod && course.endPeriod !== course.startPeriod ? `-${course.endPeriod}` : ''} 节`;
              lines.push(`  · ${course.name} ${period} ${course.location}`.trimEnd());
            }
          } else {
            lines.push('今日没有课。');
          }
          if (overview.upcoming.length > 0) {
            lines.push('临近截止：');
            const label = { overdue: '已逾期', today: '今天', soon: '即将', later: '之后', unknown: '无日期' };
            for (const task of overview.upcoming) {
              const when = task.days === null ? '' : task.days < 0 ? `逾期 ${-task.days} 天` : task.days === 0 ? '今天' : `还有 ${task.days} 天`;
              lines.push(`  · [${label[task.level] ?? task.level}] ${task.title} — ${task.due ?? '无截止日'} ${when}`.trimEnd());
            }
          }
          lines.push(`GPA：${overview.gpa.gpa === null ? '暂无成绩' : `${overview.gpa.gpa}（${overview.gpa.credits} 学分）`}`);
          if (value.problems.length > 0) {
            lines.push(`数据问题：${value.problems.map((p) => `${p.key}:${p.reason}`).join('、')}`);
          }
          return lines.join('\n');
        }),
      },
      async execute() {
        const all = await loadAll();
        const overview = buildOverview(all.docs, new Date());
        return toolResult({
          overview,
          counts: {
            courses: Array.isArray(all.docs.courses?.courses) ? all.docs.courses.courses.length : 0,
            activeTasks: activeTasks(all.docs.tasks).length,
            terms: Array.isArray(all.docs.term?.terms) ? all.docs.term.terms.length : 0,
          },
          term: currentTerm(all.docs.term),
          problems: all.problems,
        });
      },
    }),
    'study-assistant: tool study_overview',
  );

  ctx.logger?.info?.(`[study-assistant] 已就绪：数据目录 ${dataDir}，接口 ${API_PREFIX}，请求头 ${REQUEST_HEADER}`);
  return { dataDir, apiPrefix: API_PREFIX, docs: DOC_KEYS, files: DOC_FILES };
}
