# -*- coding: utf-8 -*-
"""
SQLite 初始化与连接工具。
用法：python db.py  → 执行 schema.sql 建库。
"""
import os
import sqlite3

import config

SCHEMA_PATH = os.path.join(config.BASE_DIR, "schema.sql")


def get_conn():
    """获取一个开启了外键、行工厂为 Row 的连接。"""
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """执行 schema.sql 建表。"""
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        ddl = f.read()
    conn = get_conn()
    try:
        conn.executescript(ddl)
        conn.commit()
    finally:
        conn.close()
    print(f"[db] 初始化完成: {config.DB_PATH}")


if __name__ == "__main__":
    init_db()
