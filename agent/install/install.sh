#!/usr/bin/env sh
set -eu

TARGET="linux-amd64"
DOWNLOAD_BASE_URL=""
CONTROL_PLANE_URL=""
PAIRING_TOKEN=""
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="kubi-agent"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --download-base-url) DOWNLOAD_BASE_URL="${2:-}"; shift 2 ;;
    --control-plane-url) CONTROL_PLANE_URL="${2:-}"; shift 2 ;;
    --pairing-token) PAIRING_TOKEN="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DOWNLOAD_BASE_URL" ] || [ -z "$CONTROL_PLANE_URL" ] || [ -z "$PAIRING_TOKEN" ]; then
  echo "Usage: install.sh --target <target> --download-base-url <url> --control-plane-url <url> --pairing-token <token>" >&2
  exit 2
fi

case "$TARGET" in
  linux-amd64) ARTIFACT="kubi-agent-linux-amd64" ;;
  linux-arm64) ARTIFACT="kubi-agent-linux-arm64" ;;
  darwin-amd64) ARTIFACT="kubi-agent-darwin-amd64" ;;
  darwin-arm64) ARTIFACT="kubi-agent-darwin-arm64" ;;
  *) echo "Unsupported POSIX target: $TARGET" >&2; exit 2 ;;
esac

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required to verify the agent artifact." >&2
    exit 1
  fi
}

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

curl -fsSL "$DOWNLOAD_BASE_URL/$ARTIFACT" -o "$TMP_DIR/kubi-agent"
curl -fsSL "$DOWNLOAD_BASE_URL/$ARTIFACT.sha256" -o "$TMP_DIR/kubi-agent.sha256"
EXPECTED="$(awk '{print $1}' "$TMP_DIR/kubi-agent.sha256")"
ACTUAL="$(checksum_file "$TMP_DIR/kubi-agent")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum verification failed for $ARTIFACT." >&2
  exit 1
fi

chmod +x "$TMP_DIR/kubi-agent"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$INSTALL_DIR"
  cp "$TMP_DIR/kubi-agent" "$INSTALL_DIR/kubi-agent"
  "$INSTALL_DIR/kubi-agent" pair --control-plane-url "$CONTROL_PLANE_URL" --pairing-token "$PAIRING_TOKEN"

  if command -v systemctl >/dev/null 2>&1 && [ "$TARGET" = "linux-amd64" -o "$TARGET" = "linux-arm64" ]; then
    cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=KUBI local agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/kubi-agent run
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
    echo "Installed and started systemd service $SERVICE_NAME."
  elif [ "$(uname -s)" = "Darwin" ]; then
    PLIST="/Library/LaunchDaemons/live.kubi.agent.plist"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>live.kubi.agent</string>
  <key>ProgramArguments</key><array><string>$INSTALL_DIR/kubi-agent</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    echo "Installed and loaded launchd service live.kubi.agent."
  else
    echo "Installed binary at $INSTALL_DIR/kubi-agent. Start it with: kubi-agent run"
  fi
else
  cp "$TMP_DIR/kubi-agent" ./kubi-agent
  ./kubi-agent pair --control-plane-url "$CONTROL_PLANE_URL" --pairing-token "$PAIRING_TOKEN"
  echo "Installed local binary at ./kubi-agent. Re-run with sudo for system service installation."
fi
