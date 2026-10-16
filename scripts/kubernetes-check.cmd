@echo off
cd /d "%~dp0.."
node tests\kubernetes.mjs > .local\kubernetes-check.log 2>&1 < nul
echo %errorlevel% > .local\kubernetes-check.exit
