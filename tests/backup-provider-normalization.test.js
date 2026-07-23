import { describe, expect, test } from 'bun:test';
import {
  BACKUP_PROVIDER_IDS,
  BACKUP_RESOURCE_DEFINITIONS,
  buildUniversalBackupActivitySummary
} from '../src/shared/backup-activity.js';

describe('universal backup discovery', () => {
  test('publishes all supported providers', () => {
    expect(BACKUP_PROVIDER_IDS).toEqual([
      'velero',
      'oadp',
      'csi',
      'longhorn',
      'kasten',
      'trilio',
      'rancher',
      'k3s-etcd',
      'portworx'
    ]);
  });

  test('normalizes K3s etcd snapshots without exposing raw resources', () => {
    const definition = BACKUP_RESOURCE_DEFINITIONS.find((item) => item.parser === 'k3s-etcd-snapshot');
    const result = buildUniversalBackupActivitySummary({
      resources: [{
        definition,
        available: true,
        partial: false,
        items: [{
          metadata: { name: 'local-etcd-test-k1' },
          spec: {
            snapshotName: 'etcd-test',
            nodeName: 'test-k1',
            location: 'file:///var/lib/rancher/k3s/server/db/snapshots/etcd-test'
          },
          status: {
            creationTime: '2026-07-23T00:00:01Z',
            readyToUse: true,
            size: '13410336'
          }
        }]
      }],
      fetchedAt: '2026-07-23T12:00:00Z'
    });

    expect(result.detectedProviders[0].providerId).toBe('k3s-etcd');
    expect(result.snapshots.items[0]).toMatchObject({
      name: 'local-etcd-test-k1',
      nodeName: 'test-k1',
      sizeBytes: 13410336,
      normalizedStatus: 'completed'
    });
    expect(JSON.stringify(result)).not.toContain('readyToUse');
  });
});
