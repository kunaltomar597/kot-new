BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:ServicesDir = 'C:\Program Files\Restaurant Platform\services'
}

Describe '[ONB-001] [NFR-A04] the Windows services' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $null = $script:Calls.Add(((@($FilePath) + $ArgumentList) -join ' '))
            New-TestResult
        }
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Start-Sleep {}
    }

    It 'installs the server''s service with its own account, after the database, restarted when it fails' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo { $null }
        Install-RPWinSWService -Name 'RPServer' -ServicesDir $script:ServicesDir -DependsOn 'RPDatabase' -VirtualAccount
        @($script:Calls) | Should -Be @(
            "$($script:ServicesDir)\RPServer.exe install",
            'sc.exe sidtype RPServer unrestricted',
            'sc.exe config RPServer start= auto depend= RPDatabase obj= NT SERVICE\RPServer',
            'sc.exe failure RPServer reset= 3600 actions= restart/1000/restart/2000/restart/5000',
            'sc.exe failureflag RPServer 1'
        )
    }

    It 'leaves the watchdog as LocalSystem, which may start and stop the other services' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo { $null }
        Install-RPWinSWService -Name 'RPWatchdog' -ServicesDir $script:ServicesDir
        @($script:Calls) | Should -Contain 'sc.exe config RPWatchdog start= auto'
        @($script:Calls | Where-Object { $_ -like '*obj=*' -or $_ -like '*sidtype*' }) | Should -HaveCount 0
    }

    It '[NFR-I02] on repair, sets an installed service up again without installing it twice' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            [pscustomobject]@{ Name = 'RPServer'; State = 'Stopped'; PathName = """$($script:ServicesDir)\RPServer.exe"""; StartName = 'LocalSystem'; ProcessId = 0 }
        }
        Install-RPWinSWService -Name 'RPServer' -ServicesDir $script:ServicesDir -DependsOn 'RPDatabase' -VirtualAccount
        @($script:Calls | Where-Object { $_ -like '*install' }) | Should -HaveCount 0
        @($script:Calls) | Should -Contain 'sc.exe config RPServer start= auto depend= RPDatabase obj= NT SERVICE\RPServer'
    }

    It 'installs a service again when it runs a program from somewhere else' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            [pscustomobject]@{ Name = 'RPServer'; State = 'Stopped'; PathName = '"D:\Old\services\RPServer.exe"'; StartName = 'NT SERVICE\RPServer'; ProcessId = 0 }
        }
        Mock -ModuleName $ModuleName Remove-RPService { $null = $script:Calls.Add("remove $Name") }
        Install-RPWinSWService -Name 'RPServer' -ServicesDir $script:ServicesDir -DependsOn 'RPDatabase' -VirtualAccount
        @($script:Calls)[0..1] | Should -Be @('remove RPServer', "$($script:ServicesDir)\RPServer.exe install")
    }

    It 'stops when WinSW cannot install the service' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo { $null }
        Mock -ModuleName $ModuleName Invoke-RPProgram { New-TestResult -ExitCode 1073 -Output 'A service with ID ''RPServer'' already exists.' }
        { Install-RPWinSWService -Name 'RPServer' -ServicesDir $script:ServicesDir } | Should -Throw '*Installing the RPServer service failed (exit 1073)*already exists*'
    }

    It 'waits for a service to run, and says when it does not' {
        $script:Polls = 0
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            $script:Polls++
            $state = 'Start Pending'
            if ($script:Polls -ge 3) { $state = 'Running' }
            [pscustomobject]@{ Name = $Name; State = $state; PathName = ''; StartName = ''; ProcessId = 7 }
        }
        Start-RPService -Name 'RPDatabase'
        @($script:Calls) | Should -Be @('sc.exe start RPDatabase')
        $script:Polls | Should -Be 3

        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            [pscustomobject]@{ Name = $Name; State = 'Stopped'; PathName = ''; StartName = ''; ProcessId = 0 }
        }
        { Start-RPService -Name 'RPServer' -TimeoutSeconds 3 } | Should -Throw '*RPServer did not start within 3 seconds*'
    }

    It 'ends a service that will not stop' {
        $script:Killed = $false
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            $state = 'Stop Pending'
            if ($script:Killed) { $state = 'Stopped' }
            [pscustomobject]@{ Name = $Name; State = $state; PathName = ''; StartName = ''; ProcessId = 4242 }
        }
        Mock -ModuleName $ModuleName Invoke-RPProgram -ParameterFilter { $FilePath -eq 'taskkill.exe' } {
            $null = $script:Calls.Add(((@($FilePath) + $ArgumentList) -join ' '))
            $script:Killed = $true
            New-TestResult
        }
        Stop-RPService -Name 'RPServer' -TimeoutSeconds 2
        @($script:Calls) | Should -Be @('sc.exe stop RPServer', 'taskkill.exe /PID 4242 /T /F')
    }

    It 'removes a service, and has nothing to do for one that is not there' {
        Mock -ModuleName $ModuleName Get-RPServiceInfo { $null }
        Remove-RPService -Name 'RPWatchdog'
        @($script:Calls) | Should -HaveCount 0

        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            [pscustomobject]@{ Name = $Name; State = 'Stopped'; PathName = ''; StartName = ''; ProcessId = 0 }
        }
        Remove-RPService -Name 'RPWatchdog'
        @($script:Calls) | Should -Be @('sc.exe delete RPWatchdog')
    }

    It 'gives PostgreSQL''s service its own recovery' {
        Set-RPServiceRecovery -Name 'RPDatabase' -Actions 'restart/5000/restart/10000/restart/30000'
        @($script:Calls) | Should -Be @(
            'sc.exe failure RPDatabase reset= 3600 actions= restart/5000/restart/10000/restart/30000',
            'sc.exe failureflag RPDatabase 1'
        )
    }
}

Describe 'running programs' {
    It 'returns a program''s exit code and its output, stderr included' -Skip:($PSVersionTable.PSEdition -eq 'Desktop' -or $IsWindows) {
        $result = Invoke-RPProgram -FilePath 'sh' -ArgumentList @('-c', 'echo out; echo err >&2; exit 3')
        $result.ExitCode | Should -Be 3
        $result.Output | Should -Match 'out'
        $result.Output | Should -Match 'err'
    }

    It 'says when the program is not there, instead of trusting an old exit code' {
        $result = Invoke-RPProgram -FilePath 'rp-no-such-program-here' -ArgumentList @('x')
        $result.ExitCode | Should -Be -1
        $result.Output | Should -Match 'was not found'
    }
}
