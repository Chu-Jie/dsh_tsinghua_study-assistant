# 学习辅助 / dsh-study-assistant

> 一个面向大学生的 DSH（DeepSeek Harness）插件：把**课表、DDL、成绩与 GPA、课程资料、知识点网络**收进一个面板，
> 同时把同样的能力暴露成会话工具和一条只监听本机回环的 HTTP 接口。

写它的动机很朴素：一个学期的信息散在教务系统、网络学堂、课件 PDF、教师群里，
**每周真正要回答的问题只有三个**——今天上什么课、哪些 DDL 快到了、这门课我到底掌握了多少。
这个插件把这三件事放在一个界面里，并用同一份数据支撑「让 agent 帮你做作业」这件事。

- 插件 id / 接口前缀：`study-assistant` / `/api/study-assistant`
- 面板名（中文）：**大学生学习辅助系统**；侧栏标签「学习辅助」
- 仓库：<https://github.com/Chu-Jie/dsh_tsinghua_study-assistant>
- 许可：MIT；**运行时零 npm 依赖**（唯一第三方代码是随仓库携带的 PDF.js，见 `THIRD_PARTY_NOTICES.md`）
- Node：`>= 22`

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 七页签主面板 | 今日 / 课表 / DDL / 成绩 / 资料 / 知识点 / 设置，样式只吃 DSH 主题令牌，跟随明暗主题 |
| 课表与教学周 | 按学期配置周次，自动换算「第几周 / 单双周 / 今天第几节」 |
| DDL 汇总 | 任务带截止时间、紧急度、完成态；支持按学科、状态、紧急度筛选与快捷录入 |
| 成绩与 GPA | 4.0 制加权 / 5.0 制加权两种制式，可设目标 GPA 反推「还需要考多少」 |
| 网络学堂同步 | 手动触发：粘贴一次 Cookie → 预览 → 导入，把平台作业变成 DDL；只做单向状态升级 |
| 课堂听课提醒 | 把课堂音频切片喂给语音识别，命中本人姓名（含可配置的多种写法）时提醒，并把课堂笔记落到学科目录 |
| 课程资料检索 | 为教材/课件/作业建索引，按页读正文（扫描件走 OCR 产物），面板内直接读 |
| 知识点网络 | 候选 → 织网 → 节点（掌握度 / 重点 / 大纲挂靠 / 证据），导出成笔记镜像 |
| 知识点讲解与问答 | 每个知识点可按三种档位生成讲解（助教推导 / 考前速通 / 只给提示），并围绕该节点的证据自带问答 |
| 提交件归档 | 扫描各学科 `提交文件/`，**只有当文件名同时含姓名与学号**才把任务归档；交付解答不算归档 |
| 全量备份与恢复 | 十一份 JSON 打成一个带 sha256 校验和的包，恢复时先验包再逐份校验，任一份不合法整批不写 |
| 会话工具 | `study_status`（数据健康）、`study_overview`（当前学期/今日课程/临近 DDL/GPA） |

页面与接口共用同一套数据层，因此 **agent 在会话里改的和面板上看到的永远是同一份数据**。

---

## 安装

### 前置

- DSH 桌面端或等价宿主（`ctx.webServer` / `ctx.tools` / `ctx.effect` 可用），Node `>= 22`。
- 不需要 `npm install`：仓库没有任何运行时依赖，`tests/` 用 Node 内置 `node:test`。

### 方式一：`link:` 装进 profile（开发时推荐）

把仓库直接链进你在用的 DSH profile，改源码后**重启 DSH + 刷新页面**即生效，没有构建步骤：

```bash
# 以 DSH profile 目录为准，示例路径
cd <DSH profile 目录>
npm install "link:<本仓库绝对路径>"
```

profile 的插件清单里会出现一条 `dsh-study-assistant` 指向本仓库（`package.json` 的 `name`，也是 `cordis.patch.yml` 里 `name` 的取值）。

### 方式二：用 `cordis.patch.yml` 声明装载

仓库自带 `cordis.patch.yml`，把插件插进 profile 的配置链：

```yaml
- insert:
    - id: study-assistant
      name: 'dsh-study-assistant'
      config:
        locale: zh
        gpaMode: 4.0-weighted
        backupKeep: 10
```

> 本插件的所有路由都挂在**一条** `kind: 'prefix'` 的 `/api/study-assistant` 下，
> 不需要、也不要再注册 `kind: 'exact'` 的子路径。

### 装完必须重启一次

运行中的宿主进程持有旧的 ESM 模块代，**不会**热重载插件主体。
重启后左侧栏出现「学习辅助」入口，会话里出现 `study_status` / `study_overview` 两个工具。

