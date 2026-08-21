# Installation

Generate the installation command in **KUBI APP → Connections → Agent**. It contains a short-lived token and the matching release artifact.

## POSIX Flags

| Flag | Required | Description |
| --- | --- | --- |
| `--target` | yes | `linux-amd64`, `linux-arm64`, `darwin-amd64`, or `darwin-arm64` |
| `--download-base-url` | yes | Versioned GitHub Release URL |
| `--control-plane-url` | first install | Normally `https://app.kubi.live` |
| `--pairing-token` | first install | One-time 30-minute workspace token |
| `--upgrade` | updates only | Replace the binary while preserving the existing identity and configuration |
| `--install-dir` | no | Binary directory, default `/usr/local/bin` |

On Linux as root, `install.sh` verifies SHA-256, installs the binary, creates `/etc/kubi-agent/agent.yaml`, and starts `kubi-agent.service`. macOS uses launchd. A non-root POSIX install writes `./kubi-agent` for manual execution.

Windows uses `install.ps1` with `-Target`, `-DownloadBaseUrl`, `-ControlPlaneUrl`, `-PairingToken`, and optional `-InstallDir`. Existing installations use `-Upgrade` without `-ControlPlaneUrl` or `-PairingToken`.

## Updating an existing agent

Copy the version-specific update command from **KUBI APP → Connections → Agent**. It verifies the artifact before replacing the binary and never consumes a pairing token. The update requires the installed binary and its existing identity; it preserves `agent.yaml` and all server-side connection bindings.

Do not revoke an active agent before updating. If the identity is already revoked, use **Replace agent** in KUBI to create an explicit replacement pairing instead.

After installation:

```sh
kubi-agent version
kubi-agent config validate
systemctl status kubi-agent
journalctl -u kubi-agent -f
```

The host needs outbound HTTPS/WSS on port 443 to `app.kubi.live`, DNS resolution, and network access to every Kubernetes API in the configured kubeconfigs. No inbound agent port is required.

An inbound port is still unnecessary for normal KUBI operation. Agent `v0.1.22+` can optionally open a customer-managed Prometheus endpoint; it remains disabled until configured in `agent.yaml`.
