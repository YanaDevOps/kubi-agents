function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function quantityBytes(value) {
  const match = String(value || '').trim().match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const binary = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const decimal = { K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6 };
  return amount * (binary[match[2]] || decimal[match[2]] || 1);
}

export function canonicalStorageProviderId(value) {
  const source = text(value, 'unknown').toLowerCase();
  if (source.includes('rbd.csi.ceph.com') || source.includes('cephfs.csi.ceph.com') || source === 'ceph' || source === 'rook-ceph') {
    return 'rook-ceph';
  }
  if (source.includes('vitastor')) return 'csi.vitastor.io';
  if (source.includes('longhorn')) return 'driver.longhorn.io';
  if (source.includes('openebs') || source.includes('mayastor')) return 'openebs';
  if (source.includes('portworx') || source.includes('pxd.openstorage.org')) return 'portworx';
  return source;
}

export function storageProviderName(value) {
  const lower = canonicalStorageProviderId(value);
  if (lower === 'rook-ceph') return 'Rook / Ceph';
  if (lower.includes('ebs.csi.aws.com')) return 'AWS EBS CSI';
  if (lower.includes('efs.csi.aws.com')) return 'AWS EFS CSI';
  if (lower.includes('pd.csi.storage.gke.io')) return 'GCE Persistent Disk CSI';
  if (lower.includes('filestore.csi.storage.gke.io')) return 'GCE Filestore CSI';
  if (lower.includes('disk.csi.azure.com')) return 'Azure Disk CSI';
  if (lower.includes('file.csi.azure.com')) return 'Azure File CSI';
  if (lower.includes('vitastor')) return 'Vitastor';
  if (lower.includes('longhorn')) return 'Longhorn';
  if (lower === 'openebs') return 'OpenEBS';
  if (lower === 'portworx') return 'Portworx';
  if (lower.includes('nfs')) return 'NFS';
  if (lower.includes('local-path')) return 'Local Path Provisioner';
  if (lower.includes('no-provisioner')) return 'Local Persistent Volumes';
  return text(value, 'Unknown storage provider');
}

export function normalizeCSINode(recordValue) {
  const source = record(recordValue);
  const metadata = record(source.metadata);
  const spec = record(source.spec);
  return {
    name: text(metadata.name, 'unknown'),
    drivers: records(spec.drivers).map((driverValue) => {
      const driver = record(driverValue);
      const allocatable = record(driver.allocatable);
      const count = Number(allocatable.count);
      return {
        name: text(driver.name, 'unknown'),
        nodeId: text(driver.nodeID),
        topologyKeys: Array.isArray(driver.topologyKeys) ? driver.topologyKeys.filter((item) => typeof item === 'string') : [],
        ...(Number.isFinite(count) ? { allocatableCount: count } : {})
      };
    }),
    createdAt: text(metadata.creationTimestamp) || undefined
  };
}

export function normalizeVolumeAttachment(recordValue) {
  const source = record(recordValue);
  const metadata = record(source.metadata);
  const spec = record(source.spec);
  const status = record(source.status);
  const sourceRef = record(spec.source);
  const attachError = record(status.attachError);
  const detachError = record(status.detachError);
  return {
    name: text(metadata.name, 'unknown'),
    driver: text(spec.attacher, 'unknown'),
    nodeName: text(spec.nodeName, 'unknown'),
    persistentVolumeName: text(sourceRef.persistentVolumeName),
    attached: status.attached === true,
    attachError: text(attachError.message),
    attachErrorAt: text(attachError.time),
    detachError: text(detachError.message),
    detachErrorAt: text(detachError.time),
    createdAt: text(metadata.creationTimestamp) || undefined
  };
}

export function normalizeCSIStorageCapacity(recordValue) {
  const source = record(recordValue);
  const metadata = record(source.metadata);
  const nodeTopology = record(source.nodeTopology);
  const matchLabels = record(nodeTopology.matchLabels);
  const matchExpressions = records(nodeTopology.matchExpressions).map((expressionValue) => {
    const expression = record(expressionValue);
    return {
      key: text(expression.key),
      operator: text(expression.operator),
      values: Array.isArray(expression.values) ? expression.values.filter((item) => typeof item === 'string') : []
    };
  });
  const capacity = text(source.capacity);
  const maximumVolumeSize = text(source.maximumVolumeSize);
  return {
    name: text(metadata.name, 'unknown'),
    namespace: text(metadata.namespace, 'default'),
    storageClassName: text(source.storageClassName),
    capacity,
    capacityBytes: quantityBytes(capacity),
    maximumVolumeSize,
    maximumVolumeSizeBytes: quantityBytes(maximumVolumeSize),
    topology: {
      matchLabels: Object.fromEntries(Object.entries(matchLabels).filter(([, item]) => typeof item === 'string')),
      matchExpressions
    },
    createdAt: text(metadata.creationTimestamp) || undefined
  };
}

export function storageProviderCapabilities(providerId) {
  const id = canonicalStorageProviderId(providerId);
  const backendMetrics = ['csi.vitastor.io', 'rook-ceph', 'driver.longhorn.io', 'openebs', 'portworx'].includes(id);
  return {
    kubernetesInventory: true,
    nodeRegistration: !id.includes('no-provisioner') && !id.includes('local-path'),
    attachments: !id.includes('no-provisioner') && !id.includes('local-path'),
    topologyCapacity: true,
    backendMetrics
  };
}

