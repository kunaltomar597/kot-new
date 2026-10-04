#Requires -Version 7.0
<#
.SYNOPSIS
    Installs the built installer silently on a Windows runner and checks the result (P0-16d, CI
    job "Windows installer"). Never run it on a restaurant's PC: it uninstalls at the end.

.DESCRIPTION
    1. A silent install: the three services run and start at boot, the server answers, the
       firewall rules exist (ONB-001, SEC-008).
    2. The server process is ended: it answers again within 10 seconds (NFR-A04).
    3. The installer is run again: it repairs, keeping the data folder (NFR-I02).
    4. Uninstalling with /DELETEDATA without the Owner's permission changes nothing.
    5. Uninstalling keeps the data; installing again carries on with it; a last uninstall.
    The logs are copied to ResultDir, also when a check fails.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Installer,
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'Restaurant Platform'),
    [string] $ResultDir = 'installer-results',
    [int] $RecoverySeconds = 10
)
$ErrorActionPreference = 'Stop'
$services = @('RPDatabase', 'RPServer', 'RPWatchdog')
$installationFile = Join-Path $env:ProgramData 'RestaurantPlatform\installation.json'
$uninstaller = Join-Path $InstallDir 'Uninstall Restaurant Platform.exe'
New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null

function Write-Step([string] $Message) { Write-Host ('== {0}' -f $Message) }

function Assert-That([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw ('Check failed: {0}' -f $Message) }
    Write-Host ('   ok: {0}' -f $Message)
}

function Invoke-Program([string] $Path, [string[]] $Arguments) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
    $process.ExitCode
}

function Invoke-Uninstaller([string[]] $Arguments) {
    # _?= runs the uninstaller in place, so this waits for it and gets its exit code.
    Invoke-Program $uninstaller ($Arguments + @("_?=$InstallDir"))
}

function Get-Installation { Get-Content -LiteralPath $installationFile -Raw | ConvertFrom-Json }

function Get-HostStatus {
    $node = Join-Path $InstallDir 'node\node.exe'
    $cli = Join-Path $InstallDir 'server\dist\installation\setup-cli.js'
    (& $node $cli status | Out-String | ConvertFrom-Json).host
}

function Test-Health([int] $Port) {
    try {
        $response = Invoke-RestMethod -Uri ('https://127.0.0.1:{0}/api/v1/health' -f $Port) -SkipCertificateCheck -TimeoutSec 2
        return $response.status -eq 'ok'
    } catch {
        return $false
    }
}

function Wait-Until([scriptblock] $Condition, [int] $Seconds) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
        if (& $Condition) { return $clock.Elapsed.TotalSeconds }
        Start-Sleep -Milliseconds 250
    }
    return $null
}

function Assert-Running {
    foreach ($name in $services) {
        $service = Get-Service -Name $name
        Assert-That ($service.Status -eq 'Running') ('{0} runs' -f $name)
        Assert-That ($service.StartType -eq 'Automatic') ('{0} starts at boot' -f $name)
    }
}

function Save-Logs {
    $logs = Join-Path $env:ProgramData 'RestaurantPlatform\setup-logs'
    if (Test-Path $logs) { Copy-Item -Recurse -Force $logs (Join-Path $ResultDir 'setup-logs') }
    Get-ChildItem -Path $env:TEMP -Filter 'RestaurantPlatform-uninstall-*.log' -ErrorAction SilentlyContinue |
        Copy-Item -Destination $ResultDir
    if ($script:DataDir -and (Test-Path (Join-Path $script:DataDir 'logs'))) {
        Copy-Item -Recurse -Force (Join-Path $script:DataDir 'logs') (Join-Path $ResultDir 'data-logs')
    }
    if (Test-Path $installationFile) { Copy-Item -Force $installationFile $ResultDir }
}

