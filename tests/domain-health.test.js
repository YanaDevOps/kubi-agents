import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import { loadLocalDomainHealth } from '../agent/src/kube.js';

describe('agent domain health', () => {
  test('links cert-manager Certificate state to an Ingress host', async () => {
    const certificate = fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url), 'utf8');
    const privateKey = fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
      const resources = {
        '/apis/networking.k8s.io/v1/ingresses': [{
          metadata: { name: 'galene', namespace: 'app-galene' },
          spec: {
            tls: [{ hosts: ['metest2.dcxv.com'], secretName: 'galene-tls' }],
            rules: [{ host: 'metest2.dcxv.com', http: { paths: [] } }]
          }
        }],
        '/api/v1/services': [],
        '/api/v1/endpoints': [],
        '/apis/discovery.k8s.io/v1/endpointslices': [],
        '/apis/cert-manager.io/v1/certificates': [{
          metadata: { name: 'galene-tls', namespace: 'app-galene' },
          spec: {
            dnsNames: ['metest2.dcxv.com'],
            secretName: 'galene-tls',
            issuerRef: { name: 'letsencrypt' }
          },
          status: {
            conditions: [{ type: 'Ready', status: 'False', reason: 'Failed' }]
          }
        }],
        '/apis/acme.cert-manager.io/v1/orders': [],
        '/apis/acme.cert-manager.io/v1/challenges': []
      };
      response.writeHead(resources[pathname] ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: resources[pathname] ?? [], metadata: {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const response = await loadLocalDomainHealth({
        kubeConfig: {
          getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
          applyToFetchOptions: async (options) => ({ ...options, agent })
        }
      });
      expect(response.certManagerAvailable).toBe(true);
      expect(response.certificates.items).toHaveLength(1);
      expect(response.hosts.items[0]).toMatchObject({ host: 'metest2.dcxv.com', status: 'critical' });
      expect(response.issuesList.items.some((item) => item.objectRefs?.some((ref) => ref.kind === 'Certificate'))).toBe(true);
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
