# Whether the processor could run the Windows hypervisor: virtualization on in the firmware, and SLAT.
# Only meaningful while the hypervisor is off; with it on, Windows hides these flags.
# Prints {"firmware":bool,"slat":bool}.
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance Win32_Processor | Select-Object -First 1
[pscustomobject]@{
    firmware = [bool]$p.VirtualizationFirmwareEnabled
    slat = [bool]$p.SecondLevelAddressTranslationExtensions
} | ConvertTo-Json -Compress
