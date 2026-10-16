@echo off
cd /d "%~dp0.."
node tests\terminal-live.mjs > .local\terminal-live.log 2>&1 < nul
echo %errorlevel% > .local\terminal-live.exit
