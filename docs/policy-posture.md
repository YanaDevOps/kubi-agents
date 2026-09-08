# Policy & Posture

## Product boundary

`/app/policies` belongs to **Security & Config** and is available on Basic and Premium.
It is a read-only view of current workload configuration, Kubernetes network policy
coverage, admission policy configuration, and provider-reported evaluation results.
It is not a vulnerability scanner, compliance certification, or an admission engine.
Posture findings do not change operational Cluster Health or alerting rules.

The permanent tabs are Overview, Workload, Network, Admission, and Image trust.
Unavailable tabs explain the missing source, permissions, or upgrade requirement;
an accessible cluster with no NetworkPolicies still supports Network analysis.
System workload findings are collapsed, not removed from aggregate counts.
There is deliberately no numerical security score.

## Sources

| Source | Read-only coverage |
| --- | --- |
| Kubernetes workloads | Current Pods and workload templates; security context and declared Pod Security Admission labels |
| Kubernetes networking | NetworkPolicy selectors, rules, and ingress/egress isolation coverage |
| Native admission | Served ValidatingAdmissionPolicy, MutatingAdmissionPolicy, bindings, webhook configuration metadata |
| Kyverno | Legacy Policy/ClusterPolicy and installed CEL policy APIs, exceptions, report results, image verification declarations |
| OPA Gatekeeper | ConstraintTemplates, dynamically discovered constraint kinds, audit results and total violation counts |
| Kubewarden | AdmissionPolicy/ClusterAdmissionPolicy, policy groups, PolicyServer, reports |
| Shared reports | `wgpolicyk8s.io` PolicyReport/ClusterPolicyReport and `openreports.io` Report/ClusterReport |

API discovery chooses one served version per kind. An installed API does not prove
that its controller is running. A generic report CRD does not identify its producer.
Provider result timestamps are separate from the time KUBI fetched the inventory.
Missing reports, skipped checks, and evaluation errors are not successful checks.
Audit reports can be truncated; reported totals may exceed the supplied detail rows.

## Interpretation

- Workload checks distinguish baseline violations from additional hardening advice.
  Declared Restricted namespace settings are considered separately. These checks do
  not reproduce the complete admission implementation or discover server exemptions.
- Missing namespace PSA labels do not imply that server-wide defaults are disabled.
- Standard NetworkPolicies are additive and direction-specific. No coverage means
  no coverage by these declarations, not necessarily an exposed network: Cilium,
  Calico, cloud firewalls, and other mechanisms may apply additional restrictions.
- Static rules cannot prove reachability or CNI enforcement. Missing coverage is
  informational; explicitly unrestricted rules are warnings requiring context.
- Image trust uses recognizable policy declarations and provider results only.
  KUBI does not contact registries, download images, or verify signatures itself.
- A reported resource must not be considered a verified current violation when its
  identity is stale or cannot be corroborated. Deleting a Pod does not erase a
  configuration risk still present in its active workload template.

## Runtime and isolation

Agent `/v1/policy-posture` and browser-direct use the same shared collector and
pure analyzers under `src/lib/shared/policy-posture*.js`. This is an optional
runtime API v2 capability; adding it does not raise the global minimum agent.
Old agents continue serving existing pages and require an upgrade for this view.

Collection is page-triggered, not part of the Overview critical path. It uses four
parallel reads, pages of 250 objects (at most ten pages per resource), at most 80
discovered policy resource types, a 16 MiB aggregate decoded inventory budget, and
a 20 second collection deadline with five second per-read deadlines. Reaching a
limit or losing permissions is explicit partial coverage, never a clean result.
Budgets supplement the transport limits; they do not authorize arbitrary API paths.
No raw cluster policy payload is persisted by the hosted control plane.

Namespace scope is passed to namespaced reads. Cluster-scoped configuration remains
labelled as such: merely listing a cluster policy does not assert that it applies to
every resource in the selected namespace. Search and table filters do not narrow
the source inventory used to establish coverage.

## Least-privilege permissions

Grant only `get` and `list` on the resources you want to inspect. Existing Pod,
Namespace, apps and batch workload reads plus `networking.k8s.io/networkpolicies`
provide Workload and Network. API group discovery (`/apis` and `/apis/*`) and
`/version` allow served-version selection. Admission adapters additionally need
read permissions on the installed API groups in the table above.

Gatekeeper constraint kinds are dynamic: a read-only rule for resources `*` in
the specific `constraints.gatekeeper.sh` group is appropriate when all constraints
must be inspected. Do not use an all-API-groups wildcard or grant mutation rights.
No Secret reads, impersonation, exec, scanner Jobs, or admission test writes are
required by this feature. Customers may intentionally deny optional providers;
the UI retains accessible sources and explains the missing coverage.

## Verification

`tests/policy-posture-*.test.js` exercises configuration inheritance, selectors,
report identity/result semantics, served-version discovery, pagination, denied
sources, and partial responses. UI regression tests cover the shared tabs and page
presentation. Tests use fixtures, not writes to customer clusters.

## References

- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kyverno policy types](https://kyverno.io/docs/policy-types/overview/)
- [Gatekeeper audit](https://open-policy-agent.github.io/gatekeeper/website/docs/audit/)
- [Kubewarden CRDs](https://docs.kubewarden.io/admission-controller/latest/en/reference/CRDs.html)
- [OpenReports](https://openreports.io/)
