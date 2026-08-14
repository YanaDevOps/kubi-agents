import { describe, expect, test } from 'bun:test';
import {
  buildStorageProviderHealth,
  canonicalStorageProviderId,
  normalizeCSINode,
  normalizeCSIStorageCapacity,
  normalizeVolumeAttachment
} from '../src/shared/storage-health.js';

describe('universal CSI storage health', () => {
  test('groups Ceph CSI identities and reports current attachment state', () => {
    expect(canonicalStorageProviderId('rbd.csi.ceph.com')).toBe('rook-ceph');
    expect(canonicalStorageProviderId('cephfs.csi.ceph.com')).toBe('rook-ceph');
    const health = buildStorageProviderHealth({
      providerId: 'rook-ceph',
      driverIds: ['rbd.csi.ceph.com', 'cephfs.csi.ceph.com'],
      nodes: [{ metadata: { name: 'worker-a' } }],
      storageClasses: [{ name: 'ceph-block', provisioner: 'rbd.csi.ceph.com' }],
      csiNodes: [normalizeCSINode({ metadata: { name: 'worker-a' }, spec: { drivers: [{ name: 'rbd.csi.ceph.com' }] } })],
      volumeAttachments: [normalizeVolumeAttachment({
        metadata: { name: 'attachment-a' },
        spec: { attacher: 'rbd.csi.ceph.com', nodeName: 'worker-a', source: { persistentVolumeName: 'pv-a' } },
        status: { attached: false, attachError: { message: 'backend timeout' } }
      })],
      csiStorageCapacities: [normalizeCSIStorageCapacity({ metadata: { name: 'capacity-a', namespace: 'rook-ceph' }, storageClassName: 'ceph-block', capacity: '100Gi' })],
      pods: [{
        metadata: { name: 'csi-rbdplugin-a', namespace: 'rook-ceph' },
        spec: { containers: [{ name: 'csi-rbdplugin' }] },
        status: { phase: 'Running', containerStatuses: [{ ready: true }] }
      }],
      registrationAvailable: true
    });

    expect(health).toMatchObject({
      status: 'warning',
      registeredNodes: 1,
      failedAttachments: 1,
      readyPluginPods: 1,
      topologyCapacitySamples: 1
    });
  });
});
