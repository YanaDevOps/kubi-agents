import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import { fetchKubeList, loadLocalKubeConfig } from './kube.js';

const METRICS_MAX_BYTES = 4 * 1024 * 1024;
const METRICS_TIMEOUT_SECONDS = 3;
const MAX_ENDPOINT_CANDIDATES = 8;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadata(value) {
  const source = record(record(value).metadata);
  return {
    name: text(source.name, 'unknown'),
    namespace: text(source.namespace, 'default'),
    labels: record(source.labels)
  };
}

function resourceList(items, fetchedAt) {
  return { items, fetchedAt, issues: [], partial: false, availability: 'available' };
}

function baseOverview(driver, backendKind, fetchedAt) {
  const providerIds = {
    ceph: 'rook-ceph',
    longhorn: 'driver.longhorn.io',
    openebs: 'openebs',
    portworx: 'portworx'
  };
  return {
    schemaVersion: 2,
    namespaceScope: null,
    fetchedAt,
    issues: [],
    partial: false,
    availability: 'available',
    availableDrivers: [],
    driver: {
      name: driver,
      providerId: providerIds[backendKind] || driver,
      type: 'csi',
      status: 'unknown',
      lastUpdate: fetchedAt,
      backendKind,
      features: {
        runtimeOverview: true,
        autoDiscovery: true,
        manualConfig: false,
        kubernetesHealth: true,
        backendMetrics: true
      }
    },
    capabilities: {
      kubernetesInventory: true,
      nodeRegistration: true,
      attachments: true,
      topologyCapacity: true,
      backendMetrics: true
    },
    summary: {
      monitors: { up: 0, total: 0 },
      osd: { up: 0, total: 0 },
      pools: 0,
      capacity: { usedBytes: 0, totalBytes: 0 },
      rawCapacity: { usedBytes: 0, totalBytes: 0 }
    },
    dataState: { clean: 0, degraded: 0, incomplete: 0, misplaced: 0 },
    io: { readOps: 0, writeOps: 0 },
    details: {
      monitors: resourceList([], fetchedAt),
      osds: resourceList([], fetchedAt),
      pools: resourceList([], fetchedAt)
    },
    backendSections: [],
    errors: []
  };
}

function internalAddress(value) {
  const address = String(value || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
  }
  return false;
}

function boundedGet(url, timeoutSeconds = METRICS_TIMEOUT_SECONDS, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      timeout: timeoutSeconds * 1000,
      headers: options.headers || {},
      ...(parsed.protocol === 'https:' ? {
        rejectUnauthorized: true,
        ...(options.ca ? { ca: options.ca } : {}),
        ...(options.cert ? { cert: options.cert } : {}),
        ...(options.key ? { key: options.key } : {})
      } : {})
    }, (response) => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        response.resume();
        reject(new Error(`Metrics endpoint returned HTTP ${response.statusCode || 0}.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > METRICS_MAX_BYTES) {
          request.destroy(new Error('Metrics response exceeded the 4 MiB safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => request.destroy(new Error('Metrics endpoint timed out.')));
    request.on('error', reject);
  });
}

function parseLabels(value) {
  const labels = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = pattern.exec(String(value || '')))) {
    labels[match[1]] = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

export function parseStoragePrometheusMetrics(payload) {
  const samples = [];
  for (const rawLine of String(payload || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|NaN|Inf|-Inf)(?:\s+\d+)?$/);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return samples;
}

function sampleValues(samples, names) {
  const allowed = new Set(names);
  return samples.filter((sample) => allowed.has(sample.name));
}

function sampleSum(samples, names) {
  return sampleValues(samples, names).reduce((sum, sample) => sum + sample.value, 0);
}

function sampleFirst(samples, names) {
  return sampleValues(samples, names)[0]?.value || 0;
}

async function fetchLists(kubeConfig, paths) {
  const settled = await Promise.allSettled(paths.map((path) => fetchKubeList(kubeConfig, path, true)));
  return settled.map((result) => result.status === 'fulfilled' ? result.value.items : []);
}

function serviceMatches(provider, service) {
  const meta = metadata(service);
  const haystack = `${meta.namespace}/${meta.name} ${JSON.stringify(meta.labels)}`.toLowerCase();
  if (provider === 'ceph') return haystack.includes('rook-ceph') && (haystack.includes('mgr') || haystack.includes('exporter'));
  if (provider === 'longhorn') return haystack.includes('longhorn') && (haystack.includes('backend') || haystack.includes('manager'));
  if (provider === 'openebs') {
    return (haystack.includes('openebs') || haystack.includes('mayastor') || haystack.includes('io-engine')) &&
      (haystack.includes('metric') || haystack.includes('pool') || haystack.includes('io-engine'));
  }
  if (provider === 'portworx') {
    return (haystack.includes('portworx') || haystack.includes('px-')) &&
      (haystack.includes('metric') || haystack.includes('prometheus') || haystack.includes('api'));
  }
  return false;
}

function allowedPort(provider, port, name) {
  const portNumber = Number(port);
  const portName = String(name || '').toLowerCase();
  if (provider === 'ceph') return portNumber === 9283 || portNumber === 9926 || portName.includes('metric');
  if (provider === 'longhorn') return portNumber === 9500 || portName.includes('metric');
  if (provider === 'openebs') return portNumber === 9502 || portNumber === 9090 || portName.includes('metric');
  if (provider === 'portworx') return [9001, 9028, 9090].includes(portNumber) || portName.includes('metric');
  return false;
}

export function discoverStorageMetricEndpoints(provider, services, endpointSlices) {
  const matchingServices = records(services).filter((service) => serviceMatches(provider, service));
  const candidates = [];
  for (const service of matchingServices) {
    const meta = metadata(service);
    const spec = record(service.spec);
    const servicePorts = records(spec.ports).filter((port) => allowedPort(provider, port.port || port.targetPort, port.name));
    const slices = records(endpointSlices).filter((slice) => {
      const sliceMeta = metadata(slice);
      return sliceMeta.namespace === meta.namespace && sliceMeta.labels['kubernetes.io/service-name'] === meta.name;
    });
    for (const slice of slices) {
      const slicePorts = records(slice.ports).filter((port) => allowedPort(provider, port.port, port.name));
      const ports = slicePorts.length ? slicePorts : servicePorts;
      for (const endpoint of records(slice.endpoints)) {
        for (const address of Array.isArray(endpoint.addresses) ? endpoint.addresses : []) {
          if (!internalAddress(address)) continue;
          for (const port of ports) {
            const portNumber = Number(port.port || port.targetPort);
            if (!Number.isFinite(portNumber) || portNumber <= 0) continue;
            const scheme = String(port.name || '').toLowerCase().includes('https') ? 'https' : 'http';
            const host = net.isIP(address) === 6 ? `[${address}]` : address;
            candidates.push(`${scheme}://${host}:${portNumber}/metrics`);
          }
        }
      }
    }
    const clusterIP = text(spec.clusterIP);
    for (const port of servicePorts) {
      if (!internalAddress(clusterIP)) continue;
      const portNumber = Number(port.port);
      const scheme = String(port.name || '').toLowerCase().includes('https') ? 'https' : 'http';
      const host = net.isIP(clusterIP) === 6 ? `[${clusterIP}]` : clusterIP;
      candidates.push(`${scheme}://${host}:${portNumber}/metrics`);
    }
  }
  return [...new Set(candidates)].slice(0, MAX_ENDPOINT_CANDIDATES);
}

