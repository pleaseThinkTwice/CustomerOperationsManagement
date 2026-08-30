# 客户运营平台 · TODO

> 基于《模块详细说明 v1.1（2026-08-28）》整理。
> 用法：对照实际代码勾选 `[x]`；未做/半成品保留 `[ ]` 或标 `~`（部分完成）。
> 重点项：**用户权限管理**（见文末专章，已给可落地方案）。

图例：`[ ]` 待做 · `[~]` 部分完成 · `[x]` 已完成

---

## 0. 交叉基础设施（先打地基，权限管理依赖它）

- [ ] 蓝图化拆分 `routes/*.py`（auth / customer / meeting / warning / warranty / visit / knowledge / dashboard / demand / opinion / intelligence）+ `routes/shared.py`
- [ ] 应用工厂 `create_app()`，`app.py` 收敛到注册蓝图 + 鉴权中间件 + 启动
- [ ] 统一 `get_db()` / `rows_to_list()` / 常量到 `shared.py`
- [ ] 全站鉴权中间件：未登录 API → 401，页面 → 跳登录
- [ ] 操作日志 `operation_logs`：所有 POST/PUT/DELETE 自动记录（用户名/方法/路径/动作/IP/时间）
- [ ] 前端全局 `fetch` 包装：401 自动跳登录 + `Toast` 组件
- [ ] 深浅双主题（localStorage 记忆 + 无闪烁内联脚本）

---

## 1. 登录鉴权（权限管理的直接前置）

- [~] 登录页 + 用户名/密码校验
- [ ] session 持久化（`permanent=True`，7 天）
- [ ] 账号：admin/admin123（管理员）、test/test123（普通用户）
- [ ] 密码字段仅 admin 可读
- [ ] `@require_admin` 装饰器（审批/删除/操作日志/意见评估）
- **升级为完整权限体系 → 见文末专章**

---

## 2. 首页看板（page1）

- [ ] 车辆洞察：活跃车辆识别（`/api/active_vehicles` + `/export`）
- [ ] 车辆洞察：里程调表识别（`/api/mileage_adjust` + `/export`）
- [ ] 客户看板 6 模块：接入总数 / 拜访计划三色 / 重点失效模式(+不外发徽章) / 外部关键人 / 内部PQM / 近期会议
- [ ] 自定义图表：手动添加（柱/折线/饼/表/数字）+ 快捷行编辑器
- [ ] 自定义图表：AI 生成（`/api/dashboard/modules/ai-generate`，接真实 Doris 数据 + 语义反问）
- [ ] AI 客户画像（`/api/dashboard/ai-profile`）
- [ ] 容量选择器：checkbox 列表（全选/清空，不用 Ctrl）

## 3. 客户档案（page2）

- [ ] 客户 CRUD（`/api/customers*`）+ 新增补录 Doris 没有的客户 + 级联删除
- [ ] 按客户查容量 `/api/customers/cell_caps`（Doris）
- [ ] 关键人矩阵（external/internal）CRUD（`/api/key_persons*`）

## 4. 会议纪要（page3）

- [ ] 会议 CRUD + 共识（有序）+ 关键任务（含责任人工号）
- [ ] 任务钉钉通知 `/api/tasks/<id>/notify`（BDPD 消息中心）
- [ ] AI 提取会议纪要 `/api/meetings/ai-summarize`

## 5. 预警闭环（page4）

- [ ] 预警 CRUD + 预警逻辑编辑 `/api/warning_logic`
- [ ] 不外发规则只读展示 `/api/warning_rules`（Doris `kds_warning_not_outgoing_config`，del_flag=0）
- [ ] AI 预警分析 `/api/warnings/ai-analyze`

## 6. 阶段总结（page5）

- [ ] 筛选 + 汇总统计 + 明细表
- [ ] 导出周报 CSV `/api/stage_summary/export`
- [ ] 导出 HTML 报告

## 7. Q&A 知识库（page6）

- [~] QA CRUD / 搜索 / 状态（`/api/qa*`）—— 已有基础版
- [ ] QA 批量导入 `/api/qa/upload` / 导出 `/api/qa/export`（Excel）
- [ ] **两套独立知识库**：`qa_knowledge` / `analysis_knowledge`（当前是单套 `knowledge_chunks`）
- [~] 文件夹同步 / 上传解析（xlsx/html/txt/pdf/docx/pptx/md/csv/tsv）—— 已有基础版
- [ ] 全量重建 `/api/knowledge/rebuild` + LLM 增强 `/api/knowledge/enrich`
- [ ] 分类树 `knowledge_categories`
- [ ] QA SubAgent 多步编排 `/api/agent/query`（mode=qa，search_kb/view_table/query_sql）+ 进度面板

