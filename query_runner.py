"""Execute reviewed SQL templates with bound values and database read-only mode."""

import json
import re
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse
from settings import setting


ROOT = Path(__file__).resolve().parent
QUERIES = ROOT / "queries"
PARAM = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")
MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def get_template(key):
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", str(key)):
        raise ValueError("无效的查询编号")
    file = QUERIES / f"{key}.json"
    if not file.is_file():
        raise ValueError("查询模板不存在")
    template = json.loads(file.read_text(encoding="utf-8"))
    if template.get("id") != key:
        raise ValueError("查询模板编号不匹配")
    sql = template.get("sql", "").strip()
    if (not re.match(r"^(SELECT|WITH)\b", sql, re.I)
            or ";" in sql.rstrip(";")
            or re.search(r"\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|MERGE|CALL|EXECUTE|COPY)\b", sql, re.I)):
        raise ValueError("查询模板只能包含单条 SELECT 或 WITH 查询")
    return template


def list_templates():
    return [{k: t[k] for k in ("id", "name", "description", "parameters")}
            | {"result_label": t.get("result_label", ""), "result_unit": t.get("result_unit", "")}
            for file in sorted(QUERIES.glob("*.json"))
            for t in [get_template(file.stem)]]


def bind_parameters(template, inputs):
    values = {}
    for p in template.get("parameters", []):
        name = p["name"]
        raw = inputs.get(name, p.get("default"))
        if p.get("type") == "month":
            if raw == "previous_month":
                raw = (date.today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
            if not isinstance(raw, str) or not MONTH.fullmatch(raw):
                raise ValueError(f"{p.get('label', name)}应为 YYYY-MM")
            year, month = map(int, raw.split("-"))
            if year < 2000 or year > 2100:
                raise ValueError("月份超出范围")
            start = date(year, month, 1)
            end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
            values[name + "_start"] = start.isoformat()
            values[name + "_end"] = end.isoformat()
        elif p.get("type") in ("text", "number"):
            if raw is None or raw == "":
                if p.get("required"):
                    raise ValueError(f"{p.get('label', name)}不能为空")
                raw = None
            if p["type"] == "number" and raw is not None:
                try: raw = float(raw)
                except (TypeError, ValueError) as exc: raise ValueError(f"{name}应为数字") from exc
            values[name] = raw
        else:
            raise ValueError("不支持的参数类型")
    names = set(PARAM.findall(template["sql"]))
    if names != set(values):
        raise ValueError("SQL 占位符与参数定义不匹配")
    return values


def run(template, inputs):
    values = bind_parameters(template, inputs)
    url = setting("QUERY_DATABASE_URL", f"sqlite:///{ROOT / 'data' / 'demo.sqlite'}")
    scheme = urlparse(url).scheme.lower()
    sql = template["sql"].strip().rstrip(";")
    limit = 500
    if scheme == "sqlite":
        db_file = unquote(url.removeprefix("sqlite:///"))
        conn = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True, timeout=5)
        try:
            conn.execute("PRAGMA query_only=ON")
            deadline = time.monotonic() + 5
            conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10000)
            cur = conn.execute(f"SELECT * FROM ({sql}) AS saved_query LIMIT {limit}", values)
            columns = [c[0] for c in cur.description]
            rows = cur.fetchall()
        finally: conn.close()
    elif scheme in ("postgres", "postgresql", "mysql"):
        parsed = urlparse(url)
        args = dict(host=parsed.hostname, port=parsed.port or (5432 if scheme != "mysql" else 3306),
                    user=unquote(parsed.username or ""), password=unquote(parsed.password or ""),
                    database=unquote(parsed.path.lstrip("/")))
        ordered = []
        driver_sql = PARAM.sub(lambda m: (ordered.append(values[m.group(1)]), "%s")[1], sql)
        driver_sql = f"SELECT * FROM ({driver_sql}) AS saved_query LIMIT {limit}"
        if scheme == "mysql":
            import pymysql
            conn = pymysql.connect(**args, connect_timeout=5, read_timeout=10, write_timeout=10)
            try:
                with conn.cursor() as cur:
                    cur.execute("START TRANSACTION READ ONLY")
                    cur.execute(driver_sql, ordered)
                    columns = [c[0] for c in cur.description]
                    rows = cur.fetchall()
                conn.rollback()
            finally: conn.close()
        else:
            import psycopg
            conn = psycopg.connect(**args, connect_timeout=5)
            try:
                with conn.cursor() as cur:
                    cur.execute("SET TRANSACTION READ ONLY")
                    cur.execute("SET LOCAL statement_timeout = '5s'")
                    cur.execute(driver_sql, ordered)
                    columns = [c[0] for c in cur.description]
                    rows = cur.fetchall()
                conn.rollback()
            finally: conn.close()
    else:
        raise ValueError("QUERY_DATABASE_URL 仅支持 sqlite、postgresql、mysql")
    return {"columns": columns, "rows": [[str(v) if v is not None else None for v in row] for row in rows],
            "row_count": len(rows), "sql": sql, "parameters": values}
