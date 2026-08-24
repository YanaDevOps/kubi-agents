const PROVIDER_ID = "jenkins";
const PROVIDER_NAME = "Jenkins";

const DEFAULT_LIMITS = Object.freeze({
  maxRuns: 50,
  maxPages: 3,
  maxDepth: 4,
  maxJobs: 100,
  pageSize: 25,
});

const HARD_LIMITS = Object.freeze({
  maxRuns: 200,
  maxPages: 10,
  maxDepth: 10,
  maxJobs: 500,
  pageSize: 100,
});

const JOB_FIELDS = "name,fullName,url,_class,color";
const CAUSE_FIELDS = "userName,userId,shortDescription";
const CHANGE_FIELDS = "commitId,author[fullName]";
const BUILD_FIELDS = [
  "number",
  "url",
  "building",
  "result",
  "timestamp",
  "duration",
  "displayName",
  "fullDisplayName",
  `actions[causes[${CAUSE_FIELDS}]]`,
  `changeSet[items[${CHANGE_FIELDS}]]`,
  `changeSets[items[${CHANGE_FIELDS}]]`,
].join(",");
const QUEUE_TREE = [
  "items[id,url,why,blocked,buildable,stuck,inQueueSince",
  `task[${JOB_FIELDS}]`,
  `actions[causes[${CAUSE_FIELDS}]]]`,
].join(",");

function boundedInteger(value, fallback, maximum, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function readLimits(options) {
  const maxRuns = boundedInteger(options.maxRuns, DEFAULT_LIMITS.maxRuns, HARD_LIMITS.maxRuns);
  return {
    maxRuns,
    maxPages: boundedInteger(options.maxPages, DEFAULT_LIMITS.maxPages, HARD_LIMITS.maxPages),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_LIMITS.maxDepth, HARD_LIMITS.maxDepth, 0),
    maxJobs: boundedInteger(options.maxJobs, DEFAULT_LIMITS.maxJobs, HARD_LIMITS.maxJobs),
    pageSize: Math.min(
      maxRuns,
      boundedInteger(options.pageSize, DEFAULT_LIMITS.pageSize, HARD_LIMITS.pageSize)
    ),
  };
}

function instanceIdOf(instance) {
  const value = instance?.id ?? instance?.instanceId;
  return typeof value === "string" && value.trim() ? value.trim() : "jenkins";
}

function normalizeRoot(value) {
  if (typeof value !== "string") return null;
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    return null;
  }
  return segments;
}

function jobApiPath(segments) {
  return `${segments.map((segment) => `/job/${encodeURIComponent(segment)}`).join("")}/api/json`;
}

function buildTree(offset, limit, includeChildren) {
  const fields = [JOB_FIELDS];
  if (includeChildren) fields.push(`jobs[${JOB_FIELDS}]`);
  fields.push(`builds[${BUILD_FIELDS}]{${offset},${offset + limit}}`);
  return fields.join(",");
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration / 1000 : null;
}

function firstCause(actions) {
  for (const action of safeArray(actions)) {
    const cause = safeArray(action?.causes)[0];
    if (!cause) continue;
    return safeString(cause.userName) || safeString(cause.userId) || safeString(cause.shortDescription);
  }
  return null;
}

function firstCommit(build) {
  const changeSets = [build?.changeSet, ...safeArray(build?.changeSets)];
  for (const changeSet of changeSets) {
    const item = safeArray(changeSet?.items)[0];
    const commit = safeString(item?.commitId);
    if (commit) return commit;
  }
  return null;
}

function mapBuildState(build) {
  if (build?.building) return { status: "running", conclusion: null };

  switch (safeString(build?.result)?.toUpperCase()) {
    case "SUCCESS":
      return { status: "completed", conclusion: "success" };
    case "FAILURE":
      return { status: "completed", conclusion: "failure" };
    case "UNSTABLE":
      return { status: "completed", conclusion: "failure" };
    case "ABORTED":
      return { status: "completed", conclusion: "cancelled" };
    case "NOT_BUILT":
      return { status: "completed", conclusion: "skipped" };
    default:
      return { status: "unknown", conclusion: null };
  }
}

function projectForRoot(rootSegments) {
  return rootSegments.join("/");
}

