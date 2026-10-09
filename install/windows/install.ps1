#Requires -RunAsAdministrator
#
# Ambit Agent runtime -- Windows installer (zip-distribution + user-session mode).
#
# Design shape:
#   - Runs the daemon as a Scheduled Task at user logon (NOT a Session-0
#     service), so the managed Chrome window is visible on the user's
#     desktop. Required by agents with browser.model="attached_chrome".
#   - Extracts source from a sibling `ambitagent-client-*.zip` bundled
#     alongside this .ps1 in the same folder (typically Downloads after
#     the customer saves both email attachments). No git, no PAT, no
#     public repo needed.
#   - Idempotent: re-running upgrades the source in place, restarts the
#     task, and preserves both the Chrome profile (customer's Amazon/LMD
#     logins survive upgrades) and the config file. "Preserves the config"
#     means genuinely merges it: installer-owned keys are refreshed, and
#     every operator-added key -- the per-machine hardening -- is carried
#     forward verbatim. See Read-ExistingConfig below for why that matters.
#
# Usage -- one-time customer flow:
#
#   1. Save both attachments from the install email into the SAME folder
#      (typically Downloads):
#         - install.ps1
#         - ambitagent-client-YYYYMMDD-HHMMSS-SHA.zip
#   2. Right-click install.ps1 -> Run with PowerShell (as Administrator).
#   3. When prompted:
#        - Admin URL:        <copied from email body>
#        - Enrollment token: <copied from email body>
#        - Run-as user:      <defaults to the current logged-in user;
#                            usually just press Enter>
#   4. Wait ~5 min (Node install + npm ci + Chromium download).
#   5. Log OFF and back ON to trigger the "at logon" task (or just wait
#      until tomorrow morning). Runtime appears online in portal /staff/runtimes.
#
# Overridable env vars (set BEFORE running the installer):
#   $env:AMBIT_ADMIN_URL         Skips the prompt.
#   $env:AMBIT_ENROLLMENT_TOKEN  Skips the prompt.
#   $env:AMBIT_RUN_AS_USER       DOMAIN\username to run the task as.
#                                Default: interactive user who invoked the script.
#   $env:AMBIT_HEADLESS          true|false. Default: false (user session
#                                CAN show visible Chrome, so let it).
#   $env:AMBIT_LOG_LEVEL         debug|info|warn|error. Default: info.
# --------------------------------------------------------------------

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Force TLS 1.2 for any HTTPS the script itself makes. PowerShell 5.1
# (which ships with Windows 10/11) defaults to TLS 1.0/1.1, which
# npm/GitHub/most package registries no longer accept. The current
# script doesn't make direct HTTPS calls (winget + node handle their
# own TLS), but this is cheap insurance against a future addition and
# means customers never have to prepend a TLS line before running.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
    # Tls13 enum missing on very old .NET (< 4.8) — fall back to Tls12 only.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$InstallRoot   = 'C:\Program Files\Ambit Agent'
$AppDir        = Join-Path $InstallRoot 'app'
$BrowsersDir   = Join-Path $InstallRoot 'browsers'
$WrapperFile   = Join-Path $InstallRoot 'run-daemon.ps1'
$DataDir       = 'C:\ProgramData\Ambit Agent'
$LogsDir       = Join-Path $DataDir 'logs'
$ConfigFile    = Join-Path $DataDir 'config'
$TaskName      = 'AmbitAgentRuntime'

