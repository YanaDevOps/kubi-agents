import { classifySystemConfigMap } from './system-configmap.js';

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

function referencedName(value) {
  return text(value) || text(record(value).name);
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
    ...(typeof input.optional === 'boolean' ? { optional: input.optional } : {}),
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

  const serviceAccountName = text(spec.serviceAccountName || spec.serviceAccount);
  if (serviceAccountName) {
    addReference(target, seen, {
      ...base,
      resourceKind: 'ServiceAccount',
      resourceName: serviceAccountName,
      method: 'workloadServiceAccount'
    });
  }

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
      volume: volumeName,
      optional: configMap.optional === true
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
      volume: volumeName,
      optional: secret.optional === true
    });
    for (const sourceEntry of records(record(volume.projected).sources)) {
      const source = record(sourceEntry);
      addReference(target, seen, {
        ...base,
        resourceKind: 'ConfigMap',
        resourceName: text(record(source.configMap).name),
        method: 'projectedVolume',
        volume: volumeName,
        optional: record(source.configMap).optional === true
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(record(source.secret).name),
        method: 'projectedVolume',
        volume: volumeName,
        optional: record(source.secret).optional === true
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
        key: text(configMap.key),
        optional: configMap.optional === true
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(secret.name),
        method: 'env',
        container: containerName,
        variable: text(env.name),
        key: text(secret.key),
        optional: secret.optional === true
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
        prefix: text(envFrom.prefix),
        optional: record(envFrom.configMapRef).optional === true
      });
      addReference(target, seen, {
        ...base,
        resourceKind: 'Secret',
        resourceName: text(record(envFrom.secretRef).name),
        method: 'envFrom',
        container: containerName,
        prefix: text(envFrom.prefix),
        optional: record(envFrom.secretRef).optional === true
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

const REFERENCE_PROVIDER_CRDS = new Set([
  'vaultauths.secrets.hashicorp.com',
  'vaultauthglobals.secrets.hashicorp.com',
  'vaultconnections.secrets.hashicorp.com',
  'vaultstaticsecrets.secrets.hashicorp.com',
  'vaultdynamicsecrets.secrets.hashicorp.com',
  'vaultpkisecrets.secrets.hashicorp.com',
  'certificates.cert-manager.io',
  'issuers.cert-manager.io',
  'clusterissuers.cert-manager.io',
  'backupstoragelocations.velero.io',
  'volumesnapshotlocations.velero.io',
  'ingressroutes.traefik.io',
  'middlewares.traefik.io',
  'tlsstores.traefik.io',
  'ingressroutes.traefik.containo.us',
  'middlewares.traefik.containo.us',
  'tlsstores.traefik.containo.us',
  'gateways.gateway.networking.k8s.io'
]);

export function referenceProviderResourceDescriptors(customResourceDefinitions) {
  return records(customResourceDefinitions).flatMap((crd) => {
    const meta = metadata(crd);
    if (!REFERENCE_PROVIDER_CRDS.has(meta.name)) return [];
    const spec = record(crd.spec);
    const names = record(spec.names);
    const versions = records(spec.versions);
    const selectedVersion = versions.find((item) => item.storage === true && item.served !== false)
      || versions.find((item) => item.served !== false);
    const version = text(selectedVersion?.name) || text(spec.version);
    const group = text(spec.group);
    const plural = text(names.plural);
    if (!group || !version || !plural) return [];
    return [{
      name: meta.name,
      group,
      version,
      plural,
      namespaced: text(spec.scope) !== 'Cluster'
    }];
  });
}

function clusterResourceNamespace(workloads) {
  for (const workload of records(workloads)) {
    for (const container of records(workloadSpec(workload).containers)) {
      for (const candidate of argumentCandidates([...strings(container.command), ...strings(container.args)])) {
        if (candidate.flag === '--cluster-resource-namespace' && candidate.value) return candidate.value;
      }
    }
  }
  return 'cert-manager';
}

function addControllerReference(target, seen, resource, input) {
  const meta = metadata(resource);
  addReference(target, seen, {
    namespace: input.namespace || meta.namespace,
    consumerKind: text(resource.kind) || input.consumerKind || 'ControllerResource',
    consumerName: meta.name,
    confidence: 'exact',
    ...input
  });
}

function collectBindingReferences(target, seen, bindings) {
  for (const binding of records(bindings)) {
    const meta = metadata(binding);
    for (const subject of records(binding.subjects)) {
      if (text(subject.kind) !== 'ServiceAccount') continue;
      addReference(target, seen, {
        resourceKind: 'ServiceAccount',
        resourceName: text(subject.name),
        namespace: text(subject.namespace) || meta.namespace,
        consumerKind: text(binding.kind) || 'RoleBinding',
        consumerName: meta.name,
        method: 'rbacSubject'
      });
    }
  }
}

function collectProviderReferences(target, seen, input) {
  const providerResources = records(input.providerResources);
  const certManagerNamespace = clusterResourceNamespace(records(input.workloads));

  for (const resource of providerResources) {
    const kind = text(resource.kind);
    const apiVersion = text(resource.apiVersion);
    const spec = record(resource.spec);
    const meta = metadata(resource);

    if (kind === 'VaultAuth' || kind === 'VaultAuthGlobal') {
      const kubernetes = record(spec.kubernetes);
      const aws = record(spec.aws);
      addControllerReference(target, seen, resource, { resourceKind: 'ServiceAccount', resourceName: text(kubernetes.serviceAccount), method: 'vaultAuthServiceAccount' });
      addControllerReference(target, seen, resource, { resourceKind: 'ServiceAccount', resourceName: text(aws.irsaServiceAccount), method: 'vaultAuthServiceAccount' });
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: referencedName(record(spec.appRole).secretRef), method: 'controllerSecret' });
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: referencedName(aws.secretRef), method: 'controllerSecret' });
    }

    if (kind === 'VaultConnection') {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(spec.caCertSecretRef), method: 'controllerSecret' });
    }

    if (['VaultStaticSecret', 'VaultDynamicSecret', 'VaultPKISecret'].includes(kind)) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.destination).name), method: 'managedOutput' });
    }

    if (kind === 'Certificate' && apiVersion.startsWith('cert-manager.io/')) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(spec.secretName), method: 'managedOutput' });
    }

    if ((kind === 'Issuer' || kind === 'ClusterIssuer') && apiVersion.startsWith('cert-manager.io/')) {
      const issuerNamespace = kind === 'ClusterIssuer' ? certManagerNamespace : meta.namespace;
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(record(spec.acme).privateKeySecretRef).name), namespace: issuerNamespace, method: 'controllerSecret' });
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.ca).secretName), namespace: issuerNamespace, method: 'controllerSecret' });
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: referencedName(record(record(record(spec.vault).auth).appRole).secretRef), namespace: issuerNamespace, method: 'controllerSecret' });
    }

    if (kind === 'BackupStorageLocation' && apiVersion.startsWith('velero.io/')) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.credential).name), method: 'controllerSecret' });
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(record(spec.objectStorage).caCertRef).name), method: 'controllerSecret' });
    }

    if (kind === 'VolumeSnapshotLocation' && apiVersion.startsWith('velero.io/')) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.credential).name), method: 'controllerSecret' });
    }

    if (kind === 'IngressRoute' && /traefik\.(io|containo\.us)\//.test(apiVersion)) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.tls).secretName), method: 'ingressTls' });
    }

    if (kind === 'Middleware' && /traefik\.(io|containo\.us)\//.test(apiVersion)) {
      for (const secretName of [record(spec.basicAuth).secret, record(spec.digestAuth).secret, record(record(spec.forwardAuth).tls).caSecret, record(record(spec.forwardAuth).tls).certSecret]) {
        addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(secretName), method: 'controllerSecret' });
      }
    }

    if (kind === 'TLSStore' && /traefik\.(io|containo\.us)\//.test(apiVersion)) {
      addControllerReference(target, seen, resource, { resourceKind: 'Secret', resourceName: text(record(spec.defaultCertificate).secretName), method: 'ingressTls' });
    }

    if (kind === 'Gateway' && apiVersion.startsWith('gateway.networking.k8s.io/')) {
      for (const listener of records(spec.listeners)) {
        for (const certificateRef of records(record(listener.tls).certificateRefs)) {
          if (text(certificateRef.kind || 'Secret') !== 'Secret') continue;
          addControllerReference(target, seen, resource, {
            resourceKind: 'Secret',
            resourceName: text(certificateRef.name),
            namespace: text(certificateRef.namespace) || meta.namespace,
            method: 'ingressTls'
          });
        }
      }
    }
  }

  const workloads = records(input.workloads);
  const argoNamespaces = new Set(workloads.filter((item) => /(^|-)argocd($|-)/i.test(metadata(item).name)).map((item) => metadata(item).namespace));
  const vsoNamespaces = new Set(workloads.filter((item) => /vault-secrets-operator/i.test(metadata(item).name)).map((item) => metadata(item).namespace));
  const veleroNamespaces = new Set(workloads.filter((item) => /(^|-)velero($|-)/i.test(metadata(item).name)).map((item) => metadata(item).namespace));

  for (const configMap of records(input.configMaps)) {
    const meta = metadata(configMap);
    const labels = record(record(configMap).metadata).labels;
    const argoNames = new Set(['argocd-cm', 'argocd-rbac-cm', 'argocd-cmd-params-cm', 'argocd-tls-certs-cm', 'argocd-ssh-known-hosts-cm']);
    if (argoNamespaces.has(meta.namespace) && (argoNames.has(meta.name) || text(record(labels)['app.kubernetes.io/part-of']) === 'argocd')) {
      addReference(target, seen, { resourceKind: 'ConfigMap', resourceName: meta.name, namespace: meta.namespace, consumerKind: 'ArgoCD', consumerName: 'controller', method: 'controllerConfig', confidence: 'exact' });
    }
    if (vsoNamespaces.has(meta.namespace) && /vault-secrets-operator-manager-config$/.test(meta.name)) {
      addReference(target, seen, { resourceKind: 'ConfigMap', resourceName: meta.name, namespace: meta.namespace, consumerKind: 'VaultSecretsOperator', consumerName: 'controller', method: 'controllerConfig', confidence: 'exact' });
    }
    for (const owner of records(record(record(configMap).metadata).ownerReferences)) {
      addReference(target, seen, { resourceKind: 'ConfigMap', resourceName: meta.name, namespace: meta.namespace, consumerKind: text(owner.kind) || 'Controller', consumerName: text(owner.name), method: 'managedOutput', confidence: 'exact' });
    }
  }

  for (const secret of records(input.secrets)) {
    const meta = metadata(secret);
    const labels = record(record(secret).metadata).labels;
    const ownerReferences = records(record(record(secret).metadata).ownerReferences);
    const argoSecretType = text(record(labels)['argocd.argoproj.io/secret-type']);
    const argoNames = new Set(['argocd-secret', 'argocd-server-tls', 'argocd-repo-server-tls', 'argocd-dex-server-tls']);
    if (argoNamespaces.has(meta.namespace) && (argoNames.has(meta.name) || Boolean(argoSecretType))) {
      addReference(target, seen, { resourceKind: 'Secret', resourceName: meta.name, namespace: meta.namespace, consumerKind: 'ArgoCD', consumerName: argoSecretType || 'controller', method: 'controllerSecret', confidence: 'exact' });
    }
    if (vsoNamespaces.has(meta.namespace) && /-cc-storage-hmac-key$/.test(meta.name)) {
      addReference(target, seen, { resourceKind: 'Secret', resourceName: meta.name, namespace: meta.namespace, consumerKind: 'VaultSecretsOperator', consumerName: 'client-cache', method: 'controllerSecret', confidence: 'exact' });
    }
    if (veleroNamespaces.has(meta.namespace) && meta.name === 'velero-repo-credentials') {
      addReference(target, seen, { resourceKind: 'Secret', resourceName: meta.name, namespace: meta.namespace, consumerKind: 'Velero', consumerName: 'backup-repository', method: 'controllerSecret', confidence: 'exact' });
    }
    for (const owner of ownerReferences) {
      addReference(target, seen, { resourceKind: 'Secret', resourceName: meta.name, namespace: meta.namespace, consumerKind: text(owner.kind) || 'Controller', consumerName: text(owner.name), method: 'managedOutput', confidence: 'exact' });
    }
  }
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

  collectBindingReferences(references, seen, [...records(input.roleBindings), ...records(input.clusterRoleBindings)]);
  collectProviderReferences(references, seen, input);

  return references;
}

