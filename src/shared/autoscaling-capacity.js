const CACHE_TTL_MS = 30_000;
const MAX_CACHE_SCOPES = 8;
const MAX_PAGES = 4;
const PAGE_SIZE = 250;
const MAX_OUTPUT_ITEMS = 1_000;
const cacheByTransport = new WeakMap();

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' ? value : '';
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const metadata = (value) => record(record(value).metadata);
const spec = (value) => record(record(value).spec);
const status = (value) => record(record(value).status);
const objectId = (kind, value) => `${kind}:${text(metadata(value).namespace) || '_cluster'}/${text(metadata(value).name)}`;

function parseCpuMilli(value) {
  const raw = text(value).trim();
  if (!raw) return 0;
  const match = raw.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(n|u|m)?$/);
  if (!match) return 0;
  const scalar = Number(match[1]);
  return match[2] === 'n' ? scalar / 1_000_000 : match[2] === 'u' ? scalar / 1_000 : match[2] === 'm' ? scalar : scalar * 1_000;
}

function parseBytes(value) {
  const raw = text(value).trim();
  if (!raw) return 0;
  const match = raw.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)([EPTGMK]i?|m|k)?$/i);
  if (!match) return 0;
  const suffix = match[2] || '';
  const binary = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  const decimal = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, m: 1e-3 };
  return Number(match[1]) * (binary[suffix] || decimal[suffix] || 1);
}

function resourceValue(key, value) {
  if (key === 'cpu') return parseCpuMilli(value);
  if (key === 'memory' || key === 'ephemeral-storage') return parseBytes(value);
  return number(value);
}

function quotaValue(key, value) {
  const raw = text(value).trim();
  if (!raw) return undefined;
  if (/(^|\.)cpu$/.test(key)) return parseCpuMilli(raw);
  if (/memory|storage|hugepages/i.test(key)) return parseBytes(raw);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyResources() {
  return { cpuMilli: 0, memoryBytes: 0, ephemeralStorageBytes: 0, gpu: {} };
}

function addResource(target, key, value) {
  const parsed = resourceValue(key, value);
  if (key === 'cpu') target.cpuMilli += parsed;
  else if (key === 'memory') target.memoryBytes += parsed;
  else if (key === 'ephemeral-storage') target.ephemeralStorageBytes += parsed;
  else if (/gpu/i.test(key)) target.gpu[key] = (target.gpu[key] || 0) + parsed;
}

function addResourceList(target, source) {
  for (const [key, value] of Object.entries(record(source))) addResource(target, key, value);
  return target;
}

function maxResources(left, right) {
  const output = {
    cpuMilli: Math.max(left.cpuMilli, right.cpuMilli),
    memoryBytes: Math.max(left.memoryBytes, right.memoryBytes),
    ephemeralStorageBytes: Math.max(left.ephemeralStorageBytes, right.ephemeralStorageBytes),
    gpu: { ...left.gpu }
  };
  for (const [key, value] of Object.entries(right.gpu)) output.gpu[key] = Math.max(output.gpu[key] || 0, value);
  return output;
}

function sumResources(left, right) {
  const output = { cpuMilli: left.cpuMilli + right.cpuMilli, memoryBytes: left.memoryBytes + right.memoryBytes,
    ephemeralStorageBytes: left.ephemeralStorageBytes + right.ephemeralStorageBytes, gpu: { ...left.gpu } };
  for (const [key, value] of Object.entries(right.gpu)) output.gpu[key] = (output.gpu[key] || 0) + value;
  return output;
}

function compactResources(value) {
  return {
    ...(value.cpuMilli ? { cpuMilli: value.cpuMilli } : {}),
    ...(value.memoryBytes ? { memoryBytes: value.memoryBytes } : {}),
    ...(value.ephemeralStorageBytes ? { ephemeralStorageBytes: value.ephemeralStorageBytes } : {}),
    ...(Object.keys(value.gpu).length ? { gpu: value.gpu } : {})
  };
}

// Mirrors scheduler semantics, including restartable init sidecars and Pod overhead.
function effectivePodResources(podSpec, field) {
  const regular = emptyResources();
  for (const container of list(podSpec.containers)) addResourceList(regular, record(record(container).resources)[field]);
  let runningInit = emptyResources();
  let initPeak = emptyResources();
  for (const container of list(podSpec.initContainers)) {
    const resources = addResourceList(emptyResources(), record(record(container).resources)[field]);
    if (record(container).restartPolicy === 'Always') {
      runningInit = sumResources(runningInit, resources);
      initPeak = maxResources(initPeak, runningInit);
    } else {
      initPeak = maxResources(initPeak, sumResources(runningInit, resources));
    }
  }
  let result = maxResources(sumResources(regular, runningInit), initPeak);
  result = maxResources(result, addResourceList(emptyResources(), record(record(podSpec).resources)[field]));
  result = sumResources(result, addResourceList(emptyResources(), record(podSpec.overhead)));
  return result;
}

function conditionRows(value) {
  return list(status(value).conditions).map((condition) => ({
    type: text(record(condition).type), status: text(record(condition).status), reason: text(record(condition).reason),
    message: text(record(condition).message).slice(0, 1_024), lastTransitionTime: text(record(condition).lastTransitionTime)
  }));
}

function condition(value, type) {
  return conditionRows(value).find((entry) => entry.type === type);
}

function sourceStatus(error) {
  const code = Number(record(error).status || String(record(error).message || '').match(/(?:HTTP|status)\s*(\d{3})/i)?.[1]);
  return code === 401 || code === 403 ? 'denied' : code === 404 ? 'absent' : 'error';
}

function apiPath(groupVersion, resource, namespace, namespaced = true) {
  const root = groupVersion === 'v1' ? '/api/v1' : `/apis/${groupVersion}`;
  return `${root}${namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''}/${resource}`;
}

async function collectList(request, descriptor, namespace, sources) {
  const items = [];
  let continuation = '';
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(continuation ? { continue: continuation } : {}) });
      const payload = await request(`${apiPath(descriptor.version, descriptor.resource, namespace, descriptor.namespaced)}?${query}`, { maxBytes: 4 * 1024 * 1024 });
      if (!Array.isArray(record(payload).items)) throw new Error('Invalid Kubernetes list response.');
      items.push(...payload.items.slice(0, PAGE_SIZE));
      continuation = text(record(record(payload).metadata).continue);
      if (!continuation) break;
    }
    sources.push({ id: descriptor.id, status: 'available', count: items.length, ...(continuation ? { partial: true, message: 'Collection page limit reached.' } : {}) });
  } catch (error) {
    const state = sourceStatus(error);
    sources.push({ id: descriptor.id, status: state, count: items.length, partial: state !== 'absent',
      message: state === 'denied' ? 'Kubernetes permission denied.' : state === 'absent' ? 'API is not installed.' : 'Source could not be read.' });
  }
  return items;
}

