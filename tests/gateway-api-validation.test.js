import { describe, expect, test } from 'bun:test';
import {
  buildGatewayApiValidationItems,
  gatewayApiDefinitionsFromCrds
} from '../src/shared/gateway-api-validation.js';
import { buildPortsValidationItems } from '../src/cluster-runtime/relationship-runtime.js';

function crd(kind, plural, scope = 'Namespaced') {
  return {
    metadata: { name: `${plural}.gateway.networking.k8s.io` },
    spec: {
      group: 'gateway.networking.k8s.io',
      scope,
      names: { kind, plural },
      versions: [{ name: 'v1alpha2', served: false }, { name: 'v1', served: true }]
    }
  };
}

function service(ready, total) {
  return {
    name: 'api',
    namespace: 'apps',
    ports: [{ name: 'http', port: 8080 }],
    endpointAvailability: { status: ready === total ? 'ready' : 'partial', readyAddresses: ready, addresses: total }
  };
}

function route(kind = 'HTTPRoute', backendNamespace) {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind,
    metadata: { name: 'api', namespace: 'apps', generation: 2 },
    spec: {
      parentRefs: [{ name: 'public' }],
      rules: [{ backendRefs: [{ name: 'api', namespace: backendNamespace, port: 8080 }] }]
    },
    status: {
      parents: [{
        parentRef: { name: 'public' },
        conditions: [
          { type: 'Accepted', status: 'True', observedGeneration: 2 },
          { type: 'ResolvedRefs', status: 'True', observedGeneration: 2 }
        ]
      }]
    }
  };
}

describe('Gateway API validation', () => {
  test('discovers every installed supported route kind using a served version', () => {
    const definitions = gatewayApiDefinitionsFromCrds([
      crd('GatewayClass', 'gatewayclasses', 'Cluster'),
      crd('Gateway', 'gateways'),
      crd('HTTPRoute', 'httproutes'),
      crd('GRPCRoute', 'grpcroutes'),
      crd('TLSRoute', 'tlsroutes'),
      crd('TCPRoute', 'tcproutes'),
      crd('UDPRoute', 'udproutes'),
      crd('ReferenceGrant', 'referencegrants')
    ]);

    expect(definitions.map((item) => item.kind)).toEqual([
      'GatewayClass',
      'Gateway',
      'HTTPRoute',
      'GRPCRoute',
      'TLSRoute',
      'TCPRoute',
      'UDPRoute',
      'ReferenceGrant'
    ]);
  });

  test('reports rejected route refs and a missing backend service', () => {
    const broken = route();
    broken.status.parents[0].conditions[1] = {
      type: 'ResolvedRefs',
      status: 'False',
      observedGeneration: 2,
      reason: 'BackendNotFound'
    };
    const items = buildGatewayApiValidationItems({
      gateways: [{ kind: 'Gateway', metadata: { name: 'public', namespace: 'apps' }, status: { conditions: [] } }],
      gatewayClasses: [],
      routes: [broken],
      referenceGrants: [],
      services: [],
      portRows: []
    });

    expect(items.some((item) => item.id.includes('resolvedrefs'))).toBe(true);
    expect(items.some((item) => item.id.includes('missing_backend'))).toBe(true);
  });

  test('reports partial endpoints as warning for every supported route kind', () => {
    const routeKinds = ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute'];
    const items = buildGatewayApiValidationItems({
      gateways: [{ kind: 'Gateway', metadata: { name: 'public', namespace: 'apps' }, status: { conditions: [] } }],
      gatewayClasses: [],
      routes: routeKinds.map((kind) => route(kind)),
      referenceGrants: [],
      services: [service(2, 3)],
      portRows: [],
      referenceGrantsPartial: false
    });

    const partial = items.filter((item) => item.id.includes('partial_endpoints'));
    expect(partial).toHaveLength(routeKinds.length);
    expect(partial.every((item) => item.severity === 'warning')).toBe(true);
  });

  test('does not claim a cross-namespace grant is missing when scoped data is incomplete', () => {
    const items = buildGatewayApiValidationItems({
      namespaceScope: 'apps',
      gateways: [{ kind: 'Gateway', metadata: { name: 'public', namespace: 'apps' }, status: { conditions: [] } }],
      gatewayClasses: [],
      routes: [route('HTTPRoute', 'shared')],
      referenceGrants: [],
      referenceGrantsPartial: true,
      services: [],
      servicesPartial: true,
      portRows: []
    });

    expect(items.some((item) => item.id.includes('reference_not_permitted'))).toBe(false);
    expect(items.some((item) => item.id.includes('missing_backend'))).toBe(false);
  });

  test('reports a partially ready Service port as warning', () => {
    const items = buildPortsValidationItems({
      services: {
        items: [{
          id: 'apps:api:8080:TCP',
          namespace: 'apps',
          service: 'api',
          port: 8080,
          protocol: 'TCP',
          exposure: 'internal',
          selector: { app: 'api' },
          endpointStatus: 'partial',
          targetStatus: 'matched',
          readyEndpoints: 2,
          totalEndpoints: 3,
          endpointPods: ['api-1', 'api-2']
        }]
      }
    });

    expect(items).toContainEqual(expect.objectContaining({
      severity: 'warning',
      title: 'Service endpoints are partially ready'
    }));
  });
});
