# Ambit Agent — Windows install (zip + Task Scheduler)

Installs the Ambit Agent runtime as a Scheduled Task that runs in the
customer's own user session at logon. The daemon idles until the admin
sends a `run_task`, then launches a managed Chrome window on the
customer's desktop for headful browser agents (e.g. driver-wave-assignment
which uses `browser.model: "attached_chrome"`).

Distribution is via email attachment — no public repo, no PAT, no git.
The customer receives four files, saves them into a single folder, and
**double-clicks `install.bat`**. That wrapper self-elevates, clears the
"downloaded from the internet" block, and runs `install.ps1` — so the
customer never has to open PowerShell or type any commands.

## Why Task Scheduler (not a Windows service)

Windows services run in Session 0, which has no visible desktop.
Agents that use `attached_chrome` need a Chrome window the customer can
actually see (both for the one-time Amazon/LMD sign-in and to watch runs
happen). A Scheduled Task triggered "at logon of user X" runs the
daemon in user X's interactive session, so the managed Chrome renders
where they can see it. When they log out, the daemon exits too — but
runs are human-triggered anyway, so this is fine.

Trade-off you accept: no unattended overnight runs. Not a concern for
CG Logistics.

## What you (staff) ship

Four files, all attached to one email. The customer saves all four
into the same folder (typically Downloads).

| File | Source | Notes |
|---|---|---|
| `install.bat` | `install/windows/install.bat` in this repo | Same file for every customer. The customer double-clicks THIS one. |
| `install.ps1` | `install/windows/install.ps1` in this repo | Same file for every customer. Invoked by `install.bat`. |
| `run-daemon.ps1` | `install/windows/run-daemon.ps1` in this repo | Same file for every customer. |
| `ambitagent-client-<stamp>-<sha>.zip` | Produced by `install/build-installer-zip.sh` | Rebuilt on every client version bump. |

Plus in the email body:

- The **enrollment token** — generated in the portal at
  `/staff/runtimes` → **+ Enroll runtime**. Shown once; copy immediately.
- The **admin URL** — your Heroku prod app URL, e.g.
  `https://ambitagent-prod.herokuapp.com`.

## Building the zip

On your Mac, from anywhere in this repo:

```bash
./install/build-installer-zip.sh
```

Produces `install/dist/ambitagent-client-YYYYMMDD-HHMMSS-<sha>.zip`
containing `src/`, `package.json`, `package-lock.json`, `tsconfig.json`,
`README.md`. Refuses to build with uncommitted changes to shipped files
— override with `--dirty` for one-offs.

Output is `.gitignore`d.

## Customer install — the one-time flow

1. Save all four attachments from the install email into the SAME
   folder (typically Downloads).
2. **Double-click `install.bat`.**
   - If a blue "Windows protected your PC" / "Open File – Security
     Warning" box appears, click **More info → Run anyway** (or
     **Run**) — expected for an emailed file, one click.
   - A **User Account Control** prompt appears asking for administrator
     access — click **Yes**.
3. When prompted (in the black installer window):
   - **Admin URL:** paste from email body (e.g.
     `https://ambitagent-prod.herokuapp.com`).
   - **Enrollment token:** paste from email body.
   - **Run-as user:** press Enter to accept the current user — correct
     as long as the person installing is the same one who will be logged
     in when runs are triggered. (If you clicked **Yes** on UAC using a
     *separate* admin account, type the everyday login here instead —
     `DOMAIN\username`.)
4. Wait ~5 min. The script installs any missing prerequisites
   (Node.js LTS and Google Chrome via winget), then runs `npm ci`,
   builds, and downloads Playwright's Chromium.
5. Done. If the run-as user matches the current session, the task
   starts immediately; otherwise it fires next time that user logs in.

That's it — no PowerShell, no environment variables, no TLS settings,
no `Unblock-File` or ExecutionPolicy commands. `install.bat` handles
elevation and the internet-block, and `install.ps1` handles everything
else internally.

The runtime appears **online** in your portal (`/staff/runtimes`)
within ~15 s of the daemon starting.

### Fallback: running install.ps1 directly (advanced)

