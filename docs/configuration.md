# Configuration

After pairing, the agent stores a local config file:

- Linux/macOS: `${XDG_CONFIG_HOME:-~/.config}/kubi-agent/config.json`
- Windows: `%APPDATA%\kubi-agent\config.json`

The file contains the paired agent ID, control-plane URL, and long-lived agent credential. Treat it as sensitive.

## Environment Variables

| Variable | Description |
| --- | --- |
| `KUBI_AGENT_CONTROL_PLANE_URL` | Override the paired control-plane URL |
| `KUBI_AGENT_KUBECONFIG` | Kubeconfig path to use instead of the default kubeconfig resolution |
| `KUBI_AGENT_CONTEXT` | Force a Kubernetes context |
| `KUBI_AGENT_NAMESPACE` | Default namespace scope for local runtime reads |
| `KUBI_AGENT_ALERTING_CONFIG` | Alerting rules/config path |
| `KUBI_AGENT_ALERTING_HISTORY` | Alerting history path |
| `KUBI_AGENT_VERSION` | Runtime version override, normally set at build time |
| `KUBI_AGENT_BUILD_ID` | Runtime build ID override, normally set at build time |

## Commands

### `pair`

Pairs the local agent with a workspace.

```sh
kubi-agent pair --control-plane-url <url> --pairing-token <token> [--display-name <name>]
```

### `run` / `serve`

Starts the local loopback runtime and heartbeat loop.

```sh
kubi-agent run
```

### `rotate`

Rotates the long-lived agent credential with the control plane.

```sh
kubi-agent rotate
```

Restart the agent service after rotation.
