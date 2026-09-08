// Provider configuration is inventory, not proof of admission coverage or image trust.
const NATIVE = 'admissionregistration.k8s.io';
const RESULTS = ['pass', 'fail', 'warn', 'error', 'skip'];
const PROVIDERS = {
  native: 'Kubernetes Admission Policies', kyverno: 'Kyverno', gatekeeper: 'Gatekeeper',
  kubewarden: 'Kubewarden', wgpolicy: 'Policy Reports', openreports: 'OpenReports',
};
const KINDS = {
  [NATIVE]: ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'MutatingAdmissionPolicy', 'MutatingAdmissionPolicyBinding',
    'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration'],
  'kyverno.io': ['Policy', 'ClusterPolicy', 'CleanupPolicy', 'ClusterCleanupPolicy', 'PolicyException'],
  'policies.kyverno.io': ['ValidatingPolicy', 'MutatingPolicy', 'GeneratingPolicy', 'DeletingPolicy', 'ImageValidatingPolicy',
    'NamespacedValidatingPolicy', 'NamespacedMutatingPolicy', 'NamespacedGeneratingPolicy', 'NamespacedDeletingPolicy',
    'NamespacedImageValidatingPolicy', 'PolicyException'],
  'templates.gatekeeper.sh': ['ConstraintTemplate'],
  'policies.kubewarden.io': ['AdmissionPolicy', 'ClusterAdmissionPolicy', 'AdmissionPolicyGroup', 'ClusterAdmissionPolicyGroup', 'PolicyServer'],
  'wgpolicyk8s.io': ['PolicyReport', 'ClusterPolicyReport'],
  'openreports.io': ['Report', 'ClusterReport'],
};
const CORE_KINDS = new Set(['Pod', 'Namespace', 'Node', 'Service', 'ServiceAccount', 'Secret', 'ConfigMap',
  'PersistentVolume', 'PersistentVolumeClaim', 'ResourceQuota', 'LimitRange', 'ReplicationController', 'Endpoints']);
const NAMESPACED_KINDS = new Set(['Pod', 'Service', 'ServiceAccount', 'Secret', 'ConfigMap', 'PersistentVolumeClaim',
  'ResourceQuota', 'LimitRange', 'ReplicationController', 'Endpoints', 'Deployment', 'StatefulSet', 'DaemonSet',
  'ReplicaSet', 'Job', 'CronJob', 'Ingress', 'NetworkPolicy']);
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const INVENTORY_KINDS = {
  Pod: ['', 'pods'], Namespace: ['', 'namespaces'], Deployment: ['apps', 'workloads'],
  StatefulSet: ['apps', 'workloads'], DaemonSet: ['apps', 'workloads'], ReplicaSet: ['apps', 'workloads'],
  Job: ['batch', 'workloads'], CronJob: ['batch', 'workloads'], ReplicationController: ['', 'workloads'],
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,511}$/.test(value) ? value : '';
const choice = (value, allowed) => allowed.includes(value) ? value : undefined;
const bool = (value) => typeof value === 'boolean' ? value : undefined;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
const groupOf = (value) => typeof value === 'string' && value.includes('/') ? value.split('/')[0] : '';
const meta = (value) => object(object(value).metadata);
const key = (...parts) => parts.map((part) => encodeURIComponent(part ?? '')).join(':');
const ordered = (values) => [...values].sort((a, b) => a.id.localeCompare(b.id));

function providerFor(group, kind) {
  if (group === 'constraints.gatekeeper.sh' && identifier(kind)) return 'gatekeeper';
  if (!Object.hasOwn(KINDS, group) || !KINDS[group].includes(kind)) return '';
  if (group === NATIVE) return 'native';
  if (group === 'kyverno.io' || group === 'policies.kyverno.io') return 'kyverno';
  if (group === 'templates.gatekeeper.sh') return 'gatekeeper';
  if (group === 'policies.kubewarden.io') return 'kubewarden';
  return group === 'openreports.io' ? 'openreports' : 'wgpolicy';
}

function timestamp(value) {
  let millis;
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    millis = Date.parse(value);
  } else {
    const { seconds, nanos = 0 } = object(value);
    if (!Number.isSafeInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) return undefined;
    millis = seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined;
}

function resourceRef(raw) {
  return compact({ kind: identifier(raw.kind), name: identifier(meta(raw).name),
    namespace: identifier(meta(raw).namespace), uid: identifier(meta(raw).uid) || undefined });
}

function rawKey(raw) {
  const ref = resourceRef(raw);
  return key(groupOf(raw.apiVersion), ref.kind, ref.namespace, ref.name, ref.uid);
}

function uniqueResources(values) {
  const snapshots = new Map();
  for (const raw of list(values)) {
    const id = rawKey(raw);
    const previous = snapshots.get(id);
    const rv = meta(raw).resourceVersion;
    const oldRv = meta(previous).resourceVersion;
    // Resource versions select duplicate object snapshots only, never evaluation freshness.
    const newer = typeof rv === 'string' && /^\d+$/.test(rv) && typeof oldRv === 'string' && /^\d+$/.test(oldRv)
      && BigInt(rv) > BigInt(oldRv);
    if (!previous || newer) snapshots.set(id, raw);
  }
  return [...snapshots.values()];
}

