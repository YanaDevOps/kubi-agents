export const MCP_RESOURCE_CATALOG = [
  { id: 'overview', label: 'Overview', category: 'Cluster', description: 'Cluster overview and health snapshot', path: '/v1/overview', appPath: '/app', namespaceScoped: false },
  { id: 'namespaces', label: 'Namespaces', category: 'Cluster', description: 'Namespace inventory and current state', path: '/v1/namespaces', appPath: '/app/namespaces', namespaceScoped: false },
  { id: 'nodes', label: 'Nodes', category: 'Cluster', description: 'Node capacity, conditions, and pressure signals', path: '/v1/nodes', appPath: '/app/nodes?node=all', namespaceScoped: false },
  { id: 'pods', label: 'Pods', category: 'Cluster', description: 'Pod inventory, ownership, and current status without logs', path: '/v1/pods', appPath: '/app/pods', namespaceScoped: true },
  { id: 'workloads', label: 'Workloads', category: 'Cluster', description: 'Deployment, StatefulSet, and DaemonSet summaries', path: '/v1/workloads', appPath: '/app/workloads', namespaceScoped: true },
  { id: 'jobs', label: 'Jobs', category: 'Cluster', description: 'Job and CronJob summaries without logs', path: '/v1/jobs', appPath: '/app/jobs', namespaceScoped: true },
  { id: 'services', label: 'Services', category: 'Networking', description: 'Services and EndpointSlice readiness', path: '/v1/services', appPath: '/app/networking', namespaceScoped: true },
  { id: 'topology', label: 'Topology', category: 'Networking', description: 'Read-only cluster topology graph', path: '/v1/topology', appPath: '/app/topology', namespaceScoped: true },
  { id: 'ports', label: 'Ports', category: 'Networking', description: 'Service and container port mappings', path: '/v1/ports', appPath: '/app/ports', namespaceScoped: true },
  { id: 'traffic', label: 'Traffic', category: 'Networking', description: 'Network traffic inventory and relationships', path: '/v1/traffic', appPath: '/app/networking', namespaceScoped: true },
  { id: 'cni', label: 'CNI', category: 'Networking', description: 'Detected CNI and IP stack details', path: '/v1/cni', appPath: '/app/networking', namespaceScoped: false },
  { id: 'vip', label: 'VIP and load balancing', category: 'Networking', description: 'VIP and load-balancing inventory', path: '/v1/vip', appPath: '/app/crds?tab=load-balancing', namespaceScoped: false },
  { id: 'storage', label: 'Storage', category: 'Storage', description: 'StorageClasses, PVs, PVCs, CSI drivers, and usage metadata', path: '/v1/storage', appPath: '/app/storage', namespaceScoped: true },
  { id: 'backup-activity', label: 'Backup activity', category: 'Storage', description: 'Detected Kubernetes backup providers and activity', path: '/v1/backup-activity', appPath: '/app/backup-activity', namespaceScoped: true },
  { id: 'components', label: 'Components', category: 'Platform', description: 'Detected platform, observability, security, and infrastructure components', path: '/v1/components', appPath: '/app', namespaceScoped: false },
  { id: 'service-mesh', label: 'Service mesh', category: 'Platform', description: 'Detected mesh providers, routes, and policy summaries', path: '/v1/service-mesh', appPath: '/app/service-mesh', namespaceScoped: true },
  { id: 'delivery-activity', label: 'CD activity', category: 'Platform', description: 'GitOps applications, projects, sources, Kubernetes-native pipelines, and controller health', path: '/v1/delivery-activity', appPath: '/app/delivery-activity', namespaceScoped: true },
  { id: 'ci-pipelines', label: 'CI pipelines', category: 'Platform', description: 'Read-only GitHub Actions, GitLab CI, and Jenkins run metadata without logs, artifacts, variables, or credentials', path: '/v1/ci-pipelines', appPath: '/app/delivery-activity?tab=ci', namespaceScoped: false },
  { id: 'crds', label: 'CRD inventory', category: 'Platform', description: 'CustomResourceDefinition metadata without arbitrary custom-resource objects', path: '/v1/crds', appPath: '/app/crds', namespaceScoped: false },
  { id: 'validation', label: 'Validation', category: 'Validation', description: 'Current cluster validation findings and severities', path: '/v1/validation', appPath: '/app/validation/overview', namespaceScoped: true },
  { id: 'domain-health', label: 'Domain health', category: 'Validation', description: 'Ingress, certificate, and domain health summaries', path: '/v1/domain-health', appPath: '/app/validation/domain-health', namespaceScoped: true },
  { id: 'ghost-resources', label: 'Ghost resources', category: 'Validation', description: 'Unused and dangling resource findings', path: '/v1/ghost-resources', appPath: '/app/validation/ghost-resources', namespaceScoped: true },
  { id: 'image-risk', label: 'Image risk', category: 'Validation', description: 'Container image tag and pull-policy findings', path: '/v1/image-risk', appPath: '/app/validation/image-risk', namespaceScoped: true },
  { id: 'rbac', label: 'RBAC', category: 'Validation', description: 'Roles, bindings, and effective permission summaries', path: '/v1/rbac', appPath: '/app/rbac', namespaceScoped: true },
  { id: 'metrics', label: 'Metrics', category: 'Observability', description: 'Metrics API node and pod samples when available', path: '/v1/metrics', appPath: '/app/workloads', namespaceScoped: true },
  { id: 'secrets', label: 'Secret metadata', category: 'Security', description: 'Secret names, types, references, and risk metadata; values are never exposed', path: '/v1/secrets', appPath: '/app/secrets', namespaceScoped: true, redactSecretData: true }
];

export function mcpResourceById(id) {
  return MCP_RESOURCE_CATALOG.find((resource) => resource.id === id);
}

export function mcpToolDefinitions() {
  const resourceIds = MCP_RESOURCE_CATALOG.map((resource) => resource.id);
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
  return [
    {
      name: 'kubi_get_overview',
      description: 'Read the current KUBI cluster overview through the selected customer-side agent.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations
    },
    {
      name: 'kubi_get_resource',
      description: 'Read one resource from the KUBI observe-only inventory. Logs, Secret values, events, arbitrary CR objects, alerting configuration, and mutations are not exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            description: 'KUBI read-only inventory resource',
            enum: resourceIds
          },
          namespace: {
            type: 'string',
            description: 'Optional Kubernetes namespace scope; use all or omit for cluster scope',
            minLength: 1,
            maxLength: 253
          }
        },
        required: ['resource'],
        additionalProperties: false
      },
      annotations
    }
  ];
}
