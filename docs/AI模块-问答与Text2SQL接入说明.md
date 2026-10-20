# AI 模块：知识库问答 + 数智分析（Text2SQL）接入说明

日期：2026-10-20　｜　代码：`src/ai/`

> **在平台里运行（`npm start`）时**：数智分析默认查分析库，也就是首页看板用的同一份数据。语义层由 `src/analytics/schema.js`（表和字段）加 `config/semantic.analytics.json`（枚举、口径、示例 SQL、常用问题）在启动时合成到 `data/semantic.analytics.json`；接公司 Doris 时跟随 `ANALYTICS_DB_*` 和表名映射。大模型配置读 `AI_LLM_*`，没配时回落到 `LLM_*`。只有显式设置了 `AI_SQL_*` 才改查别的库。下文的 `npm run ai:demo`、`config/semantic.json`、演示业务库只用于单独调试 AI 模块。

## 1. 结论

原型里「Q&A知识库」和「数智分析」两页现在已经接上真实后端，前端一行没改。

- **引入方式**：内置一个轻量引擎（零依赖，Node 22 自带 SQLite），同时留好 Dify、RAGFlow、MaxKB、FastGPT 的适配器。公司以后部署了这些平台，改一行配置就能切过去。
- **不做 RAG**：按你的要求，Q&A、知识片段和表结构数据量小，全部直接放进大模型上下文，不做向量检索。
- **和公司解耦**：大模型、业务库、表口径三样东西都只从配置进来。到公司只需要填配置、补一份语义层文件（表和字段的中文含义、业务口径、示例 SQL），代码不用改。
- **没有大模型也能演示**：问答退化为关键词匹配；数智分析可以回答语义层里登记过的示例问题。

![数智分析：自然语言 → SQL → 结论](images/ai-analysis-demo.png)

![问答：全量知识进上下文，答案带出处](images/ai-qa-demo.png)

截图来自 `npm run ai:demo` 加本地模拟大模型，数据是演示库里的模拟数据。

## 2. 调研与选型

上一轮调研（2026-10-12，见 [docs/调研/NL2SQL与知识库问答开源工具调研.md](调研/NL2SQL与知识库问答开源工具调研.md)）比较了 SQLBot、DB-GPT、WrenAI、Vanna、Chat2DB，以及 RAGFlow、Dify、FastGPT、MaxKB、AnythingLLM。这次结合原型的实际情况重新取舍：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| SQLBot（DataEase） | 不直接内嵌，可作为外部平台接入 | 要单独部署 Docker 加自带数据库，许可证不允许改品牌；对外 API 文档少（只看到嵌入和 MCP 方式）。可以通过 Dify 编排后接进来 |
| DB-GPT | 不内嵌 | 功能全，但很重（Python 服务、向量库、模型管理），原型只需要其中的 Text2SQL 加多步分析 |
| WrenAI | 借鉴思路 | 「先在语义层定义口径再生成 SQL」正是准确率的关键，本模块的 `config/semantic.json` 就是精简版语义层 |
| Vanna | 借鉴思路，不引入 | 原仓库 2026-03-29 已归档；它「表结构 + 文档 + 示例问答 SQL 一起喂给模型」的做法被本模块采用 |
| RAGFlow / MaxKB / FastGPT | 做成适配器，默认不用 | 你说暂时不需要 RAG。以后文档量大了（扫描件、长手册），部署其中一个，把 `AI_ENGINE_QA` 改成 `openai_app` 即可 |
| Dify | 做成适配器，默认不用 | 公司如果有 Dify，可以在里面编排问答或问数工作流（例如接 SQLBot），然后把 `AI_ENGINE_*` 改成 `dify` |

**最终方案**：内置引擎采用以上项目验证过的做法（语义层口径、示例 SQL、只读校验、出错自我修正、多步 Agent），外部平台走适配器。原因有三点：原型数据量小，用不上重型平台；原型前端已经按「Agent 多步 + 轨迹 + 反问」设计好了交互，内置引擎能原样对上；零依赖、单进程，到公司部署没有额外的容器和运维负担。

## 3. 逻辑说明

### 3.1 整体结构

```
前端（原型 HTML，未改动）
  Page6 Q&A知识库 / Page9 数智分析 / AgentProgress 进度组件
        │  POST /api/agent/query {query, mode: qa|analysis, history, stream:true} → task_id
        │  GET  /api/task/progress/:id（每 500ms 轮询：thought、步骤、最终结果）
        ▼
src/ai  createAiRouter()
  ├─ 引擎选择 engineFor(mode)：builtin | dify | openai_app
  ├─ builtin Agent（agent.js）
  │    系统提示 = 角色规则 + 全量知识（qa）或全量语义层（analysis）
  │    工具：query_sql / describe_table / ask_user
  ├─ 语义层 + 业务库（sql/catalog.js、sql/adapters.js）：sqlite | mysql | doris | postgres，只读
  ├─ SQL 安全校验（sql/guard.js）
  └─ 自有存储 data/ai.sqlite：Q&A、知识片段、收藏、轨迹与反馈、快照
```