function hpaMetric(metric, current) {
  const source = record(metric);
  const type = text(source.type) || 'Unknown';
  const configured = record(source[type.toLowerCase()] || source[type]);
  const target = record(configured.target);
  const currentValue = record(record(current)[type.toLowerCase()] || record(current)[type]);
  return { type, name: text(record(configured.name ? configured : configured.metric).name) || text(configured.name),
    targetType: text(target.type), target: target.averageUtilization ?? target.averageValue ?? target.value,
    current: currentValue.current?.averageUtilization ?? currentValue.current?.averageValue ?? currentValue.current?.value
      ?? currentValue.averageUtilization ?? currentValue.averageValue ?? currentValue.value };
}

function normalizeHpa(item, kedaOwners) {
  const itemSpec = spec(item);
  const itemStatus = status(item);
  const namespace = text(metadata(item).namespace);
  const name = text(metadata(item).name);
  const owner = list(metadata(item).ownerReferences).find((entry) => text(record(entry).kind) === 'ScaledObject');
  const managedBy = owner || kedaOwners.has(`${namespace}/${name}`) ? 'KEDA' : undefined;
  const currentMetrics = list(itemStatus.currentMetrics);
  const conditions = conditionRows(item);
  const active = conditions.find((entry) => entry.type === 'ScalingActive');
  const able = conditions.find((entry) => entry.type === 'AbleToScale');
  return {
    id: objectId('HorizontalPodAutoscaler', item), kind: 'HorizontalPodAutoscaler', name, namespace,
    target: [text(record(itemSpec.scaleTargetRef).kind), text(record(itemSpec.scaleTargetRef).name)].filter(Boolean).join('/'),
    state: able?.status === 'False' || active?.status === 'False' ? 'Unavailable' : 'Ready',
    provider: managedBy || 'Kubernetes', managedBy,
    currentReplicas: number(itemStatus.currentReplicas), desiredReplicas: number(itemStatus.desiredReplicas),
    minReplicas: itemSpec.minReplicas === undefined ? 1 : number(itemSpec.minReplicas), maxReplicas: number(itemSpec.maxReplicas),
    metrics: list(itemSpec.metrics).map((entry, index) => hpaMetric(entry, currentMetrics[index])), conditions,
    details: { behavior: record(itemSpec.behavior), lastScaleTime: text(itemStatus.lastScaleTime) || undefined }
  };
}

function normalizeVpa(item) {
  const itemSpec = spec(item);
  const recommendations = list(record(status(item).recommendation).containerRecommendations).map((entry) => ({
    container: text(record(entry).containerName), target: record(record(entry).target), lowerBound: record(record(entry).lowerBound),
    upperBound: record(record(entry).upperBound), uncappedTarget: record(record(entry).uncappedTarget)
  }));
  const provided = condition(item, 'RecommendationProvided');
  return {
    id: objectId('VerticalPodAutoscaler', item), kind: 'VerticalPodAutoscaler', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    target: [text(record(itemSpec.targetRef).kind), text(record(itemSpec.targetRef).name)].filter(Boolean).join('/'),
    state: provided?.status === 'False' ? 'Unavailable' : recommendations.length ? 'Ready' : 'Pending', provider: 'VPA',
    conditions: conditionRows(item), details: { updateMode: text(record(itemSpec.updatePolicy).updateMode) || 'Recreate', recommendations,
      resourcePolicy: record(itemSpec.resourcePolicy), recommenders: list(itemSpec.recommenders).map((entry) => text(record(entry).name)).filter(Boolean) }
  };
}