function actionsMode(actions) {
  if (!Array.isArray(actions)) return 'unknown';
  if (actions.includes('Deny')) return 'enforce';
  if (actions.includes('Warn')) return 'warn';
  if (actions.includes('Audit')) return 'audit';
  return 'unknown';
}

function combineModes(modes) {
  const unique = [...new Set(modes)];
  return unique.length === 1 ? unique[0] : unique.length ? 'mixed' : 'unknown';
}

function legacyMode(spec) {
  const mode = (value) => value === 'Enforce' ? 'enforce' : value === 'Audit' ? 'audit' : 'unknown';
  const base = spec.validationFailureAction ?? 'Audit';
  const modes = list(spec.rules).map((rule) => {
    if (rule.validate || list(rule.verifyImages).length) return mode(object(rule.validate).failureAction ?? base);
    return rule.mutate ? 'mutate' : rule.generate ? 'generate' : 'unknown';
  });
  const overrides = [...list(spec.validationFailureActionOverrides),
    ...list(spec.rules).flatMap((rule) => list(object(rule.validate).failureActionOverrides))];
  for (const override of overrides) modes.push(mode(override.action));
  return combineModes(modes);
}

const SUMMARY_LIMIT = 64;
const SENSITIVE_KEY = /password|token|secret|credential|private.?key|authorization|certificate/i;
const pattern = (value) => typeof value === 'string' && /^[A-Za-z0-9_*?./-]{0,253}$/.test(value) ? value : undefined;
const patterns = (value) => Array.isArray(value) ? [...new Set(value.map(pattern).filter((entry) => entry !== undefined))].slice(0, SUMMARY_LIMIT) : undefined;
const names = (value) => Array.isArray(value) ? [...new Set(value.map(identifier).filter(Boolean))].slice(0, SUMMARY_LIMIT) : undefined;
const enums = (value, allowed) => Array.isArray(value) ? [...new Set(value.filter((entry) => allowed.includes(entry)))].slice(0, SUMMARY_LIMIT) : undefined;
const optionalObject = (value, summarize) => value && typeof value === 'object' && !Array.isArray(value) ? summarize(value) : undefined;
const imagePattern = (value) => typeof value === 'string' && value.length <= 512 && !value.includes('://')
  && /^[A-Za-z0-9*?._/:-]+(?:@sha256:[a-fA-F0-9*?]+)?$/.test(value) ? value : undefined;

function verifyImages(value) {
  return Array.isArray(value) ? list(value).slice(0, SUMMARY_LIMIT).map((entry) => compact({
    type: choice(entry.type, ['Cosign', 'Notary']),
    imageReferences: Array.isArray(entry.imageReferences) ? entry.imageReferences.map(imagePattern).filter(Boolean).slice(0, SUMMARY_LIMIT) : undefined,
    required: bool(entry.required), verifyDigest: bool(entry.verifyDigest), mutateDigest: bool(entry.mutateDigest),
    attestorCount: list(entry.attestors).length, attestationCount: list(entry.attestations).length,
  })) : undefined;
}

function selector(value) {
  return optionalObject(value, (raw) => {
    const labelValue = (entry) => typeof entry === 'string' && /^[A-Za-z0-9_.-]{0,63}$/.test(entry);
    const labels = Object.entries(object(raw.matchLabels));
    const expressions = list(raw.matchExpressions);
    const matchLabels = Object.fromEntries(labels.filter(([name, entry]) => identifier(name) && !SENSITIVE_KEY.test(name) && labelValue(entry))
      .slice(0, SUMMARY_LIMIT));
    const matchExpressions = expressions.filter((entry) => identifier(entry.key) && !SENSITIVE_KEY.test(entry.key)
      && ['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(entry.operator)).slice(0, SUMMARY_LIMIT).map((entry) => compact({
      key: identifier(entry.key), operator: entry.operator,
      values: Array.isArray(entry.values) ? entry.values.filter(labelValue).slice(0, SUMMARY_LIMIT) : undefined,
    }));
    return compact({ matchLabels: raw.matchLabels ? matchLabels : undefined,
      matchExpressions: raw.matchExpressions ? matchExpressions : undefined,
      summaryIncomplete: labels.length > Object.keys(matchLabels).length || expressions.length > matchExpressions.length
        || expressions.some((entry) => Array.isArray(entry.values) && (entry.values.length > SUMMARY_LIMIT || entry.values.some((v) => !labelValue(v)))) ? true : undefined });
  });
}

function matchRules(value) {
  return Array.isArray(value) ? list(value).slice(0, SUMMARY_LIMIT).map((rule) => compact({
    apiGroups: patterns(rule.apiGroups), apiVersions: patterns(rule.apiVersions), resources: patterns(rule.resources),
    resourceNames: patterns(rule.resourceNames), operations: enums(rule.operations, ['*', 'CREATE', 'UPDATE', 'DELETE', 'CONNECT']),
    scope: choice(rule.scope, ['*', 'Cluster', 'Namespaced']),
  })) : undefined;
}

