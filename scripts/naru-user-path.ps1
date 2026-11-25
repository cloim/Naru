# Adds a folder to the end of the user PATH. The registry value is edited unexpanded and keeps its type,
# so entries like %USERPROFILE%\bin survive. Prints "present" or "added".
# Input (environment): NARU_BIN, the folder.
$ErrorActionPreference = 'Stop'
$dir = $env:NARU_BIN
if (-not $dir) { throw 'NARU_BIN is required.' }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$names = $key.GetValueNames()
$current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($current -split ';' | Where-Object { $_ })
if ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }) { 'present'; exit }
$kind = if ($names -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
$key.SetValue('Path', (($parts + $dir) -join ';'), $kind)
# Setting any user variable broadcasts WM_SETTINGCHANGE, so new terminals see the PATH at once.
[Environment]::SetEnvironmentVariable('NARU_PATH_REFRESH', $null, 'User')
'added'