const SENSITIVE_METADATA = /pass(word)?|token|secret|credential|connection|string|sas|private|access.?key|client.?key/i;
const SAFE_TRIGGER_VALUES = /^(metricName|threshold|activationThreshold|targetValue|activationTargetValue|queueName|topic|subscriptionName|consumerGroup|stream|lagThreshold|value|queryValue)$/i;

function safeTriggers(item) {
  return list(spec(item).triggers).map((trigger) => {
    const source = record(trigger);
    const metadata = record(source.metadata);
    const safeMetadata = {};
    const metadataKeys = [];
    for (const [key, value] of Object.entries(metadata)) {
      metadataKeys.push(key);
      if (!SENSITIVE_METADATA.test(key) && SAFE_TRIGGER_VALUES.test(key)) safeMetadata[key] = text(value).slice(0, 256);
    }
    return { type: text(source.type) || 'unknown', metricType: text(source.metricType) || undefined,
      authenticationRef: text(record(source.authenticationRef).name) || undefined,
      authenticationKind: text(record(source.authenticationRef).kind) || 'TriggerAuthentication', metadata: safeMetadata, metadataKeys };
  });
}

function normalizeKeda(item, kind) {
  const itemSpec = spec(item);
  const conditions = conditionRows(item);
  const ready = conditions.find((entry) => entry.type === 'Ready');
  const fallback = conditions.find((entry) => entry.type === 'Fallback');
  const annotations = record(metadata(item).annotations);
  const paused = annotations['autoscaling.keda.sh/paused'] === 'true' || annotations['autoscaling.keda.sh/paused-replicas'] !== undefined;
  const scaleTarget = record(itemSpec.scaleTargetRef);
  return {
    id: objectId(kind, item), kind, name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    target: kind === 'ScaledJob' ? text(record(itemSpec.jobTargetRef).template?.metadata?.name) || 'Job template'
      : [text(scaleTarget.kind) || 'Deployment', text(scaleTarget.name)].filter(Boolean).join('/'),
    state: ready?.status === 'False' ? 'Unavailable' : fallback?.status === 'True' ? 'Fallback' : paused ? 'Paused' : 'Ready',
    provider: 'KEDA', minReplicas: itemSpec.minReplicaCount === undefined ? 0 : number(itemSpec.minReplicaCount),
    maxReplicas: number(itemSpec.maxReplicaCount === undefined ? 100 : itemSpec.maxReplicaCount), conditions,
    details: { pollingInterval: itemSpec.pollingInterval, cooldownPeriod: itemSpec.cooldownPeriod, idleReplicaCount: itemSpec.idleReplicaCount,
      scaleToZero: kind === 'ScaledObject' && number(itemSpec.minReplicaCount) === 0, paused, fallback: itemSpec.fallback ? {
        failureThreshold: record(itemSpec.fallback).failureThreshold, replicas: record(itemSpec.fallback).replicas,
        behavior: record(itemSpec.fallback).behavior
      } : undefined, triggers: safeTriggers(item), advanced: record(itemSpec.advanced) }
  };
}

function normalizePdb(item) {
  const itemSpec = spec(item);
  const itemStatus = status(item);
  const healthy = number(itemStatus.currentHealthy);
  const desired = number(itemStatus.desiredHealthy);
  return {
    id: objectId('PodDisruptionBudget', item), kind: 'PodDisruptionBudget', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    state: healthy < desired ? 'Unhealthy' : 'Ready', conditions: conditionRows(item),
    details: { minAvailable: itemSpec.minAvailable, maxUnavailable: itemSpec.maxUnavailable, selector: record(itemSpec.selector),
      currentHealthy: healthy, desiredHealthy: desired, expectedPods: number(itemStatus.expectedPods), disruptionsAllowed: number(itemStatus.disruptionsAllowed),
      unhealthyPodEvictionPolicy: text(itemSpec.unhealthyPodEvictionPolicy) || undefined }
  };
}

function podOwner(pod, replicaSets) {
  const owner = list(metadata(pod).ownerReferences).find((entry) => record(entry).controller === true) || list(metadata(pod).ownerReferences)[0];
  if (!owner) return { kind: 'Pod', name: text(metadata(pod).name) };
  if (text(record(owner).kind) === 'ReplicaSet') {
    const rs = replicaSets.find((item) => text(metadata(item).namespace) === text(metadata(pod).namespace) && text(metadata(item).name) === text(record(owner).name));
    const root = list(metadata(rs).ownerReferences).find((entry) => record(entry).controller === true);
    if (root) return { kind: text(record(root).kind), name: text(record(root).name) };
  }
  return { kind: text(record(owner).kind), name: text(record(owner).name) };
}

function podUsage(metric) {
  const resources = emptyResources();
  for (const container of list(record(metric).containers)) addResourceList(resources, record(container).usage);
  return resources;
}