function selectedMetricsProfile(runtimeConfig, provider) {
  const profiles = runtimeConfig?.storageDrivers?.[provider]?.profiles || [];
  const context = String(runtimeConfig?.kubeContext || '').trim();
  return profiles.find((profile) => context && profile.context === context) || profiles.find((profile) => profile.context === '*') || null;
}

function configuredRequestOptions(endpoint) {
  const read = (filename) => filename ? fs.readFileSync(filename) : undefined;
  const bearerToken = endpoint.bearerTokenFile ? String(read(endpoint.bearerTokenFile) || '').trim() : '';
  return {
    ...(bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : {}),
    ...(endpoint.caFile ? { ca: read(endpoint.caFile) } : {}),
    ...(endpoint.clientCertFile ? { cert: read(endpoint.clientCertFile) } : {}),
    ...(endpoint.clientKeyFile ? { key: read(endpoint.clientKeyFile) } : {})
  };
}

function uniqueSamples(samples) {
  const byIdentity = new Map();
  for (const sample of samples) {
    const labels = Object.entries(sample.labels || {}).sort(([left], [right]) => left.localeCompare(right));
    const key = `${sample.name}|${JSON.stringify(labels)}`;
    if (!byIdentity.has(key)) byIdentity.set(key, sample);
  }
  return [...byIdentity.values()];
}

async function loadMetrics(provider, services, endpointSlices, options = {}) {
  const errors = [];
  const profile = selectedMetricsProfile(options.runtimeConfig, provider);
  const configured = (profile?.metricsEndpoints || []).map((endpoint) => ({ ...endpoint, configured: true }));
  const automatic = discoverStorageMetricEndpoints(provider, services, endpointSlices).map((url) => ({ url, configured: false }));
  const candidates = [...configured, ...automatic].slice(0, MAX_ENDPOINT_CANDIDATES);
  const successful = [];
  const get = options.get || boundedGet;
  for (const endpoint of candidates) {
    try {
      const requestOptions = endpoint.configured ? configuredRequestOptions(endpoint) : {};
      const payload = await get(endpoint.url, METRICS_TIMEOUT_SECONDS, requestOptions);
      successful.push({ endpoint: endpoint.url, configured: endpoint.configured, samples: parseStoragePrometheusMetrics(payload) });
      if (!options.aggregate) break;
    } catch (error) {
      errors.push(String(error instanceof Error ? error.message : error));
    }
  }
  const first = successful[0];
  return {
    endpoint: first?.endpoint || '',
    configured: first?.configured === true,
    endpointCount: successful.length,
    samples: uniqueSamples(successful.flatMap((entry) => entry.samples)),
    errors
  };
}

function cephStatus(cluster, samples) {
  const metricHealth = sampleFirst(samples, ['ceph_health_status']);
  if (metricHealth >= 2) return 'critical';
  if (metricHealth === 1) return 'warning';
  const health = text(record(record(cluster).status).ceph && record(record(record(cluster).status).ceph).health).toUpperCase();
  if (health.includes('ERR')) return 'critical';
  if (health.includes('WARN')) return 'warning';
  if (health.includes('OK') || metricHealth === 0 && samples.length > 0) return 'healthy';
  return 'unknown';
}

function cephMonitorRows(samples) {
  return sampleValues(samples, ['ceph_mon_quorum_status']).map((sample) => ({
    name: sample.labels.ceph_daemon || sample.labels.hostname || sample.labels.name || 'monitor',
    role: sample.value > 0 ? 'quorum' : 'out of quorum',
    status: sample.value > 0 ? 'up' : 'down',
    address: sample.labels.public_addr || sample.labels.instance || ''
  }));
}