function Write-Info { param($m) Write-Host "[install] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[install] $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "[install] $m" -ForegroundColor Red; exit 1 }

# --- existing config ------------------------------------------------
# Read the config this machine is ALREADY running before writing a new
# one, because the per-machine fixes live in there and nowhere else.
#
# This script used to build the config from a fixed template and write it
# unconditionally. Every upgrade therefore silently reverted every
# hardening we had applied to that laptop -- AMBIT_CHROME_DISABLE_GPU on
# the machine whose GPU driver kills renderers, a raised health-probe
# threshold, a raised startup timeout. Those values are the accumulated
# knowledge of what is wrong with that particular machine, they were
# usually added during a support call, and an upgrade threw them away
# without a word. It has already caused one regression in the field.
#
# Same parse rules as readSystemConfig() in src/config.ts, so what the
# installer preserves is exactly what the daemon reads.
function Read-ExistingConfig {
    param($Path)
    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        $v = $t.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and
            (($v.StartsWith('"') -and $v.EndsWith('"')) -or
             ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $map[$k] = $v
    }
    return $map
}

$ExistingConfig = Read-ExistingConfig $ConfigFile
if ($ExistingConfig.Count -gt 0) {
    # ASCII only in displayed strings: this file has no BOM, and PowerShell
    # 5.1 (what Windows Server 2016 / Win10 ship) decodes a BOM-less .ps1 as
    # Windows-1252, so a UTF-8 em dash here reaches the customer's console as
    # mojibake. Comments can hold whatever they like; output cannot.
    Write-Info "Found an existing config with $($ExistingConfig.Count) setting(s) - these will be carried forward."
}

# Keys this installer owns and rewrites. Everything else in the file was
# put there by an operator and is carried forward.
$ManagedKeys = @('ADMIN_URL', 'ENROLLMENT_TOKEN', 'HEADLESS', 'PLAYWRIGHT_BROWSERS_PATH', 'LOG_LEVEL')

# --- config source ---------------------------------------------------
# Precedence: explicit env override > what this machine already had >
# first-install default. The middle term is the new one, and it is what
# makes a re-run an upgrade rather than a reset -- an operator who set
# LOG_LEVEL=debug to chase a problem keeps it, and an upgrade no longer
# demands the enrollment token be pasted again.
function Get-ConfigValue {
    param($Key, $EnvValue, $Default)
    if ($EnvValue) { return $EnvValue }
    # A key present but BLANK (`LOG_LEVEL=`, from a half-finished hand edit)
    # counts as absent, not as an empty answer -- otherwise the blank
    # propagates into the new config and the daemon reads '' where it
    # expects a level. Matches the `${VAR:-default}` behaviour on the
    # Ubuntu side, so both installers resolve identically.
    if ($ExistingConfig.Contains($Key) -and
        -not [string]::IsNullOrWhiteSpace([string]$ExistingConfig[$Key])) {
        return $ExistingConfig[$Key]
    }
    return $Default
}

$AdminUrl        = Get-ConfigValue 'ADMIN_URL'        $env:AMBIT_ADMIN_URL        ''
$EnrollmentToken = Get-ConfigValue 'ENROLLMENT_TOKEN' $env:AMBIT_ENROLLMENT_TOKEN ''
$Headless        = Get-ConfigValue 'HEADLESS'         $env:AMBIT_HEADLESS         'false'
$LogLevel        = Get-ConfigValue 'LOG_LEVEL'        $env:AMBIT_LOG_LEVEL        'info'
$RunAsUser       = if ($env:AMBIT_RUN_AS_USER)        { $env:AMBIT_RUN_AS_USER }  else { '' }

if (-not $AdminUrl) {
    if ([Environment]::UserInteractive) {
        $AdminUrl = Read-Host 'Admin control-plane URL (e.g. https://ambitagent-prod.herokuapp.com)'
    } else {
        Write-Fail 'AMBIT_ADMIN_URL not set and no interactive session for prompt.'
    }
}
if (-not $EnrollmentToken) {
    if ([Environment]::UserInteractive) {
        $EnrollmentToken = Read-Host 'Enrollment token (from portal /staff/runtimes)'
    } else {
        Write-Fail 'AMBIT_ENROLLMENT_TOKEN not set and no interactive session for prompt.'
    }
}
if (-not $AdminUrl -or -not $EnrollmentToken) {
    Write-Fail 'ADMIN_URL and ENROLLMENT_TOKEN are both required.'
}

# The run-as user needs to match whoever will actually be logged into
# this machine when runs are triggered. In UAC-elevated PowerShell, the
# elevated session may be running as a different user than the logged-in
# desktop user, so we take the *interactive* user as the default and
# offer to override.
$CurrentInteractiveUser = & whoami
if (-not $RunAsUser) {
    if ([Environment]::UserInteractive) {
        $prompt = "Run task as user [default: $CurrentInteractiveUser]"
        $entered = Read-Host $prompt
        $RunAsUser = if ([string]::IsNullOrWhiteSpace($entered)) { $CurrentInteractiveUser } else { $entered }
    } else {
        $RunAsUser = $CurrentInteractiveUser
    }
}
Write-Info "Task will run as: $RunAsUser (at that user's logon)"

# --- payload discovery -----------------------------------------------
# The installer must be able to find its zip next to itself. Handles two
# invocation styles:
#   - .\install.ps1 from an unpacked folder ($PSScriptRoot works)
#   - Get-Content install.ps1 | Invoke-Expression ($PSScriptRoot is null;
#     zip must then be in the current directory)
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Write-Info "Looking for ambitagent-client-*.zip in $ScriptDir..."
$Payload = Get-ChildItem $ScriptDir -Filter 'ambitagent-client-*.zip' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Payload) {
    Write-Fail (
        "No ambitagent-client-*.zip found in $ScriptDir. Save the .zip attachment " +
        "from the install email into the SAME folder as this .ps1, then re-run."
    )
}
Write-Info "Using payload: $($Payload.Name) ($([math]::Round($Payload.Length / 1KB)) KB)"

