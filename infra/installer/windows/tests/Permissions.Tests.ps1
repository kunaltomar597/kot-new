BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:System = 'S-1-5-18'
    $script:Admins = 'S-1-5-32-544'
    $script:Users = 'S-1-5-32-545'
    $script:NetworkService = 'S-1-5-20'
    $script:Database = Get-RPServiceSid 'RPDatabase'
    $script:Server = Get-RPServiceSid 'RPServer'
    $script:Plan = Get-RPFolderAclPlan -DataDir 'D:\RestaurantPlatform\' -ProgramDataDir 'C:\ProgramData\RestaurantPlatform'
    function Get-Entry([string] $Path) { $script:Plan | Where-Object Path -EQ $Path }
    function Get-Grant([string] $Path) {
        $grants = @{}
        foreach ($grant in (Get-Entry $Path).Grants) { $grants[$grant.Sid] = $grant.Rights }
        $grants
    }
}

Describe '[SEC-006] [SEC-007] [AUD-004] the folders'' permissions' {
    It 'leaves out the accounts of services that do not exist yet, never opening a folder further' {
        $first = @(Select-RPExistingGrant -Plan $script:Plan -MissingSid @($script:Server, $script:Database))
        # The secrets and the data folder: the owners only until the services exist.
        @((($first | Where-Object Path -EQ 'D:\RestaurantPlatform\secrets').Grants.Sid) | Sort-Object) |
            Should -Be @($script:System, $script:Admins | Sort-Object)
        ($first | Where-Object Path -EQ 'D:\RestaurantPlatform\secrets').Protect | Should -BeTrue
        # A folder that inherits and grants only to those accounts waits until they exist.
        $first.Path | Should -Not -Contain 'D:\RestaurantPlatform\backups'
        $first.Path | Should -Not -Contain 'D:\RestaurantPlatform\backups\wal-staging'
        # Every grant left was in the plan.
        foreach ($entry in $first) {
            $planned = @((Get-Entry $entry.Path).Grants | ForEach-Object { '{0}={1}' -f $_.Sid, $_.Rights })
            foreach ($grant in $entry.Grants) { $planned | Should -Contain ('{0}={1}' -f $grant.Sid, $grant.Rights) }
        }
        # With every account there, the plan is unchanged.
        $all = @(Select-RPExistingGrant -Plan $script:Plan -MissingSid @())
        ($all | ConvertTo-Json -Depth 4) | Should -Be (@($script:Plan | ForEach-Object { [pscustomobject]@{ Path = $_.Path; Protect = $_.Protect; Grants = @($_.Grants) } }) | ConvertTo-Json -Depth 4)
    }

    It 'names the server''s own account by the SID Windows gives it' {
        # sc.exe showsid TrustedInstaller
        Get-RPServiceSid 'TrustedInstaller' | Should -Be 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
        Get-RPServiceSid 'rpserver' | Should -Be $script:Server
        $script:Server | Should -Match '^S-1-5-80(-\d+){5}$'
    }

    It 'keeps the secrets to administrators, SYSTEM and the server, inheriting nothing' {
        $entry = Get-Entry 'D:\RestaurantPlatform\secrets'
        $entry.Protect | Should -BeTrue
        $grants = Get-Grant 'D:\RestaurantPlatform\secrets'
        @($grants.Keys | Sort-Object) | Should -Be @($script:Server, $script:System, $script:Admins | Sort-Object)
        $grants[$script:Server] | Should -Be '(OI)(CI)M'
    }

    It 'gives the data folder to the server, and lets PostgreSQL only pass through it' {
        $entry = Get-Entry 'D:\RestaurantPlatform'
        $entry.Protect | Should -BeTrue
        $grants = Get-Grant 'D:\RestaurantPlatform'
        $grants[$script:Server] | Should -Be '(OI)(CI)M'
        $grants[$script:Database] | Should -Be 'RX'
        $grants[$script:Admins] | Should -Be '(OI)(CI)F'
        $grants[$script:System] | Should -Be '(OI)(CI)F'
        $grants.ContainsKey($script:Users) | Should -BeFalse
    }

    It 'gives PostgreSQL its own folder, which the server may read but not change' {
        (Get-Entry 'D:\RestaurantPlatform\postgres').Protect | Should -BeTrue
        $grants = Get-Grant 'D:\RestaurantPlatform\postgres'
        $grants[$script:Database] | Should -Be '(OI)(CI)F'
        $grants[$script:Server] | Should -Be '(OI)(CI)RX'
    }

    It '[DATA-002] lets PostgreSQL hand its log files to the server for the continuous backup' {
        (Get-Grant 'D:\RestaurantPlatform\backups')[$script:Database] | Should -Be 'RX'
        (Get-Entry 'D:\RestaurantPlatform\backups\wal-staging').Protect | Should -BeFalse
        (Get-Grant 'D:\RestaurantPlatform\backups\wal-staging')[$script:Database] | Should -Be '(OI)(CI)M'
    }

    It 'lets everyone signed in read the CA the POS window pins, and the installation file' {
        (Get-Grant 'D:\RestaurantPlatform\tls')[$script:Users] | Should -Be '(OI)(CI)RX'
        $entry = Get-Entry 'C:\ProgramData\RestaurantPlatform'
        $entry.Protect | Should -BeTrue
        $grants = Get-Grant 'C:\ProgramData\RestaurantPlatform'
        $grants[$script:Users] | Should -Be '(OI)(CI)RX'
        $grants[$script:Server] | Should -Be '(OI)(CI)RX'
        $grants[$script:Admins] | Should -Be '(OI)(CI)F'
    }

    It '[PC-I6] runs PostgreSQL under its own account, never the shared Network Service' {
        $script:Database | Should -Match '^S-1-5-80(-\d+){5}$'
        $script:Database | Should -Not -Be $script:Server
        foreach ($entry in $script:Plan) {
            @($entry.Grants.Sid) | Should -Not -Contain $script:NetworkService
        }
    }

    It 'never lets ordinary users or everyone change anything' {
        foreach ($entry in $script:Plan) {
            foreach ($grant in $entry.Grants) {
                $grant.Sid | Should -Not -BeIn @('S-1-1-0', 'S-1-5-11')
                if ($grant.Sid -eq $script:Users) { $grant.Rights | Should -Be '(OI)(CI)RX' }
            }
        }
    }

    It 'writes icacls arguments that replace the folder''s own entries' {
        Get-RPIcaclsArgument -Entry (Get-Entry 'D:\RestaurantPlatform\secrets') | Should -Be @(
            'D:\RestaurantPlatform\secrets', '/inheritance:r', '/grant:r',
            "*$($script:System):(OI)(CI)F", "*$($script:Admins):(OI)(CI)F", "*$($script:Server):(OI)(CI)M", '/Q'
        )
        (Get-RPIcaclsArgument -Entry (Get-Entry 'D:\RestaurantPlatform\tls'))[1] | Should -Be '/inheritance:e'
    }

    It 'finds entries the plan does not name, also ones added by hand' {
        $entry = Get-Entry 'D:\RestaurantPlatform\secrets'
        Get-RPExtraAceSid -Entry $entry -ExplicitSid @($script:System, 'S-1-1-0', $script:Admins, 'S-1-5-21-1-2-3-1001', 'S-1-1-0') |
            Should -Be @('S-1-1-0', 'S-1-5-21-1-2-3-1001')
        @(Get-RPExtraAceSid -Entry $entry -ExplicitSid @()) | Should -HaveCount 0
    }
}

