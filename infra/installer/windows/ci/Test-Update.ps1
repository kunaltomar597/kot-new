#Requires -Version 7.0
<#
.SYNOPSIS
    Scenario S9 on a Windows runner (P7-04c, UPD-005, CI job "Windows installer"): an update whose
    health check fails is rolled back, application and database, and the restaurant keeps
    working; then a good update installs through the watchdog and the updater's scheduled task.
    Never run it on a restaurant's PC: it uninstalls at the end.

.DESCRIPTION
    1. A silent install of Installer: the updater's task is registered and the installer kept.
    2. S9: an update request for NextInstaller, run by the updater with -ForceHealthCheckFailure.
       The outcome is ROLLED_BACK; the first version runs again with the database copied before
       the update (the failed one is kept as restaurant_failed_update); the server answers.
    3. The same update asked for again and left to the watchdog: it starts the task (SYSTEM),
       which installs NextInstaller; the outcome is INSTALLED and the new version answers.
    4. Uninstalling removes the task.
    The request is written here as the server writes it once it has downloaded and checked the
    installer and made the backup (apps/server src/updates); the server's part is tested on its
    own. The logs and outcome files are copied to ResultDir, also when a check fails.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Installer,
    [Parameter(Mandatory)] [string] $NextInstaller,
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'Restaurant Platform'),
    [string] $ResultDir = 'installer-results',
    [int] $UpdateMinutes = 20
)
$ErrorActionPreference = 'Stop'
$programData = Join-Path $env:ProgramData 'RestaurantPlatform'
$installationFile = Join-Path $programData 'installation.json'
$updater = Join-Path $programData 'updater\Update-RestaurantPlatform.ps1'
# The updater writes its outcome where only administrators write; the server reads it there.
$outcomeFile = Join-Path $programData 'update-outcome.json'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
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

function Get-Installation { Get-Content -LiteralPath $installationFile -Raw | ConvertFrom-Json }

function Get-Health {
    $node = Join-Path $InstallDir 'node\node.exe'
    $cli = Join-Path $InstallDir 'server\dist\installation\setup-cli.js'
    $output = & $node $cli health | Out-String
    [pscustomobject]@{ Code = $LASTEXITCODE; Report = ($output | ConvertFrom-Json) }
}

function Wait-Until([scriptblock] $Condition, [int] $Seconds) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Read-Json([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json } catch { return $null }
}

