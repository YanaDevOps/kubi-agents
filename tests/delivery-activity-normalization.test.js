import { describe, expect, test } from 'bun:test';
import { DELIVERY_RESOURCE_DEFINITIONS, buildDeliveryActivitySummary } from '../src/shared/delivery-activity.js';

function definition(providerId, kind) {
  const value = DELIVERY_RESOURCE_DEFINITIONS.find((item) => item.providerId === providerId && item.kind === kind);
  if (!value) throw new Error(`Missing definition for ${providerId}/${kind}`);
  return value;
}

describe('delivery activity normalization', () => {
  test('sanitizes Argo CD sources and exposes project consumers and sync policy', () => {
    const result = buildDeliveryActivitySummary({
      fetchedAt: '2026-08-22T12:00:00.000Z',
      resources: [
        {
          definition: definition('argocd', 'Application'),
          available: true,
          items: [{
            metadata: { name: 'app', namespace: 'tenant-apps' },
            spec: {
              project: 'default',
              sources: [
                { repoURL: 'https://robot:secret@git.example.com/app.git?token=hidden', ref: 'base', targetRevision: 'main' },
                { repoURL: 'https://git.example.com/overrides.git', helm: { releaseName: 'app', parameters: [{ name: 'image.tag', value: 'secret-value' }] } }
              ],
              syncPolicy: { automated: { prune: true, selfHeal: true } }
            },
            status: {
              sync: { status: 'Synced', revision: 'abc' },
              health: { status: 'Healthy' },
              conditions: [{ type: 'OrphanedResourceWarning', message: 'Application has 2 orphaned resources' }]
            }
          }]
        },
        {
          definition: definition('argocd', 'AppProject'),
          available: true,
          items: [{
            metadata: { name: 'default', namespace: 'argocd' },
            spec: { sourceRepos: ['*'], destinations: [{ namespace: 'app', server: 'https://kubernetes.default.svc' }] }
          }]
        }
      ],
      pods: [],
      customResourceDefinitions: [{ metadata: { name: 'applications.argoproj.io' } }]
    });

    expect(result.deployments.items[0].sourceRef).toBe('https://git.example.com/app.git');
    expect(result.deployments.items[0].sources).toHaveLength(2);
    expect(result.deployments.items[0].syncPolicyDetails.automated).toMatchObject({ enabled: true, prune: true, selfHeal: true });
    expect(result.deployments.items[0].orphanedResources).toMatchObject({ count: 2, detailsAvailable: false });
    expect(result.projects.items[0]).toMatchObject({ usedByCount: 1, unused: false });
    expect(result.sources.items).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.summary).toMatchObject({ deployments: 1, healthy: 1 });
  });

  test('normalizes the latest failed Tekton run as a current issue', () => {
    const result = buildDeliveryActivitySummary({
      fetchedAt: '2026-08-22T12:00:00.000Z',
      resources: [{
        definition: definition('tekton', 'PipelineRun'),
        available: true,
        items: [{
          metadata: { name: 'release-1', namespace: 'ci' },
          spec: { pipelineRef: { name: 'release' } },
          status: { startTime: '2026-08-22T10:00:00.000Z', conditions: [{ type: 'Succeeded', status: 'False', reason: 'TaskRunFailed' }] }
        }]
      }],
      pods: [],
      customResourceDefinitions: []
    });

    expect(result.pipelines.items).toHaveLength(1);
    expect(result.issuesList.items[0].message).toContain('TaskRunFailed');
  });
});
