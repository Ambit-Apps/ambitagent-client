#!/usr/bin/env bash
#
# Ambit Agent runtime — Ubuntu installer.
#
# What it does, in order:
#   1.  Verifies root + Ubuntu.
#   2.  Collects ADMIN_URL + ENROLLMENT_TOKEN (env vars OR positional
#       args OR interactive prompts, in that priority).
#   3.  Installs Node.js 20 (via NodeSource) if missing.
#   4.  Creates a system user `ambit-agent` and its home /opt/ambit-agent.
#   5.  Clones (or updates) the client repo into /opt/ambit-agent/app.
#   6.  Runs `npm ci && npm run build` inside that clone.
#   7.  Installs Playwright's Chromium build + its Linux system deps
#       into /opt/ambit-agent/browsers (kept out of $HOME so the
#       hardened systemd unit's ProtectHome=true doesn't block it).
#   8.  Writes /etc/ambit-agent/config (0640, root:ambit-agent).
#   9.  Installs the systemd unit and starts the service.
#
# Usage — one-liner from the portal-provisioned staff RDP session:
#
#   curl -fsSL https://raw.githubusercontent.com/Ambit-Apps/ambitagent-client/main/install/ubuntu/install.sh \
#     | sudo -E env \
#         AMBIT_ADMIN_URL=https://ambitagent-prod.example.com \
#         AMBIT_ENROLLMENT_TOKEN=<token-from-portal> \
#         bash
#
# Or interactive (SSH'd in, running as sudo):
#
#   curl -fsSL https://.../install.sh -o install.sh
#   sudo bash install.sh
#   # prompts for the two values
#
# Re-running is safe — the script is idempotent (creates users only if
# missing, updates the git checkout in place, merges + rewrites config
# atomically, reloads systemd). "Merges" is load-bearing: operator-added
# keys such as AMBIT_CHROME_DISABLE_GPU survive an upgrade instead of
# being overwritten by the template.
#
# --------------------------------------------------------------------
# Overridable env vars (rarely needed):
#   AMBIT_CLIENT_GIT_URL   Where to clone the daemon from. Default is
#                          the public Ambit-Apps repo. For a private
#                          repo, pass a PAT-embedded URL:
#                            https://TOKEN@github.com/…/ambitagent-client.git
#   AMBIT_CLIENT_REF       Branch / tag / commit to check out. Default: main.
#   AMBIT_HEADLESS         true|false. Default true — a fresh Ubuntu VM
#                          has no X server, so headful Playwright would
#                          crash on launch. Set false only if the VM
#                          runs the daemon inside a user desktop
#                          session with DISPLAY exported.
#   AMBIT_LOG_LEVEL        debug|info|warn|error. Default: info.
# --------------------------------------------------------------------

set -euo pipefail

readonly INSTALL_ROOT=/opt/ambit-agent
readonly APP_DIR=$INSTALL_ROOT/app
readonly BROWSERS_DIR=$INSTALL_ROOT/browsers
readonly CONFIG_DIR=/etc/ambit-agent
readonly CONFIG_FILE=$CONFIG_DIR/config
readonly SERVICE_FILE=/etc/systemd/system/ambit-agent.service
readonly SERVICE_USER=ambit-agent

readonly DEFAULT_GIT_URL="https://github.com/Ambit-Apps/ambitagent-client.git"
readonly DEFAULT_GIT_REF="main"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── pre-flight ──────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "OS is '${ID:-unknown}', not ubuntu — proceeding but only Ubuntu is tested."
else
  warn "/etc/os-release missing — proceeding but OS detection skipped."
fi

# ─── existing config ─────────────────────────────────────────────────
# Read the config this machine is ALREADY running before writing a new
# one. The per-machine fixes live in there and nowhere else: this script
# used to build the file from a fixed template and overwrite it, so every
# upgrade silently reverted the hardening applied to that box
# (AMBIT_CHROME_DISABLE_GPU, raised health/startup timeouts, a non-default
# Chrome port). Those settings are what we learned about that machine,
# usually during a support call. Parse rules match readSystemConfig() in
# src/config.ts so what we preserve is exactly what the daemon reads.
#
# Keys the installer owns and rewrites; everything else is operator-added
# and carried forward verbatim.
readonly MANAGED_KEYS=" ADMIN_URL ENROLLMENT_TOKEN HEADLESS PLAYWRIGHT_BROWSERS_PATH LOG_LEVEL "

