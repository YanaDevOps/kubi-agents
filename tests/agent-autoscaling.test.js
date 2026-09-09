import { describe, expect, test } from 'bun:test';
import { createAgentLoopbackServer } from '../agent/src/server.js';

const payload = {
  schemaVersion: 1,
  namespace: 'all',
  view: 'summary',
  summary: { hpa: 0 },
  sources: [],
  findings: [],
  tabs: {}
};

function server(options = {}) {
  return createAgentLoopbackServer({
    runtimeConfig: {
      controlPlaneUrl: 'https://app.kubi.live',
      agentId: 'agent-test',
      agentSecret: 'secret',
      kubeconfigPath: '/tmp/kubi-agent-test-kubeconfig',
      kubeContext: 'phase20-direct',
      runtimeApiVersion: '2'
    },
    introspectClient: async ({ accessToken }) => {
      if (accessToken !== 'runtime') throw new Error('Invalid token');
      return {
        connectionSelector: { contextName: 'phase20-agent' },
        scopes: ['runtime:read'],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    autoscalingProvider: async () => payload,
    runtimeConfigResolver: (runtimeConfig, selector) => ({
      ...runtimeConfig,
      kubeContext: selector.contextName
    }),
    ...options
  });
}

describe('agent autoscaling integration', () => {
  test('authenticates and forwards validated query options', async () => {
    const calls = [];
    const handle = server({ autoscalingProvider: async (...args) => { calls.push(args); return payload; } });
    expect((await handle.dispatch({ method: 'GET', url: '/v1/autoscaling', headers: {} })).status).toBe(401);
    const response = await handle.dispatch({
      method: 'GET',
      url: '/v1/autoscaling?ns=apps&view=keda&forceRefresh=true',
      headers: { authorization: 'Bearer runtime' }
    });
    expect(response.status).toBe(200);
    expect(calls[0][0]).toMatchObject({ kubeContext: 'phase20-agent' });
    expect(calls[0].slice(1)).toEqual(['apps', { view: 'keda', forceRefresh: true }]);
    expect((await handle.dispatch({
      method: 'GET',
      url: '/v1/autoscaling?ns=bad%2Fname',
      headers: { authorization: 'Bearer runtime' }
    })).status).toBe(400);
  });

  test('does not collect without runtime read scope', async () => {
    let collected = false;
    const handle = server({
      introspectClient: async () => ({ connectionSelector: { contextName: 'phase20-agent' }, scopes: [] }),
      autoscalingProvider: async () => { collected = true; return payload; }
    });
    expect((await handle.dispatch({
      method: 'GET',
      url: '/v1/autoscaling',
      headers: { authorization: 'Bearer runtime' }
    })).status).toBe(403);
    expect(collected).toBe(false);
  });
});
