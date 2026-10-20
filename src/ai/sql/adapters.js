'use strict';
/**
 * 业务库适配器（只读）。统一接口：
 *   dialect                       'sqlite' | 'mysql' | 'postgres'
 *   listTables()                  → [{ table, comment }]
 *   describe(table)               → [{ col, type, comment }]
 *   query(sql)                    → { columns: string[], rows: any[][] }
 *   close()
 * sqlite 用 Node 自带 node:sqlite（只读打开）；mysql / doris 需 `npm i mysql2`；postgres 需 `npm i pg`。
 */

function optionalRequire(name, hint) {
  try { return require(name); } catch (e) {
    const err = new Error(`连接该类型数据库需要安装可选依赖：npm i ${hint || name}`);
    err.code = 'MISSING_DRIVER';
    throw err;
  }
}

function sqliteAdapter(cfg) {
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(cfg.file)) {
    const e = new Error(`业务库文件不存在：${cfg.file}`);
    e.code = 'DB_MISSING';
    throw e;
  }
  const db = new DatabaseSync(cfg.file, { readOnly: true });
  const qi = t => '"' + String(t).replace(/"/g, '""') + '"';
  return {
    dialect: 'sqlite',
    async listTables() {
      return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(r => ({ table: r.name, comment: '' }));
    },
    async describe(table) {
      return db.prepare(`PRAGMA table_info(${qi(table)})`).all().map(r => ({ col: r.name, type: r.type || '', comment: '' }));
    },
    async query(sql) {
      const st = db.prepare(sql);
      const columns = st.columns().map(c => c.name);
      const rows = st.all().map(r => columns.map(c => r[c]));
      return { columns, rows };
    },
    close() { db.close(); },
  };
}

function mysqlAdapter(cfg) {
  // Doris / StarRocks 兼容 MySQL 协议，也走这里
  const mysql = optionalRequire('mysql2/promise', 'mysql2');
  const pool = mysql.createPool({ uri: cfg.url, connectionLimit: 4, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const dbName = decodeURIComponent(new URL(cfg.url).pathname.replace(/^\//, ''));
  return {
    dialect: 'mysql',
    async listTables() {
      const [rows] = await pool.query(
        'SELECT TABLE_NAME AS t, TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [dbName]);
      return rows.map(r => ({ table: r.t, comment: r.c || '' }));
    },
    async describe(table) {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME AS col, COLUMN_TYPE AS type, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, table.includes('.') ? table.split('.', 2) : [dbName, table]);
      return rows.map(r => ({ col: r.col, type: r.type, comment: r.comment || '' }));
    },
    async query(sql) {
      const [rows, fields] = await pool.query({ sql, timeout: cfg.timeoutMs, rowsAsArray: true });
      return { columns: fields.map(f => f.name), rows };
    },
    close() { return pool.end(); },
  };
}

function postgresAdapter(cfg) {
  const { Pool } = optionalRequire('pg');
  const pool = new Pool({ connectionString: cfg.url, max: 4, statement_timeout: cfg.timeoutMs });
  return {
    dialect: 'postgres',
    async listTables() {
      const r = await pool.query(`SELECT c.relname AS t, obj_description(c.oid) AS c FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m') AND n.nspname = current_schema() ORDER BY 1`);
      return r.rows.map(x => ({ table: x.t, comment: x.c || '' }));
    },
    async describe(table) {
      const r = await pool.query(`SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table]);
      return r.rows.map(x => ({ col: x.col, type: x.type, comment: x.comment || '' }));
    },
    async query(sql) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const r = await client.query({ text: sql, rowMode: 'array' });
        await client.query('ROLLBACK');
        return { columns: r.fields.map(f => f.name), rows: r.rows };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close() { return pool.end(); },
  };
}

function createSqlAdapter(cfg) {
  switch ((cfg.type || 'sqlite').toLowerCase()) {
    case 'sqlite': return sqliteAdapter(cfg);
    case 'mysql': case 'doris': case 'starrocks': case 'tidb': return mysqlAdapter(cfg);
    case 'postgres': case 'postgresql': return postgresAdapter(cfg);
    default: throw new Error(`不支持的业务库类型：${cfg.type}`);
  }
}

module.exports = { createSqlAdapter };
