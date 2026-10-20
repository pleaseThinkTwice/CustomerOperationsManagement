'use strict';
// 首次启动时初始化运营库：建表 + 内置角色/管理员 + 一套演示业务数据（可用 SEED_DEMO=0 关闭演示数据）。
const { ddl } = require('./schema');
const { hashPassword } = require('../core/auth');
const config = require('../config');
const { PAGES, EDITS } = require('../core/perms');

const pad = (n) => String(n).padStart(2, '0');
const dayOffset = (n) => { const d = new Date(Date.now() + n * 86400e3); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function migrate(db) {
  for (const stmt of ddl(db.dialect.name).split(/;\s*\n/)) if (stmt.trim()) await db.exec(stmt.trim().replace(/;$/, '') + ';');
}

async function seed(db, repo) {
  await migrate(db);
  if (await repo.count('roles')) return false;

  const allPages = PAGES.map((p) => p.perm);
  const adminRole = await repo.insert('roles', { name: '管理员', code: 'admin', description: '全部权限', is_builtin: true, permissions: ['*'] });
  const opRole = await repo.insert('roles', {
    name: '客户运营', code: 'operator', description: '日常运营：全部页面 + 业务编辑，不含系统管理', is_builtin: true,
    permissions: [...allPages.filter((p) => p !== 'user.manage'), ...EDITS.map((e) => e.perm).filter((p) => !['tool.manage', 'demand.approve', 'demand.delete'].includes(p))],
  });
  const viewRole = await repo.insert('roles', { name: '只读访客', code: 'viewer', description: '只看首页、客户、会议、预警', is_builtin: false, permissions: ['page1.view', 'page2.view', 'page3.view', 'page4.view', 'page17.view'] });
  await repo.insert('users', { username: 'admin', name: '系统管理员', password_hash: hashPassword(config.ADMIN_PASSWORD), role_id: adminRole, department: '客户运营部', position: '经理', is_active: true, account_status: '在职', oem_perms: [], dynamic_cols: {} });
  if (process.env.SEED_DEMO === '0') return true;

  const pw = hashPassword('123456');
  const people = [
    ['fengjy', '冯瑾奕', opRole, 'E001', '客户经理'], ['liqiang', '李强', opRole, 'E002', '质量工程师'],
    ['chenchen', '陈晨', opRole, 'E003', '商务专员'], ['guest', '访客', viewRole, 'E099', '实习'],
  ];
  for (const [username, name, role_id, employee_id, position] of people) {
    await repo.insert('users', { username, name, password_hash: pw, role_id, employee_id, position, department: '客户运营部', is_active: true, account_status: '在职', oem_perms: [], dynamic_cols: {} });
  }

  const customers = [
    { oem: 'XMS', oem_ch: '小米汽车', name_cn: '小米汽车', name_en: 'Xiaomi EV', address: '北京市亦庄', location: '华北', level: 'S级', relationship_status: '战略合作', kpi: 'S级', decision_auth: '总部集采', cooperation_scope: '动力电池 153Ah/100Ah', market_quality: 'A+', algorithm_capability: '强' },
    { oem: 'SHEV', oem_ch: '理想汽车', name_cn: '理想汽车', name_en: 'Li Auto', address: '北京市顺义', location: '华北', level: 'S级', relationship_status: '战略合作', kpi: 'A级', decision_auth: '总部集采', cooperation_scope: '增程电池', market_quality: 'A', algorithm_capability: '中' },
    { oem: 'BYD', oem_ch: '比亚迪', name_cn: '比亚迪', name_en: 'BYD', address: '深圳市坪山', location: '华南', level: 'A级', relationship_status: '深度绑定', kpi: 'A级', decision_auth: '事业部', cooperation_scope: '刀片/圆柱', market_quality: 'A', algorithm_capability: '强' },
    { oem: 'CNEV', oem_ch: '东风汽车', name_cn: '东风汽车', name_en: 'Dongfeng', address: '武汉市', location: '华中', level: 'B级', relationship_status: '稳定合作', kpi: 'B级', decision_auth: '项目制', cooperation_scope: '乘用车电池', market_quality: 'B+', algorithm_capability: '弱' },
    { oem: 'NIO', oem_ch: '蔚来汽车', name_cn: '蔚来', name_en: 'NIO', address: '合肥市', location: '华东', level: 'A级', relationship_status: '稳定合作', kpi: 'A级', decision_auth: '总部集采', cooperation_scope: '换电电池包', market_quality: 'A', algorithm_capability: '中' },
  ];
  for (const c of customers) {
    await repo.insert('customers', c);
    await repo.insert('oem_mapping', { oem: c.oem, oem_ch: c.oem_ch, cust_grp_name: c.oem_ch });
  }
  const persons = [
    ['XMS', 'external', '张建军', '采购部', '采购总监', '', '138-0000-0001'], ['XMS', 'external', '李文博', '质量部', '质量经理', '张建军', '138-0000-0002'],
    ['XMS', 'external', '王思远', '质量部', 'PQM', '李文博', '138-0000-0003'], ['XMS', 'internal', '冯瑾奕', '客户运营部', '客户经理', '', '139-0000-1001'],
    ['SHEV', 'external', '周明', '电池中心', '总监', '', '138-0000-0011'], ['BYD', 'external', '黄海', '品质部', '部长', '', '138-0000-0021'],
    ['NIO', 'external', '孙蕾', '能源部', '经理', '', '138-0000-0031'], ['CNEV', 'external', '刘涛', '采购部', '经理', '', '138-0000-0041'],
  ];
  for (const [oem, type, name, department, position, superior, phone] of persons) {
    await repo.insert('key_persons', { oem, type, name, department, position, superior, phone, email: '', style: '务实' });
  }
  await repo.insert('visit_plans', { oem: 'XMS', visit_date: dayOffset(-20), subject: 'Q3 季度拜访', contact_person: '张建军', visit_content: '季度质量与交付复盘', is_completed: true, created_by: '冯瑾奕' });
  await repo.insert('visit_plans', { oem: 'XMS', visit_date: dayOffset(5), subject: '量产爬坡复盘', contact_person: '李文博', visit_content: 'YU7 爬坡问题', is_completed: false, created_by: '李强' });
  await repo.insert('visit_plans', { oem: 'NIO', visit_date: dayOffset(12), subject: '月度质量例会', contact_person: '孙蕾', is_completed: false, created_by: '陈晨' });

  const meetings = [
    { oem: 'XMS', title: '小米SU7 量产协调会', meeting_date: dayOffset(-4), recorder: '冯瑾奕', purpose: '量产爬坡与产能协调', participants_external: '张建军,李文博', participants_internal: '冯瑾奕,李强',
      consensus: ['月底前完成产线验证', '每周同步一次交付计划'], tasks: [['提交产线验证报告', '冯瑾奕', 3, '待处理'], ['确认 YU7 二期排产', '李强', 8, '进行中']] },
    { oem: 'XMS', title: '电芯质量专项会', meeting_date: dayOffset(-12), recorder: '李强', purpose: '失效模式治理', participants_external: '王思远', participants_internal: '李强',
      consensus: ['建立批次追溯台账'], tasks: [['完善批次追溯', '李强', -2, '待处理'], ['绝缘故障 8D 报告', '冯瑾奕', -5, '已完成']] },
    { oem: 'SHEV', title: '季度商务对账会', meeting_date: dayOffset(-30), recorder: '陈晨', purpose: '商务回款', participants_external: '周明', participants_internal: '陈晨', consensus: [], tasks: [] },
  ];
  for (const m of meetings) {
    const id = await repo.insert('meetings', { ...m, consensus: undefined, tasks: undefined, created_by: m.recorder });
    for (const [i, content] of m.consensus.entries()) await repo.insert('meeting_consensus', { meeting_id: id, content, sort_order: i });
    for (const [task_description, owner, due, status] of m.tasks) {
      await repo.insert('tasks', { meeting_id: id, task_description, owner, planned_date: dayOffset(due), status, actual_date: status === '已完成' ? dayOffset(-6) : null });
    }
  }
  const events = [
    ['XMS', '153', '批量预警', '批量预警-绝缘故障', -2, 'SU7 批次电芯绝缘报警集中', '处理中'], ['XMS', '153', 'OTA', 'OTA 推送 SOH 校准', -20, '远程升级电池管理策略', '已闭环'],
    ['XMS', '', '质量会', '质量专题会', -38, '达成失效模式治理闭环', '已闭环'], ['NIO', '153', 'SOP', 'ET5 新版本 SOP', -60, '', '已闭环'],
  ];
  for (const [oem, cell_cap, event_type, title, off, description, status] of events) await repo.insert('events', { oem, cell_cap, event_type, title, occur_at: dayOffset(off), description, status, created_by: '冯瑾奕' });

  const modes = ['绝缘故障', 'SOC 一致性', '容量衰减', '自放电异常', '压差报警', '热失控预警'];
  for (let i = 0; i < 18; i++) {
    const oem = ['XMS', 'SHEV', 'BYD', 'NIO', 'CNEV'][i % 5];
    const closed = i % 3 === 0;
    await repo.insert('warnings', {
      oem, capacity_ah: ['153', '100', '75'][i % 3], risk_type: ['一致性', '衰减', '安全'][i % 3], failure_mode: modes[i % modes.length], warning_count: 5 + (i * 7) % 30,
      closure_status: closed ? '已闭环' : '未闭环', unclosed_reason: closed ? '' : '等待现场确认', dispatch_logic: '阈值触发', dispatched_count: i % 4,
      action_taken: closed ? '更换模组' : '远程排查', closed_by: closed ? '冯瑾奕' : '', closed_at: closed ? dayOffset(-i) : null,
    });
  }
  const rules = [
    ['XMS', 'SU7', '153', 'pack', 'ΔV 一致性', '模组 3', 'ΔV>80mV 持续 3 帧', '是', '是', 3, '复检后更换模组'],
    ['XMS', 'YU7', '153', 'pack', '绝缘检测', '高压回路', 'R<500Ω/V', '是', '是', 1, '立即停车检查'],
    ['NIO', 'ET5', '153', 'pack', '自放电', '电芯', 'K 值 > 阈值', '否', '否', 7, '观察'],
  ];
  for (const [i, r] of rules.entries()) {
    const [oem, vehicle_model, cell_cap, shipment_type, algorithm, abnormal_location, threshold, external_send, overdue_send, no_send_days, repair_suggestion] = r;
    await repo.insert('warning_rules', { oem, vehicle_model, cell_cap, shipment_type, algorithm, abnormal_location, threshold, external_send, overdue_send, no_send_days, repair_suggestion, top_order: i + 1, status: '启用', outgoing_count: 0, overdue_count: 0, work_order_done: 0, create_time: repo.now() });
  }
  for (const [i, m] of modes.slice(0, 4).entries()) {
    await repo.insert('stage_summary', { oem: 'XMS', summary_date: dayOffset(-7 * (i + 1)), failure_mode: m, dispatch_count: 12 - i * 2, reduced_breakdown: 3 - (i % 2), is_milestone: i === 0, milestone_note: i === 0 ? '绝缘故障外发量首次环比下降' : '' });
  }
  await repo.insert('documents', { oem: 'XMS', capacity_ah: '153', doc_type: '技术规格', title: 'SU7 电池规格书（演示占位）', file_name: 'SU7_spec_v3.txt', upload_date: dayOffset(-50), uploader: '冯瑾奕' });
  const d1 = await repo.insert('demands', { title: '新增 100Ah 项目需求', source_oem: 'XMS', background: '客户新车型定点', tags: '新项目', owner: '冯瑾奕', demanded_by: '小米汽车', owner_employee_id: 'E001', priority: '高', start_date: dayOffset(-30), due_date: dayOffset(60), status: '待审批', meeting_id: 1, created_by: 'admin' });
  await repo.insert('demands', { title: '批次追溯功能增强', source_oem: 'XMS', background: '质量追溯需求', tags: '功能', owner: '李强', demanded_by: '小米汽车', owner_employee_id: 'E002', priority: '中', start_date: dayOffset(-40), due_date: dayOffset(10), status: '进行中', meeting_id: 2, created_by: 'admin' });
  void d1;
  for (const name of ['产品', '质量', '数据', '流程']) await repo.insert('demand_categories', { name });
  await repo.insert('demand_pool', { description: '看板增加按基地筛选', category: '数据', priority: '中', owner: '陈晨', planned_date: dayOffset(14), status: '待审批', submitter: '陈晨' });
  await repo.insert('demand_pool', { description: '预警闭环支持批量导入', category: '流程', priority: '高', owner: '李强', planned_date: dayOffset(7), status: '已通过', submitter: '李强', reviewer: '系统管理员' });
  const c1 = await repo.insert('contracts', { contract_no: 'XMS-2026-001', title: '15GWh 动力电池供应合同', oem: 'XMS', contract_type: '主合同', status: '执行中', sign_date: dayOffset(-270), start_date: dayOffset(-250), end_date: dayOffset(110), amount: 125000000, currency: 'CNY', their_company: '小米汽车科技', their_signer: '张建军', payment_terms: 'T+60' });
  await repo.insert('contracts', { contract_no: 'XMS-2024-088', title: 'BMS 软件授权补充协议', parent_id: c1, oem: 'XMS', contract_type: '补充协议', status: '已完结', sign_date: dayOffset(-880), start_date: dayOffset(-870), end_date: dayOffset(-10), amount: 8500000, currency: 'CNY', their_company: '小米汽车科技', their_signer: '李文博', payment_terms: 'T+90' });
  await repo.insert('contracts', { contract_no: 'NIO-2025-012', title: '换电包框架协议', oem: 'NIO', contract_type: '框架协议', status: '执行中', sign_date: dayOffset(-400), start_date: dayOffset(-390), end_date: dayOffset(700), amount: 36000000, currency: 'CNY', their_company: '蔚来能源', their_signer: '孙蕾', payment_terms: 'T+45' });
  await repo.insert('tools', { name: '按客户查出货', description: '按 OEM / 容量汇总 Pack 出货量', category: '查询', enabled: true,
    params: [{ name: 'oem', label: '客户', type: 'text' }, { name: 'cell_cap', label: '容量(Ah)', type: 'text' }],
    sql_template: "SELECT oem, cell_cap, SUM(qty) AS pack_qty FROM {{dws_shipment}} WHERE ship_level = 'pack' AND (:oem = '' OR oem = :oem) AND (:cell_cap = '' OR cell_cap = :cell_cap) GROUP BY oem, cell_cap",
    result_columns: ['oem', 'cell_cap', 'pack_qty'] });
  await repo.insert('tools', { name: '未闭环外发预警', description: '列出外发且未闭环的预警', category: '质量', enabled: true,
    params: [{ name: 'oem', label: '客户', type: 'text' }],
    sql_template: 'SELECT warning_id, vin, fault_type, warning_time FROM {{dwd_warning}} WHERE is_outgoing = 1 AND is_closed = 0 AND (:oem = \'\' OR oem = :oem) ORDER BY warning_time DESC',
    result_columns: ['warning_id', 'vin', 'fault_type', 'warning_time'] });
  await repo.insert('opinions', { content: '首页加载能否再快一点', category: '体验', module: '首页看板', submitter: '李强', status: '待处理' });
  const p1 = await repo.insert('devlogs', { title: '客户运营平台 V2', entry_type: 'task', owner: '冯瑾奕', status: '进行中', priority: '高', start_date: dayOffset(-60), due_date: dayOffset(30), direction: '平台', iteration: 'S10', created_by: 'admin' });
  await repo.insert('devlogs', { title: '后端接口落地', entry_type: 'task', parent_id: p1, owner: '李强', status: '进行中', priority: '高', start_date: dayOffset(-5), due_date: dayOffset(5), direction: '平台', iteration: 'S10', created_by: 'admin' });
  await repo.insert('devlogs', { title: '看板口径确认', entry_type: 'task', parent_id: p1, owner: '冯瑾奕', status: '已完成', priority: '中', start_date: dayOffset(-20), due_date: dayOffset(-10), actual_date: dayOffset(-9), direction: '数据', iteration: 'S9', created_by: 'admin' });
  await repo.insert('devlogs', { title: 'V2 周会', entry_type: 'meeting', meeting_date: dayOffset(-2), attendees: '冯瑾奕,李强', topics: '接口进度', minutes: '本周完成鉴权与客户档案', created_by: 'admin' });
  await repo.insert('devlog_todos', { title: '合同导入模板确认', detail: '与商务确认字段', source: '周会', priority: '中', status: '待完善', tag: '合同', oem: 'XMS', created_by: 'admin' });
  const adg = [['数据中台', 'https://example.com/dp', '数仓查询与报表', '在用', '内网', '数据组'], ['BMS 云平台', 'https://example.com/bms', '车辆实时监控', '在用', 'VPN', '平台组']];
  for (const [i, [name, url, purpose, status, access, owner]] of adg.entries()) await repo.insert('adg_systems', { name, url, purpose, status, access, owner, sort_order: i + 1 });
  return true;
}

module.exports = { seed, migrate };
