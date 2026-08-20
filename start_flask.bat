@echo off
REM ============================================================
REM 后台启动，日志写入 flask_out.log / flask_err.log
REM ============================================================
chcp 65001 >nul
cd /d %~dp0

set OPENBLAS_NUM_THREADS=1
set OMP_NUM_THREADS=1
set PYTHONIOENCODING=utf-8

set LLM_ENABLED=1
set LLM_API_URL=https://aigate-dev.catl.com/v1/chat/completions
set LLM_MODEL=DeepSeek-V4-Flash
set DORIS_ENABLED=1
set DORIS_HOST=172.18.45.7
set DORIS_PORT=19030

start "customer-ops" /b .venv\Scripts\python.exe app.py > flask_out.log 2> flask_err.log
echo 已后台启动，日志见 flask_out.log / flask_err.log
