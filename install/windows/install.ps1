#Requires -RunAsAdministrator
#
# Ambit Agent runtime — Windows installer.
#
# What it does, in order:
#   1.  Elevation is enforced by the #Requires directive above.
#   2.  Collects ADMIN_URL + ENROLLMENT_TOKEN (env vars OR interactive prompts).
#   3.  Installs Node.js LTS, Git, and NSSM via winget if missing.
#   4.  Creates dirs under Program Files + ProgramData.
#   5.  Clones (or updates) the client repo into "C:\Program Files\Ambit Agent\app".
#   6.  Runs `npm ci` + `npm run build`.
#   7.  Downloads Playwright Chromium into "C:\Program Files\Ambit Agent\browsers".
#   8.  Writes "C:\ProgramData\Ambit Agent\config" with restrictive ACLs
#       (SYSTEM + Administrators only).
#   9.  Registers an NSSM-wrapped service `ambit-agent`, sets restart
#       policy + log rotation, and starts it.
#
# Usage — one-liner from an elevated PowerShell prompt:
#
#   $env:AMBIT_ADMIN_URL='https://ambitagent-prod.example.com'
#   $env:AMBIT_ENROLLMENT_TOKEN='<token-from-portal>'
#   iwr https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/windows/install.ps1 -UseBasicParsing | iex
#
# Or interactive (prompts for both values):
#
#   iwr https://.../install.ps1 -UseBasicParsing -OutFile install.ps1
#   Get-Content install.ps1 | more   # review before running
#   .\install.ps1
#
# Re-running is safe — the script is idempotent (winget skips already-
# installed packages, git fetch+reset updates the checkout in place,
# and the service is torn down + reinstalled cleanly).
#
# --------------------------------------------------------------------
# Overridable env vars (rarely needed):
#   $env:AMBIT_CLIENT_GIT_URL   Where to clone from. Default: public Ambit-Apps repo.
#   $env:AMBIT_CLIENT_REF       Branch / tag / commit. Default: main.
#   $env:AMBIT_HEADLESS         true|false. Default: true. Windows services run in
#                                Session 0 (no visible desktop) so headful browsers
#                                would render invisibly regardless.
#   $env:AMBIT_LOG_LEVEL        debug|info|warn|error. Default: info.
# --------------------------------------------------------------------

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$InstallRoot   = 'C:\Program Files\Ambit Agent'
$AppDir        = Join-Path $InstallRoot 'app'
$BrowsersDir   = Join-Path $InstallRoot 'browsers'
$DataDir       = 'C:\ProgramData\Ambit Agent'
$LogsDir       = Join-Path $DataDir 'logs'
$ConfigFile    = Join-Path $DataDir 'config'
$ServiceName   = 'ambit-agent'
$DefaultGitUrl = 'https://github.com/Ambit-Apps/ambitagent-client.git'
$DefaultRef    = 'main'