---

## 配置

全部配置项都通过 DSH 的插件配置传入（`Config` 手写了一份同步校验 schema，不引入 schemastery）。
**九项，每一项都有默认值，装完零配置即可跑**：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `$HOME/study-assistant-data` | 数据目录（绝对路径）。插件**只读写这个目录**（外加工作区里的笔记/备份落点，见下）。默认由用户主目录推导，换机器不需要改源码 |
| `backupKeep` | number | `10` | 每份数据文件保留几份轮转备份 |
| `locale` | string | `zh` | 界面语言，枚举 `zh` / `en` |
| `gpaMode` | string | `4.0-weighted` | 绩点制式，枚举 `4.0-weighted` / `5.0-weighted` |
| `studentName` | string | `示例同学` | **必须改成你自己的名字**。听课提醒靠它做点名匹配，写错这个功能等于没用 |
| `studentNameVariants` | string | 空 | 姓名的其他写法，顿号/逗号/空格分隔（同音字、室友起的绰号）。语音转写命中这些写法也算叫到你 |
| `studentId` | string | 空 | 学号。提交件归档只认「文件名同时含姓名与学号」的文件；**留空＝整个归档扫描不启用** |
| `workspaceRoot` | string | 空 | 作业工作区根目录（含各学科目录）；留空时自动取 `dataDir` 的父目录 |
| `recordingDir` | string | 空 | 腾讯会议录音笔的录像根目录（每个场次一个子目录）；**留空＝不启用录音导入** |

举个听课提醒的例子：`studentName: 李雷` + `studentNameVariants: 雷子、小李`，
则语音转写出现「李雷」「雷子」「小李」任一写法都算叫到你（按原文匹配，不解释正则元字符）。

---

## 数据目录

插件把学习数据写成**十一份人类可读、可手改、能进 git 的 JSON**（`dataDir` 下）：

```
<dataDir>/
├─ 学期.json          学期与教学周（key: term）
├─ 课程.json          课程（key: courses）
├─ 任务.json          DDL 任务（key: tasks）
├─ 成绩.json          成绩与 GPA 规则（key: grades）
├─ 作业.json          作业流台账：来源文件指纹、题数、最近一次生成的模型与时间
├─ 资料索引.json      教材/课件/作业的索引（面板只读）
├─ 题目.json          从作业里切出来的题（面板只读）
├─ 知识点候选.json     织网前的候选知识点（面板只读）
├─ 知识点网络.json     知识点节点 + 掌握度 / 重点 / 证据（可 mutate）
├─ 知识点大纲.json     教材目录骨架：章 / 节 / 小节（面板只读）
├─ 资料分析.json      扫描产物的内容库：详解 / 比方 / 公式 / 易错 / 例题（面板只读）
├─ 讲解缓存/          按「节点-档位」缓存的讲解 md
├─ 知识画布/          kp-notes 镜像导出（只读视图，可随时重建）
└─ 备份/              写入前的轮转备份
```

设计上的三条口径：

1. **身份与内容分家**——`知识点网络.json` 存「有哪些知识点、掌握到什么程度」，`资料分析.json` 存「这个知识点讲了什么」。
   后者会到 MB 级，混在一起会让每次 `/state` 都变慢。
2. **凭据不在里面**——网络学堂的 Cookie 存在单独的 `网络学堂.json`，**刻意不在十一份白名单里**：
   不进 `/state`、不进备份包、不被 `/reset-doc` 触碰。
3. **半白名单**——`知识点大纲.json` 与 `资料分析.json` 能在白名单里（可读、可备份），但**故意不给 `/mutate` 路由**，
   只能由专用工具整份落盘，避免面板把手改的内容冲掉。

`dataDir` 之外，插件只往工作区写少量文件：听课笔记（各学科目录）、`.learn-edge/`（网络学堂专用浏览器 profile）、
作业详情缓存与 `备份/`（都在 `dataDir` 内）。**它不会写任何其它位置。**

---

## 试跑：用 `demo-data/` 看一眼

仓库自带一份样例数据 `demo-data/`（11 份 JSON：2 门课 / 15 个任务 / 44 道题 / 565 个知识点节点 / 43 份资料索引），
想先看界面长什么样、又不想从零录入时用它：

```bash
# 1. 复制到仓库外（别把 dataDir 直接指到仓库里的 demo-data/：面板一写就把样例改了）
cp -r demo-data "$HOME/study-assistant-data"

# 2. 把 dataDir 指向那份副本，重启 DSH、刷新页面
```

想回到干净状态：删掉副本再重启，缺文件时插件按空文档处理，面板照常打开。

