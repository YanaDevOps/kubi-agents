import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fetchKubeList, loadLocalKubeConfig, namespacePath, asRecord, asRecordArray, metadataFor } from './kube.js';

const DEFAULT_RULES = [
  { id: 'pods-failing', enabled: true, kind: 'pod', condition: 'failing', namespace: 'all', resourceName: '*', severity: 'critical', channelIds: [], cooldownSeconds: 600 },
  { id: 'nodes-not-ready', enabled: true, kind: 'node', condition: 'not_ready', namespace: 'all', resourceName: '*', severity: 'critical', channelIds: [], cooldownSeconds: 600 },
  { id: 'services-no-endpoints', enabled: true, kind: 'service', condition: 'no_ready_endpoints', namespace: 'all', resourceName: '*', severity: 'warning', channelIds: [], cooldownSeconds: 600 },
  { id: 'jobs-failed', enabled: true, kind: 'job', condition: 'failed', namespace: 'all', resourceName: '*', severity: 'critical', channelIds: [], cooldownSeconds: 600 },
  { id: 'cronjobs-failing', enabled: true, kind: 'cronjob', condition: 'last_job_failed', namespace: 'all', resourceName: '*', severity: 'warning', channelIds: [], cooldownSeconds: 600 }
];

const CONDITIONS_BY_KIND = {
  pod: ['failing', 'failed', 'not_ready', 'restarting', 'image_pull_error'],
  node: ['not_ready', 'pressure'],
  service: ['no_ready_endpoints'],
  ingress: ['missing_backend_service', 'no_load_balancer_address', 'missing_tls_secret'],
  job: ['failed'],
  cronjob: ['last_job_failed']
};

const PROVIDERS = new Set(['telegram', 'email', 'webhook', 'whatsapp']);
const SEVERITIES = new Set(['warning', 'critical']);
const MAX_HISTORY_ITEMS = 200;
const managers = new Map();

function defaultConfigDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'kubi-agent');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kubi-agent');
}

function alertingConfigPath(runtimeConfig) {
  return process.env.KUBI_AGENT_ALERTING_CONFIG || runtimeConfig.alertingConfigPath || path.join(defaultConfigDir(), 'alerting.json');
}

function alertingHistoryPath(runtimeConfig) {
  return process.env.KUBI_AGENT_ALERTING_HISTORY || runtimeConfig.alertingHistoryPath || path.join(defaultConfigDir(), 'alerting-history.json');
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function providerOr(value) {
  return PROVIDERS.has(value) ? value : 'webhook';
}

function severityOr(value) {
  return SEVERITIES.has(value) ? value : 'warning';
}

function boolOr(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback;
}

function parseSecretRef(ref) {
  const normalized = stringOr(ref, '');
  if (!normalized) throw new Error('secretRef is required');
  if (normalized.startsWith('env:')) {
    const name = normalized.slice('env:'.length).trim();
    if (!name || /[\s=]/.test(name)) throw new Error('invalid env secretRef');
    return { kind: 'env', name };
  }
  if (normalized.startsWith('file:')) {
    const [rawPath, rawKey = ''] = normalized.slice('file:'.length).split('#');
    const filePath = rawPath.trim();
    const key = rawKey.trim();
    if (!filePath || !path.isAbsolute(filePath)) throw new Error('file secretRef path must be absolute');
    if (key && /[\s=]/.test(key)) throw new Error('invalid file secret key');
    return { kind: 'file', name: filePath, key };
  }
  throw new Error('secretRef must start with env: or file:');
}

function defaultSecretKey(provider) {
  if (provider === 'telegram') return 'KUBI_ALERT_TELEGRAM_TOKEN';
  if (provider === 'email') return 'KUBI_ALERT_SMTP_PASSWORD';
  if (provider === 'webhook') return 'KUBI_ALERT_WEBHOOK_TOKEN';
  if (provider === 'whatsapp') return 'KUBI_ALERT_WHATSAPP_TOKEN';
  return '';
}

function defaultSecretRef(provider) {
  const key = defaultSecretKey(provider);
  return key ? `env:${key}` : '';
}

function readEnvFileValue(filePath, key) {
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (name === key) return value;
  }
  return '';
}