If a locked-down machine blocks `.bat` files, or you're driving the
install from an already-elevated PowerShell, you can skip the wrapper:
right-click **`install.ps1`** → **Run with PowerShell** as
Administrator. If Windows blocks it with a "script from the internet"
warning, run `Unblock-File .\install.ps1` first, or launch it via
`powershell.exe -ExecutionPolicy Bypass -File .\install.ps1`. This is
exactly what `install.bat` automates.

### First-run browser login (once per customer)

The daemon will launch a Chrome window branded "Ambit Agent — Managed
Chrome" on the customer's desktop. **They sign into Amazon Logistics
and LMD Max in that window once.** Those sessions persist in the
managed profile (`~\.ambit\chrome-profile`) across every subsequent
run — potentially for weeks until the platforms expire cookies.

## Operate

Elevated PowerShell:

```powershell
# Status
Get-ScheduledTask -TaskName AmbitAgentRuntime | Format-List State,LastRunTime,LastTaskResult

# Tail live logs
Get-Content -Wait -Tail 30 'C:\ProgramData\Ambit Agent\logs\stdout.log'
Get-Content -Wait -Tail 30 'C:\ProgramData\Ambit Agent\logs\stderr.log'

# Restart (kick the task without waiting for logon)
Stop-ScheduledTask  -TaskName AmbitAgentRuntime
Start-ScheduledTask -TaskName AmbitAgentRuntime

# Edit config, then restart
notepad 'C:\ProgramData\Ambit Agent\config'
Stop-ScheduledTask -TaskName AmbitAgentRuntime; Start-ScheduledTask -TaskName AmbitAgentRuntime
```

## Upgrade

Ship a new `.zip` (build with `build-installer-zip.sh`). Customer
drops the new zip into the same folder as `install.bat` (replacing
the old one) and double-clicks `install.bat` again. Config file
and Chrome profile are preserved; only the source under
`C:\Program Files\Ambit Agent\app\` is wiped and re-extracted.
(You only need to re-send the `.zip` on a version bump — the customer
already has `install.bat` / `install.ps1` / `run-daemon.ps1` from the
first install, though re-sending all four is harmless.)

## Uninstall

Ship `install/windows/uninstall.ps1` as a single-file attachment (no
zip needed; it's self-contained). Elevated PowerShell:

```powershell
# Full teardown, preserves the managed Chrome profile (so a reinstall
# skips the one-time Amazon/LMD sign-in).
.\uninstall.ps1

# Preserve config too (fast reinstall — customer keeps their enrollment).
.\uninstall.ps1 -KeepConfig

# Wipe everything including the customer's Amazon/LMD logins.
.\uninstall.ps1 -WipeChromeProfile

# Uninstall for a specific user's profile (default: whoever runs the script).
.\uninstall.ps1 -WipeChromeProfile -RunAsUser DOMAIN\alice
```

`uninstall.ps1` also detects and removes the LEGACY NSSM service layout
(from the old installer variant), so a single uninstall handles both
generations of installs.

## Overridable env vars (install-time, automation only)

Not needed for a normal manual install — the script prompts for
everything. Useful when scripting installs across many machines
(e.g. from a fleet-management tool). Set before running `install.ps1`.
Note: fleet automation should call `install.ps1` directly (already
elevated, non-interactive) rather than `install.bat` — the wrapper's
self-elevation raises an interactive UAC prompt, and its relaunch
starts a fresh process that won't inherit env vars set in your shell.

| Var | Default | Notes |
|---|---|---|
| `$env:AMBIT_ADMIN_URL` | prompt | Skip the interactive prompt. |
| `$env:AMBIT_ENROLLMENT_TOKEN` | prompt | Skip the interactive prompt. |
| `$env:AMBIT_RUN_AS_USER` | current interactive user | `DOMAIN\username` — the user whose logon triggers the task. |
| `$env:AMBIT_HEADLESS` | `false` | User-session mode CAN show Chrome; keep `false` unless there's a reason. |
| `$env:AMBIT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Runtime config-file options

