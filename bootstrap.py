"""Create local-only demo data and credentials without committing secrets."""

import secrets
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
env_file = ROOT / ".env"
if not env_file.exists():
    env_file.write_text(
        "POSTGRES_PASSWORD=" + secrets.token_urlsafe(24) + "\n"
        "SECRET_KEY=" + secrets.token_urlsafe(32) + "\n"
        "DEFAULT_PWD=" + secrets.token_urlsafe(16) + "\n",
        encoding="utf-8",
    )
    env_file.chmod(0o600)
    print("已生成 .env；请妥善保存。")

file = DATA / "demo.sqlite"
if not file.exists():
    source = (ROOT / "knowledge" / "demo-seed.sql").read_text(encoding="utf-8")
    source = source.split("COMMENT ON TABLE")[0]
    with sqlite3.connect(file) as db:
        db.executescript(source)
    print("已生成合成订单数据：data/demo.sqlite")
