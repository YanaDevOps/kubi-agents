# MCP inventory and safety boundary

KUBI exposes the selected agent-backed connection through the Premium hosted MCP endpoint at `https://app.kubi.live/api/mcp`. The customer host does not need an inbound listener: MCP inventory reads travel over the agent's existing authenticated outbound WebSocket relay.

The agent and SaaS share one fixed resource catalog. It covers cluster inventory, networking, storage and backup summaries, platform components, Kubernetes-native delivery activity, external CI pipeline summaries, validation, RBAC, metrics, CRD metadata, and Secret metadata.

The MCP surface intentionally excludes:

- Kubernetes mutations;
- Pod and Job logs;
- CI logs, artifacts, variables, workspaces, and credentials;
- Kubernetes Events;
- arbitrary custom-resource objects;
- alerting configuration and channel credentials;
- Secret `data`, `stringData`, and `binaryData` values.

`kubi_get_resource` accepts a catalog resource ID rather than an arbitrary URL or local agent path. Namespace input is validated before a relay request is sent. Secret-value fields are removed again by the hosted MCP server even though the normal Secret inventory is already metadata-only.

Use the MCP bearer token generated in **KUBI APP -> Settings -> MCP Server**. Revoking that token immediately closes hosted and local agent introspection access.
