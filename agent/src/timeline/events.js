import { createHash } from 'node:crypto';
import { DELIVERY_RESOURCE_DEFINITIONS } from '../../../src/shared/delivery-activity.js';
import { BACKUP_RESOURCE_DEFINITIONS } from '../../../src/shared/backup-activity.js';

export const TIMELINE_MESSAGE_LIMIT = 1024;
export const TIMELINE_RESOURCE_DEFINITIONS = [
  ...DELIVERY_RESOURCE_DEFINITIONS.map((definition) => ({ ...definition, timelineCategory: 'delivery' })),
  ...BACKUP_RESOURCE_DEFINITIONS.map((definition) => ({ ...definition, timelineCategory: 'backup' }))
];

const list = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);

/** Defense in depth for untrusted controller messages; never pass whole specs/statuses here. */
export function sanitizeTimelineText(value, limit = TIMELINE_MESSAGE_LIMIT) {
  if (!scalar(value)) return '';
  const cap = Number.isFinite(limit) ? Math.max(0, Math.min(65536, Math.floor(limit))) : TIMELINE_MESSAGE_LIMIT;
  return String(value).slice(0, 131072)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(/\b(?:https?|ssh):\/\/[^\s<>"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      } catch { return '[REDACTED URL]'; }
    })
    .replace(/(["']?(?:[\w.-]*(?:token|password|passwd|secret|credential|api[_-]?key|access[_-]?key|authorization)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_+/=]{32,}/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, cap);
}

function timestamp(...values) {
  for (const value of values) {
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return null;
}

function resourceOf(object, reference = false) {
  const meta = reference ? object : object?.metadata;
  if (![object?.apiVersion, object?.kind, meta?.name, meta?.uid].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512)) return null;
  return {
    apiVersion: sanitizeTimelineText(object.apiVersion, 128),
    kind: sanitizeTimelineText(object.kind, 128),
    name: sanitizeTimelineText(meta.name, 253),
    namespace: sanitizeTimelineText(meta.namespace, 253) || null,
    uid: sanitizeTimelineText(meta.uid, 512)
  };
}

function nativeCategory(object) {
  const group = object?.apiVersion?.includes('/') ? object.apiVersion.split('/')[0] : '';
  if (group === '' && ['Pod', 'Node', 'PersistentVolume', 'PersistentVolumeClaim', 'ReplicationController'].includes(object?.kind)) {
    return object.kind === 'Pod' ? 'pod' : object.kind === 'Node' ? 'node' : object.kind === 'ReplicationController' ? 'workload' : 'storage';
  }
  if (group === 'apps' && ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(object?.kind)) return 'workload';
  if (group === 'batch' && ['Job', 'CronJob'].includes(object?.kind)) return 'job';
  return null;
}

function definitionOf(object) {
  const [group, version] = String(object?.apiVersion || '').split('/');
  return TIMELINE_RESOURCE_DEFINITIONS.find((definition) => definition.group === group && definition.kind === object?.kind && definition.versions.includes(version));
}

function conditions(object) {
  return list(object?.status?.conditions).slice(0, 64).map((condition) => ({
    type: sanitizeTimelineText(condition.type, 128),
    status: ['True', 'False', 'Unknown'].includes(condition.status) ? condition.status : 'Unknown',
    reason: sanitizeTimelineText(condition.reason, 128)
  })).filter((condition) => condition.type).sort((a, b) => a.type.localeCompare(b.type));
}

function conditionTime(object, type) {
  return list(object?.status?.conditions).find((condition) => condition.type === type)?.lastTransitionTime;
}

const badState = (value) => /fail|error|degraded|unhealthy|unavailable|lost|evict|oom|backoff|invalid|outofsync|notready|stalled/i.test(value || '');
const goodState = (value) => /^(?:ready|healthy|bound|available|succeeded|successful|success|completed?|synced|running)$/i.test(value || '');

function transitionSeverity(before, after) {
  if (badState(after)) return /oom|evict|lost/i.test(after) ? 'critical' : 'warning';
  return badState(before) && goodState(after) ? 'recovery' : 'change';
}

function containerStatuses(object) {
  return ['containerStatuses', 'initContainerStatuses', 'ephemeralContainerStatuses'].flatMap((field) =>
    list(object?.status?.[field]).slice(0, 128).map((status) => ({ field, status })));
}

function containerProblem(status) {
  const state = status?.state;
  if (state?.waiting?.reason) return sanitizeTimelineText(state.waiting.reason, 128);
  if (state?.terminated && (state.terminated.reason === 'OOMKilled' || (count(state.terminated.exitCode) ?? 0) > 0)) {
    return sanitizeTimelineText(state.terminated.reason, 128) || 'ContainerFailed';
  }
  return '';
}

function reducePod(previous, current, emit) {
  const old = containerStatuses(previous);
  for (const { field, status } of containerStatuses(current)) {
    const prior = old.find((item) => item.field === field && item.status.name === status.name)?.status;
    if (!prior) continue; // A newly observed container has no trustworthy restart baseline.
    const container = sanitizeTimelineText(status.name, 253);
    const from = count(prior.restartCount);
    const to = count(status.restartCount);
    const restarted = from !== null && to !== null && to > from;
    const termination = status.lastState?.terminated || status.state?.terminated;
    const oom = termination?.reason === 'OOMKilled';
    if (restarted) {
      emit(oom ? 'OOMKilled' : 'ContainerRestarted', oom ? 'critical' : 'warning',
        `${container} restarted ${to - from} time(s)${oom ? ' after OOM kill' : ''}`,
        { container, containerType: field, restartCount: from }, { container, containerType: field, restartCount: to, delta: to - from }, termination?.finishedAt);
    }
    const before = containerProblem(prior);
    const after = containerProblem(status);
    if (before !== after && after && !(restarted && oom && after === 'OOMKilled')) {
      emit(after, after === 'OOMKilled' ? 'critical' : 'warning', `${container}: ${after}`,
        { container, containerType: field, state: before || 'Running' }, { container, containerType: field, state: after }, status.state?.terminated?.finishedAt);
    } else if (before && !after && status.state?.running && status.ready === true) {
      emit('ContainerRecovered', 'recovery', `${container} is running and ready`,
        { container, containerType: field, state: before }, { container, containerType: field, state: 'Ready' }, status.state.running.startedAt);
    }
  }
  const beforeReason = previous.status?.reason || previous.status?.phase;
  const afterReason = current.status?.reason || current.status?.phase;
  if (beforeReason !== afterReason && afterReason) {
    emit(afterReason === 'Evicted' ? 'Evicted' : 'PodPhaseChanged', transitionSeverity(beforeReason, afterReason),
      `Pod state changed to ${sanitizeTimelineText(afterReason, 128)}`,
      { phase: sanitizeTimelineText(beforeReason, 128) }, { phase: sanitizeTimelineText(afterReason, 128) });
  }
  reduceConditions(previous, current, emit, ['Ready', 'PodScheduled'], 'Pod');
}

function reduceConditions(previous, current, emit, types, prefix) {
  const old = conditions(previous);
  for (const after of conditions(current).filter((condition) => types.includes(condition.type))) {
    const before = old.find((condition) => condition.type === after.type);
    if (!before || before.status === after.status) continue;
    const negative = /Pressure$|NetworkUnavailable|ReplicaFailure|Failed|FailureTarget/.test(after.type);
    const healthy = after.status === (negative ? 'False' : 'True');
    const severity = healthy ? 'recovery' : prefix === 'Node' && after.type === 'Ready' ? 'critical' : 'warning';
    emit(`${prefix}${after.type}Changed`, severity, `${after.type} changed from ${before.status} to ${after.status}`,
      { condition: before }, { condition: after }, conditionTime(current, after.type));
  }
}

function images(object) {
  const spec = object?.spec?.template?.spec;
  return ['containers', 'initContainers'].flatMap((field) => list(spec?.[field]).slice(0, 128).map((container) => ({
    type: field, name: sanitizeTimelineText(container.name, 253), image: sanitizeTimelineText(container.image, 512)
  }))).sort((a, b) => `${a.type}/${a.name}`.localeCompare(`${b.type}/${b.name}`));
}

function reduceWorkload(previous, current, emit) {
  const beforeImages = images(previous);
  const afterImages = images(current);
  if (!same(beforeImages, afterImages)) emit('WorkloadImagesChanged', 'change', 'Workload container images changed', { images: beforeImages }, { images: afterImages });
  const beforeReplicas = count(previous.spec?.replicas) ?? 1;
  const afterReplicas = count(current.spec?.replicas) ?? 1;
  if (current.kind !== 'DaemonSet' && beforeReplicas !== afterReplicas) {
    emit('WorkloadReplicasChanged', 'change', `Desired replicas changed from ${beforeReplicas} to ${afterReplicas}`, { replicas: beforeReplicas }, { replicas: afterReplicas });
  }
  for (const field of ['currentRevision', 'updateRevision']) {
    const before = sanitizeTimelineText(previous.status?.[field], 256);
    const after = sanitizeTimelineText(current.status?.[field], 256);
    if (before && after && before !== after) emit('WorkloadRevisionChanged', 'change', `${field} changed`, { [field]: before }, { [field]: after });
  }
  reduceConditions(previous, current, emit, ['Available', 'Progressing', 'ReplicaFailure'], 'Workload');
  const oldProgress = conditions(previous).find((condition) => condition.type === 'Progressing');
  const progress = conditions(current).find((condition) => condition.type === 'Progressing');
  if (oldProgress && progress?.status === 'True' && progress.reason === 'NewReplicaSetAvailable' && oldProgress.reason !== progress.reason && oldProgress.status === progress.status) {
    emit('WorkloadRolloutCompleted', 'change', 'Workload rollout completed', { condition: oldProgress }, { condition: progress }, conditionTime(current, 'Progressing'));
  }
}

// Explicit scalar paths cover provider lifecycle state without copying embedded specs,
// artifacts, results, repository credentials, controller messages, or backup locations.
const PROVIDER_STATUS_PATHS = [
  'phase', 'state', 'status', 'validation', 'health.status', 'sync.status', 'operationState.phase',
  'readyToUse', 'lastAppliedRevision', 'lastAttemptedRevision', 'observedSourceArtifactRevision',
  'artifact.revision', 'sync.revision', 'currentRevision', 'updateRevision'
];

function providerStatus(object) {
  const result = {};
  for (const path of PROVIDER_STATUS_PATHS) {
    const value = at(object?.status, path);
    if (scalar(value)) result[path] = typeof value === 'string' ? sanitizeTimelineText(value, 256) : value;
  }
  result.conditions = conditions(object);
  result.hasError = Boolean(object?.status?.error || object?.status?.failureReason || (count(object?.status?.errors) ?? list(object?.status?.errors).length) > 0);
  return result;
}

function providerHealth(state) {
  if (state.hasError) return 'failed';
  const lifecycle = ['phase', 'state', 'status', 'validation', 'health.status', 'sync.status', 'operationState.phase'].map((key) => state[key]);
  if (lifecycle.some(badState)) return 'failed';
  if (state.conditions.some((condition) =>
    (['Ready', 'Succeeded', 'Available', 'Healthy'].includes(condition.type) && condition.status === 'False') ||
    (/Error|Failed|Failure|Stalled/.test(condition.type) && condition.status === 'True'))) return 'failed';
  if (state.readyToUse === true || lifecycle.some(goodState) || state.conditions.some((condition) =>
    ['Ready', 'Succeeded', 'Available', 'Complete', 'Healthy'].includes(condition.type) && condition.status === 'True')) return 'healthy';
  return 'unknown';
}

function reduceProvider(previous, current, definition, emit) {
  const before = providerStatus(previous);
  const after = providerStatus(current);
  if (same(before, after)) return;
  const oldHealth = providerHealth(before);
  const health = providerHealth(after);
  const severity = health === 'failed' ? 'warning' : oldHealth === 'failed' && health === 'healthy' ? 'recovery' : 'change';
  const changed = Object.keys(after).filter((key) => !same(before[key], after[key]));
  const changedCondition = after.conditions.find((condition) => !same(condition, before.conditions.find((old) => old.type === condition.type)));
  emit('ProviderStatusChanged', severity, `${definition.providerName} ${current.kind} status changed: ${changed.join(', ')}`,
    before, after, conditionTime(current, changedCondition?.type) || current.status?.operationState?.finishedAt || current.status?.completionTimestamp || current.status?.completedAt || current.status?.endTime);
}

/**
 * Pure object reducer. First observation, missing UID, replacement UID, and absent
 * current objects produce no events. The collector owns baseline/deletion policy.
 * observedAt should be an ISO timestamp; the deterministic fallback is the epoch.
 * id/dedupKey identify a transition using UID + resourceVersion (opaque, not ordered).
 */
export function reduceTimelineObject(previous, current, options = {}) {
  const resource = resourceOf(current);
  if (!resource || !resourceOf(previous) || previous.metadata.uid !== current.metadata.uid || previous.kind !== current.kind || previous.apiVersion !== current.apiVersion || previous.metadata.name !== current.metadata.name || previous.metadata.namespace !== current.metadata.namespace) return [];
  const definition = definitionOf(current);
  const category = definition?.timelineCategory || nativeCategory(current);
  if (!category) return [];
  const observedAt = timestamp(options.observedAt) || '1970-01-01T00:00:00.000Z';
  const events = [];
  const emit = (reason, severity, summary, before, after, time) => {
    const id = hash(['object', current.metadata.uid, current.apiVersion, current.kind, current.metadata.resourceVersion || null, reason, before, after, timestamp(time)]);
    events.push({ id, dedupKey: id, source: 'kubernetes-object', category, severity,
      reason: sanitizeTimelineText(reason, 128), title: sanitizeTimelineText(`${resource.kind} ${resource.name}: ${reason}`, 256),
      summary: sanitizeTimelineText(summary), resource, occurredAt: timestamp(time) || observedAt, observedAt, before, after,
      ...(definition ? { providerId: definition.providerId } : {}) });
  };
  if (definition) reduceProvider(previous, current, definition, emit);
  else if (category === 'pod') reducePod(previous, current, emit);
  else if (category === 'workload') reduceWorkload(previous, current, emit);
  else if (category === 'node') {
    reduceConditions(previous, current, emit, ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'], 'Node');
    const before = previous.spec?.unschedulable === true;
    const after = current.spec?.unschedulable === true;
    if (before !== after) emit(after ? 'NodeCordoned' : 'NodeUncordoned', 'change', after ? 'Node was cordoned' : 'Node was uncordoned', { unschedulable: before }, { unschedulable: after });
    const oldVersion = sanitizeTimelineText(previous.status?.nodeInfo?.kubeletVersion, 128);
    const version = sanitizeTimelineText(current.status?.nodeInfo?.kubeletVersion, 128);
    if (oldVersion && version && oldVersion !== version) emit('KubeletVersionChanged', 'change', `Kubelet changed from ${oldVersion} to ${version}`, { kubeletVersion: oldVersion }, { kubeletVersion: version });
  } else if (category === 'storage') {
    const before = sanitizeTimelineText(previous.status?.phase, 128);
    const after = sanitizeTimelineText(current.status?.phase, 128);
    if (before !== after && after) emit('VolumePhaseChanged', transitionSeverity(before, after), `Volume phase changed from ${before || 'Unknown'} to ${after}`, { phase: before }, { phase: after }, current.status?.lastPhaseTransitionTime);
  } else if (current.kind === 'CronJob') {
    const before = previous.spec?.suspend === true;
    const after = current.spec?.suspend === true;
    if (before !== after) emit(after ? 'CronJobSuspended' : 'CronJobResumed', 'change', after ? 'CronJob was suspended' : 'CronJob was resumed', { suspend: before }, { suspend: after });
  } else if (current.kind === 'Job') {
    for (const type of ['Complete', 'Failed', 'FailureTarget']) {
      const before = conditions(previous).find((condition) => condition.type === type);
      const after = conditions(current).find((condition) => condition.type === type);
      if (after?.status !== 'True' || before?.status === 'True') continue;
      if (type === 'FailureTarget' && conditions(current).some((condition) => condition.type === 'Failed' && condition.status === 'True')) continue;
      emit(type === 'Complete' ? 'JobCompleted' : 'JobFailed', type === 'Complete' ? 'change' : 'warning', type === 'Complete' ? 'Job completed' : 'Job failed',
        { condition: before || null }, { condition: after }, conditionTime(current, type) || current.status?.completionTime);
    }
  }
  return events;
}

const MEANINGFUL_NORMAL_REASONS = new Set([
  'NodeReady', 'NodeNotReady', 'NodeSchedulable', 'NodeNotSchedulable', 'NodeHasSufficientMemory',
  'NodeHasNoDiskPressure', 'NodeHasSufficientPID', 'ScalingReplicaSet', 'SuccessfulRescale',
  'RolloutCompleted', 'ProgressDeadlineExceeded', 'BackOff', 'Evicted', 'OOMKilled',
  'Completed', 'JobCompleted', 'SawCompletedJob', 'SuccessfulDelete', 'VolumeResizeSuccessful',
  'FileSystemResizeSuccessful', 'ProvisioningSucceeded', 'Bound', 'Synced', 'ReconciliationSucceeded',
  'ReconciliationFailed', 'HealthStatusChanged', 'OperationCompleted', 'OperationFailed', 'BackupCompleted', 'BackupFailed', 'RestoreCompleted', 'RestoreFailed'
]);

function eventOccurrence(object) {
  return {
    count: count(object?.series?.count) ?? count(object?.count) ?? count(object?.deprecatedCount) ?? 1,
    time: timestamp(object?.series?.lastObservedTime, object?.lastTimestamp, object?.deprecatedLastTimestamp, object?.eventTime, object?.firstTimestamp, object?.metadata?.creationTimestamp)
  };
}

/** Kubernetes Event series dedupKey is stable; id changes with count/time, not poll time or resourceVersion. */
export function reduceKubernetesEvent(previous, current, options = {}) {
  if (current?.kind !== 'Event' || !['v1', 'events.k8s.io/v1', 'events.k8s.io/v1beta1'].includes(current.apiVersion)) return [];
  const reference = current.regarding || current.involvedObject;
  const resource = resourceOf(reference, true);
  if (!resource || typeof current.metadata?.uid !== 'string' || !current.metadata.uid) return [];
  const reason = sanitizeTimelineText(current.reason, 128) || 'KubernetesEvent';
  if (current.type !== 'Warning' && !(current.type === 'Normal' && MEANINGFUL_NORMAL_REASONS.has(current.reason))) return [];
  const occurrence = eventOccurrence(current);
  const prior = previous?.metadata?.uid === current.metadata.uid ? eventOccurrence(previous) : null;
  if (prior && (same(prior, occurrence) || occurrence.count < prior.count || (occurrence.count === prior.count && prior.time && (!occurrence.time || occurrence.time <= prior.time)))) return [];
  const definition = definitionOf(reference);
  const category = definition?.timelineCategory || nativeCategory(reference) || 'kubernetes';
  const observedAt = timestamp(options.observedAt) || occurrence.time || '1970-01-01T00:00:00.000Z';
  const dedupKey = hash(['event', current.metadata.uid, reference.uid]);
  const severity = /OOM|Evict|NodeNotReady|VolumeLost/i.test(reason) ? 'critical'
    : current.type === 'Warning' || badState(reason) ? 'warning'
      : /^(?:NodeReady|NodeHasSufficientMemory|NodeHasNoDiskPressure|NodeHasSufficientPID|ReconciliationSucceeded)$/.test(reason) ? 'recovery' : 'change';
  return [{
    id: hash([dedupKey, occurrence]), dedupKey, source: 'kubernetes-event', category, severity, reason,
    title: sanitizeTimelineText(`${resource.kind} ${resource.name}: ${reason}`, 256),
    summary: sanitizeTimelineText(current.note || current.message || reason), resource,
    occurredAt: occurrence.time || observedAt, observedAt,
    before: prior ? { count: prior.count } : null, after: { count: occurrence.count, type: current.type },
    ...(definition ? { providerId: definition.providerId } : {})
  }];
}

export function reduceTimelineEvents(previous, current, options = {}) {
  return current?.kind === 'Event' ? reduceKubernetesEvent(previous, current, options) : reduceTimelineObject(previous, current, options);
}
