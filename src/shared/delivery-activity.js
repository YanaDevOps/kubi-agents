import { CronExpressionParser } from 'cron-parser';

export const DELIVERY_PROVIDER_IDS = ['argocd', 'flux', 'tekton', 'argo-workflows', 'argo-rollouts', 'flagger'];

const PROVIDER_NAMES = {
  argocd: 'Argo CD',
  flux: 'Flux',
  tekton: 'Tekton',
  'argo-workflows': 'Argo Workflows',
  'argo-rollouts': 'Argo Rollouts',
  flagger: 'Flagger',
  jenkins: 'Jenkins',
  'gitlab-ci': 'GitLab CI',
  drone: 'Drone',
  'forgejo-actions': 'Forgejo Actions',
  'github-actions': 'GitHub Actions'
};

function definition(providerId, category, parser, group, versions, resource, kind, namespaced = true) {
  return { providerId, providerName: PROVIDER_NAMES[providerId], category, parser, group, versions, resource, kind, namespaced };
}

export const DELIVERY_RESOURCE_DEFINITIONS = [
  definition('argocd', 'deployment', 'argo-application', 'argoproj.io', ['v1alpha1'], 'applications', 'Application'),
  definition('argocd', 'deployment', 'argo-appset', 'argoproj.io', ['v1alpha1'], 'applicationsets', 'ApplicationSet'),
  definition('argocd', 'project', 'argo-project', 'argoproj.io', ['v1alpha1'], 'appprojects', 'AppProject'),
  definition('flux', 'deployment', 'flux-deployment', 'kustomize.toolkit.fluxcd.io', ['v1', 'v1beta2'], 'kustomizations', 'Kustomization'),
  definition('flux', 'deployment', 'flux-deployment', 'helm.toolkit.fluxcd.io', ['v2', 'v2beta2'], 'helmreleases', 'HelmRelease'),
  definition('flux', 'source', 'flux-source', 'source.toolkit.fluxcd.io', ['v1', 'v1beta2'], 'gitrepositories', 'GitRepository'),
  definition('flux', 'source', 'flux-source', 'source.toolkit.fluxcd.io', ['v1', 'v1beta2'], 'ocirepositories', 'OCIRepository'),
  definition('flux', 'source', 'flux-source', 'source.toolkit.fluxcd.io', ['v1', 'v1beta2'], 'helmrepositories', 'HelmRepository'),
  definition('flux', 'source', 'flux-source', 'source.toolkit.fluxcd.io', ['v1', 'v1beta2'], 'buckets', 'Bucket'),
  definition('flux', 'deployment', 'flux-deployment', 'image.toolkit.fluxcd.io', ['v1beta2', 'v1beta1'], 'imageupdateautomations', 'ImageUpdateAutomation'),
  definition('tekton', 'project', 'tekton-definition', 'tekton.dev', ['v1', 'v1beta1'], 'pipelines', 'Pipeline'),
  definition('tekton', 'project', 'tekton-definition', 'tekton.dev', ['v1', 'v1beta1'], 'tasks', 'Task'),
  definition('tekton', 'pipeline', 'tekton-run', 'tekton.dev', ['v1', 'v1beta1'], 'pipelineruns', 'PipelineRun'),
  definition('tekton', 'pipeline', 'tekton-run', 'tekton.dev', ['v1', 'v1beta1'], 'taskruns', 'TaskRun'),
  definition('argo-workflows', 'pipeline', 'argo-workflow', 'argoproj.io', ['v1alpha1'], 'workflows', 'Workflow'),
  definition('argo-workflows', 'project', 'argo-cron-workflow', 'argoproj.io', ['v1alpha1'], 'cronworkflows', 'CronWorkflow'),
  definition('argo-workflows', 'project', 'argo-workflow-template', 'argoproj.io', ['v1alpha1'], 'workflowtemplates', 'WorkflowTemplate'),
  definition('argo-workflows', 'project', 'argo-workflow-template', 'argoproj.io', ['v1alpha1'], 'clusterworkflowtemplates', 'ClusterWorkflowTemplate', false),
  definition('argo-rollouts', 'deployment', 'argo-rollout', 'argoproj.io', ['v1alpha1'], 'rollouts', 'Rollout'),
  definition('argo-rollouts', 'pipeline', 'argo-analysis-run', 'argoproj.io', ['v1alpha1'], 'analysisruns', 'AnalysisRun'),
  definition('argo-rollouts', 'project', 'argo-analysis-template', 'argoproj.io', ['v1alpha1'], 'analysistemplates', 'AnalysisTemplate'),
  definition('argo-rollouts', 'project', 'argo-analysis-template', 'argoproj.io', ['v1alpha1'], 'clusteranalysistemplates', 'ClusterAnalysisTemplate', false),
  definition('flagger', 'deployment', 'flagger-canary', 'flagger.app', ['v1beta1'], 'canaries', 'Canary'),
  definition('flagger', 'project', 'flagger-config', 'flagger.app', ['v1beta1'], 'metrictemplates', 'MetricTemplate'),
  definition('flagger', 'project', 'flagger-config', 'flagger.app', ['v1beta1'], 'alertproviders', 'AlertProvider')
];

