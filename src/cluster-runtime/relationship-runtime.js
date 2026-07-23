function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asRecordArray(value) {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)).filter(Boolean) : [];
}

function asStringRecord(value) {
  const record = asRecord(value);
  if (!record) return {};

  return Object.entries(record).reduce((current, [key, entry]) => {
    if (typeof entry === 'string') {
      current[key] = entry;
    }
    return current;
  }, {});
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function metadataFor(record) {
  const metadata = asRecord(record.metadata);
  return {
    name: stringOrUndefined(metadata?.name) || 'unknown',
    namespace: stringOrUndefined(metadata?.namespace) || 'default',
    createdAt: stringOrUndefined(metadata?.creationTimestamp),
    labels: asStringRecord(metadata?.labels),
    annotations: asStringRecord(metadata?.annotations)
  };
}

function buildAvailability(issues, partial) {
  return issues.length === 0 && !partial ? 'available' : 'degraded';
}

function buildResourceList(items, fetchedAt, partial = false, issues = []) {
  return {
    items,
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial)
  };
}

function sortByName(items, fields) {
  return [...items].sort((left, right) => {
    for (const field of fields) {
      const leftValue = field.split('.').reduce((current, key) => (current && current[key] !== undefined ? current[key] : ''), left);
      const rightValue = field
        .split('.')
        .reduce((current, key) => (current && current[key] !== undefined ? current[key] : ''), right);
      if (leftValue !== rightValue) {
        return String(leftValue).localeCompare(String(rightValue));
      }
    }
    return 0;
  });
}

