@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org 安装 Node.js LTS，然后重新打开此文件。
) else (
  node scripts\install-xjtlu.mjs
)
echo.
pause
