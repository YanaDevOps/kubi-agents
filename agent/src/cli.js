#!/usr/bin/env node

import os from 'node:os';
import process from 'node:process';
import { getAgentConfigPath, getAgentSettingsPath, loadAgentConfig, loadAgentSettings, LOCAL_AGENT_RUNTIME_API_VERSION, resolveAgentRuntimeConfig, saveAgentConfig, validateAgentSettings } from './config.js';
import { registerAgentWithControlPlane, rotateAgentCredentials, sendAgentHeartbeat, syncDiscoveredCandidates } from './control-plane.js';
import { createAgentLoopbackServer } from './server.js';
import { scanLocalAccessDiscovery } from './kube.js';
import { createAgentRelayClient } from './relay.js';
import { createAgentLogger } from './logger.js';

const AGENT_VERSION = typeof KUBI_AGENT_COMPILED_VERSION !== 'undefined'
  ? KUBI_AGENT_COMPILED_VERSION
  : process.env.KUBI_AGENT_VERSION || '0.1.0-dev';
const AGENT_BUILD_ID = typeof KUBI_AGENT_COMPILED_BUILD_ID !== 'undefined'
  ? KUBI_AGENT_COMPILED_BUILD_ID
  : process.env.KUBI_AGENT_BUILD_ID || AGENT_VERSION;
const DEFAULT_CAPABILITIES = {
  supportedModes: ['agent'],
  availableAuthKinds: ['unknown', 'token', 'client-cert', 'exec'],
  runtimeApiVersion: LOCAL_AGENT_RUNTIME_API_VERSION,
  buildId: AGENT_BUILD_ID
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? next : 'true';
    if (args[key] !== 'true') {
      index += 1;
    }
  }
  return args;
}

function platformLabel() {
  return `${process.platform}/${process.arch}`;
}

async function pairAgent(argv) {
  const logger = createAgentLogger(loadAgentSettings().logging);
  const args = parseArgs(argv);
  const controlPlaneUrl = args['control-plane-url'];
  const pairingToken = args['pairing-token'];
  if (!controlPlaneUrl || !pairingToken) {
    throw new Error('Usage: kubi-agent pair --control-plane-url <url> --pairing-token <token>');
  }

  const displayName = args['display-name'] || `KUBI Agent on ${os.hostname()}`;
  const registration = await registerAgentWithControlPlane({
    controlPlaneUrl,
    pairingToken,
    displayName,
    platform: platformLabel(),
    version: AGENT_VERSION,
    capabilities: DEFAULT_CAPABILITIES
  });

  const configPath = saveAgentConfig({
    controlPlaneUrl,
    agentId: registration.agentId,
    agentSecret: registration.agentSecret,
    heartbeatIntervalSeconds: registration.heartbeatIntervalSeconds,
    displayName,
    version: AGENT_VERSION,
    buildId: AGENT_BUILD_ID,
    runtimeApiVersion: LOCAL_AGENT_RUNTIME_API_VERSION,
    platform: platformLabel()
  });

  logger.info(`Paired agent ${registration.agentId} to workspace ${registration.workspaceId}.`);
  logger.info(`Saved agent identity at ${configPath}.`);
  logger.info('Next step: kubi-agent run');
}

