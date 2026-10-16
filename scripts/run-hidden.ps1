param([Parameter(Mandatory=$true)][string]$EncodedLine, [Parameter(Mandatory=$true)][string]$Directory)
$CommandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedLine))
$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{ShowWindow=[uint16]0} -ClientOnly
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$CommandLine;CurrentDirectory=$Directory;ProcessStartupInformation=$startup}
if ($result.ReturnValue -ne 0) { throw "WMI process creation failed: $($result.ReturnValue)" }
$result.ProcessId
