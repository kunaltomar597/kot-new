#Requires -Version 5.1
<#
.SYNOPSIS
    The Restaurant Platform's Windows set-up: data drive, permissions, services, firewall, repair
    and uninstall (ONB-001, ONB-002, NFR-I02, SEC-008, P0-16c).

.DESCRIPTION
    The installer (P0-16d) runs Install-RestaurantPlatform.ps1 and Uninstall-RestaurantPlatform.ps1,
    which call Invoke-RPInstall and Invoke-RPUninstall here. They drive the server's set-up tool
    (setup-cli, P0-16b) and do what only Windows can: folder permissions, the services' accounts and
    recovery, and the firewall.

    The logic is in functions that take their inputs as data, so the Pester tests run them on any
    PC. Everything that touches Windows goes through a few small functions (Invoke-RPProgram,
    Get-RPVolume, Get-RPServiceInfo, Get-RPExplicitAceSid, the firewall ones), which the tests mock
    and which Windows.Tests.ps1 runs for real on windows-latest.

    The files must stay ASCII: Windows PowerShell 5.1 reads a script without a byte order mark in
    the PC's ANSI code page.
#>

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Get-RPWindowsPowerShellModulePath {
    <#
    .SYNOPSIS
        A module path for Windows PowerShell without PowerShell 7's folders.

    .DESCRIPTION
        Windows PowerShell 5.1 started from PowerShell 7 (a support person's terminal, the CI
        runner) inherits PowerShell 7's module folders first. It then finds Get-Acl and the like
        in PowerShell 7's Microsoft.PowerShell.Security, which it cannot load ("found in the
        module ... but the module could not be loaded"). Its own folders are kept, the system's
        first; PowerShell 7's (...\PowerShell\... but not ...\WindowsPowerShell\...) are dropped.
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()] [string] $Path,
        [Parameter(Mandatory)] [string] $SystemRoot
    )
    # A plain join: this runs as the module loads, before Join-RPPath exists, and on any OS in tests.
    $system = $SystemRoot.TrimEnd('\') + '\System32\WindowsPowerShell\v1.0\Modules'
    $kept = @($Path -split ';' | Where-Object {
            $_ -and ($_ -match '\\WindowsPowerShell\\' -or $_ -notmatch '\\PowerShell\\')
        })
    $ordered = @($system) + @($kept | Where-Object { $_.TrimEnd('\') -ne $system })
    ($ordered | Select-Object -Unique) -join ';'
}

if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = Get-RPWindowsPowerShellModulePath -Path $env:PSModulePath -SystemRoot $env:SystemRoot
}

# ------------------------------------------------------------------------------------- constants

# The services (the server's SERVICE_NAMES).
$script:Services = [ordered]@{
    Database = 'RPDatabase'
    Server   = 'RPServer'
    Watchdog = 'RPWatchdog'
}

# The data folder made on the chosen drive (ONB-002).
$script:DataFolderName = 'RestaurantPlatform'

# The settings catalogue's onboarding.minFreeDiskGb default; the installer runs before the
# settings exist. GB as Windows Explorer counts them (1024^3 bytes).
$script:DefaultMinFreeGB = 20
$script:BytesPerGB = [double]1073741824

$script:FirewallGroup = 'Restaurant Platform'

# Well-known accounts by SID, so the names' language does not matter.
$script:Sid = @{
    System         = 'S-1-5-18'
    Administrators = 'S-1-5-32-544'
    Users          = 'S-1-5-32-545'
}

# Get-Disk's BusType by number (MSFT_Disk), for when it comes back as one.
$script:BusTypeNames = @{
    0 = 'Unknown'; 1 = 'SCSI'; 2 = 'ATAPI'; 3 = 'ATA'; 4 = '1394'; 5 = 'SSA'; 6 = 'FibreChannel'
    7 = 'USB'; 8 = 'RAID'; 9 = 'iSCSI'; 10 = 'SAS'; 11 = 'SATA'; 12 = 'SD'; 13 = 'MMC'
    14 = 'Virtual'; 15 = 'FileBackedVirtual'; 16 = 'Spaces'; 17 = 'NVMe'
}

# Disks that can be unplugged or are files themselves: never the data drive.
$script:RemovableBusTypes = @('USB', 'SD', 'MMC', '1394', 'FileBackedVirtual')
# Disks reached over the network.
$script:NetworkBusTypes = @('iSCSI')
# File systems with the permissions the data folder needs.
$script:LocalFileSystems = @('NTFS', 'ReFS')

# Windows restarts a failed service after 1, 2 and 5 seconds (the WinSW definitions say the same).
$script:ServerRecovery = 'restart/1000/restart/2000/restart/5000'
$script:DatabaseRecovery = 'restart/5000/restart/10000/restart/30000'

# Exit codes of the scripts, for the installer.
$script:ExitCodes = @{ Done = 0; Failed = 1; DeletionNotAllowed = 3 }

# -------------------------------------------------------------------------------------- logging

$script:LogFile = $null

function Start-RPLog {
    <# Every line the scripts write also goes to this file. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    $folder = Split-Path -Parent $Path
    if ($folder -and -not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
    $script:LogFile = $Path
}

function Write-RPLog {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($null -ne $script:LogFile) {
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    }
    Write-Information -MessageData $line -InformationAction Continue
}

# ------------------------------------------------------------------------------------- paths

function Join-RPPath {
    <# A Windows path: the scripts build them the same way wherever their tests run. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $ChildPath
    )
    $result = $Path.TrimEnd('\', '/')
    foreach ($child in $ChildPath) { $result = '{0}\{1}' -f $result, $child.Trim('\', '/') }
    $result
}

function Get-RPParentPath {
    <# A Windows path's folder, the same wherever the tests run (Split-Path turns \ into / off Windows). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    $trimmed = $Path.TrimEnd('\')
    $at = $trimmed.LastIndexOf('\')
    if ($at -le 0) { return $trimmed }
    $trimmed.Substring(0, $at)
}

# --------------------------------------------------------------------------- running programs

function Invoke-RPProgram {
    <#
    .SYNOPSIS
        Runs a program and returns its exit code and output (stdout and stderr together).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [string[]] $ArgumentList = @()
    )
    if ($null -eq (Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ ExitCode = -1; Output = ('{0} was not found.' -f $FilePath) }
    }
    # Windows PowerShell 5.1 turns a program's stderr into a terminating error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { [string]$_ }
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = (@($output) -join [Environment]::NewLine).Trim()
    }
}

function Assert-RPProgramResult {
    <# Throws with the program's output unless it ended with one of the allowed codes. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)] [string] $What,
        [int[]] $AllowExitCode = @(0)
    )
    if ($AllowExitCode -notcontains [int]$Result.ExitCode) {
        throw ('{0} failed (exit {1}): {2}' -f $What, $Result.ExitCode, $Result.Output)
    }
}

# ------------------------------------------------------------------- the data drive (ONB-002)

function ConvertTo-RPDriveLetter {
    <# 'd:', 'D:\' or 'D:\Data' as 'D:'. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    if ($Path -match '^([A-Za-z]):') { return ($Matches[1].ToUpperInvariant() + ':') }
    throw ('{0} is not on a drive with a letter.' -f $Path)
}

function ConvertTo-RPBusType {
    <# Get-Disk's BusType, as a number or a name, as one word ('USB', 'FileBackedVirtual'). #>
    [CmdletBinding()]
    param([AllowNull()] $Value)
    if ($null -eq $Value) { return '' }
    $text = ([string]$Value).Trim()
    $number = 0
    if ([int]::TryParse($text, [ref]$number)) {
        if ($script:BusTypeNames.ContainsKey($number)) { return $script:BusTypeNames[$number] }
        return ('Bus{0}' -f $number)
    }
    return ($text -replace '\s', '')
}

function Get-RPDriveRefusal {
    <# Why a drive cannot hold the data, or $null when it can. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Volume,
        [Parameter(Mandatory)] [int] $MinFreeGB
    )
    $bus = ConvertTo-RPBusType $Volume.BusType
    $type = [int]$Volume.DriveType
    if ($type -eq 4 -or $script:NetworkBusTypes -contains $bus) { return 'NETWORK' }
    if ($type -eq 2 -or $script:RemovableBusTypes -contains $bus) { return 'REMOVABLE' }
    if ($type -ne 3) { return 'NOT_A_DISK' }
    if ($script:LocalFileSystems -notcontains [string]$Volume.FileSystem) { return 'FILE_SYSTEM' }
    if ([double]$Volume.FreeBytes -lt $MinFreeGB * $script:BytesPerGB) { return 'TOO_LITTLE_SPACE' }
    return $null
}

function Get-RPDataDriveChoice {
    <#
    .SYNOPSIS
        The drives and the one the data folder goes on (ONB-002).

    .DESCRIPTION
        Local fixed disks with NTFS (or ReFS) and at least MinFreeGB free can hold the data;
        network, removable and USB-attached drives cannot. The default is a drive that already
        has the data (installing again after an uninstall that kept it), else the first other
        drive than the system drive, else the system drive with the warning SYSTEM_DRIVE.
        NO_DRIVE when none fits.

        Volume is what Get-RPVolume returns: Letter, DriveType (Win32_LogicalDisk: 2 removable,
        3 local disk, 4 network, 5 CD), BusType, FileSystem, FreeBytes, SizeBytes, Label, HasData.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Volume,
        [Parameter(Mandatory)] [string] $SystemDrive,
        [ValidateRange(1, 100000)] [int] $MinFreeGB = $script:DefaultMinFreeGB
    )
    $system = ConvertTo-RPDriveLetter $SystemDrive
    $drives = @(
        foreach ($entry in @($Volume | Sort-Object -Property Letter)) {
            $letter = ConvertTo-RPDriveLetter ([string]$entry.Letter)
            $reason = Get-RPDriveRefusal -Volume $entry -MinFreeGB $MinFreeGB
            [pscustomobject]@{
                Letter     = $letter
                Label      = [string]$entry.Label
                FileSystem = [string]$entry.FileSystem
                FreeGB     = [math]::Floor([double]$entry.FreeBytes / $script:BytesPerGB * 10) / 10
                SizeGB     = [math]::Floor([double]$entry.SizeBytes / $script:BytesPerGB * 10) / 10
                System     = ($letter -eq $system)
                HasData    = [bool]$entry.HasData
                Eligible   = ($null -eq $reason)
                Reason     = $reason
            }
        }
    )
    $eligible = @($drives | Where-Object { $_.Eligible })
    $choice = @($eligible | Where-Object { $_.HasData }) | Select-Object -First 1
    if ($null -eq $choice) { $choice = @($eligible | Where-Object { -not $_.System }) | Select-Object -First 1 }
    if ($null -eq $choice) { $choice = @($eligible | Where-Object { $_.System }) | Select-Object -First 1 }

    $default = $null
    $dataDir = $null
    $warning = 'NO_DRIVE'
    if ($null -ne $choice) {
        $default = $choice.Letter
        $dataDir = '{0}\{1}' -f $choice.Letter, $script:DataFolderName
        $warning = $null
        if ($choice.System) { $warning = 'SYSTEM_DRIVE' }
    }
    [pscustomobject]@{
        MinFreeGB   = $MinFreeGB
        Default     = $default
        DataDir     = $dataDir
        Warning     = $warning
        DataFoundOn = @($drives | Where-Object { $_.HasData } | ForEach-Object { $_.Letter })
        Drives      = $drives
    }
}

function Get-RPDriveRefusalMessage {
    <# A refusal in words, for the installer's log and the person. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Drive,
        [Parameter(Mandatory)] [int] $MinFreeGB
    )
    switch ($Drive.Reason) {
        'NETWORK' { return ('{0} is a network drive. The data must be on a disk inside this PC.' -f $Drive.Letter) }
        'REMOVABLE' { return ('{0} can be unplugged. The data must be on a disk inside this PC.' -f $Drive.Letter) }
        'NOT_A_DISK' { return ('{0} is not a hard disk.' -f $Drive.Letter) }
        'FILE_SYSTEM' { return ('{0} is formatted {1}. The data needs an NTFS drive.' -f $Drive.Letter, $Drive.FileSystem) }
        'TOO_LITTLE_SPACE' { return ('{0} has {1} GB free; the data needs at least {2} GB.' -f $Drive.Letter, $Drive.FreeGB, $MinFreeGB) }
        default { return $null }
    }
}