function Write-Info { param($m) Write-Host "[install] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[install] $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "[install] $m" -ForegroundColor Red; exit 1 }

# ─── config source ───────────────────────────────────────────────────
$AdminUrl        = if ($env:AMBIT_ADMIN_URL)        { $env:AMBIT_ADMIN_URL }        else { '' }
$EnrollmentToken = if ($env:AMBIT_ENROLLMENT_TOKEN) { $env:AMBIT_ENROLLMENT_TOKEN } else { '' }
$ClientGitUrl    = if ($env:AMBIT_CLIENT_GIT_URL)   { $env:AMBIT_CLIENT_GIT_URL }   else { $DefaultGitUrl }
$ClientRef       = if ($env:AMBIT_CLIENT_REF)       { $env:AMBIT_CLIENT_REF }       else { $DefaultRef }
$Headless        = if ($env:AMBIT_HEADLESS)         { $env:AMBIT_HEADLESS }         else { 'true' }
$LogLevel        = if ($env:AMBIT_LOG_LEVEL)        { $env:AMBIT_LOG_LEVEL }        else { 'info' }

if (-not $AdminUrl) {
    if ([Environment]::UserInteractive) {
        $AdminUrl = Read-Host 'Admin control-plane URL (e.g. https://api.ambitagent.com)'
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

# ─── prereqs via winget ──────────────────────────────────────────────
function Refresh-Path {
    $env:Path =
        [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Fail 'winget is required but not found. Install "App Installer" from the Microsoft Store, or use Windows 10 21H2+ / Windows 11.'
}

function Ensure-Package {
    param(
        [string]$Id,
        [string]$Name,
        [scriptblock]$AlreadyThere
    )
    if (& $AlreadyThere) {
        Write-Info "$Name already installed — reusing."
        return
    }
    Write-Info "Installing $Name via winget…"
    & winget install --id $Id -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "winget install $Id failed (exit $LASTEXITCODE)."
    }
    Refresh-Path
}

Ensure-Package -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS' -AlreadyThere {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $ver = & node -v
    return ($ver -match '^v(\d+)') -and ([int]$Matches[1] -ge 20)
}

Ensure-Package -Id 'Git.Git' -Name 'Git' -AlreadyThere {
    [bool](Get-Command git -ErrorAction SilentlyContinue)
}

Ensure-Package -Id 'NSSM.NSSM' -Name 'NSSM' -AlreadyThere {
    [bool](Get-Command nssm -ErrorAction SilentlyContinue)
}

# ─── dirs ────────────────────────────────────────────────────────────
Write-Info "Preparing directories under $InstallRoot and $DataDir…"
foreach ($d in @($InstallRoot, $BrowsersDir, $DataDir, $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# ─── daemon source ───────────────────────────────────────────────────
if (Test-Path (Join-Path $AppDir '.git')) {
    Write-Info "Updating existing checkout at $AppDir (ref=$ClientRef)…"
    Push-Location $AppDir
    try {
        & git fetch --depth 1 origin $ClientRef
        & git checkout -f $ClientRef
        & git reset --hard "origin/$ClientRef"
        if ($LASTEXITCODE -ne 0) { & git reset --hard $ClientRef }
    } finally {
        Pop-Location
    }
} else {
    Write-Info "Cloning $ClientGitUrl @ $ClientRef into $AppDir…"
    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    & git clone --depth 1 --branch $ClientRef $ClientGitUrl $AppDir
    if ($LASTEXITCODE -ne 0) { Write-Fail 'git clone failed.' }
}

# ─── build ───────────────────────────────────────────────────────────
Push-Location $AppDir
try {
    Write-Info "Installing daemon npm dependencies (npm ci)…"
    & npm ci
    if ($LASTEXITCODE -ne 0) { Write-Fail 'npm ci failed.' }

    Write-Info "Building daemon (tsc)…"
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail 'npm run build failed.' }

    Write-Info "Downloading Playwright Chromium into $BrowsersDir…"
    # PLAYWRIGHT_BROWSERS_PATH controls where the browser is downloaded;
    # sits under Program Files so ordinary users can't tamper with it
    # and Windows Defender treats it as system-owned.
    $env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersDir
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Fail 'playwright install chromium failed.' }
} finally {
    Pop-Location
}

# ─── config file ─────────────────────────────────────────────────────
Write-Info "Writing config to $ConfigFile…"

# Same shell-style KEY=VALUE the Ubuntu installer produces. The daemon's
# config loader (src/config.ts) reads either file based on process.platform.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$configContent = @"
# Ambit Agent runtime config. Written by install.ps1 at $stamp.
# The daemon reads this at startup — see readSystemConfig() in src/config.ts.

ADMIN_URL=$AdminUrl
ENROLLMENT_TOKEN=$EnrollmentToken

# Windows services run in Session 0 with no visible desktop; a headful
# Chromium would render invisible regardless. Keep true unless you have
# a specific reason to change it.
HEADLESS=$Headless

# Playwright browser cache lives under Program Files, protected from
# ordinary-user writes.
PLAYWRIGHT_BROWSERS_PATH=$BrowsersDir

LOG_LEVEL=$LogLevel
"@

# Write UTF-8 without BOM — PS 5.1's Set-Content -Encoding utf8 emits
# a BOM, and while the daemon's parser tolerates it (String.trim strips
# ﻿), avoiding it upfront is cleaner and matches Linux tooling.
[System.IO.File]::WriteAllText(
    $ConfigFile,
    $configContent,
    [System.Text.UTF8Encoding]::new($false)
)

# ACL: SYSTEM + Administrators full control, nothing else. The service
# runs as LocalSystem (see NSSM ObjectName below) so SYSTEM is the
# effective read principal.
$acl = Get-Acl $ConfigFile
$acl.SetAccessRuleProtection($true, $false)   # disable inheritance, purge parent ACEs
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
$sysRule   = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')
$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'BUILTIN\Administrators', 'FullControl', 'Allow')
$acl.AddAccessRule($sysRule)
$acl.AddAccessRule($adminRule)
Set-Acl -Path $ConfigFile -AclObject $acl

# ─── NSSM service ────────────────────────────────────────────────────
$nodeExe = (Get-Command node).Source
$mainJs  = Join-Path $AppDir 'dist\main.js'
if (-not (Test-Path $mainJs)) {
    Write-Fail "Build output missing: $mainJs (did tsc succeed?)."
}

# Idempotence: teardown any existing service registration first, so we
# don't accumulate config drift across reinstalls.
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Write-Info "Stopping existing service $ServiceName…"
    & nssm stop $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
    Write-Info "Removing existing service registration…"
    & nssm remove $ServiceName confirm | Out-Null
}

