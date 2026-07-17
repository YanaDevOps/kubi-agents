# Configuration

Linux installations create `/etc/kubi-agent/agent.yaml`. Edit it and restart `kubi-agent`; hot reload is intentionally not used.

```yaml
relay:
  url: https://app.kubi.live

discovery:
  kubeconfig_paths:
    - /etc/rancher/k3s/k3s.yaml
    - /srv/kubeconfigs/production.yaml
  # kubeconfig_directories:
  #   - /srv/kubeconfigs
  # context: production
  # namespace: default

logging:
  level: info
  outputs:
    - stdout
  # file:
  #   path: /var/log/kubi-agent/agent.log
  #   max_size_mb: 10
  #   max_files: 5
```

`kubeconfig_paths` accepts files from a cluster node or gateway host. Every API endpoint referenced by those files must already be reachable from that host. `kubeconfig_directories` scans `.yaml`, `.yml`, and `.conf` files.

The pairing identity remains separate in `${XDG_CONFIG_HOME:-~/.config}/kubi-agent/config.json` or `%APPDATA%\kubi-agent\config.json`. It has mode `0600` and must be treated as a secret.

Environment variables override YAML: `KUBI_AGENT_CONFIG`, `KUBI_AGENT_CONTROL_PLANE_URL`, `KUBI_AGENT_KUBECONFIG`, `KUBECONFIG`, `KUBI_AGENT_CONTEXT`, `KUBI_AGENT_NAMESPACE`, `KUBI_AGENT_ALERTING_CONFIG`, and `KUBI_AGENT_ALERTING_HISTORY`.

Use `kubi-agent config validate` before restart and `kubi-agent config show --effective` to inspect merged settings. Identity secrets are redacted.

By default systemd captures stdout/stderr in journald. Optional file output uses size rotation and never intentionally logs kubeconfig contents, tokens, certificates, or Kubernetes response payloads.
