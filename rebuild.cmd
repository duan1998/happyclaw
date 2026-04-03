@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/5] Stopping running processes...
taskkill /F /IM "HappyClaw.exe" >nul 2>&1
timeout /t 1 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [2/5] Building backend...
call npx tsc
if errorlevel 1 (
    echo Backend build failed!
    pause
    exit /b 1
)

echo [3/5] Building frontend...
cd web
call npx tsc && call npx vite build
if errorlevel 1 (
    echo Frontend build failed!
    pause
    exit /b 1
)
cd ..

echo [4/5] Building agent-runner...
cd container\agent-runner
call npx tsc
if errorlevel 1 (
    echo Agent-runner build failed!
    pause
    exit /b 1
)
cd ..\..

echo [5/5] Starting backend...
start "HappyClaw" node dist/index.js

echo Done! Backend is running on port 3000.
