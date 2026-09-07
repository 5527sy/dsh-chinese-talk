@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Windows PowerShell was not found on PATH.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bridge.ps1" %*

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
    echo.
    echo [INFO] Bridge exited with code %EXITCODE%.
    pause
)
exit /b %EXITCODE%
