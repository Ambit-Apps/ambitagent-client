# Ambit Agent runtime -- Scheduled Task wrapper.
#
# What Task Scheduler runs at the user's logon. Kept minimal on purpose:
# the daemon (dist/main.js) does the interesting work; this file only
# handles the two things Task Scheduler doesn't do for us:
#   1. Load the KEY=VALUE config into process env (Node.js reads env vars
#      via dotenv, but Task Scheduler doesn't seed them).
#   2. Redirect stdout + stderr into rotatable log files. Without this
#      the daemon's output disappears into the ether -- Task Scheduler's
#      "Last Run Result" gives no useful debugging surface.
#
# Copied to `C:\Program Files\Ambit Agent\run-daemon.ps1` by install.ps1.
# Do not edit in place -- the next installer run will overwrite it.

$ErrorActionPreference = 'Continue'   # keep going through non-fatal errors
Set-StrictMode -Version 3.0

$AppDir     = 'C:\Program Files\Ambit Agent\app'
$ConfigFile = 'C:\ProgramData\Ambit Agent\config'
$LogsDir    = 'C:\ProgramData\Ambit Agent\logs'
$StdoutLog  = Join-Path $LogsDir 'stdout.log'
$StderrLog  = Join-Path $LogsDir 'stderr.log'

# --- log rotation (poor man's) ---------------------------------------
# The daemon runs indefinitely so stdout.log grows unbounded. Rotate at
# 10 MB by moving the current log aside; keep one backup. Matches the
# NSSM behavior the old installer had.
function Rotate-If-Large {
    param([string]$Path, [int]$MaxBytes = 10485760)
    if (-not (Test-Path $Path)) { return }
    $size = (Get-Item $Path).Length
    if ($size -lt $MaxBytes) { return }
    $backup = "$Path.1"
    if (Test-Path $backup) { Remove-Item -Force $backup }
    Move-Item -Force $Path $backup
}
foreach ($d in @($LogsDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
Rotate-If-Large $StdoutLog
Rotate-If-Large $StderrLog

# --- load config -----------------------------------------------------
if (-not (Test-Path $ConfigFile)) {
    "$(Get-Date -Format o) [wrapper] FATAL: config file missing at $ConfigFile" |
        Out-File -FilePath $StderrLog -Append -Encoding utf8
    exit 1
}
foreach ($line in (Get-Content $ConfigFile)) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*([^=]+?)\s*=\s*(.*)\s*$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}

# --- launch daemon ---------------------------------------------------
$MainJs = Join-Path $AppDir 'dist\main.js'
if (-not (Test-Path $MainJs)) {
    "$(Get-Date -Format o) [wrapper] FATAL: daemon build missing at $MainJs (did install.ps1 finish?)" |
        Out-File -FilePath $StderrLog -Append -Encoding utf8
    exit 1
}

"$(Get-Date -Format o) [wrapper] launching daemon (node $MainJs)" |
    Out-File -FilePath $StdoutLog -Append -Encoding utf8

Set-Location $AppDir

# Foreground invocation. Runs node as a direct child of THIS PowerShell
# process, in the same session and process tree.
#
# Why not Start-Process -Wait: Task Scheduler's "Stop" action kills only
# the PowerShell process it launched, not its children. Start-Process
# spawned children survive that kill and become orphan daemons — each
# Stop→Start cycle then leaves the old node alive alongside the new one,
# and multiple daemons race on the same enrollment token (visible as
# "Superseded by new connection" churn in the admin logs). Foreground `&`
# invocation keeps node as a real child so it dies with the wrapper.
#
# Stream redirection: `1>>` appends stdout, `2>>` appends stderr, both
# native PowerShell operators that work on external processes' streams.
$node = (Get-Command node).Source
& $node $MainJs 1>>$StdoutLog 2>>$StderrLog

$exitCode = $LASTEXITCODE
"$(Get-Date -Format o) [wrapper] daemon exited (code=$exitCode)" |
    Out-File -FilePath $StdoutLog -Append -Encoding utf8
exit $exitCode