function resolveSecret(ref, provider = '') {
  const parsed = parseSecretRef(ref);
  if (parsed.kind === 'env') {
    const value = process.env[parsed.name] || '';
    if (!value) throw new Error('secret is not configured');
    return value;
  }
  const key = parsed.key || defaultSecretKey(provider);
  if (!key) throw new Error('unsupported file secret provider');
  const value = readEnvFileValue(parsed.name, key);
  if (!value) throw new Error('secret is not configured');
  return value;
}

function secretConfigured(secretRef, provider = '') {
  try {
    return Boolean(resolveSecret(secretRef, provider));
  } catch {
    return false;
  }
}

function normalizeChannel(channel) {
  const record = asRecord(channel) || {};
  const provider = providerOr(record.provider);
  const secretRef = stringOr(record.secretRef, defaultSecretRef(provider));
  return {
    id: stringOr(record.id, `${provider}-${Math.random().toString(36).slice(2, 8)}`),
    provider,
    displayName: stringOr(record.displayName, `${provider} alerts`),
    enabled: boolOr(record.enabled, true),
    secretRef,
    secretConfigured: secretConfigured(secretRef, provider),
    ...(typeof record.chatId === 'string' ? { chatId: record.chatId } : {}),
    ...(typeof record.smtpHost === 'string' ? { smtpHost: record.smtpHost } : {}),
    ...(typeof record.smtpPort === 'number' ? { smtpPort: record.smtpPort } : {}),
    ...(typeof record.smtpUser === 'string' ? { smtpUser: record.smtpUser } : {}),
    ...(typeof record.from === 'string' ? { from: record.from } : {}),
    ...(typeof record.to === 'string' ? { to: record.to } : {}),
    ...(typeof record.webhookUrl === 'string' ? { webhookUrl: record.webhookUrl } : {}),
    ...(typeof record.phoneNumberId === 'string' ? { phoneNumberId: record.phoneNumberId } : {}),
    ...(typeof record.recipient === 'string' ? { recipient: record.recipient } : {}),
    ...(record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers) ? { headers: record.headers } : {})
  };
}

function normalizeRule(rule) {
  const record = asRecord(rule) || {};
  const kind = stringOr(record.kind, 'pod').toLowerCase();
  return {
    id: stringOr(record.id, `${kind}-${stringOr(record.condition, 'failing')}`),
    enabled: boolOr(record.enabled, true),
    kind,
    condition: stringOr(record.condition, 'failing').toLowerCase(),
    namespace: stringOr(record.namespace, 'all'),
    resourceName: stringOr(record.resourceName, '*'),
    severity: severityOr(record.severity),
    channelIds: asArray(record.channelIds).filter((entry) => typeof entry === 'string'),
    cooldownSeconds: typeof record.cooldownSeconds === 'number' && Number.isFinite(record.cooldownSeconds) ? Math.max(0, Math.floor(record.cooldownSeconds)) : 600
  };
}

function normalizeConfig(raw) {
  const record = asRecord(raw) || {};
  return {
    enabled: record.enabled === true,
    channels: asArray(record.channels).map(normalizeChannel),
    rules: (asArray(record.rules).length > 0 ? asArray(record.rules) : DEFAULT_RULES).map(normalizeRule),
    pollIntervalSeconds: typeof record.pollIntervalSeconds === 'number' && Number.isFinite(record.pollIntervalSeconds) ? Math.max(5, Math.floor(record.pollIntervalSeconds)) : 30
  };
}

