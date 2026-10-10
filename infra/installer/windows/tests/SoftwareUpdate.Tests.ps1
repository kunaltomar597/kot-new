BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:InstallDir = 'C:\Program Files\Restaurant Platform'
    $script:ProgramDataDir = 'C:\ProgramData\RestaurantPlatform'
    $script:InstallationFile = 'C:\ProgramData\RestaurantPlatform\installation.json'
    $script:DataDir = 'D:\RestaurantPlatform'
    $script:Sha = 'ab' * 32
    $script:RequestId = '0199b0e0-0000-7000-8000-000000000001'

    function New-TestRequest {
        param([string] $Version = '1.2.0', [hashtable] $Change = @{})
        $request = [ordered]@{
            format            = 1
            requestId         = $script:RequestId
            version           = $Version
            previousVersion   = '1.1.0'
            fileName          = ('RestaurantPlatform-Setup-{0}.exe' -f $Version)
            sha256            = $script:Sha
            sizeBytes         = 1000
            securityCritical  = $false
            trigger           = 'WINDOW'
            approvedByStaffId = $null
            backupFileName    = 'rp-backup-20261005T213000Z-update.rpbk'
            requestedAt       = '2026-10-05T21:30:00.000Z'
        }
        foreach ($key in $Change.Keys) { $request[$key] = $Change[$key] }
        $request | ConvertTo-Json -Compress
    }

    function Get-Call([string] $Like) { @($script:Calls | Where-Object { $_ -like $Like }) }
    function Get-CallIndex([string] $Call) {
        $index = [array]::IndexOf($script:Calls.ToArray(), $Call)
        if ($index -lt 0) { throw "Not called: $Call" }
        $index
    }
}

Describe '[UPD-002] versions' {
    It 'orders semantic versions, a release after its pre-releases' {
        Compare-RPVersion -Left '1.2.0' -Right '1.1.9' | Should -Be 1
        Compare-RPVersion -Left '1.2.0' -Right '1.2.0' | Should -Be 0
        Compare-RPVersion -Left '1.10.0' -Right '1.9.0' | Should -Be 1
        Compare-RPVersion -Left '1.2.0-rc.1' -Right '1.2.0' | Should -Be -1
        Compare-RPVersion -Left '1.2.0-rc.2' -Right '1.2.0-rc.10' | Should -Be -1
        Compare-RPVersion -Left '1.2.0-rc.1' -Right '1.2.0-beta' | Should -Be 1
        Compare-RPVersion -Left '1.2.0-1' -Right '1.2.0-alpha' | Should -Be -1
        Compare-RPVersion -Left '1.2.0-rc' -Right '1.2.0-rc.1' | Should -Be -1
        { Compare-RPVersion -Left '1.2' -Right '1.2.0' } | Should -Throw '*not a version*'
    }
}

