# Kubernetes read permissions

The agent uses the identity in the selected kubeconfig. It does not grant itself
permissions or change RoleBindings. Prefer a dedicated read-only identity with
only the resource groups required by the views you intend to use.

## Core inventory

Typical inventory needs `get` and `list` for Pods, Nodes, Namespaces, Services,
Endpoints, ServiceAccounts, ConfigMaps, storage objects, and apps/batch workloads.
Optional views may need networking, discovery, RBAC, metrics, or installed custom
resource APIs. Namespace-restricted permissions are supported; cluster-wide views
must show partial coverage when the identity cannot read the complete scope.

Kubernetes RBAC does not offer metadata-only authorization for Secret lists. If
you permit reading Secrets for usage analysis, the Kubernetes credential itself
has access to Secret objects even though KUBI's runtime output removes values.
Omit this permission when that credential access is unacceptable; expect explicit
coverage limitations rather than granting broad cluster-admin rights.

## Policy & Posture

No Secret reads or write permissions are needed specifically for this feature.
Read `/version`, API discovery (`/apis`, `/apis/*`), Pods, Namespaces, relevant
apps/batch workloads, and `networking.k8s.io/networkpolicies`. For installed
admission engines, additionally grant `get`/`list` for the supported policy/report
resources in their specific API groups. Gatekeeper constraint kinds are dynamic;
`resources: ['*']` restricted to `constraints.gatekeeper.sh` is preferable to an
all-API-groups wildcard.

See [Policy & Posture](policy-posture.md) for the supported API groups and resource
kinds. Denied optional sources do not prevent other tabs from loading. The agent
does not require impersonation, admission test writes, Pod exec, or scanner Jobs.

## Check an identity

Run checks using the same kubeconfig and context as the agent:

```sh
kubectl --context <context> auth can-i list pods --all-namespaces
kubectl --context <context> auth can-i list networkpolicies.networking.k8s.io --all-namespaces
kubectl --context <context> auth can-i get /apis
kubectl --context <context> auth can-i list clusterpolicies.kyverno.io
```

`auth can-i` checks authorization, not controller health or completeness of policy
evaluation. Do not broaden permissions solely to remove an optional-view warning.