function Get-RPDriveText {
    <# An eligible drive as the installer's drive page lists it: 'D: Data (NTFS, 412.5 GB free)'. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Drive)
    $name = $Drive.Letter
    if ($Drive.Label) { $name = '{0} {1}' -f $Drive.Letter, $Drive.Label }
    $text = '{0} ({1}, {2} GB free)' -f $name, $Drive.FileSystem, $Drive.FreeGB
    if ($Drive.HasData) { $text += ', has the restaurant''s data' }
    if ($Drive.System) { $text += ', the Windows drive' }
    $text
}

function ConvertTo-RPDriveChoiceIni {
    <#
    .SYNOPSIS
        Get-RPDataDriveChoice's answer as INI lines for the installer's data-drive page (P0-16d),
        which reads them with NSIS's ReadINIStr.

    .DESCRIPTION
        [Choice]: MinFreeGB, Default, DefaultIndex (its place among the eligible drives, -1 when
        there is none), Warning, EligibleCount and RefusedCount. Each [EligibleN]: Letter,
        DataDir, System, HasData and Text (what the page lists). Each [RefusedN]: Letter, Reason
        and Text (why not, in words).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Choice)
    $eligible = @($Choice.Drives | Where-Object { $_.Eligible })
    $refused = @($Choice.Drives | Where-Object { -not $_.Eligible })
    $defaultIndex = -1
    for ($i = 0; $i -lt $eligible.Count; $i++) {
        if ($eligible[$i].Letter -eq $Choice.Default) { $defaultIndex = $i }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('[Choice]')
    $lines.Add(('MinFreeGB={0}' -f $Choice.MinFreeGB))
    $lines.Add(('Default={0}' -f $Choice.Default))
    $lines.Add(('DefaultIndex={0}' -f $defaultIndex))
    $lines.Add(('Warning={0}' -f $Choice.Warning))
    $lines.Add(('EligibleCount={0}' -f $eligible.Count))
    $lines.Add(('RefusedCount={0}' -f $refused.Count))
    for ($i = 0; $i -lt $eligible.Count; $i++) {
        $drive = $eligible[$i]
        $lines.Add(('[Eligible{0}]' -f $i))
        $lines.Add(('Letter={0}' -f $drive.Letter))
        $lines.Add(('DataDir={0}\{1}' -f $drive.Letter, $script:DataFolderName))
        $lines.Add(('System={0}' -f [int][bool]$drive.System))
        $lines.Add(('HasData={0}' -f [int][bool]$drive.HasData))
        $lines.Add(('Text={0}' -f (Get-RPDriveText -Drive $drive)))
    }
    for ($i = 0; $i -lt $refused.Count; $i++) {
        $drive = $refused[$i]
        $lines.Add(('[Refused{0}]' -f $i))
        $lines.Add(('Letter={0}' -f $drive.Letter))
        $lines.Add(('Reason={0}' -f $drive.Reason))
        $lines.Add(('Text={0}' -f (Get-RPDriveRefusalMessage -Drive $drive -MinFreeGB $Choice.MinFreeGB)))
    }
    , $lines.ToArray()
}

function ConvertTo-RPList {
    <#
    .SYNOPSIS
        A list option as the installer passes it: powershell.exe -File hands '-StaffSubnet a,b' to
        the script as one string, so commas (and spaces) separate the items.
    #>
    [CmdletBinding()]
    param([AllowNull()] [AllowEmptyCollection()] [string[]] $Value)
    $Value | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ }
}

function Get-RPProtectedFolder {
    <# Windows' own folders: the data never goes in, over or around them. #>
    [CmdletBinding()]
    param()
    @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:USERPROFILE, $env:PUBLIC) |
        Where-Object { -not [string]::IsNullOrEmpty($_) }
}

