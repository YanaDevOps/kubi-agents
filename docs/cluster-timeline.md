# Cluster Timeline

Cluster Timeline is an optional, read-only history collected locally by the
agent. An owner or workspace admin enables it per connection and chooses 1-30
days of retention; seven days is the default.

The first resource read creates a baseline and does not produce synthetic
events. Later bounded polls record meaningful Kubernetes warnings and normal
events, pod/container failures and recoveries, node pressure/readiness changes,
workload and storage transitions, and supported delivery/backup status changes.
Routine informational events are filtered. Permission gaps and reconnects are
reported as partial coverage.

Only settings and target identity cross the relay. Events, Kubernetes specs,
Secret values, kubeconfigs, and bounded failure log excerpts remain on the
customer host in per-target SQLite storage with retention and size quotas.
