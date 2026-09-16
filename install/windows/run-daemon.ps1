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

# --- hide the console window -----------------------------------------
# Task Scheduler launches this wrapper via `conhost.exe powershell.exe
# -WindowStyle Hidden ...` (see install.ps1). Routing through conhost.exe
# forces the CLASSIC console host instead of Windows Terminal. This matters
# for TWO reasons that we learned the hard way:
#
#   1. Hiding: Windows Terminal ignores -WindowStyle Hidden and cannot be
#      hidden from inside the process (its window belongs to a separate
#      windowsterminal.exe). conhost honors -WindowStyle Hidden, and the
#      ShowWindow(SW_HIDE) below reinforces it.
#   2. Teardown: node must SHARE this console. Task Scheduler's Stop
#      destroys the wrapper's console, which takes the node child down with
#      it — that shared-console cascade IS the teardown. Anything that
#      gives node its own console (FreeConsole) or spawns it outside the
#      job (a wscript/ShellExecute launcher) orphans node — it keeps
#      running and reporting "online" after Stop. Both were tried; both
#      failed. Do not reintroduce them.
try {
    if (-not ([System.Management.Automation.PSTypeName]'AmbitConsole.AmbitWin').Type) {
        Add-Type -Namespace 'AmbitConsole' -Name 'AmbitWin' -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")]   public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    }
    $consoleHandle = [AmbitConsole.AmbitWin]::GetConsoleWindow()
    if ($consoleHandle -ne [System.IntPtr]::Zero) {
        [AmbitConsole.AmbitWin]::ShowWindow($consoleHandle, 0) | Out-Null   # 0 = SW_HIDE
    }
} catch {
    # Non-fatal: worst case the window stays visible. Never let a hide
    # failure stop the runtime.
}

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

# Foreground invocation — node runs as a direct child of THIS PowerShell,
# sharing its (hidden) console, with stdout/stderr appended to the logs.
# This is the launch that reliably brings the daemon online; Start-Process
# variants launched node with the wrong working dir / no stdin and it
# exited immediately (code -1).
#
# NOTE — teardown on task Stop is deliberately NOT handled here. On this
# Windows build, Task Scheduler's Stop kills only conhost (our parent) and
# does NOT cascade to node, so a stopped task can leave node running
# ("online" in the portal). Every wrapper-side attempt to fix that failed
# (shared-console cascade doesn't happen; FreeConsole gives node its own
# console; a wscript/ShellExecute launcher and Start-Process supervision
# broke startup or orphaned node). The durable fix belongs in the node
# daemon itself — the one process guaranteed to survive the Stop. Until
# then, to fully stop the runtime, kill the Ambit node process directly.
$node = (Get-Command node).Source
& $node $MainJs 1>>$StdoutLog 2>>$StderrLog

$exitCode = $LASTEXITCODE
"$(Get-Date -Format o) [wrapper] daemon exited (code=$exitCode)" |
    Out-File -FilePath $StdoutLog -Append -Encoding utf8
exit $exitCode
