@echo off
cd /d "%~dp0.."
node tests\extensions.mjs > .local\extensions-check.log 2>&1 < nul
echo %errorlevel% > .local\extensions-check.exit
