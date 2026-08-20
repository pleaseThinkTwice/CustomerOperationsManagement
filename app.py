# -*- coding: utf-8 -*-
"""
客户运营平台 v2 —— 只做 QA + NL2SQL。
Flask 主程序，挂载 /api/* 路由与单页前端。
"""
import os
import socket

from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename

import config
import db
import kb_parser
import kb_router
import nl2sql
import doris_client
import llm_client

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64MB 上传上限


# ============================================================================
# 知识库同步
# ============================================================================
def sync_qa_to_knowledge():
    """把 qa 表同步为 knowledge_chunks（source=qa）。"""
    conn = db.get_conn()
    try:
        conn.execute("DELETE FROM knowledge_chunks WHERE source_type='qa'")
        rows = conn.execute(
            "SELECT question, answer, category FROM qa ORDER BY id"
        ).fetchall()
        for r in rows:
            content = f"问：{r['question']}\n答：{r['answer']}"
            conn.execute(
                "INSERT INTO knowledge_chunks(source_type, source_file, title, "
                "content, category) VALUES('qa', 'qa', ?, ?, ?)",
                (r["question"], content, r["category"]),
            )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def sync_folder_to_knowledge():
    """扫描 KB_DIR 文件夹，解析文档为 knowledge_chunks（source=folder）。"""
    folder = config.KB_DIR
    if not os.path.isdir(folder):
        return 0
    conn = db.get_conn()
    count = 0
    try:
        conn.execute("DELETE FROM knowledge_chunks WHERE category='folder_kb'")
        for root, _dirs, files in os.walk(folder):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in kb_parser.SUPPORTED_EXT:
                    continue
                path = os.path.join(root, fn)
                res = kb_parser.parse_file(path)
                if not res["ok"]:
                    continue
                stype = ext.lstrip(".")
                for chunk in kb_parser.chunk_text(res["text"]):
                    conn.execute(
                        "INSERT INTO knowledge_chunks(source_type, source_file, "
                        "title, content, category) VALUES(?, ?, ?, ?, 'folder_kb')",
                        (stype, fn, fn, chunk),
                    )
                    count += 1
        conn.commit()
    finally:
        conn.close()
    return count


def auto_sync_knowledge():
    n1 = sync_qa_to_knowledge()
    n2 = sync_folder_to_knowledge()
    kb_router.get_router().invalidate()
    print(f"[kb] 同步完成：qa={n1} 片段，folder={n2} 片段")


# ============================================================================
# 前端
# ============================================================================
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:name>")
def uploaded_file(name):
    return send_from_directory(config.UPLOAD_DIR, name)


# ============================================================================
# 健康检查 / 状态
# ============================================================================
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "service": "customer-ops v2 (QA + NL2SQL)"})


@app.route("/api/status")
def status():
    conn = db.get_conn()
    try:
        qa_n = conn.execute("SELECT COUNT(*) c FROM qa").fetchone()["c"]
        kb_n = conn.execute("SELECT COUNT(*) c FROM knowledge_chunks").fetchone()["c"]
        doc_n = conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"]
    finally:
        conn.close()
    llm = llm_client.get_client()
    return jsonify({
        "qa_count": qa_n,
        "knowledge_count": kb_n,
        "document_count": doc_n,
        "llm_enabled": llm.available(),
        "llm_model": config.LLM_MODEL if llm.available() else None,
        "doris_configured": doris_client.available(),
    })


# ============================================================================
# QA
# ============================================================================
@app.route("/api/qa/search", methods=["POST"])
def qa_search():
    data = request.get_json(force=True, silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query 不能为空"}), 400
    res = kb_router.get_router().route(query, use_llm=True)
    return jsonify(res)


@app.route("/api/qa", methods=["GET"])
def qa_list():
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT id, question, answer, category, updated_at FROM qa ORDER BY id DESC"
        ).fetchall()
    finally:
        conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/qa", methods=["POST"])
def qa_create():
    d = request.get_json(force=True, silent=True) or {}
    q, a = (d.get("question") or "").strip(), (d.get("answer") or "").strip()
    if not q or not a:
        return jsonify({"error": "question 和 answer 必填"}), 400
    conn = db.get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO qa(question, answer, category) VALUES(?, ?, ?)",
            (q, a, d.get("category")),
        )
        conn.commit()
        new_id = cur.lastrowid
    finally:
        conn.close()
    sync_qa_to_knowledge()
    kb_router.get_router().invalidate()
    return jsonify({"id": new_id, "ok": True})


