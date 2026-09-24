@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  exit /b 1
)
if not exist "node_modules\string-width\package.json" (
  echo Installing project dependencies...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
node --no-warnings cli\index.mjs %*
exit /b %errorlevel%
