import { describe, expect, test } from 'bun:test';
import { createUsageHistory } from '../agent/src/usage-history.js';

function harness(samples) {
  let clock = Date.parse('2026-10-10T12:00:00Z');
  let tick;
  const loads = [];
  const history = createUsageHistory({
    load: async (_config, scope) => {
      loads.push(scope);
      const next = samples.shift();
      return next ? { available: true, ...next } : { available: false, nodes: [], pods: [] };
    },
    now: () => clock,
    setTimer: (callback) => {
      tick = callback;
      return 1;
    },
    clearTimer: () => {
      tick = undefined;
    },
    maxSamples: 3,
    idleStopMs: 60_000
  });
  return {
    history,
    loads,
    advance: async (ms) => {
      clock += ms;
      tick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    get running() {
      return Boolean(tick);
    }
  };
}

const sample = (nodeCpu, podCpu) => ({
  nodes: [{ cpu: nodeCpu, memory: '1Gi' }],
  pods: [
    { namespace: 'shop', cpu: podCpu, memory: '100Mi' },
    { namespace: 'ops', cpu: '50m', memory: '10Mi' }
  ]
});

describe('agent usage history', () => {
  test('serves node totals for the cluster and pod totals per namespace, bounded to the newest samples', async () => {
    const h = harness([sample('500m', '100m'), sample('600m', '200m'), sample('700m', '300m'), sample('800m', '400m')]);
    const config = { kubeContext: 'default', clusterFingerprint: 'abc' };
    const first = await h.history.read(config, 'all');
    expect(first.samples).toEqual([{ at: '2026-10-10T12:00:00.000Z', cpuMilli: 500, memoryBytes: 1024 ** 3 }]);
    for (let index = 0; index < 3; index += 1) await h.advance(10_000);
    const cluster = await h.history.read(config, 'all');
    expect(cluster.scope).toBe('cluster');
    expect(cluster.intervalSeconds).toBe(10);
    expect(cluster.samples.map((entry) => entry.cpuMilli)).toEqual([600, 700, 800]);
    const shop = await h.history.read(config, 'shop');
    expect(shop.samples.map((entry) => entry.cpuMilli)).toEqual([200, 300, 400]);
    expect(shop.samples[0].memoryBytes).toBe(100 * 1024 ** 2);
    expect(h.loads.every((scope) => scope === 'all')).toBe(true);
  });

  test('skips samples while metrics are unavailable and stops after the idle period', async () => {
    const h = harness([sample('500m', '100m'), null, sample('700m', '300m')]);
    const config = { kubeContext: 'default' };
    await h.history.read(config, 'all');
    await h.advance(10_000);
    await h.advance(10_000);
    expect((await h.history.read(config, 'all')).samples.map((entry) => entry.cpuMilli)).toEqual([500, 700]);
    await h.advance(61_000);
    expect(h.running).toBe(false);
  });
});
