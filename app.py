"""Standalone prompt-only QA, text-to-SQL and saved-query workbench."""

import asyncio
import json
import os
import secrets
import sqlite3
from pathlib import Path

from aiohttp import web
from prompt_engine import KNOWLEDGE_FILES, answer, allowed_tables, database_url, full_context, schema_text, validate_sql
from query_runner import get_template, list_templates, run
from settings import setting
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "saved-queries.sqlite3"


def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS saved_queries (id INTEGER PRIMARY KEY, name TEXT NOT NULL, template_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    return db


async def page(_request):
    return web.FileResponse(ROOT / "public" / "index.html")


async def list_queries(_request):
    with connect() as db:
        rows = [dict(row) for row in db.execute("SELECT id, name, template_key, created_at FROM saved_queries ORDER BY id DESC")]
    return web.json_response({"queries": rows})


async def templates(_request):
    try:
        return web.json_response({"templates": list_templates()})
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        raise web.HTTPBadRequest(text="查询模板配置有误，请检查 queries/ 目录中的 JSON 与 SQL") from exc


async def knowledge(_request):
    files = []
    root = ROOT / "knowledge"
    priority = ["表与字段说明.md", "业务术语.md", "常见问答.md", "SQL示例.md"]
    ordered = [root / name for name in priority if (root / name).exists()]
    for file in ordered:
        files.append({"title": file.stem, "content": file.read_text(encoding="utf-8")})
    return web.json_response({"files": files})


async def schema(_request):
    try:
        return web.json_response({"content": await asyncio.to_thread(schema_text)})
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text="无法读取表结构；请检查数据库连接和 PROMPT_TABLES") from exc


async def update_knowledge(request):
    name = request.match_info["name"] + ".md"
    if name not in KNOWLEDGE_FILES:
        raise web.HTTPNotFound(text="知识文件不存在")
    body = await request.json()
    content = body.get("content") if isinstance(body, dict) else None
    if not isinstance(content, str) or not content.strip() or len(content) > 20000:
        raise web.HTTPBadRequest(text="知识内容应为 1–20000 字")
    try:
        full_context({name: content})
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    file = ROOT / "knowledge" / name
    temporary = file.with_suffix(".md.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(file)
    return web.json_response({"title": file.stem, "content": content})


async def chat_status(_request):
    ready = all(setting(name) for name in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"))
    return web.json_response({"model_ready": ready, "model": setting("LLM_MODEL") if ready else ""})


async def chat_ask(request):
    body = await request.json()
    question = body.get("question", "")
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 2000:
        raise web.HTTPBadRequest(text="请输入 1–2000 字的问题")
    history = body.get("history", [])
    if not isinstance(history, list) or len(history) > 12:
        raise web.HTTPBadRequest(text="对话历史格式无效")
    try:
        return web.json_response(await answer(question.strip(), history))
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    except RuntimeError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc)) from exc
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text="问答失败，请检查模型和只读数据库连接") from exc


async def save_query(request):
    body = await request.json()
    template_key = body.get("template_key", "net_sales_monthly")
    try:
        template = get_template(template_key)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    name = body.get("name") or template["name"]
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise web.HTTPBadRequest(text="名称应为 1–60 个字符")
    with connect() as db:
        existing = db.execute(
            "SELECT id, name FROM saved_queries WHERE template_key = ? ORDER BY id LIMIT 1",
            (template_key,),
        ).fetchone()
        if existing:
            return web.json_response({"id": existing["id"], "name": existing["name"], "already_saved": True})
        cur = db.execute("INSERT INTO saved_queries (name, template_key) VALUES (?, ?)", (name.strip(), template_key))
        query_id = cur.lastrowid
    return web.json_response({"id": query_id, "name": name.strip()})


async def save_chat_query(request):
    body = await request.json()
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="保存内容格式无效")
    name, sql = body.get("name"), body.get("sql")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise web.HTTPBadRequest(text="名称应为 1–60 个字符")
    try:
        sql = validate_sql(sql, allowed_tables(), urlparse(database_url()).scheme.lower())
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    key = "saved_" + secrets.token_hex(8)
    file = ROOT / "queries" / f"{key}.json"
    template = {"id": key, "name": name.strip(), "description": "从问答保存的固定 SQL；再次运行使用相同的查询条件。", "parameters": [], "sql": sql}
    try:
        with file.open("x", encoding="utf-8") as stream:
            json.dump(template, stream, ensure_ascii=False, indent=2)
        with connect() as db:
            cur = db.execute("INSERT INTO saved_queries (name, template_key) VALUES (?, ?)", (name.strip(), key))
        return web.json_response({"id": cur.lastrowid, "name": name.strip(), "template_key": key})
    except Exception:
        file.unlink(missing_ok=True)
        raise


async def run_template(request):
    try:
        template = get_template(request.match_info["key"])
        body = await request.json()
        result = await asyncio.to_thread(run, template, body)
        return web.json_response(result)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text="查询执行失败，请检查数据库连接与查询模板") from exc


async def execute_query(request):
    try:
        query_id = int(request.match_info["id"])
        body = await request.json()
        with connect() as db:
            row = db.execute("SELECT template_key FROM saved_queries WHERE id = ?", (query_id,)).fetchone()
        if row is None:
            raise web.HTTPNotFound(text="常用查询不存在")
        template = get_template(row["template_key"])
        result = await asyncio.to_thread(run, template, body)
        return web.json_response({"month": body.get("month"), "value": result["rows"][0][0] if result["rows"] else "无结果", **result})
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    except web.HTTPException:
        raise
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text="查询执行失败；请检查只读数据源和 SQL 模板") from exc


def make_app():
    app = web.Application(client_max_size=32 * 1024 * 1024)
    async def home(_request):
        raise web.HTTPFound("/saved/")

    app.router.add_get("/", home)
    app.router.add_get("/saved/", page)
    app.router.add_get("/saved/api/queries", list_queries)
    app.router.add_get("/saved/api/templates", templates)
    app.router.add_get("/saved/api/knowledge", knowledge)
    app.router.add_get("/saved/api/schema", schema)
    app.router.add_put("/saved/api/knowledge/{name}", update_knowledge)
    app.router.add_get("/saved/api/chat/status", chat_status)
    app.router.add_post("/saved/api/chat/ask", chat_ask)
    app.router.add_post("/saved/api/queries", save_query)
    app.router.add_post("/saved/api/chat/save", save_chat_query)
    app.router.add_post("/saved/api/templates/{key}/run", run_template)
    app.router.add_post("/saved/api/queries/{id}/run", execute_query)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), access_log=None)
