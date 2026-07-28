import { describe, expect, test } from 'bun:test';
import { sendAgentHeartbeat } from '../agent/src/control-plane.js';
import { coalesceAsyncTask } from '../agent/src/task-runner.js';

describe('agent control-plane client', () => {
  test('posts JSON through one bounded request path', async () => {
    let requestUrl = '';
    let requestBody = '';
    const result = await sendAgentHeartbeat({
      controlPlaneUrl: 'https://app.kubi.live/some/path',
      agentId: 'agent-1',
      agentSecret: 'secret-1',
      platform: 'linux/x64',
      version: '0.1.20',
      capabilities: { runtimeApiVersion: '2' },
      fetchImpl: async (url, init) => {
        requestUrl = url;
        requestBody = String(init.body);
        return Response.json({ ok: true, data: { accepted: true } });
      }
    });

    expect(requestUrl).toBe('https://app.kubi.live/api/agent/heartbeat');
    expect(JSON.parse(requestBody)).toMatchObject({ agentId: 'agent-1', version: '0.1.20' });
    expect(result).toEqual({ accepted: true });
  });

  test('aborts a stalled request and coalesces overlapping periodic work', async () => {
    const stalledFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    await expect(sendAgentHeartbeat({
      controlPlaneUrl: 'https://app.kubi.live',
      agentId: 'agent-1',
      agentSecret: 'secret-1',
      platform: 'linux/x64',
      version: '0.1.20',
      capabilities: {},
      timeoutMs: 5,
      fetchImpl: stalledFetch
    })).rejects.toThrow('Control-plane request timed out after 5ms.');

    let calls = 0;
    let release = () => {};
    const task = coalesceAsyncTask(async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
    });
    const first = task();
    expect(task()).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await first;
  });
});
