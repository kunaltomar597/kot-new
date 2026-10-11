# The functions that touch Windows, run for real. CI runs them on windows-latest as an
# administrator; they change only a temporary folder and a firewall group of their own.

BeforeDiscovery {
    $script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
}

BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
}

Describe 'on Windows' -Tag 'Windows' -Skip:(-not $OnWindows) {
    It '[SEC-006] computes the service SID that sc.exe gives' {
        foreach ($name in @('RPServer', 'TrustedInstaller')) {
            $shown = (& sc.exe showsid $name | Out-String)
            $shown | Should -Match ([regex]::Escape((Get-RPServiceSid $name)))
        }
    }

    It '[ONB-002] lists this PC''s drives, the system drive a local NTFS disk among them' {
        $volumes = @(Get-RPVolume)
        $choice = Get-RPDataDriveChoice -Volume $volumes -SystemDrive $env:SystemDrive -MinFreeGB 1
        $system = $choice.Drives | Where-Object { $_.System }
        $system.Letter | Should -Be $env:SystemDrive
        $system.FileSystem | Should -Be 'NTFS'
        $system.Reason | Should -Not -Be 'NETWORK'
        $choice.Default | Should -Not -BeNullOrEmpty
    }

    It '[ONB-002] writes the drive page''s INI file in UTF-16, which Windows'' INI functions read' {
        $ini = Join-Path $TestDrive 'drives.ini'
        $script = Join-Path (Split-Path -Parent $PSScriptRoot) 'Get-DataDriveChoice.ps1'
        $json = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -MinFreeGB 1 -IniFile $ini
        $LASTEXITCODE | Should -Be 0
        ($json | Out-String | ConvertFrom-Json).Default | Should -Not -BeNullOrEmpty
        $bytes = [IO.File]::ReadAllBytes($ini)
        $bytes[0..1] | Should -Be @(0xFF, 0xFE)
        $text = [IO.File]::ReadAllText($ini, [Text.Encoding]::Unicode)
        $text | Should -Match '\[Choice\]'
        $text | Should -Match 'EligibleCount=[1-9]'
    }

    It '[ONB-001] runs in Windows PowerShell started from PowerShell 7, with its own Get-Acl' {
        # The installer started from a PowerShell 7 terminal: Windows PowerShell inherits PowerShell
        # 7's module folders first, as on the CI runner.
        $module = Join-Path (Split-Path -Parent $PSScriptRoot) 'RestaurantPlatform.Setup.psm1'
        $seven = @(Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PowerShell') -Filter 'Modules' -Recurse -Depth 1 -Directory -ErrorAction SilentlyContinue).FullName
        $saved = $env:PSModulePath
        try {
            $env:PSModulePath = (@($seven) + @($saved -split ';')) -join ';'
            $command = "Import-Module '$module'; (Get-Acl -LiteralPath `$env:SystemRoot).Owner"
            $owner = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command
            $LASTEXITCODE | Should -Be 0
            $owner | Should -Not -BeNullOrEmpty
        } finally {
            $env:PSModulePath = $saved
        }
    }

    It '[SEC-007] gives real folders exactly the planned entries, removing others' {
        # A service's virtual account exists once its service does (the installer makes the
        # services before it names their accounts): two throwaway services stand in for the
        # server's and the database's here.
        $names = @(('RPAclTestServer{0}' -f $PID), ('RPAclTestDatabase{0}' -f $PID))
        $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
        foreach ($name in $names) {
            & sc.exe create $name binPath= ('"{0}" /c exit 0' -f $cmd) start= demand | Out-Null
            $LASTEXITCODE | Should -Be 0
        }
        try {
            $data = Join-Path $TestDrive 'data'
            $programData = Join-Path $TestDrive 'programdata'
            $plan = Get-RPFolderAclPlan -DataDir $data -ProgramDataDir $programData `
                -ServerSid (Get-RPServiceSid $names[0]) -DatabaseSid (Get-RPServiceSid $names[1])
            Set-RPFolderPermission -Plan $plan
            # Someone opens the secrets to everyone; repair closes them again.
            $secrets = Join-Path $data 'secrets'
            & icacls.exe $secrets /grant '*S-1-1-0:(OI)(CI)R' /Q | Out-Null
            Set-RPFolderPermission -Plan $plan

            foreach ($entry in $plan) {
                $acl = Get-Acl -LiteralPath $entry.Path
                $acl.AreAccessRulesProtected | Should -Be ([bool]$entry.Protect)
                $own = @(Get-RPExplicitAceSid -Path $entry.Path | Sort-Object)
                $own | Should -Be @($entry.Grants.Sid | Sort-Object -Unique)
            }
            $everyone = @((Get-Acl -LiteralPath $secrets).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' })
            $everyone | Should -HaveCount 0
        } finally {
            foreach ($name in $names) { & sc.exe delete $name | Out-Null }
        }
    }

    It '[SEC-006] names no service account icacls cannot find yet, as on a new PC' {
        $data = Join-Path $TestDrive 'new-pc'
        $missing = @('RPAclTestMissing{0}' -f $PID)
        $plan = Get-RPFolderAclPlan -DataDir $data -ProgramDataDir (Join-Path $TestDrive 'new-pc-programdata') `
            -ServerSid (Get-RPServiceSid $missing[0]) -DatabaseSid (Get-RPServiceSid $missing[0])
        # The whole plan cannot be set before the service exists ...
        { Set-RPFolderPermission -Plan $plan } | Should -Throw '*1332*'
        # ... what the installer sets first can, and is closed to everyone but the owners.
        Set-RPFolderPermission -Plan (Select-RPExistingGrant -Plan $plan -MissingSid @(Get-RPServiceSid $missing[0]))
        @(Get-RPExplicitAceSid -Path (Join-Path $data 'secrets') | Sort-Object) | Should -Be @('S-1-5-18', 'S-1-5-32-544')
    }

    It '[SEC-008] adds the firewall rules in their group and removes them' {
        $group = 'Restaurant Platform test {0}' -f $PID
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { $node = Join-Path $env:SystemRoot 'System32\cmd.exe' }
        try {
            Set-RPFirewallRule -Group $group -Spec (Get-RPFirewallRuleSpec -Port 18080 -MqttPort 18883 -NodePath $node -Group $group)
            $rules = @(Get-NetFirewallRule -Group $group)
            $rules | Should -HaveCount 2
            $ports = @($rules | Get-NetFirewallPortFilter | ForEach-Object { $_.LocalPort } | Sort-Object)
            $ports | Should -Be @('18080', '18883')
            @($rules | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress } | Select-Object -Unique) | Should -Be @('LocalSubnet')
            # Repair leaves the same two.
            Set-RPFirewallRule -Group $group -Spec (Get-RPFirewallRuleSpec -Port 18080 -MqttPort 18883 -NodePath $node -Group $group)
            @(Get-NetFirewallRule -Group $group) | Should -HaveCount 2
        } finally {
            Remove-RPFirewallRule -Group $group
        }
        @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue) | Should -HaveCount 0
    }

    It 'runs programs, returning their exit code and output' {
        $result = Invoke-RPProgram -FilePath 'cmd.exe' -ArgumentList @('/c', 'echo out & echo err 1>&2 & exit 3')
        $result.ExitCode | Should -Be 3
        $result.Output | Should -Match 'out'
        $result.Output | Should -Match 'err'
    }

    It 'reads a service, and nothing for one that is not there' {
        $service = Get-RPServiceInfo -Name 'EventLog'
        $service.State | Should -Be 'Running'
        $service.ProcessId | Should -BeGreaterThan 0
        Get-RPServiceInfo -Name 'RPNoSuchService' | Should -BeNullOrEmpty
    }
}
