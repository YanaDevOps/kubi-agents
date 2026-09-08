const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job', 'CronJob']);
const BASELINE_CAPABILITIES = new Set(['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL',
  'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT']);
const CONTAINER_FIELDS = ['containers', 'initContainers', 'ephemeralContainers'];
const PSA_MODES = ['enforce', 'audit', 'warn'];
const RULES = {
  'baseline-host-namespaces': ['Host namespaces are shared', 'critical', 'Disable hostNetwork, hostPID and hostIPC unless an explicitly reviewed exception is required.'],
  'baseline-host-process': ['Windows HostProcess is enabled', 'critical', 'Disable windowsOptions.hostProcess at pod and container scope.'],
  'baseline-privileged': ['Privileged containers', 'critical', 'Set privileged to false and grant only the specific permissions required.'],
  'baseline-capabilities': ['Capabilities exceed Baseline', 'warning', 'Remove added capabilities outside the PSS Baseline allowlist.'],
  'baseline-host-path': ['Host filesystem volumes', 'warning', 'Replace hostPath volumes with an appropriate isolated volume source.'],
  'baseline-host-port': ['Host ports are requested', 'warning', 'Remove nonzero hostPort settings; expose the application through a Service instead.'],
  'baseline-host-probes': ['Probe or lifecycle host overrides', 'warning', 'Remove host overrides from HTTP and TCP probes and lifecycle hooks.'],
  'baseline-apparmor': ['AppArmor profile is outside Baseline', 'warning', 'Use RuntimeDefault or an approved Localhost AppArmor profile.'],
  'baseline-selinux': ['SELinux options are outside Baseline', 'warning', 'Remove custom SELinux user/role values and use a type allowed by the reference PSS version.'],
  'baseline-proc-mount': ['Non-default proc mount', 'warning', 'Use the Default procMount setting.'],
  'baseline-seccomp': ['Seccomp profile is outside Baseline', 'warning', 'Use RuntimeDefault or an approved Localhost seccomp profile.'],
  'baseline-sysctls': ['Sysctls are outside Baseline', 'warning', 'Remove sysctls outside the safe allowlist for the reference Kubernetes version.'],
  'restricted-non-root': ['Declared non-root requirement is not met', 'warning', 'Require runAsNonRoot and remove explicit runAsUser: 0 at pod and container scope.'],
  'restricted-seccomp': ['Declared seccomp requirement is not met', 'warning', 'Set RuntimeDefault or Localhost seccomp at pod scope or on every applicable container.'],
  'restricted-privilege-escalation': ['Declared privilege escalation requirement is not met', 'warning', 'Set allowPrivilegeEscalation to false on each applicable container.'],
  'restricted-drop-capabilities': ['Declared capabilities requirement is not met', 'warning', 'Drop ALL capabilities and add back only NET_BIND_SERVICE if required.'],
  'hardening-non-root': ['Non-root execution is not required', 'warning', 'Set runAsNonRoot to true and avoid runAsUser: 0; verify the image supports a non-root user.'],
  'hardening-seccomp': ['No explicit effective seccomp profile', 'info', 'Set a pod-level RuntimeDefault seccomp profile or configure every container explicitly.'],
  'hardening-privilege-escalation': ['Privilege escalation is not disabled', 'warning', 'Set allowPrivilegeEscalation to false on each Linux container.'],
  'hardening-drop-capabilities': ['Linux capabilities are not minimized', 'info', 'Drop ALL capabilities and add back only NET_BIND_SERVICE if needed.'],
  'hardening-read-only-root': ['Root filesystem is not read-only', 'info', 'Set readOnlyRootFilesystem to true and provide writable volumes only where needed.']
};

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function resource(value, kind) {
  const metadata = record(value.metadata);
  return { kind, name: metadata.name, namespace: metadata.namespace || 'default',
    ...(metadata.uid ? { uid: metadata.uid } : {}) };
}

function key(ref) {
  return [ref.namespace, ref.kind, ref.name, ref.uid || ''].map(encodeURIComponent).join('/');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((name) => value[name] !== undefined)
      .map((name) => [name, canonical(value[name])]));
  }
  return value;
}

function completed(value, kind) {
  const status = record(value.status);
  if (kind === 'Pod') return ['Succeeded', 'Failed'].includes(status.phase);
  return kind === 'Job' && (Boolean(status.completionTime) || records(status.conditions)
    .some((condition) => ['Complete', 'Failed'].includes(condition.type) && ['True', true].includes(condition.status)));
}