function Get-RPProtectedConflict {
    <# The protected folder a path is, holds or lies in; $null when there is none. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [AllowEmptyCollection()] [string[]] $Protected = @(Get-RPProtectedFolder)
    )
    $path = $Path.TrimEnd('\')
    foreach ($folder in @($Protected | Where-Object { $_ })) {
        $other = $folder.TrimEnd('\')
        if ($path -ieq $other -or
            $other.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith($other + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return $other
        }
    }
    return $null
}

function Assert-RPDataDir {
    <# Throws unless DataDir is a folder of its own on a drive the choice allows. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataDir,
        [Parameter(Mandatory)] $Choice,
        [AllowEmptyCollection()] [string[]] $Protected = @(Get-RPProtectedFolder)
    )
    if ($DataDir -match '^\\\\') {
        throw ('{0} is a network folder. The data must be on a disk inside this PC.' -f $DataDir)
    }
    $letter = ConvertTo-RPDriveLetter $DataDir
    if (($DataDir.TrimEnd('\')).Length -le 2) {
        throw ('The data needs a folder of its own on {0}, not the whole drive.' -f $letter)
    }
    $conflict = Get-RPProtectedConflict -Path $DataDir -Protected $Protected
    if ($null -ne $conflict) {
        throw ('{0} is among Windows'' own folders ({1}). Choose a folder of its own.' -f $DataDir, $conflict)
    }
    $drive = @($Choice.Drives | Where-Object { $_.Letter -eq $letter }) | Select-Object -First 1
    if ($null -eq $drive) { throw ('{0} is not a drive on this PC.' -f $letter) }
    if (-not $drive.Eligible) { throw (Get-RPDriveRefusalMessage -Drive $drive -MinFreeGB $Choice.MinFreeGB) }
}

function Get-RPVolume {
    <# The PC's drives, for Get-RPDataDriveChoice (Windows). #>
    [CmdletBinding()]
    param()
    foreach ($disk in @(Get-CimInstance -ClassName Win32_LogicalDisk)) {
        $letter = [string]$disk.DeviceID
        $bus = $null
        if ([int]$disk.DriveType -eq 3) {
            try {
                $bus = (Get-Partition -DriveLetter $letter.Substring(0, 1) -ErrorAction Stop |
                        Get-Disk -ErrorAction Stop).BusType
            } catch {
                $bus = $null
            }
        }
        $marker = '{0}\{1}\postgres\PG_VERSION' -f $letter, $script:DataFolderName
        [pscustomobject]@{
            Letter     = $letter
            DriveType  = [int]$disk.DriveType
            BusType    = $bus
            FileSystem = [string]$disk.FileSystem
            FreeBytes  = [double]$disk.FreeSpace
            SizeBytes  = [double]$disk.Size
            Label      = [string]$disk.VolumeName
            HasData    = [bool](Test-Path -LiteralPath $marker)
        }
    }
}

# --------------------------------------------------------------------------- folder permissions

function Get-RPServiceSid {
    <#
    .SYNOPSIS
        The SID of a service's virtual account (NT SERVICE\<name>), as `sc.exe showsid` gives it.

    .DESCRIPTION
        S-1-5-80- followed by the SHA-1 of the upper-case name in UTF-16LE as five 32-bit
        numbers. Computed, so permissions can name the account before the service exists.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Name)
    $bytes = [Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant())
    $sha1 = [Security.Cryptography.SHA1]::Create()
    try { $hash = $sha1.ComputeHash($bytes) } finally { $sha1.Dispose() }
    $parts = for ($index = 0; $index -lt 20; $index += 4) { [BitConverter]::ToUInt32($hash, $index) }
    'S-1-5-80-' + ($parts -join '-')
}

function New-RPGrant {
    param([string] $Sid, [string] $Rights)
    [pscustomobject]@{ Sid = $Sid; Rights = $Rights }
}

function Get-RPFolderAclPlan {
    <#
    .SYNOPSIS
        Who may do what in each folder (SEC-006, SEC-007, AUD-004).

    .DESCRIPTION
        Rights are icacls': F full, M modify, RX read; (OI)(CI) also for what is inside; without
        them, the folder itself only. A protected folder inherits nothing.
        - The data folder: administrators, SYSTEM and the server's account (NT SERVICE\RPServer).
          The database's account may only pass through it to its own folders.
        - postgres: PostgreSQL's own virtual account (NT SERVICE\RPDatabase, PC-I6), which nothing else
          shares; the server may read it, not change it.
        - backups\wal-staging: PostgreSQL hands its log files to the server there.
        - secrets: administrators, SYSTEM and the server only, nothing inherited.
        - tls: everyone signed in to Windows may read it, for the POS window's pinned CA
          (ca.crt); its keys there are sealed with a secret.
        - ProgramData\RestaurantPlatform (the installation file): everyone may read it, only
          administrators change it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataDir,
        [Parameter(Mandatory)] [string] $ProgramDataDir,
        [string] $ServerSid = (Get-RPServiceSid $script:Services.Server),
        [string] $DatabaseSid = (Get-RPServiceSid $script:Services.Database)
    )
    $sid = $script:Sid
    $owners = @(
        (New-RPGrant $sid.System '(OI)(CI)F'),
        (New-RPGrant $sid.Administrators '(OI)(CI)F')
    )
    $data = $DataDir.TrimEnd('\')
    @(
        [pscustomobject]@{
            Path = $data; Protect = $true
            Grants = $owners + @((New-RPGrant $ServerSid '(OI)(CI)M'), (New-RPGrant $DatabaseSid 'RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'postgres'); Protect = $true
            Grants = $owners + @((New-RPGrant $DatabaseSid '(OI)(CI)F'), (New-RPGrant $ServerSid '(OI)(CI)RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'backups'); Protect = $false
            Grants = @((New-RPGrant $DatabaseSid 'RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'backups', 'wal-staging'); Protect = $false
            Grants = @((New-RPGrant $DatabaseSid '(OI)(CI)M'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'secrets'); Protect = $true
            Grants = $owners + @((New-RPGrant $ServerSid '(OI)(CI)M'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'tls'); Protect = $false
            Grants = @((New-RPGrant $sid.Users '(OI)(CI)RX'))
        },
        [pscustomobject]@{
            Path = $ProgramDataDir.TrimEnd('\'); Protect = $true
            Grants = $owners + @((New-RPGrant $sid.Users '(OI)(CI)RX'), (New-RPGrant $ServerSid '(OI)(CI)RX'))
        }
    )
}

function Get-RPIcaclsArgument {
    <# icacls' arguments that make a folder's own entries exactly the plan's. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Entry)
    $inheritance = '/inheritance:e'
    if ($Entry.Protect) { $inheritance = '/inheritance:r' }
    $grants = @($Entry.Grants | ForEach-Object { '*{0}:{1}' -f $_.Sid, $_.Rights })
    @($Entry.Path, $inheritance, '/grant:r') + $grants + @('/Q')
}

function Get-RPExtraAceSid {
    <# The accounts with entries of their own on a folder that the plan does not name. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Entry,
        [AllowEmptyCollection()] [string[]] $ExplicitSid = @()
    )
    $planned = @($Entry.Grants | ForEach-Object { $_.Sid })
    @($ExplicitSid | Where-Object { $planned -notcontains $_ } | Select-Object -Unique)
}

function Get-RPExplicitAceSid {
    <# The accounts with entries of their own (not inherited) on a folder (Windows). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    $acl = Get-Acl -LiteralPath $Path
    $found = foreach ($rule in @($acl.Access | Where-Object { -not $_.IsInherited })) {
        $reference = $rule.IdentityReference
        try {
            $reference.Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            [string]$reference
        }
    }
    @($found | Select-Object -Unique)
}

function Get-RPMissingServiceSid {
    <# The virtual-account SIDs of the platform's services that do not exist yet (Windows). #>
    [CmdletBinding()]
    param()
    @($script:Services.Values | Where-Object { $null -eq (Get-RPServiceInfo -Name $_) } | ForEach-Object { Get-RPServiceSid $_ })
}

function Select-RPExistingGrant {
    <#
    .SYNOPSIS
        The plan without its grants to accounts that do not exist yet.

    .DESCRIPTION
        A service's virtual account (NT SERVICE\<name>) exists once its service does: before that
        icacls refuses to name it (1332, "No mapping between account names and security IDs").
        On a new PC the folders are set first without those accounts, so they are more closed,
        never more open, and set in full once the services exist (SEC-006). A folder whose every
        grant is to such an account, and that inherits, is left for then.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object[]] $Plan,
        [AllowEmptyCollection()] [string[]] $MissingSid = @()
    )
    foreach ($entry in $Plan) {
        $grants = @($entry.Grants | Where-Object { $MissingSid -notcontains $_.Sid })
        if ($grants.Count -eq 0 -and -not $entry.Protect) { continue }
        [pscustomobject]@{ Path = $entry.Path; Protect = $entry.Protect; Grants = $grants }
    }
}

function Set-RPFolderPermission {
    <#
    .SYNOPSIS
        Makes each folder of the plan and gives it exactly the plan's entries.

    .DESCRIPTION
        The plan's entries are set first and anything else removed after, so a folder is never
        more open than the plan while this runs. Repair runs it again and undoes changes made by
        hand.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object[]] $Plan)
    foreach ($entry in $Plan) {
        if (-not (Test-Path -LiteralPath $entry.Path)) {
            New-Item -ItemType Directory -Path $entry.Path -Force | Out-Null
        }
        $result = Invoke-RPProgram -FilePath 'icacls.exe' -ArgumentList (Get-RPIcaclsArgument -Entry $entry)
        Assert-RPProgramResult -Result $result -What ('Setting the permissions of {0}' -f $entry.Path)
        $extra = @(Get-RPExtraAceSid -Entry $entry -ExplicitSid @(Get-RPExplicitAceSid -Path $entry.Path))
        if ($extra.Count -gt 0) {
            $arguments = @($entry.Path) + @($extra | ForEach-Object { '/remove'; ('*{0}' -f $_) }) + @('/Q')
            $removed = Invoke-RPProgram -FilePath 'icacls.exe' -ArgumentList $arguments
            Assert-RPProgramResult -Result $removed -What ('Removing other permissions from {0}' -f $entry.Path)
        }
    }
}

function Get-RPCurrentUserSid {
    <# The account running the installer (Windows). #>
    [CmdletBinding()]
    param()
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-RPAdministrator {
    <# The set-up needs an administrator (Windows). #>
    [CmdletBinding()]
    param()
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run the set-up as an administrator.'
    }
}

# ----------------------------------------------------------------------------- the firewall

function ConvertTo-RPRemoteAddress {
    <#
    .SYNOPSIS
        The addresses the server accepts connections from (SEC-008): the staff network.

    .DESCRIPTION
        Without a staff subnet, LocalSubnet: the networks this PC is on. A subnet is IPv4 CIDR
        such as 192.168.10.0/24, at most /8 wide.
    #>
    [CmdletBinding()]
    param([AllowNull()] [AllowEmptyCollection()] [string[]] $StaffSubnet)
    $given = @($StaffSubnet | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })
    if ($given.Count -eq 0) { return , @('LocalSubnet') }
    foreach ($subnet in $given) {
        if ($subnet -eq 'LocalSubnet') { continue }
        $match = [regex]::Match($subnet, '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$')
        if (-not $match.Success) {
            throw ('The staff network {0} is not a subnet such as 192.168.10.0/24.' -f $subnet)
        }
        foreach ($group in 1..4) {
            if ([int]$match.Groups[$group].Value -gt 255) {
                throw ('The staff network {0} is not a subnet such as 192.168.10.0/24.' -f $subnet)
            }
        }
        $prefix = [int]$match.Groups[5].Value
        if ($prefix -lt 8 -or $prefix -gt 32) {
            throw ('The staff network {0} is too wide; give the staff subnet, such as /24.' -f $subnet)
        }
    }
    return , $given
}

function Get-RPFirewallRuleSpec {
    <#
    .SYNOPSIS
        The inbound rules (SEC-008): the server's HTTPS port and the pagers' MQTT port, for the
        server's Node.js only, from the staff network only.

    .DESCRIPTION
        Every network profile: Windows may call the restaurant's network public, and the POS must
        still reach the server. Nothing else is opened; no outbound rule is needed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int] $Port,
        [Parameter(Mandatory)] [int] $MqttPort,
        [Parameter(Mandatory)] [string] $NodePath,
        [AllowNull()] [AllowEmptyCollection()] [string[]] $StaffSubnet,
        [string] $Group = $script:FirewallGroup
    )
    $remote = ConvertTo-RPRemoteAddress -StaffSubnet $StaffSubnet
    $common = @{
        Group         = $Group
        Direction     = 'Inbound'
        Action        = 'Allow'
        Protocol      = 'TCP'
        Program       = $NodePath
        RemoteAddress = $remote
        Profile       = 'Any'
        Enabled       = 'True'
    }
    $https = $common.Clone()
    $https.Name = 'RP-Server-HTTPS'
    $https.DisplayName = 'Restaurant Platform server (HTTPS)'
    $https.Description = 'The POS, kitchen screens, waiter phones and table tablets reach the server here.'
    $https.LocalPort = [string]$Port
    $mqtt = $common.Clone()
    $mqtt.Name = 'RP-Server-MQTT'
    $mqtt.DisplayName = 'Restaurant Platform pagers (MQTT over TLS)'
    $mqtt.Description = 'The waiters'' wrist pagers reach the server here.'
    $mqtt.LocalPort = [string]$MqttPort
    @($https, $mqtt)
}

function Remove-RPFirewallRule {
    <# Removes every rule of the group (Windows). #>
    [CmdletBinding()]
    param([string] $Group = $script:FirewallGroup)
    Get-NetFirewallRule -Group $Group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

function Add-RPFirewallRule {
    <# Adds one rule (Windows). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable] $Spec)
    New-NetFirewallRule @Spec | Out-Null
}

function Set-RPFirewallRule {
    <# The group's rules become exactly these; repair replaces them. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object[]] $Spec,
        [string] $Group = $script:FirewallGroup
    )
    Remove-RPFirewallRule -Group $Group
    foreach ($rule in $Spec) { Add-RPFirewallRule -Spec $rule }
}

# ------------------------------------------------------------------------------ the services

function Get-RPServiceInfo {
    <# A service's state, program, account and process, or $null when there is none (Windows). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Name)
    $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $Name)
    if ($null -eq $service) { return $null }
    [pscustomobject]@{
        Name      = [string]$service.Name
        State     = [string]$service.State
        PathName  = [string]$service.PathName
        StartName = [string]$service.StartName
        ProcessId = [int]$service.ProcessId
    }
}

function Wait-RPServiceState {
    <# Waits until the service is in the state (or gone, for 'Missing'); false after the timeout. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [ValidateSet('Running', 'Stopped', 'Missing')] [string] $State,
        [int] $TimeoutSeconds = 60
    )
    for ($waited = 0; $waited -le $TimeoutSeconds; $waited++) {
        $info = Get-RPServiceInfo -Name $Name
        if ($State -eq 'Missing' -and $null -eq $info) { return $true }
        if ($null -ne $info -and $info.State -eq $State) { return $true }
        if ($State -eq 'Running' -and $null -eq $info) { return $false }
        if ($waited -lt $TimeoutSeconds) { Start-Sleep -Seconds 1 }
    }
    return $false
}

function Start-RPService {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [int] $TimeoutSeconds = 120
    )
    $result = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('start', $Name)
    # 1056: already running.
    Assert-RPProgramResult -Result $result -What ('Starting {0}' -f $Name) -AllowExitCode @(0, 1056)
    if (-not (Wait-RPServiceState -Name $Name -State 'Running' -TimeoutSeconds $TimeoutSeconds)) {
        throw ('{0} did not start within {1} seconds. Its log is in the data folder''s logs.' -f $Name, $TimeoutSeconds)
    }
    Write-RPLog ('{0} is running.' -f $Name)
}

function Stop-RPService {
    <# Stops a service; ends its processes when it will not stop. Nothing to do when it is missing. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [int] $TimeoutSeconds = 60
    )
    $info = Get-RPServiceInfo -Name $Name
    if ($null -eq $info -or $info.State -eq 'Stopped') { return }
    $result = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('stop', $Name)
    # 1062: not started; 1061: cannot accept control now (still starting).
    Assert-RPProgramResult -Result $result -What ('Stopping {0}' -f $Name) -AllowExitCode @(0, 1061, 1062)
    if (Wait-RPServiceState -Name $Name -State 'Stopped' -TimeoutSeconds $TimeoutSeconds) {
        Write-RPLog ('{0} is stopped.' -f $Name)
        return
    }
    $stuck = Get-RPServiceInfo -Name $Name
    if ($null -ne $stuck -and $stuck.ProcessId -gt 0) {
        Write-RPLog ('{0} did not stop within {1} seconds; ending process {2}.' -f $Name, $TimeoutSeconds, $stuck.ProcessId)
        $killed = Invoke-RPProgram -FilePath 'taskkill.exe' -ArgumentList @('/PID', [string]$stuck.ProcessId, '/T', '/F')
        Assert-RPProgramResult -Result $killed -What ('Ending {0}' -f $Name) -AllowExitCode @(0, 128)
    }
    if (-not (Wait-RPServiceState -Name $Name -State 'Stopped' -TimeoutSeconds 15)) {
        throw ('{0} could not be stopped.' -f $Name)
    }
}

function Remove-RPService {
    <# Stops and deletes a service; nothing to do when it is missing. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Name)
    if ($null -eq (Get-RPServiceInfo -Name $Name)) { return }
    Stop-RPService -Name $Name
    $result = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('delete', $Name)
    # 1060: already gone; 1072: marked for deletion (goes when services.msc closes).
    Assert-RPProgramResult -Result $result -What ('Removing {0}' -f $Name) -AllowExitCode @(0, 1060, 1072)
    Write-RPLog ('Removed the {0} service.' -f $Name)
}

function Set-RPServiceRecovery {
    <# Windows restarts the service when it fails, also when it stops with an error. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Actions
    )
    $failure = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('failure', $Name, 'reset=', '3600', 'actions=', $Actions)
    Assert-RPProgramResult -Result $failure -What ('Setting {0}''s recovery' -f $Name)
    $flag = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('failureflag', $Name, '1')
    Assert-RPProgramResult -Result $flag -What ('Setting {0}''s recovery' -f $Name)
}

function Install-RPWinSWService {
    <#
    .SYNOPSIS
        Installs (or on repair brings up to date) a WinSW service from its definition, which
        setup-cli service-files wrote beside <services>\<name>.exe.

    .DESCRIPTION
        WinSW 2 installs a service once; it reads the XML each time the service starts. Repair
        sets what the service control manager keeps (start at boot, the database dependency, the
        account, recovery) with sc.exe, and installs the service again only when it points at
        another program (the software moved).

        Account: a virtual account (NT SERVICE\<name>) owns the data folder, so the server runs
        with nothing more than it needs. Without one the service stays LocalSystem: the
        watchdog, which must start and stop the other services.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $ServicesDir,
        [string] $DependsOn,
        [switch] $VirtualAccount
    )
    $exe = Join-RPPath $ServicesDir ('{0}.exe' -f $Name)
    $info = Get-RPServiceInfo -Name $Name
    if ($null -ne $info -and $info.PathName.Trim('"', ' ') -ne $exe) {
        Write-RPLog ('{0} runs {1}; installing it again for {2}.' -f $Name, $info.PathName, $exe)
        Remove-RPService -Name $Name
        $info = $null
    }
    if ($null -eq $info) {
        $installed = Invoke-RPProgram -FilePath $exe -ArgumentList @('install')
        Assert-RPProgramResult -Result $installed -What ('Installing the {0} service' -f $Name)
        Write-RPLog ('Installed the {0} service.' -f $Name)
    }
    $config = @('config', $Name, 'start=', 'auto')
    if ($DependsOn) { $config += @('depend=', $DependsOn) }
    if ($VirtualAccount) {
        $sidType = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList @('sidtype', $Name, 'unrestricted')
        Assert-RPProgramResult -Result $sidType -What ('Setting {0}''s account' -f $Name)
        $config += @('obj=', ('NT SERVICE\{0}' -f $Name))
    }
    $configured = Invoke-RPProgram -FilePath 'sc.exe' -ArgumentList $config
    Assert-RPProgramResult -Result $configured -What ('Configuring the {0} service' -f $Name)
    Set-RPServiceRecovery -Name $Name -Actions $script:ServerRecovery
}

