'use strict';
// 数智分析（src/ai）的语义层：表 / 字段说明取自分析库表结构（src/analytics/schema.js），
// 枚举、口径、示例 SQL 取自 config/semantic.analytics.json。合成后写到数据目录，供 AI 模块读取。
// 这样数智分析和首页看板查的是同一份数据、同一套口径。
const fs = require('node:fs');
const path = require('node:path');
const { tables } = require('../analytics/schema');

function buildSemantic({ root, dataDir, tableName = (t) => t }) {
  const extra = JSON.parse(fs.readFileSync(path.join(root, 'config', 'semantic.analytics.json'), 'utf8'));
  const values = extra.values || {};
  const out = {};
  for (const [name, t] of Object.entries(tables)) {
    const columns = {};
    for (const [col, def] of Object.entries(t.cols)) {
      const v = values[name + '.' + col];
      columns[col] = v ? { desc: def.comment, values: v } : def.comment;
    }
    out[tableName(name)] = { desc: t.comment, columns };
  }
  const real = (sql) => Object.keys(tables).reduce((s, t) => s.replace(new RegExp('\\b' + t + '\\b', 'g'), tableName(t)), sql);
  const semantic = {
    tables: out,
    glossary: extra.glossary || [],
    notes: extra.notes || [],
    examples: (extra.examples || []).map((e) => ({ ...e, sql: real(e.sql) })),
    commonQuestions: extra.commonQuestions || [],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'semantic.analytics.json');
  fs.writeFileSync(file, JSON.stringify(semantic, null, 2));
  return file;
}

module.exports = { buildSemantic };
