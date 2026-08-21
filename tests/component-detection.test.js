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
        '/apis/apps/v1/deployments': [
          {
            metadata: { name: 'vault-secrets-operator', namespace: 'vault-secrets-operator-system' },
            spec: { template: { spec: { containers: [{ name: 'manager', image: 'hashicorp/vault-secrets-operator:0.10.0' }] } } }
          },
          {
            metadata: { name: 'vector', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'vector', image: 'timberio/vector:0.48.0' }] } } }
          },
          {
            metadata: { name: 'otel-collector', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'collector', image: 'otel/opentelemetry-collector-contrib:0.131.0' }] } } }
          }
        ],
        '/apis/apps/v1/daemonsets': [
          {
            metadata: { name: 'svclb-grafana-abc', namespace: 'kube-system' },
            spec: { template: { spec: { containers: [{ name: 'lb-port-3000', image: 'rancher/klipper-lb:v0.4.13' }] } } }
          },
          {
            metadata: { name: 'fluent-bit', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'fluent-bit', image: 'fluent/fluent-bit:4.0.5' }] } } }
          },
          {
            metadata: { name: 'fluentd', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'fluentd', image: 'fluent/fluentd-kubernetes-daemonset:v1.19' }] } } }
          }
        ],
        '/apis/apps/v1/statefulsets': [
          {
            metadata: { name: 'vault', namespace: 'vault' },
            spec: { template: { spec: { containers: [{ name: 'vault', image: 'hashicorp/vault:1.20.0' }] } } }
          },
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
          },
          {
            metadata: { name: 'loki', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'loki', image: 'grafana/loki:3.5.2' }] } } }
          },
          {
            metadata: { name: 'tempo', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'tempo', image: 'grafana/tempo:2.8.2' }] } } }
          }
        ],
        '/apis/storage.k8s.io/v1/storageclasses': [{ metadata: { name: 'fast' }, provisioner: 'csi.vitastor.io' }],
        '/apis/storage.k8s.io/v1/csidrivers': [{ metadata: { name: 'csi.vitastor.io' } }],
        '/apis/networking.k8s.io/v1/ingressclasses': [],
        '/apis/apiextensions.k8s.io/v1/customresourcedefinitions': [
          { metadata: { name: 'vmsingles.operator.victoriametrics.com' }, spec: { group: 'operator.victoriametrics.com' } },
          { metadata: { name: 'vaultauths.secrets.hashicorp.com' }, spec: { group: 'secrets.hashicorp.com' } }
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
      expect(response.items.find((item) => item.key === 'loki')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'tempo')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'opentelemetry-collector')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'fluent-bit')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'fluentd')).toMatchObject({ category: 'observability', status: 'detected' });
      expect(response.items.find((item) => item.key === 'k3s-servicelb')).toMatchObject({ category: 'networking', status: 'detected' });
      expect(response.items.find((item) => item.key === 'flannel')).toMatchObject({ category: 'networking', status: 'detected' });
      expect(response.items.find((item) => item.key === 'hashicorp-vault')).toMatchObject({ category: 'security', status: 'detected' });
      expect(response.items.find((item) => item.key === 'vault-secrets-operator')).toMatchObject({ category: 'security', status: 'detected' });
      expect(response.summary.storage).toBe(1);
      expect(response.summary.security).toBe(2);
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('reports operator CRDs as configured without treating helper workloads as active components', async () => {
    const certificate = fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url), 'utf8');
    const privateKey = fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
      const resources = {
        '/api/v1/namespaces': [],
        '/api/v1/nodes': [],
        '/apis/apps/v1/deployments': [
          {
            metadata: {
              name: 'tempo-operator',
              namespace: 'operators',
              labels: { 'app.kubernetes.io/name': 'tempo-operator' }
            },
            spec: { template: { spec: { containers: [{ name: 'operator', image: 'grafana/tempo-operator:0.15.4' }] } } }
          },
          {
            metadata: {
              name: 'fluent-operator',
              namespace: 'operators',
              labels: { 'app.kubernetes.io/name': 'fluent-operator' }
            },
            spec: { template: { spec: { containers: [{ name: 'operator', image: 'fluent/fluent-operator:3.4.0' }] } } }
          }
        ],
        '/apis/apps/v1/daemonsets': [
          {
            metadata: { name: 'loki-canary', namespace: 'observability' },
            spec: { template: { spec: { containers: [{ name: 'canary', image: 'grafana/loki-canary:3.5.2' }] } } }
          },
          {
            metadata: {
              name: 'svclb-grafana-abc',
              namespace: 'kube-system',
              labels: { 'svccontroller.k3s.cattle.io/svcname': 'grafana' }
            },
            spec: { template: { spec: { containers: [{ name: 'lb', image: 'rancher/klipper-lb:v0.4.13' }] } } }
          }
        ],
        '/apis/apps/v1/statefulsets': [],
        '/apis/storage.k8s.io/v1/storageclasses': [],
        '/apis/storage.k8s.io/v1/csidrivers': [],
        '/apis/networking.k8s.io/v1/ingressclasses': [],
        '/apis/apiextensions.k8s.io/v1/customresourcedefinitions': [
          { metadata: { name: 'lokistacks.loki.grafana.com' }, spec: { group: 'loki.grafana.com' } },
          { metadata: { name: 'tempostacks.tempo.grafana.com' }, spec: { group: 'tempo.grafana.com' } },
          { metadata: { name: 'opentelemetrycollectors.opentelemetry.io' }, spec: { group: 'opentelemetry.io' } },
          { metadata: { name: 'fluentbits.fluentbit.fluent.io' }, spec: { group: 'fluentbit.fluent.io' } },
          { metadata: { name: 'fluentds.fluentd.fluent.io' }, spec: { group: 'fluentd.fluent.io' } }
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
      for (const key of ['loki', 'tempo', 'opentelemetry-collector', 'fluent-bit', 'fluentd']) {
        expect(response.items.find((item) => item.key === key)).toMatchObject({
          category: 'observability',
          status: 'partial'
        });
      }
      expect(response.items.find((item) => item.key === 'grafana')).toBeUndefined();
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
