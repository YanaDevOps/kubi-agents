import { describe, expect, test } from 'bun:test';
import { parseNodeSummaryPVCUsage } from '../agent/src/kube.js';

describe('agent PVC usage', () => {
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
  });
});