function validateConfig(config) {
  const seenChannels = new Set();
  for (const channel of config.channels) {
    if (!channel.id) throw new Error('channel id is required');
    if (seenChannels.has(channel.id)) throw new Error(`duplicate channel id ${channel.id}`);
    seenChannels.add(channel.id);
    if (!PROVIDERS.has(channel.provider)) throw new Error(`unsupported provider ${channel.provider}`);
    parseSecretRef(channel.secretRef);
  }
  const seenRules = new Set();
  for (const rule of config.rules) {
    if (!rule.id) throw new Error('rule id is required');
    if (seenRules.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
    seenRules.add(rule.id);
    if (!rule.kind || !rule.condition) throw new Error(`rule ${rule.id} requires kind and condition`);
    if (!CONDITIONS_BY_KIND[rule.kind]) throw new Error(`unsupported alerting rule kind ${rule.kind}`);
  }
}

function publicConfig(config, manager) {
  return {
    available: true,
    enabled: config.enabled,
    channels: config.channels.map(publicChannel),
    rules: config.rules,
    status: manager.status(config)
  };
}

function publicChannel(channel) {
  const { headers, ...safeChannel } = channel;
  const safeHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([key]) => !/^(authorization|proxy-authorization|x-api-key)$/i.test(key))
  );
  return {
    ...safeChannel,
    ...(Object.keys(safeHeaders).length ? { headers: safeHeaders } : {}),
    secretConfigured: secretConfigured(channel.secretRef, channel.provider)
  };
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message) return 'operation failed';
  if (/token=|password=|authorization|bearer\s+|secret|smtp password|webhook/i.test(message)) {
    return 'operation failed';
  }
  return message.slice(0, 300);
}

function displayNamespace(value) {
  return !value || value === 'all' ? 'all' : value;
}

function effectiveNamespace(value) {
  return !value || value === 'all' ? null : value;
}

function matchesResourceName(rule, name) {
  return !rule.resourceName || rule.resourceName === '*' || rule.resourceName === name;
}

function newAlert(rule, kind, namespace, name, reason, message) {
  const fingerprint = [rule.id, kind, namespace || '', name, reason].join('/');
  return {
    id: fingerprint,
    ruleId: rule.id,
    severity: rule.severity,
    kind,
    ...(namespace ? { namespace } : {}),
    name,
    reason,
    message,
    observedAt: new Date().toISOString(),
    fingerprint
  };
}

function statusConditions(record) {
  return asRecordArray(asRecord(record.status)?.conditions);
}

function podFailure(rule, pod) {
  const status = asRecord(pod.status) || {};
  const condition = rule.condition;
  if (status.phase === 'Failed' && (condition === 'failing' || condition === 'failed')) {
    return ['PodFailed', stringOr(status.message, stringOr(status.reason, 'Pod is failed'))];
  }
  const containerStatuses = [...asRecordArray(status.initContainerStatuses), ...asRecordArray(status.containerStatuses)];
  for (const item of containerStatuses) {
    const waiting = asRecord(asRecord(item.state)?.waiting);
    if (!waiting) continue;
    const reason = stringOr(waiting.reason, '');
    if (reason === 'CrashLoopBackOff' && (condition === 'failing' || condition === 'restarting')) {
      return [reason, stringOr(waiting.message, `Container ${item.name || 'unknown'} is waiting with ${reason}`)];
    }
    if ((reason === 'ImagePullBackOff' || reason === 'ErrImagePull') && (condition === 'failing' || condition === 'image_pull_error')) {
      return [reason, stringOr(waiting.message, `Container ${item.name || 'unknown'} is waiting with ${reason}`)];
    }
    if ((reason === 'CreateContainerConfigError' || reason === 'RunContainerError') && condition === 'failing') {
      return [reason, stringOr(waiting.message, `Container ${item.name || 'unknown'} is waiting with ${reason}`)];
    }
  }
  if (status.phase === 'Running' || status.phase === 'Pending') {
    for (const item of statusConditions(pod)) {
      if (item.type === 'Ready' && item.status !== 'True' && (condition === 'failing' || condition === 'not_ready')) {
        return ['PodNotReady', stringOr(item.message, stringOr(item.reason, 'Pod is running but not ready'))];
      }
    }
  }
  return null;
}

function evaluatePods(rule, pods) {
  return asRecordArray(pods).flatMap((pod) => {
    const meta = metadataFor(pod);
    if (!matchesResourceName(rule, meta.name)) return [];
    const failure = podFailure(rule, pod);
    return failure ? [newAlert(rule, 'pod', meta.namespace, meta.name, failure[0], failure[1])] : [];
  });
}

