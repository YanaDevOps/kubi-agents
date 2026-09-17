import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigMapInventory, configMapContent, sanitizeConfigMapInventoryPayload } from '../src/shared/configmap-inventory.js';

function resource(kind, name, namespace = 'apps', extra = {}) {
  return { apiVersion: 'v1', kind, metadata: { name, namespace }, ...extra };
}

test('ConfigMap inventory returns references and keys without values', () => {
  const inventory = buildConfigMapInventory({
    configMaps: [resource('ConfigMap', 'api-config', 'apps', {
      data: { 'app.yaml': 'private-value' },
      binaryData: { bundle: 'aGVsbG8=' }
    })],
    pods: [resource('Pod', 'api-1', 'apps', {
      spec: { containers: [{ name: 'api', envFrom: [{ configMapRef: { name: 'api-config' } }] }] }
    })],
    referencesComplete: true
  });

  assert.equal(inventory.summary.referenced, 1);
  assert.deepEqual(inventory.configMaps.items[0].dataKeys, ['app.yaml']);
  assert.equal(inventory.configMaps.items[0].referenceCount, 1);
  assert.equal(JSON.stringify(inventory).includes('private-value'), false);
});

test('ConfigMap inventory counts unique consumers while preserving reference paths', () => {
  const podSpec = {
    containers: [{
      name: 'api',
      env: [
        { name: 'MODE', valueFrom: { configMapKeyRef: { name: 'api-config', key: 'mode' } } },
        { name: 'PORT', valueFrom: { configMapKeyRef: { name: 'api-config', key: 'port' } } }
      ]
    }],
    volumes: [{ name: 'settings', configMap: { name: 'api-config' } }]
  };
  const inventory = buildConfigMapInventory({
    configMaps: [resource('ConfigMap', 'api-config')],
    pods: [resource('Pod', 'api-1', 'apps', { spec: podSpec })],
    workloads: [resource('Deployment', 'api', 'apps', { spec: { template: { spec: podSpec } } })],
    secrets: []
  });
  const item = inventory.configMaps.items[0];

  assert.equal(item.referenceCount, 2);
  assert.equal(item.referencePathCount, 6);
  assert.equal(item.consumers.length, 2);
  assert.deepEqual(item.consumers.find((consumer) => consumer.kind === 'Pod'), {
    kind: 'Pod',
    name: 'api-1',
    namespace: 'apps',
    confidence: 'exact',
    methods: ['env', 'volume'],
    referenceCount: 3
  });
});

test('ConfigMap inventory normalizes inflated legacy counts into unique consumers', () => {
  const consumers = Array.from({ length: 9 }, (_, index) => ({
    kind: index < 4 ? 'Pod' : index < 8 ? 'Deployment' : 'ArgoCD',
    name: `consumer-${index}`,
    namespace: 'argocd'
  }));
  const referencedBy = Array.from({ length: 307 }, (_, index) => ({
    ...consumers[index % consumers.length],
    method: index % 11 === 0 ? 'volume' : 'env',
    confidence: 'exact'
  }));
  const legacy = sanitizeConfigMapInventoryPayload({
    configMaps: {
      items: [{
        name: 'argocd-cmd-params-cm',
        namespace: 'argocd',
        referenceCount: 307,
        referencedBy
      }]
    }
  });
  const item = legacy.configMaps.items[0];

  assert.equal(item.referenceCount, 9);
  assert.equal(item.referencePathCount, 307);
  assert.equal(item.consumers.length, 9);
  assert.equal(item.consumers.reduce((total, consumer) => total + consumer.referenceCount, 0), 307);
});

test('ConfigMap content keeps text lazy and reduces binary values to byte counts', () => {
  const content = configMapContent(resource('ConfigMap', 'api-config', 'apps', {
    data: { 'app.yaml': 'replicas: 2' },
    binaryData: { bundle: 'aGVsbG8=' }
  }));

  assert.deepEqual(content.binaryData, [{ key: 'bundle', bytes: 5 }]);
  assert.equal(content.data['app.yaml'], 'replicas: 2');
  assert.equal(JSON.stringify(content).includes('aGVsbG8='), false);
});

test('ConfigMap inventory omits applied snapshots and oversized annotation values', () => {
  const applied = JSON.stringify({ data: { password: 'must-not-cross-relay' } });
  const inventory = buildConfigMapInventory({
    configMaps: [resource('ConfigMap', 'api-config', 'apps', {
      metadata: {
        name: 'api-config',
        namespace: 'apps',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': applied,
          'example.com/oversized': `-----BEGIN CERTIFICATE-----\n${'A'.repeat(1400)}`,
          'argocd.argoproj.io/tracking-id': 'apps:/ConfigMap:apps/api-config'
        }
      }
    })]
  });
  const item = inventory.configMaps.items[0];

  assert.deepEqual(item.annotations, { 'argocd.argoproj.io/tracking-id': 'apps:/ConfigMap:apps/api-config' });
  assert.equal(item.omittedAnnotations.length, 2);
  assert.equal(JSON.stringify(inventory).includes('must-not-cross-relay'), false);
  assert.equal(JSON.stringify(inventory).includes('BEGIN CERTIFICATE'), false);
});

test('legacy ConfigMap inventory payloads are sanitized defensively', () => {
  const inventory = sanitizeConfigMapInventoryPayload({
    configMaps: { items: [{
      data: { token: 'raw-data-secret' },
      binaryData: { certificate: 'raw-binary-secret' },
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"token":"legacy-secret"}}'
      }
    }] }
  });

  assert.deepEqual(inventory.configMaps.items[0].annotations, {});
  assert.equal(inventory.configMaps.items[0].omittedAnnotations[0].reason, 'applied-resource-snapshot');
  assert.equal(JSON.stringify(inventory).includes('legacy-secret'), false);
  assert.equal(JSON.stringify(inventory).includes('raw-data-secret'), false);
  assert.equal(JSON.stringify(inventory).includes('raw-binary-secret'), false);
});