### 3.2 问答（mode = qa）

1. 把**全部** Q&A 记录（编号 `Q1…`）和问答知识片段（编号 `K1…`）放进系统提示，再附上业务库结构（需要查实时数据时用）。
2. 模型依据知识回答，句末标出处 `[Q3]`。知识里没有的内容要求直接说「暂无」，不许编造。
3. 如果问题涉及实时数字（例如「小米现在有多少未闭环预警」），模型可以调用 `query_sql` 去查。
4. 上下文有上限（默认 6 万字，`contextBudgetChars`），超出时按顺序截断并在提示里注明。到那一步再考虑切换到 RAGFlow 之类的外部引擎。

### 3.3 数智分析 / Text2SQL（mode = analysis）

1. 系统提示里放：数据库方言、所有可查表及字段含义和枚举值、业务口径（术语表）、注意事项、示例问答 SQL，以及用户在页面上录入的「自定义知识」。
2. 模型调用 `query_sql`，SQL 先经过安全校验再执行：
   - 只允许单条 `SELECT` / `WITH`，拦截写操作和危险函数；
   - 只能查语义层登记的表（白名单），逗号连接、双引号表名都会检查；
   - 没写 `LIMIT` 的自动在外层加上行数上限（默认 5000）；
   - 业务库用只读方式打开（SQLite 只读模式；PostgreSQL 包在只读事务里；MySQL/Doris 靠只读账号）。
3. SQL 报错或被拦截时，把错误原文回给模型，让它修正后重试（测试里覆盖了「先写错表名 → 自动改对」）。
4. 可以分多步查（默认最多 8 步）。问题有关键歧义时调用 `ask_user` 反问，前端弹出选项框，用户回答后通过 `/api/agent/continue` 接着跑。
5. 最终回答格式：一句话结论、Markdown 数据表、口径说明。后端额外附上「执行的 SQL」折叠块和原始结果，方便核对。
6. 每次回答都记一条轨迹（问题、SQL、工具、步骤），前端 👍👎 反馈写回这条轨迹，可以用来挑选好的问答补充进示例 SQL。

### 3.4 三档降级

| 条件 | 行为 |
| --- | --- |
| 模型支持 function calling（默认） | 多步 Agent，如上 |
| 模型不支持（`AI_LLM_TOOL_CALLING=false`） | 固定流程：生成 SQL → 执行，出错带报错重试 2 次 → 总结 |
| 未配置大模型 | 问答按关键词（中文二元切分 + BM25）匹配最相关的 3 条知识；分析只回答语义层示例问题（执行预置 SQL），其他问题提示需配置模型 |

### 3.5 其他页面功能

- **常用问题快照**：对语义层的 `commonQuestions` 和所有用户收藏的问题各跑一遍，结果存成快照；页面「刷新快照」触发。如需每日自动刷新，平台定时任务调用 `require('./ai').refreshSnapshots()` 即可。
- **统一报告**：勾选多个快照问题，大模型合并写一份分析报告。
- **编辑/优化**：按用户的提示词改写结论，要求不改数字。
- **可查表目录**：列表、字段说明、一键查看前 N 行，同样只限白名单表。
- **知识库管理**：Q&A 增删改、CSV/Excel 批量导入导出；知识片段增删改、上传文件自动切片（md/txt/csv/json/html/sql，xlsx 需装可选依赖）、同步 `data/kb/` 文件夹、重建、AI 生成关键词。
- **权限**：挂到平台后，如果 `req.user` 没有 `*` 或 `knowledge.edit` 权限，就不能修改 Q&A 和知识库（返回 403）。

## 4. 怎么运行

```bash
npm test                  # 5 组端到端测试（模拟大模型），约 1 秒
npm run ai:demo           # http://localhost:3100/ ，首次运行自动生成演示业务库
# 接真实模型（任何 OpenAI 兼容接口）：
AI_LLM_BASE_URL=https://api.deepseek.com/v1 AI_LLM_API_KEY=sk-xxx AI_LLM_MODEL=deepseek-chat npm run ai:demo
```

演示服务不修改原型 HTML：返回页面时在离线拦截器前后注入两小段脚本，让 AI 相关前缀的请求走真实后端，其他页面继续用原型自带的假数据。