# existing_value KEY → prints the previous value, or nothing.
existing_value() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$CONFIG_FILE" \
    | tail -n1 | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

# Lines to append: every previous key that is not installer-owned.
#
# Re-emitted as a normalised KEY=value rather than copied verbatim, so the
# preserved line is exactly what readSystemConfig() in src/config.ts will
# read back (it trims both sides of the '='). A hand-edited `  KEY = v `
# therefore comes out canonical, which also keeps it valid for systemd's
# stricter EnvironmentFile parser.
preserved_block() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  local line key value
  # `|| [[ -n "$line" ]]` so the final line is still emitted when the file
  # has no trailing newline — otherwise an operator whose editor omits one
  # silently loses their last setting on every upgrade.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')" == '#'* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"
    [[ -n "$key" ]] || continue
    [[ "$MANAGED_KEYS" == *" $key "* ]] && continue
    value="$(printf '%s' "${line#*=}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
    printf '%s=%s\n' "$key" "$value"
  done < "$CONFIG_FILE"
}

PRESERVED="$(preserved_block)"
if [[ -n "$PRESERVED" ]]; then
  log "Preserving operator settings: $(printf '%s' "$PRESERVED" | cut -d= -f1 | paste -sd, -)"
fi

# ─── config source ───────────────────────────────────────────────────
# Precedence: explicit override > what this machine already had > default.
# The middle term makes a re-run an upgrade rather than a reset.
ADMIN_URL="${AMBIT_ADMIN_URL:-${1:-$(existing_value ADMIN_URL)}}"
ENROLLMENT_TOKEN="${AMBIT_ENROLLMENT_TOKEN:-${2:-$(existing_value ENROLLMENT_TOKEN)}}"

if [[ -z "$ADMIN_URL" ]]; then
  if [[ -t 0 ]]; then
    read -rp "Admin control-plane URL (e.g. https://api.ambitagent.com): " ADMIN_URL
  else
    die "AMBIT_ADMIN_URL not set and no TTY for prompt. Pass via env or arg."
  fi
fi
if [[ -z "$ENROLLMENT_TOKEN" ]]; then
  if [[ -t 0 ]]; then
    read -rp "Enrollment token (from portal /staff/runtimes): " ENROLLMENT_TOKEN
  else
    die "AMBIT_ENROLLMENT_TOKEN not set and no TTY for prompt. Pass via env or arg."
  fi
fi
[[ -n "$ADMIN_URL" && -n "$ENROLLMENT_TOKEN" ]] || die "ADMIN_URL and ENROLLMENT_TOKEN are both required."

CLIENT_GIT_URL="${AMBIT_CLIENT_GIT_URL:-$DEFAULT_GIT_URL}"
CLIENT_REF="${AMBIT_CLIENT_REF:-$DEFAULT_GIT_REF}"
HEADLESS="${AMBIT_HEADLESS:-$(existing_value HEADLESS)}"
HEADLESS="${HEADLESS:-true}"
LOG_LEVEL="${AMBIT_LOG_LEVEL:-$(existing_value LOG_LEVEL)}"
LOG_LEVEL="${LOG_LEVEL:-info}"

# ─── base packages ───────────────────────────────────────────────────
log "Refreshing apt index…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

log "Installing base packages (curl, git, ca-certificates)…"
apt-get install -y curl git ca-certificates gnupg

# ─── Node.js 20 ──────────────────────────────────────────────────────
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    NODE_OK=1
    log "Node $(node -v) already installed — reusing."
  else
    warn "Found Node $(node -v), need >= 20. Installing NodeSource Node 20…"
  fi