function matchConstraints(value) {
  return optionalObject(value, (raw) => compact({ resourceRules: matchRules(raw.resourceRules), excludeResourceRules: matchRules(raw.excludeResourceRules),
    matchPolicy: choice(raw.matchPolicy, ['Exact', 'Equivalent']), namespaceSelector: selector(raw.namespaceSelector), objectSelector: selector(raw.objectSelector) }));
}

function kyvernoMatch(value) {
  const filter = (raw) => compact({ resources: optionalObject(raw.resources, (resources) => compact({ kinds: patterns(resources.kinds),
    namespaces: patterns(resources.namespaces), names: patterns(resources.names), name: pattern(resources.name),
    operations: enums(resources.operations, ['*', 'CREATE', 'UPDATE', 'DELETE', 'CONNECT']),
    selector: selector(resources.selector), namespaceSelector: selector(resources.namespaceSelector) })),
  roles: names(raw.roles), clusterRoles: names(raw.clusterRoles),
  subjects: Array.isArray(raw.subjects) ? list(raw.subjects).slice(0, SUMMARY_LIMIT).map((subject) => compact({
    kind: choice(subject.kind, ['User', 'Group', 'ServiceAccount']), name: identifier(subject.name) || undefined,
    namespace: identifier(subject.namespace) || undefined,
  })) : undefined });
  return optionalObject(value, (raw) => compact({ ...filter(raw),
    any: Array.isArray(raw.any) ? list(raw.any).slice(0, SUMMARY_LIMIT).map(filter) : undefined,
    all: Array.isArray(raw.all) ? list(raw.all).slice(0, SUMMARY_LIMIT).map(filter) : undefined }));
}

function gatekeeperMatch(value) {
  return optionalObject(value, (raw) => compact({ scope: choice(raw.scope, ['*', 'Cluster', 'Namespaced']),
    kinds: Array.isArray(raw.kinds) ? list(raw.kinds).slice(0, SUMMARY_LIMIT).map((entry) => compact({ apiGroups: patterns(entry.apiGroups), kinds: patterns(entry.kinds) })) : undefined,
    namespaces: patterns(raw.namespaces), excludedNamespaces: patterns(raw.excludedNamespaces), name: pattern(raw.name),
    labelSelector: selector(raw.labelSelector), namespaceSelector: selector(raw.namespaceSelector), source: choice(raw.source, ['All', 'Original', 'Generated']) }));
}

function paramRef(value) {
  return optionalObject(value, (raw) => compact({ name: identifier(raw.name) || undefined, namespace: identifier(raw.namespace) || undefined,
    parameterNotFoundAction: choice(raw.parameterNotFoundAction, ['Allow', 'Deny']), selector: selector(raw.selector) }));
}

function kubewardenConditions(value) {
  return list(value).filter((entry) => ['PolicyActive', 'PolicyUniquelyReachable', 'PolicyServerConfigurationUpToDate',
    'PolicyWebhooksCleanedUp', 'Ready', 'Available'].includes(entry.type) && ['True', 'False', 'Unknown'].includes(entry.status))
    .slice(0, SUMMARY_LIMIT).map((entry) => compact({ type: entry.type, status: entry.status,
      observedGeneration: count(entry.observedGeneration), lastTransitionTime: timestamp(entry.lastTransitionTime) }));
}

function safeCommon(spec) {
  return compact({
    failurePolicy: choice(spec.failurePolicy, ['Fail', 'Ignore']),
    matchPolicy: choice(spec.matchPolicy, ['Exact', 'Equivalent']),
    matchConstraints: matchConstraints(spec.matchConstraints),
    namespaceSelector: selector(spec.namespaceSelector), objectSelector: selector(spec.objectSelector),
    matchConditionNames: Array.isArray(spec.matchConditions) ? names(list(spec.matchConditions).map((entry) => entry.name)) : undefined,
    matchConditionCount: Array.isArray(spec.matchConditions) ? list(spec.matchConditions).length : undefined,
    matchResourceRuleCount: Array.isArray(object(spec.matchConstraints).resourceRules) ? list(spec.matchConstraints.resourceRules).length : undefined,
  });
}