function uniqueBy(items, keyBuilder) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyBuilder(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeRule(record) {
  return {
    verbs: stringArray(record.verbs).sort(),
    resources: stringArray(record.resources).sort(),
    apiGroups: stringArray(record.apiGroups).sort(),
    resourceNames: stringArray(record.resourceNames).sort(),
    nonResourceUrls: stringArray(record.nonResourceURLs ?? record.nonResourceUrls).sort()
  };
}

function ruleIdentity(rule) {
  return [
    rule.verbs.join('|'),
    rule.resources.join('|'),
    rule.apiGroups.join('|'),
    rule.resourceNames.join('|'),
    rule.nonResourceUrls.join('|')
  ].join('::');
}

function isWildcardRule(rule) {
  return (
    rule.verbs.includes('*') ||
    rule.resources.includes('*') ||
    rule.apiGroups.includes('*') ||
    rule.nonResourceUrls.includes('*')
  );
}

const DANGEROUS_RESOURCES = new Set([
  '*',
  'secrets',
  'nodes',
  'nodes/proxy',
  'roles',
  'clusterroles',
  'rolebindings',
  'clusterrolebindings',
  'serviceaccounts/token',
  'pods/exec',
  'pods/portforward',
  'validatingwebhookconfigurations',
  'mutatingwebhookconfigurations'
]);

const DANGEROUS_VERBS = new Set(['*', 'bind', 'escalate', 'impersonate', 'delete', 'patch', 'update', 'create']);

function isDangerousRule(rule) {
  return (
    isWildcardRule(rule) ||
    rule.verbs.some((verb) => DANGEROUS_VERBS.has(verb)) ||
    rule.resources.some((resource) => DANGEROUS_RESOURCES.has(resource)) ||
    rule.nonResourceUrls.some((value) => value === '*' || value.startsWith('/'))
  );
}

function isManagedResource(meta) {
  return Boolean(
    meta.labels['app.kubernetes.io/managed-by'] ||
      meta.annotations['meta.helm.sh/release-name'] ||
      meta.annotations['meta.helm.sh/release-namespace']
  );
}

function isSystemNamespace(namespace) {
  return namespace.startsWith('kube-') || namespace.startsWith('openshift-');
}

function normalizeSubject(record) {
  const kind = stringOrUndefined(record.kind);
  const name = stringOrUndefined(record.name);
  if (!kind || !name || !['ServiceAccount', 'User', 'Group'].includes(kind)) {
    return null;
  }

  const namespace = kind === 'ServiceAccount' ? stringOrUndefined(record.namespace) || 'default' : undefined;
  const system =
    (kind === 'ServiceAccount' && Boolean(namespace) && isSystemNamespace(namespace)) ||
    name.startsWith('system:') ||
    name === 'system:authenticated' ||
    name === 'system:unauthenticated';
  const risky = kind !== 'ServiceAccount' || name === 'system:authenticated' || name === 'system:unauthenticated';
  const displayName = kind === 'ServiceAccount' ? `${namespace}/${name}` : name;

  return {
    id: `${kind}:${namespace || ''}:${name}`,
    kind,
    name,
    namespace,
    displayName,
    system,
    risky
  };
}

function roleMapKey(kind, namespace, name) {
  return `${kind}:${namespace || '*'}:${name}`;
}

function roleScope(kind, namespace) {
  return kind === 'ClusterRole' ? 'cluster-wide' : namespace || 'cluster-wide';
}

function buildBindingSource(binding) {
  return `${binding.kind} ${binding.namespace ? `${binding.namespace}/` : ''}${binding.name} -> ${binding.roleKind} ${binding.roleRef}`;
}

function bindingSubjectKey(subject) {
  return `${subject.kind}:${subject.namespace || ''}:${subject.name}`;
}

function normalizeRole(record, kind) {
  const meta = metadataFor(record);
  const rules = asRecordArray(record.rules).map(normalizeRule);
  return {
    id: roleMapKey(kind, kind === 'Role' ? meta.namespace : null, meta.name),
    kind,
    name: meta.name,
    namespace: kind === 'Role' ? meta.namespace : undefined,
    rules,
    ruleCount: rules.length,
    bindingCount: 0,
    subjectCount: 0,
    wildcard: rules.some(isWildcardRule),
    dangerous: rules.some(isDangerousRule),
    system: meta.name.startsWith('system:') || isSystemNamespace(meta.namespace),
    managed: isManagedResource(meta)
  };
}

function normalizeBinding(record, kind, roleMap, namespaceScope) {
  const meta = metadataFor(record);
  if (namespaceScope && namespaceScope !== 'all' && meta.namespace !== namespaceScope && kind === 'RoleBinding') {
    return null;
  }

  const roleRef = asRecord(record.roleRef);
  const roleKind = stringOrUndefined(roleRef?.kind) === 'Role' ? 'Role' : 'ClusterRole';
  const roleName = stringOrUndefined(roleRef?.name) || 'unknown';
  const roleKey = roleMapKey(roleKind, roleKind === 'Role' ? meta.namespace : null, roleName);
  const subjects = uniqueBy(
    asRecordArray(record.subjects).map(normalizeSubject).filter(Boolean),
    bindingSubjectKey
  );
  const referencedRole = roleMap.get(roleKey) || null;
  const wildcard = referencedRole?.wildcard === true;
  const dangerous = referencedRole?.dangerous === true;
  const risky = subjects.some((subject) => subject.risky) && (dangerous || wildcard || kind === 'ClusterRoleBinding');

  return {
    id: `${kind}:${meta.namespace}:${meta.name}`,
    kind,
    name: meta.name,
    namespace: kind === 'RoleBinding' ? meta.namespace : undefined,
    roleRef: roleName,
    roleKind,
    subjects,
    scope: kind === 'ClusterRoleBinding' ? 'cluster-wide' : 'namespace-scoped',
    wildcard,
    dangerous,
    risky,
    system: meta.name.startsWith('system:') || subjects.every((subject) => subject.system),
    managed: isManagedResource(meta),
    roleKey
  };
}

function effectivePermissionId(subject, source, rule) {
  return `${subject.id}:${source}:${ruleIdentity(rule)}`;
}

function buildRbacSummaryCounts(result) {
  return {
    roles: result.roles.items.length,
    clusterRoles: result.clusterRoles.items.length,
    roleBindings: result.roleBindings.items.length,
    clusterRoleBindings: result.clusterRoleBindings.items.length,
    serviceAccounts: result.serviceAccounts.items.length,
    subjects: result.subjects.items.length,
    effectivePermissions: result.effectivePermissions.items.length,
    riskySubjects: result.subjects.items.filter((subject) => subject.risky).length,
    wildcardRoles: result.roles.items.filter((role) => role.wildcard).length + result.clusterRoles.items.filter((role) => role.wildcard).length
  };
}

export function buildRbacExplorerSummary(input) {
  const roleRecords = asRecordArray(input.roles.items);
  const clusterRoleRecords = asRecordArray(input.clusterRoles.items);
  const roleBindingRecords = asRecordArray(input.roleBindings.items);
  const clusterRoleBindingRecords = asRecordArray(input.clusterRoleBindings.items);
  const serviceAccountRecords = asRecordArray(input.serviceAccounts.items);

  const roleMap = new Map();
  const roles = roleRecords.map((record) => normalizeRole(record, 'Role'));
  const clusterRoles = clusterRoleRecords.map((record) => normalizeRole(record, 'ClusterRole'));
  for (const role of [...roles, ...clusterRoles]) {
    roleMap.set(role.id, role);
  }

  const roleBindings = roleBindingRecords
    .map((record) => normalizeBinding(record, 'RoleBinding', roleMap, input.namespaceScope))
    .filter(Boolean);
  const clusterRoleBindings = clusterRoleBindingRecords
    .map((record) => normalizeBinding(record, 'ClusterRoleBinding', roleMap, input.namespaceScope))
    .filter(Boolean);

  const bindings = [...roleBindings, ...clusterRoleBindings];

  for (const binding of bindings) {
    const role = roleMap.get(binding.roleKey);
    if (!role) continue;
    role.bindingCount += 1;
    role.subjectCount += binding.subjects.length;
  }

  const serviceAccountMap = new Map();
  for (const record of serviceAccountRecords) {
    const meta = metadataFor(record);
    if (input.namespaceScope && input.namespaceScope !== 'all' && meta.namespace !== input.namespaceScope) {
      continue;
    }
    serviceAccountMap.set(`ServiceAccount:${meta.namespace}:${meta.name}`, {
      id: `ServiceAccount:${meta.namespace}:${meta.name}`,
      name: meta.name,
      namespace: meta.namespace,
      bindingCount: 0,
      clusterWide: false,
      wildcard: false,
      risky: false
    });
  }

  const subjectMap = new Map();
  const effectivePermissions = [];

  for (const binding of bindings) {
    for (const subject of binding.subjects) {
      subjectMap.set(subject.id, subject);

      if (subject.kind === 'ServiceAccount') {
        const accountKey = `ServiceAccount:${subject.namespace}:${subject.name}`;
        const current =
          serviceAccountMap.get(accountKey) ||
          {
            id: accountKey,
            name: subject.name,
            namespace: subject.namespace,
            bindingCount: 0,
            clusterWide: false,
            wildcard: false,
            risky: false
          };
        current.bindingCount += 1;
        current.clusterWide = current.clusterWide || binding.scope === 'cluster-wide';
        current.wildcard = current.wildcard || binding.wildcard;
        current.risky = current.risky || binding.risky;
        serviceAccountMap.set(accountKey, current);
      }

      const role = roleMap.get(binding.roleKey);
      if (!role) continue;

      for (const rule of role.rules) {
        effectivePermissions.push({
          id: effectivePermissionId(subject, buildBindingSource(binding), rule),
          subject,
          verbs: rule.verbs,
          resources: rule.resources,
          apiGroups: rule.apiGroups,
          resourceNames: rule.resourceNames,
          nonResourceUrls: rule.nonResourceUrls,
          scopes: [roleScope(role.kind, binding.namespace)],
          sources: [buildBindingSource(binding)],
          wildcard: isWildcardRule(rule),
          dangerous: isDangerousRule(rule),
          risky: subject.risky && (binding.risky || isDangerousRule(rule) || isWildcardRule(rule))
        });
      }
    }
  }

  const dedupedEffectivePermissions = uniqueBy(effectivePermissions, (item) => item.id);
  const subjects = sortByName([...subjectMap.values()], ['kind', 'displayName']);
  const serviceAccounts = sortByName([...serviceAccountMap.values()], ['namespace', 'name']);
  const issues = input.issues || [];
  const partial =
    input.partial === true ||
    input.roles.partial ||
    input.clusterRoles.partial ||
    input.roleBindings.partial ||
    input.clusterRoleBindings.partial ||
    input.serviceAccounts.partial;

  const result = {
    namespaceScope: input.namespaceScope && input.namespaceScope !== 'all' ? input.namespaceScope : null,
    fetchedAt: input.fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    subjects: buildResourceList(subjects, input.fetchedAt, bindings.length > 0 && input.serviceAccounts.partial),
    effectivePermissions: buildResourceList(
      sortByName(dedupedEffectivePermissions, ['subject.displayName', 'id']),
      input.fetchedAt,
      partial
    ),
    roles: buildResourceList(sortByName(roles, ['namespace', 'name']), input.fetchedAt, input.roles.partial),
    clusterRoles: buildResourceList(sortByName(clusterRoles, ['name']), input.fetchedAt, input.clusterRoles.partial),
    roleBindings: buildResourceList(sortByName(roleBindings, ['namespace', 'name']), input.fetchedAt, input.roleBindings.partial),
    clusterRoleBindings: buildResourceList(sortByName(clusterRoleBindings, ['name']), input.fetchedAt, input.clusterRoleBindings.partial),
    serviceAccounts: buildResourceList(serviceAccounts, input.fetchedAt, input.serviceAccounts.partial)
  };

  result.summary = buildRbacSummaryCounts(result);
  return result;
}

function labelsMatchSelector(labels, selector) {
  const entries = Object.entries(selector);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([key, value]) => labels[key] === value);
}

