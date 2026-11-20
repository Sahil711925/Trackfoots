@echo off
title WITNESS - demo server
set "PATH=%LOCALAPPDATA%\hermes\tools\node-26.7.0-win32-x64;%PATH%"
cd /d "%~dp0"
echo.
echo   Starting WITNESS...
echo   Leave this window open. Closing it stops the demo.
echo.
start "" http://localhost:5173
node scripts/demo-up.js
echo.
echo   Server stopped.
pause
