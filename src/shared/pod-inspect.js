import { stringify } from 'yaml';

const REDACTED = '<redacted by KUBI>';
const DROP_ANNOTATIONS = new Set(['kubectl.kubernetes.io/last-applied-configuration']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Kinds the generic object inspector may read. Secrets are deliberately absent:
 * KUBI never reads Secret values. ConfigMaps have their own content view.
 */
export const INSPECT_KINDS = {
  Job: { base: '/apis/batch/v1', plural: 'jobs', namespaced: true },
  CronJob: { base: '/apis/batch/v1', plural: 'cronjobs', namespaced: true },
  Deployment: { base: '/apis/apps/v1', plural: 'deployments', namespaced: true },
  StatefulSet: { base: '/apis/apps/v1', plural: 'statefulsets', namespaced: true },
  DaemonSet: { base: '/apis/apps/v1', plural: 'daemonsets', namespaced: true },
  ReplicaSet: { base: '/apis/apps/v1', plural: 'replicasets', namespaced: true },
  Service: { base: '/api/v1', plural: 'services', namespaced: true },
  Ingress: { base: '/apis/networking.k8s.io/v1', plural: 'ingresses', namespaced: true },
  NetworkPolicy: { base: '/apis/networking.k8s.io/v1', plural: 'networkpolicies', namespaced: true },
  PersistentVolumeClaim: { base: '/api/v1', plural: 'persistentvolumeclaims', namespaced: true },
  PersistentVolume: { base: '/api/v1', plural: 'persistentvolumes', namespaced: false },
  StorageClass: { base: '/apis/storage.k8s.io/v1', plural: 'storageclasses', namespaced: false },
  Namespace: { base: '/api/v1', plural: 'namespaces', namespaced: false },
  ServiceAccount: { base: '/api/v1', plural: 'serviceaccounts', namespaced: true },
  HorizontalPodAutoscaler: { base: '/apis/autoscaling/v2', plural: 'horizontalpodautoscalers', namespaced: true },
  PodDisruptionBudget: { base: '/apis/policy/v1', plural: 'poddisruptionbudgets', namespaced: true },
};

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Returns the API path and event field selector for an allowed object, or throws. */
export function inspectObjectPaths({ kind, namespace, name }) {
  const entry = Object.prototype.hasOwnProperty.call(INSPECT_KINDS, kind) ? INSPECT_KINDS[kind] : undefined;
  if (!entry) throw new TypeError('This object kind cannot be inspected.');
  if (!name || name.length > 253 || !NAME_PATTERN.test(name)) throw new TypeError('Invalid object name.');
  if (entry.namespaced && (!namespace || namespace.length > 63 || !NAME_PATTERN.test(namespace))) throw new TypeError('Invalid namespace.');
  const scope = entry.namespaced ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  const selector = encodeURIComponent(`involvedObject.kind=${kind},involvedObject.name=${name}`);
  return {
    object: `${entry.base}${scope}/${entry.plural}/${encodeURIComponent(name)}`,
    events: entry.namespaced ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?fieldSelector=${selector}` : `/api/v1/events?fieldSelector=${selector}`,
  };
}

function redactPodSpec(spec) {
  for (const list of [spec?.containers, spec?.initContainers, spec?.ephemeralContainers]) {
    for (const container of asArray(list)) {
      for (const env of asArray(asRecord(container)?.env)) {
        if (asRecord(env) && typeof env.value === 'string') env.value = REDACTED;
      }
    }
  }
}

/**
 * Removes noisy and potentially sensitive fields before an object is shown as
 * YAML: managedFields, the last-applied annotation and literal env values in
 * any embedded Pod spec. Env references (valueFrom) only name the source.
 */
export function sanitizeObjectManifest(object) {
  const copy = JSON.parse(JSON.stringify(object ?? {}));
  const metadata = asRecord(copy.metadata);
  if (metadata) {
    delete metadata.managedFields;
    const annotations = asRecord(metadata.annotations);
    if (annotations) for (const key of Object.keys(annotations)) if (DROP_ANNOTATIONS.has(key)) delete annotations[key];
  }
  const spec = asRecord(copy.spec);
  redactPodSpec(spec);
  redactPodSpec(asRecord(asRecord(spec?.template)?.spec));
  redactPodSpec(asRecord(asRecord(asRecord(asRecord(spec?.jobTemplate)?.spec)?.template)?.spec));
  return copy;
}

export const sanitizePodManifest = sanitizeObjectManifest;

function normalizeEvents(events) {
  return asArray(events)
    .map((event) => ({
      type: text(event?.type) ?? 'Normal',
      reason: text(event?.reason) ?? '',
      message: text(event?.message ?? event?.note) ?? '',
      count: typeof event?.count === 'number' ? event.count : asRecord(event?.series)?.count ?? 1,
      lastTimestamp: text(event?.lastTimestamp) ?? text(event?.eventTime) ?? text(asRecord(event?.series)?.lastObservedTime) ?? text(event?.metadata?.creationTimestamp),
    }))
    .sort((a, b) => Date.parse(b.lastTimestamp ?? '') - Date.parse(a.lastTimestamp ?? ''))
    .slice(0, 50);
}

function normalizeConditions(status) {
  return asArray(status?.conditions).map((condition) => ({
    type: text(condition?.type) ?? 'Unknown',
    status: text(condition?.status) ?? 'Unknown',
    reason: text(condition?.reason),
    message: text(condition?.message),
    lastTransitionTime: text(condition?.lastTransitionTime),
  }));
}

/** Generic drawer payload for allow-listed kinds: conditions, events and a sanitized manifest. */
export function buildObjectInspect({ kind, object, events = [] }) {
  const metadata = asRecord(object?.metadata) ?? {};
  return {
    kind,
    namespace: text(metadata.namespace),
    name: text(metadata.name) ?? '',
    conditions: normalizeConditions(asRecord(object?.status)),
    events: normalizeEvents(events),
    manifest: stringify(sanitizeObjectManifest(object), { lineWidth: 0 }),
  };
}

function containerState(status) {
  const state = asRecord(status?.state) ?? {};
  if (state.running) return { state: 'Running', since: text(state.running.startedAt) };
  if (state.waiting) return { state: text(state.waiting.reason) ?? 'Waiting', message: text(state.waiting.message) };
  if (state.terminated) return { state: text(state.terminated.reason) ?? 'Terminated', exitCode: state.terminated.exitCode, since: text(state.terminated.finishedAt) };
  return { state: 'Unknown' };
}

function lastTermination(status) {
  const terminated = asRecord(asRecord(status?.lastState)?.terminated);
  if (!terminated) return undefined;
  return {
    reason: text(terminated.reason) ?? 'Terminated',
    exitCode: typeof terminated.exitCode === 'number' ? terminated.exitCode : undefined,
    finishedAt: text(terminated.finishedAt),
  };
}

/** Builds the Pod drawer payload: containers, conditions, placement, events and a sanitized manifest. */
export function buildPodInspect({ pod, events = [] }) {
  const metadata = asRecord(pod?.metadata) ?? {};
  const spec = asRecord(pod?.spec) ?? {};
  const status = asRecord(pod?.status) ?? {};
  const statuses = new Map(
    [...asArray(status.containerStatuses), ...asArray(status.initContainerStatuses)].map((entry) => [entry?.name, entry])
  );
  const containers = [
    ...asArray(spec.initContainers).map((container) => ({ container, init: true })),
    ...asArray(spec.containers).map((container) => ({ container, init: false })),
  ].map(({ container, init }) => {
    const containerStatus = statuses.get(container?.name);
    const resources = asRecord(container?.resources) ?? {};
    return {
      name: text(container?.name) ?? 'container',
      init,
      image: text(container?.image) ?? '',
      ready: Boolean(containerStatus?.ready),
      restartCount: typeof containerStatus?.restartCount === 'number' ? containerStatus.restartCount : 0,
      ...containerState(containerStatus),
      lastTermination: lastTermination(containerStatus),
      requests: { cpu: text(asRecord(resources.requests)?.cpu), memory: text(asRecord(resources.requests)?.memory) },
      limits: { cpu: text(asRecord(resources.limits)?.cpu), memory: text(asRecord(resources.limits)?.memory) },
      ports: asArray(container?.ports).map((port) => `${port.containerPort}/${port.protocol || 'TCP'}${port.name ? ` ${port.name}` : ''}`),
      probes: ['livenessProbe', 'readinessProbe', 'startupProbe'].filter((key) => asRecord(container?.[key])),
    };
  });
  const conditions = normalizeConditions(status);
  const podEvents = normalizeEvents(events);
  return {
    namespace: text(metadata.namespace) ?? 'default',
    name: text(metadata.name) ?? '',
    node: text(spec.nodeName),
    podIp: text(status.podIP),
    hostIp: text(status.hostIP),
    serviceAccount: text(spec.serviceAccountName),
    priorityClass: text(spec.priorityClassName),
    qosClass: text(status.qosClass),
    startTime: text(status.startTime),
    containers,
    conditions,
    events: podEvents,
    manifest: stringify(sanitizePodManifest(pod), { lineWidth: 0 }),
  };
}