# ---------------------------------------------------------------------------- the set-up tool

function Get-RPSetupCli {
    <# Node.js and setup-cli.js in the installed software. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $InstallDir)
    $root = $InstallDir.TrimEnd('\')
    [pscustomobject]@{
        Node   = Join-RPPath $root 'node', 'node.exe'
        Script = Join-RPPath $root 'server', 'dist', 'installation', 'setup-cli.js'
    }
}

function Invoke-RPSetupCli {
    <#
    .SYNOPSIS
        Runs one setup-cli command (P0-16b) against the installation file; throws on failure
        unless the exit code is allowed. Returns the result.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Cli,
        [Parameter(Mandatory)] [string] $InstallationFile,
        [Parameter(Mandatory)] [string[]] $ArgumentList,
        [int[]] $AllowExitCode = @(0)
    )
    $arguments = @($Cli.Script) + $ArgumentList + @('--installation', $InstallationFile)
    $result = Invoke-RPProgram -FilePath $Cli.Node -ArgumentList $arguments
    if ($result.Output) { Write-RPLog $result.Output }
    Assert-RPProgramResult -Result $result -What ('setup-cli {0}' -f $ArgumentList[0]) -AllowExitCode $AllowExitCode
    $result
}

function Get-RPInstallationPath {
    <# The folders, ports and services of the installation (setup-cli paths). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Cli,
        [Parameter(Mandatory)] [string] $InstallationFile
    )
    $result = Invoke-RPSetupCli -Cli $Cli -InstallationFile $InstallationFile -ArgumentList @('paths')
    $result.Output | ConvertFrom-Json
}

function Read-RPInstallationFile {
    <# The installation file as written last, or $null when there is none. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-RPDefaultInstallationFile {
    [CmdletBinding()]
    param()
    $programData = $env:ProgramData
    if ([string]::IsNullOrEmpty($programData)) { $programData = 'C:\ProgramData' }
    Join-RPPath $programData 'RestaurantPlatform', 'installation.json'
}

function Wait-RPServerRunning {
    <# Waits until the service host says the server runs (setup-cli status). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Cli,
        [Parameter(Mandatory)] [string] $InstallationFile,
        [int] $TimeoutSeconds = 180
    )
    $phase = $null
    $lastError = $null
    for ($waited = 0; $waited -le $TimeoutSeconds; $waited += 2) {
        $result = Invoke-RPProgram -FilePath $Cli.Node -ArgumentList @($Cli.Script, 'status', '--installation', $InstallationFile)
        if ($result.ExitCode -eq 0) {
            $status = $result.Output | ConvertFrom-Json
            if ($null -ne $status.host) {
                $phase = $status.host.phase
                $lastError = $status.host.lastError
                if ($phase -eq 'RUNNING') { return }
            }
        }
        if ($waited -lt $TimeoutSeconds) { Start-Sleep -Seconds 2 }
    }
    $detail = ''
    if ($lastError) { $detail = (' The last error: {0}' -f $lastError) }
    throw ('The server did not start within {0} seconds (it was {1}).{2}' -f $TimeoutSeconds, $phase, $detail)
}

# ------------------------------------------------------------------------- install and repair

function Get-RPWriteInstallationArgument {
    <# write-installation's options from the script's parameters; repair keeps what is not given. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable] $Option)
    $names = [ordered]@{
        InstallDir      = '--install-dir'
        DataDir         = '--data-dir'
        ProductVersion  = '--product-version'
        Port            = '--port'
        MqttPort        = '--mqtt-port'
        PgPort          = '--pg-port'
        ControlPlaneUrl = '--control-plane-url'
        RelayUrl        = '--relay-url'
        QrSiteUrl       = '--qr-site-url'
        ErrorDsn        = '--error-dsn'
    }
    $arguments = @('write-installation')
    foreach ($name in $names.Keys) {
        if ($Option.ContainsKey($name) -and $null -ne $Option[$name] -and [string]$Option[$name] -ne '' -and [string]$Option[$name] -ne '0') {
            $value = [string]$Option[$name]
            if ($name -eq 'InstallDir' -or $name -eq 'DataDir') { $value = $value.TrimEnd('\') }
            $arguments += @($names[$name], $value)
        }
    }
    if ($Option.ContainsKey('TlsHostnames') -and @($Option.TlsHostnames).Count -gt 0) {
        $arguments += @('--tls-hostnames', (@($Option.TlsHostnames) -join ','))
    }
    # UPD-007: the signer updates must carry (kept on repair when not given); unsigned updates
    # only when this run says so (a test build), never left on from an earlier one.
    if ($Option.ContainsKey('UpdatePublisher') -and [string]$Option.UpdatePublisher -ne '') {
        $arguments += @('--update-publisher', [string]$Option.UpdatePublisher)
    }
    if ($Option.ContainsKey('UpdateIssuer') -and [string]$Option.UpdateIssuer -ne '') {
        $arguments += @('--update-issuer', [string]$Option.UpdateIssuer)
    }
    $unsigned = 'off'
    if ($Option.ContainsKey('AllowUnsignedUpdates') -and [bool]$Option.AllowUnsignedUpdates) { $unsigned = 'on' }
    $arguments += @('--allow-unsigned-updates', $unsigned)
    $arguments
}

function Invoke-RPInstall {
    <#
    .SYNOPSIS
        Installs or repairs the services on this PC (ONB-001, ONB-002, NFR-I01, NFR-I02).

    .DESCRIPTION
        Every step can run again without losing data, so repair is the same run. The software's
        files are in InstallDir already (the installer copies them first, P0-16d).

        1. The data folder: the one the installation file names (repair, which refuses another
           folder or a missing one), else DataDir, else the default drive (ONB-002). A drive given
           or chosen must pass the drive check.
        2. The installation file, its folder's permissions and the maintenance flag, so the
           watchdog leaves the services alone; repair stops the server and the watchdog.
        3. The secrets (DPAPI), behind the secrets folder's permissions.
        4. PostgreSQL's data folder (initdb runs with a restricted copy of the installer's account,
           which may write the data folder until the permissions are set in full).
        5. Every folder's permissions; the database service, started; the logins; the migrations.
        6. The server and watchdog services; the firewall rules; the updater's scheduled task and
           this installer kept for going back (P7-04c); the services started, and the server
           answering.
        The maintenance flag is lifted at the end, also when a step failed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallDir,
        [string] $DataDir,
        [string] $ProductVersion,
        [int] $Port,
        [int] $MqttPort,
        [int] $PgPort,
        [string[]] $StaffSubnet,
        [string[]] $TlsHostnames,
        [string] $ControlPlaneUrl,
        [string] $RelayUrl,
        [string] $QrSiteUrl,
        [string] $ErrorDsn,
        [int] $MinFreeGB = $script:DefaultMinFreeGB,
        # The installer that is running, kept to go back to after a failed update (P7-04c).
        [string] $InstallerPath,
        [string] $UpdatePublisher,
        [string] $UpdateIssuer,
        [switch] $AllowUnsignedUpdates,
        [string] $InstallationFile = (Get-RPDefaultInstallationFile),
        [int] $StartTimeoutSeconds = 180
    )
    Assert-RPAdministrator
    $cli = Get-RPSetupCli -InstallDir $InstallDir
    $existing = Read-RPInstallationFile -Path $InstallationFile
    $repair = $null -ne $existing
    $mode = 'install'
    if ($repair) { $mode = 'repair' }
    Write-RPLog ('Starting the {0} of the Restaurant Platform services.' -f $mode)

    # 1. The data folder.
    if ($repair) {
        $kept = ([string]$existing.dataDir).TrimEnd('\')
        if ($DataDir -and $DataDir.TrimEnd('\') -ne $kept) {
            throw ('The data is in {0}. Repair keeps it there; to use {1}, restore a backup on a new installation instead. Nothing was changed.' -f $kept, $DataDir)
        }
        if (-not (Test-Path -LiteralPath $kept)) {
            throw ('The data folder {0} is not there (was its drive removed or given another letter?). Nothing was changed.' -f $kept)
        }
        $DataDir = $kept
        Write-RPLog ('Keeping the data in {0}.' -f $DataDir)
    } else {
        $choice = Get-RPDataDriveChoice -Volume @(Get-RPVolume) -SystemDrive $env:SystemDrive -MinFreeGB $MinFreeGB
        if (-not $DataDir) {
            if ($null -eq $choice.Default) {
                throw ('No drive on this PC can hold the data: it needs a local NTFS disk with {0} GB free.' -f $MinFreeGB)
            }
            $DataDir = $choice.DataDir
        }
        Assert-RPDataDir -DataDir $DataDir -Choice $choice
        $drive = ConvertTo-RPDriveLetter $DataDir
        if ($drive -eq (ConvertTo-RPDriveLetter $env:SystemDrive)) {
            Write-RPLog ('Warning: the data goes on the system drive {0}. A second disk is safer.' -f $drive)
        }
        Write-RPLog ('The data goes in {0}.' -f $DataDir)
    }
    $DataDir = $DataDir.TrimEnd('\')

    $programDataDir = Get-RPParentPath $InstallationFile
    $plan = Get-RPFolderAclPlan -DataDir $DataDir -ProgramDataDir $programDataDir
    $early = @($plan | Where-Object { $_.Path -eq (Join-RPPath $DataDir 'secrets') -or $_.Path -eq $programDataDir.TrimEnd('\') })

    # 2. The installation file and the maintenance flag. On a new PC the services' accounts do
    # not exist yet: the folders are closed to them until step 6.
    Set-RPFolderPermission -Plan (Select-RPExistingGrant -Plan $early -MissingSid (Get-RPMissingServiceSid))
    $options = @{}
    foreach ($key in $PSBoundParameters.Keys) { $options[$key] = $PSBoundParameters[$key] }
    $options.DataDir = $DataDir
    $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList (Get-RPWriteInstallationArgument -Option $options)
    $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'on', '--minutes', '60', '--reason', $mode)
    try {
        $paths = Get-RPInstallationPath -Cli $cli -InstallationFile $InstallationFile
        Stop-RPService -Name $script:Services.Watchdog
        Stop-RPService -Name $script:Services.Server

        # 3. The secrets.
        try {
            $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('secrets')
        } catch {
            if ([string]$_ -match 'DPAPI unprotect failed') {
                throw ('The secrets in {0} were protected by another Windows installation (this PC was set up again, or the drive came from another PC), so they cannot be read here. Restore from a backup with the recovery key instead: see docs/runbooks/windows-installer.md. Nothing was changed.' -f $paths.secretsDir)
            }
            throw
        }

        # 4. PostgreSQL's data folder.
        $user = Get-RPCurrentUserSid
        $granted = Invoke-RPProgram -FilePath 'icacls.exe' -ArgumentList @($DataDir, '/grant:r', ('*{0}:(OI)(CI)F' -f $user), '/Q')
        Assert-RPProgramResult -Result $granted -What ('Letting PostgreSQL''s set-up write {0}' -f $DataDir)
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('postgres-init')

        # 5. The permissions, the database, the logins and the migrations.
        # The database is stopped while its account changes (PC-I6): an installation from before
        # ran it as Network Service, and the register step moves it to its own virtual account.
        # Registering first makes the database's account, which its folders then name.
        Stop-RPService -Name $script:Services.Database
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('postgres-register')
        Set-RPFolderPermission -Plan (Select-RPExistingGrant -Plan $plan -MissingSid (Get-RPMissingServiceSid))
        Set-RPServiceRecovery -Name $script:Services.Database -Actions $script:DatabaseRecovery
        Start-RPService -Name $script:Services.Database
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('database')
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('migrate')

        # 6. The services and the firewall.
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('service-files')
        Install-RPWinSWService -Name $script:Services.Server -ServicesDir $paths.servicesDir -DependsOn $script:Services.Database -VirtualAccount
        Install-RPWinSWService -Name $script:Services.Watchdog -ServicesDir $paths.servicesDir
        # Every account exists now: the folders get the plan in full before the server starts.
        Set-RPFolderPermission -Plan $plan
        $rules = Get-RPFirewallRuleSpec -Port $paths.ports.server -MqttPort $paths.ports.mqtt -NodePath $paths.node -StaffSubnet $StaffSubnet
        Set-RPFirewallRule -Spec $rules
        Write-RPLog ('Opened ports {0} and {1} to {2}.' -f $paths.ports.server, $paths.ports.mqtt, (@($rules[0].RemoteAddress) -join ', '))
        Register-RPUpdateTask -SetupDir (Join-RPPath $InstallDir 'setup') -ProgramDataDir $programDataDir
        if ($InstallerPath) {
            $installed = [string](Get-RPProperty (Read-RPInstallationFile -Path $InstallationFile) 'productVersion')
            if (-not $installed) { $installed = $ProductVersion }
            Save-RPInstaller -InstallerPath $InstallerPath -ProductVersion $installed -ProgramDataDir $programDataDir
        }

        Start-RPService -Name $script:Services.Server
        Wait-RPServerRunning -Cli $cli -InstallationFile $InstallationFile -TimeoutSeconds $StartTimeoutSeconds
        Start-RPService -Name $script:Services.Watchdog
    } finally {
        try {
            $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'off')
        } catch {
            Write-RPLog ('Could not lift the maintenance flag (it lapses by itself within an hour): {0}' -f $_)
        }
    }
    Write-RPLog ('The {0} is done. The server answers on port {1}.' -f $mode, $paths.ports.server)
    [pscustomobject]@{
        Mode     = $mode
        DataDir  = $DataDir
        Port     = [int]$paths.ports.server
        MqttPort = [int]$paths.ports.mqtt
    }
}

# --------------------------------------------------------------------------------- uninstall

function Assert-RPDeletableDataDir {
    <# Refuses to delete anything but a data folder of ours: never a drive or Windows' folders. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataDir,
        [AllowEmptyCollection()] [string[]] $Protected = @(Get-RPProtectedFolder)
    )
    if ($DataDir.TrimEnd('\') -notmatch '^[A-Za-z]:\\.+') {
        throw ('{0} is not a folder on a drive of this PC; nothing was deleted.' -f $DataDir)
    }
    $conflict = Get-RPProtectedConflict -Path $DataDir -Protected $Protected
    if ($null -ne $conflict) {
        throw ('{0} is among Windows'' own folders ({1}); nothing was deleted.' -f $DataDir, $conflict)
    }
}

function Remove-RPFolder {
    <# Deletes a folder and everything in it. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Test-RPDataDeletionAllowed {
    <# Whether the Owner allowed deleting the data on the System page (setup-cli data-deletion). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Cli,
        [Parameter(Mandatory)] [string] $InstallationFile
    )
    $result = Invoke-RPSetupCli -Cli $Cli -InstallationFile $InstallationFile -ArgumentList @('data-deletion') -AllowExitCode @(0, 3)
    $result.ExitCode -eq 0
}

function Invoke-RPUninstall {
    <#
    .SYNOPSIS
        Removes the services and firewall rules; keeps the data unless told to delete it and the
        Owner allowed it (NFR-I02).

    .DESCRIPTION
        Deleting the data needs the Owner's permission from the System page (password and second
        factor, audited, 30 minutes); without it nothing is changed. The program files are the
        installer's to remove, after this (P0-16d). Kept data is found again by the next install
        (ONB-002), with the installation file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallDir,
        [switch] $DeleteData,
        [string] $InstallationFile = (Get-RPDefaultInstallationFile)
    )
    Assert-RPAdministrator
    $cli = Get-RPSetupCli -InstallDir $InstallDir
    $paths = $null
    if (Test-Path -LiteralPath $InstallationFile) {
        try {
            $paths = Get-RPInstallationPath -Cli $cli -InstallationFile $InstallationFile
        } catch {
            Write-RPLog ('Could not read the installation: {0}' -f $_)
        }
    }

    if ($DeleteData) {
        if ($null -eq $paths) {
            throw 'The data cannot be deleted: the installation could not be read. Nothing was changed.'
        }
        Assert-RPDeletableDataDir -DataDir $paths.dataDir
        if (-not (Test-RPDataDeletionAllowed -Cli $cli -InstallationFile $InstallationFile)) {
            $refusal = New-Object System.InvalidOperationException('The Owner has not allowed deleting the data. On the POS, open Manage, System, Removing the software, and allow it; then uninstall within 30 minutes. Nothing was changed.')
            $refusal.Data['RPExitCode'] = $script:ExitCodes.DeletionNotAllowed
            throw $refusal
        }
        Write-RPLog 'The Owner allowed deleting the data.'
    }

    if ($null -ne $paths) {
        try {
            $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'on', '--minutes', '30', '--reason', 'uninstall')
        } catch {
            Write-RPLog ('Could not set the maintenance flag: {0}' -f $_)
        }
    }
    # The updater's task first, so no update starts; then the watchdog, or it starts the others.
    try {
        Unregister-RPUpdateTask -ProgramDataDir (Get-RPParentPath $InstallationFile)
    } catch {
        Write-RPLog ('Could not remove the updater''s scheduled task: {0}' -f $_)
    }
    Remove-RPService -Name $script:Services.Watchdog
    Remove-RPService -Name $script:Services.Server
    Remove-RPService -Name $script:Services.Database
    Remove-RPFirewallRule
    Write-RPLog 'Removed the firewall rules.'

    if ($DeleteData) {
        Remove-RPFolder -Path $paths.dataDir
        Write-RPLog ('Deleted the data in {0}.' -f $paths.dataDir)
        Remove-RPFolder -Path $paths.programDataDir
        return [pscustomobject]@{ DataKept = $false; DataDir = $paths.dataDir }
    }
    $kept = $null
    if ($null -ne $paths) {
        $kept = $paths.dataDir
        try {
            $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'off')
        } catch {
            Write-RPLog ('Could not lift the maintenance flag: {0}' -f $_)
        }
        Write-RPLog ('Kept the data in {0}; installing again carries on with it.' -f $kept)
    }
    [pscustomobject]@{ DataKept = $true; DataDir = $kept }
}