Describe '[UPD-007] the request and the installer' {
    It 'reads the server''s request, also with a byte order mark' {
        $request = ConvertTo-RPUpdateRequest -Json ([char]0xFEFF + (New-TestRequest))
        $request.version | Should -Be '1.2.0'
        $request.fileName | Should -Be 'RestaurantPlatform-Setup-1.2.0.exe'
    }

    It 'trusts nothing in it beyond its checks: no other file, hash or version' {
        { ConvertTo-RPUpdateRequest -Json (New-TestRequest -Change @{ fileName = '..\..\Windows\evil.exe' }) } | Should -Throw '*not valid (fileName)*'
        { ConvertTo-RPUpdateRequest -Json (New-TestRequest -Change @{ fileName = 'RestaurantPlatform-Setup-9.9.9.exe' }) } | Should -Throw '*not valid (fileName)*'
        { ConvertTo-RPUpdateRequest -Json (New-TestRequest -Change @{ sha256 = 'AB' * 32 }) } | Should -Throw '*not valid (sha256)*'
        { ConvertTo-RPUpdateRequest -Json (New-TestRequest -Change @{ version = 'latest' }) } | Should -Throw '*not valid (version)*'
        { ConvertTo-RPUpdateRequest -Json (New-TestRequest -Change @{ format = 2; requestId = 'x' }) } | Should -Throw '*not valid (format, requestId)*'
        { ConvertTo-RPUpdateRequest -Json '{"format":1}' } | Should -Throw '*not valid*'
    }

    It 'accepts only a valid signature by the vendor, or no signature on a test build' {
        $vendor = 'CN=Restaurant Platform Pvt Ltd, C=IN'
        $script:Seen = [pscustomobject]@{ Status = 'Valid'; Subject = $vendor }
        Mock -ModuleName $ModuleName Get-RPAuthenticode { $script:Seen }
        (Test-RPInstallerSignature -Path 'x.exe' -Publisher $vendor).Ok | Should -BeTrue
        $script:Seen = [pscustomobject]@{ Status = 'Valid'; Subject = 'CN=Someone Else' }
        (Test-RPInstallerSignature -Path 'x.exe' -Publisher $vendor).Reason | Should -Be 'The installer is signed by CN=Someone Else, not by the vendor.'
        $script:Seen = [pscustomobject]@{ Status = 'NotSigned'; Subject = $null }
        (Test-RPInstallerSignature -Path 'x.exe' -Publisher $vendor).Reason | Should -Be 'The installer is not signed.'
        (Test-RPInstallerSignature -Path 'x.exe' -AllowUnsigned).Ok | Should -BeTrue
        $script:Seen = [pscustomobject]@{ Status = 'HashMismatch'; Subject = $vendor }
        (Test-RPInstallerSignature -Path 'x.exe' -AllowUnsigned).Reason | Should -Be 'The installer''s signature is not valid (HashMismatch).'
        (Test-RPInstallerSignature -Path 'x.exe').Reason | Should -BeLike '*built without a code-signing certificate*'
        Should -Invoke -ModuleName $ModuleName Get-RPAuthenticode -Times 5 -Exactly
    }

    It 'reads an installation file from before updates as checking nothing and allowing nothing' {
        $policy = Get-RPUpdatePolicy -Installation ([pscustomobject]@{ dataDir = 'D:\x' })
        $policy.Publisher | Should -Be ''
        $policy.AllowUnsigned | Should -BeFalse
        $policy = Get-RPUpdatePolicy -Installation ([pscustomobject]@{ updates = [pscustomobject]@{ publisher = 'CN=A'; allowUnsigned = $false } })
        $policy.Publisher | Should -Be 'CN=A'
    }
}

