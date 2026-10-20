'use strict';
// 从路由源码生成接口清单 docs/API.md：方法、路径、权限、用到的 query/body 参数、紧邻的注释。
// 用法：node scripts/gen-api-doc.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MODULES = {
  auth: '登录与账号', customers: '客户档案 / 关键人 / 拜访 / 事件 / 质保 / OEM 映射', dashboard: '首页看板（三视角、趋势、车辆明细、自定义模块）',
  workbench: '我的待办', meetings: '会议纪要 / 任务 / 材料', warnings: '预警闭环 / 规则 / 阶段总结', demands: '需求管理 / 部门需求池',
  contracts: '合同管理', documents: '文档管理', system: '系统管理（用户、角色、权限、日志）',
  insights: '数据洞察', misc: '工具箱 / 意见反馈 / ADG / 查询手册 / 数据视图',
};
const RE = /r\.(get|post|put|delete)\(\s*'([^']+)'/g;
let out = '# 接口清单\n\n> 由 `node scripts/gen-api-doc.js` 从 `src/routes/*.js` 生成，勿手改。\n'
  + '> 约定：除标注「公开」外都需要登录（Cookie `cop_sid`），未登录 401；权限不足 403。返回 JSON；出错时 `{success:false, error, message}`。\n'
  + '> `/api/agent/*`、`/api/qa*`、`/api/knowledge*`、`/api/nl2sql/*`、`/api/ai/*` 由 QA / text2sql 模块（src/ai）提供，不在此表。\n\n';
let total = 0;
for (const [m, title] of Object.entries(MODULES)) {
  const src = fs.readFileSync(path.join(ROOT, 'src/routes', m + '.js'), 'utf8');
  const lines = src.split('\n');
  const hits = [...src.matchAll(RE)];
  const permConsts = Object.fromEntries([...src.matchAll(/const (\w+) = \{ perm: '([^']+)' \}/g)].map((a) => [a[1], a[2]]));
  out += `## ${title}（${m}.js · ${hits.length} 个）\n\n| 方法 | 路径 | 权限 | 参数 | 说明 |\n|---|---|---|---|---|\n`;
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    const body = src.slice(h.index, end);
    const lineNo = src.slice(0, h.index).split('\n').length - 1;
    let note = '';
    for (let k = lineNo - 1; k >= Math.max(0, lineNo - 3); k--) {
      const t = lines[k].trim();
      if (t.startsWith('//')) { if (/^\/\/\s*-{3,}/.test(t)) break; note = t.replace(/^\/\/\s*/, '') + (note ? ' ' + note : ''); continue; }
      break;
    }
    const inline = (lines[lineNo].match(/\/\/\s*(.+)$/) || [])[1];
    if (inline) note = (note ? note + '；' : '') + inline;
    const q = [...new Set([...body.matchAll(/x\.query\.(\w+)/g)].map((a) => a[1]))];
    const b = [...new Set([...body.matchAll(/(?:x\.body|\bb)\.(\w+)/g)].map((a) => a[1]))];
    const f = /x\.files/.test(body) ? ['文件上传'] : [];
    const perm = (body.match(/perm:\s*'([^']+)'/) || [])[1] || permConsts[(body.match(/\},\s*(\w+)\);/) || [])[1]] || (/public:\s*true/.test(body) ? '公开' : '');
    const params = [q.length ? 'query: ' + q.join(', ') : '', b.length ? 'body: ' + b.join(', ') : '', ...f].filter(Boolean).join('<br>');
    out += `| ${h[1].toUpperCase()} | \`${h[2]}\` | ${perm} | ${params} | ${note.replace(/\|/g, '\\|')} |\n`;
  });
  total += hits.length;
  out += '\n';
}
out = out.replace('# 接口清单\n', `# 接口清单（共 ${total} 个）\n`);
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/API.md'), out);
console.log('docs/API.md:', total, '个接口');