function cephOSDRows(samples) {
  const rows = new Map();
  const ensure = (sample) => {
    const name = sample.labels.ceph_daemon || sample.labels.osd || sample.labels.name || '';
    if (!name) return null;
    const existing = rows.get(name) || { name, status: 'unknown', node: sample.labels.hostname || '', usedBytes: 0, totalBytes: 0 };
    rows.set(name, existing);
    return existing;
  };
  for (const sample of samples) {
    if (!['ceph_osd_up', 'ceph_osd_stat_bytes', 'ceph_osd_stat_bytes_used'].includes(sample.name)) continue;
    const row = ensure(sample);
    if (!row) continue;
    if (sample.name === 'ceph_osd_up') row.status = sample.value > 0 ? 'up' : 'down';
    if (sample.name === 'ceph_osd_stat_bytes') row.totalBytes = sample.value;
    if (sample.name === 'ceph_osd_stat_bytes_used') row.usedBytes = sample.value;
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function cephPoolRows(samples, blockPools) {
  const rows = new Map(records(blockPools).map((pool) => {
    const meta = metadata(pool);
    const status = record(pool.status);
    return [meta.name, { name: meta.name, status: text(status.phase, 'detected'), usedBytes: 0, availableBytes: 0, totalBytes: 0, objects: 0 }];
  }));
  const ensure = (sample) => {
    const name = sample.labels.name || sample.labels.pool_name || sample.labels.pool || sample.labels.pool_id || '';
    if (!name) return null;
    const existing = rows.get(name) || { name, status: 'active', usedBytes: 0, availableBytes: 0, totalBytes: 0, objects: 0 };
    rows.set(name, existing);
    return existing;
  };
  for (const sample of samples) {
    if (!['ceph_pool_stored', 'ceph_pool_max_avail', 'ceph_pool_objects', 'ceph_pool_bytes_used'].includes(sample.name)) continue;
    const row = ensure(sample);
    if (!row) continue;
    if (sample.name === 'ceph_pool_stored' || sample.name === 'ceph_pool_bytes_used') row.usedBytes = Math.max(row.usedBytes, sample.value);
    if (sample.name === 'ceph_pool_max_avail') row.availableBytes = sample.value;
    if (sample.name === 'ceph_pool_objects') row.objects = sample.value;
  }
  return [...rows.values()]
    .map(({ availableBytes, ...row }) => ({ ...row, totalBytes: row.totalBytes || row.usedBytes + availableBytes }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadCephStorageOverview(runtimeConfig, input = {}, dependencies = {}) {
  const fetchedAt = new Date().toISOString();
  const overview = baseOverview('Rook / Ceph', 'ceph', fetchedAt);
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const [clusters, blockPools, filesystems, services, endpointSlices] = await fetchLists(kubeConfig, [
    '/apis/ceph.rook.io/v1/cephclusters',
    '/apis/ceph.rook.io/v1/cephblockpools',
    '/apis/ceph.rook.io/v1/cephfilesystems',
    '/api/v1/services',
    '/apis/discovery.k8s.io/v1/endpointslices'
  ]);
  const metrics = await loadMetrics('ceph', services, endpointSlices, {
    runtimeConfig,
    get: dependencies.getMetrics || boundedGet
  });
  const cluster = records(clusters)[0] || {};
  const clusterStatus = record(cluster.status);
  const ceph = record(clusterStatus.ceph);
  const crdCapacity = record(ceph.capacity);
  const monitors = cephMonitorRows(metrics.samples);
  const osds = cephOSDRows(metrics.samples);
  const pools = cephPoolRows(metrics.samples, blockPools);
  const usedBytes = sampleFirst(metrics.samples, ['ceph_cluster_total_used_bytes']) || number(crdCapacity.bytesUsed) || pools.reduce((sum, pool) => sum + pool.usedBytes, 0);
  const totalBytes = sampleFirst(metrics.samples, ['ceph_cluster_total_bytes']) || number(crdCapacity.bytesTotal) || pools.reduce((sum, pool) => sum + pool.totalBytes, 0);
  const status = cephStatus(cluster, metrics.samples);

  overview.driver.status = status;
  overview.driver.metricsSource = metrics.endpoint ? 'auto-discovered-exporter' : records(clusters).length ? 'rook-crds' : 'kubernetes-inventory';
  overview.driver.metricsSourceDetail = metrics.endpoint || undefined;
  overview.summary = {
    monitors: { up: monitors.filter((item) => item.status === 'up').length, total: monitors.length },
    osd: { up: osds.filter((item) => item.status === 'up').length, total: osds.length },
    pools: pools.length,
    capacity: { usedBytes, totalBytes },
    rawCapacity: { usedBytes, totalBytes },
    poolCountSource: metrics.endpoint ? 'Ceph exporter' : 'Rook CephBlockPool CRDs'
  };
  overview.io = {
    readOps: sampleSum(metrics.samples, ['ceph_pool_rd', 'ceph_osd_op_r']),
    writeOps: sampleSum(metrics.samples, ['ceph_pool_wr', 'ceph_osd_op_w'])
  };
  overview.dataState = {
    clean: sampleSum(metrics.samples, ['ceph_pg_clean']),
    degraded: sampleSum(metrics.samples, ['ceph_pg_degraded']),
    incomplete: sampleSum(metrics.samples, ['ceph_pg_incomplete']),
    misplaced: sampleSum(metrics.samples, ['ceph_pg_misplaced'])
  };
  overview.details = {
    monitors: resourceList(monitors, fetchedAt),
    osds: resourceList(osds, fetchedAt),
    pools: resourceList(pools, fetchedAt)
  };
  overview.backendSections = [
    {
      id: 'ceph-filesystems',
      title: 'Ceph filesystems',
      description: 'Rook CephFilesystem resources',
      columns: [{ key: 'name', label: 'Name' }, { key: 'namespace', label: 'Namespace' }, { key: 'status', label: 'Status', format: 'status' }],
      rows: records(filesystems).map((item) => ({ name: metadata(item).name, namespace: metadata(item).namespace, status: text(record(item.status).phase, 'detected') }))
    }
  ].filter((section) => section.rows.length > 0);
  overview.message = metrics.endpoint
    ? 'Ceph health and metrics loaded from Rook CRDs and an auto-discovered exporter.'
    : records(clusters).length
      ? 'Ceph health loaded from Rook CRDs. An unauthenticated internal metrics endpoint was not reachable.'
      : 'Ceph CSI is detected, but Rook CRDs and exporter metrics are not available.';
  return overview;
}

function conditionTrue(conditions, type) {
  return records(conditions).some((condition) => text(condition.type).toLowerCase() === type.toLowerCase() && String(condition.status).toLowerCase() === 'true');
}

function longhornRows(nodes, volumes, replicas, samples) {
  const nodeRows = [];
  const diskRows = [];
  let totalBytes = 0;
  let availableBytes = 0;
  for (const node of records(nodes)) {
    const meta = metadata(node);
    const status = record(node.status);
    const ready = conditionTrue(status.conditions, 'Ready');
    const schedulable = conditionTrue(status.conditions, 'Schedulable');
    const diskStatus = record(status.diskStatus);
    nodeRows.push({ name: meta.name, status: ready ? schedulable ? 'ready' : 'unschedulable' : 'not ready', disks: Object.keys(diskStatus).length });
    for (const [diskName, diskValue] of Object.entries(diskStatus)) {
      const disk = record(diskValue);
      const total = number(disk.storageMaximum);
      const available = number(disk.storageAvailable);
      totalBytes += total;
      availableBytes += available;
      diskRows.push({
        name: diskName,
        node: meta.name,
        status: conditionTrue(disk.conditions, 'Ready') ? 'ready' : 'not ready',
        usedBytes: Math.max(0, total - available),
        totalBytes: total
      });
    }
  }
  const volumeRows = records(volumes).map((volume) => {
    const meta = metadata(volume);
    const spec = record(volume.spec);
    const status = record(volume.status);
    return {
      name: meta.name,
      status: text(status.robustness, text(status.state, 'unknown')),
      node: text(status.currentNodeID, text(spec.nodeID)),
      sizeBytes: number(spec.size),
      actualSizeBytes: number(status.actualSize)
    };
  });
  const replicaRows = records(replicas).map((replica) => {
    const meta = metadata(replica);
    const spec = record(replica.spec);
    const status = record(replica.status);
    return {
      name: meta.name,
      volume: text(spec.volumeName),
      node: text(spec.nodeID),
      status: text(status.currentState, text(status.mode, 'unknown'))
    };
  });
  const metricTotal = sampleSum(samples, ['longhorn_node_storage_capacity_bytes']);
  const metricAvailable = sampleSum(samples, ['longhorn_node_storage_available_bytes']);
  return {
    nodeRows,
    diskRows,
    volumeRows,
    replicaRows,
    totalBytes: metricTotal || totalBytes,
    availableBytes: metricAvailable || availableBytes
  };
}

function longhornStatus(rows) {
  const failedVolume = rows.volumeRows.some((item) => /faulted|unknown/i.test(item.status));
  const degradedVolume = rows.volumeRows.some((item) => /degraded/i.test(item.status));
  const failedNode = rows.nodeRows.some((item) => item.status === 'not ready');
  const failedDisk = rows.diskRows.some((item) => item.status === 'not ready');
  if (failedVolume) return 'critical';
  if (degradedVolume || failedNode || failedDisk) return 'warning';
  if (rows.nodeRows.length || rows.volumeRows.length) return 'healthy';
  return 'unknown';
}

export async function loadLonghornStorageOverview(runtimeConfig, input = {}, dependencies = {}) {
  const fetchedAt = new Date().toISOString();
  const overview = baseOverview('Longhorn', 'longhorn', fetchedAt);
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  let [nodes, volumes, replicas, services, endpointSlices] = await fetchLists(kubeConfig, [
    '/apis/longhorn.io/v1beta2/nodes',
    '/apis/longhorn.io/v1beta2/volumes',
    '/apis/longhorn.io/v1beta2/replicas',
    '/api/v1/services',
    '/apis/discovery.k8s.io/v1/endpointslices'
  ]);
  if (!nodes.length && !volumes.length && !replicas.length) {
    [nodes, volumes, replicas] = await fetchLists(kubeConfig, [
      '/apis/longhorn.io/v1beta1/nodes',
      '/apis/longhorn.io/v1beta1/volumes',
      '/apis/longhorn.io/v1beta1/replicas'
    ]);
  }
  const metrics = await loadMetrics('longhorn', services, endpointSlices, {
    runtimeConfig,
    get: dependencies.getMetrics || boundedGet
  });
  const rows = longhornRows(nodes, volumes, replicas, metrics.samples);
  const status = longhornStatus(rows);
  const nodeStatus = rows.nodeRows.some((item) => item.status === 'not ready') ? 'warning' : rows.nodeRows.length ? 'healthy' : 'unknown';
  const diskStatus = rows.diskRows.some((item) => item.status === 'not ready') ? 'warning' : rows.diskRows.length ? 'healthy' : 'unknown';
  const volumeStatus = rows.volumeRows.some((item) => /faulted|unknown/i.test(item.status))
    ? 'critical'
    : rows.volumeRows.some((item) => /degraded/i.test(item.status))
      ? 'warning'
      : rows.volumeRows.length ? 'healthy' : 'unknown';
  const replicaStatus = rows.replicaRows.some((item) => !/running|healthy/i.test(item.status)) ? 'warning' : rows.replicaRows.length ? 'healthy' : 'unknown';
  overview.driver.status = status;
  overview.driver.metricsSource = metrics.endpoint ? 'auto-discovered-exporter' : rows.nodeRows.length || rows.volumeRows.length ? 'longhorn-crds' : 'kubernetes-inventory';
  overview.driver.metricsSourceDetail = metrics.endpoint || undefined;
  overview.summary.capacity = {
    usedBytes: Math.max(0, rows.totalBytes - rows.availableBytes),
    totalBytes: rows.totalBytes
  };
  overview.summary.rawCapacity = { ...overview.summary.capacity };
  overview.io = {
    readOps: sampleSum(metrics.samples, ['longhorn_volume_read_iops', 'longhorn_volume_read_throughput']),
    writeOps: sampleSum(metrics.samples, ['longhorn_volume_write_iops', 'longhorn_volume_write_throughput'])
  };
  overview.backendSections = [
    {
      id: 'longhorn-nodes', title: 'Longhorn nodes', description: 'Node and disk scheduling state', status: nodeStatus,
      columns: [{ key: 'name', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'disks', label: 'Disks', format: 'number' }], rows: rows.nodeRows
    },
    {
      id: 'longhorn-disks', title: 'Longhorn disks', description: 'Disk health and allocatable capacity', status: diskStatus,
      columns: [{ key: 'name', label: 'Disk' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'usedBytes', label: 'Used', format: 'bytes' }, { key: 'totalBytes', label: 'Total', format: 'bytes' }], rows: rows.diskRows
    },
    {
      id: 'longhorn-volumes', title: 'Longhorn volumes', description: 'Volume robustness and placement', status: volumeStatus,
      columns: [{ key: 'name', label: 'Volume' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'node', label: 'Node' }, { key: 'actualSizeBytes', label: 'Actual', format: 'bytes' }, { key: 'sizeBytes', label: 'Size', format: 'bytes' }], rows: rows.volumeRows
    },
    {
      id: 'longhorn-replicas', title: 'Longhorn replicas', description: 'Replica placement and current state', status: replicaStatus,
      columns: [{ key: 'name', label: 'Replica' }, { key: 'volume', label: 'Volume' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }], rows: rows.replicaRows
    }
  ].filter((section) => section.rows.length > 0);
  overview.message = metrics.endpoint
    ? 'Longhorn health and metrics loaded from CRDs and an auto-discovered Manager endpoint.'
    : rows.nodeRows.length || rows.volumeRows.length
      ? 'Longhorn health loaded from CRDs. An unauthenticated internal metrics endpoint was not reachable.'
      : 'Longhorn CSI is detected, but Longhorn CRDs and Manager metrics are not available.';
  return overview;
}

function bytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]i?B?|B)?$/i);
  if (!match) return number(value);
  const amount = Number(match[1]);
  const unit = String(match[2] || 'B').toUpperCase();
  const powers = { B: 0, K: 1, KB: 1, KIB: 1, M: 2, MB: 2, MIB: 2, G: 3, GB: 3, GIB: 3, T: 4, TB: 4, TIB: 4, P: 5, PB: 5, PIB: 5, E: 6, EB: 6, EIB: 6 };
  const power = powers[unit] ?? 0;
  const base = unit.includes('I') ? 1024 : 1000;
  return amount * base ** power;
}

function currentStatus(value, fallback = 'unknown') {
  return text(value, fallback).toLowerCase().replace(/[_\s]+/g, '-');
}

function metricsSource(metrics, fallback) {
  if (metrics.endpoint) return metrics.configured ? 'configured-exporter' : 'auto-discovered-exporter';
  return fallback;
}

function openEbsPoolRows(diskPools, samples) {
  const rows = new Map();
  const ensure = (name, node = '') => {
    if (!name) return null;
    const row = rows.get(name) || {
      name,
      node,
      status: 'unknown',
      usedBytes: 0,
      totalBytes: 0,
      committedBytes: 0,
      ioErrors: 0,
      ioStalled: false
    };
    if (!row.node && node) row.node = node;
    rows.set(name, row);
    return row;
  };

  for (const pool of records(diskPools)) {
    const meta = metadata(pool);
    const spec = record(pool.spec);
    const status = record(pool.status);
    const capacity = record(status.capacity);
    const errorInfo = record(status.error_info || status.errorInfo);
    const row = ensure(meta.name, text(spec.node));
    row.status = currentStatus(status.state || status.phase || status.status, 'detected');
    row.totalBytes = bytes(capacity.total ?? capacity.capacity ?? status.capacity ?? status.totalCapacity);
    row.usedBytes = bytes(capacity.used ?? status.used ?? status.allocated);
    const available = bytes(capacity.available ?? status.available);
    if (!row.totalBytes && available) row.totalBytes = row.usedBytes + available;
    row.committedBytes = bytes(capacity.committed ?? status.committed);
    row.ioErrors = number(errorInfo.io_error_count ?? errorInfo.ioErrorCount);
    row.ioStalled = errorInfo.io_stalled === true || errorInfo.ioStalled === true;
  }

  for (const sample of samples) {
    if (!sample.name.startsWith('diskpool_')) continue;
    const row = ensure(sample.labels.name || sample.labels.pool, sample.labels.node || '');
    if (!row) continue;
    if (sample.name === 'diskpool_status') row.status = ['unknown', 'online', 'degraded', 'faulted'][sample.value] || 'unknown';
    if (sample.name === 'diskpool_total_size_bytes') row.totalBytes = sample.value;
    if (sample.name === 'diskpool_used_size_bytes') row.usedBytes = sample.value;
    if (sample.name === 'diskpool_committed_size_bytes') row.committedBytes = sample.value;
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function localStorageRows(engine, nodes, volumes) {
  const nodeRows = records(nodes).map((node) => {
    const meta = metadata(node);
    const status = record(node.status);
    const pools = records(node.pools || status.pools);
    return {
      name: meta.name,
      engine,
      status: currentStatus(status.state || status.phase || status.status, 'ready'),
      pools: pools.length
    };
  });
  const volumeRows = records(volumes).map((volume) => {
    const meta = metadata(volume);
    const spec = record(volume.spec);
    const status = record(volume.status);
    return {
      name: meta.name,
      engine,
      namespace: meta.namespace,
      node: text(spec.ownerNodeID || spec.nodeID || spec.node),
      status: currentStatus(status.state || status.phase || status.status, 'detected'),
      sizeBytes: bytes(spec.capacity || spec.size || status.capacity)
    };
  });
  return { nodeRows, volumeRows };
}

function openEbsStatus(poolRows, nodeRows, volumeRows) {
  if (poolRows.some((row) => /faulted|offline/.test(row.status) || row.ioStalled)) return 'critical';
  if (poolRows.some((row) => /degraded|suspected|warning|attention/.test(row.status))) return 'warning';
  if (nodeRows.some((row) => /not-ready|offline|faulted/.test(row.status))) return 'warning';
  if (volumeRows.some((row) => /faulted|offline|error/.test(row.status))) return 'critical';
  if (poolRows.length || nodeRows.length || volumeRows.length) return 'healthy';
  return 'unknown';
}

export async function loadOpenEbsStorageOverview(runtimeConfig, input = {}, dependencies = {}) {
  const fetchedAt = new Date().toISOString();
  const overview = baseOverview('OpenEBS', 'openebs', fetchedAt);
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  let [diskPools, lvmNodes, lvmVolumes, zfsNodes, zfsVolumes, storageClasses, services, endpointSlices] = await fetchLists(kubeConfig, [
    '/apis/openebs.io/v1beta3/diskpools',
    '/apis/local.openebs.io/v1alpha1/lvmnodes',
    '/apis/local.openebs.io/v1alpha1/lvmvolumes',
    '/apis/zfs.openebs.io/v1/zfsnodes',
    '/apis/zfs.openebs.io/v1/zfsvolumes',
    '/apis/storage.k8s.io/v1/storageclasses',
    '/api/v1/services',
    '/apis/discovery.k8s.io/v1/endpointslices'
  ]);
  if (!diskPools.length) {
    [diskPools] = await fetchLists(kubeConfig, ['/apis/openebs.io/v1beta2/diskpools']);
  }
  const metrics = await loadMetrics('openebs', services, endpointSlices, {
    runtimeConfig,
    aggregate: true,
    get: dependencies.getMetrics || boundedGet
  });
  const poolRows = openEbsPoolRows(diskPools, metrics.samples);
  const lvm = localStorageRows('LVM LocalPV', lvmNodes, lvmVolumes);
  const zfs = localStorageRows('ZFS LocalPV', zfsNodes, zfsVolumes);
  const localNodeRows = [...lvm.nodeRows, ...zfs.nodeRows];
  const volumeRows = [...lvm.volumeRows, ...zfs.volumeRows];
  const provisioners = new Set(records(storageClasses).map((item) => text(item.provisioner).toLowerCase()));
  const engines = [
    { name: 'Mayastor', detected: poolRows.length > 0 || provisioners.has('io.openebs.csi-mayastor'), pools: poolRows.length, nodes: new Set(poolRows.map((row) => row.node).filter(Boolean)).size, volumes: 0 },
    { name: 'LVM LocalPV', detected: lvm.nodeRows.length > 0 || lvm.volumeRows.length > 0 || [...provisioners].some((item) => item.includes('lvm') && item.includes('openebs')), pools: 0, nodes: lvm.nodeRows.length, volumes: lvm.volumeRows.length },
    { name: 'ZFS LocalPV', detected: zfs.nodeRows.length > 0 || zfs.volumeRows.length > 0 || [...provisioners].some((item) => item.includes('zfs') && item.includes('openebs')), pools: 0, nodes: zfs.nodeRows.length, volumes: zfs.volumeRows.length },
    { name: 'Hostpath LocalPV', detected: provisioners.has('openebs.io/local'), pools: 0, nodes: 0, volumes: 0 }
  ].filter((engine) => engine.detected).map(({ detected, ...engine }) => ({ ...engine, status: 'detected' }));
  const status = openEbsStatus(poolRows, localNodeRows, volumeRows);
  const totalBytes = poolRows.reduce((sum, row) => sum + row.totalBytes, 0);
  const usedBytes = poolRows.reduce((sum, row) => sum + row.usedBytes, 0);

  overview.driver.status = status;
  overview.driver.metricsSource = metricsSource(metrics, engines.length ? 'openebs-crds' : 'kubernetes-inventory');
  overview.driver.metricsSourceDetail = metrics.endpoint || undefined;
  overview.summary.pools = poolRows.length;
  overview.summary.capacity = { usedBytes, totalBytes };
  overview.summary.rawCapacity = { usedBytes, totalBytes };
  overview.io = {
    readOps: sampleSum(metrics.samples, ['diskpool_num_read_ops']),
    writeOps: sampleSum(metrics.samples, ['diskpool_num_write_ops'])
  };
  overview.backendSections = [
    {
      id: 'openebs-engines', title: 'OpenEBS engines', description: 'Detected replicated and local storage engines', status,
      columns: [{ key: 'name', label: 'Engine' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'nodes', label: 'Nodes', format: 'number' }, { key: 'pools', label: 'Pools', format: 'number' }, { key: 'volumes', label: 'Volumes', format: 'number' }], rows: engines
    },
    {
      id: 'openebs-pools', title: 'Mayastor pools', description: 'Current pool capacity and I/O health', status,
      columns: [{ key: 'name', label: 'Pool' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'usedBytes', label: 'Used', format: 'bytes' }, { key: 'totalBytes', label: 'Total', format: 'bytes' }, { key: 'committedBytes', label: 'Committed', format: 'bytes' }, { key: 'ioErrors', label: 'I/O errors', format: 'number' }], rows: poolRows
    },
    {
      id: 'openebs-local-nodes', title: 'LocalPV nodes', description: 'LVM and ZFS node inventory', status: localNodeRows.length ? 'healthy' : 'unknown',
      columns: [{ key: 'name', label: 'Node' }, { key: 'engine', label: 'Engine' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'pools', label: 'Pools', format: 'number' }], rows: localNodeRows
    },
    {
      id: 'openebs-volumes', title: 'LocalPV volumes', description: 'LVM and ZFS volume state', status: volumeRows.length ? 'healthy' : 'unknown',
      columns: [{ key: 'name', label: 'Volume' }, { key: 'engine', label: 'Engine' }, { key: 'namespace', label: 'Namespace' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'sizeBytes', label: 'Size', format: 'bytes' }], rows: volumeRows
    }
  ].filter((section) => section.rows.length > 0);
  overview.errors = metrics.errors;
  overview.partial = metrics.errors.length > 0 && metrics.endpointCount === 0 && engines.length > 0;
  overview.message = metrics.endpoint
    ? `OpenEBS inventory and metrics loaded from ${metrics.endpointCount} exporter endpoint${metrics.endpointCount === 1 ? '' : 's'}.`
    : engines.length
      ? 'OpenEBS health loaded from Kubernetes CRDs. Exporter metrics are not available.'
      : 'OpenEBS CSI is detected, but OpenEBS CRDs and exporter metrics are not available.';
  return overview;
}

function portworxPoolRows(samples) {
  const rows = new Map();
  const ensure = (sample) => {
    const name = sample.labels.pool || sample.labels.poolid || '';
    if (!name) return null;
    const key = `${sample.labels.node || sample.labels.nodeID || ''}/${name}`;
    const row = rows.get(key) || { name, node: sample.labels.node || sample.labels.nodeID || '', status: 'unknown', usedBytes: 0, totalBytes: 0, provisionedBytes: 0 };
    rows.set(key, row);
    return row;
  };
  for (const sample of samples) {
    if (!sample.name.startsWith('px_pool_stats_')) continue;
    const row = ensure(sample);
    if (!row) continue;
    if (sample.name === 'px_pool_stats_status') row.status = ['offline', 'online', 'full', 'not-found', 'maintenance', 'degraded', 'background-activity'][sample.value] || 'unknown';
    if (sample.name === 'px_pool_stats_total_bytes') row.totalBytes = sample.value;
    if (sample.name === 'px_pool_stats_used_bytes') row.usedBytes = sample.value;
    if (sample.name === 'px_pool_stats_provisioned_bytes') row.provisionedBytes = sample.value;
  }
  return [...rows.values()].sort((left, right) => `${left.node}/${left.name}`.localeCompare(`${right.node}/${right.name}`));
}

function portworxVolumeRows(samples) {
  const rows = new Map();
  const ensure = (sample) => {
    const id = sample.labels.volume || sample.labels.volumeid || sample.labels.volume_id || '';
    const name = sample.labels.volumename || sample.labels.pvc || id;
    if (!id && !name) return null;
    const key = id || name;
    const row = rows.get(key) || { name, id, node: sample.labels.node || sample.labels.node_name || '', status: 'unknown', usedBytes: 0, totalBytes: 0, attached: false };
    rows.set(key, row);
    return row;
  };
  for (const sample of samples) {
    if (!sample.name.startsWith('px_volume_')) continue;
    const row = ensure(sample);
    if (!row) continue;
    if (sample.name === 'px_volume_capacity_bytes' || sample.name === 'px_volume_fs_capacity_bytes') row.totalBytes = sample.value;
    if (sample.name === 'px_volume_usage_bytes' || sample.name === 'px_volume_fs_usage_bytes') row.usedBytes = sample.value;
    if (sample.name === 'px_volume_attached') row.attached = sample.value > 0;
    if (sample.name === 'px_volume_replication_status') row.status = ['healthy', 'not-in-quorum', 'resync', 'degraded', 'detached', 'restore'][sample.value] || 'unknown';
    if (sample.name === 'px_volume_fs_health_status' && sample.value > 0) row.status = 'filesystem-unhealthy';
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function portworxConnectionRows(samples) {
  const pairs = [
    ['iscsi', 'px_csi_node_iscsi_sessions', 'px_csi_node_iscsi_sessions_healthy'],
    ['nvme', 'px_csi_node_nvme_connections', 'px_csi_node_nvme_connections_healthy'],
    ['fc-hosts', 'px_csi_node_fc_hosts', 'px_csi_node_fc_hosts_online'],
    ['fc-rports', 'px_csi_node_fc_rports', 'px_csi_node_fc_rports_online'],
    ['multipath', 'px_csi_multipath_device_total_paths', 'px_csi_multipath_device_healthy_paths']
  ];
  const rows = [];
  for (const [protocol, totalMetric, healthyMetric] of pairs) {
    const totals = sampleValues(samples, [totalMetric]);
    for (const total of totals) {
      const identity = {
        node: total.labels.node_name || total.labels.node || '',
        transport: total.labels.transport_type || '',
        volume: total.labels.volume_id || ''
      };
      const healthy = sampleValues(samples, [healthyMetric]).find((sample) =>
        (sample.labels.node_name || sample.labels.node || '') === identity.node &&
        (sample.labels.transport_type || '') === identity.transport &&
        (sample.labels.volume_id || '') === identity.volume
      );
      rows.push({
        name: [protocol, identity.transport, identity.volume].filter(Boolean).join(' / '),
        node: identity.node,
        status: healthy && healthy.value >= total.value ? 'healthy' : total.value === 0 ? 'not-configured' : 'degraded',
        healthy: healthy?.value || 0,
        total: total.value
      });
    }
  }
  return rows.sort((left, right) => `${left.node}/${left.name}`.localeCompare(`${right.node}/${right.name}`));
}

function portworxStatus(clusters, nodes, pools, volumes, connections, samples) {
  const storageDown = sampleSum(samples, ['px_cluster_status_nodes_storage_down']);
  const offline = sampleSum(samples, ['px_cluster_status_nodes_offline', 'px_cluster_status_storage_nodes_offline']);
  if (storageDown > 0 || pools.some((row) => /offline|full|not-found/.test(row.status)) || volumes.some((row) => /not-in-quorum|filesystem-unhealthy/.test(row.status))) return 'critical';
  if (offline > 0 || pools.some((row) => /degraded/.test(row.status)) || volumes.some((row) => /resync|degraded/.test(row.status)) || connections.some((row) => row.status === 'degraded')) return 'warning';
  if (records(clusters).some((cluster) => /error|offline|failed/.test(currentStatus(record(cluster.status).phase || record(cluster.status).status)))) return 'critical';
  if (records(nodes).some((node) => /error|offline|failed/.test(currentStatus(record(node.status).phase || record(node.status).status)))) return 'warning';
  if (records(clusters).length || records(nodes).length || pools.length || volumes.length) return 'healthy';
  return 'unknown';
}

export async function loadPortworxStorageOverview(runtimeConfig, input = {}, dependencies = {}) {
  const fetchedAt = new Date().toISOString();
  const overview = baseOverview('Portworx', 'portworx', fetchedAt);
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const [clusters, storageNodes, services, endpointSlices] = await fetchLists(kubeConfig, [
    '/apis/core.libopenstorage.org/v1/storageclusters',
    '/apis/core.libopenstorage.org/v1/storagenodes',
    '/api/v1/services',
    '/apis/discovery.k8s.io/v1/endpointslices'
  ]);
  const metrics = await loadMetrics('portworx', services, endpointSlices, {
    runtimeConfig,
    aggregate: true,
    get: dependencies.getMetrics || boundedGet
  });
  const nodeRows = records(storageNodes).map((node) => {
    const meta = metadata(node);
    const status = record(node.status);
    return { name: meta.name, status: currentStatus(status.phase || status.status || status.state, 'detected'), version: text(status.version) };
  });
  const poolRows = portworxPoolRows(metrics.samples);
  const volumeRows = portworxVolumeRows(metrics.samples);
  const connectionRows = portworxConnectionRows(metrics.samples);
  const status = portworxStatus(clusters, storageNodes, poolRows, volumeRows, connectionRows, metrics.samples);
  const poolTotal = poolRows.reduce((sum, row) => sum + row.totalBytes, 0);
  const poolUsed = poolRows.reduce((sum, row) => sum + row.usedBytes, 0);
  const clusterTotal = sampleSum(metrics.samples, ['px_cluster_disk_total_bytes']);
  const clusterUsed = sampleSum(metrics.samples, ['px_cluster_disk_utilized_bytes']);

  overview.driver.status = status;
  overview.driver.metricsSource = metricsSource(metrics, records(clusters).length || nodeRows.length ? 'portworx-crds' : 'kubernetes-inventory');
  overview.driver.metricsSourceDetail = metrics.endpoint || undefined;
  overview.summary.pools = poolRows.length;
  overview.summary.capacity = { usedBytes: poolUsed || clusterUsed, totalBytes: poolTotal || clusterTotal };
  overview.summary.rawCapacity = { ...overview.summary.capacity };
  overview.io = {
    readOps: sampleSum(metrics.samples, ['px_volume_read_iops']),
    writeOps: sampleSum(metrics.samples, ['px_volume_write_iops'])
  };
  overview.backendSections = [
    {
      id: 'portworx-nodes', title: 'Portworx nodes', description: 'Storage node readiness', status,
      columns: [{ key: 'name', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'version', label: 'Version' }], rows: nodeRows
    },
    {
      id: 'portworx-pools', title: 'Portworx pools', description: 'Pool capacity and current state', status,
      columns: [{ key: 'name', label: 'Pool' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'usedBytes', label: 'Used', format: 'bytes' }, { key: 'totalBytes', label: 'Total', format: 'bytes' }, { key: 'provisionedBytes', label: 'Provisioned', format: 'bytes' }], rows: poolRows
    },
    {
      id: 'portworx-volumes', title: 'Portworx volumes', description: 'Volume capacity, replication, and attachment state', status,
      columns: [{ key: 'name', label: 'Volume' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'attached', label: 'Attached' }, { key: 'usedBytes', label: 'Used', format: 'bytes' }, { key: 'totalBytes', label: 'Total', format: 'bytes' }], rows: volumeRows
    },
    {
      id: 'portworx-connections', title: 'Host storage connections', description: 'iSCSI, NVMe, FC, and multipath health', status: connectionRows.some((row) => row.status === 'degraded') ? 'warning' : connectionRows.length ? 'healthy' : 'unknown',
      columns: [{ key: 'name', label: 'Connection' }, { key: 'node', label: 'Node' }, { key: 'status', label: 'Status', format: 'status' }, { key: 'healthy', label: 'Healthy', format: 'number' }, { key: 'total', label: 'Total', format: 'number' }], rows: connectionRows
    }
  ].filter((section) => section.rows.length > 0);
  overview.errors = metrics.errors;
  overview.partial = metrics.errors.length > 0 && metrics.endpointCount === 0 && (records(clusters).length > 0 || nodeRows.length > 0);
  overview.message = metrics.endpoint
    ? `Portworx inventory and metrics loaded from ${metrics.endpointCount} exporter endpoint${metrics.endpointCount === 1 ? '' : 's'}.`
    : records(clusters).length || nodeRows.length
      ? 'Portworx health loaded from Kubernetes CRDs. Exporter metrics are not available.'
      : 'Portworx CSI is detected, but Portworx CRDs and exporter metrics are not available.';
  return overview;
}
