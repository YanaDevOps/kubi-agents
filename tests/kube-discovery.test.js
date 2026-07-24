import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRuntimeSecretInventory,
  discoverLocalAccessCandidates,
  fetchKubeJson,
  fetchKubeText,
  resolveAgentRuntimeConfigForSelector
} from '../agent/src/kube.js';

const kubeconfig = (server = 'https://shared.invalid') => `apiVersion: v1
kind: Config
clusters:
  - name: shared-cluster
    cluster:
      server: ${server}
users:
  - name: shared-user
    user:
      token: token
contexts:
  - name: shared-context
    context:
      cluster: shared-cluster
      user: shared-user
current-context: shared-context
`;

describe('kubeconfig source merge', () => {
  test('uses kubeconfig-aware Node transport instead of global fetch', async () => {
    const certificate = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url)), 'utf8');
    const privateKey = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url)), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    const server = https.createServer({ cert: certificate, key: privateKey }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ gitVersion: 'v1.test' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('global fetch must not handle agent Kubernetes requests');
    };

    try {
      expect(await fetchKubeJson({
        getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
        applyToFetchOptions: async (options) => ({ ...options, agent })
      }, '/version')).toEqual({ gitVersion: 'v1.test' });
    } finally {
      agent.destroy();
      globalThis.fetch = previousFetch;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('negotiates Kubernetes logs without a text/plain-only Accept header', async () => {
    const certificate = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url)), 'utf8');
    const privateKey = fs.readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url)), 'utf8');
    const agent = new https.Agent({ ca: certificate });
    let receivedAccept = '';
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      receivedAccept = request.headers.accept || '';
      if (receivedAccept !== '*/*') {
        response.writeHead(406);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('booted\nready\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start.');

    try {
      const logs = await fetchKubeText({
        getCurrentCluster: () => ({ server: `https://127.0.0.1:${address.port}` }),
        applyToFetchOptions: async (options) => ({ ...options, agent })
      }, '/api/v1/namespaces/default/pods/web/log?tailLines=2');
      expect(receivedAccept).toBe('*/*');
      expect(logs).toBe('booted\nready\n');
    } finally {
      agent.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('deduplicates identical records while blocking conflicting records', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubi-agent-merge-'));
    const firstPath = path.join(tempDir, 'first.yaml');
    const secondPath = path.join(tempDir, 'second.yaml');
    const previousKubeconfig = process.env.KUBECONFIG;
    fs.writeFileSync(firstPath, kubeconfig());
    fs.writeFileSync(secondPath, kubeconfig());
    process.env.KUBECONFIG = secondPath;

    try {
      const runtimeConfig = { kubeconfigPath: firstPath };
      const candidates = discoverLocalAccessCandidates(runtimeConfig);
      const candidate = candidates.find((entry) => entry.sourceContextName === 'shared-context');
      expect(candidates.filter((entry) => entry.sourceContextName === 'shared-context')).toHaveLength(1);
      expect(candidate?.recommendedMode).toBe('agent');
      expect(
        resolveAgentRuntimeConfigForSelector(runtimeConfig, {
          contextName: 'shared-context',
          clusterFingerprint: candidate?.clusterFingerprint
        }).kubeConfig?.getCurrentCluster()?.server
      ).toBe('https://shared.invalid');

      fs.writeFileSync(secondPath, kubeconfig('https://conflicting.invalid'));
      const conflicting = discoverLocalAccessCandidates(runtimeConfig).find(
        (entry) => entry.sourceContextName === 'shared-context'
      );
      expect(conflicting).toMatchObject({
        recommendedMode: 'none',
        directSupportState: 'invalid',
        directSupportReason: 'ambiguous_source'
      });
      expect(() =>
        resolveAgentRuntimeConfigForSelector(runtimeConfig, { contextName: 'shared-context' })
      ).toThrow('ambiguous');
    } finally {
      if (previousKubeconfig === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = previousKubeconfig;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reports active Pod and owning Workload Secret references without values', () => {
    const inventory = buildRuntimeSecretInventory(
      [{
        metadata: { name: 'kubi-saas-env', namespace: 'kubi-saas' },
        type: 'Opaque',
        data: { SESSION_SECRET: 'never-return-this-value' }
      }],
      [{
        metadata: {
          name: 'kubi-saas-0',
          namespace: 'kubi-saas',
          ownerReferences: [{ kind: 'StatefulSet', name: 'kubi-saas' }]
        },
        status: { phase: 'Running' },
        spec: {
          containers: [{
            name: 'app',
            envFrom: [{ secretRef: { name: 'kubi-saas-env' } }]
          }]
        }
      }],
      [],
      [],
      '2026-07-24T00:00:00.000Z',
      null
    );

    const secret = inventory.secrets.items[0];
    expect(secret.references).toMatchObject({ total: 2, pods: 1, workloads: 1 });
    expect(secret.referencedBy.map((reference) => reference.kind)).toEqual(['Pod', 'Workload']);
    expect(JSON.stringify(secret)).not.toContain('never-return-this-value');
  });
});
