import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const LOCAL_AGENT_RUNTIME_API_VERSION = '2';

function defaultConfigDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'kubi-agent');
  }

  const baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'kubi-agent');
}

export function getAgentConfigPath() {
  return process.env.KUBI_AGENT_IDENTITY || path.join(defaultConfigDir(), 'config.json');
}

export function getAgentSettingsPath() {
  if (process.env.KUBI_AGENT_CONFIG) return process.env.KUBI_AGENT_CONFIG;
  if (process.platform === 'win32') return path.join(defaultConfigDir(), 'agent.yaml');
  return '/etc/kubi-agent/agent.yaml';
}

export function loadAgentSettings({ required = false } = {}) {
  const settingsPath = getAgentSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    if (required) throw new Error(`Agent settings do not exist at ${settingsPath}.`);
    return {};
  }
  const parsed = YAML.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Agent settings at ${settingsPath} must be a YAML object.`);
  }
  return parsed;
}

function strings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${field} must be a list of non-empty paths.`);
  }
  return value.map((entry) => entry.trim());
}

function object(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a YAML object.`);
  }
  return value;
}

function optionalString(value, field, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value.trim();
}

function boundedNumber(value, field, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeVitastorProfiles(settings) {
  const storage = object(settings.storage, 'storage');
  const drivers = object(storage.drivers, 'storage.drivers');
  const vitastor = object(drivers.vitastor, 'storage.drivers.vitastor');
  if (vitastor.profiles === undefined) return null;
  if (!Array.isArray(vitastor.profiles)) {
    throw new Error('storage.drivers.vitastor.profiles must be a list.');
  }

  const profiles = vitastor.profiles.map((raw, index) => {
    const field = `storage.drivers.vitastor.profiles[${index}]`;
    const profile = object(raw, field);
    const auth = object(profile.auth, `${field}.auth`);
    const tls = object(profile.tls, `${field}.tls`);
    const metrics = object(profile.metrics, `${field}.metrics`);
    const metricsAuth = object(metrics.auth, `${field}.metrics.auth`);
    const mode = optionalString(metricsAuth.mode, `${field}.metrics.auth.mode`, 'none').toLowerCase();
    if (!['none', 'basic', 'bearer', 'headers'].includes(mode)) {
      throw new Error(`${field}.metrics.auth.mode must be none, basic, bearer or headers.`);
    }
    const headers = object(metricsAuth.headers, `${field}.metrics.auth.headers`);
    if (Object.values(headers).some((value) => typeof value !== 'string')) {
      throw new Error(`${field}.metrics.auth.headers values must be strings.`);
    }
    const scheme = optionalString(profile.scheme, `${field}.scheme`, 'http').toLowerCase();
    const metricsScheme = optionalString(metrics.scheme, `${field}.metrics.scheme`, 'http').toLowerCase();
    if (!['http', 'https'].includes(scheme)) throw new Error(`${field}.scheme must be http or https.`);
    if (!['http', 'https'].includes(metricsScheme)) throw new Error(`${field}.metrics.scheme must be http or https.`);

    return {
      context: optionalString(profile.context, `${field}.context`, '*') || '*',
      clusterFingerprint: optionalString(profile.cluster_fingerprint, `${field}.cluster_fingerprint`) || undefined,
      endpoints: strings(profile.endpoints, `${field}.endpoints`),
      prefix: optionalString(profile.prefix, `${field}.prefix`, '/vitastor') || '/vitastor',
      scheme,
      timeoutSeconds: boundedNumber(profile.timeout_seconds, `${field}.timeout_seconds`, 8, 1, 60),
      osdStaleSeconds: boundedNumber(profile.osd_stale_seconds, `${field}.osd_stale_seconds`, 30, 1, 3600),
      auth: {
        username: optionalString(auth.username, `${field}.auth.username`),
        password: optionalString(auth.password, `${field}.auth.password`)
      },
      tls: {
        caFile: optionalString(tls.ca_file, `${field}.tls.ca_file`),
        certFile: optionalString(tls.cert_file, `${field}.tls.cert_file`),
        keyFile: optionalString(tls.key_file, `${field}.tls.key_file`)
      },
      metrics: {
        scheme: metricsScheme,
        timeoutSeconds: boundedNumber(metrics.timeout_seconds, `${field}.metrics.timeout_seconds`, 5, 1, 60),
        auth: {
          mode,
          username: optionalString(metricsAuth.username, `${field}.metrics.auth.username`),
          password: optionalString(metricsAuth.password, `${field}.metrics.auth.password`),
          bearerToken: optionalString(metricsAuth.bearer_token, `${field}.metrics.auth.bearer_token`),
          headers: { ...headers }
        }
      }
    };
  });

  const selectors = new Set();
  for (const profile of profiles) {
    const selector = `${profile.clusterFingerprint || ''}|${profile.context}`;
    if (selectors.has(selector)) {
      throw new Error(`Duplicate Vitastor profile selector: ${selector}.`);
    }
    selectors.add(selector);
  }
  return { vitastor: { profiles } };
}

export function validateAgentSettings(settings) {
  const discovery = settings.discovery && typeof settings.discovery === 'object' ? settings.discovery : {};
  const logging = settings.logging && typeof settings.logging === 'object' ? settings.logging : {};
  const kubeconfigPaths = strings(discovery.kubeconfig_paths, 'discovery.kubeconfig_paths');
  const kubeconfigDirectories = strings(discovery.kubeconfig_directories, 'discovery.kubeconfig_directories');
  if (logging.level !== undefined && !['debug', 'info', 'warn', 'error'].includes(logging.level)) {
    throw new Error('logging.level must be debug, info, warn or error.');
  }
  if (logging.outputs !== undefined && (!Array.isArray(logging.outputs) || logging.outputs.some((entry) => entry !== 'stdout'))) {
    throw new Error('logging.outputs currently supports only stdout.');
  }
  const file = logging.file && typeof logging.file === 'object' ? logging.file : null;
  if (file?.path !== undefined && (typeof file.path !== 'string' || !file.path.trim())) {
    throw new Error('logging.file.path must be a non-empty path.');
  }
  const storageDrivers = normalizeVitastorProfiles(settings);
  return {
    kubeconfigPaths,
    kubeconfigDirectories,
    ...(storageDrivers ? { storageDrivers } : {})
  };
}

export function loadAgentConfig() {
  const configPath = getAgentConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Local agent config does not exist at ${configPath}. Run "kubi-agent pair" first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

export function saveAgentConfig(config) {
  const configPath = getAgentConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return configPath;
}

export function resolveAgentRuntimeConfig(config, runningRelease = {}) {
  const settings = loadAgentSettings();
  const validated = validateAgentSettings(settings);
  const relay = settings.relay && typeof settings.relay === 'object' ? settings.relay : {};
  const discovery = settings.discovery && typeof settings.discovery === 'object' ? settings.discovery : {};
  return {
    controlPlaneUrl: process.env.KUBI_AGENT_CONTROL_PLANE_URL || relay.url || config.controlPlaneUrl,
    agentId: config.agentId,
    agentSecret: config.agentSecret,
    version: runningRelease.version || process.env.KUBI_AGENT_VERSION || config.version || null,
    buildId: runningRelease.buildId || process.env.KUBI_AGENT_BUILD_ID || config.buildId || null,
    runtimeApiVersion: LOCAL_AGENT_RUNTIME_API_VERSION,
    kubeconfigPath: process.env.KUBI_AGENT_KUBECONFIG || config.kubeconfigPath || null,
    kubeconfigPaths: validated.kubeconfigPaths,
    kubeconfigDirectories: validated.kubeconfigDirectories,
    kubeContext: process.env.KUBI_AGENT_CONTEXT || discovery.context || config.kubeContext || null,
    namespace: process.env.KUBI_AGENT_NAMESPACE || discovery.namespace || config.namespace || null,
    alertingConfigPath: process.env.KUBI_AGENT_ALERTING_CONFIG || config.alertingConfigPath || null,
    alertingHistoryPath: process.env.KUBI_AGENT_ALERTING_HISTORY || config.alertingHistoryPath || null,
    logging: settings.logging && typeof settings.logging === 'object' ? settings.logging : {},
    storageDrivers: validated.storageDrivers || {}
  };
}

export function redactAgentRuntimeConfig(runtimeConfig) {
  const clone = structuredClone(runtimeConfig);
  clone.agentSecret = '[redacted]';
  for (const profile of clone.storageDrivers?.vitastor?.profiles || []) {
    if (profile.auth?.password) profile.auth.password = '[redacted]';
    if (profile.metrics?.auth?.password) profile.metrics.auth.password = '[redacted]';
    if (profile.metrics?.auth?.bearerToken) profile.metrics.auth.bearerToken = '[redacted]';
    if (profile.metrics?.auth?.headers && Object.keys(profile.metrics.auth.headers).length > 0) {
      profile.metrics.auth.headers = Object.fromEntries(
        Object.keys(profile.metrics.auth.headers).map((name) => [name, '[redacted]'])
      );
    }
  }
  return clone;
}
