@echo off
REM ============================================================
REM 前台启动（调试用）。先确保已建库+种子：
REM   .venv\Scripts\python.exe db.py
REM   .venv\Scripts\python.exe seed.py
REM ============================================================
chcp 65001 >nul
cd /d %~dp0

REM 线程库降噪
set OPENBLAS_NUM_THREADS=1
set OMP_NUM_THREADS=1
set PYTHONIOENCODING=utf-8

REM ---- LLM 配置（按需修改；或改用 config.local.py）----
set LLM_ENABLED=1
REM set LLM_API_KEY=你的key
set LLM_API_URL=https://aigate-dev.catl.com/v1/chat/completions
set LLM_MODEL=DeepSeek-V4-Flash
set LLM_TIMEOUT=60

REM ---- Doris 只读（按需修改；或改用 config.local.py）----
set DORIS_ENABLED=1
set DORIS_HOST=172.18.45.7
set DORIS_PORT=19030
REM set DORIS_USER=账号
REM set DORIS_PASS=密码

REM set APP_PORT=5050
REM set FLASK_DEBUG=1

.venv\Scripts\python.exe app.py
pause
