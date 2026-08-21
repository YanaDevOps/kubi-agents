import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import { loadLocalStorageDriverOverview } from '../agent/src/storage-drivers.js';

describe('agent storage driver metrics', () => {
  test('prefers bounded Vitastor CLI JSON and exposes its source', async () => {
    const payloads = {
      status: {
        etcd_alive: 3, etcd_count: 3, mon_count: 3, osd_up: 3, osd_count: 3,
        active_pool_count: 1, pool_count: 1, total_raw: 6000, free_raw: 6000,
        clean_data: 0, degraded_data: 0, incomplete_data: 0, misplaced_data: 0,
        op_stats: { read: { count: 12 }, write: { count: 7 } }
      },
      pools: [{ id: 1, name: 'data', status: 'active', total_raw: 6000, used_raw: 0, max_available: 2000, raw_to_usable: 3 }],
      osds: [
        { name: 1, parent: 'node-a', up: true, size: 2000, free: 2000 },
        { name: 2, parent: 'node-b', up: true, size: 2000, free: 2000 },
        { name: 3, parent: 'node-c', up: true, size: 2000, free: 2000 }
      ]
    };
    const overview = await loadLocalStorageDriverOverview({
      kubeContext: 'default',
      discoveredContextCount: 1,
      storageDrivers: { vitastor: { enabled: true, cli: { enabled: true, path: 'vitastor-cli' }, profiles: [] } }
    }, { driver: 'csi.vitastor.io' }, {
      execFile: async (_command, args) => JSON.stringify(payloads[args[0]]),
      discoverVitastorConfig: async () => ({ endpoints: [], prefix: '/vitastor', poolIds: [], evidence: [] })
    });

    expect(overview.driver).toMatchObject({ status: 'healthy', metricsSource: 'vitastor-cli' });
    expect(overview.summary).toMatchObject({
      monitors: { up: 3, total: 3 },
      osd: { up: 3, total: 3 },
      pools: 1,
      capacity: { usedBytes: 0, totalBytes: 2000 },
      rawCapacity: { usedBytes: 0, totalBytes: 6000 }
    });
    expect(overview.details.monitors.items).toEqual([]);
    expect(overview.errors).toEqual([]);
  });

  test('enriches CLI metrics with per-monitor inventory from etcd', async () => {
    const records = [
      ['/vitastor/mon/master', { id: 'mon-a' }],
      ['/vitastor/mon/member/mon-a', { hostname: 'mon-a', ip: ['127.0.0.1'] }],
      ['/vitastor/mon/member/mon-b', { hostname: 'mon-b', ip: ['127.0.0.2'] }]
    ];
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v3/kv/range') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          kvs: records.map(([key, value]) => ({
            key: Buffer.from(String(key)).toString('base64'),
            value: Buffer.from(JSON.stringify(value)).toString('base64')
          }))
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const payloads = {
      status: { etcd_alive: 2, etcd_count: 2, mon_count: 2, osd_up: 1, osd_count: 1, active_pool_count: 1, pool_count: 1 },
      pools: [{ id: 1, name: 'data', status: 'active', max_available: 1024, used_raw: 0 }],
      osds: [{ name: 1, parent: 'node-a', up: true, size: 1024, free: 1024 }]
    };

    try {
      const overview = await loadLocalStorageDriverOverview({
        kubeContext: 'default',
        discoveredContextCount: 1,
        storageDrivers: {
          vitastor: {
            enabled: true,
            cli: { enabled: true, path: 'vitastor-cli' },
            profiles: [{
              context: '*', endpoints: [endpoint], prefix: '/vitastor', scheme: 'http', timeoutSeconds: 1,
              osdStaleSeconds: 30, auth: { username: '', password: '' }, tls: { caFile: '', certFile: '', keyFile: '' },
              metrics: { scheme: 'http', timeoutSeconds: 1, auth: { mode: 'none', username: '', password: '', bearerToken: '', headers: {} } }
            }]
          }
        }
      }, { driver: 'csi.vitastor.io' }, {
        execFile: async (_command, args) => JSON.stringify(payloads[args[0]]),
        discoverVitastorConfig: async () => ({ endpoints: [], prefix: '/vitastor', poolIds: [], evidence: [] })
      });

      expect(overview.driver.metricsSource).toBe('vitastor-cli');
      expect(overview.summary.monitors).toEqual({ up: 2, total: 2 });
      expect(overview.details.monitors.items).toEqual([
        { name: 'mon-a', role: 'master', status: 'up', address: '127.0.0.1' },
        { name: 'mon-b', role: 'standby', status: 'up', address: '127.0.0.2' }
      ]);
      expect(overview.summary.osd).toEqual({ up: 1, total: 1 });
      expect(overview.summary.pools).toBe(1);
      expect(overview.errors).toEqual([]);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('loads Vitastor OSD, pool, capacity, and IO data through the etcd v3 gateway', async () => {
    const records = [
      ['/vitastor/osd/state/1', { state: 'up' }],
      ['/vitastor/osd/stats/1', { used: 128, total: 1024, node: 'storage-a' }],
      ['/vitastor/config/pools', { pools: [{ id: 1, name: 'data', used: 128, total: 1024, objects: 4 }] }],
      ['/vitastor/stats', { op_stats: { read: { count: 12 }, write: { count: 7 } } }]
    ];
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v3/kv/range') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          kvs: records.map(([key, value]) => ({
            key: Buffer.from(String(key)).toString('base64'),
            value: Buffer.from(JSON.stringify(value)).toString('base64')
          }))
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [], metadata: {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');
    const endpoint = `http://127.0.0.1:${address.port}`;

    try {
      const overview = await loadLocalStorageDriverOverview({
        kubeContext: 'gateway',
        kubeConfig: {
          getCurrentCluster: () => ({ server: endpoint }),
          applyToFetchOptions: async (options) => options
        },
        storageDrivers: {
          vitastor: {
            enabled: true,
            cli: { enabled: false },
            profiles: [{
              context: '*',
              endpoints: [endpoint],
              prefix: '/vitastor',
              scheme: 'http',
              timeoutSeconds: 2,
              osdStaleSeconds: 30,
              auth: { username: '', password: '' },
              tls: { caFile: '', certFile: '', keyFile: '' },
              metrics: {
                scheme: 'http',
                timeoutSeconds: 1,
                auth: { mode: 'none', username: '', password: '', bearerToken: '', headers: {} }
              }
            }]
          }
        }
      }, { driver: 'csi.vitastor.io' });

      expect(overview.driver).toMatchObject({ name: 'Vitastor', status: 'healthy' });
      expect(overview.summary).toMatchObject({
        osd: { up: 1, total: 1 },
        pools: 1,
        capacity: { usedBytes: 128, totalBytes: 1024 }
      });
      expect(overview.io).toEqual({ readOps: 12, writeOps: 7 });
      expect(overview.details.osds.items[0]).toMatchObject({
        name: '1',
        node: 'storage-a',
        status: 'up'
      });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
