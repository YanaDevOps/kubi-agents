# KUBI Agent

KUBI Agent is the customer-side runtime for [KUBI](https://kubi.live). Install it on a Kubernetes node or a gateway host that can already reach your cluster APIs. The agent discovers kubeconfigs, performs read-only runtime requests, and opens an outbound WSS connection to KUBI over port 443.

No inbound port, public Kubernetes API, browser tunnel, or separate WSS utility is required. Raw kubeconfigs, client certificates, exec credentials, provider tokens, and custom CA files remain on the agent host.

## Quick Start

1. Sign in at [app.kubi.live](https://app.kubi.live).
2. Open **KUBI APP -> Connections -> Agent**.
3. Create a one-time pairing token and run the generated install command on the target host.
4. Add non-standard kubeconfig paths to `/etc/kubi-agent/agent.yaml`.
5. Restart the service and select the discovered context in **Connections -> Kubeconfigs**.

```sh
sudo systemctl restart kubi-agent
sudo systemctl status kubi-agent
journalctl -u kubi-agent -f
```

The pairing token expires after 30 minutes and can be used once. It is needed only for the first installation or for replacing a revoked identity.

## Update Without Re-pairing

When KUBI shows `update-recommended` or `update-required`, use **Update agent** on the existing agent row. The generated command uses `--upgrade`, preserves the paired identity and `/etc/kubi-agent/agent.yaml`, and restores the previous binary if the service cannot start.

Do not revoke an agent to update it. Revoke is a decommissioning action.

## Supported Platforms

| Platform | Release artifact |
| --- | --- |
| Linux x64 | `kubi-agent-linux-amd64` |
| Linux ARM64 | `kubi-agent-linux-arm64` |
| macOS Intel | `kubi-agent-darwin-amd64` |
| macOS Apple Silicon | `kubi-agent-darwin-arm64` |
| Windows x64 | `kubi-agent-windows-amd64.exe` |

Each release includes checksums, cosign signatures and certificates, `install.sh`, and `install.ps1`. Release tags use `agent-vX.Y.Z`.

## Configuration

Linux installations use `/etc/kubi-agent/agent.yaml`. The paired identity is stored separately in `${XDG_CONFIG_HOME:-~/.config}/kubi-agent/config.json`; do not copy or edit that file manually.

```yaml
discovery:
  kubeconfig_paths:
    - /etc/rancher/k3s/k3s.yaml
    - /srv/kubeconfigs/production.yaml

logging:
  level: info
  outputs:
    - stdout

metrics_exporter:
  enabled: false
  listen_address: 127.0.0.1
  port: 9464

storage:
  drivers:
    vitastor:
      enabled: false
    ceph:
      enabled: false
    longhorn:
      enabled: false
    openebs:
      enabled: false
    portworx:
      enabled: false

ci:
  enabled: false
  github_actions:
    enabled: false
    instances: []
  gitlab_ci:
    enabled: false
    instances: []
  jenkins:
    enabled: false
    instances: []
```

All deep storage collectors and external CI integrations are opt-in. Restart the service after configuration changes.

```sh
kubi-agent config validate
kubi-agent config show --effective
```

Effective configuration output redacts identity secrets, provider credentials, and protected credential paths.

## CD & Pipelines

KUBI reads Kubernetes-native delivery resources for Argo CD, Flux, Tekton, Argo Workflows, Argo Rollouts, and Flagger. Agent `v0.1.34+` can additionally read bounded run metadata from GitHub Actions, GitLab CI, and Jenkins.

External provider credentials are read from protected files on the agent host. KUBI does not request CI logs, artifacts, variables, workspaces, credentials, or mutation permissions. See [CI pipelines](docs/ci-pipelines.md) for configuration and least-privilege examples.

## Prometheus Metrics

The optional metrics exporter is disabled and loopback-only by default. It exposes bounded agent and cluster health metrics for customer-owned Prometheus, VictoriaMetrics, or Grafana dashboards. It is separate from the local runtime API and cannot proxy arbitrary KUBI requests.

See [Prometheus metrics](docs/prometheus-metrics.md) for secure remote scraping and the bundled dashboard.

## Security Defaults

- The hosted relay is outbound WSS over port 443.
- Kubernetes and CI operations are read-only and bounded.
- Secret, ConfigMap, and ServiceAccount cleanup findings are emitted only when the agent can verify workload, RBAC, and installed-controller references. Vault Secrets Operator, cert-manager, Velero, Argo CD, Traefik, and Gateway API references are recognized; incomplete coverage is reported instead of producing false orphan findings.
- Raw kubeconfigs and provider credentials stay customer-side.
- The loopback runtime listens on `127.0.0.1:47641`; do not expose it publicly.
- Credential files must be regular files and must not be group- or world-readable on POSIX hosts.
- Provider redirects are limited to the same origin; response size, request duration, and concurrency are bounded.
- Logs, artifacts, CI variables, Kubernetes Secret values, and mutations are outside the runtime contract.

See [Security model](docs/security.md) and [Kubernetes RBAC](docs/rbac.md).

## CLI

```sh
kubi-agent pair --control-plane-url https://app.kubi.live --pairing-token <token>
kubi-agent run
kubi-agent version
kubi-agent config validate
kubi-agent config show --effective
kubi-agent rotate
```

## Documentation

- [Installation and flags](docs/installation.md)
- [Configuration and gateway kubeconfigs](docs/configuration.md)
- [Kubernetes RBAC](docs/rbac.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Prometheus metrics](docs/prometheus-metrics.md)
- [Storage and CSI diagnostics](docs/storage.md)
- [CD and Kubernetes-native delivery](docs/delivery-activity.md)
- [External CI pipelines](docs/ci-pipelines.md)
- [MCP inventory and safety boundary](docs/mcp.md)

## Development

```sh
npm install
npm run check
npm test
```

The source package is ESM and targets Node.js 22+. Never commit kubeconfigs, pairing identities, provider tokens, private keys, or generated credential files.

Agent `v0.1.39` adds accurate ServiceAccount target validation to Pod related resources. It also includes the controller-aware Ghost Resource analysis, optional resource validation, and terminal relay identity handling introduced in `v0.1.38`. Runtime API compatibility remains v2.
