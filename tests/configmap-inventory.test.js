import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigMapInventory, configMapContent } from '../src/shared/configmap-inventory.js';

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

test('ConfigMap content keeps text lazy and reduces binary values to byte counts', () => {
  const content = configMapContent(resource('ConfigMap', 'api-config', 'apps', {
    data: { 'app.yaml': 'replicas: 2' },
    binaryData: { bundle: 'aGVsbG8=' }
  }));

  assert.deepEqual(content.binaryData, [{ key: 'bundle', bytes: 5 }]);
  assert.equal(content.data['app.yaml'], 'replicas: 2');
  assert.equal(JSON.stringify(content).includes('aGVsbG8='), false);
});
