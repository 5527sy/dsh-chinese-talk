@echo off
rem 启动 V1 录音落盘服务（record-sink, http://127.0.0.1:8766/api/health）
rem 输出目录：默认 <项目根的上一级>\vocal\master，可用 DSH_VOCAL_DIR 覆盖。
setlocal
set "PY=%~dp0..\venv-speech\Scripts\python.exe"
if not exist "%PY%" (
  echo [record-sink] venv python not found: "%PY%"
  exit /b 1
)
"%PY%" -m uvicorn record_sink:app --app-dir "%~dp0." --host 127.0.0.1 --port 8766
