import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execFile as nodeExecFile } from 'node:child_process';
import { discoverLocalAccessCandidates, fetchKubeList, loadLocalKubeConfig, metadataFor } from './kube.js';
import {
  loadCephStorageOverview,
  loadLonghornStorageOverview,
  loadOpenEbsStorageOverview,
  loadPortworxStorageOverview
} from './storage-provider-adapters.js';

const CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function emptyResourceList(items, fetchedAt, errors = []) {
  return {
    items,
    fetchedAt,
    issues: errors.map((message) => ({
      code: 'partial_data',
      message,
      retryable: true,
      scope: 'storage-driver'
    })),
    partial: errors.length > 0,
    availability: errors.length > 0 ? 'degraded' : 'available'
  };
}

function emptyDriverSummary(driver, fetchedAt, message, errors = []) {
  const partial = errors.length > 0;
  return {
    namespaceScope: null,
    fetchedAt,
    issues: errors.map((error) => ({
      code: 'partial_data',
      message: error,
      retryable: true,
      scope: 'storage-driver'
    })),
    partial,
    availability: partial ? 'degraded' : 'available',
    availableDrivers: [],
    driver: {
      name: driver || 'Unknown',
      providerId: driver || undefined,
      type: 'csi',
      status: 'unknown',
      lastUpdate: fetchedAt,
      features: {
        runtimeOverview: /vitastor/i.test(driver),
        autoDiscovery: /vitastor/i.test(driver),
        manualConfig: /vitastor/i.test(driver)
      }
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
      monitors: emptyResourceList([], fetchedAt),
      osds: emptyResourceList([], fetchedAt),
      pools: emptyResourceList([], fetchedAt)
    },
    message,
    errors
  };
}

function executeFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      args,
      {
        timeout: Math.max(1, Number(options.timeoutSeconds) || 8) * 1000,
        maxBuffer: CLI_MAX_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(authorization|password|token)=?[^,\s]*/gi, '$1=[redacted]')
    .replace(/https?:\/\/([^/@\s]+)@/gi, 'https://[redacted]@');
}

function request(url, { method = 'GET', headers = {}, body, timeoutSeconds = 8, tls = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const options = {
      method,
      headers,
      timeout: timeoutSeconds * 1000
    };
    if (parsed.protocol === 'https:') {
      if (tls.caFile) options.ca = fs.readFileSync(tls.caFile);
      if (tls.certFile) options.cert = fs.readFileSync(tls.certFile);
      if (tls.keyFile) options.key = fs.readFileSync(tls.keyFile);
    }
    const req = transport.request(parsed, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode || 0, text, headers: response.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutSeconds}s.`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function withScheme(endpoint, scheme = 'http') {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  return /^[a-z]+:\/\//i.test(value) ? value : `${scheme}://${value}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractEndpointCandidates(value) {
  const text = String(value || '');
  const urls = text.match(/https?:\/\/[A-Za-z0-9_.:[\]-]+/g) || [];
  const hosts = text.match(/(?:\[[0-9a-f:]+\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}/g) || [];
  return unique([...urls, ...hosts]);
}

function prefixRangeEnd(prefix) {
  const bytes = Buffer.from(prefix);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] < 255) {
      bytes[index] += 1;
      return bytes.subarray(0, index + 1);
    }
  }
  return Buffer.from([0]);
}