function policyItem(raw, provider, resources) {
  const spec = object(raw.spec);
  const status = object(raw.status);
  const { kind, name, namespace } = resourceRef(raw);
  let mode = 'unknown';
  let ruleCount = 0;
  let summary = 'Policy configuration observed; effective admission coverage is not verified.';
  const configuration = safeCommon(spec);
  configuration.summaryLimit = SUMMARY_LIMIT;
  configuration.summaryNotice = 'Allowlisted configuration only; lists are capped at 64 entries and expressions and parameter values are omitted. Do not infer effective coverage from this summary.';
  let evaluatedAt;
  if (provider === 'native') {
    const mutating = kind.startsWith('Mutating');
    const binding = kind.endsWith('Binding');
    const policyKind = mutating ? 'MutatingAdmissionPolicy' : 'ValidatingAdmissionPolicy';
    configuration.reinvocationPolicy = choice(spec.reinvocationPolicy, ['Never', 'IfNeeded']);
    if (kind.endsWith('WebhookConfiguration')) {
      mode = 'webhook';
      const webhooks = list(raw.webhooks);
      ruleCount = webhooks.reduce((sum, webhook) => sum + list(webhook.rules).length, 0);
      configuration.webhookCount = webhooks.length;
      configuration.webhooks = webhooks.slice(0, SUMMARY_LIMIT).map((webhook) => compact({
        name: identifier(webhook.name), type: mutating ? 'mutating' : 'validating', ...safeCommon(webhook),
        rules: matchRules(webhook.rules), sideEffects: choice(webhook.sideEffects, ['None', 'NoneOnDryRun', 'Some', 'Unknown']),
        timeoutSeconds: count(webhook.timeoutSeconds), reinvocationPolicy: choice(webhook.reinvocationPolicy, ['Never', 'IfNeeded']),
        admissionReviewVersions: names(webhook.admissionReviewVersions),
        service: optionalObject(object(webhook.clientConfig).service, (service) => compact({ name: identifier(service.name) || undefined,
          namespace: identifier(service.namespace) || undefined, port: count(service.port) })),
        externalEndpointConfigured: typeof object(webhook.clientConfig).url === 'string' || undefined,
      }));
      summary = 'Admission webhook configuration observed; endpoint availability and effective enforcement are not verified.';
    } else if (binding) {
      configuration.policyName = identifier(spec.policyName) || undefined;
      configuration.policyPresent = resources.some((entry) => groupOf(entry.apiVersion) === NATIVE && entry.kind === policyKind
        && meta(entry).name === spec.policyName && !meta(entry).deletionTimestamp);
      mode = configuration.policyPresent ? (mutating ? 'mutate' : actionsMode(spec.validationActions)) : 'unbound';
      configuration.paramRef = paramRef(spec.paramRef);
      configuration.matchResources = matchConstraints(spec.matchResources);
      configuration.validationActions = Array.isArray(spec.validationActions)
        ? [...new Set(spec.validationActions.filter((action) => ['Deny', 'Audit', 'Warn'].includes(action)))].sort() : undefined;
      summary = 'Binding configuration observed; matching resources and parameters are not evaluated.';
    } else {
      const bindings = resources.filter((entry) => groupOf(entry.apiVersion) === NATIVE && entry.kind === `${policyKind}Binding`
        && object(entry.spec).policyName === name && !meta(entry).deletionTimestamp);
      configuration.bindingCount = bindings.length;
      configuration.bindingNames = names(bindings.map((entry) => meta(entry).name));
      configuration.paramKind = optionalObject(spec.paramKind, (param) => compact({ apiVersion: identifier(param.apiVersion) || undefined,
        kind: identifier(param.kind) || undefined }));
      ruleCount = list(mutating ? spec.mutations : spec.validations).length;
      mode = bindings.length ? (mutating ? 'mutate' : combineModes(bindings.map((entry) => actionsMode(object(entry.spec).validationActions)))) : 'unbound';
      configuration.typeCheckWarningCount = list(object(status.typeChecking).expressionWarnings).length;
    }
  } else if (provider === 'kyverno') {
    if (kind === 'PolicyException') {
      mode = 'exception';
      configuration.match = kyvernoMatch(spec.match);
      configuration.exceptions = Array.isArray(spec.exceptions) ? list(spec.exceptions).slice(0, SUMMARY_LIMIT).map((exception) => compact({
        policyName: identifier(exception.policyName) || undefined, ruleNames: names(exception.ruleNames) })) : undefined;
      configuration.policyRefs = Array.isArray(spec.policyRefs) ? list(spec.policyRefs).slice(0, SUMMARY_LIMIT).map((ref) => compact({
        name: identifier(ref.name) || undefined, kind: choice(ref.kind, KINDS['policies.kyverno.io']) })) : undefined;
      ruleCount = list(spec.exceptions).length + list(spec.policyRefs).length;
      configuration.exceptionCount = ruleCount;
    } else if (kind.includes('Cleanup')) {
      mode = 'cleanup';
      configuration.scheduleConfigured = typeof spec.schedule === 'string' && spec.schedule.length > 0;
    } else if (groupOf(raw.apiVersion) === 'kyverno.io') {
      ruleCount = list(spec.rules).length;
      configuration.rules = list(spec.rules).slice(0, SUMMARY_LIMIT).map((rule) => compact({ name: identifier(rule.name),
        match: kyvernoMatch(rule.match), exclude: kyvernoMatch(rule.exclude),
        verifyImages: verifyImages(rule.verifyImages),
        type: rule.validate ? 'validate' : rule.mutate ? 'mutate' : rule.generate ? 'generate' : list(rule.verifyImages).length ? 'verifyImages' : 'unknown',
        failureAction: choice(object(rule.validate).failureAction, ['Audit', 'Enforce']),
        failureActionOverrides: Array.isArray(object(rule.validate).failureActionOverrides) ? list(rule.validate.failureActionOverrides).slice(0, SUMMARY_LIMIT)
          .map((override) => compact({ action: choice(override.action, ['Audit', 'Enforce']), namespaces: patterns(override.namespaces) })) : undefined,
      }));
      configuration.validationFailureActionOverrides = Array.isArray(spec.validationFailureActionOverrides) ? list(spec.validationFailureActionOverrides)
        .slice(0, SUMMARY_LIMIT).map((override) => compact({ action: choice(override.action, ['Audit', 'Enforce']), namespaces: patterns(override.namespaces) })) : undefined;
      mode = legacyMode(spec);
      configuration.background = bool(spec.background);
      configuration.admission = bool(spec.admission);
      configuration.validationFailureAction = choice(spec.validationFailureAction, ['Audit', 'Enforce']);
      configuration.overrideCount = list(spec.validationFailureActionOverrides).length
        + list(spec.rules).reduce((sum, rule) => sum + list(object(rule.validate).failureActionOverrides).length, 0);
      configuration.imageVerificationRuleCount = list(spec.rules).filter((rule) => list(rule.verifyImages).length > 0).length;
      if (spec.admission === false) mode = spec.background === false ? 'disabled' : 'background';
    } else {
      const evaluation = object(spec.evaluation);
      configuration.admission = bool(object(evaluation.admission).enabled);
      configuration.background = bool(object(evaluation.background).enabled);
      configuration.validationActions = Array.isArray(spec.validationActions)
        ? [...new Set(spec.validationActions.filter((action) => ['Deny', 'Audit', 'Warn'].includes(action)))].sort() : undefined;
      if (kind.includes('Mutating')) { mode = 'mutate'; ruleCount = list(spec.mutations).length; }
      else if (kind.includes('Generating')) { mode = 'generate'; ruleCount = list(spec.generate).length; }
      else if (kind.includes('Deleting')) { mode = 'delete'; ruleCount = list(spec.conditions).length; }
      else { mode = actionsMode(spec.validationActions); ruleCount = list(spec.validations).length; }
      if (configuration.admission === false) mode = configuration.background === false ? 'disabled' : 'background';
      if (kind.includes('ImageValidating')) {
        configuration.imageVerification = true;
        configuration.attestorCount = list(spec.attestors).length;
        configuration.attestationCount = list(spec.attestations).length;
        configuration.imageMatchCount = list(spec.matchImageReferences).length;
        configuration.matchImageReferences = list(spec.matchImageReferences).filter((ref) => imagePattern(ref.glob))
          .slice(0, SUMMARY_LIMIT).map((ref) => ({ glob: imagePattern(ref.glob) }));
        const validation = object(spec.validationConfigurations);
        configuration.mutateDigest = bool(validation.mutateDigest);
        configuration.verifyDigest = bool(validation.verifyDigest);
        configuration.required = bool(validation.required);
      }
    }
    if (configuration.imageVerificationRuleCount > 0) configuration.imageVerification = true;
    if (configuration.imageVerification) summary = 'Image verification policy configured; image trust and effective coverage are not verified.';
  } else if (provider === 'gatekeeper') {
    if (kind === 'ConstraintTemplate') {
      mode = 'template';
      configuration.constraintKind = identifier(object(object(object(spec.crd).spec).names).kind) || undefined;
      configuration.targetCount = list(spec.targets).length;
      summary = 'Constraint template installed; enforcement requires constraint instances.';
    } else {
      const action = spec.enforcementAction ?? 'deny';
      mode = action === 'deny' ? 'enforce' : action === 'dryrun' ? 'audit' : action === 'warn' ? 'warn' : 'unknown';
      ruleCount = 1;
      configuration.match = gatekeeperMatch(spec.match);
      configuration.enforcementAction = choice(action, ['deny', 'dryrun', 'warn', 'scoped']);
      configuration.totalViolations = count(status.totalViolations);
      configuration.violationDetailCount = list(status.violations).length;
      configuration.omittedViolationCount = configuration.totalViolations === undefined ? undefined
        : Math.max(0, configuration.totalViolations - configuration.violationDetailCount);
      evaluatedAt = timestamp(status.auditTimestamp);
    }
  } else if (provider === 'kubewarden') {
    configuration.conditions = kubewardenConditions(status.conditions);
    configuration.policyStatus = choice(status.policyStatus, ['unscheduled', 'scheduled', 'pending', 'active']);
    configuration.observedMode = choice(status.mode, ['protect', 'monitor']);
    if (kind === 'PolicyServer') {
      mode = 'server';
      configuration.replicas = count(spec.replicas);
      summary = 'Policy server configuration observed; server availability is not verified.';
    } else {
      mode = spec.mode === 'protect' || spec.mode === undefined || spec.mode === '' ? 'enforce' : spec.mode === 'monitor' ? 'audit' : 'unknown';
      ruleCount = kind.endsWith('Group') ? Object.keys(object(spec.policies)).length : 1;
      configuration.memberNames = kind.endsWith('Group') ? names(Object.keys(object(spec.policies))) : undefined;
      configuration.rules = matchRules(spec.rules);
      configuration.policyServer = identifier(spec.policyServer) || undefined;
      configuration.mutating = bool(spec.mutating);
      configuration.backgroundAudit = bool(spec.backgroundAudit);
      configuration.matchRuleCount = list(spec.rules).length;
      configuration.moduleConfigured = typeof spec.module === 'string' && spec.module.length > 0;
    }
  }
  return compact({ id: key(provider, groupOf(raw.apiVersion), kind, namespace, name), provider, kind, name,
    namespace, mode, ruleCount, summary, configuration: compact(configuration), evaluatedAt });
}

