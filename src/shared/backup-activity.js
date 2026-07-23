export const BACKUP_PROVIDER_IDS = [
  'velero',
  'oadp',
  'csi',
  'longhorn',
  'kasten',
  'trilio',
  'rancher',
  'k3s-etcd',
  'portworx'
];

const PROVIDERS = {
  velero: 'Velero',
  oadp: 'OpenShift OADP',
  csi: 'Kubernetes CSI',
  longhorn: 'Longhorn',
  kasten: 'Veeam Kasten K10',
  trilio: 'Trilio',
  rancher: 'Rancher Backup Operator',
  'k3s-etcd': 'K3s / RKE2 etcd',
  portworx: 'Portworx / Stork'
};

function definition(providerId, parser, group, versions, resource, kind, namespaced = true) {
  return { providerId, providerName: PROVIDERS[providerId], parser, group, versions, resource, kind, namespaced };
}

export const BACKUP_RESOURCE_DEFINITIONS = [
  definition('oadp', 'oadp-detection', 'oadp.openshift.io', ['v1alpha1'], 'dataprotectionapplications', 'DataProtectionApplication'),
  definition('velero', 'velero-backup', 'velero.io', ['v1'], 'backups', 'Backup'),
  definition('velero', 'velero-restore', 'velero.io', ['v1'], 'restores', 'Restore'),
  definition('velero', 'velero-schedule', 'velero.io', ['v1'], 'schedules', 'Schedule'),
  definition('csi', 'csi-snapshot', 'snapshot.storage.k8s.io', ['v1', 'v1beta1'], 'volumesnapshots', 'VolumeSnapshot'),
  definition('csi', 'csi-snapshot-content', 'snapshot.storage.k8s.io', ['v1', 'v1beta1'], 'volumesnapshotcontents', 'VolumeSnapshotContent', false),
  definition('csi', 'csi-snapshot-class', 'snapshot.storage.k8s.io', ['v1', 'v1beta1'], 'volumesnapshotclasses', 'VolumeSnapshotClass', false),
  definition('longhorn', 'longhorn-backup', 'longhorn.io', ['v1beta2', 'v1beta1'], 'backups', 'Backup'),
  definition('longhorn', 'longhorn-system-backup', 'longhorn.io', ['v1beta2', 'v1beta1'], 'systembackups', 'SystemBackup'),
  definition('longhorn', 'longhorn-recurring-job', 'longhorn.io', ['v1beta2', 'v1beta1'], 'recurringjobs', 'RecurringJob'),
  definition('kasten', 'kasten-backup-action', 'actions.kio.kasten.io', ['v1alpha1'], 'backupactions', 'BackupAction'),
  definition('kasten', 'kasten-cluster-backup-action', 'actions.kio.kasten.io', ['v1alpha1'], 'clusterbackupactions', 'ClusterBackupAction', false),
  definition('kasten', 'kasten-restore-action', 'actions.kio.kasten.io', ['v1alpha1'], 'restoreactions', 'RestoreAction'),
  definition('kasten', 'kasten-batch-restore-action', 'actions.kio.kasten.io', ['v1alpha1'], 'batchrestoreactions', 'BatchRestoreAction'),
  definition('kasten', 'kasten-cluster-restore-action', 'actions.kio.kasten.io', ['v1alpha1'], 'clusterrestoreactions', 'ClusterRestoreAction', false),
  definition('kasten', 'kasten-policy', 'config.kio.kasten.io', ['v1alpha1'], 'policies', 'Policy'),
  definition('trilio', 'trilio-backup', 'triliovault.trilio.io', ['v1'], 'backups', 'Backup'),
  definition('trilio', 'trilio-cluster-backup', 'triliovault.trilio.io', ['v1'], 'clusterbackups', 'ClusterBackup', false),
  definition('trilio', 'trilio-restore', 'triliovault.trilio.io', ['v1'], 'restores', 'Restore'),
  definition('trilio', 'trilio-cluster-restore', 'triliovault.trilio.io', ['v1'], 'clusterrestores', 'ClusterRestore', false),
  definition('trilio', 'trilio-snapshot', 'triliovault.trilio.io', ['v1'], 'snapshots', 'Snapshot'),
  definition('trilio', 'trilio-cluster-snapshot', 'triliovault.trilio.io', ['v1'], 'clustersnapshots', 'ClusterSnapshot', false),
  definition('trilio', 'trilio-backup-plan', 'triliovault.trilio.io', ['v1'], 'backupplans', 'BackupPlan'),
  definition('trilio', 'trilio-cluster-backup-plan', 'triliovault.trilio.io', ['v1'], 'clusterbackupplans', 'ClusterBackupPlan', false),
  definition('rancher', 'rancher-backup', 'resources.cattle.io', ['v1'], 'backups', 'Backup'),
  definition('rancher', 'rancher-restore', 'resources.cattle.io', ['v1'], 'restores', 'Restore'),
  definition('k3s-etcd', 'k3s-etcd-snapshot', 'k3s.cattle.io', ['v1'], 'etcdsnapshotfiles', 'ETCDSnapshotFile', false),
  definition('portworx', 'portworx-backup', 'stork.libopenstorage.org', ['v1alpha1'], 'applicationbackups', 'ApplicationBackup'),
  definition('portworx', 'portworx-restore', 'stork.libopenstorage.org', ['v1alpha1'], 'applicationrestores', 'ApplicationRestore'),
  definition('portworx', 'portworx-schedule', 'stork.libopenstorage.org', ['v1alpha1'], 'applicationbackupschedules', 'ApplicationBackupSchedule')
];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function strings(value) {
  return list(value).filter((item) => typeof item === 'string');
}

