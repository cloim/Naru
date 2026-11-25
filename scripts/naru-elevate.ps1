# Runs a batch file with administrator rights, hidden: Windows asks for consent. Returns once it has started.
# Input (environment): NARU_BATCH, the batch file's full path.
$ErrorActionPreference = 'Stop'
$batch = $env:NARU_BATCH
if (-not $batch) { throw 'NARU_BATCH is required.' }
$cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
Start-Process -FilePath $cmd -ArgumentList '/d', '/c', "`"$batch`"" -Verb RunAs -WindowStyle Hidden