function evaluateNodes(rule, nodes) {
  const condition = rule.condition;
  const alerts = [];
  for (const node of asRecordArray(nodes)) {
    const meta = metadataFor(node);
    if (!matchesResourceName(rule, meta.name)) continue;
    for (const item of statusConditions(node)) {
      if (item.type === 'Ready' && item.status !== 'True' && condition === 'not_ready') {
        alerts.push(newAlert(rule, 'node', '', meta.name, 'NodeNotReady', stringOr(item.message, stringOr(item.reason, 'Node is not ready'))));
      }
      if (item.type !== 'Ready' && item.status === 'True' && condition === 'pressure') {
        alerts.push(newAlert(rule, 'node', '', meta.name, String(item.type), stringOr(item.message, stringOr(item.reason, 'Node pressure condition is active'))));
      }
    }
  }
  return alerts;
}

function evaluateServices(rule, services, endpointSlices) {
  if (rule.condition !== 'no_ready_endpoints') return [];
  const readyByService = new Map();
  for (const slice of asRecordArray(endpointSlices)) {
    const meta = metadataFor(slice);
    const serviceName = asRecord(slice.metadata)?.labels?.['kubernetes.io/service-name'];
    if (!serviceName) continue;
    const key = `${meta.namespace}/${serviceName}`;
    for (const endpoint of asRecordArray(slice.endpoints)) {
      const ready = asRecord(endpoint.conditions)?.ready;
      if (ready === false) continue;
      readyByService.set(key, (readyByService.get(key) || 0) + 1);
    }
  }
  return asRecordArray(services).flatMap((service) => {
    const meta = metadataFor(service);
    const spec = asRecord(service.spec) || {};
    if (!matchesResourceName(rule, meta.name) || spec.type === 'ExternalName' || Object.keys(asRecord(spec.selector) || {}).length === 0) return [];
    return (readyByService.get(`${meta.namespace}/${meta.name}`) || 0) === 0
      ? [newAlert(rule, 'service', meta.namespace, meta.name, 'NoReadyEndpoints', 'Service has selectors but no ready endpoints.')]
      : [];
  });
}

function ingressServiceNames(ingress) {
  const names = new Set();
  const add = (name) => {
    if (typeof name === 'string' && name.trim()) names.add(name.trim());
  };
  const spec = asRecord(ingress.spec) || {};
  add(asRecord(asRecord(spec.defaultBackend)?.service)?.name);
  for (const rule of asRecordArray(spec.rules)) {
    for (const entry of asRecordArray(asRecord(rule.http)?.paths)) {
      add(asRecord(asRecord(entry.backend)?.service)?.name);
    }
  }
  return [...names];
}

function evaluateIngresses(rule, ingresses, services, secrets) {
  const serviceSet = new Set(asRecordArray(services).map((service) => {
    const meta = metadataFor(service);
    return `${meta.namespace}/${meta.name}`;
  }));
  const secretSet = new Set(asRecordArray(secrets).map((secret) => {
    const meta = metadataFor(secret);
    return `${meta.namespace}/${meta.name}`;
  }));
  const alerts = [];
  for (const ingress of asRecordArray(ingresses)) {
    const meta = metadataFor(ingress);
    if (!matchesResourceName(rule, meta.name)) continue;
    if (rule.condition === 'missing_backend_service') {
      for (const serviceName of ingressServiceNames(ingress)) {
        if (!serviceSet.has(`${meta.namespace}/${serviceName}`)) {
          alerts.push(newAlert(rule, 'ingress', meta.namespace, meta.name, 'MissingBackendService', `Ingress references missing Service ${serviceName}.`));
        }
      }
    }
    if (rule.condition === 'no_load_balancer_address') {
      if (asRecordArray(asRecord(asRecord(ingress.status)?.loadBalancer)?.ingress).length === 0) {
        alerts.push(newAlert(rule, 'ingress', meta.namespace, meta.name, 'NoLoadBalancerAddress', 'Ingress has no load balancer address.'));
      }
    }
    if (rule.condition === 'missing_tls_secret') {
      for (const tlsEntry of asRecordArray(asRecord(ingress.spec)?.tls)) {
        const secretName = stringOr(tlsEntry.secretName, '');
        if (!secretName) {
          alerts.push(newAlert(rule, 'ingress', meta.namespace, meta.name, 'MissingTLSSecret', 'Ingress TLS entry has no secretName.'));
        } else if (!secretSet.has(`${meta.namespace}/${secretName}`)) {
          alerts.push(newAlert(rule, 'ingress', meta.namespace, meta.name, 'MissingTLSSecret', `Ingress TLS secret ${secretName} does not exist.`));
        }
      }
    }
  }
  return alerts;
}

