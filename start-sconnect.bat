@echo off
title sConnector - Local Client
cd /d "%~dp0"
echo ========================================================
echo   sConnector - Secure Remote Desktop and P2P Sync
echo ========================================================
echo.
echo Starting client and connecting to Live Hub...
node index.js
echo.
echo sConnector stopped. Press any key to exit.
pause >nul
