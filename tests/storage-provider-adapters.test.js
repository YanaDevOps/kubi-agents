import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
  discoverStorageMetricEndpoints,
  loadCephStorageOverview,
  loadLonghornStorageOverview,
  parseStoragePrometheusMetrics
} from '../agent/src/storage-provider-adapters.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function apiServer(responses) {
  const server = http.createServer((request, response) => {
    const path = String(request.url || '').split('?')[0];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: responses[path] || [], metadata: {} }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function runtimeConfig(endpoint) {
  return {
    kubeConfig: {
      getCurrentCluster: () => ({ server: endpoint }),
      applyToFetchOptions: async (options) => options
    }
  };
}

function service(name, namespace, port) {
  return { metadata: { name, namespace }, spec: { clusterIP: '10.43.0.10', ports: [{ name: 'metrics', port }] } };
}

function endpointSlice(name, namespace, serviceName, port) {
  return {
    metadata: { name, namespace, labels: { 'kubernetes.io/service-name': serviceName } },
    ports: [{ name: 'metrics', port }],
    endpoints: [{ addresses: ['127.0.0.1'] }]
  };
}

describe('storage provider adapters', () => {
  test('parses metrics and excludes public EndpointSlice addresses', () => {
    expect(parseStoragePrometheusMetrics('ceph_health_status 1\n')).toEqual([{ name: 'ceph_health_status', labels: {}, value: 1 }]);
    expect(discoverStorageMetricEndpoints(
      'ceph',
      [service('rook-ceph-mgr', 'rook-ceph', 9283)],
      [{ ...endpointSlice('mgr', 'rook-ceph', 'rook-ceph-mgr', 9283), endpoints: [{ addresses: ['8.8.8.8'] }] }]
    )).toEqual(['http://10.43.0.10:9283/metrics']);
  });

  test('combines Rook CRDs with exporter metrics', async () => {
    const endpoint = await apiServer({
      '/apis/ceph.rook.io/v1/cephclusters': [{ metadata: { name: 'rook-ceph' }, status: { ceph: { health: 'HEALTH_OK' } } }],
      '/apis/ceph.rook.io/v1/cephblockpools': [{ metadata: { name: 'replicapool' }, status: { phase: 'Ready' } }],
      '/api/v1/services': [service('rook-ceph-mgr', 'rook-ceph', 9283)],
      '/apis/discovery.k8s.io/v1/endpointslices': [endpointSlice('mgr', 'rook-ceph', 'rook-ceph-mgr', 9283)]
    });
    const overview = await loadCephStorageOverview(runtimeConfig(endpoint), {}, {
      getMetrics: async () => 'ceph_health_status 0\nceph_osd_up{ceph_daemon="osd.0"} 1\nceph_pool_max_avail{name="replicapool"} 900\nceph_pool_stored{name="replicapool"} 100\n'
    });
    expect(overview.driver).toMatchObject({ backendKind: 'ceph', status: 'healthy' });
    expect(overview.details.pools.items[0]).toMatchObject({ usedBytes: 100, totalBytes: 1000 });
  });

  test('builds Longhorn capability sections from CRDs', async () => {
    const endpoint = await apiServer({
      '/apis/longhorn.io/v1beta2/nodes': [{ metadata: { name: 'worker-a' }, status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'Schedulable', status: 'True' }] } }],
      '/apis/longhorn.io/v1beta2/volumes': [{ metadata: { name: 'volume-a' }, spec: { size: '500' }, status: { robustness: 'healthy' } }],
      '/api/v1/services': [service('longhorn-backend', 'longhorn-system', 9500)],
      '/apis/discovery.k8s.io/v1/endpointslices': [endpointSlice('longhorn', 'longhorn-system', 'longhorn-backend', 9500)]
    });
    const overview = await loadLonghornStorageOverview(runtimeConfig(endpoint), {}, { getMetrics: async () => '' });
    expect(overview.driver).toMatchObject({ backendKind: 'longhorn', status: 'healthy' });
    expect(overview.backendSections.map((section) => section.id)).toContain('longhorn-volumes');
  });
});
