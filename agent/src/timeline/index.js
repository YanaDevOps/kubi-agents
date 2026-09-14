import { createHash } from 'node:crypto';
import { createTimelineStore } from './store.js';
import { reduceTimelineEvents, reduceTimelineLifecycle } from './events.js';
import { fetchKubeList, loadLocalKubeConfig, loadLocalPodLogs, resolveAgentRuntimeConfigForSelector } from '../kube.js';
import { DELIVERY_RESOURCE_DEFINITIONS } from '../../../src/shared/delivery-activity.js';
import { BACKUP_RESOURCE_DEFINITIONS } from '../../../src/shared/backup-activity.js';

const POLL_MS = 15_000;
const CYCLE_TIMEOUT_MS = 45_000;
const MAX_ITEMS = 2_000;
const BASELINE_SCHEMA_VERSION = 2;
const CORE_SOURCE_DEFS = [
  ['pods', '/api/v1/pods', 'v1', 'Pod'],
  ['nodes', '/api/v1/nodes', 'v1', 'Node'],
  ['deployments', '/apis/apps/v1/deployments', 'apps/v1', 'Deployment'],
  ['statefulsets', '/apis/apps/v1/statefulsets', 'apps/v1', 'StatefulSet'],
  ['daemonsets', '/apis/apps/v1/daemonsets', 'apps/v1', 'DaemonSet'],
  ['jobs', '/apis/batch/v1/jobs', 'batch/v1', 'Job'],
  ['cronjobs', '/apis/batch/v1/cronjobs', 'batch/v1', 'CronJob'],
  ['services', '/api/v1/services', 'v1', 'Service'],
  ['persistentvolumes', '/api/v1/persistentvolumes', 'v1', 'PersistentVolume'],
  ['persistentvolumeclaims', '/api/v1/persistentvolumeclaims', 'v1', 'PersistentVolumeClaim'],
  ['events', '/api/v1/events', 'v1', 'Event'],
  ['events.k8s.io', '/apis/events.k8s.io/v1/events', 'events.k8s.io/v1', 'Event'],
  ['customresourcedefinitions', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions', 'apiextensions.k8s.io/v1', 'CustomResourceDefinition']
];

const PROVIDER_SOURCE_DEFS = [...DELIVERY_RESOURCE_DEFINITIONS, ...BACKUP_RESOURCE_DEFINITIONS]
  .map((definition) => [
    `${definition.providerId}:${definition.resource}`,
    `/apis/${definition.group}/${definition.versions[0]}/${definition.resource}`,
    `${definition.group}/${definition.versions[0]}`,
    definition.kind,
    `${definition.resource}.${definition.group}`
  ])
  .filter(([, path], index, entries) => entries.findIndex(([, candidate]) => candidate === path) === index);
const LOG_REASONS = /restart|oom|crash|backoff|fail|evict/i;

const keyOf = (object) => `${object?.apiVersion || ''}/${object?.kind || ''}/${object?.metadata?.uid || ''}`;
const targetKey = (target) => createHash('sha256').update(JSON.stringify([
  target.workspaceId, target.agentId, target.connectionId, target.connectionSelector
])).digest('hex');

function project(object) {
  if (!object?.metadata?.uid || !object?.apiVersion || !object?.kind) return null;
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    metadata: {
      name: object.metadata.name,
      namespace: object.metadata.namespace,
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
      creationTimestamp: object.metadata.creationTimestamp,
      generation: object.metadata.generation
    },
    spec: object.spec ? {
      replicas: object.spec.replicas,
      suspend: object.spec.suspend,
      unschedulable: object.spec.unschedulable,
      template: object.spec.template ? { spec: { containers: (object.spec.template.spec?.containers || []).map(({ name, image }) => ({ name, image })) } } : undefined
    } : undefined,
    status: object.status ? {
      phase: object.status.phase,
      reason: object.status.reason,
      conditions: object.status.conditions,
      containerStatuses: object.status.containerStatuses,
      initContainerStatuses: object.status.initContainerStatuses,
      ephemeralContainerStatuses: object.status.ephemeralContainerStatuses,
      currentRevision: object.status.currentRevision,
      updateRevision: object.status.updateRevision,
      readyReplicas: object.status.readyReplicas,
      availableReplicas: object.status.availableReplicas,
      observedGeneration: object.status.observedGeneration,
      nodeInfo: object.status.nodeInfo
    } : undefined
  };
}

function eventProject(object) {
  if (!object?.metadata?.uid) return null;
  return { ...object, metadata: { uid: object.metadata.uid, creationTimestamp: object.metadata.creationTimestamp } };
}

export function normalizeTimelineSourceItem(item, apiVersion, kind) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return {
    ...item,
    apiVersion: item.apiVersion || apiVersion,
    kind: item.kind || kind
  };
}

