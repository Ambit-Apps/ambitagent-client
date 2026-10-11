#!/usr/bin/env bash
# Build a customer-shipping .zip of the client source.
#
# You (staff) run this on your Mac when a new client version is ready
# to distribute. It produces a stamped .zip containing everything the
# customer's install.ps1 needs to `npm ci && npm run build` on their
# Windows box. Never includes node_modules, dist, or the install
# folder itself — those are built fresh on the customer machine or
# shipped as separate email attachments.
#
# Usage (from anywhere in the repo):
#   ./install/build-installer-zip.sh
#
# Output:
#   install/dist/ambitagent-client-<YYYYMMDD-HHMMSS>-<sha>.zip
#
# Ship to a customer:
#   1. Copy the .zip AND install/windows/install.bat AND
#      install/windows/install.ps1 AND install/windows/run-daemon.ps1
#      into your email.
#   2. Include the enrollment token + prod admin URL in the email body.
#   3. Customer saves all four attachments into their Downloads folder,
#      then double-clicks install.bat (self-elevates, no PowerShell needed).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

# Refuse to ship if there are uncommitted changes — the SHA in the
# filename should uniquely identify what's in the .zip. Override with
# --dirty for a quick one-off (adds "-dirty" to the filename so you
# can tell later it wasn't from a clean checkout).
ALLOW_DIRTY=false
for arg in "$@"; do
    case "$arg" in
        --dirty) ALLOW_DIRTY=true ;;
        --help|-h)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown arg: $arg" >&2; exit 2 ;;
    esac
done

DIRTY_TAG=""
if ! git diff --quiet HEAD -- src package.json package-lock.json tsconfig.json 2>/dev/null; then
    if [[ "$ALLOW_DIRTY" == "true" ]]; then
        DIRTY_TAG="-dirty"
        echo "warning: uncommitted changes to shipped files — proceeding with --dirty tag"
    else
        echo "error: uncommitted changes to shipped files (src/, package.json, etc.)"
        echo "commit them, or re-run with --dirty to ship the working-tree state anyway"
        exit 1
    fi
fi

STAMP=$(date -u +'%Y%m%d-%H%M%S')
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')
OUT_DIR="install/dist"
OUT_NAME="ambitagent-client-${STAMP}-${SHA}${DIRTY_TAG}.zip"
OUT_PATH="${OUT_DIR}/${OUT_NAME}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_PATH"

# ── The build's identity, written INTO the payload ──
#
# This stamp and SHA were already computed for the filename, and only for
# the filename — so an installed client had no way to know what it was.
# config.ts fell back to `npm_package_version`, which npm only sets when
# npm launches the process; run-daemon.ps1 invokes `node` directly, so on
# every Task Scheduler install that variable was undefined and the runtime
# reported the hardcoded fallback '0.0.0'. Three production machines all
# claimed the same non-version, and the portal showed it as though it were
# data.
#
# The string written here is IDENTICAL to the one in the zip filename, so
# a runtime on screen can be matched by eye to a file that was actually
# shipped. Derived, never remembered — it cannot drift the way a
# hand-bumped package.json version did (it read 0.0.1 across every
# release this project has ever made).
BUILD_INFO="build-info.json"
cat > "$BUILD_INFO" <<EOF
{
  "version": "${STAMP}-${SHA}${DIRTY_TAG}",
  "stamp": "${STAMP}",
  "sha": "${SHA}",
  "built_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
# Remove it from the working tree afterwards — it is a build artifact, not
# a source file, and a stale one lying around would be reported as the
# running version by a dev-mode daemon.
trap 'rm -f "$BUILD_INFO"' EXIT

# Contents shipped to the customer. Kept intentionally minimal:
#   - src/               source the customer builds with tsc
#   - package.json       declares dependencies
#   - package-lock.json  locks dep versions (npm ci refuses to run without)
#   - tsconfig.json      TypeScript build config
#   - build-info.json    what this build IS — see above
#   - README.md          nice to have if the customer explores the extracted tree
INCLUDES=(
    src
    package.json
    package-lock.json
    tsconfig.json
    "$BUILD_INFO"
)
[[ -f README.md ]] && INCLUDES+=(README.md)

# Explicitly excluded via -x (belt & braces — INCLUDES doesn't list them
# anyway, but zip's recursive traversal would pick up any that snuck in).
EXCLUDES=(
    '*/node_modules/*'
    '*/dist/*'
    '*/.git/*'
    '.env'
    '.env.*'
    '*.tsbuildinfo'
    '.DS_Store'
    '*/.DS_Store'
)

echo "Building $OUT_PATH"
echo "Contents:"
for p in "${INCLUDES[@]}"; do
    echo "  $p"
done

zip_args=(-rq "$OUT_PATH" "${INCLUDES[@]}")
for e in "${EXCLUDES[@]}"; do
    zip_args+=(-x "$e")
done
zip "${zip_args[@]}"

SIZE=$(du -h "$OUT_PATH" | awk '{print $1}')
echo ""
echo "Built:  $OUT_PATH  ($SIZE)"
echo ""
# This script only BUILDS. Publishing is install/publish-release.mjs,
# which calls this and then uploads — so most of the time you want that
# instead and will never read the lines below.
#
# The old epilogue here told you to email four attachments. Gmail blocks
# .bat and .ps1 and inspects inside archives, which is how distribution
# became a round-trip through Google Drive. Saying so in the tool's own
# output was actively sending people down that path.
echo "Built. To publish it so staff can download it from the portal:"
echo ""
echo "  node install/publish-release.mjs --admin <your admin API URL>"
echo ""
echo "That runs this build again and uploads the result. The admin API URL"
echo "is the PUBLIC_API_URL value, not the portal address."
