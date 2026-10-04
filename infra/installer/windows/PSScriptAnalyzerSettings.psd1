@{
    # The set-up scripts run on Windows PowerShell 5.1, which every Windows 10 and 11 PC has; the
    # tests also run on PowerShell 7. These rules check that nothing newer is used.
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # The installer runs the scripts unattended; -WhatIf and -Confirm have no one to ask.
        'PSUseShouldProcessForStateChangingFunctions'
    )
    Rules        = @{
        PSUseCompatibleSyntax   = @{
            Enable         = $true
            TargetVersions = @('5.1', '7.0')
        }
        PSUseCompatibleCommands = @{
            Enable         = $true
            TargetProfiles = @(
                # Windows 10 with Windows PowerShell 5.1, and with PowerShell 7.
                'win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework',
                'win-4_x64_10.0.18362.0_7.0.0_x64_3.1.2_core'
            )
        }
        PSUseCompatibleTypes    = @{
            Enable         = $true
            TargetProfiles = @(
                'win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework',
                'win-4_x64_10.0.18362.0_7.0.0_x64_3.1.2_core'
            )
        }
    }
}
