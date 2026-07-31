const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const KUBERNETES_DESCRIPTION = 'kubernetes.io/description';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Classifies only standard Kubernetes-managed ConfigMap signals. Raw metadata is
 * intentionally reduced to a boolean and reason before crossing runtime APIs.
 */
export function classifySystemConfigMap(value) {
  const input = record(value);
  const metadata = record(input.metadata);
  const annotations = record(metadata.annotations || input.annotations);
  const namespace = String(metadata.namespace || input.namespace || '').trim().toLowerCase();
  const name = String(metadata.name || input.resourceName || input.name || '').trim().toLowerCase();

  if (SYSTEM_NAMESPACES.has(namespace)) {
    return { systemManaged: true, systemReason: 'system-namespace' };
  }
  if (name === 'kube-root-ca.crt') {
    return { systemManaged: true, systemReason: 'kubernetes-root-ca' };
  }
  if (Object.prototype.hasOwnProperty.call(annotations, KUBERNETES_DESCRIPTION)) {
    return { systemManaged: true, systemReason: 'kubernetes-description' };
  }
  return { systemManaged: false };
}
