import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSettings, redactAgentRuntimeConfig, resolveAgentRuntimeConfig, validateAgentSettings } from '../agent/src/config.js';
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
      kubeconfigDirectories: ['/srv/gateway/kubeconfigs'],
      metricsExporter: {
        enabled: false,
        listenAddress: '127.0.0.1',
        port: 9464,
        collectionIntervalSeconds: 60,
        detailLevel: 'aggregate',
        contexts: [],
        bearerTokenFile: '',
        allowInsecureHttp: false,
        tls: { certFile: '', keyFile: '' }
      },
      storageDrivers: {
        openebs: { profiles: [] },
        portworx: { profiles: [] },
        vitastor: {
          cli: {
            enabled: true,
            path: 'vitastor-cli',
            configPath: '',
            timeoutSeconds: 8
          },
          profiles: []
        }
      }
    });
    expect(resolveAgentRuntimeConfig({ controlPlaneUrl: 'https://old.invalid', agentId: 'a', agentSecret: 's' })).toMatchObject({
      controlPlaneUrl: 'https://app.kubi.live',
      kubeconfigPath: '/override/kubeconfig'
    });
  }));

  test('requires authentication and transport protection for a remote metrics listener', () => {
    expect(() => validateAgentSettings({
      metrics_exporter: {
        enabled: true,
        listen_address: '0.0.0.0',
        bearer_token_file: '/etc/kubi-agent/metrics.token'
      }
    })).toThrow('metrics_exporter.tls');
    expect(() => validateAgentSettings({
      metrics_exporter: {
        enabled: true,
        listen_address: '0.0.0.0',
        allow_insecure_http: true
      }
    })).toThrow('metrics_exporter.bearer_token_file');
    expect(validateAgentSettings({
      metrics_exporter: {
        enabled: true,
        listen_address: '0.0.0.0',
        detail_level: 'balanced',
        bearer_token_file: '/etc/kubi-agent/metrics.token',
        tls: {
          cert_file: '/etc/kubi-agent/tls/metrics.crt',
          key_file: '/etc/kubi-agent/tls/metrics.key'
        }
      }
    }).metricsExporter).toMatchObject({
      enabled: true,
      listenAddress: '0.0.0.0',
      detailLevel: 'balanced',
      bearerTokenFile: '/etc/kubi-agent/metrics.token',
      tls: {
        certFile: '/etc/kubi-agent/tls/metrics.crt',
        keyFile: '/etc/kubi-agent/tls/metrics.key'
      }
    });

    expect(validateAgentSettings({ metrics_exporter: {} }).metricsExporter.detailLevel).toBe('aggregate');
    expect(() => validateAgentSettings({
      metrics_exporter: { detail_level: 'per-pod' }
    })).toThrow('metrics_exporter.detail_level must be aggregate or balanced');
  });

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

  test('validates customer-side Vitastor profiles', () => {
    const validated = validateAgentSettings({
      storage: {
        drivers: {
          vitastor: {
            cli: {
              enabled: true,
              path: '/usr/bin/vitastor-cli',
              config_path: '/etc/vitastor/vitastor.conf',
              timeout_seconds: 12
            },
            profiles: [{
              context: '*',
              endpoints: ['http://10.10.8.201:12379'],
              prefix: '/vitastor',
              auth: { username: 'reader', password: 'secret' },
              metrics: {
                scheme: 'http',
                auth: { mode: 'bearer', bearer_token: 'metrics-secret' }
              }
            }]
          }
        }
      }
    });

    expect(validated.storageDrivers.vitastor.cli).toEqual({
      enabled: true,
      path: '/usr/bin/vitastor-cli',
      configPath: '/etc/vitastor/vitastor.conf',
      timeoutSeconds: 12
    });
    expect(validated.storageDrivers.vitastor.profiles[0]).toMatchObject({
      context: '*',
      endpoints: ['http://10.10.8.201:12379'],
      prefix: '/vitastor',
      auth: { username: 'reader', password: 'secret' },
      metrics: {
        scheme: 'http',
        auth: { mode: 'bearer', bearerToken: 'metrics-secret' }
      }
    });
  });

  test('validates and redacts context-scoped storage exporter endpoints', () => {
    const validated = validateAgentSettings({
      storage: {
        drivers: {
          openebs: {
            profiles: [{
              context: 'production',
              metrics_endpoints: [{
                url: 'https://openebs.internal/metrics',
                ca_file: '/etc/kubi-agent/tls/ca.pem',
                client_cert_file: '/etc/kubi-agent/tls/client.pem',
                client_key_file: '/etc/kubi-agent/tls/client.key',
                bearer_token_file: '/etc/kubi-agent/tokens/openebs'
              }]
            }]
          },
          portworx: {
            profiles: [{ context: '*', metrics_endpoints: [{ url: 'http://127.0.0.1:9001/metrics' }] }]
          }
        }
      }
    });

    expect(validated.storageDrivers.openebs.profiles[0].metricsEndpoints[0]).toMatchObject({
      url: 'https://openebs.internal/metrics',
      caFile: '/etc/kubi-agent/tls/ca.pem',
      bearerTokenFile: '/etc/kubi-agent/tokens/openebs'
    });
    expect(validated.storageDrivers.portworx.profiles[0].context).toBe('*');
    const redacted = JSON.stringify(redactAgentRuntimeConfig({
      agentSecret: 'agent-secret',
      storageDrivers: validated.storageDrivers
    }));
    expect(redacted).not.toContain('/etc/kubi-agent/tokens/openebs');
    expect(redacted).not.toContain('/etc/kubi-agent/tls/client.key');
    expect(() => validateAgentSettings({
      storage: { drivers: { openebs: { profiles: [{ metrics_endpoints: [{ url: 'https://user:secret@example.com/metrics' }] }] } } }
    })).toThrow('must not include inline credentials');
    expect(() => validateAgentSettings({
      storage: { drivers: { portworx: { profiles: [{ metrics_endpoints: [{ url: 'https://px.internal/metrics', client_cert_file: '/cert.pem' }] }] } } }
    })).toThrow('must be configured together');
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
