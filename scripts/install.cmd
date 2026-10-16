@echo off
cd /d "%~dp0.."
if not exist .local mkdir .local
call npm install > .local\install.log 2>&1 < nul
echo %errorlevel% > .local\install.exit
