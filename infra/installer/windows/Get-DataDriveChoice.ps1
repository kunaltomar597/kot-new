#Requires -Version 5.1
<#
.SYNOPSIS
    The drives that can hold the data and the default one, as JSON, for the installer's
    data-drive page (ONB-002, P0-16d).

.DESCRIPTION
    Prints Get-RPDataDriveChoice's answer: MinFreeGB, Default ('D:'), DataDir, Warning
    (SYSTEM_DRIVE, NO_DRIVE or null), DataFoundOn and Drives, each with Letter, Label,
    FileSystem, FreeGB, SizeGB, System, HasData, Eligible and Reason (NETWORK, REMOVABLE,
    NOT_A_DISK, FILE_SYSTEM, TOO_LITTLE_SPACE or null).

    With -IniFile it also writes the answer as an INI file for the installer's page, which reads
    it with NSIS's ReadINIStr (ConvertTo-RPDriveChoiceIni).
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 100000)] [int] $MinFreeGB = 20,
    [string] $IniFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force
$choice = Get-RPDataDriveChoice -Volume @(Get-RPVolume) -SystemDrive $env:SystemDrive -MinFreeGB $MinFreeGB
if ($IniFile) {
    # UTF-16 with a byte order mark, which Windows' INI functions read: drive labels may not be ASCII.
    Set-Content -LiteralPath $IniFile -Value (ConvertTo-RPDriveChoiceIni -Choice $choice) -Encoding Unicode
}
$choice | ConvertTo-Json -Depth 4