function controller(value) {
  return records(record(value.metadata).ownerReferences).find((owner) => owner.controller === true);
}

function lineageOf(value, kind, inventory) {
  let current = { value, kind };
  const visited = new Set();
  while (true) {
    const identity = resource(current.value, current.kind);
    if (visited.has(key(identity))) return identity;
    visited.add(key(identity));
    const owner = controller(current.value);
    if (typeof owner?.kind !== 'string' || typeof owner?.name !== 'string' || !owner.name) return identity;
    const ownerRef = { kind: owner.kind, name: owner.name, namespace: identity.namespace,
      ...(typeof owner.uid === 'string' && owner.uid ? { uid: owner.uid } : {}) };
    if (visited.has(key(ownerRef))) return identity;
    const candidates = inventory.filter((entry) => {
      const candidate = resource(entry.value, entry.kind);
      return candidate.kind === ownerRef.kind && candidate.name === ownerRef.name && candidate.namespace === ownerRef.namespace
        && (!ownerRef.uid || ownerRef.uid === candidate.uid);
    });
    // A stale owner UID must not resolve to a replacement with the same name.
    if (candidates.length !== 1) return ownerRef;
    current = candidates[0];
  }
}

function probeHosts(container) {
  const hosts = [];
  for (const field of ['livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle.postStart', 'lifecycle.preStop']) {
    const action = field.split('.').reduce((value, part) => record(value)[part], container);
    for (const protocol of ['httpGet', 'tcpSocket']) {
      const host = record(record(action)[protocol]).host;
      if (host) hosts.push([`${field}.${protocol}.host`, host]);
    }
  }
  return hosts;
}

// Ignore runtime/defaulted fields unrelated to these checks, such as injected
// service-account volumes, image pull policy and scheduler assignments.
function securityConfiguration(spec, metadata) {
  return canonical({
    os: record(spec.os).name || 'linux', securityContext: record(spec.securityContext),
    hostNetwork: spec.hostNetwork === true, hostPID: spec.hostPID === true, hostIPC: spec.hostIPC === true,
    hostPaths: records(spec.volumes).filter((volume) => volume.hostPath != null)
      .map((volume) => ({ name: volume.name, hostPath: volume.hostPath })),
    annotations: Object.fromEntries(Object.entries(record(metadata.annotations))
      .filter(([name]) => name.startsWith('container.apparmor.security.beta.kubernetes.io/'))),
    ...Object.fromEntries(CONTAINER_FIELDS.map((field) => [field, records(spec[field]).map((container) => ({
      name: container.name, securityContext: record(container.securityContext),
      hostPorts: records(container.ports).map((port) => port.hostPort).filter((port) => port != null && port !== 0),
      probeHosts: field === 'ephemeralContainers' ? [] : probeHosts(container)
    }))]))
  });
}

function referenceVersion(value) {
  const match = typeof value === 'string' && value.match(/^v?(\d+)\.(\d+)(?:[.\-+]|$)/);
  const supported = match && Number(match[1]) === 1 && Number(match[2]) >= 23 && Number(match[2]) <= 34;
  return { minor: supported ? Number(match[2]) : 34, assumed: !supported };
}

function namespacePolicy(name, raw, clusterVersion) {
  const labels = record(record(raw?.metadata).labels);
  const policy = { namespace: name, observed: Boolean(raw), notes: [
    'Missing labels do not establish that PSA is disabled: cluster-wide defaults and exemptions are unknown.'
  ] };
  for (const mode of PSA_MODES) {
    const levelKey = `pod-security.kubernetes.io/${mode}`;
    const versionKey = `${levelKey}-version`;
    const declared = Object.hasOwn(labels, levelKey);
    const level = ['privileged', 'baseline', 'restricted'].includes(labels[levelKey]) ? labels[levelKey] : 'unknown';
    const versionDeclared = Object.hasOwn(labels, versionKey);
    const version = versionDeclared ? String(labels[versionKey]) : 'latest';
    const versionValid = version === 'latest' || /^v1\.(0|[1-9]\d*)$/.test(version);
    const reference = version === 'latest' ? clusterVersion : versionValid ? referenceVersion(version) : { minor: 34, assumed: true };
    policy[mode] = { level, declared, valid: !declared || level !== 'unknown', version, versionDeclared, versionValid,
      referenceVersion: `v1.${reference.minor}`, versionAssumed: reference.assumed };
  }
  return policy;
}

