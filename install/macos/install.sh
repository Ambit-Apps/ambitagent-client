#!/usr/bin/env bash
#
# Ambit Agent runtime — macOS installer.
#
# ── WHY A LaunchAgent AND NOT A LaunchDaemon ──
# Same reason Windows uses a Scheduled Task rather than a service.
# A LaunchDaemon runs in the system context with no GUI session, and
# browser agents need a Chrome window the customer can actually see —
# both for the one-time sign-ins and to watch runs happen. A LaunchAgent
# runs inside the logged-in user's session, so Chrome renders where they
# can see it.
#
# The trade is the same too: when they log out, the daemon stops. Runs
# are human-triggered anyway.
#
# ── NO sudo, ANYWHERE ──
# Everything lives under ~/Library. That is not just convenience: a
# LaunchAgent is per-user by definition, so a root-owned install dir and
# a user-owned agent would be a split-brain waiting to confuse someone.
# It also means no password prompt in the middle of a customer install.
#
# ── WHAT IT DOES ──
#   1. Checks Node >= 20 and Google Chrome. Does NOT install them — see
#      the note at the preflight step.
#   2. Collects ADMIN_URL + ENROLLMENT_TOKEN (env > existing config >
#      prompt), exactly like the Windows installer.
#   3. Unpacks the source zip sitting next to this script, npm ci,
#      npm run build.
#   4. Writes the config, MERGING with any existing one.
#   5. Installs and loads the LaunchAgent.
#
# Re-running is safe and is how upgrades work. The config merge is load
# bearing: an existing ENROLLMENT_TOKEN is reused, so an upgrade never
# asks for one and the runtime keeps its identity. Operator-added keys
# such as AMBIT_CHROME_DISABLE_GPU survive too.
#
# Usage, from the folder you extracted the zip into:
#
#   bash install.sh
#
set -euo pipefail

LABEL="com.ambitllc.agent"
SUPPORT_DIR="$HOME/Library/Application Support/Ambit Agent"
APP_DIR="$SUPPORT_DIR/app"
CONFIG_FILE="$SUPPORT_DIR/config"
LOG_DIR="$HOME/Library/Logs/Ambit Agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[0;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer is for macOS. On Windows use install.bat."

# ── 1. Preflight ────────────────────────────────────────────────────
#
# Deliberately does NOT auto-install Node or Chrome. The Windows
# installer can, because winget ships with Windows. macOS has no
# guaranteed package manager — Homebrew is a 2-minute install with its
# own sudo prompts and Xcode CLT dependency, and bootstrapping it
# silently inside someone's agent installer is a bigger imposition than
# telling them to click a download link.
info "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed.
    Install the LTS build from https://nodejs.org/en/download/ (or
    'brew install node' if you use Homebrew), then re-run this script."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  fail "Node.js $(node -v) is too old — version 20 or newer is required.
    Upgrade from https://nodejs.org/en/download/ then re-run this script."
fi
info "Node $(node -v)"

CHROME="/Applications/Google Chrome.app"
if [[ ! -d "$CHROME" ]]; then
  warn "Google Chrome was not found in /Applications."
  warn "Browser agents need real Chrome — install it from"
  warn "https://www.google.com/chrome/ before the first run."
else
  info "Google Chrome found"
fi

# The source bundle shipped beside this script.
SRC_ZIP="$(find "$HERE" -maxdepth 1 -name 'ambitagent-client-*.zip' | sort | tail -1)"
[[ -n "$SRC_ZIP" ]] || fail "No ambitagent-client-*.zip found next to this script.
    Extract ALL files from the download into one folder and re-run."
info "Source bundle: $(basename "$SRC_ZIP")"

# ── 2. Config: env > existing file > prompt ─────────────────────────
#
# Precedence matches install.ps1's Get-ConfigValue exactly, which is what
# makes an UPGRADE need no enrollment token: the value already in the
# config file is reused when no env var overrides it.
# Trim with parameter expansion, NOT `echo | xargs`.
#
# xargs looks like a tidy trim and is a word-splitter that also
# interprets quotes and backslashes: it would strip the quotes off
# VALUE="x", and die outright on a value containing an apostrophe
# ("unterminated quote"). Config values are mostly hex tokens and URLs,
# but an operator-added key only has to contain one apostrophe once to
# break an install, and the failure would point at nothing useful.
trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"   # leading
  v="${v%"${v##*[![:space:]]}"}"   # trailing
  printf '%s' "$v"
}