## 8. 文档管理（page7）

- [~] 文档上传/下载 —— 已有基础上传
- [ ] 按客户/类型分类、`scope`（customer_agreement/internal）、`doc_type`

## 9. OEM 映射（page8）

- [ ] 映射 CRUD（`oem_cust_mapping`）
- [ ] Doris OEM 列表 / cust_grp_name 列表下拉

## 10. 数智分析（page9，NL2SQL 归属页）

- [~] NL2SQL 智能问数（自然语言→SQL→执行→表格）—— 已有基础版
- [ ] 快照缓存 + 常用问题收藏
- [ ] Agent 多步分析 `/api/agent/query`（mode=analysis）：query_sql / run_python(沙箱) / search_kb / view_table + 进度面板
- [ ] 分析报告生成 `/api/nl2sql/report`（Markdown 渲染）
- [ ] Markdown 预览 `/api/md/preview`

## 11. 需求管理（page10）

- [ ] 需求提报/编辑/审批(仅admin)/删除(仅admin)（`demand_requests`）
- [ ] AI 智能拆解 `/api/demands/ai-generate`（纪要→多条结构化需求）
- [ ] 审批通过通知责任人 `/api/demands/<id>/review`（notify 参数，钉钉）

## 12. 意见箱（全局）

- [ ] 提交/列表/管理员处理/删除
- [ ] AI 自动评估 `/api/opinions/auto-assess`（合理性/优先级/建议/action）

## 13. 已交付基础（本仓库现状）

- [x] QA：库内直答 + 整库 prompt LLM 兜底（不融合）
- [x] 文档解析 pdf/docx/pptx/xlsx/html/txt
- [x] NL2SQL：schema_config 驱动 + SQL 安全校验 + Doris 只读执行 + 报告
- [x] 完整 v2 SQLite schema（15 表）
- [x] 两 Tab 前端 + Windows start.bat + 冒烟测试

## 14. 配置对齐（文档 v1.1 变更，可立即改）

- [ ] `NL2SQL_MAX_LIMIT`：1000 → **5000**
- [ ] Doris `read_timeout`：60s → **120s**
- [ ] 访问地址/端口对齐（5020）

---

# ★ 专章：用户权限管理（优先做）

> 目标：把现有"硬编码 admin/test 两角色"升级为**可维护的 RBAC 权限体系**——
> 管理员能在页面上增删用户、分配角色、控制每个页面/操作的可见与可用。

## A. 现状 → 目标

| 维度 | 现状（文档） | 目标 |
|---|---|---|
| 用户 | admin/test 两个写死账号 | 用户表 CRUD，可增删改、重置密码、启用/禁用 |
| 角色 | admin / 普通用户（写死） | 角色表，可扩展（如 管理员/客户经理/只读员）|
| 权限 | `@require_admin` 一刀切 | 页面级 + 操作级细粒度，装饰器按权限点校验 |
| 前端 | 全量渲染 | 按当前用户权限渲染菜单/按钮（无权即隐藏/禁用）|
| 审计 | operation_logs | 补权限变更日志 |

## B. 数据模型（RBAC，新增/改表）

