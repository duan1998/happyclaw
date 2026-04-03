@echo off
chcp 65001 >nul
cd /d "%~dp0"

taskkill /F /IM "HappyClaw.exe" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

node dist/index.js
