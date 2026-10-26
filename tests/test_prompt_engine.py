import json
import os
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, web

from app import make_app
from prompt_engine import full_context, validate_sql


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
        for request in self.requests:
            self.assertIn(context, request["messages"][0]["content"])
            self.assertIn("表 orders：", request["messages"][0]["content"])
        self.assertEqual(len(self.requests[-1]["messages"]), 4)

    async def test_dangerous_sql_is_rejected(self):
        status, message = await self.ask("危险查询")
        self.assertEqual(status, 400)
        self.assertIn("只允许 SELECT", message)
        for sql in ("SELECT * FROM sqlite_master", "SELECT pg_sleep(5) FROM orders", "SELECT * FROM orders; DELETE FROM orders"):
            with self.assertRaises(ValueError):
                validate_sql(sql, ["orders"], "sqlite")


if __name__ == "__main__":
    unittest.main()
