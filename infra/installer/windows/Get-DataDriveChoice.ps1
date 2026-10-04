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
#>
[CmdletBinding()]
param([ValidateRange(1, 100000)] [int] $MinFreeGB = 20)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force
Get-RPDataDriveChoice -Volume @(Get-RPVolume) -SystemDrive $env:SystemDrive -MinFreeGB $MinFreeGB |
    ConvertTo-Json -Depth 4
