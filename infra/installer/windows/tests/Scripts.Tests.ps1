BeforeDiscovery {
    $root = Split-Path -Parent $PSScriptRoot
    $script:Files = @(
        Get-ChildItem -Path $root -Recurse -File -Include '*.ps1', '*.psm1', '*.psd1' |
            ForEach-Object { @{ Name = $_.FullName.Substring($root.Length + 1); Path = $_.FullName } }
    )
}

BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:Root = Split-Path -Parent $PSScriptRoot
    $script:Shell = (Get-Process -Id $PID).Path
}

Describe 'the script files' {
    It '<Name> is ASCII, as Windows PowerShell 5.1 reads a file without a byte order mark' -ForEach $Files {
        $bytes = [IO.File]::ReadAllBytes($Path)
        @($bytes | Where-Object { $_ -gt 127 }) | Should -HaveCount 0
    }

    It '<Name> parses' -ForEach $Files {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
        @($errors) | Should -HaveCount 0
    }

    It 'that ship pass PSScriptAnalyzer, with the Windows PowerShell 5.1 compatibility rules' {
        if ($null -eq (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {
            Set-ItResult -Skipped -Because 'PSScriptAnalyzer is not installed'
            return
        }
        # What ships to the PC; the tests and their runner need Pester, which CI installs.
        $settings = Join-Path $script:Root 'PSScriptAnalyzerSettings.psd1'
        $shipped = @(Get-ChildItem -Path (Join-Path $script:Root '*') -File -Include '*.ps1', '*.psm1' |
                Where-Object { $_.Name -ne 'Invoke-Tests.ps1' })
        $shipped.Count | Should -Be 7
        $findings = @($shipped | ForEach-Object { Invoke-ScriptAnalyzer -Path $_.FullName -Settings $settings })
        $findings | ForEach-Object { '{0} {1}:{2} {3}' -f $_.RuleName, $_.ScriptName, $_.Line, $_.Message } | Should -BeNullOrEmpty
    }
}

Describe 'the scripts the installer runs' {
    It '[ONB-001] Install-RestaurantPlatform.ps1 logs a failure and ends with exit code 1' {
        $log = Join-Path $TestDrive 'install.log'
        & $script:Shell -NoProfile -NonInteractive -File (Join-Path $script:Root 'Install-RestaurantPlatform.ps1') `
            -InstallDir (Join-Path $TestDrive 'program') -InstallationFile (Join-Path $TestDrive 'installation.json') -LogFile $log *> $null
        $LASTEXITCODE | Should -Be 1
        Get-Content -LiteralPath $log -Raw | Should -Match 'The set-up failed'
    }

    It '[UPD-007] Stop- and Start-RestaurantPlatform.ps1 log a failure and end with exit code 1' {
        foreach ($name in @('Stop', 'Start')) {
            $message = @{ Stop = 'Stopping the services failed'; Start = 'Starting the services failed' }[$name]
            $log = Join-Path $TestDrive "$name.log"
            & $script:Shell -NoProfile -NonInteractive -File (Join-Path $script:Root "$name-RestaurantPlatform.ps1") `
                -InstallDir (Join-Path $TestDrive 'program') -InstallationFile (Join-Path $TestDrive 'installation.json') -LogFile $log *> $null
            $LASTEXITCODE | Should -Be 1
            Get-Content -LiteralPath $log -Raw | Should -Match $message
        }
    }

    It '[UPD-005] Update-RestaurantPlatform.ps1 logs a failure and ends with exit code 1' {
        $log = Join-Path $TestDrive 'update.log'
        & $script:Shell -NoProfile -NonInteractive -File (Join-Path $script:Root 'Update-RestaurantPlatform.ps1') `
            -InstallationFile (Join-Path $TestDrive 'none.json') -LogFile $log *> $null
        $LASTEXITCODE | Should -Be 1
        Get-Content -LiteralPath $log -Raw | Should -Match 'The updater failed'
    }

    It '[NFR-I02] Uninstall-RestaurantPlatform.ps1 logs a failure and ends with exit code 1' {
        $log = Join-Path $TestDrive 'uninstall.log'
        & $script:Shell -NoProfile -NonInteractive -File (Join-Path $script:Root 'Uninstall-RestaurantPlatform.ps1') `
            -InstallDir (Join-Path $TestDrive 'program') -InstallationFile (Join-Path $TestDrive 'none.json') -DeleteData -LogFile $log *> $null
        $LASTEXITCODE | Should -Be 1
        Get-Content -LiteralPath $log -Raw | Should -Match 'The uninstall stopped'
    }
} -Skip:($PSVersionTable.PSEdition -eq 'Desktop' -or $IsWindows)
