#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the Restaurant Platform services before the installer replaces the software's files
    (an update or a repair, P0-16d).

.DESCRIPTION
    Run by the installer as an administrator, before it copies the new files: sets the
    maintenance flag, then stops the watchdog, the server and the database. Nothing to do on a PC
    without an installation. Install-RestaurantPlatform.ps1 starts them again after the copy; if
    the copy cannot go ahead, the installer runs Start-RestaurantPlatform.ps1. See
    docs/runbooks/windows-installer.md.

    Exit codes: 0 done, 1 failed (see the log).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InstallDir,
    [string] $Reason = 'update',
    [string] $InstallationFile,
    [string] $LogFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force

if (-not $InstallationFile) { $InstallationFile = Get-RPDefaultInstallationFile }
if (-not $LogFile) {
    $LogFile = Join-RPPath (Split-Path -Parent $InstallationFile) 'setup-logs', ('stop-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
Start-RPLog -Path $LogFile
try {
    $null = Invoke-RPStop -InstallDir $InstallDir -InstallationFile $InstallationFile -Reason $Reason
    exit 0
} catch {
    Write-RPLog ('Stopping the services failed: {0}' -f $_)
    exit (Get-RPExitCode -ErrorRecord $_)
}
