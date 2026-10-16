@echo off
git clone --depth 1 --branch v1.24.0 https://github.com/example/external-engine.git D:\GITHUB\external-engine > D:\PROJECTS\Naru\evidence\clone.log 2>&1
echo %errorlevel% > D:\PROJECTS\Naru\evidence\clone.exit
call rea inspect-artifact "C:\Program Files\External Engine\resources\app.asar" --format json > D:\PROJECTS\Naru\evidence\asar.json 2> D:\PROJECTS\Naru\evidence\asar.err
echo %errorlevel% > D:\PROJECTS\Naru\evidence\asar.exit
call rea inspect-pe-resources "C:\Program Files\External Engine\External Engine.exe" --max-file-bytes 300000000 --format json > D:\PROJECTS\Naru\evidence\pe.json 2> D:\PROJECTS\Naru\evidence\pe.err
echo %errorlevel% > D:\PROJECTS\Naru\evidence\pe.exit
