@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Please extract the entire Whisper-CLI folder before running it.
  exit /b 1
)
"%~dp0runtime\node.exe" --no-warnings "%~dp0cli\remote-entry.mjs" %*
exit /b %errorlevel%
