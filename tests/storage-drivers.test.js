import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import { loadLocalStorageDriverOverview } from '../agent/src/storage-drivers.js';

describe('agent storage driver metrics', () => {
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