function capacityFromInventory(pods, replicaSets, podMetrics, nodes, nodeMetrics, namespace) {
  const metricByPod = new Map(podMetrics.map((item) => [`${text(metadata(item).namespace)}/${text(metadata(item).name)}`, item]));
  const workloadRows = new Map();
  let clusterRequests = emptyResources();
  let scopedRequests = emptyResources();
  let scopedLimits = emptyResources();
  let scopedUsage = emptyResources();
  const active = pods.filter((pod) => !['Succeeded', 'Failed'].includes(text(status(pod).phase)));
  for (const pod of active) {
    const ns = text(metadata(pod).namespace);
    const requests = effectivePodResources(spec(pod), 'requests');
    const limits = effectivePodResources(spec(pod), 'limits');
    const usage = podUsage(metricByPod.get(`${ns}/${text(metadata(pod).name)}`));
    clusterRequests = sumResources(clusterRequests, requests);
    if (namespace === 'all' || namespace === ns) {
      scopedRequests = sumResources(scopedRequests, requests); scopedLimits = sumResources(scopedLimits, limits); scopedUsage = sumResources(scopedUsage, usage);
      const owner = podOwner(pod, replicaSets);
      const key = `${ns}/${owner.kind}/${owner.name}`;
      const row = workloadRows.get(key) || { id: key, namespace: ns, kind: owner.kind, name: owner.name, pods: 0, readyPods: 0,
        requests: emptyResources(), limits: emptyResources(), usage: emptyResources() };
      row.pods += 1;
      row.readyPods += Number(list(status(pod).conditions).some((entry) => text(record(entry).type) === 'Ready' && text(record(entry).status) === 'True'));
      row.requests = sumResources(row.requests, requests); row.limits = sumResources(row.limits, limits); row.usage = sumResources(row.usage, usage);
      workloadRows.set(key, row);
    }
  }
  let allocatable = emptyResources();
  let schedulableNodes = 0;
  for (const node of nodes) {
    const ready = list(status(node).conditions).some((entry) => text(record(entry).type) === 'Ready' && text(record(entry).status) === 'True');
    if (!ready || spec(node).unschedulable === true) continue;
    schedulableNodes += 1;
    allocatable = sumResources(allocatable, addResourceList(emptyResources(), status(node).allocatable));
  }
  let clusterUsage = emptyResources();
  for (const metric of nodeMetrics) clusterUsage = sumResources(clusterUsage, podUsage({ containers: [{ usage: record(metric).usage }] }));
  return {
    clusterWide: { nodes: nodes.length, schedulableNodes, allocatable: compactResources(allocatable), requests: compactResources(clusterRequests),
      ...(nodeMetrics.length ? { usage: compactResources(clusterUsage) } : {}) },
    scoped: { namespace, requests: compactResources(scopedRequests), limits: compactResources(scopedLimits),
      ...(podMetrics.length ? { usage: compactResources(scopedUsage) } : {}) },
    workloads: [...workloadRows.values()].map((row) => ({ ...row, requests: compactResources(row.requests), limits: compactResources(row.limits), usage: compactResources(row.usage) }))
  };
}

function normalizeQuota(item) {
  return { id: objectId('ResourceQuota', item), kind: 'ResourceQuota', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    state: 'Observed', details: { hard: record(status(item).hard), used: record(status(item).used), scopes: list(spec(item).scopes) } };
}

function normalizeLimitRange(item) {
  return { id: objectId('LimitRange', item), kind: 'LimitRange', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    state: 'Observed', details: { limits: list(spec(item).limits).map((entry) => ({ type: text(record(entry).type), min: record(record(entry).min),
      max: record(record(entry).max), default: record(record(entry).default), defaultRequest: record(record(entry).defaultRequest), maxLimitRequestRatio: record(record(entry).maxLimitRequestRatio) })) } };
}

function unschedulablePod(item) {
  return list(status(item).conditions).find((entry) => text(record(entry).type) === 'PodScheduled' && text(record(entry).status) === 'False' && text(record(entry).reason) === 'Unschedulable');
}

function finding(category, severity, code, title, message, resource, evidence, recommendation, clusterWide = false) {
  return { id: `${category}:${code}:${resource.kind}:${resource.namespace || '_cluster'}/${resource.name}`, category, severity, title, message, resource,
    evidence: evidence.filter(Boolean), recommendation, ...(clusterWide ? { clusterWide: true } : {}) };
}