declare -a EXISTING_KEYS=()
declare -a EXISTING_VALS=()
if [[ -f "$CONFIG_FILE" ]]; then
  # `|| [[ -n "$line" ]]` so a final line with no trailing newline is not
  # silently dropped — that bug cost an afternoon on the Ubuntu side.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    # No '=' is not a setting. config.ts skips these too; parsing them
    # would invent a key whose name is the whole line.
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"; val="${line#*=}"
    key="$(trim "$key")"; val="$(trim "$val")"
    [[ -n "$key" ]] || continue
    EXISTING_KEYS+=("$key"); EXISTING_VALS+=("$val")
  done < "$CONFIG_FILE"
  info "Existing config found — values will be preserved"
fi

existing_value() {
  local want="$1" i
  for i in "${!EXISTING_KEYS[@]}"; do
    if [[ "${EXISTING_KEYS[$i]}" == "$want" ]]; then
      # Present but blank counts as absent, matching ${VAR:-default}.
      [[ -n "${EXISTING_VALS[$i]}" ]] && printf '%s' "${EXISTING_VALS[$i]}"
      return
    fi
  done
}

resolve() { # resolve KEY ENV_VALUE DEFAULT
  local env_val="$2"
  if [[ -n "$env_val" ]]; then printf '%s' "$env_val"; return; fi
  local from_file; from_file="$(existing_value "$1")"
  if [[ -n "$from_file" ]]; then printf '%s' "$from_file"; return; fi
  printf '%s' "${3:-}"
}

ADMIN_URL="$(resolve ADMIN_URL "${AMBIT_ADMIN_URL:-}" '')"
ENROLLMENT_TOKEN="$(resolve ENROLLMENT_TOKEN "${AMBIT_ENROLLMENT_TOKEN:-}" '')"
HEADLESS="$(resolve HEADLESS "${AMBIT_HEADLESS:-}" 'false')"
LOG_LEVEL="$(resolve LOG_LEVEL "${AMBIT_LOG_LEVEL:-}" 'info')"

if [[ -z "$ADMIN_URL" ]]; then
  [[ -t 0 ]] || fail "AMBIT_ADMIN_URL is not set and there is no terminal to prompt from."
  read -r -p 'Admin control-plane URL: ' ADMIN_URL
fi
if [[ -z "$ENROLLMENT_TOKEN" ]]; then
  [[ -t 0 ]] || fail "AMBIT_ENROLLMENT_TOKEN is not set and there is no terminal to prompt from."
  echo "Enrollment token (portal → Runtimes → + Enroll runtime; shown once)"
  read -r -p '  token: ' ENROLLMENT_TOKEN
fi
[[ -n "$ADMIN_URL" && -n "$ENROLLMENT_TOKEN" ]] || fail "ADMIN_URL and ENROLLMENT_TOKEN are both required."

# ── 3. Unpack + build ───────────────────────────────────────────────
info "Installing to $APP_DIR"
mkdir -p "$APP_DIR" "$LOG_DIR"

# Into a staging dir, then swap. A half-extracted app directory is worse
# than no new version, and on an UPGRADE the old one is still running.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ambit-install-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
unzip -q "$SRC_ZIP" -d "$STAGE"

info "Installing dependencies (this takes a minute)"
( cd "$STAGE" && npm ci --silent --no-audit --no-fund )
info "Building"
( cd "$STAGE" && npm run build --silent )
[[ -f "$STAGE/dist/main.js" ]] || fail "Build finished but dist/main.js is missing."

# Stop before swapping so we are not replacing files under a running node.
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  info "Stopping the running agent"
  launchctl unload "$PLIST" 2>/dev/null || true
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
# `/.` copies contents including dotfiles.
cp -R "$STAGE/." "$APP_DIR/"

# ── 4. Config ───────────────────────────────────────────────────────
#
# Rewritten whole from resolved values, so formatting is canonical, with
# every key we do NOT manage carried across verbatim.
info "Writing config"
MANAGED=(ADMIN_URL ENROLLMENT_TOKEN HEADLESS LOG_LEVEL)
is_managed() { local k="$1" m; for m in "${MANAGED[@]}"; do [[ "$m" == "$k" ]] && return 0; done; return 1; }

TMP_CONFIG="$(mktemp)"
{
  echo "# Ambit Agent runtime config — written by install.sh"
  echo "# $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo "ADMIN_URL=$ADMIN_URL"
  echo "ENROLLMENT_TOKEN=$ENROLLMENT_TOKEN"
  echo "HEADLESS=$HEADLESS"
  echo "LOG_LEVEL=$LOG_LEVEL"
  preserved=""
  for i in "${!EXISTING_KEYS[@]}"; do
    k="${EXISTING_KEYS[$i]}"
    is_managed "$k" && continue
    [[ -z "$preserved" ]] && { echo ""; echo "# Preserved from the previous install"; preserved=1; }
    echo "$k=${EXISTING_VALS[$i]}"
  done
} > "$TMP_CONFIG"
mv "$TMP_CONFIG" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"   # it holds the enrollment token

# ── 5. LaunchAgent ──────────────────────────────────────────────────
#
# KeepAlive restarts the daemon if it dies — the supervision Windows gets
# from Task Scheduler's RestartCount, except launchd does not give up
# after three tries. ThrottleInterval stops a crash-looping build from
# spinning: launchd will not relaunch more than once per 10 seconds.
info "Installing the LaunchAgent"
mkdir -p "$(dirname "$PLIST")"
NODE_BIN="$(command -v node)"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd gives an agent a minimal PATH. node is invoked by
         absolute path above, but the daemon shells out (npm, Chrome
         lookups), so give it the usual places things live. -->
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# ── 6. Did it actually come up? ─────────────────────────────────────
sleep 3
if launchctl list | grep -q "$LABEL"; then
  info "Agent is running."
else
  warn "The agent did not appear in launchctl. Check $LOG_DIR/agent.err.log"
fi

cat <<DONE

Installed.

  app     $APP_DIR
  config  $CONFIG_FILE
  logs    $LOG_DIR/agent.log
  agent   $LABEL  (starts automatically at login)

The runtime should show as online in the portal within a few seconds,
under Runtimes. If it does not, the error log above is the place to look.

To stop it:       launchctl unload "$PLIST"
To start it:      launchctl load "$PLIST"
To remove it:     bash uninstall.sh
DONE
