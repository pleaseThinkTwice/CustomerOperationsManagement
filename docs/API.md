# 接口清单（共 201 个）

> 由 `node scripts/gen-api-doc.js` 从 `src/routes/*.js` 生成，勿手改。
> 约定：除标注「公开」外都需要登录（Cookie `cop_sid`），未登录 401；权限不足 403。返回 JSON；出错时 `{success:false, error, message}`。
> `/api/agent/*`、`/api/qa*`、`/api/knowledge*`、`/api/nl2sql/*`、`/api/ai/*` 由 QA / text2sql 模块（src/ai）提供，不在此表。

## 登录与账号（auth.js · 5 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| POST | `/api/login` | 公开 | body: username, password |  |
| POST | `/api/logout` | 公开 |  |  |
| GET | `/api/me` |  |  |  |
| POST | `/api/change_password` |  |  |  |
| POST | `/api/activity/track` |  | body: type, target |  |

## 客户档案 / 关键人 / 拜访 / 事件 / 质保 / OEM 映射（customers.js · 31 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/customers/list` |  |  |  |
| GET | `/api/customers/cell_caps` |  | query: oem |  |
| GET | `/api/customers/cell_products` |  | query: oem |  |
| GET | `/api/customers/by_cap` |  | query: cell_cap |  |
| GET | `/api/customers` |  | query: name_cn, level |  |
| GET | `/api/customers/:oem` |  |  |  |
| POST | `/api/customers` | customer.edit | body: oem |  |
| PUT | `/api/customers/:oem` | customer.edit |  |  |
| DELETE | `/api/customers/:oem` | customer.edit |  |  |
| POST | `/api/key_persons` | customer.edit | body: oem, name |  |
| PUT | `/api/key_persons/:id` | customer.edit |  |  |
| DELETE | `/api/key_persons/:id` | customer.edit |  |  |
| GET | `/api/key_persons/template` |  | query: oem |  |
| POST | `/api/key_persons/import` | customer.edit | body: oem<br>文件上传 |  |
| GET | `/api/visit_plans` |  | query: oem |  |
| POST | `/api/visit_plans` | visit.edit | body: oem, visit_date |  |
| PUT | `/api/visit_plans/:id` | visit.edit |  |  |
| DELETE | `/api/visit_plans/:id` | visit.edit |  |  |
| GET | `/api/events` |  | query: oem, cell_cap |  |
| POST | `/api/events` | events.edit | body: title |  |
| PUT | `/api/events/:id` | events.edit |  |  |
| DELETE | `/api/events/:id` | events.edit |  |  |
| GET | `/api/warranty_settings` |  | query: oem, cell_cap |  |
| PUT | `/api/warranty_settings/:id` | warning.edit |  |  |
| POST | `/api/warranty_settings/init` | warning.edit | query: oem, cell_cap<br>body: oem, cell_cap | 从数仓质保政策初始化（已存在的 客户×容量×车型 不覆盖） |
| POST | `/api/warranty_settings/parse-excel` | warning.edit | query: force | Excel 导入：读取 data/import/warranty.xlsx（列：客户/容量/车型/PN/乘用年限/乘用里程/乘用SOH/营运年限/营运里程/营运SOH）， 文件不存在时退化为从数仓全量初始化。force=1 覆盖已有记录。 |
| GET | `/api/oem_mapping` |  | query: oem |  |
| POST | `/api/oem_mapping` | oem_mapping.edit |  |  |
| DELETE | `/api/oem_mapping/:id` | oem_mapping.edit |  |  |
| GET | `/api/doris/oem_list` |  |  |  |
| GET | `/api/doris/cust_grp_list` |  |  |  |

