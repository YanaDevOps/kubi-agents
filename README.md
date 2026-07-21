# KUBI Agent

KUBI Agent is the customer-side runtime for [KUBI SaaS](https://kubi.live). Run it on a Kubernetes node or a gateway host that can already reach one or more Kubernetes APIs. The agent discovers local kubeconfigs and opens an outbound WSS connection to KUBI over port 443; no inbound port, browser-to-host tunnel, or public Kubernetes API is required.

Raw kubeconfigs, client certificates, exec credentials, and bearer tokens remain on the agent host.

Agent `v0.1.5` and newer monitor the hosted WebSocket with ping/pong probes and reconnect automatically when a SaaS rollout or network interruption leaves the previous relay connection stale.
Agent `v0.1.6` and newer report the running binary version and build through runtime health after an in-place upgrade; re-pairing is not required.
Agent `v0.1.7` and newer detect platform extensions from StatefulSets, CSI drivers, StorageClasses, workload images, and operator CRDs. This includes Vitastor, Grafana, Prometheus, and VictoriaMetrics evidence without storing Kubernetes credentials in SaaS.
Agent `v0.1.8` and newer also detect CNI providers from Node metadata and can report best-effort PVC usage through the Kubernetes `nodes/proxy` read path. Core storage inventory remains available when that optional permission is absent.
Agent `v0.1.9` and newer correctly treat the UI `all` scope as a cluster-wide list and resolve kubelet volume names through Pod specs when summaries omit `pvcRef`.
Agent `v0.1.10` and newer validate kubelet PVC samples against declared volume capacity. Node-filesystem statistics incorrectly attributed to a local PVC are ignored instead of being shown as PVC usage, and active Pod mounts are reported alongside each claim.
Agent `v0.1.11` and newer negotiate Pod and Job log responses with Kubernetes API servers that reject a `text/plain`-only Accept header.
Agent `v0.1.12` and newer expose the latest container restart timestamp so KUBI can distinguish current health from restart history.

Agent `v0.1.13` and newer also expose read-only Job and CronJob execution controls, including TTL, restart policy, active deadlines, completion mode, and Indexed Job failure limits. Older agents remain compatible, but these optional fields are omitted from KUBI drawers.

## Install

1. Sign in at [app.kubi.live](https://app.kubi.live).
2. Open **KUBI APP → Connections → Agent**.
3. Select the host platform and create a one-time pairing token.
4. Run the generated installation command on the gateway host or cluster node.
5. Add custom kubeconfig paths to `/etc/kubi-agent/agent.yaml`, restart the service, and select a discovered context in **Connections → Kubeconfigs**.

The pairing token expires after 30 minutes and can be used once. If it expires, create a new token; an expired token does not affect an already paired agent.

## Supported Artifacts

| Platform | Artifact |
| --- | --- |
| Linux x64 | `kubi-agent-linux-amd64` |
| Linux ARM64 | `kubi-agent-linux-arm64` |
| macOS Intel | `kubi-agent-darwin-amd64` |
| macOS Apple Silicon | `kubi-agent-darwin-arm64` |
| Windows x64 | `kubi-agent-windows-amd64.exe` |

Every release includes SHA-256 checksums, cosign signatures/certificates, `install.sh`, `install.ps1`, and `SHA256SUMS`.

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
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

Release tags use `agent-vX.Y.Z`.
