# Installs WSL without a distribution, with administrator rights: Windows asks for consent.
# Prints wsl.exe's exit code (3010 means a restart is needed).
$ErrorActionPreference = 'Stop'
$wsl = Join-Path ([Environment]::SystemDirectory) 'wsl.exe'
$p = Start-Process -FilePath $wsl -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru
$p.ExitCode
