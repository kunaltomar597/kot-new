#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the Restaurant Platform services again when an update could not replace the files
    (P0-16d).

.DESCRIPTION
    Run by the installer as an administrator after Stop-RestaurantPlatform.ps1, when the old
    version's files could not be removed: the old version carries on. Starts the database, the
    server and the watchdog (those that are installed) and lifts the maintenance flag. See
    docs/runbooks/windows-installer.md.

    Exit codes: 0 done, 1 failed (see the log).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InstallDir,
    [string] $InstallationFile,
    [string] $LogFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force

if (-not $InstallationFile) { $InstallationFile = Get-RPDefaultInstallationFile }
if (-not $LogFile) {
    $LogFile = Join-RPPath (Split-Path -Parent $InstallationFile) 'setup-logs', ('start-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
Start-RPLog -Path $LogFile
try {
    $result = Invoke-RPStart -InstallDir $InstallDir -InstallationFile $InstallationFile
    Write-RPLog ('Started: {0}.' -f ($result.Started -join ', '))
    exit 0
} catch {
    Write-RPLog ('Starting the services failed: {0}' -f $_)
    exit (Get-RPExitCode -ErrorRecord $_)
}