function assess(spec, metadata, minor, restricted = false) {
  const issues = new Map();
  function add(rule, evidence) {
    if (!issues.has(rule)) issues.set(rule, []);
    issues.get(rule).push(evidence);
  }
  const podSecurity = record(spec.securityContext);
  const containers = CONTAINER_FIELDS.flatMap((field) => records(spec[field]).map((container, index) => ({
    container, field, path: `spec.${field}[${container.name || index}]`, security: record(container.securityContext)
  })));
  if (restricted && (podSecurity.runAsNonRoot === false || podSecurity.runAsUser === 0)) {
    add('restricted-non-root', `spec.securityContext: runAsNonRoot=${podSecurity.runAsNonRoot ?? 'unset'}, runAsUser=${podSecurity.runAsUser ?? 'unset'}; explicit pod-level constraints apply even when containers override them`);
  }

  for (const field of ['hostNetwork', 'hostPID', 'hostIPC']) {
    if (spec[field] === true) add('baseline-host-namespaces', `spec.${field}=true`);
  }
  for (const volume of records(spec.volumes)) {
    if (volume.hostPath != null) add('baseline-host-path', `spec.volumes[${volume.name || '?'}].hostPath=${record(volume.hostPath).path || '(set)'}`);
  }

  // Baseline forbids explicit settings at either scope, even if a child
  // overrides them. Inheritance below applies only to effective hardening.
  for (const { security, path } of [{ security: podSecurity, path: 'spec' }, ...containers]) {
    if (record(security.windowsOptions).hostProcess === true) add('baseline-host-process', `${path}.securityContext.windowsOptions.hostProcess=true`);
    for (const [field, rule] of [['seccompProfile', 'baseline-seccomp'], ['appArmorProfile', 'baseline-apparmor']]) {
      const type = record(security[field]).type;
      if (type != null && !['RuntimeDefault', 'Localhost'].includes(type)) add(rule, `${path}.securityContext.${field}.type=${type}`);
    }
    const seLinux = record(security.seLinuxOptions);
    const allowedTypes = ['', 'container_t', 'container_init_t', 'container_kvm_t', ...(minor >= 31 ? ['container_engine_t'] : [])];
    for (const field of ['user', 'role', 'type']) {
      if (seLinux[field] && (field !== 'type' || !allowedTypes.includes(seLinux.type))) {
        add('baseline-selinux', `${path}.securityContext.seLinuxOptions.${field}=${seLinux[field]}`);
      }
    }
  }
  for (const [name, profile] of Object.entries(record(metadata.annotations))) {
    if (name.startsWith('container.apparmor.security.beta.kubernetes.io/') && profile !== '' && profile !== 'runtime/default'
      && !(typeof profile === 'string' && profile.startsWith('localhost/'))) {
      add('baseline-apparmor', `metadata.annotations[${name}]=${profile}`);
    }
  }
  const safeSysctls = new Set(['kernel.shm_rmid_forced', 'net.ipv4.ip_local_port_range',
    'net.ipv4.ip_unprivileged_port_start', 'net.ipv4.tcp_syncookies', 'net.ipv4.ping_group_range',
    ...(minor >= 27 ? ['net.ipv4.ip_local_reserved_ports'] : []),
    ...(minor >= 29 ? ['net.ipv4.tcp_keepalive_time', 'net.ipv4.tcp_fin_timeout', 'net.ipv4.tcp_keepalive_intvl', 'net.ipv4.tcp_keepalive_probes'] : []),
    ...(minor >= 32 ? ['net.ipv4.tcp_rmem', 'net.ipv4.tcp_wmem'] : [])]);
  for (const sysctl of records(podSecurity.sysctls)) {
    const name = String(sysctl.name || '');
    if (!safeSysctls.has(name)) add('baseline-sysctls', `spec.securityContext.sysctls[${name}] is not in the v1.${minor} safe allowlist`);
  }

  for (const { container, field, path, security } of containers) {
    if (security.privileged === true) add('baseline-privileged', `${path}.securityContext.privileged=true`);
    const capabilities = record(security.capabilities);
    const added = Array.isArray(capabilities.add) ? capabilities.add : [];
    const forbidden = added.filter((capability) => !BASELINE_CAPABILITIES.has(capability));
    if (forbidden.length) add('baseline-capabilities', `${path}.securityContext.capabilities.add=${forbidden.join(', ')}`);
    if (security.procMount != null && security.procMount !== 'Default') add('baseline-proc-mount', `${path}.securityContext.procMount=${security.procMount}`);
    for (const port of records(container.ports)) {
      if (port.hostPort != null && port.hostPort !== 0) add('baseline-host-port', `${path}.ports.hostPort=${port.hostPort}`);
    }
    if (minor >= 34 && field !== 'ephemeralContainers') {
      for (const [probe, host] of probeHosts(container)) add('baseline-host-probes', `${path}.${probe}=${host}`);
    }
    const nonRoot = security.runAsNonRoot ?? podSecurity.runAsNonRoot;
    const user = security.runAsUser ?? podSecurity.runAsUser;
    const seccomp = record(security.seccompProfile ?? podSecurity.seccompProfile).type;
    const minimizedCapabilities = Array.isArray(capabilities.drop) && capabilities.drop.includes('ALL')
      && added.every((capability) => capability === 'NET_BIND_SERVICE');
    if (restricted) {
      if (nonRoot !== true || user === 0) add('restricted-non-root', `${path}: effective runAsNonRoot=${nonRoot ?? 'unset'}, runAsUser=${user ?? 'unknown (image-dependent)'}`);
      if (record(spec.os).name !== 'windows' || minor < 25) {
        if (!['RuntimeDefault', 'Localhost'].includes(seccomp)) add('restricted-seccomp', `${path}: effective seccompProfile.type=${seccomp ?? 'unset'}`);
        if (security.allowPrivilegeEscalation !== false) add('restricted-privilege-escalation', `${path}.securityContext.allowPrivilegeEscalation=${security.allowPrivilegeEscalation ?? 'unset'}`);
        if (!minimizedCapabilities) add('restricted-drop-capabilities', `${path}: drop ALL and add only NET_BIND_SERVICE is not configured`);
      }
    }
    if (record(spec.os).name === 'windows') continue;
    if (nonRoot !== true || user === 0) add('hardening-non-root', `${path}: effective runAsNonRoot=${nonRoot ?? 'unset'}, runAsUser=${user ?? 'unknown (image-dependent)'}`);
    if (seccomp == null) add('hardening-seccomp', `${path}: no container or inherited pod seccomp profile; runtime default is unknown`);
    if (security.allowPrivilegeEscalation !== false || security.privileged === true || added.includes('SYS_ADMIN')) {
      add('hardening-privilege-escalation', `${path}: allowPrivilegeEscalation=${security.allowPrivilegeEscalation ?? 'unset'}${security.privileged === true || added.includes('SYS_ADMIN') ? '; privileged/SYS_ADMIN forces escalation capability' : ''}`);
    }
    if (!minimizedCapabilities) {
      add('hardening-drop-capabilities', `${path}: drop ALL and add only NET_BIND_SERVICE is not configured`);
    }
    if (security.readOnlyRootFilesystem !== true) add('hardening-read-only-root', `${path}.securityContext.readOnlyRootFilesystem=${security.readOnlyRootFilesystem ?? 'unset'}`);
  }
  return issues;
}

