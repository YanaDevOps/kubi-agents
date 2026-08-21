#!/usr/bin/env sh
set -eu

TARGET="linux-amd64"
DOWNLOAD_BASE_URL=""
CONTROL_PLANE_URL=""
PAIRING_TOKEN=""
UPGRADE="false"
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="kubi-agent"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --download-base-url) DOWNLOAD_BASE_URL="${2:-}"; shift 2 ;;
    --control-plane-url) CONTROL_PLANE_URL="${2:-}"; shift 2 ;;
    --pairing-token) PAIRING_TOKEN="${2:-}"; shift 2 ;;
    --upgrade) UPGRADE="true"; shift ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DOWNLOAD_BASE_URL" ]; then
  echo "Usage: install.sh --target <target> --download-base-url <url> [--upgrade | --control-plane-url <url> --pairing-token <token>]" >&2
  exit 2
fi
if [ "$UPGRADE" = "true" ] && { [ -n "$CONTROL_PLANE_URL" ] || [ -n "$PAIRING_TOKEN" ]; }; then
  echo "--upgrade preserves the existing agent identity and must not be combined with a pairing token." >&2
  exit 2
fi
if [ "$UPGRADE" != "true" ] && { [ -z "$CONTROL_PLANE_URL" ] || [ -z "$PAIRING_TOKEN" ]; }; then
  echo "A control-plane URL and one-time pairing token are required for the first installation." >&2
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

IDENTITY_PATH="${KUBI_AGENT_IDENTITY:-$HOME/.config/kubi-agent/config.json}"
if [ "$UPGRADE" = "true" ] && [ ! -f "$IDENTITY_PATH" ]; then
  echo "Update requires an existing agent identity at $IDENTITY_PATH. Use a replacement pairing from KUBI instead." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$INSTALL_DIR"
  if [ "$UPGRADE" = "true" ] && [ ! -x "$INSTALL_DIR/kubi-agent" ]; then
    echo "Existing agent binary was not found at $INSTALL_DIR/kubi-agent." >&2
    exit 1
  fi
  if [ "$UPGRADE" = "true" ]; then
    cp "$INSTALL_DIR/kubi-agent" "$TMP_DIR/kubi-agent.previous"
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1; then
      systemctl stop "$SERVICE_NAME" || true
    elif [ "$(uname -s)" = "Darwin" ] && [ -f /Library/LaunchDaemons/live.kubi.agent.plist ]; then
      launchctl unload /Library/LaunchDaemons/live.kubi.agent.plist >/dev/null 2>&1 || true
    fi
  fi
  install -m 0755 "$TMP_DIR/kubi-agent" "$INSTALL_DIR/kubi-agent.next"
  mv -f "$INSTALL_DIR/kubi-agent.next" "$INSTALL_DIR/kubi-agent"
  mkdir -p /etc/kubi-agent /var/log/kubi-agent
  chmod 0750 /etc/kubi-agent /var/log/kubi-agent
  if [ "$UPGRADE" != "true" ] && [ ! -f /etc/kubi-agent/agent.yaml ]; then
    cat >/etc/kubi-agent/agent.yaml <<EOF
# KUBI Agent settings. Restart kubi-agent after editing this file.
relay:
  url: $CONTROL_PLANE_URL

discovery:
  # Add every kubeconfig the gateway host should expose to this workspace.
  kubeconfig_paths:
    - /root/.kube/config
  # kubeconfig_directories:
  #   - /home/operator/.kube
  # context: production
  # namespace: default

# Optional Prometheus pull endpoint. It is disabled and loopback-only by default.
# Balanced detail adds namespace, node, and workload labels, but never Pod/container names or credentials.
metrics_exporter:
  enabled: false
  listen_address: 127.0.0.1
  port: 9464
  collection_interval_seconds: 60
  detail_level: aggregate # Set to balanced for the bundled Grafana detail panels.
  contexts: []
  # bearer_token_file: /etc/kubi-agent/metrics.token
  # allow_insecure_http: false
  # tls:
  #   cert_file: /etc/kubi-agent/tls/metrics.crt
  #   key_file: /etc/kubi-agent/tls/metrics.key