function normalizeBuild(build, context) {
  const number = Number(build?.number);
  if (!Number.isFinite(number)) return null;

  const state = mapBuildState(build);
  const startedAt = safeTimestamp(build.timestamp);
  const durationSeconds = safeDurationSeconds(build.duration);
  let finishedAt = null;
  if (state.status === "completed" && startedAt && durationSeconds !== null) {
    finishedAt = new Date(new Date(startedAt).getTime() + durationSeconds * 1000).toISOString();
  }

  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    instanceId: context.instanceId,
    project: projectForRoot(context.rootSegments),
    pipeline: context.fullName,
    id: String(number),
    status: state.status,
    conclusion: state.conclusion,
    branch: null,
    ref: null,
    commitSha: firstCommit(build),
    actor: firstCause(build.actions),
    url: safeString(build.url),
    createdAt: startedAt,
    startedAt,
    finishedAt,
    durationSeconds,
    jobCount: null,
  };
}

function normalizeQueueItem(item, context) {
  const id = Number(item?.id);
  const fullName = safeString(item?.task?.fullName) || safeString(item?.task?.name);
  if (!Number.isFinite(id) || !fullName) return null;

  const root = context.roots.find((candidate) => {
    const rootName = projectForRoot(candidate);
    return fullName === rootName || fullName.startsWith(`${rootName}/`);
  });
  if (!root) return null;

  const createdAt = safeTimestamp(item.inQueueSince);
  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    instanceId: context.instanceId,
    project: projectForRoot(root),
    pipeline: fullName,
    id: `queue-${id}`,
    status: "queued",
    conclusion: null,
    branch: null,
    ref: null,
    commitSha: null,
    actor: firstCause(item.actions),
    url: safeString(item.url) || safeString(item.task?.url),
    createdAt,
    startedAt: null,
    finishedAt: null,
    durationSeconds: null,
    jobCount: null,
  };
}

function safeIssue(instanceId, code, message, project = null, status = null) {
  return {
    providerId: PROVIDER_ID,
    instanceId,
    code,
    severity: "warning",
    message,
    project,
    ...(Number.isInteger(status) ? { status } : {}),
  };
}

function statusFromError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function projectRecord(instanceId, rootSegments, payload, pathSegments) {
  const fullName = safeString(payload?.fullName) || pathSegments.join("/");
  return {
    providerId: PROVIDER_ID,
    instanceId,
    id: fullName,
    name: safeString(payload?.name) || pathSegments[pathSegments.length - 1],
    fullName,
    project: projectForRoot(rootSegments),
    url: safeString(payload?.url),
  };
}

/**
 * Loads bounded, read-only Jenkins job and build metadata.
 * The supplied client owns authentication and transport; this adapter never receives credentials.
 */
