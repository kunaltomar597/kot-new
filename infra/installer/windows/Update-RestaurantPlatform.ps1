#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the update the restaurant's server downloaded and checked, and goes back to the
    previous version when the new one fails its health check (UPD-005, UPD-007, P7-04c).

.DESCRIPTION
    The updater's scheduled task (\RestaurantPlatform\Update) runs this as SYSTEM from
    ProgramData\RestaurantPlatform\updater, where only administrators may change it. The RPWatchdog
    service starts the task when the server leaves an update request in <data>\run; the server's
    own account cannot install software. Nothing to do when there is no request.

    The outcome goes to <data>\run\update-outcome.json, which the server reports to the vendor,
    and the log to ProgramData\RestaurantPlatform\setup-logs\update-<time>.log. See
    docs/runbooks/software-updates.md.

    Exit codes: 0 the update ran (see the outcome) or there was none, 1 the updater itself failed.

.PARAMETER ForceHealthCheckFailure
    Scenario S9 in CI only: the new version's health check fails on purpose, to show the
    rollback. Never used on a restaurant's PC.
#>
[CmdletBinding()]
param(
    [string] $InstallationFile,
    [switch] $ForceHealthCheckFailure,
    [ValidateRange(30, 3600)] [int] $HealthTimeoutSeconds = 600,
    [ValidateRange(0, 3600)] [int] $StableSeconds = 120,
    [string] $LogFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force

if (-not $InstallationFile) { $InstallationFile = Get-RPDefaultInstallationFile }
if (-not $LogFile) {
    $LogFile = Join-RPPath (Split-Path -Parent $InstallationFile) 'setup-logs', ('update-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
Start-RPLog -Path $LogFile
try {
    $arguments = @{
        InstallationFile        = $InstallationFile
        ForceHealthCheckFailure = $ForceHealthCheckFailure
        HealthTimeoutSeconds    = $HealthTimeoutSeconds
        StableSeconds           = $StableSeconds
        LogFile                 = $LogFile
    }
    $null = Invoke-RPUpdate @arguments
    exit 0
} catch {
    Write-RPLog ('The updater failed: {0}' -f $_)
    exit 1
}
