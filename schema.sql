-- 客户运营平台 v2 · 只保留 QA / 知识库 相关表
-- SQLite

-- 用户（最小化，占位）
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    display    TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- Q&A 标准问答库（人工维护的高置信答案，用于"字面直答，零幻觉"）
CREATE TABLE IF NOT EXISTS qa (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    category   TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 知识片段（由 qa 表 + 上传文档解析同步而来，作为整库 prompt 的语料）
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT,           -- 来源类型: qa / document / manual
    title      TEXT,
    content    TEXT NOT NULL,
    doc_id     INTEGER,        -- 关联 documents.id（若来自文档）
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 上传文档登记
CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    path        TEXT NOT NULL,
    filetype    TEXT,
    size        INTEGER,
    chunk_count INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(source);
CREATE INDEX IF NOT EXISTS idx_chunks_doc    ON knowledge_chunks(doc_id);