@app.route("/api/qa/<int:qid>", methods=["PUT"])
def qa_update(qid):
    d = request.get_json(force=True, silent=True) or {}
    conn = db.get_conn()
    try:
        conn.execute(
            "UPDATE qa SET question=?, answer=?, category=?, "
            "updated_at=datetime('now','localtime') WHERE id=?",
            (d.get("question"), d.get("answer"), d.get("category"), qid),
        )
        conn.commit()
    finally:
        conn.close()
    sync_qa_to_knowledge()
    kb_router.get_router().invalidate()
    return jsonify({"ok": True})


@app.route("/api/qa/<int:qid>", methods=["DELETE"])
def qa_delete(qid):
    conn = db.get_conn()
    try:
        conn.execute("DELETE FROM qa WHERE id=?", (qid,))
        conn.commit()
    finally:
        conn.close()
    sync_qa_to_knowledge()
    kb_router.get_router().invalidate()
    return jsonify({"ok": True})


# ============================================================================
# 知识库
# ============================================================================
@app.route("/api/knowledge", methods=["GET"])
def knowledge_list():
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT id, source_type, source_file, title, "
            "substr(content,1,120) preview, created_at "
            "FROM knowledge_chunks ORDER BY id DESC LIMIT 500"
        ).fetchall()
    finally:
        conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/knowledge/upload", methods=["POST"])
def knowledge_upload():
    """上传文档 → 解析 → 入库 knowledge_chunks(source=document)。"""
    if "file" not in request.files:
        return jsonify({"error": "未收到文件（字段名应为 file）"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "文件名为空"}), 400

    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    fname = secure_filename(f.filename) or "upload"
    # secure_filename 可能清掉中文，做兜底
    if fname in ("", "upload") and f.filename:
        fname = f.filename.replace("/", "_").replace("\\", "_")
    save_path = os.path.join(config.UPLOAD_DIR, fname)
    f.save(save_path)

    res = kb_parser.parse_file(save_path)
    if not res["ok"]:
        return jsonify({"error": res["error"], "filename": fname}), 400

    chunks = kb_parser.chunk_text(res["text"])
    stype = os.path.splitext(fname)[1].lower().lstrip(".")
    oem = (request.form.get("oem") or "").strip() or None
    conn = db.get_conn()
    try:
        conn.execute(
            "INSERT INTO documents(oem, scope, doc_type, title, file_path, "
            "file_name, uploader) VALUES(?, 'internal', ?, ?, ?, ?, ?)",
            (oem, stype, fname, save_path, fname, request.form.get("uploader")),
        )
        for ch in chunks:
            conn.execute(
                "INSERT INTO knowledge_chunks(source_type, source_file, title, "
                "content, category) VALUES(?, ?, ?, ?, 'upload')",
                (stype, fname, fname, ch),
            )
        conn.commit()
    finally:
        conn.close()
    kb_router.get_router().invalidate()
    return jsonify({"ok": True, "filename": fname, "chunks": len(chunks)})


@app.route("/api/knowledge/sync", methods=["POST"])
def knowledge_sync():
    """重新同步 qa 表 + KB 文件夹。"""
    n1 = sync_qa_to_knowledge()
    n2 = sync_folder_to_knowledge()
    kb_router.get_router().invalidate()
    return jsonify({"ok": True, "qa_chunks": n1, "folder_chunks": n2})


# ============================================================================
# NL2SQL
# ============================================================================
@app.route("/api/nl2sql/query", methods=["POST"])
def nl2sql_query():
    d = request.get_json(force=True, silent=True) or {}
    q = (d.get("query") or "").strip()
    if not q:
        return jsonify({"error": "query 不能为空"}), 400
    do_summary = d.get("summary", True)
    res = nl2sql.answer(q, do_summary=do_summary)
    return jsonify(res)


@app.route("/api/nl2sql/schema", methods=["GET"])
def nl2sql_schema():
    try:
        schema = nl2sql.load_schema()
    except nl2sql.NL2SQLError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify(schema)


@app.route("/api/nl2sql/ping", methods=["GET"])
def nl2sql_ping():
    ok, msg = doris_client.ping()
    return jsonify({"ok": ok, "message": msg})


# ============================================================================
# 启动
# ============================================================================
def pick_port():
    if config.APP_PORT:
        return int(config.APP_PORT)
    for p in range(5020, 5030):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return 5020


def bootstrap():
    """启动前准备：建库（若不存在）、建目录、同步知识库。"""
    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    os.makedirs(config.KB_DIR, exist_ok=True)
    if not os.path.exists(config.DB_PATH):
        db.init_db()
    try:
        auto_sync_knowledge()
    except Exception as e:
        print(f"[kb] 自动同步跳过：{e}")


if __name__ == "__main__":
    bootstrap()
    port = pick_port()
    print(f"[app] 访问地址：http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=config.FLASK_DEBUG)
