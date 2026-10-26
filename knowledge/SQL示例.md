# 经核对的 SQL 示例

将问题及对应 SQL 添加到 SQLBot 的「SQL 示例库」。替换真实表名后先在只读库验证结果。

**问题：** 2026 年 9 月净销售额是多少？

```sql
WITH r AS (
  SELECT order_id, SUM(refund_amount) AS amount
  FROM refunds WHERE status = 'completed' GROUP BY order_id
)
SELECT SUM(o.order_amount - COALESCE(r.amount, 0)) AS net_sales
FROM orders o LEFT JOIN r ON r.order_id = o.id
WHERE o.status IN ('paid', 'refunded')
  AND o.order_date >= '2026-09-01' AND o.order_date < '2026-10-01';
```

演示数据参考结果：`2900.00`。这条示例与 `queries/net_sales_monthly.json` 的可重跑查询使用同一业务口径。
