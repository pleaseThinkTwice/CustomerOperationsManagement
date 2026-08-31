# AGENTS.md

本文件是本项目所有 AI 协作者（opencode / Claude / 其他）的长期开发规约。**每次进项目先读它。**
覆盖前后端持续开发，规则自足——设计令牌与约定都写在本文内，无需另找参考文件。

---

## 1. 项目概览

客户运营平台 v2：面向新能源汽车 B 端客户运营的作业平台。

- **后端**：Python 3.13 + Flask + SQLite（本地业务数据）+ Doris（只读，MySQL 协议）+ LLM（OpenAI 兼容网关）
- **前端**：原生 HTML/CSS/JS 单页应用，无框架
- **两大核心能力**：QA 智能问答、NL2SQL 智能查数；并逐步扩展为多页业务平台（看板/客户/会议/预警/知识库/需求/权限等）

关键文件：`app.py`(主程序/路由)、`schema.sql`(表结构)、`config.py`(配置)、`schema_config.yaml`(NL2SQL 可查询表)、`todo.md`(路线图)。

---

## 2. 通用工作准则

1. **先读后写**：动手前先读相关文件，理解现有约定，沿用而非另起一套。
2. **小步交付**：一次只做一个页面 / 一个接口 / 一个模块。大改先说方案，确认后再写。
3. **完整文件**：给出可直接运行的完整文件，不要零散片段。
4. **不破坏现状**：改动前确认不影响已有功能；删除/覆盖前先看清目标内容。
5. **自检**：交付前自查——语法、明显边界、是否违反下方硬规则。
6. **中文优先**：界面文案、注释、提交信息用简体中文，从用户视角表达。

---

## 3. 后端约定

### 结构
- 路由集中在 `app.py`（或按蓝图拆到 `routes/*.py`，共享工具放 `routes/shared.py`）。保持风格统一。
- 数据库访问用 `db.get_conn()`（`sqlite3`，`row_factory=Row`）。SQL 用参数化 `?`，**禁止字符串拼接 SQL**。
- 新增表改 `schema.sql`；新增种子改 `seed.py`。改表后确保 `db.py`/`seed.py` 仍可重复运行。

### 配置与密钥（红线）
- 所有凭据（LLM key、Doris 账号密码）**只从环境变量 / `config.local.py` 读取**，`config.local.py` 已被 `.gitignore` 忽略。
- **绝不把任何密钥、密码、内网地址写死进代码或提交进 Git。**

### API 约定
- 路径 `/api/<资源>`，REST 风格：GET 查、POST 增、PUT 改、DELETE 删。
- 返回 JSON；成功 `{ok:true,...}`，失败返回合适 HTTP 状态码 + `{error:"人话说明"}`。
- 写操作（POST/PUT/DELETE）需鉴权；未登录返回 401。

### NL2SQL 安全（红线）
- LLM 生成的 SQL 必须过安全校验：**仅允许单条 SELECT/WITH**、表名限 `schema_config.yaml` 白名单、自动补 `LIMIT`、拦截一切写操作/危险关键字。
- Doris 一律**只读**账号；不提供任何写 Doris 的路径。
- 新增可查询表只改 `schema_config.yaml`，不改代码。

### LLM
- 通过 `llm_client` 调用；`LLM_ENABLED=0` 时全站须可离线运行（功能降级而非崩溃）。
- 大段不变上下文（知识库/schema）放消息前部作稳定前缀，利于 prompt cache。

### 质量
- 关键逻辑加轻量测试（见 `tests/`），离线可跑。改后端跑一遍冒烟测试。
- 异常要捕获并返回清晰错误，不让整个请求 500 且无信息。

---

## 4. 前端约定

- 纯原生 HTML/CSS/JS，可被 Flask 直接渲染。**禁止引入 React/Vue/Tailwind/Bootstrap 等框架或构建工具。**
- 公共样式集中在 `static/css/theme.css`（下方第 5 节即其内容契约），每页 `<link>` 引用；每页脚本放 `static/js/`。
- 组件化复用：同类 UI（卡片/按钮/徽章/表格/弹窗）用统一 class，不每页重造。
- 交互态齐全：hover / active / 禁用 / loading / 空状态 / 错误态都要有；异步按钮点击即禁用防重复。
- 可访问性：`:focus-visible` 可见描边；尊重 `prefers-reduced-motion`；按钮文案说清后果（“保存”→toast“已保存”）。

---

## 5. 设计系统（视觉契约，自足）

