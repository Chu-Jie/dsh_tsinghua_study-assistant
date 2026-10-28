/**
 * 宿主 index.js 集成测试（零依赖）
 * 运行：node tests/host.test.js
 *
 * 这是安装前最有价值的一道关：用一个假的 Cordis ctx 真跑一遍 apply()，
 * 验证 4 个事件类事实：
 *   1. 路由与工具确实注册到了 ctx 上（数量与名字正确）；
 *   2. 工具定义满足 ctx.tools.register 的硬性要求（output.render 是函数）；
 *   3. 工具真的能执行并返回真实数据（在临时数据目录上）；
 *   4. apply 返回的清理函数可调用，卸载不抛错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { apply, Config, name, inject } from '../index.js';
import { API_PREFIX, REQUEST_HEADER } from '../lib/api.js';
import { makeTempDir, removeTempDir } from './_tmpdir.js';

// ---------------------------------------------------------------------------
// JSON Schema 子集校验（照抄 dsh-tools 的 assertSupportedJsonSchema 规则）
//
// 为什么必须有它：`ctx.tools.register` 会调用 assertSupportedJsonSchema，
// 而它**拒绝 type 数组**。我原先在工具输出 schema 里写了
// `type: ['string','null']`，tests/host.test.js 只检查了 output.render 是函数、
// 没跑这个校验器，于是缺陷漏过全部测试，直到 DSH 真启动才炸：
//
//   JsonSchemaError: schema.properties.files.items.properties.reason.type
//     must be a single type string (type arrays are not supported)
//
// 插件是 required，所以这一次注册失败直接让整个 DSH 启动失败、桌面端进安全模式。
// 下面这份校验器就是让同样的错误在测试阶段被拦住。
// ---------------------------------------------------------------------------

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'default', 'examples']);
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);

/** 走一遍 schema 树，返回全部违规说明（与 dsh-tools 的报错文案一致）。 */
function collectSchemaViolations(root) {
  const violations = [];
  const tasks = [{ node: root, path: 'schema' }];
  const seen = new Set();

  while (tasks.length > 0) {
    const { node, path } = tasks.pop();
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${path} must be a schema object`);
      continue;
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`);
      continue;
    }
    seen.add(node);

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }

    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`);
      continue;
    }
    if (!hasType && !hasOneOf) continue;

    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`);
      } else {
        node.oneOf.forEach((entry, index) => tasks.push({ node: entry, path: `${path}.oneOf[${index}]` }));
      }
      continue;
    }

    const type = node.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      // 这一行就是这次线上事故的判定点
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
      continue;
    }

    // 关键字只能出现在允许的类型上
    for (const [key, types] of Object.entries({
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    })) {
      if (Object.hasOwn(node, key) && !types.includes(type)) {
        violations.push(`${path}.${key} is not supported on type "${type}"`);
      }
    }

    if (type === 'object') {
      const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined;
      if (Object.hasOwn(node, 'required')) {
        const required = node.required;
        if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${path}.required must be an array of strings`);
        } else {
          const declared = properties !== null && typeof properties === 'object' ? properties : {};
          for (const key of required) {
            if (!Object.hasOwn(declared, key)) {
              violations.push(`${path}.required names "${key}" which is not in properties`);
            }
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`);
      }
      if (properties !== null && typeof properties === 'object') {
        for (const [key, value] of Object.entries(properties)) {
          tasks.push({ node: value, path: `${path}.properties.${key}` });
        }
      }
    }

    if (type === 'array' && Object.hasOwn(node, 'items')) {
      tasks.push({ node: node.items, path: `${path}.items` });
    }
  }

  return violations;
}

