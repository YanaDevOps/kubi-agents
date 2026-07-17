# Troubleshooting

## Token Expired

An unused pairing token expires after 30 minutes and cannot be reused. Create a new token in **Connections → Agent**. Existing paired agents are unaffected.

## Agent Offline or Relay Disconnected

```sh
systemctl status kubi-agent
journalctl -u kubi-agent -n 100
curl -I https://app.kubi.live
```

Confirm outbound HTTPS/WSS on port 443 is allowed. The log should report `KUBI hosted relay connected.`

## No Kubeconfigs

Edit `/etc/kubi-agent/agent.yaml`, add the real files under `discovery.kubeconfig_paths`, run `kubi-agent config validate`, and restart the service. Confirm the service account can read every referenced kubeconfig, CA, client certificate, and key.

## Rescan Fails

Rescan is delivered through the hosted relay. Check relay connectivity first, then confirm each kubeconfig parses and referenced exec plugins are available to the systemd service.

## Connect Fails

KUBI runs a Kubernetes API probe before marking a context connected. Verify the same context using `kubectl --kubeconfig <path> --context <name> get namespaces` on the agent host. Check DNS, routing, TLS files, exec-plugin environment, and Kubernetes RBAC.

## Update Required

The installed binary is below the minimum hosted version or reports development build metadata. Download the current binary from the latest GitHub Release, replace it, verify `kubi-agent version`, and restart the service.
