import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {
  loadLocalPrometheusSnapshot,
  resolveAgentRuntimeConfigForSelector,
  scanLocalAccessDiscovery
} from './kube.js';

const metricDefinitions = [
  ['kubi_agent_info', 'Static information about the running KUBI agent.', 'gauge'],
  ['kubi_agent_relay_connected', 'Whether the hosted relay is currently connected.', 'gauge'],
  ['kubi_agent_discovered_contexts', 'Number of unambiguous Kubernetes contexts discovered by the agent.', 'gauge'],
  ['kubi_agent_discovery_sources', 'Number of kubeconfig sources scanned by the agent.', 'gauge'],
  ['kubi_agent_discovery_last_success_timestamp_seconds', 'Unix timestamp of the last successful discovery sync.', 'gauge'],
  ['kubi_agent_heartbeat_last_success_timestamp_seconds', 'Unix timestamp of the last successful control-plane heartbeat.', 'gauge'],
  ['kubi_agent_errors_total', 'Agent errors grouped by bounded operation name.', 'counter'],
  ['kubi_agent_metrics_collection_duration_seconds', 'Duration of the most recent Prometheus collection.', 'gauge'],
  ['kubi_agent_metrics_last_collection_success_timestamp_seconds', 'Unix timestamp of the last collection with at least one reachable context.', 'gauge'],
  ['kubi_cluster_up', 'Whether the Kubernetes API was reachable for this context during the last collection.', 'gauge'],
  ['kubi_cluster_health', 'One-hot aggregate cluster health state.', 'gauge'],
  ['kubi_cluster_namespaces', 'Number of namespaces in the context.', 'gauge'],
  ['kubi_cluster_nodes', 'Number of Kubernetes nodes by readiness state.', 'gauge'],
  ['kubi_cluster_node_pressure', 'Number of nodes reporting each current pressure condition.', 'gauge'],
  ['kubi_cluster_workloads', 'Number of workloads by controller kind.', 'gauge'],
  ['kubi_cluster_unavailable_workloads', 'Number of workloads whose desired replicas exceed ready replicas.', 'gauge'],
  ['kubi_cluster_pods', 'Number of pods by current phase.', 'gauge'],
  ['kubi_cluster_active_pods', 'Number of non-completed pods by readiness state.', 'gauge'],
  ['kubi_cluster_crashloop_pods', 'Number of pods currently in CrashLoopBackOff.', 'gauge'],
  ['kubi_cluster_failed_jobs', 'Number of Jobs currently reporting Failed.', 'gauge'],
  ['kubi_cluster_services_without_ready_endpoints', 'Number of selector-based Services without ready endpoints.', 'gauge'],
  ['kubi_cluster_metrics_api_available', 'Whether metrics.k8s.io was available during the last collection.', 'gauge'],
  ['kubi_cluster_node_cpu_usage_cores', 'Aggregate node CPU usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_cluster_node_memory_usage_bytes', 'Aggregate node memory usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_cluster_pod_cpu_usage_cores', 'Aggregate pod CPU usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_cluster_pod_memory_usage_bytes', 'Aggregate pod memory usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_node_ready', 'Whether an individual Kubernetes node is Ready.', 'gauge'],
  ['kubi_node_pressure', 'Whether an individual node reports a current pressure condition.', 'gauge'],
  ['kubi_node_cpu_usage_cores', 'Node CPU usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_node_cpu_allocatable_cores', 'Allocatable CPU capacity for an individual node.', 'gauge'],
  ['kubi_node_memory_usage_bytes', 'Node memory usage reported by metrics.k8s.io.', 'gauge'],
  ['kubi_node_memory_allocatable_bytes', 'Allocatable memory capacity for an individual node.', 'gauge'],
  ['kubi_namespace_pods', 'Number of Pods in a namespace by current phase.', 'gauge'],
  ['kubi_namespace_active_pods', 'Number of non-completed Pods in a namespace by readiness state.', 'gauge'],
  ['kubi_namespace_pod_cpu_usage_cores', 'Aggregate Pod CPU usage in a namespace reported by metrics.k8s.io.', 'gauge'],
  ['kubi_namespace_pod_memory_usage_bytes', 'Aggregate Pod memory usage in a namespace reported by metrics.k8s.io.', 'gauge'],
  ['kubi_namespace_pod_cpu_requests_cores', 'Aggregate CPU requests for active Pods in a namespace.', 'gauge'],
  ['kubi_namespace_pod_cpu_limits_cores', 'Aggregate CPU limits for active Pods in a namespace.', 'gauge'],
  ['kubi_namespace_pod_memory_requests_bytes', 'Aggregate memory requests for active Pods in a namespace.', 'gauge'],
  ['kubi_namespace_pod_memory_limits_bytes', 'Aggregate memory limits for active Pods in a namespace.', 'gauge'],
  ['kubi_workload_replicas', 'Replica counts for an individual Kubernetes workload.', 'gauge']
];

function labelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(values) {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? '' : `{${entries.map(([key, value]) => `${key}="${labelValue(value)}"`).join(',')}}`;
}

function metricValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '0';
}

function sample(lines, name, value, metricLabels = {}) {
  lines.push(`${name}${labels(metricLabels)} ${metricValue(value)}`);
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createAgentMetricsState() {
  return {
    relayConnected: false,
    discoveredContexts: 0,
    discoverySources: 0,
    discoveryLastSuccessTimestampSeconds: 0,
    heartbeatLastSuccessTimestampSeconds: 0,
    errors: { discovery: 0, heartbeat: 0, relay: 0, collection: 0 }
  };
}

export function renderPrometheusMetrics({ version, runtimeApiVersion, platform, state, collection }) {
  const lines = [];
  for (const [name, help, type] of metricDefinitions) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }

  sample(lines, 'kubi_agent_info', 1, {
    platform: platform || 'unknown',
    runtime_api_version: runtimeApiVersion || 'unknown',
    version: version || 'unknown'
  });
  sample(lines, 'kubi_agent_relay_connected', state.relayConnected ? 1 : 0);
  sample(lines, 'kubi_agent_discovered_contexts', state.discoveredContexts);
  sample(lines, 'kubi_agent_discovery_sources', state.discoverySources);
  sample(lines, 'kubi_agent_discovery_last_success_timestamp_seconds', state.discoveryLastSuccessTimestampSeconds);
  sample(lines, 'kubi_agent_heartbeat_last_success_timestamp_seconds', state.heartbeatLastSuccessTimestampSeconds);
  for (const operation of ['discovery', 'heartbeat', 'relay', 'collection']) {
    sample(lines, 'kubi_agent_errors_total', state.errors?.[operation] || 0, { operation });
  }
  sample(lines, 'kubi_agent_metrics_collection_duration_seconds', collection.durationSeconds || 0);
  sample(
    lines,
    'kubi_agent_metrics_last_collection_success_timestamp_seconds',
    collection.lastSuccessTimestampSeconds || 0
  );

  for (const entry of [...(collection.contexts || [])].sort((left, right) => left.context.localeCompare(right.context))) {
    const context = entry.context;
    sample(lines, 'kubi_cluster_up', entry.up ? 1 : 0, { context });
    if (!entry.up || !entry.snapshot) continue;
    const snapshot = entry.snapshot;
    for (const status of ['healthy', 'warning', 'critical']) {
      sample(lines, 'kubi_cluster_health', snapshot.health === status ? 1 : 0, { context, status });
    }
    sample(lines, 'kubi_cluster_namespaces', snapshot.namespaces, { context });
    sample(lines, 'kubi_cluster_nodes', snapshot.nodes?.ready, { context, state: 'ready' });
    sample(lines, 'kubi_cluster_nodes', snapshot.nodes?.notReady, { context, state: 'not_ready' });
    for (const type of ['memory', 'disk', 'pid', 'network']) {
      sample(lines, 'kubi_cluster_node_pressure', snapshot.nodes?.pressures?.[type], { context, type });
    }
    for (const kind of ['deployment', 'statefulset', 'daemonset']) {
      sample(lines, 'kubi_cluster_workloads', snapshot.workloads?.[kind]?.total, { context, kind });
      sample(lines, 'kubi_cluster_unavailable_workloads', snapshot.workloads?.[kind]?.unavailable, { context, kind });
    }
    for (const phase of ['running', 'pending', 'succeeded', 'failed', 'unknown']) {
      sample(lines, 'kubi_cluster_pods', snapshot.pods?.phases?.[phase], { context, phase });
    }
    sample(lines, 'kubi_cluster_active_pods', snapshot.pods?.activeReady, { context, state: 'ready' });
    sample(lines, 'kubi_cluster_active_pods', snapshot.pods?.activeNotReady, { context, state: 'not_ready' });
    sample(lines, 'kubi_cluster_crashloop_pods', snapshot.pods?.crashLoop, { context });
    sample(lines, 'kubi_cluster_failed_jobs', snapshot.failedJobs, { context });
    sample(lines, 'kubi_cluster_services_without_ready_endpoints', snapshot.servicesWithoutReadyEndpoints, { context });
    sample(lines, 'kubi_cluster_metrics_api_available', snapshot.metrics?.available ? 1 : 0, { context });
    if (snapshot.metrics?.available) {
      sample(lines, 'kubi_cluster_node_cpu_usage_cores', snapshot.metrics.nodeCpuUsageCores, { context });
      sample(lines, 'kubi_cluster_node_memory_usage_bytes', snapshot.metrics.nodeMemoryUsageBytes, { context });
      sample(lines, 'kubi_cluster_pod_cpu_usage_cores', snapshot.metrics.podCpuUsageCores, { context });
      sample(lines, 'kubi_cluster_pod_memory_usage_bytes', snapshot.metrics.podMemoryUsageBytes, { context });
    }

    if (collection.detailLevel !== 'balanced' || !snapshot.details) continue;
    for (const node of [...(snapshot.details.nodes || [])].sort((left, right) => left.name.localeCompare(right.name))) {
      const nodeLabels = { context, node: node.name };
      sample(lines, 'kubi_node_ready', node.ready ? 1 : 0, nodeLabels);
      for (const type of ['memory', 'disk', 'pid', 'network']) {
        sample(lines, 'kubi_node_pressure', node.pressures?.[type] ? 1 : 0, { ...nodeLabels, type });
      }
      sample(lines, 'kubi_node_cpu_allocatable_cores', node.cpuAllocatableCores, nodeLabels);
      sample(lines, 'kubi_node_memory_allocatable_bytes', node.memoryAllocatableBytes, nodeLabels);
      if (snapshot.metrics?.available && finiteMetric(node.cpuUsageCores)) {
        sample(lines, 'kubi_node_cpu_usage_cores', node.cpuUsageCores, nodeLabels);
      }
      if (snapshot.metrics?.available && finiteMetric(node.memoryUsageBytes)) {
        sample(lines, 'kubi_node_memory_usage_bytes', node.memoryUsageBytes, nodeLabels);
      }
    }

    for (const namespace of [...(snapshot.details.namespaces || [])].sort((left, right) => left.name.localeCompare(right.name))) {
      const namespaceLabels = { context, namespace: namespace.name };
      for (const phase of ['running', 'pending', 'succeeded', 'failed', 'unknown']) {
        sample(lines, 'kubi_namespace_pods', namespace.phases?.[phase], { ...namespaceLabels, phase });
      }
      sample(lines, 'kubi_namespace_active_pods', namespace.activeReady, { ...namespaceLabels, state: 'ready' });
      sample(lines, 'kubi_namespace_active_pods', namespace.activeNotReady, { ...namespaceLabels, state: 'not_ready' });
      sample(lines, 'kubi_namespace_pod_cpu_requests_cores', namespace.cpuRequestsCores, namespaceLabels);
      sample(lines, 'kubi_namespace_pod_cpu_limits_cores', namespace.cpuLimitsCores, namespaceLabels);
      sample(lines, 'kubi_namespace_pod_memory_requests_bytes', namespace.memoryRequestsBytes, namespaceLabels);
      sample(lines, 'kubi_namespace_pod_memory_limits_bytes', namespace.memoryLimitsBytes, namespaceLabels);
      if (snapshot.metrics?.available && finiteMetric(namespace.cpuUsageCores)) {
        sample(lines, 'kubi_namespace_pod_cpu_usage_cores', namespace.cpuUsageCores, namespaceLabels);
      }
      if (snapshot.metrics?.available && finiteMetric(namespace.memoryUsageBytes)) {
        sample(lines, 'kubi_namespace_pod_memory_usage_bytes', namespace.memoryUsageBytes, namespaceLabels);
      }
    }

    for (const workload of [...(snapshot.details.workloads || [])].sort((left, right) => {
      return `${left.namespace}/${left.kind}/${left.name}`.localeCompare(`${right.namespace}/${right.kind}/${right.name}`);
    })) {
      const workloadLabels = {
        context,
        namespace: workload.namespace,
        kind: workload.kind,
        workload: workload.name
      };
      for (const state of ['desired', 'ready', 'available']) {
        sample(lines, 'kubi_workload_replicas', workload[state], { ...workloadLabels, state });
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function readBearerToken(filePath) {
  if (!filePath) return '';
  const stat = fs.statSync(filePath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('metrics_exporter.bearer_token_file must not be readable by group or other users.');
  }
  const token = fs.readFileSync(filePath, 'utf8').trim();
  if (!token) throw new Error('metrics_exporter.bearer_token_file is empty.');
  return token;
}

function tokenMatches(expected, received) {
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestToken(request) {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

export function createPrometheusExporter(options) {
  const config = options.runtimeConfig.metricsExporter || { enabled: false };
  const state = options.state || createAgentMetricsState();
  const discoveryProvider = options.discoveryProvider || scanLocalAccessDiscovery;
  const selectorProvider = options.selectorProvider || resolveAgentRuntimeConfigForSelector;
  const snapshotProvider = options.snapshotProvider || loadLocalPrometheusSnapshot;
  const now = options.now || Date.now;
  const detailLevel = config.detailLevel || 'aggregate';
  let collection = { detailLevel, durationSeconds: 0, lastSuccessTimestampSeconds: 0, contexts: [] };
  let rendered = renderPrometheusMetrics({ ...options, state, collection });
  let server = null;
  let interval = null;
  let collecting = null;
  let bearerToken = '';

  const render = () => renderPrometheusMetrics({ ...options, state, collection });
  const collect = async () => {
    if (collecting) return collecting;
    collecting = (async () => {
      const startedAt = now();
      let contextResults = [];
      try {
        const discovery = discoveryProvider(options.runtimeConfig);
        const usable = discovery.candidates.filter((candidate) =>
          candidate.recommendedMode === 'agent' && candidate.sourceContextName
        );
        state.discoveredContexts = usable.length;
        state.discoverySources = discovery.sourceCount || 0;
        const allowlist = new Set(config.contexts || []);
        const selected = usable.filter((candidate) => allowlist.size === 0 || allowlist.has(candidate.sourceContextName));
        contextResults = await Promise.all(selected.map(async (candidate) => {
          const context = candidate.sourceContextName;
          try {
            const selectedConfig = selectorProvider(options.runtimeConfig, {
              contextName: context,
              clusterFingerprint: candidate.clusterFingerprint
            });
            return {
              context,
              up: true,
              snapshot: await snapshotProvider(selectedConfig, { detailLevel })
            };
          } catch {
            state.errors.collection += 1;
            return { context, up: false };
          }
        }));
      } catch {
        state.errors.collection += 1;
      }
      const successful = contextResults.some((entry) => entry.up);
      collection = {
        detailLevel,
        durationSeconds: Math.max(0, now() - startedAt) / 1000,
        lastSuccessTimestampSeconds: successful
          ? Math.floor(now() / 1000)
          : collection.lastSuccessTimestampSeconds,
        contexts: contextResults
      };
      rendered = render();
      return collection;
    })();
    try {
      return await collecting;
    } finally {
      collecting = null;
    }
  };

  const handle = (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Not found\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (bearerToken && !tokenMatches(bearerToken, requestToken(request))) {
      response.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer'
      });
      response.end('Unauthorized\n');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store'
    });
    rendered = render();
    response.end(request.method === 'HEAD' ? undefined : rendered);
  };

  return {
    state,
    collect,
    render: () => {
      rendered = render();
      return rendered;
    },
    address: () => server?.address() || null,
    async start() {
      if (!config.enabled || server) return;
      bearerToken = readBearerToken(config.bearerTokenFile);
      const tls = config.tls?.certFile
        ? {
            cert: fs.readFileSync(config.tls.certFile),
            key: fs.readFileSync(config.tls.keyFile)
          }
        : null;
      server = tls ? https.createServer(tls, handle) : http.createServer(handle);
      server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.listenAddress, () => {
          server.off('error', reject);
          resolve();
        });
      });
      interval = setInterval(() => void collect(), config.collectionIntervalSeconds * 1000);
      interval.unref?.();
    },
    async close() {
      if (interval) clearInterval(interval);
      interval = null;
      const active = server;
      server = null;
      if (!active) return;
      await new Promise((resolve) => active.close(() => resolve()));
    }
  };
}