# --- prereq: Node.js LTS ---------------------------------------------
function Refresh-Path {
    $env:Path =
        [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User')
}
$HasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

function Ensure-NodeLts {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $ver = & node -v
        if ($ver -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
            Write-Info "Node.js already installed ($ver) -- reusing."
            return
        }
        Write-Warn "Node.js $ver is too old (need >= 20). Upgrading via winget..."
    }
    if (-not $HasWinget) {
        Write-Fail (
            "Node.js LTS >= 20 is not installed and winget is unavailable. " +
            "Install Node.js LTS x64 manually from https://nodejs.org/en/download/ " +
            "and re-run this script."
        )
    }
    Write-Info "Installing Node.js LTS via winget..."
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget install Node.js failed (exit $LASTEXITCODE)." }
    Refresh-Path
}
Ensure-NodeLts

# --- prereq: Google Chrome -------------------------------------------
# The daemon's ChromeManager needs REAL Google Chrome (not Playwright's
# Chromium — different fingerprint, no Web Store extensions). Detect the
# three standard install locations before falling back to winget; if
# Chrome is already there we never touch it.
function Ensure-Chrome {
    $paths = @(
        (Join-Path $env:ProgramFiles       'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA       'Google\Chrome\Application\chrome.exe')
    )
    foreach ($p in $paths) {
        if ($p -and (Test-Path $p)) {
            Write-Info "Google Chrome already installed at $p -- reusing."
            return
        }
    }
    if (-not $HasWinget) {
        Write-Fail (
            "Google Chrome is not installed and winget is unavailable. " +
            "Install Chrome manually from https://www.google.com/chrome/ and re-run this script."
        )
    }
    Write-Info "Installing Google Chrome via winget..."
    & winget install --id Google.Chrome -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget install Chrome failed (exit $LASTEXITCODE)." }
    Refresh-Path
}
Ensure-Chrome

# --- dirs ------------------------------------------------------------
Write-Info "Preparing directories under $InstallRoot and $DataDir..."
foreach ($d in @($InstallRoot, $BrowsersDir, $DataDir, $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# --- extract source zip ----------------------------------------------
# Wipe the previous $AppDir so stale files never sneak into a new
# release. The Chrome profile lives in the user's home dir, NOT here,
# so this doesn't touch customer sessions.
if (Test-Path $AppDir) {
    Write-Info "Removing previous $AppDir..."
    Remove-Item -Recurse -Force $AppDir
}
Write-Info "Extracting $($Payload.Name) to $AppDir..."
Expand-Archive -Path $Payload.FullName -DestinationPath $AppDir -Force

# --- build -----------------------------------------------------------
Push-Location $AppDir
try {
    Write-Info "Installing daemon npm dependencies (npm ci)..."
    & npm ci
    if ($LASTEXITCODE -ne 0) { Write-Fail 'npm ci failed.' }

    Write-Info "Building daemon (tsc)..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail 'npm run build failed.' }

    Write-Info "Downloading Playwright Chromium into $BrowsersDir..."
    $env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersDir
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Fail 'playwright install chromium failed.' }
} finally {
    Pop-Location
}

# --- config file -----------------------------------------------------
Write-Info "Writing config to $ConfigFile..."
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# Carry forward every operator-added key. These are the machine-specific
# settings (GPU, timeouts, Chrome port/profile) that must outlive an
# upgrade -- see the note on Read-ExistingConfig above.
$preservedKeys = @($ExistingConfig.Keys | Where-Object { $ManagedKeys -notcontains $_ })
$preservedBlock = ''
if ($preservedKeys.Count -gt 0) {
    Write-Info "Preserving $($preservedKeys.Count) operator setting(s): $($preservedKeys -join ', ')"
    $preservedLines = foreach ($k in $preservedKeys) { "$k=$($ExistingConfig[$k])" }
    $preservedBlock = @"

# --- Preserved from the previous install -----------------------------
# Added by an operator on this machine, not by the installer. Carried
# forward on every upgrade. Delete a line here to drop it.
$($preservedLines -join "`n")
"@
}

$configContent = @"
# Ambit Agent runtime config. Written by install.ps1 at $stamp.
# The daemon reads this at startup -- see readSystemConfig() in src/config.ts.

ADMIN_URL=$AdminUrl
ENROLLMENT_TOKEN=$EnrollmentToken

# User-session Task Scheduler mode: the managed Chrome window IS visible
# on the user's desktop, so headful is fine (and required for the first
# Amazon/LMD sign-in). Set true only if the customer wants Chrome
# invisible and has already persisted sessions some other way.
HEADLESS=$Headless

# Playwright browser cache lives under Program Files (system-owned).
PLAYWRIGHT_BROWSERS_PATH=$BrowsersDir

LOG_LEVEL=$LogLevel
$preservedBlock
"@
[System.IO.File]::WriteAllText(
    $ConfigFile,
    $configContent,
    [System.Text.UTF8Encoding]::new($false)
)

# ACL on config: SYSTEM + Administrators full control, plus the run-as
# user READ (they need to load env vars from it at task start).
$acl = Get-Acl $ConfigFile
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    'NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    'BUILTIN\Administrators', 'FullControl', 'Allow')))
try {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $RunAsUser, 'Read', 'Allow')))
} catch {
    Write-Warn "Could not add Read ACE for '$RunAsUser' (may be a computed / group name). Task will still run if the user is a local Administrator."
}
Set-Acl -Path $ConfigFile -AclObject $acl

