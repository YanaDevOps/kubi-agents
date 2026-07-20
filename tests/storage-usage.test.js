import { describe, expect, test } from 'bun:test';
import { isReliablePVCUsageSample, namespacePath, parseNodeSummaryPVCUsage } from '../agent/src/kube.js';

describe('agent PVC usage', () => {
  test('maps the UI all scope to cluster-wide Kubernetes list paths', () => {
    expect(namespacePath('/api/v1/pods', '/api/v1/namespaces/:namespace/pods', 'all')).toBe('/api/v1/pods');
  });

  test('extracts kubelet PVC usage from both volume field variants', () => {
    expect(parseNodeSummaryPVCUsage({
      pods: [{
        podRef: { namespace: 'apps' },
        volume: [{ pvcRef: { name: 'data' }, usedBytes: 1024, capacityBytes: 8192 }],
        volumes: [{ pvcRef: { namespace: 'apps', name: 'cache' }, usedBytes: 2048, capacityBytes: 16384 }]
      }]
    })).toEqual(new Map([
      ['apps/data', { usedBytes: 1024, capacityBytes: 8192 }],
      ['apps/cache', { usedBytes: 2048, capacityBytes: 16384 }]
    ]));

    expect(parseNodeSummaryPVCUsage({
      pods: [{
        podRef: { namespace: 'apps', name: 'api-0' },
        volume: [{ name: 'storage', usedBytes: 4096, capacityBytes: 8192 }]
      }]
    }, new Map([['apps/api-0/storage', 'apps/data']]))).toEqual(new Map([
      ['apps/data', { usedBytes: 4096, capacityBytes: 8192 }]
    ]));
  });

  test('rejects node filesystem statistics attributed to a small local PVC', () => {
    const declared = 512 * 1024 * 1024;
    expect(isReliablePVCUsageSample({ usedBytes: 128 * 1024 * 1024, capacityBytes: declared }, declared)).toBe(true);
    expect(isReliablePVCUsageSample({ usedBytes: 17.6 * 1024 ** 3, capacityBytes: 31.3 * 1024 ** 3 }, declared)).toBe(false);
  });
});
