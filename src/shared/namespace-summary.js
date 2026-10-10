// Per-namespace summary for the Namespaces page: health, usage, owners, resource counts and guardrails.
// Counted kinds are listed as PartialObjectMetadata, so Secret and ConfigMap values never leave the API server.

export const METADATA_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';

const COUNTED = [
  ['Deployment', '/apis/apps/v1/deployments'],
  ['StatefulSet', '/apis/apps/v1/statefulsets'],
  ['DaemonSet', '/apis/apps/v1/daemonsets'],
  ['CronJob', '/apis/batch/v1/cronjobs'],
  ['Service', '/api/v1/services'],
  ['Ingress', '/apis/networking.k8s.io/v1/ingresses'],
  ['ConfigMap', '/api/v1/configmaps'],
  ['Secret', '/api/v1/secrets'],
  ['NetworkPolicy', '/apis/networking.k8s.io/v1/networkpolicies'],
  ['ResourceQuota', '/api/v1/resourcequotas'],
  ['LimitRange', '/api/v1/limitranges']
];
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];
const SYSTEM_NAMESPACES = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);
const DAY_MS = 86_400_000;

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');

function parseCpuMilli(value) {
  const raw = text(value);
  if (!raw) return 0;
  if (raw.endsWith('n')) return Number(raw.slice(0, -1)) / 1e6 || 0;
  if (raw.endsWith('u')) return Number(raw.slice(0, -1)) / 1e3 || 0;
  if (raw.endsWith('m')) return Number(raw.slice(0, -1)) || 0;
  return (Number(raw) || 0) * 1000;
}

function parseBytes(value) {
  const match = /^(\d+(?:\.\d+)?)([KMGTE]i?)?$/.exec(text(value));
  if (!match) return 0;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(match[1]) * (match[2] ? units[match[2]] ?? 1 : 1);
}

async function listAll(request, path, accept, sources, id, optional = false) {
  const items = [];
  let cont = '';
  try {
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '500', ...(cont ? { continue: cont } : {}) });
      const payload = record(await request(`${path}?${query}`, accept ? { accept } : undefined));
      items.push(...list(payload.items));
      cont = text(record(payload.metadata).continue);
      if (!cont) break;
    }
    sources.push({ id, status: cont ? 'partial' : 'available', count: items.length });
  } catch (error) {
    const status = Number(error?.status) || Number(/HTTP (\d{3})/.exec(String(error?.message))?.[1]);
    sources.push({ id, status: status === 404 && optional ? 'absent' : status === 403 ? 'denied' : 'error', count: 0 });
  }
  return items;
}

/** Owning tool for a namespace, from the labels of its workloads (Argo CD, Flux, Helm) or the distribution for system namespaces. */
export function namespaceManager(name, objects, distribution) {
  for (const object of objects) {
    const meta = record(object.metadata);
    const labels = record(meta.labels);
    const annotations = record(meta.annotations);
    const argo = text(labels['argocd.argoproj.io/instance']) || text(annotations['argocd.argoproj.io/tracking-id']).split(':')[0];
    if (argo) return { tool: 'Argo CD', name: argo };
    const flux = text(labels['kustomize.toolkit.fluxcd.io/name']) || text(labels['helm.toolkit.fluxcd.io/name']);
    if (flux) return { tool: 'Flux', name: flux };
  }
  for (const object of objects) {
    const labels = record(record(object.metadata).labels);
    if (text(labels['app.kubernetes.io/managed-by']) === 'Helm' || labels['helm.sh/chart']) {
      return { tool: 'Helm', name: text(labels['helm.sh/chart']) || text(labels['app.kubernetes.io/instance']) || undefined };
    }
  }
  if (SYSTEM_NAMESPACES.has(name)) return { tool: distribution };
  return undefined;
}

