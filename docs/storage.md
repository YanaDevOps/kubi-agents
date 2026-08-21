# Storage and CSI diagnostics

KUBI Agent reads Kubernetes storage state through the kubeconfig configured on the customer host. It does
not mutate storage resources or send kubeconfig contents, client keys, bearer tokens, or Kubernetes Secret
values to the hosted control plane.

## Universal CSI health

Agent `v0.1.26+` reports StorageClasses, PersistentVolumes, PersistentVolumeClaims, CSIDrivers, CSINodes,
VolumeAttachments, and CSIStorageCapacities. This provides current node registration, attach/detach errors,
and scheduler capacity samples for any CSI provider. CSIStorageCapacity is topology-scoped and is not a
backend total-capacity measurement.

The agent also checks CSI plugin Pods only when their identity can be associated with the selected driver
using the exact driver name or a provider-specific plugin identity. Missing optional resources or RBAC
permissions produce partial data instead of failing the whole Storage page.

## Backend adapters

Deep adapters are disabled by default. Enable only the installed backend under
`storage.drivers.<provider>.enabled: true` in `/etc/kubi-agent/agent.yaml`, validate the config, and restart
the agent. Universal CSI health remains available while deep collection is disabled.

- **Vitastor:** bounded read-only `vitastor-cli` JSON commands with etcd discovery as fallback.
- **Rook / Ceph:** CephCluster, CephBlockPool, and CephFilesystem CRDs, optionally enriched from a recognized
  internal Ceph manager or exporter `/metrics` endpoint.
- **Longhorn:** Node, Volume, and Replica CRDs, optionally enriched from the Longhorn Manager `/metrics`
  endpoint. v1beta2 is preferred and v1beta1 remains a compatibility fallback.
- **OpenEBS:** DiskPool, LVM, and ZFS CRDs for Mayastor and LocalPV engines, optionally enriched from
  recognized pool exporters for capacity, state, and read/write operations.
- **Portworx:** StorageCluster and StorageNode CRDs, optionally enriched from Portworx metrics for pools,
  volumes, I/O, and iSCSI/NVMe/Fibre Channel/multipath connection health.

Cloud CSI, NFS, local-path, and other providers retain universal Kubernetes health without requiring cloud
credentials or displaying backend concepts they do not implement.

## Exporter safety

Exporter discovery accepts only recognized provider Services and EndpointSlices with loopback, link-local,
RFC1918, carrier-grade NAT, or IPv6 ULA addresses. Each read has a three-second timeout and 4 MiB response
limit, and at most eight candidates are tried. Arbitrary URLs cannot be supplied through SaaS, and
Kubernetes Secrets are never read. Operators may add context-scoped OpenEBS or Portworx endpoints in
`/etc/kubi-agent/agent.yaml`; bearer and mTLS files are read only on the agent host. Authenticated
auto-discovered exporters are skipped while CRD and Kubernetes health remain available.

The kubeconfig identity should have list access to these optional resources for complete diagnostics:

```text
storage.k8s.io: storageclasses, csidrivers, csinodes, volumeattachments, csistoragecapacities
core: persistentvolumes, persistentvolumeclaims, nodes, pods, services
discovery.k8s.io: endpointslices
ceph.rook.io: cephclusters, cephblockpools, cephfilesystems
longhorn.io: nodes, volumes, replicas
openebs.io: diskpools
local.openebs.io: lvmnodes, lvmvolumes
zfs.openebs.io: zfsnodes, zfsvolumes
core.libopenstorage.org: storageclusters, storagenodes
```

Provider CRD permissions are needed only when that provider is installed. `nodes/proxy` remains optional
and is used solely for kubelet-backed PVC filesystem usage.