The daemon reads `KEY=VALUE` lines from `C:\ProgramData\Ambit Agent\config`
at startup (this is the same file that holds `ADMIN_URL` and
`ENROLLMENT_TOKEN`). Add or edit a line, then restart the task:
`Stop-ScheduledTask -TaskName AmbitAgentRuntime; Start-ScheduledTask -TaskName AmbitAgentRuntime`.

| Key | Default | When to set it |
|---|---|---|
| `AMBIT_CHROME_DISABLE_GPU` | `false` | Set to `true` on a machine where Chrome crashes mid-run (the managed Chrome window vanishes, a browser agent errors with "Target page, context or browser has been closed", and it's NOT a memory problem). Forces software rendering (`--disable-gpu`), which trades a little paint speed for stability. Seen on older Intel iGPUs (e.g. UHD 620) whose driver kills the GPU process on device-loss. Overrides any enterprise policy that locks hardware acceleration on. |

Note: browser-agent behavior on genuinely slow machines is also tunable
per run via the agent's own inputs (e.g. driver-wave-assignment's
`page_load_timeout_ms`) — those live in the admin run form, not this file.

## Troubleshooting

**Runtime stays offline in the portal.**

Check `C:\ProgramData\Ambit Agent\logs\stderr.log`:

- `WebSocket connection failed` → `ADMIN_URL` wrong, or the admin app
  is down. Edit `C:\ProgramData\Ambit Agent\config` then restart.
- `4401 Unauthorized` → enrollment token was already consumed on
  another machine. Enroll a fresh runtime in the portal.
- File is empty → the task never started. See next.

**Task never starts.**

```powershell
Get-ScheduledTask -TaskName AmbitAgentRuntime | Format-List
```

- `State: Ready` but never runs → the user hasn't logged in since
  install. Log off / back on.
- `LastTaskResult: 267011` → task is disabled by policy. Ask the
  customer's IT to allow Scheduled Tasks under `\` (root folder).
- `LastTaskResult: 0x41306` → previous instance is stuck; run
  `Stop-ScheduledTask -TaskName AmbitAgentRuntime` then re-start.

**Chrome window never appears when a run triggers.**

- Confirm the daemon is running: `Get-Process node | Where-Object { $_.Path -like 'C:\Program Files\Ambit Agent\*' }` should show one process.
- Check `stderr.log` for Chromium launch errors. Common: `Executable doesn't exist at ...` → `PLAYWRIGHT_BROWSERS_PATH` not reaching the daemon (`Get-Content 'C:\ProgramData\Ambit Agent\config'` should include the line).

**winget missing.**

Windows 10 pre-21H2 doesn't ship App Installer (winget). The installer
uses winget to install two prerequisites if they're absent — **Node.js
LTS x64** and **Google Chrome** — so without winget you must pre-install
whichever is missing, then re-run:

- Node.js LTS x64 — <https://nodejs.org/en/download/> (the installer
  detects an existing `node` >= 20 on PATH and skips it).
- Google Chrome — <https://www.google.com/chrome/> (the installer
  detects Chrome in the standard install locations and skips it).

Real Google Chrome — not Playwright's bundled Chromium — is required
because the browser agents attach to it (`attached_chrome`) for the
real fingerprint and Web Store extensions. TLS is already handled inside
`install.ps1` (it forces TLS 1.2/1.3 at the top), so the once-common
"pre-run this TLS line" workaround is no longer needed.

## Hardening TODOs (deferred, Phase 2)

- **MSI installer with code-signing cert.** `install.bat` already gives
  the double-click, no-PowerShell-literacy UX; the remaining gap an MSI
  would close is the SmartScreen / "Open File – Security Warning" prompt
  (an unsigned emailed `.bat` still triggers a one-click warning). A
  code-signing cert (~$200/yr) removes that prompt. Worth it when you
  have 5+ customers.
- **Auto-update.** Currently the customer receives a new zip via email
  and re-runs the installer. Fine for pilot; automate once >1
  customer.
- **Windows Defender exclusions.** Playwright's Chromium + node_modules
  can trigger real-time-scan slowdowns. Adding
  `C:\Program Files\Ambit Agent` as an exclusion helps cold starts but
  requires customer IT approval.
