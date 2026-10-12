import sqlite3, random, datetime, sys
random.seed(7)
db = sqlite3.connect(sys.argv[1])
db.executescript("""
DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS tickets;
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, region TEXT, level TEXT, signup_date TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INT, order_date TEXT, amount REAL, status TEXT);
CREATE TABLE tickets(id INTEGER PRIMARY KEY, customer_id INT, created_at TEXT, category TEXT, status TEXT, resolve_hours REAL);
""")
regions=['华东','华南','华北','西南']; levels=['VIP','普通','普通','普通']
for i in range(1,201):
    d=datetime.date(2025,1,1)+datetime.timedelta(days=random.randint(0,600))
    db.execute("insert into customers values(?,?,?,?,?)",(i,f"客户{i:03d}",random.choice(regions),random.choice(levels),d.isoformat()))
oid=0
for c in range(1,201):
    for _ in range(random.randint(0,12)):
        oid+=1; d=datetime.date(2025,1,1)+datetime.timedelta(days=random.randint(0,640))
        db.execute("insert into orders values(?,?,?,?,?)",(oid,c,d.isoformat(),round(random.uniform(200,20000),2),random.choice(['已完成']*8+['已退款','进行中'])))
tid=0
for c in range(1,201):
    for _ in range(random.randint(0,5)):
        tid+=1; d=datetime.date(2026,1,1)+datetime.timedelta(days=random.randint(0,280))
        st=random.choice(['已解决']*4+['处理中'])
        db.execute("insert into tickets values(?,?,?,?,?,?)",(tid,c,d.isoformat(),random.choice(['物流','质量','退款','咨询']),st,round(random.uniform(1,96),1) if st=='已解决' else None))
db.commit()
print(db.execute("select (select count(*) from customers),(select count(*) from orders),(select count(*) from tickets)").fetchone())