# LogsDir ACL: the run-as user needs write access (the wrapper redirects
# stdout/stderr there). Grant Modify to that user.
try {
    $logAcl = Get-Acl $LogsDir
    $logAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $RunAsUser, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -Path $LogsDir -AclObject $logAcl
} catch {
    Write-Warn "Could not grant Modify on $LogsDir to '$RunAsUser'. Logs may fall back to the user's %TEMP%."
}

# --- wrapper script --------------------------------------------------
# Copy the sibling run-daemon.ps1 into $InstallRoot. The Scheduled Task
# invokes this file (not node.exe directly) so we can source the config,
# set env vars, and redirect stdout/stderr in one place.
$SrcWrapper = Join-Path $ScriptDir 'run-daemon.ps1'
if (-not (Test-Path $SrcWrapper)) {
    Write-Fail (
        "run-daemon.ps1 not found in $ScriptDir. This installer needs it " +
        "alongside install.ps1 -- both should have arrived together in the install email."
    )
}
Write-Info "Installing wrapper to $WrapperFile..."
Copy-Item -Path $SrcWrapper -Destination $WrapperFile -Force

# Remove any run-daemon.vbs left by a prior installer version. We used to
# launch the daemon through a hidden VBScript to suppress the console
# window, but that orphaned node on Stop (WScript.Shell.Run spawns outside
# the task's job object). The wrapper now hides its own window via
# FreeConsole while staying Task Scheduler's direct in-job child, so the
# VBScript is gone and must not linger.
$StaleVbs = Join-Path $InstallRoot 'run-daemon.vbs'
if (Test-Path $StaleVbs) { Remove-Item -Path $StaleVbs -Force -ErrorAction SilentlyContinue }

