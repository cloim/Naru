@echo off
cd /d "%~dp0.."
node tests\tools-and-live-ui.mjs > .local\live-ui-check.log 2>&1 < nul
echo %errorlevel% > .local\live-ui-check.exit
