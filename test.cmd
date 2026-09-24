@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
call npm.cmd run build
if errorlevel 1 goto :end
call npm.cmd test
if errorlevel 1 goto :end
call npm.cmd run test:e2e
if errorlevel 1 goto :end
call npm.cmd run test:cli:tty
if errorlevel 1 goto :end
call npm.cmd run build:cli
if errorlevel 1 goto :end
call npm.cmd run test:cli:install
:end
pause
