#!/usr/bin/env bash
# Roon Controller — Linux installer
# Builds from source and installs as a systemd service.
# Must be run as root (or via sudo) from the repository root.
#
# Usage:
#   sudo ./scripts/install.sh [options]
#
# Options:
#   --port PORT       HTTP port (default: 3333)
#   --install-dir DIR Install path (default: /opt/roon-controller)
#   --user USER       Service user to create/use (default: roon)
#   --no-start        Install but do not start the service
#   --reinstall       Overwrite an existing installation
#   --help            Show this message

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/roon-controller"
SERVICE_USER="roon"
SERVICE_NAME="roon-controller"
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
    --user)        SERVICE_USER="$2"; shift 2 ;;
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

# Capture the invoking user so build steps run without root privileges,
# keeping source-tree file ownership clean.
INVOKING_USER="${SUDO_USER:-}"
if [[ -z "$INVOKING_USER" ]]; then
  die "Could not determine the invoking user. Run via sudo, not as a root login shell."
fi

# Must be run from the repo root
[[ -f "package.json" && -d "src" && -d "ui" ]] \
  || die "Run this script from the repository root (directory containing package.json, src/, ui/)."

# Require systemd
command -v systemctl &>/dev/null \
  || die "systemd is required but systemctl was not found."

# Detect node
NODE_BIN=$(command -v node 2>/dev/null || true)
[[ -n "$NODE_BIN" ]] || die "Node.js is not installed.  Install Node 20+ and re-run."

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[[ "$NODE_MAJOR" -ge 20 ]] \
  || die "Node.js 20 or newer is required (found $("$NODE_BIN" --version))."

# Detect npm
command -v npm &>/dev/null || die "npm is not installed."

# Guard against overwriting an existing install without --reinstall
if [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  die "$INSTALL_DIR already exists.  Use --reinstall to overwrite."
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo
info "Roon Controller installer"
info "  Install dir : $INSTALL_DIR"
info "  Service user: $SERVICE_USER"
info "  Port        : $PORT"
info "  Node        : $("$NODE_BIN" --version)"
echo

# ── Build (run as invoking user to keep source tree ownership clean) ───────────
# Use runuser (not su) — runuser is designed for root→user switching and does
# not go through PAM authentication, so it cannot trigger account lockouts.
run_as_user() {
  runuser -s /bin/bash -l "$INVOKING_USER" -c "cd '$PWD' && $*"
}

info "Installing backend dependencies..."
run_as_user "npm ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building backend..."
run_as_user "npm run build" 2>&1 | sed 's/^/  /'

info "Installing frontend dependencies..."
run_as_user "npm --prefix ui ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building frontend..."
run_as_user "npm --prefix ui run build" 2>&1 | sed 's/^/  /'

success "Build complete."

# ── Stop existing service ──────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping existing service..."
  systemctl stop "$SERVICE_NAME"
fi

# ── Deploy files ───────────────────────────────────────────────────────────────
info "Deploying to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR/config"

# Copy built artefacts and manifests (not source, not node_modules)
cp -r dist               "$INSTALL_DIR/"
cp -r ui/build           "$INSTALL_DIR/ui/"
cp    package.json       "$INSTALL_DIR/"
cp    package-lock.json  "$INSTALL_DIR/"

# Production node_modules (no devDependencies)
info "Installing production dependencies in $INSTALL_DIR..."
npm ci --omit=dev --prefix "$INSTALL_DIR" --prefer-offline 2>&1 | sed 's/^/  /'

# ── Environment file ───────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" && "$REINSTALL" == false ]]; then
  warn ".env already exists — leaving it unchanged."
else
  info "Writing .env..."
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
LOG_LEVEL=info
ROON_TOKEN_PATH=${INSTALL_DIR}/config/roon-token.json
EOF
fi

# ── Service user ───────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
  info "Creating system user '$SERVICE_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Systemd service ────────────────────────────────────────────────────────────
info "Installing systemd service..."

# Write service file with correct paths and user
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Roon Controller
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} dist/index.js
EnvironmentFile=${INSTALL_DIR}/.env
Restart=on-failure
RestartSec=5
User=${SERVICE_USER}
Group=${SERVICE_USER}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# ── Start ──────────────────────────────────────────────────────────────────────
if [[ "$START_SERVICE" == true ]]; then
  info "Starting service..."
  systemctl start "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    success "Service is running."
  else
    warn "Service did not start cleanly. Check logs:"
    warn "  journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
else
  info "Skipping service start (--no-start was set)."
  info "Start manually with: systemctl start $SERVICE_NAME"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo
success "Installation complete!"
echo
echo "  URL        : http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "  Logs       : journalctl -u ${SERVICE_NAME} -f"
echo "  Stop       : systemctl stop ${SERVICE_NAME}"
echo "  Uninstall  : systemctl disable --now ${SERVICE_NAME} && rm -rf ${INSTALL_DIR}"
echo
echo "  First run: open Roon → Settings → Extensions → enable 'Custom Roon Controller'"
echo
