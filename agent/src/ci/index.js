import { createCiHttpClient } from './http.js';
import { load as loadGithubActions } from './github-actions.js';
import { load as loadGitlabCi } from './gitlab-ci.js';
import { load as loadJenkins } from './jenkins.js';

const CACHE_TTL_MS = 30_000;
const CACHE_STALE_TTL_MS = 5 * 60_000;
const FAILURE_CACHE_TTL_MS = 15_000;
const cache = new Map();
const inFlight = new Map();

const providerDefinitions = [
  { id: 'github-actions', name: 'GitHub Actions', configKey: 'githubActions', load: loadGithubActions },
  { id: 'gitlab-ci', name: 'GitLab CI', configKey: 'gitlabCi', load: loadGitlabCi },
  { id: 'jenkins', name: 'Jenkins', configKey: 'jenkins', load: loadJenkins }
];

function runtimeIssue(message) {
  return {
    code: 'partial_resource_failure',
    message,
    retryable: true,
    resource: 'ci-pipelines'
  };
}

function safeFailureMessage(providerName, error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return `${providerName} denied read access. Check the local agent credential file and permissions.`;
  if (status === 429) return `${providerName} rate-limited the agent. The agent will wait before polling again.`;
  if (status >= 500) return `${providerName} is temporarily unavailable.`;
  if (/timed out/i.test(String(error?.message || ''))) return `${providerName} did not answer before the configured timeout.`;
  return `${providerName} could not be read by the local agent.`;
}

function retryDelayMs(error, now) {
  if (Number(error?.status || 0) !== 429) return FAILURE_CACHE_TTL_MS;
  const value = String(error?.retryAfter || '').trim();
  const seconds = Number(value);
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(Date.parse(value))
      ? Date.parse(value) - now
      : 60_000;
  return Math.min(15 * 60_000, Math.max(FAILURE_CACHE_TTL_MS, requested));
}

async function loadInstanceUncached(definition, instance, cached) {
  const key = `${definition.id}:${instance.id}`;
  try {
    const value = await definition.load(instance, {
      client: createCiHttpClient(definition.id, instance),
      maxRuns: instance.maxRuns,
      maxPages: instance.maxPages,
      maxDepth: instance.maxDepth,
      maxJobs: instance.maxJobs
    });
    const completedAt = Date.now();
    cache.set(key, {
      value,
      expiresAt: completedAt + CACHE_TTL_MS,
      staleUntil: completedAt + CACHE_STALE_TTL_MS
    });
    return { ...value, cached: false, stale: false };
  } catch (error) {
    const failedAt = Date.now();
    const retryAt = failedAt + retryDelayMs(error, failedAt);
    if (cached?.staleUntil > failedAt) {
      cached.expiresAt = retryAt;
      cache.set(key, cached);
      return {
        ...cached.value,
        partial: true,
        cached: true,
        stale: true,
        issues: [...(cached.value.issues || []), { message: safeFailureMessage(definition.name, error) }]
      };
    }
    cache.delete(key);
    const failure = {
      providerId: definition.id,
      instanceId: instance.id,
      projects: [],
      runs: [],
      issues: [{ message: safeFailureMessage(definition.name, error) }],
      partial: true,
      cached: false,
      stale: false
    };
    cache.set(key, { value: failure, expiresAt: retryAt, staleUntil: retryAt });
    return failure;
  }
}

async function loadInstance(definition, instance, now) {
  const key = `${definition.id}:${instance.id}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return { ...cached.value, cached: true, stale: false };
  if (inFlight.has(key)) return inFlight.get(key);

  const request = loadInstanceUncached(definition, instance, cached);
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function safeExternalUrl(value) {
  const normalized = boundedText(value, 4096);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeIsoDate(value) {
  const normalized = boundedText(value, 128);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return undefined;
  return new Date(normalized).toISOString();
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  const providerId = boundedText(run.providerId, 64);
  const instanceId = boundedText(run.instanceId, 64);
  const project = boundedText(run.project, 512);
  const pipeline = boundedText(run.pipeline, 512);
  const id = boundedText(run.id, 256);
  if (!providerId || !instanceId || !project || !pipeline || !id) return null;
  return {
    ...run,
    providerId,
    providerName: boundedText(run.providerName, 128) || providerId,
    instanceId,
    project,
    pipeline,
    id,
    status: boundedText(run.status, 64) || 'unknown',
    conclusion: boundedText(run.conclusion, 64) || undefined,
    branch: boundedText(run.branch, 512) || undefined,
    ref: boundedText(run.ref, 512) || undefined,
    commitSha: boundedText(run.commitSha, 256) || undefined,
    actor: boundedText(run.actor, 256) || undefined,
    url: safeExternalUrl(run.url) || undefined,
    createdAt: safeIsoDate(run.createdAt),
    startedAt: safeIsoDate(run.startedAt),
    finishedAt: safeIsoDate(run.finishedAt),
    durationSeconds: nonNegativeNumber(run.durationSeconds),
    jobCount: nonNegativeNumber(run.jobCount)
  };
}

async function mapWithConcurrency(items, limit, action) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await action(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function loadLocalCiPipelines(runtimeConfig, providerFilter = null, instanceFilter = null) {
  const ci = runtimeConfig.ci || {};
  if (!ci.enabled) {
    const fetchedAt = new Date().toISOString();
    return {
      schemaVersion: 1,
      fetchedAt,
      issues: [],
      partial: false,
      availability: 'available',
      providers: [],
      runs: { items: [], fetchedAt, issues: [], partial: false, availability: 'available' }
    };
  }

  const selected = providerDefinitions.flatMap((definition) => {
    if (providerFilter && providerFilter !== definition.id) return [];
    const provider = ci[definition.configKey] || {};
    if (!provider.enabled) return [];
    return (provider.instances || [])
      .filter((instance) => !instanceFilter || instance.id === instanceFilter)
      .map((instance) => ({ definition, instance }));
  });

  const now = Date.now();
  const loaded = await mapWithConcurrency(selected, 3, ({ definition, instance }) => loadInstance(definition, instance, now));
  const fetchedAt = new Date().toISOString();
  const providers = selected.map(({ definition, instance }, index) => ({
    providerId: definition.id,
    providerName: definition.name,
    instanceId: instance.id,
    displayName: instance.displayName || instance.id,
    configured: true,
    reachable: !loaded[index].stale && (!loaded[index].partial || loaded[index].runs.length > 0),
    targetCount: loaded[index].projects.length,
    ...(loaded[index].stale ? { message: 'Showing the last successful snapshot while the provider reconnects.' } : {})
  }));
  const issues = loaded.flatMap((result, index) =>
    (result.issues || []).map((issue) => runtimeIssue(
      `${selected[index].definition.name} (${selected[index].instance.displayName || selected[index].instance.id}): ${issue.message || 'Partial provider response.'}`
    ))
  );
  const runs = loaded
    .flatMap((result) => result.runs || [])
    .map(sanitizeRun)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt || right.startedAt || '') - Date.parse(left.createdAt || left.startedAt || ''))
    .slice(0, 500);
  const partial = loaded.some((result) => result.partial || result.stale);
  const availability = partial ? 'degraded' : 'available';

  return {
    schemaVersion: 1,
    fetchedAt,
    issues,
    partial,
    availability,
    providers,
    runs: { items: runs, fetchedAt, issues, partial, availability }
  };
}
