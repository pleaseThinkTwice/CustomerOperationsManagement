"""Read local .env without requiring an extra package."""

import os
from pathlib import Path


def setting(name, default=""):
    if name in os.environ:
        return os.environ[name]
    env_file = Path(__file__).resolve().parent / ".env"
    if env_file.exists():
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                if key.strip() == name:
                    return value.strip()
    return default
