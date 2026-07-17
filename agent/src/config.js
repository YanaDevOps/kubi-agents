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
  return { kubeconfigPaths, kubeconfigDirectories };
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

export function resolveAgentRuntimeConfig(config) {
  const settings = loadAgentSettings();
  const validated = validateAgentSettings(settings);
  const relay = settings.relay && typeof settings.relay === 'object' ? settings.relay : {};
  const discovery = settings.discovery && typeof settings.discovery === 'object' ? settings.discovery : {};
  return {
    controlPlaneUrl: process.env.KUBI_AGENT_CONTROL_PLANE_URL || relay.url || config.controlPlaneUrl,
    agentId: config.agentId,
    agentSecret: config.agentSecret,
    version: process.env.KUBI_AGENT_VERSION || config.version || null,
    buildId: process.env.KUBI_AGENT_BUILD_ID || config.buildId || null,
    runtimeApiVersion: LOCAL_AGENT_RUNTIME_API_VERSION,
    kubeconfigPath: process.env.KUBI_AGENT_KUBECONFIG || config.kubeconfigPath || null,
    kubeconfigPaths: validated.kubeconfigPaths,
    kubeconfigDirectories: validated.kubeconfigDirectories,
    kubeContext: process.env.KUBI_AGENT_CONTEXT || discovery.context || config.kubeContext || null,
    namespace: process.env.KUBI_AGENT_NAMESPACE || discovery.namespace || config.namespace || null,
    alertingConfigPath: process.env.KUBI_AGENT_ALERTING_CONFIG || config.alertingConfigPath || null,
    alertingHistoryPath: process.env.KUBI_AGENT_ALERTING_HISTORY || config.alertingHistoryPath || null,
    logging: settings.logging && typeof settings.logging === 'object' ? settings.logging : {}
  };
}
