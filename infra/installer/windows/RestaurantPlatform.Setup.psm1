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
    NetworkService = 'S-1-5-20'
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
          Network Service may only pass through it to its own folders.
        - postgres: PostgreSQL's account (Network Service); the server may read it, not change it.
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
        [string] $ServerSid = (Get-RPServiceSid $script:Services.Server)
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
            Grants = $owners + @((New-RPGrant $ServerSid '(OI)(CI)M'), (New-RPGrant $sid.NetworkService 'RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'postgres'); Protect = $true
            Grants = $owners + @((New-RPGrant $sid.NetworkService '(OI)(CI)F'), (New-RPGrant $ServerSid '(OI)(CI)RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'backups'); Protect = $false
            Grants = @((New-RPGrant $sid.NetworkService 'RX'))
        },
        [pscustomobject]@{
            Path = (Join-RPPath $data 'backups', 'wal-staging'); Protect = $false
            Grants = @((New-RPGrant $sid.NetworkService '(OI)(CI)M'))
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
        6. The server and watchdog services; the firewall rules; the services started, and the
           server answering.
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

    $programDataDir = Split-Path -Parent $InstallationFile
    $plan = Get-RPFolderAclPlan -DataDir $DataDir -ProgramDataDir $programDataDir
    $early = @($plan | Where-Object { $_.Path -eq (Join-RPPath $DataDir 'secrets') -or $_.Path -eq $programDataDir.TrimEnd('\') })

    # 2. The installation file and the maintenance flag.
    Set-RPFolderPermission -Plan $early
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
        Set-RPFolderPermission -Plan $plan
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('postgres-register')
        Set-RPServiceRecovery -Name $script:Services.Database -Actions $script:DatabaseRecovery
        Start-RPService -Name $script:Services.Database
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('database')
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('migrate')

        # 6. The services and the firewall.
        $null = Invoke-RPSetupCli -Cli $cli -InstallationFile $InstallationFile -ArgumentList @('service-files')
        Install-RPWinSWService -Name $script:Services.Server -ServicesDir $paths.servicesDir -DependsOn $script:Services.Database -VirtualAccount
        Install-RPWinSWService -Name $script:Services.Watchdog -ServicesDir $paths.servicesDir
        $rules = Get-RPFirewallRuleSpec -Port $paths.ports.server -MqttPort $paths.ports.mqtt -NodePath $paths.node -StaffSubnet $StaffSubnet
        Set-RPFirewallRule -Spec $rules
        Write-RPLog ('Opened ports {0} and {1} to {2}.' -f $paths.ports.server, $paths.ports.mqtt, (@($rules[0].RemoteAddress) -join ', '))

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
    # The watchdog first, or it starts the others again.
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
    'Remove-RPFirewallRule',
    'Remove-RPFolder',
    'Remove-RPService',
    'Set-RPFirewallRule',
    'Set-RPFolderPermission',
    'Set-RPServiceRecovery',
    'Start-RPLog',
    'Start-RPService',
    'Stop-RPService',
    'Test-RPDataDeletionAllowed',
    'Wait-RPServerRunning',
    'Wait-RPServiceState',
    'Write-RPLog'
)