export async function load(instance, options = {}) {
  if (!options.client || typeof options.client.get !== "function") {
    throw new TypeError("Jenkins adapter requires options.client.get(path, { query }).");
  }

  const instanceId = instanceIdOf(instance);
  const limits = readLimits(options);
  const roots = safeArray(instance?.allowedJobRoots).map(normalizeRoot).filter(Boolean);
  const projects = [];
  const runs = [];
  const issues = [];
  const visited = new Set();
  let jobsSeen = 0;
  let jobsTruncated = false;
  let runsTruncated = false;

  if (!roots.length) {
    issues.push(safeIssue(
      instanceId,
      "jenkins_no_allowed_job_roots",
      "No valid Jenkins job roots are configured."
    ));
    return { providerId: PROVIDER_ID, instanceId, projects, runs, issues, partial: true };
  }

  async function visit(pathSegments, rootSegments, depth) {
    if (jobsSeen >= limits.maxJobs || runs.length >= limits.maxRuns) {
      jobsTruncated ||= jobsSeen >= limits.maxJobs;
      runsTruncated ||= runs.length >= limits.maxRuns;
      return;
    }

    const pathKey = pathSegments.join("/");
    if (visited.has(pathKey)) return;
    visited.add(pathKey);
    jobsSeen += 1;

    const firstPageSize = Math.min(limits.pageSize, limits.maxRuns - runs.length);
    let payload;
    try {
      payload = await options.client.get(jobApiPath(pathSegments), {
        query: { tree: buildTree(0, firstPageSize, true) },
      });
    } catch (error) {
      const status = statusFromError(error);
      issues.push(safeIssue(
        instanceId,
        "jenkins_job_read_failed",
        status ? `Jenkins job metadata request failed with HTTP ${status}.` : "Jenkins job metadata request failed.",
        pathKey,
        status
      ));
      return;
    }

    const children = safeArray(payload?.jobs);
    const builds = safeArray(payload?.builds);
    const fullName = safeString(payload?.fullName) || pathKey;

    if (builds.length || !children.length) {
      projects.push(projectRecord(instanceId, rootSegments, payload, pathSegments));
      for (const build of builds) {
        if (runs.length >= limits.maxRuns) {
          runsTruncated = true;
          break;
        }
        const normalized = normalizeBuild(build, { instanceId, rootSegments, fullName });
        if (normalized) runs.push(normalized);
      }

      let page = 1;
      let offset = firstPageSize;
      let previousCount = builds.length;
      while (
        previousCount === firstPageSize &&
        firstPageSize > 0 &&
        page < limits.maxPages &&
        runs.length < limits.maxRuns
      ) {
        const pageSize = Math.min(limits.pageSize, limits.maxRuns - runs.length);
        try {
          const next = await options.client.get(jobApiPath(pathSegments), {
            query: { tree: buildTree(offset, pageSize, false) },
          });
          const nextBuilds = safeArray(next?.builds);
          previousCount = nextBuilds.length;
          for (const build of nextBuilds) {
            if (runs.length >= limits.maxRuns) {
              runsTruncated = true;
              break;
            }
            const normalized = normalizeBuild(build, { instanceId, rootSegments, fullName });
            if (normalized) runs.push(normalized);
          }
          offset += pageSize;
          page += 1;
        } catch (error) {
          const status = statusFromError(error);
          issues.push(safeIssue(
            instanceId,
            "jenkins_build_page_read_failed",
            status ? `Jenkins build page request failed with HTTP ${status}.` : "Jenkins build page request failed.",
            fullName,
            status
          ));
          break;
        }
      }
      if (previousCount === firstPageSize && page >= limits.maxPages) runsTruncated = true;
    }

    if (!children.length) return;
    if (depth >= limits.maxDepth) {
      jobsTruncated = true;
      return;
    }

    for (const child of children) {
      if (jobsSeen >= limits.maxJobs || runs.length >= limits.maxRuns) {
        jobsTruncated ||= jobsSeen >= limits.maxJobs;
        runsTruncated ||= runs.length >= limits.maxRuns;
        break;
      }
      const childName = safeString(child?.name);
      if (!childName || childName === "." || childName === "..") continue;
      await visit([...pathSegments, childName], rootSegments, depth + 1);
    }
  }

  for (const root of roots) {
    if (jobsSeen >= limits.maxJobs || runs.length >= limits.maxRuns) break;
    await visit(root, root, 0);
  }

  if (runs.length < limits.maxRuns) {
    try {
      const queue = await options.client.get("/queue/api/json", { query: { tree: QUEUE_TREE } });
      for (const item of safeArray(queue?.items)) {
        if (runs.length >= limits.maxRuns) {
          runsTruncated = true;
          break;
        }
        const normalized = normalizeQueueItem(item, { instanceId, roots });
        if (normalized) runs.push(normalized);
      }
    } catch (error) {
      const status = statusFromError(error);
      issues.push(safeIssue(
        instanceId,
        "jenkins_queue_read_failed",
        status ? `Jenkins queue request failed with HTTP ${status}.` : "Jenkins queue request failed.",
        null,
        status
      ));
    }
  }

  if (jobsTruncated) {
    issues.push(safeIssue(instanceId, "jenkins_job_limit_reached", "Jenkins job discovery reached its configured limit."));
  }
  if (runsTruncated) {
    issues.push(safeIssue(instanceId, "jenkins_run_limit_reached", "Jenkins run discovery reached its configured limit."));
  }

  return {
    providerId: PROVIDER_ID,
    instanceId,
    projects,
    runs,
    issues,
    partial: issues.length > 0,
  };
}
