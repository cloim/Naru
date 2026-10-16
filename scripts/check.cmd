@echo off
cd /d "%~dp0.."
if not exist .local mkdir .local
call npm run build > .local\build.log 2>&1 < nul
echo %errorlevel% > .local\build.exit
call npm test > .local\test.log 2>&1 < nul
echo %errorlevel% > .local\test.exit
