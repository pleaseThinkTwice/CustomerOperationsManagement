'use strict';
/**
 * SQL 安全校验：只读、单语句、表白名单、行数上限。
 * 这是第二道防线，第一道是业务库只读账号（见报告）。
 */

// 只校验单条 SELECT/WITH 内部可能出现的写操作和危险函数（REPLACE() 等普通函数不拦）
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|call|exec|execute|attach|detach|pragma|vacuum|outfile|dumpfile|load_file|sleep|benchmark|pg_sleep|pg_read_file)\b/i;

/** 去掉注释和字符串字面量（替换为占位），用于关键字和分号检查 */
function mask(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");   // 双引号按标识符处理，不遮盖，防止绕过表白名单
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
}

function referencedTables(masked) {
  const ctes = new Set();
  const cteRe = /(?:\bwith\b|,)\s*([`"]?)([a-z_][\w]*)\1\s+as\s*\(/gi;
  let m;
  while ((m = cteRe.exec(masked))) ctes.add(m[2].toLowerCase());
  const tables = new Set();
  const add = (raw) => {
    const name = raw.replace(/[`"]/g, '').toLowerCase();
    const short = name.includes('.') ? name.split('.').pop() : name;
    if (name && !ctes.has(short)) tables.add(name);
  };
  const re = /\bjoin\s+(?!\()([`"]?[\w.]+[`"]?)/gi;
  while ((m = re.exec(masked))) add(m[1]);
  // FROM 后可能是逗号分隔的多张表：from a x, b y
  const fromRe = /\bfrom\s+([\s\S]*?)(?=\b(?:where|join|left|right|inner|full|cross|natural|group|order|limit|having|union|except|intersect|on)\b|\(|\)|$)/gi;
  while ((m = fromRe.exec(masked))) {
    for (const part of m[1].split(',')) {
      const tok = part.trim().split(/\s+/)[0];
      if (tok) add(tok);
    }
  }
  return [...tables];
}

/**
 * @returns {{ok:true, sql:string, tables:string[]}|{ok:false, error:string}}
 */
function checkSql(rawSql, { allowTables = null, maxRows = 5000 } = {}) {
  let sql = stripComments(String(rawSql || '')).replace(/;\s*$/, '').trim();
  if (!sql) return { ok: false, error: 'SQL 为空' };
  const masked = mask(sql);
  if (masked.includes(';')) return { ok: false, error: '只允许单条 SQL 语句' };
  if (!/^\s*(select|with)\b/i.test(masked)) return { ok: false, error: '只允许 SELECT / WITH 查询' };
  const bad = FORBIDDEN.exec(masked);
  if (bad) return { ok: false, error: `不允许的关键字：${bad[1]}` };
  if (/\binto\b/i.test(masked)) return { ok: false, error: '不允许 SELECT ... INTO' };
  const tables = referencedTables(masked);
  if (allowTables) {
    const allow = new Set(allowTables.map(t => t.toLowerCase()));
    const denied = tables.filter(t => !allow.has(t) && !allow.has(t.split('.').pop()));
    if (denied.length) return { ok: false, error: `不在可查表白名单内：${denied.join(', ')}` };
  }
  // 外层没有 LIMIT 时包一层，防止大查询拖垮库
  if (!/\blimit\s+\d+\s*(offset\s+\d+\s*)?$/i.test(masked)) {
    sql = `SELECT * FROM (\n${sql}\n) AS _q LIMIT ${maxRows}`;
  }
  return { ok: true, sql, tables };
}

module.exports = { checkSql, referencedTables, mask };
