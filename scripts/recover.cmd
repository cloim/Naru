@echo off
cd /d "%~dp0.."
python scripts\extract-analysis.py > evidence\extracted.log 2>&1 < nul
call rea recover-javascript-sources D:\PROJECTS\Naru\evidence\shipped\background.js D:\PROJECTS\Naru\evidence\recovered --format json > evidence\recovery.json 2> evidence\recovery.err < nul
echo %errorlevel% > evidence\recovery.exit
