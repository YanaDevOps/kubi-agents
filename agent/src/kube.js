import { KubeConfig } from '@kubernetes/client-node';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { detectProviderMetadata } from '../../src/shared/provider-detection.js';
import {
  BACKUP_RESOURCE_DEFINITIONS,
  buildUniversalBackupActivitySummary
} from '../../src/shared/backup-activity.js';
import { deriveRuntimeTargetKey } from '../../src/shared/runtime-target.js';
import {
  buildGatewayApiValidationItems,
  gatewayApiDefinitionsFromCrds
} from '../../src/shared/gateway-api-validation.js';
import {
  buildPortsTruthSummary,
  buildTrafficIntentSummary,
  buildCniPluginsSummary,
  buildVipLoadBalancerSummary,
  buildRbacExplorerSummary,
  buildPortsValidationItems,
  buildRbacValidationItems,
  buildTopologyGraphSummary
} from '../../src/cluster-runtime/relationship-runtime.js';

const PAGE_LIMIT = 500;
const MAX_PAGES = 10;
export const VALIDATED_KUBECONFIG_CACHE_TTL_MS = 2_000;
const PRIVATE_HOST_PATTERNS = ['.local', '.internal', '.cluster.local'];
const validatedKubeConfigCache = new Map();
const DELIVERY_RESOURCE_DEFINITIONS = [
  { providerId: 'argocd', providerName: 'Argo CD', group: 'argoproj.io', versions: ['v1alpha1'], resource: 'applications', kind: 'Application' },
  {
    providerId: 'flux',
    providerName: 'Flux',
    group: 'kustomize.toolkit.fluxcd.io',
    versions: ['v1', 'v1beta2'],
    resource: 'kustomizations',
    kind: 'Kustomization'
  },
  {
    providerId: 'flux',
    providerName: 'Flux',
    group: 'helm.toolkit.fluxcd.io',
    versions: ['v2', 'v2beta2'],
    resource: 'helmreleases',
    kind: 'HelmRelease'
  },
  {
    providerId: 'flux',
    providerName: 'Flux',
    group: 'source.toolkit.fluxcd.io',
    versions: ['v1', 'v1beta2'],
    resource: 'gitrepositories',
    kind: 'GitRepository',
    source: true
  },
  {
    providerId: 'flux',
    providerName: 'Flux',
    group: 'source.toolkit.fluxcd.io',
    versions: ['v1', 'v1beta2'],
    resource: 'helmrepositories',
    kind: 'HelmRepository',
    source: true
  },
  {
    providerId: 'flux',
    providerName: 'Flux',
    group: 'source.toolkit.fluxcd.io',
    versions: ['v1', 'v1beta2'],
    resource: 'ocirepositories',
    kind: 'OCIRepository',
    source: true
  }
];

function sanitizeKubeError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unable to read cluster data through the local agent.';
}

function baseServerUrl(kubeConfig) {
  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error('The local kubeconfig does not define a current cluster server.');
  }
  return new URL(cluster.server);
}

function nodeHeaders(headers) {
  if (!headers) return undefined;
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }
  return headers;
}

function requestKubeApi(url, requestOptions) {
  const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!transport) {
    throw new Error(`Unsupported Kubernetes API protocol: ${url.protocol}`);
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      ...requestOptions,
      headers: nodeHeaders(requestOptions.headers)
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.setTimeout(Number(requestOptions.timeout) || 10000);
    request.on('timeout', () => request.destroy(new Error('Kubernetes API request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

export async function fetchKubeJson(kubeConfig, pathWithQuery) {
  const url = new URL(pathWithQuery, baseServerUrl(kubeConfig));
  const requestOptions = await kubeConfig.applyToFetchOptions({
    method: 'GET',
    headers: {
      accept: 'application/json'
    }
  });

  const response = await requestKubeApi(url, requestOptions);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Kubernetes API responded with HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    return {};
  }
}

export async function fetchKubeText(kubeConfig, pathWithQuery) {
  const url = new URL(pathWithQuery, baseServerUrl(kubeConfig));
  const requestOptions = await kubeConfig.applyToFetchOptions({
    method: 'GET',
    headers: {
      accept: '*/*'
    }
  });

  const response = await requestKubeApi(url, requestOptions);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Kubernetes API responded with HTTP ${response.status}.`);
  }
  return response.body;
}

export async function fetchKubeList(kubeConfig, path, allowMissing = false) {
  const items = [];
  let page = 0;
  let continueToken = null;

  while (page < MAX_PAGES) {
    const [pathname, rawSearch = ''] = path.split('?');
    const search = new URLSearchParams(rawSearch);
    search.set('limit', String(PAGE_LIMIT));
    if (continueToken) {
      search.set('continue', continueToken);
    }

    let payload;
    try {
      payload = await fetchKubeJson(kubeConfig, `${pathname}?${search.toString()}`);
    } catch (error) {
      if (allowMissing && error instanceof Error && /HTTP 404/.test(error.message)) {
        return { items, truncated: false, missing: true };
      }
      throw error;
    }
    if (Array.isArray(payload.items)) {
      items.push(...payload.items);
    }

    continueToken = payload.metadata && typeof payload.metadata.continue === 'string' ? payload.metadata.continue : null;
    if (!continueToken) {
      return { items, truncated: false };
    }
    page += 1;
  }

  return { items, truncated: true };
}

export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function asRecordArray(value) {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)).filter(Boolean) : [];
}

function asStringRecord(value) {
  const record = asRecord(value);
  if (!record) return {};
  return Object.entries(record).reduce((current, [key, entry]) => {
    if (typeof entry === 'string') {
      current[key] = entry;
    }
    return current;
  }, {});
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseCpuMilli(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const match = value.trim().match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = match[2] || '';
  if (suffix === 'n') return amount / 1_000_000;
  if (suffix === 'u') return amount / 1_000;
  if (suffix === 'm') return amount;
  return amount * 1000;
}

function parseBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const match = value.trim().match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = match[2] || '';
  const binary = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const decimal = { K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6 };
  if (suffix in binary) return amount * binary[suffix];
  if (suffix in decimal) return amount * decimal[suffix];
  return amount;
}

export function metadataFor(record) {
  const metadata = asRecord(record.metadata);
  return {
    name: stringOrUndefined(metadata?.name) || 'unknown',
    namespace: stringOrUndefined(metadata?.namespace) || 'default',
    createdAt: stringOrUndefined(metadata?.creationTimestamp),
    labels: asStringRecord(metadata?.labels),
    annotations: asStringRecord(metadata?.annotations),
    ownerReferences: asRecordArray(metadata?.ownerReferences)
  };
}

function statusConditions(record) {
  return asRecordArray(asRecord(record.status)?.conditions);
}

function isPodReady(pod) {
  const status = asRecord(pod.status);
  const phase = stringOrUndefined(status?.phase) || 'Unknown';
  if (phase !== 'Running') {
    return false;
  }

  const readyCondition = statusConditions({ status }).find((condition) => condition.type === 'Ready');
  if (readyCondition) {
    return readyCondition.status === 'True';
  }

  const containerStatuses = asRecordArray(status?.containerStatuses);
  if (containerStatuses.length === 0) {
    return true;
  }

  return containerStatuses.every((entry) => entry.ready === true);
}

function buildPodPhaseSummary(pods) {
  const podRecords = asRecordArray(pods);
  const phaseCounts = {};
  let ready = 0;
  let crashLoopBackOff = 0;

  for (const pod of podRecords) {
    const status = asRecord(pod.status);
    const phase = stringOrUndefined(status?.phase) || 'Unknown';
    phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;

    if (isPodReady(pod)) {
      ready += 1;
    }

    const crashLooping = asRecordArray(status?.containerStatuses).some((entry) => {
      const waiting = asRecord(asRecord(entry.state)?.waiting);
      return waiting?.reason === 'CrashLoopBackOff';
    });
    if (crashLooping) {
      crashLoopBackOff += 1;
    }
  }

  return {
    total: podRecords.length,
    ready,
    notReady: Math.max(0, podRecords.length - ready),
    phaseCounts,
    crashLoopBackOff
  };
}

function buildAvailability(issues, partial) {
  return issues.length === 0 && !partial ? 'available' : 'degraded';
}

function buildResourceList(items, fetchedAt, issues = [], partial = false) {
  return {
    items,
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial)
  };
}

function workloadHealth(desired, ready, available) {
  if (desired === 0) return 'pending';
  if (ready >= desired && available >= Math.min(desired, available || desired)) return 'healthy';
  if (ready === 0 && available === 0) return 'pending';
  return 'warning';
}

function labelsMatchSelector(labels, selector) {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => labels[key] === value);
}

function normalizeNamespace(record) {
  const meta = metadataFor(record);
  const status = asRecord(record.status);
  return {
    name: meta.name,
    status: stringOrUndefined(status?.phase) || 'Unknown',
    createdAt: meta.createdAt,
    labels: meta.labels,
    labelsCount: Object.keys(meta.labels).length
  };
}

function nodeRoles(labels) {
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith('node-role.kubernetes.io/'))
    .map((key) => key.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);

  if (labels['node-role.kubernetes.io/control-plane'] !== undefined && !roles.includes('control-plane')) {
    roles.push('control-plane');
  }
  if (labels['node-role.kubernetes.io/master'] !== undefined && !roles.includes('master')) {
    roles.push('master');
  }

  return roles.sort();
}

function nodePressures(record) {
  const conditions = statusConditions(record);
  const hasTrue = (type) => conditions.some((condition) => condition.type === type && condition.status === 'True');
  return {
    memoryPressure: hasTrue('MemoryPressure'),
    diskPressure: hasTrue('DiskPressure'),
    pidPressure: hasTrue('PIDPressure'),
    networkUnavailable: hasTrue('NetworkUnavailable')
  };
}

function nodeCapacity(record) {
  const values = asStringRecord(record);
  return {
    cpu: values.cpu,
    memory: values.memory,
    pods: values.pods
  };
}

function nodeAddresses(addresses, type) {
  return asRecordArray(addresses)
    .filter((entry) => entry.type === type)
    .map((entry) => stringOrUndefined(entry.address))
    .filter(Boolean);
}

function normalizeNode(record) {
  const meta = metadataFor(record);
  const status = asRecord(record.status);
  const spec = asRecord(record.spec);
  const nodeInfo = asRecord(status?.nodeInfo);
  const capacity = asRecord(status?.capacity) || {};
  const allocatable = asRecord(status?.allocatable) || {};
  const podCidr = stringOrUndefined(spec?.podCIDR);
  const podCidrs = Array.isArray(spec?.podCIDRs) ? spec.podCIDRs.filter((value) => typeof value === 'string' && value.trim()) : [];

  return {
    name: meta.name,
    ready: statusConditions(record).some((condition) => condition.type === 'Ready' && condition.status === 'True'),
    roles: nodeRoles(meta.labels),
    kubeletVersion: stringOrUndefined(nodeInfo?.kubeletVersion),
    osImage: stringOrUndefined(nodeInfo?.osImage),
    architecture: stringOrUndefined(nodeInfo?.architecture),
    createdAt: meta.createdAt,
    taints: asRecordArray(spec?.taints).map((taint) => {
      const key = stringOrUndefined(taint.key) || 'taint';
      const effect = stringOrUndefined(taint.effect) || 'UnknownEffect';
      const value = stringOrUndefined(taint.value);
      return value ? `${key}=${value}:${effect}` : `${key}:${effect}`;
    }),
    conditions: nodePressures(record),
    capacity: nodeCapacity(capacity),
    allocatable: nodeCapacity(allocatable),
    cpuCapacityMilli: parseCpuMilli(capacity.cpu),
    cpuAllocatableMilli: parseCpuMilli(allocatable.cpu),
    memoryCapacityBytes: parseBytes(capacity.memory),
    memoryAllocatableBytes: parseBytes(allocatable.memory),
    ...(podCidr ? { podCidr } : {}),
    podCidrs,
    internalIps: nodeAddresses(status?.addresses, 'InternalIP'),
    externalIps: nodeAddresses(status?.addresses, 'ExternalIP')
  };
}

function normalizeWorkload(kind, record, pods, podsAvailable) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const selector = asStringRecord(asRecord(spec?.selector)?.matchLabels);

  const desired = kind === 'DaemonSet' ? numberOrZero(status?.desiredNumberScheduled) : numberOrZero(status?.replicas ?? spec?.replicas);
  const ready = kind === 'DaemonSet' ? numberOrZero(status?.numberReady) : numberOrZero(status?.readyReplicas);
  const updated = kind === 'DaemonSet' ? numberOrZero(status?.updatedNumberScheduled) : numberOrZero(status?.updatedReplicas);
  const available = kind === 'DaemonSet' ? numberOrZero(status?.numberAvailable) : numberOrZero(status?.availableReplicas);

  const matchingPods = podsAvailable
    ? pods.filter((pod) => {
        const podMeta = metadataFor(pod);
        return podMeta.namespace === meta.namespace && labelsMatchSelector(podMeta.labels, selector);
      })
    : [];

  return {
    kind,
    name: meta.name,
    namespace: meta.namespace,
    selector,
    labels: meta.labels,
    annotations: meta.annotations,
    desired,
    ready,
    updated,
    available,
    createdAt: meta.createdAt,
    health: workloadHealth(desired, ready, available),
    ...(podsAvailable ? { podSummary: buildPodPhaseSummary(matchingPods) } : {})
  };
}

function endpointAvailabilityForService(service, endpointSlices, endpointsAvailable) {
  if (!endpointsAvailable) {
    return {
      sliceCount: 0,
      addresses: 0,
      readyAddresses: 0,
      status: 'unknown'
    };
  }

  const meta = metadataFor(service);
  const slices = endpointSlices.filter((entry) => {
    const sliceMeta = metadataFor(entry);
    if (sliceMeta.namespace !== meta.namespace) return false;
    return asStringRecord(asRecord(entry.metadata)?.labels)['kubernetes.io/service-name'] === meta.name;
  });

  let addresses = 0;
  let readyAddresses = 0;
  for (const slice of slices) {
    for (const endpoint of asRecordArray(slice.endpoints)) {
      const endpointAddresses = Array.isArray(endpoint.addresses) ? endpoint.addresses : [];
      addresses += endpointAddresses.length;
      const ready = asRecord(endpoint.conditions)?.ready;
      if (ready !== false) {
        readyAddresses += endpointAddresses.length;
      }
    }
  }

  return {
    sliceCount: slices.length,
    addresses,
    readyAddresses,
    status: readyAddresses === 0 ? 'missing' : readyAddresses < addresses ? 'partial' : 'ready'
  };
}

function serviceNameForEndpointSlice(slice) {
  return asStringRecord(asRecord(slice.metadata)?.labels)['kubernetes.io/service-name'] || '';
}

function normalizeEndpointSlice(slice) {
  const meta = metadataFor(slice);
  const addressList = asRecordArray(slice.endpoints).flatMap((endpoint) =>
    (Array.isArray(endpoint.addresses) ? endpoint.addresses : []).filter((address) => typeof address === 'string')
  );
  const readyCount = asRecordArray(slice.endpoints).reduce((count, endpoint) => {
    const addresses = Array.isArray(endpoint.addresses) ? endpoint.addresses : [];
    return asRecord(endpoint.conditions)?.ready === false ? count : count + addresses.length;
  }, 0);
  const ports = asRecordArray(slice.ports).map((port) => {
    const name = stringOrUndefined(port.name);
    const number = typeof port.port === 'number' ? String(port.port) : stringOrUndefined(port.port);
    const protocol = stringOrUndefined(port.protocol) || 'TCP';
    return [name, number ? `${number}/${protocol}` : protocol].filter(Boolean).join(': ');
  });

  return {
    name: meta.name,
    namespace: meta.namespace,
    serviceName: serviceNameForEndpointSlice(slice),
    addressType: stringOrUndefined(slice.addressType),
    addresses: addressList.length,
    addressList: addressList.filter((value, index, values) => values.indexOf(value) === index),
    readyCount,
    ports,
    createdAt: meta.createdAt
  };
}

function normalizeService(record, endpointSlices, endpointsAvailable) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);

  const externalIps = [
    ...((Array.isArray(spec?.externalIPs) ? spec.externalIPs : []).filter((value) => typeof value === 'string')),
    ...asRecordArray(status?.loadBalancer?.ingress).flatMap((entry) =>
      [stringOrUndefined(entry.ip), stringOrUndefined(entry.hostname)].filter(Boolean)
    )
  ].filter((value, index, values) => values.indexOf(value) === index);

  const clusterIps = [
    ...((Array.isArray(spec?.clusterIPs) ? spec.clusterIPs : []).filter((value) => typeof value === 'string')),
    ...(typeof spec?.clusterIP === 'string' && spec.clusterIP !== 'None' ? [spec.clusterIP] : [])
  ].filter((value, index, values) => values.indexOf(value) === index);

  return {
    name: meta.name,
    namespace: meta.namespace,
    type: stringOrUndefined(spec?.type) || 'ClusterIP',
    createdAt: meta.createdAt,
    clusterIps,
    externalIps,
    selector: asStringRecord(spec?.selector),
    ports: asRecordArray(spec?.ports).map((port) => ({
      name: stringOrUndefined(port.name),
      protocol: stringOrUndefined(port.protocol),
      port: numberOrZero(port.port),
      ...(port.targetPort !== undefined
        ? { targetPort: typeof port.targetPort === 'number' ? port.targetPort : String(port.targetPort) }
        : {}),
      ...(typeof port.nodePort === 'number' ? { nodePort: port.nodePort } : {}),
      ...(typeof port.appProtocol === 'string' ? { appProtocol: port.appProtocol } : {})
    })),
    endpointAvailability: endpointAvailabilityForService(record, endpointSlices, endpointsAvailable)
  };
}

export function namespacePath(clusterPath, namespacedPath, namespaceScope) {
  return namespaceScope && namespaceScope !== 'all'
    ? namespacedPath.replace(':namespace', encodeURIComponent(namespaceScope))
    : clusterPath;
}

function truncationIssue(resource, message) {
  return { code: 'truncated_results', message, retryable: true, resource };
}

function partialIssue(resource, message) {
  return { code: 'partial_resource_failure', message, retryable: true, resource };
}

function settledSection(result, resource, missingMessage, truncationMessage, issues) {
  if (result.status === 'fulfilled') {
    if (result.value.truncated) {
      issues.push(truncationIssue(resource, truncationMessage));
    }
    return {
      items: result.value.items,
      partial: result.value.truncated
    };
  }

  issues.push(partialIssue(resource, missingMessage));
  return {
    items: [],
    partial: true
  };
}

function normalizeServerUrl(serverUrl) {
  const trimmed = typeof serverUrl === 'string' ? serverUrl.trim() : '';
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function maskEndpoint(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized) return typeof serverUrl === 'string' ? serverUrl.trim() : '';
  return new URL(normalized).origin;
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [, aRaw, bRaw] = match;
  const a = Number(aRaw);
  const b = Number(bRaw);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateEndpoint(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  if (hostname.endsWith('.localhost')) return true;
  if (PRIVATE_HOST_PATTERNS.some((pattern) => hostname.endsWith(pattern))) return true;
  if (!hostname.includes('.')) return true;
  if (isPrivateIpv4(hostname)) return true;
  return false;
}

function discoveredAuthKind(user) {
  const record = asRecord(user) || {};
  const hasExec = Boolean(asRecord(record.exec));
  const hasClientCert =
    typeof record['client-certificate-data'] === 'string' ||
    typeof record['client-key-data'] === 'string' ||
    typeof record['client-certificate'] === 'string' ||
    typeof record['client-key'] === 'string';
  if (hasExec) return 'exec';
  if (hasClientCert) return 'client-cert';
  if (typeof record.token === 'string' && record.token.trim()) return 'token';
  return 'unknown';
}

function classifyDirectSupport(serverUrl, authKind, hasCustomCa, insecureSkipTlsVerify, hasToken) {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  if (!normalizedUrl) {
    return { state: 'invalid', reason: 'missing_server' };
  }
  const parsed = new URL(normalizedUrl);
  if (parsed.protocol !== 'https:') {
    return { state: 'invalid', reason: 'non_https_endpoint' };
  }
  if (authKind === 'exec') {
    return { state: 'agent-required', reason: 'exec_auth' };
  }
  if (authKind === 'client-cert') {
    return { state: 'agent-required', reason: 'client_cert' };
  }
  if (authKind !== 'token') {
    return { state: 'agent-required', reason: 'unsupported_auth' };
  }
  if (!hasToken) {
    return { state: 'invalid', reason: 'missing_token' };
  }
  if (isPrivateEndpoint(normalizedUrl)) {
    return { state: 'agent-required', reason: 'private_endpoint' };
  }
  if (hasCustomCa) {
    return { state: 'agent-required', reason: 'custom_ca' };
  }
  if (insecureSkipTlsVerify) {
    return { state: 'limited', reason: 'cors_unknown' };
  }
  return { state: 'supported', reason: 'token_auth' };
}

function kubeconfigSourceLabel(kind, resolvedPath, index = 0) {
  const kubeDir = path.join(os.homedir(), '.kube');
  const basename = path.basename(resolvedPath);
  if (kind === 'configured') {
    return `Configured kubeconfig: ${basename}`;
  }
  if (kind === 'env') {
    return `KUBECONFIG[${index + 1}]: ${basename}`;
  }
  if (resolvedPath === path.join(kubeDir, 'config')) {
    return '~/.kube/config';
  }
  if (resolvedPath.startsWith(`${kubeDir}${path.sep}`)) {
    return `~/.kube/${basename}`;
  }
  return basename;
}

function listDiscoverySourceFiles(runtimeConfig) {
  const kubeDir = path.join(os.homedir(), '.kube');
  const seen = new Set();
  const sources = [];

  function addSource(filePath, kind, index = 0) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return;
    }

    const resolvedPath = path.resolve(filePath.trim());
    if (seen.has(resolvedPath)) {
      return;
    }

    seen.add(resolvedPath);
    sources.push({
      path: resolvedPath,
      label: kubeconfigSourceLabel(kind, resolvedPath, index)
    });
  }

  if (runtimeConfig.kubeconfigPath) {
    addSource(runtimeConfig.kubeconfigPath, 'configured');
  }

  for (const [index, configuredPath] of (runtimeConfig.kubeconfigPaths || []).entries()) {
    addSource(configuredPath, 'configured', index);
  }

  for (const directory of runtimeConfig.kubeconfigDirectories || []) {
    try {
      fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(ya?ml|conf)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
        .forEach((entry) => addSource(path.join(directory, entry), 'directory'));
    } catch {
      // Discovery reports unreadable configured sources after attempting explicit files.
    }
  }

  if (process.env.KUBECONFIG) {
    process.env.KUBECONFIG.split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry, index) => addSource(entry, 'env', index));
  }

  addSource(path.join(kubeDir, 'config'), 'default');

  try {
    const entries = fs
      .readdirSync(kubeDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(ya?ml|conf)$/i.test(name) && name !== 'config')
      .sort((left, right) => left.localeCompare(right));

    for (const entry of entries) {
      addSource(path.join(kubeDir, entry), 'directory');
    }
  } catch {
    // Ignore missing or unreadable kube directories during discovery.
  }

  return sources;
}

function parseKubeconfigSourceFile(source) {
  try {
    const raw = fs.readFileSync(source.path, 'utf8');
    const parsed = parseYaml(raw);
    const record = asRecord(parsed);
    if (!record) {
      return { source, error: 'Invalid kubeconfig structure.' };
    }

    return {
      source,
      document: {
        clusters: Array.isArray(record.clusters) ? record.clusters : [],
        users: Array.isArray(record.users) ? record.users : [],
        contexts: Array.isArray(record.contexts) ? record.contexts : [],
        currentContext: typeof record['current-context'] === 'string' ? record['current-context'] : null
      }
    };
  } catch (error) {
    return {
      source,
      error: 'Unreadable kubeconfig.'
    };
  }
}

function normalizeSourceRelativeFileReference(record, key, sourcePath) {
  const reference = stringOrUndefined(record[key]);
  if (!reference || path.isAbsolute(reference)) {
    return;
  }
  record[key] = path.resolve(path.dirname(sourcePath), reference);
}

function normalizeClusterFileReferences(cluster, sourcePath) {
  normalizeSourceRelativeFileReference(cluster, 'certificate-authority', sourcePath);
  normalizeSourceRelativeFileReference(cluster, 'caFile', sourcePath);
  return cluster;
}

function normalizeUserFileReferences(user, sourcePath) {
  normalizeSourceRelativeFileReference(user, 'client-certificate', sourcePath);
  normalizeSourceRelativeFileReference(user, 'certFile', sourcePath);
  normalizeSourceRelativeFileReference(user, 'client-key', sourcePath);
  normalizeSourceRelativeFileReference(user, 'keyFile', sourcePath);
  return user;
}

function mergeDiscoveredKubeconfigSources(runtimeConfig) {
  const contextsByName = new Map();
  const clustersByName = new Map();
  const usersByName = new Map();
  const duplicateContextNames = new Set();
  const duplicateClusterNames = new Set();
  const duplicateUserNames = new Set();
  const warnings = [];
  let currentContextName = runtimeConfig.kubeContext || null;
  let parsedSourceCount = 0;

  const sources = listDiscoverySourceFiles(runtimeConfig);
  for (const source of sources) {
    const parsed = parseKubeconfigSourceFile(source);
    if (!parsed.document) {
      warnings.push(`Ignored ${source.label}: ${parsed.error}`);
      continue;
    }

    parsedSourceCount += 1;

    for (const clusterEntry of parsed.document.clusters) {
      const name = stringOrUndefined(clusterEntry?.name);
      if (!name) continue;
      const cluster = normalizeClusterFileReferences(asRecord(clusterEntry.cluster) || {}, source.path);
      const existingCluster = clustersByName.get(name);
      if (existingCluster) {
        if (!isDeepStrictEqual(existingCluster.cluster, cluster)) duplicateClusterNames.add(name);
        continue;
      }
      clustersByName.set(name, {
        name,
        cluster,
        sourceFileLabel: source.label
      });
    }

    for (const userEntry of parsed.document.users) {
      const name = stringOrUndefined(userEntry?.name);
      if (!name) continue;
      const user = normalizeUserFileReferences(asRecord(userEntry.user) || {}, source.path);
      const existingUser = usersByName.get(name);
      if (existingUser) {
        if (!isDeepStrictEqual(existingUser.user, user)) duplicateUserNames.add(name);
        continue;
      }
      usersByName.set(name, {
        name,
        user,
        sourceFileLabel: source.label
      });
    }

    for (const contextEntry of parsed.document.contexts) {
      const name = stringOrUndefined(contextEntry?.name);
      if (!name) continue;
      const context = asRecord(contextEntry.context) || {};
      const existingContext = contextsByName.get(name);
      if (existingContext) {
        if (!isDeepStrictEqual(existingContext.context, context)) duplicateContextNames.add(name);
        continue;
      }
      contextsByName.set(name, {
        name,
        context,
        sourceFileLabel: source.label
      });
    }

    if (parsed.document.currentContext) {
      currentContextName = parsed.document.currentContext;
    }
  }

  if (duplicateContextNames.size > 0) {
    warnings.push(`Conflicting context names across kubeconfig sources: ${Array.from(duplicateContextNames).sort().join(', ')}.`);
  }
  if (duplicateClusterNames.size > 0) {
    warnings.push(`Conflicting cluster names across kubeconfig sources: ${Array.from(duplicateClusterNames).sort().join(', ')}.`);
  }
  if (duplicateUserNames.size > 0) {
    warnings.push(`Conflicting user names across kubeconfig sources: ${Array.from(duplicateUserNames).sort().join(', ')}.`);
  }

  return {
    currentContextName,
    sourceCount: parsedSourceCount,
    warnings,
    bundleLabel:
      parsedSourceCount > 1
        ? `Discovered from merged kubeconfig bundle (${parsedSourceCount} files)`
        : parsedSourceCount === 1
          ? `Discovered from ${Array.from(contextsByName.values())[0]?.sourceFileLabel ?? Array.from(clustersByName.values())[0]?.sourceFileLabel ?? 'local kubeconfig'}`
          : 'Agent local kubeconfig discovery',
    contexts: Array.from(contextsByName.values()).sort((left, right) => left.name.localeCompare(right.name)),
    duplicateContextNames,
    duplicateClusterNames,
    duplicateUserNames,
    clustersByName,
    usersByName
  };
}

function digestTransportValue(value) {
  const normalized = stringOrUndefined(value);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

function digestTransportFile(value) {
  const filePath = stringOrUndefined(value);
  if (!filePath) {
    return '';
  }
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function discoveredClusterFingerprint(contextEntry, clusterRecord) {
  const certificateAuthorityReference = clusterRecord.caFile || clusterRecord['certificate-authority'];
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        contextName: contextEntry.name || '',
        clusterName: contextEntry.context?.cluster || '',
        server: stringOrUndefined(clusterRecord.server) || '',
        certificateAuthorityDataDigest: digestTransportValue(
          clusterRecord.caData || clusterRecord['certificate-authority-data']
        ),
        certificateAuthorityReferenceDigest: digestTransportValue(
          certificateAuthorityReference
        ),
        certificateAuthorityFileContentDigest: digestTransportFile(certificateAuthorityReference),
        insecureSkipTlsVerify:
          clusterRecord.skipTLSVerify === true || clusterRecord['insecure-skip-tls-verify'] === true,
        tlsServerName: stringOrUndefined(clusterRecord.tlsServerName || clusterRecord['tls-server-name']) || '',
        proxyUrl: stringOrUndefined(clusterRecord.proxyUrl || clusterRecord['proxy-url']) || ''
      })
    )
    .digest('hex')}`;
}

function sourceFilesSignature(runtimeConfig) {
  const sources = listDiscoverySourceFiles(runtimeConfig);
  const caFiles = new Set();

  for (const source of sources) {
    const parsed = parseKubeconfigSourceFile(source);
    for (const clusterEntry of parsed.document?.clusters ?? []) {
      const cluster = normalizeClusterFileReferences(asRecord(clusterEntry?.cluster) || {}, source.path);
      const caFile = stringOrUndefined(cluster.caFile || cluster['certificate-authority']);
      if (caFile) caFiles.add(caFile);
    }
  }

  const fileSignature = (filePath, includeContentDigest = false) => {
    try {
      const stat = fs.statSync(filePath);
      const digest = includeContentDigest ? digestTransportFile(filePath) : '';
      return `${filePath}:${stat.mtimeMs}:${stat.size}:${digest}`;
    } catch {
      return `${filePath}:missing`;
    }
  };

  return [
    ...sources.map((source) => fileSignature(source.path)),
    ...Array.from(caFiles).sort().map((filePath) => fileSignature(filePath, true))
  ].join('|');
}

function buildDiscoveredAccessCandidates(merged) {
  return merged.contexts.map((contextEntry) => {
    const context = contextEntry.context || {};
    const cluster = merged.clustersByName.get(context.cluster) || { cluster: {} };
    const user = merged.usersByName.get(context.user) || { user: {} };
    const clusterRecord = cluster.cluster || {};
    const userRecord = user.user || {};
    const authKind = discoveredAuthKind(userRecord);
    const hasCustomCa =
      typeof clusterRecord['caData'] === 'string' ||
      typeof clusterRecord['certificate-authority-data'] === 'string' ||
      typeof clusterRecord['certificate-authority'] === 'string';
    const insecureSkipTlsVerify = clusterRecord.skipTLSVerify === true || clusterRecord['insecure-skip-tls-verify'] === true;
    const hasToken = typeof userRecord.token === 'string' && userRecord.token.trim().length > 0;
    const support = classifyDirectSupport(clusterRecord.server, authKind, hasCustomCa, insecureSkipTlsVerify, hasToken);
    const hasAmbiguousSource =
      merged.duplicateContextNames.has(contextEntry.name) ||
      merged.duplicateClusterNames.has(context.cluster) ||
      merged.duplicateUserNames.has(context.user);
    const execRecord = asRecord(userRecord.exec);
    const provider = detectProviderMetadata({
      contextName: contextEntry.name || undefined,
      clusterName: context.cluster || undefined,
      userName: context.user || undefined,
      serverUrl: clusterRecord.server,
      execCommand: typeof execRecord?.command === 'string' ? execRecord.command : undefined,
      execArgs: Array.isArray(execRecord?.args)
        ? execRecord.args.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
        : undefined
    });
    return {
      displayName: contextEntry.name || context.cluster || 'Discovered context',
      discoveryKey: `${contextEntry.name || 'context'}|${context.cluster || 'cluster'}|${maskEndpoint(clusterRecord.server || '')}`,
      sourceOriginLabel: merged.bundleLabel,
      sourceFileLabel: contextEntry.sourceFileLabel,
      sourceContextName: contextEntry.name || undefined,
      sourceClusterName: context.cluster || undefined,
      sourceUserName: context.user || undefined,
      sourceAuthKind: authKind,
      sourceSummary: context.cluster
        ? `Agent-discovered context ${contextEntry.name || context.cluster} → cluster ${context.cluster}${contextEntry.sourceFileLabel ? ` from ${contextEntry.sourceFileLabel}` : ''}`
        : 'Agent-discovered context',
      providerKind: provider.kind,
      providerDetectionConfidence: provider.confidence,
      providerEvidence: provider.evidence,
      providerHints: provider.hints,
      recommendedMode: hasAmbiguousSource || support.state === 'invalid' ? 'none' : 'agent',
      directSupportState: hasAmbiguousSource ? 'invalid' : support.state,
      directSupportReason: hasAmbiguousSource ? 'ambiguous_source' : support.reason,
      endpointMasked: maskEndpoint(clusterRecord.server || ''),
      clusterFingerprint: discoveredClusterFingerprint(contextEntry, clusterRecord)
    };
  });
}

function buildMergedKubeConfig(merged, contextName) {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: Array.from(merged.clustersByName.values()).map((entry) => ({ name: entry.name, cluster: entry.cluster })),
      users: Array.from(merged.usersByName.values()).map((entry) => ({ name: entry.name, user: entry.user })),
      contexts: merged.contexts.map((entry) => ({ name: entry.name, context: entry.context })),
      'current-context': contextName
    })
  );
  kubeConfig.setCurrentContext(contextName);
  if (!kubeConfig.getContextObject(contextName) || !kubeConfig.getCurrentCluster()) {
    throw new Error(`Kubeconfig context "${contextName}" is not loadable. Rediscover and reactivate the context.`);
  }
  return kubeConfig;
}

