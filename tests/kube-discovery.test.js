import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverLocalAccessCandidates, resolveAgentRuntimeConfigForSelector } from '../agent/src/kube.js';

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
