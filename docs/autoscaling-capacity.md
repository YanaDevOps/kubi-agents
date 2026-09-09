# Autoscaling & Capacity

`/app/autoscaling` is a read-only, current-state view under **Workloads**. It combines Kubernetes scheduler capacity with native and optional autoscaling controllers without executing external metrics, changing workloads, or calling cloud APIs from the hosted control plane.

## Coverage

| Tab | Sources |
| --- | --- |
| Overview | Evidence-backed current findings and source availability |
| HPA | `autoscaling/v2` HorizontalPodAutoscaler status, metrics, conditions, behavior, and KEDA ownership |
| VPA | `autoscaling.k8s.io/v1`, with `v1beta2` fallback, recommendation and policy status |
| KEDA | ScaledObject, ScaledJob, TriggerAuthentication and ClusterTriggerAuthentication availability; safe trigger metadata only |
| PDB | `policy/v1` PodDisruptionBudget health and disruption controls |
| Capacity | schedulable Node allocatable values, active Pod requests/limits, Metrics API usage, ResourceQuota, and LimitRange |
| Node scaling | Karpenter NodePool/NodeClaim, Cluster Autoscaler controller status, current Unschedulable Pods, and optional managed cloud node pools |

CPU, memory, ephemeral storage, and extended GPU resources are normalized. Pod requests follow scheduler semantics: regular containers are summed, init-container peaks and restartable init sidecars are considered, Pod-level resources and overhead are included, and completed Pods are excluded.

Findings use observed current conditions. Restart history is not a finding. `PDB.status.disruptionsAllowed=0` is not independently treated as unhealthy because a PDB may intentionally permit no voluntary disruption; KUBI warns only when `currentHealthy < desiredHealthy`. Static capacity does not prove future schedulability, and Network, affinity, topology, taint, and plugin-specific scheduling behavior are not simulated.

## Optional agent configuration

Cloud adapters run only in the customer-side agent and are disabled by default. Default SDK credential chains are used when no credential file is configured. File references remain local and diagnostics redact them.

```yaml
autoscaling:
  cloud:
    aws:
      enabled: false
      profiles:
        - id: production-eks
          context: production
          cluster_name: production
          region: eu-central-1
          # profile: kubi-readonly
          # credentials_file: /etc/kubi-agent/credentials/aws
    gcp:
      enabled: false
      profiles:
        - id: production-gke
          context: production
          project_id: example-project
          location: europe-west3
          cluster_name: production
          # credentials_file: /etc/kubi-agent/credentials/gcp.json
    azure:
      enabled: false
      profiles:
        - id: production-aks
          context: production
          subscription_id: replace-me
          resource_group: production
          cluster_name: production
          # Configure all three files together, or use DefaultAzureCredential.
          # tenant_id_file: /etc/kubi-agent/credentials/azure-tenant
          # client_id_file: /etc/kubi-agent/credentials/azure-client
          # client_secret_file: /etc/kubi-agent/credentials/azure-secret
```

Use read-only cloud identities. AWS needs EKS node-group list/describe. GCP needs GKE node-pool read and Compute instance-group-manager read. Azure needs AKS managed-cluster/agent-pool read. KUBI returns operational pool names, state and size but omits account, project and subscription identifiers, ARNs, credentials, and raw provider responses.

## Kubernetes permissions

Core inventory needs list access to Pods, Nodes, Deployments, ReplicaSets, ConfigMaps, HPA, PDB, ResourceQuota, LimitRange, and optional Pod/Node Metrics. Optional controllers need list access only to installed VPA, KEDA, and Karpenter resources. Missing optional APIs disable their tabs; denied or failed required sources produce explicit partial coverage rather than a clean result.

The additive `/v1/autoscaling` endpoint and `autoscalingCapacity` capability retain runtime API v2 compatibility. Older agents continue serving existing pages. The MCP catalog exposes the same bounded normalized objects through `autoscaling-capacity`; trigger credentials and arbitrary cloud payloads are never included.
