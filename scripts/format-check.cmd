@echo off
cd /d "%~dp0.."
call npx --no-install prettier --write src server tests public/extension-sdk.js vite.config.js > .local\format.log 2>&1 < nul
echo %errorlevel% > .local\format.exit
call scripts\check.cmd
