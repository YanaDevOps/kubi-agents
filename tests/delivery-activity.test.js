import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import { loadLocalDeliveryActivity } from '../agent/src/kube.js';

describe('agent delivery activity', () => {
  test('loads selected Argo CD activity without cluster-wide pod or CRD lists', async () => {
    const certificate = fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url), 'utf8');
    const privateKey = fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const requestedPaths = [];
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      const pathname = new URL(request.url || '/', 'https://localhost').pathname;
      requestedPaths.push(pathname);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (pathname === '/apis/argoproj.io/v1alpha1/applications') {
        response.end(JSON.stringify({
          items: [{
            metadata: { name: 'kubi', namespace: 'argocd' },
            spec: { source: { repoURL: 'https://git.example.com/kubi.git' } },
            status: { sync: { status: 'Synced', revision: 'abc123' }, health: { status: 'Healthy' } }
          }],
          metadata: {}
        }));
        return;
      }
      if (pathname === '/api/v1/namespaces/argocd/pods') {
        response.end(JSON.stringify({
          items: [{ metadata: { name: 'argocd-application-controller-0', namespace: 'argocd' }, status: { phase: 'Running' }, spec: {} }],
          metadata: {}
        }));
        return;
      }
      if (pathname === '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/applications.argoproj.io') {
        response.end(JSON.stringify({ metadata: { name: 'applications.argoproj.io' }, spec: { group: 'argoproj.io' } }));
        return;
      }
      response.end(JSON.stringify({ items: [], metadata: {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const response = await loadLocalDeliveryActivity({
        kubeConfig: {
          getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
          applyToFetchOptions: async (options) => ({ ...options, agent })
        }
      }, null, 'argocd');
      expect(response.summary).toMatchObject({ total: 1, healthy: 1 });
      expect(response.detectedProviders[0]).toMatchObject({ providerId: 'argocd', active: true });
      expect(requestedPaths).toContain('/api/v1/namespaces/argocd/pods');
      expect(requestedPaths).not.toContain('/api/v1/pods');
      expect(requestedPaths).not.toContain('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
