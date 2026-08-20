# -*- coding: utf-8 -*-
"""
Doris 只读查询客户端（MySQL 协议，走堡垒机）。

只读：不提供任何写接口；SQL 安全性由 nl2sql.py 的校验层保证。
凭据来自 config（环境变量 / config.local.py）。
"""
import config


class DorisError(Exception):
    pass


def available():
    return bool(config.DORIS_ENABLED and config.DORIS_HOST and config.DORIS_USER)


def _connect():
    try:
        import pymysql
    except Exception:
        raise DorisError("未安装 pymysql（pip install pymysql）")
    if not available():
        raise DorisError("Doris 未配置或未启用（检查 DORIS_* 环境变量 / config.local.py）")
    try:
        return pymysql.connect(
            host=config.DORIS_HOST,
            port=config.DORIS_PORT,
            user=config.DORIS_USER,
            password=config.DORIS_PASS,
            database=config.DORIS_DB or None,
            charset=config.DORIS_CHARSET,
            connect_timeout=15,
            read_timeout=60,
            cursorclass=pymysql.cursors.Cursor,
        )
    except Exception as e:
        raise DorisError(f"Doris 连接失败: {e}")


def query(sql, max_rows=None):
    """执行只读查询，返回 (columns: list[str], rows: list[list])。"""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            columns = [d[0] for d in cur.description] if cur.description else []
            if max_rows:
                data = cur.fetchmany(max_rows)
            else:
                data = cur.fetchall()
            rows = [list(r) for r in data]
        return columns, rows
    except Exception as e:
        raise DorisError(f"Doris 查询失败: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def ping():
    """连通性自检。返回 (ok, message)。"""
    try:
        cols, rows = query("SELECT 1")
        return True, "Doris 连接正常"
    except DorisError as e:
        return False, str(e)
