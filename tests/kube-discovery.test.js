import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { discoverLocalAccessCandidates, fetchKubeJson, resolveAgentRuntimeConfigForSelector } from '../agent/src/kube.js';

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
    const server = http.createServer((_request, response) => {
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
        getCurrentCluster: () => ({ server: `http://127.0.0.1:${address.port}` }),
        applyToFetchOptions: async (options) => options
      }, '/version')).toEqual({ gitVersion: 'v1.test' });
    } finally {
      globalThis.fetch = previousFetch;
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
});
