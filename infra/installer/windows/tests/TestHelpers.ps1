# Dot-sourced by every test file's BeforeAll: the module, and builders for its inputs.

$script:ModuleName = 'RestaurantPlatform.Setup'
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'RestaurantPlatform.Setup.psm1') -Force

function New-TestVolume {
    <# A drive as Get-RPVolume describes it: a local NTFS disk unless told otherwise. #>
    param(
        [Parameter(Mandatory, Position = 0)] [string] $Letter,
        [int] $DriveType = 3,
        $BusType = 'SATA',
        [string] $FileSystem = 'NTFS',
        [double] $FreeGB = 100,
        [double] $FreeBytes = -1,
        [double] $SizeGB = 256,
        [string] $Label = '',
        [bool] $HasData = $false
    )
    if ($FreeBytes -lt 0) { $FreeBytes = $FreeGB * 1GB }
    [pscustomobject]@{
        Letter     = $Letter
        DriveType  = $DriveType
        BusType    = $BusType
        FileSystem = $FileSystem
        FreeBytes  = $FreeBytes
        SizeBytes  = $SizeGB * 1GB
        Label      = $Label
        HasData    = $HasData
    }
}

function New-TestPaths {
    <# What `setup-cli paths` prints for an installation. #>
    param(
        [string] $InstallDir = 'C:\Program Files\Restaurant Platform',
        [string] $DataDir = 'D:\RestaurantPlatform',
        [string] $ProgramDataDir = 'C:\ProgramData\RestaurantPlatform'
    )
    [pscustomobject]@{
        installationFile = "$ProgramDataDir\installation.json"
        programDataDir   = $ProgramDataDir
        installDir       = $InstallDir
        dataDir          = $DataDir
        setupCli         = "$InstallDir\server\dist\installation\setup-cli.js"
        node             = "$InstallDir\node\node.exe"
        serverDir        = "$InstallDir\server"
        consoleDir       = "$InstallDir\console"
        pgBin            = "$InstallDir\postgres\bin"
        pgData           = "$DataDir\postgres"
        servicesDir      = "$InstallDir\services"
        logsDir          = "$DataDir\logs"
        runDir           = "$DataDir\run"
        secretsDir       = "$DataDir\secrets"
        tlsDir           = "$DataDir\tls"
        backupsDir       = "$DataDir\backups"
        walStaging       = "$DataDir\backups\wal-staging"
        ports            = [pscustomobject]@{ server = 8080; mqtt = 8883; postgres = 5432 }
        services         = [pscustomobject]@{ database = 'RPDatabase'; server = 'RPServer'; watchdog = 'RPWatchdog' }
    }
}

function New-TestResult {
    param([int] $ExitCode = 0, [string] $Output = '')
    [pscustomobject]@{ ExitCode = $ExitCode; Output = $Output }
}
