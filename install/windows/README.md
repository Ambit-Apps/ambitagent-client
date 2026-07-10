# Ambit Agent — Windows install

Installs the Ambit Agent runtime daemon as a Windows service on a
customer's Windows 10 / 11 VM. Uses NSSM (Non-Sucking Service Manager)
to wrap the Node process — same restart-on-crash semantics as the
Ubuntu install's systemd unit.

> **Status: untested against a real Windows VM.** The script mirrors
> `install.sh` step-for-step but the first customer install should be
> supervised — surface any issues to `install/windows/README.md`.

## Prerequisites

- **Windows 10 (21H2+) or Windows 11.** Windows Server 2022 will also
  work but you may need to install "App Installer" from the Microsoft
  Store to get `winget`.
- Administrator access on the VM.
- **PowerShell 5.1** (ships with Windows) or PowerShell 7+.
- An **enrollment token** — generated in the portal at
  `/staff/runtimes` ⇢ **+ Enroll runtime**. Shown once; copy immediately.

## Install

From an **elevated** PowerShell prompt (right-click PowerShell ⇢ Run as
Administrator):

```powershell
# Force TLS 1.2 — Windows PowerShell 5.1 defaults to TLS 1.0/1.1 which
# GitHub refuses. Not needed on PowerShell 7+.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$env:AMBIT_ADMIN_URL='https://ambitagent-prod.example.com'
$env:AMBIT_ENROLLMENT_TOKEN='<token-from-portal>'
iwr https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/windows/install.ps1 -UseBasicParsing | iex
```

Prefer to inspect first:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
iwr https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/windows/install.ps1 `
  -UseBasicParsing -OutFile install.ps1
notepad install.ps1
.\install.ps1     # will prompt for AMBIT_ADMIN_URL + AMBIT_ENROLLMENT_TOKEN
```

## What the installer does

| Step | Result |
|---|---|
| Node.js LTS (winget) if missing | `node -v` ⇢ `v20.x` |
| Git (winget) if missing | `git --version` |
| NSSM (winget) if missing | `nssm --version` |
| Daemon source | `C:\Program Files\Ambit Agent\app\` (git clone, depth 1) |
| Compiled JS | `C:\Program Files\Ambit Agent\app\dist\` |
| Chromium | `C:\Program Files\Ambit Agent\browsers\` |
| Config file | `C:\ProgramData\Ambit Agent\config` (SYSTEM+Administrators only) |
| Logs | `C:\ProgramData\Ambit Agent\logs\stdout.log` (10 MB rotating) |
| Service | `ambit-agent` (auto-start, restart on crash, LocalSystem account) |

Within ~15 seconds the runtime should show as **online** in the portal
(`/staff/runtimes`).

## Operate

```powershell
# status
Get-Service ambit-agent

# tail live logs (Ctrl+C to stop)
Get-Content -Wait -Tail 30 'C:\ProgramData\Ambit Agent\logs\stdout.log'
Get-Content -Wait -Tail 30 'C:\ProgramData\Ambit Agent\logs\stderr.log'

# restart after editing the config file
Restart-Service ambit-agent

# stop
Stop-Service ambit-agent

# reconfigure the service via NSSM's GUI
nssm edit ambit-agent

# uninstall
Stop-Service ambit-agent
nssm remove ambit-agent confirm
Remove-Item -Recurse -Force 'C:\Program Files\Ambit Agent'
Remove-Item -Recurse -Force 'C:\ProgramData\Ambit Agent'
```

## Overridable env vars

Set these BEFORE running the installer (they're consumed at install
time; changing them later means re-running the installer or editing
the config file directly).

| Var | Default | Notes |
|---|---|---|
| `$env:AMBIT_CLIENT_GIT_URL` | `https://github.com/Ambit-Apps/ambitagent-client.git` | For a private mirror, embed a PAT: `https://TOKEN@github.com/...` |
| `$env:AMBIT_CLIENT_REF` | `main` | Any git ref — pin releases to a tag. |
| `$env:AMBIT_HEADLESS` | `true` | Windows services run in Session 0 with no visible desktop, so headful browsers render invisible anyway. |
| `$env:AMBIT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Troubleshooting

**Portal shows the runtime as offline.**

Check `C:\ProgramData\Ambit Agent\logs\stderr.log`:

- `WebSocket connection failed` ⇢ `ADMIN_URL` wrong, or the admin dyno
  is down. Edit `C:\ProgramData\Ambit Agent\config`, then
  `Restart-Service ambit-agent`.
- `4401 Unauthorized` ⇢ enrollment token was already used on a
  different machine. Enroll a fresh runtime in the portal.

**`iwr` fails with "Could not create SSL/TLS secure channel".**

Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub refuses.
Run this line first, then retry the install command:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
```

**`winget` not found.**

Windows 10 versions older than 21H2 don't ship App Installer. Install
it from the Microsoft Store, or upgrade to Win 11. On Windows Server
2022, install "App Installer" via `Add-AppxPackage`, OR install Node,
Git, and NSSM manually first — this installer detects existing
binaries via `Get-Command` and skips winget for anything already on
PATH.

**Chromium fails to launch — `Executable doesn't exist at ...`.**

`PLAYWRIGHT_BROWSERS_PATH` isn't reaching the service. Verify:

```powershell
Get-Content 'C:\ProgramData\Ambit Agent\config' | Select-String 'PLAYWRIGHT_BROWSERS_PATH'
```

Should print `PLAYWRIGHT_BROWSERS_PATH=C:\Program Files\Ambit Agent\browsers`.
If missing, re-run the installer.

**Service starts then immediately stops.**

The daemon exits when required config is missing — check
`stderr.log` for `Missing required config: ENROLLMENT_TOKEN` or
similar. Fix the config file, then `Restart-Service ambit-agent`.

**Chromium crashes with `A required privilege is not held...` or
similar sandbox errors.**

Chromium's sandbox on Windows expects LocalSystem or a service
account with specific privileges. LocalSystem (the installer default)
should work. If you switched `ObjectName` via `nssm edit`, either
revert to LocalSystem or grant the alternate account
`SeAssignPrimaryTokenPrivilege`.

## Hardening TODOs (deferred, Phase 2)

- **Non-LocalSystem service account.** LocalSystem is more permissive
  than we need. Switching to `NT SERVICE\ambit-agent` (virtual account)
  requires re-ACLing the install dir + granting `SeServiceLogonRight`.
  Skipped for MVP; documented for later.
- **MSI installer with code-signing cert.** Double-click install UX
  for non-technical customers, avoiding SmartScreen warnings. Requires
  ~$100–300/yr code-signing cert. Worth doing once the first
  self-install customer materializes.
- **Windows Defender exclusions.** Playwright's Chromium binary + the
  `node_modules` tree can trigger real-time-scan slowdowns. Adding
  `C:\Program Files\Ambit Agent` as a Defender exclusion would speed
  cold starts noticeably, but requires customer/IT approval.
