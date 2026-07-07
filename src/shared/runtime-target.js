function normalizePart(value) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, '/');
}

export function deriveRuntimeTargetKey(input) {
  const clusterFingerprint = normalizePart(input.clusterFingerprint);
  if (clusterFingerprint) {
    return `fingerprint:${clusterFingerprint}`;
  }

  const sourceClusterName = normalizePart(input.sourceClusterName);
  const sourceContextName = normalizePart(input.sourceContextName);
  if (sourceClusterName && sourceContextName) {
    return `context:${sourceClusterName}|${sourceContextName}`;
  }

  const endpointMasked = normalizePart(input.endpointMasked);
  const connectionSource = normalizePart(input.connectionSource);
  const providerKind = normalizePart(input.providerKind);
  if (endpointMasked) {
    return `endpoint:${endpointMasked}|${connectionSource || 'unknown'}|${providerKind || 'unknown'}`;
  }

  return `unknown:${connectionSource || 'unknown'}|${providerKind || 'unknown'}`;
}