function inventoryResolver(input, resources) {
  const inventory = [...resources, ...list(input.pods).map((entry) => ({ ...entry, kind: entry.kind || 'Pod', apiVersion: entry.apiVersion || 'v1' })),
    ...list(input.namespaces).map((entry) => ({ ...entry, kind: entry.kind || 'Namespace', apiVersion: entry.apiVersion || 'v1' })), ...list(input.workloads)];
  const byIdentity = new Map();
  const byUid = new Map();
  for (const raw of inventory) {
    const ref = resourceRef(raw);
    if (!ref.kind || !ref.name) continue;
    const id = key(ref.kind, ref.namespace, ref.name);
    byIdentity.set(id, [...(byIdentity.get(id) || []), raw]);
    if (ref.uid) byUid.set(ref.uid, [...(byUid.get(ref.uid) || []), raw]);
  }
  return (value, reportNamespace, evaluatedAt) => {
    const target = object(value);
    let kind = identifier(target.kind);
    let name = identifier(target.name);
    let namespace = identifier(target.namespace);
    const uid = identifier(target.uid);
    let apiGroup = typeof target.apiVersion === 'string' ? groupOf(target.apiVersion)
      : typeof target.group === 'string' ? target.group : undefined;
    if (apiGroup === undefined && CORE_KINDS.has(kind)) apiGroup = '';
    if (!namespace && NAMESPACED_KINDS.has(kind)) namespace = reportNamespace;
    if ((!kind || !name) && uid) {
      const candidates = (byUid.get(uid) || []).filter((entry) => (!kind || entry.kind === kind)
        && (!name || meta(entry).name === name) && (!namespace || meta(entry).namespace === namespace)
        && (apiGroup === undefined || groupOf(entry.apiVersion) === apiGroup));
      const identities = new Map(candidates.map((entry) => [rawKey(entry), entry]));
      if (identities.size === 1) {
        const raw = [...identities.values()][0];
        ({ kind, name, namespace } = resourceRef(raw));
        apiGroup = groupOf(raw.apiVersion);
      }
    }
    if (!kind || !name) return undefined;
    const candidates = (byIdentity.get(key(kind, namespace, name)) || [])
      .filter((entry) => apiGroup === undefined || groupOf(entry.apiVersion) === apiGroup);
    const groups = new Set(candidates.map((entry) => groupOf(entry.apiVersion)));
    const known = apiGroup !== undefined && groups.size === 1 ? candidates : [];
    // Absence is evidence only for an explicitly complete, supported kind inside the collector's read scope.
    const inventoryKind = Object.hasOwn(INVENTORY_KINDS, kind) ? INVENTORY_KINDS[kind] : undefined;
    const scope = input.namespaceScope;
    const allNamespaces = scope === null || scope === undefined || scope === 'all';
    const inReadScope = allNamespaces || (identifier(scope) && (kind === 'Namespace' ? name === scope : namespace === scope));
    if (!known.length && inventoryKind && apiGroup === inventoryKind[0] && Array.isArray(input[inventoryKind[1]])
      && object(input.inventoryComplete)[kind] === true && inReadScope) return { stale: true, missing: true };
    const live = known.filter((entry) => !meta(entry).deletionTimestamp);
    if (known.length && !live.length) return { stale: true };
    if (uid && live.length && live.every((entry) => identifier(meta(entry).uid) && meta(entry).uid !== uid)) return { stale: true };
    if (evaluatedAt && live.length && live.every((entry) => {
      const createdAt = timestamp(meta(entry).creationTimestamp);
      return createdAt && createdAt > evaluatedAt;
    })) return { stale: true };
    const matched = uid && live.some((entry) => meta(entry).uid === uid);
    return { stale: false, resource: compact({ kind, name, namespace, uid: uid || undefined }),
      identity: key(apiGroup ?? '?', kind, namespace, name, uid),
      freshness: matched ? 'Resource UID matches the supplied inventory; the reported evaluation is not a live recheck.'
        : 'Current resource freshness unverified; scoped inventory does not establish this reported identity.' };
  };
}

