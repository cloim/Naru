# Starts a process outside Naru's process tree and job object, so it survives a server restart.
# WMI creates it, hidden. Prints the new process id.
# Input (environment): NARU_DETACH_LINE, the full command line; NARU_DETACH_DIR, its working folder.
# NARU_DETACH_DRY_RUN prints both values instead (tests check they arrive unchanged).
$ErrorActionPreference = 'Stop'
$line = $env:NARU_DETACH_LINE
$dir = $env:NARU_DETACH_DIR
if (-not $line -or -not $dir) { throw 'NARU_DETACH_LINE and NARU_DETACH_DIR are required.' }
if ($env:NARU_DETACH_DRY_RUN) {
    $line
    $dir
    exit 0
}
$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{ ShowWindow = [uint16]0 } -ClientOnly
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $line
    CurrentDirectory = $dir
    ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw "WMI process creation failed: $($result.ReturnValue)" }
$result.ProcessId
