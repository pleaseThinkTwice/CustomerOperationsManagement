# -*- coding: utf-8 -*-
"""
种子数据：默认用户 + 若干示例 Q&A。
用法：python seed.py（会先确保表存在）。可重复运行（幂等：先清空 qa 再灌）。
"""
import db

DEFAULT_USER = ("管理员", "客户运营", "管理员")  # name, department, position

SEED_QA = [  # (question, answer, category)
    ("平台支持哪些功能", "当前平台提供两大功能：智能问答（QA，基于知识库文档回答问题）与智能查数（NL2SQL，用自然语言查询 Doris 数据并生成报告）。", "平台"),
    ("QA 是怎么工作的", "QA 会先在标准问答库里做字面匹配，命中就直接返回人工维护的标准答案（零幻觉）；未命中则把整个知识库作为上下文交给 LLM 生成回答。", "QA"),
    ("支持解析哪些文档格式", "知识库支持解析 pdf、docx、pptx、xlsx、html、txt 等格式，解析后作为问答语料。", "QA"),
    ("NL2SQL 是什么", "NL2SQL 把你的自然语言问题转成 SQL，在 Doris（只读）上执行，再把结果整理成自然语言报告和表格。", "NL2SQL"),
    ("NL2SQL 会不会误删数据", "不会。NL2SQL 只允许执行单条 SELECT 查询，禁止任何增删改和 DDL，并使用只读账号，从机制上杜绝写操作。", "NL2SQL"),
    ("怎么新增可查询的表", "在 schema_config.yaml 里补充表名和字段说明即可，代码无需改动，NL2SQL 会自动读取新配置。", "NL2SQL"),
    ("cell_cap 是什么意思", "cell_cap 表示电芯容量，单位 Ah。", "字段"),
    ("oem 指什么", "oem 表示客户英文简称。", "字段"),
    ("没有配置 LLM 还能用吗", "可以。LLM_ENABLED=0 时平台离线可用，QA 仅返回库内标准答案匹配，NL2SQL 仍可生成模板/校验但生成式能力受限。", "平台"),
    ("Doris 连接失败怎么办", "检查堡垒机账号、网络与端口（默认 19030）。连接失败时 NL2SQL 查询会返回错误提示，但平台本身仍可启动。", "排错"),
]


def run():
    db.init_db()
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        # 用户（幂等重灌）
        cur.execute("DELETE FROM users")
        cur.execute(
            "INSERT INTO users(name, department, position) VALUES(?, ?, ?)",
            DEFAULT_USER,
        )
        # Q&A（幂等重灌）
        cur.execute("DELETE FROM qa")
        cur.executemany(
            "INSERT INTO qa(category, question, answer) VALUES(?, ?, ?)",
            [(c, q, a) for (q, a, c) in SEED_QA],
        )
        conn.commit()
        print(f"[seed] 用户 1，Q&A {len(SEED_QA)} 条 已写入")
    finally:
        conn.close()


if __name__ == "__main__":
    run()