function analyze({ hpas, vpas, scaledObjects, scaledJobs, triggerAuthKeys, pdbs, pods, quotas, nodeProviders, nodePools, nodeClaims, sourceComplete }) {
  const findings = [];
  const kedaByTarget = new Map(scaledObjects.map((item) => [`${item.namespace}/${item.target}`, item]));
  for (const item of hpas) {
    const failed = list(item.conditions).find((entry) => ['AbleToScale', 'ScalingActive'].includes(text(record(entry).type)) && text(record(entry).status) === 'False');
    if (failed) findings.push(finding('hpa', 'warning', text(record(failed).type), 'HPA cannot calculate or apply scaling',
      text(record(failed).message) || `${item.name} reports ${text(record(failed).type)}=False.`, item, [text(record(failed).reason)], 'Inspect the target scale subresource and configured metrics APIs.'));
    const limited = list(item.conditions).find((entry) => text(record(entry).type) === 'ScalingLimited' && text(record(entry).status) === 'True');
    if (limited && item.maxReplicas && item.desiredReplicas >= item.maxReplicas) findings.push(finding('hpa', 'warning', 'max-replicas', 'HPA reached maxReplicas',
      `${item.name} is capped at ${item.maxReplicas} replicas.`, item, [text(record(limited).reason)], 'Verify demand, application capacity, and the configured maximum.'));
  }
  for (const item of vpas) {
    const failed = list(item.conditions).find((entry) => text(record(entry).status) === 'False');
    if (failed) findings.push(finding('vpa', 'warning', text(record(failed).type), 'VPA recommendation is unavailable', text(record(failed).message) || `${item.name} reports an unhealthy condition.`, item, [text(record(failed).reason)], 'Inspect the VPA recommender and target workload.'));
    if (text(record(item.details).updateMode).toLowerCase() === 'off') continue;
    const controlled = new Set(list(record(item.details.resourcePolicy).containerPolicies).flatMap((policy) => list(record(policy).controlledResources).map(text)));
    const targetHpa = hpas.find((hpa) => hpa.namespace === item.namespace && hpa.target === item.target);
    const hpaResources = new Set(list(targetHpa?.metrics).filter((metric) => text(record(metric).type) === 'Resource' || text(record(metric).type) === 'ContainerResource').map((metric) => text(record(metric).name)));
    const overlap = [...hpaResources].filter((resource) => controlled.size === 0 ? ['cpu', 'memory'].includes(resource) : controlled.has(resource));
    if (overlap.length) findings.push(finding('vpa', 'warning', 'hpa-metric-conflict', 'HPA and VPA manage the same resource metric',
      `${item.name} and ${targetHpa.name} both depend on ${overlap.join(', ')}.`, item, overlap, 'Use separate metrics for horizontal and vertical scaling.'));
  }
  const allKeda = [...scaledObjects, ...scaledJobs];
  for (const item of allKeda) {
    const failed = list(item.conditions).find((entry) => text(record(entry).type) === 'Ready' && text(record(entry).status) === 'False');
    if (failed) findings.push(finding('keda', 'warning', 'not-ready', 'KEDA resource is not ready', text(record(failed).message) || `${item.name} reports Ready=False.`, item, [text(record(failed).reason)], 'Inspect the scaler configuration, authentication reference, and operator health.'));
    const fallback = list(item.conditions).find((entry) => text(record(entry).type) === 'Fallback' && text(record(entry).status) === 'True');
    if (fallback) findings.push(finding('keda', 'warning', 'fallback', 'KEDA fallback is active', text(record(fallback).message) || `${item.name} is using fallback replicas.`, item, [text(record(fallback).reason)], 'Restore the trigger metric source before fallback capacity becomes stale.'));
    if (record(item.details).paused) findings.push(finding('keda', 'info', 'paused', 'Autoscaling is paused', `${item.name} is explicitly paused.`, item, [], 'Remove the KEDA pause annotation when maintenance is complete.'));
    if (record(item.details).scaleToZero) findings.push(finding('keda', 'info', 'scale-to-zero', 'Scale-to-zero is enabled', `${item.name} can scale its target to zero.`, item, [], 'Confirm cold-start latency is acceptable for this workload.'));
    if (item.kind === 'ScaledObject' && sourceComplete.hpa && !hpas.some((hpa) => hpa.managedBy === 'KEDA' && hpa.namespace === item.namespace && (hpa.target === item.target || hpa.name === `keda-hpa-${item.name}`))) {
      findings.push(finding('keda', 'warning', 'missing-hpa', 'KEDA-generated HPA is missing', `${item.name} has no matching managed HPA.`, item, [], 'Inspect the KEDA operator and ScaledObject events.'));
    }
    for (const trigger of list(record(item.details).triggers)) {
      const name = text(record(trigger).authenticationRef);
      const kind = text(record(trigger).authenticationKind) || 'TriggerAuthentication';
      if (!name) continue;
      const sourceId = kind === 'ClusterTriggerAuthentication' ? 'keda-clustertriggerauth' : 'keda-triggerauth';
      const key = kind === 'ClusterTriggerAuthentication' ? `cluster/${name}` : `${item.namespace}/${name}`;
      if (sourceComplete[sourceId] && !triggerAuthKeys.has(key)) findings.push(finding('keda', 'warning', `missing-auth-${name}`, 'KEDA authentication reference is missing',
        `${item.name} references ${kind} ${name}, but it is not present in the readable inventory.`, item, [`${kind}/${name}`], 'Restore the referenced authentication object or update the trigger reference.'));
    }
  }
  for (const item of pdbs) {
    if (number(record(item.details).currentHealthy) < number(record(item.details).desiredHealthy)) findings.push(finding('pdb', 'warning', 'insufficient-healthy', 'PDB has insufficient healthy Pods',
      `${item.name} has ${record(item.details).currentHealthy}/${record(item.details).desiredHealthy} healthy Pods.`, item, [], 'Restore workload readiness before voluntary disruptions.'));
  }
  for (const item of pods) {
    const state = unschedulablePod(item);
    if (!state) continue;
    const resource = { kind: 'Pod', name: text(metadata(item).name), namespace: text(metadata(item).namespace) };
    findings.push(finding('capacity', 'warning', 'unschedulable', 'Pod is currently unschedulable', text(record(state).message) || `${resource.name} cannot be scheduled.`, resource,
      [text(record(state).reason)], 'Inspect requests, affinity, taints, quotas, and node-pool limits.'));
  }
  for (const item of quotas) {
    const hard = record(record(item.details).hard); const used = record(record(item.details).used);
    const exhausted = Object.keys(hard).filter((key) => {
      const hardValue = quotaValue(key, hard[key]);
      const usedValue = quotaValue(key, used[key]);
      return hardValue !== undefined && usedValue !== undefined && usedValue >= hardValue;
    });
    if (exhausted.length) findings.push(finding('capacity', 'warning', 'quota-exhausted', 'ResourceQuota is exhausted', `${item.name} reached ${exhausted.join(', ')}.`, item, exhausted, 'Increase the quota or reduce the requested namespace capacity.'));
  }
  for (const item of nodePools) {
    const failed = list(item.conditions).find((entry) => text(record(entry).type) === 'Ready' && text(record(entry).status) === 'False');
    if (failed) findings.push(finding('node-scaling', 'warning', 'pool-not-ready', 'Node pool is not ready', text(record(failed).message) || `${item.name} reports Ready=False.`, item, [text(record(failed).reason)], 'Inspect the node class, provider permissions, and pool constraints.', true));
  }
  for (const item of nodeClaims) {
    const failed = list(item.conditions).find((entry) => ['Launched', 'Registered', 'Initialized', 'Ready'].includes(text(record(entry).type)) && text(record(entry).status) === 'False');
    if (failed) findings.push(finding('node-scaling', 'warning', 'claim-not-ready', 'Node claim is not ready', text(record(failed).message) || `${item.name} reports ${text(record(failed).type)}=False.`, item, [text(record(failed).reason)], 'Inspect provider capacity, NodeClass configuration, and node registration.', true));
  }
  const unschedulable = pods.some(unschedulablePod);
  if (unschedulable && nodeProviders.length === 0) findings.push(finding('node-scaling', 'warning', 'provider-missing', 'No node autoscaler was detected',
    'Unschedulable Pods are present and no supported node autoscaler is visible.', { kind: 'Cluster', name: 'node-scaling' }, [], 'Install or configure a node autoscaler, or add capacity manually.', true));
  return [...new Map(findings.map((item) => [item.id, item])).values()];
}