# Optional deep storage metrics. Kubernetes CSI inventory works without these collectors.
# Explicitly enable only the provider used by this host, then restart kubi-agent.
storage:
  drivers:
    vitastor:
      enabled: false
      cli:
        enabled: true
        path: vitastor-cli
        timeout_seconds: 8
        # config_path: /etc/vitastor/vitastor.conf
      profiles: []
      # profiles:
      #   - context: production
      #     endpoints:
      #       - http://10.10.8.201:2379
      #     prefix: /vitastor
      #     # auth:
      #     #   username: vitastor
      #     #   password: replace-me
      #     # tls:
      #     #   ca_file: /etc/kubi-agent/tls/etcd-ca.pem
      #     #   cert_file: /etc/kubi-agent/tls/etcd-client.pem
      #     #   key_file: /etc/kubi-agent/tls/etcd-client-key.pem
      #     # metrics:
      #     #   scheme: http
      #     #   timeout_seconds: 5
    ceph:
      enabled: false
    longhorn:
      enabled: false
    openebs:
      enabled: false
      profiles: []
      # Add a context profile only for authenticated or otherwise undiscoverable endpoints.
      # profiles:
      #   - context: production
      #     metrics_endpoints:
      #       - url: https://openebs-metrics.internal/metrics
      #         ca_file: /etc/kubi-agent/tls/openebs-ca.pem
      #         bearer_token_file: /etc/kubi-agent/tokens/openebs
    portworx:
      enabled: false
      profiles: []
      # profiles:
      #   - context: "*"
      #     metrics_endpoints:
      #       - url: http://127.0.0.1:9001/metrics

logging:
  level: info
  outputs:
    - stdout
  # file:
  #   path: /var/log/kubi-agent/agent.log
  #   max_size_mb: 10
  #   max_files: 5
EOF
    chmod 0600 /etc/kubi-agent/agent.yaml
  fi
  if [ "$UPGRADE" != "true" ]; then
    KUBI_AGENT_IDENTITY="$IDENTITY_PATH" "$INSTALL_DIR/kubi-agent" pair --control-plane-url "$CONTROL_PLANE_URL" --pairing-token "$PAIRING_TOKEN"
  fi

  if command -v systemctl >/dev/null 2>&1 && [ "$TARGET" = "linux-amd64" -o "$TARGET" = "linux-arm64" ]; then
    cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=KUBI customer-side agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/kubi-agent run
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=KUBI_AGENT_CONFIG=/etc/kubi-agent/agent.yaml
Environment=KUBI_AGENT_IDENTITY=$IDENTITY_PATH

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    if ! systemctl enable --now "$SERVICE_NAME" || { sleep 1; ! systemctl is-active --quiet "$SERVICE_NAME"; }; then
      if [ "$UPGRADE" = "true" ]; then
        install -m 0755 "$TMP_DIR/kubi-agent.previous" "$INSTALL_DIR/kubi-agent"
        systemctl restart "$SERVICE_NAME" || true
      fi
      echo "The updated agent did not start; the previous binary was restored." >&2
      exit 1
    fi
    echo "$([ "$UPGRADE" = "true" ] && echo Updated || echo Installed) and started systemd service $SERVICE_NAME."
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
    if ! launchctl load "$PLIST"; then
      if [ "$UPGRADE" = "true" ]; then
        install -m 0755 "$TMP_DIR/kubi-agent.previous" "$INSTALL_DIR/kubi-agent"
        launchctl load "$PLIST" || true
      fi
      echo "The updated agent did not start; the previous binary was restored." >&2
      exit 1
    fi
    echo "$([ "$UPGRADE" = "true" ] && echo Updated || echo Installed) and loaded launchd service live.kubi.agent."
  else
    echo "Installed binary at $INSTALL_DIR/kubi-agent. Start it with: kubi-agent run"
  fi
else
  if [ "$UPGRADE" = "true" ] && [ ! -x ./kubi-agent ]; then
    echo "Existing agent binary was not found at ./kubi-agent." >&2
    exit 1
  fi
  install -m 0755 "$TMP_DIR/kubi-agent" ./kubi-agent.next
  mv -f ./kubi-agent.next ./kubi-agent
  if [ "$UPGRADE" != "true" ]; then
    KUBI_AGENT_IDENTITY="$IDENTITY_PATH" ./kubi-agent pair --control-plane-url "$CONTROL_PLANE_URL" --pairing-token "$PAIRING_TOKEN"
  fi
  echo "$([ "$UPGRADE" = "true" ] && echo Updated || echo Installed) local binary at ./kubi-agent."
fi

if [ "$(id -u)" -eq 0 ]; then
  "${INSTALL_DIR}/kubi-agent" version
else
  ./kubi-agent version
fi
