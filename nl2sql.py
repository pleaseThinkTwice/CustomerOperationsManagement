# -*- coding: utf-8 -*-
"""
NL2SQL：自然语言 → SQL → Doris 只读执行 → 报告。

鲁棒/安全设计：
  - schema 来自外部 schema_config.yaml（堡垒机统一维护），代码零改动适配新表。
  - LLM 生成 SQL 后，经过严格安全校验：只允许单条 SELECT、禁写操作、表名白名单、自动补 LIMIT。
  - 执行只读账号，双重保险。
"""
import os
import re

import config
import doris_client
import llm_client

# ----------------------------------------------------------------------------
# schema 配置加载
# ----------------------------------------------------------------------------
_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|"
    r"REVOKE|CALL|EXEC|EXECUTE|LOAD|OUTFILE|DUMPFILE|SET|USE|ATTACH)\b",
    re.IGNORECASE,
)
_TABLE_REF = re.compile(r"\b(?:FROM|JOIN)\s+([`\w.]+)", re.IGNORECASE)


class NL2SQLError(Exception):
    pass


def load_schema():
    """读取 schema_config.yaml，返回 dict（失败时返回空结构）。"""
    path = config.SCHEMA_CONFIG_PATH
    if not os.path.exists(path):
        return {"dialect": "MySQL", "tables": [], "intents": []}
    try:
        import yaml
    except Exception:
        raise NL2SQLError("未安装 pyyaml（pip install pyyaml），无法读取 schema 配置")
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    data.setdefault("dialect", "MySQL")
    data.setdefault("tables", [])
    data.setdefault("intents", [])
    return data


def known_table_names(schema):
    names = set()
    for t in schema.get("tables", []):
        n = (t.get("name") or "").strip().strip("`").lower()
        if n:
            names.add(n)
    return names


def build_schema_prompt(schema, question=None):
    """把表结构 + 命中的意图拼成给 LLM 的提示文本。"""
    lines = [f"方言：{schema.get('dialect', 'MySQL')}"]
    for t in schema.get("tables", []):
        lines.append(f"\n表名：{t.get('name')}  —— {t.get('desc', '')}")
        cols = t.get("columns", {}) or {}
        for col, meaning in cols.items():
            lines.append(f"  - {col}: {meaning}")

    # 命中意图 few-shot
    if question:
        hit_notes = []
        for it in schema.get("intents", []):
            kws = it.get("keywords", []) or []
            if any(kw and kw in question for kw in kws):
                hit_notes.append(f"- {it.get('name')}：{it.get('note', '')}")
        if hit_notes:
            lines.append("\n【相关业务口径提示】")
            lines.extend(hit_notes)
    return "\n".join(lines)


# ----------------------------------------------------------------------------
# SQL 清洗 + 安全校验
# ----------------------------------------------------------------------------
def clean_sql(raw):
    """去掉 ```sql 包裹、多余空白、结尾分号。"""
    s = (raw or "").strip()
    # 去代码块围栏
    s = re.sub(r"^```(?:sql)?\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*```$", "", s)
    s = s.strip()
    # 去行注释与块注释
    s = re.sub(r"--[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = s.strip().rstrip(";").strip()
    return s


def validate_sql(sql, schema):
    """安全校验。通过返回 (True, 最终SQL)；不通过抛 NL2SQLError。"""
    if not sql:
        raise NL2SQLError("生成的 SQL 为空")

    # 单语句：清洗后不应再含 ';'
    if ";" in sql:
        raise NL2SQLError("只允许单条语句，检测到多条 SQL")

    head = sql.lstrip("( \t\n").upper()
    if not (head.startswith("SELECT") or head.startswith("WITH")):
        raise NL2SQLError("只允许 SELECT / WITH 查询语句")

    if _FORBIDDEN.search(sql):
        raise NL2SQLError("检测到被禁止的写操作/危险关键字，已拦截")

    # 表名白名单（仅当配置里有表时启用）
    whitelist = known_table_names(schema)
    if whitelist:
        refs = [m.strip("`").lower() for m in _TABLE_REF.findall(sql)]
        # 允许引用 CTE 名（WITH 定义）：粗略提取 WITH x AS
        cte_names = set(
            m.lower() for m in re.findall(r"\b([A-Za-z_]\w*)\s+AS\s*\(", sql, re.IGNORECASE)
        )
        for r in refs:
            if r in cte_names:
                continue
            if r not in whitelist:
                raise NL2SQLError(
                    f"引用了未在 schema_config.yaml 中登记的表：{r}（仅允许查询已登记表）"
                )

    # 自动补 LIMIT
    if not re.search(r"\bLIMIT\b", sql, re.IGNORECASE):
        sql = f"{sql}\nLIMIT {config.NL2SQL_MAX_LIMIT}"

    return True, sql


# ----------------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------------
def answer(question, do_summary=True):
    """
    返回 dict：
      { ok, question, sql, columns, rows, row_count, report, error, stage }
    stage 标记失败发生在哪一步，便于排错。
    """
    result = {
        "ok": False, "question": question, "sql": None,
        "columns": [], "rows": [], "row_count": 0,
        "report": None, "error": None, "stage": None,
    }

    llm = llm_client.get_client()
    if not llm.available():
        result["stage"] = "llm"
        result["error"] = "未启用 LLM（LLM_ENABLED=0），NL2SQL 需要 LLM 生成 SQL。"
        return result

    # 1) 生成 SQL
    try:
        schema = load_schema()
        schema_prompt = build_schema_prompt(schema, question)
        raw = llm.generate_sql(schema_prompt, question)
        sql = clean_sql(raw)
    except (llm_client.LLMError, NL2SQLError) as e:
        result["stage"] = "generate"
        result["error"] = f"生成 SQL 失败：{e}"
        return result

    # 2) 安全校验
    try:
        _, sql = validate_sql(sql, schema)
        result["sql"] = sql
    except NL2SQLError as e:
        result["stage"] = "validate"
        result["sql"] = sql
        result["error"] = f"SQL 安全校验未通过：{e}"
        return result

    # 3) 执行
    try:
        columns, rows = doris_client.query(sql, max_rows=config.NL2SQL_MAX_LIMIT)
        result["columns"] = columns
        result["rows"] = rows
        result["row_count"] = len(rows)
    except doris_client.DorisError as e:
        result["stage"] = "execute"
        result["error"] = f"Doris 执行失败：{e}"
        return result

    # 4) 报告（可选）
    if do_summary and rows:
        try:
            result["report"] = llm.summarize_result(question, sql, columns, rows)
        except llm_client.LLMError as e:
            result["report"] = f"（结果已返回，但生成文字报告失败：{e}）"

    result["ok"] = True
    result["stage"] = "done"
    return result
