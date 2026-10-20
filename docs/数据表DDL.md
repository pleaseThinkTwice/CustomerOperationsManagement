# 数据表 DDL

> 由 `node scripts/gen-ddl-doc.js` 从 `src/analytics/schema.js`、`src/db/schema.js` 生成，勿手改。

## 一、分析库（公司数仓，只读）

平台只 `SELECT` 这些表。字段名与类型以此为准；公司表字段名不同时，建议建同名视图对齐（见 docs/数据需求.md）。下面是 Doris 建表参考，仅在需要落一份测试表时使用。

### dim_oem — 客户维表：数仓客户编码与名称、客户组

| 字段 | 类型 | 说明 |
|---|---|---|
| oem | text | 客户编码（与平台 customers.oem 一致，如 XMS） |
| oem_ch | text | 客户中文名 |
| cust_grp_name | text | 数仓客户组名称（OEM 映射页使用） |

```sql
CREATE TABLE IF NOT EXISTS `dim_oem` (
  `oem` VARCHAR(128) COMMENT '客户编码（与平台 customers.oem 一致，如 XMS）',
  `oem_ch` VARCHAR(128) COMMENT '客户中文名',
  `cust_grp_name` VARCHAR(128) COMMENT '数仓客户组名称（OEM 映射页使用）'
) DUPLICATE KEY(`oem`) COMMENT '客户维表：数仓客户编码与名称、客户组'
DISTRIBUTED BY HASH(`oem`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dim_cell_product — 电芯产品/项目维表：一个客户 × 容量 × 车型 一行

| 字段 | 类型 | 说明 |
|---|---|---|
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah，如 153 |
| cell_structure | text | 成组方式，如 1P204S |
| pn_system | text | 电芯 PN / 项目号 |
| cell_type | text | 电芯体系：LFP / NCM / AB 等 |
| vehicle_model | text | 车型 |
| series_count | int | 串数 S |
| sop_date | date | SOP 日期 |
| plant | text | 生产基地 |

```sql
CREATE TABLE IF NOT EXISTS `dim_cell_product` (
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah，如 153',
  `cell_structure` VARCHAR(128) COMMENT '成组方式，如 1P204S',
  `pn_system` VARCHAR(128) COMMENT '电芯 PN / 项目号',
  `cell_type` VARCHAR(128) COMMENT '电芯体系：LFP / NCM / AB 等',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `series_count` BIGINT COMMENT '串数 S',
  `sop_date` DATE COMMENT 'SOP 日期',
  `plant` VARCHAR(128) COMMENT '生产基地'
) DUPLICATE KEY(`oem`) COMMENT '电芯产品/项目维表：一个客户 × 容量 × 车型 一行'
DISTRIBUTED BY HASH(`oem`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dws_shipment — 出货明细（按批次）

| 字段 | 类型 | 说明 |
|---|---|---|
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| vehicle_model | text | 车型 |
| ship_level | text | 出货层级：cell 电芯 | module 模组 | pack 系统 |
| qty | int | 数量 |
| ship_date | date | 出货日期 |
| pn | text | 出货 PN（电芯层级为电芯 PN，用于 PN 追溯） |
| batch_no | text | 电芯生产批次 |
| plant | text | 生产基地 |

```sql
CREATE TABLE IF NOT EXISTS `dws_shipment` (
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `ship_level` VARCHAR(128) COMMENT '出货层级：cell 电芯 | module 模组 | pack 系统',
  `qty` BIGINT COMMENT '数量',
  `ship_date` DATE COMMENT '出货日期',
  `pn` VARCHAR(128) COMMENT '出货 PN（电芯层级为电芯 PN，用于 PN 追溯）',
  `batch_no` VARCHAR(128) COMMENT '电芯生产批次',
  `plant` VARCHAR(128) COMMENT '生产基地'
) DUPLICATE KEY(`oem`) COMMENT '出货明细（按批次）'
DISTRIBUTED BY HASH(`oem`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dwd_vehicle_access — 车辆接入台账：每辆已接入监控平台的车（Pack）一行

| 字段 | 类型 | 说明 |
|---|---|---|
| vin | text | 车架号 |
| deviceid | text | 终端/BMS 设备号 |
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| cell_structure | text | 成组方式 |
| vehicle_model | text | 车型 |
| pack_pn | text | Pack PN（与质保条款 PN 对应） |
| pack_id | text | Pack 唯一码（为空计入 pack_id 缺失率） |
| usage_type | text | 用途：passenger 乘用 | commercial 营运 |
| access_date | date | 首次接入日期 |
| last_online_date | date | 最近一次上线日期 |
| warranty_start_date | date | 质保起算日（开票/上牌日） |
| mileage_km | real | 累计里程 km |
| soh | real | 最新 SOH % |
| cycle_count | int | 累计循环次数 |

```sql
CREATE TABLE IF NOT EXISTS `dwd_vehicle_access` (
  `vin` VARCHAR(128) COMMENT '车架号',
  `deviceid` VARCHAR(128) COMMENT '终端/BMS 设备号',
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `cell_structure` VARCHAR(128) COMMENT '成组方式',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `pack_pn` VARCHAR(128) COMMENT 'Pack PN（与质保条款 PN 对应）',
  `pack_id` VARCHAR(128) COMMENT 'Pack 唯一码（为空计入 pack_id 缺失率）',
  `usage_type` VARCHAR(128) COMMENT '用途：passenger 乘用 | commercial 营运',
  `access_date` DATE COMMENT '首次接入日期',
  `last_online_date` DATE COMMENT '最近一次上线日期',
  `warranty_start_date` DATE COMMENT '质保起算日（开票/上牌日）',
  `mileage_km` DOUBLE COMMENT '累计里程 km',
  `soh` DOUBLE COMMENT '最新 SOH %',
  `cycle_count` BIGINT COMMENT '累计循环次数'
) DUPLICATE KEY(`vin`) COMMENT '车辆接入台账：每辆已接入监控平台的车（Pack）一行'
DISTRIBUTED BY HASH(`vin`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dwd_warning — 电池预警明细：算法触发的每条预警一行（外发=推送给客户）

| 字段 | 类型 | 说明 |
|---|---|---|
| warning_id | text | 预警唯一编号 |
| vin | text | 车架号 |
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| vehicle_model | text | 车型 |
| fault_type | text | 失效模式/故障类型，如 绝缘故障、压差报警 |
| warning_time | datetime | 预警触发时间 |
| is_outgoing | int | 是否外发给客户 1/0 |
| is_closed | int | 是否闭环 1/0 |
| close_time | datetime | 闭环时间 |
| is_complaint | int | 是否形成客诉 1/0 |
| batch_no | text | 电芯批次 |
| pack_no | text | Pack 编号 |
| cell_pos | text | 电芯位置 |
| soh | real | 预警时 SOH % |

```sql
CREATE TABLE IF NOT EXISTS `dwd_warning` (
  `warning_id` VARCHAR(128) COMMENT '预警唯一编号',
  `vin` VARCHAR(128) COMMENT '车架号',
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `fault_type` VARCHAR(128) COMMENT '失效模式/故障类型，如 绝缘故障、压差报警',
  `warning_time` DATETIME COMMENT '预警触发时间',
  `is_outgoing` BIGINT COMMENT '是否外发给客户 1/0',
  `is_closed` BIGINT COMMENT '是否闭环 1/0',
  `close_time` DATETIME COMMENT '闭环时间',
  `is_complaint` BIGINT COMMENT '是否形成客诉 1/0',
  `batch_no` VARCHAR(128) COMMENT '电芯批次',
  `pack_no` VARCHAR(128) COMMENT 'Pack 编号',
  `cell_pos` VARCHAR(128) COMMENT '电芯位置',
  `soh` DOUBLE COMMENT '预警时 SOH %'
) DUPLICATE KEY(`warning_id`) COMMENT '电池预警明细：算法触发的每条预警一行（外发=推送给客户）'
DISTRIBUTED BY HASH(`warning_id`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dwd_work_order — 售后工单：预警工单 / 批改工单 / 现场工单（现场工单 = 失效车辆口径）

| 字段 | 类型 | 说明 |
|---|---|---|
| wo_id | text | 工单号 |
| wo_type | text | 工单类型：预警 | 批改 | 现场 |
| vin | text | 车架号 |
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| vehicle_model | text | 车型 |
| pn | text | 电芯 PN |
| fault_type | text | 失效模式 |
| create_time | datetime | 开单时间 |
| close_time | datetime | 关单时间 |
| plant | text | 电芯生产基地 |

```sql
CREATE TABLE IF NOT EXISTS `dwd_work_order` (
  `wo_id` VARCHAR(128) COMMENT '工单号',
  `wo_type` VARCHAR(128) COMMENT '工单类型：预警 | 批改 | 现场',
  `vin` VARCHAR(128) COMMENT '车架号',
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `pn` VARCHAR(128) COMMENT '电芯 PN',
  `fault_type` VARCHAR(128) COMMENT '失效模式',
  `create_time` DATETIME COMMENT '开单时间',
  `close_time` DATETIME COMMENT '关单时间',
  `plant` VARCHAR(128) COMMENT '电芯生产基地'
) DUPLICATE KEY(`wo_id`) COMMENT '售后工单：预警工单 / 批改工单 / 现场工单（现场工单 = 失效车辆口径）'
DISTRIBUTED BY HASH(`wo_id`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dwd_mileage_adjust — 疑似调表记录：同车里程回退/跳变检测结果

| 字段 | 类型 | 说明 |
|---|---|---|
| vin | text | 车架号 |
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| check_date | date | 检测日期 |
| mileage_diff_km | real | 里程差（万公里口径前端换算） |

```sql
CREATE TABLE IF NOT EXISTS `dwd_mileage_adjust` (
  `vin` VARCHAR(128) COMMENT '车架号',
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `check_date` DATE COMMENT '检测日期',
  `mileage_diff_km` DOUBLE COMMENT '里程差（万公里口径前端换算）'
) DUPLICATE KEY(`vin`) COMMENT '疑似调表记录：同车里程回退/跳变检测结果'
DISTRIBUTED BY HASH(`vin`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

### dim_warranty_policy — 质保政策（用于初始化平台 warranty_settings）

| 字段 | 类型 | 说明 |
|---|---|---|
| oem | text | 客户编码 |
| cell_cap | text | 电芯容量 Ah |
| vehicle_model | text | 车型 |
| pn | text | PN |
| passenger_years | real | 乘用质保年限 |
| passenger_mileage | real | 乘用质保里程 km |
| passenger_soh | real | 乘用质保 SOH 下限 % |
| commercial_years | real | 营运质保年限 |
| commercial_mileage | real | 营运质保里程 km |
| commercial_soh | real | 营运质保 SOH 下限 % |

```sql
CREATE TABLE IF NOT EXISTS `dim_warranty_policy` (
  `oem` VARCHAR(128) COMMENT '客户编码',
  `cell_cap` VARCHAR(128) COMMENT '电芯容量 Ah',
  `vehicle_model` VARCHAR(128) COMMENT '车型',
  `pn` VARCHAR(128) COMMENT 'PN',
  `passenger_years` DOUBLE COMMENT '乘用质保年限',
  `passenger_mileage` DOUBLE COMMENT '乘用质保里程 km',
  `passenger_soh` DOUBLE COMMENT '乘用质保 SOH 下限 %',
  `commercial_years` DOUBLE COMMENT '营运质保年限',
  `commercial_mileage` DOUBLE COMMENT '营运质保里程 km',
  `commercial_soh` DOUBLE COMMENT '营运质保 SOH 下限 %'
) DUPLICATE KEY(`oem`) COMMENT '质保政策（用于初始化平台 warranty_settings）'
DISTRIBUTED BY HASH(`oem`) BUCKETS 8 PROPERTIES ("replication_num" = "1");
```

## 二、运营库（平台自有业务表）

服务启动时自动建表（sqlite 默认；`OPS_DB_DRIVER=mysql` 时在 MySQL 建同样的表），一般不需要手工执行。以下为 MySQL 版本，便于 DBA 预建或审阅。

| 表 | 说明 |
|---|---|
| roles | 角色 |
| users | 平台账号 |
| user_dynamic_cols | 用户表自定义列 |
| login_logs | 登录日志 |
| operation_logs | 操作日志（写请求审计） |
| activity_logs | 页面访问埋点 |
| customers | 客户档案 |
| key_persons | 客户关键人（外部）与我方对接人（内部） |
| visit_plans | 拜访计划 |
| meetings | 会议纪要 |
| meeting_consensus | 会议共识 |
| tasks | 会议待办任务 |
| materials | 会议归档材料（文件存 data/uploads） |
| events | 客户/项目大事记 |
| warnings | 预警闭环台账 |
| warning_analyses | AI 预警分析留档 |
| warning_logic | 失效模式外发判定逻辑说明 |
| warning_rules | 预警外发规则 |
| stage_summary | 阶段总结（按客户×失效模式的周期快照） |
| warranty_settings | 质保条款（按客户×容量×车型） |
| documents | 客户文档（规格书/报告/协议） |
| oem_mapping | 平台 oem ↔ 数仓客户组映射 |
| demands | 客户需求（审批流） |
| demand_pool | 内部需求池 |
| demand_categories | 需求池分类 |
| contracts | 合同 |
| dashboard_modules | 首页自定义图表模块 |
| tools | 工具箱：参数化 SQL 查询 |
| opinions | 意见箱 |
| devlogs | 项目日志：任务树 / 会议 / 里程碑 |
| devlog_todos | 项目待完善池 |
| weekly_meetings | 周会纪要（按 ISO 年周） |
| insights | 数据洞察（对分析库表的学习结果） |
| insight_followups | 洞察信号跟进 |
| adg_systems | 系统导航（ADG） |

```sql
CREATE TABLE IF NOT EXISTS `roles` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255) COMMENT '角色名',
  `code` VARCHAR(255) COMMENT '角色编码，唯一',
  `description` VARCHAR(255),
  `is_builtin` TINYINT(1) COMMENT '内置角色不可删',
  `permissions` JSON COMMENT '权限码数组，["*"] 表示全部',
  UNIQUE (`code`)
) COMMENT='角色' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(255) COMMENT '登录名，唯一',
  `name` VARCHAR(255) COMMENT '姓名',
  `password_hash` VARCHAR(255) COMMENT 'scrypt 哈希',
  `role_id` BIGINT COMMENT '→ roles.id',
  `department` VARCHAR(255),
  `position` VARCHAR(255),
  `employee_id` VARCHAR(255) COMMENT '工号',
  `email` VARCHAR(255),
  `is_active` TINYINT(1),
  `account_status` VARCHAR(255) COMMENT '在职/离职/冻结',
  `must_change_password` TINYINT(1),
  `oem_perms` JSON COMMENT '可见客户 oem 数组，空=全部',
  `module_override` JSON COMMENT '个人可见模块覆盖，null=跟随角色',
  `dynamic_cols` JSON COMMENT '自定义列值 {col_key: value}',
  `last_login_at` DATETIME,
  `created_at` DATETIME,
  UNIQUE (`username`)
) COMMENT='平台账号' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_dynamic_cols` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `col_key` VARCHAR(255),
  `col_name` VARCHAR(255)
) COMMENT='用户表自定义列' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `login_logs` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(255),
  `ip` VARCHAR(255),
  `success` TINYINT(1),
  `detail` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='登录日志' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(255),
  `method` VARCHAR(255),
  `path` VARCHAR(255),
  `status` BIGINT,
  `created_at` DATETIME
) COMMENT='操作日志（写请求审计）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `activity_logs` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(255),
  `type` VARCHAR(255),
  `target` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='页面访问埋点' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `customers` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255) COMMENT '客户编码，唯一，全平台主键',
  `oem_ch` VARCHAR(255) COMMENT '中文简称',
  `name_cn` VARCHAR(255),
  `name_en` VARCHAR(255),
  `address` VARCHAR(255),
  `location` VARCHAR(255) COMMENT '区域',
  `kpi` VARCHAR(255) COMMENT '客户 KPI 等级',
  `decision_auth` VARCHAR(255) COMMENT '决策权',
  `level` VARCHAR(255) COMMENT 'S/A/B 级',
  `cooperation_scope` VARCHAR(255),
  `relationship_status` VARCHAR(255),
  `market_quality` VARCHAR(255),
  `algorithm_capability` VARCHAR(255),
  `created_at` DATETIME,
  `updated_at` DATETIME,
  UNIQUE (`oem`)
) COMMENT='客户档案' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `key_persons` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255) COMMENT '→ customers.oem',
  `type` VARCHAR(255) COMMENT 'external | internal',
  `name` VARCHAR(255),
  `department` VARCHAR(255),
  `position` VARCHAR(255),
  `style` VARCHAR(255) COMMENT '沟通风格',
  `phone` VARCHAR(255),
  `email` VARCHAR(255),
  `superior` VARCHAR(255) COMMENT '上级姓名，用于组织架构树',
  `created_at` DATETIME
) COMMENT='客户关键人（外部）与我方对接人（内部）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `visit_plans` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `visit_date` DATE,
  `subject` VARCHAR(255),
  `contact_person` VARCHAR(255),
  `contact_phone` VARCHAR(255),
  `visit_content` TEXT,
  `is_completed` TINYINT(1),
  `summary` TEXT,
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='拜访计划' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `meetings` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `title` VARCHAR(255),
  `meeting_date` DATE,
  `purpose` TEXT,
  `participants_external` VARCHAR(255),
  `participants_internal` VARCHAR(255),
  `recorder` VARCHAR(255),
  `material_name` VARCHAR(255),
  `source_devlog_id` BIGINT COMMENT '从项目日志导入时的来源',
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='会议纪要' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `meeting_consensus` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `meeting_id` BIGINT,
  `content` TEXT,
  `sort_order` BIGINT
) COMMENT='会议共识' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tasks` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `meeting_id` BIGINT,
  `task_description` TEXT,
  `owner` VARCHAR(255) COMMENT '责任人姓名',
  `planned_date` DATE,
  `actual_date` DATE,
  `status` VARCHAR(255) COMMENT '未完成/进行中/已完成/已取消',
  `created_at` DATETIME
) COMMENT='会议待办任务' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `materials` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `meeting_id` BIGINT,
  `filename` VARCHAR(255),
  `stored_path` VARCHAR(255),
  `file_size` BIGINT,
  `mime` VARCHAR(255),
  `uploaded_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='会议归档材料（文件存 data/uploads）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `events` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `cell_cap` VARCHAR(255),
  `event_type` VARCHAR(255) COMMENT '召回/OTA/停线/批量预警/索赔/质量会/SOP/工艺变更/其他',
  `title` VARCHAR(255),
  `occur_at` DATE,
  `description` TEXT,
  `status` VARCHAR(255) COMMENT '待处理/处理中/已闭环',
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='客户/项目大事记' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `warnings` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `capacity_ah` VARCHAR(255),
  `risk_type` VARCHAR(255),
  `failure_mode` VARCHAR(255),
  `warning_count` BIGINT,
  `closure_status` VARCHAR(255) COMMENT '已闭环/未闭环',
  `unclosed_reason` VARCHAR(255),
  `dispatch_logic` VARCHAR(255),
  `dispatched_count` BIGINT,
  `action_taken` VARCHAR(255),
  `owner` VARCHAR(255) COMMENT '认领人（我的待办 / 周会认领）',
  `closed_by` VARCHAR(255),
  `closed_at` DATE,
  `created_at` DATETIME,
  `updated_at` DATETIME
) COMMENT='预警闭环台账' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `warning_analyses` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `analysis` TEXT,
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='AI 预警分析留档' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `warning_logic` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `cell_cap` VARCHAR(255),
  `fault_type` VARCHAR(255),
  `logic_text` TEXT,
  `updated_by` VARCHAR(255),
  `updated_at` DATETIME,
  UNIQUE (`oem`, `cell_cap`, `fault_type`)
) COMMENT='失效模式外发判定逻辑说明' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `warning_rules` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `vehicle_model` VARCHAR(255),
  `cell_cap` VARCHAR(255),
  `shipment_type` VARCHAR(255),
  `algorithm` VARCHAR(255),
  `abnormal_location` VARCHAR(255),
  `threshold` VARCHAR(255),
  `external_send` VARCHAR(255) COMMENT '是否外发',
  `overdue_send` VARCHAR(255),
  `no_send_days` BIGINT,
  `repair_suggestion` TEXT,
  `top_order` BIGINT,
  `status` VARCHAR(255),
  `vin` VARCHAR(255),
  `outgoing_count` BIGINT,
  `overdue_count` BIGINT,
  `work_order_done` BIGINT,
  `create_time` DATETIME
) COMMENT='预警外发规则' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `stage_summary` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `summary_date` DATE,
  `failure_mode` VARCHAR(255),
  `dispatch_count` BIGINT COMMENT '本期外发数',
  `reduced_breakdown` BIGINT COMMENT '较上期减少数',
  `is_milestone` TINYINT(1),
  `milestone_note` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='阶段总结（按客户×失效模式的周期快照）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `warranty_settings` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `cell_cap` VARCHAR(255),
  `vehicle_model` VARCHAR(255),
  `pn` VARCHAR(255),
  `passenger_years` DOUBLE,
  `passenger_mileage` DOUBLE,
  `passenger_soh` DOUBLE,
  `commercial_years` DOUBLE,
  `commercial_mileage` DOUBLE,
  `commercial_soh` DOUBLE,
  `source` VARCHAR(255) COMMENT 'doris/excel/manual',
  `updated_at` DATETIME
) COMMENT='质保条款（按客户×容量×车型）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `documents` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `capacity_ah` VARCHAR(255),
  `doc_type` VARCHAR(255),
  `title` VARCHAR(255),
  `file_name` VARCHAR(255),
  `stored_path` VARCHAR(255),
  `file_size` BIGINT,
  `uploader` VARCHAR(255),
  `upload_date` DATE
) COMMENT='客户文档（规格书/报告/协议）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `oem_mapping` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `oem` VARCHAR(255),
  `oem_ch` VARCHAR(255),
  `cust_grp_name` VARCHAR(255) COMMENT '数仓 cust_grp_name',
  `created_at` DATETIME
) COMMENT='平台 oem ↔ 数仓客户组映射' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `demands` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `title` VARCHAR(255),
  `source_oem` VARCHAR(255),
  `background` TEXT,
  `tags` VARCHAR(255),
  `owner` VARCHAR(255),
  `owner_employee_id` VARCHAR(255),
  `demanded_by` VARCHAR(255),
  `priority` VARCHAR(255) COMMENT '高/中/低',
  `start_date` DATE,
  `due_date` DATE,
  `status` VARCHAR(255) COMMENT '待审批/进行中/已驳回/已完成',
  `meeting_id` BIGINT,
  `review_comment` VARCHAR(255),
  `reviewed_by` VARCHAR(255),
  `reviewed_at` DATETIME,
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='客户需求（审批流）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `demand_pool` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `description` TEXT,
  `category` VARCHAR(255),
  `priority` VARCHAR(255),
  `owner` VARCHAR(255),
  `planned_date` DATE,
  `actual_date` DATE,
  `status` VARCHAR(255) COMMENT '待审批/已通过/已驳回/已完成',
  `submitter` VARCHAR(255),
  `reviewer` VARCHAR(255),
  `review_comment` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='内部需求池' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `demand_categories` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255)
) COMMENT='需求池分类' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `contracts` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `contract_no` VARCHAR(255),
  `title` VARCHAR(255),
  `parent_id` BIGINT COMMENT '主合同 id，补充协议挂在其下',
  `oem` VARCHAR(255),
  `contract_type` VARCHAR(255),
  `status` VARCHAR(255),
  `sign_date` DATE,
  `start_date` DATE,
  `end_date` DATE,
  `amount` DOUBLE,
  `currency` VARCHAR(255),
  `their_company` VARCHAR(255),
  `their_signer` VARCHAR(255),
  `payment_terms` VARCHAR(255),
  `important_notes` TEXT,
  `remark` TEXT,
  `file_name` VARCHAR(255),
  `stored_path` VARCHAR(255),
  `file_size` BIGINT,
  `created_at` DATETIME
) COMMENT='合同' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_modules` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `title` VARCHAR(255),
  `display_type` VARCHAR(255),
  `data` JSON,
  `sort_order` BIGINT,
  `created_by` VARCHAR(255)
) COMMENT='首页自定义图表模块' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tools` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255),
  `description` VARCHAR(255),
  `category` VARCHAR(255),
  `params` JSON,
  `sql_template` TEXT,
  `result_columns` JSON,
  `enabled` TINYINT(1)
) COMMENT='工具箱：参数化 SQL 查询' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `opinions` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `content` TEXT,
  `category` VARCHAR(255),
  `module` VARCHAR(255),
  `contact` VARCHAR(255),
  `submitter` VARCHAR(255),
  `page` VARCHAR(255),
  `status` VARCHAR(255) COMMENT '待处理/处理中/已采纳/已关闭',
  `reply` TEXT,
  `created_at` DATETIME
) COMMENT='意见箱' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `devlogs` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `title` VARCHAR(255),
  `entry_type` VARCHAR(255) COMMENT 'task | meeting | milestone',
  `parent_id` BIGINT COMMENT '父任务；会议行动项挂在会议下',
  `owner` VARCHAR(255),
  `priority` VARCHAR(255),
  `status` VARCHAR(255) COMMENT '未开始/进行中/已完成/已暂停',
  `start_date` DATE,
  `due_date` DATE,
  `actual_date` DATE COMMENT '实际完成日',
  `description` TEXT,
  `direction` VARCHAR(255) COMMENT '方向',
  `iteration` VARCHAR(255) COMMENT '迭代',
  `module` VARCHAR(255),
  `depend_on` VARCHAR(255),
  `estimate` DOUBLE COMMENT '预估人天',
  `progress` BIGINT COMMENT '里程碑进度%',
  `meeting_date` DATE,
  `meeting_time` VARCHAR(255),
  `meeting_location` VARCHAR(255),
  `attendees` VARCHAR(255),
  `topics` TEXT,
  `minutes` TEXT,
  `created_by` VARCHAR(255),
  `created_at` DATETIME,
  `updated_at` DATETIME
) COMMENT='项目日志：任务树 / 会议 / 里程碑' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `devlog_todos` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `title` VARCHAR(255),
  `detail` TEXT,
  `source` VARCHAR(255),
  `priority` VARCHAR(255),
  `status` VARCHAR(255),
  `tag` VARCHAR(255),
  `oem` VARCHAR(255),
  `owner` VARCHAR(255),
  `created_by` VARCHAR(255),
  `created_at` DATETIME
) COMMENT='项目待完善池' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `weekly_meetings` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `yw` VARCHAR(255) COMMENT '如 2026-W38',
  `agenda` TEXT,
  `recap` TEXT,
  `risks` TEXT,
  `blockers` TEXT,
  `next_plan` TEXT,
  `updated_at` DATETIME,
  UNIQUE (`yw`)
) COMMENT='周会纪要（按 ISO 年周）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `insights` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `table_name` VARCHAR(255),
  `db` VARCHAR(255),
  `status` VARCHAR(255),
  `meta` JSON,
  `charts` JSON,
  `conclusions` JSON,
  `columns_meta` JSON,
  `joins` JSON,
  `starred` TINYINT(1),
  `note` VARCHAR(255),
  `trigger_by` VARCHAR(255),
  `updated_at` DATETIME,
  UNIQUE (`table_name`)
) COMMENT='数据洞察（对分析库表的学习结果）' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `insight_followups` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `table_name` VARCHAR(255),
  `title` VARCHAR(255),
  `status` VARCHAR(255) COMMENT '待跟进/处理中/已闭环',
  `action_note` VARCHAR(255),
  `created_by` VARCHAR(255),
  `created_at` DATETIME,
  `updated_at` DATETIME
) COMMENT='洞察信号跟进' DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `adg_systems` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255),
  `url` VARCHAR(255),
  `purpose` VARCHAR(255),
  `status` VARCHAR(255),
  `access` VARCHAR(255),
  `owner` VARCHAR(255),
  `sort_order` BIGINT
) COMMENT='系统导航（ADG）' DEFAULT CHARSET=utf8mb4;
```