function reportItem(raw, provider) {
  const ref = resourceRef(raw);
  const configuration = { resultDetailCount: list(raw.results).length };
  for (const outcome of RESULTS) configuration[`reported${outcome[0].toUpperCase()}${outcome.slice(1)}`] = count(object(raw.summary)[outcome]);
  const times = list(raw.results).map((entry) => timestamp(entry.timestamp)).filter(Boolean).sort();
  return compact({ id: key(provider, groupOf(raw.apiVersion), ref.kind, ref.namespace, ref.name),
    provider, kind: ref.kind, name: ref.name, namespace: ref.namespace, mode: 'report', ruleCount: list(raw.results).length,
    summary: 'Reported evaluation outcomes; current resource freshness is checked separately.',
    configuration: compact(configuration), evaluatedAt: times.at(-1) });
}

function sourceProvider(source) {
  const normalized = source.toLowerCase();
  if (KINDS['policies.kyverno.io'].some((kind) => normalized === `kyverno${kind.toLowerCase()}`)) return 'kyverno';
  if (['kyverno', 'gatekeeper', 'kubewarden'].includes(normalized)) return normalized;
  if (['kubernetes', 'validatingadmissionpolicy', 'kubernetes-validating-admission-policy'].includes(normalized)) return 'native';
  return '';
}

