@echo off
title TRACKFOOTS - demo server
set "PATH=%LOCALAPPDATA%\hermes\tools\node-26.7.0-win32-x64;%PATH%"
cd /d "%~dp0"
echo.
echo   Starting TRACKFOOTS...
echo   Leave this window open. Closing it stops the demo.
echo   Landing:    http://localhost:5173
echo   Dashboard:  http://localhost:5173/app
echo   Public:     http://localhost:5173/status
echo.
start "" http://localhost:5173
node scripts/demo-up.js
echo.
echo   Server stopped.
pause
