import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { loadLocalPods } from '../agent/src/kube.js';

describe('pod restart history', () => {
  test('exposes the latest Kubernetes container restart timestamp', async () => {
    const certificate = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url)), 'utf8');
    const privateKey = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url)), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        items: [{
          metadata: { name: 'web', namespace: 'default' },
          spec: { containers: [{ name: 'web', image: 'example/web:1' }] },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: [{
              name: 'web',
              ready: true,
              restartCount: 12,
              state: { running: {} },
              lastState: { terminated: { finishedAt: '2026-06-04T12:00:00Z' } }
            }]
          }
        }],
        metadata: {}
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const response = await loadLocalPods({
        kubeConfig: {
          getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
          applyToFetchOptions: async (options) => ({ ...options, agent })
        }
      }, 'default');
      expect(response.items[0]?.lastRestartAt).toBe('2026-06-04T12:00:00Z');
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