export function referencedResourceKeys(references) {
  return new Set(records(references).map((item) => referenceKey(text(item.resourceKind), text(item.namespace) || 'default', text(item.resourceName))));
}

export function podRelatedResources(input) {
  const meta = metadata(input.pod);
  const configMapClassifications = new Map(records(input.configMaps).map((configMap) => {
    const configMapMeta = metadata(configMap);
    return [referenceKey('ConfigMap', configMapMeta.namespace, configMapMeta.name), classifySystemConfigMap(configMap)];
  }));
  const systemSecrets = new Set(records(input.secrets).flatMap((secret) => {
    const secretMeta = metadata(secret);
    return text(secret.type) === 'kubernetes.io/service-account-token'
      ? [referenceKey('Secret', secretMeta.namespace, secretMeta.name)]
      : [];
  }));
  const knownResources = new Set([
    ...records(input.configMaps).map((item) => {
      const itemMeta = metadata(item);
      return referenceKey('ConfigMap', itemMeta.namespace, itemMeta.name);
    }),
    ...records(input.secrets).map((item) => {
      const itemMeta = metadata(item);
      return referenceKey('Secret', itemMeta.namespace, itemMeta.name);
    }),
    ...records(input.serviceAccounts).map((item) => {
      const itemMeta = metadata(item);
      return referenceKey('ServiceAccount', itemMeta.namespace, itemMeta.name);
    })
  ]);
  return collectResourceReferences({
    pods: [input.pod],
    configMaps: input.configMaps,
    secrets: input.secrets,
    workloads: [],
    serviceAccounts: [],
    ingresses: []
  })
    .filter((item) => item.consumerKind === 'Pod' && item.consumerName === meta.name && item.namespace === meta.namespace)
    .map((item) => {
      const inventoryComplete = item.resourceKind === 'Secret'
        ? input.secretsComplete !== false
        : item.resourceKind === 'ServiceAccount'
          ? input.serviceAccountsComplete !== false
          : input.configMapsComplete !== false;
      const targetState = knownResources.has(referenceKey(item.resourceKind, item.namespace, item.resourceName))
        ? 'present'
        : inventoryComplete ? 'missing' : 'unknown';
      if (item.resourceKind === 'Secret' && systemSecrets.has(referenceKey('Secret', item.namespace, item.resourceName))) {
        return { ...item, targetState, systemManaged: true, systemReason: 'service-account-token' };
      }
      if (item.resourceKind !== 'ConfigMap') return { ...item, targetState };
      const classification = configMapClassifications.get(referenceKey('ConfigMap', item.namespace, item.resourceName));
      return classification?.systemManaged
        ? { ...item, targetState, systemManaged: true, systemReason: classification.systemReason }
        : { ...item, targetState };
    });
}