/** 构建一个假 ctx，记录所有注册。 */
function makeCtx() {
  const state = { routes: [], tools: [], effects: [], logs: [] };
  const ctx = {
    logger: {
      info: (...args) => state.logs.push(['info', ...args]),
      error: (...args) => state.logs.push(['error', ...args]),
    },
    effect(callback, label) {
      const dispose = callback();
      state.effects.push({ label, dispose });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    webServer: {
      register(route) {
        state.routes.push(route);
        return () => {
          state.routes = state.routes.filter((r) => r !== route);
        };
      },
    },
    tools: {
      register(definition) {
        // 与真 ctx 对齐：dsh-tools 的 register 会先校验 schema 再插入
        const violations = collectSchemaViolations(definition.output?.schema ?? {});
        if (violations.length > 0) {
          throw new Error(`JsonSchemaError: unsupported JSON schema: ${violations.join('; ')}`);
        }
        state.tools.push(definition);
        return () => {
          state.tools = state.tools.filter((d) => d !== definition);
        };
      },
    },
  };
  return { ctx, state };
}

async function withTempDataDir(run) {
  const dir = await makeTempDir('study-assistant-host-');
  try {
    return await run(dir);
  } finally {
    await removeTempDir(dir);
  }
}

test('导出形式：apply / name / inject / Config 齐备', () => {
  assert.equal(typeof apply, 'function');
  assert.equal(name, 'study-assistant');
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes('tools'));
  assert.ok(inject.includes('webServer'));
  assert.ok(Config['~standard']);
});

test('apply：注册一条 prefix 路由，覆盖 handler 实现的全部子路径', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    apply(ctx, { dataDir: dir, backupKeep: 2 });

    assert.equal(state.routes.length, 1, '只应注册一条路由（前缀本身）');
    for (const route of state.routes) {
      // 必须是 prefix：exact 是精确匹配，子路径根本进不来（真机会 404）
      assert.equal(route.kind, 'prefix', '路由必须是 prefix 类型');
      assert.equal(route.path, API_PREFIX);
      assert.equal(typeof route.handler, 'function', '路由必须带 handler');
    }

    // 契约测试：从 handler 源码里反推它实际实现了哪些路径，
    // 再断言每一条都被已注册的路由覆盖。
    //
    // 这条断言防的是**真机 404**：这个用例原先把注册清单写死成 6 条 exact 路径，
    // 于是在 handler 里新增 /learn/* 不会让任何测试变红，而真机访问
    // /api/study-assistant/learn/status 拿到的是宿主对「未注册路径」的 404
    // （客户端把非 JSON 的 404 报成「接口返回了非 JSON 内容（HTTP 404）」）。
    // 把清单改成从源码反推，以后再加路由就会自动被要求一起注册。
    const source = await fs.readFile(path.join(import.meta.dirname, '..', 'lib', 'api.js'), 'utf8');
    // handler 里的 rest 是**相对 API_PREFIX** 的（`rest === '/health'`），
    // 而注册路由的 path 是**绝对**的，所以此处要补回前缀再比。
    const implemented = [...source.matchAll(/rest === '([^']+)'/g)].map((match) => match[1]);
    assert.ok(implemented.length >= 10, `handler 里应能抽出足够多的路由，实际 ${implemented.length} 条`);
    for (const relativePath of implemented) {
      const handlerPath = `${API_PREFIX}${relativePath}`;
      const covered = state.routes.some((route) => (route.kind === 'prefix'
        ? handlerPath === route.path || handlerPath.startsWith(`${route.path}/`)
        : handlerPath === route.path));
      assert.ok(covered, `handler 实现了 ${handlerPath}，但没有任何已注册路由覆盖它（真机会 404）`);
    }
    // 反向确认：网络学堂这几条（正是真机报 404 的那些）确实在契约范围里
    assert.ok(implemented.includes('/learn/status'), 'handler 应实现 /learn/status');
    assert.ok(implemented.includes('/learn/semester'), 'handler 应实现 /learn/semester');
  });
});

test('apply：注册两个工具，定义满足 ctx.tools.register 的硬性要求', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    apply(ctx, { dataDir: dir, backupKeep: 2 });

    const names = state.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['study_overview', 'study_status']);

    for (const tool of state.tools) {
      assert.equal(typeof tool.description, 'string', `${tool.name} 需要 description`);
      assert.equal(typeof tool.parameters, 'object', `${tool.name} 需要 parameters`);
      assert.equal(tool.parameters.type, 'object');
      // ctx.tools.register 会强制检查这个函数存在
      assert.equal(typeof tool.output?.render, 'function', `${tool.name} 的 output.render 必须是函数`);
      assert.equal(typeof tool.output?.schema, 'object', `${tool.name} 的 output.schema 必须存在`);
      assert.equal(typeof tool.execute, 'function', `${tool.name} 需要 execute`);
    }
  });
});

