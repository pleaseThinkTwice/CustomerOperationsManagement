'use strict';
/**
 * 业务库目录 + 语义层。
 * 语义层文件（config/semantic.json）登记：可查表、表/字段中文含义、枚举值、业务口径（术语）、示例问答 SQL、常用问题。
 * 表结构从库里实时读取，语义层只补充含义；两者合并后整体放进提示词（表少，不做检索）。
 */
const fs = require('node:fs');
const { createSqlAdapter } = require('./adapters');
const { checkSql } = require('./guard');

function loadSemantic(file) {
  if (!file || !fs.existsSync(file)) return { tables: {}, glossary: [], examples: [], commonQuestions: [] };
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { tables: s.tables || {}, glossary: s.glossary || [], examples: s.examples || [], commonQuestions: s.commonQuestions || [], notes: s.notes || [] };
}

function createCatalog(cfg) {
  let adapter = null;
  let cache = null;          // { tables: [{table, desc, fields}] }
  let semantic = loadSemantic(cfg.semanticFile);
  let semanticMtime = 0;

  function sem() {
    try {
      const m = fs.statSync(cfg.semanticFile).mtimeMs;
      if (m !== semanticMtime) { semantic = loadSemantic(cfg.semanticFile); semanticMtime = m; cache = null; }
    } catch (e) { /* 无语义层文件 */ }
    return semantic;
  }

  function db() {
    if (!adapter) adapter = createSqlAdapter(cfg.sql);
    return adapter;
  }

  async function load() {
    const s = sem();
    if (cache) return cache;
    const all = await db().listTables();
    const allow = cfg.sql.allowTables && cfg.sql.allowTables.length ? cfg.sql.allowTables
      : (Object.keys(s.tables).length ? Object.keys(s.tables) : ['*']);
    const allowAll = allow.includes('*');
    const allowSet = new Set(allow.map(t => t.toLowerCase()));
    const picked = all.filter(t => allowAll || allowSet.has(t.table.toLowerCase()));
    // 跨库的「库.表」（如 ANALYTICS_TABLE_dwd_warning=dw.dwd_warning）不在当前库的表清单里，直接按登记的名字纳入
    if (!allowAll) {
      const have = new Set(picked.map(t => t.table.toLowerCase()));
      for (const t of allow) if (t.includes('.') && !have.has(t.toLowerCase())) picked.push({ table: t, comment: '' });
    }
    const tables = [];
    for (const t of picked) {
      const meta = s.tables[t.table] || {};
      const cols = await db().describe(t.table);
      const colMeta = meta.columns || {};
      tables.push({
        table: t.table,
        desc: meta.desc || t.comment || '',
        fields: cols.map(c => {
          const m = colMeta[c.col];
          const desc = typeof m === 'string' ? m : (m && m.desc) || c.comment || '';
          const values = m && typeof m === 'object' && m.values ? m.values : null;
          return { col: c.col, type: c.type, desc, values };
        }),
      });
    }
    cache = { tables };
    return cache;
  }

  async function tables() {
    return (await load()).tables.map(t => ({ table: t.table, desc: t.desc }));
  }

  async function columns(table) {
    const t = (await load()).tables.find(x => x.table.toLowerCase() === String(table).toLowerCase());
    if (!t) return null;
    return { table: t.table, desc: t.desc, fields: t.fields.map(f => ({ col: f.col, type: f.type, desc: f.desc + (f.values ? `（取值：${f.values.join(' / ')}）` : '') })) };
  }

  /** 整个语义层渲染成提示词文本 */
  async function schemaPrompt(budget = 60000) {
    const { tables: ts } = await load();
    const s = sem();
    const parts = [`数据库方言：${db().dialect}`, '', '## 可查询的表'];
    for (const t of ts) {
      parts.push(`### ${t.table}${t.desc ? ' —— ' + t.desc : ''}`);
      for (const f of t.fields) {
        parts.push(`- ${f.col} ${f.type}${f.desc ? '：' + f.desc : ''}${f.values ? `（取值：${f.values.join(' / ')}）` : ''}`);
      }
    }
    if (s.glossary.length) {
      parts.push('', '## 业务口径（必须遵守）');
      for (const g of s.glossary) parts.push(`- ${g.term}：${g.definition}`);
    }
    if (s.notes.length) {
      parts.push('', '## 注意事项');
      for (const n of s.notes) parts.push(`- ${n}`);
    }
    if (s.examples.length) {
      parts.push('', '## 示例（问题 → SQL）');
      for (const e of s.examples) parts.push(`问：${e.question}\n\`\`\`sql\n${e.sql}\n\`\`\``);
    }
    let text = parts.join('\n');
    if (text.length > budget) text = text.slice(0, budget) + '\n…（表结构过长已截断，可用 describe_table 工具查看具体表）';
    return text;
  }

  async function allowList() {
    return (await load()).tables.map(t => t.table);
  }

  /** 校验 + 执行。失败不抛异常，返回 {ok:false, error} 供 Agent 自我修正。 */
  async function run(sql, { maxRows } = {}) {
    const limit = Math.min(maxRows || cfg.sql.maxRows, cfg.sql.maxRows);
    let allow;
    try { allow = await allowList(); } catch (e) { return { ok: false, sql, error: e.message }; }
    const g = checkSql(sql, { allowTables: allow, maxRows: limit });
    if (!g.ok) return { ok: false, sql, error: g.error };
    try {
      const r = await db().query(g.sql);
      return { ok: true, sql: g.sql, columns: r.columns, rows: r.rows.map(row => row.map(norm)), row_count: r.rows.length };
    } catch (e) {
      return { ok: false, sql: g.sql, error: `SQL 执行出错：${e.message}` };
    }
  }

  function reset() {
    cache = null;
    if (adapter && adapter.close) { try { adapter.close(); } catch (e) { /* ignore */ } }
    adapter = null;
  }

  return { tables, columns, schemaPrompt, allowList, run, semantic: sem, reset, dialect: () => db().dialect };
}

function norm(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

module.exports = { createCatalog };
