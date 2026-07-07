#!/usr/bin/env node

import os from 'node:os';
import process from 'node:process';
import { getAgentConfigPath, loadAgentConfig, LOCAL_AGENT_RUNTIME_API_VERSION, resolveAgentRuntimeConfig, saveAgentConfig } from './config.js';
import { registerAgentWithControlPlane, rotateAgentCredentials, sendAgentHeartbeat, syncDiscoveredCandidates } from './control-plane.js';
import { createAgentLoopbackServer } from './server.js';
import { scanLocalAccessDiscovery } from './kube.js';

const AGENT_VERSION = process.env.KUBI_AGENT_VERSION || '0.1.0-dev';
const AGENT_BUILD_ID = process.env.KUBI_AGENT_BUILD_ID || AGENT_VERSION;
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

  console.log(`Paired agent ${registration.agentId} to workspace ${registration.workspaceId}.`);
  console.log(`Saved local config at ${configPath}.`);
  console.log('Next step: node agent/src/cli.js run');
}

async function runAgent() {
  const config = loadAgentConfig();
  const runtimeConfig = resolveAgentRuntimeConfig(config);
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

  console.log(`KUBI agent loopback runtime listening on http://127.0.0.1:47641/v1`);
  console.log(`Using config ${getAgentConfigPath()}`);

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
      console.error(error instanceof Error ? error.message : 'Agent heartbeat failed.');
    }
  }

  try {
    const discoveryResult = await refreshDiscovery();
    if (discoveryResult.warnings.length > 0) {
      console.error(discoveryResult.warnings.join('\n'));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Initial access discovery failed.');
  }

  await heartbeat();
  const interval = setInterval(heartbeat, Number(config.heartbeatIntervalSeconds || 30) * 1000);

  const shutdown = async () => {
    clearInterval(interval);
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

  console.log('Usage:');
  console.log('  node agent/src/cli.js pair --control-plane-url <url> --pairing-token <token>');
  console.log('  node agent/src/cli.js run');
  console.log('  node agent/src/cli.js rotate');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'KUBI agent failed.');
  process.exit(1);
});