function assessedIssues(spec, metadata, policy, version) {
  const declared = PSA_MODES.filter((mode) => ['baseline', 'restricted'].includes(policy[mode].level));
  const reference = declared.length ? policy[declared[0]].referenceVersion : `v1.${version.minor}`;
  const benchmark = assess(spec, metadata, Number(reference.slice(3)));
  const issues = new Map([...benchmark].filter(([rule]) => rule.startsWith('hardening-'))
    .map(([rule, evidence]) => [rule, { evidence, references: [] }]));
  const contexts = declared.length ? declared.map((mode) => ({ mode, ...policy[mode] }))
    : [{ mode: 'benchmark', level: 'baseline', referenceVersion: reference, versionAssumed: version.assumed }];
  for (const context of contexts) {
    const label = context.mode === 'benchmark' ? `Baseline benchmark (${context.referenceVersion} reference)`
      : `Namespace PSA ${context.mode}=${context.level}, version=${context.version}, reference=${context.referenceVersion}`;
    for (const [rule, evidence] of assess(spec, metadata, Number(context.referenceVersion.slice(3)), context.level === 'restricted')) {
      if (rule.startsWith('hardening-')) continue;
      if (!issues.has(rule)) issues.set(rule, { evidence: [], references: [] });
      const issue = issues.get(rule);
      issue.evidence.push(...evidence, `${label}${context.versionAssumed ? ' (version coverage is partial)' : ''}`);
      issue.references.push(label);
      if (rule.startsWith('restricted-')) issues.delete(rule.replace('restricted-', 'hardening-'));
    }
  }
  return { issues, baselineVersions: [...new Set(contexts.map((context) => context.referenceVersion))].sort() };
}

