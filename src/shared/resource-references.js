function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function strings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function metadata(resource) {
  const meta = record(resource?.metadata);
  return {
    name: text(meta.name),
    namespace: text(meta.namespace) || 'default'
  };
}

function referenceKey(kind, namespace, name) {
  return `${kind.toLowerCase()}:${namespace}/${name}`;
}

function addReference(target, seen, input) {
  if (!input.resourceName || !input.consumerName) return;
  const reference = {
    resourceKind: input.resourceKind,
    resourceName: input.resourceName,
    namespace: input.namespace,
    consumerKind: input.consumerKind,
    consumerName: input.consumerName,
    method: input.method,
    confidence: input.confidence || 'exact',
    ...(input.container ? { container: input.container } : {}),
    ...(input.variable ? { variable: input.variable } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(input.prefix ? { prefix: input.prefix } : {}),
    ...(input.volume ? { volume: input.volume } : {}),
    ...(input.argument ? { argument: input.argument } : {})
  };
  const key = JSON.stringify(reference);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(reference);
}

function argumentCandidates(values) {
  const result = [];
  const args = values.map(text).filter(Boolean);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current.startsWith('--') && current.includes('=')) {
      const separator = current.indexOf('=');
      const flag = current.slice(0, separator);
      const value = current.slice(separator + 1);
      if (value) result.push({ flag, value });
      continue;
    }
    if (current.startsWith('--') && index + 1 < args.length && !args[index + 1].startsWith('-')) {
      result.push({ flag: current, value: args[index + 1] });
      index += 1;
      continue;
    }
  }
  return result;
}

function inferredKinds(flag, namespace, name, known) {
  const normalizedFlag = flag.toLowerCase();
  const configMap = known.has(referenceKey('ConfigMap', namespace, name));
  const secret = known.has(referenceKey('Secret', namespace, name));
  if (normalizedFlag.includes('configmap') || normalizedFlag.includes('config-map')) return configMap ? ['ConfigMap'] : [];
  if (normalizedFlag.includes('secret')) return secret ? ['Secret'] : [];
  if (configMap !== secret) return [configMap ? 'ConfigMap' : 'Secret'];
  return [];
}

function collectSpecReferences(target, seen, specInput, consumer, known) {
  const spec = record(specInput);
  const base = {
    namespace: consumer.namespace,
    consumerKind: consumer.kind,
    consumerName: consumer.name
  };

  for (const pullSecret of records(spec.imagePullSecrets)) {
    addReference(target, seen, {
      ...base,
      resourceKind: 'Secret',
      resourceName: text(pullSecret.name),
      method: 'imagePullSecret'
    });
  }

  for (const volumeEntry of records(spec.volumes)) {
    const volume = record(volumeEntry);
    const volumeName = text(volume.name);
    const configMap = record(volume.configMap);
    const secret = record(volume.secret);
    addReference(target, seen, {
      ...base,
      resourceKind: 'ConfigMap',
      resourceName: text(configMap.name),
      method: 'volume',
      volume: volumeName
    });
    const typedSecretSources = [
      record(volume.csi).nodePublishSecretRef,
      record(volume.flexVolume).secretRef,
      record(volume.cephfs).secretRef,
      record(volume.rbd).secretRef,
      record(volume.iscsi).secretRef,
      record(volume.scaleIO).secretRef,
      record(volume.storageos).secretRef
    ];
    for (const secretSource of typedSecretSources) {
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(record(secretSource).name),
        method: 'volume',
        volume: volumeName
      });
    }
    addReference(target, seen, {
      ...base,
      resourceKind: 'Secret',
      resourceName: text(record(volume.azureFile).secretName),
      method: 'volume',
      volume: volumeName
    });
    addReference(target, seen, {
      ...base,
      resourceKind: 'Secret',
      resourceName: text(secret.secretName),
      method: 'volume',
      volume: volumeName
    });
    for (const sourceEntry of records(record(volume.projected).sources)) {
      const source = record(sourceEntry);
      addReference(target, seen, {
        ...base,
        resourceKind: 'ConfigMap',
        resourceName: text(record(source.configMap).name),
        method: 'projectedVolume',
        volume: volumeName
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(record(source.secret).name),
        method: 'projectedVolume',
        volume: volumeName
      });
    }
  }

  const containers = [
    ...records(spec.containers),
    ...records(spec.initContainers),
    ...records(spec.ephemeralContainers)
  ];
  for (const containerEntry of containers) {
    const container = record(containerEntry);
    const containerName = text(container.name);
    for (const envEntry of records(container.env)) {
      const env = record(envEntry);
      const valueFrom = record(env.valueFrom);
      const configMap = record(valueFrom.configMapKeyRef);
      const secret = record(valueFrom.secretKeyRef);
      addReference(target, seen, {
        ...base,
        resourceKind: 'ConfigMap',
        resourceName: text(configMap.name),
        method: 'env',
        container: containerName,
        variable: text(env.name),
        key: text(configMap.key)
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(secret.name),
        method: 'env',
        container: containerName,
        variable: text(env.name),
        key: text(secret.key)
      });
    }
    for (const envFromEntry of records(container.envFrom)) {
      const envFrom = record(envFromEntry);
      addReference(target, seen, {
        ...base,
        resourceKind: 'ConfigMap',
        resourceName: text(record(envFrom.configMapRef).name),
        method: 'envFrom',
        container: containerName,
        prefix: text(envFrom.prefix)
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(record(envFrom.secretRef).name),
        method: 'envFrom',
        container: containerName,
        prefix: text(envFrom.prefix)
      });
    }
    const candidates = [
      ...argumentCandidates(strings(container.command)),
      ...argumentCandidates(strings(container.args))
    ];
    for (const candidate of candidates) {
      for (const kind of inferredKinds(candidate.flag, consumer.namespace, candidate.value, known)) {
        addReference(target, seen, {
          ...base,
          resourceKind: kind,
          resourceName: candidate.value,
          method: 'argument',
          confidence: 'inferred',
          container: containerName,
          argument: candidate.flag || 'argument'
        });
      }
    }
  }
}

