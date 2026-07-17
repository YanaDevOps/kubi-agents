# Installation

Generate the installation command in **KUBI APP → Connections → Agent**. It contains a short-lived token and the matching release artifact.

## POSIX Flags

| Flag | Required | Description |
| --- | --- | --- |
| `--target` | yes | `linux-amd64`, `linux-arm64`, `darwin-amd64`, or `darwin-arm64` |
| `--download-base-url` | yes | Versioned GitHub Release URL |
| `--control-plane-url` | yes | Normally `https://app.kubi.live` |
| `--pairing-token` | yes | One-time 30-minute workspace token |
| `--install-dir` | no | Binary directory, default `/usr/local/bin` |

On Linux as root, `install.sh` verifies SHA-256, installs the binary, creates `/etc/kubi-agent/agent.yaml`, and starts `kubi-agent.service`. macOS uses launchd. A non-root POSIX install writes `./kubi-agent` for manual execution.

Windows uses `install.ps1` with `-Target`, `-DownloadBaseUrl`, `-ControlPlaneUrl`, `-PairingToken`, and optional `-InstallDir`.

After installation:

```sh
kubi-agent version
kubi-agent config validate
systemctl status kubi-agent
journalctl -u kubi-agent -f
```

The host needs outbound HTTPS/WSS on port 443 to `app.kubi.live`, DNS resolution, and network access to every Kubernetes API in the configured kubeconfigs. No inbound agent port is required.
