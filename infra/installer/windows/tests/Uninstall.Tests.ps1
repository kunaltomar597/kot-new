BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:InstallDir = 'C:\Program Files\Restaurant Platform'
    $script:InstallationFile = 'C:\ProgramData\RestaurantPlatform\installation.json'
}

Describe '[NFR-I02] uninstalling' {
    BeforeEach {
        $script:Calls = [System.Collections.ArrayList]::new()
        $script:Allowed = $false
        $script:DataDir = 'D:\RestaurantPlatform'
        Mock -ModuleName $ModuleName Assert-RPAdministrator {}
        Mock -ModuleName $ModuleName Write-RPLog {}
        Mock -ModuleName $ModuleName Test-Path { $true }
        Mock -ModuleName $ModuleName Remove-RPService { $null = $script:Calls.Add("remove service $Name") }
        Mock -ModuleName $ModuleName Remove-RPFirewallRule { $null = $script:Calls.Add('remove firewall rules') }
        Mock -ModuleName $ModuleName Remove-RPFolder { $null = $script:Calls.Add("delete $Path") }
        Mock -ModuleName $ModuleName Invoke-RPProgram {
            $command = @($ArgumentList | Select-Object -Skip 1 | Select-Object -SkipLast 2)
            $null = $script:Calls.Add('setup-cli ' + ($command -join ' '))
            switch ($command[0]) {
                'paths' { return New-TestResult -Output ((New-TestPaths -DataDir $script:DataDir) | ConvertTo-Json -Depth 4) }
                'data-deletion' {
                    if ($script:Allowed) { return New-TestResult -Output '{"allowed":true,"until":"2026-10-05T10:30:00.000Z","allowedBy":"owner"}' }
                    return New-TestResult -ExitCode 3 -Output '{"allowed":false,"until":null,"allowedBy":null}'
                }
            }
            New-TestResult
        }
    }

    It 'keeps the data: removes the watchdog first, then the server and the database, and the firewall rules' {
        $result = Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        $result.DataKept | Should -BeTrue
        $result.DataDir | Should -Be 'D:\RestaurantPlatform'
        @($script:Calls) | Should -Be @(
            'setup-cli paths',
            'setup-cli maintenance on --minutes 30 --reason uninstall',
            'remove service RPWatchdog',
            'remove service RPServer',
            'remove service RPDatabase',
            'remove firewall rules',
            'setup-cli maintenance off'
        )
    }

    It 'does not delete the data without the Owner''s permission, and changes nothing' {
        $failure = $null
        try {
            Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -DeleteData
        } catch {
            $failure = $_
        }
        $failure | Should -Not -BeNullOrEmpty
        [string]$failure | Should -BeLike '*Owner has not allowed deleting the data*Nothing was changed.'
        Get-RPExitCode -ErrorRecord $failure | Should -Be 3
        @($script:Calls) | Should -Be @('setup-cli paths', 'setup-cli data-deletion')
    }

    It '[AUTH-006] deletes the data folder and the installation''s folder with the Owner''s permission' {
        $script:Allowed = $true
        $result = Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -DeleteData
        $result.DataKept | Should -BeFalse
        @($script:Calls) | Should -Be @(
            'setup-cli paths',
            'setup-cli data-deletion',
            'setup-cli maintenance on --minutes 30 --reason uninstall',
            'remove service RPWatchdog',
            'remove service RPServer',
            'remove service RPDatabase',
            'remove firewall rules',
            'delete D:\RestaurantPlatform',
            'delete C:\ProgramData\RestaurantPlatform'
        )
    }

    It 'never deletes a whole drive or Windows'' own folders' {
        $script:Allowed = $true
        foreach ($folder in @('D:\', 'D:', '\\nas\restaurant')) {
            $script:DataDir = $folder
            { Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -DeleteData } |
                Should -Throw '*nothing was deleted*'
        }
        { Assert-RPDeletableDataDir -DataDir 'C:\' -Protected @('C:\Windows') } | Should -Throw '*nothing was deleted*'
        { Assert-RPDeletableDataDir -DataDir 'C:\Users' -Protected @('C:\Users\owner') } | Should -Throw '*Windows'' own folders*'
        { Assert-RPDeletableDataDir -DataDir 'C:\Windows\Temp\data' -Protected @('C:\Windows') } | Should -Throw '*Windows'' own folders*'
        { Assert-RPDeletableDataDir -DataDir 'D:\RestaurantPlatform' -Protected @('C:\Windows') } | Should -Not -Throw
        @($script:Calls | Where-Object { $_ -like 'remove*' -or $_ -like 'delete*' }) | Should -HaveCount 0
    }

    It 'still removes the services when the installation file is gone, keeping whatever data there is' {
        Mock -ModuleName $ModuleName Test-Path { $false }
        $result = Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile
        $result.DataKept | Should -BeTrue
        $result.DataDir | Should -BeNullOrEmpty
        @($script:Calls) | Should -Be @('remove service RPWatchdog', 'remove service RPServer', 'remove service RPDatabase', 'remove firewall rules')

        $script:Calls.Clear()
        { Invoke-RPUninstall -InstallDir $script:InstallDir -InstallationFile $script:InstallationFile -DeleteData } |
            Should -Throw '*installation could not be read*Nothing was changed.'
        @($script:Calls) | Should -HaveCount 0
    }
}
