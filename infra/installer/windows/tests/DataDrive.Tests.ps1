BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
}

Describe '[ONB-002] [DATA-001] choosing the data drive' {
    It 'defaults to the first local disk other than the system drive' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'c:' -Volume @(
            (New-TestVolume 'C:' -FreeGB 80),
            (New-TestVolume 'E:' -FreeGB 300),
            (New-TestVolume 'D:' -FreeGB 150 -Label 'Data')
        )
        $choice.Default | Should -Be 'D:'
        $choice.DataDir | Should -Be 'D:\RestaurantPlatform'
        $choice.Warning | Should -BeNullOrEmpty
        $choice.MinFreeGB | Should -Be 20
        @($choice.Drives.Letter) | Should -Be @('C:', 'D:', 'E:')
        ($choice.Drives | Where-Object Letter -EQ 'C:').System | Should -BeTrue
        $d = $choice.Drives | Where-Object Letter -EQ 'D:'
        $d.Eligible | Should -BeTrue
        $d.Reason | Should -BeNullOrEmpty
        $d.FreeGB | Should -Be 150
        $d.Label | Should -Be 'Data'
    }

    It 'uses the system drive, with a warning, when it is the only disk that fits' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:' -FreeGB 120),
            (New-TestVolume 'D:' -FreeGB 12)
        )
        $choice.Default | Should -Be 'C:'
        $choice.DataDir | Should -Be 'C:\RestaurantPlatform'
        $choice.Warning | Should -Be 'SYSTEM_DRIVE'
    }

    It 'refuses network, removable, USB, card, optical and file-backed drives' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:'),
            (New-TestVolume 'N:' -DriveType 4 -BusType $null -FileSystem 'NTFS'),
            (New-TestVolume 'I:' -BusType 'iSCSI'),
            (New-TestVolume 'R:' -DriveType 2 -BusType 'USB' -FileSystem 'FAT32'),
            (New-TestVolume 'U:' -BusType 'USB'),
            (New-TestVolume 'V:' -BusType 7),
            (New-TestVolume 'S:' -BusType 'SD'),
            (New-TestVolume 'F:' -BusType 'File Backed Virtual'),
            (New-TestVolume 'Z:' -DriveType 5 -BusType $null -FileSystem 'CDFS')
        )
        $reasons = @{}
        foreach ($drive in $choice.Drives) { $reasons[$drive.Letter] = $drive.Reason }
        $reasons['N:'] | Should -Be 'NETWORK'
        $reasons['I:'] | Should -Be 'NETWORK'
        $reasons['R:'] | Should -Be 'REMOVABLE'
        $reasons['U:'] | Should -Be 'REMOVABLE'
        $reasons['V:'] | Should -Be 'REMOVABLE'
        $reasons['S:'] | Should -Be 'REMOVABLE'
        $reasons['F:'] | Should -Be 'REMOVABLE'
        $reasons['Z:'] | Should -Be 'NOT_A_DISK'
        $reasons['C:'] | Should -BeNullOrEmpty
        $choice.Default | Should -Be 'C:'
    }

    It 'needs NTFS (or ReFS) for the folders'' permissions' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:'),
            (New-TestVolume 'D:' -FileSystem 'exFAT'),
            (New-TestVolume 'E:' -FileSystem 'FAT32'),
            (New-TestVolume 'F:' -FileSystem 'ReFS')
        )
        @($choice.Drives | Where-Object Reason -EQ 'FILE_SYSTEM' | ForEach-Object Letter) | Should -Be @('D:', 'E:')
        $choice.Default | Should -Be 'F:'
    }

    It 'needs the free space the setting asks for, in gigabytes as Windows Explorer counts them' {
        $volumes = @(
            (New-TestVolume 'C:'),
            (New-TestVolume 'D:' -FreeBytes (20GB - 1)),
            (New-TestVolume 'E:' -FreeBytes 20GB),
            (New-TestVolume 'F:' -FreeGB 60)
        )
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume $volumes
        ($choice.Drives | Where-Object Letter -EQ 'D:').Reason | Should -Be 'TOO_LITTLE_SPACE'
        $choice.Default | Should -Be 'E:'

        $stricter = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume $volumes -MinFreeGB 50
        $stricter.MinFreeGB | Should -Be 50
        $stricter.Default | Should -Be 'F:'
        ($stricter.Drives | Where-Object Letter -EQ 'E:').Reason | Should -Be 'TOO_LITTLE_SPACE'
    }

    It 'prefers the drive that has the data from an earlier installation' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:'),
            (New-TestVolume 'D:'),
            (New-TestVolume 'E:' -HasData $true)
        )
        $choice.Default | Should -Be 'E:'
        @($choice.DataFoundOn) | Should -Be @('E:')
    }

    It 'says when no drive can hold the data' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:' -FreeGB 5),
            (New-TestVolume 'U:' -BusType 'USB')
        )
        $choice.Default | Should -BeNullOrEmpty
        $choice.DataDir | Should -BeNullOrEmpty
        $choice.Warning | Should -Be 'NO_DRIVE'
    }

    It 'gives every refusal in words' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:' -FreeGB 12.34),
            (New-TestVolume 'N:' -DriveType 4),
            (New-TestVolume 'U:' -BusType 'USB'),
            (New-TestVolume 'Z:' -DriveType 5),
            (New-TestVolume 'X:' -FileSystem 'FAT32')
        )
        $messages = @{}
        foreach ($drive in $choice.Drives) { $messages[$drive.Letter] = Get-RPDriveRefusalMessage -Drive $drive -MinFreeGB 20 }
        $messages['C:'] | Should -Be 'C: has 12.3 GB free; the data needs at least 20 GB.'
        $messages['N:'] | Should -Match 'network drive'
        $messages['U:'] | Should -Match 'can be unplugged'
        $messages['Z:'] | Should -Match 'not a hard disk'
        $messages['X:'] | Should -Be 'X: is formatted FAT32. The data needs an NTFS drive.'
    }

    It 'checks a data folder the installer is given' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:'),
            (New-TestVolume 'D:'),
            (New-TestVolume 'U:' -BusType 'USB')
        )
        { Assert-RPDataDir -DataDir 'D:\Restaurant data' -Choice $choice } | Should -Not -Throw
        { Assert-RPDataDir -DataDir '\\nas\restaurant' -Choice $choice } | Should -Throw '*network folder*'
        { Assert-RPDataDir -DataDir 'D:\' -Choice $choice } | Should -Throw '*folder of its own*'
        { Assert-RPDataDir -DataDir 'Q:\Data' -Choice $choice } | Should -Throw '*not a drive on this PC*'
        { Assert-RPDataDir -DataDir 'U:\Data' -Choice $choice } | Should -Throw '*can be unplugged*'
        { Assert-RPDataDir -DataDir 'C:\Windows\RestaurantPlatform' -Choice $choice -Protected @('C:\Windows') } |
            Should -Throw '*Windows*'
    }

    It 'reads Get-Disk''s bus type given as a number or a name' {
        ConvertTo-RPBusType 7 | Should -Be 'USB'
        ConvertTo-RPBusType '17' | Should -Be 'NVMe'
        ConvertTo-RPBusType 'File Backed Virtual' | Should -Be 'FileBackedVirtual'
        ConvertTo-RPBusType 'SATA' | Should -Be 'SATA'
        ConvertTo-RPBusType 99 | Should -Be 'Bus99'
        ConvertTo-RPBusType $null | Should -Be ''
        ConvertTo-RPDriveLetter 'd:\data' | Should -Be 'D:'
        { ConvertTo-RPDriveLetter '\\nas\share' } | Should -Throw
    }
}

