@echo off
cd /d "%~dp0.."
set NARU_TEST_ENGINE=containerd
node tests\terminal-live.mjs > .local\terminal-containerd.log 2>&1 < nul
echo %errorlevel% > .local\terminal-containerd.exit