function imageResult(entry, source, target, policies) {
  // Policy names, messages, and arbitrary properties are not evidence of signature verification.
  const provider = sourceProvider(source);
  const policyName = identifier(entry.policy);
  const sourceKind = KINDS['policies.kyverno.io'].find((kind) => source.toLowerCase() === `kyverno${kind.toLowerCase()}`);
  const candidates = policies.filter(({ raw, item }) => item.provider === provider
    && (!sourceKind || sourceKind === item.kind)
    && (policyName === item.name || policyName === `${item.namespace}/${item.name}`)
    && (!item.namespace || item.namespace === target.namespace)
    && !meta(raw).deletionTimestamp);
  if (candidates.length !== 1) return false;
  const { raw, item } = candidates[0];
  if (!item.configuration.imageVerification) return false;
  if (groupOf(raw.apiVersion) === 'policies.kyverno.io') return true;
  return list(object(raw.spec).rules).some((rule) => rule.name === entry.rule && list(rule.verifyImages).length > 0);
}

function finding(id, resource, outcome, severity, evidence, evaluatedAt, category = 'admission') {
  const details = {
    fail: ['Policy violation reported', 'The producer reported a failed policy evaluation. This does not prove the resource is currently noncompliant.', 'Review the policy and re-evaluate the resource before remediation.'],
    error: ['Policy evaluation error', 'The producer could not evaluate the policy. Compliance and image trust are unknown.', 'Resolve the policy engine evaluation error and run evaluation again.'],
    warn: ['Policy warning reported', 'The producer reported a policy warning, not a successful validation.', 'Review the warning and policy scoring or enforcement configuration.'],
    skip: ['Policy evaluation skipped', 'The policy was not evaluated; skipping is not a pass or proof of image trust.', 'Review applicability, preconditions, and policy exceptions before re-evaluating.'],
  };
  const [title, message, recommendation] = details[outcome];
  return compact({ id, category, severity: outcome === 'skip' ? 'info' : outcome === 'fail'
    && ['critical', 'high'].includes(severity) ? 'critical' : 'warning', title, message, resource, evidence,
    recommendation, system: SYSTEM_NAMESPACES.has(resource.namespace)
      || (resource.kind === 'Namespace' && SYSTEM_NAMESPACES.has(resource.name)), evaluatedAt, result: outcome });
}

/**
 * Pure, allowlisted policy inventory and reported evaluations. No selectors, CEL,
 * Rego, WASM or signatures are executed. Absence only proves deletion with explicit
 * in-scope inventory completeness. imageTrust contains policies, never trusted images.
 */
