# Ambit Agent -- standalone test for install.ps1's config merge.
#
# WHY THIS EXISTS
# install.ps1 used to overwrite C:\ProgramData\Ambit Agent\config from a
# fixed template on every run, which silently reverted the per-machine
# hardening an operator had added during a support call
# (AMBIT_CHROME_DISABLE_GPU on a box whose GPU driver kills renderers, a
# raised health threshold, a raised startup timeout). It now merges
# instead. That merge is the single most consequential thing the installer
# does to an EXISTING machine, and it is the part no macOS or Linux dev box
# can execute -- PowerShell is the only engine that runs it.
#
# So this script tests the merge ALONE. It extracts the real functions out
# of install.ps1 and drives them against seeded configs. It touches no
# system state, needs no admin rights, and -- deliberately -- needs no
# winget, no Node, and no Chrome, so it runs on a stripped or old box
# (Windows Server 2016 / PowerShell 5.1) where the full installer cannot
# get past its prerequisites.
#
# Usage:   .\test-config-merge.ps1
# Expect:  every line prefixed [PASS]. Any [FAIL] is a real defect.
#
# ASCII only in output: this file has no BOM and PS 5.1 decodes a BOM-less
# .ps1 as Windows-1252, so non-ASCII would render as mojibake.

$ErrorActionPreference = 'Stop'

$here      = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$installer = Join-Path $here 'install.ps1'
if (-not (Test-Path -LiteralPath $installer)) {
    Write-Host "Cannot find install.ps1 next to this script (looked in $here)." -ForegroundColor Red
    exit 1
}

Write-Host "PowerShell $($PSVersionTable.PSVersion) on $([Environment]::OSVersion.VersionString)"
Write-Host "Testing the merge logic inside: $installer`n"

# --- load the REAL functions, not a copy ----------------------------
# Pull the two function bodies and the managed-key list straight out of
# the installer so this test can never drift from the thing it tests.
$src = Get-Content -LiteralPath $installer -Raw
$parts = @()
foreach ($name in @('Read-ExistingConfig', 'Get-ConfigValue')) {
    $m = [regex]::Match($src, "(?ms)^function $name \{.*?^\}")
    if (-not $m.Success) {
        Write-Host "[FAIL] could not extract function $name from install.ps1" -ForegroundColor Red
        exit 1
    }
    $parts += $m.Value
}
$mk = [regex]::Match($src, '(?m)^\$ManagedKeys = .*$')
if (-not $mk.Success) {
    Write-Host '[FAIL] could not extract $ManagedKeys from install.ps1' -ForegroundColor Red
    exit 1
}
$parts += $mk.Value
Invoke-Expression ($parts -join "`n")
Write-Host "Extracted 2 functions + ManagedKeys ($($ManagedKeys -join ', '))`n"

# --- harness --------------------------------------------------------
$script:failures = 0
function Check {
    param($Label, $Expected, $Actual)
    if ($Expected -ceq $Actual) {
        Write-Host "  [PASS] $Label = '$Actual'" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $Label : expected '$Expected', got '$Actual'" -ForegroundColor Red
        $script:failures++
    }
}

function New-TempConfig {
    param($Content)
    $p = Join-Path ([System.IO.Path]::GetTempPath()) ("ambit-merge-test-" + [guid]::NewGuid().ToString('N') + ".cfg")
    # No trailing newline: that is itself a case worth covering, since an
    # operator's editor may omit one and the last setting must survive.
    [System.IO.File]::WriteAllText($p, $Content, [System.Text.UTF8Encoding]::new($false))
    return $p
}

# Mirrors the block install.ps1 appends to the new config.
function Get-PreservedKeys {
    return @($ExistingConfig.Keys | Where-Object { $ManagedKeys -notcontains $_ })
}

# ====================================================================
Write-Host 'SCENARIO 1: a hardened field machine upgrading' -ForegroundColor Cyan
# The Sept-12 customer laptop: five operator settings plus two
# installer-owned values that were deliberately changed from the defaults.
$ConfigFile = New-TempConfig @'
# Ambit Agent runtime config. Written by install.ps1 at 2026-09-12T03:11:00Z.
ADMIN_URL=https://ambitagent-stage.herokuapp.com
ENROLLMENT_TOKEN=tok_abc123_DO_NOT_LOSE_ME
HEADLESS=false
PLAYWRIGHT_BROWSERS_PATH=C:\Program Files\Ambit Agent\browsers
LOG_LEVEL=debug

