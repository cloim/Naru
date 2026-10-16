@echo off
cd /d "%~dp0.."
call scripts\format-check.cmd
node tests\shared-engine.mjs > .local\shared-engine.log 2>&1 < nul
echo %errorlevel% > .local\shared-engine.exit