```sql
-- 用户表升级（在现有 users 上补列）
ALTER TABLE users ADD COLUMN username   TEXT;      -- 登录名（唯一）
ALTER TABLE users ADD COLUMN password   TEXT;      -- 存哈希（werkzeug generate_password_hash）
ALTER TABLE users ADD COLUMN role_id    INTEGER;   -- 关联 roles.id
ALTER TABLE users ADD COLUMN is_active  INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN last_login TIMESTAMP;

-- 角色
CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,      -- admin / manager / viewer
    name TEXT NOT NULL,             -- 管理员 / 客户经理 / 只读员
    description TEXT,
    is_builtin INTEGER DEFAULT 0    -- 内置角色不可删
);

-- 权限点（页面 + 操作）
CREATE TABLE permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,      -- 例: page1.view / demand.approve / user.manage
    name TEXT NOT NULL,
    category TEXT                   -- 归类: 页面/需求/预警/系统...
);

-- 角色-权限（多对多）
CREATE TABLE role_permissions (
    role_id INTEGER NOT NULL,
    perm_id INTEGER NOT NULL,
    PRIMARY KEY (role_id, perm_id)
);

-- 权限变更审计
CREATE TABLE permission_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator TEXT,                  -- 谁改的
    target_user TEXT,               -- 改了谁
    change TEXT,                    -- 描述: 角色 A→B / 授予 xx 权限
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

> 简化选项：若暂不需要"自定义角色的权限勾选"，可先做 **users.role_id + 角色→权限点用代码常量表**，
> 省掉 role_permissions 表；等需要在页面上编辑角色权限时再落表。

## C. 权限点清单（初版，按页面 + 关键操作）

- 页面级：`page1.view` … `page10.view`、`opinion.view`
- 操作级（示例）：
  - `user.manage`（用户/角色管理，仅管理员）
  - `demand.approve` / `demand.delete`
  - `warning.edit` / `warning_logic.edit`
  - `knowledge.rebuild` / `knowledge.enrich`
  - `opinion.assess`（AI 评估）
  - `oplog.view`（操作日志）
  - `password.view`（查看密码字段）

内置角色默认授权：
- **admin**：全部权限
- **manager（客户经理）**：page1-10.view + 业务写操作，**不含** user.manage / oplog.view / demand.approve
- **viewer（只读）**：仅 `*.view`，无写操作

## D. 后端改造

- [ ] `routes/auth.py`：
  - 登录改哈希校验（`check_password_hash`）+ 写 `last_login`
  - `session` 存 `user_id / username / role_code / perms(set)`
  - 新增装饰器 `@require_perm('demand.approve')`（泛化现有 `@require_admin`）
  - `GET /api/me`：返回当前用户 + 权限点列表（前端据此渲染）
- [ ] 用户管理 API（`user.manage` 保护）：
  - `GET /api/users`、`POST /api/users`、`PUT /api/users/<id>`、`DELETE /api/users/<id>`
  - `POST /api/users/<id>/reset-password`、`PUT /api/users/<id>/toggle-active`
- [ ] 角色管理 API：
  - `GET /api/roles`、`POST /api/roles`、`PUT /api/roles/<id>`、`DELETE /api/roles/<id>`（内置禁删）
  - `GET /api/permissions`（权限点字典）
  - `PUT /api/roles/<id>/permissions`（勾选授权）
- [ ] 给现有写接口挂对应 `@require_perm(...)`
- [ ] 种子迁移：admin→admin 角色、test→viewer（或 manager），密码转哈希

## E. 前端改造

- [ ] 登录后调 `/api/me` 缓存权限集
- [ ] 菜单/按钮按 `hasPerm(code)` 渲染：无 `xxx.view` 隐藏页签；无操作权限禁用/隐藏按钮
- [ ] 新增「系统管理 · 用户与权限」页（仅 `user.manage` 可见）：
  - 用户表格（增删改 / 重置密码 / 启停 / 分配角色）
  - 角色表格 + 权限勾选矩阵
- [ ] 401/403 统一 Toast + 跳转处理

## F. 分步落地顺序（建议）

1. **P0 地基**：users 补列 + roles/permissions/role_permissions 建表 + 种子迁移（admin/test→角色，密码哈希）
2. **P0 后端**：`/api/me` + `@require_perm` + 用户管理 API
3. **P1 前端**：`/api/me` 拉权限 + 菜单/按钮按权限渲染 + 用户管理页
4. **P1 角色权限编辑**：角色 CRUD + 权限勾选矩阵页
5. **P2 审计**：permission_audit 记录 + 管理员查看

## G. 验收标准

- [ ] 新建一个 viewer 用户，登录后只能看 `*.view`，所有写按钮不可见/禁用，直接调写 API 返回 403
- [ ] manager 能做业务操作但看不到用户管理、审批、操作日志入口
- [ ] admin 改某用户角色后，该用户下次请求即生效（或提示重登）
- [ ] 密码全程哈希存储，接口不回传明文；仅 `password.view` 可见（如仍保留该功能）
- [ ] 所有权限变更写入 permission_audit

---

*本 TODO 随迭代更新。开始某模块前，先确认它是否已在真实代码中实现，避免重复。*