Describe '[ONB-002] the installer''s drive page' {
    It 'lists the drives that fit, with the default selected, and why the others do not' {
        $choice = Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @(
            (New-TestVolume 'C:' -FreeGB 80 -Label 'Windows'),
            (New-TestVolume 'D:' -FreeGB 412.5 -Label 'Data'),
            (New-TestVolume 'E:' -FreeGB 300 -HasData $true),
            (New-TestVolume 'U:' -BusType 'USB')
        )
        $ini = ConvertTo-RPDriveChoiceIni -Choice $choice
        $ini[0..6] | Should -Be @(
            '[Choice]', 'MinFreeGB=20', 'Default=E:', 'DefaultIndex=2', 'Warning=', 'EligibleCount=3', 'RefusedCount=1'
        )
        $ini | Should -Contain '[Eligible0]'
        $ini | Should -Contain 'Text=C: Windows (NTFS, 80 GB free), the Windows drive'
        $ini | Should -Contain 'Text=D: Data (NTFS, 412.5 GB free)'
        $ini | Should -Contain 'Text=E: (NTFS, 300 GB free), has the restaurant''s data'
        $ini | Should -Contain 'DataDir=E:\RestaurantPlatform'
        $ini[-4..-1] | Should -Be @(
            '[Refused0]', 'Letter=U:', 'Reason=REMOVABLE', 'Text=U: can be unplugged. The data must be on a disk inside this PC.'
        )
    }

    It 'says when only the system drive fits, and when nothing does' {
        $system = ConvertTo-RPDriveChoiceIni -Choice (Get-RPDataDriveChoice -SystemDrive 'C:' -Volume @((New-TestVolume 'C:' -FreeGB 50)))
        $system | Should -Contain 'Warning=SYSTEM_DRIVE'
        $system | Should -Contain 'DefaultIndex=0'
        $system | Should -Contain 'System=1'

        $none = ConvertTo-RPDriveChoiceIni -Choice (Get-RPDataDriveChoice -SystemDrive 'C:' -MinFreeGB 40 -Volume @((New-TestVolume 'C:' -FreeGB 10)))
        $none[0..6] | Should -Be @(
            '[Choice]', 'MinFreeGB=40', 'Default=', 'DefaultIndex=-1', 'Warning=NO_DRIVE', 'EligibleCount=0', 'RefusedCount=1'
        )
        $none | Should -Contain 'Text=C: has 10 GB free; the data needs at least 40 GB.'
    }
}
