#!/usr/bin/env bash
#
# Ambit Agent runtime — macOS uninstaller.
#
# Removes the LaunchAgent and the application, and LEAVES THE LOGS.
# A machine you are uninstalling from is usually a machine something went
# wrong on, and deleting the evidence as part of the cleanup is how you
# end up unable to answer why.
#
# The config is also left by default — it holds the enrollment token, and
# a reinstall that silently reuses it is the behaviour you want when this
# is really a repair. Pass --purge to remove everything.
#
#   bash uninstall.sh            # agent + app, keep config and logs
#   bash uninstall.sh --purge    # everything, including the token
#
set -euo pipefail

LABEL="com.ambitllc.agent"
SUPPORT_DIR="$HOME/Library/Application Support/Ambit Agent"
APP_DIR="$SUPPORT_DIR/app"
CONFIG_FILE="$SUPPORT_DIR/config"
LOG_DIR="$HOME/Library/Logs/Ambit Agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

info() { printf '\033[0;36m==>\033[0m %s\n' "$1"; }

if [[ -f "$PLIST" ]]; then
  info "Stopping and removing the LaunchAgent"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
else
  info "No LaunchAgent installed"
fi

# Put Chrome's DevTools policy back BEFORE deleting the app — the tool
# that knows how to revert it lives inside $APP_DIR, and the backup it
# reads records whether the key was previously absent or merely zero.
#
# A vendor that relaxes a security setting and then walks away leaves the
# machine weaker than it found it, so this is part of uninstalling rather
# than optional tidying. No backup on record = we never changed it = this
# prints one line and succeeds.
if [[ -f "$APP_DIR/dist/tools/chrome-policy.js" ]] && command -v node >/dev/null 2>&1; then
  info "Restoring Chrome's DevTools policy"
  node "$APP_DIR/dist/tools/chrome-policy.js" --revert || \
    echo "  (could not revert automatically — check it by hand)"
fi

if [[ -d "$APP_DIR" ]]; then
  info "Removing $APP_DIR"
  rm -rf "$APP_DIR"
fi

if (( PURGE )); then
  info "Purging config and logs"
  rm -f "$CONFIG_FILE"
  rm -rf "$LOG_DIR"
  rmdir "$SUPPORT_DIR" 2>/dev/null || true
  echo "Removed. The enrollment token is gone — a reinstall will need a new one."
else
  cat <<KEPT
Removed the agent and the application.

Kept, deliberately:
  config  $CONFIG_FILE   (enrollment token — a reinstall reuses it)
  logs    $LOG_DIR

Run with --purge to delete those too.
KEPT
fi
