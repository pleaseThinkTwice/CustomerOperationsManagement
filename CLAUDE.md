# 客户运营管理平台 · 约定

## 分支

- **只有 `main` 一个长期分支，所有改动都在 main 上迭代。** 不要再新开长期分支；需要走 PR 时用短命分支，合并后立刻删掉。
- 旧分支已归档为 `archive/*` 标签，只读参考，不要在上面继续开发。

## 项目结构

| 位置 | 内容 |
|---|---|
| `客户运营管理平台离线演示.html` | 前端：单文件原型（约 1.8 万行）。内置离线 mock，可直接双击打开，也可发布为 claude.ai Artifact。由后端托管时 mock 自动关闭，请求走真实接口 |
| `src/app.js`、`src/server.js` | 后端入口：零依赖 Node（22.13+），路由装配、登录校验、操作日志 |
| `src/routes/` | 按页面划分的接口 |
| `src/db/` | 运营库（平台自有、可读写）：驱动 sqlite / mysql、表结构 `schema.js`、演示数据 `seed.js` |
| `src/analytics/` | 分析库（公司数仓、只读）：表结构 `schema.js`、全部看板口径 `index.js`、演示数据生成 |
| `src/ai/` | Q&A 知识库问答 + 数智分析（text2sql），挂在同一服务上 |
| `src/core/` | 鉴权、权限码（`perms.js`）、文件、xlsx、通知、AI 桥接、数智分析语义层合成（`ai-semantic.js`） |
| `config/semantic.analytics.json` | 数智分析的枚举、口径、示例 SQL、常用问题 |
| `docs/` | 业务逻辑、页面逻辑说明 / 问题清单、数据需求、AI 接入说明；`API.md` 和 `数据表DDL.md` 由 `npm run docs` 生成 |
| `test/` | `node:test` 接口测试和 AI 模块端到端测试 |

侧栏分「运营 / 智能 / 管理」三组。页面 id 与 `pageN.view` 权限码一一对应，新增或删除页面时同步改：HTML 里的侧栏、`ALL_PAGES`、`renderNavByPerms`、页面标题表、`pageInits`，以及后端 `src/core/perms.js`。数据洞察（page14）不在侧栏，从知识中心进入。

## 运行

```bash
npm start            # http://localhost:3000 ，admin / admin123；首次启动在 data/ 生成运营库和演示数仓
npm test             # 全部测试，提交前必须通过
npm run reset-data   # 清空 data/，下次启动重新生成
npm run docs         # 改了路由或表结构后重新生成 docs/API.md、docs/数据表DDL.md
```

## 数据层（可插拔）

- **运营库**：`OPS_DB_DRIVER=sqlite|mysql`。平台自己维护的数据（档案、会议、闭环台账、质保条款、需求、合同等）。
- **分析库**：`ANALYTICS_DB_DRIVER=demo|mysql`（Doris 走 MySQL 协议）。看板指标都从这里现算，口径集中在 `src/analytics/index.js`，同一条 SQL 在 sqlite 演示库和 Doris 上都要能跑。公司表名不同用 `ANALYTICS_TABLE_PREFIX` 或 `ANALYTICS_TABLE_<逻辑表名>` 映射，`npm run check-analytics` 自检。
- **数智分析**默认查分析库，和看板同一份数据。改了 `src/analytics/schema.js` 的表或口径，同步改 `config/semantic.analytics.json` 里的口径和示例 SQL。
- **大模型**：`LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`（OpenAI 兼容）。不配也能跑，AI 功能走规则兜底。
- 配置都在 `.env`（见 `.env.example`），不要把公司连接串、密钥写进代码或提交。

## 口径

指标口径以 `src/analytics/index.js` 顶部注释和 `docs/业务逻辑.md` 为准。还没定的口径列在 `docs/页面逻辑问题清单.md`（X1–X11），改之前先问用户，不要自己拍板。

## 页面改动规则

改页面时遵守下面的规则；新规则在评审中形成后追加到这里。

### 表格

- **对齐**：文本、编号、数值一律左对齐；只有状态标签列、操作列居中。表头与该列内容同向。
  - 写法：居中列的表头加 `class="ctr"`（如 `<th class="ctr">操作</th>`），同列单元格由全局 `TableAlign` 自动跟随，不用逐格加类。`TableAlign` 会按 rowspan / colspan 换算单元格所在列，合并单元格的表也适用。
  - 数值列用 `class="num"`（只负责等宽数字，不改对齐）。行内的条形图 / 徽标等用 flex 时不要 `justify-content:flex-end`。
- **合计行**：只加总数量列；比率类（缺失率、闭环率、失效率 / ppm、占比等）合计格留空。合计必须等于各行相加，KPI 卡与合计同一口径。
- **数值展示**：直接写值，不加多余的比较符号，例如质保 SOH 写 `80%`，不写 `≥ 80%`。只有规则 / 阈值本身需要运算符时才写（如外发规则「里程 ≥ 120000 km」、复核阈值「> 3 %/天」）。

### 文案

- 不放解释性文字：标题后不加「（本地真源 · 共 N 条 · 可编辑）」这类说明，不写「点击表头可排序」「按 A × B 汇总 · 点击行查看…」之类的提示句，不写「离线演示：…」。
- 保留的是数据本身（如「质保信息管理（600 台）」、外发漏斗的每步数量）和必须的状态提示（如「显示前 200 台，共 N 台」）。
- 文件选择框占位统一为「未选择文件」，模板列通过「下载模板」查看。

### 图表

- 多系列图的图例都可点选隐藏 / 恢复（`lgItem` + `legendRedraw[key]` 局部重绘）。
- 单位写在标题或纵轴上（如「电芯失效率走势（ppm）」、纵轴 `ppm` / `%`），ppm 刻度直接显示数字，不用「万」。
- 走势类图默认纵轴从 0 起，避免放大波动。
- 有「月增量 / 累积量」概念的走势，在卡片右上角放切换（`.seg`）。
- 配色：失效模式用 `modeColor`，客户用 `CUST_COLORS`；同一名称在任何图里颜色一致。

### 筛选与下拉

- 下拉需要「全部」时，用非空值（如 `__all__`）的正式选项，不用空值占位项——`SearchSelect` 不会把空值选项放进列表，选了别的就切不回来。
- 顶部筛选会影响整页时，相关卡片（KPI、表格、走势、构成）都要按同一筛选重算。

### 发布页（Artifact）兼容

- 不用原生 `confirm` / `prompt` / `alert`，用 `Dialog.confirm / prompt / alert`（返回 Promise）。
- 下载统一走 `FileSaver.save(blob, 文件名)` / `FileSaver.fromUrl(url, 文件名)`，不直接建 `<a download>`、不 `location.href` 跳导出接口。

## 验证

- 改了后端跑 `npm test`。
- 改了页面用 Playwright（Chromium 在 `/opt/pw-browsers`）真实点击验证，确认无脚本错误；离线（直接打开 HTML）和 `npm start` 两种方式都要点一遍侧栏所有页面，改动涉及的联动都要点到。