fi
if [[ "$NODE_OK" -eq 0 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ─── system user + dirs ──────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user $SERVICE_USER…"
  useradd --system --home "$INSTALL_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "Preparing $INSTALL_ROOT…"
mkdir -p "$INSTALL_ROOT" "$BROWSERS_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT"

# ─── daemon source ───────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  log "Updating existing daemon checkout at $APP_DIR (ref=$CLIENT_REF)…"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch --depth 1 origin "$CLIENT_REF"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" checkout -f "$CLIENT_REF"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" reset --hard "origin/$CLIENT_REF" 2>/dev/null \
    || sudo -u "$SERVICE_USER" git -C "$APP_DIR" reset --hard "$CLIENT_REF"
else
  log "Cloning $CLIENT_GIT_URL @ $CLIENT_REF into $APP_DIR…"
  rm -rf "$APP_DIR"
  sudo -u "$SERVICE_USER" git clone --depth 1 --branch "$CLIENT_REF" "$CLIENT_GIT_URL" "$APP_DIR"
fi

# ─── daemon build ────────────────────────────────────────────────────
log "Installing daemon npm dependencies…"
sudo -u "$SERVICE_USER" env HOME="$INSTALL_ROOT" \
  npm --prefix "$APP_DIR" ci

log "Building daemon (tsc)…"
sudo -u "$SERVICE_USER" env HOME="$INSTALL_ROOT" \
  npm --prefix "$APP_DIR" run build

# ─── Playwright Chromium + its system libs ───────────────────────────
# `install-deps chromium` covers the ~30 shared libraries Chromium
# needs on Ubuntu — libnss3, libatk1.0-0, libx11-6, and friends. It
# internally invokes `apt-get install`, so it MUST run as root; the
# ambit-agent user has nologin + no sudo. Run it first so the browser
# binary can start on first launch (as opposed to surfacing a cryptic
# LD_LIBRARY_PATH error to the customer at first Run).
log "Installing Chromium system libraries via Playwright…"
env HOME="$INSTALL_ROOT" \
  npx --prefix "$APP_DIR" playwright install-deps chromium \
  || warn "playwright install-deps failed — daemon will fail to launch Chromium until this is resolved."

# The browser binary itself lives under PLAYWRIGHT_BROWSERS_PATH; drop
# it in /opt/ambit-agent/browsers so ProtectHome=true in the systemd
# unit doesn't block Chromium's cache. This step doesn't need root.
log "Downloading Playwright Chromium into $BROWSERS_DIR…"
sudo -u "$SERVICE_USER" env \
  HOME="$INSTALL_ROOT" \
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
  npx --prefix "$APP_DIR" playwright install chromium

# ─── config file ─────────────────────────────────────────────────────
log "Writing config to $CONFIG_FILE (0640, root:$SERVICE_USER)…"
mkdir -p "$CONFIG_DIR"
umask 077
cat > "$CONFIG_FILE.tmp" <<EOF
# Ambit Agent runtime config. Written by install.sh at $(date -u +'%Y-%m-%dT%H:%M:%SZ').
# systemd loads this as EnvironmentFile= — every line becomes a process env var.

ADMIN_URL=$ADMIN_URL
ENROLLMENT_TOKEN=$ENROLLMENT_TOKEN

# Headless Chromium — required on a fresh Ubuntu VM with no X server.
# Flip to false only if the daemon runs inside a desktop session with
# DISPLAY exported (e.g. an RDP user session, not a systemd service).
HEADLESS=$HEADLESS

# Playwright looks here for the Chromium binary. Installer downloads
# into this directory to keep it out of \$HOME (blocked by ProtectHome=true).
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR

LOG_LEVEL=$LOG_LEVEL
${PRESERVED:+
# --- Preserved from the previous install -----------------------------
# Added by an operator on this machine, not by the installer. Carried
# forward on every upgrade. Delete a line here to drop it.
$PRESERVED
}
EOF
chown root:"$SERVICE_USER" "$CONFIG_FILE.tmp"
chmod 0640 "$CONFIG_FILE.tmp"
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
umask 022

# ─── systemd unit ────────────────────────────────────────────────────
log "Installing systemd unit…"
cp "$APP_DIR/install/ubuntu/ambit-agent.service" "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable ambit-agent >/dev/null
systemctl restart ambit-agent

# ─── done ────────────────────────────────────────────────────────────
sleep 2
log "Service status:"
systemctl --no-pager --lines=0 status ambit-agent || true

cat <<EOF

[install] Done.

  Check status:   systemctl status ambit-agent
  Tail logs:      journalctl -u ambit-agent -f
  Reload config:  sudo systemctl restart ambit-agent
  Config path:    $CONFIG_FILE   (owner root:$SERVICE_USER, mode 0640)

Portal ⇢ Staff ⇢ Runtimes should show this runtime as **online** within
about 15 seconds (the heartbeat interval). If it stays offline, check
journalctl for connection errors — the most common causes are a wrong
ADMIN_URL or a token that was already used on another VM.
EOF