**挂到平台后端**（已和「补齐原型所需的后端接口」线程约定好）：

```js
const ai = require('./ai');
const aiRouter = ai.createAiRouter();
// 鉴权之后：
if (await aiRouter(req, res)) return;     // 处理了返回 true
// 平台其它模块复用同一个大模型和任务进度表：
ai.llm.chat(messages)                       // 未配置时抛出 code = 'LLM_DISABLED'
ai.tasks.start(async report => { report({ current: 1, total: 3, thought: '…' }); return result; })
```

## 5. 配置项

配置优先级：环境变量 > `config/ai.json`（参考 `config/ai.example.json`，已加入 .gitignore）> 默认值。

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `AI_LLM_BASE_URL` | OpenAI 兼容接口地址（到 `/v1`） | 空（离线兜底） |
| `AI_LLM_API_KEY` | 模型密钥 | 空 |
| `AI_LLM_MODEL` | 模型名，如 `qwen-plus`、`deepseek-chat` | 空 |
| `AI_LLM_TOOL_CALLING` | 模型是否支持 function calling | `true` |
| `AI_SQL_TYPE` | 业务库类型：`sqlite` / `mysql` / `doris` / `postgres` | `sqlite` |
| `AI_SQL_URL` | 连接串，如 `mysql://ai_ro:pwd@host:9030/test` | 空 |
| `AI_SQL_FILE` | SQLite 文件 | 平台内：分析库；单独调试：`data/demo_business.sqlite` |
| `AI_SQL_MAX_ROWS` | 单次查询行数上限 | `5000` |
| `AI_SQL_ALLOW_TABLES` | 可查表白名单（逗号分隔；`*` 为全部） | 语义层登记的表 |
| `AI_SEMANTIC_FILE` | 语义层文件 | 平台内：启动时合成；单独调试：`config/semantic.json` |
| `AI_STORE_DB` | 本模块自有存储 | `data/ai.sqlite` |
| `AI_ENGINE_QA` / `AI_ENGINE_ANALYSIS` | `builtin` / `dify` / `openai_app` | `builtin` |
| `AI_DIFY_BASE_URL`、`AI_DIFY_QA_KEY`、`AI_DIFY_ANALYSIS_KEY` | Dify 应用 API | 空 |
| `AI_APP_QA_URL`、`AI_APP_QA_KEY`（及 `ANALYSIS` 对应项） | RAGFlow / MaxKB / FastGPT 的 OpenAI 兼容对话接口完整 URL | 空 |

MySQL/Doris 需要 `npm i mysql2`，PostgreSQL 需要 `npm i pg`，Excel 导入导出需要 `npm i xlsx`。这三个都是按需加载的可选依赖，不装不影响 SQLite 演示。

## 6. 需要你在公司提供的东西

按优先级排列。前 4 项齐了，数智分析就能在真实数据上跑。

### 6.1 大模型（必需）

- 一个 OpenAI 兼容的接口地址、密钥、模型名。公司内网的通义千问、DeepSeek、vLLM 或 Xinference 都可以。
- 确认模型支持 function calling（工具调用）。不支持也能用，但会降级为单步生成 SQL。
- 合规确认：表结构和查询结果会发给模型。用外部 API 前请确认允许；否则用私有化部署的模型。

### 6.2 业务库只读账号（必需）

- 单独开一个**只读**账号，最好连 test 库或报表库，而不是生产主库。
- 只授权下面 6.3 里用到的表或视图；手机号、证件号、精确位置等敏感字段不要授权，或者建脱敏视图。
- 告诉我库的类型（Doris / MySQL / PostgreSQL）和连接串格式。
- 建议在数据库侧也设置查询超时，例如 Doris 的 `query_timeout`。

### 6.3 表清单：演示表对应 test 库的哪张表（必需）

演示库里的 6 张表是按原型页面编的占位口径。请在最后一列填上公司真实表名。字段名不同没关系，在语义层里写清楚含义就行；一张演示表对应多张真实表也可以，都登记进去。

| 演示表 | 用途 | 关键字段 | test 库对应表（请填写） |
| --- | --- | --- | --- |
| `cust_oem` | 客户（OEM）主数据 | 客户代码、中文简称、等级、合作关系、区域 | |
| `cust_project` | 客户项目（客户 × 电芯容量）与出货 | 容量、成组方式、PN、SOP 月份、出货 PACK 数 | |
| `veh_access` | 车辆接入台账 | VIN、客户、容量、首次接入日期、最近上线日期、里程 | |
| `warn_record` | 电池预警记录 | 预警日期、失效模式、风险等级、闭环状态、是否外发、闭环日期 | |
| `demand` | 客户需求池 | 分类、状态、优先级、提出日期、负责人 | |
| `contract` | 客户合同 | 金额、状态、签订日期、到期日期 | |