function normalizeNodePool(item) {
  const itemSpec = spec(item); const itemStatus = status(item);
  return { id: objectId('NodePool', item), kind: 'NodePool', name: text(metadata(item).name), state: condition(item, 'Ready')?.status === 'False' ? 'Unavailable' : 'Ready',
    provider: 'Karpenter', conditions: conditionRows(item), currentReplicas: number(itemStatus.nodes), details: { nodeClassRef: record(record(itemSpec.template).spec).nodeClassRef,
      limits: record(itemSpec.limits), resources: record(itemStatus.resources), weight: itemSpec.weight, replicas: itemSpec.replicas,
      disruption: record(itemSpec.disruption), requirements: list(record(record(itemSpec.template).spec).requirements) } };
}

function normalizeNodeClaim(item) {
  const itemSpec = spec(item);
  return { id: objectId('NodeClaim', item), kind: 'NodeClaim', name: text(metadata(item).name), state: condition(item, 'Ready')?.status === 'False' ? 'Unavailable' : 'Ready',
    provider: 'Karpenter', conditions: conditionRows(item), details: { nodeClassRef: record(itemSpec.nodeClassRef), requirements: list(itemSpec.requirements),
      resources: record(itemSpec.resources), nodeName: text(status(item).nodeName), providerId: text(status(item).providerID) ? 'redacted' : undefined } };
}

function normalizeClusterAutoscaler(deployments, configMaps) {
  const controllers = deployments.filter((item) => /cluster-autoscaler/i.test(`${text(metadata(item).name)} ${JSON.stringify(spec(item).template || {})}`));
  return controllers.map((item) => {
    const itemStatus = status(item); const podSpec = record(record(record(spec(item).template).spec));
    const args = list(record(list(podSpec.containers)[0]).args).map(text).filter((arg) => /^--(?:cloud-provider|node-group-auto-discovery|balance-similar-node-groups|expander)=?/.test(arg));
    const statusMap = configMaps.find((value) => text(metadata(value).name) === 'cluster-autoscaler-status');
    return { id: objectId('ClusterAutoscaler', item), kind: 'ClusterAutoscaler', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
      state: number(itemStatus.availableReplicas) > 0 ? 'Ready' : 'Unavailable', provider: 'Cluster Autoscaler',
      currentReplicas: number(itemStatus.readyReplicas), desiredReplicas: number(spec(item).replicas), details: { safeFlags: args, statusAvailable: Boolean(statusMap) } };
  });
}