function Request-Update([string] $DataDir, [string] $Version, [string] $Previous) {
    <# What the server's update agent leaves for the updater (UpdateRequestFile). #>
    $updates = Join-Path $DataDir 'updates'
    New-Item -ItemType Directory -Force -Path $updates | Out-Null
    $fileName = 'RestaurantPlatform-Setup-{0}.exe' -f $Version
    Copy-Item -LiteralPath $NextInstaller -Destination (Join-Path $updates $fileName) -Force
    $requestId = [guid]::NewGuid().ToString()
    $request = [ordered]@{
        format            = 1
        requestId         = $requestId
        version           = $Version
        previousVersion   = $Previous
        fileName          = $fileName
        sha256            = (Get-FileHash -LiteralPath $NextInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes         = (Get-Item -LiteralPath $NextInstaller).Length
        securityCritical  = $false
        trigger           = 'APPROVED'
        approvedByStaffId = $null
        backupFileName    = $null
        requestedAt       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
    $path = Join-Path $DataDir 'run\update-request.json'
    [IO.File]::WriteAllText($path, ($request | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    $requestId
}

function Save-Logs([string] $DataDir) {
    $logs = Join-Path $programData 'setup-logs'
    if (Test-Path $logs) { Copy-Item -Recurse -Force $logs (Join-Path $ResultDir 'update-setup-logs') }
    if (Test-Path $outcomeFile) { Copy-Item -Force $outcomeFile (Join-Path $ResultDir 's9-update-outcome.json') }
    if ($DataDir) {
        $path = Join-Path $DataDir 'backups\update-rollback-outcome.json'
        if (Test-Path $path) { Copy-Item -Force $path (Join-Path $ResultDir 's9-update-rollback-outcome.json') }
        if (Test-Path (Join-Path $DataDir 'logs')) { Copy-Item -Recurse -Force (Join-Path $DataDir 'logs') (Join-Path $ResultDir 'update-data-logs') }
    }
}

$dataDir = $null
try {
    Write-Step 'A silent install keeps its installer and registers the updater'
    $code = Invoke-Program $Installer @('/S')
    Assert-That ($code -eq 0) ('the installer ends with 0 (it ended with {0})' -f $code)
    $installation = Get-Installation
    $dataDir = $installation.dataDir
    $first = [string]$installation.productVersion
    $next = ([regex]::Match((Split-Path -Leaf $NextInstaller), 'Setup-(.+)\.exe$')).Groups[1].Value
    Write-Host ('   from {0} to {1}; data in {2}' -f $first, $next, $dataDir)
    Assert-That (Wait-Until { (Get-Health).Code -eq 0 } 120) 'the server is healthy'
    Assert-That ($null -ne (Get-ScheduledTask -TaskPath '\RestaurantPlatform\' -TaskName 'Update' -ErrorAction SilentlyContinue)) 'the updater''s task is registered'
    Assert-That (Test-Path (Join-Path $programData ('installers\RestaurantPlatform-Setup-{0}.exe' -f $first))) 'the installer is kept to go back to'
    Assert-That (Test-Path $updater) 'the updater is in ProgramData'

    Write-Step 'S9: an update that fails its health check is rolled back'
    # This run starts the updater itself (with the forced failure), so the watchdog must not start
    # the task for the same request; the updater stops the watchdog anyway, and the installer of
    # the version it goes back to starts it again.
    Stop-Service -Name 'RPWatchdog'
    $requestId = Request-Update -DataDir $dataDir -Version $next -Previous $first
    $code = Invoke-Program $windowsPowerShell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $updater), '-ForceHealthCheckFailure', '-StableSeconds', '20')
    Assert-That ($code -eq 0) ('the updater ends with 0 (it ended with {0})' -f $code)
    $outcome = Read-Json $outcomeFile
    Assert-That ($null -ne $outcome -and $outcome.requestId -eq $requestId) 'the updater wrote the outcome of this request'
    Write-Host ('   outcome: {0}: {1}' -f $outcome.outcome, $outcome.error)
    Assert-That ($outcome.outcome -eq 'ROLLED_BACK') 'the update was rolled back'
    Assert-That ((Get-Installation).productVersion -eq $first) ('version {0} is installed again' -f $first)
    $rollback = Read-Json (Join-Path $dataDir 'backups\update-rollback-outcome.json')
    Assert-That ($null -ne $rollback -and $rollback.ok -eq $true) 'the database from before the update is back'
    Assert-That ($rollback.failedDatabase -eq 'restaurant_failed_update') 'the failed version''s database is kept for support'
    $health = Get-Health
    Assert-That ($health.Code -eq 0 -and $health.Report.productVersion -eq $first) 'the restaurant keeps working on the first version'
    Assert-That ((Get-Service -Name 'RPWatchdog').Status -eq 'Running') 'the watchdog runs again'
    Assert-That (-not (Test-Path (Join-Path $programData 'update-rollback.json'))) 'the rollback request was used once'
    # The watchdog sees the request still there, but the updater took it: nothing runs again.
    Start-Sleep -Seconds 20
    Assert-That ((Read-Json $outcomeFile).outcome -eq 'ROLLED_BACK') 'the request is not run a second time'
    # The server removes a request once it has recorded the outcome.
    Remove-Item -LiteralPath (Join-Path $dataDir 'run\update-request.json') -Force

    Write-Step 'A good update installs through the watchdog and the updater''s task'
    $requestId = Request-Update -DataDir $dataDir -Version $next -Previous $first
    $done = Wait-Until {
        $seen = Read-Json $outcomeFile
        $null -ne $seen -and $seen.requestId -eq $requestId -and $seen.outcome -ne 'RUNNING'
    } ($UpdateMinutes * 60)
    Assert-That $done ('the updater reported within {0} minutes' -f $UpdateMinutes)
    $outcome = Read-Json $outcomeFile
    Write-Host ('   outcome: {0}: {1}' -f $outcome.outcome, $outcome.error)
    Assert-That ($outcome.outcome -eq 'INSTALLED') 'the update installed'
    Assert-That ((Get-Installation).productVersion -eq $next) ('version {0} is installed' -f $next)
    $health = Get-Health
    Assert-That ($health.Code -eq 0 -and $health.Report.productVersion -eq $next) 'the new version is healthy'
    foreach ($version in @($first, $next)) {
        Assert-That (Test-Path (Join-Path $programData ('installers\RestaurantPlatform-Setup-{0}.exe' -f $version))) ('the installer of {0} is kept' -f $version)
    }

    Write-Step 'Uninstalling removes the updater'
    $code = Invoke-Program $uninstaller @('/S', "_?=$InstallDir")
    Assert-That ($code -eq 0) ('the uninstaller ends with 0 (it ended with {0})' -f $code)
    Assert-That ($null -eq (Get-ScheduledTask -TaskPath '\RestaurantPlatform\' -TaskName 'Update' -ErrorAction SilentlyContinue)) 'the updater''s task is removed'
    Write-Host 'All update checks passed.'
} finally {
    Save-Logs -DataDir $dataDir
}
