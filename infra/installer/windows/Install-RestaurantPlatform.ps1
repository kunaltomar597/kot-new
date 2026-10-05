#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or repairs the Restaurant Platform services on this PC (ONB-001, NFR-I02, P0-16c).

.DESCRIPTION
    Run by the installer (P0-16d) as an administrator, after it has copied the software into
    InstallDir. When the installation file exists already this is a repair: the data stays where
    it is and every step runs again. It also registers the updater's scheduled task and keeps the
    installer for going back after a failed update (P7-04c). See docs/runbooks/windows-installer.md.

    Exit codes: 0 done, 1 failed (see the log).

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-RestaurantPlatform.ps1 `
        -InstallDir 'C:\Program Files\Restaurant Platform' -ProductVersion 1.0.0 -DataDir D:\RestaurantPlatform
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InstallDir,
    # The data folder (ONB-002); without one, the default drive's. Repair keeps the existing one.
    [string] $DataDir,
    [string] $ProductVersion,
    [ValidateRange(1, 65535)] [int] $Port,
    [ValidateRange(1, 65535)] [int] $MqttPort,
    [ValidateRange(1, 65535)] [int] $PgPort,
    # The staff network, e.g. 192.168.10.0/24 (SEC-008); without one, the PC's own networks.
    # Several are given with commas.
    [string[]] $StaffSubnet,
    [string[]] $TlsHostnames,
    [string] $ControlPlaneUrl,
    [string] $RelayUrl,
    [string] $QrSiteUrl,
    [string] $ErrorDsn,
    [ValidateRange(1, 100000)] [int] $MinFreeGB = 20,
    # The installer itself, kept to go back to after a failed update (P7-04c).
    [string] $InstallerPath,
    # UPD-007: the Authenticode signer updates must carry (the code-signing certificate's subject).
    [string] $UpdatePublisher,
    # A test build only: updates may be unsigned.
    [switch] $AllowUnsignedUpdates,
    [string] $InstallationFile,
    [string] $LogFile
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RestaurantPlatform.Setup.psm1') -Force

$arguments = @{}
foreach ($key in $PSBoundParameters.Keys) {
    if ($key -ne 'LogFile') { $arguments[$key] = $PSBoundParameters[$key] }
}
# The installer passes lists as one argument ('-StaffSubnet 192.168.10.0/24,192.168.11.0/24').
foreach ($key in @('StaffSubnet', 'TlsHostnames')) {
    if ($arguments.ContainsKey($key)) { $arguments[$key] = @(ConvertTo-RPList -Value $arguments[$key]) }
}
if (-not $InstallationFile) { $arguments.InstallationFile = Get-RPDefaultInstallationFile }
if (-not $LogFile) {
    $LogFile = Join-RPPath (Split-Path -Parent $arguments.InstallationFile) 'setup-logs', ('install-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
Start-RPLog -Path $LogFile
try {
    $result = Invoke-RPInstall @arguments
    Write-RPLog ('Data folder: {0}; port {1}; pagers {2}.' -f $result.DataDir, $result.Port, $result.MqttPort)
    exit 0
} catch {
    Write-RPLog ('The set-up failed: {0}' -f $_)
    exit (Get-RPExitCode -ErrorRecord $_)
}