async function runAgent() {
  const config = loadAgentConfig();
  const runtimeConfig = resolveAgentRuntimeConfig(config);
  const logger = createAgentLogger(runtimeConfig.logging);
  const discoveryState = {
    candidateCount: 0,
    sourceCount: 0,
    lastScannedAt: null,
    lastError: null
  };

  async function refreshDiscovery() {
    const result = scanLocalAccessDiscovery(runtimeConfig);
    const lastError = result.sourceCount === 0 && result.warnings.length > 0 ? result.warnings.join(' ') : undefined;
    const sync = await syncDiscoveredCandidates({
      controlPlaneUrl: runtimeConfig.controlPlaneUrl,
      agentId: runtimeConfig.agentId,
      agentSecret: runtimeConfig.agentSecret,
      candidates: result.candidates,
      sourceCount: result.sourceCount,
      ...(lastError ? { lastError } : {})
    });

    discoveryState.candidateCount = sync.syncedCount;
    discoveryState.sourceCount = sync.sourceCount;
    discoveryState.lastScannedAt = sync.lastScannedAt;
    discoveryState.lastError = lastError ?? null;
    return { ...sync, warnings: result.warnings };
  }

  const server = createAgentLoopbackServer({
    runtimeConfig,
    discoveryScanProvider: refreshDiscovery
  });
  await server.listen();

  const relay = createAgentRelayClient({
    runtimeConfig,
    dispatch: server.dispatch,
    platform: platformLabel(),
    version: AGENT_VERSION,
    capabilities: DEFAULT_CAPABILITIES,
    onStatus(status) {
      logger.info(status === 'connected' ? 'KUBI hosted relay connected.' : 'KUBI hosted relay disconnected; reconnecting.');
    },
    onError(error) {
      logger.warn(`KUBI hosted relay: ${error.message}`);
    }
  });
  relay.start();

  logger.info('KUBI agent loopback runtime listening on http://127.0.0.1:47641/v1');
  logger.info(`Using identity ${getAgentConfigPath()} and settings ${getAgentSettingsPath()}`);

  async function heartbeat() {
    try {
      await sendAgentHeartbeat({
        controlPlaneUrl: runtimeConfig.controlPlaneUrl,
        agentId: runtimeConfig.agentId,
        agentSecret: runtimeConfig.agentSecret,
        platform: platformLabel(),
        version: AGENT_VERSION,
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          discoveredContextCount: discoveryState.candidateCount
        }
      });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : 'Agent heartbeat failed.');
    }
  }

  try {
    const discoveryResult = await refreshDiscovery();
    if (discoveryResult.warnings.length > 0) {
      logger.warn(discoveryResult.warnings.join(' '));
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : 'Initial access discovery failed.');
  }

  await heartbeat();
  const interval = setInterval(heartbeat, Number(config.heartbeatIntervalSeconds || 30) * 1000);

  const shutdown = async () => {
    clearInterval(interval);
    relay.close();
    await server.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function rotateAgent() {
  const config = loadAgentConfig();
  const runtimeConfig = resolveAgentRuntimeConfig(config);
  const rotation = await rotateAgentCredentials({
    controlPlaneUrl: runtimeConfig.controlPlaneUrl,
    agentId: runtimeConfig.agentId,
    agentSecret: runtimeConfig.agentSecret
  });

  saveAgentConfig({
    ...config,
    agentSecret: rotation.agentSecret
  });

  console.log(`Rotated credentials for agent ${rotation.agentId}.`);
  console.log(`Updated local config at ${getAgentConfigPath()}.`);
  console.log('If the agent is already running, restart it so future heartbeats use the new credential.');
}

function printVersion() {
  console.log(`kubi-agent ${AGENT_VERSION} (${AGENT_BUILD_ID}) runtime-api/${LOCAL_AGENT_RUNTIME_API_VERSION}`);
}

function configCommand(action) {
  const settings = loadAgentSettings({ required: action === 'validate' });
  validateAgentSettings(settings);
  if (action === 'validate') {
    console.log(`Configuration is valid: ${getAgentSettingsPath()}`);
    return;
  }
  if (action === 'show') {
    const identity = loadAgentConfig();
    const effective = resolveAgentRuntimeConfig(identity);
    console.log(JSON.stringify({ ...effective, agentSecret: '[redacted]' }, null, 2));
    return;
  }
  throw new Error('Usage: kubi-agent config validate | config show --effective');
}

async function main() {
  const command = process.argv[2];
  if (command === 'pair') {
    await pairAgent(process.argv.slice(3));
    return;
  }
  if (command === 'run' || command === 'serve') {
    await runAgent();
    return;
  }
  if (command === 'rotate') {
    await rotateAgent();
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    printVersion();
    return;
  }
  if (command === 'config') {
    configCommand(process.argv[3] === 'show' && process.argv.includes('--effective') ? 'show' : process.argv[3]);
    return;
  }

  console.log('Usage:');
  console.log('  node agent/src/cli.js pair --control-plane-url <url> --pairing-token <token>');
  console.log('  node agent/src/cli.js run');
  console.log('  node agent/src/cli.js rotate');
  console.log('  node agent/src/cli.js version');
  console.log('  node agent/src/cli.js config validate');
  console.log('  node agent/src/cli.js config show --effective');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'KUBI agent failed.');
  process.exit(1);
});
