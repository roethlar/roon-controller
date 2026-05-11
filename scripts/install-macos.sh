#!/usr/bin/env bash
# Roon Controller — macOS installer
# Builds from source and installs as a launchd service.
# Must be run as root (or via sudo) from the repository root.
#
# Usage:
#   sudo ./scripts/install-macos.sh [options]
#
# Options:
#   --port PORT       HTTP port (default: 3333)
#   --install-dir DIR Install path (default: /opt/roon-controller)
#   --no-start        Install but do not start the service
#   --reinstall       Overwrite an existing installation
#   --help            Show this message

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/roon-controller"
SERVICE_LABEL="com.roon.controller"
PLIST_PATH="/Library/LaunchDaemons/${SERVICE_LABEL}.plist"
LOG_DIR="/Library/Logs/RoonController"
PORT="3333"
START_SERVICE=true
REINSTALL=false

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[install]${NC} $*"; }
success() { echo -e "${GREEN}[install]${NC} $*"; }
warn()    { echo -e "${YELLOW}[install]${NC} $*"; }
die()     { echo -e "${RED}[install] ERROR:${NC} $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)        PORT="$2";         shift 2 ;;
    --install-dir) INSTALL_DIR="$2";  shift 2 ;;
    --no-start)    START_SERVICE=false; shift ;;
    --reinstall)   REINSTALL=true;    shift ;;
    --help)
      sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1  (use --help for usage)" ;;
  esac
done

# ── Pre-flight checks ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "This script must be run as root.  Try: sudo $0 $*"

INVOKING_USER="${SUDO_USER:-}"
if [[ -z "$INVOKING_USER" ]]; then
  die "Could not determine the invoking user. Run via sudo, not as a root login shell."
fi

[[ "$(uname)" == "Darwin" ]] || die "This installer is for macOS only."

[[ -f "package.json" && -d "src" && -d "ui" ]] \
  || die "Run this script from the repository root (directory containing package.json, src/, ui/)."

# Detect node — check common Homebrew and nvm locations
NODE_BIN=$(command -v node 2>/dev/null || true)
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$NODE_BIN" ]] || die "Node.js is not installed.  Install Node 20+ (e.g. brew install node) and re-run."

NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[[ "$NODE_MAJOR" -ge 20 ]] \
  || die "Node.js 20 or newer is required (found $("$NODE_BIN" --version))."

NPM_BIN=$(command -v npm 2>/dev/null || dirname "$NODE_BIN")/npm
[[ -x "$NPM_BIN" ]] || NPM_BIN=$(command -v npm 2>/dev/null || true)
[[ -n "$NPM_BIN" ]] || die "npm is not installed."

if [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  die "$INSTALL_DIR already exists.  Use --reinstall to overwrite."
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo
info "Roon Controller macOS installer"
info "  Install dir : $INSTALL_DIR"
info "  Port        : $PORT"
info "  Node        : $("$NODE_BIN" --version)"
echo

# ── Build (as invoking user) ──────────────────────────────────────────────────
run_as_user() {
  sudo -u "$INVOKING_USER" bash -c "cd '$PWD' && $*"
}

info "Installing backend dependencies..."
run_as_user "$NPM_BIN ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building backend..."
run_as_user "$NPM_BIN run build" 2>&1 | sed 's/^/  /'

info "Installing frontend dependencies..."
run_as_user "$NPM_BIN --prefix ui ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building frontend..."
run_as_user "$NPM_BIN --prefix ui run build" 2>&1 | sed 's/^/  /'

success "Build complete."

# ── Stop existing service ──────────────────────────────────────────────────────
if launchctl list "$SERVICE_LABEL" &>/dev/null; then
  info "Stopping existing service..."
  launchctl bootout system/"$SERVICE_LABEL" 2>/dev/null || true
fi

# ── Deploy files ───────────────────────────────────────────────────────────────
info "Deploying to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/data/image-cache" "$INSTALL_DIR/ui" "$LOG_DIR"

# Wipe build artefacts before re-copying so files removed in a newer build
# don't survive as stale leftovers. config/ and data/ are NOT touched.
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/ui/build"

cp -R dist               "$INSTALL_DIR/"
cp -R ui/build           "$INSTALL_DIR/ui/"
cp    package.json       "$INSTALL_DIR/"
cp    package-lock.json  "$INSTALL_DIR/"

info "Installing production dependencies in $INSTALL_DIR..."
"$NPM_BIN" ci --omit=dev --prefix "$INSTALL_DIR" --prefer-offline 2>&1 | sed 's/^/  /'

# ── Environment file ───────────────────────────────────────────────────────────
# launchd doesn't support EnvironmentFile, so the plist below carries the
# real environment. This .env is documentation only — edits to it will not
# affect the running service. To change runtime config, edit the plist's
# EnvironmentVariables block and reload via `launchctl bootout`/`bootstrap`.
# Keep this template in sync with .env.example at the repo root.
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — leaving it unchanged."
else
  info "Writing .env (documentation only — see plist for live config)..."
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
LOG_LEVEL=info
ROON_TOKEN_PATH=${INSTALL_DIR}/config/roon-token.json
IMAGE_CACHE_PATH=${INSTALL_DIR}/data/image-cache
IMAGE_CACHE_MAX_BYTES=10737418240
RECENTLY_PLAYED_PATH=${INSTALL_DIR}/data/recently-played.json
# RECENTLY_PLAYED_CAP=50
# CLIENT_ORIGIN=http://roon.lan,http://192.168.1.10:${PORT}
# TRUST_PROXY=true
EOF
fi

# ── launchd plist ──────────────────────────────────────────────────────────────
info "Installing launchd service..."

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${INSTALL_DIR}/dist/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key>
      <string>production</string>
      <key>HOST</key>
      <string>0.0.0.0</string>
      <key>PORT</key>
      <string>${PORT}</string>
      <key>LOG_LEVEL</key>
      <string>info</string>
      <key>ROON_TOKEN_PATH</key>
      <string>${INSTALL_DIR}/config/roon-token.json</string>
      <key>IMAGE_CACHE_PATH</key>
      <string>${INSTALL_DIR}/data/image-cache</string>
      <key>IMAGE_CACHE_MAX_BYTES</key>
      <string>10737418240</string>
      <key>RECENTLY_PLAYED_PATH</key>
      <string>${INSTALL_DIR}/data/recently-played.json</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/error.log</string>
  </dict>
</plist>
EOF

# ── Start ──────────────────────────────────────────────────────────────────────
if [[ "$START_SERVICE" == true ]]; then
  info "Starting service..."
  launchctl bootstrap system "$PLIST_PATH"
  sleep 2
  if launchctl list "$SERVICE_LABEL" &>/dev/null; then
    success "Service is running."
  else
    warn "Service did not start cleanly. Check logs:"
    warn "  cat ${LOG_DIR}/error.log"
    exit 1
  fi
else
  info "Skipping service start (--no-start was set)."
  info "Start manually with: sudo launchctl bootstrap system $PLIST_PATH"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo
success "Installation complete!"
echo
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
echo "  URL        : http://${LOCAL_IP}:${PORT}"
echo "  Logs       : tail -f ${LOG_DIR}/out.log"
echo "  Stop       : sudo launchctl bootout system/${SERVICE_LABEL}"
echo "  Uninstall  : sudo launchctl bootout system/${SERVICE_LABEL}; sudo rm -rf ${INSTALL_DIR} ${PLIST_PATH}"
echo
echo "  First run: open Roon > Settings > Extensions > enable 'Custom Roon Controller'"
echo
