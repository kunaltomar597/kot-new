BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $env:SystemDrive = 'C:'
    $script:InstallDir = 'C:\Program Files\Restaurant Platform'
    $script:InstallationFile = 'C:\ProgramData\RestaurantPlatform\installation.json'
    $script:UserSid = 'S-1-5-21-9-9-9-1001'

    <# A fake PC: the services by state, and setup-cli's answers; every call is recorded. #>
    function Set-FakePc {
        param([hashtable] $Services = @{}, [hashtable] $Fail = @{}, [string] $Phase = 'RUNNING', [string] $LastError = $null)
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:ServiceState = $Services
        $script:Fail = $Fail
        $script:Phase = $Phase
        $script:LastError = $LastError
        $script:DataDir = $null
    }

    function Get-SetupCalls { @($script:Calls | Where-Object { $_ -like 'setup-cli *' }) }
    function Get-CallIndex([string] $Call) {
        $index = [array]::IndexOf($script:Calls.ToArray(), $Call)
        if ($index -lt 0) { throw "Not called: $Call" }
        $index
    }
}

Describe '[ONB-001] [NFR-I01] installing on a new PC' {
    BeforeEach {
        Set-FakePc
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Start-Sleep {}
        Mock -ModuleName $ModuleName Test-Path { $true }
        Mock -ModuleName $ModuleName New-Item {}
        Mock -ModuleName $ModuleName Get-RPCurrentUserSid { $script:UserSid }
        Mock -ModuleName $ModuleName Read-RPInstallationFile { $null }
        Mock -ModuleName $ModuleName Get-RPVolume {
            @((New-TestVolume 'C:' -FreeGB 90), (New-TestVolume 'D:' -FreeGB 400), (New-TestVolume 'E:' -BusType 'USB'))
        }
        Mock -ModuleName $ModuleName Register-RPUpdateTask { $null = $script:Calls.Add("updater task from $SetupDir into $ProgramDataDir") }
        Mock -ModuleName $ModuleName Save-RPInstaller { $null = $script:Calls.Add("keep $InstallerPath as $ProductVersion") }
        Mock -ModuleName $ModuleName Get-RPExplicitAceSid { @() }
        # The installer's own account is on the data folder until the permissions are set in full.
        Mock -ModuleName $ModuleName Get-RPExplicitAceSid -ParameterFilter { $Path -eq 'D:\RestaurantPlatform' } {
            @('S-1-5-18', 'S-1-5-32-544', $script:UserSid)
        }
        Mock -ModuleName $ModuleName Remove-RPFirewallRule { $null = $script:Calls.Add('firewall: remove the group') }
        Mock -ModuleName $ModuleName Add-RPFirewallRule {
            $null = $script:Calls.Add(('firewall: add {0} port {1} from {2}' -f $Spec.Name, $Spec.LocalPort, (@($Spec.RemoteAddress) -join ',')))
        }
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            if (-not $script:ServiceState.ContainsKey($Name)) { return $null }
            [pscustomobject]@{
                Name = $Name; State = $script:ServiceState[$Name]; StartName = ''; ProcessId = 10
                PathName = ('"{0}\services\{1}.exe"' -f $script:InstallDir, $Name)
            }
        }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            if ($FilePath -like '*node.exe') {
                $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
                $call = 'setup-cli ' + ($command -join ' ')
                $null = $script:Calls.Add($call)
                $name = $command[0]
                if ($script:Fail.ContainsKey($name)) { return $script:Fail[$name] }
                switch ($name) {
                    'write-installation' {
                        $at = [array]::IndexOf($command, '--data-dir')
                        if ($at -ge 0) { $script:DataDir = $command[$at + 1] }
                    }
                    'paths' { return New-TestResult -Output ((New-TestPaths -InstallDir $script:InstallDir -DataDir $script:DataDir) | ConvertTo-Json -Depth 4) }
                    'postgres-register' { if (-not $script:ServiceState.ContainsKey('RPDatabase')) { $script:ServiceState['RPDatabase'] = 'Stopped' } }
                    'status' { return New-TestResult -Output (@{ host = @{ phase = $script:Phase; lastError = $script:LastError } } | ConvertTo-Json) }
                }
                return New-TestResult -Output 'done'
            }
            $null = $script:Calls.Add(((@($FilePath) + $ArgumentList) -join ' '))
            if ($FilePath -like '*.exe' -and $FilePath -ne 'sc.exe' -and $FilePath -ne 'icacls.exe' -and $ArgumentList[0] -eq 'install') {
                $script:ServiceState[[IO.Path]::GetFileNameWithoutExtension(($FilePath -split '\\')[-1])] = 'Stopped'
            }
            if ($FilePath -eq 'sc.exe' -and $ArgumentList[0] -eq 'start') { $script:ServiceState[$ArgumentList[1]] = 'Running' }
            if ($FilePath -eq 'sc.exe' -and $ArgumentList[0] -eq 'stop') { $script:ServiceState[$ArgumentList[1]] = 'Stopped' }
            New-TestResult
        }
    }

    It 'sets up the data drive, secrets, database, services and firewall in order, and starts them' {
        $result = Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile
        $result.Mode | Should -Be 'install'
        $result.DataDir | Should -Be 'D:\RestaurantPlatform'
        $result.Port | Should -Be 8080

        Get-SetupCalls | Should -Be @(
            "setup-cli write-installation --install-dir $($script:InstallDir) --data-dir D:\RestaurantPlatform --product-version 1.0.0 --allow-unsigned-updates off",
            'setup-cli maintenance on --minutes 60 --reason install',
            'setup-cli paths',
            'setup-cli secrets',
            'setup-cli postgres-init',
            'setup-cli postgres-register',
            'setup-cli database',
            'setup-cli migrate',
            'setup-cli service-files',
            'setup-cli status',
            'setup-cli maintenance off'
        )
        # [SEC-006] The secrets' folder is closed before the secrets are made.
        $secretsAcl = Get-CallIndex ('icacls.exe ' + ((Get-RPIcaclsArgument -Entry (Get-RPFolderAclPlan -DataDir 'D:\RestaurantPlatform' -ProgramDataDir 'C:\ProgramData\RestaurantPlatform' | Where-Object { $_.Path -like '*secrets' })) -join ' '))
        $secretsAcl | Should -BeLessThan (Get-CallIndex 'setup-cli secrets')
        # initdb runs with a restricted copy of the installer's account: it may write the folder until
        # the permissions are set in full, which then take that away again.
        $granted = Get-CallIndex "icacls.exe D:\RestaurantPlatform /grant:r *$($script:UserSid):(OI)(CI)F /Q"
        $granted | Should -BeLessThan (Get-CallIndex 'setup-cli postgres-init')
        (Get-CallIndex "icacls.exe D:\RestaurantPlatform /remove *$($script:UserSid) /Q") | Should -BeGreaterThan (Get-CallIndex 'setup-cli postgres-init')
        # The database runs before the logins are made; the server before the watchdog.
        (Get-CallIndex 'sc.exe start RPDatabase') | Should -BeLessThan (Get-CallIndex 'setup-cli database')
        (Get-CallIndex "$($script:InstallDir)\services\RPServer.exe install") | Should -BeGreaterThan (Get-CallIndex 'setup-cli service-files')
        (Get-CallIndex 'sc.exe config RPServer start= auto depend= RPDatabase obj= NT SERVICE\RPServer') | Should -BeGreaterThan 0
        (Get-CallIndex 'sc.exe start RPServer') | Should -BeLessThan (Get-CallIndex 'setup-cli status')
        (Get-CallIndex 'sc.exe start RPWatchdog') | Should -BeGreaterThan (Get-CallIndex 'setup-cli status')
        # [SEC-008]
        (Get-CallIndex 'firewall: add RP-Server-HTTPS port 8080 from LocalSubnet') | Should -BeGreaterThan (Get-CallIndex 'firewall: remove the group')
        @($script:Calls) | Should -Contain 'firewall: add RP-Server-MQTT port 8883 from LocalSubnet'
        $script:ServiceState['RPWatchdog'] | Should -Be 'Running'
    }

    It 'passes the installer''s choices on, and opens the ports to the staff subnet given' {
        Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile `
            -DataDir 'C:\RestaurantPlatform\' -Port 9443 -MqttPort 8884 -StaffSubnet '192.168.10.0/24' `
            -ControlPlaneUrl 'https://cp.example.com' -TlsHostnames 'pos.local', 'counter' | Out-Null
        (Get-SetupCalls)[0] | Should -Be ("setup-cli write-installation --install-dir $($script:InstallDir) --data-dir C:\RestaurantPlatform " +
            '--product-version 1.0.0 --port 9443 --mqtt-port 8884 --control-plane-url https://cp.example.com --tls-hostnames pos.local,counter ' +
            '--allow-unsigned-updates off')
        @($script:Calls) | Should -Contain 'firewall: add RP-Server-HTTPS port 8080 from 192.168.10.0/24'
        # [ONB-002] The system drive is allowed when chosen, with a warning in the log.
        Should -Invoke -ModuleName $ModuleName Write-RPLog -ParameterFilter { $Message -like 'Warning: the data goes on the system drive C:*' } -Times 1
    }

    It '[UPD-005] [UPD-007] registers the updater and keeps the installer to go back to' {
        $script:InstallationRead = 0
        Mock -ModuleName $ModuleName Read-RPInstallationFile {
            $script:InstallationRead++
            if ($script:InstallationRead -eq 1) { return $null }
            [pscustomobject]@{ dataDir = 'D:\RestaurantPlatform'; productVersion = '1.0.0' }
        }
        Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile `
            -InstallerPath 'C:\Users\owner\Downloads\RestaurantPlatform-Setup-1.0.0.exe' `
            -UpdatePublisher 'CN=Restaurant Platform Pvt Ltd, C=IN' -AllowUnsignedUpdates | Out-Null
        (Get-SetupCalls)[0] | Should -BeLike '* --update-publisher CN=Restaurant Platform Pvt Ltd, C=IN --allow-unsigned-updates on'
        $task = Get-CallIndex "updater task from $($script:InstallDir)\setup into C:\ProgramData\RestaurantPlatform"
        $kept = Get-CallIndex 'keep C:\Users\owner\Downloads\RestaurantPlatform-Setup-1.0.0.exe as 1.0.0'
        # Both before the server starts, so a failed step leaves no half-set-up updater behind it.
        $task | Should -BeLessThan (Get-CallIndex 'sc.exe start RPServer')
        $kept | Should -BeLessThan (Get-CallIndex 'sc.exe start RPServer')
    }

    It '[ONB-002] refuses a removable drive before changing anything' {
        { Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile -DataDir 'E:\RestaurantPlatform' } |
            Should -Throw '*E: can be unplugged*'
        @($script:Calls) | Should -HaveCount 0
    }

    It '[ONB-002] says when no drive can hold the data' {
        Mock -ModuleName $ModuleName Get-RPVolume { @((New-TestVolume 'C:' -FreeGB 8)) }
        { Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile } |
            Should -Throw '*No drive on this PC can hold the data*20 GB*'
        @($script:Calls) | Should -HaveCount 0
    }

    It 'lifts the maintenance flag when a step fails' {
        Set-FakePc -Fail @{ migrate = (New-TestResult -ExitCode 1 -Output 'Migration 20261004200000 failed') }
        { Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile } |
            Should -Throw '*setup-cli migrate failed (exit 1): Migration 20261004200000 failed*'
        (Get-SetupCalls)[-1] | Should -Be 'setup-cli maintenance off'
        Get-SetupCalls | Should -Not -Contain 'setup-cli service-files'
    }

    It 'says plainly when the secrets were protected by another Windows installation' {
        Set-FakePc -Fail @{ secrets = (New-TestResult -ExitCode 1 -Output 'DPAPI unprotect failed (exit 1): Key not valid for use in specified state.') }
        { Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile } |
            Should -Throw '*protected by another Windows installation*recovery key*Nothing was changed.'
        Get-SetupCalls | Should -Not -Contain 'setup-cli postgres-init'
        (Get-SetupCalls)[-1] | Should -Be 'setup-cli maintenance off'
    }

    It 'says why when the server does not start' {
        Set-FakePc -Phase 'MIGRATING' -LastError 'Migration 20261004200000 failed'
        { Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.0.0' -InstallationFile $script:InstallationFile -StartTimeoutSeconds 4 } |
            Should -Throw '*did not start within 4 seconds (it was MIGRATING)*Migration 20261004200000 failed*'
        Get-SetupCalls | Where-Object { $_ -eq 'setup-cli status' } | Should -HaveCount 3
        @($script:Calls) | Should -Not -Contain 'sc.exe start RPWatchdog'
    }
}

