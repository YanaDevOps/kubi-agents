import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compactTimelineBaselineItem,
  createTimelineManager,
  normalizeTimelineSourceItem,
  projectTimelineSourceItem,
  reduceTimelineSnapshot,
  restoreTimelineBaseline,
  settleTimelineSources,
  selectTimelineProviderSources,
  withTimelineCycleDeadline,
  withTimelineSourceDeadline
} from '../agent/src/timeline/index.js';
import { createTimelineStore } from '../agent/src/timeline/store.js';

describe('cluster Timeline collection', () => {
  test('projects Kubernetes events without retaining managed fields or unrelated payloads', () => {
    const projected = projectTimelineSourceItem({
      metadata: {
        uid: 'event-1', resourceVersion: '12', creationTimestamp: '2026-09-28T00:00:00Z',
        managedFields: [{ fieldsV1: { huge: 'payload' } }]
      },
      involvedObject: { apiVersion: 'v1', kind: 'Pod', namespace: 'default', name: 'api-0', uid: 'pod-1', fieldPath: 'spec.containers{api}' },
      type: 'Warning', reason: 'BackOff', message: 'container failed',
      source: { component: 'kubelet' }, reportingInstance: 'node-a',
      unrelated: { nested: 'payload' }
    }, 'v1', 'Event');

    expect(projected).toMatchObject({
      apiVersion: 'v1', kind: 'Event',
      metadata: { uid: 'event-1', resourceVersion: '12' },
      involvedObject: { kind: 'Pod', name: 'api-0', uid: 'pod-1' },
      type: 'Warning', reason: 'BackOff', message: 'container failed'
    });
    expect(JSON.stringify(projected)).not.toContain('managedFields');
    expect(JSON.stringify(projected)).not.toContain('unrelated');
    expect(JSON.stringify(projected)).not.toContain('reportingInstance');
  });

  test('bounds concurrent Timeline source reads and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await settleTimelineSources([0, 1, 2, 3, 4, 5], async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (value === 3) throw new Error('unavailable');
      return value * 2;
    }, 2);

    expect(peak).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'
    ]);
    expect(results[4]).toEqual({ status: 'fulfilled', value: 8 });
  });

  test('bounds the complete paginated lifetime of one Timeline source', async () => {
    let sourceSignal;
    await expect(withTimelineSourceDeadline((signal) => {
      sourceSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, undefined, 5)).rejects.toThrow('Timeline source timed out after 5ms.');
    expect(sourceSignal.aborted).toBe(true);
  });

  test('persists a dense Kubernetes event baseline within the store state limits', async () => {
    const source = (apiVersion) => Object.fromEntries(Array.from({ length: 750 }, (_, index) => {
      const projected = projectTimelineSourceItem({
        metadata: { uid: `event-${index}`, resourceVersion: String(index), creationTimestamp: '2026-09-28T00:00:00Z' },
        involvedObject: { apiVersion: 'v1', kind: 'Pod', namespace: 'workloads', name: `pod-${index}`, uid: `pod-${index}` },
        type: 'Warning', reason: 'BackOff', message: `A bounded warning message ${'x'.repeat(400)}`, count: index + 1,
        lastTimestamp: '2026-09-28T00:00:00Z', managedFields: [{ fieldsV1: { oversized: 'x'.repeat(8_192) } }]
      }, apiVersion, 'Event');
      return [`${apiVersion}/Event/event-${index}`, projected];
    }));
    // Both Event APIs list the same objects, so a busy cluster fills both sources.
    const full = { events: source('v1'), 'events.k8s.io': source('events.k8s.io/v1') };
    const compact = Object.fromEntries(Object.entries(full).map(([id, objects]) => [id,
      Object.fromEntries(Object.entries(objects).map(([key, item]) => [key, compactTimelineBaselineItem(item)]))]));
    const state = (sources) => ({ schemaVersion: 3, initialized: true, sources, lastObservedAt: '2026-09-28T00:00:00Z', gaps: 0 });

    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubi-agent-timeline-baseline-test-'));
    const store = await createTimelineStore({ directory });
    const key = 'e'.repeat(64);
    try {
      await expect(store.saveState(key, state(full))).rejects.toThrow(/Timeline (state is too complex|state exceeds its limit|request is too large)/);
      const saved = await store.saveState(key, state(compact));
      expect(saved.sources.events['v1/Event/event-749']).toEqual([750, '2026-09-28T00:00:00.000Z']);
      expect(Object.keys(saved.sources['events.k8s.io'])).toHaveLength(750);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('polls only provider resources backed by installed CRDs', () => {
    const selected = selectTimelineProviderSources([
      { metadata: { name: 'applications.argoproj.io' } },
      { metadata: { name: 'backups.velero.io' } },
      { metadata: { name: 42 } },
      null
    ]).map((definition) => definition[4]);
    expect(selected).toContain('applications.argoproj.io');
    expect(selected).toContain('backups.velero.io');
    expect(selected).not.toContain('helmreleases.helm.toolkit.fluxcd.io');
    expect(selectTimelineProviderSources(null)).toEqual([]);
  });

  test('aborts a collection cycle that exceeds its deadline', async () => {
    let signal;
    await expect(withTimelineCycleDeadline((currentSignal) => {
      signal = currentSignal;
      return new Promise((_, reject) => currentSignal.addEventListener('abort', () => reject(currentSignal.reason), { once: true }));
    }, 5)).rejects.toThrow('Timeline collection cycle timed out after 5ms.');
    expect(signal.aborted).toBe(true);
  });

  test('rejects an unbounded worker request lifetime', async () => {
    await expect(createTimelineStore({ requestTimeoutMs: 0 })).rejects.toThrow('Invalid requestTimeoutMs');
  });

  test('restores omitted List TypeMeta and safely migrates older baselines', () => {
    expect(normalizeTimelineSourceItem(
      { metadata: { name: 'api', uid: 'deploy-1' } },
      'apps/v1',
      'Deployment'
    )).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment' });
    expect(restoreTimelineBaseline({ initialized: true, sources: { deployments: {} } }))
      .toMatchObject({ schemaVersion: 3, initialized: false, sources: {} });
    // Version 2 retained full Event payloads and is discarded rather than diffed.
    expect(restoreTimelineBaseline({ schemaVersion: 2, initialized: true, sources: { deployments: {} } }))
      .toMatchObject({ schemaVersion: 3, initialized: false, sources: {} });
    const current = { schemaVersion: 3, initialized: true, sources: {} };
    expect(restoreTimelineBaseline(current)).toBe(current);
  });

  test('records resource lifecycle and new meaningful events only after baseline', () => {
    const deployment = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'test-app', namespace: 'default', uid: 'deploy-1', resourceVersion: '1', creationTimestamp: '2026-09-13T14:00:00Z' }
    };
    const service = {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'test-app', namespace: 'default', uid: 'service-1', resourceVersion: '1', creationTimestamp: '2026-09-13T14:00:01Z' }
    };
    const warning = {
      apiVersion: 'v1', kind: 'Event', metadata: { uid: 'event-1', creationTimestamp: '2026-09-13T14:00:02Z' },
      involvedObject: { apiVersion: 'v1', kind: 'Pod', name: 'test-app-0', namespace: 'default', uid: 'pod-1' },
      type: 'Warning', reason: 'BackOff', message: 'container back-off', count: 1
    };
    const current = { deployments: { deployment }, services: { service }, events: { warning } };

    expect(reduceTimelineSnapshot({ initialized: false, sources: {} }, current, '2026-09-13T14:00:05Z')).toHaveLength(0);
    const events = reduceTimelineSnapshot({ initialized: true, sources: { deployments: {}, services: {}, events: {} } }, current, '2026-09-13T14:00:05Z');
    expect(events.map((event) => event.reason).sort()).toEqual(['BackOff', 'DeploymentCreated', 'ServiceCreated']);
  });

  test('does not report deletion when a source is unavailable', () => {
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: 'default', uid: 'deploy-1' } };
    const baseline = { initialized: true, sources: { deployments: { deployment } } };
    expect(reduceTimelineSnapshot(baseline, { deployments: {} }, '2026-09-13T14:01:00Z')[0]?.reason).toBe('DeploymentDeleted');
    expect(reduceTimelineSnapshot(baseline, {}, '2026-09-13T14:01:00Z')).toHaveLength(0);
  });

  test('preserves the UI event contract and restart baseline without secrets', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubi-agent-timeline-test-'));
    const store = await createTimelineStore({ directory });
    const key = 'a'.repeat(64);
    try {
      await store.saveState(key, { schemaVersion: 2, initialized: true, sources: { pods: { pod: {
        apiVersion: 'v1', kind: 'Pod', metadata: { name: 'api-0', namespace: 'default', uid: 'pod-1' },
        status: { phase: 'Running', containerStatuses: [{ name: 'api', restartCount: 0, ready: true, state: { running: {} } }] }
      } } } });
      await store.append(key, {
        id: 'event-1', dedupKey: 'dedup-1', sourceId: 'kubernetes', source: 'kubernetes-event',
        category: 'pod', severity: 'warning', reason: 'BackOff', title: 'Pod api-0: BackOff', summary: 'Container is backing off',
        observedAt: new Date(Date.now() - 60_000).toISOString(), before: { restartCount: 0, token: 'supersecret' }, after: { restartCount: 1 },
        logs: [{ container: 'api', lines: ['password=supersecret'] }],
        resource: { apiVersion: 'v1', kind: 'Pod', namespace: 'default', name: 'api-0', uid: 'pod-1' }
      });
      const page = await store.list(key, { limit: 1 });
      expect(page.items[0]).toMatchObject({ sequence: 1, source: 'kubernetes-event', title: 'Pod api-0: BackOff', summary: 'Container is backing off' });
      expect(JSON.stringify(page.items[0])).not.toContain('supersecret');
      expect((await store.getState(key))?.schemaVersion).toBe(2);
      expect((await store.getState(key))?.sources?.pods?.pod?.metadata?.uid).toBe('pod-1');
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('cluster Timeline baseline and store bounds', () => {
  test('keeps Event baselines compact and still reports only new occurrences', () => {
    const warning = (count, lastTimestamp) => ({
      apiVersion: 'events.k8s.io/v1', kind: 'Event', type: 'Warning', reason: 'BackOff',
      note: 'x'.repeat(4096), series: { count, lastObservedTime: lastTimestamp },
      metadata: { uid: 'event-1', creationTimestamp: '2026-09-13T13:00:00Z' },
      regarding: { apiVersion: 'v1', kind: 'Pod', namespace: 'default', name: 'api-0', uid: 'pod-1' }
    });
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'api-0', namespace: 'default', uid: 'pod-1' } };
    const key = 'events.k8s.io/v1/Event/event-1';
    const compact = compactTimelineBaselineItem(warning(3, '2026-09-13T14:00:00Z'));
    expect(compact).toEqual([3, '2026-09-13T14:00:00.000Z']);
    expect(compactTimelineBaselineItem(pod)).toBe(pod);

    const baseline = { initialized: true, sources: { events: { [key]: compact } } };
    expect(reduceTimelineSnapshot(baseline, { events: { [key]: warning(3, '2026-09-13T14:00:00Z') } }, '2026-09-13T14:00:15Z')).toHaveLength(0);
    const repeated = reduceTimelineSnapshot(baseline, { events: { [key]: warning(4, '2026-09-13T14:00:10Z') } }, '2026-09-13T14:00:15Z');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ reason: 'BackOff', before: { count: 3 }, after: { count: 4 } });
    expect(reduceTimelineSnapshot(baseline, { events: {} }, '2026-09-13T14:00:15Z')).toHaveLength(0);
  });

  test('advances the baseline when state cannot be persisted instead of replaying changes', async () => {
    const appended = [];
    const warnings = [];
    let polls = 0;
    const deployment = (replicas) => ({
      apiVersion: 'apps/v1', kind: 'Deployment', spec: { replicas },
      metadata: { name: 'api', namespace: 'default', uid: 'deploy-1', resourceVersion: String(replicas) }
    });
    const manager = createTimelineManager({
      pollMs: 5,
      logger: { warn: (message) => { warnings.push(message); } },
      loadSources: async () => {
        polls += 1;
        return { definitions: [['deployments']], results: [{ status: 'fulfilled', value: [deployment(polls === 1 ? 1 : 2)] }], resolved: {} };
      },
      timelineStore: {
        getState: async () => null,
        saveState: async () => { throw Object.assign(new Error('Timeline state exceeds its limit'), { code: 'TIMELINE_TOO_LARGE' }); },
        append: async (_key, events) => { appended.push(...events); return { ids: [] }; },
        prune: async () => ({}),
        status: async () => ({}),
        close: async () => {}
      }
    });
    const target = { enabled: true, workspaceId: 'w', agentId: 'a', connectionId: 'c', connectionSelector: { contextName: 'ctx' }, retentionDays: 7 };
    try {
      await manager.applyDesiredConfig({ complete: true, targets: [target] });
      const deadline = Date.now() + 2_000;
      while (polls < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(polls).toBeGreaterThanOrEqual(6);
      expect(appended.map((event) => event.reason)).toEqual(['WorkloadReplicasChanged']);
      const status = await manager.status(target);
      expect(status.state).toBe('partial');
      expect(status.message).toContain('Timeline baseline was not persisted (Timeline state exceeds its limit)');
      expect(warnings.filter((message) => message.includes('not persisted'))).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test('does not store observations that are already outside retention', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubi-agent-timeline-retention-test-'));
    const store = await createTimelineStore({ directory });
    const key = 'c'.repeat(64);
    const event = (id, occurredAt) => ({
      id, dedupKey: id, sourceId: 'kubernetes', source: 'kubernetes-object', category: 'pod', severity: 'warning',
      reason: 'ContainerRestarted', title: `Pod ${id}: ContainerRestarted`, occurredAt,
      resource: { apiVersion: 'v1', kind: 'Pod', namespace: 'default', name: id, uid: id }
    });
    try {
      const result = await store.append(key, [
        event('expired', new Date(Date.now() - 8 * 86_400_000).toISOString()),
        event('recent', new Date(Date.now() - 60_000).toISOString())
      ]);
      expect(result.ids).toEqual([null, 'recent']);
      expect(result.after).toBe(1);
      expect(result.pruned).toBe(0);
      expect((await store.list(key)).items.map((item) => item.id)).toEqual(['recent']);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('evicts the oldest rows to the target quota and reclaims file space', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubi-agent-timeline-quota-test-'));
    const maxTargetBytes = 512 * 1024;
    const store = await createTimelineStore({ directory, maxTargetBytes });
    const key = 'd'.repeat(64);
    const base = Date.now() - 3_600_000;
    try {
      for (let batch = 0; batch < 6; batch += 1) {
        await store.append(key, Array.from({ length: 50 }, (_, index) => {
          const id = `event-${batch * 50 + index}`;
          return {
            id, dedupKey: id, sourceId: 'kubernetes', source: 'kubernetes-event', category: 'pod', severity: 'warning',
            reason: 'BackOff', title: `Pod ${id}: BackOff`, summary: `${id} ${'x'.repeat(4000)}`,
            occurredAt: new Date(base + batch * 50_000 + index * 1_000).toISOString(),
            resource: { apiVersion: 'v1', kind: 'Pod', namespace: 'default', name: id, uid: id }
          };
        }));
      }
      const status = await store.status(key);
      expect(status.bytes).toBeLessThanOrEqual(maxTargetBytes);
      expect(status.pruned).toBeGreaterThan(0);
      expect(status.count + status.pruned).toBe(300);
      expect((await store.list(key, { limit: 1 })).items[0].id).toBe('event-299');
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
