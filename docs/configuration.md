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

# Optional deep Vitastor metrics. Credentials stay on this host.
# storage:
#   drivers:
#     vitastor:
#       profiles:
#         - context: "*"
#           # cluster_fingerprint: "<preferred stable selector>"
#           endpoints:
#             - http://10.10.8.201:12379
#           prefix: /vitastor
#           scheme: http
#           timeout_seconds: 8
#           osd_stale_seconds: 30
#           # auth:
#           #   username: readonly
#           #   password: change-me
#           # tls:
#           #   ca_file: /etc/kubi-agent/tls/ca.crt
#           #   cert_file: /etc/kubi-agent/tls/client.crt
#           #   key_file: /etc/kubi-agent/tls/client.key
#           metrics:
#             scheme: http
#             timeout_seconds: 5
#             auth:
#               mode: none
```

`kubeconfig_paths` accepts files from a cluster node or gateway host. Every API endpoint referenced by those files must already be reachable from that host. `kubeconfig_directories` scans `.yaml`, `.yml`, and `.conf` files.

Discovery also reads `KUBECONFIG` and the standard `~/.kube/config`. Structurally identical context, cluster, and user records found in more than one file are treated as one context. Conflicting records with the same names are blocked until they are removed or renamed and the agent is rescanned.

The pairing identity remains separate in `${XDG_CONFIG_HOME:-~/.config}/kubi-agent/config.json` or `%APPDATA%\kubi-agent\config.json`. It has mode `0600` and must be treated as a secret.

Environment variables override YAML: `KUBI_AGENT_CONFIG`, `KUBI_AGENT_CONTROL_PLANE_URL`, `KUBI_AGENT_KUBECONFIG`, `KUBECONFIG`, `KUBI_AGENT_CONTEXT`, `KUBI_AGENT_NAMESPACE`, `KUBI_AGENT_ALERTING_CONFIG`, and `KUBI_AGENT_ALERTING_HISTORY`.

Use `kubi-agent config validate` before restart and `kubi-agent config show --effective` to inspect merged settings. Identity secrets are redacted.

By default systemd captures stdout/stderr in journald. Optional file output uses size rotation and never intentionally logs kubeconfig contents, tokens, certificates, or Kubernetes response payloads.

## Storage driver metrics

KUBI always derives generic CSI driver, StorageClass, PV, and PVC inventory from the Kubernetes API. Deep provider metrics are optional and run only inside the customer-side agent.

For Vitastor, the agent checks profiles by exact `cluster_fingerprint`, exact kubeconfig `context`, then wildcard context `*`. Without a profile, it searches readable StorageClasses, ConfigMaps, Services, and EndpointSlices for an etcd v3 HTTP gateway endpoint.

If auto-discovery is incomplete, configure `endpoints` explicitly. The endpoint must already be reachable from the agent host and expose `/v3/kv/range`; KUBI does not create a tunnel or modify Vitastor.

Use a read-only etcd account where authentication is enabled. TLS settings are file paths, not inline certificate data. Agent configuration is installed with mode `0600`; `kubi-agent config show --effective` redacts passwords, bearer tokens, custom metric headers, and the pairing identity secret.

Supported metric authentication modes are `none`, `basic`, `bearer`, and `headers`. Providers other than Vitastor currently show Kubernetes inventory and an explicit message that deep provider metrics are unavailable rather than returning an error.