function providerPodAliases(providerId) {
  if (providerId === 'rook-ceph') return ['csi-rbdplugin', 'csi-cephfsplugin', 'rook-ceph-csi'];
  if (providerId === 'csi.vitastor.io') return ['csi-vitastor', 'vitastor-csi'];
  if (providerId === 'driver.longhorn.io') return ['longhorn-csi-plugin'];
  if (providerId === 'openebs') return ['openebs', 'mayastor', 'io-engine', 'lvm-localpv', 'zfs-localpv'];
  if (providerId === 'portworx') return ['portworx', 'px-cluster', 'px-storage', 'pxd'];
  return [];
}

function matchingCSIPluginPods(providerId, driverIds, pods) {
  const aliases = providerPodAliases(providerId);
  return (pods || []).flatMap((podValue) => {
    const pod = record(podValue);
    const metadata = record(pod.metadata);
    const spec = record(pod.spec);
    const status = record(pod.status);
    if (metadata.deletionTimestamp) return [];
    const containers = records(spec.containers);
    const identity = JSON.stringify({
      name: metadata.name,
      namespace: metadata.namespace,
      labels: metadata.labels,
      containers: containers.map((container) => ({ name: container.name, image: container.image, args: container.args, env: container.env }))
    }).toLowerCase();
    const exactDriverMatch = [...driverIds].some((driverId) => driverId !== 'unknown' && identity.includes(driverId));
    const aliasMatch = aliases.some((alias) => identity.includes(alias));
    if (!exactDriverMatch && !aliasMatch) return [];
    const statuses = records(status.containerStatuses);
    const totalContainers = statuses.length || containers.length;
    const readyContainers = statuses.filter((container) => container.ready === true).length;
    const phase = text(status.phase, 'Unknown');
    return [{
      namespace: text(metadata.namespace, 'default'),
      name: text(metadata.name, 'unknown'),
      nodeName: text(spec.nodeName),
      phase,
      ready: phase.toLowerCase() === 'running' && totalContainers > 0 && readyContainers === totalContainers,
      readyContainers,
      totalContainers
    }];
  });
}

export function buildStorageProviderHealth(input) {
  const providerId = canonicalStorageProviderId(input.providerId);
  const driverIds = new Set((input.driverIds || [input.providerId]).map((item) => String(item || '').toLowerCase()));
  const storageClassNames = new Set(
    (input.storageClasses || [])
      .filter((item) => canonicalStorageProviderId(item.provisioner) === providerId)
      .map((item) => item.name)
  );
  const registrations = (input.csiNodes || []).flatMap((node) =>
    (node.drivers || [])
      .filter((driver) => driverIds.has(String(driver.name || '').toLowerCase()))
      .map((driver) => ({ nodeName: node.name, ...driver }))
  );
  const registeredNodeNames = new Set(registrations.map((item) => item.nodeName));
  const attachments = (input.volumeAttachments || []).filter((item) => driverIds.has(String(item.driver || '').toLowerCase()));
  const capacities = (input.csiStorageCapacities || []).filter((item) => storageClassNames.has(item.storageClassName));
  const pluginPods = matchingCSIPluginPods(providerId, driverIds, input.pods || []);
  const issues = [];

  for (const attachment of attachments) {
    if (attachment.attachError) {
      issues.push({
        code: 'attach_error',
        severity: 'warning',
        title: 'Volume attachment failed',
        message: attachment.attachError,
        attachmentName: attachment.name,
        nodeName: attachment.nodeName,
        persistentVolumeName: attachment.persistentVolumeName
      });
    }
    if (attachment.detachError) {
      issues.push({
        code: 'detach_error',
        severity: 'warning',
        title: 'Volume detach failed',
        message: attachment.detachError,
        attachmentName: attachment.name,
        nodeName: attachment.nodeName,
        persistentVolumeName: attachment.persistentVolumeName
      });
    }
    if (input.registrationAvailable && attachment.nodeName && !registeredNodeNames.has(attachment.nodeName)) {
      issues.push({
        code: 'driver_not_registered',
        severity: 'warning',
        title: 'CSI driver is not registered on the attachment node',
        message: `${attachment.driver} is not reported by CSINode ${attachment.nodeName}.`,
        attachmentName: attachment.name,
        nodeName: attachment.nodeName,
        persistentVolumeName: attachment.persistentVolumeName
      });
    }
  }

  for (const pod of pluginPods) {
    if (!pod.ready && !['succeeded', 'completed'].includes(pod.phase.toLowerCase())) {
      issues.push({
        code: 'plugin_not_ready',
        severity: 'warning',
        title: 'CSI plugin Pod is not ready',
        message: `${pod.namespace}/${pod.name} is ${pod.phase} with ${pod.readyContainers}/${pod.totalContainers} containers ready.`,
        podName: pod.name,
        namespace: pod.namespace,
        nodeName: pod.nodeName
      });
    }
  }

  const failedAttachments = attachments.filter((item) => Boolean(item.attachError || item.detachError)).length;
  const attachedVolumes = attachments.filter((item) => item.attached).length;
  const pendingAttachments = attachments.filter((item) => !item.attached && !item.attachError && !item.detachError).length;
  const capabilities = storageProviderCapabilities(providerId);
  const hasHealthSignal = registrations.length > 0 || attachments.length > 0 || capacities.length > 0;

  return {
    status: issues.length > 0 ? 'warning' : hasHealthSignal ? 'healthy' : 'unknown',
    issues,
    capabilities,
    registeredNodes: registrations.length ? registeredNodeNames.size : 0,
    knownNodes: Array.isArray(input.nodes) ? input.nodes.length : 0,
    attachedVolumes,
    totalAttachments: attachments.length,
    pendingAttachments,
    failedAttachments,
    readyPluginPods: pluginPods.filter((item) => item.ready).length,
    totalPluginPods: pluginPods.length,
    topologyCapacitySamples: capacities.length,
    registrations,
    attachments,
    capacities,
    pluginPods
  };
}