### 6.4 语义层 `config/semantic.json`（必需，最影响准确率）

这个文件可以直接照着当前的演示版本改，改完不用重启。

- **tables**：每张表一句中文说明；每个字段的中文含义；状态类字段列出全部取值（例如闭环状态的实际取值是「已闭环 / 未闭环」还是「1 / 0」）。库里已有字段注释的可以不写，会自动读取。
- **glossary（业务口径）**：接入率、活跃车辆、闭环率、外发等指标的**准确算法**，写到字段级别。这一项最容易出错，模型只能照着写，写不清它就只能猜。
- **examples（示例 SQL）**：10~30 条业务方常问的问题，每条配一条你确认过结果正确的 SQL。
- **commonQuestions**：希望每天自动出快照的问题。

### 6.5 Q&A 与文档（可选）

- 现有 Q&A 表格：列名包含「分类、问题、回答、关键词、维护人」，在页面上直接导入（CSV，或装 xlsx 后用 Excel）。
- 产品手册、售后流程等文档：放进 `data/kb/qa/`，在页面点「同步文件夹」。
- 现在的 12 条 Q&A 是演示数据（维护人显示「演示数据」），导入真实数据前在页面上删掉即可。

### 6.6 验收题库（建议）

30 个真实问数问题，每题附标准答案，用来在真实数据上测准确率。建议门槛：常见问题执行准确率 ≥ 85%，单次响应 ≤ 15 秒，低权限账号越权查询 0 次成功。

## 7. 接口清单

全部对齐原型前端现有调用，前缀由本模块独占。

| 接口 | 说明 |
| --- | --- |
| `POST /api/agent/query` | `{query, mode, history, stream}`；stream 时返回 `{task_id}`，否则同步返回结果 |
| `POST /api/agent/continue` | 反问后续答 `{sid, answer, stream}` |
| `POST /api/agent/refine` | 按提示词改写结论 |
| `POST /api/agent/feedback` | 👍👎 反馈 |
| `GET /api/task/progress/:id` | `{success, status: running/done/error/waiting_input, current, total, thought, result}` |
| `GET/POST /api/qa`、`PUT/DELETE /api/qa/:id` | Q&A 记录 |
| `GET /api/qa/status`、`POST /api/qa/upload`、`GET /api/qa/export` | 状态、导入、导出 |
| `GET/POST /api/knowledge`、`PUT/DELETE /api/knowledge/:id` | 知识片段（`scope=qa/analysis`） |
| `GET /api/knowledge/status`、`POST /api/knowledge/upload` | 分类树、文件上传切片 |
| `POST /api/knowledge/sync-folder`、`rebuild`、`enrich`、`sync-qa` | 文件夹同步、重建、AI 关键词；`sync-qa` 现在不需要（Q&A 已全量进上下文） |
| `GET/POST /api/knowledge/user`、`DELETE /api/knowledge/user/:id` | 数智分析页的自定义知识 |
| `GET /api/nl2sql/tables`、`tables/columns`、`tables/view` | 可查表目录、字段、预览 |
| `GET /api/nl2sql/snapshots`、`POST snapshots/refresh`、`POST report` | 常用问题快照与统一报告 |
| `GET/POST /api/nl2sql/user-favorites`、`DELETE …/:id` | 我的常见问题 |
| `GET /api/ai/status` | 模块状态（引擎、模型、业务库、表数量） |

## 8. 风险与限制

- **「看起来对、实际错」的 SQL** 是最大风险。缓解办法：语义层口径写清、回答里附 SQL 和口径说明、用验收题库测、用 👎 反馈持续补充示例 SQL。
- **越权**：SQL 校验是第二道防线，第一道必须是数据库只读账号加表级授权。MySQL/Doris 适配器没法在连接层强制只读，依赖账号权限。
- **上下文上限**：全量放进上下文适合几十张表、几百条 Q&A 的规模。超过 6 万字会截断；到时候切 RAGFlow 等外部引擎，或者给语义层按主题拆分。
- **任务状态在内存里**：服务重启后，正在跑的任务会丢，前端提示失败后重问即可。轨迹、反馈、知识都在 SQLite 里，不受影响。
- **工具箱 / 数据洞察**：前端提到的 `run_tool`、`search_insight` 两个工具属于其他页面（工具箱、数据洞察）的后端，本模块暂未接入。等那两块后端就绪后，可以作为 Agent 工具加进来。
