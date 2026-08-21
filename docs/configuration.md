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

metrics_exporter:
  enabled: false
  listen_address: 127.0.0.1
  port: 9464
  collection_interval_seconds: 60
  detail_level: aggregate
  contexts: []
  # bearer_token_file: /etc/kubi-agent/metrics.token
  # allow_insecure_http: false
  # tls:
  #   cert_file: /etc/kubi-agent/tls/metrics.crt
  #   key_file: /etc/kubi-agent/tls/metrics.key

logging:
  level: info
  outputs:
    - stdout
  # file:
  #   path: /var/log/kubi-agent/agent.log
  #   max_size_mb: 10
  #   max_files: 5

# Optional deep storage metrics. Generic Kubernetes CSI inventory works without these collectors.
# Explicitly enable only providers used by this host, then restart kubi-agent.
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
#     profiles:
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
    ceph:
      enabled: false
    longhorn:
      enabled: false
    openebs:
      enabled: false
      profiles: []
      # - context: production
      #   metrics_endpoints:
      #     - url: https://openebs-metrics.internal/metrics
      #       ca_file: /etc/kubi-agent/tls/openebs-ca.pem
      #       client_cert_file: /etc/kubi-agent/tls/openebs-client.pem
      #       client_key_file: /etc/kubi-agent/tls/openebs-client.key
      #       bearer_token_file: /etc/kubi-agent/tokens/openebs
    portworx:
      enabled: false
      profiles: []
      # - context: "*"
      #   metrics_endpoints:
      #     - url: http://127.0.0.1:9001/metrics
```

`kubeconfig_paths` accepts files from a cluster node or gateway host. Every API endpoint referenced by those files must already be reachable from that host. `kubeconfig_directories` scans `.yaml`, `.yml`, and `.conf` files.

Discovery also reads `KUBECONFIG` and the standard `~/.kube/config`. Structurally identical context, cluster, and user records found in more than one file are treated as one context. Conflicting records with the same names are blocked until they are removed or renamed and the agent is rescanned.

The pairing identity remains separate in `${XDG_CONFIG_HOME:-~/.config}/kubi-agent/config.json` or `%APPDATA%\kubi-agent\config.json`. It has mode `0600` and must be treated as a secret.

Environment variables override YAML: `KUBI_AGENT_CONFIG`, `KUBI_AGENT_CONTROL_PLANE_URL`, `KUBI_AGENT_KUBECONFIG`, `KUBECONFIG`, `KUBI_AGENT_CONTEXT`, `KUBI_AGENT_NAMESPACE`, `KUBI_AGENT_ALERTING_CONFIG`, and `KUBI_AGENT_ALERTING_HISTORY`.

Use `kubi-agent config validate` before restart and `kubi-agent config show --effective` to inspect merged settings. Identity secrets are redacted.

By default systemd captures stdout/stderr in journald. Optional file output uses size rotation and never intentionally logs kubeconfig contents, tokens, certificates, or Kubernetes response payloads.

`metrics_exporter` is independent of the KUBI plan and disabled by default. Empty `contexts` collects all unambiguous discovered contexts. `detail_level: aggregate` exports only bounded context totals; explicitly set `detail_level: balanced` to add node, namespace, and workload series for the bundled dashboard. A non-loopback `listen_address` requires `bearer_token_file` plus TLS unless `allow_insecure_http: true` is explicitly set for an already protected private network. See [Prometheus metrics](prometheus-metrics.md).

## Storage driver metrics

KUBI always derives generic CSI driver, StorageClass, PV, and PVC inventory from the Kubernetes API. Deep provider metrics are optional and run only inside the customer-side agent.

Set `storage.drivers.<provider>.enabled: true` for exactly the backends whose deep metrics should run. Supported provider keys are `vitastor`, `ceph`, `longhorn`, `openebs`, and `portworx`. All are disabled by default; changing a nested CLI or endpoint option alone does not enable collection.

For Vitastor, a single-context node or gateway first runs only `vitastor-cli status --json`, `vitastor-cli pools --json`, and `vitastor-cli osds --json`. Commands run without a shell and have bounded runtime and output. They follow the host's current Vitastor configuration, so endpoint address changes do not require a KUBI configuration change.

Agent `v0.1.24+` also performs a best-effort etcd read for monitor membership after successful CLI collection. This supplies monitor names, roles, health, and addresses. Failure to enrich monitor details does not downgrade the CLI-backed driver response.

On a multi-context gateway, local CLI collection requires an exact `cluster_fingerprint` or kubeconfig `context` profile. This prevents host-local metrics from being attributed to another context. Wildcard profiles remain valid for direct etcd fallback but do not authorize ambiguous CLI attribution.

If CLI collection is unavailable, the agent checks profiles by exact `cluster_fingerprint`, exact kubeconfig `context`, then wildcard context `*`. It tries configured endpoints first and then fresh endpoints from readable StorageClasses, ConfigMaps, Services, and EndpointSlices. A stale failed endpoint does not block later candidates.

If auto-discovery is incomplete, configure `endpoints` explicitly. The endpoint must already be reachable from the agent host and expose `/v3/kv/range`; KUBI does not create a tunnel or modify Vitastor.

Use a read-only etcd account where authentication is enabled. TLS settings are file paths, not inline certificate data. Agent configuration is installed with mode `0600`; `kubi-agent config show --effective` redacts passwords, bearer tokens, custom metric headers, and the pairing identity secret.

`StorageClass.parameters.poolId` may provide a configured pool count when deep metrics are unavailable, but StorageClass data is never presented as capacity. Supported Vitastor metric authentication modes are `none`, `basic`, `bearer`, and `headers`.

When explicitly enabled, OpenEBS and Portworx use recognized internal exporter Services automatically. Configure `metrics_endpoints`
only when discovery is unavailable or the endpoint requires bearer or mTLS authentication. Exact context
profiles take precedence over `*`; each profile accepts up to eight HTTP(S) endpoints. URLs cannot contain
inline credentials, query strings, or fragments. Client certificate and key files must be configured
together. Effective-config output redacts all credential and TLS paths. Restart the agent after changes.

Rook/Ceph, Longhorn, OpenEBS, and Portworx retain Kubernetes/CRD health when an optional exporter is not
reachable. Other providers show universal CSI inventory without claiming unavailable backend metrics.