async function etcdToken(endpoint, config) {
  if (!config.auth?.username && !config.auth?.password) return '';
  const response = await request(`${endpoint}/v3/auth/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: config.auth.username, password: config.auth.password }),
    timeoutSeconds: config.timeoutSeconds,
    tls: config.tls
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`etcd authentication returned HTTP ${response.status}.`);
  }
  return String(JSON.parse(response.text || '{}').token || '');
}

async function etcdRange(endpoint, prefix, config) {
  const token = await etcdToken(endpoint, config);
  const key = Buffer.from(prefix);
  const response = await request(`${endpoint}/v3/kv/range`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {})
    },
    body: JSON.stringify({
      key: key.toString('base64'),
      range_end: prefixRangeEnd(prefix).toString('base64'),
      limit: 5000
    }),
    timeoutSeconds: config.timeoutSeconds,
    tls: config.tls
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`etcd range request returned HTTP ${response.status}.`);
  }
  const payload = JSON.parse(response.text || '{}');
  return (Array.isArray(payload.kvs) ? payload.kvs : []).map((entry) => ({
    key: Buffer.from(String(entry.key || ''), 'base64').toString('utf8'),
    value: Buffer.from(String(entry.value || ''), 'base64').toString('utf8'),
    lease: String(entry.lease || '')
  }));
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCliJson(output, command) {
  try {
    return JSON.parse(String(output || ''));
  } catch {
    throw new Error(`vitastor-cli ${command} returned invalid JSON.`);
  }
}

function vitastorCliArgs(command, configPath) {
  const args = [command, '--json'];
  if (configPath) args.push('--config_path', configPath);
  return args;
}

function exactProfileSelected(profile, runtimeConfig) {
  if (!profile) return false;
  if (profile.clusterFingerprint) {
    return profile.clusterFingerprint === runtimeConfig.clusterFingerprint;
  }
  return Boolean(profile.context && profile.context !== '*' && profile.context === runtimeConfig.kubeContext);
}

function canUseLocalVitastorCli(runtimeConfig, profile) {
  if (exactProfileSelected(profile, runtimeConfig)) return true;
  if (Number.isFinite(runtimeConfig.discoveredContextCount)) {
    return runtimeConfig.discoveredContextCount <= 1;
  }
  try {
    return discoverLocalAccessCandidates(runtimeConfig).length <= 1;
  } catch {
    return false;
  }
}

async function loadVitastorCliOverview(runtimeConfig, profile, fetchedAt, execFile) {
  const cli = {
    enabled: true,
    path: 'vitastor-cli',
    configPath: '',
    timeoutSeconds: 8,
    ...(runtimeConfig.storageDrivers?.vitastor?.cli || {})
  };
  if (!cli.enabled || !canUseLocalVitastorCli(runtimeConfig, profile)) return null;

  const run = async (command) => parseCliJson(
    await execFile(cli.path, vitastorCliArgs(command, cli.configPath), {
      timeoutSeconds: cli.timeoutSeconds,
      maxOutputBytes: CLI_MAX_OUTPUT_BYTES
    }),
    command
  );
  const status = await run('status');
  const poolsPayload = await run('pools');
  const osdsPayload = await run('osds');
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('vitastor-cli status returned an invalid object.');
  }
  const poolsInput = Array.isArray(poolsPayload) ? poolsPayload : [];
  const osdsInput = Array.isArray(osdsPayload) ? osdsPayload : [];
  const pools = poolsInput.map((pool) => {
    const rawToUsable = Math.max(1, numeric(pool.raw_to_usable));
    const usedBytes = numeric(pool.used_raw) / rawToUsable;
    const availableBytes = numeric(pool.max_available);
    return {
      name: String(pool.name || pool.id || 'unknown'),
      status: String(pool.status || 'unknown'),
      usedBytes,
      totalBytes: usedBytes + availableBytes,
      objects: numeric(pool.object_count)
    };
  });
  const osds = osdsInput.map((osd) => ({
    name: String(osd.name ?? osd.id ?? 'unknown'),
    status: osd.up === true ? 'up' : 'down',
    node: osd.parent || osd.node || osd.host,
    usedBytes: Math.max(0, numeric(osd.size) - numeric(osd.free)),
    totalBytes: numeric(osd.size)
  }));
  const poolUsedBytes = pools.reduce((sum, pool) => sum + pool.usedBytes, 0);
  const poolTotalBytes = pools.reduce((sum, pool) => sum + pool.totalBytes, 0);
  const rawTotalBytes = numeric(status.total_raw);
  const rawUsedBytes = Math.max(0, rawTotalBytes - numeric(status.free_raw));
  const osdTotal = numeric(status.osd_count) || osds.length;
  const osdUp = numeric(status.osd_up) || osds.filter((osd) => osd.status === 'up').length;
  const poolTotal = numeric(status.pool_count) || pools.length;
  const activePools = numeric(status.active_pool_count);
  const degraded = numeric(status.degraded_data);
  const incomplete = numeric(status.incomplete_data);
  const misplaced = numeric(status.misplaced_data);
  const etcdUnhealthy = numeric(status.etcd_count) > 0 && numeric(status.etcd_alive) < numeric(status.etcd_count);
  const osdUnhealthy = osdTotal > 0 && osdUp < osdTotal;
  const poolUnhealthy = poolTotal > 0 && activePools < poolTotal;
  const driverStatus = incomplete > 0 || osdUnhealthy
    ? 'critical'
    : degraded > 0 || misplaced > 0 || etcdUnhealthy || poolUnhealthy
      ? 'warning'
      : 'healthy';
  const opStats = status.op_stats && typeof status.op_stats === 'object' ? status.op_stats : {};

  return {
    namespaceScope: null,
    fetchedAt,
    issues: [],
    partial: false,
    availability: 'available',
    availableDrivers: [],
    driver: {
      name: 'Vitastor',
      providerId: 'csi.vitastor.io',
      type: 'csi',
      status: driverStatus,
      lastUpdate: fetchedAt,
      metricsSource: 'vitastor-cli',
      metricsSourceDetail: cli.path,
      features: { runtimeOverview: true, autoDiscovery: true, manualConfig: true }
    },
    summary: {
      monitors: { up: numeric(status.mon_count), total: numeric(status.mon_count) },
      osd: { up: osdUp, total: osdTotal },
      pools: poolTotal,
      poolCountSource: 'vitastor-cli status',
      capacity: { usedBytes: poolUsedBytes, totalBytes: poolTotalBytes },
      rawCapacity: { usedBytes: rawUsedBytes, totalBytes: rawTotalBytes }
    },
    dataState: {
      clean: numeric(status.clean_data),
      degraded,
      incomplete,
      misplaced
    },
    io: {
      readOps: numeric(opStats.read?.count ?? opStats.read),
      writeOps: numeric(opStats.write?.count ?? opStats.write)
    },
    details: {
      monitors: emptyResourceList([], fetchedAt),
      osds: emptyResourceList(osds, fetchedAt),
      pools: emptyResourceList(pools, fetchedAt)
    },
    message: 'Vitastor metrics loaded through the local read-only CLI.',
    errors: []
  };
}

function metricHeaders(auth = {}) {
  const headers = { ...(auth.headers || {}) };
  if (auth.mode === 'basic' && (auth.username || auth.password)) {
    headers.authorization = `Basic ${Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')}`;
  }
  if (auth.mode === 'bearer' && auth.bearerToken) {
    headers.authorization = `Bearer ${auth.bearerToken}`;
  }
  return headers;
}

function parsePrometheusMetrics(text) {
  const result = {
    objectBytes: {},
    objectCount: {},
    readOps: 0,
    writeOps: 0
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
    if (!match) continue;
    const labels = Object.fromEntries(
      String(match[2] || '')
        .split(',')
        .map((entry) => entry.match(/^\s*([^=]+)="(.*)"\s*$/))
        .filter(Boolean)
        .map((entry) => [entry[1], entry[2]])
    );
    const value = numeric(match[3]);
    if (match[1] === 'vitastor_object_bytes' && labels.object_type) result.objectBytes[labels.object_type] = value;
    if (match[1] === 'vitastor_object_count' && labels.object_type) result.objectCount[labels.object_type] = value;
    if (match[1] === 'vitastor_stat_count') {
      if (labels.op_type === 'read' || labels.op_type === 'rd') result.readOps += value;
      if (labels.op_type === 'write' || labels.op_type === 'wr') result.writeOps += value;
    }
  }
  return result;
}

function mergeMetrics(target, source) {
  Object.assign(target.objectBytes, source.objectBytes);
  Object.assign(target.objectCount, source.objectCount);
  target.readOps += source.readOps;
  target.writeOps += source.writeOps;
}

function monitorAddresses(record) {
  const addresses = [];
  if (Array.isArray(record.ip)) addresses.push(...record.ip);
  for (const key of ['addr', 'address', 'host', 'hostname']) {
    if (typeof record[key] === 'string') addresses.push(record[key]);
  }
  return unique(addresses.map((value) => String(value).trim()));
}

async function probeMonitor(member, config, masterId) {
  const addresses = monitorAddresses(member.record);
  const address = addresses.find((value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) || addresses[0] || member.id;
  const metricsUrl = withScheme(`${address}:8060`, config.metrics.scheme);
  let metrics = { objectBytes: {}, objectCount: {}, readOps: 0, writeOps: 0 };
  let status = 'up';
  try {
    const response = await request(`${metricsUrl}/metrics`, {
      headers: metricHeaders(config.metrics.auth),
      timeoutSeconds: config.metrics.timeoutSeconds,
      tls: config.tls
    });
    if (response.status === 200) metrics = parsePrometheusMetrics(response.text);
    else if (response.status === 503) status = 'standby';
    else status = `HTTP ${response.status}`;
  } catch {
    status = 'discovered';
  }
  const master = member.id === masterId;
  return {
    row: {
      name: member.record.hostname || address,
      role: master ? 'master' : 'standby',
      status: status === 'up' || status === 'standby' || status === 'discovered' ? 'up' : 'down',
      address
    },
    metrics
  };
}

function osdRows(entries, staleSeconds) {
  const states = new Map();
  const stats = new Map();
  for (const entry of entries) {
    if (entry.key.includes('/osd/state/')) states.set(entry.key.split('/').at(-1), parseJson(entry.value));
    if (entry.key.includes('/osd/stats/')) stats.set(entry.key.split('/').at(-1), parseJson(entry.value));
  }
  return [...new Set([...states.keys(), ...stats.keys()])].sort().map((id) => {
    const state = states.get(id) || {};
    const stat = stats.get(id) || {};
    const nested = stat.stats && typeof stat.stats === 'object' ? stat.stats : stat;
    const lastSeenValue = state.time || state.timestamp || state.last_seen || state.lastSeen;
    const lastSeen = numeric(lastSeenValue);
    const recent = lastSeen > 0 && Date.now() / 1000 - lastSeen <= staleSeconds;
    const stateText = String(state.state || '').toLowerCase();
    const up = stateText.includes('down') ? false : stateText.includes('up') || recent || Boolean(state.up);
    return {
      name: id,
      status: up ? 'up' : 'down',
      node: state.node || state.host || state.hostname || nested.node || nested.host,
      usedBytes: numeric(nested.used ?? nested.used_bytes ?? nested.data_bytes),
      totalBytes: numeric(nested.total ?? nested.total_bytes ?? nested.size ?? nested.capacity)
    };
  });
}

function poolRows(entries) {
  const pools = new Map();
  const addPool = (record, fallback = '') => {
    if (!record || typeof record !== 'object') return;
    const id = String(record.id ?? record.pool_id ?? fallback ?? '');
    const name = String(record.name ?? record.pool_name ?? id);
    if (!id && !name) return;
    const stats = record.stats && typeof record.stats === 'object' ? record.stats : record;
    pools.set(id || name, {
      name: name || id,
      status: 'active',
      usedBytes: numeric(stats.used ?? stats.used_bytes ?? stats.usage ?? stats.data_bytes),
      totalBytes: numeric(stats.total ?? stats.total_bytes ?? stats.size ?? stats.capacity),
      objects: numeric(stats.objects ?? stats.object_count ?? stats.object_cnt)
    });
  };
  for (const entry of entries) {
    if (!entry.key.includes('/config/') && !entry.key.includes('/pool/')) continue;
    const value = parseJson(entry.value);
    if (Array.isArray(value.pools)) value.pools.forEach((pool) => addPool(pool));
    else addPool(value, entry.key.split('/').at(-1));
  }
  return [...pools.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function discoveryText(records) {
  return records
    .flatMap((record) => {
      const metadata = metadataFor(record);
      return [
        metadata.name,
        metadata.namespace,
        JSON.stringify(record.parameters || {}),
        JSON.stringify(record.data || {}),
        JSON.stringify(record.spec || {})
      ];
    })
    .join(' ');
}

async function discoverVitastorConfig(runtimeConfig) {
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const paths = [
    '/apis/storage.k8s.io/v1/storageclasses',
    '/api/v1/configmaps',
    '/api/v1/services',
    '/apis/discovery.k8s.io/v1/endpointslices'
  ];
  const settled = await Promise.allSettled(paths.map((path) => fetchKubeList(kubeConfig, path, true)));
  const records = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []));
  const text = discoveryText(records);
  const endpoints = extractEndpointCandidates(text).filter((value) => !/:2380(?:\/|$)/.test(value));
  const prefixMatch = text.match(/(?:etcd[_-]?prefix|prefix)["':=\s]+(\/[A-Za-z0-9_.-]+)/i);
  const poolIds = unique(
    records
      .filter((record) => /vitastor/i.test(String(record.provisioner || '')))
      .map((record) => String(record.parameters?.poolId || record.parameters?.pool_id || '').trim())
  );
  return {
    endpoints,
    prefix: prefixMatch?.[1] || '/vitastor',
    poolIds,
    evidence: endpoints.length > 0 ? ['Kubernetes StorageClass/ConfigMap/Service metadata'] : []
  };
}

function applyDiscoveredPoolCount(summary, discovered) {
  const poolIds = discovered?.poolIds || [];
  if (summary.summary.pools > 0 || poolIds.length === 0) return summary;
  return {
    ...summary,
    summary: {
      ...summary.summary,
      pools: poolIds.length,
      poolCountSource: 'Kubernetes StorageClass parameters'
    }
  };
}

function selectVitastorProfile(runtimeConfig) {
  const profiles = runtimeConfig.storageDrivers?.vitastor?.profiles || [];
  const fingerprint = runtimeConfig.clusterFingerprint || '';
  const context = runtimeConfig.kubeContext || '';
  return (
    profiles.find((profile) => profile.clusterFingerprint && profile.clusterFingerprint === fingerprint) ||
    profiles.find((profile) => !profile.clusterFingerprint && profile.context === context) ||
    profiles.find((profile) => !profile.clusterFingerprint && profile.context === '*') ||
    null
  );
}

function defaultVitastorConfig() {
  return {
    endpoints: [],
    prefix: '/vitastor',
    scheme: 'http',
    timeoutSeconds: 8,
    osdStaleSeconds: 30,
    auth: { username: '', password: '' },
    tls: { caFile: '', certFile: '', keyFile: '' },
    metrics: {
      scheme: 'http',
      timeoutSeconds: 5,
      auth: { mode: 'none', username: '', password: '', bearerToken: '', headers: {} }
    }
  };
}

function resolvedVitastorConfig(configured, discovered) {
  return {
    ...defaultVitastorConfig(),
    ...(configured || {}),
    endpoints: unique(
      [...(configured?.endpoints || []), ...(discovered?.endpoints || [])]
        .map((value) => withScheme(value, configured?.scheme || 'http'))
    ),
    prefix: configured?.prefix || discovered?.prefix || '/vitastor'
  };
}

async function loadVitastorMonitorInventory(config) {
  for (const endpoint of config.endpoints) {
    try {
      const entries = await etcdRange(endpoint, `${config.prefix.replace(/\/+$/, '')}/`, config);
      const master = entries.find((entry) => entry.key.endsWith('/mon/master'));
      const masterRecord = parseJson(master?.value || '');
      const masterId = String(masterRecord.id || masterRecord.member_id || master?.value || '').replace(/^"|"$/g, '');
      const members = entries
        .filter((entry) => entry.key.includes('/mon/member/'))
        .map((entry) => ({ id: entry.key.split('/').at(-1), record: parseJson(entry.value) }));
      if (members.length === 0) continue;
      const results = await Promise.all(members.map((member) => probeMonitor(member, config, masterId)));
      return results.map((result) => result.row);
    } catch {
      // Monitor inventory enriches CLI data and must not downgrade otherwise healthy metrics.
    }
  }
  return [];
}

async function enrichCliOverviewWithMonitors(overview, runtimeConfig, configured, discoverConfig = discoverVitastorConfig) {
  const discovered = await discoverConfig(runtimeConfig)
    .catch(() => ({ endpoints: [], prefix: '/vitastor', poolIds: [], evidence: [] }));
  const config = resolvedVitastorConfig(configured, discovered);
  if (config.endpoints.length === 0) return overview;

  const monitors = await loadVitastorMonitorInventory(config);
  if (monitors.length === 0) return overview;
  const reportedTotal = numeric(overview.summary?.monitors?.total);
  const monitorUp = monitors.filter((monitor) => monitor.status === 'up').length;
  return {
    ...overview,
    summary: {
      ...overview.summary,
      monitors: { up: monitorUp, total: Math.max(reportedTotal, monitors.length) }
    },
    details: {
      ...overview.details,
      monitors: emptyResourceList(monitors, overview.fetchedAt)
    }
  };
}

async function loadVitastorStorageDriverOverview(runtimeConfig, input = {}, dependencies = {}) {
  const fetchedAt = new Date().toISOString();
  const driver = String(input.driver || '').trim();
  if (!driver) return emptyDriverSummary('Unknown', fetchedAt, 'Select a storage driver.');
  if (!/vitastor/i.test(driver)) {
    return emptyDriverSummary(
      driver,
      fetchedAt,
      'Kubernetes inventory is available for this driver. Deep runtime metrics are not implemented for this provider.'
    );
  }

  const configured = selectVitastorProfile(runtimeConfig);
  let cliError = '';
  try {
    const cliOverview = await loadVitastorCliOverview(
      runtimeConfig,
      configured,
      fetchedAt,
      dependencies.execFile || executeFile
    );
    if (cliOverview) {
      return enrichCliOverviewWithMonitors(
        cliOverview,
        runtimeConfig,
        configured,
        dependencies.discoverVitastorConfig || discoverVitastorConfig
      );
    }
  } catch (error) {
    cliError = safeError(error);
  }
  const discovered = await discoverVitastorConfig(runtimeConfig).catch(() => ({ endpoints: [], prefix: '/vitastor', poolIds: [], evidence: [] }));
  const config = resolvedVitastorConfig(configured, discovered);
  if (config.endpoints.length === 0) {
    return applyDiscoveredPoolCount(emptyDriverSummary(
      'Vitastor',
      fetchedAt,
      'Vitastor detected, but neither the local CLI nor an etcd endpoint was available.',
      cliError ? [cliError] : []
    ), discovered);
  }

  const errors = [];
  let entries = [];
  for (const endpoint of config.endpoints) {
    try {
      entries = await etcdRange(endpoint, `${config.prefix.replace(/\/+$/, '')}/`, config);
      if (entries.length > 0) break;
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${safeError(error)}`);
    }
  }
  if (entries.length === 0) {
    return applyDiscoveredPoolCount(emptyDriverSummary(
      'Vitastor',
      fetchedAt,
      'Vitastor detected. Driver metrics are unavailable; check etcd connectivity from the agent host.',
      [...(cliError ? [cliError] : []), ...(errors.length > 0 ? errors : ['No Vitastor keys were returned by the configured endpoints.'])]
    ), discovered);
  }

  const master = entries.find((entry) => entry.key.endsWith('/mon/master'));
  const masterRecord = parseJson(master?.value || '');
  const masterId = String(masterRecord.id || masterRecord.member_id || master?.value || '').replace(/^"|"$/g, '');
  const members = entries
    .filter((entry) => entry.key.includes('/mon/member/'))
    .map((entry) => ({ id: entry.key.split('/').at(-1), record: parseJson(entry.value) }));
  const monitorResults = await Promise.all(members.map((member) => probeMonitor(member, config, masterId)));
  const metrics = { objectBytes: {}, objectCount: {}, readOps: 0, writeOps: 0 };
  monitorResults.forEach((result) => mergeMetrics(metrics, result.metrics));
  const statsEntry = entries.find((entry) => entry.key === `${config.prefix.replace(/\/+$/, '')}/stats`);
  const stats = parseJson(statsEntry?.value || '');
  const statsObjectCount = stats.object_counts && typeof stats.object_counts === 'object' ? stats.object_counts : {};
  const statsObjectBytes = stats.object_bytes && typeof stats.object_bytes === 'object' ? stats.object_bytes : {};
  Object.assign(metrics.objectCount, statsObjectCount);
  Object.assign(metrics.objectBytes, statsObjectBytes);
  const opStats = stats.op_stats && typeof stats.op_stats === 'object' ? stats.op_stats : {};
  metrics.readOps += numeric(opStats.read?.count ?? opStats.read);
  metrics.writeOps += numeric(opStats.write?.count ?? opStats.write);

  const monitors = monitorResults.map((result) => result.row);
  const osds = osdRows(entries, config.osdStaleSeconds);
  const pools = poolRows(entries);
  const usedBytes = pools.reduce((sum, pool) => sum + pool.usedBytes, 0) || numeric(metrics.objectBytes.object);
  const totalBytes = pools.reduce((sum, pool) => sum + pool.totalBytes, 0);
  const dataState = {
    clean: numeric(metrics.objectCount.clean),
    degraded: numeric(metrics.objectCount.degraded),
    incomplete: numeric(metrics.objectCount.incomplete),
    misplaced: numeric(metrics.objectCount.misplaced)
  };
  const monitorUp = monitors.filter((row) => row.status === 'up').length;
  const osdUp = osds.filter((row) => row.status === 'up').length;
  const hasCritical = osds.some((row) => row.status !== 'up') || dataState.incomplete > 0;
  const hasWarning = monitors.some((row) => row.status !== 'up') || dataState.degraded > 0 || dataState.misplaced > 0;
  const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  return {
    namespaceScope: null,
    fetchedAt,
    issues: errors.map((message) => ({ code: 'partial_data', message, retryable: true, scope: 'storage-driver' })),
    partial: errors.length > 0,
    availability: errors.length > 0 ? 'degraded' : 'available',
    availableDrivers: [],
    driver: {
      name: 'Vitastor',
      providerId: driver,
      type: 'csi',
      status,
      lastUpdate: fetchedAt,
      metricsSource: configured ? 'configured-etcd' : 'kubernetes-discovery',
      metricsSourceDetail: config.endpoints[0] ? new URL(config.endpoints[0]).host : undefined,
      features: { runtimeOverview: true, autoDiscovery: true, manualConfig: true }
    },
    summary: {
      monitors: { up: monitorUp, total: monitors.length },
      osd: { up: osdUp, total: osds.length },
      pools: pools.length || discovered.poolIds.length,
      capacity: { usedBytes, totalBytes },
      rawCapacity: { usedBytes: 0, totalBytes: 0 },
      poolCountSource: pools.length > 0 ? 'vitastor etcd' : 'Kubernetes StorageClass parameters'
    },
    dataState,
    io: { readOps: metrics.readOps, writeOps: metrics.writeOps },
    details: {
      monitors: emptyResourceList(monitors, fetchedAt),
      osds: emptyResourceList(osds, fetchedAt),
      pools: emptyResourceList(pools, fetchedAt)
    },
    message: configured
      ? 'Vitastor metrics loaded with the matching agent configuration profile.'
      : `Vitastor metrics loaded through Kubernetes auto-discovery${discovered.evidence.length ? ` (${discovered.evidence[0]})` : ''}.`,
    errors
  };
}

function withStorageOverviewV2(overview, backendKind) {
  return {
    ...overview,
    schemaVersion: 2,
    capabilities: {
      kubernetesInventory: true,
      nodeRegistration: true,
      attachments: true,
      topologyCapacity: true,
      backendMetrics: backendKind !== 'none'
    },
    backendSections: overview.backendSections || [],
    driver: {
      ...overview.driver,
      backendKind,
      features: {
        ...overview.driver?.features,
        kubernetesHealth: true,
        backendMetrics: backendKind !== 'none'
      }
    }
  };
}

export async function loadLocalStorageDriverOverview(runtimeConfig, input = {}, dependencies = {}) {
  const driver = String(input.driver || '').trim();
  if (/^(rook-ceph|ceph)$/i.test(driver) || /(?:rbd|cephfs)\.csi\.ceph\.com/i.test(driver)) {
    if (runtimeConfig.storageDrivers?.ceph?.enabled !== true) return withStorageOverviewV2(emptyDriverSummary('Ceph', new Date().toISOString(), 'Deep Ceph metrics are disabled. Set storage.drivers.ceph.enabled to true and restart the agent.'), 'none');
    return loadCephStorageOverview(runtimeConfig, input, dependencies);
  }
  if (/longhorn/i.test(driver)) {
    if (runtimeConfig.storageDrivers?.longhorn?.enabled !== true) return withStorageOverviewV2(emptyDriverSummary('Longhorn', new Date().toISOString(), 'Deep Longhorn metrics are disabled. Set storage.drivers.longhorn.enabled to true and restart the agent.'), 'none');
    return loadLonghornStorageOverview(runtimeConfig, input, dependencies);
  }
  if (/openebs|mayastor|local\.csi\.openebs|zfs\.csi\.openebs/i.test(driver)) {
    if (runtimeConfig.storageDrivers?.openebs?.enabled !== true) return withStorageOverviewV2(emptyDriverSummary('OpenEBS', new Date().toISOString(), 'Deep OpenEBS metrics are disabled. Set storage.drivers.openebs.enabled to true and restart the agent.'), 'none');
    return loadOpenEbsStorageOverview(runtimeConfig, input, dependencies);
  }
  if (/portworx|pxd\.openstorage\.org/i.test(driver)) {
    if (runtimeConfig.storageDrivers?.portworx?.enabled !== true) return withStorageOverviewV2(emptyDriverSummary('Portworx', new Date().toISOString(), 'Deep Portworx metrics are disabled. Set storage.drivers.portworx.enabled to true and restart the agent.'), 'none');
    return loadPortworxStorageOverview(runtimeConfig, input, dependencies);
  }
  if (/vitastor/i.test(driver)) {
    if (runtimeConfig.storageDrivers?.vitastor?.enabled !== true) return withStorageOverviewV2(emptyDriverSummary('Vitastor', new Date().toISOString(), 'Deep Vitastor metrics are disabled. Set storage.drivers.vitastor.enabled to true and restart the agent.'), 'none');
    return withStorageOverviewV2(await loadVitastorStorageDriverOverview(runtimeConfig, input, dependencies), 'vitastor');
  }
  const fetchedAt = new Date().toISOString();
  return withStorageOverviewV2(
    emptyDriverSummary(
      driver || 'Unknown',
      fetchedAt,
      'Kubernetes CSI health is available. This provider does not publish a supported backend metrics adapter.'
    ),
    'none'
  );
}
