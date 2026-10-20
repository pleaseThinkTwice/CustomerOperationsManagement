'use strict';
// 运营库表结构（平台自有数据）。同一份描述同时用于：建表 DDL（sqlite/mysql）、通用 CRUD、数据需求报告。
// 列类型：id 自增主键 | text 短文本 | longtext 长文本 | int | real | date(YYYY-MM-DD) | datetime | bool | json(存 JSON 字符串)
const T = (comment, cols, extra = {}) => ({ comment, cols, ...extra });
const c = (type, comment = '') => ({ type, comment });

const tables = {
  roles: T('角色', {
    id: c('id'), name: c('text', '角色名'), code: c('text', '角色编码，唯一'), description: c('text'),
    is_builtin: c('bool', '内置角色不可删'), permissions: c('json', '权限码数组，["*"] 表示全部'),
  }, { unique: [['code']] }),
  users: T('平台账号', {
    id: c('id'), username: c('text', '登录名，唯一'), name: c('text', '姓名'), password_hash: c('text', 'scrypt 哈希'),
    role_id: c('int', '→ roles.id'), department: c('text'), position: c('text'), employee_id: c('text', '工号'),
    email: c('text'), is_active: c('bool'), account_status: c('text', '在职/离职/冻结'),
    must_change_password: c('bool'), oem_perms: c('json', '可见客户 oem 数组，空=全部'),
    module_override: c('json', '个人可见模块覆盖，null=跟随角色'), dynamic_cols: c('json', '自定义列值 {col_key: value}'),
    last_login_at: c('datetime'), created_at: c('datetime'),
  }, { unique: [['username']] }),
  user_dynamic_cols: T('用户表自定义列', { id: c('id'), col_key: c('text'), col_name: c('text') }),
  login_logs: T('登录日志', {
    id: c('id'), username: c('text'), ip: c('text'), success: c('bool'), detail: c('text'), created_at: c('datetime'),
  }),
  operation_logs: T('操作日志（写请求审计）', {
    id: c('id'), username: c('text'), method: c('text'), path: c('text'), status: c('int'), created_at: c('datetime'),
  }),
  activity_logs: T('页面访问埋点', {
    id: c('id'), username: c('text'), type: c('text'), target: c('text'), created_at: c('datetime'),
  }),

  customers: T('客户档案', {
    id: c('id'), oem: c('text', '客户编码，唯一，全平台主键'), oem_ch: c('text', '中文简称'), name_cn: c('text'), name_en: c('text'),
    address: c('text'), location: c('text', '区域'), kpi: c('text', '客户 KPI 等级'), decision_auth: c('text', '决策权'),
    level: c('text', 'S/A/B 级'), cooperation_scope: c('text'), relationship_status: c('text'), market_quality: c('text'),
    algorithm_capability: c('text'), created_at: c('datetime'), updated_at: c('datetime'),
  }, { unique: [['oem']] }),
  key_persons: T('客户关键人（外部）与我方对接人（内部）', {
    id: c('id'), oem: c('text', '→ customers.oem'), type: c('text', 'external | internal'), name: c('text'),
    department: c('text'), position: c('text'), style: c('text', '沟通风格'), phone: c('text'), email: c('text'),
    superior: c('text', '上级姓名，用于组织架构树'), created_at: c('datetime'),
  }),
  visit_plans: T('拜访计划', {
    id: c('id'), oem: c('text'), visit_date: c('date'), subject: c('text'), contact_person: c('text'), contact_phone: c('text'),
    visit_content: c('longtext'), is_completed: c('bool'), summary: c('longtext'), created_by: c('text'), created_at: c('datetime'),
  }),
  meetings: T('会议纪要', {
    id: c('id'), oem: c('text'), title: c('text'), meeting_date: c('date'), purpose: c('longtext'),
    participants_external: c('text'), participants_internal: c('text'), recorder: c('text'), material_name: c('text'),
    created_by: c('text'), created_at: c('datetime'),
  }),
  meeting_consensus: T('会议共识', { id: c('id'), meeting_id: c('int'), content: c('longtext'), sort_order: c('int') }),
  tasks: T('会议待办任务', {
    id: c('id'), meeting_id: c('int'), task_description: c('longtext'), owner: c('text', '责任人姓名'),
    planned_date: c('date'), actual_date: c('date'), status: c('text', '未完成/进行中/已完成/已取消'), created_at: c('datetime'),
  }),
  materials: T('会议归档材料（文件存 data/uploads）', {
    id: c('id'), meeting_id: c('int'), filename: c('text'), stored_path: c('text'), file_size: c('int'), mime: c('text'),
    uploaded_by: c('text'), created_at: c('datetime'),
  }),
  events: T('客户/项目大事记', {
    id: c('id'), oem: c('text'), cell_cap: c('text'), event_type: c('text', '召回/OTA/停线/批量预警/索赔/质量会/SOP/工艺变更/其他'),
    title: c('text'), occur_at: c('date'), description: c('longtext'), status: c('text', '待处理/处理中/已闭环'),
    created_by: c('text'), created_at: c('datetime'),
  }),
  warnings: T('预警闭环台账', {
    id: c('id'), oem: c('text'), capacity_ah: c('text'), risk_type: c('text'), failure_mode: c('text'), warning_count: c('int'),
    closure_status: c('text', '已闭环/未闭环'), unclosed_reason: c('text'), dispatch_logic: c('text'), dispatched_count: c('int'),
    action_taken: c('text'), owner: c('text', '认领人（我的待办 / 周会认领）'), closed_by: c('text'), closed_at: c('date'), created_at: c('datetime'), updated_at: c('datetime'),
  }),
  warning_analyses: T('AI 预警分析留档', {
    id: c('id'), oem: c('text'), analysis: c('longtext'), created_by: c('text'), created_at: c('datetime'),
  }),
  warning_logic: T('失效模式外发判定逻辑说明', {
    id: c('id'), oem: c('text'), cell_cap: c('text'), fault_type: c('text'), logic_text: c('longtext'),
    updated_by: c('text'), updated_at: c('datetime'),
  }, { unique: [['oem', 'cell_cap', 'fault_type']] }),
  warning_rules: T('预警外发规则', {
    id: c('id'), oem: c('text'), vehicle_model: c('text'), cell_cap: c('text'), shipment_type: c('text'), algorithm: c('text'),
    abnormal_location: c('text'), threshold: c('text'), external_send: c('text', '是否外发'), overdue_send: c('text'),
    no_send_days: c('int'), repair_suggestion: c('longtext'), top_order: c('int'), status: c('text'), vin: c('text'),
    outgoing_count: c('int'), overdue_count: c('int'), work_order_done: c('int'), create_time: c('datetime'),
  }),
  stage_summary: T('阶段总结（按客户×失效模式的周期快照）', {
    id: c('id'), oem: c('text'), summary_date: c('date'), failure_mode: c('text'), dispatch_count: c('int', '本期外发数'),
    reduced_breakdown: c('int', '较上期减少数'), is_milestone: c('bool'), milestone_note: c('text'), created_at: c('datetime'),
  }),
  warranty_settings: T('质保条款（按客户×容量×车型）', {
    id: c('id'), oem: c('text'), cell_cap: c('text'), vehicle_model: c('text'), pn: c('text'),
    passenger_years: c('real'), passenger_mileage: c('real'), passenger_soh: c('real'),
    commercial_years: c('real'), commercial_mileage: c('real'), commercial_soh: c('real'),
    source: c('text', 'doris/excel/manual'), updated_at: c('datetime'),
  }),
  documents: T('客户文档（规格书/报告/协议）', {
    id: c('id'), oem: c('text'), capacity_ah: c('text'), doc_type: c('text'), title: c('text'), file_name: c('text'),
    stored_path: c('text'), file_size: c('int'), uploader: c('text'), upload_date: c('date'),
  }),
  oem_mapping: T('平台 oem ↔ 数仓客户组映射', {
    id: c('id'), oem: c('text'), oem_ch: c('text'), cust_grp_name: c('text', '数仓 cust_grp_name'), created_at: c('datetime'),
  }),
  demands: T('客户需求（审批流）', {
    id: c('id'), title: c('text'), source_oem: c('text'), background: c('longtext'), tags: c('text'), owner: c('text'),
    owner_employee_id: c('text'), demanded_by: c('text'), priority: c('text', '高/中/低'), start_date: c('date'),
    due_date: c('date'), status: c('text', '待审批/进行中/已驳回/已完成'), meeting_id: c('int'),
    review_comment: c('text'), reviewed_by: c('text'), reviewed_at: c('datetime'), created_by: c('text'), created_at: c('datetime'),
  }),
  demand_pool: T('内部需求池', {
    id: c('id'), description: c('longtext'), category: c('text'), priority: c('text'), owner: c('text'),
    planned_date: c('date'), actual_date: c('date'), status: c('text', '待审批/已通过/已驳回/已完成'),
    submitter: c('text'), reviewer: c('text'), review_comment: c('text'), created_at: c('datetime'),
  }),
  demand_categories: T('需求池分类', { id: c('id'), name: c('text') }),
  contracts: T('合同', {
    id: c('id'), contract_no: c('text'), title: c('text'), parent_id: c('int', '主合同 id，补充协议挂在其下'), oem: c('text'),
    contract_type: c('text'), status: c('text'), sign_date: c('date'), start_date: c('date'), end_date: c('date'),
    amount: c('real'), currency: c('text'), their_company: c('text'), their_signer: c('text'), payment_terms: c('text'),
    important_notes: c('longtext'), remark: c('longtext'), file_name: c('text'), stored_path: c('text'), file_size: c('int'),
    created_at: c('datetime'),
  }),
  dashboard_modules: T('首页自定义图表模块', {
    id: c('id'), title: c('text'), display_type: c('text'), data: c('json'), sort_order: c('int'), created_by: c('text'),
  }),
  tools: T('工具箱：参数化 SQL 查询', {
    id: c('id'), name: c('text'), description: c('text'), category: c('text'), params: c('json'), sql_template: c('longtext'),
    result_columns: c('json'), enabled: c('bool'),
  }),

  insights: T('数据洞察（对分析库表的学习结果）', {
    id: c('id'), table_name: c('text'), db: c('text'), status: c('text'), meta: c('json'), charts: c('json'),
    conclusions: c('json'), columns_meta: c('json'), joins: c('json'), starred: c('bool'), note: c('text'),
    trigger_by: c('text'), updated_at: c('datetime'),
  }, { unique: [['table_name']] }),
  insight_followups: T('洞察信号跟进', {
    id: c('id'), table_name: c('text'), title: c('text'), status: c('text', '待跟进/处理中/已闭环'), action_note: c('text'),
    created_by: c('text'), created_at: c('datetime'), updated_at: c('datetime'),
  }),
  adg_systems: T('系统导航（ADG）', {
    id: c('id'), name: c('text'), url: c('text'), purpose: c('text'), status: c('text'), access: c('text'), owner: c('text'),
    sort_order: c('int'),
  }),
};

