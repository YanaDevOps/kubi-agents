import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeTimelineSourceItem,
  reduceTimelineSnapshot,
  restoreTimelineBaseline,
  selectTimelineProviderSources,
  withTimelineCycleDeadline
} from '../agent/src/timeline/index.js';
import { createTimelineStore } from '../agent/src/timeline/store.js';

describe('cluster Timeline collection', () => {
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
      .toMatchObject({ schemaVersion: 2, initialized: false, sources: {} });
    const current = { schemaVersion: 2, initialized: true, sources: {} };
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
        observedAt: '2026-09-13T14:02:00Z', before: { restartCount: 0, token: 'supersecret' }, after: { restartCount: 1 },
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
