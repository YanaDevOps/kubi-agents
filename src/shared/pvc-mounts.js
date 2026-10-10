// Which pod mounts each PVC, where, and which CSI backend serves a PV. Shared by agent and browser-direct storage.

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' && value ? value : undefined);

/** @returns {Map<string, Array<{ pod: string; node?: string; ownerKind?: string; ownerName?: string; mountPath?: string; readOnly?: boolean }>>} */
export function collectPvcMounts(pods) {
  const mounts = new Map();
  for (const pod of list(pods)) {
    const meta = record(pod.metadata);
    const phase = String(record(pod.status).phase || '').toLowerCase();
    if (meta.deletionTimestamp || phase === 'succeeded' || phase === 'failed') continue;
    const spec = record(pod.spec);
    const owner = list(meta.ownerReferences).find((entry) => record(entry).controller) || list(meta.ownerReferences)[0];
    const ownerKind = text(record(owner).kind);
    const ownerName = ownerKind === 'ReplicaSet' ? text(record(owner).name)?.replace(/-[a-z0-9]{5,10}$/, '') : text(record(owner).name);
    for (const volume of list(spec.volumes)) {
      const claim = text(record(record(volume).persistentVolumeClaim).claimName);
      if (!claim) continue;
      const mount = [...list(spec.containers), ...list(spec.initContainers)].flatMap((container) => list(record(container).volumeMounts)).find((entry) => record(entry).name === record(volume).name);
      const key = `${text(meta.namespace) || 'default'}/${claim}`;
      const entries = mounts.get(key) || [];
      entries.push({ pod: text(meta.name) || '', node: text(spec.nodeName), ownerKind: ownerKind === 'ReplicaSet' ? 'Deployment' : ownerKind, ownerName, mountPath: text(record(mount).mountPath), readOnly: record(mount).readOnly === true || undefined });
      mounts.set(key, entries);
    }
  }
  return mounts;
}

/** CSI backend of a PersistentVolume: driver, handle and pool when the driver exposes one. */
export function persistentVolumeBackend(pv) {
  const csi = record(record(record(pv).spec).csi);
  if (!text(csi.driver)) return undefined;
  const attributes = record(csi.volumeAttributes);
  const pool = text(attributes.pool) || text(attributes.poolName) || text(attributes.storagePool) || text(attributes.pool_id);
  return { driver: csi.driver, volumeHandle: text(csi.volumeHandle), ...(pool ? { pool } : {}) };
}
