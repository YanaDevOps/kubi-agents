import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import { loadLocalComponentInventory } from '../agent/src/kube.js';

describe('agent component detection', () => {
  test('detects storage and observability extensions from Kubernetes platform facts', async () => {
    const certificate = fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url), 'utf8');
    const privateKey = fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
      const resources = {
        '/api/v1/namespaces': [],
        '/api/v1/nodes': [{
          metadata: {
            name: 'node-a',
            annotations: { 'flannel.alpha.coreos.com/backend-type': 'vxlan' }
          }
        }],
        '/apis/apps/v1/deployments': [{
          metadata: { name: 'vector', namespace: 'observability' },
          spec: { template: { spec: { containers: [{ name: 'vector', image: 'timberio/vector:0.48.0' }] } } }
        }],
        '/apis/apps/v1/daemonsets': [{
          metadata: { name: 'svclb-grafana-abc', namespace: 'kube-system' },
          spec: { template: { spec: { containers: [{ name: 'lb-port-3000', image: 'rancher/klipper-lb:v0.4.13' }] } } }
        }],
        '/apis/apps/v1/statefulsets': [
          {
            metadata: { name: 'dashboards', namespace: 'monitoring' },
            spec: { template: { spec: { containers: [{ name: 'ui', image: 'grafana/grafana:11.0.0' }] } } }
          },
          {
            metadata: { name: 'metrics-store', namespace: 'monitoring' },
            spec: { template: { spec: { containers: [{ name: 'storage', image: 'victoriametrics/vmstorage:v1.121.0' }] } } }
          },
          {
            metadata: { name: 'logs-store', namespace: 'monitoring' },
            spec: { template: { spec: { containers: [{ name: 'storage', image: 'victoriametrics/victoria-logs:v1.23.3' }] } } }
          }
        ],
        '/apis/storage.k8s.io/v1/storageclasses': [{ metadata: { name: 'fast' }, provisioner: 'csi.vitastor.io' }],
        '/apis/storage.k8s.io/v1/csidrivers': [{ metadata: { name: 'csi.vitastor.io' } }],
        '/apis/networking.k8s.io/v1/ingressclasses': [],
        '/apis/apiextensions.k8s.io/v1/customresourcedefinitions': [
          { metadata: { name: 'vmsingles.operator.victoriametrics.com' }, spec: { group: 'operator.victoriametrics.com' } }
        ]
      };
      response.writeHead(resources[pathname] ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: resources[pathname] ?? [], metadata: {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const response = await loadLocalComponentInventory({
        kubeConfig: {
          getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
          applyToFetchOptions: async (options) => ({ ...options, agent })
        }
      });
      expect(response.items.find((item) => item.key === 'vitastor')).toMatchObject({ category: 'storage', status: 'detected' });
      expect(response.items.find((item) => item.key === 'grafana')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'victoria-metrics')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'victoria-logs')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'vector')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'k3s-servicelb')).toMatchObject({ category: 'networking', status: 'detected' });
      expect(response.items.find((item) => item.key === 'flannel')).toMatchObject({ category: 'networking', status: 'detected' });
      expect(response.summary.storage).toBe(1);
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
