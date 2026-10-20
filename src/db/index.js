'use strict';
// 数据库适配层：对上只暴露 async all/get/run/exec + dialect，业务代码不感知底层是 sqlite 还是 MySQL/Doris。
//   sqlite：Node 自带 node:sqlite（Node >= 22.13），零依赖，本地演示/开发用
//   mysql ：公司 MySQL 或 Doris（MySQL 协议），需要 `npm i mysql2`，只有选用时才加载
const fs = require('node:fs');
const path = require('node:path');

const dialects = {
  sqlite: {
    name: 'sqlite',
    month: (col) => `substr(${col}, 1, 7)`,
    year: (col) => `substr(${col}, 1, 4)`,
    day: (col) => `substr(${col}, 1, 10)`,
    quote: (id) => `"${id}"`,
  },
  mysql: {
    name: 'mysql',
    month: (col) => `DATE_FORMAT(${col}, '%Y-%m')`,
    year: (col) => `DATE_FORMAT(${col}, '%Y')`,
    day: (col) => `DATE_FORMAT(${col}, '%Y-%m-%d')`,
    quote: (id) => '`' + id + '`',
  },
};

function openSqlite(file) {
  // node:sqlite 在部分 22.x 版本会打印实验特性警告，这里静默掉
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = origEmit;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const norm = (params) => (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  return {
    driver: 'sqlite',
    dialect: dialects.sqlite,
    async all(sql, params) { return db.prepare(sql).all(...norm(params)); },
    async get(sql, params) { return db.prepare(sql).get(...norm(params)) || null; },
    async run(sql, params) {
      const r = db.prepare(sql).run(...norm(params));
      return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}

function openMysql(url) {
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (e) {
    throw new Error('使用 mysql 驱动需先安装依赖：npm i mysql2');
  }
  const pool = mysql.createPool({ uri: url, connectionLimit: 8, dateStrings: true, multipleStatements: true });
  return {
    driver: 'mysql',
    dialect: dialects.mysql,
    async all(sql, params) { const [rows] = await pool.query(sql, params || []); return rows; },
    async get(sql, params) { const [rows] = await pool.query(sql, params || []); return rows[0] || null; },
    async run(sql, params) {
      const [r] = await pool.query(sql, params || []);
      return { lastId: Number(r.insertId || 0), changes: Number(r.affectedRows || 0) };
    },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) { return fn(); }, // 简化：MySQL 侧按单语句提交
    close() { return pool.end(); },
  };
}

function openDb({ driver, file, url }) {
  if (driver === 'mysql') return openMysql(url);
  return openSqlite(file);
}

module.exports = { openDb, dialects };