async function collect(request, namespace, cloudProvider) {
  const sources = [];
  const core = [
    ['pods', 'v1', 'pods', true], ['nodes', 'v1', 'nodes', false], ['deployments', 'apps/v1', 'deployments', true],
    ['replicasets', 'apps/v1', 'replicasets', true], ['hpa', 'autoscaling/v2', 'horizontalpodautoscalers', true],
    ['pdb', 'policy/v1', 'poddisruptionbudgets', true], ['quotas', 'v1', 'resourcequotas', true], ['limitranges', 'v1', 'limitranges', true],
    ['pod-metrics', 'metrics.k8s.io/v1beta1', 'pods', true], ['node-metrics', 'metrics.k8s.io/v1beta1', 'nodes', false],
    ['configmaps', 'v1', 'configmaps', false]
  ].map(([id, version, resource, namespaced]) => ({ id, version, resource, namespaced }));
  const optional = [
    ['vpa', 'autoscaling.k8s.io/v1', 'verticalpodautoscalers', true],
    ['vpa-v1beta2', 'autoscaling.k8s.io/v1beta2', 'verticalpodautoscalers', true],
    ['keda-scaledobjects', 'keda.sh/v1alpha1', 'scaledobjects', true], ['keda-scaledjobs', 'keda.sh/v1alpha1', 'scaledjobs', true],
    ['keda-triggerauth', 'keda.sh/v1alpha1', 'triggerauthentications', true], ['keda-clustertriggerauth', 'keda.sh/v1alpha1', 'clustertriggerauthentications', false],
    ['karpenter-nodepools', 'karpenter.sh/v1', 'nodepools', false], ['karpenter-nodeclaims', 'karpenter.sh/v1', 'nodeclaims', false],
    ['karpenter-nodepools-v1beta1', 'karpenter.sh/v1beta1', 'nodepools', false], ['karpenter-nodeclaims-v1beta1', 'karpenter.sh/v1beta1', 'nodeclaims', false]
  ].map(([id, version, resource, namespaced]) => ({ id, version, resource, namespaced }));
  const descriptors = [...core, ...optional];
  const results = new Array(descriptors.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < descriptors.length) {
      const index = cursor++;
      results[index] = await collectList(request, descriptors[index], namespace, sources);
    }
  }));
  const byId = Object.fromEntries(descriptors.map((entry, index) => [entry.id, results[index]]));
  const scaledObjects = byId['keda-scaledobjects'].map((item) => normalizeKeda(item, 'ScaledObject'));
  const kedaOwners = new Set(scaledObjects.map((item) => `${item.namespace}/keda-hpa-${item.name}`));
  const hpas = byId.hpa.map((item) => normalizeHpa(item, kedaOwners));
  const vpaItems = byId.vpa.length ? byId.vpa : byId['vpa-v1beta2'];
  const vpas = vpaItems.map(normalizeVpa);
  const scaledJobs = byId['keda-scaledjobs'].map((item) => normalizeKeda(item, 'ScaledJob'));
  const triggerAuthKeys = new Set([
    ...byId['keda-triggerauth'].map((item) => `${text(metadata(item).namespace)}/${text(metadata(item).name)}`),
    ...byId['keda-clustertriggerauth'].map((item) => `cluster/${text(metadata(item).name)}`)
  ]);
  const pdbs = byId.pdb.map(normalizePdb);
  const quotas = byId.quotas.map(normalizeQuota);
  const limitRanges = byId.limitranges.map(normalizeLimitRange);
  const karpenterPools = (byId['karpenter-nodepools'].length ? byId['karpenter-nodepools'] : byId['karpenter-nodepools-v1beta1']).map(normalizeNodePool);
  const karpenterClaims = (byId['karpenter-nodeclaims'].length ? byId['karpenter-nodeclaims'] : byId['karpenter-nodeclaims-v1beta1']).map(normalizeNodeClaim);
  const clusterAutoscalers = normalizeClusterAutoscaler(byId.deployments, byId.configmaps);
  const nodeProviders = [
    ...(karpenterPools.length || karpenterClaims.length ? [{ id: 'provider:karpenter', kind: 'NodeAutoscaler', name: 'Karpenter', state: karpenterPools.some((item) => item.state === 'Unavailable') ? 'Degraded' : 'Ready', provider: 'Karpenter', details: {} }] : []),
    ...clusterAutoscalers
  ];
  let cloud = { sources: [], providers: [], pools: [], claims: [], findings: [] };
  if (typeof cloudProvider === 'function') {
    try { cloud = { ...cloud, ...await cloudProvider() }; }
    catch { cloud.sources = [{ id: 'cloud-autoscaling', status: 'error', count: 0, partial: true, message: 'Configured cloud adapters could not be read.' }]; }
  } else sources.push({ id: 'cloud-autoscaling', status: 'not-configured', count: 0, message: 'Cloud provider details require an enabled local agent adapter.' });
  sources.push(...list(cloud.sources));
  const capacity = capacityFromInventory(byId.pods, byId.replicasets, byId['pod-metrics'], byId.nodes, byId['node-metrics'], namespace || 'all');
  capacity.quotas = quotas; capacity.limitRanges = limitRanges;
  const unschedulablePods = byId.pods.filter(unschedulablePod).map((item) => ({ id: objectId('Pod', item), kind: 'Pod', name: text(metadata(item).name), namespace: text(metadata(item).namespace),
    state: 'Unschedulable', details: { message: text(record(unschedulablePod(item)).message).slice(0, 1_024) } }));
  const sourceComplete = Object.fromEntries(sources.map((entry) => [entry.id, entry.status === 'available' && !entry.partial]));
  const providers = [...nodeProviders, ...list(cloud.providers)];
  const pools = [...karpenterPools, ...list(cloud.pools)];
  const claims = [...karpenterClaims, ...list(cloud.claims)];
  const findings = [...analyze({ hpas, vpas, scaledObjects, scaledJobs, triggerAuthKeys, pdbs, pods: byId.pods, quotas, nodeProviders: providers, nodePools: pools, nodeClaims: claims, sourceComplete }), ...list(cloud.findings)];
  return { sources, hpas, vpas, scaledObjects, scaledJobs, pdbs, capacity, providers, pools, claims, unschedulablePods, findings };
}