function evaluateJobs(rule, jobs) {
  if (rule.condition !== 'failed') return [];
  return asRecordArray(jobs).flatMap((job) => {
    const meta = metadataFor(job);
    if (!matchesResourceName(rule, meta.name)) return [];
    const failed = statusConditions(job).find((condition) => condition.type === 'Failed' && condition.status === 'True');
    return failed ? [newAlert(rule, 'job', meta.namespace, meta.name, 'JobFailed', stringOr(failed.message, stringOr(failed.reason, 'Job failed')))] : [];
  });
}

function evaluateCronJobs(rule, cronJobs, jobs) {
  if (rule.condition !== 'last_job_failed') return [];
  const latestByCron = new Map();
  for (const job of asRecordArray(jobs)) {
    const meta = metadataFor(job);
    const owner = meta.ownerReferences.find((ref) => ref.kind === 'CronJob' && ref.name);
    if (!owner) continue;
    const key = `${meta.namespace}/${owner.name}`;
    const current = latestByCron.get(key);
    if (!current || stringOr(asRecord(job.metadata)?.creationTimestamp, '') > stringOr(asRecord(current.metadata)?.creationTimestamp, '')) {
      latestByCron.set(key, job);
    }
  }
  const alerts = [];
  for (const cronJob of asRecordArray(cronJobs)) {
    const meta = metadataFor(cronJob);
    if (!matchesResourceName(rule, meta.name) || asRecord(cronJob.spec)?.suspend === true) continue;
    const job = latestByCron.get(`${meta.namespace}/${meta.name}`);
    const jobMeta = job ? metadataFor(job) : null;
    const failed = job ? statusConditions(job).find((condition) => condition.type === 'Failed' && condition.status === 'True') : null;
    if (failed && jobMeta) {
      alerts.push(newAlert(rule, 'cronjob', meta.namespace, meta.name, 'LastJobFailed', `Latest CronJob run failed: ${jobMeta.name}`));
    }
  }
  return alerts;
}

async function evaluateRule(runtimeConfig, kubeConfig, rule) {
  const ns = effectiveNamespace(rule.namespace);
  if (rule.kind === 'pod') {
    const pods = await fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', ns));
    return evaluatePods(rule, pods.items);
  }
  if (rule.kind === 'node') {
    const nodes = await fetchKubeList(kubeConfig, '/api/v1/nodes');
    return evaluateNodes(rule, nodes.items);
  }
  if (rule.kind === 'service') {
    const [services, slices] = await Promise.all([
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', ns)),
      fetchKubeList(kubeConfig, namespacePath('/apis/discovery.k8s.io/v1/endpointslices', '/apis/discovery.k8s.io/v1/namespaces/:namespace/endpointslices', ns))
    ]);
    return evaluateServices(rule, services.items, slices.items);
  }
  if (rule.kind === 'ingress') {
    const [ingresses, services, secrets] = await Promise.all([
      fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', ns)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', ns)),
      fetchKubeList(kubeConfig, namespacePath('/api/v1/secrets', '/api/v1/namespaces/:namespace/secrets', ns))
    ]);
    return evaluateIngresses(rule, ingresses.items, services.items, secrets.items);
  }
  if (rule.kind === 'job') {
    const jobs = await fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/jobs', '/apis/batch/v1/namespaces/:namespace/jobs', ns));
    return evaluateJobs(rule, jobs.items);
  }
  if (rule.kind === 'cronjob') {
    const [cronJobs, jobs] = await Promise.all([
      fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/cronjobs', '/apis/batch/v1/namespaces/:namespace/cronjobs', ns)),
      fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/jobs', '/apis/batch/v1/namespaces/:namespace/jobs', ns))
    ]);
    return evaluateCronJobs(rule, cronJobs.items, jobs.items);
  }
  throw new Error(`unsupported alerting rule kind ${rule.kind}`);
}

