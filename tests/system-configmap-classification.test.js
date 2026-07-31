import { describe, expect, test } from 'bun:test';
import { buildRuntimeGhostResources } from '../agent/src/kube.js';
import { classifySystemConfigMap } from '../src/shared/system-configmap.js';

function configMap(name, namespace, annotations = {}) {
  return { metadata: { name, namespace, annotations } };
}

describe('system-managed ConfigMap classification', () => {
  test('uses standard cross-distribution Kubernetes markers', () => {
    expect(classifySystemConfigMap(configMap('kube-root-ca.crt', 'apps'))).toEqual({
      systemManaged: true,
      systemReason: 'kubernetes-root-ca'
    });
    expect(classifySystemConfigMap(configMap('cluster-info', 'apps', {
      'kubernetes.io/description': 'Managed by the Kubernetes control plane.'
    }))).toEqual({
      systemManaged: true,
      systemReason: 'kubernetes-description'
    });
    expect(classifySystemConfigMap(configMap('extension-apiserver-authentication', 'kube-system'))).toEqual({
      systemManaged: true,
      systemReason: 'system-namespace'
    });
    expect(classifySystemConfigMap(configMap('application-settings', 'apps'))).toEqual({ systemManaged: false });
  });

  test('separates actionable and system counts without exposing annotations', () => {
    const configMaps = [
      configMap('kube-root-ca.crt', 'apps', { 'kubernetes.io/description': 'private marker text' }),
      configMap('system-settings', 'kube-system'),
      configMap('old-application-settings', 'apps'),
      configMap('used-settings', 'apps')
    ];
    const pods = [{
      metadata: { name: 'web', namespace: 'apps' },
      spec: { volumes: [{ name: 'settings', configMap: { name: 'used-settings' } }], containers: [] }
    }];
    const response = buildRuntimeGhostResources(
      [], [], [], [], pods, configMaps, [], [], [],
      '2026-07-31T00:00:00.000Z', null
    );

    expect(response.summary).toMatchObject({
      unusedConfigMaps: 3,
      actionableUnusedConfigMaps: 1,
      systemUnusedConfigMaps: 2
    });
    expect(response.issuesList.items.find((item) => item.resourceName === 'used-settings')).toBeUndefined();
    expect(response.issuesList.items.find((item) => item.resourceName === 'kube-root-ca.crt')).toMatchObject({
      systemManaged: true,
      systemReason: 'kubernetes-root-ca'
    });
    expect(JSON.stringify(response)).not.toContain('private marker text');
    expect(JSON.stringify(response)).not.toContain('kubernetes.io/description');
  });
});
