import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_AGENT_RUNTIME_API_VERSION = '2';

function defaultConfigDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'kubi-agent');
  }

  const baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'kubi-agent');
}

export function getAgentConfigPath() {
  return path.join(defaultConfigDir(), 'config.json');
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
  return {
    controlPlaneUrl: process.env.KUBI_AGENT_CONTROL_PLANE_URL || config.controlPlaneUrl,
    agentId: config.agentId,
    agentSecret: config.agentSecret,
    version: process.env.KUBI_AGENT_VERSION || config.version || null,
    buildId: process.env.KUBI_AGENT_BUILD_ID || config.buildId || null,
    runtimeApiVersion: LOCAL_AGENT_RUNTIME_API_VERSION,
    kubeconfigPath: process.env.KUBI_AGENT_KUBECONFIG || config.kubeconfigPath || null,
    kubeContext: process.env.KUBI_AGENT_CONTEXT || config.kubeContext || null,
    namespace: process.env.KUBI_AGENT_NAMESPACE || config.namespace || null,
    alertingConfigPath: process.env.KUBI_AGENT_ALERTING_CONFIG || config.alertingConfigPath || null,
    alertingHistoryPath: process.env.KUBI_AGENT_ALERTING_HISTORY || config.alertingHistoryPath || null
  };
}