async function evaluateConfig(runtimeConfig, config) {
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const alerts = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    try {
      alerts.push(...(await evaluateRule(runtimeConfig, kubeConfig, rule)));
    } catch (error) {
      alerts.push({
        id: `rule-error-${rule.id}`,
        ruleId: rule.id,
        severity: 'warning',
        kind: 'alerting',
        name: rule.id,
        reason: 'RuleEvaluationFailed',
        message: sanitizeError(error),
        observedAt: new Date().toISOString(),
        fingerprint: `alerting/${rule.id}/evaluation-error`
      });
    }
  }
  return alerts;
}

function formatAlertText(alert) {
  const target = alert.namespace ? `${alert.namespace}/${alert.name}` : alert.name;
  return `[${String(alert.severity).toUpperCase()}] ${alert.kind} ${target}: ${alert.reason}\n${alert.message}`;
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`delivery failed: status ${response.status}`);
}

async function sendTelegram(channel, alert) {
  const token = resolveSecret(channel.secretRef, channel.provider);
  if (!channel.chatId) throw new Error('telegram chatId is required');
  await postJson(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    chat_id: channel.chatId,
    text: formatAlertText(alert)
  });
}

async function sendWebhook(channel, alert) {
  const secret = resolveSecret(channel.secretRef, channel.provider);
  if (!channel.webhookUrl) throw new Error('webhookUrl is required');
  const headers = { authorization: `Bearer ${secret}` };
  for (const [key, value] of Object.entries(channel.headers || {})) {
    if (!/^authorization$/i.test(key)) headers[key] = String(value);
  }
  await postJson(channel.webhookUrl, { alert }, headers);
}

async function sendWhatsApp(channel, alert) {
  const token = resolveSecret(channel.secretRef, channel.provider);
  if (!channel.phoneNumberId || !channel.recipient) throw new Error('whatsapp phoneNumberId and recipient are required');
  await postJson(`https://graph.facebook.com/v19.0/${encodeURIComponent(channel.phoneNumberId)}/messages`, {
    messaging_product: 'whatsapp',
    to: channel.recipient,
    type: 'text',
    text: { preview_url: false, body: formatAlertText(alert) }
  }, { authorization: `Bearer ${token}` });
}

function smtpCommand(socket, command) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const value = chunk.toString('utf8');
      if (/^[245]\d\d[ -]/.test(value) || /^[245]\d\d$/.test(value.trim())) {
        socket.off('data', onData);
        if (/^[45]/.test(value)) reject(new Error('smtp delivery failed'));
        else resolve(value);
      }
    };
    socket.on('data', onData);
    if (command) socket.write(`${command}\r\n`);
  });
}

async function sendEmail(channel, alert) {
  const password = resolveSecret(channel.secretRef, channel.provider);
  if (!channel.smtpHost || !channel.smtpPort || !channel.from || !channel.to) {
    throw new Error('smtp host, port, from and to are required');
  }
  const port = Number(channel.smtpPort);
  const socket = port === 465
    ? tls.connect({ host: channel.smtpHost, port, servername: channel.smtpHost })
    : net.connect({ host: channel.smtpHost, port });
  await smtpCommand(socket);
  await smtpCommand(socket, `HELO kubi-agent`);
  if (channel.smtpUser) {
    await smtpCommand(socket, 'AUTH LOGIN');
    await smtpCommand(socket, Buffer.from(channel.smtpUser).toString('base64'));
    await smtpCommand(socket, Buffer.from(password).toString('base64'));
  }
  await smtpCommand(socket, `MAIL FROM:<${channel.from}>`);
  await smtpCommand(socket, `RCPT TO:<${channel.to}>`);
  await smtpCommand(socket, 'DATA');
  socket.write(`To: ${channel.to}\r\nFrom: ${channel.from}\r\nSubject: KUBI alert: ${alert.name}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${formatAlertText(alert)}\r\n.\r\n`);
  await smtpCommand(socket);
  socket.end('QUIT\r\n');
}

async function sendAlert(channel, alert) {
  if (!channel.enabled) throw new Error('channel is disabled');
  if (channel.provider === 'telegram') return sendTelegram(channel, alert);
  if (channel.provider === 'webhook') return sendWebhook(channel, alert);
  if (channel.provider === 'email') return sendEmail(channel, alert);
  if (channel.provider === 'whatsapp') return sendWhatsApp(channel, alert);
  throw new Error('unsupported provider');
}