export function loadLocalKubeConfig(runtimeConfig) {
  if (runtimeConfig.kubeConfig) {
    return runtimeConfig.kubeConfig;
  }

  const kubeConfig = new KubeConfig();
  if (runtimeConfig.kubeconfigPath) {
    kubeConfig.loadFromFile(runtimeConfig.kubeconfigPath);
  } else {
    kubeConfig.loadFromDefault();
  }

  if (runtimeConfig.kubeContext) {
    kubeConfig.setCurrentContext(runtimeConfig.kubeContext);
  }

  return kubeConfig;
}

export function discoverLocalAccessCandidates(runtimeConfig) {
  const merged = mergeDiscoveredKubeconfigSources(runtimeConfig);
  return buildDiscoveredAccessCandidates(merged);
}

export function resolveAgentRuntimeConfigForSelector(runtimeConfig, selector, options = {}) {
  if (!selector || typeof selector.contextName !== 'string' || !selector.contextName.trim()) {
    throw new Error('The runtime session is not bound to a kubeconfig context.');
  }

  const contextName = selector.contextName.trim();
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const cacheKey = `${JSON.stringify(selector)}|${sourceFilesSignature(runtimeConfig)}`;
  const cached = validatedKubeConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      ...runtimeConfig,
      kubeContext: contextName,
      clusterFingerprint: selector.clusterFingerprint,
      kubeConfig: cached.kubeConfig
    };
  }

  const merged = mergeDiscoveredKubeconfigSources(runtimeConfig);
  if (merged.duplicateContextNames.has(contextName)) {
    throw new Error(`Kubeconfig context "${contextName}" is ambiguous across multiple sources. Rediscover and reactivate the context.`);
  }
  const candidates = buildDiscoveredAccessCandidates(merged).filter((candidate) => candidate.sourceContextName === contextName);
  if (candidates.length !== 1) {
    throw new Error(`Kubeconfig context "${contextName}" is missing or ambiguous. Rediscover and reactivate the context.`);
  }

  const candidate = candidates[0];
  const selectedContext = merged.contexts.find((entry) => entry.name === contextName);
  const ambiguousReferences = [];
  if (selectedContext && merged.duplicateClusterNames.has(selectedContext.context?.cluster)) {
    ambiguousReferences.push(`cluster "${selectedContext.context.cluster}"`);
  }
  if (selectedContext && merged.duplicateUserNames.has(selectedContext.context?.user)) {
    ambiguousReferences.push(`user "${selectedContext.context.user}"`);
  }
  if (ambiguousReferences.length > 0) {
    throw new Error(
      `Kubeconfig context "${contextName}" references ambiguous ${ambiguousReferences.join(' and ')}. Rediscover and reactivate the context.`
    );
  }
  const localRuntimeTargetKey = deriveRuntimeTargetKey({
    clusterFingerprint: candidate.clusterFingerprint,
    sourceClusterName: candidate.sourceClusterName,
    sourceContextName: candidate.sourceContextName,
    endpointMasked: candidate.endpointMasked,
    connectionSource: 'agent-discovered',
    providerKind: candidate.providerKind
  });
  if (selector.runtimeTargetKey && selector.runtimeTargetKey !== localRuntimeTargetKey) {
    throw new Error(`Kubeconfig context "${contextName}" no longer matches the authorized runtime target.`);
  }
  if (selector.clusterFingerprint && selector.clusterFingerprint !== candidate.clusterFingerprint) {
    throw new Error(`Kubeconfig context "${contextName}" no longer matches the authorized cluster fingerprint.`);
  }

  const kubeConfig = buildMergedKubeConfig(merged, contextName);
  validatedKubeConfigCache.set(cacheKey, {
    kubeConfig,
    expiresAt: now + VALIDATED_KUBECONFIG_CACHE_TTL_MS
  });
  return {
    ...runtimeConfig,
    kubeContext: contextName,
    clusterFingerprint: candidate.clusterFingerprint,
    kubeConfig
  };
}

export function scanLocalAccessDiscovery(runtimeConfig) {
  const merged = mergeDiscoveredKubeconfigSources(runtimeConfig);
  return {
    scannedAt: new Date().toISOString(),
    sourceCount: merged.sourceCount,
    warnings: merged.warnings,
    candidates: buildDiscoveredAccessCandidates(merged)
  };
}

export async function loadLocalRuntimeCapability(runtimeConfig) {
  const checkedAt = new Date().toISOString();

  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const version = await fetchKubeJson(kubeConfig, '/version');

    return {
      ok: true,
      workspaceId: runtimeConfig.workspaceId || 'agent-local',
      agentId: runtimeConfig.agentId,
      connectionId: runtimeConfig.connectionId || 'agent-local',
      checkedAt,
      message: 'The local agent can reach the cluster API.',
      retryable: false,
      kubernetesVersion: typeof version.gitVersion === 'string' ? version.gitVersion : undefined,
      platform: typeof version.platform === 'string' ? version.platform : undefined
    };
  } catch (error) {
    return {
      ok: false,
      workspaceId: runtimeConfig.workspaceId || 'agent-local',
      agentId: runtimeConfig.agentId,
      connectionId: runtimeConfig.connectionId || 'agent-local',
      checkedAt,
      issueCode: 'agent_unreachable',
      message: sanitizeKubeError(error),
      retryable: true
    };
  }
}

