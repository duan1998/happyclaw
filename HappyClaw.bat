@echo off
chcp 65001 >nul 2>&1
title HappyClaw

:: Resolve script directory (where this bat lives)
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Detect Node.js: prefer bundled portable node, fall back to system node
if exist "%SCRIPT_DIR%node\node.exe" (
    set "NODE=%SCRIPT_DIR%node\node.exe"
) else (
    where node >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Node.js not found. Place portable node.exe in the "node" subfolder, or install Node.js.
        pause
        exit /b 1
    )
    set "NODE=node"
)

set "PORT=3000"

:: Kill existing process on port if any
echo [HappyClaw] Checking port %PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
    echo [HappyClaw] Killing existing process PID %%a on port %PORT%...
    taskkill /F /PID %%a >nul 2>&1
)

:: Start the service in background
echo [HappyClaw] Starting service...
start "" /B "%NODE%" dist\index.js

:: Wait for port to be ready (up to 15 seconds)
set /a TRIES=0
:waitloop
if %TRIES% GEQ 30 (
    echo [ERROR] Service did not start within 15 seconds.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
netstat -aon | findstr "LISTENING" | findstr ":%PORT% " >nul 2>&1
if errorlevel 1 (
    set /a TRIES+=1
    goto waitloop
)

echo [HappyClaw] Service ready on port %PORT%.
echo [HappyClaw] Opening browser...
start http://127.0.0.1:%PORT%

echo.
echo ========================================
echo   HappyClaw is running.
echo   Close this window to stop the service.
echo ========================================
echo.

:: Keep window open; when user closes it, child node process also terminates
cmd /k "echo Press Ctrl+C or close this window to stop."
