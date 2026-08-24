const PROVIDER_ID = 'github-actions';
const PROVIDER_NAME = 'GitHub Actions';
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_RUNS_LIMIT = 500;
const MAX_PAGES_LIMIT = 10;
const PAGE_SIZE_LIMIT = 100;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function durationSeconds(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const duration = Math.floor((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function normalizeStatus(value) {
  switch (text(value).toLowerCase()) {
    case 'requested':
    case 'waiting':
    case 'pending':
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    default:
      return 'unknown';
  }
}

function normalizeConclusion(value) {
  switch (text(value).toLowerCase()) {
    case 'success':
      return 'success';
    case 'failure':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'action_required':
      return 'action_required';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    case 'stale':
      return 'stale';
    default:
      return null;
  }
}

function normalizeRun(instanceId, project, value) {
  const run = record(value);
  const actor = record(run.actor);
  const startedAt = isoDate(run.run_started_at);
  const status = normalizeStatus(run.status);
  const finishedAt = status === 'completed' ? isoDate(run.updated_at) : null;
  const branch = text(run.head_branch) || null;

  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    instanceId,
    project,
    pipeline: text(run.name) || text(run.path) || text(run.display_title, 'Workflow'),
    id: run.id === undefined || run.id === null ? '' : String(run.id),
    status,
    conclusion: normalizeConclusion(run.conclusion),
    branch,
    ref: branch,
    commitSha: text(run.head_sha) || null,
    actor: text(actor.login) || text(actor.name) || null,
    url: text(run.html_url) || null,
    createdAt: isoDate(run.created_at),
    startedAt,
    finishedAt,
    durationSeconds: durationSeconds(startedAt, finishedAt),
    // Counting jobs would require one additional request per run.
    jobCount: null
  };
}

function repositories(instance) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(record(instance).repositories) ? instance.repositories : []) {
    const repository = record(value);
    const owner = text(repository.owner);
    const name = text(repository.name);
    if (!owner || !name) continue;
    const id = `${owner}/${name}`;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ owner, name, id });
  }
  return result;
}

function projectIssue(instanceId, project, code, message) {
  return {
    providerId: PROVIDER_ID,
    instanceId,
    project,
    severity: 'warning',
    code,
    message
  };
}

export async function load(instance, options = {}) {
  const source = record(instance);
  const client = record(options).client;
  if (!client || typeof client.get !== 'function') {
    throw new TypeError('GitHub Actions adapter requires options.client.get(path, { query }).');
  }

  const instanceId = text(source.id) || text(source.instanceId, 'github');
  const maxRuns = boundedInteger(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUNS_LIMIT);
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT);
  const configuredRepositories = repositories(source);
  const projects = [];
  const collectedRuns = [];
  const issues = [];
  let partial = false;

  for (const [repositoryIndex, repository] of configuredRepositories.entries()) {
    const repositoryRuns = [];
    let totalCount = 0;
    let page = 1;
    let projectPartial = false;
    const remainingRepositories = configuredRepositories.length - repositoryIndex;
    const remainingRunBudget = maxRuns - collectedRuns.length;
    const repositoryBudget = remainingRunBudget > 0
      ? Math.ceil(remainingRunBudget / remainingRepositories)
      : 0;

    try {
      while (page <= maxPages && repositoryRuns.length < repositoryBudget) {
        const remaining = repositoryBudget - repositoryRuns.length;
        const perPage = Math.min(PAGE_SIZE_LIMIT, remaining);
        const payload = record(await client.get(
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/runs`,
          { query: { page, per_page: perPage } }
        ));
        const workflowRuns = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : null;
        if (!workflowRuns) {
          throw new Error('invalid-response');
        }

        if (page === 1) {
          const parsedTotal = Number(payload.total_count);
          totalCount = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? Math.floor(parsedTotal) : workflowRuns.length;
        }

        repositoryRuns.push(...workflowRuns.slice(0, remaining).map((run) => normalizeRun(instanceId, repository.id, run)));
        if (workflowRuns.length < perPage || repositoryRuns.length >= totalCount) break;
        page += 1;
      }

      if (repositoryRuns.length < totalCount) {
        projectPartial = true;
        partial = true;
        issues.push(projectIssue(
          instanceId,
          repository.id,
          'run-limit-reached',
          `Only the newest ${repositoryRuns.length} workflow runs were loaded for ${repository.id}.`
        ));
      }

      if (repositoryBudget === 0) {
        projectPartial = true;
        partial = true;
        issues.push(projectIssue(
          instanceId,
          repository.id,
          'run-limit-reached',
          `No workflow runs were loaded for ${repository.id} because the instance run limit was reached.`
        ));
      }
    } catch {
      projectPartial = true;
      partial = true;
      issues.push(projectIssue(
        instanceId,
        repository.id,
        'project-load-failed',
        `Workflow runs could not be loaded for ${repository.id}.`
      ));
    }

    collectedRuns.push(...repositoryRuns);
    projects.push({
      id: repository.id,
      name: repository.id,
      owner: repository.owner,
      repository: repository.name,
      totalCount,
      loadedRuns: repositoryRuns.length,
      partial: projectPartial
    });
  }

  const runs = collectedRuns
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))
    .slice(0, maxRuns);

  return {
    providerId: PROVIDER_ID,
    instanceId,
    projects,
    runs,
    issues,
    partial
  };
}

export default { load };
