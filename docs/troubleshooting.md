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

If KUBI reports an ambiguous context, cluster, or user name, inspect configured paths, `KUBECONFIG`, and `~/.kube/config`. Identical copies are merged automatically; entries with the same name but different endpoints or credentials must be removed or renamed before rescanning.

## Pod or Job Logs Fail

Update to agent `v0.1.11` or newer, then restart the service. If logs still fail, verify that the kubeconfig identity can `get` the `pods/log` subresource in the selected namespace and that the requested container is running or has retained logs.

## Restart Time Is Unavailable

Update to agent `v0.1.12` or newer, then restart the service. Older agents report the cumulative restart count but do not include the timestamp of the latest terminated container state.

### Job or CronJob execution fields are missing in KUBI

Update to agent `v0.1.13` or newer, then restart the service. Older agents do not report the optional Job template execution controls used by the Job and CronJob detail drawers.

## PVC Usage Is Unavailable

Agent `v0.1.8` and newer use the Kubernetes API `nodes/proxy` subresource to read kubelet volume summaries. This permission is optional. Without it, requested capacity and storage inventory still work, but used bytes are shown as unavailable. Grant `get` on `nodes/proxy` only when that additional read is acceptable for your cluster policy.

## Relay Reconnects

The agent keeps heartbeat and runtime relay connectivity separate. Agent `v0.1.5` and newer actively probes the WebSocket and reconnects automatically after a SaaS rollout or transient network failure. A short `relay disconnected; reconnecting` message is expected during recovery; no manual service restart should be required.

Agent `v0.1.6` and newer use the installed binary release for both heartbeat and runtime health. Upgrading the binary does not require deleting the saved identity or pairing the agent again.

## Update Required

The installed binary is below the minimum hosted version or reports development build metadata. Download the current binary from the latest GitHub Release, replace it, verify `kubi-agent version`, and restart the service.
