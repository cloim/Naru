@echo off
cd /d "%~dp0.."
node tests\integration.mjs > .local\integration.log 2>&1 < nul
echo %errorlevel% > .local\integration.exit
