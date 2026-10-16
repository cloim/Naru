@echo off
cd /d "%~dp0.."
node tests\advanced.mjs > .local\advanced-check.log 2>&1 < nul
echo %errorlevel% > .local\advanced-check.exit
