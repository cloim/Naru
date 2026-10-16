@echo off
set "NARU_WORKER_DATA=%LOCALAPPDATA%\Naru"
if defined NARU_DATA_DIR set "NARU_WORKER_DATA=%NARU_DATA_DIR%"
"%~2" "%~dp0..\server\worker.js" "%~1" > "%NARU_WORKER_DATA%\jobs\%~1.worker.log" 2>&1 < nul
