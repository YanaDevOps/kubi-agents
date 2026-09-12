import { createHash } from 'node:crypto';
import { createTimelineStore } from './store.js';
import { reduceTimelineEvents, reduceTimelineObject } from './events.js';
import { fetchKubeList, loadLocalKubeConfig, loadLocalPodLogs, resolveAgentRuntimeConfigForSelector } from '../kube.js';
import { DELIVERY_RESOURCE_DEFINITIONS } from '../../../src/shared/delivery-activity.js';
import { BACKUP_RESOURCE_DEFINITIONS } from '../../../src/shared/backup-activity.js';

const POLL_MS = 15_000;
const MAX_ITEMS = 2_000;
const CORE_SOURCE_DEFS = [
  ['pods', '/api/v1/pods'],
  ['nodes', '/api/v1/nodes'],
  ['deployments', '/apis/apps/v1/deployments'],
  ['statefulsets', '/apis/apps/v1/statefulsets'],
  ['daemonsets', '/apis/apps/v1/daemonsets'],
  ['services', '/api/v1/services'],
  ['persistentvolumes', '/api/v1/persistentvolumes'],
  ['persistentvolumeclaims', '/api/v1/persistentvolumeclaims'],
  ['events', '/api/v1/events'],
  ['events.k8s.io', '/apis/events.k8s.io/v1/events']
];

const PROVIDER_SOURCE_DEFS = [...DELIVERY_RESOURCE_DEFINITIONS, ...BACKUP_RESOURCE_DEFINITIONS]
  .map((definition) => [
    `${definition.providerId}:${definition.resource}`,
    `/apis/${definition.group}/${definition.versions[0]}/${definition.resource}`
  ])
  .filter(([, path], index, entries) => entries.findIndex(([, candidate]) => candidate === path) === index);
const SOURCE_DEFS = [...CORE_SOURCE_DEFS, ...PROVIDER_SOURCE_DEFS];
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

async function listSource(runtimeConfig, path) {
  const kubeConfig = runtimeConfig.__kubeConfig || runtimeConfig.kubeConfig || loadLocalKubeConfig(runtimeConfig);
  const result = await fetchKubeList(kubeConfig, path, true, { pageLimit: 500, maxPages: 4 });
  return (result?.items || []).slice(0, MAX_ITEMS);
}

function emptyState() {
  return { initialized: false, sources: {}, lastObservedAt: null, gaps: 0 };
}

class TargetCollector {
  constructor(manager, target) {
    this.manager = manager;
    this.target = target;
    this.key = targetKey(target);
    this.timer = null;
    this.running = false;
    this.state = 'starting';
    this.message = '';
    this.sources = SOURCE_DEFS.map(([id]) => ({ id, state: 'pending' }));
    this.lastObservedAt = null;
    this.baseline = emptyState();
  }

  async start() {
    this.baseline = (await this.manager.store.getState(this.key)) || emptyState();
    await this.collect();
    this.timer = setInterval(() => void this.collect(), POLL_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collect() {
    if (this.running || this.manager.closed) return;
    this.running = true;
    const observedAt = new Date().toISOString();
    try {
      const resolved = resolveAgentRuntimeConfigForSelector(this.manager.runtimeConfig, this.target.connectionSelector);
      const results = await Promise.allSettled(SOURCE_DEFS.map(([, path]) => listSource(resolved, path)));
      const next = { initialized: true, sources: {}, lastObservedAt: observedAt, gaps: 0 };
      let failures = 0;
      results.forEach((result, index) => {
        const [id] = SOURCE_DEFS[index];
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
        const events = [];
        for (const [source, objects] of Object.entries(next.sources)) {
          for (const [key, current] of Object.entries(objects)) {
            const previous = this.baseline.sources?.[source]?.[key];
            if (!previous) continue;
            events.push(...reduceTimelineEvents(previous, current, { observedAt }));
          }
        }
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
          await this.manager.store.append(this.key, enriched);
        }
      }
      await this.manager.store.saveState(this.key, next);
      this.baseline = next;
      this.lastObservedAt = observedAt;
      this.state = failures ? 'partial' : 'collecting';
      this.message = failures ? `${failures} Kubernetes sources were unavailable during the latest poll.` : '';
    } catch (error) {
      this.state = 'offline';
      this.message = error instanceof Error ? error.message : 'Timeline collection failed.';
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
    runtimeConfig, store: null, closed: false,
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
      return { state: collector.state, enabled: true, retentionDays: target.retentionDays || 7, sources: collector.sources, ...(await collector.status()) };
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
