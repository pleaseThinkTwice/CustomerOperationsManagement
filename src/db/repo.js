'use strict';
// 基于 schema 描述的通用 CRUD：只写入表中存在的列，json/bool 自动编解码，created_at/updated_at 自动填充。
const { tables } = require('./schema');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => now().slice(0, 10);

function createRepo(db) {
  const q = db.dialect.quote;

  function encode(table, obj) {
    const cols = tables[table].cols; const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const d = cols[k];
      if (!d || d.type === 'id') continue;
      if (d.type === 'json') out[k] = v == null ? null : JSON.stringify(v);
      else if (d.type === 'bool') out[k] = v === '' || v == null ? null : (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
      else if (d.type === 'int') out[k] = v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
      else if (d.type === 'real') out[k] = v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
      else out[k] = v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return out;
  }

  function decode(table, row) {
    if (!row) return row;
    const cols = tables[table].cols;
    for (const [k, d] of Object.entries(cols)) {
      if (!(k in row)) continue;
      if (d.type === 'json' && typeof row[k] === 'string') { try { row[k] = JSON.parse(row[k]); } catch (e) { /* 保留原文 */ } }
      else if (d.type === 'bool' && row[k] != null) row[k] = !!Number(row[k]);
    }
    return row;
  }

  function whereSql(where) {
    const keys = Object.keys(where || {}).filter((k) => where[k] !== undefined);
    if (!keys.length) return { sql: '', params: [] };
    const parts = []; const params = [];
    for (const k of keys) {
      const v = where[k];
      if (v === null) parts.push(`${q(k)} IS NULL`);
      else if (Array.isArray(v)) { parts.push(`${q(k)} IN (${v.map(() => '?').join(',') || 'NULL'})`); params.push(...v); }
      else { parts.push(`${q(k)} = ?`); params.push(v); }
    }
    return { sql: ' WHERE ' + parts.join(' AND '), params };
  }

  return {
    now, today,
    async insert(table, obj) {
      const cols = tables[table].cols;
      const data = encode(table, obj);
      if (cols.created_at && data.created_at == null) data.created_at = now();
      if (cols.updated_at && data.updated_at == null) data.updated_at = now();
      const keys = Object.keys(data);
      const r = await db.run(`INSERT INTO ${q(table)} (${keys.map(q).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => data[k]));
      return r.lastId;
    },
    async update(table, id, patch) {
      const cols = tables[table].cols;
      const data = encode(table, patch);
      delete data.created_at;
      if (cols.updated_at) data.updated_at = now();
      const keys = Object.keys(data);
      if (!keys.length) return 0;
      const r = await db.run(`UPDATE ${q(table)} SET ${keys.map((k) => `${q(k)} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), id]);
      return r.changes;
    },
    async get(table, id) { return decode(table, await db.get(`SELECT * FROM ${q(table)} WHERE id = ?`, [id])); },
    async findOne(table, where) {
      const w = whereSql(where);
      return decode(table, await db.get(`SELECT * FROM ${q(table)}${w.sql} LIMIT 1`, w.params));
    },
    async find(table, where, { order = 'id DESC', limit, offset } = {}) {
      const w = whereSql(where);
      let sql = `SELECT * FROM ${q(table)}${w.sql}${order ? ' ORDER BY ' + order : ''}`;
      if (limit) sql += ` LIMIT ${Number(limit)}` + (offset ? ` OFFSET ${Number(offset)}` : '');
      return (await db.all(sql, w.params)).map((r) => decode(table, r));
    },
    async count(table, where) {
      const w = whereSql(where);
      const r = await db.get(`SELECT COUNT(*) AS n FROM ${q(table)}${w.sql}`, w.params);
      return Number(r ? r.n : 0);
    },
    async remove(table, id) { return (await db.run(`DELETE FROM ${q(table)} WHERE id = ?`, [id])).changes; },
    async removeWhere(table, where) {
      const w = whereSql(where);
      if (!w.sql) throw new Error('removeWhere 需要条件');
      return (await db.run(`DELETE FROM ${q(table)}${w.sql}`, w.params)).changes;
    },
    // 原生查询（结果按表解码）
    async query(table, sql, params) { return (await db.all(sql, params)).map((r) => (table ? decode(table, r) : r)); },
    decode,
  };
}

module.exports = { createRepo, now, today };