## 首页看板（三视角、趋势、车辆明细、自定义模块）（dashboard.js · 18 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/dashboard/three_view` |  | query: view, oem |  |
| GET | `/api/dashboard/fast` |  | query: oem |  |
| GET | `/api/dashboard/doris` |  | query: oem |  |
| GET | `/api/dashboard` |  | query: oem |  |
| GET | `/api/dashboard/project-detail` |  | query: oem | 项目详情（旧版项目视角） |
| GET | `/api/dashboard/cell` |  |  | 电芯视角（旧版）：同一容量下各客户对比 |
| GET | `/api/access_trend` |  | query: group, oem |  |
| GET | `/api/warning_distribution` |  | query: group, oem |  |
| GET | `/api/active_vehicles` |  | query: oem, limit |  |
| GET | `/api/mileage_adjust` |  | query: oem, threshold, limit |  |
| GET | `/api/active_vehicles/export` |  | query: oem |  |
| GET | `/api/mileage_adjust/export` |  | query: oem, threshold |  |
| GET | `/api/oem_comparison` |  | query: threshold<br>body: access_count |  |
| GET | `/api/dashboard/modules` |  |  |  |
| POST | `/api/dashboard/modules` |  |  |  |
| PUT | `/api/dashboard/modules/:id` |  |  |  |
| DELETE | `/api/dashboard/modules/:id` |  |  |  |
| POST | `/api/dashboard/modules/ai-generate` |  | body: text | AI 生成图表：把自然语言描述解析成 {title, display_type, data}；无大模型时尝试解析“名称 数值”行 |

## 我的待办（workbench.js · 1 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/workbench/my_todos` |  |  |  |

## 会议纪要 / 任务 / 材料（meetings.js · 20 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/meetings` |  | query: oem, page_size, page |  |
| GET | `/api/meetings/:id` |  |  |  |
| POST | `/api/meetings` | meeting.edit | body: title |  |
| PUT | `/api/meetings/:id` | meeting.edit |  |  |
| DELETE | `/api/meetings/:id` | meeting.edit |  |  |
| POST | `/api/meetings/batch-create` | meeting.edit | body: meetings |  |
| GET | `/api/meetings/:id/export/xlsx` |  |  |  |
| GET | `/api/meetings/:id/tasks` |  |  |  |
| POST | `/api/meetings/:id/tasks` | meeting.edit | body: task_description |  |
| PUT | `/api/tasks/:id` |  |  | 任务状态：负责人本人或有会议编辑权限的人可改 |
| DELETE | `/api/tasks/:id` | meeting.edit |  |  |
| POST | `/api/tasks/:id/notify` |  |  |  |
| POST | `/api/meetings/:id/notify_tasks` |  |  |  |
| GET | `/api/meetings/:id/materials` |  |  |  |
| POST | `/api/meetings/:id/materials` | meeting.edit | 文件上传 |  |
| GET | `/api/materials/:id/download` |  |  |  |
| GET | `/api/meetings/:id/material` |  |  |  |
| DELETE | `/api/materials/:id` | meeting.edit |  |  |
| POST | `/api/meetings/ai-summarize` |  | body: text |  |
| POST | `/api/meetings/ai-summarize-batch` |  | body: oem, texts, stream<br>文件上传 |  |

## 预警闭环 / 规则 / 阶段总结（warnings.js · 16 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/warnings` |  |  |  |
| POST | `/api/warnings` | warning.edit | body: oem, failure_mode |  |
| PUT | `/api/warnings/:id` | warning.edit |  |  |
| DELETE | `/api/warnings/:id` | warning.edit |  |  |
| GET | `/api/warnings/analyses` |  | query: oem |  |
| POST | `/api/warnings/ai-analyze` |  | body: oem |  |
| GET | `/api/warning_rules` |  |  |  |
| POST | `/api/warning_rules/manage` | warning.edit | body: oem |  |
| PUT | `/api/warning_rules/manage/:id` | warning.edit |  |  |
| DELETE | `/api/warning_rules/manage/:id` | warning.edit |  |  |
| POST | `/api/warning_logic` | warning.edit | body: cell_cap |  |
| GET | `/api/stage_summary` |  |  |  |
| POST | `/api/stage_summary/:id/milestone` |  | body: note |  |
| POST | `/api/stage_summary/generate` | warning.edit | body: oem | 生成本周快照：每个客户 × 失效模式，本周外发数与上周对比（口径见报告） |
| GET | `/api/stage_summary/export` |  |  |  |
| POST | `/api/stage_summary/email` |  | body: to, cc, subject |  |

