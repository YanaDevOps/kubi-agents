import { describe, expect, test } from 'bun:test';
import { DELIVERY_RESOURCE_DEFINITIONS, buildDeliveryActivitySummary } from '../src/shared/delivery-activity.js';

function definition(providerId, kind) {
  const value = DELIVERY_RESOURCE_DEFINITIONS.find((item) => item.providerId === providerId && item.kind === kind);
  if (!value) throw new Error(`Missing definition for ${providerId}/${kind}`);
  return value;
}

describe('delivery activity normalization', () => {
  test('sanitizes Argo CD source credentials and exposes sync state', () => {
    const result = buildDeliveryActivitySummary({
      fetchedAt: '2026-08-22T12:00:00.000Z',
      resources: [{
        definition: definition('argocd', 'Application'),
        available: true,
        items: [{
          metadata: { name: 'app', namespace: 'argocd' },
          spec: { source: { repoURL: 'https://robot:secret@git.example.com/app.git?token=hidden' } },
          status: { sync: { status: 'Synced', revision: 'abc' }, health: { status: 'Healthy' } }
        }]
      }],
      pods: [],
      customResourceDefinitions: [{ metadata: { name: 'applications.argoproj.io' } }]
    });

    expect(result.deployments.items[0].sourceRef).toBe('https://git.example.com/app.git');
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
