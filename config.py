# -*- coding: utf-8 -*-
"""
全局配置。所有敏感凭据都从环境变量读取；也可用 config.local.py 覆盖（不进 Git）。

优先级：config.local.py > 环境变量 > 这里的默认值
在堡垒机上，推荐把真实凭据写进环境变量（start.bat）或 config.local.py。
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _b(v, default=False):
    """把环境变量解析成 bool。"""
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ----------------------------------------------------------------------------
# 应用
# ----------------------------------------------------------------------------
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data.db"))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(BASE_DIR, "uploads"))
KB_DIR = os.environ.get("KB_DIR", os.path.join(BASE_DIR, "客户运营知识库"))

APP_PORT = os.environ.get("APP_PORT")  # 为空则自动探测 5020-5029
FLASK_DEBUG = _b(os.environ.get("FLASK_DEBUG"), False)

# ----------------------------------------------------------------------------
# LLM（OpenAI 兼容网关）
# ----------------------------------------------------------------------------
LLM_ENABLED = _b(os.environ.get("LLM_ENABLED"), False)
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_API_URL = os.environ.get(
    "LLM_API_URL", "https://aigate-dev.catl.com/v1/chat/completions"
)
LLM_MODEL = os.environ.get("LLM_MODEL", "DeepSeek-V4-Flash")
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "60"))
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))

# ----------------------------------------------------------------------------
# Doris（只读，MySQL 协议，走堡垒机）
# ----------------------------------------------------------------------------
DORIS_ENABLED = _b(os.environ.get("DORIS_ENABLED"), True)
DORIS_HOST = os.environ.get("DORIS_HOST", "172.18.45.7")
DORIS_PORT = int(os.environ.get("DORIS_PORT", "19030"))
DORIS_USER = os.environ.get("DORIS_USER", "")
DORIS_PASS = os.environ.get("DORIS_PASS", "")
DORIS_DB = os.environ.get("DORIS_DB", "")  # 可留空，表名里带库名
DORIS_CHARSET = os.environ.get("DORIS_CHARSET", "utf8mb4")

# NL2SQL schema 配置文件（堡垒机统一维护表结构）
SCHEMA_CONFIG_PATH = os.environ.get(
    "SCHEMA_CONFIG_PATH", os.path.join(BASE_DIR, "schema_config.yaml")
)
# 单次查询自动补的 LIMIT 上限
NL2SQL_MAX_LIMIT = int(os.environ.get("NL2SQL_MAX_LIMIT", "1000"))

# ----------------------------------------------------------------------------
# 本地覆盖（config.local.py，不进 Git）
# ----------------------------------------------------------------------------
try:
    from config_local import *  # noqa: F401,F403
except Exception:
    try:
        # 兼容文件名 config.local.py（用 importlib 加载带点的名字）
        import importlib.util as _ilu

        _p = os.path.join(BASE_DIR, "config.local.py")
        if os.path.exists(_p):
            _spec = _ilu.spec_from_file_location("config_local_dotted", _p)
            _mod = _ilu.module_from_spec(_spec)
            _spec.loader.exec_module(_mod)  # type: ignore
            for _k in dir(_mod):
                if _k.isupper():
                    globals()[_k] = getattr(_mod, _k)
    except Exception:
        pass
