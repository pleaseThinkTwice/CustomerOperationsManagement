# -*- coding: utf-8 -*-
"""
外部 LLM 客户端（OpenAI 兼容网关，如 aigate-dev.catl.com）。

只用标准库 urllib，避免额外依赖。
关键设计（配合 prompt cache）：把不变的大段上下文（系统指令 + 整库知识 / schema）
放在 messages 的最前面且保持稳定，让网关/模型的自动前缀缓存尽可能命中，
重复提问时只有末尾的问题变化，成本可忽略。
"""
import json
import urllib.request
import urllib.error

import config


class LLMError(Exception):
    pass


class LLMClient:
    def __init__(self):
        self.enabled = config.LLM_ENABLED
        self.api_key = config.LLM_API_KEY
        self.api_url = config.LLM_API_URL
        self.model = config.LLM_MODEL
        self.timeout = config.LLM_TIMEOUT
        self.temperature = config.LLM_TEMPERATURE

    def available(self):
        return bool(self.enabled and self.api_url)

    # ------------------------------------------------------------------
    # 低层：直接发 messages
    # ------------------------------------------------------------------
    def chat(self, messages, temperature=None, max_tokens=None):
        """messages: [{"role": "system"/"user"/"assistant", "content": "..."}]"""
        if not self.available():
            raise LLMError("LLM 未启用（LLM_ENABLED=0）")

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "stream": False,
        }
        if max_tokens:
            payload["max_tokens"] = max_tokens

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = urllib.request.Request(
            self.api_url, data=data, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise LLMError(f"LLM HTTP {e.code}: {detail[:500]}")
        except Exception as e:
            raise LLMError(f"LLM 请求失败: {e}")

        try:
            obj = json.loads(body)
            return obj["choices"][0]["message"]["content"]
        except Exception:
            raise LLMError(f"LLM 响应解析失败: {body[:500]}")

    # ------------------------------------------------------------------
    # QA：稳定前缀（系统 + 整库知识）+ 变化的问题
    # ------------------------------------------------------------------
    def answer_with_context(self, context, question):
        """整库 prompt 问答。context 为拼好的知识库全文（稳定前缀）。"""
        system = (
            "你是客户运营平台的智能问答助手。请严格依据下方【知识库】回答用户问题，"
            "用简体中文、条理清晰地作答。若知识库中没有相关信息，请明确说明"
            "“知识库中未找到相关信息”，不要编造。\n\n"
            "【知识库】\n" + context
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": question},
        ]
        return self.chat(messages)

    # ------------------------------------------------------------------
    # NL2SQL：生成 SQL
    # ------------------------------------------------------------------
    def generate_sql(self, schema_prompt, question):
        """返回模型生成的 SQL 文本（可能带 ```sql 包裹，交由调用方清洗）。"""
        system = (
            "你是一名严谨的数据分析工程师，负责把用户的自然语言问题转换成"
            " Doris（MySQL 语法）的 **只读 SELECT** 查询。\n"
            "规则：\n"
            "1. 只能生成一条 SELECT 语句，禁止任何 INSERT/UPDATE/DELETE/DROP/ALTER 等写操作。\n"
            "2. 只能使用下方【表结构】中出现的表名和字段名，不要臆造表或字段。\n"
            "3. 表名需使用其完整名称（含库名）。\n"
            "4. 结果集较大时请自行加上合理的 LIMIT。\n"
            "5. 只输出 SQL 本身，不要输出解释文字。\n\n"
            "【表结构】\n" + schema_prompt
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": question},
        ]
        return self.chat(messages, temperature=0.0)

    # ------------------------------------------------------------------
    # NL2SQL：把结果整理成自然语言报告
    # ------------------------------------------------------------------
    def summarize_result(self, question, sql, columns, rows, max_rows=30):
        """rows: list[list]。返回自然语言报告。"""
        preview = rows[:max_rows]
        table_txt = " | ".join(columns) + "\n"
        for r in preview:
            table_txt += " | ".join("" if v is None else str(v) for v in r) + "\n"
        if len(rows) > max_rows:
            table_txt += f"...（共 {len(rows)} 行，仅展示前 {max_rows} 行）\n"

        system = (
            "你是一名数据分析师。请根据用户的问题、执行的 SQL 和查询结果，"
            "用简体中文写一段简洁、准确的分析结论/报告。突出关键数字和结论，"
            "不要编造结果中没有的数据。"
        )
        user = (
            f"用户问题：{question}\n\n"
            f"执行的 SQL：\n{sql}\n\n"
            f"查询结果（表格）：\n{table_txt}"
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        return self.chat(messages, temperature=0.3)


# 单例
_client = None


def get_client():
    global _client
    if _client is None:
        _client = LLMClient()
    return _client