**风格锁定：深蓝科技风（深色默认）+ 深浅双主题。字体 Manrope（UI）+ JetBrains Mono（数字）。**
新页面直接采用以下令牌，**禁止自创配色/圆角/阴影体系，禁止在组件里写死颜色**——颜色只能来自 `var(--token)`。

### 5.1 颜色令牌（`theme.css` 应包含，深浅两套）

```css
/* 浅色（默认 :root）*/
:root{
  --bg:#eef2f8; --panel:#fff; --panel-2:#f6f8fc; --line:#dde5f0; --line-strong:#c7d3e5;
  --ink:#141d2e; --ink-2:#3a4761; --muted:#6c7a94; --faint:#9aa8c0;
  --brand:#2563eb; --brand-ink:#fff; --brand-soft:#e6efff;
  --ok:#16a34a; --ok-soft:#dcfce7; --warn:#d97706; --warn-soft:#fef1dc;
  --danger:#dc2626; --danger-soft:#fde4e4; --info:#0891b2; --info-soft:#dbf3f8;
  --ring:rgba(37,99,235,.35); --shadow:0 1px 2px rgba(20,29,46,.06),0 8px 24px rgba(20,29,46,.08);
  --radius:14px;
}
/* 深色：同名令牌重定义。三处都要写，保证 系统深色 / 手动切换 都生效 */
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){ /* …深色值… */ }}
:root[data-theme="dark"]{ /* …深色值… */ }
:root[data-theme="light"]{ /* …浅色值（同默认）… */ }
/* 深色值参考：--bg:#0a1120;--panel:#111b2e;--panel-2:#0e1728;--line:#22304c;--line-strong:#2d3d5e;
   --ink:#e8eefb;--ink-2:#b7c4dc;--muted:#8496b6;--faint:#5e6f8f;
   --brand:#4f8cff;--brand-ink:#08122a;--brand-soft:#182a49;
   --ok:#34d399;--ok-soft:#0f2e26;--warn:#fbbf24;--warn-soft:#2e2410;
   --danger:#f87171;--danger-soft:#33141a;--info:#38bdf8;--info-soft:#0b2833; */
```

### 5.2 主题规则
- 一律 `var(--token)` 取色；`#hex`/`rgb()` 只允许出现在 theme.css 令牌定义处。
- 深色为默认（首屏内联脚本按 localStorage 设 `data-theme`，无闪烁），右上角一键切换并记忆。
- `body` 必须显式 `background:var(--bg)`；每个元素颜色与其背景取自同一套令牌。

### 5.3 语义色（与主色分开）
绿 `--ok`=正常/闭环 · 红 `--danger`=预警/逾期/危险 · 黄 `--warn`=过保/警示 · 青 `--info`=信息/待定。
主色（蓝 `--brand`）只作品牌与强调，**不当语义色**。

### 5.4 排版与信息设计
- 数字/金额/ID 用 `.mono`（`font-variant-numeric:tabular-nums`）对齐。
- 仪表盘信息密度：先摘要后明细、卡片化、状态用徽章/圆点一眼可辨。
- 宽内容（表格/代码/图表）放进 `overflow-x:auto` 容器，页面本体不横向滚动。

### 5.5 组件命名（统一复用）
`.panel/.phead/.pbody`(卡片) · `.tile`(统计块) · `.btn`(`.btn.primary`/`.btn.ai`) · `.badge`(`.yes/.no/.info`) ·
`.pill`(状态) · `.switch`(开关) · 表格 · `.side/.nav`(侧栏) · `.topbar`(顶栏) · `.scrim/.modal`(弹窗) · `.toast`。

### 5.6 严禁的「AI 通用观感」
不要奶油底+衬线大标题+陶土色；不要全圆角+紫蓝渐变 hero；不要 Inter/Space Grotesk 兜底；
不要 emoji 当章节标记铺满；不要无意义编号 01/02/03。

---

## 6. Git 与协作
- 提交信息用中文、说清“做了什么/为什么”。功能相关的改动一起提交。
- 不提交：`data.db`、`uploads/*`、日志、`config.local.py`、`__pycache__`（见 `.gitignore`）。
- 分支按项目要求；不要在他人分支上改写历史（rebase/force-push）。

---

## 7. 变更记录
- 2026-08-31：初版通用规约（前后端 + 设计系统 + 工作准则）。

> 本文件是活文档：约定变化、发现 agent 反复踩的坑、新增真源或模块时，**及时更新本文并提交**。
