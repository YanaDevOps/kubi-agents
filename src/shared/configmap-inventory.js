import { collectResourceReferences } from './resource-references.js';
import { classifySystemConfigMap } from './system-configmap.js';

const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';
const MAX_ANNOTATION_VALUE_BYTES = 1024;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.map(record) : [];
}

function strings(value) {
  const result = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function textBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function sanitizedAnnotations(value) {
  const annotations = {};
  const omittedAnnotations = [];
  for (const [key, entry] of Object.entries(strings(value))) {
    const bytes = textBytes(entry);
    const reason = key === LAST_APPLIED_ANNOTATION
      ? 'applied-resource-snapshot'
      : bytes > MAX_ANNOTATION_VALUE_BYTES
        ? 'value-too-large'
        : null;
    if (reason) {
      omittedAnnotations.push({ key, bytes, reason });
    } else {
      annotations[key] = entry;
    }
  }
  return {
    annotations,
    omittedAnnotations: omittedAnnotations.sort((left, right) => left.key.localeCompare(right.key))
  };
}

function metadata(value) {
  const meta = record(record(value).metadata);
  const annotationMetadata = sanitizedAnnotations(meta.annotations);
  return {
    name: String(meta.name || ''),
    namespace: String(meta.namespace || 'default'),
    createdAt: typeof meta.creationTimestamp === 'string' ? meta.creationTimestamp : undefined,
    labels: strings(meta.labels),
    ...annotationMetadata,
    owners: records(meta.ownerReferences)
  };
}

function referenceKey(namespace, name) {
  return `${namespace || 'default'}/${name}`;
}

const CONSUMER_KIND_ORDER = new Map([
  ['pod', 0],
  ['deployment', 1],
  ['statefulset', 2],
  ['daemonset', 3],
  ['job', 4],
  ['cronjob', 5]
]);

function consumerSort(left, right) {
  const leftKind = String(left.kind || '').toLowerCase();
  const rightKind = String(right.kind || '').toLowerCase();
  const rank = (CONSUMER_KIND_ORDER.get(leftKind) ?? 20) - (CONSUMER_KIND_ORDER.get(rightKind) ?? 20);
  return rank || leftKind.localeCompare(rightKind) || left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name);
}

function configMapConsumers(references) {
  const consumers = new Map();
  for (const reference of records(references)) {
    const kind = String(reference.kind || reference.consumerKind || '').trim() || 'Other';
    const name = String(reference.name || reference.consumerName || '').trim();
    const namespace = String(reference.namespace || '').trim() || 'default';
    if (!name) continue;
    const key = `${kind.toLowerCase()}:${namespace}/${name}`;
    const current = consumers.get(key) || {
      kind,
      name,
      namespace,
      confidence: 'inferred',
      methods: new Set(),
      referenceCount: 0
    };
    const method = String(reference.method || '').trim();
    if (method) current.methods.add(method);
    if (reference.confidence !== 'inferred') current.confidence = 'exact';
    current.referenceCount += 1;
    consumers.set(key, current);
  }
  return [...consumers.values()]
    .map((consumer) => ({ ...consumer, methods: [...consumer.methods].sort((left, right) => left.localeCompare(right)) }))
    .sort(consumerSort);
}

function normalizedConsumers(value) {
  return records(value)
    .map((consumer) => ({
      kind: String(consumer.kind || '').trim() || 'Other',
      name: String(consumer.name || '').trim(),
      namespace: String(consumer.namespace || '').trim() || 'default',
      confidence: consumer.confidence === 'inferred' ? 'inferred' : 'exact',
      methods: [...new Set(Array.isArray(consumer.methods) ? consumer.methods.map((method) => String(method || '').trim()).filter(Boolean) : [])].sort((left, right) => left.localeCompare(right)),
      referenceCount: Math.max(0, Number(consumer.referenceCount) || 0)
    }))
    .filter((consumer) => consumer.name)
    .sort(consumerSort);
}