# Added during the Sept 12 support call - DO NOT LOSE
AMBIT_CHROME_DISABLE_GPU=true
AMBIT_CHROME_HEALTH_MAX_FAILURES=5
AMBIT_CHROME_STARTUP_TIMEOUT_MS=120000
AMBIT_CHROME_PORT=9333
'@
$ExistingConfig = Read-ExistingConfig $ConfigFile
Check 'parsed setting count' 9 $ExistingConfig.Count
# No env overrides set -> the stored values must win over the defaults.
Check 'ADMIN_URL carried forward'  'https://ambitagent-stage.herokuapp.com' (Get-ConfigValue 'ADMIN_URL' $null '')
Check 'TOKEN carried forward'      'tok_abc123_DO_NOT_LOSE_ME'              (Get-ConfigValue 'ENROLLMENT_TOKEN' $null '')
Check 'HEADLESS kept (not reset)'  'false'                                  (Get-ConfigValue 'HEADLESS' $null 'false')
Check 'LOG_LEVEL kept (not reset)' 'debug'                                  (Get-ConfigValue 'LOG_LEVEL' $null 'info')
$preserved = Get-PreservedKeys
Check 'preserved operator keys' 'AMBIT_CHROME_DISABLE_GPU,AMBIT_CHROME_HEALTH_MAX_FAILURES,AMBIT_CHROME_STARTUP_TIMEOUT_MS,AMBIT_CHROME_PORT' ($preserved -join ',')
Check 'GPU flag value intact' 'true' $ExistingConfig['AMBIT_CHROME_DISABLE_GPU']
Remove-Item -LiteralPath $ConfigFile -Force

# ====================================================================
Write-Host "`nSCENARIO 2: a first install (no config file yet)" -ForegroundColor Cyan
$ConfigFile = Join-Path ([System.IO.Path]::GetTempPath()) 'ambit-merge-test-absent.cfg'
$ExistingConfig = Read-ExistingConfig $ConfigFile
Check 'empty map for a missing file' 0 $ExistingConfig.Count
Check 'HEADLESS falls to default'  'false' (Get-ConfigValue 'HEADLESS' $null 'false')
Check 'LOG_LEVEL falls to default' 'info'  (Get-ConfigValue 'LOG_LEVEL' $null 'info')
Check 'no keys to preserve' '' ((Get-PreservedKeys) -join ',')

# ====================================================================
Write-Host "`nSCENARIO 3: an explicit env override must beat the stored value" -ForegroundColor Cyan
$ConfigFile = New-TempConfig "LOG_LEVEL=debug`nAMBIT_CHROME_PORT=9333"
$ExistingConfig = Read-ExistingConfig $ConfigFile
Check 'env override wins'        'warn'  (Get-ConfigValue 'LOG_LEVEL' 'warn' 'info')
Check 'stored wins when no env'  'debug' (Get-ConfigValue 'LOG_LEVEL' $null  'info')
Remove-Item -LiteralPath $ConfigFile -Force

# ====================================================================
Write-Host "`nSCENARIO 4: a hand-edited, malformed config" -ForegroundColor Cyan
# Every one of these is something a human plausibly leaves behind. The
# last line deliberately has NO trailing newline.
$ConfigFile = New-TempConfig @'
# header comment
ADMIN_URL="https://quoted.example.com"

AMBIT_BROWSER_ARGS=--window-size=1280,720 --disable-gpu
   AMBIT_CHROME_PORT = 9444
LOG_LEVEL=
#AMBIT_COMMENTED_OUT=true
NO_EQUALS_LINE
AMBIT_LAST_LINE_NO_NEWLINE=yes
'@.TrimEnd("`r", "`n")
$ExistingConfig = Read-ExistingConfig $ConfigFile
Check 'surrounding quotes stripped'   'https://quoted.example.com' $ExistingConfig['ADMIN_URL']
Check 'splits on the FIRST = only'    '--window-size=1280,720 --disable-gpu' $ExistingConfig['AMBIT_BROWSER_ARGS']
Check 'key+value whitespace trimmed'  '9444' $ExistingConfig['AMBIT_CHROME_PORT']
Check 'commented-out key ignored'     $false ($ExistingConfig.Contains('#AMBIT_COMMENTED_OUT'))
Check 'line with no = ignored'        $false ($ExistingConfig.Contains('NO_EQUALS_LINE'))
Check 'final line w/o newline kept'   'yes'  $ExistingConfig['AMBIT_LAST_LINE_NO_NEWLINE']
# A key present but BLANK counts as absent, so the default applies rather
# than an empty value propagating into the daemon's config.
Check 'blank value -> default'        'info' (Get-ConfigValue 'LOG_LEVEL' $null 'info')
Remove-Item -LiteralPath $ConfigFile -Force

# ====================================================================
if ($script:failures -eq 0) {
    Write-Host "`nAll checks passed. The config merge behaves correctly on this PowerShell." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n$($script:failures) check(s) FAILED -- do not ship the installer." -ForegroundColor Red
    exit 1
}
