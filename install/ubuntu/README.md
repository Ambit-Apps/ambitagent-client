# Ambit Agent — Ubuntu install

Installs the Ambit Agent runtime daemon as a systemd service on a
customer's Ubuntu VM. Tested on Ubuntu 22.04 LTS and 24.04 LTS.

## Prerequisites

- Ubuntu 22.04 or 24.04 (x86_64 or arm64).
- Outbound network to the Ambit admin control plane.
- Root / sudo access on the VM.
- An **enrollment token** — generated in the portal at
  `/staff/runtimes` ⇢ **+ Enroll runtime**. Tokens are shown once;
  copy immediately.

## Install

The recommended path pipes the install script directly and passes
config as environment variables. The `-E` on `sudo` preserves those
env vars into the elevated shell:

```bash
curl -fsSL https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/ubuntu/install.sh \
  | sudo -E env \
      AMBIT_ADMIN_URL=https://ambitagent-prod.example.com \
      AMBIT_ENROLLMENT_TOKEN=<token-from-portal> \
      bash
```

Prefer to read the script before running? Download first:

```bash
curl -fsSL https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/ubuntu/install.sh \
  -o install.sh
less install.sh
sudo bash install.sh   # prompts for ADMIN_URL + ENROLLMENT_TOKEN
```

## What the installer does

| Step | Result |
|---|---|
| Node 20 (via NodeSource) if missing | `/usr/bin/node -v` → `v20.x` |
| System user `ambit-agent` (nologin) | `id ambit-agent` |
| Daemon source | `/opt/ambit-agent/app/` (git clone, depth 1) |
| Compiled JS | `/opt/ambit-agent/app/dist/` |
| Chromium + system libs | `/opt/ambit-agent/browsers/` |
| Config file | `/etc/ambit-agent/config` (0640 root:ambit-agent) |
| systemd unit | `/etc/systemd/system/ambit-agent.service` |
| Service state | enabled + started |

Within ~15 seconds the runtime should show as **online** in the
portal (`/staff/runtimes`).

## Operate

```bash
# status + last few log lines
systemctl status ambit-agent

# live logs
journalctl -u ambit-agent -f

# restart after editing /etc/ambit-agent/config
sudo systemctl restart ambit-agent

# stop
sudo systemctl stop ambit-agent

# uninstall (removes daemon + config; keeps Node and system packages)
sudo systemctl disable --now ambit-agent
sudo rm /etc/systemd/system/ambit-agent.service
sudo rm -rf /opt/ambit-agent /etc/ambit-agent
sudo userdel ambit-agent
sudo systemctl daemon-reload
```

## Overridable env vars

Pass these to `sudo -E env … bash` (same shape as the required vars).

| Var | Default | Notes |
|---|---|---|
| `AMBIT_CLIENT_GIT_URL` | `https://github.com/Ambit-Apps/ambitagent-client.git` | For a private mirror, embed a PAT: `https://TOKEN@github.com/…` |
| `AMBIT_CLIENT_REF` | `main` | Any git ref — pin releases with a tag. |
| `AMBIT_HEADLESS` | `true` | Set `false` only if the daemon runs inside a user desktop session with `DISPLAY` exported. A fresh headless VM has no X server; headful Chromium will crash there. |
| `AMBIT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Troubleshooting

**Portal shows the runtime as offline.**
Check `journalctl -u ambit-agent -f`:

- `WebSocket connection failed` → `ADMIN_URL` wrong, or the admin
  dyno is down.
- `4401 Unauthorized` → enrollment token was already used on a
  different VM (each token is single-use once accepted). Enroll a
  fresh runtime in the portal.

**Chromium fails to launch.**

```
Executable doesn't exist at /home/ambit-agent/.cache/ms-playwright/chromium-XXXX/…
```

means `PLAYWRIGHT_BROWSERS_PATH` isn't reaching the process. Verify
`/etc/ambit-agent/config` contains
`PLAYWRIGHT_BROWSERS_PATH=/opt/ambit-agent/browsers` and restart.

```
libnss3.so: cannot open shared object file
```

means `playwright install-deps` didn't run cleanly. Re-run manually:

```bash
sudo -u ambit-agent env HOME=/opt/ambit-agent \
  npx --prefix /opt/ambit-agent/app playwright install-deps chromium
```

**Service crashes with `Missing required config: ENROLLMENT_TOKEN`.**
The config file is missing or malformed. Verify:

```bash
sudo cat /etc/ambit-agent/config   # should show ADMIN_URL and ENROLLMENT_TOKEN lines
```

Re-running `install.sh` rewrites it.