test('工具 schema 必须在 dsh-tools 的受支持子集内（这一条防的是 DSH 启动失败）', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    // makeCtx 的 tools.register 会像真 ctx 一样先校验 schema；
    // 因此这一行不抛，本身就说明两个工具的 schema 都合法。
    apply(ctx, { dataDir: dir, backupKeep: 2 });

    assert.equal(state.tools.length, 2, '两个工具都应通过 schema 校验');
    for (const tool of state.tools) {
      assert.deepEqual(collectSchemaViolations(tool.output.schema), [], `${tool.name} 的输出 schema 有违规`);
      assert.deepEqual(collectSchemaViolations(tool.parameters), [], `${tool.name} 的参数 schema 有违规`);
      const text = JSON.stringify({ parameters: tool.parameters, output: tool.output.schema });
      assert.equal(/"type"\s*:\s*\[/.test(text), false, `${tool.name} 的 schema 里不应出现 type 数组`);
    }
  });
});

test('工具返回值必须通过 output.schema 校验，render 不抛（第二道关卡）', async () => {
  // 工具 schema 有**两道**关卡，我先后各踩了一次：
  //   1) 注册时 assertSupportedJsonSchema —— 拒绝 type 数组
  //      （`type: ['string','null']` 曾让整个 DSH 启动失败、桌面端进安全模式）；
  //   2) 执行后 validateJsonSchemaValue —— 按 output.schema 校验返回值
  //      （实测报过 `"value.version" is not a declared property` 与 `"value.term" must be an object`）。
  //
  // 第 1 道由本文件上面的照抄校验器覆盖；第 2 道交给
  // tools/verify-tool-output.mjs —— 它**直接加载生产版** validateJsonSchemaValue，
  // 比在这里再抄一份规则可靠。这里只跑它并断言退出码。
  const toolOutputCheck = path.join(import.meta.dirname, '..', 'tools', 'verify-tool-output.mjs');
  if (!existsSync(toolOutputCheck)) {
    assert.fail('缺少 tools/verify-tool-output.mjs（生产版输出校验）');
  }
  const result = spawnSync(process.execPath, [toolOutputCheck], { encoding: 'utf8' });
  assert.equal(result.status, 0,
    `verify-tool-output.mjs 未通过：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /7 项通过，0 项失败/, '输出校验应报告 7 项全过');
});

test('Schema 校验器自身有效：能识别出类型数组（本次启动失败的成因）', () => {
  // 正例：合法子集
  assert.deepEqual(collectSchemaViolations({
    type: 'object',
    properties: {
      name: { type: 'string' },
      n: { type: 'number' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['name'],
    additionalProperties: false,
  }), []);

  // 反例 1：type 数组 —— 正是让 DSH 启动失败的那种写法
  const typeArray = collectSchemaViolations({
    type: 'object',
    properties: { reason: { type: ['string', 'null'] } },
  });
  assert.equal(typeArray.length, 1);
  assert.match(typeArray[0], /must be a single type string \(type arrays are not supported\)/);

  // 反例 2：required 指了没声明的属性
  assert.match(
    collectSchemaViolations({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })[0],
    /required names "b" which is not in properties/,
  );
  // 反例 3：关键字用在错误的类型上
  assert.match(
    collectSchemaViolations({ type: 'string', properties: {} })[0],
    /properties is not supported on type "string"/,
  );
  // 反例 4：未知关键字
  assert.match(collectSchemaViolations({ type: 'string', anyOf: [] })[0], /is not a supported keyword/);
  // 反例 5：additionalProperties 非布尔
  assert.match(
    collectSchemaViolations({ type: 'object', additionalProperties: 'yes' })[0],
    /additionalProperties must be a boolean/,
  );
  // 反例 6：type 与 oneOf 同时声明
  assert.match(
    collectSchemaViolations({ type: 'object', oneOf: [{ type: 'string' }, { type: 'number' }] })[0],
    /cannot declare both type and oneOf/,
  );
});

test('study_status 工具：真实执行并返回数据健康', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    apply(ctx, { dataDir: dir, backupKeep: 2 });
    const tool = state.tools.find((t) => t.name === 'study_status');

    const value = await tool.execute({}, {});
    assert.equal(value.healthy, true, '刚初始化后应当健康');
    assert.equal(value.dataDir, dir);
    // 四份学习数据 + 作业流 + 三份取字产物（资料索引 / 题目 / 知识点候选）+ 知识网络
    assert.equal(value.files.length, 11);
    for (const file of value.files) {
      assert.equal(file.ok, true, `${file.file} 应可读`);
      assert.equal(file.exists, true);
    }

    // 渲染函数必须产出文本内容
    const rendered = tool.output.render({}, value);
    assert.ok(Array.isArray(rendered) && rendered.length > 0);
    assert.equal(rendered[0].type, 'text');
    assert.ok(rendered[0].text.includes('总体状态：正常'));
  });
});

test('study_overview 工具：真实执行并返回概览与计数', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    apply(ctx, { dataDir: dir, backupKeep: 2 });
    const tool = state.tools.find((t) => t.name === 'study_overview');

    // 空数据时不崩
    const empty = await tool.execute({}, {});
    assert.equal(empty.counts.courses, 0);
    assert.equal(empty.counts.activeTasks, 0);
    assert.equal(empty.overview.term, null);
    assert.equal(empty.overview.gpa.gpa, null);
    const emptyText = tool.output.render({}, empty)[0].text;
    assert.ok(emptyText.includes('还没有设置学期'));

    // 通过接口写入数据后，工具应读到同样的内容
    const { createStore } = await import('../lib/store.js');
    const store = createStore(dir);
    const termRead = await store.readDocument('term');
    await store.writeDocument('term', {
      ...termRead.doc,
      terms: [{ id: 's1', name: '2026 秋', startDate: '2026-09-07', endDate: '2026-12-27', totalWeeks: 16, isCurrent: true }],
      currentId: 's1',
    }, { expectedHash: termRead.hash, backupKeep: 2 });

    const coursesRead = await store.readDocument('courses');
    await store.writeDocument('courses', {
      ...coursesRead.doc,
      courses: [{ id: 'c1', name: '数据结构', credits: 4, sessions: [{ weekday: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16', location: 'A101' }] }],
    }, { expectedHash: coursesRead.hash, backupKeep: 2 });

    const gradesRead = await store.readDocument('grades');
    await store.writeDocument('grades', {
      ...gradesRead.doc,
      courses: [{ courseId: 'c1', score: 90, credit: 4 }],
    }, { expectedHash: gradesRead.hash, backupKeep: 2 });

    const value = await tool.execute({}, {});
    assert.equal(value.counts.courses, 1);
    assert.equal(value.counts.terms, 1);
    assert.equal(value.term.name, '2026 秋');
    assert.equal(value.overview.gpa.gpa, 4);
    assert.deepEqual(value.problems, [], '数据写入后不应有缺失问题');
  });
});

test('apply：清理函数可调用，卸载不抛错', async () => {
  await withTempDataDir(async (dir) => {
    const { ctx, state } = makeCtx();
    apply(ctx, { dataDir: dir, backupKeep: 2 });
    assert.ok(state.effects.length >= 3, '应注册多项 effect');
    for (const { dispose } of state.effects) {
      assert.equal(typeof dispose, 'function', '每个 effect 都应返回清理函数');
      dispose();
    }
    assert.equal(state.routes.length, 0, '清理后路由应被移除');
    assert.equal(state.tools.length, 0, '清理后工具应被移除');
  });
});

test('apply：直接传入空配置也能回落到默认数据目录而不抛错', async () => {
  const { ctx, state } = makeCtx();
  // 不传 dataDir，应回落到 Config 的默认值；这里只验证不抛错且注册完成
  apply(ctx, {});
  assert.ok(state.routes.length > 0);
  assert.ok(state.tools.length > 0);
  for (const { dispose } of state.effects) dispose();
});

test('apply：数据目录不可写时报错被捕获，不把异常抛给宿主', async () => {
  const { ctx, state } = makeCtx();
  // 用一个非法路径（Windows 下包含 NUL 字符）触发失败
  const badDir = 'Z:\\definitely-not-a-drive\\学习台\u0000';
  apply(ctx, { dataDir: badDir, backupKeep: 1 });
  // 初始化是异步的，等一下让 catch 分支跑到
  await new Promise((resolve) => setTimeout(resolve, 60));
  const tool = state.tools.find((t) => t.name === 'study_status');
  const value = await tool.execute({}, {});
  assert.equal(value.healthy, false, '不可写目录应报告不健康而不是抛异常');
  for (const { dispose } of state.effects) dispose();
});