## 需求管理 / 部门需求池（demands.js · 13 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/demands` |  |  |  |
| POST | `/api/demands` | demand.edit | body: title |  |
| PUT | `/api/demands/:id` | demand.edit |  |  |
| DELETE | `/api/demands/:id` | demand.delete |  |  |
| POST | `/api/demands/:id/review` | demand.approve | body: action, comment, notify | 审批：approve → 已通过；reject → 已驳回；notify=true 时通知负责人 |
| POST | `/api/demands/ai-generate` |  | body: text, source_oem |  |
| GET | `/api/demand-pool/meta` |  |  |  |
| GET | `/api/demand-pool` |  | query: status, mine |  |
| POST | `/api/demand-pool` |  | body: description |  |
| PUT | `/api/demand-pool/:id` |  | body: _reopen |  |
| POST | `/api/demand-pool/:id/review` | demand.approve | body: action, comment |  |
| POST | `/api/demand-pool/:id/complete` |  | body: actual_date |  |
| DELETE | `/api/demand-pool/:id` |  |  |  |

## 合同管理（contracts.js · 10 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/contracts` |  |  |  |
| GET | `/api/contracts/stats` |  | body: value |  |
| POST | `/api/contracts` | contract.edit | body: title, parent_id |  |
| PUT | `/api/contracts/:id` | contract.edit | body: parent_id |  |
| DELETE | `/api/contracts/:id` | contract.edit |  |  |
| POST | `/api/contracts/:id/file` | contract.edit | 文件上传 |  |
| GET | `/api/contracts/:id/file-info` |  |  |  |
| GET | `/api/contracts/:id/file` |  | query: download |  |
| GET | `/api/contracts/export` |  |  |  |
| POST | `/api/contracts/import` | contract.edit | 文件上传 | 导入：按合同编号新增或更新；“主合同编号”列用来挂补充协议 |

## 文档管理（documents.js · 4 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/documents` |  | query: oem, capacity_ah, doc_type |  |
| POST | `/api/documents/upload` |  | body: oem, overwrite, capacity_ah, doc_type, title, uploader<br>文件上传 |  |
| GET | `/api/documents/:id/download` |  |  |  |
| DELETE | `/api/documents/:id` |  |  |  |

## 系统管理（用户、角色、权限、日志）（system.js · 22 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/users` |  |  |  |
| GET | `/api/users/all-detail` | user.manage |  |  |
| POST | `/api/users` | user.manage | body: username, password |  |
| PUT | `/api/users/:id` | user.manage |  |  |
| DELETE | `/api/users/:id` | user.manage |  |  |
| PUT | `/api/users/:id/toggle-active` | user.manage |  |  |
| PUT | `/api/users/:id/oem-perms` | user.manage | body: oems |  |
| PUT | `/api/users/:id/account-info` | user.manage | body: account_status, dynamic_cols |  |
| GET | `/api/users/:id/module-perms` | user.manage |  |  |
| PUT | `/api/users/:id/module-perms` | user.manage | body: modules |  |
| DELETE | `/api/users/:id/module-perms` | user.manage |  |  |
| POST | `/api/user-dynamic-cols` | user.manage | body: col_name | 自定义列：列定义在 user_dynamic_cols，值存每个用户的 dynamic_cols JSON |
| DELETE | `/api/user-dynamic-cols` | user.manage | query: col_key<br>body: col_key |  |
| GET | `/api/roles` |  |  |  |
| GET | `/api/permissions/pages` |  |  |  |
| GET | `/api/roles/:id/permissions` | user.manage |  |  |
| PUT | `/api/roles/:id/permissions` | user.manage | body: permissions |  |
| POST | `/api/roles` | user.manage | body: name, code, permissions |  |
| DELETE | `/api/roles/:id` | user.manage |  |  |
| GET | `/api/login_logs` |  |  |  |
| GET | `/api/operation_logs` |  |  |  |
| GET | `/api/activity/stats` | user.manage | query: type, username |  |