const SQL_TYPES = {
  sqlite: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', text: 'TEXT', longtext: 'TEXT', int: 'INTEGER', real: 'REAL', date: 'TEXT', datetime: 'TEXT', bool: 'INTEGER', json: 'TEXT' },
  mysql: { id: 'BIGINT PRIMARY KEY AUTO_INCREMENT', text: 'VARCHAR(255)', longtext: 'TEXT', int: 'BIGINT', real: 'DOUBLE', date: 'DATE', datetime: 'DATETIME', bool: 'TINYINT(1)', json: 'JSON' },
};

function ddl(dialect) {
  const types = SQL_TYPES[dialect];
  const q = dialect === 'mysql' ? (s) => '`' + s + '`' : (s) => `"${s}"`;
  const out = [];
  for (const [name, t] of Object.entries(tables)) {
    const cols = Object.entries(t.cols).map(([col, d]) => {
      const cm = dialect === 'mysql' && d.comment ? ` COMMENT '${d.comment.replace(/'/g, "''")}'` : '';
      return `  ${q(col)} ${types[d.type]}${cm}`;
    });
    for (const u of t.unique || []) cols.push(`  UNIQUE (${u.map(q).join(', ')})`);
    const tail = dialect === 'mysql' ? ` COMMENT='${t.comment}' DEFAULT CHARSET=utf8mb4` : '';
    out.push(`CREATE TABLE IF NOT EXISTS ${q(name)} (\n${cols.join(',\n')}\n)${tail};`);
  }
  return out.join('\n\n');
}

module.exports = { tables, ddl };