export async function loadLocalClusterOverview(runtimeConfig) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const [version, namespaces, nodes, deployments, statefulSets, daemonSets, pods] = await Promise.all([
      fetchKubeJson(kubeConfig, '/version'),
      fetchKubeList(kubeConfig, '/api/v1/namespaces'),
      fetchKubeList(kubeConfig, '/api/v1/nodes'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/deployments'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/statefulsets'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/daemonsets'),
      fetchKubeList(kubeConfig, '/api/v1/pods')
    ]);

    const issues = [];
    if ([namespaces, nodes, deployments, statefulSets, daemonSets, pods].some((entry) => entry.truncated)) {
      issues.push(truncationIssue('overview', 'Large resource lists were truncated for this overview read.'));
    }

    return {
      cluster: {
        endpointMasked: new URL(baseServerUrl(kubeConfig)).origin,
        connectionId: runtimeConfig.connectionId || 'agent-local',
        connectionName: runtimeConfig.connectionName || 'Local Agent Runtime',
        kubernetesVersion: typeof version.gitVersion === 'string' ? version.gitVersion : undefined,
        platform: typeof version.platform === 'string' ? version.platform : undefined,
        runtimeMode: 'agent',
        fetchedAt: new Date().toISOString()
      },
      namespaces: {
        total: namespaces.items.length
      },
      nodes: {
        total: nodes.items.length,
        ready: asRecordArray(nodes.items).filter((node) =>
          statusConditions(node).some((condition) => condition.type === 'Ready' && condition.status === 'True')
        ).length,
        notReady:
          nodes.items.length -
          asRecordArray(nodes.items).filter((node) => statusConditions(node).some((condition) => condition.type === 'Ready' && condition.status === 'True')).length
      },
      workloads: {
        deployments: deployments.items.length,
        statefulSets: statefulSets.items.length,
        daemonSets: daemonSets.items.length
      },
      pods: buildPodPhaseSummary(pods.items),
      issues
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalNamespaces(runtimeConfig) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const namespaces = await fetchKubeList(kubeConfig, '/api/v1/namespaces');
    return buildResourceList(
      asRecordArray(namespaces.items).map(normalizeNamespace).sort((left, right) => left.name.localeCompare(right.name)),
      new Date().toISOString(),
      namespaces.truncated ? [truncationIssue('namespaces', 'The namespaces list was truncated for this runtime read.')] : [],
      namespaces.truncated
    );
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalNodes(runtimeConfig) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const nodes = await fetchKubeList(kubeConfig, '/api/v1/nodes');
    return buildResourceList(
      asRecordArray(nodes.items)
        .map(normalizeNode)
        .sort((left, right) => {
          if (left.ready !== right.ready) {
            return left.ready ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        }),
      new Date().toISOString(),
      nodes.truncated ? [truncationIssue('nodes', 'The nodes list was truncated for this runtime read.')] : [],
      nodes.truncated
    );
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalWorkloads(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/apis/apps/v1/deployments', '/apis/apps/v1/namespaces/:namespace/deployments', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/apps/v1/statefulsets', '/apis/apps/v1/namespaces/:namespace/statefulsets', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/apps/v1/daemonsets', '/apis/apps/v1/namespaces/:namespace/daemonsets', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace))
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    let partial = false;

    const deploymentItems =
      requests[0].status === 'fulfilled'
        ? requests[0].value.items
        : (partial = true, issues.push(partialIssue('workloads', 'Deployments could not be loaded.')), []);
    const statefulSetItems =
      requests[1].status === 'fulfilled'
        ? requests[1].value.items
        : (partial = true, issues.push(partialIssue('workloads', 'StatefulSets could not be loaded.')), []);
    const daemonSetItems =
      requests[2].status === 'fulfilled'
        ? requests[2].value.items
        : (partial = true, issues.push(partialIssue('workloads', 'DaemonSets could not be loaded.')), []);
    const podItems =
      requests[3].status === 'fulfilled'
        ? requests[3].value.items
        : (partial = true, issues.push(partialIssue('workloads', 'Pods summary could not be loaded for workloads.')), []);

    if (
      (requests[0].status === 'fulfilled' && requests[0].value.truncated) ||
      (requests[1].status === 'fulfilled' && requests[1].value.truncated) ||
      (requests[2].status === 'fulfilled' && requests[2].value.truncated) ||
      (requests[3].status === 'fulfilled' && requests[3].value.truncated)
    ) {
      partial = true;
      issues.push(truncationIssue('workloads', 'Large workload lists were truncated for this runtime read.'));
    }

    const podRecords = asRecordArray(podItems);
    const podsAvailable = requests[3].status === 'fulfilled';
    const items = [
      ...asRecordArray(deploymentItems).map((record) => normalizeWorkload('Deployment', record, podRecords, podsAvailable)),
      ...asRecordArray(statefulSetItems).map((record) => normalizeWorkload('StatefulSet', record, podRecords, podsAvailable)),
      ...asRecordArray(daemonSetItems).map((record) => normalizeWorkload('DaemonSet', record, podRecords, podsAvailable))
    ].sort((left, right) => {
      if (left.namespace !== right.namespace) {
        return left.namespace.localeCompare(right.namespace);
      }
      if (left.kind !== right.kind) {
        return left.kind.localeCompare(right.kind);
      }
      return left.name.localeCompare(right.name);
    });

    return {
      ...buildResourceList(items, new Date().toISOString(), issues, partial),
      namespaceScope: effectiveNamespace,
      podSummary: podsAvailable ? buildPodPhaseSummary(podRecords) : buildPodPhaseSummary([])
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalServices(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const [services, endpointSlices] = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/discovery.k8s.io/v1/endpointslices', '/apis/discovery.k8s.io/v1/namespaces/:namespace/endpointslices', effectiveNamespace)
      )
    ]);

    if (services.status === 'rejected') {
      throw services.reason;
    }

    const issues = [];
    let partial = false;
    let endpointSliceItems = [];
    let endpointsAvailable = true;

    if (services.value.truncated) {
      partial = true;
      issues.push(truncationIssue('services', 'The services list was truncated for this runtime read.'));
    }

    if (endpointSlices.status === 'fulfilled') {
      endpointSliceItems = endpointSlices.value.items;
      if (endpointSlices.value.truncated) {
        partial = true;
        issues.push(truncationIssue('services', 'The EndpointSlices list was truncated for this runtime read.'));
      }
    } else {
      partial = true;
      endpointsAvailable = false;
      issues.push(partialIssue('services', 'Endpoint availability could not be loaded for services.'));
    }

    const items = asRecordArray(services.value.items)
      .map((record) => normalizeService(record, asRecordArray(endpointSliceItems), endpointsAvailable))
      .sort((left, right) => {
        if (left.namespace !== right.namespace) {
          return left.namespace.localeCompare(right.namespace);
        }
        return left.name.localeCompare(right.name);
      });

    const endpointSliceSummaries = asRecordArray(endpointSliceItems)
      .map(normalizeEndpointSlice)
      .sort((left, right) => {
        if (left.namespace !== right.namespace) {
          return left.namespace.localeCompare(right.namespace);
        }
        return left.name.localeCompare(right.name);
      });

    const fetchedAt = new Date().toISOString();
    return {
      ...buildResourceList(items, fetchedAt, issues, partial),
      namespaceScope: effectiveNamespace,
      endpointSlices: buildResourceList(endpointSliceSummaries, fetchedAt, issues, partial)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function ownerFor(record) {
  const refs = asRecordArray(asRecord(record.metadata)?.ownerReferences);
  return refs.find((entry) => entry.controller === true) || refs[0] || null;
}

function containerStateSummary(status) {
  const state = asRecord(status.state);
  if (asRecord(state?.waiting)) return { state: 'waiting', reason: stringOrUndefined(asRecord(state.waiting)?.reason) };
  if (asRecord(state?.terminated)) return { state: 'terminated', reason: stringOrUndefined(asRecord(state.terminated)?.reason) };
  if (asRecord(state?.running)) return { state: 'running' };
  return { state: 'unknown' };
}

function normalizeRuntimeContainer(container, statusByName, type) {
  const name = stringOrUndefined(container.name) || 'container';
  const status = statusByName.get(name) || {};
  const state = containerStateSummary(status);
  return {
    name,
    image: stringOrUndefined(container.image) || 'unknown',
    ready: status.ready === true,
    restartCount: numberOrZero(status.restartCount),
    state: state.state,
    reason: state.reason,
    imagePullPolicy: stringOrUndefined(container.imagePullPolicy),
    type
  };
}

function podStatusReason(record) {
  const status = asRecord(record.status);
  const waiting = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .map((entry) => asRecord(asRecord(entry.state)?.waiting))
    .find((entry) => stringOrUndefined(entry?.reason));
  const terminated = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .map((entry) => asRecord(asRecord(entry.state)?.terminated))
    .find((entry) => stringOrUndefined(entry?.reason));
  return stringOrUndefined(waiting?.reason) || stringOrUndefined(terminated?.reason) || stringOrUndefined(status?.reason);
}

function podStatusMessage(record) {
  const status = asRecord(record.status);
  const waiting = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .map((entry) => asRecord(asRecord(entry.state)?.waiting))
    .find((entry) => stringOrUndefined(entry?.message));
  const terminated = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .map((entry) => asRecord(asRecord(entry.state)?.terminated))
    .find((entry) => stringOrUndefined(entry?.message));
  return stringOrUndefined(waiting?.message) || stringOrUndefined(terminated?.message) || stringOrUndefined(status?.message);
}

function podLastRestartAt(status) {
  const timestamps = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .filter((entry) => numberOrZero(entry.restartCount) > 0)
    .map((entry) => stringOrUndefined(asRecord(asRecord(entry.lastState)?.terminated)?.finishedAt))
    .filter(Boolean)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  return timestamps.at(-1);
}

function podResourceTotals(containers) {
  return asRecordArray(containers).reduce(
    (total, container) => {
      const resources = asRecord(container.resources);
      const requests = asRecord(resources?.requests);
      const limits = asRecord(resources?.limits);
      total.cpuRequestsMilli += parseCpuMilli(requests?.cpu);
      total.cpuLimitsMilli += parseCpuMilli(limits?.cpu);
      total.memoryRequestsBytes += parseBytes(requests?.memory);
      total.memoryLimitsBytes += parseBytes(limits?.memory);
      return total;
    },
    { cpuRequestsMilli: 0, cpuLimitsMilli: 0, memoryRequestsBytes: 0, memoryLimitsBytes: 0 }
  );
}

function normalizeRuntimePod(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const containerStatuses = new Map(asRecordArray(status?.containerStatuses).map((entry) => [stringOrUndefined(entry.name) || 'container', entry]));
  const initContainerStatuses = new Map(asRecordArray(status?.initContainerStatuses).map((entry) => [stringOrUndefined(entry.name) || 'initContainer', entry]));
  const containers = [
    ...asRecordArray(spec?.containers).map((container) => normalizeRuntimeContainer(container, containerStatuses, 'container')),
    ...asRecordArray(spec?.initContainers).map((container) => normalizeRuntimeContainer(container, initContainerStatuses, 'initContainer'))
  ];
  const resources = podResourceTotals(spec?.containers);
  const owner = ownerFor(record);
  return {
    name: meta.name,
    namespace: meta.namespace,
    phase: stringOrUndefined(status?.phase) || 'Unknown',
    statusReason: podStatusReason(record),
    statusMessage: podStatusMessage(record),
    ready: isPodReady(record),
    restarts: containers.reduce((total, container) => total + container.restartCount, 0),
    lastRestartAt: podLastRestartAt(status),
    nodeName: stringOrUndefined(spec?.nodeName),
    podIp: stringOrUndefined(status?.podIP),
    podIps: asRecordArray(status?.podIPs).map((entry) => stringOrUndefined(entry.ip)).filter(Boolean),
    ownerKind: stringOrUndefined(owner?.kind),
    ownerName: stringOrUndefined(owner?.name),
    qosClass: stringOrUndefined(status?.qosClass),
    createdAt: meta.createdAt,
    startTime: stringOrUndefined(status?.startTime),
    labels: meta.labels,
    annotations: meta.annotations,
    images: [...new Set(containers.map((container) => container.image).filter(Boolean))],
    cpuRequestsMilli: resources.cpuRequestsMilli,
    cpuLimitsMilli: resources.cpuLimitsMilli,
    memoryRequestsBytes: resources.memoryRequestsBytes,
    memoryLimitsBytes: resources.memoryLimitsBytes,
    containers
  };
}

function buildRuntimePodPhaseSummary(pods) {
  const ready = pods.filter((pod) => pod.ready).length;
  const phaseCounts = pods.reduce((current, pod) => {
    current[pod.phase] = (current[pod.phase] || 0) + 1;
    return current;
  }, {});
  return {
    total: pods.length,
    ready,
    notReady: Math.max(0, pods.length - ready),
    phaseCounts,
    crashLoopBackOff: pods.filter((pod) => pod.containers.some((container) => container.reason === 'CrashLoopBackOff')).length
  };
}

function buildRuntimePodList(podItems, fetchedAt, namespaceScope, issues = [], partial = false) {
  const items = asRecordArray(podItems)
    .map(normalizeRuntimePod)
    .sort((left, right) => {
      if (left.namespace !== right.namespace) return left.namespace.localeCompare(right.namespace);
      if (left.ready !== right.ready) return left.ready ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
  return {
    ...buildResourceList(items, fetchedAt, issues, partial),
    namespaceScope,
    summary: buildRuntimePodPhaseSummary(items)
  };
}

/**
 * @param {any} runtimeConfig
 * @param {string | null} [namespaceScope]
 */
export async function loadLocalPods(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const pods = await fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace));
    const issues = pods.truncated ? [truncationIssue('pods', 'The Pod list was truncated for this runtime read.')] : [];
    return buildRuntimePodList(pods.items, new Date().toISOString(), effectiveNamespace, issues, pods.truncated);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function ownerName(references, kind) {
  return asRecordArray(references).find((reference) => reference.kind === kind)?.name;
}

function jobKey(namespace, name) {
  return `${namespace}/${name}`;
}

function durationSeconds(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 0;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) return 0;
  return Math.round((completed - started) / 1000);
}

function jobStatusSummary(job) {
  const spec = asRecord(job.spec);
  const status = asRecord(job.status);
  const conditions = asRecordArray(status?.conditions);
  const failedCondition = conditions.find((condition) => condition.type === 'Failed' && condition.status === 'True');
  const completeCondition = conditions.find((condition) => condition.type === 'Complete' && condition.status === 'True');
  const active = numberOrZero(status?.active);
  const succeeded = numberOrZero(status?.succeeded);
  const failed = numberOrZero(status?.failed);
  const completions = numberOrZero(spec?.completions) || 1;
  if (failedCondition) {
    return {
      status: 'Failed',
      reason: stringOrUndefined(failedCondition.reason),
      message: stringOrUndefined(failedCondition.message),
      completedAt: stringOrUndefined(failedCondition.lastTransitionTime)
    };
  }
  if (completeCondition || succeeded >= completions) {
    return {
      status: 'Succeeded',
      reason: stringOrUndefined(completeCondition?.reason),
      message: stringOrUndefined(completeCondition?.message),
      completedAt: stringOrUndefined(completeCondition?.lastTransitionTime)
    };
  }
  if (active > 0) return { status: 'Running' };
  if (failed > 0) return { status: 'Failed', reason: 'FailedPods' };
  return { status: 'Pending' };
}

function jobSelector(job) {
  return asStringRecord(asRecord(asRecord(job.spec)?.selector)?.matchLabels);
}

function podBelongsToJob(pod, job) {
  const podMeta = metadataFor(pod);
  const jobMeta = metadataFor(job);
  if (podMeta.namespace !== jobMeta.namespace) return false;
  if (ownerName(podMeta.ownerReferences, 'Job') === jobMeta.name) return true;
  return labelsMatchSelector(podMeta.labels, jobSelector(job));
}

function podContainerNames(pod) {
  const spec = asRecord(pod.spec);
  return [...asRecordArray(spec?.containers), ...asRecordArray(spec?.initContainers)]
    .map((container) => stringOrUndefined(container.name))
    .filter(Boolean);
}

function podFinishedAt(pod) {
  const status = asRecord(pod.status);
  const finishedAt = [...asRecordArray(status?.initContainerStatuses), ...asRecordArray(status?.containerStatuses)]
    .map((entry) => stringOrUndefined(asRecord(asRecord(entry.state)?.terminated)?.finishedAt))
    .filter(Boolean)
    .sort();
  return finishedAt.at(-1);
}

function podLogContainers(pod) {
  const spec = asRecord(pod.spec);
  return [
    ...asRecordArray(spec?.initContainers).map((container) => ({
      name: stringOrUndefined(container.name) || 'initContainer',
      type: 'initContainer'
    })),
    ...asRecordArray(spec?.containers).map((container) => ({
      name: stringOrUndefined(container.name) || 'container',
      type: 'container'
    }))
  ];
}

function normalizeLogTail(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function splitLogLines(value) {
  return String(value || '').split(/\r?\n/).filter((line) => line.length > 0);
}

function buildJobPodRef(pod) {
  const meta = metadataFor(pod);
  const status = asRecord(pod.status);
  const spec = asRecord(pod.spec);
  return {
    name: meta.name,
    namespace: meta.namespace,
    phase: stringOrUndefined(status?.phase) || 'Unknown',
    node: stringOrUndefined(spec?.nodeName),
    startedAt: stringOrUndefined(status?.startTime),
    finishedAt: podFinishedAt(pod),
    containers: podContainerNames(pod)
  };
}

function buildRuntimeJob(job, pods) {
  const meta = metadataFor(job);
  const spec = asRecord(job.spec);
  const podTemplateSpec = asRecord(asRecord(spec?.template)?.spec);
  const status = asRecord(job.status);
  const statusSummary = jobStatusSummary(job);
  const startedAt = stringOrUndefined(status?.startTime) || statusSummary.completedAt || meta.createdAt;
  return {
    name: meta.name,
    namespace: meta.namespace,
    status: statusSummary.status,
    reason: statusSummary.reason,
    message: statusSummary.message,
    createdAt: meta.createdAt,
    startedAt,
    completedAt: statusSummary.completedAt,
    durationSeconds: durationSeconds(startedAt, statusSummary.completedAt),
    active: numberOrZero(status?.active),
    succeeded: numberOrZero(status?.succeeded),
    failed: numberOrZero(status?.failed),
    completions: numberOrZero(spec?.completions) || 1,
    parallelism: numberOrZero(spec?.parallelism) || 1,
    backoffLimit: numberOrZero(spec?.backoffLimit),
    ttlSecondsAfterFinished: numberOrUndefined(spec?.ttlSecondsAfterFinished),
    restartPolicy: stringOrUndefined(podTemplateSpec?.restartPolicy),
    activeDeadlineSeconds: numberOrUndefined(spec?.activeDeadlineSeconds),
    completionMode: stringOrUndefined(spec?.completionMode),
    backoffLimitPerIndex: numberOrUndefined(spec?.backoffLimitPerIndex),
    maxFailedIndexes: numberOrUndefined(spec?.maxFailedIndexes),
    ownerCronJob: ownerName(meta.ownerReferences, 'CronJob'),
    labels: meta.labels,
    annotations: asStringRecord(asRecord(job.metadata)?.annotations),
    pods: pods.filter((pod) => podBelongsToJob(pod, job)).map(buildJobPodRef)
  };
}

function buildRuntimeCronJob(cronJob, jobs) {
  const meta = metadataFor(cronJob);
  const spec = asRecord(cronJob.spec);
  const jobTemplateSpec = asRecord(asRecord(spec?.jobTemplate)?.spec);
  const podTemplateSpec = asRecord(asRecord(jobTemplateSpec?.template)?.spec);
  const status = asRecord(cronJob.status);
  const recentJobs = jobs
    .filter((job) => job.ownerCronJob === meta.name && job.namespace === meta.namespace)
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))
    .slice(0, 5)
    .map((job) => ({
      name: job.name,
      status: job.status,
      reason: job.reason,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationSeconds: job.durationSeconds,
      active: job.active,
      succeeded: job.succeeded,
      failed: job.failed
    }));
  const active = asRecordArray(status?.active).length;
  const lastRun = recentJobs[0];
  const suspend = spec?.suspend === true;
  return {
    name: meta.name,
    namespace: meta.namespace,
    status: suspend ? 'Suspended' : active > 0 ? 'Active' : lastRun?.status === 'Failed' ? 'Failing' : 'Ready',
    schedule: stringOrUndefined(spec?.schedule) || '-',
    suspend,
    concurrencyPolicy: stringOrUndefined(spec?.concurrencyPolicy),
    createdAt: meta.createdAt,
    lastScheduleTime: stringOrUndefined(status?.lastScheduleTime),
    lastSuccessfulTime: stringOrUndefined(status?.lastSuccessfulTime),
    active,
    successfulJobsHistoryLimit: numberOrZero(spec?.successfulJobsHistoryLimit),
    failedJobsHistoryLimit: numberOrZero(spec?.failedJobsHistoryLimit),
    startingDeadlineSeconds: numberOrZero(spec?.startingDeadlineSeconds),
    ttlSecondsAfterFinished: numberOrUndefined(jobTemplateSpec?.ttlSecondsAfterFinished),
    restartPolicy: stringOrUndefined(podTemplateSpec?.restartPolicy),
    activeDeadlineSeconds: numberOrUndefined(jobTemplateSpec?.activeDeadlineSeconds),
    completionMode: stringOrUndefined(jobTemplateSpec?.completionMode),
    backoffLimitPerIndex: numberOrUndefined(jobTemplateSpec?.backoffLimitPerIndex),
    maxFailedIndexes: numberOrUndefined(jobTemplateSpec?.maxFailedIndexes),
    lastJobName: lastRun?.name,
    lastJobStatus: lastRun?.status,
    lastJobCompletedAt: lastRun?.completedAt,
    recentJobs,
    labels: meta.labels,
    annotations: asStringRecord(asRecord(cronJob.metadata)?.annotations)
  };
}

function buildRuntimeJobsInventory(jobsRaw, cronJobsRaw, podsRaw, fetchedAt, namespaceScope, issues = [], partial = false) {
  const jobs = asRecordArray(jobsRaw).map((job) => buildRuntimeJob(job, asRecordArray(podsRaw)));
  const cronJobs = asRecordArray(cronJobsRaw).map((cronJob) => buildRuntimeCronJob(cronJob, jobs));
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    namespaceScope,
    summary: {
      jobs: jobs.length,
      cronJobs: cronJobs.length,
      runningJobs: jobs.filter((job) => job.status === 'Running').length,
      failedJobs: jobs.filter((job) => job.status === 'Failed').length,
      suspendedCronJobs: cronJobs.filter((cronJob) => cronJob.suspend).length,
      failingCronJobs: cronJobs.filter((cronJob) => cronJob.status === 'Failing').length
    },
    jobs: buildResourceList(jobs, fetchedAt, issues, partial),
    cronJobs: buildResourceList(cronJobs, fetchedAt, issues, partial)
  };
}

/**
 * @param {any} runtimeConfig
 * @param {string | null} [namespaceScope]
 */
export async function loadLocalJobs(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/jobs', '/apis/batch/v1/namespaces/:namespace/jobs', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/cronjobs', '/apis/batch/v1/namespaces/:namespace/cronjobs', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace))
    ]);
    if (requests[0].status === 'rejected' && requests[1].status === 'rejected') throw requests[0].reason;
    const issues = [];
    const jobs = settledSection(requests[0], 'jobs', 'Jobs could not be loaded.', 'The Job list was truncated for this runtime read.', issues);
    const cronJobs = settledSection(requests[1], 'jobs', 'CronJobs could not be loaded.', 'The CronJob list was truncated for this runtime read.', issues);
    const pods = settledSection(requests[2], 'jobs', 'Pods could not be loaded for Job ownership.', 'The Pod list was truncated for Job ownership.', issues);
    return buildRuntimeJobsInventory(jobs.items, cronJobs.items, pods.items, new Date().toISOString(), effectiveNamespace, issues, jobs.partial || cronJobs.partial || pods.partial);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalPodLogs(runtimeConfig, input) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const namespace = input?.namespace || runtimeConfig.namespace || 'default';
    const name = input?.name;
    if (!name) {
      throw new Error('Pod name is required.');
    }
    const tailLines = normalizeLogTail(input?.tail);
    const search = new URLSearchParams({ tailLines: String(tailLines) });
    if (input?.container) {
      search.set('container', input.container);
    }
    const raw = await fetchKubeText(kubeConfig, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/log?${search.toString()}`);
    return {
      namespace,
      pod: name,
      ...(input?.container ? { container: input.container } : {}),
      tailLines,
      lines: splitLogLines(raw)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalJobLogs(runtimeConfig, input) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const namespace = input?.namespace || runtimeConfig.namespace || 'default';
    const name = input?.name;
    if (!name) {
      throw new Error('Job name is required.');
    }
    const tailLines = normalizeLogTail(input?.tail);
    const job = await fetchKubeJson(kubeConfig, `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`);
    const podsByLabel = await fetchKubeList(
      kubeConfig,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`job-name=${name}`)}`
    );
    let pods = asRecordArray(podsByLabel.items).filter((pod) => podBelongsToJob(pod, job));
    if (pods.length === 0) {
      const allPods = await fetchKubeList(kubeConfig, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`);
      pods = asRecordArray(allPods.items).filter((pod) => podBelongsToJob(pod, job));
    }

    const logPods = await Promise.all(
      pods.map(async (pod) => {
        const meta = metadataFor(pod);
        const status = asRecord(pod.status);
        const spec = asRecord(pod.spec);
        const containers = await Promise.all(
          podLogContainers(pod).map(async (container) => {
            const search = new URLSearchParams({ container: container.name, tailLines: String(tailLines) });
            try {
              const raw = await fetchKubeText(
                kubeConfig,
                `/api/v1/namespaces/${encodeURIComponent(meta.namespace)}/pods/${encodeURIComponent(meta.name)}/log?${search.toString()}`
              );
              return {
                name: container.name,
                type: container.type,
                lines: splitLogLines(raw),
                truncated: false
              };
            } catch (error) {
              return {
                name: container.name,
                type: container.type,
                lines: [],
                error: error instanceof Error ? error.message : 'Container logs could not be loaded.',
                truncated: false
              };
            }
          })
        );
        return {
          name: meta.name,
          namespace: meta.namespace,
          phase: stringOrUndefined(status?.phase) || 'Unknown',
          node: stringOrUndefined(spec?.nodeName),
          startedAt: stringOrUndefined(status?.startTime),
          finishedAt: podFinishedAt(pod),
          containers
        };
      })
    );

    return {
      job: name,
      namespace,
      tailLines,
      pods: logPods
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function referenceKey(namespace, name) {
  return `${namespace}/${name}`;
}

function referenceId(secretKey, ref) {
  return `ref:${secretKey}:${String(ref.kind).toLowerCase()}:${ref.namespace || 'default'}/${ref.name}`;
}

function appendReferencePath(ref, path) {
  if (!ref.paths.some((entry) => entry.type === path.type && entry.field === path.field && entry.source === path.source)) {
    ref.paths.push(path);
  }
}

function addObjectRef(refs, namespace, name, ref, path) {
  if (!name) return;
  const key = referenceKey(namespace, name);
  const existing = refs.get(key) || [];
  let current = existing.find((entry) => entry.kind === ref.kind && entry.name === ref.name && entry.namespace === ref.namespace);
  if (!current) {
    current = {
      id: referenceId(key, ref),
      ...ref,
      paths: []
    };
    existing.push(current);
  }
  appendReferencePath(current, path);
  refs.set(key, existing);
}

function podContainersForRefs(pod) {
  const spec = asRecord(pod.spec);
  return [...asRecordArray(spec?.containers), ...asRecordArray(spec?.initContainers)];
}

function collectRuntimeSecretRefs(pods, serviceAccounts, ingresses) {
  const refs = new Map();
  for (const pod of asRecordArray(pods)) {
    const meta = metadataFor(pod);
    const phase = stringOrUndefined(asRecord(pod.status)?.phase);
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const spec = asRecord(pod.spec);
    const owner = meta.ownerReferences.find((entry) => entry.controller === true) || meta.ownerReferences[0];
    const podRef = {
      kind: 'Pod',
      name: meta.name,
      namespace: meta.namespace,
      resourceType: 'Pod',
      source: 'podSpec'
    };
    const addPodReference = (secretName, path) => {
      addObjectRef(refs, meta.namespace, secretName, podRef, path);
      const ownerKind = stringOrUndefined(owner?.kind);
      const ownerName = stringOrUndefined(owner?.name);
      if (ownerKind && ownerName) {
        addObjectRef(
          refs,
          meta.namespace,
          secretName,
          {
            kind: 'Workload',
            name: ownerName,
            namespace: meta.namespace,
            resourceType: ownerKind,
            source: 'podOwner'
          },
          { type: 'workloadOwner', field: `pod/${meta.name}`, source: 'podOwner' }
        );
      }
    };
    for (const [index, volume] of asRecordArray(spec?.volumes).entries()) {
      addPodReference(
        stringOrUndefined(asRecord(volume.secret)?.secretName),
        { type: 'volumeMount', field: `spec.volumes[${index}]`, source: 'podSpec' }
      );
    }
    for (const [index, pullSecret] of asRecordArray(spec?.imagePullSecrets).entries()) {
      addPodReference(
        stringOrUndefined(pullSecret.name),
        { type: 'imagePullSecrets', field: `spec.imagePullSecrets[${index}]`, source: 'podSpec' }
      );
    }
    for (const [containerIndex, container] of podContainersForRefs(pod).entries()) {
      for (const [envIndex, env] of asRecordArray(container.env).entries()) {
        addPodReference(
          stringOrUndefined(asRecord(asRecord(env.valueFrom)?.secretKeyRef)?.name),
          { type: 'env', field: `spec.containers[${containerIndex}].env[${envIndex}]`, source: 'podSpec' }
        );
      }
      for (const [envFromIndex, envFrom] of asRecordArray(container.envFrom).entries()) {
        addPodReference(
          stringOrUndefined(asRecord(envFrom.secretRef)?.name),
          { type: 'envFrom', field: `spec.containers[${containerIndex}].envFrom[${envFromIndex}]`, source: 'podSpec' }
        );
      }
    }
  }
  for (const serviceAccount of asRecordArray(serviceAccounts)) {
    const meta = metadataFor(serviceAccount);
    const serviceAccountRef = {
      kind: 'ServiceAccount',
      name: meta.name,
      namespace: meta.namespace,
      resourceType: 'ServiceAccount',
      source: 'serviceAccount'
    };
    for (const [index, secretRef] of asRecordArray(serviceAccount.secrets).entries()) {
      addObjectRef(
        refs,
        meta.namespace,
        stringOrUndefined(secretRef.name),
        serviceAccountRef,
        { type: 'serviceAccountSecret', field: `secrets[${index}]`, source: 'serviceAccount' }
      );
    }
    for (const [index, secretRef] of asRecordArray(serviceAccount.imagePullSecrets).entries()) {
      addObjectRef(
        refs,
        meta.namespace,
        stringOrUndefined(secretRef.name),
        serviceAccountRef,
        { type: 'serviceAccountImagePullSecrets', field: `imagePullSecrets[${index}]`, source: 'serviceAccount' }
      );
    }
  }
  for (const ingress of asRecordArray(ingresses)) {
    const meta = metadataFor(ingress);
    const ingressRef = {
      kind: 'Ingress',
      name: meta.name,
      namespace: meta.namespace,
      resourceType: 'Ingress',
      source: 'ingressSpec'
    };
    for (const [index, tls] of asRecordArray(asRecord(ingress.spec)?.tls).entries()) {
      addObjectRef(
        refs,
        meta.namespace,
        stringOrUndefined(tls.secretName),
        ingressRef,
        { type: 'ingressTLS', field: `spec.tls[${index}].secretName`, source: 'ingressSpec' }
      );
    }
  }
  return refs;
}

function secretReferenceCounts(referencedBy) {
  return referencedBy.reduce(
    (summary, reference) => {
      summary.total += 1;
      if (reference.kind === 'Pod') summary.pods += 1;
      if (reference.kind === 'Workload') summary.workloads += 1;
      if (reference.kind === 'ServiceAccount') summary.serviceAccounts += 1;
      if (reference.kind === 'Ingress') summary.ingresses += 1;
      return summary;
    },
    { total: 0, pods: 0, workloads: 0, serviceAccounts: 0, ingresses: 0 }
  );
}

function estimateSecretBytes(data) {
  return Object.values(data).reduce((total, value) => total + Math.floor((String(value).length * 3) / 4), 0);
}

function normalizeRuntimeSecret(record, refs) {
  const meta = metadataFor(record);
  const metadata = asRecord(record.metadata);
  const annotations = asStringRecord(metadata?.annotations);
  const data = asStringRecord(record.data);
  const referencedBy = refs.get(referenceKey(meta.namespace, meta.name)) || [];
  const references = secretReferenceCounts(referencedBy);
  const type = stringOrUndefined(record.type) || 'Opaque';
  const dataKeys = Object.keys(data).sort((left, right) => left.localeCompare(right));
  const riskFlags = [];
  if (referencedBy.length === 0 && type !== 'kubernetes.io/tls') riskFlags.push('unreferenced');
  if (type === 'kubernetes.io/tls') riskFlags.push('tls');
  if (type === 'kubernetes.io/dockerconfigjson' || type === 'kubernetes.io/dockercfg') riskFlags.push('registry');
  if (type === 'kubernetes.io/service-account-token') riskFlags.push('service-account-token');
  if (type.toLowerCase() === 'opaque' && dataKeys.some((key) => /(password|token|key|secret|aws|gcp|azure|api)/i.test(key))) {
    riskFlags.push('sensitive-keys');
  }
  if (meta.namespace === 'kube-system' || meta.name.startsWith('sh.helm.release.v1.')) riskFlags.push('system-managed');

  return {
    id: `secret:${meta.namespace}/${meta.name}`,
    name: meta.name,
    namespace: meta.namespace,
    type,
    createdAt: meta.createdAt,
    labels: meta.labels,
    annotations,
    dataKeys,
    dataKeyCount: dataKeys.length,
    totalBytes: estimateSecretBytes(data),
    dataRedacted: false,
    immutable: record.immutable === true,
    labelsCount: Object.keys(meta.labels).length,
    annotationsCount: Object.keys(annotations).length,
    referenceCount: references.total,
    references,
    referencedBy,
    riskFlags,
    riskSignals: riskFlags,
    ownerKinds: [...new Set(meta.ownerReferences.map((entry) => stringOrUndefined(entry.kind)).filter(Boolean))],
    resourceType: 'Secret',
    source: 'kubernetes'
  };
}

export function buildRuntimeSecretInventory(secrets, pods, serviceAccounts, ingresses, fetchedAt, namespaceScope, issues = [], partial = false) {
  const refs = collectRuntimeSecretRefs(pods, serviceAccounts, ingresses);
  const items = asRecordArray(secrets)
    .map((secret) => normalizeRuntimeSecret(secret, refs))
    .sort((left, right) => (left.namespace === right.namespace ? left.name.localeCompare(right.name) : left.namespace.localeCompare(right.namespace)));
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    namespaceScope,
    summary: {
      total: items.length,
      referenced: items.filter((item) => item.referenceCount > 0).length,
      unreferenced: items.filter((item) => item.riskFlags.includes('unreferenced')).length,
      sensitive: items.filter((item) => item.riskFlags.includes('tls') || item.riskFlags.includes('registry') || item.riskFlags.includes('sensitive-keys')).length,
      tls: items.filter((item) => item.riskFlags.includes('tls')).length,
      registryCredentials: items.filter((item) => item.riskFlags.includes('registry')).length,
      serviceAccountTokens: items.filter((item) => item.riskFlags.includes('service-account-token')).length
    },
    secrets: buildResourceList(items, fetchedAt, issues, partial)
  };
}

export async function loadLocalSecrets(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/secrets', '/api/v1/namespaces/:namespace/secrets', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/serviceaccounts', '/api/v1/namespaces/:namespace/serviceaccounts', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace))
    ]);
    if (requests[0].status === 'rejected') throw requests[0].reason;
    const issues = [];
    const secrets = settledSection(requests[0], 'secrets', 'Secrets could not be loaded.', 'The Secret list was truncated for this runtime read.', issues);
    const pods = settledSection(requests[1], 'secrets', 'Pods could not be loaded for Secret references.', 'The Pod list was truncated for Secret references.', issues);
    const serviceAccounts = settledSection(requests[2], 'secrets', 'ServiceAccounts could not be loaded for Secret references.', 'The ServiceAccount list was truncated for Secret references.', issues);
    const ingresses = settledSection(requests[3], 'secrets', 'Ingresses could not be loaded for TLS Secret references.', 'The Ingress list was truncated for Secret references.', issues);
    return buildRuntimeSecretInventory(secrets.items, pods.items, serviceAccounts.items, ingresses.items, new Date().toISOString(), effectiveNamespace, issues, secrets.partial || pods.partial || serviceAccounts.partial || ingresses.partial);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function normalizeRuntimeCrd(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const names = asRecord(spec?.names);
  const conditions = asRecordArray(status?.conditions);
  return {
    name: meta.name,
    group: stringOrUndefined(spec?.group) || 'unknown',
    kind: stringOrUndefined(names?.kind) || 'Unknown',
    plural: stringOrUndefined(names?.plural) || 'objects',
    scope: stringOrUndefined(spec?.scope) || 'Unknown',
    versions: asRecordArray(spec?.versions).filter((entry) => entry.served !== false).map((entry) => stringOrUndefined(entry.name)).filter(Boolean),
    storedVersions: Array.isArray(status?.storedVersions) ? status.storedVersions.filter((entry) => typeof entry === 'string') : [],
    categories: Array.isArray(names?.categories) ? names.categories.filter((entry) => typeof entry === 'string') : [],
    established: conditions.some((condition) => condition.type === 'Established' && condition.status === 'True'),
    namesAccepted: conditions.some((condition) => condition.type === 'NamesAccepted' && condition.status === 'True'),
    createdAt: meta.createdAt
  };
}

function buildRuntimeCrdInventory(crds, fetchedAt, issues = [], partial = false) {
  const items = asRecordArray(crds).map(normalizeRuntimeCrd).sort((left, right) => left.name.localeCompare(right.name));
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    summary: {
      total: items.length,
      namespaced: items.filter((item) => item.scope === 'Namespaced').length,
      clusterScoped: items.filter((item) => item.scope === 'Cluster').length,
      established: items.filter((item) => item.established).length
    },
    crds: buildResourceList(items, fetchedAt, issues, partial)
  };
}

function normalizeRuntimeCustomResourceObject(record, crd) {
  const meta = metadataFor(record);
  const status = asRecord(record.status);
  const spec = asRecord(record.spec);
  const conditions = asRecordArray(status?.conditions);
  return {
    id: meta.namespace ? `${meta.namespace}/${meta.name}` : meta.name,
    name: meta.name,
    namespace: meta.namespace,
    apiVersion: stringOrUndefined(record.apiVersion) || `${crd.group}/${crd.versions?.[0] || 'v1'}`,
    kind: stringOrUndefined(record.kind) || crd.kind,
    createdAt: meta.createdAt,
    labelsCount: Object.keys(meta.labels).length,
    annotationsCount: Object.keys(meta.annotations).length,
    ownerReferences: meta.ownerReferences.map((reference) => ({
      kind: stringOrUndefined(reference.kind) || 'Unknown',
      name: stringOrUndefined(reference.name) || 'unknown',
      namespace: meta.namespace
    })),
    statusPhase: stringOrUndefined(status?.phase) || stringOrUndefined(status?.status),
    statusConditions: conditions
      .map((condition) => [stringOrUndefined(condition.type), stringOrUndefined(condition.status), stringOrUndefined(condition.reason)].filter(Boolean).join(':'))
      .filter(Boolean),
    specKeys: Object.keys(spec || {}).sort(),
    statusKeys: Object.keys(status || {}).sort()
  };
}

function runtimeCustomResourcePath(crd, namespaceScope = null) {
  const version = crd.versions?.[0] || crd.storedVersions?.[0];
  if (!version) {
    throw new Error(`CRD ${crd.name} does not expose a served version.`);
  }
  if (crd.scope === 'Namespaced' && namespaceScope && namespaceScope !== 'all') {
    return `/apis/${encodeURIComponent(crd.group)}/${encodeURIComponent(version)}/namespaces/${encodeURIComponent(namespaceScope)}/${encodeURIComponent(crd.plural)}`;
  }
  return `/apis/${encodeURIComponent(crd.group)}/${encodeURIComponent(version)}/${encodeURIComponent(crd.plural)}`;
}

export async function loadLocalCrds(runtimeConfig) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const crds = await fetchKubeList(kubeConfig, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
    const issues = crds.truncated ? [truncationIssue('crds', 'The CustomResourceDefinition list was truncated for this runtime read.')] : [];
    return buildRuntimeCrdInventory(crds.items, new Date().toISOString(), issues, crds.truncated);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalCrdObjects(runtimeConfig, input) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const crd = input?.crd;
    if (!crd || !crd.group || !crd.plural || !crd.kind) {
      throw new Error('CRD metadata is required.');
    }
    const namespaceScope = input?.namespaceScope || null;
    const objects = await fetchKubeList(kubeConfig, runtimeCustomResourcePath(crd, namespaceScope), true);
    const fetchedAt = new Date().toISOString();
    const issues = objects.truncated ? [truncationIssue('crds', `The ${crd.kind} object list was truncated for this runtime read.`)] : [];
    const partial = objects.truncated;
    return {
      crd,
      namespaceScope: namespaceScope && namespaceScope !== 'all' ? namespaceScope : null,
      fetchedAt,
      issues,
      partial,
      availability: buildAvailability(issues, partial),
      objects: buildResourceList(asRecordArray(objects.items).map((item) => normalizeRuntimeCustomResourceObject(item, crd)), fetchedAt, issues, partial)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function runtimeProviderEvidence(crds, pods, deployments, matcher) {
  const evidence = [];
  const add = (value) => {
    if (!evidence.includes(value)) evidence.push(value);
  };
  asRecordArray(crds).forEach((crd) => {
    const name = metadataFor(crd).name;
    if (matcher(name)) add(`CRD ${name}`);
  });
  asRecordArray(pods).forEach((pod) => {
    const meta = metadataFor(pod);
    const names = [...asRecordArray(asRecord(pod.spec)?.containers), ...asRecordArray(asRecord(pod.spec)?.initContainers)].map((container) => stringOrUndefined(container.name) || '').join(' ');
    if (matcher(`${meta.namespace}/${meta.name} ${names}`)) add(`Pod ${meta.namespace}/${meta.name}`);
  });
  asRecordArray(deployments).forEach((deployment) => {
    const meta = metadataFor(deployment);
    if (matcher(`${meta.namespace}/${meta.name}`)) add(`Deployment ${meta.namespace}/${meta.name}`);
  });
  return evidence.slice(0, 8);
}

function runtimeProvider(key, name, evidence) {
  if (evidence.length === 0) return null;
  return { key, name, confidence: evidence.length >= 2 ? 'high' : 'medium', evidence };
}

function runtimePodHasMeshSidecar(pod) {
  const names = pod.containers.map((container) => container.name.toLowerCase());
  const images = pod.containers.map((container) => container.image.toLowerCase());
  return names.some((name) => ['istio-proxy', 'linkerd-proxy', 'envoy', 'kuma-sidecar'].includes(name)) || images.some((image) => image.includes('/proxyv2') || image.includes('linkerd/proxy') || image.includes('envoyproxy/envoy') || image.includes('kuma-dp'));
}

function runtimeNormalizeMeshName(value) {
  return String(value || '').trim().toLowerCase();
}

function runtimeDedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = runtimeNormalizeMeshName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function runtimeDedupeMeshIssues(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = [item.severity, item.issueType, item.message].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function runtimeActiveMeshProvider(providers) {
  return providers.find((provider) => provider.key === 'istio') || providers[0] || null;
}

function runtimeServiceHostAliases(name, namespace) {
  const base = runtimeNormalizeMeshName(name);
  const ns = runtimeNormalizeMeshName(namespace);
  return base && ns ? [base, `${base}.${ns}`, `${base}.${ns}.svc`, `${base}.${ns}.svc.cluster.local`] : [];
}

function runtimeResolvableServiceHosts(services) {
  const hosts = new Set();
  for (const service of asRecordArray(services)) {
    const meta = metadataFor(service);
    for (const alias of runtimeServiceHostAliases(meta.name, meta.namespace)) hosts.add(alias);
  }
  return hosts;
}

function runtimeMeshGatewayRef(namespace, name) {
  return `${runtimeNormalizeMeshName(namespace)}/${runtimeNormalizeMeshName(name)}`;
}

function runtimeGatewayRefs(gateways) {
  const refs = new Set();
  for (const gateway of asRecordArray(gateways)) {
    const meta = metadataFor(gateway);
    if (meta.namespace && meta.name) refs.add(runtimeMeshGatewayRef(meta.namespace, meta.name));
  }
  return refs;
}

function runtimeMeshHostCandidates(host, namespace) {
  const normalized = runtimeNormalizeMeshName(host);
  if (!normalized) return [];
  const candidates = [normalized];
  if (!normalized.includes('.') && namespace) {
    candidates.push(runtimeNormalizeMeshName(`${normalized}.${namespace}`));
    candidates.push(runtimeNormalizeMeshName(`${normalized}.${namespace}.svc`));
    candidates.push(runtimeNormalizeMeshName(`${normalized}.${namespace}.svc.cluster.local`));
  }
  if (normalized.split('.').length === 2) {
    candidates.push(runtimeNormalizeMeshName(`${normalized}.svc`));
    candidates.push(runtimeNormalizeMeshName(`${normalized}.svc.cluster.local`));
  }
  return runtimeDedupeStrings(candidates);
}

function runtimeDestinationRuleSubsets(destinationRules) {
  const index = new Map();
  for (const rule of asRecordArray(destinationRules)) {
    const meta = metadataFor(rule);
    const host = stringOrUndefined(asRecord(rule.spec)?.host) || '';
    for (const candidate of runtimeMeshHostCandidates(host, meta.namespace)) {
      if (!index.has(candidate)) index.set(candidate, new Set());
      for (const subset of asRecordArray(asRecord(rule.spec)?.subsets)) {
        const name = stringOrUndefined(subset.name);
        if (name) index.get(candidate).add(runtimeNormalizeMeshName(name));
      }
    }
  }
  return index;
}

function runtimeMeshSubsetExists(index, host, namespace, subset) {
  if (!subset) return true;
  return runtimeMeshHostCandidates(host, namespace).some((candidate) => index.get(candidate)?.has(runtimeNormalizeMeshName(subset)));
}

function runtimeMeshHostResolvable(host, namespace, serviceHosts, serviceEntryHosts) {
  return runtimeMeshHostCandidates(host, namespace).some((candidate) => serviceHosts.has(candidate) || serviceEntryHosts.has(candidate));
}

function runtimeNumberOrUndefined(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function runtimeMeshPorts(object) {
  return asRecordArray(asRecord(object.spec)?.ports).map((port) => {
    const number = runtimeNumberOrUndefined(port.number) ?? stringOrUndefined(port.number);
    return [stringOrUndefined(port.name), number !== undefined ? String(number) : undefined, stringOrUndefined(port.protocol)].filter(Boolean).join(' ').trim();
  }).filter(Boolean);
}

function runtimeMeshRegistry(serviceEntries, workloadEntries) {
  const items = [];
  const issues = [];
  const serviceEntryHosts = new Set();
  for (const entry of asRecordArray(serviceEntries)) {
    const meta = metadataFor(entry);
    const spec = asRecord(entry.spec);
    const hosts = Array.isArray(spec?.hosts) ? spec.hosts.filter((value) => typeof value === 'string') : [];
    const addresses = Array.isArray(spec?.addresses) ? spec.addresses.filter((value) => typeof value === 'string') : [];
    const location = stringOrUndefined(spec?.location);
    const item = { id: `serviceentry:${meta.namespace}/${meta.name}`, namespace: meta.namespace, name: meta.name, kind: 'ServiceEntry', hosts, ...(addresses.length ? { address: addresses.join(', ') } : {}), ...(stringOrUndefined(spec?.resolution) ? { resolution: stringOrUndefined(spec?.resolution) } : {}), ...(location ? { location } : {}), ports: runtimeMeshPorts(entry), issues: [] };
    if (hosts.length === 0) {
      const issue = { severity: 'warning', issueType: 'Missing host', message: `ServiceEntry ${meta.namespace}/${meta.name} has no hosts.` };
      item.issues.push(issue); issues.push(issue);
    }
    if (addresses.length === 0 && location?.toUpperCase() === 'MESH_EXTERNAL') {
      const issue = { severity: 'info', issueType: 'No address', message: `ServiceEntry ${meta.namespace}/${meta.name} has no explicit address.` };
      item.issues.push(issue); issues.push(issue);
    }
    for (const host of hosts) serviceEntryHosts.add(runtimeNormalizeMeshName(host));
    items.push(item);
  }
  for (const entry of asRecordArray(workloadEntries)) {
    const meta = metadataFor(entry);
    const address = stringOrUndefined(asRecord(entry.spec)?.address);
    const item = { id: `workloadentry:${meta.namespace}/${meta.name}`, namespace: meta.namespace, name: meta.name, kind: 'WorkloadEntry', hosts: [], ...(address ? { address } : {}), ports: runtimeMeshPorts(entry), issues: [] };
    if (!address) {
      const issue = { severity: 'warning', issueType: 'Missing address', message: `WorkloadEntry ${meta.namespace}/${meta.name} has no address.` };
      item.issues.push(issue); issues.push(issue);
    }
    items.push(item);
  }
  items.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return { items, issues, serviceEntryHosts };
}

function runtimeVirtualServiceGateways(values, namespace) {
  if (!Array.isArray(values) || values.length === 0) return ['mesh'];
  return runtimeDedupeStrings(values.flatMap((value) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    if (value.trim() === 'mesh') return ['mesh'];
    if (value.includes('/')) {
      const [ns, name] = value.split('/', 2);
      return [runtimeMeshGatewayRef(ns, name)];
    }
    return [runtimeMeshGatewayRef(namespace, value)];
  }));
}

function runtimeVirtualServiceDestinations(rule, namespace, serviceHosts, serviceEntryHosts, subsetIndex) {
  return asRecordArray(rule.route).flatMap((entry) => {
    const destination = asRecord(entry.destination);
    if (!destination) return [];
    const host = stringOrUndefined(destination.host) || '';
    const subset = stringOrUndefined(destination.subset);
    const portRecord = asRecord(destination.port);
    const portNumber = runtimeNumberOrUndefined(portRecord?.number) ?? stringOrUndefined(portRecord?.number);
    const weight = runtimeNumberOrUndefined(entry.weight);
    return [{ host, ...(subset ? { subset } : {}), ...(weight && weight > 0 ? { weight } : {}), ...(portNumber !== undefined ? { port: String(portNumber) } : {}), resolved: runtimeMeshHostResolvable(host, namespace, serviceHosts, serviceEntryHosts) || runtimeMeshSubsetExists(subsetIndex, host, namespace, subset) }];
  });
}

function runtimeMeshTrafficSplit(destinations) {
  if (destinations.length === 0) return '-';
  return destinations.map((destination) => `${destination.host}${destination.subset ? `[${destination.subset}]` : ''}${destination.weight ? ` ${destination.weight}%` : ''}`).join(' | ');
}

function runtimeIstioRoutes(virtualServices, gateways, services, serviceEntryHosts, destinationRules) {
  const gatewayRefs = runtimeGatewayRefs(gateways);
  const serviceHosts = runtimeResolvableServiceHosts(services);
  const subsetIndex = runtimeDestinationRuleSubsets(destinationRules);
  const routes = [];
  const issues = [];
  for (const virtualService of asRecordArray(virtualServices)) {
    const meta = metadataFor(virtualService);
    const spec = asRecord(virtualService.spec);
    const hosts = Array.isArray(spec?.hosts) ? spec.hosts.filter((value) => typeof value === 'string') : [];
    const routeHosts = hosts.length ? hosts : ['*'];
    const gatewaysForRoute = runtimeVirtualServiceGateways(spec?.gateways, meta.namespace);
    const routeKinds = [{ kind: 'HTTP', rules: asRecordArray(spec?.http) }, { kind: 'TLS', rules: asRecordArray(spec?.tls) }, { kind: 'TCP', rules: asRecordArray(spec?.tcp) }];
    for (const host of routeHosts) {
      for (const routeKind of routeKinds) {
        routeKind.rules.forEach((rule, index) => {
          const destinations = runtimeVirtualServiceDestinations(rule, meta.namespace, serviceHosts, serviceEntryHosts, subsetIndex);
          const routeIssues = [];
          for (const gateway of gatewaysForRoute) {
            if (gateway !== 'mesh' && !gatewayRefs.has(gateway)) routeIssues.push({ severity: 'warning', issueType: 'Missing gateway', message: `VirtualService ${meta.namespace}/${meta.name} references gateway ${gateway} that was not found.` });
          }
          for (const destination of destinations) {
            if (!destination.resolved) routeIssues.push({ severity: 'warning', issueType: 'Unresolved destination', message: `VirtualService ${meta.namespace}/${meta.name} references destination ${destination.host} that could not be resolved.` });
            if (destination.subset && !runtimeMeshSubsetExists(subsetIndex, destination.host, meta.namespace, destination.subset)) routeIssues.push({ severity: 'warning', issueType: 'Missing subset', message: `VirtualService ${meta.namespace}/${meta.name} references subset ${destination.subset} for host ${destination.host}, but no matching DestinationRule subset was found.` });
          }
          const deduped = runtimeDedupeMeshIssues(routeIssues);
          routes.push({ id: `${meta.namespace}/${meta.name}:${routeKind.kind}:${index}:${host}`, host, namespace: meta.namespace, virtualService: meta.name, gateways: gatewaysForRoute, routeKind: routeKind.kind, destinations, trafficSplit: runtimeMeshTrafficSplit(destinations), issues: deduped });
          issues.push(...deduped);
        });
      }
    }
  }
  routes.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.host.localeCompare(right.host) || left.virtualService.localeCompare(right.virtualService));
  return { routes, issues: runtimeDedupeMeshIssues(issues) };
}

function runtimeSelectorMatchesPods(selector, pods) {
  const entries = Object.entries(selector);
  if (entries.length === 0) return true;
  return pods.some((pod) => entries.every(([key, value]) => metadataFor(pod).labels[key] === value));
}

function runtimeMeshPolicyTarget(namespace, selector) {
  const entries = Object.entries(selector).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : `namespace/${namespace}`;
}

function runtimeIstioPolicies(peerAuthentications, authorizationPolicies, pods) {
  const items = [];
  const issues = [];
  const podsByNamespace = new Map();
  for (const pod of asRecordArray(pods)) {
    const namespace = metadataFor(pod).namespace;
    podsByNamespace.set(namespace, [...(podsByNamespace.get(namespace) || []), pod]);
  }
  const pushPolicy = (record, kind, modeOrAction, idPrefix) => {
    const meta = metadataFor(record);
    const selector = asStringRecord(asRecord(asRecord(record.spec)?.selector)?.matchLabels);
    const item = { id: `${idPrefix}:${meta.namespace}/${meta.name}`, namespace: meta.namespace, name: meta.name, kind, target: runtimeMeshPolicyTarget(meta.namespace, selector), modeOrAction, issues: [] };
    if (Object.keys(selector).length > 0 && !runtimeSelectorMatchesPods(selector, podsByNamespace.get(meta.namespace) || [])) {
      const issue = { severity: 'info', issueType: 'Selector matches nothing', message: `${kind} ${meta.namespace}/${meta.name} selector does not match any pods in namespace ${meta.namespace}.` };
      item.issues.push(issue); issues.push(issue);
    }
    items.push(item);
  };
  for (const policy of asRecordArray(peerAuthentications)) pushPolicy(policy, 'PeerAuthentication', stringOrUndefined(asRecord(asRecord(policy.spec)?.mtls)?.mode) || 'UNSET', 'peerauthentication');
  for (const policy of asRecordArray(authorizationPolicies)) pushPolicy(policy, 'AuthorizationPolicy', stringOrUndefined(asRecord(policy.spec)?.action) || 'ALLOW', 'authorizationpolicy');
  items.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return { items, issues: runtimeDedupeMeshIssues(issues) };
}

function runtimeIstioDeepMeshData(input) {
  const registry = runtimeMeshRegistry(input.serviceEntries, input.workloadEntries);
  const routes = runtimeIstioRoutes(input.virtualServices, input.gateways, input.services, registry.serviceEntryHosts, input.destinationRules);
  const policies = runtimeIstioPolicies(input.peerAuthentications, input.authorizationPolicies, input.pods);
  const issues = runtimeDedupeMeshIssues([...routes.issues, ...policies.issues, ...registry.issues]);
  return {
    summary: { virtualServices: asRecordArray(input.virtualServices).length, destinationRules: asRecordArray(input.destinationRules).length, gateways: asRecordArray(input.gateways).length, peerAuthentications: asRecordArray(input.peerAuthentications).length, authorizationPolicies: asRecordArray(input.authorizationPolicies).length, serviceEntries: asRecordArray(input.serviceEntries).length, workloadEntries: asRecordArray(input.workloadEntries).length, issueCount: issues.length },
    routes: routes.routes,
    policies: policies.items,
    registry: registry.items,
    issues
  };
}

function buildRuntimeServiceMeshInventory(namespaces, pods, deployments, services, crds, fetchedAt, namespaceScope, issues = [], partial = false, deepInput = null) {
  const providers = [
    runtimeProvider('istio', 'Istio', runtimeProviderEvidence(crds, pods, deployments, (value) => /istio\.io|istiod|istio-ingressgateway|istio-proxy/i.test(value))),
    runtimeProvider('linkerd', 'Linkerd', runtimeProviderEvidence(crds, pods, deployments, (value) => /linkerd\.io|linkerd-proxy|linkerd-destination/i.test(value))),
    runtimeProvider('consul', 'Consul Connect', runtimeProviderEvidence(crds, pods, deployments, (value) => /consul\.hashicorp\.com|consul/i.test(value))),
    runtimeProvider('kuma', 'Kuma', runtimeProviderEvidence(crds, pods, deployments, (value) => /kuma\.io|kuma-sidecar|kuma-dp/i.test(value))),
    runtimeProvider('cilium', 'Cilium Service Mesh', runtimeProviderEvidence(crds, pods, deployments, (value) => /cilium\.io|cilium/i.test(value))),
    runtimeProvider('gateway-api', 'Gateway API', runtimeProviderEvidence(crds, pods, deployments, (value) => /gateway\.networking\.k8s\.io/i.test(value)))
  ].filter(Boolean);
  const normalizedPods = asRecordArray(pods).map(normalizeRuntimePod);
  const meshPods = normalizedPods.filter((pod) => runtimePodHasMeshSidecar(pod) || /istio|linkerd|consul|kuma|cilium|envoy/i.test(`${pod.namespace}/${pod.name}`));
  const sidecarPods = normalizedPods.filter(runtimePodHasMeshSidecar);
  const meshNamespaceNames = new Set(meshPods.map((pod) => pod.namespace));
  const meshNamespaces = asRecordArray(namespaces)
    .filter((namespace) => {
      const meta = metadataFor(namespace);
      const combined = `${Object.keys(meta.labels).join(' ')} ${Object.values(meta.labels).join(' ')}`;
      if (/istio-injection|linkerd\.io\/inject|kuma\.io\/sidecar-injection|consul\.hashicorp\.com\/connect-inject/i.test(combined)) meshNamespaceNames.add(meta.name);
      return meshNamespaceNames.has(meta.name);
    })
    .map(normalizeNamespace)
    .sort((left, right) => left.name.localeCompare(right.name));
  const issuesList = [];
  if (providers.length === 0) {
    issuesList.push({ severity: 'info', issueType: 'no-provider-detected', message: 'No service mesh provider evidence was found in CRDs, workloads, or pods.', objectRefs: [] });
  } else if (sidecarPods.length === 0) {
    issuesList.push({ severity: 'warning', issueType: 'provider-without-sidecars', message: 'Service mesh control-plane evidence exists, but no workload sidecars were detected in the current scope.', objectRefs: [] });
  }
  const gatewayApiCrds = asRecordArray(crds).filter((crd) => metadataFor(crd).name.includes('gateway.networking.k8s.io')).length;
  const activeProvider = runtimeActiveMeshProvider(providers);
  const deepSupport = activeProvider?.key === 'istio';
  const deepData = deepSupport && deepInput ? runtimeIstioDeepMeshData({ ...deepInput, pods, services }) : null;
  const deepPartial = Boolean(deepInput?.partial);
  return {
    fetchedAt,
    issues,
    partial: partial || deepPartial,
    availability: buildAvailability(issues, partial || deepPartial),
    namespaceScope,
    summary: { providers: providers.length, meshPods: meshPods.length, sidecarPods: sidecarPods.length, meshNamespaces: meshNamespaces.length, gatewayApiCrds, issues: issuesList.length + (deepData?.issues.length || 0) },
    ...(activeProvider ? { activeProviderId: activeProvider.key } : {}),
    deepSupport,
    ...(providers.length === 0 ? { message: 'No service mesh detected in this cluster.' } : !deepSupport ? { message: `Service Mesh detected: ${activeProvider?.name || 'Unknown'}. Deep route and policy visualization is not implemented yet for this provider.` } : {}),
    ...(deepData ? { deepSummary: deepData.summary } : {}),
    providers,
    meshNamespaces: buildResourceList(meshNamespaces, fetchedAt, [], partial),
    meshPods: buildResourceList(meshPods, fetchedAt, [], partial),
    issuesList: buildResourceList(issuesList, fetchedAt, [], partial),
    ...(deepData ? {
      routes: buildResourceList(deepData.routes, fetchedAt, [], deepPartial),
      policies: buildResourceList(deepData.policies, fetchedAt, [], deepPartial),
      registry: buildResourceList(deepData.registry, fetchedAt, [], deepPartial),
      deepIssues: buildResourceList(deepData.issues, fetchedAt, [], deepPartial)
    } : {})
  };
}

async function fetchFirstAvailableLocalMeshResource(kubeConfig, namespaceScope, group, versions, resource) {
  for (const version of versions) {
    const base = `/apis/${group}/${version}`;
    const path = namespaceScope && namespaceScope !== 'all'
      ? `${base}/namespaces/${encodeURIComponent(namespaceScope)}/${resource}`
      : `${base}/${resource}`;
    const response = await fetchKubeList(kubeConfig, path, true);
    if (response.items.length > 0 || response.truncated) return response;
  }
  return { items: [], truncated: false };
}

export async function loadLocalServiceMesh(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const meshResource = (group, versions, resource) => fetchFirstAvailableLocalMeshResource(kubeConfig, effectiveNamespace, group, versions, resource);
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, '/api/v1/namespaces'),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/apps/v1/deployments', '/apis/apps/v1/namespaces/:namespace/deployments', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(kubeConfig, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
      meshResource('networking.istio.io', ['v1', 'v1beta1', 'v1alpha3'], 'virtualservices'),
      meshResource('networking.istio.io', ['v1', 'v1beta1', 'v1alpha3'], 'destinationrules'),
      meshResource('networking.istio.io', ['v1', 'v1beta1', 'v1alpha3'], 'gateways'),
      meshResource('networking.istio.io', ['v1', 'v1beta1', 'v1alpha3'], 'serviceentries'),
      meshResource('networking.istio.io', ['v1', 'v1beta1', 'v1alpha3'], 'workloadentries'),
      meshResource('security.istio.io', ['v1', 'v1beta1', 'v1alpha1'], 'peerauthentications'),
      meshResource('security.istio.io', ['v1', 'v1beta1', 'v1alpha1'], 'authorizationpolicies')
    ]);
    if (requests.every((entry) => entry.status === 'rejected')) throw requests[0].reason;
    const issues = [];
    const namespaces = settledSection(requests[0], 'service-mesh', 'Namespaces could not be loaded for service mesh detection.', 'The Namespace list was truncated for service mesh detection.', issues);
    const pods = settledSection(requests[1], 'service-mesh', 'Pods could not be loaded for service mesh detection.', 'The Pod list was truncated for service mesh detection.', issues);
    const deployments = settledSection(requests[2], 'service-mesh', 'Deployments could not be loaded for service mesh detection.', 'The Deployment list was truncated for service mesh detection.', issues);
    const services = settledSection(requests[3], 'service-mesh', 'Services could not be loaded for service mesh detection.', 'The Service list was truncated for service mesh detection.', issues);
    const crds = settledSection(requests[4], 'service-mesh', 'CRDs could not be loaded for service mesh detection.', 'The CRD list was truncated for service mesh detection.', issues);
    const virtualServices = settledSection(requests[5], 'service-mesh', 'VirtualServices could not be loaded for service mesh inspection.', 'The VirtualService list was truncated for this runtime read.', issues);
    const destinationRules = settledSection(requests[6], 'service-mesh', 'DestinationRules could not be loaded for service mesh inspection.', 'The DestinationRule list was truncated for this runtime read.', issues);
    const gateways = settledSection(requests[7], 'service-mesh', 'Gateways could not be loaded for service mesh inspection.', 'The Gateway list was truncated for this runtime read.', issues);
    const serviceEntries = settledSection(requests[8], 'service-mesh', 'ServiceEntries could not be loaded for service mesh inspection.', 'The ServiceEntry list was truncated for this runtime read.', issues);
    const workloadEntries = settledSection(requests[9], 'service-mesh', 'WorkloadEntries could not be loaded for service mesh inspection.', 'The WorkloadEntry list was truncated for this runtime read.', issues);
    const peerAuthentications = settledSection(requests[10], 'service-mesh', 'PeerAuthentications could not be loaded for service mesh inspection.', 'The PeerAuthentication list was truncated for this runtime read.', issues);
    const authorizationPolicies = settledSection(requests[11], 'service-mesh', 'AuthorizationPolicies could not be loaded for service mesh inspection.', 'The AuthorizationPolicy list was truncated for this runtime read.', issues);
    const deepPartial = virtualServices.partial || destinationRules.partial || gateways.partial || serviceEntries.partial || workloadEntries.partial || peerAuthentications.partial || authorizationPolicies.partial;
    return buildRuntimeServiceMeshInventory(namespaces.items, pods.items, deployments.items, services.items, crds.items, new Date().toISOString(), effectiveNamespace, issues, namespaces.partial || pods.partial || deployments.partial || services.partial || crds.partial || deepPartial, {
      virtualServices: virtualServices.items,
      destinationRules: destinationRules.items,
      gateways: gateways.items,
      serviceEntries: serviceEntries.items,
      workloadEntries: workloadEntries.items,
      peerAuthentications: peerAuthentications.items,
      authorizationPolicies: authorizationPolicies.items,
      partial: deepPartial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function runtimeServiceEndpointStatus(service, endpointSlices) {
  const meta = metadataFor(service);
  const slices = endpointSlices.filter((slice) => asStringRecord(asRecord(slice.metadata)?.labels)['kubernetes.io/service-name'] === meta.name && metadataFor(slice).namespace === meta.namespace);
  let readyAddresses = 0;
  let addresses = 0;
  for (const slice of slices) {
    for (const endpoint of asRecordArray(slice.endpoints)) {
      const endpointAddresses = Array.isArray(endpoint.addresses) ? endpoint.addresses : [];
      addresses += endpointAddresses.length;
      if (asRecord(endpoint.conditions)?.ready !== false) readyAddresses += endpointAddresses.length;
    }
  }
  return { slices: slices.length, addresses, readyAddresses };
}

function runtimeBackendServiceNames(ingress) {
  const names = [];
  const add = (name) => {
    const value = stringOrUndefined(name);
    if (value && !names.includes(value)) names.push(value);
  };
  const spec = asRecord(ingress.spec);
  add(asRecord(asRecord(spec?.defaultBackend)?.service)?.name);
  for (const rule of asRecordArray(spec?.rules)) {
    for (const pathItem of asRecordArray(asRecord(rule.http)?.paths)) {
      add(asRecord(asRecord(pathItem.backend)?.service)?.name);
    }
  }
  return names;
}

function pushRuntimeGhostIssue(issues, input) {
  issues.push({ id: `${input.category}:${input.namespace || '_'}:${input.resourceKind}:${input.resourceName}:${issues.length}`, ...input });
}

function collectRuntimePodRefs(pods) {
  const pvcs = new Set();
  const configMaps = new Set();
  const secrets = new Set();
  const serviceAccounts = new Set();
  for (const pod of asRecordArray(pods)) {
    const meta = metadataFor(pod);
    const spec = asRecord(pod.spec);
    serviceAccounts.add(referenceKey(meta.namespace, stringOrUndefined(spec?.serviceAccountName) || 'default'));
    for (const volume of asRecordArray(spec?.volumes)) {
      const pvcName = stringOrUndefined(asRecord(volume.persistentVolumeClaim)?.claimName);
      const configMapName = stringOrUndefined(asRecord(volume.configMap)?.name);
      const secretName = stringOrUndefined(asRecord(volume.secret)?.secretName);
      if (pvcName) pvcs.add(referenceKey(meta.namespace, pvcName));
      if (configMapName) configMaps.add(referenceKey(meta.namespace, configMapName));
      if (secretName) secrets.add(referenceKey(meta.namespace, secretName));
    }
    for (const container of podContainersForRefs(pod)) {
      for (const env of asRecordArray(container.env)) {
        const valueFrom = asRecord(env.valueFrom);
        const configMapName = stringOrUndefined(asRecord(valueFrom?.configMapKeyRef)?.name);
        const secretName = stringOrUndefined(asRecord(valueFrom?.secretKeyRef)?.name);
        if (configMapName) configMaps.add(referenceKey(meta.namespace, configMapName));
        if (secretName) secrets.add(referenceKey(meta.namespace, secretName));
      }
      for (const envFrom of asRecordArray(container.envFrom)) {
        const configMapName = stringOrUndefined(asRecord(envFrom.configMapRef)?.name);
        const secretName = stringOrUndefined(asRecord(envFrom.secretRef)?.name);
        if (configMapName) configMaps.add(referenceKey(meta.namespace, configMapName));
        if (secretName) secrets.add(referenceKey(meta.namespace, secretName));
      }
    }
  }
  return { pvcs, configMaps, secrets, serviceAccounts };
}

function isRuntimeSystemNamespace(namespace) {
  return namespace === 'kube-system' || namespace === 'kube-public' || namespace === 'kube-node-lease';
}

function buildRuntimeGhostResources(services, endpointSlices, ingresses, pvcs, pods, configMaps, secrets, serviceAccounts, replicaSets, fetchedAt, namespaceScope, issues = [], partial = false) {
  const ghostIssues = [];
  const serviceRecords = asRecordArray(services);
  const serviceKeys = new Set(serviceRecords.map((service) => referenceKey(metadataFor(service).namespace, metadataFor(service).name)));
  const endpointSliceRecords = asRecordArray(endpointSlices);
  const podRefs = collectRuntimePodRefs(pods);
  for (const service of serviceRecords) {
    const meta = metadataFor(service);
    const selector = asStringRecord(asRecord(service.spec)?.selector);
    if (Object.keys(selector).length === 0) continue;
    const endpointStatus = runtimeServiceEndpointStatus(service, endpointSliceRecords);
    if (endpointStatus.readyAddresses === 0) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'services-without-endpoints', severity: 'warning', resourceKind: 'Service', resourceName: meta.name, namespace: meta.namespace, reason: `Service selector exists but no ready EndpointSlice addresses were found (${endpointStatus.slices} slices, ${endpointStatus.addresses} addresses).`, related: [{ kind: 'Service', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Check the service selector labels.', 'Verify matching pods are running and ready.'] });
    }
  }
  for (const ingress of asRecordArray(ingresses)) {
    const meta = metadataFor(ingress);
    for (const serviceName of runtimeBackendServiceNames(ingress)) {
      if (!serviceKeys.has(referenceKey(meta.namespace, serviceName))) {
        pushRuntimeGhostIssue(ghostIssues, { category: 'broken-ingress-backends', severity: 'critical', resourceKind: 'Ingress', resourceName: meta.name, namespace: meta.namespace, reason: `Ingress references backend service ${serviceName}, but that service was not found in the same namespace.`, related: [{ kind: 'Service', name: serviceName, namespace: meta.namespace }], suggestedActions: ['Create the backend Service or update the Ingress backend reference.'] });
      }
    }
  }
  for (const pvc of asRecordArray(pvcs)) {
    const meta = metadataFor(pvc);
    const status = stringOrUndefined(asRecord(pvc.status)?.phase) || 'Unknown';
    if (status === 'Bound' && !podRefs.pvcs.has(referenceKey(meta.namespace, meta.name))) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'unused-pvc', severity: 'warning', resourceKind: 'PersistentVolumeClaim', resourceName: meta.name, namespace: meta.namespace, reason: 'Bound PVC is not mounted by any runtime-visible pod.', related: [{ kind: 'PersistentVolumeClaim', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Confirm the claim is still needed before deleting it.'] });
    }
  }
  for (const configMap of asRecordArray(configMaps)) {
    const meta = metadataFor(configMap);
    if (!isRuntimeSystemNamespace(meta.namespace) && !podRefs.configMaps.has(referenceKey(meta.namespace, meta.name))) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'unused-configmaps', severity: 'info', resourceKind: 'ConfigMap', resourceName: meta.name, namespace: meta.namespace, reason: 'ConfigMap is not referenced by pod volumes, env, or envFrom in the current snapshot.', related: [{ kind: 'ConfigMap', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Check application configuration history before cleanup.'] });
    }
  }
  for (const secret of asRecordArray(secrets)) {
    const meta = metadataFor(secret);
    const type = stringOrUndefined(secret.type) || 'Opaque';
    if (!isRuntimeSystemNamespace(meta.namespace) && type !== 'kubernetes.io/service-account-token' && !meta.name.startsWith('sh.helm.release.v1.') && !podRefs.secrets.has(referenceKey(meta.namespace, meta.name))) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'unused-secrets', severity: 'info', resourceKind: 'Secret', resourceName: meta.name, namespace: meta.namespace, reason: 'Secret is not referenced by pods in volumes, env, envFrom, or imagePullSecrets in the current snapshot.', related: [{ kind: 'Secret', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Verify no external controller consumes this Secret before cleanup.'] });
    }
  }
  for (const serviceAccount of asRecordArray(serviceAccounts)) {
    const meta = metadataFor(serviceAccount);
    if (!isRuntimeSystemNamespace(meta.namespace) && meta.name !== 'default' && !podRefs.serviceAccounts.has(referenceKey(meta.namespace, meta.name))) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'unused-serviceaccounts', severity: 'info', resourceKind: 'ServiceAccount', resourceName: meta.name, namespace: meta.namespace, reason: 'ServiceAccount is not used by any runtime-visible pod.', related: [{ kind: 'ServiceAccount', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Check RBAC bindings before removing the ServiceAccount.'] });
    }
  }
  for (const replicaSet of asRecordArray(replicaSets)) {
    const meta = metadataFor(replicaSet);
    const owners = asRecordArray(asRecord(replicaSet.metadata)?.ownerReferences);
    if (!owners.some((owner) => owner.kind === 'Deployment')) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'orphan-replicasets', severity: 'info', resourceKind: 'ReplicaSet', resourceName: meta.name, namespace: meta.namespace, reason: 'ReplicaSet does not have a Deployment owner reference.', related: [{ kind: 'ReplicaSet', name: meta.name, namespace: meta.namespace }], suggestedActions: ['Confirm this ReplicaSet is expected before cleanup.'] });
    }
  }
  for (const endpointSlice of endpointSliceRecords) {
    const meta = metadataFor(endpointSlice);
    const serviceName = asStringRecord(asRecord(endpointSlice.metadata)?.labels)['kubernetes.io/service-name'];
    if (serviceName && !serviceKeys.has(referenceKey(meta.namespace, serviceName))) {
      pushRuntimeGhostIssue(ghostIssues, { category: 'orphan-endpointslices', severity: 'info', resourceKind: 'EndpointSlice', resourceName: meta.name, namespace: meta.namespace, reason: `EndpointSlice points to service ${serviceName}, but that Service was not found.`, related: [{ kind: 'Service', name: serviceName, namespace: meta.namespace }], suggestedActions: ['Check whether the owning Service was deleted or recreated.'] });
    }
  }
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    namespaceScope,
    summary: {
      total: ghostIssues.length,
      servicesWithoutEndpoints: ghostIssues.filter((issue) => issue.category === 'services-without-endpoints').length,
      brokenIngressBackends: ghostIssues.filter((issue) => issue.category === 'broken-ingress-backends').length,
      unusedPVC: ghostIssues.filter((issue) => issue.category === 'unused-pvc').length,
      unusedConfigMaps: ghostIssues.filter((issue) => issue.category === 'unused-configmaps').length,
      unusedSecrets: ghostIssues.filter((issue) => issue.category === 'unused-secrets').length,
      unusedServiceAccounts: ghostIssues.filter((issue) => issue.category === 'unused-serviceaccounts').length,
      orphanReplicaSets: ghostIssues.filter((issue) => issue.category === 'orphan-replicasets').length,
      orphanEndpointSlices: ghostIssues.filter((issue) => issue.category === 'orphan-endpointslices').length
    },
    issuesList: buildResourceList(ghostIssues, fetchedAt, [], partial)
  };
}

export async function loadLocalGhostResources(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/discovery.k8s.io/v1/endpointslices', '/apis/discovery.k8s.io/v1/namespaces/:namespace/endpointslices', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/persistentvolumeclaims', '/api/v1/namespaces/:namespace/persistentvolumeclaims', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/configmaps', '/api/v1/namespaces/:namespace/configmaps', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/secrets', '/api/v1/namespaces/:namespace/secrets', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/serviceaccounts', '/api/v1/namespaces/:namespace/serviceaccounts', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/apps/v1/replicasets', '/apis/apps/v1/namespaces/:namespace/replicasets', effectiveNamespace))
    ]);
    if (requests.every((entry) => entry.status === 'rejected')) throw requests[0].reason;
    const issues = [];
    const services = settledSection(requests[0], 'ghost-resources', 'Services could not be loaded for ghost-resource checks.', 'The Service list was truncated for ghost-resource checks.', issues);
    const endpointSlices = settledSection(requests[1], 'ghost-resources', 'EndpointSlices could not be loaded for ghost-resource checks.', 'The EndpointSlice list was truncated for ghost-resource checks.', issues);
    const ingresses = settledSection(requests[2], 'ghost-resources', 'Ingresses could not be loaded for ghost-resource checks.', 'The Ingress list was truncated for ghost-resource checks.', issues);
    const pvcs = settledSection(requests[3], 'ghost-resources', 'PVCs could not be loaded for ghost-resource checks.', 'The PVC list was truncated for ghost-resource checks.', issues);
    const pods = settledSection(requests[4], 'ghost-resources', 'Pods could not be loaded for ghost-resource checks.', 'The Pod list was truncated for ghost-resource checks.', issues);
    const configMaps = settledSection(requests[5], 'ghost-resources', 'ConfigMaps could not be loaded for ghost-resource checks.', 'The ConfigMap list was truncated for ghost-resource checks.', issues);
    const secrets = settledSection(requests[6], 'ghost-resources', 'Secrets could not be loaded for ghost-resource checks.', 'The Secret list was truncated for ghost-resource checks.', issues);
    const serviceAccounts = settledSection(requests[7], 'ghost-resources', 'ServiceAccounts could not be loaded for ghost-resource checks.', 'The ServiceAccount list was truncated for ghost-resource checks.', issues);
    const replicaSets = settledSection(requests[8], 'ghost-resources', 'ReplicaSets could not be loaded for ghost-resource checks.', 'The ReplicaSet list was truncated for ghost-resource checks.', issues);
    return buildRuntimeGhostResources(services.items, endpointSlices.items, ingresses.items, pvcs.items, pods.items, configMaps.items, secrets.items, serviceAccounts.items, replicaSets.items, new Date().toISOString(), effectiveNamespace, issues, services.partial || endpointSlices.partial || ingresses.partial || pvcs.partial || pods.partial || configMaps.partial || secrets.partial || serviceAccounts.partial || replicaSets.partial);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function parseRuntimeImage(image) {
  const [withoutDigest, digest] = image.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : undefined;
  return { repository, tag, digest, versionKey: digest ? `@${digest}` : tag ? `:${tag}` : ':<none>' };
}

function runtimeImageIsPrivate(repository) {
  const firstSegment = repository.split('/')[0] || '';
  return firstSegment.includes('.') || firstSegment.includes(':');
}

function buildRuntimeImageRisk(pods, fetchedAt, namespaceScope, issues = [], partial = false) {
  const groups = new Map();
  const versionsByRepository = new Map();
  for (const pod of asRecordArray(pods)) {
    const normalizedPod = normalizeRuntimePod(pod);
    for (const container of normalizedPod.containers) {
      const parsed = parseRuntimeImage(container.image);
      const versions = versionsByRepository.get(parsed.repository) || new Set();
      versions.add(parsed.versionKey);
      versionsByRepository.set(parsed.repository, versions);
      const usage = { namespace: normalizedPod.namespace, pod: normalizedPod.name, container: container.name, containerType: container.type, pullPolicy: container.imagePullPolicy };
      const existing = groups.get(container.image);
      if (existing) {
        existing.usages.push(usage);
        existing.pods = new Set(existing.usages.map((entry) => `${entry.namespace}/${entry.pod}`)).size;
        existing.namespaces = [...new Set(existing.usages.map((entry) => entry.namespace))].sort((left, right) => left.localeCompare(right));
      } else {
        groups.set(container.image, { image: container.image, repository: parsed.repository, tag: parsed.tag, digest: parsed.digest, severity: 'none', flags: [], namespaces: [normalizedPod.namespace], pods: 1, pullPolicy: container.imagePullPolicy || 'IfNotPresent', usages: [usage] });
      }
    }
  }
  const rows = Array.from(groups.values()).map((row) => {
    const flags = new Set();
    if (!row.tag) flags.add('no-tag');
    if (row.tag === 'latest') flags.add('latest');
    if (!row.digest) flags.add('no-digest');
    if (runtimeImageIsPrivate(row.repository)) flags.add('private-registry');
    if (row.usages.some((usage) => usage.pullPolicy === 'Always')) flags.add('always');
    if ((versionsByRepository.get(row.repository)?.size || 0) > 1) flags.add('drift');
    const risky = flags.has('latest') || flags.has('no-tag') || (flags.has('always') && flags.has('latest'));
    const informational = flags.has('no-digest') || flags.has('drift');
    return { ...row, flags: Array.from(flags).sort((left, right) => left.localeCompare(right)), severity: risky ? 'warning' : informational ? 'info' : 'none', pullPolicy: [...new Set(row.usages.map((usage) => usage.pullPolicy || 'IfNotPresent'))].join(', ') };
  }).sort((left, right) => left.image.localeCompare(right.image));
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    namespaceScope,
    summary: {
      totalImages: rows.length,
      warningImages: rows.filter((row) => row.severity === 'warning').length,
      latest: rows.filter((row) => row.flags.includes('latest')).length,
      noTag: rows.filter((row) => row.flags.includes('no-tag')).length,
      noDigest: rows.filter((row) => row.flags.includes('no-digest')).length,
      drift: rows.filter((row) => row.flags.includes('drift')).length,
      alwaysPullLatest: rows.filter((row) => row.flags.includes('always') && row.flags.includes('latest')).length
    },
    rows: buildResourceList(rows, fetchedAt, [], partial)
  };
}

export async function loadLocalImageRisk(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const pods = await fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace));
    const issues = pods.truncated ? [truncationIssue('image-risk', 'The Pod list was truncated for this image-risk read.')] : [];
    return buildRuntimeImageRisk(pods.items, new Date().toISOString(), effectiveNamespace, issues, pods.truncated);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalRbac(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/apis/rbac.authorization.k8s.io/v1/roles', '/apis/rbac.authorization.k8s.io/v1/namespaces/:namespace/roles', effectiveNamespace)),
      fetchKubeList(kubeConfig, '/apis/rbac.authorization.k8s.io/v1/clusterroles'),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/rbac.authorization.k8s.io/v1/rolebindings', '/apis/rbac.authorization.k8s.io/v1/namespaces/:namespace/rolebindings', effectiveNamespace)
      ),
      fetchKubeList(kubeConfig, '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/serviceaccounts', '/api/v1/namespaces/:namespace/serviceaccounts', effectiveNamespace))
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const roles = settledSection(
      requests[0],
      'rbac',
      'Roles could not be loaded for the RBAC explorer.',
      'The Role list was truncated for this runtime read.',
      issues
    );
    const clusterRoles = settledSection(
      requests[1],
      'rbac',
      'ClusterRoles could not be loaded for the RBAC explorer.',
      'The ClusterRole list was truncated for this runtime read.',
      issues
    );
    const roleBindings = settledSection(
      requests[2],
      'rbac',
      'RoleBindings could not be loaded for the RBAC explorer.',
      'The RoleBinding list was truncated for this runtime read.',
      issues
    );
    const clusterRoleBindings = settledSection(
      requests[3],
      'rbac',
      'ClusterRoleBindings could not be loaded for the RBAC explorer.',
      'The ClusterRoleBinding list was truncated for this runtime read.',
      issues
    );
    const serviceAccounts = settledSection(
      requests[4],
      'rbac',
      'ServiceAccounts could not be loaded for the RBAC explorer.',
      'The ServiceAccount list was truncated for this runtime read.',
      issues
    );

    return buildRbacExplorerSummary({
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      roles,
      clusterRoles,
      roleBindings,
      clusterRoleBindings,
      serviceAccounts,
      issues,
      partial: roles.partial || clusterRoles.partial || roleBindings.partial || clusterRoleBindings.partial || serviceAccounts.partial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalPorts(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/discovery.k8s.io/v1/endpointslices', '/apis/discovery.k8s.io/v1/namespaces/:namespace/endpointslices', effectiveNamespace)
      ),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace))
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const services = settledSection(
      requests[0],
      'ports',
      'Services could not be loaded for port truth.',
      'The Service list was truncated for this runtime read.',
      issues
    );
    const endpointSlices = settledSection(
      requests[1],
      'ports',
      'EndpointSlices could not be loaded for port truth.',
      'The EndpointSlice list was truncated for this runtime read.',
      issues
    );
    const pods = settledSection(
      requests[2],
      'ports',
      'Pods could not be loaded for port truth.',
      'The Pod list was truncated for this runtime read.',
      issues
    );
    const ingresses = settledSection(
      requests[3],
      'ports',
      'Ingresses could not be loaded for port truth.',
      'The Ingress list was truncated for this runtime read.',
      issues
    );

    return buildPortsTruthSummary({
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      services,
      endpointSlices,
      pods,
      ingresses,
      issues,
      partial: services.partial || endpointSlices.partial || pods.partial || ingresses.partial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalTraffic(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace)),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/networking.k8s.io/v1/networkpolicies', '/apis/networking.k8s.io/v1/namespaces/:namespace/networkpolicies', effectiveNamespace)
      )
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const services = settledSection(requests[0], 'traffic', 'Services could not be loaded for traffic inference.', 'The Service list was truncated for this runtime read.', issues);
    const pods = settledSection(requests[1], 'traffic', 'Pods could not be loaded for traffic inference.', 'The Pod list was truncated for this runtime read.', issues);
    const ingresses = settledSection(requests[2], 'traffic', 'Ingresses could not be loaded for traffic inference.', 'The Ingress list was truncated for this runtime read.', issues);
    const networkPolicies = settledSection(
      requests[3],
      'traffic',
      'NetworkPolicies could not be loaded for traffic inference.',
      'The NetworkPolicy list was truncated for this runtime read.',
      issues
    );

    return buildTrafficIntentSummary({
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      services,
      pods,
      ingresses,
      networkPolicies,
      issues,
      partial: services.partial || pods.partial || ingresses.partial || networkPolicies.partial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalCni(runtimeConfig, namespaceScope = null) {
  const components = await loadLocalComponentInventory(runtimeConfig);
  return buildCniPluginsSummary({
    namespaceScope: namespaceScope || runtimeConfig.namespace || null,
    fetchedAt: components.fetchedAt,
    components: { items: components.items, partial: components.partial },
    issues: components.issues,
    partial: components.partial
  });
}

export async function loadLocalVip(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const componentRequest = loadLocalComponentInventory(runtimeConfig);
    const requests = await Promise.allSettled([
      componentRequest,
      fetchKubeList(kubeConfig, namespacePath('/api/v1/configmaps', '/api/v1/namespaces/:namespace/configmaps', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace))
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const components =
      requests[0].status === 'fulfilled'
        ? { items: requests[0].value.items, partial: requests[0].value.partial }
        : (issues.push(partialIssue('vip', 'Component inventory could not be loaded for VIP detection.')), { items: [], partial: true });
    const configMaps = settledSection(requests[1], 'vip', 'ConfigMaps could not be loaded for VIP detection.', 'The ConfigMap list was truncated for this runtime read.', issues);
    const services = settledSection(requests[2], 'vip', 'Services could not be loaded for VIP detection.', 'The Service list was truncated for this runtime read.', issues);

    return buildVipLoadBalancerSummary({
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      components,
      configMaps,
      services,
      issues,
      partial: components.partial || configMaps.partial || services.partial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalTopology(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', effectiveNamespace)),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/discovery.k8s.io/v1/endpointslices', '/apis/discovery.k8s.io/v1/namespaces/:namespace/endpointslices', effectiveNamespace)
      ),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, '/api/v1/nodes')
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const ingresses = settledSection(
      requests[0],
      'topology',
      'Ingresses could not be loaded for topology.',
      'The Ingress list was truncated for this runtime read.',
      issues
    );
    const services = settledSection(
      requests[1],
      'topology',
      'Services could not be loaded for topology.',
      'The Service list was truncated for this runtime read.',
      issues
    );
    const endpointSlices = settledSection(
      requests[2],
      'topology',
      'EndpointSlices could not be loaded for topology.',
      'The EndpointSlice list was truncated for this runtime read.',
      issues
    );
    const pods = settledSection(
      requests[3],
      'topology',
      'Pods could not be loaded for topology.',
      'The Pod list was truncated for this runtime read.',
      issues
    );
    const nodes = settledSection(
      requests[4],
      'topology',
      'Nodes could not be loaded for topology.',
      'The Node list was truncated for this runtime read.',
      issues
    );

    return buildTopologyGraphSummary({
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      ingresses,
      services,
      endpointSlices,
      pods,
      nodes,
      issues,
      partial: ingresses.partial || services.partial || endpointSlices.partial || pods.partial || nodes.partial
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function normalizeStorageClass(record) {
  const meta = metadataFor(record);
  return {
    name: meta.name,
    provisioner: stringOrUndefined(record.provisioner) || 'unknown',
    reclaimPolicy: stringOrUndefined(record.reclaimPolicy),
    volumeBindingMode: stringOrUndefined(record.volumeBindingMode),
    allowExpansion: record.allowVolumeExpansion === true,
    isDefault:
      meta.labels['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      meta.labels['storageclass.beta.kubernetes.io/is-default-class'] === 'true' ||
      asStringRecord(asRecord(record.metadata)?.annotations)['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      asStringRecord(asRecord(record.metadata)?.annotations)['storageclass.beta.kubernetes.io/is-default-class'] === 'true',
    parameters: asStringRecord(record.parameters),
    createdAt: meta.createdAt
  };
}

function normalizePersistentVolume(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const claimRef = asRecord(spec?.claimRef);
  return {
    name: meta.name,
    status: stringOrUndefined(status?.phase) || 'Unknown',
    statusReason: stringOrUndefined(status?.reason),
    statusMessage: stringOrUndefined(status?.message),
    capacity: stringOrUndefined(asRecord(spec?.capacity)?.storage) || stringOrUndefined(asRecord(status?.capacity)?.storage),
    storageClassName: stringOrUndefined(spec?.storageClassName),
    accessModes: Array.isArray(spec?.accessModes) ? spec.accessModes.filter((value) => typeof value === 'string') : [],
    reclaimPolicy: stringOrUndefined(spec?.persistentVolumeReclaimPolicy),
    volumeMode: stringOrUndefined(spec?.volumeMode),
    createdAt: meta.createdAt,
    ...(claimRef
      ? {
          claimRef: {
            namespace: stringOrUndefined(claimRef.namespace) || 'default',
            name: stringOrUndefined(claimRef.name) || 'claim'
          }
        }
      : {})
  };
}

function normalizePersistentVolumeClaim(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const requests = asRecord(asRecord(spec?.resources)?.requests);
  const conditions = asRecordArray(status?.conditions)
    .map((condition) => {
      const type = stringOrUndefined(condition.type);
      if (!type) return null;
      const statusValue = stringOrUndefined(condition.status);
      return statusValue ? `${type}:${statusValue}` : type;
    })
    .filter(Boolean);
  return {
    name: meta.name,
    namespace: meta.namespace,
    status: stringOrUndefined(status?.phase) || 'Unknown',
    statusReason: stringOrUndefined(record.statusReason),
    statusMessage: stringOrUndefined(record.statusMessage),
    conditions,
    requested: stringOrUndefined(requests?.storage),
    capacity: stringOrUndefined(asRecord(status?.capacity)?.storage),
    mountedByPods: [],
    storageClassName: stringOrUndefined(spec?.storageClassName),
    accessModes: Array.isArray(spec?.accessModes) ? spec.accessModes.filter((value) => typeof value === 'string') : [],
    volumeName: stringOrUndefined(spec?.volumeName),
    createdAt: meta.createdAt
  };
}

export function parseNodeSummaryPVCUsage(payload, podVolumeClaims = new Map()) {
  const usage = new Map();
  for (const pod of asRecordArray(asRecord(payload)?.pods)) {
    const podNamespace = stringOrUndefined(asRecord(pod.podRef)?.namespace) || 'default';
    const podName = stringOrUndefined(asRecord(pod.podRef)?.name) || '';
    const volumes = [...asRecordArray(pod.volume), ...asRecordArray(pod.volumes)];
    for (const volume of volumes) {
      const pvcRef = asRecord(volume.pvcRef);
      const directName = stringOrUndefined(pvcRef?.name);
      const volumeName = stringOrUndefined(volume.name);
      const mappedClaim = volumeName && podName ? podVolumeClaims.get(`${podNamespace}/${podName}/${volumeName}`) : undefined;
      const mappedParts = typeof mappedClaim === 'string' ? mappedClaim.split('/') : [];
      const name = directName || mappedParts.slice(1).join('/');
      const namespace = stringOrUndefined(pvcRef?.namespace) || mappedParts[0] || podNamespace;
      const usedBytes = Number(volume.usedBytes);
      const capacityBytes = Number(volume.capacityBytes);
      if (!name || !Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(capacityBytes) || capacityBytes <= 0) continue;
      const key = `${namespace}/${name}`;
      const current = usage.get(key);
      if (!current || usedBytes > current.usedBytes) usage.set(key, { usedBytes, capacityBytes });
    }
  }
  return usage;
}

export function isReliablePVCUsageSample(sample, declaredCapacityBytes) {
  if (!sample || !Number.isFinite(declaredCapacityBytes) || declaredCapacityBytes <= 0) return false;
  if (!Number.isFinite(sample.usedBytes) || sample.usedBytes < 0) return false;
  if (!Number.isFinite(sample.capacityBytes) || sample.capacityBytes <= 0) return false;
  const capacityRatio = sample.capacityBytes / declaredCapacityBytes;
  if (capacityRatio < 0.75 || capacityRatio > 1.25) return false;
  if (sample.usedBytes > sample.capacityBytes) return false;
  return sample.usedBytes <= declaredCapacityBytes * 1.05;
}

async function loadPVCUsage(kubeConfig) {
  let nodes;
  let pods = [];
  try {
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, '/api/v1/nodes'),
      fetchKubeList(kubeConfig, '/api/v1/pods')
    ]);
    if (requests[0].status === 'rejected') throw requests[0].reason;
    nodes = requests[0].value;
    pods = requests[1].status === 'fulfilled' ? asRecordArray(requests[1].value.items) : [];
  } catch (error) {
    const message = sanitizeKubeError(error);
    return {
      usage: new Map(),
      mountedByPods: new Map(),
      status: {
        available: false,
        partial: false,
        missingPermissions: message.includes('HTTP 403') ? ['nodes/proxy'] : [],
        sampledNodes: 0,
        failedNodes: 0,
        message: message.includes('HTTP 403')
          ? 'PVC usage requires read access to the nodes/proxy subresource.'
          : 'PVC usage could not be sampled from cluster nodes.'
      }
    };
  }

  const nodeNames = asRecordArray(nodes.items).map((node) => metadataFor(node).name).filter(Boolean);
  const podVolumeClaims = new Map();
  const mountedByPods = new Map();
  for (const pod of pods) {
    const meta = metadataFor(pod);
    const phase = (stringOrUndefined(asRecord(pod.status)?.phase) || '').toLowerCase();
    const active = !asRecord(pod.metadata)?.deletionTimestamp && phase !== 'succeeded' && phase !== 'failed';
    for (const volume of asRecordArray(asRecord(pod.spec)?.volumes)) {
      const volumeName = stringOrUndefined(volume.name);
      const claimName = stringOrUndefined(asRecord(volume.persistentVolumeClaim)?.claimName);
      if (volumeName && claimName) {
        const claimKey = `${meta.namespace}/${claimName}`;
        podVolumeClaims.set(`${meta.namespace}/${meta.name}/${volumeName}`, claimKey);
        if (active) {
          const mounted = mountedByPods.get(claimKey) || new Set();
          mounted.add(meta.name);
          mountedByPods.set(claimKey, mounted);
        }
      }
    }
  }
  const usage = new Map();
  let sampledNodes = 0;
  let failedNodes = 0;
  let permissionDenied = false;
  for (let offset = 0; offset < nodeNames.length; offset += 4) {
    const batch = nodeNames.slice(offset, offset + 4);
    const results = await Promise.allSettled(
      batch.map((name) => fetchKubeJson(kubeConfig, `/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`))
    );
    results.forEach((result) => {
      if (result.status === 'rejected') {
        failedNodes += 1;
        permissionDenied ||= String(result.reason?.message || result.reason).includes('HTTP 403');
        return;
      }
      sampledNodes += 1;
      for (const [key, value] of parseNodeSummaryPVCUsage(result.value, podVolumeClaims)) {
        const current = usage.get(key);
        if (!current || value.usedBytes > current.usedBytes) usage.set(key, value);
      }
    });
  }

  const available = sampledNodes > 0;
  const partial = available && failedNodes > 0;
  return {
    usage,
    mountedByPods,
    status: {
      available,
      partial,
      missingPermissions: permissionDenied ? ['nodes/proxy'] : [],
      sampledNodes,
      failedNodes,
      message: available
        ? partial
          ? `PVC usage sampled from ${sampledNodes} node(s); ${failedNodes} node(s) were unavailable.`
          : `PVC usage sampled from ${sampledNodes} node(s).`
        : permissionDenied
          ? 'PVC usage requires read access to the nodes/proxy subresource.'
          : 'PVC usage is not reported by the available node summaries.'
    }
  };
}

function normalizeCSIDriver(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  return {
    name: meta.name,
    attachRequired: typeof spec?.attachRequired === 'boolean' ? spec.attachRequired : undefined,
    podInfoOnMount: typeof spec?.podInfoOnMount === 'boolean' ? spec.podInfoOnMount : undefined,
    storageCapacity: typeof spec?.storageCapacity === 'boolean' ? spec.storageCapacity : undefined,
    fsGroupPolicy: stringOrUndefined(spec?.fsGroupPolicy),
    requiresRepublish: typeof spec?.requiresRepublish === 'boolean' ? spec.requiresRepublish : undefined,
    createdAt: meta.createdAt
  };
}

function validationSeverityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function validationItem(id, category, severity, title, message, nextStep, objectRefs, evidence = []) {
  return {
    id,
    category,
    severity,
    title,
    message,
    nextStep,
    objectRefs,
    evidence
  };
}

function buildStorageValidationHighlights(persistentVolumes, persistentVolumeClaims) {
  const highlights = [];

  for (const claim of persistentVolumeClaims) {
    if ((claim.status || '').toLowerCase() === 'pending') {
      highlights.push(
        validationItem(
          `storage.pvc_pending.${claim.namespace}.${claim.name}`,
          'storage',
          'warning',
          'PersistentVolumeClaim pending',
          `${claim.namespace}/${claim.name} is still pending.`,
          'Check the storage class, provisioner, and PVC events for this claim.',
          [{ kind: 'PersistentVolumeClaim', namespace: claim.namespace, name: claim.name }],
          [claim.storageClassName ? `StorageClass ${claim.storageClassName}` : 'No storage class recorded.']
        )
      );
    }
  }

  for (const volume of persistentVolumes) {
    const status = (volume.status || '').toLowerCase();
    if (status === 'released' || status === 'failed') {
      highlights.push(
        validationItem(
          `storage.pv_state.${volume.name}`,
          'storage',
          status === 'failed' ? 'critical' : 'warning',
          'PersistentVolume needs attention',
          `${volume.name} is in ${volume.status} state.`,
          'Review reclaim policy, claim references, and backend storage health for this volume.',
          [{ kind: 'PersistentVolume', name: volume.name }],
          volume.claimRef ? [`Claim ${volume.claimRef.namespace}/${volume.claimRef.name}`] : []
        )
      );
    }
  }

  return highlights.sort((left, right) => validationSeverityRank(left.severity) - validationSeverityRank(right.severity));
}

function storageProviderName(value) {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('ebs.csi.aws.com')) return 'AWS EBS CSI';
  if (lower.includes('pd.csi.storage.gke.io')) return 'GCE Persistent Disk CSI';
  if (lower.includes('disk.csi.azure.com')) return 'Azure Disk CSI';
  if (lower.includes('file.csi.azure.com')) return 'Azure File CSI';
  if (lower.includes('rbd.csi.ceph.com')) return 'Ceph RBD CSI';
  if (lower.includes('cephfs.csi.ceph.com')) return 'CephFS CSI';
  if (lower.includes('vitastor')) return 'Vitastor';
  if (lower.includes('longhorn')) return 'Longhorn';
  if (lower.includes('nfs')) return 'NFS';
  if (lower.includes('no-provisioner')) return 'Local Persistent Volumes';
  return value || 'Unknown storage provider';
}

function buildStorageProviders(storageClasses, csiDrivers) {
  const byId = new Map();
  const ensure = (providerId) => {
    const key = String(providerId || 'unknown').trim() || 'unknown';
    const existing = byId.get(key);
    if (existing) return existing;
    const provider = {
      providerId: key,
      providerName: storageProviderName(key),
      type: key.includes('csi') ? 'csi' : 'platform',
      detected: true,
      configured: true,
      active: true,
      confidence: 'high',
      evidence: [],
      features: {
        runtimeOverview: key.toLowerCase().includes('vitastor'),
        autoDiscovery: false,
        manualConfig: false
      }
    };
    byId.set(key, provider);
    return provider;
  };

  for (const driver of csiDrivers) {
    ensure(driver.name).evidence.push(`CSIDriver ${driver.name}`);
  }
  for (const storageClass of storageClasses) {
    ensure(storageClass.provisioner).evidence.push(`StorageClass ${storageClass.name}`);
  }
  return [...byId.values()]
    .map((provider) => ({ ...provider, evidence: [...new Set(provider.evidence)].sort() }))
    .sort((left, right) => left.providerName.localeCompare(right.providerName));
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((entry) => {
    const key = `${entry.kind}:${entry.namespace || ''}:${entry.name}:${entry.detail || ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function componentConfidence(evidence) {
  const score = evidence.reduce(
    (current, entry) => current + (['node', 'deployment', 'statefulset', 'daemonset', 'service', 'storageclass', 'csidriver'].includes(entry.kind) ? 2 : 1),
    0
  );
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function componentStatusFor(evidence) {
  return evidence.some((entry) => ['node', 'deployment', 'statefulset', 'daemonset', 'service', 'storageclass', 'csidriver'].includes(entry.kind))
    ? 'detected'
    : 'partial';
}

function componentSummary(key, name, category, summary, evidence) {
  const items = uniqueEvidence(evidence);
  if (items.length === 0) return null;
  return {
    key,
    name,
    category,
    status: componentStatusFor(items),
    confidence: componentConfidence(items),
    summary,
    namespaces: [...new Set(items.map((entry) => entry.namespace).filter(Boolean))].sort(),
    evidence: items
  };
}

function matchNamespaceEvidence(namespaces, ...names) {
  const targets = names.map((name) => name.toLowerCase());
  return namespaces
    .map(metadataFor)
    .filter((meta) => targets.includes(meta.name.toLowerCase()))
    .map((meta) => ({ kind: 'namespace', name: meta.name }));
}

function matchNodeEvidence(nodes, needles) {
  return nodes
    .filter((record) => {
      const meta = metadataFor(record);
      const haystack = [
        ...Object.keys(meta.labels),
        ...Object.values(meta.labels),
        ...Object.keys(meta.annotations),
        ...Object.values(meta.annotations)
      ].join(' ').toLowerCase();
      return needles.some((needle) => haystack.includes(needle));
    })
    .map((record) => ({ kind: 'node', name: metadataFor(record).name, detail: 'CNI metadata detected on Node' }));
}

function matchDeploymentEvidence(deployments, predicate) {
  return deployments
    .filter((record) => predicate(metadataFor(record), record))
    .map(metadataFor)
    .map((meta) => ({ kind: 'deployment', name: meta.name, namespace: meta.namespace }));
}

function matchDaemonSetEvidence(daemonSets, predicate) {
  return daemonSets
    .filter((record) => predicate(metadataFor(record), record))
    .map(metadataFor)
    .map((meta) => ({ kind: 'daemonset', name: meta.name, namespace: meta.namespace }));
}

function matchStatefulSetEvidence(statefulSets, predicate) {
  return statefulSets
    .filter(predicate)
    .map(metadataFor)
    .map((meta) => ({ kind: 'statefulset', name: meta.name, namespace: meta.namespace }));
}

function workloadSearchText(record) {
  const meta = metadataFor(record);
  const template = asRecord(asRecord(record.spec)?.template);
  const podSpec = asRecord(template?.spec);
  const containers = [...asRecordArray(podSpec?.containers), ...asRecordArray(podSpec?.initContainers)];
  return [
    meta.name,
    meta.namespace,
    ...Object.keys(meta.labels),
    ...Object.values(meta.labels),
    ...containers.flatMap((container) => [stringOrUndefined(container.name) || '', stringOrUndefined(container.image) || ''])
  ]
    .join(' ')
    .toLowerCase();
}

function workloadContains(record, needles) {
  const text = workloadSearchText(record);
  return needles.some((needle) => text.includes(needle));
}

function matchStorageClassEvidence(storageClasses, needles) {
  return storageClasses
    .filter((record) => {
      const meta = metadataFor(record);
      const provisioner = stringOrUndefined(record.provisioner) || '';
      const text = `${meta.name} ${provisioner}`.toLowerCase();
      return needles.some((needle) => text.includes(needle));
    })
    .map((record) => {
      const meta = metadataFor(record);
      return { kind: 'storageclass', name: meta.name, detail: stringOrUndefined(record.provisioner) };
    });
}

function matchCsiDriverEvidence(csiDrivers, needles) {
  return csiDrivers
    .map(metadataFor)
    .filter((meta) => needles.some((needle) => meta.name.toLowerCase().includes(needle)))
    .map((meta) => ({ kind: 'csidriver', name: meta.name }));
}

function matchIngressClassEvidence(ingressClasses, predicate) {
  return ingressClasses.filter(predicate).map((record) => {
    const meta = metadataFor(record);
    return {
      kind: 'ingressclass',
      name: meta.name,
      detail: stringOrUndefined(asRecord(record.spec)?.controller)
    };
  });
}

function matchCrdEvidence(crds, predicate) {
  return crds.filter(predicate).map((record) => {
    const meta = metadataFor(record);
    return {
      kind: 'crd',
      name: meta.name,
      detail: stringOrUndefined(asRecord(record.spec)?.group)
    };
  });
}

function backendServiceRef(backend, fallbackNamespace) {
  const service = asRecord(backend.service);
  const name = stringOrUndefined(service?.name);
  if (!name) return null;
  return { namespace: fallbackNamespace, name };
}

function ingressBackendRefs(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const refs = [];

  const defaultBackend = asRecord(spec?.defaultBackend);
  const defaultRef = defaultBackend ? backendServiceRef(defaultBackend, meta.namespace) : null;
  if (defaultRef) refs.push(defaultRef);

  for (const rule of asRecordArray(spec?.rules)) {
    const http = asRecord(rule.http);
    for (const path of asRecordArray(http?.paths)) {
      const ref = backendServiceRef(asRecord(path.backend) || {}, meta.namespace);
      if (ref) refs.push(ref);
    }
  }

  return refs;
}

function ingressHosts(record) {
  const spec = asRecord(record.spec);
  const hosts = asRecordArray(spec?.rules)
    .map((rule) => stringOrUndefined(rule.host))
    .filter(Boolean);
  return hosts.length > 0 ? [...new Set(hosts)] : ['*'];
}

function ingressTlsHosts(record) {
  const spec = asRecord(record.spec);
  return [...new Set(asRecordArray(spec?.tls).flatMap((entry) => (Array.isArray(entry.hosts) ? entry.hosts.filter((value) => typeof value === 'string') : [])))];
}

function ingressTlsSecretNames(record) {
  const spec = asRecord(record.spec);
  return [...new Set(asRecordArray(spec?.tls).map((entry) => stringOrUndefined(entry.secretName)).filter(Boolean))];
}

function dedupeServiceLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    const key = `${link.namespace}:${link.name}:${link.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadLocalStorage(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, '/apis/storage.k8s.io/v1/storageclasses'),
      fetchKubeList(kubeConfig, '/api/v1/persistentvolumes'),
      fetchKubeList(
        kubeConfig,
        namespacePath('/api/v1/persistentvolumeclaims', '/api/v1/namespaces/:namespace/persistentvolumeclaims', effectiveNamespace)
      ),
      fetchKubeList(kubeConfig, '/apis/storage.k8s.io/v1/csidrivers')
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    let partial = false;

    const storageClassItems =
      requests[0].status === 'fulfilled'
        ? requests[0].value.items
        : (partial = true, issues.push(partialIssue('storage', 'StorageClasses could not be loaded.')), []);
    const persistentVolumeItems =
      requests[1].status === 'fulfilled'
        ? requests[1].value.items
        : (partial = true, issues.push(partialIssue('storage', 'PersistentVolumes could not be loaded.')), []);
    const persistentVolumeClaimItems =
      requests[2].status === 'fulfilled'
        ? requests[2].value.items
        : (partial = true, issues.push(partialIssue('storage', 'PersistentVolumeClaims could not be loaded.')), []);
    const csiDriverItems =
      requests[3].status === 'fulfilled'
        ? requests[3].value.items
        : (partial = true, issues.push(partialIssue('storage', 'CSIDrivers could not be loaded.')), []);

    if (requests.some((entry) => entry.status === 'fulfilled' && entry.value.truncated)) {
      partial = true;
      issues.push(truncationIssue('storage', 'Large storage resource lists were truncated for this runtime read.'));
    }

    const storageClasses = buildResourceList(
      asRecordArray(storageClassItems).map(normalizeStorageClass).sort((left, right) => left.name.localeCompare(right.name)),
      new Date().toISOString(),
      requests[0].status === 'fulfilled' ? requests[0].value.truncated : true
    );
    const persistentVolumes = buildResourceList(
      asRecordArray(persistentVolumeItems).map(normalizePersistentVolume).sort((left, right) => left.name.localeCompare(right.name)),
      new Date().toISOString(),
      requests[1].status === 'fulfilled' ? requests[1].value.truncated : true
    );
    const persistentVolumeClaims = buildResourceList(
      asRecordArray(persistentVolumeClaimItems)
        .map(normalizePersistentVolumeClaim)
        .sort((left, right) => {
          if (left.namespace !== right.namespace) {
            return left.namespace.localeCompare(right.namespace);
          }
          return left.name.localeCompare(right.name);
        }),
      new Date().toISOString(),
      requests[2].status === 'fulfilled' ? requests[2].value.truncated : true
    );
    const csiDrivers = buildResourceList(
      asRecordArray(csiDriverItems).map(normalizeCSIDriver).sort((left, right) => left.name.localeCompare(right.name)),
      new Date().toISOString(),
      requests[3].status === 'fulfilled' ? requests[3].value.truncated : true
    );
    const pvcUsage = await loadPVCUsage(kubeConfig);
    const usageObservedAt = new Date().toISOString();
    let validUsageCount = 0;
    let discardedSamples = 0;
    persistentVolumeClaims.items = persistentVolumeClaims.items.map((claim) => {
      const key = `${claim.namespace}/${claim.name}`;
      const sample = pvcUsage.usage.get(key);
      const mounted = [...(pvcUsage.mountedByPods.get(key) || [])].sort();
      if (!isReliablePVCUsageSample(sample, parseBytes(claim.capacity || claim.requested))) {
        if (sample) discardedSamples += 1;
        return {
          ...claim,
          mountedByPods: mounted,
          ...(sample ? { usageUnavailableReason: 'Kubelet reported filesystem capacity that does not match this PVC.' } : {})
        };
      }
      validUsageCount += 1;
      return { ...claim, usedBytes: sample.usedBytes, usageSource: 'kubelet-summary', usageObservedAt, mountedByPods: mounted };
    });
    const claimUsageByVolume = new Map(
      persistentVolumeClaims.items
        .filter((claim) => claim.volumeName && Number.isFinite(claim.usedBytes))
        .map((claim) => [claim.volumeName, claim.usedBytes])
    );
    persistentVolumes.items = persistentVolumes.items.map((volume) => {
      const usedBytes = claimUsageByVolume.get(volume.name);
      return Number.isFinite(usedBytes)
        ? { ...volume, usedBytes, usageSource: 'kubelet-summary', usageObservedAt }
        : volume;
    });
    const providers = buildStorageProviders(storageClasses.items, csiDrivers.items);
    const usageAvailable = validUsageCount > 0;
    const usagePartial = usageAvailable && (pvcUsage.status.failedNodes > 0 || discardedSamples > 0);
    const usageStatus = {
      ...pvcUsage.status,
      available: usageAvailable,
      partial: usagePartial,
      discardedSamples,
      message: usageAvailable
        ? usagePartial
          ? `PVC usage is partial; ${pvcUsage.status.failedNodes} node(s) were unavailable and ${discardedSamples} unreliable sample(s) were ignored.`
          : `PVC usage sampled from ${pvcUsage.status.sampledNodes} node(s).`
        : discardedSamples > 0
          ? `PVC usage is unavailable because ${discardedSamples} kubelet sample(s) did not match the declared volume capacity.`
          : pvcUsage.status.message
    };

    return {
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      issues,
      partial,
      availability: buildAvailability(issues, partial),
      summary: {
        storageClasses: storageClasses.items.length,
        persistentVolumes: persistentVolumes.items.length,
        persistentVolumeClaims: persistentVolumeClaims.items.length,
        csiDrivers: csiDrivers.items.length,
        boundClaims: persistentVolumeClaims.items.filter((claim) => (claim.status || '').toLowerCase() === 'bound').length,
        pendingClaims: persistentVolumeClaims.items.filter((claim) => (claim.status || '').toLowerCase() === 'pending').length,
        releasedVolumes: persistentVolumes.items.filter((volume) => {
          const status = (volume.status || '').toLowerCase();
          return status === 'released' || status === 'failed';
        }).length,
        totalCapacityBytes: persistentVolumes.items.reduce((sum, volume) => sum + parseBytes(volume.capacity), 0),
        requestedBytes: persistentVolumeClaims.items.reduce((sum, claim) => sum + parseBytes(claim.requested), 0),
        usedBytes: persistentVolumeClaims.items.reduce((sum, claim) => sum + (Number.isFinite(claim.usedBytes) ? claim.usedBytes : 0), 0)
      },
      usageStatus,
      providers,
      storageClasses,
      persistentVolumes,
      persistentVolumeClaims,
      csiDrivers,
      validationHighlights: buildStorageValidationHighlights(persistentVolumes.items, persistentVolumeClaims.items)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalStorageEvents(runtimeConfig, input) {
  try {
    const kind = String(input?.kind || '').trim();
    const name = String(input?.name || '').trim();
    if (!name || (kind !== 'PersistentVolume' && kind !== 'PersistentVolumeClaim')) {
      throw new Error('Storage events require PersistentVolume or PersistentVolumeClaim kind and name.');
    }

    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const namespace = kind === 'PersistentVolumeClaim' ? String(input?.namespace || runtimeConfig.namespace || '').trim() : '';
    const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : '/api/v1/events';
    const events = await fetchKubeEventList(kubeConfig, path, `involvedObject.kind=${kind},involvedObject.name=${name}`);
    return normalizeDeliveryEvents(events.items, new Date().toISOString());
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function readPath(record, pathParts) {
  let current = record;
  for (const key of pathParts) {
    const next = asRecord(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function statusPhase(record) {
  return stringOrUndefined(readPath(record, ['status', 'phase'])) || stringOrUndefined(readPath(record, ['status', 'status'])) || 'Unknown';
}

function compactDuration(startedAt, finishedAt) {
  const seconds = durationSeconds(startedAt, finishedAt);
  if (!seconds) return undefined;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function issueMessages(record) {
  return [
    ...stringList(readPath(record, ['status', 'validationErrors'])).map((text) => ({ tone: 'error', text })),
    ...stringList(readPath(record, ['status', 'warnings'])).map((text) => ({ tone: 'warn', text })),
    ...stringList(readPath(record, ['status', 'errors'])).map((text) => ({ tone: 'error', text }))
  ];
}

function countHooks(spec) {
  return asRecordArray(asRecord(spec?.hooks)?.resources).length;
}

function normalizeBackupActivityBackup(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const startedAt = stringOrUndefined(status?.startTimestamp);
  const finishedAt = stringOrUndefined(status?.completionTimestamp);
  return {
    name: meta.name,
    namespace: meta.namespace,
    phase: statusPhase(record),
    startedAt,
    finishedAt,
    duration: compactDuration(startedAt, finishedAt),
    ttl: stringOrUndefined(spec?.ttl),
    expiresAt: stringOrUndefined(status?.expiration),
    storageLocation: stringOrUndefined(spec?.storageLocation),
    includedNamespaces: stringList(spec?.includedNamespaces),
    excludedNamespaces: stringList(spec?.excludedNamespaces),
    includedResources: stringList(spec?.includedResources),
    excludedResources: stringList(spec?.excludedResources),
    labelSelector: stringOrUndefined(spec?.labelSelector),
    snapshotVolumes: spec?.snapshotVolumes === undefined ? undefined : String(spec.snapshotVolumes),
    volumeBackupMode: spec?.defaultVolumesToFsBackup === true ? 'Filesystem' : undefined,
    uploaderType: stringOrUndefined(spec?.uploaderType),
    hooksCount: countHooks(spec),
    itemsBackedUp: numberOrZero(status?.itemsBackedUp) || undefined,
    itemsTotal: numberOrZero(status?.itemsTotal) || undefined,
    warnings: numberOrZero(status?.warnings),
    errors: numberOrZero(status?.errors),
    failureReason: stringOrUndefined(status?.failureReason),
    validationErrors: stringList(status?.validationErrors),
    issueMessages: issueMessages(record),
    scheduleName: stringOrUndefined(spec?.scheduleName)
  };
}

function normalizeBackupActivityRestore(record) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const startedAt = stringOrUndefined(status?.startTimestamp);
  const finishedAt = stringOrUndefined(status?.completionTimestamp);
  return {
    name: meta.name,
    namespace: meta.namespace,
    phase: statusPhase(record),
    startedAt,
    finishedAt,
    duration: compactDuration(startedAt, finishedAt),
    backupName: stringOrUndefined(spec?.backupName),
    includedNamespaces: stringList(spec?.includedNamespaces),
    excludedNamespaces: stringList(spec?.excludedNamespaces),
    includedResources: stringList(spec?.includedResources),
    excludedResources: stringList(spec?.excludedResources),
    namespaceMapping: Object.entries(asRecord(spec?.namespaceMapping) || {}).map(([key, value]) => `${key}:${String(value)}`),
    itemsTotal: numberOrZero(status?.itemsTotal) || undefined,
    itemsRestored: numberOrZero(status?.itemsRestored) || undefined,
    kopiaRestoresCompleted: numberOrZero(status?.kopiaRestoresCompleted) || undefined,
    warnings: numberOrZero(status?.warnings),
    errors: numberOrZero(status?.errors),
    failureReason: stringOrUndefined(status?.failureReason),
    validationErrors: stringList(status?.validationErrors),
    issueMessages: issueMessages(record),
    postRestoreHints: {
      ingressesRestored: 0,
      restoredHosts: []
    }
  };
}

function normalizeBackupActivitySchedule(record, backups) {
  const meta = metadataFor(record);
  const spec = asRecord(record.spec);
  const template = asRecord(spec?.template);
  const recentBackups = backups
    .filter((backup) => backup.namespace === meta.namespace && (backup.scheduleName === meta.name || backup.name.startsWith(`${meta.name}-`)))
    .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''))
    .slice(0, 5);
  const paused = spec?.paused === true;
  return {
    name: meta.name,
    namespace: meta.namespace,
    schedule: stringOrUndefined(spec?.schedule) || '-',
    paused,
    status: paused ? 'Paused' : 'Enabled',
    ttl: stringOrUndefined(template?.ttl),
    storageLocation: stringOrUndefined(template?.storageLocation),
    lastBackupName: recentBackups[0]?.name,
    lastBackupStatus: recentBackups[0]?.phase,
    lastBackupStartedAt: recentBackups[0]?.startedAt,
    templateIncludedNamespaces: stringList(template?.includedNamespaces),
    templateExcludedNamespaces: stringList(template?.excludedNamespaces),
    templateIncludedResources: stringList(template?.includedResources),
    templateExcludedResources: stringList(template?.excludedResources),
    recentBackups: recentBackups.map((backup) => ({
      name: backup.name,
      phase: backup.phase,
      startedAt: backup.startedAt,
      finishedAt: backup.finishedAt
    }))
  };
}

function backupPhaseFailed(phase) {
  const normalized = String(phase || '').toLowerCase();
  return normalized.includes('failed') || normalized.includes('error');
}

function buildRuntimeBackupActivity(backupsRaw, restoresRaw, schedulesRaw, fetchedAt, namespaceScope, detected, message, issues = [], partial = false) {
  const backups = asRecordArray(backupsRaw).map(normalizeBackupActivityBackup);
  const restores = asRecordArray(restoresRaw).map(normalizeBackupActivityRestore);
  const schedules = asRecordArray(schedulesRaw).map((schedule) => normalizeBackupActivitySchedule(schedule, backups));
  return {
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    namespaceScope,
    detected,
    message,
    volumeBackupModes: [],
    versions: {},
    summary: {
      backups: backups.length,
      restores: restores.length,
      schedules: schedules.length,
      failedBackups: backups.filter((backup) => backupPhaseFailed(backup.phase)).length,
      failedRestores: restores.filter((restore) => backupPhaseFailed(restore.phase)).length,
      pausedSchedules: schedules.filter((schedule) => schedule.paused).length
    },
    backups: buildResourceList(backups, fetchedAt, issues, partial),
    restores: buildResourceList(restores, fetchedAt, issues, partial),
    schedules: buildResourceList(schedules, fetchedAt, issues, partial)
  };
}

export async function loadLocalBackupActivity(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const backupPath = (definition, version) => {
      const base = `/apis/${definition.group}/${version}`;
      return definition.namespaced && effectiveNamespace
        ? `${base}/namespaces/${encodeURIComponent(effectiveNamespace)}/${definition.resource}`
        : `${base}/${definition.resource}`;
    };
    const resources = await Promise.all(BACKUP_RESOURCE_DEFINITIONS.map(async (definition) => {
      for (const version of definition.versions) {
        try {
          const response = await fetchKubeList(
            kubeConfig,
            backupPath(definition, version),
            true
          );
          if (response.missing) continue;
          return {
            definition,
            items: response.items,
            available: true,
            partial: response.truncated,
            version
          };
        } catch (error) {
          if (error instanceof Error && /HTTP 403/.test(error.message)) {
            return { definition, items: [], available: false, denied: true, partial: true, version };
          }
          return { definition, items: [], available: false, partial: true, version };
        }
      }
      return { definition, items: [], available: false, partial: false };
    }));
    return buildUniversalBackupActivitySummary({
      resources,
      fetchedAt: new Date().toISOString(),
      namespaceScope: effectiveNamespace,
      issues: [],
      partial: resources.some((resource) => resource.partial)
    });
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function deliveryResourcePath(definition, version, namespaceScope) {
  const base = `/apis/${definition.group}/${version}`;
  return namespacePath(`${base}/${definition.resource}`, `${base}/namespaces/:namespace/${definition.resource}`, namespaceScope);
}

async function fetchOptionalDeliveryResource(kubeConfig, definition, namespaceScope) {
  for (const version of definition.versions) {
    try {
      const list = await fetchKubeList(kubeConfig, deliveryResourcePath(definition, version, namespaceScope));
      return {
        definition,
        items: list.items,
        partial: list.truncated
      };
    } catch {
      // GitOps CRDs are optional and served versions differ by installation.
    }
  }
  return {
    definition,
    items: [],
    partial: false
  };
}

function deliveryNestedString(record, pathParts) {
  let current = record;
  for (const part of pathParts) {
    current = asRecord(current)?.[part];
    if (current === undefined) return undefined;
  }
  return stringOrUndefined(current);
}

function deliveryConditions(record) {
  return asRecordArray(asRecord(record.status)?.conditions).map((condition) => ({
    type: stringOrUndefined(condition.type) || '',
    status: stringOrUndefined(condition.status) || '',
    reason: stringOrUndefined(condition.reason),
    message: stringOrUndefined(condition.message),
    lastTransitionTime: stringOrUndefined(condition.lastTransitionTime)
  }));
}

function deliveryConditionIsTrue(conditions, conditionType) {
  return conditions.some((condition) => condition.type.toLowerCase() === conditionType.toLowerCase() && condition.status.toLowerCase() === 'true');
}

function fluxDeliveryConditionStatus(conditions) {
  if (deliveryConditionIsTrue(conditions, 'Stalled')) {
    return { status: 'Stalled', health: 'Degraded' };
  }
  if (deliveryConditionIsTrue(conditions, 'Reconciling')) {
    return { status: 'Reconciling', health: 'Progressing' };
  }
  const ready = conditions.find((condition) => condition.type.toLowerCase() === 'ready');
  if (ready) {
    if (ready.status.toLowerCase() === 'true') {
      return { status: 'Ready', health: 'Healthy' };
    }
    return { status: ready.reason || 'Not Ready', health: 'Degraded' };
  }
  return { status: 'Unknown', health: 'Unknown' };
}

function deliveryUpdatedAt(record, conditions) {
  return (
    deliveryNestedString(record, ['status', 'reconciledAt']) ||
    deliveryNestedString(record, ['status', 'lastHandledReconcileAt']) ||
    conditions.find((condition) => condition.lastTransitionTime)?.lastTransitionTime ||
    metadataFor(record).createdAt
  );
}

function sanitizeDeliverySourceUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    let cleaned = trimmed.split('?')[0].split('#')[0];
    const at = cleaned.lastIndexOf('@');
    if (at >= 0) {
      cleaned = cleaned.slice(at + 1);
    }
    return cleaned;
  }
}

function parseDeliveryApplication(definition, record) {
  const meta = metadataFor(record);
  const conditions = deliveryConditions(record);
  const updatedAt = deliveryUpdatedAt(record, conditions);
  if (definition.providerId === 'argocd') {
    return {
      providerId: definition.providerId,
      providerName: definition.providerName,
      kind: definition.kind,
      namespace: meta.namespace,
      name: meta.name,
      status: deliveryNestedString(record, ['status', 'sync', 'status']) || 'Unknown',
      health: deliveryNestedString(record, ['status', 'health', 'status']) || 'Unknown',
      revision: deliveryNestedString(record, ['status', 'sync', 'revision']),
      updatedAt,
      sourceRef: sanitizeDeliverySourceUrl(deliveryNestedString(record, ['spec', 'source', 'repoURL'])),
      conditions
    };
  }

  const status = fluxDeliveryConditionStatus(conditions);
  const sourceRef = [
    deliveryNestedString(record, ['spec', 'sourceRef', 'namespace']),
    deliveryNestedString(record, ['spec', 'sourceRef', 'kind']),
    deliveryNestedString(record, ['spec', 'sourceRef', 'name'])
  ]
    .filter(Boolean)
    .join('/');
  return {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    status: status.status,
    health: status.health,
    revision: deliveryNestedString(record, ['status', 'lastAppliedRevision']) || deliveryNestedString(record, ['status', 'lastAttemptedRevision']),
    updatedAt,
    sourceRef: sourceRef || undefined,
    conditions
  };
}

function parseDeliverySource(definition, record) {
  const meta = metadataFor(record);
  const conditions = deliveryConditions(record);
  const status = fluxDeliveryConditionStatus(conditions);
  return {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    status: status.status,
    revision: deliveryNestedString(record, ['status', 'artifact', 'revision']),
    url: sanitizeDeliverySourceUrl(deliveryNestedString(record, ['spec', 'url'])),
    updatedAt: deliveryUpdatedAt(record, conditions),
    conditions
  };
}

function deliveryConditionIssues(providerId, kind, namespace, name, conditions) {
  return conditions
    .filter((condition) => {
      const type = condition.type.toLowerCase();
      const status = condition.status.toLowerCase();
      return (type === 'stalled' && status === 'true') || (type === 'ready' && status === 'false') || type.includes('error');
    })
    .map((condition) => ({
      providerId,
      kind,
      namespace,
      name,
      severity: 'warning',
      message: [condition.reason, condition.message].filter(Boolean).join(': ') || 'Controller reported a failed condition.'
    }));
}

function deliveryProviderForPod(pod) {
  const name = pod.name.toLowerCase();
  const namespace = pod.namespace.toLowerCase();
  if (namespace === 'argocd' || name.startsWith('argocd-')) {
    return 'argocd';
  }
  if (namespace === 'flux-system' && (name.includes('controller') || name.includes('flux'))) {
    return 'flux';
  }
  return null;
}

function deliveryProviderName(providerId) {
  if (providerId === 'argocd') return 'Argo CD';
  if (providerId === 'flux') return 'Flux';
  return providerId;
}

function summarizeDeliveryApplications(items) {
  return items.reduce(
    (summary, item) => {
      const health = item.health.toLowerCase();
      const status = item.status.toLowerCase();
      if (health === 'healthy') summary.healthy += 1;
      if (health === 'progressing' || status === 'reconciling' || status === 'progressing') summary.progressing += 1;
      if (health === 'degraded' || status === 'stalled' || status === 'failed') summary.degraded += 1;
      if (status.includes('outofsync') || status.includes('out of sync')) summary.outOfSync += 1;
      return summary;
    },
    { total: items.length, healthy: 0, progressing: 0, degraded: 0, outOfSync: 0 }
  );
}

function buildDeliveryDetectedProviders({ applications, sources, controllers, crds }) {
  return ['argocd', 'flux']
    .map((providerId) => {
      const evidence = new Set();
      const appCount = applications.filter((item) => item.providerId === providerId).length;
      const sourceCount = sources.filter((item) => item.providerId === providerId).length;
      const controllerCount = controllers.filter((item) => item.providerId === providerId).length;
      if (appCount > 0) evidence.add(`${appCount} application resources`);
      if (sourceCount > 0) evidence.add(`${sourceCount} source resources`);
      if (controllerCount > 0) evidence.add(`${controllerCount} controller pods`);
      for (const crd of crds) {
        const name = metadataFor(crd).name.toLowerCase();
        if (providerId === 'argocd' && name === 'applications.argoproj.io') evidence.add('applications.argoproj.io CRD');
        if (providerId === 'flux' && (name.endsWith('.toolkit.fluxcd.io') || name.endsWith('.source.toolkit.fluxcd.io'))) {
          evidence.add(`${metadataFor(crd).name} CRD`);
        }
      }
      if (evidence.size === 0) return null;
      return {
        providerId,
        providerName: deliveryProviderName(providerId),
        active: appCount + sourceCount + controllerCount > 0,
        evidence: [...evidence].sort()
      };
    })
    .filter(Boolean);
}

function buildRuntimeDeliveryActivity(resourceSections, podsRaw, crdsRaw, fetchedAt, namespaceScope, issues = [], partial = false) {
  const applications = [];
  const sources = [];
  const issuesList = [];
  for (const section of resourceSections) {
    for (const record of asRecordArray(section.items)) {
      if (section.definition.source) {
        const source = parseDeliverySource(section.definition, record);
        sources.push(source);
        issuesList.push(...deliveryConditionIssues(source.providerId, source.kind, source.namespace, source.name, source.conditions));
      } else {
        const application = parseDeliveryApplication(section.definition, record);
        applications.push(application);
        issuesList.push(...deliveryConditionIssues(application.providerId, application.kind, application.namespace, application.name, application.conditions));
      }
    }
  }
  const pods = asRecordArray(podsRaw).map(normalizePod);
  const controllers = pods
    .map((pod) => {
      const providerId = deliveryProviderForPod(pod);
      return providerId ? { providerId, providerName: deliveryProviderName(providerId), pod } : null;
    })
    .filter(Boolean);

  applications.sort((left, right) => `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`));
  sources.sort((left, right) => `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`));
  controllers.sort((left, right) => `${left.pod.namespace}/${left.pod.name}`.localeCompare(`${right.pod.namespace}/${right.pod.name}`));

  return {
    namespaceScope,
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    detectedProviders: buildDeliveryDetectedProviders({ applications, sources, controllers, crds: asRecordArray(crdsRaw) }),
    summary: summarizeDeliveryApplications(applications),
    applications: buildResourceList(applications, fetchedAt, [], resourceSections.some((section) => !section.definition.source && section.partial === true)),
    sources: buildResourceList(sources, fetchedAt, [], resourceSections.some((section) => section.definition.source && section.partial === true)),
    controllers: buildResourceList(controllers, fetchedAt, [], false),
    issuesList: buildResourceList(issuesList, fetchedAt, [], partial)
  };
}

export async function loadLocalDeliveryActivity(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      ...DELIVERY_RESOURCE_DEFINITIONS.map((definition) => fetchOptionalDeliveryResource(kubeConfig, definition, effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', effectiveNamespace)),
      fetchKubeList(kubeConfig, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
    ]);
    const resourceCount = DELIVERY_RESOURCE_DEFINITIONS.length;
    const resourceSections = requests
      .slice(0, resourceCount)
      .map((request, index) =>
        request.status === 'fulfilled'
          ? request.value
          : {
              definition: DELIVERY_RESOURCE_DEFINITIONS[index],
              items: [],
              partial: true
            }
      );
    const issues = [];
    let partial = resourceSections.some((section) => section.partial === true);
    if (partial) {
      issues.push(truncationIssue('delivery-activity', 'Large GitOps resource lists were truncated for this runtime read.'));
    }
    const podRequest = requests[resourceCount];
    const crdRequest = requests[resourceCount + 1];
    const pods =
      podRequest.status === 'fulfilled'
        ? podRequest.value
        : (partial = true, issues.push(partialIssue('delivery-activity', 'Controller pods could not be loaded for delivery activity.')), { items: [], truncated: false });
    if (pods.truncated) {
      partial = true;
      issues.push(truncationIssue('delivery-activity', 'The Pod list was truncated for delivery controller detection.'));
    }
    const crds = crdRequest.status === 'fulfilled' ? crdRequest.value : { items: [], truncated: false };
    if (crds.truncated) {
      partial = true;
      issues.push(truncationIssue('delivery-activity', 'The CRD list was truncated for delivery provider detection.'));
    }
    return buildRuntimeDeliveryActivity(resourceSections, pods.items, crds.items, new Date().toISOString(), effectiveNamespace, issues, partial);
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function deliveryKindAllowed(providerId, kind) {
  return DELIVERY_RESOURCE_DEFINITIONS.some((definition) => definition.providerId === providerId && definition.kind.toLowerCase() === String(kind || '').toLowerCase());
}

async function fetchKubeEventList(kubeConfig, path, fieldSelector) {
  const items = [];
  let page = 0;
  let continueToken = null;
  while (page < MAX_PAGES) {
    const search = new URLSearchParams({ limit: String(PAGE_LIMIT), fieldSelector });
    if (continueToken) {
      search.set('continue', continueToken);
    }
    const payload = await fetchKubeJson(kubeConfig, `${path}?${search.toString()}`);
    if (Array.isArray(payload.items)) {
      items.push(...payload.items);
    }
    continueToken = payload.metadata && typeof payload.metadata.continue === 'string' ? payload.metadata.continue : null;
    if (!continueToken) {
      return { items, truncated: false };
    }
    page += 1;
  }
  return { items, truncated: true };
}

function normalizeDeliveryEvents(items, fetchedAt) {
  const events = asRecordArray(items)
    .map((record) => {
      const eventTime =
        stringOrUndefined(record.lastTimestamp) || stringOrUndefined(record.eventTime) || stringOrUndefined(asRecord(record.metadata)?.creationTimestamp);
      return {
        type: stringOrUndefined(record.type) || '',
        reason: stringOrUndefined(record.reason) || '',
        message: stringOrUndefined(record.message) || '',
        count: numberOrZero(record.count),
        firstObserved: stringOrUndefined(record.firstTimestamp) || eventTime,
        lastObserved: eventTime
      };
    })
    .sort((left, right) => Date.parse(right.lastObserved || '') - Date.parse(left.lastObserved || ''))
    .slice(0, 30);
  return buildResourceList(events, fetchedAt);
}

function parseMetricCpuMilli(value) {
  const raw = stringOrUndefined(value);
  if (!raw) return 0;
  if (raw.endsWith('n')) return Number.parseFloat(raw.slice(0, -1)) / 1_000_000;
  if (raw.endsWith('u')) return Number.parseFloat(raw.slice(0, -1)) / 1_000;
  if (raw.endsWith('m')) return Number.parseFloat(raw.slice(0, -1));
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed * 1000 : 0;
}

function parseMemoryBytes(value) {
  const raw = stringOrUndefined(value);
  if (!raw) return 0;
  const match = raw.match(/^([0-9.]+)([KMGTP]i?|[kMGTPE])?$/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] || '0');
  if (!Number.isFinite(amount)) return 0;
  const multipliers = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4
  };
  return amount * (multipliers[match[2] || ''] || 1);
}

function formatCpuMilli(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const rounded = Math.round(value * 1000) / 1000;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}m`;
}

function formatMemoryBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const mib = value / (1024 ** 2);
  if (mib >= 1) return `${Math.round(mib)}Mi`;
  const kib = value / 1024;
  if (kib >= 1) return `${Math.round(kib)}Ki`;
  return `${Math.round(value)}`;
}

function metricSample(item, sumContainers) {
  const meta = metadataFor(item);
  if (!sumContainers) {
    const usage = asRecord(item.usage) || {};
    return {
      name: meta.name,
      namespace: '',
      cpu: stringOrUndefined(usage.cpu) || '',
      memory: stringOrUndefined(usage.memory) || ''
    };
  }

  let cpuMilli = 0;
  let memoryBytes = 0;
  for (const container of asRecordArray(item.containers)) {
    const usage = asRecord(container.usage) || {};
    cpuMilli += parseMetricCpuMilli(usage.cpu);
    memoryBytes += parseMemoryBytes(usage.memory);
  }
  return {
    name: meta.name,
    namespace: meta.namespace,
    cpu: formatCpuMilli(cpuMilli),
    memory: formatMemoryBytes(memoryBytes)
  };
}

export async function loadLocalMetrics(runtimeConfig, namespaceScope = null) {
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const fetchedAt = new Date().toISOString();
  const effectiveNamespace = namespaceScope && namespaceScope !== 'all' ? namespaceScope : null;

  try {
    const [nodes, pods] = await Promise.all([
      fetchKubeList(kubeConfig, '/apis/metrics.k8s.io/v1beta1/nodes'),
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/metrics.k8s.io/v1beta1/pods', '/apis/metrics.k8s.io/v1beta1/namespaces/:namespace/pods', effectiveNamespace)
      )
    ]);
    const issues = [];
    if (nodes.truncated || pods.truncated) {
      issues.push({
        code: 'truncated_results',
        message: 'Large metrics lists were truncated for this local agent read.',
        retryable: true,
        resource: 'metrics'
      });
    }
    return {
      namespaceScope: effectiveNamespace,
      available: true,
      message: '',
      nodes: nodes.items.map((item) => metricSample(item, false)),
      pods: pods.items.map((item) => metricSample(item, true)),
      fetchedAt,
      issues,
      partial: nodes.truncated || pods.truncated,
      availability: nodes.truncated || pods.truncated ? 'degraded' : 'available'
    };
  } catch {
    return {
      namespaceScope: effectiveNamespace,
      available: false,
      message: 'Metrics API not available. Install metrics-server to enable CPU and memory samples.',
      nodes: [],
      pods: [],
      fetchedAt,
      issues: [
        {
          code: 'resource_unavailable',
          message: 'Metrics API not available.',
          retryable: true,
          resource: 'metrics'
        }
      ],
      partial: true,
      availability: 'unavailable'
    };
  }
}

export async function loadLocalDeliveryEvents(runtimeConfig, input) {
  try {
    const providerId = String(input?.providerId || '').trim().toLowerCase();
    const kind = String(input?.kind || '').trim();
    const name = String(input?.name || '').trim();
    const namespace = String(input?.namespace || '').trim();
    if (!name || !deliveryKindAllowed(providerId, kind)) {
      throw new Error('The requested delivery object is outside the GitOps event allowlist.');
    }
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : '/api/v1/events';
    const events = await fetchKubeEventList(kubeConfig, path, `involvedObject.kind=${kind},involvedObject.name=${name}`);
    return normalizeDeliveryEvents(events.items, new Date().toISOString());
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalComponentInventory(runtimeConfig) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const requests = await Promise.allSettled([
      fetchKubeList(kubeConfig, '/api/v1/namespaces'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/deployments'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/statefulsets'),
      fetchKubeList(kubeConfig, '/apis/apps/v1/daemonsets'),
      fetchKubeList(kubeConfig, '/apis/storage.k8s.io/v1/storageclasses'),
      fetchKubeList(kubeConfig, '/apis/storage.k8s.io/v1/csidrivers'),
      fetchKubeList(kubeConfig, '/apis/networking.k8s.io/v1/ingressclasses'),
      fetchKubeList(kubeConfig, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
      fetchKubeList(kubeConfig, '/api/v1/nodes')
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    let partial = false;
    const namespaces =
      requests[0].status === 'fulfilled'
        ? asRecordArray(requests[0].value.items)
        : (partial = true, issues.push(partialIssue('components', 'Namespaces could not be loaded for component detection.')), []);
    const deployments =
      requests[1].status === 'fulfilled'
        ? asRecordArray(requests[1].value.items)
        : (partial = true, issues.push(partialIssue('components', 'Deployments could not be loaded for component detection.')), []);
    const daemonSets =
      requests[3].status === 'fulfilled'
        ? asRecordArray(requests[3].value.items)
        : (partial = true, issues.push(partialIssue('components', 'DaemonSets could not be loaded for component detection.')), []);
    const statefulSets =
      requests[2].status === 'fulfilled'
        ? asRecordArray(requests[2].value.items)
        : (partial = true, issues.push(partialIssue('components', 'StatefulSets could not be loaded for component detection.')), []);
    const storageClasses =
      requests[4].status === 'fulfilled'
        ? asRecordArray(requests[4].value.items)
        : (partial = true, issues.push(partialIssue('components', 'StorageClasses could not be loaded for component detection.')), []);
    const csiDrivers =
      requests[5].status === 'fulfilled'
        ? asRecordArray(requests[5].value.items)
        : (partial = true, issues.push(partialIssue('components', 'CSIDrivers could not be loaded for component detection.')), []);
    const ingressClasses =
      requests[6].status === 'fulfilled'
        ? asRecordArray(requests[6].value.items)
        : (partial = true, issues.push(partialIssue('components', 'IngressClasses could not be loaded for component detection.')), []);
    const crds =
      requests[7].status === 'fulfilled'
        ? asRecordArray(requests[7].value.items)
        : (partial = true, issues.push(partialIssue('components', 'CustomResourceDefinitions could not be loaded for component detection.')), []);
    const nodes =
      requests[8].status === 'fulfilled'
        ? asRecordArray(requests[8].value.items)
        : (partial = true, issues.push(partialIssue('components', 'Nodes could not be loaded for CNI detection.')), []);

    if (requests.some((entry) => entry.status === 'fulfilled' && entry.value.truncated)) {
      partial = true;
      issues.push(truncationIssue('components', 'Large component detection inputs were truncated for this runtime read.'));
    }

    const items = [
      componentSummary(
        'ingress-nginx',
        'NGINX Ingress',
        'ingress',
        'Ingress controller evidence from workloads, ingress classes, or ingress-nginx namespace.',
        [
          ...matchNamespaceEvidence(namespaces, 'ingress-nginx'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('ingress-nginx') || meta.namespace === 'ingress-nginx'),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('ingress-nginx') || meta.namespace === 'ingress-nginx'),
          ...matchIngressClassEvidence(ingressClasses, (record) => stringOrUndefined(asRecord(record.spec)?.controller)?.includes('ingress-nginx') === true)
        ]
      ),
      componentSummary(
        'traefik',
        'Traefik',
        'ingress',
        'Traefik controller evidence from workloads or ingress classes.',
        [
          ...matchNamespaceEvidence(namespaces, 'traefik'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('traefik')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('traefik')),
          ...matchIngressClassEvidence(ingressClasses, (record) => stringOrUndefined(asRecord(record.spec)?.controller)?.includes('traefik') === true)
        ]
      ),
      componentSummary(
        'cilium',
        'Cilium',
        'networking',
        'Cilium evidence from DaemonSets, Deployments, or cilium.io CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'cilium-system'),
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['cilium'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['cilium'])),
          ...matchNodeEvidence(nodes, ['cilium.io', 'network.cilium.io']),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('cilium.io') === true)
        ]
      ),
      componentSummary(
        'calico',
        'Calico',
        'networking',
        'Calico evidence from workloads or projectcalico.org CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'calico-system'),
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['calico'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['calico'])),
          ...matchNodeEvidence(nodes, ['projectcalico.org']),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('projectcalico.org') === true)
        ]
      ),
      componentSummary(
        'flannel',
        'Flannel',
        'networking',
        'Flannel evidence from kube-flannel namespace or DaemonSets.',
        [
          ...matchNamespaceEvidence(namespaces, 'kube-flannel'),
          ...matchDaemonSetEvidence(daemonSets, (meta, record) => meta.name.includes('flannel') || meta.namespace === 'kube-flannel' || workloadContains(record, ['flannel'])),
          ...matchNodeEvidence(nodes, ['flannel.alpha.coreos.com'])
        ]
      ),
      componentSummary(
        'weave-net',
        'Weave Net',
        'networking',
        'Weave Net evidence from workloads.',
        [
          ...matchNamespaceEvidence(namespaces, 'weave'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('weave-net') || meta.name.includes('weave')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('weave-net') || meta.name.includes('weave')),
          ...matchNodeEvidence(nodes, ['weave.works'])
        ]
      ),
      componentSummary(
        'antrea',
        'Antrea',
        'networking',
        'Antrea evidence from workloads or antrea.io CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'antrea'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('antrea')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('antrea')),
          ...matchNodeEvidence(nodes, ['antrea.io', 'node.antrea.io']),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('antrea.io') === true)
        ]
      ),
      componentSummary(
        'kube-router',
        'kube-router',
        'networking',
        'kube-router evidence from workloads.',
        [
          ...matchNamespaceEvidence(namespaces, 'kube-router'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('kube-router')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('kube-router')),
          ...matchNodeEvidence(nodes, ['kube-router.io'])
        ]
      ),
      componentSummary('canal', 'Canal', 'networking', 'Canal evidence from controller workloads.', [
        ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['canal'])),
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['canal']))
      ]),
      componentSummary('multus', 'Multus', 'networking', 'Multus evidence from workloads or NetworkAttachmentDefinition CRDs.', [
        ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['multus'])),
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['multus'])),
        ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group) === 'k8s.cni.cncf.io')
      ]),
      componentSummary('kube-ovn', 'Kube-OVN', 'networking', 'Kube-OVN evidence from workloads, Node metadata, or kubeovn.io CRDs.', [
        ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['kube-ovn', 'kubeovn'])),
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['kube-ovn', 'kubeovn'])),
        ...matchNodeEvidence(nodes, ['kube-ovn.io', 'kubeovn.io']),
        ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('kubeovn.io') === true)
      ]),
      componentSummary('aws-vpc-cni', 'AWS VPC CNI', 'networking', 'AWS VPC CNI evidence from aws-node workloads or ENI Node metadata.', [
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['aws-node', 'amazon-k8s-cni'])),
        ...matchNodeEvidence(nodes, ['vpc.amazonaws.com', 'k8s.amazonaws.com/eni'])
      ]),
      componentSummary('azure-cni', 'Azure CNI', 'networking', 'Azure CNI evidence from networking workloads or pod-network Node metadata.', [
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['azure-cni', 'azure-vnet', 'azure-npm'])),
        ...matchNodeEvidence(nodes, ['kubernetes.azure.com/podnetwork'])
      ]),
      componentSummary('ovn-kubernetes', 'OVN-Kubernetes', 'networking', 'OVN-Kubernetes evidence from ovnkube workloads or Node metadata.', [
        ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['ovnkube', 'ovn-kubernetes'])),
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['ovnkube', 'ovn-kubernetes'])),
        ...matchNodeEvidence(nodes, ['k8s.ovn.org'])
      ]),
      componentSummary('kindnet', 'kindnet', 'networking', 'kindnet evidence from its DaemonSet.', [
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['kindnet']))
      ]),
      componentSummary('gke-dataplane-v2', 'GKE Dataplane V2', 'networking', 'GKE Dataplane V2 evidence from anetd workloads or Node metadata.', [
        ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['anetd'])),
        ...matchNodeEvidence(nodes, ['networking.gke.io'])
      ]),
      componentSummary(
        'kube-proxy',
        'kube-proxy',
        'networking',
        'kube-proxy evidence from its DaemonSet.',
        [...matchDaemonSetEvidence(daemonSets, (meta) => meta.name === 'kube-proxy')]
      ),
      componentSummary(
        'kube-vip',
        'kube-vip',
        'networking',
        'kube-vip evidence from workloads.',
        [
          ...matchNamespaceEvidence(namespaces, 'kube-vip'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('kube-vip')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('kube-vip'))
        ]
      ),
      componentSummary(
        'k3s-servicelb',
        'K3s ServiceLB',
        'networking',
        'K3s ServiceLB evidence from svclb DaemonSets.',
        [...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.startsWith('svclb-'))]
      ),
      componentSummary(
        'metallb',
        'MetalLB',
        'networking',
        'MetalLB evidence from workloads or metallb.io CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'metallb-system'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.includes('metallb') || meta.namespace === 'metallb-system'),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.includes('metallb') || meta.namespace === 'metallb-system'),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('metallb.io') === true)
        ]
      ),
      componentSummary(
        'metrics-server',
        'metrics-server',
        'observability',
        'metrics-server evidence from controller workloads.',
        [...matchDeploymentEvidence(deployments, (meta) => meta.name === 'metrics-server')]
      ),
      componentSummary(
        'prometheus',
        'Prometheus',
        'observability',
        'Prometheus evidence from controller workloads or monitoring.coreos.com CRDs.',
        [
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['prometheus'])),
          ...matchStatefulSetEvidence(statefulSets, (record) => workloadContains(record, ['prometheus'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['prometheus'])),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group) === 'monitoring.coreos.com')
        ]
      ),
      componentSummary(
        'grafana',
        'Grafana',
        'observability',
        'Grafana evidence from workload names, labels, or container images.',
        [
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['grafana'])),
          ...matchStatefulSetEvidence(statefulSets, (record) => workloadContains(record, ['grafana'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['grafana']))
        ]
      ),
      componentSummary(
        'victoria-metrics',
        'VictoriaMetrics',
        'observability',
        'VictoriaMetrics evidence from operator CRDs or VictoriaMetrics workloads.',
        [
          ...matchDeploymentEvidence(deployments, (_meta, record) =>
            workloadContains(record, ['victoriametrics', 'victoria-metrics', 'vmagent', 'vmsingle', 'vmstorage', 'vminsert', 'vmselect'])
          ),
          ...matchStatefulSetEvidence(statefulSets, (record) =>
            workloadContains(record, ['victoriametrics', 'victoria-metrics', 'vmagent', 'vmsingle', 'vmstorage', 'vminsert', 'vmselect'])
          ),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['victoriametrics', 'victoria-metrics', 'vmagent'])),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('victoriametrics.com') === true)
        ]
      ),
      componentSummary(
        'victoria-logs',
        'VictoriaLogs',
        'observability',
        'VictoriaLogs evidence from workloads or VictoriaLogs operator CRDs.',
        [
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['victorialogs', 'victoria-logs', 'vlogs', 'vlinsert', 'vlselect', 'vlstorage'])),
          ...matchStatefulSetEvidence(statefulSets, (record) => workloadContains(record, ['victorialogs', 'victoria-logs', 'vlogs', 'vlinsert', 'vlselect', 'vlstorage'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['victorialogs', 'victoria-logs', 'vlogs'])),
          ...matchCrdEvidence(crds, (record) => {
            const kind = stringOrUndefined(asRecord(asRecord(record.spec)?.names)?.kind)?.toLowerCase() || '';
            return kind.startsWith('vl') && stringOrUndefined(asRecord(record.spec)?.group)?.includes('victoriametrics.com') === true;
          })
        ]
      ),
      componentSummary(
        'vector',
        'Vector',
        'observability',
        'Vector evidence from dedicated workloads or timberio/vector images.',
        [
          ...matchDeploymentEvidence(deployments, (meta, record) => meta.name === 'vector' || meta.name.startsWith('vector-') || workloadContains(record, ['timberio/vector'])),
          ...matchStatefulSetEvidence(statefulSets, (record) => workloadContains(record, ['timberio/vector'])),
          ...matchDaemonSetEvidence(daemonSets, (meta, record) => meta.name === 'vector' || meta.name.startsWith('vector-') || workloadContains(record, ['timberio/vector']))
        ]
      ),
      componentSummary(
        'vitastor',
        'Vitastor',
        'storage',
        'Vitastor evidence from CSI resources, storage classes, or controller workloads.',
        [
          ...matchNamespaceEvidence(namespaces, 'vitastor-system'),
          ...matchDeploymentEvidence(deployments, (_meta, record) => workloadContains(record, ['vitastor'])),
          ...matchStatefulSetEvidence(statefulSets, (record) => workloadContains(record, ['vitastor'])),
          ...matchDaemonSetEvidence(daemonSets, (_meta, record) => workloadContains(record, ['vitastor'])),
          ...matchStorageClassEvidence(storageClasses, ['vitastor']),
          ...matchCsiDriverEvidence(csiDrivers, ['vitastor'])
        ]
      ),
      componentSummary(
        'cert-manager',
        'cert-manager',
        'certificates',
        'cert-manager evidence from controller workloads or cert-manager.io CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'cert-manager'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.name.startsWith('cert-manager')),
          ...matchDaemonSetEvidence(daemonSets, (meta) => meta.name.startsWith('cert-manager')),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('cert-manager.io') === true)
        ]
      ),
      componentSummary(
        'external-dns',
        'external-dns',
        'dns',
        'external-dns evidence from controller workloads.',
        [...matchDeploymentEvidence(deployments, (meta) => meta.name === 'external-dns')]
      ),
      componentSummary(
        'gateway-api',
        'Gateway API',
        'gateway',
        'Gateway API evidence from gateway.networking.k8s.io CRDs.',
        [...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group) === 'gateway.networking.k8s.io')]
      ),
      componentSummary(
        'argocd',
        'Argo CD',
        'continuous-delivery',
        'Argo CD evidence from argocd namespace, controller workloads, or argoproj.io application CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'argocd'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.namespace === 'argocd' || meta.name.startsWith('argocd-')),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group) === 'argoproj.io')
        ]
      ),
      componentSummary(
        'flux',
        'Flux',
        'continuous-delivery',
        'Flux evidence from flux-system namespace, controller workloads, or toolkit.fluxcd.io CRDs.',
        [
          ...matchNamespaceEvidence(namespaces, 'flux-system'),
          ...matchDeploymentEvidence(deployments, (meta) => meta.namespace === 'flux-system' || meta.name.includes('flux')),
          ...matchCrdEvidence(crds, (record) => stringOrUndefined(asRecord(record.spec)?.group)?.includes('toolkit.fluxcd.io') === true)
        ]
      )
    ]
      .filter(Boolean)
      .sort((left, right) => {
        if (left.category !== right.category) {
          return left.category.localeCompare(right.category);
        }
        return left.name.localeCompare(right.name);
      });

    const summary = {
      ingress: items.filter((item) => item.category === 'ingress').length,
      networking: items.filter((item) => item.category === 'networking').length,
      storage: items.filter((item) => item.category === 'storage').length,
      certificates: items.filter((item) => item.category === 'certificates').length,
      dns: items.filter((item) => item.category === 'dns').length,
      observability: items.filter((item) => item.category === 'observability').length,
      gateway: items.filter((item) => item.category === 'gateway').length,
      'continuous-delivery': items.filter((item) => item.category === 'continuous-delivery').length
    };

    partial = partial || items.some((item) => item.status === 'partial');

    return {
      items,
      summary,
      fetchedAt: new Date().toISOString(),
      issues,
      partial,
      availability: buildAvailability(issues, partial)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

function normalizeLocalCertificates(records) {
  return asRecordArray(records).map((record) => {
    const meta = metadataFor(record);
    const spec = asRecord(record.spec);
    const status = asRecord(record.status);
    const issuerRef = asRecord(spec?.issuerRef);
    const conditions = asRecordArray(status?.conditions).map((condition) => ({
      type: stringOrUndefined(condition.type) || 'Unknown',
      status: stringOrUndefined(condition.status) || 'Unknown',
      reason: stringOrUndefined(condition.reason),
      message: stringOrUndefined(condition.message),
      lastTransitionTime: stringOrUndefined(condition.lastTransitionTime)
    }));
    const ready = conditions.find((condition) => condition.type.toLowerCase() === 'ready');
    return {
      namespace: meta.namespace,
      name: meta.name,
      dnsNames: stringList(spec?.dnsNames),
      ready: ready?.status || 'Unknown',
      issuer: stringOrUndefined(issuerRef?.name),
      secretName: stringOrUndefined(spec?.secretName),
      notAfter: stringOrUndefined(status?.notAfter),
      reason: ready?.reason,
      message: ready?.message,
      conditions
    };
  });
}

function normalizeLocalOrders(records) {
  return asRecordArray(records).map((record) => {
    const meta = metadataFor(record);
    const metadata = asRecord(record.metadata);
    const annotations = asStringRecord(metadata?.annotations);
    const spec = asRecord(record.spec);
    const status = asRecord(record.status);
    return {
      namespace: meta.namespace,
      name: meta.name,
      certificateName: annotations['cert-manager.io/certificate-name'],
      state: stringOrUndefined(status?.state) || 'unknown',
      reason: stringOrUndefined(status?.reason),
      dnsNames: [...new Set([
        ...stringList(spec?.dnsNames),
        ...asRecordArray(status?.authorizations).map((item) => stringOrUndefined(item.identifier)).filter(Boolean)
      ])]
    };
  });
}

function normalizeLocalChallenges(records) {
  return asRecordArray(records).map((record) => {
    const meta = metadataFor(record);
    const metadata = asRecord(record.metadata);
    const owner = asRecordArray(metadata?.ownerReferences).find((item) => stringOrUndefined(item.kind) === 'Order');
    const spec = asRecord(record.spec);
    const status = asRecord(record.status);
    return {
      namespace: meta.namespace,
      name: meta.name,
      orderName: stringOrUndefined(owner?.name),
      state: stringOrUndefined(status?.state) || 'unknown',
      reason: stringOrUndefined(status?.reason),
      dnsName: stringOrUndefined(spec?.dnsName),
      type: stringOrUndefined(spec?.type)
    };
  });
}

export async function loadLocalDomainHealth(runtimeConfig, namespaceScope = null) {
  try {
    const kubeConfig = loadLocalKubeConfig(runtimeConfig);
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      fetchKubeList(
        kubeConfig,
        namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', effectiveNamespace)
      ),
      loadLocalServices(runtimeConfig, effectiveNamespace),
      fetchKubeList(kubeConfig, namespacePath('/apis/cert-manager.io/v1/certificates', '/apis/cert-manager.io/v1/namespaces/:namespace/certificates', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/acme.cert-manager.io/v1/orders', '/apis/acme.cert-manager.io/v1/namespaces/:namespace/orders', effectiveNamespace)),
      fetchKubeList(kubeConfig, namespacePath('/apis/acme.cert-manager.io/v1/challenges', '/apis/acme.cert-manager.io/v1/namespaces/:namespace/challenges', effectiveNamespace))
    ]);

    if (requests.slice(0, 2).every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    let partial = false;
    const ingressItems =
      requests[0].status === 'fulfilled'
        ? asRecordArray(requests[0].value.items)
        : (partial = true, issues.push(partialIssue('domain-health', 'Ingresses could not be loaded for domain health.')), []);
    const serviceSummary =
      requests[1].status === 'fulfilled'
        ? requests[1].value
        : (partial = true, issues.push(partialIssue('domain-health', 'Services could not be loaded for domain health.')), null);
    const certManagerAvailable = requests.slice(2).some((entry) => entry.status === 'fulfilled');
    const certManagerDenied = !certManagerAvailable && requests.slice(2).some((entry) =>
      entry.status === 'rejected' && !/404|not found/i.test(String(entry.reason?.message || entry.reason))
    );
    if (certManagerDenied) {
      partial = true;
      issues.push(partialIssue('domain-health', 'cert-manager resources could not be loaded.'));
    }
    const certificates = requests[2].status === 'fulfilled' ? normalizeLocalCertificates(requests[2].value.items) : [];
    const orders = requests[3].status === 'fulfilled' ? normalizeLocalOrders(requests[3].value.items) : [];
    const challenges = requests[4].status === 'fulfilled' ? normalizeLocalChallenges(requests[4].value.items) : [];

    if (requests[0].status === 'fulfilled' && requests[0].value.truncated) {
      partial = true;
      issues.push(truncationIssue('domain-health', 'The Ingress list was truncated for this runtime read.'));
    }

    const serviceMap = new Map();
    for (const service of serviceSummary?.items || []) {
      serviceMap.set(`${service.namespace}/${service.name}`, service);
    }

    const issueMap = new Map();
    const hostMap = new Map();
    const ingresses = [];

    for (const ingress of ingressItems) {
      const meta = metadataFor(ingress);
      const spec = asRecord(ingress.spec);
      const hosts = ingressHosts(ingress);
      const tlsHosts = ingressTlsHosts(ingress);
      const tlsSecretNames = ingressTlsSecretNames(ingress);
      const className = stringOrUndefined(spec?.ingressClassName);
      const backendServices = serviceSummary
        ? dedupeServiceLinks(
            ingressBackendRefs(ingress).map((ref) => {
              const match = serviceMap.get(`${ref.namespace}/${ref.name}`);
              if (!match) {
                return { namespace: ref.namespace, name: ref.name, status: 'missing' };
              }
              if (match.endpointAvailability.status === 'missing') {
                return { namespace: ref.namespace, name: ref.name, status: 'no-endpoints' };
              }
              return { namespace: ref.namespace, name: ref.name, status: 'ready' };
            })
          )
        : [];

      for (const host of hosts) {
        const existing = hostMap.get(host) || {
          host,
          owners: [],
          tls: false,
          tlsSecretNames: [],
          backendServices: [],
          issueIds: [],
          status: 'healthy'
        };

        existing.owners = [...existing.owners, { namespace: meta.namespace, ingressName: meta.name, className }];
        existing.tls = existing.tls || tlsHosts.includes(host) || (host === '*' && tlsSecretNames.length > 0);
        existing.tlsSecretNames = [...new Set([...existing.tlsSecretNames, ...tlsSecretNames])];
        existing.backendServices = dedupeServiceLinks([...existing.backendServices, ...backendServices]);

        for (const backend of backendServices) {
          if (backend.status === 'missing' || backend.status === 'no-endpoints') {
            const severity = backend.status === 'missing' ? 'critical' : 'warning';
            const issueId = `${backend.status === 'missing' ? 'domain.missing_service' : 'domain.no_endpoints'}.${host}.${backend.namespace}.${backend.name}`;
            issueMap.set(issueId, {
              id: issueId,
              severity,
              title: backend.status === 'missing' ? 'Ingress backend service missing' : 'Ingress backend has no endpoints',
              message:
                backend.status === 'missing'
                  ? `Host ${host} routes to ${backend.namespace}/${backend.name}, but that Service was not found.`
                  : `Host ${host} routes to ${backend.namespace}/${backend.name}, but the Service has no ready endpoints.`,
              host,
              nextStep:
                backend.status === 'missing'
                  ? 'Verify the Ingress backend service name and namespace.'
                  : 'Verify Service selectors, pods, and EndpointSlices for this backend.',
              objectRefs: [
                { kind: 'Ingress', namespace: meta.namespace, name: meta.name },
                { kind: 'Service', namespace: backend.namespace, name: backend.name }
              ]
            });
            if (!existing.issueIds.includes(issueId)) {
              existing.issueIds.push(issueId);
            }
          }
        }

        existing.status = existing.issueIds.some((id) => issueMap.get(id)?.severity === 'critical')
          ? 'critical'
          : existing.issueIds.length > 0
            ? 'warning'
            : 'healthy';
        hostMap.set(host, existing);
      }

      ingresses.push({
        name: meta.name,
        namespace: meta.namespace,
        className,
        createdAt: meta.createdAt,
        hosts,
        tlsHosts,
        backendServices,
        issueCount: backendServices.filter((backend) => backend.status !== 'ready').length
      });
    }

    const fetchedAt = new Date().toISOString();
    for (const certificate of certificates) {
      const ready = certificate.ready.toLowerCase() === 'true';
      const expired = certificate.notAfter ? Date.parse(certificate.notAfter) <= Date.parse(fetchedAt) : false;
      if (ready && !expired) continue;
      const reason = certificate.reason || (expired ? 'Expired' : 'Not Ready');
      const critical = expired || /expired|failed|revoked|denied/i.test(reason);
      const linkedHosts = [...hostMap.values()].filter((host) =>
        certificate.dnsNames.includes(host.host) ||
        (host.owners.some((owner) => owner.namespace === certificate.namespace) &&
          certificate.secretName && host.tlsSecretNames.includes(certificate.secretName))
      );
      const affectedHosts = linkedHosts.length > 0 ? linkedHosts.map((host) => host.host) : certificate.dnsNames;
      for (const host of affectedHosts.length > 0 ? affectedHosts : [undefined]) {
        const issueId = `domain.certificate.${certificate.namespace}.${certificate.name}.${host || 'unlinked'}`;
        issueMap.set(issueId, {
          id: issueId,
          severity: critical ? 'critical' : 'warning',
          title: expired ? 'Certificate expired' : 'Certificate is not ready',
          message: certificate.message || `${certificate.namespace}/${certificate.name} reports ${reason}.`,
          ...(host ? { host } : {}),
          nextStep: 'Review the Certificate, Order, and Challenge status in cert-manager.',
          objectRefs: [{ kind: 'Certificate', namespace: certificate.namespace, name: certificate.name }]
        });
        const hostSummary = host ? hostMap.get(host) : null;
        if (hostSummary && !hostSummary.issueIds.includes(issueId)) {
          hostSummary.issueIds.push(issueId);
          hostSummary.status = critical ? 'critical' : hostSummary.status === 'critical' ? 'critical' : 'warning';
        }
      }
    }

    const hosts = [...hostMap.values()].sort((left, right) => left.host.localeCompare(right.host));
    const issuesList = [...issueMap.values()].sort((left, right) => validationSeverityRank(left.severity) - validationSeverityRank(right.severity));

    return {
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      issues,
      partial: partial || serviceSummary?.partial === true,
      availability: buildAvailability(issues, partial || serviceSummary?.partial === true),
      summary: {
        ingresses: ingresses.length,
        hosts: hosts.length,
        tlsHosts: hosts.filter((host) => host.tls).length,
        problematicHosts: hosts.filter((host) => host.status !== 'healthy').length,
        issues: issuesList.length
      },
      ingresses: buildResourceList(ingresses, new Date().toISOString(), requests[0].status === 'fulfilled' ? requests[0].value.truncated : true),
      hosts: buildResourceList(hosts, new Date().toISOString(), requests[0].status === 'fulfilled' ? requests[0].value.truncated : true),
      issuesList: buildResourceList(issuesList, new Date().toISOString(), requests[0].status === 'fulfilled' ? requests[0].value.truncated : true),
      certManagerAvailable,
      certManagerMessage: certManagerDenied ? 'cert-manager is installed, but its resources are not readable with the current credentials.' : undefined,
      certificates: buildResourceList(certificates, fetchedAt, requests[2].status === 'fulfilled' ? requests[2].value.truncated : certManagerDenied),
      orders: buildResourceList(orders, fetchedAt, requests[3].status === 'fulfilled' ? requests[3].value.truncated : certManagerDenied),
      challenges: buildResourceList(challenges, fetchedAt, requests[4].status === 'fulfilled' ? requests[4].value.truncated : certManagerDenied)
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

export async function loadLocalValidation(runtimeConfig, namespaceScope = null) {
  try {
    const effectiveNamespace = namespaceScope || runtimeConfig.namespace || null;
    const requests = await Promise.allSettled([
      loadLocalNodes(runtimeConfig),
      loadLocalWorkloads(runtimeConfig, effectiveNamespace),
      loadLocalServices(runtimeConfig, effectiveNamespace),
      loadLocalStorage(runtimeConfig, effectiveNamespace),
      loadLocalComponentInventory(runtimeConfig),
      loadLocalDomainHealth(runtimeConfig, effectiveNamespace),
      loadLocalRbac(runtimeConfig, effectiveNamespace),
      loadLocalPorts(runtimeConfig, effectiveNamespace),
      loadLocalGatewayApiValidationData(runtimeConfig, effectiveNamespace)
    ]);

    if (requests.every((entry) => entry.status === 'rejected')) {
      throw requests[0].reason;
    }

    const issues = [];
    const nodes =
      requests[0].status === 'fulfilled'
        ? requests[0].value
        : (issues.push(partialIssue('validation', 'Node validation inputs could not be loaded.')), null);
    const workloads =
      requests[1].status === 'fulfilled'
        ? requests[1].value
        : (issues.push(partialIssue('validation', 'Workload validation inputs could not be loaded.')), null);
    const services =
      requests[2].status === 'fulfilled'
        ? requests[2].value
        : (issues.push(partialIssue('validation', 'Networking validation inputs could not be loaded.')), null);
    const storage =
      requests[3].status === 'fulfilled'
        ? requests[3].value
        : (issues.push(partialIssue('validation', 'Storage validation inputs could not be loaded.')), null);
    const components =
      requests[4].status === 'fulfilled'
        ? requests[4].value
        : (issues.push(partialIssue('validation', 'Component validation inputs could not be loaded.')), null);
    const domainHealth =
      requests[5].status === 'fulfilled'
        ? requests[5].value
        : (issues.push(partialIssue('validation', 'Domain health validation inputs could not be loaded.')), null);
    const rbac =
      requests[6].status === 'fulfilled'
        ? requests[6].value
        : (issues.push(partialIssue('validation', 'RBAC validation inputs could not be loaded.')), null);
    const ports =
      requests[7].status === 'fulfilled'
        ? requests[7].value
        : (issues.push(partialIssue('validation', 'Ports validation inputs could not be loaded.')), null);
    const gatewayApi =
      requests[8].status === 'fulfilled'
        ? requests[8].value
        : (issues.push(partialIssue('validation', 'Gateway API validation inputs could not be loaded.')), null);

    const items = [];

    for (const node of nodes?.items || []) {
      if (!node.ready) {
        items.push(
          validationItem(
            `cluster.node_not_ready.${node.name}`,
            'cluster',
            'critical',
            'Node is not ready',
            `${node.name} is reporting NotReady.`,
            'Review node conditions, kubelet logs, and scheduler pressure on this node.',
            [{ kind: 'Node', name: node.name }]
          )
        );
      }

      const pressures = [
        node.conditions.memoryPressure ? 'MemoryPressure' : null,
        node.conditions.diskPressure ? 'DiskPressure' : null,
        node.conditions.pidPressure ? 'PIDPressure' : null,
        node.conditions.networkUnavailable ? 'NetworkUnavailable' : null
      ].filter(Boolean);

      if (pressures.length > 0) {
        items.push(
          validationItem(
            `cluster.node_pressure.${node.name}`,
            'cluster',
            'warning',
            'Node pressure detected',
            `${node.name} reports ${pressures.join(', ')}.`,
            'Review node capacity, disk pressure, and kubelet condition events.',
            [{ kind: 'Node', name: node.name }],
            pressures
          )
        );
      }
    }

    for (const workload of workloads?.items || []) {
      if (workload.desired > workload.ready) {
        items.push(
          validationItem(
            `workloads.ready_mismatch.${workload.namespace}.${workload.kind}.${workload.name}`,
            'workloads',
            workload.ready === 0 ? 'critical' : 'warning',
            'Workload desired/ready mismatch',
            `${workload.kind} ${workload.namespace}/${workload.name} is ${workload.ready}/${workload.desired} ready.`,
            'Check pod events, rollout status, and workload scheduling constraints.',
            [{ kind: workload.kind, namespace: workload.namespace, name: workload.name }],
            workload.podSummary ? [`${workload.podSummary.crashLoopBackOff} pods in CrashLoopBackOff`] : []
          )
        );
      }

      if ((workload.podSummary?.crashLoopBackOff || 0) > 0) {
        items.push(
          validationItem(
            `workloads.crashloop.${workload.namespace}.${workload.kind}.${workload.name}`,
            'workloads',
            'warning',
            'CrashLoopBackOff detected behind workload',
            `${workload.kind} ${workload.namespace}/${workload.name} has ${workload.podSummary?.crashLoopBackOff || 0} crashing pod(s).`,
            'Inspect pod restart reasons and container logs for this workload.',
            [{ kind: workload.kind, namespace: workload.namespace, name: workload.name }]
          )
        );
      }
    }

    if (!ports) {
      for (const service of services?.items || []) {
        if (service.endpointAvailability.status === 'missing' && Object.keys(service.selector).length > 0) {
          items.push(
            validationItem(
              `networking.service_no_endpoints.${service.namespace}.${service.name}`,
              'networking',
              'warning',
              'Service has no ready endpoints',
              `${service.namespace}/${service.name} does not currently have any ready endpoints.`,
              'Verify Service selectors, backing pods, and EndpointSlices for this Service.',
              [{ kind: 'Service', namespace: service.namespace, name: service.name }],
              Object.entries(service.selector).map(([key, value]) => `${key}=${value}`)
            )
          );
        }
      }
    }

    for (const issue of domainHealth?.issuesList.items || []) {
      items.push(
        validationItem(
          issue.id,
          'networking',
          issue.severity,
          issue.title,
          issue.message,
          issue.nextStep,
          issue.objectRefs,
          issue.host ? [`Host ${issue.host}`] : []
        )
      );
    }

    for (const claim of storage?.persistentVolumeClaims.items || []) {
      if ((claim.status || '').toLowerCase() === 'pending') {
        items.push(
          validationItem(
            `storage.pvc_pending.${claim.namespace}.${claim.name}`,
            'storage',
            'warning',
            'PersistentVolumeClaim pending',
            `${claim.namespace}/${claim.name} is still pending.`,
            'Check the selected storage class, provisioner, and PVC events.',
            [{ kind: 'PersistentVolumeClaim', namespace: claim.namespace, name: claim.name }],
            [claim.storageClassName ? `StorageClass ${claim.storageClassName}` : 'No storage class recorded.']
          )
        );
      }
    }

    for (const volume of storage?.persistentVolumes.items || []) {
      const status = (volume.status || '').toLowerCase();
      if (status === 'released' || status === 'failed') {
        items.push(
          validationItem(
            `storage.pv_attention.${volume.name}`,
            'storage',
            status === 'failed' ? 'critical' : 'warning',
            'PersistentVolume needs attention',
            `${volume.name} is in ${volume.status} state.`,
            'Review claim bindings, reclaim policy, and backend storage health for this volume.',
            [{ kind: 'PersistentVolume', name: volume.name }],
            volume.claimRef ? [`Claim ${volume.claimRef.namespace}/${volume.claimRef.name}`] : []
          )
        );
      }
    }

    for (const component of components?.items || []) {
      if (component.status === 'partial') {
        items.push(
          validationItem(
            `components.partial.${component.key}`,
            'components',
            component.confidence === 'low' ? 'warning' : 'info',
            'Component detected with limited evidence',
            `${component.name} was detected, but only partial control artifacts are visible.`,
            'Confirm the component controller workloads are installed and healthy in the cluster.',
            component.evidence.map((evidence) => ({ kind: evidence.kind, namespace: evidence.namespace, name: evidence.name })),
            component.evidence.map((evidence) =>
              evidence.namespace ? `${evidence.kind} ${evidence.namespace}/${evidence.name}` : `${evidence.kind} ${evidence.name}`
            )
          )
        );
      }
    }

    items.push(...(rbac ? buildRbacValidationItems(rbac) : []));
    items.push(...(ports ? buildPortsValidationItems(ports) : []));
    items.push(...(gatewayApi
      ? buildGatewayApiValidationItems({
          ...gatewayApi,
          namespaceScope: effectiveNamespace,
          services: services?.items || [],
          servicesPartial: services?.partial === true,
          portRows: ports?.services?.items || []
        })
      : []));

    const deduped = [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => {
      const severity = validationSeverityRank(left.severity) - validationSeverityRank(right.severity);
      if (severity !== 0) {
        return severity;
      }
      if (left.category !== right.category) {
        return left.category.localeCompare(right.category);
      }
      return left.title.localeCompare(right.title);
    });

    const partial = [nodes, workloads, services, storage, components, domainHealth, rbac, ports, gatewayApi].some((entry) => entry?.partial === true);

    return {
      namespaceScope: effectiveNamespace,
      fetchedAt: new Date().toISOString(),
      issues,
      partial,
      availability: buildAvailability(issues, partial),
      items: deduped,
      summary: {
        total: deduped.length,
        bySeverity: {
          critical: deduped.filter((item) => item.severity === 'critical').length,
          warning: deduped.filter((item) => item.severity === 'warning').length,
          info: deduped.filter((item) => item.severity === 'info').length
        },
        byCategory: {
          components: deduped.filter((item) => item.category === 'components').length,
          cluster: deduped.filter((item) => item.category === 'cluster').length,
          workloads: deduped.filter((item) => item.category === 'workloads').length,
          networking: deduped.filter((item) => item.category === 'networking').length,
          storage: deduped.filter((item) => item.category === 'storage').length,
          rbac: deduped.filter((item) => item.category === 'rbac').length
        }
      }
    };
  } catch (error) {
    throw new Error(sanitizeKubeError(error));
  }
}

async function loadLocalGatewayApiValidationData(runtimeConfig, namespaceScope = null) {
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const crds = await fetchKubeList(kubeConfig, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  const definitions = gatewayApiDefinitionsFromCrds(crds.items);
  const requests = await Promise.allSettled(
    definitions.map((definition) =>
      fetchKubeList(kubeConfig, gatewayApiResourcePath(definition, namespaceScope), true)
    )
  );
  const resources = {
    gatewayClasses: [],
    gateways: [],
    routes: [],
    referenceGrants: []
  };
  let partial = crds.truncated;

  requests.forEach((result, index) => {
    const definition = definitions[index];
    if (!definition) return;
    if (result.status === 'rejected') {
      partial = true;
      return;
    }
    partial = partial || result.value.truncated;
    if (definition.kind === 'GatewayClass') resources.gatewayClasses.push(...result.value.items);
    else if (definition.kind === 'Gateway') resources.gateways.push(...result.value.items);
    else if (definition.kind === 'ReferenceGrant') resources.referenceGrants.push(...result.value.items);
    else resources.routes.push(...result.value.items);
  });

  return {
    ...resources,
    partial,
    referenceGrantsPartial: partial || Boolean(namespaceScope && namespaceScope !== 'all')
  };
}

function gatewayApiResourcePath(definition, namespaceScope = null) {
  const base = `/apis/${encodeURIComponent(definition.group)}/${encodeURIComponent(definition.version)}`;
  if (definition.scope === 'Namespaced' && namespaceScope && namespaceScope !== 'all') {
    return `${base}/namespaces/${encodeURIComponent(namespaceScope)}/${encodeURIComponent(definition.plural)}`;
  }
  return `${base}/${encodeURIComponent(definition.plural)}`;
}
