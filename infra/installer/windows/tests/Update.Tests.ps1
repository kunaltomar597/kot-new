BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:InstallDir = 'C:\Program Files\Restaurant Platform'
    $script:InstallationFile = 'C:\ProgramData\RestaurantPlatform\installation.json'
}

Describe '[UPD-007] stopping the services before an update replaces the files' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:MaintenanceFails = $false
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Test-Path { $true }
        Mock -ModuleName $ModuleName Stop-RPService { $null = $script:Calls.Add("stop $Name") }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
            $null = $script:Calls.Add('setup-cli ' + ($command -join ' '))
            if ($script:MaintenanceFails) { return New-TestResult -ExitCode -1 -Output 'node.exe was not found.' }
            New-TestResult
        }
    }

    It 'sets the maintenance flag, then stops the watchdog, the server and the database' {
        $result = Invoke-RPStop -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        $result.Stopped | Should -BeTrue
        @($script:Calls) | Should -Be @(
            'setup-cli maintenance on --minutes 60 --reason update',
            'stop RPWatchdog',
            'stop RPServer',
            'stop RPDatabase'
        )
        Should -Invoke -ModuleName $ModuleName Invoke-RPProgram -ParameterFilter {
            $FilePath -eq 'C:\Program Files\Restaurant Platform\node\node.exe'
        }
    }

    It 'still stops the services when the installed software cannot set the flag (a damaged installation)' {
        $script:MaintenanceFails = $true
        $result = Invoke-RPStop -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -Reason repair
        $result.Stopped | Should -BeTrue
        @($script:Calls) | Should -Be @(
            'setup-cli maintenance on --minutes 60 --reason repair',
            'stop RPWatchdog',
            'stop RPServer',
            'stop RPDatabase'
        )
    }

    It 'does nothing on a PC without an installation' {
        Mock -ModuleName $ModuleName Test-Path { $false }
        $result = Invoke-RPStop -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        $result.Stopped | Should -BeFalse
        @($script:Calls) | Should -HaveCount 0
    }

    It 'fails when a service cannot be stopped, so the files are not replaced under it' {
        Mock -ModuleName $ModuleName Stop-RPService { throw ('{0} could not be stopped.' -f $Name) } -ParameterFilter { $Name -eq 'RPServer' }
        { Invoke-RPStop -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile } | Should -Throw 'RPServer could not be stopped.'
    }
}

Describe '[UPD-007] starting the services again when an update could not go ahead' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:Installed = @('RPDatabase', 'RPServer', 'RPWatchdog')
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Test-Path { $true }
        Mock -ModuleName $ModuleName Get-RPServiceInfo {
            if ($script:Installed -contains $Name) { return [pscustomobject]@{ Name = $Name; State = 'Stopped' } }
            $null
        }
        Mock -ModuleName $ModuleName Start-RPService { $null = $script:Calls.Add("start $Name") }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
            $null = $script:Calls.Add('setup-cli ' + ($command -join ' '))
            New-TestResult
        }
    }

    It 'starts the database, the server and the watchdog, then lifts the maintenance flag' {
        $result = Invoke-RPStart -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        @($result.Started) | Should -Be @('RPDatabase', 'RPServer', 'RPWatchdog')
        @($script:Calls) | Should -Be @('start RPDatabase', 'start RPServer', 'start RPWatchdog', 'setup-cli maintenance off')
    }

    It 'starts only the services that are installed' {
        $script:Installed = @('RPDatabase')
        $result = Invoke-RPStart -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        @($result.Started) | Should -Be @('RPDatabase')
        @($script:Calls) | Should -Be @('start RPDatabase', 'setup-cli maintenance off')
    }
}

Describe 'lists given to the install script' {
    It 'splits the installer''s one argument at commas and spaces' {
        ConvertTo-RPList -Value @('192.168.10.0/24,192.168.11.0/24') | Should -Be @('192.168.10.0/24', '192.168.11.0/24')
        ConvertTo-RPList -Value @('pos.local, kitchen.local', 'bar.local') | Should -Be @('pos.local', 'kitchen.local', 'bar.local')
        @(ConvertTo-RPList -Value @('')) | Should -HaveCount 0
        @(ConvertTo-RPList -Value $null) | Should -HaveCount 0
    }
}
