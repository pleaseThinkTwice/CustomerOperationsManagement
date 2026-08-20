# -*- coding: utf-8 -*-
"""
QA 路由层（不做三路融合）。

流程：
  ① 库内 Q&A 字面直答：用 RapidFuzz 对 qa 表做相似度匹配，≥阈值直接返回标准答案（零幻觉）
  ② 整库 prompt 兜底：把整个 knowledge_chunks 拼成稳定上下文交给 LLM（配合 prompt cache）

设计取舍：知识库文档数少，整库直接进 prompt 比 RAG 检索更简单、召回更全、成本可忽略。
"""
import db
import llm_client

DIRECT_ANSWER_THRESHOLD = 0.82  # 字面直答阈值（0~1）
CONTEXT_MAX_CHARS = 24000       # 整库上下文上限，超出则截断，避免超长


class KBRouter:
    def __init__(self):
        self._context_cache = None
        self._context_version = 0

    # ------------------------------------------------------------------
    # 上下文构建（稳定前缀，供 prompt cache 命中）
    # ------------------------------------------------------------------
    def invalidate(self):
        """知识库增删改后调用，使缓存的整库上下文失效。"""
        self._context_cache = None
        self._context_version += 1

    def build_context(self):
        if self._context_cache is not None:
            return self._context_cache

        conn = db.get_conn()
        try:
            rows = conn.execute(
                "SELECT source, title, content FROM knowledge_chunks ORDER BY id"
            ).fetchall()
        finally:
            conn.close()

        parts, total = [], 0
        for r in rows:
            title = (r["title"] or "").strip()
            content = (r["content"] or "").strip()
            if not content:
                continue
            block = (f"### {title}\n{content}" if title else content)
            if total + len(block) > CONTEXT_MAX_CHARS:
                parts.append("\n（知识库内容较多，已截断）")
                break
            parts.append(block)
            total += len(block)

        self._context_cache = "\n\n".join(parts) if parts else "（知识库为空）"
        return self._context_cache

    # ------------------------------------------------------------------
    # ① 库内 Q&A 字面直答
    # ------------------------------------------------------------------
    def direct_answer(self, query):
        conn = db.get_conn()
        try:
            rows = conn.execute("SELECT question, answer FROM qa").fetchall()
        finally:
            conn.close()
        if not rows:
            return None

        try:
            from rapidfuzz import fuzz

            best, best_score = None, 0.0
            for r in rows:
                score = fuzz.token_set_ratio(query, r["question"]) / 100.0
                if score > best_score:
                    best, best_score = r, score
            if best and best_score >= DIRECT_ANSWER_THRESHOLD:
                return {"answer": best["answer"], "matched": best["question"],
                        "score": round(best_score, 3)}
        except Exception:
            # 无 rapidfuzz 时退化为精确/包含匹配
            for r in rows:
                if query.strip() and query.strip() in r["question"]:
                    return {"answer": r["answer"], "matched": r["question"], "score": 1.0}
        return None

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    def route(self, query, use_llm=True):
        """返回 {answer, mode, matched?, llm_enabled}。"""
        llm = llm_client.get_client()

        # ① 直答
        hit = self.direct_answer(query)
        if hit:
            return {
                "answer": hit["answer"],
                "mode": "direct",
                "matched": hit["matched"],
                "score": hit["score"],
                "llm_enabled": llm.available(),
            }

        # ② 整库 prompt 兜底
        if use_llm and llm.available():
            try:
                context = self.build_context()
                ans = llm.answer_with_context(context, query)
                return {"answer": ans, "mode": "llm", "llm_enabled": True}
            except llm_client.LLMError as e:
                return {
                    "answer": f"（LLM 调用失败，暂无法生成回答）\n{e}",
                    "mode": "llm_error",
                    "llm_enabled": True,
                }

        # ③ 离线：无直答且无 LLM
        return {
            "answer": "未在标准问答库中找到匹配，且当前未启用 LLM（LLM_ENABLED=0），无法生成回答。",
            "mode": "offline_miss",
            "llm_enabled": False,
        }


_router = None


def get_router():
    global _router
    if _router is None:
        _router = KBRouter()
    return _router
