#Requires -RunAsAdministrator
#
# Ambit Agent runtime -- Windows uninstaller.
#
# Tears down what install.ps1 (Task Scheduler variant) sets up:
#   - Unregisters the AmbitAgentRuntime scheduled task
#   - Kills any lingering daemon node.exe
#   - Removes C:\Program Files\Ambit Agent (app + browsers + wrapper)
#   - Removes C:\ProgramData\Ambit Agent (config + logs) UNLESS -KeepConfig
#   - Optionally wipes the managed Chrome profile with -WipeChromeProfile
#
# Self-contained: no dependencies on the install .zip or source repo.
# Safe to send as a single .ps1 attachment for customer-side removal.
#
# Usage (elevated PowerShell):
#
#   .\uninstall.ps1                          # full teardown, keeps Chrome profile
#   .\uninstall.ps1 -KeepConfig              # preserves config file (fast reinstall)
#   .\uninstall.ps1 -WipeChromeProfile       # also removes ~\.ambit\chrome-profile
#   .\uninstall.ps1 -RunAsUser DOMAIN\alice  # target a specific user's Chrome profile
#
# Idempotent: safe to run against a machine that's already clean.
# --------------------------------------------------------------------

[CmdletBinding()]
param(
    [switch]$KeepConfig,
    [switch]$WipeChromeProfile,
    [string]$RunAsUser = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Continue'   # keep going through missing pieces

$InstallRoot = 'C:\Program Files\Ambit Agent'
$DataDir     = 'C:\ProgramData\Ambit Agent'
$TaskName    = 'AmbitAgentRuntime'
# Also handle the LEGACY NSSM service name, in case this uninstaller is
# being run against a machine that was set up by the old install.ps1
# variant (NSSM service instead of scheduled task).
$LegacyServiceName = 'ambit-agent'

function Write-Info { param($m) Write-Host "[uninstall] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[uninstall] $m" -ForegroundColor Yellow }

# --- 1. Scheduled Task (new install layout) --------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Info "Stopping scheduled task $TaskName..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Info "Unregistering scheduled task $TaskName..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
} else {
    Write-Info "No scheduled task $TaskName -- skipping."
}

# --- 2. Legacy NSSM service (old install layout) ---------------------
$svc = Get-Service $LegacyServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Info "Legacy NSSM service detected -- tearing it down."
    Stop-Service $LegacyServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Get-Command nssm -ErrorAction SilentlyContinue) {
        & nssm remove $LegacyServiceName confirm | Out-Null
    } else {
        Write-Warn "nssm not on PATH; trying sc.exe delete as fallback."
        & sc.exe delete $LegacyServiceName | Out-Null
    }
}

# --- 3. Kill any lingering daemon node.exe ---------------------------
$daemonNodes = Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "$InstallRoot\*" }
if ($daemonNodes) {
    Write-Info "Killing $($daemonNodes.Count) lingering daemon node.exe process(es)..."
    $daemonNodes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# --- 4. Remove install directory -------------------------------------
if (Test-Path $InstallRoot) {
    Write-Info "Removing $InstallRoot..."
    Remove-Item -Recurse -Force $InstallRoot -ErrorAction SilentlyContinue
    if (Test-Path $InstallRoot) {
        Write-Warn "$InstallRoot still exists (open file handle?). Retry after a reboot if needed."
    }
} else {
    Write-Info "No install dir at $InstallRoot -- skipping."
}

# --- 5. Remove data directory (config + logs) unless -KeepConfig -----
if ($KeepConfig) {
    Write-Info "Preserving $DataDir (--KeepConfig)."
} elseif (Test-Path $DataDir) {
    Write-Info "Removing $DataDir (config + logs)..."
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
}

# --- 6. Managed Chrome profile (opt-in) ------------------------------
# The daemon stores its dedicated Chrome profile under the RUN-AS user's
# home dir, NOT Program Files -- so we need the username to find it.
# Default target: the interactive user who invoked this script. Override
# via -RunAsUser DOMAIN\alice for a different account.
if ($WipeChromeProfile) {
    $targetUser = if ($RunAsUser) { $RunAsUser } else { & whoami }
    # Strip domain prefix if present -- home dirs use just the sAMAccountName.
    $bareName = $targetUser -replace '^.*\\', ''
    $profileDir = "C:\Users\$bareName\.ambit\chrome-profile"
    if (Test-Path $profileDir) {
        Write-Info "Wiping managed Chrome profile at $profileDir..."
        Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
    } else {
        Write-Info "No Chrome profile at $profileDir -- skipping."
    }
    $parent = "C:\Users\$bareName\.ambit"
    if ((Test-Path $parent) -and -not (Get-ChildItem $parent -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $parent -ErrorAction SilentlyContinue
    }
} else {
    Write-Info "Preserving managed Chrome profile (pass -WipeChromeProfile to remove it)."
}

# --- 7. Verify -------------------------------------------------------
Write-Host ""
Write-Host "[uninstall] Verification:" -ForegroundColor Cyan
$checks = @(
    @{ Label = "Scheduled task '$TaskName'";       Test = { -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) } }
    @{ Label = "Legacy service '$LegacyServiceName'"; Test = { -not (Get-Service $LegacyServiceName -ErrorAction SilentlyContinue) } }
    @{ Label = "Install dir '$InstallRoot'";        Test = { -not (Test-Path $InstallRoot) } }
    @{ Label = "Data dir '$DataDir'";               Test = { $KeepConfig -or -not (Test-Path $DataDir) } }
)
$allClean = $true
foreach ($c in $checks) {
    $ok = & $c.Test
    if (-not $ok) { $allClean = $false }
    $mark = if ($ok) { '[ok]' } else { '[still present]' }
    $color = if ($ok) { 'Green' } else { 'Yellow' }
    Write-Host "  $mark $($c.Label)" -ForegroundColor $color
}

Write-Host ""
if ($allClean) {
    Write-Host "[uninstall] Done. Machine is clean." -ForegroundColor Green
} else {
    Write-Warn "One or more items are still present. See warnings above."
    Write-Warn "The most common cause is an open file handle -- reboot and re-run uninstall.ps1."
}
