'use strict';
// 生成 docs/数据表DDL.md：分析库（Doris 建表参考）+ 运营库（MySQL / sqlite）。字段来自 schema 描述，勿手改。
// 用法：node scripts/gen-ddl-doc.js
const fs = require('fs');
const path = require('path');
const analytics = require('../src/analytics/schema').tables;
const ops = require('../src/db/schema');

const DORIS = { text: 'VARCHAR(128)', int: 'BIGINT', real: 'DOUBLE', date: 'DATE', datetime: 'DATETIME' };
const esc = (s) => String(s || '').replace(/'/g, "''");
let out = '# 数据表 DDL\n\n> 由 `node scripts/gen-ddl-doc.js` 从 `src/analytics/schema.js`、`src/db/schema.js` 生成，勿手改。\n\n';
out += '## 一、分析库（公司数仓，只读）\n\n平台只 `SELECT` 这些表。字段名与类型以此为准；公司表字段名不同时，建议建同名视图对齐（见 docs/数据需求.md）。下面是 Doris 建表参考，仅在需要落一份测试表时使用。\n\n';
for (const [name, t] of Object.entries(analytics)) {
  out += `### ${name} — ${t.comment}\n\n| 字段 | 类型 | 说明 |\n|---|---|---|\n`;
  for (const [c, d] of Object.entries(t.cols)) out += `| ${c} | ${d.type} | ${d.comment} |\n`;
  const first = Object.keys(t.cols)[0];
  out += '\n```sql\nCREATE TABLE IF NOT EXISTS `' + name + '` (\n'
    + Object.entries(t.cols).map(([c, d]) => `  \`${c}\` ${DORIS[d.type]} COMMENT '${esc(d.comment)}'`).join(',\n')
    + `\n) DUPLICATE KEY(\`${first}\`) COMMENT '${esc(t.comment)}'\nDISTRIBUTED BY HASH(\`${first}\`) BUCKETS 8 PROPERTIES ("replication_num" = "1");\n\`\`\`\n\n`;
}
out += '## 二、运营库（平台自有业务表）\n\n服务启动时自动建表（sqlite 默认；`OPS_DB_DRIVER=mysql` 时在 MySQL 建同样的表），一般不需要手工执行。以下为 MySQL 版本，便于 DBA 预建或审阅。\n\n';
out += '| 表 | 说明 |\n|---|---|\n' + Object.entries(ops.tables).map(([n, t]) => `| ${n} | ${t.comment} |`).join('\n') + '\n\n';
out += '```sql\n' + ops.ddl('mysql') + '\n```\n';
fs.writeFileSync(path.join(__dirname, '..', 'docs/数据表DDL.md'), out);
console.log('docs/数据表DDL.md 已生成');
