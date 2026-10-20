'use strict';
/**
 * AI 模块自己的存储（与业务库、平台主库分开）：Q&A 记录、知识片段、收藏问题、Agent 轨迹与反馈、常用问题快照。
 * 使用 Node 22 自带 node:sqlite，无需安装依赖。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS qa_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT DEFAULT '',
  maintainer TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'qa',          -- qa | analysis
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  source_type TEXT DEFAULT 'manual',         -- manual | qa | user | md | txt | csv | json | html | xlsx | folder
  kind TEXT DEFAULT 'document',              -- document | code
  source_ref TEXT DEFAULT '',                -- 来源文件名或 qa:<id>
  user_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_kb_scope ON kb_chunks(scope);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT DEFAULT '',
  question TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT DEFAULT '',
  mode TEXT,
  query TEXT,
  answer TEXT,
  tools TEXT,
  sql TEXT,
  steps_json TEXT,
  feedback INTEGER DEFAULT 0,
  feedback_text TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snap_date TEXT,
  items_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

function plain(rows) { return rows.map(r => ({ ...r })); }

function createStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  let version = 0;   // 知识片段变更计数，检索索引据此判断是否重建
  const bump = () => { version++; };

  const qa = {
    list({ category } = {}) {
      return category
        ? plain(db.prepare('SELECT * FROM qa_records WHERE category = ? ORDER BY id DESC').all(category))
        : plain(db.prepare('SELECT * FROM qa_records ORDER BY id DESC').all());
    },
    get(id) { const r = db.prepare('SELECT * FROM qa_records WHERE id = ?').get(id); return r ? { ...r } : null; },
    create(r) {
      const info = db.prepare('INSERT INTO qa_records (category, question, answer, keywords, maintainer) VALUES (?,?,?,?,?)')
        .run(r.category, r.question, r.answer, r.keywords || '', r.maintainer || '');
      return Number(info.lastInsertRowid);
    },
    update(id, r) {
      return db.prepare(`UPDATE qa_records SET category=?, question=?, answer=?, keywords=?, maintainer=?,
        updated_at=datetime('now','localtime') WHERE id=?`).run(r.category, r.question, r.answer, r.keywords || '', r.maintainer || '', id).changes;
    },
    remove(id) { return db.prepare('DELETE FROM qa_records WHERE id = ?').run(id).changes; },
    count() { return db.prepare('SELECT COUNT(*) AS n FROM qa_records').get().n; },
  };

  const kb = {
    list({ scope, source_type, search, user_id } = {}) {
      const where = []; const args = [];
      if (scope) { where.push('scope = ?'); args.push(scope); }
      if (source_type) { where.push('source_type = ?'); args.push(source_type); }
      if (user_id !== undefined) { where.push('user_id = ?'); args.push(user_id); }
      if (search) { where.push('(title LIKE ? OR content LIKE ? OR keywords LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      const sql = `SELECT id, scope, title, content, category, keywords, source_type, kind, source_ref, user_id, created_at
        FROM kb_chunks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
      return plain(db.prepare(sql).all(...args));
    },
    all(scope) { return plain(db.prepare('SELECT * FROM kb_chunks WHERE scope = ?').all(scope)); },
    get(id) { const r = db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(id); return r ? { ...r } : null; },
    create(c) {
      const info = db.prepare(`INSERT INTO kb_chunks (scope, title, content, category, keywords, source_type, kind, source_ref, user_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(c.scope || 'qa', c.title, c.content, c.category || '', c.keywords || '',
        c.source_type || 'manual', c.kind || 'document', c.source_ref || '', c.user_id || '');
      bump();
      return Number(info.lastInsertRowid);
    },
    update(id, c) {
      const n = db.prepare('UPDATE kb_chunks SET title=?, content=?, category=?, keywords=?, source_type=? WHERE id=?')
        .run(c.title, c.content, c.category || '', c.keywords || '', c.source_type || 'manual', id).changes;
      bump();
      return n;
    },
    setKeywords(id, keywords) { db.prepare('UPDATE kb_chunks SET keywords=? WHERE id=?').run(keywords, id); bump(); },
    remove(id) { const n = db.prepare('DELETE FROM kb_chunks WHERE id = ?').run(id).changes; bump(); return n; },
    removeBy(where, ...args) { const n = db.prepare(`DELETE FROM kb_chunks WHERE ${where}`).run(...args).changes; bump(); return n; },
    exists(scope, source_ref) { return !!db.prepare('SELECT 1 FROM kb_chunks WHERE scope=? AND source_ref=? LIMIT 1').get(scope, source_ref); },
    count(scope) {
      return scope ? db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE scope=?').get(scope).n
        : db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get().n;
    },
    categories(scope) {
      return plain(db.prepare(`SELECT category AS name, COUNT(*) AS cnt FROM kb_chunks
        WHERE scope=? AND category<>'' GROUP BY category ORDER BY cnt DESC`).all(scope));
    },
    version: () => version,
  };

  const favorites = {
    list(user_id) { return plain(db.prepare('SELECT id, question, created_at FROM favorites WHERE user_id=? ORDER BY id DESC').all(user_id)); },
    all() { return plain(db.prepare('SELECT DISTINCT question FROM favorites').all()); },
    create(user_id, question) {
      const dup = db.prepare('SELECT id FROM favorites WHERE user_id=? AND question=?').get(user_id, question);
      if (dup) return dup.id;
      return Number(db.prepare('INSERT INTO favorites (user_id, question) VALUES (?,?)').run(user_id, question).lastInsertRowid);
    },
    remove(user_id, id) { return db.prepare('DELETE FROM favorites WHERE id=? AND user_id=?').run(id, user_id).changes; },
  };

  const traces = {
    create(t) {
      return Number(db.prepare('INSERT INTO traces (user_id, mode, query, answer, tools, sql, steps_json) VALUES (?,?,?,?,?,?,?)')
        .run(t.user_id || '', t.mode, t.query, t.answer || '', (t.tools || []).join(','), t.sql || '', JSON.stringify(t.steps || [])).lastInsertRowid);
    },
    feedback(id, fb, text) { return db.prepare('UPDATE traces SET feedback=?, feedback_text=? WHERE id=?').run(fb, text || '', id).changes; },
  };

  const snapshots = {
    latest() {
      const r = db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
      return r ? { date: r.snap_date, items: JSON.parse(r.items_json) } : null;
    },
    save(date, items) { db.prepare('INSERT INTO snapshots (snap_date, items_json) VALUES (?,?)').run(date, JSON.stringify(items)); },
  };

  return { db, qa, kb, favorites, traces, snapshots, close: () => db.close() };
}

module.exports = { createStore };
