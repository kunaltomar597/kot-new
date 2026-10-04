#Requires -Version 5.1
<#
.SYNOPSIS
    Runs the set-up scripts' Pester tests (with PSScriptAnalyzer). Off Windows the tests tagged
    Windows are skipped.

.DESCRIPTION
    Needs Pester 5.5 or later and PSScriptAnalyzer:
        Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser -SkipPublisherCheck
        Install-Module PSScriptAnalyzer -RequiredVersion 1.25.0 -Scope CurrentUser
    Exit code 0 when everything passes. -ResultFile writes NUnit XML for CI.
#>
[CmdletBinding()]
param([string] $ResultFile)
$ErrorActionPreference = 'Stop'
Import-Module Pester -MinimumVersion 5.5 -MaximumVersion 5.99
$config = New-PesterConfiguration
$config.Run.Path = Join-Path $PSScriptRoot 'tests'
$config.Run.Exit = $true
$config.Output.Verbosity = 'Detailed'
$onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
if (-not $onWindows) { $config.Filter.ExcludeTag = @('Windows') }
if ($ResultFile) {
    $config.TestResult.Enabled = $true
    $config.TestResult.OutputPath = $ResultFile
}
Invoke-Pester -Configuration $config
