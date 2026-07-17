import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSettings, resolveAgentRuntimeConfig, validateAgentSettings } from '../agent/src/config.js';
import { createAgentLogger } from '../agent/src/logger.js';

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubi-agent-config-'));
  try {
    return run(directory);
  } finally {
    delete process.env.KUBI_AGENT_CONFIG;
    delete process.env.KUBI_AGENT_KUBECONFIG;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('agent operator configuration', () => {
  test('loads gateway kubeconfigs and preserves environment precedence', () => withTemporaryDirectory((directory) => {
    const settingsPath = path.join(directory, 'agent.yaml');
    fs.writeFileSync(settingsPath, `
relay:
  url: https://app.kubi.live
discovery:
  kubeconfig_paths:
    - /etc/rancher/k3s/k3s.yaml
    - /srv/gateway/production.yaml
  kubeconfig_directories:
    - /srv/gateway/kubeconfigs
`);
    process.env.KUBI_AGENT_CONFIG = settingsPath;
    process.env.KUBI_AGENT_KUBECONFIG = '/override/kubeconfig';

    const settings = loadAgentSettings({ required: true });
    expect(validateAgentSettings(settings)).toEqual({
      kubeconfigPaths: ['/etc/rancher/k3s/k3s.yaml', '/srv/gateway/production.yaml'],
      kubeconfigDirectories: ['/srv/gateway/kubeconfigs']
    });
    expect(resolveAgentRuntimeConfig({ controlPlaneUrl: 'https://old.invalid', agentId: 'a', agentSecret: 's' })).toMatchObject({
      controlPlaneUrl: 'https://app.kubi.live',
      kubeconfigPath: '/override/kubeconfig'
    });
  }));

  test('uses the running binary release instead of stale pairing metadata', () => {
    const runtime = resolveAgentRuntimeConfig(
      {
        controlPlaneUrl: 'https://app.kubi.live',
        agentId: 'agent-1',
        agentSecret: 'secret-1',
        version: '0.1.0-dev',
        buildId: 'stale-pairing-build'
      },
      {
        version: '0.1.6',
        buildId: 'release-build-016'
      }
    );

    expect(runtime.version).toBe('0.1.6');
    expect(runtime.buildId).toBe('release-build-016');
  });

  test('redacts credentials from optional rotating file logs', () => withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'agent.log');
    const logger = createAgentLogger({ outputs: [], file: { path: logPath, max_size_mb: 1, max_files: 2 } });
    logger.info('agent-secret=super-secret pairing-token=one-time Bearer runtime-token');
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).not.toContain('super-secret');
    expect(log).not.toContain('one-time');
    expect(log).not.toContain('runtime-token');
  }));
});