class AlertingManager {
  constructor(runtimeConfig) {
    this.runtimeConfig = runtimeConfig;
    this.configPath = alertingConfigPath(runtimeConfig);
    this.historyPath = alertingHistoryPath(runtimeConfig);
    this.active = new Map();
    this.lastSent = new Map();
    this.lastScanAt = undefined;
    this.lastDeliveryAt = undefined;
    this.lastDeliveryError = undefined;
    this.scanning = false;
    this.timer = null;
    this.history = this.loadHistory();
  }

  loadConfig() {
    return normalizeConfig(readJsonFile(this.configPath, {}));
  }

  saveConfig(payload) {
    const requested = normalizeConfig(payload);
    validateConfig(requested);
    writeJsonFile(this.configPath, requested);
    this.ensureTimer(requested);
    return this.publicConfig();
  }

  loadHistory() {
    return asArray(readJsonFile(this.historyPath, { items: [] }).items).slice(-MAX_HISTORY_ITEMS);
  }

  persistHistory() {
    writeJsonFile(this.historyPath, { items: this.history.slice(-MAX_HISTORY_ITEMS) });
  }

  status(config = this.loadConfig()) {
    return {
      enabled: config.enabled,
      ...(this.lastScanAt ? { lastScanAt: this.lastScanAt } : {}),
      ...(this.lastDeliveryAt ? { lastDeliveryAt: this.lastDeliveryAt } : {}),
      ...(this.lastDeliveryError ? { lastDeliveryError: 'Alert delivery failed on the local agent.' } : {}),
      activeAlerts: this.active.size,
      configPath: 'local-agent',
      pollIntervalSeconds: config.pollIntervalSeconds || 30
    };
  }

  publicConfig() {
    return publicConfig(this.loadConfig(), this);
  }

  summary() {
    this.ensureTimer();
    return {
      fetchedAt: new Date().toISOString(),
      issues: [],
      partial: false,
      availability: 'available',
      config: this.publicConfig(),
      history: this.historyPublic()
    };
  }

  historyPublic() {
    return [...this.history]
      .slice(-MAX_HISTORY_ITEMS)
      .reverse()
      .map((item) => ({
        ...item,
        error: item.error ? 'Alert delivery failed on the local agent.' : undefined
      }));
  }

  ensureTimer(config = this.loadConfig()) {
    if (this.timer || !config.enabled) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, (config.pollIntervalSeconds || 30) * 1000);
    this.timer.unref?.();
    void this.scan();
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    const now = new Date().toISOString();
    try {
      const config = this.loadConfig();
      this.ensureTimer(config);
      if (!config.enabled) {
        this.active = new Map();
        this.lastScanAt = now;
        return;
      }
      const alerts = await evaluateConfig(this.runtimeConfig, config);
      this.active = new Map(alerts.map((alert) => [alert.fingerprint, alert]));
      this.lastScanAt = now;
      for (const alert of alerts) {
        await this.deliver(config, alert, now);
      }
    } catch (error) {
      this.lastScanAt = now;
      this.lastDeliveryError = sanitizeError(error);
    } finally {
      this.scanning = false;
    }
  }

  async deliver(config, alert, now) {
    const rule = config.rules.find((entry) => entry.id === alert.ruleId);
    if (!rule) return;
    const channels = new Map(config.channels.map((channel) => [channel.id, channel]));
    for (const channelId of rule.channelIds) {
      const channel = channels.get(channelId);
      if (!channel || !channel.enabled) continue;
      const key = `${alert.fingerprint}|${channelId}`;
      const last = this.lastSent.get(key);
      if (last && Date.parse(now) - Date.parse(last) < rule.cooldownSeconds * 1000) continue;
      let error = '';
      try {
        await sendAlert(channel, alert);
        this.lastDeliveryAt = now;
        this.lastDeliveryError = undefined;
      } catch (sendError) {
        error = sanitizeError(sendError);
        this.lastDeliveryError = error;
      }
      this.lastSent.set(key, now);
      this.history.push({
        alert,
        channelId: channel.id,
        provider: channel.provider,
        delivered: !error,
        ...(error ? { error } : {}),
        deliveredAt: now
      });
      this.history = this.history.slice(-MAX_HISTORY_ITEMS);
      this.persistHistory();
    }
  }

  async test(channelId) {
    const config = this.loadConfig();
    const channel = config.channels.find((entry) => entry.id === channelId);
    if (!channel) return { ok: false, message: 'Alerting channel was not found in the local agent config.' };
    const alert = newAlert(
      { id: 'manual-test', severity: 'warning' },
      'test',
      '',
      'KUBI alerting test',
      'ManualTest',
      'This is a test alert from KUBI.'
    );
    try {
      await sendAlert(channel, alert);
      const now = new Date().toISOString();
      this.lastDeliveryAt = now;
      this.lastDeliveryError = undefined;
      this.history.push({ alert, channelId: channel.id, provider: channel.provider, delivered: true, deliveredAt: now });
      this.history = this.history.slice(-MAX_HISTORY_ITEMS);
      this.persistHistory();
      return { ok: true, message: 'Test alert delivered.' };
    } catch (error) {
      return { ok: false, message: sanitizeError(error) };
    }
  }
}

