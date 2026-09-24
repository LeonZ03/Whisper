@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Whisper - Local encrypted chat
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 goto :failed
)
call npm.cmd run build
if errorlevel 1 goto :failed
node --no-warnings scripts\launch.mjs %*
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo Whisper did not start successfully. See the error above.
pause
exit /b 1
