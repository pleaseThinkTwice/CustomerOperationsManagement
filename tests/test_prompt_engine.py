import json
import os
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import ClientSession, web

from app import DB, make_app
from prompt_engine import full_context, validate_sql
from query_runner import execute_sql


class PromptOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []

        async def model(request):
            payload = await request.json()
            self.requests.append(payload)
            question = payload["messages"][-1]["content"]
            if "怎么算" in question:
                obj = {"action": "answer", "answer": "有效订单金额减去已完成退款。"}
            elif "销售额" in question and "2026" not in question:
                obj = {"action": "clarify", "question": "要毛销售额还是净销售额？"}
            elif "危险" in question:
                obj = {"action": "sql", "sql": "DELETE FROM orders", "explanation": "错误语句"}
            else:
                obj = {"action": "sql", "sql": "WITH r AS (SELECT order_id, SUM(refund_amount) AS amount FROM refunds WHERE status='completed' GROUP BY order_id) SELECT SUM(o.order_amount - COALESCE(r.amount, 0)) AS net_sales FROM orders o LEFT JOIN r ON r.order_id=o.id WHERE o.status IN ('paid','refunded') AND o.order_date >= '2026-09-01' AND o.order_date < '2026-10-01'", "explanation": "按净销售额口径查询"}
            return web.json_response({"choices": [{"message": {"content": json.dumps(obj)}}]})

        mock = web.Application()
        mock.router.add_post("/v1/chat/completions", model)
        self.model_runner = web.AppRunner(mock)
        await self.model_runner.setup()
        site = web.TCPSite(self.model_runner, "127.0.0.1", 0)
        await site.start()
        model_port = site._server.sockets[0].getsockname()[1]

        self.environment = patch.dict(os.environ, {
            "LLM_BASE_URL": f"http://127.0.0.1:{model_port}/v1",
            "LLM_API_KEY": "test-only",
            "LLM_MODEL": "mock-model",
        })
        self.environment.start()

        self.app_runner = web.AppRunner(make_app())
        await self.app_runner.setup()
        app_site = web.TCPSite(self.app_runner, "127.0.0.1", 0)
        await app_site.start()
        app_port = app_site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{app_port}"

    async def asyncTearDown(self):
        await self.app_runner.cleanup()
        self.environment.stop()
        await self.model_runner.cleanup()

    async def ask(self, question, history=None):
        async with ClientSession() as session:
            async with session.post(self.url + "/saved/api/chat/ask", json={"question": question, "history": history or []}) as response:
                return response.status, await response.json() if response.status == 200 else await response.text()

    async def test_answer_clarify_and_sql_use_full_prompt(self):
        status, direct = await self.ask("净销售额怎么算？")
        self.assertEqual(status, 200)
        self.assertEqual(direct["action"], "answer")

        status, followup = await self.ask("销售额是多少？")
        self.assertEqual(status, 200)
        self.assertEqual(followup["action"], "clarify")

        status, data = await self.ask("2026年9月净销售额是多少？", [
            {"role": "user", "content": "销售额是多少？"},
            {"role": "assistant", "content": followup["question"]},
        ])
        self.assertEqual(status, 200)
        self.assertEqual(data["action"], "sql")
        self.assertEqual(data["rows"][0][0], "2900")
        self.assertEqual(len(self.requests), 3)
        context = full_context()
        self.assertIn("数据库方言：SQLite", context)
        for request in self.requests:
            self.assertIn(context, request["messages"][0]["content"])
            self.assertIn("表 orders：", request["messages"][0]["content"])
            self.assertIn("日期等条件必须按当前问题重新确定", request["messages"][0]["content"])
        self.assertEqual(len(self.requests[-1]["messages"]), 4)

    async def test_dangerous_sql_is_rejected(self):
        status, message = await self.ask("危险查询")
        self.assertEqual(status, 400)
        self.assertIn("只允许 SELECT", message)
        for sql in ("SELECT * FROM sqlite_master", "SELECT pg_sleep(5) FROM orders", "SELECT * FROM orders; DELETE FROM orders"):
            with self.assertRaises(ValueError):
                validate_sql(sql, ["orders"], "sqlite")
        with self.assertRaises(ValueError):
            validate_sql("SELECT * FROM orders FOR UPDATE", ["orders"], "postgres")

    async def test_result_cap_is_reported(self):
        data = execute_sql("WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x <= 500) SELECT x FROM seq", {})
        self.assertEqual(data["row_count"], 500)
        self.assertTrue(data["truncated"])
        self.assertEqual(data["rows"][-1], ["500"])

    async def test_chat_sql_can_be_saved_and_reused(self):
        status, result = await self.ask("2026年9月净销售额是多少？")
        self.assertEqual(status, 200)
        self.assertEqual(result["action"], "sql")
        key = None
        try:
            async with ClientSession() as session:
                async with session.post(self.url + "/saved/api/chat/save", json={"name": "九月净销售额", "sql": result["sql"]}) as response:
                    self.assertEqual(response.status, 200)
                    saved = await response.json()
                key = saved["template_key"]
                async with session.post(self.url + f"/saved/api/templates/{key}/run", json={}) as response:
                    self.assertEqual(response.status, 200)
                    rerun = await response.json()
                self.assertEqual(rerun["rows"], result["rows"])
                async with session.post(self.url + "/saved/api/chat/save", json={"name": "非法", "sql": "DELETE FROM orders"}) as response:
                    self.assertEqual(response.status, 400)
        finally:
            if key:
                (Path(__file__).resolve().parents[1] / "queries" / f"{key}.json").unlink(missing_ok=True)
                with sqlite3.connect(DB) as db:
                    db.execute("DELETE FROM saved_queries WHERE template_key = ?", (key,))

    async def test_knowledge_edit_updates_prompt_and_rejects_overflow(self):
        file = Path(__file__).resolve().parents[1] / "knowledge" / "业务术语.md"
        original = file.read_text(encoding="utf-8")
        try:
            async with ClientSession() as session:
                async with session.put(self.url + "/saved/api/knowledge/业务术语", json={"content": original + "\n临时验收术语：仅用于测试。"}) as response:
                    self.assertEqual(response.status, 200)
                self.assertIn("临时验收术语", full_context())
                async with session.put(self.url + "/saved/api/knowledge/业务术语", json={"content": "x" * 20001}) as response:
                    self.assertEqual(response.status, 400)
                self.assertIn("临时验收术语", full_context())
        finally:
            file.write_text(original, encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
