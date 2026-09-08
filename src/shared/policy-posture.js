import { analyzeWorkloadPosture } from './policy-posture-workload.js';
import { analyzeNetworkPosture } from './policy-posture-network.js';
import { analyzeAdmissionPosture } from './policy-posture-admission.js';

// Discover served APIs rather than assuming a particular controller/API version.
const POLICY_KINDS = {
  'admissionregistration.k8s.io': new Set(['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'MutatingAdmissionPolicy', 'MutatingAdmissionPolicyBinding', 'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration']),
  'kyverno.io': new Set(['Policy', 'ClusterPolicy', 'PolicyException']),
  'policies.kyverno.io': new Set(['ValidatingPolicy', 'NamespacedValidatingPolicy', 'MutatingPolicy', 'NamespacedMutatingPolicy', 'GeneratingPolicy', 'NamespacedGeneratingPolicy', 'DeletingPolicy', 'NamespacedDeletingPolicy', 'ImageValidatingPolicy', 'NamespacedImageValidatingPolicy', 'PolicyException']),
  'templates.gatekeeper.sh': new Set(['ConstraintTemplate']),
  'constraints.gatekeeper.sh': null,
  'policies.kubewarden.io': new Set(['AdmissionPolicy', 'ClusterAdmissionPolicy', 'AdmissionPolicyGroup', 'ClusterAdmissionPolicyGroup', 'PolicyServer']),
  'wgpolicyk8s.io': new Set(['PolicyReport', 'ClusterPolicyReport']),
  'openreports.io': new Set(['Report', 'ClusterReport'])
};
const MAX_PAGES = 10;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCES = 80;
const CONCURRENCY = 4;
const COLLECTION_TIMEOUT_MS = 20_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_VERSIONS = 8;
const MAX_NETWORK_COMPARISONS = 250_000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_SCOPES = 8;
const collectionCache = new WeakMap();
const encoder = new TextEncoder();
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = (value) => encoder.encode(JSON.stringify(value)).byteLength;

function boundOutput(summary) {
  const fields = ['findings', 'policies', 'providers', 'workloads', 'networkPolicies', 'imageTrust', 'sources'];
  const perListBudget = Math.floor((MAX_OUTPUT_BYTES - 128 * 1024) / fields.length);
  const counts = {};
  const findingsBySeverity = {};
  for (const finding of summary.findings) {
    const severity = typeof finding.severity === 'string' ? finding.severity : 'unknown';
    findingsBySeverity[severity] = (findingsBySeverity[severity] || 0) + 1;
  }
  let truncated = false;
  for (const field of fields) {
    const input = summary[field];
    const output = [];
    let bytes = 2;
    for (const item of input) {
      const size = byteLength(item) + 1;
      if (bytes + size <= perListBudget) {
        output.push(item);
        bytes += size;
      }
    }
    counts[field] = { total: input.length, returned: output.length, omitted: input.length - output.length };
    truncated ||= output.length !== input.length;
    summary[field] = output;
  }
  if (byteLength(summary.coverage) > 64 * 1024) {
    summary.coverage = { partial: true, message: 'Coverage details omitted to keep the response bounded.' };
    truncated = true;
  }
  summary.coverage.collection = { outputLimitBytes: MAX_OUTPUT_BYTES, truncated, counts, findingsBySeverity };
  if (truncated) {
    summary.partial = true;
    summary.sources.push({ id: 'output-limit', status: 'error', partial: true,
      message: 'Response details were omitted to stay below 2 MiB. See coverage.collection.counts; omitted findings are not successful checks.' });
  }
  return summary;
}

// Cache only sanitized summaries, isolated by credential-bound transport identity and scope.
export async function collectPolicyPosture({ request, namespace = null, forceRefresh = false }) {
  if (typeof request !== 'function') throw new TypeError('A customer-side request function is required.');
  const scope = namespace && namespace !== 'all' ? namespace : null;
  if (scope !== null && (typeof scope !== 'string' || scope.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(scope))) {
    throw new TypeError('Invalid Kubernetes namespace.');
  }
  let cache = collectionCache.get(request);
  if (!cache) {
    cache = new Map();
    collectionCache.set(request, cache);
  }
  const existing = cache.get(scope);
  // Refresh bypasses settled data, never duplicates a currently running collection.
  if (existing?.inflight) return JSON.parse(await existing.inflight);
  if (!forceRefresh && existing?.json && existing.expiresAt > Date.now()) return JSON.parse(existing.json);
  if (!existing && cache.size >= MAX_CACHED_SCOPES) {
    const evictable = [...cache].find(([, entry]) => !entry.inflight);
    if (!evictable) throw new Error('Too many policy posture namespace collections are already running.');
    cache.delete(evictable[0]);
  }
  const entry = { inflight: null, json: null, expiresAt: 0 };
  cache.set(scope, entry);
  entry.inflight = collectInventory(request, scope).then((summary) => {
    entry.json = JSON.stringify(boundOutput(summary));
    entry.expiresAt = Date.now() + CACHE_TTL_MS;
    return entry.json;
  });
  try {
    return JSON.parse(await entry.inflight);
  } catch (error) {
    cache.delete(scope);
    throw error;
  } finally {
    entry.inflight = null;
  }
}

function failureStatus(error) {
  const status = Number(error?.status || error?.statusCode || String(error?.message || '').match(/(?:HTTP|status)\s*(\d{3})/i)?.[1]);
  return status === 403 || status === 401 ? 'denied' : status === 404 ? 'absent' : 'error';
}

async function mapBounded(items, operation) {
  let cursor = 0;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await operation(items[index]);
    }
  }));
  return output;
}