# -------------------------------------------------------------------------------- updates

function Invoke-RPStop {
    <#
    .SYNOPSIS
        Stops the services before the installer replaces the software's files: an update, or the
        installer run again to repair (P0-16d).

    .DESCRIPTION
        The maintenance flag first, so the watchdog leaves the services alone, then the watchdog,
        the server and the database: every program in InstallDir must be closed before its file
        can be replaced. Nothing to do on a PC that has no installation yet. The installer then
        copies the files and runs Install-RestaurantPlatform.ps1 (repair), which starts them; if
        the files cannot be replaced, it runs Start-RestaurantPlatform.ps1 instead.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallDir,
        [string] $InstallationFile = (Get-RPDefaultInstallationFile),
        [string] $Reason = 'update'
    )
    Assert-RPAdministrator
    if (-not (Test-Path -LiteralPath $InstallationFile)) {
        Write-RPLog 'There is no installation on this PC yet; nothing to stop.'
        return [pscustomobject]@{ Stopped = $false }
    }
    $cli = Get-RPSetupCli -InstallDir $InstallDir
    try {
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'on', '--minutes', '60', '--reason', $Reason)
    } catch {
        # The watchdog is stopped first anyway; a damaged installation must still take an update.
        Write-RPLog ('Could not set the maintenance flag: {0}' -f $_)
    }
    # The watchdog first, or it starts the others again.
    Stop-RPService -Name $script:Services.Watchdog
    Stop-RPService -Name $script:Services.Server
    Stop-RPService -Name $script:Services.Database
    Write-RPLog 'The services are stopped; the software''s files can be replaced.'
    [pscustomobject]@{ Stopped = $true }
}

function Invoke-RPStart {
    <#
    .SYNOPSIS
        Starts the services again when an update could not replace the files (P0-16d): the old
        version carries on. Lifts the maintenance flag.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallDir,
        [string] $InstallationFile = (Get-RPDefaultInstallationFile)
    )
    Assert-RPAdministrator
    $started = @()
    foreach ($name in @($script:Services.Database, $script:Services.Server, $script:Services.Watchdog)) {
        if ($null -eq (Get-RPServiceInfo -Name $name)) {
            Write-RPLog ('{0} is not installed.' -f $name)
            continue
        }
        Start-RPService -Name $name
        $started += $name
    }
    if (Test-Path -LiteralPath $InstallationFile) {
        try {
            $cli = Get-RPSetupCli -InstallDir $InstallDir
            $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'off')
        } catch {
            Write-RPLog ('Could not lift the maintenance flag (it lapses by itself within an hour): {0}' -f $_)
        }
    }
    [pscustomobject]@{ Started = $started }
}

# ------------------------------------------------------------------- software updates (P7-04c)

# The updater's scheduled task (the server's UPDATER_TASK): runs Update-RestaurantPlatform.ps1 as
# SYSTEM. The watchdog service starts it when the server leaves an update request.
$script:UpdaterTask = '\RestaurantPlatform\Update'
$script:UpdaterScripts = @('Update-RestaurantPlatform.ps1', 'RestaurantPlatform.Setup.psm1')
$script:SemVer = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'

function Get-RPUpdaterPath {
    <#
    .SYNOPSIS
        The updater's files in ProgramData, which only administrators write: the scripts the task
        runs and the installers kept to go back to (no one else may even read these two), the
        outcome and the rollback request (the server reads them).

    .DESCRIPTION
        The updater runs as SYSTEM, so it never writes or deletes in the data folder: the server's
        account could turn a folder there into a link to anywhere. It only reads there.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ProgramDataDir)
    $root = $ProgramDataDir.TrimEnd('\')
    [pscustomobject]@{
        UpdaterDir    = Join-RPPath $root 'updater'
        Script        = Join-RPPath $root 'updater', 'Update-RestaurantPlatform.ps1'
        TakenFile     = Join-RPPath $root 'updater', 'taken.json'
        InstallersDir = Join-RPPath $root 'installers'
        LogsDir       = Join-RPPath $root 'setup-logs'
        OutcomeFile   = Join-RPPath $root 'update-outcome.json'
        RollbackFile  = Join-RPPath $root 'update-rollback.json'
    }
}

function Get-RPUpdaterAclPlan {
    <# The updater's scripts and the kept installers: administrators and SYSTEM only. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ProgramDataDir)
    $paths = Get-RPUpdaterPath -ProgramDataDir $ProgramDataDir
    $owners = @(
        (New-RPGrant $script:Sid.System '(OI)(CI)F'),
        (New-RPGrant $script:Sid.Administrators '(OI)(CI)F')
    )
    @(
        [pscustomobject]@{ Path = $paths.UpdaterDir; Protect = $true; Grants = $owners },
        [pscustomobject]@{ Path = $paths.InstallersDir; Protect = $true; Grants = $owners }
    )
}

function Get-RPInstallerFileName {
    <# Installers are named by their version, as the CI job names them. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Version)
    'RestaurantPlatform-Setup-{0}.exe' -f $Version
}

