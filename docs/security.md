# Security Model

The agent is installed inside the customer network and makes an outbound authenticated WSS connection to KUBI SaaS over port 443.

The following remain customer-side: raw kubeconfigs, bearer tokens, client keys/certificates, custom CA data, exec-plugin credentials, and alerting secrets. SaaS stores sanitized context metadata, agent status/version, and workspace connection state.

Runtime tokens are short-lived, signed, bound to one workspace, user, agent, connection, and source-qualified context. The agent introspects them before every runtime operation. All plan limits and context selection are also checked server-side.

Kubernetes API responses requested by the signed runtime session cross the TLS-protected relay in memory. KUBI SaaS does not intentionally persist or log relay payloads. This transport is TLS/WSS, not application-layer end-to-end encryption against the SaaS relay itself.

Pairing tokens are one-time and expire after 30 minutes. After registration the agent receives a separate long-lived credential stored in its protected identity file. Revoke an agent from KUBI if its host or identity file may be compromised.

The loopback listener on `127.0.0.1:47641` remains for local diagnostics and compatibility. Do not expose it publicly; hosted browser traffic uses the outbound relay.

Installers verify SHA-256 before installation. Release assets include cosign signatures and certificates for independent verification.

PVC usage is optional and read-only. The agent requests kubelet summary data through the Kubernetes API `nodes/proxy` subresource; it never opens kubelet ports directly. If RBAC denies that path, KUBI reports usage as unavailable and continues to show PV, PVC, StorageClass, and CSI inventory.

Domain Health reads cert-manager `certificates`, `orders`, and `challenges` when those APIs are installed and permitted. It exposes status, DNS names, issuer references, expiry, and failure reasons; it does not read TLS Secret values or private keys.

Gateway API validation reads only installed Gateway API custom resources, Service summaries, and endpoint readiness already available through the selected kubeconfig. It does not mutate routes, call backend workloads, or execute server-side authorization probes.

## Backup Discovery

Backup activity is read from Kubernetes custom-resource metadata through the same selected kubeconfig and read-only runtime boundary. The agent does not call vendor cloud APIs, read Kubernetes Secret values, persist raw custom resources in SaaS, or create/restore/delete backup resources.

Supported resources include Velero/OADP, CSI VolumeSnapshot, Longhorn, Kasten K10, Trilio, Rancher Backup Operator, K3s/RKE2 ETCDSnapshotFile, and Portworx/Stork APIs. A missing API is ignored; a denied API is reported as a provider-specific permission gap.
