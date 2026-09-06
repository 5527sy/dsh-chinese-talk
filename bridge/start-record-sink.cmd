@echo off
rem 启动 V1 录音落盘服务（record-sink, http://127.0.0.1:8766/api/health）
rem 输出目录：默认 <工作区>\vocal\master，可用 DSH_VOCAL_DIR 覆盖。
rem 以下环境变量指向本机真实依赖（代码内已改为相对路径，机器级路径在此配置）：
setlocal
set "PY=%~dp0..\venv-speech\Scripts\python.exe"
if not exist "%PY%" (
  echo [record-sink] venv python not found: "%PY%"
  exit /b 1
)
set "FFMPEG_BIN=D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe"
set "FFPLAY_BIN=D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffplay.exe"
set "FUNASR_DIR=D:\models\funasr\speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
"%PY%" -m uvicorn record_sink:app --app-dir "%~dp0." --host 127.0.0.1 --port 8766