function text(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function at(value, ...path) {
  let current = value;
  for (const part of path) current = record(current)[part];
  return current;
}

function metadata(item, clusterScoped = false) {
  const meta = record(item.metadata);
  return {
    name: text(meta.name) || 'Unknown',
    namespace: clusterScoped ? 'cluster' : text(meta.namespace) || 'default',
    createdAt: text(meta.creationTimestamp)
  };
}

function duration(startedAt, finishedAt) {
  const start = Date.parse(startedAt || '');
  const finish = Date.parse(finishedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return undefined;
  const seconds = Math.round((finish - start) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function normalizedStatus(value, paused = false) {
  if (paused) return 'paused';
  const status = String(value || '').toLowerCase();
  if (/fail|error|invalid|unavailable/.test(status)) return 'failed';
  if (/complete|completed|success|successful|ready|available/.test(status)) return 'completed';
  if (/running|progress|execut|active|upload|download/.test(status)) return 'running';
  if (/pending|new|waiting|queued|initial/.test(status)) return 'pending';
  return 'unknown';
}

function parseBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T|KB|MB|GB|TB)?$/i);
  if (!match) return undefined;
  const units = { ki: 1024, mi: 1024 ** 2, gi: 1024 ** 3, ti: 1024 ** 4, k: 1e3, m: 1e6, g: 1e9, t: 1e12, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
  return Math.round(Number(match[1]) * (units[(match[2] || '').toLowerCase()] || 1));
}

function sanitizeLocation(value) {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/([?&#](?:token|secret|key|password)=[^&#\s]*)/gi, '').slice(0, 512);
  }
}

function details(entries) {
  return entries
    .map(([label, value]) => ({ label, value: text(value) }))
    .filter((item) => item.value);
}

function base(def, item, clusterScoped = !def.namespaced) {
  const meta = metadata(item, clusterScoped);
  return {
    ...meta,
    providerId: def.providerId,
    providerName: def.providerName,
    resourceKind: def.kind,
    scope: clusterScoped ? 'cluster' : 'namespace'
  };
}

function veleroIssues(status) {
  return [
    ...strings(status.validationErrors).map((entry) => ({ tone: 'error', text: entry })),
    ...strings(status.warnings).map((entry) => ({ tone: 'warn', text: entry })),
    ...strings(status.errors).map((entry) => ({ tone: 'error', text: entry }))
  ];
}

function normalizeVeleroBackup(def, item) {
  const spec = record(item.spec);
  const status = record(item.status);
  const startedAt = text(status.startTimestamp);
  const finishedAt = text(status.completionTimestamp);
  const phase = text(status.phase) || 'Unknown';
  return {
    ...base(def, item),
    phase,
    status: phase,
    normalizedStatus: normalizedStatus(phase),
    startedAt,
    finishedAt,
    duration: duration(startedAt, finishedAt),
    ttl: text(spec.ttl),
    expiresAt: text(status.expiration),
    storageLocation: sanitizeLocation(spec.storageLocation),
    includedNamespaces: strings(spec.includedNamespaces),
    excludedNamespaces: strings(spec.excludedNamespaces),
    includedResources: strings(spec.includedResources),
    excludedResources: strings(spec.excludedResources),
    labelSelector: text(spec.labelSelector),
    snapshotVolumes: spec.snapshotVolumes === undefined ? undefined : String(spec.snapshotVolumes),
    volumeBackupMode: spec.defaultVolumesToFsBackup === true ? 'Filesystem' : undefined,
    uploaderType: text(spec.uploaderType),
    hooksCount: list(record(spec.hooks).resources).length,
    itemsBackedUp: number(status.itemsBackedUp),
    itemsTotal: number(status.itemsTotal),
    warnings: number(status.warnings) || 0,
    errors: number(status.errors) || 0,
    failureReason: text(status.failureReason),
    validationErrors: strings(status.validationErrors),
    issueMessages: veleroIssues(status),
    scheduleName: text(spec.scheduleName),
    progress: number(status.progress)
  };
}

function normalizeVeleroRestore(def, item) {
  const spec = record(item.spec);
  const status = record(item.status);
  const startedAt = text(status.startTimestamp);
  const finishedAt = text(status.completionTimestamp);
  const phase = text(status.phase) || 'Unknown';
  return {
    ...base(def, item),
    phase,
    status: phase,
    normalizedStatus: normalizedStatus(phase),
    startedAt,
    finishedAt,
    duration: duration(startedAt, finishedAt),
    backupName: text(spec.backupName),
    includedNamespaces: strings(spec.includedNamespaces),
    excludedNamespaces: strings(spec.excludedNamespaces),
    includedResources: strings(spec.includedResources),
    excludedResources: strings(spec.excludedResources),
    namespaceMapping: Object.entries(record(spec.namespaceMapping)).map(([key, value]) => `${key}:${String(value)}`),
    itemsTotal: number(status.itemsTotal),
    itemsRestored: number(status.itemsRestored),
    kopiaRestoresCompleted: number(status.kopiaRestoresCompleted),
    warnings: number(status.warnings) || 0,
    errors: number(status.errors) || 0,
    failureReason: text(status.failureReason),
    validationErrors: strings(status.validationErrors),
    issueMessages: veleroIssues(status),
    postRestoreHints: { ingressesRestored: 0, restoredHosts: [] }
  };
}

function normalizeVeleroSchedule(def, item) {
  const spec = record(item.spec);
  const template = record(spec.template);
  const paused = spec.paused === true;
  return {
    ...base(def, item),
    schedule: text(spec.schedule) || '-',
    paused,
    status: paused ? 'Paused' : 'Enabled',
    normalizedStatus: normalizedStatus(paused ? 'Paused' : 'Enabled', paused),
    ttl: text(template.ttl),
    storageLocation: sanitizeLocation(template.storageLocation),
    templateIncludedNamespaces: strings(template.includedNamespaces),
    templateExcludedNamespaces: strings(template.excludedNamespaces),
    templateIncludedResources: strings(template.includedResources),
    templateExcludedResources: strings(template.excludedResources),
    recentBackups: []
  };
}

function genericActivity(def, item, kind) {
  const spec = record(item.spec);
  const status = record(item.status);
  const phase = text(status.phase) || text(status.status) || text(status.state) || 'Unknown';
  const startedAt = text(status.startTimestamp) || text(status.startTime) || text(status.startedAt);
  const finishedAt = text(status.completionTimestamp) || text(status.endTime) || text(status.completedAt);
  const common = {
    ...base(def, item),
    phase,
    status: phase,
    normalizedStatus: normalizedStatus(phase),
    startedAt,
    finishedAt,
    duration: duration(startedAt, finishedAt),
    progress: number(status.progress) ?? number(status.percentageCompletion),
    failureReason: text(status.failureReason) || text(at(status, 'error', 'message')) || text(status.error),
    warnings: 0,
    errors: normalizedStatus(phase) === 'failed' ? 1 : 0,
    validationErrors: [],
    issueMessages: [],
    includedNamespaces: [],
    excludedNamespaces: [],
    includedResources: [],
    excludedResources: []
  };
  if (kind === 'restore') common.postRestoreHints = { ingressesRestored: 0, restoredHosts: [] };
  return common;
}

function normalizeLonghorn(def, item) {
  const spec = record(item.spec);
  const status = record(item.status);
  if (def.parser === 'longhorn-recurring-job') {
    const paused = spec.isGroup === false && spec.task === 'snapshot-delete';
    return {
      ...base(def, item),
      schedule: text(spec.cron) || '-',
      paused,
      status: paused ? 'Paused' : 'Enabled',
      normalizedStatus: normalizedStatus(paused ? 'Paused' : 'Enabled', paused),
      retention: text(spec.retain),
      details: details([['Task', spec.task], ['Concurrency', spec.concurrency]]),
      recentBackups: []
    };
  }
  const activity = genericActivity(def, item, 'backup');
  return {
    ...activity,
    sourceRef: text(spec.volumeName) ? `Volume/${spec.volumeName}` : undefined,
    targetRef: text(spec.snapshotName) ? `Snapshot/${spec.snapshotName}` : undefined,
    storageLocation: sanitizeLocation(status.url),
    sizeBytes: parseBytes(status.size),
    details: details([['Snapshot', spec.snapshotName], ['Volume', spec.volumeName]])
  };
}

function normalizeKasten(def, item) {
  if (def.parser === 'kasten-policy') {
    const spec = record(item.spec);
    const retention = record(spec.retention);
    return {
      ...base(def, item),
      schedule: text(spec.frequency) || '-',
      paused: spec.paused === true,
      status: spec.paused === true ? 'Paused' : text(at(item, 'status', 'validation')) || 'Enabled',
      normalizedStatus: normalizedStatus(spec.paused ? 'Paused' : at(item, 'status', 'validation'), spec.paused === true),
      retention: Object.entries(retention).map(([key, value]) => `${key}: ${value}`).join(', '),
      recentBackups: []
    };
  }
  const kind = def.parser.includes('restore') ? 'restore' : 'backup';
  const activity = genericActivity(def, item, kind);
  const spec = record(item.spec);
  const subject = record(spec.subject);
  const restorePoint = record(at(item, 'status', 'restorePoint'));
  return {
    ...activity,
    scheduleName: text(record(item.metadata).labels?.['k10.kasten.io/policyName']),
    sourceRef: text(subject.name) ? `Application/${text(subject.namespace) || activity.namespace}/${subject.name}` : undefined,
    targetRef: text(restorePoint.name) ? `RestorePoint/${text(restorePoint.namespace) || activity.namespace}/${restorePoint.name}` : undefined
  };
}

function trilioPlanName(spec) {
  const plan = record(spec.backupPlan);
  return text(plan.name);
}

function normalizeTrilio(def, item) {
  const spec = record(item.spec);
  if (def.parser.includes('backup-plan')) {
    const cron = at(spec, 'backupConfig', 'schedulePolicy', 'fullBackupCron', 'schedule');
    return {
      ...base(def, item),
      schedule: text(cron) || '-',
      paused: spec.paused === true,
      status: spec.paused ? 'Paused' : text(at(item, 'status', 'status')) || 'Enabled',
      normalizedStatus: normalizedStatus(spec.paused ? 'Paused' : at(item, 'status', 'status'), spec.paused === true),
      recentBackups: []
    };
  }
  const kind = def.parser.includes('restore') ? 'restore' : def.parser.includes('snapshot') ? 'snapshot' : 'backup';
  const activity = genericActivity(def, item, kind);
  const source = record(spec.source);
  const backup = record(source.backup);
  return {
    ...activity,
    scheduleName: trilioPlanName(spec),
    backupName: text(backup.name),
    sourceRef: kind === 'snapshot' && trilioPlanName(spec)
      ? `BackupPlan/${text(record(spec.backupPlan).namespace) || activity.namespace}/${trilioPlanName(spec)}`
      : undefined
  };
}

function normalizeRancher(def, item) {
  const spec = record(item.spec);
  if (def.parser === 'rancher-backup' && text(spec.schedule)) {
    return {
      ...base(def, item),
      schedule: text(spec.schedule),
      paused: spec.paused === true,
      status: spec.paused ? 'Paused' : text(at(item, 'status', 'status')) || 'Enabled',
      normalizedStatus: normalizedStatus(spec.paused ? 'Paused' : at(item, 'status', 'status'), spec.paused === true),
      retention: text(spec.retentionCount),
      lastBackupName: text(at(item, 'status', 'lastSnapshot')),
      nextRunAt: text(at(item, 'status', 'nextSnapshot')),
      recentBackups: []
    };
  }
  const kind = def.parser === 'rancher-restore' ? 'restore' : 'backup';
  return {
    ...genericActivity(def, item, kind),
    storageLocation: sanitizeLocation(at(item, 'status', 'filename')),
    backupName: text(spec.backupFilename),
    details: details([['Resource set', spec.resourceSetName], ['Retention', spec.retentionCount]])
  };
}

function normalizeK3s(def, item) {
  const spec = record(item.spec);
  const status = record(item.status);
  const ready = status.readyToUse === true;
  const activity = {
    ...base(def, item, true),
    phase: ready ? 'Ready' : 'Pending',
    status: ready ? 'Ready' : 'Pending',
    normalizedStatus: ready ? 'completed' : 'pending',
    createdAt: text(status.creationTime) || text(record(item.metadata).creationTimestamp),
    sourceRef: text(spec.snapshotName) ? `etcd/${spec.snapshotName}` : undefined,
    nodeName: text(spec.nodeName),
    storageLocation: sanitizeLocation(spec.location),
    sizeBytes: parseBytes(status.size),
    details: details([['Node', spec.nodeName], ['Location', sanitizeLocation(spec.location)]])
  };
  return activity;
}

function normalizePortworx(def, item) {
  const spec = record(item.spec);
  if (def.parser === 'portworx-schedule') {
    return {
      ...base(def, item),
      schedule: text(spec.schedulePolicyName) ? `Policy: ${spec.schedulePolicyName}` : '-',
      paused: spec.suspend === true,
      status: spec.suspend ? 'Paused' : text(at(item, 'status', 'status')) || 'Enabled',
      normalizedStatus: normalizedStatus(spec.suspend ? 'Paused' : at(item, 'status', 'status'), spec.suspend === true),
      storageLocation: sanitizeLocation(spec.backupLocation),
      recentBackups: []
    };
  }
  const kind = def.parser === 'portworx-restore' ? 'restore' : 'backup';
  return {
    ...genericActivity(def, item, kind),
    storageLocation: sanitizeLocation(spec.backupLocation),
    backupName: text(spec.backupName)
  };
}

function normalizeCsi(def, item, lookups) {
  const spec = record(item.spec);
  const status = record(item.status);
  const content = lookups.csiContents.get(`${text(record(spec.source).volumeSnapshotContentName) || text(status.boundVolumeSnapshotContentName) || ''}`)
    || lookups.csiContentBySnapshot.get(`${text(record(item.metadata).namespace) || 'default'}/${text(record(item.metadata).name)}`);
  const className = text(spec.volumeSnapshotClassName) || text(record(content?.spec).volumeSnapshotClassName);
  const snapshotClass = lookups.csiClasses.get(className || '');
  const driver = text(record(content?.spec).driver) || text(snapshotClass?.driver);
  const ready = status.readyToUse === true;
  const pvc = text(record(spec.source).persistentVolumeClaimName);
  return {
    ...base(def, item),
    phase: ready ? 'Ready' : 'Pending',
    status: ready ? 'Ready' : 'Pending',
    normalizedStatus: ready ? 'completed' : 'pending',
    createdAt: text(status.creationTime) || text(record(item.metadata).creationTimestamp),
    sourceRef: pvc ? `PersistentVolumeClaim/${text(record(item.metadata).namespace) || 'default'}/${pvc}` : undefined,
    targetRef: text(status.boundVolumeSnapshotContentName),
    storageClass: className,
    driver,
    deletionPolicy: text(content?.spec?.deletionPolicy) || text(snapshotClass?.deletionPolicy),
    sizeBytes: parseBytes(status.restoreSize),
    details: details([['Snapshot class', className], ['CSI driver', driver], ['Deletion policy', text(content?.spec?.deletionPolicy) || text(snapshotClass?.deletionPolicy)]])
  };
}

function normalizeResource(def, item, lookups) {
  if (def.parser === 'velero-backup') return { bucket: 'backups', item: normalizeVeleroBackup(def, item) };
  if (def.parser === 'velero-restore') return { bucket: 'restores', item: normalizeVeleroRestore(def, item) };
  if (def.parser === 'velero-schedule') return { bucket: 'schedules', item: normalizeVeleroSchedule(def, item) };
  if (def.parser === 'csi-snapshot') return { bucket: 'snapshots', item: normalizeCsi(def, item, lookups) };
  if (def.parser.startsWith('longhorn-')) {
    return { bucket: def.parser === 'longhorn-recurring-job' ? 'schedules' : 'backups', item: normalizeLonghorn(def, item) };
  }
  if (def.parser.startsWith('kasten-')) {
    const bucket = def.parser === 'kasten-policy' ? 'schedules' : def.parser.includes('restore') ? 'restores' : 'backups';
    return { bucket, item: normalizeKasten(def, item) };
  }
  if (def.parser.startsWith('trilio-')) {
    const bucket = def.parser.includes('backup-plan') ? 'schedules' : def.parser.includes('restore') ? 'restores' : def.parser.includes('snapshot') ? 'snapshots' : 'backups';
    return { bucket, item: normalizeTrilio(def, item) };
  }
  if (def.parser.startsWith('rancher-')) {
    const normalized = normalizeRancher(def, item);
    const bucket = def.parser === 'rancher-backup' && text(record(item.spec).schedule) ? 'schedules' : def.parser === 'rancher-restore' ? 'restores' : 'backups';
    return { bucket, item: normalized };
  }
  if (def.parser === 'k3s-etcd-snapshot') return { bucket: 'snapshots', item: normalizeK3s(def, item) };
  if (def.parser.startsWith('portworx-')) {
    const bucket = def.parser === 'portworx-schedule' ? 'schedules' : def.parser === 'portworx-restore' ? 'restores' : 'backups';
    return { bucket, item: normalizePortworx(def, item) };
  }
  return null;
}

function resourceList(items, fetchedAt, issues, partial) {
  return { items, fetchedAt, issues, partial, availability: partial ? 'degraded' : 'available' };
}

function itemTime(item) {
  return Date.parse(item.startedAt || item.createdAt || item.finishedAt || '') || 0;
}

/**
 * @param {{
 *   resources?: any[],
 *   fetchedAt?: string,
 *   namespaceScope?: string | null,
 *   issues?: any[],
 *   partial?: boolean
 * }} input
 */
export function buildUniversalBackupActivitySummary({
  resources = [],
  fetchedAt = new Date().toISOString(),
  namespaceScope = null,
  issues = [],
  partial = false
} = {}) {
  const oadpDetected = resources.some((entry) => entry?.definition?.parser === 'oadp-detection' && list(entry.items).length > 0);
  const csiClassResources = resources.filter((entry) => entry?.definition?.parser === 'csi-snapshot-class');
  const csiContentResources = resources.filter((entry) => entry?.definition?.parser === 'csi-snapshot-content');
  const csiClasses = new Map();
  const csiContents = new Map();
  const csiContentBySnapshot = new Map();

  for (const item of csiClassResources.flatMap((entry) => list(entry.items))) {
    csiClasses.set(text(record(item.metadata).name) || '', item);
  }
  for (const item of csiContentResources.flatMap((entry) => list(entry.items))) {
    csiContents.set(text(record(item.metadata).name) || '', item);
    const ref = record(record(item.spec).volumeSnapshotRef);
    if (text(ref.name)) csiContentBySnapshot.set(`${text(ref.namespace) || 'default'}/${ref.name}`, item);
  }

  const buckets = { backups: [], restores: [], snapshots: [], schedules: [] };
  const providerState = new Map(BACKUP_PROVIDER_IDS.map((providerId) => [providerId, { available: false, denied: false, partial: false, resources: 0 }]));
  const outputIssues = [...issues];
  let runtimePartial = partial;

  for (const entry of resources) {
    const original = entry?.definition;
    if (!original) continue;
    const providerId = oadpDetected && original.providerId === 'velero' ? 'oadp' : original.providerId;
    const def = providerId === original.providerId ? original : { ...original, providerId, providerName: PROVIDERS[providerId] };
    const state = providerState.get(providerId);
    if (state) {
      state.available ||= entry.available !== false;
      state.denied ||= entry.denied === true;
      state.partial ||= entry.partial === true;
      state.resources += list(entry.items).length;
    }
    runtimePartial ||= entry.partial === true || entry.denied === true;
    if (entry.denied === true) {
      outputIssues.push({
        code: 'forbidden',
        section: 'backup-activity',
        message: `${def.providerName} resources are present but the runtime lacks read permission.`,
        retryable: false
      });
    }
    if (def.parser === 'oadp-detection' || def.parser === 'csi-snapshot-class' || def.parser === 'csi-snapshot-content') continue;
    if (!def.namespaced && namespaceScope) continue;
    for (const item of list(entry.items)) {
      const itemNamespace = text(record(item.metadata).namespace);
      if (def.namespaced && namespaceScope && itemNamespace && itemNamespace !== namespaceScope) continue;
      const normalized = normalizeResource(def, item, { csiClasses, csiContents, csiContentBySnapshot });
      if (normalized) buckets[normalized.bucket].push(normalized.item);
    }
  }

  for (const values of Object.values(buckets)) values.sort((left, right) => itemTime(right) - itemTime(left) || left.name.localeCompare(right.name));
  for (const schedule of buckets.schedules) {
    if (schedule.providerId !== 'velero' && schedule.providerId !== 'oadp') continue;
    const recent = buckets.backups
      .filter((backup) => backup.providerId === schedule.providerId && backup.namespace === schedule.namespace && (backup.scheduleName === schedule.name || backup.name.startsWith(`${schedule.name}-`)))
      .slice(0, 5);
    schedule.recentBackups = recent.map(({ name, phase, startedAt, finishedAt }) => ({ name, phase, startedAt, finishedAt }));
    schedule.lastBackupName = recent[0]?.name;
    schedule.lastBackupStatus = recent[0]?.phase;
    schedule.lastBackupStartedAt = recent[0]?.startedAt;
  }

  const providerCoverage = BACKUP_PROVIDER_IDS.map((providerId) => {
    const state = providerState.get(providerId);
    const effective = providerId === 'velero' && oadpDetected ? { available: false, denied: false, partial: false, resources: 0 } : state;
    return {
      providerId,
      providerName: PROVIDERS[providerId],
      status: effective.denied ? 'permission-denied' : effective.available ? (effective.partial ? 'partial' : 'available') : 'not-detected',
      resources: effective.resources
    };
  });
  const detectedProviders = providerCoverage
    .filter((provider) => provider.status === 'available' || provider.status === 'partial')
    .map(({ providerId, providerName, status, resources }) => ({ providerId, providerName, status, resources }));
  const failedBackups = buckets.backups.filter((item) => item.normalizedStatus === 'failed').length;
  const failedRestores = buckets.restores.filter((item) => item.normalizedStatus === 'failed').length;
  const failedSnapshots = buckets.snapshots.filter((item) => item.normalizedStatus === 'failed').length;
  const running = Object.values(buckets).flat().filter((item) => item.normalizedStatus === 'running').length;

  return {
    fetchedAt,
    issues: outputIssues,
    partial: runtimePartial,
    availability: runtimePartial ? 'degraded' : 'available',
    namespaceScope,
    detected: detectedProviders.length > 0,
    message: detectedProviders.length > 0
      ? undefined
      : 'No supported backup or snapshot resources were detected, or the runtime cannot read them.',
    supportedProviders: BACKUP_PROVIDER_IDS.map((providerId) => ({ providerId, providerName: PROVIDERS[providerId] })),
    detectedProviders,
    providerCoverage,
    volumeBackupModes: [],
    versions: {},
    summary: {
      providers: detectedProviders.length,
      backups: buckets.backups.length,
      restores: buckets.restores.length,
      snapshots: buckets.snapshots.length,
      schedules: buckets.schedules.length,
      running,
      failed: failedBackups + failedRestores + failedSnapshots,
      failedBackups,
      failedRestores,
      failedSnapshots,
      pausedSchedules: buckets.schedules.filter((item) => item.paused).length
    },
    backups: resourceList(buckets.backups, fetchedAt, outputIssues, runtimePartial),
    restores: resourceList(buckets.restores, fetchedAt, outputIssues, runtimePartial),
    snapshots: resourceList(buckets.snapshots, fetchedAt, outputIssues, runtimePartial),
    schedules: resourceList(buckets.schedules, fetchedAt, outputIssues, runtimePartial)
  };
}