async function listSource(runtimeConfig, path, apiVersion, kind, signal) {
  const kubeConfig = runtimeConfig.__kubeConfig || runtimeConfig.kubeConfig || loadLocalKubeConfig(runtimeConfig);
  const result = await fetchKubeList(kubeConfig, path, true, {
    pageLimit: 500,
    maxPages: 4,
    timeoutMs: 10_000,
    signal
  });
  return (result?.items || []).slice(0, MAX_ITEMS)
    .map((item) => normalizeTimelineSourceItem(item, apiVersion, kind));
}

export function selectTimelineProviderSources(crds) {
  const installed = new Set((Array.isArray(crds) ? crds : [])
    .map((crd) => crd?.metadata?.name)
    .filter((name) => typeof name === 'string'));
  return PROVIDER_SOURCE_DEFS.filter((definition) => installed.has(definition[4]));
}

export async function withTimelineCycleDeadline(operation, timeoutMs = CYCLE_TIMEOUT_MS) {
  if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid Timeline cycle deadline.');
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timeline collection cycle timed out after ${timeoutMs}ms.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyState() {
  return { schemaVersion: BASELINE_SCHEMA_VERSION, initialized: false, sources: {}, lastObservedAt: null, gaps: 0 };
}

export function restoreTimelineBaseline(state) {
  return state?.schemaVersion === BASELINE_SCHEMA_VERSION ? state : emptyState();
}

export function reduceTimelineSnapshot(baseline, sources, observedAt) {
  if (!baseline?.initialized) return [];
  const events = [];
  for (const [source, objects] of Object.entries(sources || {})) {
    const previousObjects = baseline.sources?.[source];
    // A source returning after a permission/network gap is a new baseline, not
    // evidence that every object was just created.
    if (!previousObjects) continue;
    for (const [key, current] of Object.entries(objects || {})) {
      const previous = previousObjects[key];
      events.push(...(previous
        ? reduceTimelineEvents(previous, current, { observedAt })
        : current?.kind === 'Event'
          ? reduceTimelineEvents(null, current, { observedAt })
          : reduceTimelineLifecycle(null, current, { observedAt })));
    }
    for (const [key, previous] of Object.entries(previousObjects)) {
      if (!Object.hasOwn(objects || {}, key)) {
        events.push(...reduceTimelineLifecycle(previous, null, { observedAt }));
      }
    }
  }
  return events;
}

async function appendEvents(store, key, events) {
  for (let offset = 0; offset < events.length; offset += 100) {
    await store.append(key, events.slice(offset, offset + 100));
  }
}

class TargetCollector {
  constructor(manager, target) {
    this.manager = manager;
    this.target = target;
    this.key = targetKey(target);
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.state = 'starting';
    this.message = '';
    this.sources = CORE_SOURCE_DEFS.map(([id]) => ({ id, state: 'pending' }));
    this.lastObservedAt = null;
    this.baseline = emptyState();
  }

  async start() {
    this.stopped = false;
    const restored = await this.manager.store.getState(this.key);
    this.baseline = restoreTimelineBaseline(restored);
    await this.collect();
    this.schedule();
  }

  schedule() {
    if (this.timer || this.stopped || this.manager.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.collect().finally(() => this.schedule());
    }, POLL_MS);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async collect() {
    if (this.running || this.manager.closed) return;
    this.running = true;
    const observedAt = new Date().toISOString();
    try {
      const resolved = resolveAgentRuntimeConfigForSelector(this.manager.runtimeConfig, this.target.connectionSelector);
      const { definitions, results } = await withTimelineCycleDeadline(async (signal) => {
        const coreResults = await Promise.allSettled(CORE_SOURCE_DEFS.map(([, path, apiVersion, kind]) =>
          listSource(resolved, path, apiVersion, kind, signal)));
        const crdIndex = CORE_SOURCE_DEFS.findIndex(([id]) => id === 'customresourcedefinitions');
        const crdResult = coreResults[crdIndex];
        const providerDefinitions = crdResult?.status === 'fulfilled'
          ? selectTimelineProviderSources(crdResult.value)
          : [];
        const providerResults = await Promise.allSettled(providerDefinitions.map(([, path, apiVersion, kind]) =>
          listSource(resolved, path, apiVersion, kind, signal)));
        return { definitions: [...CORE_SOURCE_DEFS, ...providerDefinitions], results: [...coreResults, ...providerResults] };
      });
      const next = { schemaVersion: BASELINE_SCHEMA_VERSION, initialized: true, sources: {}, lastObservedAt: observedAt, gaps: 0 };
      let failures = 0;
      this.sources = definitions.map(([id]) => ({ id, state: 'pending' }));
      results.forEach((result, index) => {
        const [id] = definitions[index];
        if (result.status === 'rejected') {
          failures += 1;
          next.gaps += 1;
          this.sources[index] = { id, state: 'unavailable', message: result.reason instanceof Error ? result.reason.message : 'Source unavailable' };
          return;
        }
        const projected = result.value.map((item) => id.startsWith('events') ? eventProject(item) : project(item)).filter(Boolean);
        next.sources[id] = Object.fromEntries(projected.map((item) => [keyOf(item), item]));
        this.sources[index] = { id, state: 'collecting', lastObservedAt: observedAt };
      });
      if (this.baseline.initialized) {
        const events = reduceTimelineSnapshot(this.baseline, next.sources, observedAt);
        if (events.length) {
          const enriched = await Promise.all(events.map(async (event) => {
            if (event.resource?.kind !== 'Pod' || !LOG_REASONS.test(event.reason || '')) return { ...event, sourceId: 'kubernetes' };
            const release = await this.manager.acquireLogSlot();
            if (!release) return { ...event, sourceId: 'kubernetes' };
            try {
              const logs = await loadLocalPodLogs(resolved, {
                namespace: event.resource.namespace || 'default', name: event.resource.name,
                container: event.after?.container, tail: 100
              });
              const lines = (logs.lines || []).join('\n').slice(0, 64 * 1024).split('\n').slice(-100);
              return { ...event, sourceId: 'kubernetes', logs: [{ container: logs.container, previous: false, lines, capturedAt: observedAt }] };
            } catch (error) {
              return { ...event, sourceId: 'kubernetes', logs: [{ container: event.after?.container, previous: false, message: error instanceof Error ? error.message : 'Logs unavailable', capturedAt: observedAt }] };
            } finally { release(); }
          }));
          await appendEvents(this.manager.store, this.key, enriched);
        }
      }
      await this.manager.store.saveState(this.key, next);
      this.baseline = next;
      this.lastObservedAt = observedAt;
      this.state = failures ? 'partial' : 'collecting';
      this.message = failures ? `${failures} Kubernetes sources were unavailable during the latest poll.` : '';
    } catch (error) {
      const previousMessage = this.message;
      this.state = 'offline';
      this.message = error instanceof Error ? error.message : 'Timeline collection failed.';
      if (this.message !== previousMessage) this.manager.logger.warn(`Timeline collection failed: ${this.message}`);
    } finally {
      this.running = false;
    }
  }

  async status() {
    const stored = await this.manager.store.status(this.key);
    return { id: this.key, state: this.state, message: this.message || undefined, lastObservedAt: this.lastObservedAt || undefined, ...stored };
  }
}

export function createTimelineManager({ runtimeConfig, logger = console } = {}) {
  let storePromise;
  const collectors = new Map();
  let closed = false;
  let activeLogReads = 0;
  const store = { get: () => { storePromise ||= createTimelineStore(); return storePromise; } };
  const manager = {
    runtimeConfig, logger, store: null, closed: false,
    acquireLogSlot() {
      if (activeLogReads >= 2) return null;
      activeLogReads += 1;
      return () => { activeLogReads = Math.max(0, activeLogReads - 1); };
    },
    async applyDesiredConfig(configuration) {
      const targets = configuration?.complete ? configuration.targets || [] : [];
      const wanted = new Map(targets.filter((target) => target.enabled).map((target) => [targetKey(target), target]));
      for (const [key, collector] of collectors) {
        if (!wanted.has(key)) { await collector.stop(); collectors.delete(key); }
      }
      for (const target of wanted.values()) {
        const key = targetKey(target);
        let collector = collectors.get(key);
        if (!collector) {
          collector = new TargetCollector(manager, target);
          collectors.set(key, collector);
          void collector.start().catch((error) => logger.warn(`Timeline collector failed: ${error.message}`));
        } else {
          collector.target = target;
          // Heartbeats also repair a timer lost to a runtime/worker interruption.
          collector.schedule();
        }
        await store.get().then((value) => value.prune(key, { retentionDays: target.retentionDays })).catch((error) => logger.warn(`Timeline retention update failed: ${error.message}`));
      }
    },
    async list(target, query) { return (await store.get()).list(targetKey(target), query); },
    async detail(target, id) { return (await store.get()).detail(targetKey(target), id); },
    async status(target) {
      const key = targetKey(target);
      const collector = collectors.get(key);
      if (!collector) return { state: 'disabled', enabled: false, retentionDays: target.retentionDays || 7, sources: [], message: 'Collection is disabled for this connection.' };
      return {
        state: collector.state,
        enabled: true,
        retentionDays: collector.target.retentionDays || 7,
        revision: collector.target.revision || 0,
        sources: collector.sources,
        ...(await collector.status())
      };
    },
    async close() {
      closed = true; manager.closed = true;
      await Promise.all([...collectors.values()].map((collector) => collector.stop()));
      collectors.clear();
      if (storePromise) await storePromise.then((value) => value.close());
    }
  };
  manager.store = { getState: (...args) => store.get().then((value) => value.getState(...args)), saveState: (...args) => store.get().then((value) => value.saveState(...args)), append: (...args) => store.get().then((value) => value.append(...args)), list: (...args) => store.get().then((value) => value.list(...args)), detail: (...args) => store.get().then((value) => value.detail(...args)), status: (...args) => store.get().then((value) => value.status(...args)), prune: (...args) => store.get().then((value) => value.prune(...args)) };
  return manager;
}
