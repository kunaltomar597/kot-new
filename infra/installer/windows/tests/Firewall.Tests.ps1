BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    $script:Node = 'C:\Program Files\Restaurant Platform\node\node.exe'
}

Describe '[SEC-008] the firewall' {
    It 'opens the HTTPS and MQTT ports for the server''s Node.js only, from the PC''s own networks' {
        $rules = Get-RPFirewallRuleSpec -Port 8080 -MqttPort 8883 -NodePath $script:Node
        $rules | Should -HaveCount 2
        foreach ($rule in $rules) {
            $rule.Group | Should -Be 'Restaurant Platform'
            $rule.Direction | Should -Be 'Inbound'
            $rule.Action | Should -Be 'Allow'
            $rule.Protocol | Should -Be 'TCP'
            $rule.Program | Should -Be $script:Node
            @($rule.RemoteAddress) | Should -Be @('LocalSubnet')
            # Windows may call the restaurant's network public; the POS must still reach the server.
            $rule.Profile | Should -Be 'Any'
        }
        $rules[0].Name | Should -Be 'RP-Server-HTTPS'
        $rules[0].LocalPort | Should -Be '8080'
        $rules[1].Name | Should -Be 'RP-Server-MQTT'
        $rules[1].LocalPort | Should -Be '8883'
    }

    It 'opens them to the staff subnet only, when the installer is given one' {
        $rules = Get-RPFirewallRuleSpec -Port 9443 -MqttPort 8884 -NodePath $script:Node -StaffSubnet @(' 192.168.10.0/24 ', '10.20.0.0/16')
        @($rules[0].RemoteAddress) | Should -Be @('192.168.10.0/24', '10.20.0.0/16')
        @($rules[1].RemoteAddress) | Should -Be @('192.168.10.0/24', '10.20.0.0/16')
        $rules[0].LocalPort | Should -Be '9443'
        @(ConvertTo-RPRemoteAddress -StaffSubnet @('', $null)) | Should -Be @('LocalSubnet')
    }

    It 'refuses what is not a staff subnet, or one as wide as the internet' {
        foreach ($subnet in @('192.168.10.0', '300.1.1.0/24', 'staff', '10.0.0.0/7', '0.0.0.0/0', '10.0.0.0/33')) {
            { ConvertTo-RPRemoteAddress -StaffSubnet @($subnet) } | Should -Throw "*$subnet*"
        }
    }

    It 'replaces the group''s rules, so repair leaves exactly these' {
        $script:Calls = [System.Collections.ArrayList]::new()
        Mock -ModuleName $ModuleName Remove-RPFirewallRule { $null = $script:Calls.Add("remove $Group") }
        Mock -ModuleName $ModuleName Add-RPFirewallRule { $null = $script:Calls.Add("add $($Spec.Name)") }
        Set-RPFirewallRule -Spec (Get-RPFirewallRuleSpec -Port 8080 -MqttPort 8883 -NodePath $script:Node)
        @($script:Calls) | Should -Be @('remove Restaurant Platform', 'add RP-Server-HTTPS', 'add RP-Server-MQTT')
    }
}
