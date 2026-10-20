import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
Q=[
("华东区的 VIP 客户有多少个？",
"SELECT COUNT(*) AS VIP客户数\nFROM customers\nWHERE region = '华东' AND level = 'VIP';"),
("2026 年每个季度的成交额是多少（不含退款）？",
"SELECT CASE WHEN strftime('%m', order_date) <= '03' THEN 'Q1'\n            WHEN strftime('%m', order_date) <= '06' THEN 'Q2'\n            WHEN strftime('%m', order_date) <= '09' THEN 'Q3' ELSE 'Q4' END AS 季度,\n       ROUND(SUM(amount), 0) AS 成交额\nFROM orders\nWHERE order_date >= '2026-01-01' AND status = '已完成'\nGROUP BY 季度 ORDER BY 季度;"),
("今年哪类工单平均解决时间最长？",
"SELECT category AS 工单类别, ROUND(AVG(resolve_hours), 1) AS 平均解决小时, COUNT(*) AS 已解决工单数\nFROM tickets\nWHERE status = '已解决' AND created_at >= '2026-01-01'\nGROUP BY category ORDER BY 平均解决小时 DESC;"),
("最近 90 天没下过单的 VIP 客户有哪些？（流失预警）",
"SELECT c.name AS 客户, c.region AS 区域, MAX(o.order_date) AS 最近下单日\nFROM customers c LEFT JOIN orders o ON o.customer_id = c.id\nWHERE c.level = 'VIP'\nGROUP BY c.id\nHAVING 最近下单日 IS NULL OR 最近下单日 < date('2026-10-12', '-90 day')\nORDER BY 最近下单日 LIMIT 5;"),
("成交额前 5 的客户，各自还有几张未解决工单？",
"SELECT c.name AS 客户, ROUND(SUM(o.amount), 0) AS 累计成交额,\n       (SELECT COUNT(*) FROM tickets t WHERE t.customer_id = c.id AND t.status = '处理中') AS 未解决工单\nFROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = '已完成'\nGROUP BY c.id ORDER BY 累计成交额 DESC LIMIT 5;"),
]
for q,sql in Q:
    cur=db.execute(sql); cols=[d[0] for d in cur.description]; rows=cur.fetchall()
    cnt=None
    print("###",q); print(sql); print(cols)
    for r in rows: print(r)
    print()
print(db.execute("select count(*) from customers c where level='VIP' and not exists(select 1 from orders o where o.customer_id=c.id and o.order_date>=date('2026-10-12','-90 day'))").fetchone())
