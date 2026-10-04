#Requires -Version 5.1
<#
.SYNOPSIS
    Removes the Restaurant Platform services and firewall rules; keeps the data unless the Owner
    allowed deleting it (NFR-I02, P0-16c).

.DESCRIPTION
    Run by the uninstaller (P0-16d) as an administrator, before it removes the program files.
    With -DeleteData the data folder is deleted too, but only while the Owner's permission from the
    System page holds (password and second factor, 30 minutes); otherwise nothing is changed and
    the exit code is 3. See docs/runbooks/windows-installer.md.

    Exit codes: 0 done, 1 failed (see the log), 3 deleting the data was not allowed (nothing
    changed).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InstallDir,
    [switch] $DeleteData,
    [string] $InstallationFile,
    [string] $LogFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force

$arguments = @{ InstallDir = $InstallDir; DeleteData = $DeleteData }
if ($InstallationFile) { $arguments.InstallationFile = $InstallationFile }
if (-not $LogFile) {
    # Not in the data folder or ProgramData, which this may delete.
    $LogFile = Join-RPPath $env:TEMP ('RestaurantPlatform-uninstall-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
Start-RPLog -Path $LogFile
try {
    $result = Invoke-RPUninstall @arguments
    if ($result.DataKept -and $result.DataDir) { Write-RPLog ('The data stays in {0}.' -f $result.DataDir) }
    exit 0
} catch {
    Write-RPLog ('The uninstall stopped: {0}' -f $_)
    exit (Get-RPExitCode -ErrorRecord $_)
}
