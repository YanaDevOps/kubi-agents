# Prometheus Metrics

Agent `v0.1.22+` can expose metrics for customer-owned Prometheus, VictoriaMetrics, and Grafana dashboards. This feature is available on every KUBI plan and is disabled by default.

## Local scrape

```yaml
metrics_exporter:
  enabled: true
  listen_address: 127.0.0.1
  port: 9464
  collection_interval_seconds: 60
  contexts: [] # All unambiguous discovered contexts.
```

```yaml
scrape_configs:
  - job_name: kubi-agent
    static_configs:
      - targets: [127.0.0.1:9464]
```

Restart `kubi-agent` after editing `/etc/kubi-agent/agent.yaml`. The agent refreshes a cached snapshot on the configured interval; each `/metrics` scrape reads that cache and does not query Kubernetes.

Set exact kubeconfig context names in `contexts` to restrict collection. If one context is unavailable, only its `kubi_cluster_up` becomes `0`; other contexts remain visible.

## Secure remote scrape

Prefer a local collector or a TLS reverse proxy. For direct remote access, create a random token readable only by the agent service account:

```sh
install -m 0600 /dev/null /etc/kubi-agent/metrics.token
openssl rand -hex 32 > /etc/kubi-agent/metrics.token
chmod 0600 /etc/kubi-agent/metrics.token
```

```yaml
metrics_exporter:
  enabled: true
  listen_address: 0.0.0.0
  port: 9464
  bearer_token_file: /etc/kubi-agent/metrics.token
  tls:
    cert_file: /etc/kubi-agent/tls/metrics.crt
    key_file: /etc/kubi-agent/tls/metrics.key
```

Use the same token and CA in Prometheus. `allow_insecure_http: true` permits bearer-authenticated plaintext HTTP only when the network is already protected.

## Exported scope

Metrics include agent version, relay/discovery/heartbeat state, per-context reachability and aggregate health, namespace/node/workload/Pod/Job/Service counts, current node pressure, and aggregate CPU/memory when `metrics.k8s.io` is available.

The endpoint does not expose kubeconfigs, API URLs, credentials, emails, individual resource names, or the KUBI runtime API. Per-Pod and per-Node labels and remote write are intentionally omitted to keep cardinality and security boundaries predictable.
