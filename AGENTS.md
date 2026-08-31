# AGENTS.md — 本项目 AI 协作规则（opencode / 其他 agent 自动读取）

> 客户运营平台 v2。后端 Python Flask + SQLite + Doris(只读) + LLM(OpenAI 兼容网关)。
> 两大功能：QA 智能问答、NL2SQL 智能查数。前端为原生 HTML/CSS/JS 单页。

## 技术栈约束（硬性）

- 禁止引入 React / Vue / Tailwind / Bootstrap 等任何前端框架或构建工具。
- 前端必须是可被 Flask 直接渲染的静态 HTML/CSS/JS。
- 后端只用标准库 + requirements.txt 内依赖；凭据走环境变量 / config.local.py，**绝不写死进代码或提交**。

## 设计唯一真源

`ui_mockups/platform-shell.html`、`ui_mockups/user-admin.html` 是全站视觉基准。
所有新页面 / 改造必须**直接复用**它们的 CSS 令牌与组件类，**禁止自创**配色 / 圆角 / 阴影 / 间距体系。
落地方式：把令牌抽成 `static/css/theme.css`，每页 `<link>` 引用，再用现成组件类拼页面。

## 前端硬规则（逐条遵守）

1. **深浅双主题**：一律用 `var(--token)` 取色，绝不写死颜色。支持 `data-theme="dark"/"light"` +
   `prefers-color-scheme`，深色为默认。任何 `#hex`/`rgb()` 只允许出现在 theme.css 的令牌定义处。
2. **复用组件类**：`.panel/.phead/.pbody`、`.tile`、`.btn`(`.btn.ai`)、`.badge`(`.yes/.no/.info`)、
   表格、侧栏 `.side/.nav`、顶栏 `.topbar`、状态 `.pill`、开关 `.switch` —— 有现成就用，不重造。
3. **语义色分明**：绿=正常/闭环、红=预警/逾期/危险、黄=过保/警示、青=信息/待定；主色(蓝)只作品牌与强调，不当语义色。
4. **数字等宽**：数量/金额/ID 加 `class="mono"`（`font-variant-numeric:tabular-nums`）。
5. **仪表盘信息密度**：先摘要后明细、卡片化、状态用徽章/圆点一眼可辨；宽表放 `overflow-x:auto` 容器。
6. **可访问性**：`:focus-visible` 有描边、`prefers-reduced-motion` 关动画、按钮文案说清后果（“保存”→toast“已保存”）。
7. **交互态齐全**：hover/active/禁用/loading/空状态；异步按钮点击后禁用防重复。
8. **中文界面**，文案从用户视角写（“未闭环预警”而非 `warning_status`）。

## 严禁的「AI 通用观感」

不要奶油底+衬线大标题+陶土色；不要全圆角+紫蓝渐变 hero；不要 Inter/Space Grotesk 兜底；
不要 emoji 当章节标记铺满；不要无意义编号 01/02/03。
风格锁定：**深蓝科技风 + Manrope + JetBrains Mono(数字)**。

## 交付要求

- 每次给出**完整可运行文件**，不要片段。
- 改造前先读 `ui_mockups/` 三个文件对齐，再动手。
- **一次只做一个页面**，先用三五句话说版面方案，确认后再输出完整 HTML。
- 自检：全文搜写死颜色值（除 theme.css 令牌定义处），有就改成 `var(--token)`。

## 单页任务提示词模板

```
参照 ui_mockups/platform-shell.html 的风格与组件，做【页面名，如 预警闭环 page4】。
- 功能：列表 + 新增/编辑 + 【本页特有，如 不外发规则只读、AI 分析按钮】
- 接口：【如 GET/POST /api/warnings*，GET /api/warning_rules 只读】
- 布局：顶栏标题+筛选 → 统计块 → 主表格(状态徽章) → AI 分析卡
- 要求：复用 theme.css 令牌与现成组件类，深浅双主题，等宽数字，空/加载/错误态齐全。
- 先说版面方案，我确认后再输出完整 HTML。
```

## 后端 / 数据参考

- 表结构见 `schema.sql`；NL2SQL 可查询表在 `schema_config.yaml`（改表只改这个文件，代码零改动）。
- NL2SQL 生成的 SQL 必须经安全校验：仅单条 SELECT、表名白名单、自动补 LIMIT、禁一切写操作。
- 完整平台待办与权限管理方案见 `todo.md`。