样例是从一份真实学期数据脱敏来的（姓名、学号换成占位值，课程名与任务描述保留原样，供对照字段形状用）。
`demo-data/任务详情.json` 是「抓取过一次网络学堂详情」的缓存样例：结构照平台返回的真实形状，其中的链接一律换成了 `https://example.edu/...` 示例域名。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/使用手册.md`](docs/使用手册.md) | 装上之后怎么用：七个页签、网络学堂同步、听课提醒、知识点、提交件归档、备份恢复、常见问题 |
| [`docs/接口契约.md`](docs/接口契约.md) | 44 条 HTTP 路由（GET 21 / POST 23）、请求守卫、十一份 JSON 的字段契约、新增接口必须遵守的 34 条规则 |
| [`docs/设计说明.md`](docs/设计说明.md) | 模块地图、数据流、存储安全模型（原子写 / 冲突检测 / 损坏保护 / 备份轮转）、关键设计取舍 |
| [`docs/开发备忘.md`](docs/开发备忘.md) | 开发工作流、验收脚本、踩过的坑（schema / 路由 / exports / 样式令牌） |
| [`docs/故障复盘-启动失败事故.md`](docs/故障复盘-启动失败事故.md) | 一次真实启动失败事故的完整复盘与取证顺序 |
| [`docs/故障复盘与后续开发.md`](docs/故障复盘与后续开发.md) | 会话卡死/写句柄冲突等故障的排查手册 |
| [`docs/网络学堂对接可行性.md`](docs/网络学堂对接可行性.md) | 「能不能不靠手工点、直接对接网络学堂」的可行性分析（含风险与不建议的做法） |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | 第三方代码声明（PDF.js） |

---

## 开发

```
index.js                宿主入口：配置 schema、apply()、注册路由 / 工具 / 定时器
lib/                    领域逻辑（core / store / api / deliverables / homework / knowledge / learn …）
lib/lecture/            听课提醒：录音切片、ASR、会话、笔记、报告、面板
client.js               随包发布的面板（单文件、自包含）
client.full.js          可编辑的那份，改完用 sync 脚本同步到 client.js
vendor/pdfjs/           随仓库携带的 PDF.js（唯一第三方代码）
tools/                  命令行脚本：织网 / 大纲 / 体检 / 分题 / 浅表导出 / 同步校验 / 装机验收
tests/                  37 个 node:test 用例文件
demo-data/              可直接试跑的样例数据（11 份 JSON）
docs/                   使用手册 / 接口契约 / 设计说明 / 开发备忘 / 两篇故障复盘 / 网络学堂可行性
```

```bash
# 全部用例（Node 内置 test runner，跨平台，无第三方依赖）：37 个文件、536 项
npm test

# 依赖「本机装有 DSH」的三个校验脚本（不进 CI；找不到生产包时会跳过或报错）
npm run verify:dsh

# 装机验收：直接加载已装进 profile 的那份产物，跑契约断言
npm run verify:installed
```

- 改了 `client.full.js` 之后要同步到随包发布的 `client.js`：`node tools/sync-client-full.mjs --reverse`（**默认方向相反**），
  然后 `--check` 确认逐字一致。
- CI 见 [`.github/workflows/test.yml`](.github/workflows/test.yml)：`windows-latest` × Node 22/24 跑 `npm test`，
  另有 ubuntu/macos 的「可移植性参考」job（`continue-on-error`，不阻塞）。
- 工具脚本（`tools/`）都能单独跑，多数支持 `--help`；`tools/` 里的探针脚本只用于读真机/平台接口取证，不参与运行。

---

## 边界与免责

- **只面向本机自用**：HTTP 接口只监听宿主自己的回环端口，写请求要求自定义头 `X-Study-Request: 1` 且拒绝跨站来源；
  它不是一个可以暴露到公网的服务。
- **网络学堂同步依赖你自己的登录态**：Cookie / 浏览器 profile 都留在你本机，插件不上传任何凭证。
  平台侧接口不是公开 API，平台改版后同步可能失效——这属于已知风险，不是缺陷承诺。
- **不代替你提交作业**：插件只归档「你自己放进 `提交文件/` 的带姓名学号的提交件」，
  不会创建提交件、也不会因为「生成了答案」就把任务标完成。
- **不做后台轮询**：网络学堂同步、讲解生成都是手动触发，避免触发平台反爬与无意义 token 消耗。
- 本项目是个人学习工具，与 DeepSeek / 任何学校教务或网络学堂官方无关；使用需自行遵守所在平台的服务条款。

---

## 许可

MIT，见 [`LICENSE`](LICENSE)。第三方代码与模型接口的声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
