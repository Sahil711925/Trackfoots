@echo off
title WITNESS - verify against chain
set "PATH=%LOCALAPPDATA%\hermes\tools\node-26.7.0-win32-x64;%PATH%"
cd /d "%~dp0"
node scripts/verify-chain.js
echo.
pause
