"""Create local synthetic data and a model configuration template."""

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
env_file = ROOT / ".env"
if not env_file.exists():
    env_file.write_text(
        "# OpenAI-compatible model API; keep the key only on this computer.\n"
        "LLM_BASE_URL=\n"
        "LLM_API_KEY=\n"
        "LLM_MODEL=\n"
        "PROMPT_TABLES=orders,order_items,refunds\n"
        "# QUERY_DATABASE_URL=sqlite:////absolute/path/to/database.sqlite\n",
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