function pathFor(groupVersion, resource, namespace) {
  const root = groupVersion === 'v1' ? '/api/v1' : `/apis/${groupVersion}`;
  return `${root}${resource.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''}/${resource.name}`;
}

async function collectInventory(request, scope) {
  const sources = [];
  let budget = MAX_BYTES;
  const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const pending = new Set();
  const boundedRequest = async (path) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Collection timed out');
    if (pending.size >= CONCURRENCY) throw new Error('Transport has not released timed-out requests.');
    const controller = new AbortController();
    pending.add(controller);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => request(path, {
          signal: controller.signal,
          maxBytes: Math.min(MAX_READ_BYTES, budget)
        })).finally(() => pending.delete(controller)),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = new Error('Collection timed out');
          controller.abort(error);
          reject(error);
        }, Math.min(5_000, remaining)); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const read = async (id, path, kind, apiVersion, list = true) => {
    const items = [];
    let continuation = '';
    try {
      for (let page = 0; page < (list ? MAX_PAGES : 1); page++) {
        if (budget <= 0) throw new Error('Collection budget reached');
        const query = new URLSearchParams({ limit: '250', ...(continuation ? { continue: continuation } : {}) });
        const payload = await boundedRequest(list ? `${path}?${query}` : path);
        const size = byteLength(payload);
        budget -= size;
        if (size > MAX_READ_BYTES) throw new Error('Per-read collection budget reached');
        if (budget < 0) throw new Error('Collection budget reached');
        if (!record(payload) || (list && !Array.isArray(payload.items))) throw new Error('Invalid API response');
        if (!list) {
          sources.push({ id, status: 'available' });
          return payload;
        }
        if (payload.items.some((item) => !record(item))) throw new Error('Invalid API list item');
        items.push(...payload.items.slice(0, 250).map((item) => ({ ...item, kind, apiVersion })));
        if (payload.items.length > 250) throw new Error('API page exceeded its requested object limit');
        continuation = payload.metadata?.continue ?? '';
        if (typeof continuation !== 'string') throw new Error('Invalid pagination token');
        if (!continuation) break;
      }
      sources.push({ id, status: 'available', count: items.length, ...(continuation ? { partial: true, message: 'Collection limit reached; coverage is incomplete.' } : {}) });
    } catch (error) {
      const status = failureStatus(error);
      sources.push({ id, status, count: items.length, partial: true, message: status === 'denied' ? 'Kubernetes permission denied.' : status === 'absent' ? 'Requested API is unavailable; coverage is incomplete.' : 'This source could not be fully read. Retry to refresh coverage.' });
    }
    return list ? items : null;
  };
  const definitions = [
    ['pods', 'v1', 'pods', 'Pod', true],
    ['namespaces', 'v1', 'namespaces', 'Namespace', false],
    ['networkpolicies', 'networking.k8s.io/v1', 'networkpolicies', 'NetworkPolicy', true],
    ['deployments', 'apps/v1', 'deployments', 'Deployment', true],
    ['statefulsets', 'apps/v1', 'statefulsets', 'StatefulSet', true],
    ['daemonsets', 'apps/v1', 'daemonsets', 'DaemonSet', true],
    ['replicasets', 'apps/v1', 'replicasets', 'ReplicaSet', true],
    ['jobs', 'batch/v1', 'jobs', 'Job', true],
    ['cronjobs', 'batch/v1', 'cronjobs', 'CronJob', true]
  ];
  const inventory = await mapBounded(definitions, ([id, version, name, kind, namespaced]) => read(id, pathFor(version, { name, namespaced }, scope), kind, version));
  const [pods, allNamespaces, networkPolicies, ...workloadLists] = inventory;
  const namespaces = scope ? allNamespaces.filter((item) => item.metadata?.name === scope) : allNamespaces;
  const version = await read('version', '/version', '', '', false);
  const apiGroups = await read('api-discovery', '/apis', '', '', false);
  const invalidDiscovery = (id) => {
    const source = sources.find((entry) => entry.id === id);
    if (source) Object.assign(source, { status: 'error', partial: true, message: 'API discovery was malformed or exceeded its collection limit; coverage is incomplete.' });
  };
  if (apiGroups && !Array.isArray(apiGroups.groups)) invalidDiscovery('api-discovery');
  const groups = [];
  for (const group of Array.isArray(apiGroups?.groups) ? apiGroups.groups : []) {
    if (!record(group) || typeof group.name !== 'string') { invalidDiscovery('api-discovery'); continue; }
    if (Object.hasOwn(POLICY_KINDS, group.name) && !groups.some((entry) => entry.name === group.name)) groups.push(group);
  }
  const served = await mapBounded(groups, async (group) => {
    if (!Array.isArray(group.versions)) invalidDiscovery('api-discovery');
    const versions = [group.preferredVersion, ...(Array.isArray(group.versions) ? group.versions : [])].filter((entry) => entry !== undefined);
    const validVersions = versions.filter((entry) => {
      const valid = record(entry) && typeof entry.groupVersion === 'string'
        && entry.groupVersion.startsWith(`${group.name}/`)
        && /^[a-z][a-z0-9]{0,31}$/.test(entry.groupVersion.slice(group.name.length + 1));
      if (!valid) invalidDiscovery('api-discovery');
      return valid;
    });
    const uniqueVersions = [...new Map(validVersions.map((entry) => [entry.groupVersion, entry])).values()];
    if (!uniqueVersions.length || uniqueVersions.length > MAX_VERSIONS) invalidDiscovery('api-discovery');
    const chosen = new Map();
    for (const entry of uniqueVersions.slice(0, MAX_VERSIONS)) {
      const id = `discovery:${entry.groupVersion}`;
      const api = await read(id, `/apis/${entry.groupVersion}`, '', '', false);
      if (api && !Array.isArray(api.resources)) invalidDiscovery(id);
      for (const resource of Array.isArray(api?.resources) ? api.resources : []) {
        if (!record(resource) || typeof resource.name !== 'string') { invalidDiscovery(id); continue; }
        if (resource.name.includes('/')) continue;
        if (!/^[a-z][a-z0-9-]{0,252}$/.test(resource.name) || typeof resource.kind !== 'string'
          || !/^[A-Za-z][A-Za-z0-9]{0,252}$/.test(resource.kind) || typeof resource.namespaced !== 'boolean'
          || !Array.isArray(resource.verbs) || resource.verbs.some((verb) => typeof verb !== 'string')) {
          invalidDiscovery(id); continue;
        }
        if (!resource.verbs.includes('list') || (POLICY_KINDS[group.name] && !POLICY_KINDS[group.name].has(resource.kind))) continue;
        if (!chosen.has(resource.kind)) chosen.set(resource.kind, { ...resource, groupVersion: entry.groupVersion });
      }
    }
    return [...chosen.values()];
  });
  const descriptors = served.flat();
  if (descriptors.length > MAX_RESOURCES) sources.push({ id: 'policy-api-limit', status: 'error', partial: true, message: 'Policy API collection limit reached.' });
  const resources = (await mapBounded(descriptors.slice(0, MAX_RESOURCES), (resource) => read(
    `${resource.groupVersion}/${resource.name}`,
    pathFor(resource.groupVersion, resource, scope), resource.kind, resource.groupVersion
  ))).flat();
  for (const controller of pending) controller.abort(new Error('Collection finished.'));
  const workloads = workloadLists.flat();
  const complete = (id) => sources.some((source) => source.id === id && source.status === 'available' && !source.partial);
  const workload = analyzeWorkloadPosture({ pods, workloads, namespaces, kubernetesVersion: version?.gitVersion });
  const workloadAnalysisPartial = Boolean(workload.coverage.partial || workload.coverage.versionAssumed);
  if (workloadAnalysisPartial) sources.push({ id: 'workload-analysis', status: 'available', partial: true,
    message: 'Workload analysis is incomplete; check version assumptions and namespace policy details in workload coverage.' });
  // Dense selectors can otherwise materialize millions of repeated policy/pod references.
  const networkPolicyLimit = Math.max(1, Math.floor(MAX_NETWORK_COMPARISONS / Math.max(1, pods.length)));
  const analyzedNetworkPolicies = networkPolicies.slice(0, networkPolicyLimit);
  const networkLimited = analyzedNetworkPolicies.length < networkPolicies.length;
  if (networkLimited) sources.push({ id: 'network-analysis-limit', status: 'error', partial: true,
    count: analyzedNetworkPolicies.length,
    message: `Analyzed ${analyzedNetworkPolicies.length} of ${networkPolicies.length} NetworkPolicies to bound selector comparisons; coverage is incomplete.` });
  const network = analyzeNetworkPosture({ pods, namespaces, networkPolicies: analyzedNetworkPolicies });
  const admission = analyzeAdmissionPosture({ resources, pods, namespaces, workloads,
    inventoryComplete: Object.fromEntries(definitions.filter(([id]) => id !== 'networkpolicies').map(([id, , , kind]) => [kind, complete(id)])),
    namespaceScope: scope || 'all'
  });
  const partial = sources.some((source) => source.status === 'denied' || source.status === 'error' || source.partial);
  // Absence findings are only valid when their source inventory is complete.
  const networkFindings = network.findings.filter((finding) => {
    if (finding.id.startsWith('network:missing-coverage:')) return complete('pods') && complete('networkpolicies') && !networkLimited;
    if (finding.id.startsWith('network:unmatched-selector:')) return complete('pods');
    return true;
  });
  const findings = [...workload.findings, ...networkFindings, ...admission.findings]
    .filter((item) => !scope || !item.resource?.namespace || item.resource.namespace === scope);
  const providerGroups = {
    'kyverno.io': ['kyverno', 'Kyverno'],
    'policies.kyverno.io': ['kyverno', 'Kyverno'],
    'templates.gatekeeper.sh': ['gatekeeper', 'OPA Gatekeeper'],
    'constraints.gatekeeper.sh': ['gatekeeper', 'OPA Gatekeeper'],
    'policies.kubewarden.io': ['kubewarden', 'Kubewarden']
  };
  const providers = new Map(admission.providers.map((provider) => [provider.id, provider]));
  for (const group of groups) {
    const identity = providerGroups[group.name];
    if (identity && !providers.has(identity[0])) providers.set(identity[0], {
      id: identity[0], name: identity[1], itemCount: 0,
      status: 'configured', summary: 'Policy API advertised. Controller health and policy evaluation are not established by API discovery.'
    });
  }
  const tab = (available, reason) => ({ available, ...(!available ? { reason } : {}) });
  const failedReason = 'The required source is unreadable or unavailable. Check agent permissions and retry.';
  return {
    fetchedAt: new Date().toISOString(), namespace: scope || 'all', partial,
    sources, findings: [...new Map(findings.map((item) => [item.id, item])).values()],
    policies: admission.items, providers: [...providers.values()], imageTrust: admission.imageTrust,
    workloads: workload.items, networkPolicies: network.items,
    coverage: {
      workload: { ...workload.coverage, partial: workloadAnalysisPartial || !complete('pods') || !complete('namespaces') || definitions.slice(3).some(([id]) => !complete(id)) },
      network: { ...network.coverage, partial: networkLimited || !complete('pods') || !complete('networkpolicies') || !complete('namespaces'),
        analyzedPolicies: analyzedNetworkPolicies.length, omittedPolicies: networkPolicies.length - analyzedNetworkPolicies.length }
    },
    tabs: {
      workload: tab(complete('pods') || workloads.length > 0, failedReason),
      // A bounded analysis is still useful. Keep the tab available and expose the
      // omitted count through coverage instead of hiding the partial result.
      network: tab(complete('pods') && complete('networkpolicies'), failedReason),
      admission: tab(admission.items.length > 0, partial ? failedReason : 'No supported admission policies were found in the accessible scope.'),
      'image-trust': tab(admission.imageTrust.length > 0, partial ? failedReason : 'No supported image verification policies or results were found. Images have not been evaluated.')
    }
  };
}
