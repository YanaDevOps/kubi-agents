import { describe, expect, test } from 'bun:test';
import { podRelatedResources } from '../src/shared/resource-references.js';

function resource(kind, name, namespace = 'apps', extra = {}) {
  return { apiVersion: 'v1', kind, metadata: { name, namespace }, ...extra };
}

describe('Pod related resource references', () => {
  test('labels the Pod ServiceAccount and validates whether it exists', () => {
    const pod = resource('Pod', 'api', 'apps', {
      spec: { serviceAccountName: 'api-runtime', containers: [{ name: 'api' }] }
    });

    expect(podRelatedResources({
      pod,
      serviceAccounts: [resource('ServiceAccount', 'api-runtime')]
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKind: 'ServiceAccount',
        resourceName: 'api-runtime',
        method: 'workloadServiceAccount',
        targetState: 'present'
      })
    ]));

    expect(podRelatedResources({
      pod,
      serviceAccounts: [],
      serviceAccountsComplete: true
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceName: 'api-runtime', targetState: 'missing' })
    ]));
  });
});
