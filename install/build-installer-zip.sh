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
#   1. Copy the .zip AND install/windows/install.ps1 AND
#      install/windows/run-daemon.ps1 into your email.
#   2. Include the enrollment token + prod admin URL in the email body.
#   3. Customer saves all three attachments into their Downloads folder,
#      right-clicks install.ps1 → Run with PowerShell (as Administrator).

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

# Contents shipped to the customer. Kept intentionally minimal:
#   - src/               source the customer builds with tsc
#   - package.json       declares dependencies
#   - package-lock.json  locks dep versions (npm ci refuses to run without)
#   - tsconfig.json      TypeScript build config
#   - README.md          nice to have if the customer explores the extracted tree
INCLUDES=(
    src
    package.json
    package-lock.json
    tsconfig.json
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
echo "Send these three attachments to the customer:"
echo "  1. $OUT_PATH"
echo "  2. install/windows/install.ps1"
echo "  3. install/windows/run-daemon.ps1"
echo ""
echo "Also include in the email body:"
echo "  - Enrollment token (from portal /staff/runtimes → + Enroll runtime)"
echo "  - Your prod ADMIN_URL (Heroku app URL)"
echo "  - Instructions: 'save all three files into Downloads, right-click"
echo "    install.ps1 → Run with PowerShell (as Administrator)'"
