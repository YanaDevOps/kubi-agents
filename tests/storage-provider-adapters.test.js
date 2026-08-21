import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { loadLocalStorageDriverOverview } from '../agent/src/storage-drivers.js';
import {
  discoverStorageMetricEndpoints,
  loadCephStorageOverview,
  loadLonghornStorageOverview,
  loadOpenEbsStorageOverview,
  loadPortworxStorageOverview,
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

  test('combines OpenEBS CRDs with Mayastor exporter metrics', async () => {
    const endpoint = await apiServer({
      '/apis/openebs.io/v1beta3/diskpools': [{
        metadata: { name: 'pool-a', namespace: 'openebs' },
        spec: { node: 'worker-a' },
        status: { state: 'Online', capacity: 1000, used: 250, committed: 400 }
      }],
      '/apis/local.openebs.io/v1alpha1/lvmnodes': [{ metadata: { name: 'worker-b' }, status: { state: 'Ready' } }],
      '/api/v1/services': [service('openebs-io-engine-metrics', 'openebs', 9502)],
      '/apis/discovery.k8s.io/v1/endpointslices': [endpointSlice('io-engine', 'openebs', 'openebs-io-engine-metrics', 9502)]
    });
    const overview = await loadOpenEbsStorageOverview(runtimeConfig(endpoint), {}, {
      getMetrics: async () => [
        'diskpool_status{node="worker-a",name="pool-a"} 1',
        'diskpool_total_size_bytes{node="worker-a",name="pool-a"} 1000',
        'diskpool_used_size_bytes{node="worker-a",name="pool-a"} 250',
        'diskpool_num_read_ops{node="worker-a",name="pool-a"} 18',
        'diskpool_num_write_ops{node="worker-a",name="pool-a"} 9'
      ].join('\n')
    });

    expect(overview.driver).toMatchObject({ backendKind: 'openebs', status: 'healthy' });
    expect(overview.summary.capacity).toEqual({ usedBytes: 250, totalBytes: 1000 });
    expect(overview.io).toEqual({ readOps: 18, writeOps: 9 });
    expect(overview.backendSections.map((section) => section.id)).toEqual([
      'openebs-engines',
      'openebs-pools',
      'openebs-local-nodes'
    ]);
  });

  test('normalizes Portworx pools, volumes, I/O and connection health', async () => {
    const endpoint = await apiServer({
      '/apis/core.libopenstorage.org/v1/storageclusters': [{ metadata: { name: 'px-cluster' }, status: { phase: 'Online' } }],
      '/apis/core.libopenstorage.org/v1/storagenodes': [{ metadata: { name: 'worker-a' }, status: { phase: 'Online' } }],
      '/api/v1/services': [service('portworx-metrics', 'portworx', 9001)],
      '/apis/discovery.k8s.io/v1/endpointslices': [endpointSlice('portworx', 'portworx', 'portworx-metrics', 9001)]
    });
    const overview = await loadPortworxStorageOverview(runtimeConfig(endpoint), {}, {
      getMetrics: async () => [
        'px_pool_stats_status{node="worker-a",pool="pool-0"} 1',
        'px_pool_stats_total_bytes{node="worker-a",pool="pool-0"} 2000',
        'px_pool_stats_used_bytes{node="worker-a",pool="pool-0"} 500',
        'px_volume_capacity_bytes{node="worker-a",volume="vol-a",volumename="data"} 1000',
        'px_volume_usage_bytes{node="worker-a",volume="vol-a",volumename="data"} 200',
        'px_volume_replication_status{node="worker-a",volume="vol-a",volumename="data"} 0',
        'px_volume_read_iops{node="worker-a",volume="vol-a"} 12',
        'px_volume_write_iops{node="worker-a",volume="vol-a"} 7',
        'px_csi_node_iscsi_sessions{node_name="worker-a"} 2',
        'px_csi_node_iscsi_sessions_healthy{node_name="worker-a"} 2'
      ].join('\n')
    });

    expect(overview.driver).toMatchObject({ backendKind: 'portworx', status: 'healthy' });
    expect(overview.summary.capacity).toEqual({ usedBytes: 500, totalBytes: 2000 });
    expect(overview.io).toEqual({ readOps: 12, writeOps: 7 });
    expect(overview.backendSections.map((section) => section.id)).toEqual([
      'portworx-nodes',
      'portworx-pools',
      'portworx-volumes',
      'portworx-connections'
    ]);
  });

  test('routes OpenEBS and Portworx CSI aliases to deep adapters', async () => {
    const endpoint = await apiServer({});
    const config = runtimeConfig(endpoint);
    config.storageDrivers = {
      openebs: { enabled: true, profiles: [] },
      portworx: { enabled: true, profiles: [] }
    };
    const openebs = await loadLocalStorageDriverOverview(config, { driver: 'io.openebs.csi-mayastor' }, { getMetrics: async () => '' });
    const portworx = await loadLocalStorageDriverOverview(config, { driver: 'pxd.openstorage.org' }, { getMetrics: async () => '' });
    expect(openebs.driver.backendKind).toBe('openebs');
    expect(portworx.driver.backendKind).toBe('portworx');
  });
});