export function analyzeAdmissionPosture(input = {}) {
  input = object(input);
  const resources = uniqueResources(input.resources);
  const items = [];
  const findings = [];
  const providers = new Map();
  const policies = [];
  const reports = [];
  const resolve = inventoryResolver(input, resources);
  function detect(provider, method) {
    const current = providers.get(provider) || { id: provider, name: PROVIDERS[provider], itemCount: 0, reportCount: 0, detectedBy: [] };
    if (!current.detectedBy.includes(method)) current.detectedBy.push(method);
    providers.set(provider, current);
    return current;
  }
  for (const raw of resources) {
    if (meta(raw).deletionTimestamp) continue;
    if (raw.kind === 'CustomResourceDefinition' && groupOf(raw.apiVersion) === 'apiextensions.k8s.io') {
      const provider = providerFor(object(raw.spec).group, object(object(raw.spec).names).kind);
      if (provider) detect(provider, 'crd');
      continue;
    }
    const provider = providerFor(groupOf(raw.apiVersion), raw.kind);
    if (!provider || !identifier(meta(raw).name)) continue;
    const state = detect(provider, 'resource');
    const isReport = provider === 'wgpolicy' || provider === 'openreports';
    const item = isReport ? reportItem(raw, provider) : policyItem(raw, provider, resources);
    state.itemCount++;
    if (isReport) { state.reportCount++; reports.push({ raw, item }); }
    else policies.push({ raw, item });
    items.push(item);
  }

  const observations = new Map();
  for (const { raw, item } of reports) {
    let staleResultCount = 0;
    let missingResourceResultCount = 0;
    for (const entry of list(raw.results)) {
      const outcome = choice(entry.result, RESULTS);
      if (!outcome) continue;
      const source = identifier(entry.source) || identifier(raw.source) || 'unknown';
      const policy = identifier(entry.policy);
      const rule = identifier(entry.rule);
      const evaluatedAt = timestamp(entry.timestamp);
      const refs = list(entry.resources);
      // A selector has no concrete identity; do not borrow the report scope for it.
      const targets = refs.length ? refs : entry.resourceSelector || raw.scopeSelector ? [undefined] : [raw.scope];
      for (const ref of targets) {
        const resolved = resolve(ref, item.namespace, evaluatedAt);
        if (resolved?.stale) { staleResultCount++; if (resolved.missing) missingResourceResultCount++; continue; }
        const resource = resolved?.resource || resourceRef(raw);
        const identity = resolved?.identity || key('report', rawKey(raw));
        const category = resolved && imageResult(entry, source, resource, policies) ? 'image-trust' : 'admission';
        // Deduplicate migrated WG/OpenReports results, but never unrelated unknown producers/policies.
        const id = key('report-result', source === 'unknown' ? rawKey(raw) : source.toLowerCase(), policy || rawKey(raw), rule, identity);
        const evidence = [`Source: ${source}`, ...(policy ? [`Policy: ${policy}`] : []), ...(rule ? [`Rule: ${rule}`] : []),
          resolved?.freshness || 'Evaluated resource identity unavailable; report-level evidence only, freshness unverified.'];
        const candidate = { id, resource, outcome, severity: choice(entry.severity, ['critical', 'high', 'medium', 'low', 'info']),
          evidence, evaluatedAt, category, scored: bool(entry.scored) };
        const old = observations.get(id);
        const rank = { pass: 0, skip: 1, warn: 2, fail: 3, error: 4 };
        const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
        // A timestamp-less pass cannot erase a dated failure. Equal-time conflicts favor uncertainty/failure.
        if (!old || (evaluatedAt && old.evaluatedAt && evaluatedAt > old.evaluatedAt)
          || (!(evaluatedAt && old.evaluatedAt && evaluatedAt !== old.evaluatedAt) && rank[outcome] > rank[old.outcome])
          || (evaluatedAt === old.evaluatedAt && outcome === old.outcome
            && (severityRank[candidate.severity] || 0) > (severityRank[old.severity] || 0))
          || (evaluatedAt && !old.evaluatedAt && outcome === old.outcome)) observations.set(id, candidate);
      }
    }
    item.configuration.staleResultCount = staleResultCount;
    item.configuration.missingResourceResultCount = missingResourceResultCount;
  }
  for (const observation of observations.values()) {
    if (observation.outcome === 'pass') continue;
    const { id, resource, outcome, severity, evidence, evaluatedAt, category, scored } = observation;
    const output = finding(id, resource, outcome, scored === false ? undefined : severity, evidence, evaluatedAt, category);
    if (scored === false) output.evidence.push('Result is not scored.');
    findings.push(output);
  }

  for (const { raw, item } of policies) {
    if (item.provider !== 'gatekeeper' || item.kind === 'ConstraintTemplate') continue;
    const violations = list(object(raw.status).violations);
    const seen = new Set();
    let staleDetailCount = 0;
    for (const violation of violations) {
      const resolved = resolve(violation, '', item.evaluatedAt);
      if (resolved?.stale) { staleDetailCount++; continue; }
      const resource = resolved?.resource || resourceRef(raw);
      const id = key('gatekeeper-violation', item.id, resolved?.identity || 'unknown');
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push(finding(id, resource, 'fail', undefined, [`Constraint: ${item.name}`,
        resolved?.freshness || 'Violation resource identity unavailable; constraint-level evidence only, freshness unverified.'], item.evaluatedAt));
    }
    item.configuration.staleDetailCount = staleDetailCount;
    const omitted = item.configuration.omittedViolationCount;
    if (omitted > 0) {
      const output = finding(key('gatekeeper-truncated', item.id), resourceRef(raw), 'fail', undefined,
        [`Reported totalViolations: ${item.configuration.totalViolations}`, `Reported violation details: ${violations.length}`], item.evaluatedAt);
      output.title = 'Gatekeeper audit details truncated';
      output.message = `${omitted} reported violations have no resource detail in this constraint status. Their resource identities and current freshness are unverified.`;
      output.recommendation = 'Inspect the Gatekeeper audit output or increase the constraint violation detail limit; re-run audit to verify current posture.';
      findings.push(output);
    }
  }
  return { items: ordered(items), findings: ordered(findings), providers: ordered([...providers.values()].map((provider) => ({
    ...provider, detectedBy: [...provider.detectedBy].sort(),
  }))), imageTrust: ordered(items.filter((item) => item.configuration.imageVerification === true)) };
}
