# KUBI Agent Observability

These artifacts are portable and remain on the customer side. KUBI SaaS does not receive or persist Prometheus samples.

## Enable metrics

Add the following to `/etc/kubi-agent/agent.yaml`, validate it, and restart the service:

```yaml
metrics_exporter:
  enabled: true
  listen_address: 127.0.0.1
  port: 9464
  collection_interval_seconds: 60
  detail_level: balanced
  contexts: []
```

```sh
kubi-agent config validate
systemctl restart kubi-agent
```

Use `prometheus/scrape-local.example.yaml` when Prometheus runs on the same host. Use `prometheus/scrape-remote.example.yaml` only with a private token file and TLS certificate paths configured on both sides.

## Grafana and alerts

Import `grafana/kubi-agent-overview.json` and select the Prometheus or VictoriaMetrics datasource that scrapes the agent. Install `prometheus/kubi-agent-alerts.yaml` as a Prometheus rule file and reload Prometheus.

The alert rules use aggregate metrics and work with either detail level. Balanced dashboard panels use node, namespace, and workload labels. Pod/container names, credentials, API URLs, storage-provider metrics, and remote write are outside this release.

Tagged releases attach the same dashboard, rules, and scrape examples as signed `kubi-agent-*` assets alongside the native binaries.
