// Short in-memory CPU/memory history for the Cluster workload charts.
// One sampler per kubeconfig context reads metrics.k8s.io every interval while the history is
// being viewed and stops after an idle period. Nothing is persisted; samples hold totals only.
import { loadLocalMetrics, parseMemoryBytes, parseMetricCpuMilli } from './kube.js';

export const USAGE_HISTORY_INTERVAL_MS = 10_000;
export const USAGE_HISTORY_SAMPLES = 30;
const IDLE_STOP_MS = 30 * 60_000;

function contextKey(runtimeConfig) {
  return `${runtimeConfig.kubeContext || ''}|${runtimeConfig.clusterFingerprint || ''}`;
}

function summarize(metrics, at) {
  let nodeCpu = 0;
  let nodeMemory = 0;
  for (const node of metrics.nodes ?? []) {
    nodeCpu += parseMetricCpuMilli(node.cpu);
    nodeMemory += parseMemoryBytes(node.memory);
  }
  const namespaces = new Map();
  let podCpu = 0;
  let podMemory = 0;
  for (const pod of metrics.pods ?? []) {
    const cpu = parseMetricCpuMilli(pod.cpu);
    const memory = parseMemoryBytes(pod.memory);
    const entry = namespaces.get(pod.namespace) ?? { cpuMilli: 0, memoryBytes: 0 };
    entry.cpuMilli += cpu;
    entry.memoryBytes += memory;
    namespaces.set(pod.namespace, entry);
    podCpu += cpu;
    podMemory += memory;
  }
  const hasNodes = (metrics.nodes ?? []).length > 0;
  return { at, cluster: hasNodes ? { cpuMilli: nodeCpu, memoryBytes: nodeMemory } : { cpuMilli: podCpu, memoryBytes: podMemory }, namespaces };
}

/**
 * @typedef {{ at: string; cpuMilli: number; memoryBytes: number }} UsageSample
 * @typedef {{ scope: 'cluster' | 'namespace'; namespace: string | null; intervalSeconds: number; samples: UsageSample[] }} UsageHistory
 * @param {{
 *   load?: (runtimeConfig: any, namespaceScope: string) => Promise<any>;
 *   intervalMs?: number;
 *   maxSamples?: number;
 *   idleStopMs?: number;
 *   now?: () => number;
 *   setTimer?: (callback: () => void, ms: number) => any;
 *   clearTimer?: (timer: any) => void;
 * }} [options]
 * @returns {{ read(runtimeConfig: any, namespaceScope?: string | null): Promise<UsageHistory>; close(): void }}
 */
export function createUsageHistory({
  load = loadLocalMetrics,
  intervalMs = USAGE_HISTORY_INTERVAL_MS,
  maxSamples = USAGE_HISTORY_SAMPLES,
  idleStopMs = IDLE_STOP_MS,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval
} = {}) {
  const samplers = new Map();

  function stop(key) {
    const sampler = samplers.get(key);
    if (!sampler) return;
    clearTimer(sampler.timer);
    samplers.delete(key);
  }

  async function sample(key, sampler) {
    if (sampler.inFlight) return;
    if (now() - sampler.lastViewedAt > idleStopMs) {
      stop(key);
      return;
    }
    sampler.inFlight = true;
    try {
      const metrics = await load(sampler.runtimeConfig, 'all');
      if (metrics?.available) {
        sampler.samples.push(summarize(metrics, now()));
        if (sampler.samples.length > maxSamples) sampler.samples.splice(0, sampler.samples.length - maxSamples);
      }
    } catch {
      // A missed sample leaves a gap; the next tick tries again.
    } finally {
      sampler.inFlight = false;
    }
  }

  function ensure(runtimeConfig) {
    const key = contextKey(runtimeConfig);
    let sampler = samplers.get(key);
    if (!sampler) {
      sampler = { runtimeConfig, samples: [], lastViewedAt: now(), inFlight: false, timer: null, first: null };
      samplers.set(key, sampler);
      sampler.first = sample(key, sampler);
      sampler.timer = setTimer(() => void sample(key, sampler), intervalMs);
      sampler.timer?.unref?.();
    }
    sampler.lastViewedAt = now();
    return sampler;
  }

  return {
    /** Returns the retained samples for the cluster ("all") or one namespace and keeps sampling for this context. */
    async read(runtimeConfig, namespaceScope) {
      const sampler = ensure(runtimeConfig);
      if (sampler.samples.length === 0 && sampler.first) await sampler.first;
      const namespace = namespaceScope && namespaceScope !== 'all' ? namespaceScope : null;
      return {
        scope: namespace ? 'namespace' : 'cluster',
        namespace,
        intervalSeconds: Math.round(intervalMs / 1000),
        samples: sampler.samples.map((entry) => {
          const usage = namespace ? entry.namespaces.get(namespace) ?? { cpuMilli: 0, memoryBytes: 0 } : entry.cluster;
          return { at: new Date(entry.at).toISOString(), cpuMilli: Math.round(usage.cpuMilli), memoryBytes: Math.round(usage.memoryBytes) };
        })
      };
    },
    close() {
      for (const key of [...samplers.keys()]) stop(key);
    }
  };
}
