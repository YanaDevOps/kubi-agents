import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { fetchKubeJson } from '../agent/src/kube.js';

// A request that outlives its timeout must settle. Under Bun, node:https sometimes stalled
// mid-body on large lists and never settled, and an abandoned request kept its Response and
// buffered body reachable; with ~20 Timeline reads every 15 s that grew the agent by
// hundreds of MB per day.
const openResponses = new Set();
const server = http.createServer((request, response) => {
  openResponses.add(response);
  response.on('close', () => openResponses.delete(response));
  if (request.url.startsWith('/no-headers')) return; // never answers
  if (request.url.startsWith('/stalled-body')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"items":[');
    return; // never finishes the body
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"gitVersion":"v1.test"}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const baseUrl = `http://127.0.0.1:${server.address().port}`;

afterEach(() => {
  for (const response of openResponses) response.destroy();
});

// A plain agent takes Bun's fetch transport; a subclass (as proxy agents are) keeps node:http.
class ProxyLikeAgent extends http.Agent {}
const transports = [
  ['fetch', () => undefined],
  ['node:http', () => new ProxyLikeAgent()]
];

const kubeConfig = (agent) => ({
  getCurrentCluster: () => ({ server: baseUrl }),
  applyToFetchOptions: async (options) => ({ ...options, agent })
});

function settleWithin(promise, ms) {
  return Promise.race([
    promise.then(() => 'resolved', (error) => `rejected: ${error.message}`),
    new Promise((resolve) => setTimeout(() => resolve('still pending'), ms))
  ]);
}

for (const [name, agent] of transports) describe(`agent Kubernetes API transport (${name})`, () => {
  test('rejects a request whose response headers never arrive', async () => {
    expect(await settleWithin(fetchKubeJson(kubeConfig(agent()), '/no-headers', { timeoutMs: 100 }), 2_000))
      .toBe('rejected: Kubernetes API request timed out.');
  });

  test('rejects a request whose response body stalls', async () => {
    expect(await settleWithin(fetchKubeJson(kubeConfig(agent()), '/stalled-body', { timeoutMs: 100 }), 2_000))
      .toBe('rejected: Kubernetes API request timed out.');
  });

  test('rejects a response over the byte limit', async () => {
    expect(await settleWithin(fetchKubeJson(kubeConfig(agent()), '/version', { maxBytes: 4 }), 2_000))
      .toBe('rejected: Kubernetes API response exceeded the byte limit.');
  });

  test('cancels with the caller signal reason', async () => {
    const controller = new AbortController();
    const pending = fetchKubeJson(kubeConfig(agent()), '/no-headers', { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(new Error('cycle deadline')), 50);
    expect(await settleWithin(pending, 2_000)).toBe('rejected: cycle deadline');
  });

  test('still returns a response that completes in time', async () => {
    expect(await fetchKubeJson(kubeConfig(agent()), '/version', { timeoutMs: 1_000 })).toEqual({ gitVersion: 'v1.test' });
  });
});