/** Distribution name shown for system namespaces, read from node metadata only. */
export function clusterDistribution(nodes) {
  const meta = nodes.map((node) => JSON.stringify({ labels: record(record(node.metadata).labels), annotations: record(record(node.metadata).annotations) })).join(' ');
  if (/k3s\.io\//.test(meta)) return 'k3s';
  if (/rke2\.io\//.test(meta)) return 'RKE2';
  if (/eks\.amazonaws\.com\//.test(meta)) return 'EKS';
  if (/cloud\.google\.com\/gke-/.test(meta)) return 'GKE';
  if (/kubernetes\.azure\.com\//.test(meta)) return 'AKS';
  return 'Kubernetes';
}

function podHealth(pod, now) {
  const status = record(pod.status);
  const phase = text(status.phase) || 'Unknown';
  const statuses = list(status.containerStatuses);
  const restarts = statuses.reduce((sum, entry) => sum + (Number(record(entry).restartCount) || 0), 0);
  const recent = statuses.some((entry) => {
    const finished = Date.parse(text(record(record(record(entry).lastState).terminated).finishedAt));
    return Number.isFinite(finished) && now - finished < DAY_MS;
  });
  const ownedByJob = list(record(pod.metadata).ownerReferences).some((owner) => record(owner).kind === 'Job');
  const waiting = statuses.map((entry) => text(record(record(record(entry).state).waiting).reason)).find(Boolean);
  const running = phase === 'Running' && !waiting;
  const finishedJob = phase === 'Succeeded' && ownedByJob;
  return { running, finishedJob, problem: running || finishedJob ? '' : waiting || (phase === 'Succeeded' ? 'Completed' : phase), restarts, restarts24h: recent ? restarts : 0 };
}

export async function collectNamespaceSummary({ request, now = Date.now() } = {}) {
  if (typeof request !== 'function') throw new TypeError('A customer-side request function is required.');
  const sources = [];
  const [namespaces, pods, nodes, podMetrics, ...counted] = await Promise.all([
    listAll(request, '/api/v1/namespaces', null, sources, 'namespaces'),
    listAll(request, '/api/v1/pods', null, sources, 'pods'),
    listAll(request, '/api/v1/nodes', METADATA_ACCEPT, sources, 'nodes'),
    listAll(request, '/apis/metrics.k8s.io/v1beta1/pods', null, sources, 'pod-metrics', true),
    ...COUNTED.map(([kind, path]) => listAll(request, path, METADATA_ACCEPT, sources, kind, true))
  ]);
  const distribution = clusterDistribution(nodes);
  const byNamespace = new Map(
    namespaces.map((ns) => {
      const meta = record(ns.metadata);
      return [text(meta.name), {
        name: text(meta.name), status: text(record(ns.status).phase) || 'Active', createdAt: text(meta.creationTimestamp), labels: record(meta.labels),
        pods: { total: 0, running: 0, notRunning: 0, restarts: 0, restarts24h: 0, problem: '' },
        usage: { cpuMilli: 0, memoryBytes: 0 }, counts: {}, workloads: 0, managedBy: undefined, managed: []
      }];
    })
  );
  for (const pod of pods) {
    const entry = byNamespace.get(text(record(pod.metadata).namespace));
    if (!entry) continue;
    const health = podHealth(pod, now);
    entry.pods.total += 1;
    entry.pods.running += Number(health.running);
    if (health.problem) {
      entry.pods.notRunning += 1;
      entry.pods.problem ||= health.problem;
    }
    entry.pods.restarts += health.restarts;
    entry.pods.restarts24h += health.restarts24h;
  }
  for (const metric of podMetrics) {
    const entry = byNamespace.get(text(record(metric.metadata).namespace));
    if (!entry) continue;
    for (const container of list(metric.containers)) {
      entry.usage.cpuMilli += parseCpuMilli(record(record(container).usage).cpu);
      entry.usage.memoryBytes += parseBytes(record(record(container).usage).memory);
    }
  }
  COUNTED.forEach(([kind], index) => {
    for (const object of counted[index]) {
      const entry = byNamespace.get(text(record(object.metadata).namespace));
      if (!entry) continue;
      entry.counts[kind] = (entry.counts[kind] || 0) + 1;
      if (WORKLOAD_KINDS.includes(kind)) {
        entry.workloads += 1;
        entry.managed.push(object);
      }
    }
  });
  const items = [...byNamespace.values()].map(({ managed, ...entry }) => ({ ...entry, managedBy: namespaceManager(entry.name, managed, distribution) }));
  return {
    schemaVersion: 1,
    fetchedAt: new Date(now).toISOString(),
    metricsAvailable: sources.some((source) => source.id === 'pod-metrics' && source.status === 'available'),
    sources,
    items
  };
}