Describe '[UPD-005] the updater''s scheduled task and the installers kept' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:Present = @()
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Test-Path { $script:Present -contains $LiteralPath }
        Mock -ModuleName $ModuleName New-Item { $null = $script:Calls.Add("make $Path") }
        Mock -ModuleName $ModuleName Copy-Item { $null = $script:Calls.Add("copy $LiteralPath to $Destination") }
        Mock -ModuleName $ModuleName Remove-Item { $null = $script:Calls.Add("remove $LiteralPath") }
        Mock -ModuleName $ModuleName Remove-RPFolder { $null = $script:Calls.Add("delete $Path") }
        Mock -ModuleName $ModuleName Write-RPTextFile {
            $script:TaskXml = $Text
            $null = $script:Calls.Add("write $Path utf16=$([bool]$Utf16)")
        }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $null = $script:Calls.Add(((@($FilePath) + $ArgumentList) -join ' '))
            New-TestResult
        }
    }

    It 'runs the updater from ProgramData as SYSTEM, one at a time, for at most four hours' {
        $xml = [xml](Get-RPUpdateTaskXml -ScriptPath 'C:\ProgramData\RestaurantPlatform\updater\Update-RestaurantPlatform.ps1' -PowerShell 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
        $task = $xml.Task
        $task.Principals.Principal.UserId | Should -Be 'S-1-5-18'
        $task.Principals.Principal.RunLevel | Should -Be 'HighestAvailable'
        $task.Settings.MultipleInstancesPolicy | Should -Be 'IgnoreNew'
        $task.Settings.ExecutionTimeLimit | Should -Be 'PT4H'
        $task.Settings.DisallowStartIfOnBatteries | Should -Be 'false'
        $task.RegistrationInfo.URI | Should -Be '\RestaurantPlatform\Update'
        # Nothing starts it on a schedule: only the watchdog does.
        $task.PSObject.Properties['Triggers'] | Should -BeNullOrEmpty
        $task.Actions.Exec.Command | Should -Be 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        $task.Actions.Exec.Arguments | Should -Be '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\RestaurantPlatform\updater\Update-RestaurantPlatform.ps1"'
        (Get-RPUpdateTaskXml -ScriptPath 'C:\a&b\u.ps1') | Should -Match 'C:\\a&amp;b\\u\.ps1'
    }

    It 'copies the updater where only administrators write, and registers its task' {
        Mock -ModuleName $ModuleName Set-RPFolderPermission {
            foreach ($entry in $Plan) {
                $grants = @($entry.Grants | ForEach-Object { '{0}:{1}' -f $_.Sid, $_.Rights }) -join ' '
                $null = $script:Calls.Add(('acl {0} protect={1} {2}' -f $entry.Path, $entry.Protect, $grants))
            }
        }
        Register-RPUpdateTask -SetupDir "$($script:InstallDir)\setup" -ProgramDataDir $script:ProgramDataDir
        @($script:Calls) | Should -Be @(
            'acl C:\ProgramData\RestaurantPlatform\updater protect=True S-1-5-18:(OI)(CI)F S-1-5-32-544:(OI)(CI)F',
            'acl C:\ProgramData\RestaurantPlatform\installers protect=True S-1-5-18:(OI)(CI)F S-1-5-32-544:(OI)(CI)F',
            "copy $($script:InstallDir)\setup\Update-RestaurantPlatform.ps1 to C:\ProgramData\RestaurantPlatform\updater\Update-RestaurantPlatform.ps1",
            "copy $($script:InstallDir)\setup\RestaurantPlatform.Setup.psm1 to C:\ProgramData\RestaurantPlatform\updater\RestaurantPlatform.Setup.psm1",
            'write C:\ProgramData\RestaurantPlatform\updater\update-task.xml utf16=True',
            'schtasks.exe /Create /TN \RestaurantPlatform\Update /XML C:\ProgramData\RestaurantPlatform\updater\update-task.xml /F'
        )
        $script:TaskXml | Should -Match 'C:\\ProgramData\\RestaurantPlatform\\updater\\Update-RestaurantPlatform\.ps1'
    }

    It 'removes the task on uninstall, also when it is already gone' {
        Mock -ModuleName $ModuleName Invoke-RPProgram { New-TestResult -ExitCode 1 -Output 'ERROR: The system cannot find the file specified.' }
        Unregister-RPUpdateTask -ProgramDataDir $script:ProgramDataDir
        Should -Invoke -ModuleName $ModuleName Remove-RPFolder -ParameterFilter { $Path -eq 'C:\ProgramData\RestaurantPlatform\updater' }
    }

    It 'keeps the installer that installed this version, once' {
        $script:Present = @('E:\RestaurantPlatform-Setup-1.1.0.exe')
        Save-RPInstaller -InstallerPath 'E:\RestaurantPlatform-Setup-1.1.0.exe' -ProductVersion '1.1.0' -ProgramDataDir $script:ProgramDataDir
        @($script:Calls) | Should -Be @(
            'make C:\ProgramData\RestaurantPlatform\installers',
            'copy E:\RestaurantPlatform-Setup-1.1.0.exe to C:\ProgramData\RestaurantPlatform\installers\RestaurantPlatform-Setup-1.1.0.exe'
        )
        # The updater runs the kept copy itself: nothing to copy.
        $script:Calls.Clear()
        Save-RPInstaller -InstallerPath 'C:\ProgramData\RestaurantPlatform\installers\RestaurantPlatform-Setup-1.2.0.exe' -ProductVersion '1.2.0' -ProgramDataDir $script:ProgramDataDir
        @($script:Calls) | Should -HaveCount 0
        Save-RPInstaller -InstallerPath 'E:\gone.exe' -ProductVersion '1.1.0' -ProgramDataDir $script:ProgramDataDir
        @($script:Calls) | Should -HaveCount 0
        Should -Invoke -ModuleName $ModuleName Write-RPLog -ParameterFilter { $Message -like 'Warning: the installer E:\gone.exe is not there*' }
    }

    It 'removes the installers of other versions after an update' {
        $script:Present = @('C:\ProgramData\RestaurantPlatform\installers')
        Mock -ModuleName $ModuleName Get-RPInstallerFile {
            foreach ($version in @('1.0.0', '1.1.0', '1.2.0')) {
                [pscustomobject]@{ Name = "RestaurantPlatform-Setup-$version.exe"; FullName = "C:\ProgramData\RestaurantPlatform\installers\RestaurantPlatform-Setup-$version.exe" }
            }
        }
        Remove-RPOldInstaller -InstallersDir 'C:\ProgramData\RestaurantPlatform\installers' -Keep @('1.2.0', '1.1.0')
        @($script:Calls) | Should -Be @('remove C:\ProgramData\RestaurantPlatform\installers\RestaurantPlatform-Setup-1.0.0.exe')
    }
}

