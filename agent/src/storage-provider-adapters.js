import http from 'node:http';
import https from 'node:https';
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
      providerId: backendKind === 'ceph' ? 'rook-ceph' : backendKind === 'longhorn' ? 'driver.longhorn.io' : driver,
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

function boundedGet(url, timeoutSeconds = METRICS_TIMEOUT_SECONDS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      timeout: timeoutSeconds * 1000,
      ...(parsed.protocol === 'https:' ? { rejectUnauthorized: true } : {})
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
  return provider === 'ceph'
    ? haystack.includes('rook-ceph') && (haystack.includes('mgr') || haystack.includes('exporter'))
    : haystack.includes('longhorn') && (haystack.includes('backend') || haystack.includes('manager'));
}

function allowedPort(provider, port, name) {
  const portNumber = Number(port);
  const portName = String(name || '').toLowerCase();
  if (provider === 'ceph') return portNumber === 9283 || portNumber === 9926 || portName.includes('metric');
  return portNumber === 9500 || portName.includes('metric');
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

async function loadMetrics(provider, services, endpointSlices, get = boundedGet) {
  const errors = [];
  for (const endpoint of discoverStorageMetricEndpoints(provider, services, endpointSlices)) {
    try {
      return { endpoint, samples: parseStoragePrometheusMetrics(await get(endpoint)), errors };
    } catch (error) {
      errors.push(String(error instanceof Error ? error.message : error));
    }
  }
  return { endpoint: '', samples: [], errors };
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
  const metrics = await loadMetrics('ceph', services, endpointSlices, dependencies.getMetrics || boundedGet);
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
  const metrics = await loadMetrics('longhorn', services, endpointSlices, dependencies.getMetrics || boundedGet);
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