export const DELIVERY_PROVIDER_MARKERS = {
  argocd: 'applications.argoproj.io',
  flux: 'kustomizations.kustomize.toolkit.fluxcd.io',
  tekton: 'pipelineruns.tekton.dev',
  'argo-workflows': 'workflows.argoproj.io',
  'argo-rollouts': 'rollouts.argoproj.io',
  flagger: 'canaries.flagger.app'
};

const EXTERNAL_PROVIDERS = [
  { providerId: 'jenkins', pattern: /(^|[/-])jenkins([/-]|$)/i },
  { providerId: 'gitlab-ci', pattern: /gitlab[-/]runner|gitlab-runner/i },
  { providerId: 'drone', pattern: /(^|[/-])drone([/-]|$)/i },
  { providerId: 'forgejo-actions', pattern: /forgejo.*runner|forgejo-runner|act-runner/i },
  { providerId: 'github-actions', pattern: /actions-runner-controller|gha-runner|github.*runner/i }
];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function text(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strings(value) {
  return (Array.isArray(value) ? value : []).map((item) => text(item)).filter(Boolean);
}

function metadata(value) {
  const meta = record(record(value).metadata);
  return {
    name: text(meta.name) || 'unknown',
    namespace: text(meta.namespace) || 'default',
    createdAt: text(meta.creationTimestamp),
    labels: record(meta.labels),
    owners: records(meta.ownerReferences)
  };
}

function nested(value, path) {
  let current = value;
  for (const part of path) {
    current = record(current)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function nestedText(value, path) {
  return text(nested(value, path));
}

function conditions(value) {
  return records(record(record(value).status).conditions).map((condition) => ({
    type: text(condition.type) || '',
    status: text(condition.status) || '',
    reason: text(condition.reason),
    message: text(condition.message),
    lastTransitionTime: text(condition.lastTransitionTime)
  }));
}

function conditionTrue(items, type) {
  return items.some((item) => item.type.toLowerCase() === type.toLowerCase() && item.status.toLowerCase() === 'true');
}

function conditionFalse(items, type) {
  return items.some((item) => item.type.toLowerCase() === type.toLowerCase() && item.status.toLowerCase() === 'false');
}

function conditionState(items) {
  if (conditionTrue(items, 'Stalled') || conditionFalse(items, 'Ready') || conditionFalse(items, 'Succeeded')) {
    const failed = items.find((item) => item.status.toLowerCase() === 'false' && ['ready', 'succeeded'].includes(item.type.toLowerCase()));
    return { status: failed?.reason || 'Failed', health: 'Degraded' };
  }
  if (conditionTrue(items, 'Reconciling') || conditionTrue(items, 'Progressing') || conditionTrue(items, 'Running')) {
    return { status: 'Progressing', health: 'Progressing' };
  }
  if (conditionTrue(items, 'Ready') || conditionTrue(items, 'Succeeded') || conditionTrue(items, 'Available')) {
    return { status: 'Ready', health: 'Healthy' };
  }
  return { status: 'Unknown', health: 'Unknown' };
}

function updatedAt(value, sourceConditions) {
  return (
    nestedText(value, ['status', 'operationState', 'finishedAt']) ||
    nestedText(value, ['status', 'reconciledAt']) ||
    nestedText(value, ['status', 'lastHandledReconcileAt']) ||
    sourceConditions.find((item) => item.lastTransitionTime)?.lastTransitionTime ||
    metadata(value).createdAt
  );
}

export function sanitizeDeliveryUrl(value) {
  const normalized = text(value);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const withoutQuery = normalized.split('?')[0].split('#')[0];
    const at = withoutQuery.lastIndexOf('@');
    return at >= 0 ? withoutQuery.slice(at + 1) : withoutQuery;
  }
}

function sourceReferences(value) {
  const spec = record(record(value).spec);
  const rawSources = records(spec.sources).length ? records(spec.sources) : spec.source ? [record(spec.source)] : [];
  return rawSources.map((source) => ({
    url: sanitizeDeliveryUrl(source.repoURL),
    chart: text(source.chart),
    path: text(source.path),
    targetRevision: text(source.targetRevision)
  }));
}

function durationMs(value) {
  const normalized = text(value);
  if (!normalized) return 0;
  let total = 0;
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    total += Number(match[1]) * units[match[2]];
  }
  return total;
}

function syncWindowState(window, now) {
  const schedule = text(window.schedule) || '';
  const duration = text(window.duration) || '';
  const timeZone = text(window.timeZone);
  let active = false;
  let nextChangeAt;
  try {
    const interval = CronExpressionParser.parse(schedule, { currentDate: now, tz: timeZone });
    const previous = interval.prev().toDate();
    const end = new Date(previous.getTime() + durationMs(duration));
    active = end.getTime() > now.getTime();
    nextChangeAt = (active ? end : interval.next().toDate()).toISOString();
  } catch {
    // Invalid schedules remain visible with an unknown active state.
  }
  return {
    kind: text(window.kind) || 'allow',
    schedule,
    duration,
    timeZone,
    active,
    manualSync: window.manualSync === true,
    applications: strings(window.applications),
    namespaces: strings(window.namespaces),
    clusters: strings(window.clusters),
    nextChangeAt
  };
}

function wildcardMatch(pattern, value) {
  if (!pattern || pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value || '');
}

function windowMatchesDeployment(window, deployment) {
  const selectors = [...window.applications, ...window.namespaces, ...window.clusters];
  if (!selectors.length) return true;
  return (
    window.applications.some((value) => wildcardMatch(value, deployment.name)) ||
    window.namespaces.some((value) => wildcardMatch(value, deployment.targetNamespace || deployment.namespace)) ||
    window.clusters.some((value) => wildcardMatch(value, deployment.destination || ''))
  );
}

function deploymentWindowState(project, deployment) {
  const matching = (project?.syncWindows || []).filter((window) => windowMatchesDeployment(window, deployment));
  if (!matching.length) return { state: 'unrestricted', activeWindows: 0 };
  const active = matching.filter((window) => window.active);
  const denied = active.find((window) => window.kind.toLowerCase() === 'deny');
  const allowed = active.find((window) => window.kind.toLowerCase() === 'allow');
  const nextChangeAt = matching.map((window) => window.nextChangeAt).filter(Boolean).sort()[0];
  if (denied) return { state: denied.manualSync ? 'manual' : 'denied', activeWindows: active.length, nextChangeAt };
  if (allowed) return { state: 'allowed', activeWindows: active.length, nextChangeAt };
  if (matching.some((window) => window.kind.toLowerCase() === 'allow')) return { state: 'denied', activeWindows: 0, nextChangeAt };
  return { state: 'unrestricted', activeWindows: 0, nextChangeAt };
}

function parseDeployment(definition, value) {
  const meta = metadata(value);
  const spec = record(record(value).spec);
  const statusRecord = record(record(value).status);
  const sourceConditions = conditions(value);
  const state = conditionState(sourceConditions);
  const base = {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    status: state.status,
    health: state.health,
    updatedAt: updatedAt(value, sourceConditions),
    conditions: sourceConditions,
    pattern: 'standard'
  };

  if (definition.parser === 'argo-application') {
    const sources = sourceReferences(value);
    const history = records(statusRecord.history);
    const latestHistory = history.sort((left, right) => Date.parse(text(right.deployedAt) || '') - Date.parse(text(left.deployedAt) || ''))[0];
    const childApplication = records(statusRecord.resources).some((resource) => text(resource.group) === 'argoproj.io' && text(resource.kind) === 'Application');
    return {
      ...base,
      status: nestedText(value, ['status', 'sync', 'status']) || state.status,
      health: nestedText(value, ['status', 'health', 'status']) || state.health,
      revision: nestedText(value, ['status', 'sync', 'revision']) || text(latestHistory?.revision),
      updatedAt: nestedText(value, ['status', 'operationState', 'finishedAt']) || text(latestHistory?.deployedAt) || base.updatedAt,
      sourceRef: sources[0]?.url,
      sources,
      targetNamespace: nestedText(value, ['spec', 'destination', 'namespace']),
      destination: nestedText(value, ['spec', 'destination', 'name']) || nestedText(value, ['spec', 'destination', 'server']),
      project: text(spec.project) || 'default',
      pattern: childApplication ? 'app-of-apps' : 'standard',
      syncPolicy: record(spec.syncPolicy).automated ? 'Automated' : 'Manual'
    };
  }

  if (definition.parser === 'argo-appset') {
    const generatedCount = number(statusRecord.resources?.length) ?? records(statusRecord.applicationStatus).length;
    const templateSpec = record(record(spec.template).spec);
    const templateSources = records(templateSpec.sources).length ? records(templateSpec.sources) : templateSpec.source ? [record(templateSpec.source)] : [];
    return {
      ...base,
      status: state.status,
      health: state.health,
      sourceRef: sanitizeDeliveryUrl(templateSources[0]?.repoURL),
      sources: templateSources.map((source) => ({ url: sanitizeDeliveryUrl(source.repoURL), chart: text(source.chart), path: text(source.path), targetRevision: text(source.targetRevision) })),
      targetNamespace: nestedText(templateSpec, ['destination', 'namespace']),
      destination: nestedText(templateSpec, ['destination', 'name']) || nestedText(templateSpec, ['destination', 'server']),
      project: text(templateSpec.project) || 'default',
      pattern: 'application-set',
      generatedCount
    };
  }

  if (definition.parser === 'flux-deployment') {
    const sourceRef = definition.kind === 'HelmRelease' ? record(record(spec.chart).spec).sourceRef : spec.sourceRef;
    const targetNamespace = text(spec.targetNamespace) || text(spec.storageNamespace) || meta.namespace;
    return {
      ...base,
      revision: nestedText(value, ['status', 'lastAppliedRevision']) || nestedText(value, ['status', 'lastAttemptedRevision']) || nestedText(value, ['status', 'observedSourceArtifactRevision']),
      sourceRef: [text(record(sourceRef).namespace) || meta.namespace, text(record(sourceRef).kind), text(record(sourceRef).name)].filter(Boolean).join('/'),
      sources: [{ kind: text(record(sourceRef).kind), name: text(record(sourceRef).name), namespace: text(record(sourceRef).namespace) || meta.namespace, chart: nestedText(spec, ['chart', 'spec', 'chart']) }],
      targetNamespace,
      destination: targetNamespace,
      syncPolicy: spec.suspend === true ? 'Suspended' : 'Automated'
    };
  }

  if (definition.parser === 'argo-rollout') {
    const desired = number(spec.replicas) || 0;
    const ready = number(statusRecord.readyReplicas) || 0;
    return {
      ...base,
      status: text(statusRecord.phase) || state.status,
      health: desired > 0 && ready >= desired ? 'Healthy' : state.health,
      targetNamespace: meta.namespace,
      destination: meta.namespace,
      pattern: 'progressive',
      revision: text(statusRecord.currentPodHash),
      sourceRef: `step ${number(statusRecord.currentStepIndex) ?? 0} · ${ready}/${desired} ready`
    };
  }

  if (definition.parser === 'flagger-canary') {
    return {
      ...base,
      status: text(statusRecord.phase) || state.status,
      health: /succeeded|initialized/i.test(text(statusRecord.phase) || '') ? 'Healthy' : state.health,
      targetNamespace: meta.namespace,
      destination: meta.namespace,
      pattern: 'progressive',
      revision: text(statusRecord.lastAppliedSpec),
      sourceRef: [nestedText(spec, ['targetRef', 'kind']), nestedText(spec, ['targetRef', 'name'])].filter(Boolean).join('/')
    };
  }

  return base;
}

function pipelineState(value) {
  const sourceConditions = conditions(value);
  const phase = nestedText(value, ['status', 'phase']);
  if (phase) {
    if (/succeeded|success|completed/i.test(phase)) return { status: phase, health: 'Healthy' };
    if (/failed|error/i.test(phase)) return { status: phase, health: 'Degraded' };
    if (/running|pending/i.test(phase)) return { status: phase, health: 'Progressing' };
  }
  const succeeded = sourceConditions.find((item) => item.type.toLowerCase() === 'succeeded');
  if (succeeded?.status.toLowerCase() === 'true') return { status: succeeded.reason || 'Succeeded', health: 'Healthy' };
  if (succeeded?.status.toLowerCase() === 'false') return { status: succeeded.reason || 'Failed', health: 'Degraded' };
  return conditionState(sourceConditions);
}

function parsePipeline(definition, value) {
  const meta = metadata(value);
  const spec = record(record(value).spec);
  const statusRecord = record(record(value).status);
  const sourceConditions = conditions(value);
  const state = pipelineState(value);
  const startedAt = text(statusRecord.startTime) || text(statusRecord.startedAt) || meta.createdAt;
  const finishedAt = text(statusRecord.completionTime) || text(statusRecord.finishedAt);
  const durationSeconds = startedAt ? Math.max(0, Math.round((Date.parse(finishedAt || new Date().toISOString()) - Date.parse(startedAt)) / 1000)) : undefined;
  let pipelineName = meta.name;
  let revision;
  let progress = text(statusRecord.progress);
  if (definition.parser === 'tekton-run') {
    pipelineName = nestedText(spec, ['pipelineRef', 'name']) || nestedText(spec, ['taskRef', 'name']) || text(meta.labels['tekton.dev/pipeline']) || text(meta.labels['tekton.dev/task']) || meta.name;
    revision = records(statusRecord.pipelineResults || statusRecord.results).map((item) => `${text(item.name)}=${text(record(item.value).stringVal) || text(item.value) || ''}`).filter((item) => !item.endsWith('=')).join(', ') || undefined;
    progress = progress || `${records(statusRecord.childReferences).length} tasks`;
  } else if (definition.parser === 'argo-workflow') {
    pipelineName = text(meta.labels['workflows.argoproj.io/workflow-template']) || nestedText(spec, ['workflowTemplateRef', 'name']) || meta.name;
  } else if (definition.parser === 'argo-analysis-run') {
    pipelineName = nestedText(spec, ['metrics', '0', 'name']) || meta.name;
    progress = `${number(statusRecord.successful) || 0} successful · ${number(statusRecord.failed) || 0} failed`;
  }
  return {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    pipelineName,
    status: state.status,
    health: state.health,
    revision,
    startedAt,
    finishedAt,
    durationSeconds,
    progress,
    conditions: sourceConditions
  };
}

function parseProject(definition, value, now) {
  const meta = metadata(value);
  const spec = record(record(value).spec);
  const statusRecord = record(record(value).status);
  const sourceConditions = conditions(value);
  const state = conditionState(sourceConditions);
  const base = {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    status: state.status,
    health: state.health,
    usedByCount: 0,
    unused: true,
    conditions: sourceConditions
  };
  if (definition.parser === 'argo-project') {
    const roles = records(spec.roles);
    const windows = records(spec.syncWindows).map((window) => syncWindowState(window, now));
    return {
      ...base,
      status: 'Configured',
      health: 'Healthy',
      sourceCount: records(spec.sourceRepos).length,
      destinationCount: records(spec.destinations).length,
      roleCount: roles.length,
      syncWindows: windows,
      details: [
        `${records(spec.clusterResourceWhitelist).length} cluster allow rules`,
        `${records(spec.namespaceResourceWhitelist).length} namespace allow rules`,
        `${roles.length} roles`,
        `${windows.length} sync windows`,
        record(spec.orphanedResources).warn === true ? 'Orphan monitoring enabled' : 'Orphan monitoring not enabled'
      ]
    };
  }
  if (definition.parser === 'argo-cron-workflow') {
    return {
      ...base,
      status: spec.suspend === true ? 'Suspended' : 'Scheduled',
      health: spec.suspend === true ? 'Unknown' : 'Healthy',
      schedule: text(spec.schedule) || records(spec.schedules).map((item) => text(item)).filter(Boolean).join(', '),
      details: [text(spec.timezone) ? `Timezone ${text(spec.timezone)}` : '', nestedText(statusRecord, ['lastScheduledTime']) ? `Last run ${nestedText(statusRecord, ['lastScheduledTime'])}` : 'No runs yet'].filter(Boolean)
    };
  }
  if (definition.parser === 'tekton-definition') {
    return { ...base, status: 'Configured', health: 'Healthy', details: [`${records(spec.tasks || spec.steps).length} steps/tasks`] };
  }
  return { ...base, status: 'Configured', health: 'Healthy' };
}

function parseSource(definition, value) {
  const meta = metadata(value);
  const sourceConditions = conditions(value);
  const state = conditionState(sourceConditions);
  return {
    providerId: definition.providerId,
    providerName: definition.providerName,
    kind: definition.kind,
    namespace: meta.namespace,
    name: meta.name,
    status: state.status,
    revision: nestedText(value, ['status', 'artifact', 'revision']),
    url: sanitizeDeliveryUrl(nestedText(value, ['spec', 'url'])),
    updatedAt: updatedAt(value, sourceConditions),
    usedByCount: 0,
    unused: true,
    conditions: sourceConditions
  };
}

function controllerProvider(pod) {
  const value = `${pod.namespace || ''}/${pod.name || ''}`;
  if (/argocd-|\/argocd\//i.test(value)) return 'argocd';
  if (/flux-system|source-controller|kustomize-controller|helm-controller/i.test(value)) return 'flux';
  if (/tekton-pipelines|tekton-pipeline-controller|tekton-events-controller/i.test(value)) return 'tekton';
  if (/workflow-controller|argo-server/i.test(value)) return 'argo-workflows';
  if (/argo-rollouts/i.test(value)) return 'argo-rollouts';
  if (/flagger/i.test(value)) return 'flagger';
  return EXTERNAL_PROVIDERS.find((provider) => provider.pattern.test(value))?.providerId || null;
}

function availability(issues, partial) {
  return issues.length || partial ? 'degraded' : 'available';
}

function resourceList(items, fetchedAt, issues = [], partial = false) {
  return { items, fetchedAt, issues, partial, availability: availability(issues, partial) };
}

function failedState(status, health) {
  return /failed|error|degraded|stalled|outofsync|out of sync|imagepull|crashloop/i.test(`${status} ${health}`);
}

function currentConditionIssues(item) {
  const result = [];
  for (const condition of item.conditions || []) {
    const type = condition.type.toLowerCase();
    if (!((type === 'stalled' && condition.status === 'True') || (['ready', 'succeeded', 'available'].includes(type) && condition.status === 'False'))) continue;
    result.push({
      providerId: item.providerId,
      kind: item.kind,
      namespace: item.namespace,
      name: item.name,
      severity: 'warning',
      message: [condition.reason, condition.message].filter(Boolean).join(': ') || `${condition.type}=${condition.status}`
    });
  }
  if (!result.length && failedState(item.status, item.health)) {
    result.push({
      providerId: item.providerId,
      kind: item.kind,
      namespace: item.namespace,
      name: item.name,
      severity: item.health?.toLowerCase() === 'degraded' ? 'critical' : 'warning',
      message: `${item.kind} reports ${item.status || item.health}.`
    });
  }
  return result;
}

function dedupeIssues(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.providerId}/${item.kind}/${item.namespace}/${item.name}/${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortRecent(left, right) {
  return Date.parse(right.finishedAt || right.startedAt || '') - Date.parse(left.finishedAt || left.startedAt || '');
}

function providerEvidence(providerId, deployments, pipelines, projects, sources, controllers, crds, sections) {
  const evidence = new Set();
  const counts = [
    ['deployment', deployments.filter((item) => item.providerId === providerId).length],
    ['pipeline', pipelines.filter((item) => item.providerId === providerId).length],
    ['configuration', projects.filter((item) => item.providerId === providerId).length],
    ['source', sources.filter((item) => item.providerId === providerId).length],
    ['controller', controllers.filter((item) => item.providerId === providerId).length]
  ];
  for (const [label, count] of counts) if (count) evidence.add(`${count} ${label}${count === 1 ? '' : 's'}`);
  const marker = DELIVERY_PROVIDER_MARKERS[providerId];
  if (marker && crds.some((crd) => metadata(crd).name === marker)) evidence.add(`${marker} CRD`);
  if (sections.some((section) => section.definition.providerId === providerId && section.available === true)) evidence.add('Kubernetes API resources served');
  return [...evidence].sort();
}

export function buildDeliveryActivitySummary(input) {
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  const now = input.now instanceof Date ? input.now : new Date(input.now || fetchedAt);
  const deployments = [];
  const pipelines = [];
  const projects = [];
  const sources = [];
  for (const section of input.resources || []) {
    for (const item of records(section.items)) {
      if (section.definition.category === 'deployment') deployments.push(parseDeployment(section.definition, item));
      if (section.definition.category === 'pipeline') pipelines.push(parsePipeline(section.definition, item));
      if (section.definition.category === 'project') projects.push(parseProject(section.definition, item, now));
      if (section.definition.category === 'source') sources.push(parseSource(section.definition, item));
    }
  }

  const projectIndex = new Map(projects.filter((item) => item.kind === 'AppProject').map((item) => [`${item.namespace}/${item.name}`, item]));
  for (const deployment of deployments) {
    if (deployment.providerId === 'argocd' && deployment.project) {
      const project = projectIndex.get(`${deployment.namespace}/${deployment.project}`);
      if (project) {
        project.usedByCount += 1;
        project.unused = false;
        deployment.syncWindow = deploymentWindowState(project, deployment);
      }
    }
  }

  const sourceIndex = new Map(sources.map((item) => [`${item.namespace}/${item.kind}/${item.name}`, item]));
  for (const deployment of deployments) {
    for (const source of deployment.sources || []) {
      const key = `${source.namespace || deployment.namespace}/${source.kind}/${source.name}`;
      const referenced = sourceIndex.get(key);
      if (referenced) {
        referenced.usedByCount += 1;
        referenced.unused = false;
      }
    }
  }

  const controllers = [];
  for (const pod of input.pods || []) {
    const providerId = controllerProvider(pod);
    if (providerId) controllers.push({ providerId, providerName: PROVIDER_NAMES[providerId] || providerId, pod });
  }

  pipelines.sort(sortRecent);
  const latestPipelines = new Map();
  for (const pipeline of pipelines) {
    const key = `${pipeline.providerId}/${pipeline.namespace}/${pipeline.pipelineName}`;
    if (!latestPipelines.has(key)) latestPipelines.set(key, pipeline);
  }
  const issuesList = dedupeIssues([
    ...deployments.flatMap(currentConditionIssues),
    ...sources.flatMap(currentConditionIssues),
    ...[...latestPipelines.values()].flatMap(currentConditionIssues)
  ]);

  const crds = records(input.customResourceDefinitions);
  const detectedProviders = [];
  for (const providerId of DELIVERY_PROVIDER_IDS) {
    const evidence = providerEvidence(providerId, deployments, pipelines, projects, sources, controllers, crds, input.resources || []);
    if (evidence.length) detectedProviders.push({ providerId, providerName: PROVIDER_NAMES[providerId], active: true, evidence, mode: 'kubernetes-native', coverage: 'full' });
  }
  for (const provider of EXTERNAL_PROVIDERS) {
    const count = controllers.filter((item) => item.providerId === provider.providerId).length;
    if (!count) continue;
    detectedProviders.push({
      providerId: provider.providerId,
      providerName: PROVIDER_NAMES[provider.providerId],
      active: true,
      evidence: [`${count} controller/runner pod${count === 1 ? '' : 's'}`],
      mode: 'external-api',
      coverage: 'detection-only',
      message: 'Provider API integration is required for pipeline history.'
    });
  }

  const partial = input.partial === true || (input.resources || []).some((section) => section.partial === true);
  const runtimeIssues = input.issues || [];
  const healthSummary = deployments.reduce((summary, item) => {
    const health = item.health.toLowerCase();
    const status = item.status.toLowerCase();
    if (health === 'healthy') summary.healthy += 1;
    if (health === 'progressing' || /progressing|reconciling|running/.test(status)) summary.progressing += 1;
    if (health === 'degraded' || failedState(status, health)) summary.degraded += 1;
    if (/outofsync|out of sync/.test(status)) summary.outOfSync += 1;
    return summary;
  }, { healthy: 0, progressing: 0, degraded: 0, outOfSync: 0 });
  const failedPipelines = [...latestPipelines.values()].filter((item) => failedState(item.status, item.health)).length;
  const limitedPipelines = pipelines.slice(0, 100);
  const applications = deployments.filter((item) => ['argocd', 'flux'].includes(item.providerId));

  return {
    schemaVersion: 2,
    namespaceScope: input.namespaceScope && input.namespaceScope !== 'all' ? input.namespaceScope : null,
    fetchedAt,
    issues: runtimeIssues,
    partial,
    availability: availability(runtimeIssues, partial),
    detectedProviders,
    summary: {
      total: deployments.length,
      deployments: deployments.length,
      pipelines: limitedPipelines.length,
      projects: projects.length,
      sources: sources.length,
      ...healthSummary,
      failedPipelines
    },
    applications: resourceList(applications, fetchedAt, [], partial),
    deployments: resourceList(deployments, fetchedAt, [], partial),
    pipelines: resourceList(limitedPipelines, fetchedAt, [], partial || pipelines.length > limitedPipelines.length),
    projects: resourceList(projects, fetchedAt, [], partial),
    sources: resourceList(sources, fetchedAt, [], partial),
    controllers: resourceList(controllers, fetchedAt, [], partial),
    issuesList: resourceList(issuesList, fetchedAt, [], partial)
  };
}

export function deliveryKindAllowed(providerId, kind) {
  return DELIVERY_RESOURCE_DEFINITIONS.some((definition) => definition.providerId === providerId && definition.kind.toLowerCase() === String(kind).toLowerCase());
}

export function deliveryProviderName(providerId) {
  return PROVIDER_NAMES[providerId] || providerId;
}
