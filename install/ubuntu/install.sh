#!/usr/bin/env bash
#
# Ambit Agent installer — Ubuntu.
#
# Usage on a customer VM:
#   sudo bash install.sh <ADMIN_URL> <ENROLLMENT_TOKEN>
#
# Or interactive:
#   sudo bash install.sh   # prompts for both values
#
# This is the Phase 0 shape: assumes the caller has a tarball of the
# built daemon at ./dist-bundle/ next to this script (or downloadable
# via curl in a follow-up version). Once release artifacts are on
# GitHub Releases, the top of this script becomes:
#     curl -sSL https://github.com/Ambit-Apps/ambitagent-client/releases/latest/download/ambit-agent-linux-x64.tar.gz | tar xz
#

set -euo pipefail

INSTALL_DIR="/opt/ambit-agent"
CONFIG_DIR="/etc/ambit-agent"
CONFIG_FILE="$CONFIG_DIR/config"
SERVICE_FILE="/etc/systemd/system/ambit-agent.service"
SERVICE_USER="ambit-agent"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."

# ─── args / prompts ──────────────────────────────────────────────────
ADMIN_URL="${1:-}"
ENROLLMENT_TOKEN="${2:-}"

if [[ -z "$ADMIN_URL" ]]; then
  read -rp "Admin control-plane URL (e.g. https://api.ambitagent.com): " ADMIN_URL
fi
if [[ -z "$ENROLLMENT_TOKEN" ]]; then
  read -rp "Enrollment token: " ENROLLMENT_TOKEN
fi
[[ -n "$ADMIN_URL" && -n "$ENROLLMENT_TOKEN" ]] || die "ADMIN_URL and ENROLLMENT_TOKEN are required."

# ─── prereqs ─────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  log "Node.js not found — installing Node 20 via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node.js 20+ required, found $(node -v)."
fi

# ─── system user ─────────────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user $SERVICE_USER…"
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ─── install files ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "Copying daemon to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
if [[ -d "$SCRIPT_DIR/../../dist" ]]; then
  # Local install from a built repo.
  cp -R "$SCRIPT_DIR/../../dist" "$INSTALL_DIR/"
  cp    "$SCRIPT_DIR/../../package.json" "$INSTALL_DIR/"
  ( cd "$INSTALL_DIR" && npm install --omit=dev )
else
  die "Expected a built ./dist directory next to install.sh — run 'npm run build' first, or wait for the release-artifact flow."
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

log "Writing config to $CONFIG_FILE (mode 0600)…"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" <<EOF
ADMIN_URL=$ADMIN_URL
ENROLLMENT_TOKEN=$ENROLLMENT_TOKEN
EOF
chown root:"$SERVICE_USER" "$CONFIG_FILE"
chmod 0640 "$CONFIG_FILE"

log "Installing systemd unit…"
cp "$SCRIPT_DIR/ambit-agent.service" "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable ambit-agent
systemctl restart ambit-agent

log "Done. Check status with: systemctl status ambit-agent"
log "Follow logs with:      journalctl -u ambit-agent -f"