function managerFor(runtimeConfig) {
  const key = `${alertingConfigPath(runtimeConfig)}::${alertingHistoryPath(runtimeConfig)}::${runtimeConfig.kubeContext || ''}`;
  let manager = managers.get(key);
  if (!manager) {
    manager = new AlertingManager(runtimeConfig);
    managers.set(key, manager);
  } else {
    manager.runtimeConfig = runtimeConfig;
  }
  return manager;
}

export function loadAlertingConfig(runtimeConfig) {
  return managerFor(runtimeConfig).publicConfig();
}

export function saveAlertingConfig(runtimeConfig, payload) {
  return managerFor(runtimeConfig).saveConfig(payload);
}

export function loadAlertingHistory(runtimeConfig) {
  return managerFor(runtimeConfig).historyPublic();
}

export function loadAlertingSummary(runtimeConfig) {
  return managerFor(runtimeConfig).summary();
}

export async function testAlertingChannel(runtimeConfig, channelId) {
  return managerFor(runtimeConfig).test(channelId);
}

export async function alertingRuleOptions(runtimeConfig, query) {
  const kind = stringOr(query.kind, 'pod').toLowerCase();
  if (!CONDITIONS_BY_KIND[kind]) {
    throw new Error('unsupported alerting rule kind');
  }
  const namespace = displayNamespace(query.namespace || 'all');
  const ns = effectiveNamespace(namespace);
  const kubeConfig = loadLocalKubeConfig(runtimeConfig);
  const objects = ['*'];
  const add = (name) => {
    if (typeof name === 'string' && name.trim()) objects.push(name.trim());
  };
  if (kind === 'pod') {
    const list = await fetchKubeList(kubeConfig, namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', ns));
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  } else if (kind === 'node') {
    const list = await fetchKubeList(kubeConfig, '/api/v1/nodes');
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  } else if (kind === 'service') {
    const list = await fetchKubeList(kubeConfig, namespacePath('/api/v1/services', '/api/v1/namespaces/:namespace/services', ns));
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  } else if (kind === 'ingress') {
    const list = await fetchKubeList(kubeConfig, namespacePath('/apis/networking.k8s.io/v1/ingresses', '/apis/networking.k8s.io/v1/namespaces/:namespace/ingresses', ns));
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  } else if (kind === 'job') {
    const list = await fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/jobs', '/apis/batch/v1/namespaces/:namespace/jobs', ns));
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  } else if (kind === 'cronjob') {
    const list = await fetchKubeList(kubeConfig, namespacePath('/apis/batch/v1/cronjobs', '/apis/batch/v1/namespaces/:namespace/cronjobs', ns));
    asRecordArray(list.items).forEach((item) => add(metadataFor(item).name));
  }
  return {
    kind,
    namespace,
    conditions: [...CONDITIONS_BY_KIND[kind]],
    objects: ['*', ...Array.from(new Set(objects.slice(1))).sort((left, right) => left.localeCompare(right))]
  };
}

export const __alertingInternals = {
  normalizeConfig,
  evaluatePods,
  evaluateNodes,
  evaluateServices,
  evaluateIngresses,
  evaluateJobs,
  evaluateCronJobs,
  sendAlert,
  managerFor,
  sanitizeError
};