function Get-RPWindowsPowerShell {
    <# The 64-bit Windows PowerShell 5.1, by its full path. #>
    [CmdletBinding()]
    param()
    $root = $env:SystemRoot
    if ([string]::IsNullOrEmpty($root)) { $root = 'C:\Windows' }
    Join-RPPath $root 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
}

function ConvertTo-RPXmlText {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Text)
    [System.Security.SecurityElement]::Escape($Text)
}

function Get-RPUpdateTaskXml {
    <#
    .SYNOPSIS
        The updater's task: SYSTEM, highest rights, no trigger (the watchdog starts it), one at a
        time, at most four hours (the maintenance flag's longest), also on battery.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $ScriptPath,
        [string] $PowerShell = (Get-RPWindowsPowerShell)
    )
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    @(
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <RegistrationInfo>',
        '    <Description>Installs a Restaurant Platform update the server downloaded and checked, and goes back to the previous version when the new one fails its health check. The RPWatchdog service starts it.</Description>',
        ('    <URI>{0}</URI>' -f (ConvertTo-RPXmlText $script:UpdaterTask)),
        '  </RegistrationInfo>',
        '  <Principals>',
        '    <Principal id="System">',
        '      <UserId>S-1-5-18</UserId>',
        '      <RunLevel>HighestAvailable</RunLevel>',
        '    </Principal>',
        '  </Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>false</StartWhenAvailable>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled>',
        '    <Hidden>false</Hidden>',
        '    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>',
        '    <Priority>5</Priority>',
        '  </Settings>',
        '  <Actions Context="System">',
        '    <Exec>',
        ('      <Command>{0}</Command>' -f (ConvertTo-RPXmlText $PowerShell)),
        ('      <Arguments>{0}</Arguments>' -f (ConvertTo-RPXmlText $arguments)),
        '    </Exec>',
        '  </Actions>',
        '</Task>'
    ) -join "`r`n"
}

function Register-RPUpdateTask {
    <#
    .SYNOPSIS
        Copies the updater's scripts to ProgramData, where only administrators may change them,
        and registers its scheduled task (again on repair and on every update).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SetupDir,
        [Parameter(Mandatory)] [string] $ProgramDataDir
    )
    $paths = Get-RPUpdaterPath -ProgramDataDir $ProgramDataDir
    # Makes the folders and closes them before anything goes in.
    Set-RPFolderPermission -Plan (Get-RPUpdaterAclPlan -ProgramDataDir $ProgramDataDir)
    foreach ($name in $script:UpdaterScripts) {
        Copy-Item -LiteralPath (Join-RPPath $SetupDir $name) -Destination (Join-RPPath $paths.UpdaterDir $name) -Force
    }
    $xmlFile = Join-RPPath $paths.UpdaterDir 'update-task.xml'
    # schtasks reads a task's XML as UTF-16.
    Write-RPTextFile -Path $xmlFile -Text (Get-RPUpdateTaskXml -ScriptPath $paths.Script) -Utf16
    $result = Invoke-RPProgram -FilePath 'schtasks.exe' -ArgumentList @('/Create', '/TN', $script:UpdaterTask, '/XML', $xmlFile, '/F')
    Assert-RPProgramResult -Result $result -What 'Registering the updater''s scheduled task'
    Write-RPLog 'Registered the updater''s scheduled task.'
}

function Unregister-RPUpdateTask {
    <# Removes the updater's task and scripts; the installers kept stay with the installation file. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ProgramDataDir)
    $result = Invoke-RPProgram -FilePath 'schtasks.exe' -ArgumentList @('/Delete', '/TN', $script:UpdaterTask, '/F')
    # 1: there was no such task.
    Assert-RPProgramResult -Result $result -What 'Removing the updater''s scheduled task' -AllowExitCode @(0, 1)
    Remove-RPFolder -Path (Get-RPUpdaterPath -ProgramDataDir $ProgramDataDir).UpdaterDir
    Write-RPLog 'Removed the updater''s scheduled task.'
}

function Save-RPInstaller {
    <#
    .SYNOPSIS
        Keeps the installer that installed this version in ProgramData\RestaurantPlatform\
        installers, so a failed update can go back to it (UPD-005).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallerPath,
        [Parameter(Mandatory)] [string] $ProductVersion,
        [Parameter(Mandatory)] [string] $ProgramDataDir
    )
    $folder = (Get-RPUpdaterPath -ProgramDataDir $ProgramDataDir).InstallersDir
    $target = Join-RPPath $folder (Get-RPInstallerFileName $ProductVersion)
    if ($InstallerPath.TrimEnd('\') -eq $target) { return }
    if (-not (Test-Path -LiteralPath $InstallerPath)) {
        Write-RPLog ('Warning: the installer {0} is not there to keep; an update from this version could not go back to it.' -f $InstallerPath)
        return
    }
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    Copy-Item -LiteralPath $InstallerPath -Destination $target -Force
    Write-RPLog ('Kept the installer of version {0} for going back to it: {1}' -f $ProductVersion, $target)
}

function Get-RPInstallerFile {
    <# The kept installers in a folder. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Folder)
    @(Get-ChildItem -LiteralPath $Folder -Filter 'RestaurantPlatform-Setup-*.exe' -File)
}

function Read-RPTextFile {
    <# A whole text file, UTF-8. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8
}

function Remove-RPOldInstaller {
    <# Removes kept installers of versions other than these (after a successful update). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallersDir,
        [Parameter(Mandatory)] [string[]] $Keep
    )
    if (-not (Test-Path -LiteralPath $InstallersDir)) { return }
    $names = @($Keep | ForEach-Object { Get-RPInstallerFileName $_ })
    foreach ($file in @(Get-RPInstallerFile -Folder $InstallersDir)) {
        if ($names -notcontains $file.Name) {
            Remove-Item -LiteralPath $file.FullName -Force
            Write-RPLog ('Removed the installer {0}.' -f $file.Name)
        }
    }
}

function ConvertTo-RPSemVer {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Version)
    $match = [regex]::Match($Version, $script:SemVer)
    if (-not $match.Success) { throw ('{0} is not a version.' -f $Version) }
    $pre = @()
    if ($match.Groups[4].Success) { $pre = $match.Groups[4].Value.Split('.') }
    [pscustomobject]@{
        Core       = @([decimal]$match.Groups[1].Value, [decimal]$match.Groups[2].Value, [decimal]$match.Groups[3].Value)
        Prerelease = $pre
    }
}

function Compare-RPVersion {
    <# -1, 0 or 1 as Left is older, the same or newer than Right (semantic versions). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Left,
        [Parameter(Mandatory)] [string] $Right
    )
    $a = ConvertTo-RPSemVer $Left
    $b = ConvertTo-RPSemVer $Right
    for ($i = 0; $i -lt 3; $i++) {
        if ($a.Core[$i] -lt $b.Core[$i]) { return -1 }
        if ($a.Core[$i] -gt $b.Core[$i]) { return 1 }
    }
    # A release is newer than its pre-releases.
    if ($a.Prerelease.Count -eq 0 -and $b.Prerelease.Count -eq 0) { return 0 }
    if ($a.Prerelease.Count -eq 0) { return 1 }
    if ($b.Prerelease.Count -eq 0) { return -1 }
    $length = [Math]::Max($a.Prerelease.Count, $b.Prerelease.Count)
    for ($i = 0; $i -lt $length; $i++) {
        if ($i -ge $a.Prerelease.Count) { return -1 }
        if ($i -ge $b.Prerelease.Count) { return 1 }
        $x = $a.Prerelease[$i]
        $y = $b.Prerelease[$i]
        $xNumber = $x -match '^\d+$'
        $yNumber = $y -match '^\d+$'
        if ($xNumber -and $yNumber) {
            if ([decimal]$x -lt [decimal]$y) { return -1 }
            if ([decimal]$x -gt [decimal]$y) { return 1 }
        } elseif ($xNumber -ne $yNumber) {
            if ($xNumber) { return -1 }
            return 1
        } else {
            $order = [string]::CompareOrdinal($x, $y)
            if ($order -lt 0) { return -1 }
            if ($order -gt 0) { return 1 }
        }
    }
    0
}

function Get-RPProperty {
    <# A property of a parsed JSON object, or $null when it has none (strict mode throws). #>
    [CmdletBinding()]
    param(
        [AllowNull()] $Object,
        [Parameter(Mandatory)] [string] $Name
    )
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    $property.Value
}

function ConvertTo-RPUpdateRequest {
    <#
    .SYNOPSIS
        The server's update request (apps/server src/updates/update-files.ts), checked. The
        server's account wrote it, so nothing in it is trusted beyond these checks: the
        installer is checked again before it runs.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Json)
    $request = $Json.TrimStart([char]0xFEFF) | ConvertFrom-Json
    $version = [string](Get-RPProperty $request 'version')
    $problems = @()
    if ((Get-RPProperty $request 'format') -ne 1) { $problems += 'format' }
    if ([string](Get-RPProperty $request 'requestId') -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { $problems += 'requestId' }
    if ($version -notmatch $script:SemVer) { $problems += 'version' }
    elseif ([string](Get-RPProperty $request 'fileName') -cne (Get-RPInstallerFileName $version)) { $problems += 'fileName' }
    if ([string](Get-RPProperty $request 'sha256') -cnotmatch '^[0-9a-f]{64}$') { $problems += 'sha256' }
    if ($problems.Count -gt 0) { throw ('The update request is not valid ({0}).' -f ($problems -join ', ')) }
    $request
}

function Get-RPFileSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RPAuthenticode {
    <# What Windows says about a file's signature. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = $null
    $issuer = $null
    if ($null -ne $signature.SignerCertificate) {
        $subject = $signature.SignerCertificate.Subject
        $issuer = $signature.SignerCertificate.Issuer
    }
    [pscustomobject]@{ Status = [string]$signature.Status; Subject = $subject; Issuer = $issuer }
}

function Test-RPInstallerSignature {
    <#
    .SYNOPSIS
        UPD-007: the installer must carry a valid Authenticode signature by the vendor (the
        publisher this installation's build named). A test build may take unsigned installers;
        a damaged signature never passes. The server applies the same rules
        (src/updates/authenticode.ts).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [AllowNull()] [AllowEmptyString()] [string] $Publisher,
        # UPDATE-S2: the authority that issued the signer's certificate; empty: not checked.
        [AllowNull()] [AllowEmptyString()] [string] $Issuer,
        [switch] $AllowUnsigned
    )
    $fail = { param($Reason) [pscustomobject]@{ Ok = $false; Signer = $null; Reason = $Reason } }
    if ([string]::IsNullOrEmpty($Publisher) -and -not $AllowUnsigned) {
        return (& $fail 'This installation cannot check an update''s signature: it was built without a code-signing certificate.')
    }
    $seen = Get-RPAuthenticode -Path $Path
    if ($seen.Status -eq 'Valid') {
        if ([string]::IsNullOrEmpty($Publisher) -or $seen.Subject -ceq $Publisher) {
            if (-not [string]::IsNullOrEmpty($Publisher) -and -not [string]::IsNullOrEmpty($Issuer) -and $seen.Issuer -cne $Issuer) {
                return (& $fail ('The installer''s certificate was issued by {0}, not by the vendor''s.' -f $seen.Issuer))
            }
            return [pscustomobject]@{ Ok = $true; Signer = $seen.Subject; Reason = $null }
        }
        return (& $fail ('The installer is signed by {0}, not by the vendor.' -f $seen.Subject))
    }
    if ($seen.Status -eq 'NotSigned') {
        if ($AllowUnsigned) { return [pscustomobject]@{ Ok = $true; Signer = $null; Reason = $null } }
        return (& $fail 'The installer is not signed.')
    }
    & $fail ('The installer''s signature is not valid ({0}).' -f $seen.Status)
}

function Get-RPInstallerVersion {
    <# The product version an installer's version resource names (electron-builder writes the build's version there), or $null. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    $version = (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($version)) { return $null }
    $version.Trim()
}

