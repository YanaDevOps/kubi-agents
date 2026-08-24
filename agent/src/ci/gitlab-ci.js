const PROVIDER_ID = 'gitlab-ci';
const PROVIDER_NAME = 'GitLab CI';
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_DETAILS = 12;
const MAX_RUNS_LIMIT = 500;
const MAX_PAGES_LIMIT = 10;
const MAX_DETAILS_LIMIT = 50;

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function projectPaths(instance) {
  const paths = Array.isArray(instance?.projects)
    ? instance.projects.map((project) => text(typeof project === 'string' ? project : project?.path))
    : [];
  return [...new Set(paths.filter(Boolean))];
}

function encodeProjectPath(path) {
  return encodeURIComponent(path).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function responseBody(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return response;
  if (Object.prototype.hasOwnProperty.call(response, 'data')) return response.data;
  if (Object.prototype.hasOwnProperty.call(response, 'body')) return response.body;
  if (Object.prototype.hasOwnProperty.call(response, 'json') && typeof response.json !== 'function') return response.json;
  return response;
}

function responseHeaders(response) {
  if (!response || typeof response !== 'object') return null;
  return response.headers || response.response?.headers || null;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return text(headers.get(name) || headers.get(name.toLowerCase()));
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return text(match?.[1]);
}

function positivePage(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function linkNextPage(value) {
  if (!value) return null;
  const next = value.split(',').find((part) => /rel\s*=\s*["']?next["']?/i.test(part));
  if (!next) return null;
  const url = next.match(/<([^>]+)>/)?.[1];
  if (!url) return null;
  try {
    return positivePage(new URL(url, 'https://gitlab.invalid').searchParams.get('page'));
  } catch {
    return null;
  }
}

function nextPageFrom(response, currentPage, itemCount, perPage) {
  const pagination = response && typeof response === 'object' ? response.pagination : null;
  const explicit = positivePage(
    pagination?.nextPage
      ?? pagination?.next_page
      ?? response?.nextPage
      ?? response?.next_page
      ?? headerValue(responseHeaders(response), 'x-next-page')
  );
  if (explicit) return explicit;
  const linked = linkNextPage(headerValue(responseHeaders(response), 'link'));
  if (linked) return linked;
  return itemCount >= perPage ? currentPage + 1 : null;
}

function statusPair(value) {
  switch (text(value).toLowerCase()) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' };
    case 'manual':
      return { status: 'waiting', conclusion: 'action-required' };
    case 'running':
      return { status: 'running', conclusion: undefined };
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
      return { status: 'queued', conclusion: undefined };
    default:
      return { status: text(value).toLowerCase() || 'unknown', conclusion: undefined };
  }
}

function dateValue(value) {
  const candidate = text(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function numberValue(value) {
  if (value == null || value === '') return undefined;
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
}

function actorName(user) {
  if (!user || typeof user !== 'object') return undefined;
  return text(user.name) || text(user.username) || undefined;
}

function normalizeRun(instanceId, project, pipeline, detail) {
  const source = detail && typeof detail === 'object' ? { ...pipeline, ...detail } : pipeline;
  const state = statusPair(source.status);
  const id = String(source.id ?? source.iid ?? '');
  const ref = text(source.ref) || undefined;
  const createdAt = dateValue(source.created_at);
  const startedAt = dateValue(source.started_at);
  const finishedAt = dateValue(source.finished_at);
  const computedDuration = startedAt && finishedAt
    ? Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)
    : undefined;

  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    instanceId,
    project,
    pipeline: text(source.name) || (source.iid != null ? `Pipeline #${source.iid}` : `Pipeline #${id || 'unknown'}`),
    id,
    status: state.status,
    conclusion: state.conclusion,
    branch: source.tag === true ? undefined : ref,
    ref,
    commitSha: text(source.sha) || undefined,
    actor: actorName(source.user),
    url: text(source.web_url) || undefined,
    createdAt,
    startedAt,
    finishedAt,
    durationSeconds: numberValue(source.duration) ?? computedDuration,
    jobCount: numberValue(source.job_count),
  };
}

function needsDetail(pipeline) {
  return !actorName(pipeline?.user)
    || !dateValue(pipeline?.started_at)
    || (['success', 'failed', 'canceled', 'cancelled', 'skipped'].includes(text(pipeline?.status).toLowerCase())
      && !dateValue(pipeline?.finished_at));
}

function errorStatus(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status];
  return candidates.map(Number).find((value) => Number.isInteger(value) && value >= 100 && value <= 599) || null;
}

function safeIssue(instanceId, project, error, input = {}) {
  const status = errorStatus(error);
  let code = 'request-failed';
  let message = 'GitLab CI data could not be loaded for this project.';
  if (status === 401 || status === 403) {
    code = 'access-denied';
    message = 'GitLab denied read access for this project.';
  } else if (status === 404) {
    code = 'project-not-found';
    message = 'The configured GitLab project was not found or is not visible.';
  } else if (status === 429) {
    code = 'rate-limited';
    message = 'GitLab temporarily rate-limited this read request.';
  } else if (status && status >= 500) {
    code = 'provider-unavailable';
    message = 'GitLab temporarily failed to serve this read request.';
  }
  return {
    providerId: PROVIDER_ID,
    instanceId,
    project,
    scope: input.scope || 'project',
    ...(input.runId ? { runId: String(input.runId) } : {}),
    code,
    message,
    ...(status ? { status } : {}),
  };
}

function sortRuns(left, right) {
  const leftTime = Date.parse(left.createdAt || left.startedAt || '') || 0;
  const rightTime = Date.parse(right.createdAt || right.startedAt || '') || 0;
  return rightTime - leftTime || String(right.id).localeCompare(String(left.id));
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

export async function load(instance, options = {}) {
  if (!options.client || typeof options.client.get !== 'function') {
    throw new TypeError('GitLab CI adapter requires options.client.get(path, { query }).');
  }

  const instanceId = text(instance?.id) || text(instance?.instanceId) || PROVIDER_ID;
  const projects = projectPaths(instance);
  const maxRuns = boundedInteger(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUNS_LIMIT);
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT);
  const maxDetails = options.includeDetails === false
    ? 0
    : boundedInteger(options.maxDetails, DEFAULT_MAX_DETAILS, MAX_DETAILS_LIMIT);
  const runs = [];
  const issues = [];
  let remainingDetails = maxDetails;

  for (const project of projects) {
    if (runs.length >= maxRuns) break;
    const encodedProject = encodeProjectPath(project);
    const visitedPages = new Set();
    let page = 1;

    for (let pageCount = 0; pageCount < maxPages && runs.length < maxRuns; pageCount += 1) {
      if (visitedPages.has(page)) break;
      visitedPages.add(page);
      const perPage = Math.min(100, maxRuns - runs.length);
      let response;
      let pipelines;
      try {
        response = await options.client.get(`/api/v4/projects/${encodedProject}/pipelines`, {
          query: { page, per_page: perPage, order_by: 'updated_at', sort: 'desc' },
        });
        pipelines = responseBody(response);
        if (!Array.isArray(pipelines)) throw new TypeError('GitLab pipelines response must be an array.');
      } catch (error) {
        issues.push(safeIssue(instanceId, project, error));
        break;
      }

      const pagePipelines = pipelines.slice(0, maxRuns - runs.length);
      const normalizedPage = await mapWithConcurrency(pagePipelines, 4, async (pipeline) => {
        let detail;
        if (pageCount === 0 && remainingDetails > 0 && pipeline?.id != null && needsDetail(pipeline)) {
          remainingDetails -= 1;
          try {
            const detailResponse = await options.client.get(
              `/api/v4/projects/${encodedProject}/pipelines/${encodeURIComponent(String(pipeline.id))}`,
              { query: {} }
            );
            const body = responseBody(detailResponse);
            if (body && typeof body === 'object' && !Array.isArray(body)) detail = body;
          } catch (error) {
            issues.push(safeIssue(instanceId, project, error, { scope: 'pipeline', runId: pipeline.id }));
          }
        }
        return normalizeRun(instanceId, project, pipeline, detail);
      });
      runs.push(...normalizedPage);

      const nextPage = nextPageFrom(response, page, pipelines.length, perPage);
      if (!nextPage || nextPage === page) break;
      page = nextPage;
    }
  }

  return {
    providerId: PROVIDER_ID,
    instanceId,
    projects,
    runs: runs.sort(sortRuns).slice(0, maxRuns),
    issues,
    partial: issues.length > 0,
  };
}