/** Pure inventory analysis, not a Pod Security Admission decision. */
export function analyzeWorkloadPosture({ pods = [], workloads = [], namespaces = [], kubernetesVersion } = {}) {
  const version = referenceVersion(kubernetesVersion);
  const inventory = new Map();
  for (const [values, fallbackKind] of [[pods, 'Pod'], [workloads, '']]) {
    for (const value of records(values)) {
      const kind = value.kind || fallbackKind;
      if (typeof record(value.metadata).name !== 'string' || !value.metadata.name || (kind !== 'Pod' && !WORKLOAD_KINDS.has(kind))) continue;
      inventory.set(key(resource(value, kind)), { value, kind });
    }
  }
  const entries = [...inventory.values()];
  const livePods = entries.filter(({ value, kind }) => kind === 'Pod' && !completed(value, kind));
  const namespaceInventory = new Map(records(namespaces).filter((raw) => typeof record(raw.metadata).name === 'string' && raw.metadata.name)
    .map((raw) => [raw.metadata.name, raw]));
  const namespaceNames = new Set([...namespaceInventory.keys(), ...entries.map(({ value, kind }) => resource(value, kind).namespace)]);
  const namespacePolicies = new Map([...namespaceNames].sort().map((name) => [name, namespacePolicy(name, namespaceInventory.get(name), version)]));
  let excludedCompletedResources = 0;
  let excludedHistoricalReplicaSets = 0;
  let skippedResources = 0;
  const groups = new Map();
  for (const { value, kind } of inventory.values()) {
    if (completed(value, kind)) { excludedCompletedResources++; continue; }
    const ref = resource(value, kind);
    if (kind === 'ReplicaSet' && controller(value)?.kind === 'Deployment' && record(value.spec).replicas === 0
      && !(record(value.status).replicas > 0) && !livePods.some(({ value: live }) => {
        const owner = controller(live);
        return resource(live, 'Pod').namespace === ref.namespace && owner?.kind === 'ReplicaSet'
          && (owner.uid && ref.uid ? owner.uid === ref.uid : owner.name === ref.name);
      })) { excludedHistoricalReplicaSets++; continue; }
    const template = kind === 'Pod' ? value : kind === 'CronJob'
      ? record(record(record(value.spec).jobTemplate).spec).template : record(value.spec).template;
    const spec = record(record(template).spec);
    const metadata = record(record(template).metadata);
    if (!records(spec.containers).length) { skippedResources++; continue; }
    const lineage = lineageOf(value, kind, entries);
    const fingerprint = JSON.stringify([key(lineage), securityConfiguration(spec, metadata)]);
    if (!groups.has(fingerprint)) groups.set(fingerprint, { spec, metadata, lineage, affectedResources: [] });
    groups.get(fingerprint).affectedResources.push(ref);
  }
  const findings = [];
  const items = [];
  for (const group of groups.values()) {
    group.affectedResources.sort((a, b) => Number(a.kind === 'Pod') - Number(b.kind === 'Pod') || key(a).localeCompare(key(b)));
    const ref = group.affectedResources[0];
    const system = SYSTEM_NAMESPACES.has(ref.namespace);
    const findingIds = [];
    let baselineViolations = 0;
    let restrictedViolations = 0;
    let hardeningChecks = 0;
    const policy = namespacePolicies.get(ref.namespace);
    const { issues, baselineVersions } = assessedIssues(group.spec, group.metadata, policy, version);
    for (const [rule, issue] of issues) {
      const [title, severity, recommendation] = RULES[rule];
      const baseline = rule.startsWith('baseline-');
      const restricted = rule.startsWith('restricted-');
      if (baseline) baselineViolations++; else if (restricted) restrictedViolations++; else hardeningChecks++;
      const id = `workload:${rule}:${key(ref)}`;
      findingIds.push(id);
      findings.push({ id, category: 'workload', severity, title: `${baseline ? 'PSS Baseline' : restricted ? 'PSS Restricted' : 'Hardening'}: ${title}`,
        message: baseline || restricted ? `Configuration does not meet this implemented ${baseline ? 'Baseline' : 'Restricted'} check for ${issue.references.join('; ')}. This is not a full compliance, admission or runtime enforcement verdict.`
          : 'Optional hardening beyond Baseline is not configured; this is not a PSS Baseline violation or proof of runtime behavior.',
        resource: { ...ref }, evidence: [...new Set(issue.evidence)].sort().concat(group.affectedResources
          .map((affected) => `Affected resource: ${affected.kind} ${affected.namespace}/${affected.name}${affected.uid ? ` (uid: ${affected.uid})` : ''}`)),
        recommendation, system });
    }
    items.push({ id: `workload:configuration:${key(ref)}`, type: 'workload', resource: { ...ref }, system,
      lineage: group.lineage, namespacePolicy: policy, baselineVersions,
      affectedResources: group.affectedResources, baselineViolations, restrictedViolations, hardeningChecks, findingIds: findingIds.sort() });
  }
  const partialReasons = [];
  if (version.assumed) {
    partialReasons.push(`Kubernetes ${kubernetesVersion || 'version unknown'} is outside verified version coverage; only the v1.34 reference is available unless a namespace pins a supported version.`);
    if (kubernetesVersion || items.length) findings.push({ id: 'workload:version-coverage:cluster', category: 'workload', severity: 'info',
      title: 'Workload version coverage is partial', message: partialReasons[0],
      resource: { kind: 'Cluster', name: 'kubernetes', namespace: '' }, evidence: ['Supported PSS reference versions: v1.23-v1.34', 'Checks added or changed in other versions are not fully assessed.'],
      recommendation: 'Use an analyzer supporting the cluster version; review these results only as reference checks, not a compliance verdict.', system: false });
  }
  for (const policy of namespacePolicies.values()) {
    if (!policy.observed) partialReasons.push(`Namespace PSA metadata is unavailable for ${policy.namespace}; labels and cluster defaults are unknown.`);
    const unsupported = PSA_MODES.filter((mode) => policy[mode].declared && (policy[mode].versionAssumed || !policy[mode].valid));
    if (!unsupported.length) continue;
    partialReasons.push(`Namespace ${policy.namespace} has PSA modes with unknown or unsupported level/version coverage.`);
    findings.push({ id: `workload:namespace-version-coverage:${encodeURIComponent(policy.namespace)}`, category: 'workload', severity: 'info',
      title: 'Namespace PSA reference coverage is partial', message: partialReasons[partialReasons.length - 1],
      resource: { kind: 'Namespace', name: policy.namespace, namespace: '' },
      evidence: unsupported.map((mode) => `${mode}=${policy[mode].level}, version=${policy[mode].version}, assessed reference=${policy[mode].referenceVersion}`),
      recommendation: 'Validate the namespace PSA labels and use an analyzer supporting their declared versions; the fallback is not the effective admission version.',
      system: SYSTEM_NAMESPACES.has(policy.namespace) });
  }
  if (skippedResources) partialReasons.push(`${skippedResources} workload resource(s) lacked an assessable pod template.`);
  items.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { findings, coverage: {
    assessedResources: items.reduce((sum, item) => sum + item.affectedResources.length, 0),
    uniqueConfigurations: items.length, namespaces: namespaceNames.size,
    excludedCompletedResources, excludedHistoricalReplicaSets, skippedResources,
    baselineVersion: `v1.${version.minor}`, versionAssumed: version.assumed, enforcement: 'unknown',
    requestedVersion: kubernetesVersion || null, supportedVersionRange: 'v1.23-v1.34',
    partial: partialReasons.length > 0, status: partialReasons.length ? 'partial' : 'assessed', partialReasons,
    namespacePolicies: [...namespacePolicies.values()], restrictedAssessment: 'implemented-checks-only',
    notes: ['PSS reference versions 1.23-1.34 are supported; missing, invalid or unsupported versions use v1.34 explicitly as a reference.',
      'Declared Restricted requirements are assessed only for non-root, seccomp, privilege escalation and capabilities; this is not a full Restricted compliance assessment.',
      'Namespace enforce/audit/warn labels and their version pins are reported separately; absent labels do not establish the absence of cluster-wide PSA defaults or exemptions.',
      'Only supplied inventory is assessed; image users, runtime defaults, feature gates, exemptions and actual enforcement are unknown.',
      'Equivalent security configurations are grouped only within a controller lineage; all assessed resources and differing active configurations are retained.']
  }, items };
}