Describe '[SEC-007] setting the permissions' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $null = $script:Calls.Add(($FilePath + ' ' + ($ArgumentList -join ' ')))
            New-TestResult
        }
        # A folder made inside the data folder has only inherited entries.
        Mock -ModuleName $ModuleName Get-RPExplicitAceSid { @() }
        Mock -ModuleName $ModuleName Get-RPExplicitAceSid -ParameterFilter { $Path -like '*secrets' } {
            @('S-1-5-18', 'S-1-1-0', 'S-1-5-11')
        }
        $script:Data = Join-Path $TestDrive 'data'
        $script:TestPlan = Get-RPFolderAclPlan -DataDir $script:Data -ProgramDataDir (Join-Path $TestDrive 'programdata')
    }

    It 'makes each folder, sets the plan''s entries, then removes the others' {
        Set-RPFolderPermission -Plan $script:TestPlan
        foreach ($entry in $script:TestPlan) { Test-Path -LiteralPath $entry.Path | Should -BeTrue }
        $icacls = @($script:Calls | Where-Object { $_ -like 'icacls.exe *' })
        $icacls | Should -HaveCount ($script:TestPlan.Count + 1)
        $secrets = $script:TestPlan | Where-Object { $_.Path -like '*secrets' }
        $set = [array]::IndexOf($script:Calls.ToArray(), ('icacls.exe ' + ((Get-RPIcaclsArgument -Entry $secrets) -join ' ')))
        $removed = [array]::IndexOf($script:Calls.ToArray(), ('icacls.exe {0} /remove *S-1-1-0 /remove *S-1-5-11 /Q' -f $secrets.Path))
        $set | Should -BeGreaterOrEqual 0
        $removed | Should -Be ($set + 1)
    }

    It 'stops when icacls fails, saying which folder' {
        Mock -ModuleName $ModuleName Invoke-RPProgram { New-TestResult -ExitCode 5 -Output 'Access is denied.' }
        { Set-RPFolderPermission -Plan $script:TestPlan } | Should -Throw "*Setting the permissions of $($script:Data)*Access is denied.*"
    }
}
