# MCP inventory and safety boundary

KUBI exposes the selected agent-backed connection through the Premium hosted MCP endpoint at `https://app.kubi.live/api/mcp`. The customer host does not need an inbound listener: MCP inventory reads travel over the agent's existing authenticated outbound WebSocket relay.

The agent and SaaS share one fixed resource catalog. It covers cluster inventory, networking, storage and backup summaries, platform components, Kubernetes-native delivery activity, external CI pipeline summaries, validation, RBAC, metrics, CRD metadata, Secret metadata, and ConfigMap metadata.

Agent `v0.1.42` adds `policy-posture` aggregate counts and source/tab coverage.
Raw policy configuration, expressions, report messages, and evidence are not
exposed through MCP. Both the agent and hosted MCP project the safe summary;
an MCP token cannot bypass this projection by requesting arbitrary CRD objects.
The app page itself is available in both plans; MCP retains its existing plan policy.

The MCP surface intentionally excludes:

- Kubernetes mutations;
- Pod and Job logs;
- CI logs, artifacts, variables, workspaces, and credentials;
- Kubernetes Events;
- arbitrary custom-resource objects;
- alerting configuration and channel credentials;
- Secret `data`, `stringData`, and `binaryData` values.
- ConfigMap values and the interactive `/v1/configmaps/content` endpoint.

ConfigMap inventory also omits `kubectl.kubernetes.io/last-applied-configuration` because it embeds a full applied resource, and omits any other annotation value larger than 1 KiB. The annotation key, size, and omission reason remain visible.

`kubi_get_resource` accepts a catalog resource ID rather than an arbitrary URL or local agent path. Namespace input is validated before a relay request is sent. Secret and ConfigMap value fields are removed again by the hosted MCP server even though their inventory endpoints are already metadata-only.

Use the MCP bearer token generated in **KUBI APP -> Settings -> MCP Server**. Revoking that token immediately closes hosted and local agent introspection access.
