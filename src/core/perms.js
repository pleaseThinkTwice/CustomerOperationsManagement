'use strict';
// 权限码清单：页面可见（pageN.view）+ 编辑类操作。与前端 App.renderNavByPerms / data-perm 保持一致。
const PAGES = [
  { perm: 'page1.view', name: '首页看板' }, { perm: 'page17.view', name: '我的待办' }, { perm: 'page15.view', name: '系统导航' },
  { perm: 'page2.view', name: '客户档案' }, { perm: 'page3.view', name: '会议纪要' }, { perm: 'page4.view', name: '预警闭环' },
  { perm: 'page5.view', name: '阶段总结' }, { perm: 'page6.view', name: 'Q&A知识库' }, { perm: 'page9.view', name: '数智分析' },
  { perm: 'page19.view', name: '工具箱' }, { perm: 'page18.view', name: '知识中心' }, { perm: 'page14.view', name: '数据洞察' },
  { perm: 'page7.view', name: '文档管理' }, { perm: 'page8.view', name: 'OEM映射' }, { perm: 'page10.view', name: '需求管理' },
  { perm: 'page16.view', name: '需求池' }, { perm: 'page12.view', name: '合同管理' }, { perm: 'page13.view', name: '项目日志' },
  { perm: 'user.manage', name: '系统管理' },
];
const EDITS = [
  { perm: 'customer.edit', name: '客户档案编辑' }, { perm: 'visit.edit', name: '拜访计划编辑' }, { perm: 'meeting.edit', name: '会议纪要编辑' },
  { perm: 'events.edit', name: '大事记编辑' }, { perm: 'warning.edit', name: '预警/外发规则编辑' }, { perm: 'demand.edit', name: '需求编辑' },
  { perm: 'demand.approve', name: '需求审批' }, { perm: 'demand.delete', name: '需求删除' }, { perm: 'contract.edit', name: '合同编辑' },
  { perm: 'oem_mapping.edit', name: 'OEM 映射编辑' }, { perm: 'knowledge.edit', name: '知识库编辑' }, { perm: 'knowledge.rebuild', name: '知识库重建' },
  { perm: 'qa.import', name: 'Q&A 导入' }, { perm: 'tool.manage', name: '工具管理' }, { perm: 'adg.edit', name: '系统导航编辑' },
];
// 模块（菜单）可见性：用户可单独覆盖角色默认
const MODULES = PAGES.map((p) => ({ key: p.perm, name: p.name }));

function hasPerm(user, code) {
  const p = (user && user.perms) || [];
  return p.includes('*') || p.includes(code);
}

module.exports = { PAGES, EDITS, MODULES, hasPerm };
