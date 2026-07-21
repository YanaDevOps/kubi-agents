import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import { loadLocalJobs } from '../agent/src/kube.js';

describe('agent batch workload specs', () => {
  test('exposes Job and CronJob template execution controls', async () => {
    const certificate = fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url), 'utf8');
    const privateKey = fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
      const resources = {
        '/apis/batch/v1/namespaces/observability/jobs': [{
          metadata: { name: 'indexed-export', namespace: 'observability' },
          spec: {
            ttlSecondsAfterFinished: 3600,
            activeDeadlineSeconds: 900,
            completionMode: 'Indexed',
            backoffLimitPerIndex: 2,
            maxFailedIndexes: 1,
            template: { spec: { restartPolicy: 'Never' } }
          },
          status: { active: 1 }
        }],
        '/apis/batch/v1/namespaces/observability/cronjobs': [{
          metadata: { name: 'scheduled-export', namespace: 'observability' },
          spec: {
            schedule: '0 2 * * *',
            startingDeadlineSeconds: 120,
            jobTemplate: {
              spec: {
                ttlSecondsAfterFinished: 1800,
                activeDeadlineSeconds: 600,
                completionMode: 'Indexed',
                backoffLimitPerIndex: 3,
                maxFailedIndexes: 2,
                template: { spec: { restartPolicy: 'OnFailure' } }
              }
            }
          },
          status: {}
        }],
        '/api/v1/namespaces/observability/pods': []
      };
      response.writeHead(resources[pathname] ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: resources[pathname] ?? [], metadata: {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const response = await loadLocalJobs({
        kubeConfig: {
          getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
          applyToFetchOptions: async (options) => ({ ...options, agent })
        }
      }, 'observability');
      expect(response.jobs.items[0]).toMatchObject({
        ttlSecondsAfterFinished: 3600,
        restartPolicy: 'Never',
        activeDeadlineSeconds: 900,
        completionMode: 'Indexed',
        backoffLimitPerIndex: 2,
        maxFailedIndexes: 1
      });
      expect(response.cronJobs.items[0]).toMatchObject({
        startingDeadlineSeconds: 120,
        ttlSecondsAfterFinished: 1800,
        restartPolicy: 'OnFailure',
        activeDeadlineSeconds: 600,
        completionMode: 'Indexed',
        backoffLimitPerIndex: 3,
        maxFailedIndexes: 2
      });
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