function base64Bytes(value) {
  const normalized = value.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function availability(issues, partial) {
  return partial || issues.length ? 'degraded' : 'available';
}

export function buildConfigMapInventory(input) {
  const configMaps = records(input.configMaps);
  const references = collectResourceReferences({
    pods: input.pods,
    workloads: input.workloads,
    configMaps,
    secrets: input.secrets
  }).filter((item) => item.resourceKind === 'ConfigMap');
  const referencesByConfigMap = new Map();
  for (const reference of references) {
    const key = referenceKey(reference.namespace, reference.resourceName);
    const current = referencesByConfigMap.get(key) || [];
    current.push({
      kind: reference.consumerKind,
      name: reference.consumerName,
      namespace: reference.namespace,
      method: reference.method,
      confidence: reference.confidence,
      ...(reference.container ? { container: reference.container } : {}),
      ...(reference.variable ? { variable: reference.variable } : {}),
      ...(reference.key ? { key: reference.key } : {}),
      ...(reference.prefix ? { prefix: reference.prefix } : {}),
      ...(reference.volume ? { volume: reference.volume } : {}),
      ...(reference.argument ? { argument: reference.argument } : {})
    });
    referencesByConfigMap.set(key, current);
  }

  const referencesVerified = input.referencesComplete !== false;
  const items = configMaps.map((configMap) => {
    const meta = metadata(configMap);
    const data = strings(configMap.data);
    const binaryData = strings(configMap.binaryData);
    const referencedBy = referencesByConfigMap.get(referenceKey(meta.namespace, meta.name)) || [];
    const consumers = configMapConsumers(referencedBy);
    const classification = classifySystemConfigMap(configMap);
    const ownerKinds = [...new Set(meta.owners.map((owner) => String(owner.kind || '')).filter(Boolean))];
    const managedBy = meta.labels['app.kubernetes.io/managed-by'] || ownerKinds[0];
    return {
      id: `configmap:${meta.namespace}/${meta.name}`,
      name: meta.name,
      namespace: meta.namespace,
      createdAt: meta.createdAt,
      labels: meta.labels,
      annotations: meta.annotations,
      omittedAnnotations: meta.omittedAnnotations,
      dataKeys: Object.keys(data).sort((left, right) => left.localeCompare(right)),
      binaryDataKeys: Object.keys(binaryData).sort((left, right) => left.localeCompare(right)),
      keyCount: Object.keys(data).length + Object.keys(binaryData).length,
      totalBytes: Object.values(data).reduce((total, value) => total + textBytes(value), 0) +
        Object.values(binaryData).reduce((total, value) => total + base64Bytes(value), 0),
      immutable: configMap.immutable === true,
      referenceCount: consumers.length,
      referencePathCount: referencedBy.length,
      consumers,
      referencedBy,
      referencesVerified,
      systemManaged: classification.systemManaged,
      ...(classification.systemReason ? { systemReason: classification.systemReason } : {}),
      ...(managedBy ? { managedBy } : {}),
      ownerKinds
    };
  }).sort((left, right) => left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name));
  const issues = records(input.issues);
  const partial = Boolean(input.partial);
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  return {
    fetchedAt,
    issues,
    partial,
    availability: availability(issues, partial),
    namespaceScope: input.namespaceScope || null,
    summary: {
      total: items.length,
      referenced: items.filter((item) => item.referenceCount > 0).length,
      unreferenced: items.filter((item) => item.referenceCount === 0 && item.referencesVerified && !item.systemManaged).length,
      immutable: items.filter((item) => item.immutable).length,
      system: items.filter((item) => item.systemManaged).length
    },
    configMaps: { items, fetchedAt, issues, partial, availability: availability(issues, partial) }
  };
}

export function sanitizeConfigMapSummary(value) {
  const item = record(value);
  const safeItem = { ...item };
  delete safeItem.data;
  delete safeItem.stringData;
  delete safeItem.binaryData;
  const annotationMetadata = sanitizedAnnotations(item.annotations);
  const existingOmitted = records(item.omittedAnnotations)
    .map((entry) => ({
      key: String(entry.key || ''),
      bytes: Number.isFinite(Number(entry.bytes)) ? Math.max(0, Number(entry.bytes)) : 0,
      reason: entry.reason === 'applied-resource-snapshot' ? 'applied-resource-snapshot' : 'value-too-large'
    }))
    .filter((entry) => entry.key);
  const omittedByKey = new Map([...existingOmitted, ...annotationMetadata.omittedAnnotations].map((entry) => [entry.key, entry]));
  const hasReferencePaths = Array.isArray(item.referencedBy);
  const referencedBy = records(item.referencedBy);
  const consumers = hasReferencePaths ? configMapConsumers(referencedBy) : normalizedConsumers(item.consumers);
  const legacyReferenceCount = Math.max(0, Number(item.referenceCount) || 0);
  return {
    ...safeItem,
    annotations: annotationMetadata.annotations,
    omittedAnnotations: [...omittedByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    referenceCount: hasReferencePaths || consumers.length ? consumers.length : legacyReferenceCount,
    referencePathCount: hasReferencePaths
      ? referencedBy.length
      : Math.max(0, Number(item.referencePathCount) || legacyReferenceCount),
    consumers,
    referencedBy
  };
}

export function sanitizeConfigMapInventoryPayload(value) {
  const payload = record(value);
  const configMaps = record(payload.configMaps);
  return {
    ...payload,
    configMaps: {
      ...configMaps,
      items: records(configMaps.items).map(sanitizeConfigMapSummary)
    }
  };
}

export function configMapContent(value) {
  const configMap = record(value);
  const meta = metadata(configMap);
  const binaryData = strings(configMap.binaryData);
  return {
    name: meta.name,
    namespace: meta.namespace,
    data: strings(configMap.data),
    binaryData: Object.entries(binaryData)
      .map(([key, encoded]) => ({ key, bytes: base64Bytes(encoded) }))
      .sort((left, right) => left.key.localeCompare(right.key))
  };
}