function tab(available, reason) { return { available, ...(!available ? { reason } : {}) }; }

export async function collectAutoscalingCapacity({ request, namespace = null, view = 'full', forceRefresh = false, cloudProvider } = {}) {
  if (typeof request !== 'function') throw new TypeError('A customer-side request function is required.');
  const scope = namespace && namespace !== 'all' ? namespace : null;
  if (scope && (scope.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(scope))) throw new TypeError('Invalid Kubernetes namespace.');
  const allowedViews = new Set(['summary', 'hpa', 'vpa', 'keda', 'pdb', 'capacity', 'node-scaling', 'full']);
  if (!allowedViews.has(view)) throw new TypeError('Invalid autoscaling view.');
  let cache = cacheByTransport.get(request);
  if (!cache) { cache = new Map(); cacheByTransport.set(request, cache); }
  const key = scope || 'all';
  let entry = cache.get(key);
  if (entry?.inflight) await entry.inflight;
  if (forceRefresh || !entry?.value || entry.expiresAt <= Date.now()) {
    if (!entry && cache.size >= MAX_CACHE_SCOPES) cache.delete(cache.keys().next().value);
    entry = { value: null, expiresAt: 0, inflight: null };
    cache.set(key, entry);
    entry.inflight = collect(request, scope, cloudProvider).then((value) => { entry.value = value; entry.expiresAt = Date.now() + CACHE_TTL_MS; });
    try { await entry.inflight; } finally { entry.inflight = null; }
  }
  const data = entry.value;
  const partial = data.sources.some((source) => source.status === 'denied' || source.status === 'error' || source.partial);
  const reason = (name, ids) => data.sources.some((source) => ids.some((id) => source.id === id || source.id.startsWith(`${id}:`)) && ['denied', 'error'].includes(source.status))
    ? `${name} data is unavailable or permission was denied.`
    : `No ${name} objects were found in the current scope.`;
  const include = (name) => view === 'full' || view === name;
  const clipped = (items) => items.slice(0, MAX_OUTPUT_ITEMS);
  const summary = { hpa: data.hpas.length, vpa: data.vpas.length, scaledObjects: data.scaledObjects.length, scaledJobs: data.scaledJobs.length,
    pdb: data.pdbs.length, findings: data.findings.length, critical: data.findings.filter((item) => item.severity === 'critical').length,
    warning: data.findings.filter((item) => item.severity === 'warning').length, unschedulablePods: data.unschedulablePods.length,
    nodeScalingProviders: data.providers.length };
  return {
    schemaVersion: 1, fetchedAt: new Date().toISOString(), namespace: scope || 'all', view, partial,
    availability: partial ? 'degraded' : 'available', issues: partial ? [{ code: 'partial_resource_failure', message: 'Some autoscaling sources are unavailable.', retryable: true, resource: 'autoscaling' }] : [],
    sources: data.sources, summary, findings: clipped(data.findings),
    tabs: { overview: tab(true), hpa: tab(data.hpas.length > 0, reason('HPA', ['hpa'])), vpa: tab(data.vpas.length > 0, reason('VPA', ['vpa', 'vpa-v1beta2'])),
      keda: tab(data.scaledObjects.length + data.scaledJobs.length > 0, reason('KEDA', ['keda-scaledobjects', 'keda-scaledjobs'])), pdb: tab(data.pdbs.length > 0, reason('PDB', ['pdb'])),
      capacity: tab(data.capacity.clusterWide.nodes > 0, reason('capacity', ['nodes', 'pods'])), 'node-scaling': tab(data.providers.length > 0, reason('node autoscaling', ['karpenter-nodepools', 'karpenter-nodeclaims', 'cloud-aws', 'cloud-gcp', 'cloud-azure'])) },
    hpas: include('hpa') ? clipped(data.hpas) : [], vpas: include('vpa') ? clipped(data.vpas) : [],
    scaledObjects: include('keda') ? clipped(data.scaledObjects) : [], scaledJobs: include('keda') ? clipped(data.scaledJobs) : [],
    pdbs: include('pdb') ? clipped(data.pdbs) : [],
    capacity: include('capacity') || view === 'summary' ? data.capacity : { clusterWide: { nodes: 0, schedulableNodes: 0, allocatable: {}, requests: {} }, scoped: { namespace: scope || 'all', requests: {}, limits: {} }, workloads: [], quotas: [], limitRanges: [] },
    nodeScaling: { providers: include('node-scaling') || view === 'summary' ? clipped(data.providers) : [], pools: include('node-scaling') ? clipped(data.pools) : [],
      claims: include('node-scaling') ? clipped(data.claims) : [], unschedulablePods: include('node-scaling') || view === 'summary' ? clipped(data.unschedulablePods) : [] }
  };
}