## 项目管理（开发日志、周会、待办）（devlogs.js · 21 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/devlogs` |  | query: done, owner, from, to |  |
| POST | `/api/devlogs` |  | body: title, created_by |  |
| PUT | `/api/devlogs/:id` |  |  |  |
| DELETE | `/api/devlogs/:id` |  |  |  |
| GET | `/api/devlogs/tree` |  |  | 树：方向 → 迭代 → 任务（递归子任务） |
| GET | `/api/devlogs/stats` |  |  |  |
| GET | `/api/devlogs/weekly` |  |  | 有记录的周列表（倒序） |
| GET | `/api/devlogs/todo` |  |  |  |
| POST | `/api/devlogs/todo` |  | body: title, created_by |  |
| PUT | `/api/devlogs/todo/:id` |  |  |  |
| DELETE | `/api/devlogs/todo/:id` |  |  |  |
| GET | `/api/devlogs/todo/export` |  |  |  |
| GET | `/api/devlogs/weekly-brief` |  | query: yw |  |
| GET | `/api/devlogs/weekly-meeting` |  | query: yw |  |
| PUT | `/api/devlogs/weekly-meeting` |  | body: yw, agenda, recap, risks, blockers, next_plan |  |
| GET | `/api/devlogs/weekly-meeting/export` |  | query: yw |  |
| POST | `/api/devlogs/weekly-claim` |  | body: kind, id, owner | 周会上认领：kind = demand \| warning \| todo \| task |
| GET | `/api/devlogs/report` |  | query: kind |  |
| GET | `/api/devlogs/export-md` |  |  |  |
| GET | `/api/devlogs/:id/meeting-export` |  |  | 会议纪要导出 Word：生成 Word 可直接打开的 HTML 文档（.doc） |
| POST | `/api/devlogs/:id/to-operations-meeting` |  | body: oem, merge | 导入到运营会议纪要（meetings 表）；已导入过时返回 409，merge=true 时覆盖更新 |

## 数据洞察（insights.js · 23 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/insights` |  |  |  |
| GET | `/api/insights/overview` |  |  |  |
| GET | `/api/insights/learnable` |  |  |  |
| GET | `/api/insights/learnable/columns` |  | query: table |  |
| GET | `/api/insights/assets-by-domain` |  |  |  |
| POST | `/api/insights/learn` |  | body: table_name |  |
| POST | `/api/insights/learn-many` |  | body: tables |  |
| GET | `/api/insights/search` |  | query: q |  |
| GET | `/api/insights/export` |  | query: table |  |
| POST | `/api/insights/report` |  | body: scope |  |
| GET | `/api/insights/signals` |  |  | 信号：所有“重点”结论；按表映射主题；带跟进状态 |
| GET | `/api/insights/followups` |  |  |  |
| POST | `/api/insights/followups` |  | body: table, title |  |
| PUT | `/api/insights/followups/:id` |  | body: status, action_note |  |
| DELETE | `/api/insights/followups/:id` |  |  |  |
| POST | `/api/insights/kb-sync` |  |  | 同步到知识库：洞察以 Markdown 形式交给 AI 模块的知识库（若其提供 knowledge.upsert），否则只返回统计 |
| POST | `/api/insights/run-query` |  | body: sql, max_rows |  |
| GET | `/api/insights/:id` |  |  |  |
| DELETE | `/api/insights/:id` |  |  |  |
| POST | `/api/insights/:id/star` |  | body: starred, note |  |
| GET | `/api/insights/:id/related` |  | body: points | 关联候选：与本表共享字段的其他表，按共享字段数打分 |
| POST | `/api/insights/:id/ties` |  | body: related | 跨表联动：按共享键关联，计算匹配率 |
| POST | `/api/insights/:id/ask` |  | body: question |  |

## 工具箱 / 意见反馈 / ADG / 查询手册 / 数据视图（misc.js · 17 个）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/tools` |  |  |  |
| POST | `/api/tools/:id/run` |  | body: params |  |
| POST | `/api/tools/manage` | tool.manage | body: name, sql_template |  |
| PUT | `/api/tools/manage/:id` | tool.manage |  |  |
| DELETE | `/api/tools/manage/:id` | tool.manage |  |  |
| GET | `/api/opinions` |  |  |  |
| POST | `/api/opinions` |  | body: content, submitter |  |
| PUT | `/api/opinions/:id` | user.manage | body: status, reply |  |
| DELETE | `/api/opinions/:id` | user.manage |  |  |
| GET | `/api/adg/systems` |  |  |  |
| POST | `/api/adg/systems` | adg.edit | body: name |  |
| PUT | `/api/adg/systems/:id` | adg.edit |  |  |
| DELETE | `/api/adg/systems/:id` | adg.edit |  |  |
| GET | `/api/handbook/list` |  |  |  |
| GET | `/api/handbook/view` |  | query: file, sheet, q, limit |  |
| GET | `/api/dataview` |  |  |  |
| GET | `/api/dataview/:key` |  | query: limit |  |

