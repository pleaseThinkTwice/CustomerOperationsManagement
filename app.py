"""Standalone SQLBot portal for reviewed, reusable SQL templates."""

import asyncio
import json
import os
import sqlite3
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web
from query_runner import get_template, list_templates, run
from settings import setting


ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "saved-queries.sqlite3"
UPSTREAM = setting("SQLBOT_UPSTREAM", "http://127.0.0.1:8003")


def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS saved_queries (id INTEGER PRIMARY KEY, name TEXT NOT NULL, template_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    return db


async def page(_request):
    return web.Response(text=PAGE, content_type="text/html")


async def list_queries(_request):
    with connect() as db:
        rows = [dict(row) for row in db.execute("SELECT id, name, created_at FROM saved_queries ORDER BY id DESC")]
    return web.json_response({"queries": rows})


async def templates(_request):
    return web.json_response({"templates": list_templates()})


async def knowledge(_request):
    files = []
    for file in sorted((ROOT / "knowledge").glob("*.md")):
        files.append({"title": file.stem, "content": file.read_text(encoding="utf-8")})
    return web.json_response({"files": files})


async def save_query(request):
    body = await request.json()
    name = body.get("name", "")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise web.HTTPBadRequest(text="名称应为 1–60 个字符")
    template_key = body.get("template_key", "net_sales_monthly")
    try: get_template(template_key)
    except ValueError as exc: raise web.HTTPBadRequest(text=str(exc)) from exc
    with connect() as db:
        cur = db.execute("INSERT INTO saved_queries (name, template_key) VALUES (?, ?)", (name.strip(), template_key))
        query_id = cur.lastrowid
    return web.json_response({"id": query_id, "name": name.strip()})


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
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text="查询执行失败；请检查只读数据源和 SQL 模板") from exc


async def proxy(request):
    # SQLBot stays on the same browser origin; the saved-query screen is /saved/.
    upstream_url = UPSTREAM + request.rel_url.path_qs
    headers = {key: value for key, value in request.headers.items()
               if key.lower() not in {"host", "connection", "content-length", "accept-encoding"}}
    async with request.app["client"].request(
        request.method, upstream_url, headers=headers, data=await request.read(), allow_redirects=False
    ) as upstream:
        response_headers = {key: value for key, value in upstream.headers.items()
                            if key.lower() not in {"transfer-encoding", "connection", "content-length", "content-encoding"}}
        response = web.StreamResponse(status=upstream.status, headers=response_headers)
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536):
            await response.write(chunk)
        await response.write_eof()
        return response


async def client_context(app):
    app["client"] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=15))
    yield
    await app["client"].close()


PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQLBot · 问数与知识</title><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,-apple-system,'Segoe UI',sans-serif;color:#172235;background:#f4f7fb}
header{height:58px;background:#152b4a;color:white;display:flex;align-items:center;justify-content:space-between;padding:0 22px}header strong{font-size:18px}header small{opacity:.72}
nav{display:flex;gap:8px}button{font:inherit;cursor:pointer}nav button{border:0;background:transparent;color:#c7d7ed;padding:9px 16px;border-radius:8px}nav button.active{color:#fff;background:#315b96}
#bot{display:none;width:100%;height:calc(100vh - 58px);border:0}.wrap{max-width:1060px;margin:28px auto;padding:0 20px}.grid{display:grid;grid-template-columns:330px 1fr;gap:18px}
.card{background:#fff;border:1px solid #dfE6f0;border-radius:12px;padding:22px;box-shadow:0 3px 12px #152b4a0a}h1{margin:0 0 8px;font-size:25px}h2{font-size:17px;margin:0 0 16px}.muted{color:#66768e;line-height:1.6}.hint{background:#edf4ff;border-radius:8px;padding:12px;margin:17px 0;color:#335681}
input{width:100%;height:40px;border:1px solid #cbd6e5;border-radius:7px;padding:8px 10px;font:inherit}label{display:block;font-weight:600;margin:16px 0 7px}
.primary{background:#2865bd;color:white;border:0;border-radius:7px;padding:10px 16px;margin-top:15px}.primary:hover{background:#1c55a5}.saved{display:block;width:100%;text-align:left;border:1px solid #dce5f1;border-radius:8px;background:white;padding:12px;margin:8px 0}.saved:hover,.saved.active{border-color:#2865bd;background:#f1f6ff}
.result{font-size:36px;font-weight:700;color:#174d97;margin:12px 0}.pill{background:#eaf2ff;color:#2058a4;font-size:12px;border-radius:99px;padding:4px 9px}.error{color:#b52c2c}.status{min-height:20px;margin-top:10px}pre{background:#172235;color:#e3ecfa;padding:17px;white-space:pre-wrap;overflow:auto;border-radius:8px;font-size:12px;line-height:1.5}
@media(max-width:720px){.grid{grid-template-columns:1fr}header small{display:none}}
</style></head><body><header><div><strong>SQLBot</strong> <small>· 问数与知识</small></div><nav><button id="tab-bot" onclick="tab('bot')">智能问数</button><button id="tab-saved" class="active" onclick="tab('saved')">常用查询</button><button id="tab-knowledge" onclick="tab('knowledge')">知识与表说明</button></nav></header>
<iframe id="bot" title="SQLBot 智能问数" src="/#/chat/index?start_chat=1"></iframe>
<section id="knowledge" class="wrap" style="display:none"><h1>知识与表说明</h1><p class="muted">这些内容保存在项目的 knowledge/ 目录，可在公司电脑直接修改文件。确认后把表字段描述、术语和 SQL 示例录入 SQLBot 管理页。</p><div id="knowledge-list"></div></section>
<main id="saved" class="wrap"><h1>常用查询</h1><p class="muted">把确认过的查询保存起来。下次只需更换月份，就能直接运行同一套统计口径。</p>
<div class="grid"><section class="card"><h2>已保存</h2><div id="list" class="muted">正在读取…</div><hr style="border:0;border-top:1px solid #e5eaf2;margin:24px 0"><h2>保存当前示例查询</h2><p class="muted">已核对口径：净销售额＝有效订单金额－已完成退款。</p><label for="name">查询名称</label><input id="name" value="月度净销售额"><button class="primary" onclick="save()">保存为常用查询</button></section>
<section class="card"><h2>运行已保存的查询 <span class="pill">只读</span></h2><p id="selection" class="muted">请先在左侧保存或选中一条查询。</p><label for="month">统计月份</label><input id="month" type="month" value="2026-09" min="2000-01" max="2100-12"><button class="primary" onclick="run()">运行查询</button><p id="status" class="status"></p><div id="output" hidden><div class="muted">净销售额</div><div id="result" class="result"></div><p class="muted">以下 SQL 与本次结果对应；重复运行时不再生成 SQL。</p><pre id="sql"></pre></div></section></div></main>
<script>
let selected=null;
function tab(which){for(const key of ['bot','saved','knowledge']){document.getElementById(key).style.display=key===which?(key==='bot'?'block':''):'none';document.getElementById('tab-'+key).classList.toggle('active',key===which)}if(which==='knowledge')loadKnowledge()}
async function loadKnowledge(){const box=document.getElementById('knowledge-list');if(box.childElementCount)return;const data=await(await fetch('/saved/api/knowledge')).json();for(const file of data.files){const article=document.createElement('article');article.className='card';article.style.marginBottom='15px';const h=document.createElement('h2');h.textContent=file.title;const pre=document.createElement('pre');pre.style.background='#f4f7fb';pre.style.color='#172235';pre.textContent=file.content;article.append(h,pre);box.appendChild(article)}}
async function refresh(){const data=await (await fetch('/saved/api/queries')).json();const list=document.getElementById('list');list.replaceChildren();if(!data.queries.length){list.textContent='还没有保存的查询';return}for(const q of data.queries){const b=document.createElement('button');b.className='saved'+(selected===q.id?' active':'');b.textContent=q.name;b.onclick=()=>{selected=q.id;document.getElementById('selection').textContent='已选择：'+q.name;document.getElementById('output').hidden=true;refresh()};list.appendChild(b)}}
async function save(){const name=document.getElementById('name').value.trim();const res=await fetch('/saved/api/queries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(!res.ok){document.getElementById('status').textContent=await res.text();return}const q=await res.json();selected=q.id;document.getElementById('selection').textContent='已选择：'+q.name;document.getElementById('status').textContent='已保存。选择月份后可反复运行。';refresh()}
async function run(){const status=document.getElementById('status');if(!selected){status.textContent='请先保存或选择一条查询。';return}status.textContent='正在运行…';document.getElementById('output').hidden=true;const res=await fetch('/saved/api/queries/'+selected+'/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({month:document.getElementById('month').value})});if(!res.ok){status.className='status error';status.textContent=await res.text();return}const data=await res.json();status.className='status';status.textContent='运行完成 · '+data.month;document.getElementById('result').textContent='¥ '+data.value;document.getElementById('sql').textContent=data.sql;document.getElementById('output').hidden=false}
refresh();
</script></body></html>"""


def make_app():
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app.cleanup_ctx.append(client_context)
    app.router.add_get("/saved/", page)
    app.router.add_get("/saved/api/queries", list_queries)
    app.router.add_get("/saved/api/templates", templates)
    app.router.add_get("/saved/api/knowledge", knowledge)
    app.router.add_post("/saved/api/queries", save_query)
    app.router.add_post("/saved/api/queries/{id}/run", execute_query)
    app.router.add_route("*", "/{tail:.*}", proxy)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), access_log=None)
