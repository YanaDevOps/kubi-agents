# Troubleshooting

## Pairing Fails

- Confirm the pairing token was generated for the correct workspace.
- Generate a new token if the existing token expired or was deleted.
- Confirm the agent host can reach `https://app.kubi.live`.

## Agent Is Offline

- Check the service status:

```sh
systemctl status kubi-agent
```

```powershell
Get-Service kubi-agent
```

- Restart the service after credential rotation.
- Confirm outbound HTTPS is allowed.

## No Kubeconfigs Are Discovered

- Set `KUBI_AGENT_KUBECONFIG` to an explicit kubeconfig path.
- Set `KUBI_AGENT_CONTEXT` if the default/current context is not the intended one.
- Confirm the user running the service can read the kubeconfig file.

## Browser Cannot Reach The Agent

- Confirm the agent process is listening on `127.0.0.1:47641`.
- Open KUBI from `https://app.kubi.live`.
- Check local firewall or endpoint protection rules.

## Kubernetes Reads Fail

- Verify the kubeconfig works locally with `kubectl`.
- Confirm RBAC allows read-only access to the requested resources.
- Confirm optional APIs such as `metrics.k8s.io` are installed when viewing metrics.
