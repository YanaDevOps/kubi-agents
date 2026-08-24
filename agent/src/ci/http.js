import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export class CiHttpError extends Error {
  constructor(message, { status = 0, retryAfter = '' } = {}) {
    super(message);
    this.name = 'CiHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function readProtectedFile(filePath, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} must point to a regular file.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group or other users.`);
  }
  const value = fs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error(`${label} is empty.`);
  return value;
}

function authHeaders(providerId, instance) {
  if (providerId === 'github-actions') {
    return {
      authorization: `Bearer ${readProtectedFile(instance.auth.tokenFile, 'GitHub token file')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': instance.apiVersion || '2022-11-28'
    };
  }
  if (providerId === 'gitlab-ci') {
    return { 'private-token': readProtectedFile(instance.auth.tokenFile, 'GitLab token file') };
  }
  if (providerId === 'jenkins') {
    const username = readProtectedFile(instance.auth.usernameFile, 'Jenkins username file');
    const token = readProtectedFile(instance.auth.apiTokenFile, 'Jenkins API token file');
    return { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` };
  }
  throw new Error(`Unsupported CI provider: ${providerId}.`);
}

function requestJson(url, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET',
      headers: options.headers,
      timeout: options.timeoutMs,
      ...(url.protocol === 'https:'
        ? {
            ca: options.caFile ? fs.readFileSync(options.caFile) : undefined,
            cert: options.clientCertFile ? fs.readFileSync(options.clientCertFile) : undefined,
            key: options.clientKeyFile ? readProtectedFile(options.clientKeyFile, 'CI client key file') : undefined,
            rejectUnauthorized: true
          }
        : {})
    });
    request.on('timeout', () => request.destroy(new Error('CI provider request timed out.')));
    request.on('error', reject);
    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 1) {
          reject(new CiHttpError('CI provider returned too many redirects.', { status }));
          return;
        }
        const redirected = new URL(response.headers.location, url);
        if (redirected.origin !== url.origin) {
          reject(new CiHttpError('CI provider redirected to a different origin.', { status }));
          return;
        }
        if (!pathWithinBase(redirected.pathname, options.allowedPathPrefix)) {
          reject(new CiHttpError('CI provider redirected outside the configured base path.', { status }));
          return;
        }
        requestJson(redirected, options, redirectCount + 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      let size = 0;
      let exceededLimit = false;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          exceededLimit = true;
          response.destroy(new CiHttpError('CI provider response exceeded the configured size limit.', { status }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (exceededLimit) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new CiHttpError(`CI provider returned HTTP ${status}.`, {
            status,
            retryAfter: String(response.headers['retry-after'] || '')
          }));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new CiHttpError('CI provider returned invalid JSON.', { status }));
        }
      });
    });
    request.end();
  });
}

function pathWithinBase(pathname, basePath) {
  if (!basePath || basePath === '/') return true;
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function createCiHttpClient(providerId, instance) {
  const baseUrl = new URL(instance.baseUrl);
  const basePath = baseUrl.pathname.replace(/\/$/, '') || '/';
  const headers = authHeaders(providerId, instance);
  const requestOptions = {
    headers: { accept: 'application/json', 'user-agent': 'kubi-agent', ...headers },
    timeoutMs: Math.round((instance.timeoutSeconds || 8) * 1000),
    maxBytes: 2 * 1024 * 1024,
    caFile: instance.tls?.caFile,
    clientCertFile: instance.tls?.clientCertFile,
    clientKeyFile: instance.tls?.clientKeyFile,
    allowedPathPrefix: basePath
  };

  return {
    async get(pathname, { query = {} } = {}) {
      if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('..')) {
        throw new Error('CI provider path is outside the read-only allowlist.');
      }
      const url = new URL(`${basePath === '/' ? '' : basePath}${pathname}`, baseUrl.origin);
      if (url.origin !== baseUrl.origin || !pathWithinBase(url.pathname, basePath)) {
        throw new Error('CI provider path escaped the configured base URL.');
      }
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(name, String(value));
      }
      return requestJson(url, requestOptions);
    }
  };
}