# --- Scheduled Task registration -------------------------------------
# Idempotence: remove any prior task before re-registering.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Info "Removing existing scheduled task $TaskName..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Info "Registering Scheduled Task '$TaskName' (at logon of $RunAsUser)..."
# Launch through conhost.exe so the console uses the classic host, not
# Windows Terminal. WT ignores -WindowStyle Hidden and can't be hidden in
# process (its window is a separate windowsterminal.exe); conhost honors
# it. node shares this hidden console, so Task Scheduler's Stop tears the
# whole tree down via the shared-console cascade (no orphaned daemon).
$action = New-ScheduledTaskAction `
    -Execute 'conhost.exe' `
    -Argument "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WrapperFile`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
# LogonType Interactive: task fires ONLY when the user has an interactive
# session (visible desktop). Perfect for showing Chrome when a run
# triggers, and no stored password required.
$principal = New-ScheduledTaskPrincipal `
    -UserId $RunAsUser `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # unlimited
Register-ScheduledTask `
    -TaskName $TaskName `
    -Description 'Ambit Agent runtime daemon (user-session mode). Idle until admin sends a run_task; launches managed Chrome for headful agent runs.' `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings | Out-Null

# Try to start it now IF the run-as user matches the current interactive
# session. When installer is run by (elevated) UserA for a task that
# targets UserB, we can't start it -- UserB has to log in first.
$CurrentUserLower = ($CurrentInteractiveUser -as [string]).ToLower()
$RunAsUserLower   = ($RunAsUser -as [string]).ToLower()
if ($CurrentUserLower -eq $RunAsUserLower -or $CurrentUserLower.EndsWith("\$RunAsUserLower") -or $RunAsUserLower.EndsWith("\$CurrentUserLower")) {
    Write-Info "Starting task now (matches current session)..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    Write-Info "Task state: $state"
} else {
    Write-Warn (
        "Not starting task now -- installer is running as '$CurrentInteractiveUser' but " +
        "the task is registered for '$RunAsUser'. Log in as '$RunAsUser' to trigger the first run."
    )
}

Write-Host ""
Write-Host "[install] Done."
Write-Host ""
Write-Host "  Task status:      Get-ScheduledTask -TaskName $TaskName | Format-List State,LastRunTime,LastTaskResult"
Write-Host "  Tail stdout:      Get-Content -Wait -Tail 30 '$(Join-Path $LogsDir 'stdout.log')'"
Write-Host "  Tail stderr:      Get-Content -Wait -Tail 30 '$(Join-Path $LogsDir 'stderr.log')'"
Write-Host "  Restart:          Stop-ScheduledTask -TaskName $TaskName; Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Edit config:      notepad '$ConfigFile'  # then restart"
Write-Host ""
Write-Host "Portal > Staff > Runtimes should show this runtime as **online**"
Write-Host "within about 15 seconds after '$RunAsUser' logs in. If it stays"
Write-Host "offline, check '$(Join-Path $LogsDir 'stderr.log')' -- the most"
Write-Host "common causes are a wrong ADMIN_URL or a token already used on"
Write-Host "another machine."
