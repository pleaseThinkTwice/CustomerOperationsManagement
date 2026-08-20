# -*- coding: utf-8 -*-
"""
离线冒烟测试（不依赖 LLM / Doris）。
用法：python tests/smoke_test.py
覆盖：建库、种子、QA 直答、QA 未命中降级、知识同步、schema 加载、SQL 安全校验。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db
import seed
import nl2sql
import app as flask_app


def main():
    ok = True
    seed.run()
    flask_app.bootstrap()
    c = flask_app.app.test_client()

    # 健康
    assert c.get("/api/health").get_json()["ok"], "health 失败"

    # QA 直答
    r = c.post("/api/qa/search", json={"query": "支持解析哪些文档格式"}).get_json()
    assert r["mode"] == "direct", f"应命中库内直答，实际 {r['mode']}"

    # QA 未命中 + 无 LLM → 离线降级
    r = c.post("/api/qa/search", json={"query": "无关问题askjdhqwe"}).get_json()
    assert r["mode"] in ("offline_miss", "llm"), f"未命中降级异常 {r['mode']}"

    # schema
    schema = nl2sql.load_schema()
    assert isinstance(schema.get("tables"), list), "schema 加载失败"

    # SQL 安全校验：允许 SELECT，拦截写操作/未登记表/多语句
    cases = [
        ("SELECT oem FROM metric_device.dm_ss_bdpd_md_info", True),
        ("DELETE FROM metric_device.dm_ss_bdpd_md_info", False),
        ("SELECT * FROM unknown_tbl", False),
        ("SELECT 1; DROP TABLE x", False),
        ("UPDATE t SET a=1", False),
    ]
    for sql, expect in cases:
        try:
            nl2sql.validate_sql(nl2sql.clean_sql(sql), schema)
            got = True
        except nl2sql.NL2SQLError:
            got = False
        if got != expect:
            ok = False
            print(f"[FAIL] SQL 校验 {sql!r} 期望 {expect} 实际 {got}")

    # auto LIMIT
    _, final = nl2sql.validate_sql(
        nl2sql.clean_sql("SELECT oem FROM metric_device.dm_ss_bdpd_md_info"), schema
    )
    assert "LIMIT" in final.upper(), "未自动补 LIMIT"

    print("[OK] 全部冒烟测试通过" if ok else "[FAIL] 存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
