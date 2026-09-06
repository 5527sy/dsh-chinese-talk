@echo off
rem 启动语音桥（需先按 docs/INSTALL.md 建好 venv 并安装依赖）。
rem 用法：在项目根目录执行  bridge\start-bridge.cmd
cd /d "%~dp0.."

if not exist "venv-speech\Scripts\python.exe" (
    echo [ERROR] 未找到 venv-speech。请先执行：
    echo    python -m venv venv-speech
    echo    venv-speech\Scripts\activate
    echo    pip install -r bridge\requirements.txt
    pause
    exit /b 1
)

echo 启动 voice-bridge @ http://127.0.0.1:8765 ...
venv-speech\Scripts\python.exe -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765 --app-dir bridge