function workloadSpec(resource) {
  const spec = record(resource?.spec);
  const jobTemplateSpec = record(record(spec.jobTemplate).spec);
  const cronJobPodSpec = record(record(jobTemplateSpec.template).spec);
  if (Object.keys(cronJobPodSpec).length > 0) return cronJobPodSpec;
  return record(record(spec.template).spec);
}

export function collectResourceReferences(input) {
  const references = [];
  const seen = new Set();
  const known = new Set();
  for (const configMap of records(input.configMaps)) {
    const meta = metadata(configMap);
    if (meta.name) known.add(referenceKey('ConfigMap', meta.namespace, meta.name));
  }
  for (const secret of records(input.secrets)) {
    const meta = metadata(secret);
    if (meta.name) known.add(referenceKey('Secret', meta.namespace, meta.name));
  }

  for (const pod of records(input.pods)) {
    const meta = metadata(pod);
    collectSpecReferences(references, seen, record(pod.spec), { kind: 'Pod', ...meta }, known);
  }
  for (const workload of records(input.workloads)) {
    const meta = metadata(workload);
    const kind = text(workload.kind) || 'Workload';
    collectSpecReferences(references, seen, workloadSpec(workload), { kind, ...meta }, known);
  }
  for (const serviceAccount of records(input.serviceAccounts)) {
    const meta = metadata(serviceAccount);
    for (const secretEntry of records(serviceAccount.secrets)) {
      addReference(references, seen, {
        resourceKind: 'Secret', resourceName: text(secretEntry.name), namespace: meta.namespace,
        consumerKind: 'ServiceAccount', consumerName: meta.name, method: 'serviceAccountSecret'
      });
    }
    for (const secretEntry of records(serviceAccount.imagePullSecrets)) {
      addReference(references, seen, {
        resourceKind: 'Secret', resourceName: text(secretEntry.name), namespace: meta.namespace,
        consumerKind: 'ServiceAccount', consumerName: meta.name, method: 'serviceAccountImagePullSecret'
      });
    }
  }
  for (const ingress of records(input.ingresses)) {
    const meta = metadata(ingress);
    for (const tls of records(record(ingress.spec).tls)) {
      addReference(references, seen, {
        resourceKind: 'Secret', resourceName: text(tls.secretName), namespace: meta.namespace,
        consumerKind: 'Ingress', consumerName: meta.name, method: 'ingressTls'
      });
    }
  }

  return references;
}

export function referencedResourceKeys(references) {
  return new Set(records(references).map((item) => referenceKey(text(item.resourceKind), text(item.namespace) || 'default', text(item.resourceName))));
}

export function podRelatedResources(input) {
  const meta = metadata(input.pod);
  return collectResourceReferences({
    pods: [input.pod],
    configMaps: input.configMaps,
    secrets: input.secrets,
    workloads: [],
    serviceAccounts: [],
    ingresses: []
  }).filter((item) => item.consumerKind === 'Pod' && item.consumerName === meta.name && item.namespace === meta.namespace);
}