$script:DataDir = $null
try {
    Write-Step 'A silent install'
    $code = Invoke-Program $Installer @('/S')
    Assert-That ($code -eq 0) ('the installer ends with 0 (it ended with {0})' -f $code)
    $installation = Get-Installation
    $script:DataDir = $installation.dataDir
    $port = [int]$installation.server.port
    Write-Host ('   data folder: {0}; port {1}' -f $script:DataDir, $port)
    Assert-Running
    Assert-That ((Get-HostStatus).phase -eq 'RUNNING') 'the service host says the server runs'
    Assert-That ($null -ne (Wait-Until { Test-Health $port } 60)) 'the server answers over HTTPS'
    $rules = @(Get-NetFirewallRule -Group 'Restaurant Platform' -ErrorAction SilentlyContinue)
    Assert-That ($rules.Count -eq 2) 'the firewall admits the server and the pagers'
    Assert-That (Test-Path (Join-Path $InstallDir 'Restaurant Platform.exe')) 'the POS window is installed'

    Write-Step ('The server process ended: back within {0} seconds (NFR-A04)' -f $RecoverySeconds)
    $before = Get-HostStatus
    Stop-Process -Id $before.serverPid -Force
    $elapsed = Wait-Until {
        $now = Get-HostStatus
        ($null -ne $now.serverPid) -and ($now.serverPid -ne $before.serverPid) -and (Test-Health $port)
    } 60
    Assert-That ($null -ne $elapsed) 'the server answers again'
    Write-Host ('   back after {0:N1} s' -f $elapsed)
    Assert-That ($elapsed -le $RecoverySeconds) ('within {0} seconds' -f $RecoverySeconds)
    Assert-That ((Get-HostStatus).restarts -eq $before.restarts + 1) 'the host counted the restart'

    Write-Step 'The installer run again repairs'
    $code = Invoke-Program $Installer @('/S')
    Assert-That ($code -eq 0) ('the repair ends with 0 (it ended with {0})' -f $code)
    Assert-That ((Get-Installation).dataDir -eq $script:DataDir) 'the data stays where it was'
    Assert-Running
    Assert-That ($null -ne (Wait-Until { Test-Health $port } 60)) 'the server answers after the repair'

    Write-Step 'Deleting the data without the Owner''s permission changes nothing (NFR-I02)'
    $code = Invoke-Uninstaller @('/S', '/DELETEDATA')
    Assert-That ($code -ne 0) ('the uninstaller refuses (it ended with {0})' -f $code)
    Assert-That ($null -ne (Get-Service -Name 'RPServer' -ErrorAction SilentlyContinue)) 'the services are still there'
    Assert-That (Test-Path (Join-Path $script:DataDir 'postgres\PG_VERSION')) 'the data is still there'

    Write-Step 'Uninstalling keeps the data'
    $code = Invoke-Uninstaller @('/S')
    Assert-That ($code -eq 0) ('the uninstaller ends with 0 (it ended with {0})' -f $code)
    foreach ($name in $services) {
        Assert-That ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) ('{0} is removed' -f $name)
    }
    Assert-That (@(Get-NetFirewallRule -Group 'Restaurant Platform' -ErrorAction SilentlyContinue).Count -eq 0) 'the firewall rules are removed'
    Assert-That (Test-Path (Join-Path $script:DataDir 'postgres\PG_VERSION')) 'the data is kept'
    Assert-That (Test-Path $installationFile) 'the installation file is kept'

    Write-Step 'Installing again carries on with the kept data'
    $code = Invoke-Program $Installer @('/S')
    Assert-That ($code -eq 0) ('the install ends with 0 (it ended with {0})' -f $code)
    Assert-That ((Get-Installation).dataDir -eq $script:DataDir) 'the same data folder'
    Assert-Running
    Assert-That ($null -ne (Wait-Until { Test-Health $port } 60)) 'the server answers'
    $code = Invoke-Uninstaller @('/S')
    Assert-That ($code -eq 0) 'the last uninstall ends with 0'
    Write-Host 'All checks passed.'
} finally {
    Save-Logs
}