function Get-RPUpdatePolicy {
    <# The installation file's update settings; an older file checks nothing and allows nothing. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Installation)
    $updates = Get-RPProperty $Installation 'updates'
    [pscustomobject]@{
        Publisher     = [string](Get-RPProperty $updates 'publisher')
        Issuer        = [string](Get-RPProperty $updates 'issuer')
        AllowUnsigned = [bool](Get-RPProperty $updates 'allowUnsigned')
    }
}

function Invoke-RPInstallerProgram {
    <# Runs an installer silently and waits for it (and what it starts) to end; its exit code. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [string[]] $ArgumentList = @('/S')
    )
    $process = Start-Process -FilePath $Path -ArgumentList $ArgumentList -Wait -PassThru -WindowStyle Hidden
    [int]$process.ExitCode
}

function Get-RPTimestamp {
    [CmdletBinding()]
    param()
    (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Write-RPTextFile {
    <# Text to a file: UTF-8 without a byte order mark, or UTF-16 (with one). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Text,
        [switch] $Utf16
    )
    $encoding = New-Object System.Text.UTF8Encoding $false
    if ($Utf16) { $encoding = [System.Text.Encoding]::Unicode }
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Write-RPJsonFile {
    <# JSON in UTF-8 without a byte order mark, written beside the file, then moved over it. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] $Value
    )
    $folder = Split-Path -Parent $Path
    if ($folder -and -not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    Write-RPTextFile -Path ('{0}.new' -f $Path) -Text ($Value | ConvertTo-Json -Depth 5 -Compress)
    Move-Item -LiteralPath ('{0}.new' -f $Path) -Destination $Path -Force
}

function Wait-RPHealthyServer {
    <#
    .SYNOPSIS
        The health check after an update (UPD-005): `setup-cli health` says the service host
        runs the server and it answers its health check over TLS, with the version expected;
        then it stays so for StableSeconds: the same server process, no restart.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Cli,
        [Parameter(Mandatory)] [string] $InstallationFile,
        [Parameter(Mandatory)] [string] $Version,
        [int] $TimeoutSeconds = 600,
        [int] $StableSeconds = 120,
        [ValidateRange(1, 60)] [int] $IntervalSeconds = 5
    )
    $first = $null
    $steady = 0
    $last = 'no answer'
    $checks = [Math]::Ceiling($TimeoutSeconds / $IntervalSeconds)
    for ($check = 0; $check -le $checks; $check++) {
        $result = Invoke-RPProgram -FilePath $Cli.Node -ArgumentList @($Cli.Script, 'health', '--installation', $InstallationFile)
        $report = $null
        try { $report = $result.Output | ConvertFrom-Json } catch { $report = $null }
        $installed = [string](Get-RPProperty $report 'productVersion')
        if ($result.ExitCode -eq 0 -and $installed -eq $Version) {
            if ($null -eq $first) {
                $first = $report
                Write-RPLog ('Version {0} answers its health check.' -f $Version)
            } elseif ((Get-RPProperty $report 'serverPid') -ne (Get-RPProperty $first 'serverPid') -or (Get-RPProperty $report 'restarts') -ne (Get-RPProperty $first 'restarts')) {
                return [pscustomobject]@{ Healthy = $false; Reason = ('Version {0} answered, then its server restarted (it crashed).' -f $Version) }
            }
            if ($steady * $IntervalSeconds -ge $StableSeconds) {
                return [pscustomobject]@{ Healthy = $true; Reason = $null }
            }
            $steady++
        } else {
            if ($null -ne $first) {
                return [pscustomobject]@{ Healthy = $false; Reason = ('Version {0} answered, then stopped answering its health check.' -f $Version) }
            }
            if ($null -ne $report) {
                $last = 'version {0}, server {1}, health {2}' -f $installed, (Get-RPProperty $report 'phase'), (Get-RPProperty $report 'health')
                $hostError = Get-RPProperty $report 'lastError'
                if ($hostError) { $last = '{0}: {1}' -f $last, $hostError }
            } elseif ($result.Output) {
                $last = $result.Output
            }
        }
        if ($check -lt $checks) { Start-Sleep -Seconds $IntervalSeconds }
    }
    [pscustomobject]@{ Healthy = $false; Reason = ('Version {0} did not pass its health check within {1} seconds ({2}).' -f $Version, $TimeoutSeconds, $last) }
}

function Invoke-RPUpdateRollback {
    <#
    .SYNOPSIS
        Goes back to the version that ran before (UPD-005): asks for the database copied before
        the update (ProgramData\RestaurantPlatform\update-rollback.json), then runs that version's
        installer, whose service host switches the copy back in before its server starts. Returns
        $null when the old version runs again with its database, else what went wrong.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataDir,
        [Parameter(Mandatory)] [string] $InstallDir,
        [Parameter(Mandatory)] [string] $InstallationFile,
        [Parameter(Mandatory)] [string] $RequestId,
        [Parameter(Mandatory)] [string] $FailedVersion,
        [Parameter(Mandatory)] [string] $PreviousVersion,
        [Parameter(Mandatory)] [string] $PreviousInstaller,
        [int] $HealthTimeoutSeconds = 600,
        [int] $StableSeconds = 120
    )
    $paths = Get-RPUpdaterPath -ProgramDataDir (Get-RPParentPath $InstallationFile)
    # Written by the service host; only read here.
    $outcomeFile = Join-RPPath $DataDir 'backups', 'update-rollback-outcome.json'
    Write-RPJsonFile -Path $paths.RollbackFile -Value ([ordered]@{ format = 1; requestId = $RequestId; version = $FailedVersion; requestedAt = (Get-RPTimestamp) })
    Write-RPLog ('Going back to version {0}.' -f $PreviousVersion)
    try {
        $code = Invoke-RPInstallerProgram -Path $PreviousInstaller
        if ($code -ne 0) {
            return ('the installer of version {0} ended with {1}' -f $PreviousVersion, $code)
        }
        $health = Wait-RPHealthyServer -Cli (Get-RPSetupCli -InstallDir $InstallDir) -InstallationFile $InstallationFile -Version $PreviousVersion -TimeoutSeconds $HealthTimeoutSeconds -StableSeconds $StableSeconds
        if (-not $health.Healthy) { return $health.Reason }
        $rollback = $null
        if (Test-Path -LiteralPath $outcomeFile) {
            try { $rollback = Read-RPTextFile -Path $outcomeFile | ConvertFrom-Json } catch { $rollback = $null }
        }
        if ([string](Get-RPProperty $rollback 'requestId') -ne $RequestId) {
            return 'the database was not switched back (the server did not run the rollback)'
        }
        if (-not [bool](Get-RPProperty $rollback 'ok')) {
            $why = [string](Get-RPProperty $rollback 'error')
            if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
            return ('version {0} runs, but on the database the update changed: {1}' -f $PreviousVersion, $why)
        }
        Write-RPLog ('Version {0} runs again with the database from before the update; the failed version''s database is kept for support.' -f $PreviousVersion)
        $null
    } finally {
        # Run once: the service host has acted on it, or the installer did not get that far.
        if (Test-Path -LiteralPath $paths.RollbackFile) { Remove-Item -LiteralPath $paths.RollbackFile -Force }
    }
}

