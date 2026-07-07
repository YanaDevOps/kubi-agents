# KUBI Agents

Customer-side agents for KUBI SaaS.

The KUBI Agent runs on infrastructure that can reach your Kubernetes API. It pairs with your KUBI workspace, discovers local kubeconfig contexts, and exposes a loopback read-only runtime at `http://127.0.0.1:47641/v1` for the hosted KUBI app.

## What You Download

GitHub Releases publish native binaries and installer scripts:

| Target | Artifact |
| --- | --- |
| Linux x64 | `kubi-agent-linux-amd64` |
| Linux ARM64 | `kubi-agent-linux-arm64` |
| macOS Intel | `kubi-agent-darwin-amd64` |
| macOS Apple Silicon | `kubi-agent-darwin-arm64` |
| Windows x64 | `kubi-agent-windows-amd64.exe` |

Each release also includes:

- `install.sh` for Linux/macOS
- `install.ps1` for Windows
- `<artifact>.sha256` checksums
- `<artifact>.sig` cosign signatures
- `<artifact>.pem` signing certificates
- `SHA256SUMS`

## Quick Start

1. Open `https://app.kubi.live/profile?section=connect&connect=agent`.
2. Select where you will run the agent.
3. Generate a one-time pairing token.
4. Run the install command shown by KUBI.

Linux/macOS command shape:

```sh
curl -fsSL "https://github.com/YanaDevOps/kubi-agents/releases/download/agent-v0.1.0/install.sh" -o kubi-agent-install.sh
sh kubi-agent-install.sh \
  --target linux-amd64 \
  --download-base-url "https://github.com/YanaDevOps/kubi-agents/releases/download/agent-v0.1.0" \
  --control-plane-url "https://app.kubi.live" \
  --pairing-token "<one-time-token>"
```

Windows command shape:

```powershell
Invoke-WebRequest -Uri "https://github.com/YanaDevOps/kubi-agents/releases/download/agent-v0.1.0/install.ps1" -OutFile "kubi-agent-install.ps1"
PowerShell -ExecutionPolicy Bypass -File .\kubi-agent-install.ps1 `
  -Target "windows-amd64" `
  -DownloadBaseUrl "https://github.com/YanaDevOps/kubi-agents/releases/download/agent-v0.1.0" `
  -ControlPlaneUrl "https://app.kubi.live" `
  -PairingToken "<one-time-token>"
```

## CLI

```sh
kubi-agent pair --control-plane-url <url> --pairing-token <token> [--display-name <name>]
kubi-agent run
kubi-agent rotate
```

## Documentation

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

```sh
bun install
bun run check
bun test
bun run build
```

Release tags use the `agent-vX.Y.Z` format.