Describe '[UPD-005] the health check after an update' {
    BeforeEach {
        $script:Answers = [System.Collections.Queue]::new()
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Start-Sleep {}
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $answer = $script:Last
            if ($script:Answers.Count -gt 0) { $answer = $script:Answers.Dequeue(); $script:Last = $answer }
            $answer
        }
        $script:Cli = Get-RPSetupCli -InstallDir $script:InstallDir
        function Add-Answer([string] $Version = '1.2.0', [int] $ExitCode = 0, [int] $ServerPid = 100, [int] $Restarts = 0, [string] $Phase = 'RUNNING', [string] $Health = 'ok', [int] $Times = 1) {
            $output = [ordered]@{ productVersion = $Version; health = $Health; phase = $Phase; serverPid = $ServerPid; restarts = $Restarts; lastError = $null } | ConvertTo-Json -Compress
            for ($i = 0; $i -lt $Times; $i++) { $script:Answers.Enqueue((New-TestResult -ExitCode $ExitCode -Output $output)) }
        }
        $script:Wait = @{ Cli = $script:Cli; InstallationFile = $script:InstallationFile; Version = '1.2.0'; TimeoutSeconds = 60; StableSeconds = 10; IntervalSeconds = 5 }
    }

    It 'passes once the new version answers and keeps answering with the same server' {
        Add-Answer -ExitCode 1 -Phase 'MIGRATING' -Health 'unanswered' -Times 2
        Add-Answer -Times 3
        $result = Wait-RPHealthyServer @script:Wait
        $result.Healthy | Should -BeTrue
        Should -Invoke -ModuleName $ModuleName Invoke-RPProgram -Times 5 -Exactly -ParameterFilter {
            $FilePath -eq 'C:\Program Files\Restaurant Platform\node\node.exe' -and $ArgumentList[1] -eq 'health'
        }
    }

    It 'fails a version that never answers, saying where it got to' {
        Add-Answer -Version '1.1.0' -Times 1
        Add-Answer -ExitCode 1 -Phase 'MIGRATING' -Health 'unanswered' -Times 1
        $result = Wait-RPHealthyServer @script:Wait
        $result.Healthy | Should -BeFalse
        $result.Reason | Should -Be 'Version 1.2.0 did not pass its health check within 60 seconds (version 1.2.0, server MIGRATING, health unanswered).'
    }

    It 'fails a server that crashes, or stops answering, after it first answered' {
        Add-Answer -Times 1
        Add-Answer -ServerPid 200 -Restarts 1
        (Wait-RPHealthyServer @script:Wait).Reason | Should -Be 'Version 1.2.0 answered, then its server restarted (it crashed).'
        $script:Answers.Clear()
        Add-Answer -Times 1
        Add-Answer -ExitCode 1 -Health 'degraded'
        (Wait-RPHealthyServer @script:Wait).Reason | Should -Be 'Version 1.2.0 answered, then stopped answering its health check.'
    }
}