function Invoke-RPUpdate {
    <#
    .SYNOPSIS
        Installs the update the server asked for, and goes back when it fails (UPD-005, UPD-007).

    .DESCRIPTION
        Runs as SYSTEM from the updater's scheduled task, which the watchdog starts when the
        server leaves <data>\run\update-request.json; the server has downloaded and checked the
        installer and made a full backup. Each request runs once: its id is kept in
        ProgramData\RestaurantPlatform\updater\taken.json, and the outcome says RUNNING until the
        end. A request taken before whose run never ended (the PC restarted) ends as FAILED. Then:
        1. the installer is copied to ProgramData\RestaurantPlatform\installers (administrators
           only) and checked there: SHA-256 and Authenticode, against the publisher this
           installation names; the version must be newer than the installed one;
        2. the installer of the installed version must be there, to go back to;
        3. the maintenance flag, the watchdog and the server stopped, the database copied
           (setup-cli update-snapshot create);
        4. the installer runs silently; the new version must pass its health check;
        5. healthy: the copy is dropped and older installers removed. Not: the previous version's
           installer runs again and its service host switches the database copy back in.
        The outcome goes to ProgramData\RestaurantPlatform\update-outcome.json for the server to
        report, and is returned. Nothing is written or deleted in the data folder.
        ForceHealthCheckFailure fails step 4 on purpose (scenario S9 in CI).
    #>
    [CmdletBinding()]
    param(
        [string] $InstallationFile = (Get-RPDefaultInstallationFile),
        [switch] $ForceHealthCheckFailure,
        [int] $HealthTimeoutSeconds = 600,
        [int] $StableSeconds = 120,
        [string] $LogFile
    )
    Assert-RPAdministrator
    $installation = Read-RPInstallationFile -Path $InstallationFile
    if ($null -eq $installation) { throw ('There is no installation file at {0}.' -f $InstallationFile) }
    $dataDir = ([string]$installation.dataDir).TrimEnd('\')
    $installDir = ([string]$installation.installDir).TrimEnd('\')
    $current = [string]$installation.productVersion
    $paths = Get-RPUpdaterPath -ProgramDataDir (Get-RPParentPath $InstallationFile)
    $requestFile = Join-RPPath $dataDir 'run', 'update-request.json'
    if (-not (Test-Path -LiteralPath $requestFile)) {
        Write-RPLog 'No update is waiting.'
        return $null
    }
    $json = Read-RPTextFile -Path $requestFile
    $requestId = ''
    $version = ''
    try {
        $raw = $json.TrimStart([char]0xFEFF) | ConvertFrom-Json
        # Only what looks like an id and a version goes into the outcome the server reads.
        $id = [string](Get-RPProperty $raw 'requestId')
        if ($id -match '^[0-9a-fA-F-]{36}$') { $requestId = $id }
        $named = [string](Get-RPProperty $raw 'version')
        if ($named -match $script:SemVer) { $version = $named }
    } catch {
        Write-RPLog 'The update request could not be read.'
    }
    $outcome = [ordered]@{
        format          = 1
        requestId       = $requestId
        version         = $version
        previousVersion = $current
        outcome         = 'RUNNING'
        error           = $null
        startedAt       = (Get-RPTimestamp)
        finishedAt      = $null
        logFile         = $null
    }
    if ($LogFile) { $outcome.logFile = $LogFile }

    # Each request once.
    $taken = $null
    if (Test-Path -LiteralPath $paths.TakenFile) {
        try { $taken = Read-RPTextFile -Path $paths.TakenFile | ConvertFrom-Json } catch { $taken = $null }
    }
    if ($requestId -ne '' -and [string](Get-RPProperty $taken 'requestId') -eq $requestId) {
        $last = $null
        if (Test-Path -LiteralPath $paths.OutcomeFile) {
            try { $last = Read-RPTextFile -Path $paths.OutcomeFile | ConvertFrom-Json } catch { $last = $null }
        }
        if ([string](Get-RPProperty $last 'requestId') -eq $requestId -and [string](Get-RPProperty $last 'outcome') -ne 'RUNNING') {
            Write-RPLog ('The update request {0} was handled already.' -f $requestId)
            return $null
        }
        $outcome.outcome = 'FAILED'
        $outcome.error = 'The updater was interrupted (the PC restarted?) and did not finish this update. Check the PC, then run the installer of the version wanted, or ask support.'
        $outcome.startedAt = [string](Get-RPProperty $taken 'takenAt')
        if (-not $outcome.startedAt) { $outcome.startedAt = Get-RPTimestamp }
        $outcome.finishedAt = Get-RPTimestamp
        Write-RPJsonFile -Path $paths.OutcomeFile -Value $outcome
        Write-RPLog $outcome.error
        return [pscustomobject]$outcome
    }
    if ($requestId -ne '') {
        Write-RPJsonFile -Path $paths.TakenFile -Value ([ordered]@{ requestId = $requestId; takenAt = $outcome.startedAt })
    }
    Write-RPJsonFile -Path $paths.OutcomeFile -Value $outcome

    $steps = @{
        DataDir          = $dataDir
        InstallDir       = $installDir
        InstallationFile = $InstallationFile
        Current          = $current
        Json             = $json
        Installation     = $installation
        Force            = [bool]$ForceHealthCheckFailure
        HealthTimeout    = $HealthTimeoutSeconds
        Stable           = $StableSeconds
    }
    try {
        $result = Invoke-RPUpdateStep @steps
        $outcome.outcome = $result.Outcome
        $outcome.error = $result.Error
    } catch {
        $outcome.outcome = 'FAILED'
        $outcome.error = ('The updater stopped: {0}' -f $_)
    } finally {
        # Whatever happened, the watchdog looks after the services again.
        try {
            $null = Invoke-RPSetupCli -Cli (Get-RPSetupCli -InstallDir $installDir) -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'off')
        } catch {
            Write-RPLog ('Could not lift the maintenance flag (it lapses by itself): {0}' -f $_)
        }
    }
    $outcome.finishedAt = Get-RPTimestamp
    if ($null -ne $outcome.error -and $outcome.error.Length -gt 1000) { $outcome.error = $outcome.error.Substring(0, 1000) }
    Write-RPJsonFile -Path $paths.OutcomeFile -Value $outcome
    Write-RPLog ('The update to {0} ended: {1}{2}' -f $outcome.version, $outcome.outcome, $(if ($outcome.error) { ': ' + $outcome.error } else { '' }))
    [pscustomobject]$outcome
}

function Invoke-RPUpdateStep {
    <# Invoke-RPUpdate's steps; returns the outcome and the reason. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataDir,
        [Parameter(Mandatory)] [string] $InstallDir,
        [Parameter(Mandatory)] [string] $InstallationFile,
        [Parameter(Mandatory)] [string] $Current,
        [Parameter(Mandatory)] [string] $Json,
        [Parameter(Mandatory)] $Installation,
        [bool] $Force,
        [int] $HealthTimeout = 600,
        [int] $Stable = 120
    )
    $failed = { param($Reason) [pscustomobject]@{ Outcome = 'FAILED'; Error = $Reason } }
    try {
        $request = ConvertTo-RPUpdateRequest -Json $Json
    } catch {
        return (& $failed ('{0} Nothing was changed.' -f $_))
    }
    $version = [string]$request.version
    if ((Compare-RPVersion -Left $version -Right $Current) -le 0) {
        return (& $failed ('Version {0} is not newer than the installed {1}. Nothing was changed.' -f $version, $Current))
    }
    Write-RPLog ('Updating from version {0} to {1}.' -f $Current, $version)

    # 1. The installer, copied where only administrators write, and checked there.
    $folders = Get-RPUpdaterPath -ProgramDataDir (Get-RPParentPath $InstallationFile)
    if (-not (Test-Path -LiteralPath $folders.InstallersDir)) {
        Set-RPFolderPermission -Plan (Get-RPUpdaterAclPlan -ProgramDataDir (Get-RPParentPath $InstallationFile))
    }
    $installer = Join-RPPath $folders.InstallersDir (Get-RPInstallerFileName $version)
    $download = Join-RPPath $DataDir 'updates', ([string]$request.fileName)
    if (-not (Test-Path -LiteralPath $download)) {
        return (& $failed ('The downloaded installer {0} is not there. Nothing was changed.' -f $download))
    }
    Copy-Item -LiteralPath $download -Destination $installer -Force
    if ((Get-RPFileSha256 -Path $installer) -ne [string]$request.sha256) {
        Remove-Item -LiteralPath $installer -Force
        return (& $failed 'The installer does not match the SHA-256 the server checked. Nothing was changed.')
    }
    $policy = Get-RPUpdatePolicy -Installation $Installation
    $signature = Test-RPInstallerSignature -Path $installer -Publisher $policy.Publisher -Issuer $policy.Issuer -AllowUnsigned:$policy.AllowUnsigned
    if (-not $signature.Ok) {
        Remove-Item -LiteralPath $installer -Force
        return (& $failed ('{0} Nothing was changed.' -f $signature.Reason))
    }
    if ($signature.Signer) { Write-RPLog ('The installer is signed by {0}.' -f $signature.Signer) }
    # UPD-002: the installer is the version asked for, not an older signed one under its name.
    $productVersion = Get-RPInstallerVersion -Path $installer
    if ($productVersion -cne $version) {
        Remove-Item -LiteralPath $installer -Force
        $named = 'no version'
        if ($productVersion) { $named = 'version {0}' -f $productVersion }
        return (& $failed ('The installer installs {0}, not version {1} as asked. Nothing was changed.' -f $named, $version))
    }

    # 2. The way back.
    $previous = Join-RPPath $folders.InstallersDir (Get-RPInstallerFileName $Current)
    if (-not (Test-Path -LiteralPath $previous)) {
        return (& $failed ('The installer of the installed version {0} is not kept in {1}, so a failed update could not go back. Nothing was changed; run that installer once to keep it, or ask support.' -f $Current, $folders.InstallersDir))
    }

    # 3. The services stopped and the database copied.
    $cli = Get-RPSetupCli -InstallDir $InstallDir
    $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('maintenance', 'on', '--minutes', '240', '--reason', ('update to {0}' -f $version))
    try {
        Stop-RPService -Name $script:Services.Watchdog
        Stop-RPService -Name $script:Services.Server
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('update-snapshot', 'create')
    } catch {
        $reason = [string]$_
        Write-RPLog ('The update cannot go ahead: {0}' -f $reason)
        try {
            Start-RPService -Name $script:Services.Server
            Start-RPService -Name $script:Services.Watchdog
        } catch {
            Write-RPLog ('Starting the services again failed: {0}' -f $_)
        }
        return (& $failed ('{0} Nothing was changed.' -f $reason))
    }

    # 4. The installer, then the health check.
    Write-RPLog ('Running the installer of version {0}.' -f $version)
    $code = Invoke-RPInstallerProgram -Path $installer
    if ($code -eq 2) {
        # The installed version's files could not be replaced; the installer started it again.
        try { $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('update-snapshot', 'drop') } catch { Write-RPLog ('Could not drop the database copy: {0}' -f $_) }
        return (& $failed ('The installed version''s files could not be replaced, so version {0} carries on. Restart the PC and try again.' -f $Current))
    }
    $reason = $null
    if ($code -ne 0) {
        $reason = 'The installer of version {0} failed (exit {1}).' -f $version, $code
    } elseif ($Force) {
        $reason = 'The health check was made to fail on purpose (scenario S9).'
    } else {
        $health = Wait-RPHealthyServer -Cli (Get-RPSetupCli -InstallDir $InstallDir) -InstallationFile $InstallationFile -Version $version -TimeoutSeconds $HealthTimeout -StableSeconds $Stable
        if (-not $health.Healthy) { $reason = $health.Reason }
    }

    # 5. Done, or back.
    if ($null -eq $reason) {
        try {
            $null = Invoke-RPSetupCli -Cli (Get-RPSetupCli -InstallDir $InstallDir) -InstallationFile $InstallationFile -ArgumentList @('update-snapshot', 'drop')
        } catch {
            Write-RPLog ('Could not drop the database copy (it can be dropped later): {0}' -f $_)
        }
        Remove-RPOldInstaller -InstallersDir $folders.InstallersDir -Keep @($version, $Current)
        Write-RPLog ('Version {0} is installed and healthy.' -f $version)
        return [pscustomobject]@{ Outcome = 'INSTALLED'; Error = $null }
    }
    Write-RPLog ('The update failed: {0}' -f $reason)
    $rollback = @{
        DataDir              = $DataDir
        InstallDir           = $InstallDir
        InstallationFile     = $InstallationFile
        RequestId            = [string]$request.requestId
        FailedVersion        = $version
        PreviousVersion      = $Current
        PreviousInstaller    = $previous
        HealthTimeoutSeconds = $HealthTimeout
        StableSeconds        = $Stable
    }
    $back = Invoke-RPUpdateRollback @rollback
    if ($null -eq $back) {
        return [pscustomobject]@{ Outcome = 'ROLLED_BACK'; Error = $reason }
    }
    & $failed ('{0} Going back to version {1} failed too: {2}. Call support.' -f $reason, $Current, $back)
}

function Get-RPExitCode {
    <# The exit code for a failure: 3 when deleting the data was not allowed, else 1. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $ErrorRecord)
    $exception = $ErrorRecord.Exception
    if ($null -ne $exception -and $exception.Data.Contains('RPExitCode')) { return [int]$exception.Data['RPExitCode'] }
    $script:ExitCodes.Failed
}

Export-ModuleMember -Function @(
    'Add-RPFirewallRule',
    'Compare-RPVersion',
    'ConvertTo-RPUpdateRequest',
    'Get-RPAuthenticode',
    'Get-RPFileSha256',
    'Get-RPInstallerFile',
    'Get-RPParentPath',
    'Get-RPInstallerFileName',
    'Get-RPInstallerVersion',
    'Get-RPProperty',
    'Get-RPUpdatePolicy',
    'Get-RPUpdaterAclPlan',
    'Get-RPUpdaterPath',
    'Get-RPUpdateTaskXml',
    'Get-RPWindowsPowerShell',
    'Invoke-RPInstallerProgram',
    'Invoke-RPUpdate',
    'Invoke-RPUpdateRollback',
    'Invoke-RPUpdateStep',
    'Register-RPUpdateTask',
    'Remove-RPOldInstaller',
    'Save-RPInstaller',
    'Test-RPInstallerSignature',
    'Unregister-RPUpdateTask',
    'Wait-RPHealthyServer',
    'Write-RPJsonFile',
    'Write-RPTextFile',
    'Assert-RPAdministrator',
    'Assert-RPDataDir',
    'Assert-RPDeletableDataDir',
    'Assert-RPProgramResult',
    'ConvertTo-RPBusType',
    'ConvertTo-RPDriveChoiceIni',
    'ConvertTo-RPDriveLetter',
    'ConvertTo-RPList',
    'ConvertTo-RPRemoteAddress',
    'Get-RPCurrentUserSid',
    'Get-RPDataDriveChoice',
    'Get-RPDefaultInstallationFile',
    'Get-RPDriveRefusal',
    'Get-RPDriveRefusalMessage',
    'Get-RPDriveText',
    'Get-RPExitCode',
    'Get-RPExplicitAceSid',
    'Get-RPExtraAceSid',
    'Get-RPProtectedConflict',
    'Get-RPProtectedFolder',
    'Get-RPFirewallRuleSpec',
    'Get-RPFolderAclPlan',
    'Get-RPIcaclsArgument',
    'Get-RPInstallationPath',
    'Get-RPServiceInfo',
    'Get-RPServiceSid',
    'Get-RPSetupCli',
    'Get-RPVolume',
    'Get-RPWriteInstallationArgument',
    'Install-RPWinSWService',
    'Invoke-RPInstall',
    'Invoke-RPProgram',
    'Invoke-RPSetupCli',
    'Invoke-RPStart',
    'Invoke-RPStop',
    'Invoke-RPUninstall',
    'Join-RPPath',
    'Read-RPInstallationFile',
    'Read-RPTextFile',
    'Remove-RPFirewallRule',
    'Remove-RPFolder',
    'Remove-RPService',
    'Set-RPFirewallRule',
    'Set-RPFolderPermission',
    'Get-RPWindowsPowerShellModulePath',
    'Select-RPExistingGrant',
    'Get-RPMissingServiceSid',
    'Set-RPServiceRecovery',
    'Start-RPLog',
    'Start-RPService',
    'Stop-RPService',
    'Test-RPDataDeletionAllowed',
    'Wait-RPServerRunning',
    'Wait-RPServiceState',
    'Write-RPLog'
)
