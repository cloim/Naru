@echo off
cd /d "%~dp0.."
if not exist .local mkdir .local
node server\index.js > .local\server.log 2>&1 < nul
echo %errorlevel% > .local\server.exit
