# Installation

The recommended install path is to generate an install command from the KUBI SaaS Agent tab. That command includes the correct release URL, target platform, control-plane URL, and one-time pairing token.

## POSIX Installer

`install.sh` supports:

| Flag | Required | Description |
| --- | --- | --- |
| `--target` | yes | `linux-amd64`, `linux-arm64`, `darwin-amd64`, or `darwin-arm64` |
| `--download-base-url` | yes | GitHub Release URL containing binaries and checksums |
| `--control-plane-url` | yes | KUBI SaaS URL, normally `https://app.kubi.live` |
| `--pairing-token` | yes | One-time token generated in your workspace |
| `--install-dir` | no | Binary install directory, default `/usr/local/bin` |

When run as root, the installer installs the binary and attempts to create a system service:

- Linux: `systemd` service named `kubi-agent`
- macOS: `launchd` daemon named `live.kubi.agent`

Without root, it writes `./kubi-agent`, pairs it, and prints a manual run instruction.

## Windows Installer

`install.ps1` supports:

| Parameter | Required | Description |
| --- | --- | --- |
| `-Target` | no | Must be `windows-amd64`, default `windows-amd64` |
| `-DownloadBaseUrl` | yes | GitHub Release URL containing binaries and checksums |
| `-ControlPlaneUrl` | yes | KUBI SaaS URL, normally `https://app.kubi.live` |
| `-PairingToken` | yes | One-time token generated in your workspace |
| `-InstallDir` | no | Default `%ProgramData%\KUBI\Agent` |

The Windows installer installs a service named `kubi-agent`.

## Manual Binary Usage

```sh
kubi-agent pair --control-plane-url https://app.kubi.live --pairing-token <token>
kubi-agent run
```

The pairing token is one-time and short-lived. Generate a new token if it expires or is deleted from the KUBI workspace.