Write-Info "Registering service $ServiceName (NSSM)…"
& nssm install $ServiceName $nodeExe $mainJs                                 | Out-Null
& nssm set $ServiceName AppDirectory $AppDir                                 | Out-Null
& nssm set $ServiceName DisplayName 'Ambit Agent Runtime'                    | Out-Null
& nssm set $ServiceName Description 'Ambit Agent — local runtime daemon for browser-type automation tasks.' | Out-Null
& nssm set $ServiceName Start SERVICE_AUTO_START                             | Out-Null

# Restart policy — matches systemd's Restart=always, RestartSec=5.
& nssm set $ServiceName AppExit Default Restart                              | Out-Null
& nssm set $ServiceName AppRestartDelay 5000                                 | Out-Null

# Log rotation — NSSM writes stdout/stderr to files it rotates when
# they exceed AppRotateBytes. Rotated files get .N suffixes in $LogsDir.
$stdoutLog = Join-Path $LogsDir 'stdout.log'
$stderrLog = Join-Path $LogsDir 'stderr.log'
& nssm set $ServiceName AppStdout $stdoutLog                                 | Out-Null
& nssm set $ServiceName AppStderr $stderrLog                                 | Out-Null
& nssm set $ServiceName AppRotateFiles 1                                     | Out-Null
& nssm set $ServiceName AppRotateBytes 10485760                              | Out-Null   # 10 MB
& nssm set $ServiceName AppStdoutCreationDisposition 4                       | Out-Null   # OPEN_ALWAYS
& nssm set $ServiceName AppStderrCreationDisposition 4                       | Out-Null

# Service account — LocalSystem for MVP simplicity. Windows equivalent
# to systemd's User=ambit-agent would be an "NT SERVICE\ambit-agent"
# virtual account, but wiring that requires SeServiceLogonRight grants
# and per-directory ACL updates. LocalSystem is more permissive than
# ideal; hardening to a virtual account is a Phase 2 item.
& nssm set $ServiceName ObjectName LocalSystem                               | Out-Null

Write-Info "Starting service $ServiceName…"
Start-Service $ServiceName
Start-Sleep -Seconds 2

Write-Info "Service status:"
Get-Service $ServiceName | Format-Table Status, Name, DisplayName -AutoSize

Write-Host ""
Write-Host "[install] Done."
Write-Host ""
Write-Host "  Service status:   Get-Service $ServiceName"
Write-Host "  Tail stdout:      Get-Content -Wait -Tail 30 '$stdoutLog'"
Write-Host "  Tail stderr:      Get-Content -Wait -Tail 30 '$stderrLog'"
Write-Host "  Restart:          Restart-Service $ServiceName"
Write-Host "  Edit config:      notepad $ConfigFile  # then Restart-Service"
Write-Host "  Reconfigure svc:  nssm edit $ServiceName"
Write-Host ""
Write-Host "Portal > Staff > Runtimes should show this runtime as **online**"
Write-Host "within about 15 seconds (the heartbeat interval). If it stays"
Write-Host "offline, check '$stderrLog' — the most common causes are a"
Write-Host "wrong ADMIN_URL or a token already used on another machine."
