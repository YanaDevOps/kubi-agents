import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCiHttpClient } from '../agent/src/ci/http.js';
import { loadLocalCiPipelines } from '../agent/src/ci/index.js';
import { load as loadGithub } from '../agent/src/ci/github-actions.js';
import { load as loadGitlab } from '../agent/src/ci/gitlab-ci.js';
import { load as loadJenkins } from '../agent/src/ci/jenkins.js';

const directories = [];

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true });
});

function protectedFile(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubi-ci-protected-'));
  directories.push(directory);
  const file = path.join(directory, 'token');
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('read-only CI provider adapters', () => {
  test('rejects credential files readable by group or other users', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubi-ci-credential-'));
    const tokenFile = path.join(directory, 'token');
    try {
      fs.writeFileSync(tokenFile, 'secret', { mode: 0o644 });
      fs.chmodSync(tokenFile, 0o644);
      expect(() => createCiHttpClient('github-actions', { baseUrl: 'https://api.github.com', auth: { tokenFile } })).toThrow('must not be readable or writable by group or other users');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('normalizes GitHub Actions runs without per-run fan-out', async () => {
    const requests = [];
    const result = await loadGithub({ id: 'github', repositories: [{ owner: 'acme', name: 'api' }] }, {
      maxRuns: 20,
      maxPages: 1,
      client: { get: async (path, options) => {
        requests.push({ path, options });
        return { total_count: 1, workflow_runs: [{ id: 101, name: 'test', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'abc', created_at: '2026-08-24T10:00:00Z', run_started_at: '2026-08-24T10:00:01Z', updated_at: '2026-08-24T10:00:11Z' }] };
      } }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/repos/acme/api/actions/runs');
    expect(result.runs[0]).toMatchObject({ providerId: 'github-actions', project: 'acme/api', conclusion: 'success', durationSeconds: 10 });
  });

  test('normalizes GitLab pipelines from fixed read endpoints', async () => {
    const paths = [];
    const result = await loadGitlab({ id: 'gitlab', projects: ['platform/api'] }, {
      maxRuns: 20,
      maxPages: 1,
      includeDetails: false,
      client: { get: async (path) => {
        paths.push(path);
        return [{ id: 202, iid: 7, status: 'failed', ref: 'main', sha: 'def', created_at: '2026-08-24T10:00:00Z', started_at: '2026-08-24T10:00:01Z', finished_at: '2026-08-24T10:00:21Z' }];
      } }
    });
    expect(paths).toEqual(['/api/v4/projects/platform%2Fapi/pipelines']);
    expect(result.runs[0]).toMatchObject({ providerId: 'gitlab-ci', project: 'platform/api', conclusion: 'failure', durationSeconds: 20 });
  });

  test('keeps Jenkins reads inside configured job roots', async () => {
    const paths = [];
    const result = await loadJenkins({ id: 'jenkins', allowedJobRoots: ['platform'] }, {
      maxRuns: 20,
      maxPages: 1,
      client: { get: async (path) => {
        paths.push(path);
        if (path === '/queue/api/json') return { items: [] };
        return { name: 'platform', fullName: 'platform', jobs: [], builds: [{ number: 3, result: 'SUCCESS', timestamp: 1787565600000, duration: 5000, actions: [], changeSet: { items: [] } }] };
      } }
    });
    expect(paths.every((path) => path === '/job/platform/api/json' || path === '/queue/api/json')).toBe(true);
    expect(result.runs[0]).toMatchObject({ providerId: 'jenkins', project: 'platform', conclusion: 'success', durationSeconds: 5 });
  });

  test('does not forward credentials outside the configured base path after a redirect', async () => {
    const tokenFile = protectedFile('sensitive-token');
    let escapedRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url === '/base/repos/acme/api/actions/runs') {
        response.writeHead(302, { location: '/other/provider' });
        response.end();
        return;
      }
      escapedRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const port = await listen(server);
    try {
      const client = createCiHttpClient('github-actions', {
        baseUrl: `http://127.0.0.1:${port}/base`,
        timeoutSeconds: 2,
        auth: { tokenFile }
      });
      await expect(client.get('/repos/acme/api/actions/runs')).rejects.toThrow('outside the configured base path');
      expect(escapedRequests).toBe(0);
    } finally {
      await close(server);
    }
  });

  test('coalesces concurrent polls for one provider instance', async () => {
    const tokenFile = protectedFile('sensitive-token');
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
      }, 25);
    });
    const port = await listen(server);
    const runtimeConfig = {
      ci: {
        enabled: true,
        githubActions: {
          enabled: true,
          instances: [{
            id: `coalesce-${port}`,
            displayName: 'Coalesce',
            baseUrl: `http://127.0.0.1:${port}`,
            timeoutSeconds: 2,
            maxPages: 1,
            maxRuns: 10,
            repositories: [{ owner: 'acme', name: 'api' }],
            auth: { tokenFile },
            tls: {}
          }]
        },
        gitlabCi: { enabled: false, instances: [] },
        jenkins: { enabled: false, instances: [] }
      }
    };
    try {
      await Promise.all([loadLocalCiPipelines(runtimeConfig), loadLocalCiPipelines(runtimeConfig)]);
      expect(requests).toBe(1);
    } finally {
      await close(server);
    }
  });

  test('negative-caches provider rate limits without exposing raw provider messages', async () => {
    const tokenFile = protectedFile('sensitive-token');
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      response.end('{"message":"raw provider detail"}');
    });
    const port = await listen(server);
    const runtimeConfig = {
      ci: {
        enabled: true,
        githubActions: {
          enabled: true,
          instances: [{
            id: `rate-limit-${port}`,
            displayName: 'Rate limit',
            baseUrl: `http://127.0.0.1:${port}`,
            timeoutSeconds: 2,
            maxPages: 1,
            maxRuns: 10,
            repositories: [{ owner: 'acme', name: 'api' }],
            auth: { tokenFile },
            tls: {}
          }]
        },
        gitlabCi: { enabled: false, instances: [] },
        jenkins: { enabled: false, instances: [] }
      }
    };
    try {
      const first = await loadLocalCiPipelines(runtimeConfig);
      const second = await loadLocalCiPipelines(runtimeConfig);
      expect(requests).toBe(1);
      expect(first.availability).toBe('degraded');
      expect(second.availability).toBe('degraded');
      expect(JSON.stringify(second)).not.toContain('raw provider detail');
    } finally {
      await close(server);
    }
  });
});
