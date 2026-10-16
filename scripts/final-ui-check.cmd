@echo off
cd /d "%~dp0.."
call scripts\format-check.cmd
node tests\terminal-live.mjs > .local\terminal-live.log 2>&1 < nul
echo %errorlevel% > .local\terminal-live.exit