Describe '[NFR-I02] repairing an installation' {
    BeforeEach {
        Set-FakePc -Services @{ RPDatabase = 'Running'; RPServer = 'Running'; RPWatchdog = 'Running' }
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Start-Sleep {}
        Mock -ModuleName $ModuleName Test-Path { $true }
        Mock -ModuleName $ModuleName New-Item {}
        Mock -ModuleName $ModuleName Get-RPCurrentUserSid { $script:UserSid }
        Mock -ModuleName $ModuleName Read-RPInstallationFile { [pscustomobject]@{ dataDir = 'F:\Old data' } }
        Mock -ModuleName $ModuleName Get-RPVolume { throw 'the drives are not looked at on repair' }
        Mock -ModuleName $ModuleName Register-RPUpdateTask { $null = $script:Calls.Add("updater task from $SetupDir into $ProgramDataDir") }
        Mock -ModuleName $ModuleName Save-RPInstaller { $null = $script:Calls.Add("keep $InstallerPath as $ProductVersion") }
        Mock -ModuleName $ModuleName Get-RPExplicitAceSid { @() }
        Mock -ModuleName $ModuleName Remove-RPFirewallRule { $null = $script:Calls.Add('firewall: remove the group') }
        Mock -ModuleName $ModuleName Add-RPFirewallRule { $null = $script:Calls.Add("firewall: add $($Spec.Name)") }
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            if (-not $script:ServiceState.ContainsKey($Name)) { return $null }
            [pscustomobject]@{
                Name = $Name; State = $script:ServiceState[$Name]; StartName = ''; ProcessId = 10
                PathName = ('"{0}\services\{1}.exe"' -f $script:InstallDir, $Name)
            }
        }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            if ($FilePath -like '*node.exe') {
                $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
                $null = $script:Calls.Add('setup-cli ' + ($command -join ' '))
                if ($command[0] -eq 'paths') { return New-TestResult -Output ((New-TestPaths -InstallDir $script:InstallDir -DataDir 'F:\Old data') | ConvertTo-Json -Depth 4) }
                if ($command[0] -eq 'status') { return New-TestResult -Output (@{ host = @{ phase = 'RUNNING'; lastError = $null } } | ConvertTo-Json) }
                return New-TestResult
            }
            $null = $script:Calls.Add(((@($FilePath) + $ArgumentList) -join ' '))
            if ($FilePath -eq 'sc.exe' -and $ArgumentList[0] -eq 'start') { $script:ServiceState[$ArgumentList[1]] = 'Running' }
            if ($FilePath -eq 'sc.exe' -and $ArgumentList[0] -eq 'stop') { $script:ServiceState[$ArgumentList[1]] = 'Stopped' }
            New-TestResult
        }
    }

    It 'keeps the data where it is, stops the watchdog then the server, and runs every step again' {
        $result = Invoke-RPInstall -InstallDir $script:InstallDir -ProductVersion '1.1.0' -InstallationFile $script:InstallationFile
        $result.Mode | Should -Be 'repair'
        $result.DataDir | Should -Be 'F:\Old data'
        (Get-SetupCalls)[0] | Should -Be "setup-cli write-installation --install-dir $($script:InstallDir) --data-dir F:\Old data --product-version 1.1.0 --allow-unsigned-updates off"
        (Get-SetupCalls)[1] | Should -Be 'setup-cli maintenance on --minutes 60 --reason repair'
        (Get-CallIndex 'sc.exe stop RPWatchdog') | Should -BeLessThan (Get-CallIndex 'sc.exe stop RPServer')
        (Get-CallIndex 'sc.exe stop RPServer') | Should -BeLessThan (Get-CallIndex 'setup-cli secrets')
        Get-SetupCalls | Should -Contain 'setup-cli migrate'
        # WinSW installs once; repair sets the services up with sc.exe.
        @($script:Calls | Where-Object { $_ -like '*.exe install' }) | Should -HaveCount 0
        @($script:Calls) | Should -Contain 'sc.exe config RPServer start= auto depend= RPDatabase obj= NT SERVICE\RPServer'
        @($script:Calls) | Should -Contain 'firewall: remove the group'
        $script:ServiceState['RPServer'] | Should -Be 'Running'
        $script:ServiceState['RPWatchdog'] | Should -Be 'Running'
        Should -Invoke -ModuleName $ModuleName Get-RPVolume -Times 0
    }

    It 'refuses to move the data to another folder, changing nothing' {
        { Invoke-RPInstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -DataDir 'G:\New' } |
            Should -Throw '*The data is in F:\Old data. Repair keeps it there*Nothing was changed.'
        @($script:Calls) | Should -HaveCount 0
    }

    It 'stops when the data folder is gone, instead of starting an empty restaurant' {
        Mock -ModuleName $ModuleName Test-Path -ParameterFilter { $LiteralPath -eq 'F:\Old data' } { $false }
        { Invoke-RPInstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile } |
            Should -Throw '*F:\Old data is not there*Nothing was changed.'
        @($script:Calls) | Should -HaveCount 0
    }
}