function selectorString(selector) {
  const entries = Object.entries(selector || {}).filter(([key, value]) => key && value);
  if (entries.length === 0) return '(none)';
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function backendServicePort(service) {
  const port = asRecord(service?.port);
  if (!port) return '';
  const number = numberOrUndefined(port.number);
  const name = stringOrUndefined(port.name);
  return number ? String(number) : name || '';
}

function networkPolicyTypes(spec) {
  const explicit = stringArray(spec?.policyTypes);
  if (explicit.length > 0) return explicit;
  const hasEgress = asRecordArray(spec?.egress).length > 0;
  return hasEgress ? ['Ingress', 'Egress'] : ['Ingress'];
}

export function buildTrafficIntentSummary(input) {
  const namespaceScope = input.namespaceScope;
  const fetchedAt = input.fetchedAt;
  const podRecords = asRecordArray(input.pods.items).filter((pod) => {
    const meta = metadataFor(pod);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const serviceRecords = asRecordArray(input.services.items).filter((service) => {
    const meta = metadataFor(service);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const ingressRecords = asRecordArray(input.ingresses.items).filter((ingress) => {
    const meta = metadataFor(ingress);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const policyRecords = asRecordArray(input.networkPolicies.items).filter((policy) => {
    const meta = metadataFor(policy);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });

  const serviceIntents = serviceRecords.map((service) => {
    const meta = metadataFor(service);
    const selector = asStringRecord(asRecord(service.spec)?.selector);
    const pods = Object.keys(selector).length
      ? podRecords
          .filter((pod) => {
            const podMeta = metadataFor(pod);
            return podMeta.namespace === meta.namespace && labelsMatchSelector(podMeta.labels, selector);
          })
          .map((pod) => metadataFor(pod).name)
          .sort()
      : [];
    return {
      namespace: meta.namespace,
      service: meta.name,
      selector: selectorString(selector),
      pods
    };
  });

  const ingressIntents = [];
  function pushIngressIntent(meta, host, path, service) {
    ingressIntents.push({
      namespace: meta.namespace,
      ingress: meta.name,
      host: host || '*',
      path: path || '*',
      service: stringOrUndefined(service?.name) || 'unknown',
      port: backendServicePort(service)
    });
  }

  for (const ingress of ingressRecords) {
    const meta = metadataFor(ingress);
    const spec = asRecord(ingress.spec);
    const defaultBackend = asRecord(asRecord(spec?.defaultBackend)?.service);
    if (defaultBackend) {
      pushIngressIntent(meta, '*', '*', defaultBackend);
    }
    for (const rule of asRecordArray(spec?.rules)) {
      const host = stringOrUndefined(rule.host) || '*';
      const http = asRecord(rule.http);
      for (const path of asRecordArray(http?.paths)) {
        const service = asRecord(asRecord(path.backend)?.service);
        if (!service) continue;
        pushIngressIntent(meta, host, stringOrUndefined(path.path) || '*', service);
      }
    }
  }

  const networkPolicies = policyRecords.map((policy) => {
    const meta = metadataFor(policy);
    const spec = asRecord(policy.spec);
    return {
      namespace: meta.namespace,
      name: meta.name,
      types: networkPolicyTypes(spec),
      podSelector: selectorString(asStringRecord(asRecord(spec?.podSelector)?.matchLabels)),
      ingressRules: asRecordArray(spec?.ingress).length,
      egressRules: asRecordArray(spec?.egress).length
    };
  });

  const issues = input.issues || [];
  const partial =
    input.partial === true || input.services.partial || input.pods.partial || input.ingresses.partial || input.networkPolicies.partial;

  return {
    namespaceScope: namespaceScope && namespaceScope !== 'all' ? namespaceScope : null,
    fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    summary: {
      serviceIntents: serviceIntents.length,
      ingressIntents: ingressIntents.length,
      networkPolicies: networkPolicies.length
    },
    serviceIntents: buildResourceList(sortByName(serviceIntents, ['namespace', 'service']), fetchedAt, input.services.partial || input.pods.partial),
    ingressIntents: buildResourceList(sortByName(ingressIntents, ['namespace', 'ingress', 'host', 'path']), fetchedAt, input.ingresses.partial),
    networkPolicies: buildResourceList(sortByName(networkPolicies, ['namespace', 'name']), fetchedAt, input.networkPolicies.partial)
  };
}

const CNI_COMPONENT_KEYS = new Set(['cilium', 'calico', 'flannel', 'weave-net', 'canal', 'antrea', 'kube-router']);
const VIP_COMPONENT_KEYS = new Set(['kube-vip', 'kube-keepalived-vip', 'keepalived', 'metallb', 'k3s-servicelb']);
const VIP_IP_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

export function buildCniPluginsSummary(input) {
  const issues = input.issues || [];
  const partial = input.partial === true || input.components.partial;
  const items = asRecordArray(input.components.items).filter((component) => CNI_COMPONENT_KEYS.has(component.key || component.name));

  return {
    namespaceScope: input.namespaceScope && input.namespaceScope !== 'all' ? input.namespaceScope : null,
    fetchedAt: input.fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    items: sortByName(items, ['name']),
    summary: {
      detected: items.filter((component) => component.status === 'detected').length,
      candidates: items.length
    }
  };
}

function uniqueStrings(values) {
  return values.filter((value, index, list) => list.indexOf(value) === index);
}

function vipConfigs(configMaps, namespaceScope) {
  const configs = [];
  for (const configMap of asRecordArray(configMaps)) {
    const meta = metadataFor(configMap);
    if (namespaceScope && namespaceScope !== 'all' && meta.namespace !== namespaceScope) {
      continue;
    }
    const lowerName = meta.name.toLowerCase();
    if (!lowerName.includes('vip') && !lowerName.includes('keepalived')) {
      continue;
    }
    const data = asRecord(configMap.data) || {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') continue;
      const vips = uniqueStrings(value.match(VIP_IP_PATTERN) || []);
      if (vips.length === 0) continue;
      configs.push({
        namespace: meta.namespace,
        configName: meta.name,
        service: key,
        vips
      });
    }
  }
  return sortByName(configs, ['namespace', 'service', 'configName']);
}

function serviceLoadBalancerIps(services, namespaceScope) {
  const ips = [];
  for (const service of asRecordArray(services)) {
    const meta = metadataFor(service);
    if (namespaceScope && namespaceScope !== 'all' && meta.namespace !== namespaceScope) {
      continue;
    }
    const spec = asRecord(service.spec);
    const status = asRecord(service.status);
    ips.push(...serviceExternalIps(spec, status));
  }
  return uniqueStrings(ips);
}

export function buildVipLoadBalancerSummary(input) {
  const namespaceScope = input.namespaceScope;
  const components = asRecordArray(input.components.items).filter((component) => VIP_COMPONENT_KEYS.has(component.key || component.name));
  const configs = vipConfigs(input.configMaps.items, namespaceScope);
  const externalIps = serviceLoadBalancerIps(input.services.items, namespaceScope);
  const configVipSet = new Set(configs.flatMap((config) => config.vips));
  const issues = input.issues || [];
  const partial = input.partial === true || input.components.partial || input.configMaps.partial || input.services.partial;

  return {
    namespaceScope: namespaceScope && namespaceScope !== 'all' ? namespaceScope : null,
    fetchedAt: input.fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    summary: {
      detectedTooling: components.filter((component) => component.status === 'detected').length,
      activeVips: configVipSet.size,
      externalIps: externalIps.length,
      configMaps: configs.length
    },
    components: buildResourceList(sortByName(components, ['name']), input.fetchedAt, input.components.partial),
    configs: buildResourceList(configs, input.fetchedAt, input.configMaps.partial)
  };
}

function parsePortValue(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { raw: value, matchByName: null, resolvedTargetPort: value };
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return { raw: value, matchByName: null, resolvedTargetPort: parsed };
    }
    return { raw: value, matchByName: value.trim(), resolvedTargetPort: undefined };
  }

  return { raw: fallback, matchByName: null, resolvedTargetPort: fallback };
}

function normalizeContainerPorts(pods) {
  const containerPorts = [];

  for (const pod of asRecordArray(pods)) {
    const meta = metadataFor(pod);
    const spec = asRecord(pod.spec);
    for (const container of asRecordArray(spec?.containers)) {
      const containerName = stringOrUndefined(container.name) || 'container';
      for (const port of asRecordArray(container.ports)) {
        const portNumber = numberOrZero(port.containerPort);
        if (!portNumber) continue;
        containerPorts.push({
          id: `${meta.namespace}:${meta.name}:${containerName}:${portNumber}:${stringOrUndefined(port.protocol) || 'TCP'}`,
          namespace: meta.namespace,
          pod: meta.name,
          container: containerName,
          port: portNumber,
          protocol: stringOrUndefined(port.protocol) || 'TCP',
          name: stringOrUndefined(port.name),
          hostPort: numberOrUndefined(port.hostPort),
          nodeName: stringOrUndefined(spec?.nodeName)
        });
      }
    }
  }

  return sortByName(containerPorts, ['namespace', 'pod', 'container', 'name']);
}

function endpointDataByService(endpointSlices) {
  const map = new Map();

  for (const slice of asRecordArray(endpointSlices)) {
    const meta = metadataFor(slice);
    const labels = asStringRecord(asRecord(slice.metadata)?.labels);
    const serviceName = labels['kubernetes.io/service-name'];
    if (!serviceName) continue;

    const key = `${meta.namespace}/${serviceName}`;
    const current =
      map.get(key) || {
        sliceNames: [],
        addresses: 0,
        readyAddresses: 0,
        podNames: new Set(),
        slices: []
      };

    current.sliceNames.push(meta.name);
    current.slices.push(slice);

    for (const endpoint of asRecordArray(slice.endpoints)) {
      const addresses = Array.isArray(endpoint.addresses) ? endpoint.addresses.filter((value) => typeof value === 'string') : [];
      current.addresses += addresses.length;
      if (asRecord(endpoint.conditions)?.ready !== false) {
        current.readyAddresses += addresses.length;
      }
      const targetRef = asRecord(endpoint.targetRef);
      if ((stringOrUndefined(targetRef?.kind) || '') === 'Pod') {
        const podName = stringOrUndefined(targetRef?.name);
        if (podName) {
          current.podNames.add(podName);
        }
      }
    }

    map.set(key, current);
  }

  return map;
}

function ingressRoutes(ingresses, serviceMap, endpointMap) {
  const rows = [];

  function pushRoute(meta, host, path, backend) {
    const serviceName = stringOrUndefined(backend?.name) || 'unknown';
    const servicePort = backend?.port && typeof backend.port === 'object'
      ? String(backend.port.number ?? backend.port.name ?? '')
      : String(backend?.port ?? '');
    const service = serviceMap.get(`${meta.namespace}/${serviceName}`) || null;
    const endpoints = endpointMap.get(`${meta.namespace}/${serviceName}`) || null;
    const resolved = service
      ? asRecordArray(asRecord(service.spec)?.ports).some((port) => {
          const name = stringOrUndefined(port.name);
          const number = numberOrUndefined(port.port);
          return servicePort === String(number) || (name && servicePort === name);
        })
      : false;

    let endpointStatus = 'unknown';
    if (!service) {
      endpointStatus = 'missing-service';
    } else if (!resolved) {
      endpointStatus = 'port-mismatch';
    } else if (!endpoints || endpoints.readyAddresses === 0) {
      endpointStatus = 'missing-endpoints';
    } else {
      endpointStatus = 'ready';
    }

    rows.push({
      id: `${meta.namespace}:${meta.name}:${host}:${path}:${serviceName}:${servicePort}`,
      namespace: meta.namespace,
      ingress: meta.name,
      host,
      path,
      service: serviceName,
      servicePort,
      serviceExists: Boolean(service),
      servicePortResolved: resolved,
      endpointStatus
    });
  }

  for (const ingress of asRecordArray(ingresses)) {
    const meta = metadataFor(ingress);
    const spec = asRecord(ingress.spec);
    const rules = asRecordArray(spec?.rules);

    const defaultBackend = asRecord(spec?.defaultBackend)?.service;
    if (defaultBackend) {
      pushRoute(meta, '*', '/', defaultBackend);
    }

    for (const rule of rules) {
      const host = stringOrUndefined(rule.host) || '*';
      const http = asRecord(rule.http);
      for (const path of asRecordArray(http?.paths)) {
        const backend = asRecord(path.backend)?.service;
        if (!backend) continue;
        pushRoute(meta, host, stringOrUndefined(path.path) || '/', backend);
      }
    }
  }

  return sortByName(rows, ['namespace', 'ingress', 'host', 'path', 'service']);
}

function serviceExternalIps(spec, status) {
  const loadBalancer = asRecord(status?.loadBalancer);
  return [
    ...stringArray(spec?.externalIPs),
    ...asRecordArray(loadBalancer?.ingress).flatMap((entry) =>
      [stringOrUndefined(entry.ip), stringOrUndefined(entry.hostname)].filter(Boolean)
    )
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function serviceClusterIp(spec) {
  const clusterIPs = stringArray(spec?.clusterIPs);
  if (clusterIPs.length > 0) {
    return clusterIPs[0];
  }
  const clusterIp = stringOrUndefined(spec?.clusterIP);
  return clusterIp && clusterIp !== 'None' ? clusterIp : undefined;
}

function buildPortsTruthRows(services, endpointSlices, pods, ingresses, namespaceScope) {
  const podRecords = asRecordArray(pods).filter((pod) => {
    const meta = metadataFor(pod);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const serviceRecords = asRecordArray(services).filter((service) => {
    const meta = metadataFor(service);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const endpointSliceRecords = asRecordArray(endpointSlices).filter((slice) => {
    const meta = metadataFor(slice);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const ingressRecords = asRecordArray(ingresses).filter((ingress) => {
    const meta = metadataFor(ingress);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });

  const containerPorts = normalizeContainerPorts(podRecords);
  const podMap = new Map(podRecords.map((pod) => [`${metadataFor(pod).namespace}/${metadataFor(pod).name}`, pod]));
  const serviceMap = new Map(serviceRecords.map((service) => [`${metadataFor(service).namespace}/${metadataFor(service).name}`, service]));
  const endpointMap = endpointDataByService(endpointSliceRecords);
  const routes = ingressRoutes(ingressRecords, serviceMap, endpointMap);
  const rows = [];

  for (const service of serviceRecords) {
    const meta = metadataFor(service);
    const spec = asRecord(service.spec);
    const status = asRecord(service.status);
    const selector = asStringRecord(spec?.selector);
    const matchingPods = Object.keys(selector).length
      ? podRecords.filter((pod) => {
          const podMeta = metadataFor(pod);
          return podMeta.namespace === meta.namespace && labelsMatchSelector(podMeta.labels, selector);
        })
      : [];
    const endpoints = endpointMap.get(`${meta.namespace}/${meta.name}`) || {
      sliceNames: [],
      addresses: 0,
      readyAddresses: 0,
      podNames: new Set(),
      slices: []
    };
    const routesForService = routes.filter((route) => route.namespace === meta.namespace && route.service === meta.name);

    for (const port of asRecordArray(spec?.ports)) {
      const portNumber = numberOrZero(port.port);
      if (!portNumber) continue;

      const target = parsePortValue(port.targetPort, portNumber);
      const containerMatches = containerPorts.filter((containerPort) => {
        if (containerPort.namespace !== meta.namespace) return false;
        if (!matchingPods.some((pod) => metadataFor(pod).name === containerPort.pod)) return false;
        if (target.matchByName) {
          return containerPort.name === target.matchByName;
        }
        return containerPort.port === (target.resolvedTargetPort || portNumber);
      });
      const resolvedTargetPort =
        target.resolvedTargetPort ||
        (target.matchByName && containerMatches.length > 0 ? containerMatches[0].port : undefined);

      const serviceType = stringOrUndefined(spec?.type) || 'ClusterIP';
      const exposure =
        routesForService.length > 0
          ? 'ingress'
          : serviceType === 'LoadBalancer'
            ? 'loadbalancer'
            : serviceType === 'NodePort' || typeof port.nodePort === 'number'
              ? 'nodeport'
              : 'internal';

      let targetStatus = 'matched';
      const issues = [];
      if (Object.keys(selector).length === 0) {
        targetStatus = 'selectorless';
        issues.push('Service does not define a selector.');
      } else if (matchingPods.length === 0) {
        targetStatus = 'selector-mismatch';
        issues.push('Service selector does not match any pods.');
      } else if (endpoints.readyAddresses === 0) {
        targetStatus = 'missing-endpoints';
        issues.push('Service has no ready endpoints.');
      } else if (!resolvedTargetPort || containerMatches.length === 0) {
        targetStatus = 'unresolved-target-port';
        issues.push('TargetPort does not resolve to any selected container port.');
      }

      rows.push({
        id: `${meta.namespace}:${meta.name}:${portNumber}:${stringOrUndefined(port.protocol) || 'TCP'}`,
        namespace: meta.namespace,
        service: meta.name,
        serviceType,
        clusterIp: serviceClusterIp(spec),
        port: portNumber,
        portName: stringOrUndefined(port.name),
        protocol: stringOrUndefined(port.protocol) || 'TCP',
        targetPort: target.raw,
        resolvedTargetPort,
        nodePort: numberOrUndefined(port.nodePort),
        exposure,
        selector,
        matchingPods: matchingPods.length,
        readyEndpoints: endpoints.readyAddresses,
        totalEndpoints: endpoints.addresses,
        endpointStatus:
          endpoints.addresses === 0
            ? 'missing'
            : endpoints.readyAddresses < endpoints.addresses
              ? 'partial'
              : 'ready',
        targetStatus,
        endpointPods: [...endpoints.podNames].sort(),
        containerMatches,
        ingressRoutes: routesForService.filter((route) => {
          if (route.servicePort === String(portNumber)) return true;
          if (stringOrUndefined(port.name) && route.servicePort === stringOrUndefined(port.name)) return true;
          return false;
        }),
        externalIps: serviceExternalIps(spec, status),
        issues
      });
    }
  }

  return {
    services: sortByName(rows, ['namespace', 'service', 'port']),
    containers: containerPorts,
    ingresses: routes
  };
}

export function buildPortsTruthSummary(input) {
  const built = buildPortsTruthRows(
    input.services.items,
    input.endpointSlices.items,
    input.pods.items,
    input.ingresses.items,
    input.namespaceScope
  );
  const issues = input.issues || [];
  const partial =
    input.partial === true ||
    input.services.partial ||
    input.endpointSlices.partial ||
    input.pods.partial ||
    input.ingresses.partial;

  return {
    namespaceScope: input.namespaceScope && input.namespaceScope !== 'all' ? input.namespaceScope : null,
    fetchedAt: input.fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    summary: {
      services: uniqueBy(built.services, (row) => `${row.namespace}/${row.service}`).length,
      servicePorts: built.services.length,
      containerPorts: built.containers.length,
      ingressRoutes: built.ingresses.length,
      exposedPorts: built.services.filter((row) => row.exposure !== 'internal').length,
      brokenRoutes:
        built.ingresses.filter((row) => row.endpointStatus !== 'ready').length +
        built.services.filter((row) => row.targetStatus !== 'matched').length,
      missingEndpoints: built.services.filter((row) => row.endpointStatus === 'missing').length,
      unresolvedTargetPorts: built.services.filter((row) => row.targetStatus === 'unresolved-target-port').length
    },
    services: buildResourceList(built.services, input.fetchedAt, input.services.partial || input.endpointSlices.partial || input.pods.partial),
    containers: buildResourceList(built.containers, input.fetchedAt, input.pods.partial),
    ingresses: buildResourceList(built.ingresses, input.fetchedAt, input.ingresses.partial || input.services.partial || input.endpointSlices.partial)
  };
}

function topologyNode(id, kind, name, namespace, status, hint, labels) {
  return {
    id,
    kind,
    name,
    ...(namespace ? { namespace } : {}),
    ...(status ? { status } : {}),
    ...(hint ? { hint } : {}),
    ...(labels && Object.keys(labels).length ? { labels } : {})
  };
}

function nodeReady(record) {
  return asRecordArray(asRecord(record.status)?.conditions).some((condition) => condition.type === 'Ready' && condition.status === 'True');
}

function ingressIssueCount(routeRows, namespace, ingressName) {
  return routeRows.filter((route) => route.namespace === namespace && route.ingress === ingressName && route.endpointStatus !== 'ready').length;
}

export function buildTopologyGraphSummary(input) {
  const namespaceScope = input.namespaceScope;
  const built = buildPortsTruthRows(
    input.services.items,
    input.endpointSlices.items,
    input.pods.items,
    input.ingresses.items,
    namespaceScope
  );
  const podRecords = asRecordArray(input.pods.items).filter((pod) => {
    const meta = metadataFor(pod);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const endpointSliceRecords = asRecordArray(input.endpointSlices.items).filter((slice) => {
    const meta = metadataFor(slice);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const ingressRecords = asRecordArray(input.ingresses.items).filter((ingress) => {
    const meta = metadataFor(ingress);
    return !namespaceScope || namespaceScope === 'all' || meta.namespace === namespaceScope;
  });
  const nodeRecords = asRecordArray(input.nodes.items);

  const nodes = [];
  const edges = [];
  const nodeIndex = new Set();

  function addNode(entry) {
    if (nodeIndex.has(entry.id)) return;
    nodeIndex.add(entry.id);
    nodes.push(entry);
  }

  function addEdge(from, to, kind) {
    const id = `${kind}:${from}:${to}`;
    if (edges.some((edge) => edge.id === id)) return;
    edges.push({ id, from, to, kind });
  }

  for (const ingress of ingressRecords) {
    const meta = metadataFor(ingress);
    const ingressId = `Ingress:${meta.namespace}:${meta.name}`;
    addNode(
      topologyNode(
        ingressId,
        'Ingress',
        meta.name,
        meta.namespace,
        ingressIssueCount(built.ingresses, meta.namespace, meta.name) > 0 ? 'warning' : 'ready',
        `${built.ingresses.filter((row) => row.namespace === meta.namespace && row.ingress === meta.name).length} backend route(s)`,
        meta.labels
      )
    );
  }

  for (const serviceRow of uniqueBy(built.services, (row) => `${row.namespace}/${row.service}`)) {
    const serviceId = `Service:${serviceRow.namespace}:${serviceRow.service}`;
    addNode(
      topologyNode(
        serviceId,
        'Service',
        serviceRow.service,
        serviceRow.namespace,
        serviceRow.endpointStatus === 'ready' ? 'ready' : serviceRow.endpointStatus,
        `${serviceRow.serviceType} service`,
        serviceRow.selector
      )
    );
  }

  for (const slice of endpointSliceRecords) {
    const meta = metadataFor(slice);
    const endpointCount = asRecordArray(slice.endpoints).reduce((current, endpoint) => {
      const addresses = Array.isArray(endpoint.addresses) ? endpoint.addresses.filter((value) => typeof value === 'string') : [];
      return current + addresses.length;
    }, 0);
    addNode(
      topologyNode(
        `EndpointSlice:${meta.namespace}:${meta.name}`,
        'EndpointSlice',
        meta.name,
        meta.namespace,
        endpointCount > 0 ? 'ready' : 'missing',
        `${endpointCount} endpoint address(es)`,
        meta.labels
      )
    );
  }

  const referencedPodNames = new Set();
  for (const row of built.services) {
    for (const podName of row.endpointPods) {
      referencedPodNames.add(`${row.namespace}/${podName}`);
    }
    for (const match of row.containerMatches) {
      referencedPodNames.add(`${match.namespace}/${match.pod}`);
    }
  }

  for (const pod of podRecords) {
    const meta = metadataFor(pod);
    if (!referencedPodNames.has(`${meta.namespace}/${meta.name}`)) {
      continue;
    }
    const spec = asRecord(pod.spec);
    const status = asRecord(pod.status);
    addNode(
      topologyNode(
        `Pod:${meta.namespace}:${meta.name}`,
        'Pod',
        meta.name,
        meta.namespace,
        stringOrUndefined(status?.phase) || 'Unknown',
        stringOrUndefined(spec?.nodeName) || 'unscheduled',
        meta.labels
      )
    );
  }

  const referencedNodes = new Set();
  for (const pod of podRecords) {
    const meta = metadataFor(pod);
    if (!referencedPodNames.has(`${meta.namespace}/${meta.name}`)) continue;
    const nodeName = stringOrUndefined(asRecord(pod.spec)?.nodeName);
    if (nodeName) {
      referencedNodes.add(nodeName);
    }
  }

  for (const node of nodeRecords) {
    const meta = metadataFor(node);
    if (!referencedNodes.has(meta.name)) continue;
    addNode(
      topologyNode(
        `Node::${meta.name}`,
        'Node',
        meta.name,
        undefined,
        nodeReady(node) ? 'Ready' : 'NotReady',
        Object.keys(meta.labels)
          .filter((key) => key.startsWith('node-role.kubernetes.io/'))
          .map((key) => key.replace('node-role.kubernetes.io/', ''))
          .filter(Boolean)
          .join(', ') || 'worker',
        meta.labels
      )
    );
  }

  for (const route of built.ingresses) {
    if (!route.serviceExists) continue;
    addEdge(`Ingress:${route.namespace}:${route.ingress}`, `Service:${route.namespace}:${route.service}`, 'routes-to');
  }

  for (const slice of endpointSliceRecords) {
    const meta = metadataFor(slice);
    const labels = asStringRecord(asRecord(slice.metadata)?.labels);
    const serviceName = labels['kubernetes.io/service-name'];
    if (!serviceName) continue;
    addEdge(`Service:${meta.namespace}:${serviceName}`, `EndpointSlice:${meta.namespace}:${meta.name}`, 'fans-out-to');

    for (const endpoint of asRecordArray(slice.endpoints)) {
      const targetRef = asRecord(endpoint.targetRef);
      if ((stringOrUndefined(targetRef?.kind) || '') !== 'Pod') continue;
      const podName = stringOrUndefined(targetRef?.name);
      if (!podName) continue;
      addEdge(`EndpointSlice:${meta.namespace}:${meta.name}`, `Pod:${meta.namespace}:${podName}`, 'targets-pod');
    }
  }

  for (const pod of podRecords) {
    const meta = metadataFor(pod);
    if (!referencedPodNames.has(`${meta.namespace}/${meta.name}`)) continue;
    const nodeName = stringOrUndefined(asRecord(pod.spec)?.nodeName);
    if (!nodeName) continue;
    addEdge(`Pod:${meta.namespace}:${meta.name}`, `Node::${nodeName}`, 'scheduled-on');
  }

  const issues = input.issues || [];
  const partial =
    input.partial === true ||
    input.ingresses.partial ||
    input.services.partial ||
    input.endpointSlices.partial ||
    input.pods.partial ||
    input.nodes.partial;

  return {
    namespaceScope: namespaceScope && namespaceScope !== 'all' ? namespaceScope : null,
    fetchedAt: input.fetchedAt,
    issues,
    partial,
    availability: buildAvailability(issues, partial),
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      ingresses: nodes.filter((node) => node.kind === 'Ingress').length,
      services: nodes.filter((node) => node.kind === 'Service').length,
      endpointSlices: nodes.filter((node) => node.kind === 'EndpointSlice').length,
      pods: nodes.filter((node) => node.kind === 'Pod').length,
      clusterNodes: nodes.filter((node) => node.kind === 'Node').length
    },
    nodes: buildResourceList(sortByName(nodes, ['kind', 'namespace', 'name']), input.fetchedAt, input.ingresses.partial || input.services.partial || input.endpointSlices.partial || input.pods.partial || input.nodes.partial),
    edges: buildResourceList(sortByName(edges, ['kind', 'from', 'to']), input.fetchedAt, input.ingresses.partial || input.services.partial || input.endpointSlices.partial || input.pods.partial || input.nodes.partial)
  };
}

function validationItem(id, category, severity, title, message, nextStep, objectRefs, evidence = []) {
  return {
    id,
    category,
    severity,
    title,
    message,
    nextStep,
    objectRefs,
    evidence
  };
}

export function buildRbacValidationItems(rbac) {
  const items = [];

  for (const binding of [...(rbac.roleBindings?.items || []), ...(rbac.clusterRoleBindings?.items || [])]) {
    if (
      binding.roleKind === 'ClusterRole' &&
      binding.roleRef === 'cluster-admin' &&
      binding.subjects.some((subject) => subject.risky || !subject.system)
    ) {
      items.push(
        validationItem(
          `rbac.cluster_admin.${binding.id}`,
          'rbac',
          binding.kind === 'ClusterRoleBinding' ? 'critical' : 'warning',
          'Cluster-admin granted to non-system subject',
          `${binding.kind} ${binding.namespace ? `${binding.namespace}/` : ''}${binding.name} grants cluster-admin to ${binding.subjects
            .map((subject) => subject.displayName)
            .join(', ')}.`,
          'Limit cluster-admin to tightly controlled break-glass subjects and review the bound identity set.',
          [
            { kind: binding.kind, namespace: binding.namespace, name: binding.name },
            ...binding.subjects.map((subject) => ({
              kind: subject.kind,
              namespace: subject.namespace,
              name: subject.name
            }))
          ],
          [`RoleRef ${binding.roleRef}`]
        )
      );
    }

    if (
      binding.scope === 'cluster-wide' &&
      binding.subjects.some((subject) => subject.name === 'system:authenticated' || subject.name === 'system:unauthenticated')
    ) {
      items.push(
        validationItem(
          `rbac.authenticated_cluster_scope.${binding.id}`,
          'rbac',
          'critical',
          'Authenticated or unauthenticated group bound cluster-wide',
          `${binding.kind} ${binding.name} binds ${binding.subjects
            .filter((subject) => subject.name === 'system:authenticated' || subject.name === 'system:unauthenticated')
            .map((subject) => subject.name)
            .join(', ')} to ${binding.roleRef}.`,
          'Avoid binding broad authentication groups to cluster-wide roles unless this is explicitly intended.',
          [{ kind: binding.kind, namespace: binding.namespace, name: binding.name }],
          binding.subjects.map((subject) => subject.displayName)
        )
      );
    }
  }

  for (const role of [...(rbac.roles?.items || []), ...(rbac.clusterRoles?.items || [])]) {
    if (role.wildcard && !role.system) {
      items.push(
        validationItem(
          `rbac.wildcard_role.${role.id}`,
          'rbac',
          role.kind === 'ClusterRole' ? 'warning' : 'info',
          'Wildcard permissions present in role',
          `${role.kind} ${role.namespace ? `${role.namespace}/` : ''}${role.name} includes wildcard permissions.`,
          'Review whether wildcard verbs, resources, or API groups can be narrowed.',
          [{ kind: role.kind, namespace: role.namespace, name: role.name }],
          [`${role.ruleCount} rule(s)`, `${role.bindingCount} binding(s)`]
        )
      );
    }
  }

  return uniqueBy(items, (item) => item.id);
}

export function buildPortsValidationItems(ports) {
  const items = [];

  for (const row of ports.services?.items || []) {
    if (row.targetStatus === 'selector-mismatch') {
      items.push(
        validationItem(
          `networking.selector_mismatch.${row.id}`,
          'networking',
          'warning',
          'Service selector does not match any pods',
          `${row.namespace}/${row.service} does not currently select any pods for port ${row.port}.`,
          'Verify Service selectors, namespace scope, and workload labels.',
          [{ kind: 'Service', namespace: row.namespace, name: row.service }],
          Object.entries(row.selector).map(([key, value]) => `${key}=${value}`)
        )
      );
    }

    if (row.targetStatus === 'missing-endpoints') {
      items.push(
        validationItem(
          `networking.service_no_endpoints.${row.id}`,
          'networking',
          row.exposure === 'internal' ? 'warning' : 'critical',
          'Service has no ready endpoints',
          `${row.namespace}/${row.service} has no ready endpoints for port ${row.port}.`,
          'Check pod readiness, EndpointSlices, and workload rollout state.',
          [{ kind: 'Service', namespace: row.namespace, name: row.service }],
          row.endpointPods
        )
      );
    }

    if (row.endpointStatus === 'partial') {
      items.push(
        validationItem(
          `networking.service_partial_endpoints.${row.namespace}.${row.service}.${row.port}`,
          'networking',
          'warning',
          'Service endpoints are partially ready',
          `${row.namespace}/${row.service} has ${row.readyEndpoints}/${row.totalEndpoints} ready endpoints for port ${row.port}.`,
          'Inspect the Not Ready pods and their readiness probes before capacity degrades further.',
          [{ kind: 'Service', namespace: row.namespace, name: row.service }],
          [`Port ${row.port}/${row.protocol}`, ...row.endpointPods]
        )
      );
    }

    if (row.targetStatus === 'unresolved-target-port') {
      items.push(
        validationItem(
          `networking.target_port_unresolved.${row.id}`,
          'networking',
          'warning',
          'Service targetPort does not resolve cleanly',
          `${row.namespace}/${row.service} points port ${row.port} to targetPort ${String(row.targetPort)} without a matching container port.`,
          'Verify targetPort names and containerPort declarations on the selected pods.',
          [{ kind: 'Service', namespace: row.namespace, name: row.service }],
          row.containerMatches.map((match) => `${match.pod}:${match.container}:${match.port}`)
        )
      );
    }

    if (row.exposure !== 'internal' && row.endpointStatus !== 'ready') {
      items.push(
        validationItem(
          `networking.exposed_broken_route.${row.id}`,
          'networking',
          'critical',
          'Externally exposed service route is not healthy',
          `${row.namespace}/${row.service} is exposed via ${row.exposure}, but the backing route for port ${row.port} is not healthy.`,
          'Check Service type, ingress/backend mapping, and endpoint readiness before relying on this exposed path.',
          [{ kind: 'Service', namespace: row.namespace, name: row.service }],
          row.issues
        )
      );
    }
  }

  for (const route of ports.ingresses?.items || []) {
    if (route.endpointStatus === 'ready') {
      continue;
    }

    const severity = route.endpointStatus === 'missing-service' ? 'critical' : 'warning';
    items.push(
      validationItem(
        `networking.ingress_route.${route.id}`,
        'networking',
        severity,
        route.endpointStatus === 'missing-service'
          ? 'Ingress backend service missing'
          : route.endpointStatus === 'port-mismatch'
            ? 'Ingress backend port mismatch'
            : 'Ingress backend has no endpoints',
        `Ingress ${route.namespace}/${route.ingress} routes ${route.host}${route.path} to ${route.service}, but the backend is ${route.endpointStatus}.`,
        'Confirm the backend Service exists, exposes the expected port, and has ready endpoints.',
        [
          { kind: 'Ingress', namespace: route.namespace, name: route.ingress },
          { kind: 'Service', namespace: route.namespace, name: route.service }
        ],
        [`Host ${route.host}`, `Path ${route.path}`]
      )
    );
  }

  return uniqueBy(items, (item) => item.id);
}