Describe '[UPD-005] [UPD-007] installing an update, and going back when it fails' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:Installed = '1.1.0'
        $script:Healthy = @{ '1.1.0' = $true; '1.2.0' = $true }
        $script:InstallerCode = @{ '1.1.0' = 0; '1.2.0' = 0 }
        $script:FileSha = $script:Sha
        $script:Signature = [pscustomobject]@{ Status = 'NotSigned'; Subject = $null }
        # The version an installer's version resource names: by default the one in its name.
        $script:ProductVersion = @{}
        $script:Request = New-TestRequest
        $script:RollbackOk = $true
        $script:HostAnswers = $true
        $script:Fail = @{}
        $script:Written = @{}
        $script:Files = @{}
        $script:RequestFile = "$($script:DataDir)\run\update-request.json"
        $script:OutcomeFile = "$($script:ProgramDataDir)\update-outcome.json"
        $script:TakenFile = "$($script:ProgramDataDir)\updater\taken.json"
        $script:RollbackFile = "$($script:ProgramDataDir)\update-rollback.json"
        $script:HostOutcome = "$($script:DataDir)\backups\update-rollback-outcome.json"
        $script:Present = @(
            $script:RequestFile,
            "$($script:DataDir)\updates\RestaurantPlatform-Setup-1.2.0.exe",
            "$($script:ProgramDataDir)\installers",
            "$($script:ProgramDataDir)\installers\RestaurantPlatform-Setup-1.1.0.exe"
        )
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Start-Sleep {}
        Mock -ModuleName $ModuleName Get-RPTimestamp { '2026-10-05T21:31:00.000Z' }
        Mock -ModuleName $ModuleName Read-RPInstallationFile {
            [pscustomobject]@{
                installDir = $script:InstallDir; dataDir = $script:DataDir; productVersion = $script:Installed
                updates = [pscustomobject]@{ publisher = $null; allowUnsigned = $true }
            }
        }
        # Test-Path's -LiteralPath is a list.
        Mock -ModuleName $ModuleName Test-Path {
            $path = [string]$LiteralPath
            $script:Present -contains $path -or $script:Written.ContainsKey($path) -or $script:Files.ContainsKey($path)
        }
        Mock -ModuleName $ModuleName New-Item {}
        Mock -ModuleName $ModuleName Read-RPTextFile {
            if ($Path -eq $script:RequestFile) { return $script:Request }
            if ($script:Files.ContainsKey($Path)) { return $script:Files[$Path] }
            if ($script:Written.ContainsKey($Path)) { return ($script:Written[$Path] | ConvertTo-Json -Compress) }
            throw "nothing at $Path"
        }
        Mock -ModuleName $ModuleName Remove-Item { $null = $script:Calls.Add("remove $LiteralPath") }
        Mock -ModuleName $ModuleName Copy-Item { $null = $script:Calls.Add("copy $LiteralPath to $Destination") }
        Mock -ModuleName $ModuleName Get-RPInstallerFile { @() }
        Mock -ModuleName $ModuleName Get-RPFileSha256 { $script:FileSha }
        Mock -ModuleName $ModuleName Get-RPAuthenticode { $script:Signature }
        Mock -ModuleName $ModuleName Get-RPInstallerVersion {
            $named = ([regex]::Match($Path, 'Setup-(.+)\.exe$')).Groups[1].Value
            if ($script:ProductVersion.ContainsKey($named)) { return $script:ProductVersion[$named] }
            $named
        }
        Mock -ModuleName $ModuleName Set-RPFolderPermission { $null = $script:Calls.Add('acl') }
        Mock -ModuleName $ModuleName Stop-RPService { $null = $script:Calls.Add("stop $Name") }
        Mock -ModuleName $ModuleName Start-RPService { $null = $script:Calls.Add("start $Name") }
        Mock -ModuleName $ModuleName Write-RPJsonFile {
            $script:Written[$Path] = [pscustomobject]$Value
            $note = ''
            if ($Path -eq $script:OutcomeFile) { $note = ' ' + $Value.outcome }
            $null = $script:Calls.Add("write $Path$note")
        }
        Mock -ModuleName $ModuleName Invoke-RPInstallerProgram {
            $version = ([regex]::Match($Path, 'Setup-(.+)\.exe$')).Groups[1].Value
            $null = $script:Calls.Add("installer $version")
            $code = $script:InstallerCode[$version]
            if ($code -eq 0) { $script:Installed = $version }
            # The previous version's service host answers the rollback request before its server starts.
            if ($code -eq 0 -and $script:HostAnswers -and $script:Written.ContainsKey($script:RollbackFile)) {
                $request = $script:Written[$script:RollbackFile]
                $script:Files[$script:HostOutcome] = ([ordered]@{
                        requestId = $request.requestId; version = $request.version; ok = $script:RollbackOk
                        error = 'There is no copy of the database from before the update.'; failedDatabase = 'restaurant_failed_update'
                    } | ConvertTo-Json)
            }
            $code
        }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
            $name = $command[0]
            if ($name -eq 'health') {
                $healthy = $script:Healthy[$script:Installed]
                $code = 1
                if ($healthy) { $code = 0 }
                return New-TestResult -ExitCode $code -Output ([ordered]@{ productVersion = $script:Installed; health = 'ok'; phase = 'RUNNING'; serverPid = 7; restarts = 0; lastError = $null } | ConvertTo-Json -Compress)
            }
            $null = $script:Calls.Add('setup-cli ' + ($command -join ' '))
            if ($script:Fail.ContainsKey($name)) { return $script:Fail[$name] }
            New-TestResult
        }
        $script:Update = @{ InstallationFile = $script:InstallationFile; HealthTimeoutSeconds = 30; StableSeconds = 10; LogFile = 'C:\ProgramData\RestaurantPlatform\setup-logs\update.log' }
    }

    It 'installs a checked update, then drops the database copy and the older installers' {
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'INSTALLED'
        $result.error | Should -BeNullOrEmpty
        @($script:Calls) | Should -Be @(
            "write $($script:TakenFile)",
            "write $($script:OutcomeFile) RUNNING",
            "copy $($script:DataDir)\updates\RestaurantPlatform-Setup-1.2.0.exe to $($script:ProgramDataDir)\installers\RestaurantPlatform-Setup-1.2.0.exe",
            'setup-cli maintenance on --minutes 240 --reason update to 1.2.0',
            'stop RPWatchdog',
            'stop RPServer',
            'setup-cli update-snapshot create',
            'installer 1.2.0',
            'setup-cli update-snapshot drop',
            'setup-cli maintenance off',
            "write $($script:OutcomeFile) INSTALLED"
        )
        $outcome = $script:Written[$script:OutcomeFile]
        $outcome.requestId | Should -Be $script:RequestId
        $outcome.version | Should -Be '1.2.0'
        $outcome.previousVersion | Should -Be '1.1.0'
        $outcome.logFile | Should -Be 'C:\ProgramData\RestaurantPlatform\setup-logs\update.log'
        $outcome.startedAt | Should -Be '2026-10-05T21:31:00.000Z'
        $script:Written[$script:TakenFile].requestId | Should -Be $script:RequestId
    }

    It 'never writes or deletes in the data folder, which the server''s account controls' {
        $script:Healthy['1.2.0'] = $false
        Invoke-RPUpdate @script:Update | Out-Null
        @($script:Calls | Where-Object { ($_ -like 'write D:*') -or ($_ -like 'remove D:*') }) | Should -HaveCount 0
        @($script:Calls | Where-Object { $_ -like 'copy *' }) | ForEach-Object { $_ | Should -BeLike '* to C:\ProgramData\*' }
    }

    It 'goes back to the previous version and its database when the new one fails its health check' {
        $script:Healthy['1.2.0'] = $false
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'ROLLED_BACK'
        $result.error | Should -BeLike 'Version 1.2.0 did not pass its health check within 30 seconds*'
        $rollback = Get-CallIndex "write $($script:RollbackFile)"
        $rollback | Should -BeGreaterThan (Get-CallIndex 'installer 1.2.0')
        (Get-CallIndex 'installer 1.1.0') | Should -BeGreaterThan $rollback
        $script:Written[$script:RollbackFile].version | Should -Be '1.2.0'
        $script:Written[$script:RollbackFile].requestId | Should -Be $script:RequestId
        # Run once: removed when the service host has acted on it.
        (Get-CallIndex "remove $($script:RollbackFile)") | Should -BeGreaterThan (Get-CallIndex 'installer 1.1.0')
        Get-Call 'setup-cli update-snapshot drop' | Should -HaveCount 0
        $script:Installed | Should -Be '1.1.0'
    }

    It '[S9] fails the health check on purpose and rolls back, the restaurant keeping its version' {
        $result = Invoke-RPUpdate @script:Update -ForceHealthCheckFailure
        $result.outcome | Should -Be 'ROLLED_BACK'
        $result.error | Should -Be 'The health check was made to fail on purpose (scenario S9).'
        $script:Installed | Should -Be '1.1.0'
    }

    It 'goes back when the new installer fails' {
        $script:InstallerCode['1.2.0'] = 1
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'ROLLED_BACK'
        $result.error | Should -Be 'The installer of version 1.2.0 failed (exit 1).'
        Get-Call 'installer 1.1.0' | Should -HaveCount 1
    }

    It 'says so, and asks for support, when going back fails too' {
        $script:Healthy['1.2.0'] = $false
        $script:InstallerCode['1.1.0'] = 1
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike '*Going back to version 1.1.0 failed too: the installer of version 1.1.0 ended with 1. Call support.'
        Get-Call "remove $($script:RollbackFile)" | Should -HaveCount 1
    }

    It 'reports a version that runs again on the database the update changed' {
        $script:Healthy['1.2.0'] = $false
        $script:RollbackOk = $false
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike '*version 1.1.0 runs, but on the database the update changed: There is no copy*'
    }

    It 'does not trust a rollback outcome left from another request' {
        $script:Healthy['1.2.0'] = $false
        $script:HostAnswers = $false
        $script:Files[$script:HostOutcome] = '{"requestId":"older","ok":true}'
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike '*the database was not switched back*'
    }

    It 'changes nothing when the installer is not the one the server checked' {
        $script:FileSha = 'cd' * 32
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -Be 'The installer does not match the SHA-256 the server checked. Nothing was changed.'
        Get-Call 'stop *' | Should -HaveCount 0
        Get-Call 'installer *' | Should -HaveCount 0
        Get-Call "remove $($script:ProgramDataDir)\installers\RestaurantPlatform-Setup-1.2.0.exe" | Should -HaveCount 1
    }

    It 'changes nothing when the signature is not valid' {
        $script:Signature = [pscustomobject]@{ Status = 'HashMismatch'; Subject = 'CN=Restaurant Platform' }
        $result = Invoke-RPUpdate @script:Update
        $result.error | Should -Be 'The installer''s signature is not valid (HashMismatch). Nothing was changed.'
        Get-Call 'stop *' | Should -HaveCount 0
    }

    It 'changes nothing when the installer is not the version asked for' {
        # An older signed installer under the new version's name, or one that names no version.
        $script:ProductVersion = @{ '1.2.0' = '1.0.5' }
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -Be 'The installer installs version 1.0.5, not version 1.2.0 as asked. Nothing was changed.'
        Get-Call 'stop *' | Should -HaveCount 0
        Get-Call 'installer *' | Should -HaveCount 0
        Get-Call "remove $($script:ProgramDataDir)\installers\RestaurantPlatform-Setup-1.2.0.exe" | Should -HaveCount 1
        $script:ProductVersion = @{ '1.2.0' = $null }
        $script:Request = New-TestRequest -Change @{ requestId = '0199b0e0-0000-7000-8000-000000000003' }
        (Invoke-RPUpdate @script:Update).error | Should -Be 'The installer installs no version, not version 1.2.0 as asked. Nothing was changed.'
        $script:ProductVersion = @{ '1.2.0' = '1.2.0-rc.1' }
        $script:Request = New-TestRequest -Change @{ requestId = '0199b0e0-0000-7000-8000-000000000004' }
        (Invoke-RPUpdate @script:Update).error | Should -BeLike 'The installer installs version 1.2.0-rc.1, not*'
        Get-Call 'installer *' | Should -HaveCount 0
    }

    It 'never installs an older version, nor without the way back' {
        $script:Request = New-TestRequest -Version '1.0.5'
        $script:Present += "$($script:DataDir)\updates\RestaurantPlatform-Setup-1.0.5.exe"
        (Invoke-RPUpdate @script:Update).error | Should -Be 'Version 1.0.5 is not newer than the installed 1.1.0. Nothing was changed.'
        $script:Request = New-TestRequest -Change @{ requestId = '0199b0e0-0000-7000-8000-000000000002' }
        $script:Present = @($script:Present | Where-Object { $_ -notlike '*Setup-1.1.0.exe' })
        (Invoke-RPUpdate @script:Update).error | Should -BeLike 'The installer of the installed version 1.1.0 is not kept in*Nothing was changed*'
        Get-Call 'stop *' | Should -HaveCount 0
    }

    It 'starts the services again when the database cannot be copied' {
        $script:Fail = @{ 'update-snapshot' = (New-TestResult -ExitCode 1 -Output 'The data drive has 1.2 GB free; copying the database before the update needs 3.0 GB.') }
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike '*needs 3.0 GB.* Nothing was changed.'
        (Get-CallIndex 'start RPServer') | Should -BeLessThan (Get-CallIndex 'start RPWatchdog')
        Get-Call 'installer *' | Should -HaveCount 0
        (Get-Call 'setup-cli maintenance off') | Should -HaveCount 1
    }

    It 'leaves the installed version running when its files could not be replaced' {
        $script:InstallerCode['1.2.0'] = 2
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike '*could not be replaced, so version 1.1.0 carries on*'
        Get-Call 'setup-cli update-snapshot drop' | Should -HaveCount 1
        Get-Call 'installer 1.1.0' | Should -HaveCount 0
    }

    It 'runs each request once, and ends one a restart cut short as FAILED' {
        $first = Invoke-RPUpdate @script:Update
        $first.outcome | Should -Be 'INSTALLED'
        $script:Calls.Clear()
        # The watchdog starts the task again for the request the server still holds.
        Invoke-RPUpdate @script:Update | Should -BeNullOrEmpty
        @($script:Calls) | Should -HaveCount 0

        # Taken, but its outcome still RUNNING: the PC restarted in the middle.
        $script:Written[$script:OutcomeFile].outcome = 'RUNNING'
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.error | Should -BeLike 'The updater was interrupted*'
        @($script:Calls) | Should -Be @("write $($script:OutcomeFile) FAILED")
    }

    It 'does nothing without a request, and reports one it cannot read' {
        $script:Present = @()
        Invoke-RPUpdate @script:Update | Should -BeNullOrEmpty
        @($script:Calls) | Should -HaveCount 0

        $script:Present = @($script:RequestFile)
        $script:Request = 'not json'
        $result = Invoke-RPUpdate @script:Update
        $result.outcome | Should -Be 'FAILED'
        $result.requestId | Should -Be ''
        $result.error | Should -BeLike '*Nothing was changed.'
        Get-Call 'stop *' | Should -HaveCount 0
    }
}
