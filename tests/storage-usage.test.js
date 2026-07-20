import { describe, expect, test } from 'bun:test';
import { namespacePath, parseNodeSummaryPVCUsage } from '../agent/src/kube.js';

describe('agent PVC usage', () => {
  test('maps the UI all scope to cluster-wide Kubernetes list paths', () => {
    expect(namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', 'all')).toBe('/api/v1/pods');
  });

  test('extracts kubelet PVC usage from both volume field variants', () => {
    expect(parseNodeSummaryPVCUsage({
      pods: [{
        podRef: { namespace: 'apps' },
        volume: [{ pvcRef: { name: 'data' }, usedBytes: 1024 }],
        volumes: [{ pvcRef: { namespace: 'apps', name: 'cache' }, usedBytes: 2048 }]
      }]
    })).toEqual(new Map([
      ['apps/data', 1024],
      ['apps/cache', 2048]
    ]));

    expect(parseNodeSummaryPVCUsage({
      pods: [{
        podRef: { namespace: 'apps', name: 'api-0' },
        volume: [{ name: 'storage', usedBytes: 4096 }]
      }]
    }, new Map([['apps/api-0/storage', 'apps/data']]))).toEqual(new Map([
      ['apps/data', 4096]
    ]));
  });
});
