import { describe, expect, test } from 'bun:test';
import {
  buildPortsTruthSummary,
  buildPortsValidationItems
} from '../src/cluster-runtime/relationship-runtime.js';

const list = (items) => ({ items, partial: false });

function buildPorts({ servicePorts, endpointPorts, readyStates, containerPorts = [] }) {
  return buildPortsTruthSummary({
    services: list([{
      metadata: { name: 'metrics', namespace: 'observability' },
      spec: { type: 'ClusterIP', selector: { app: 'metrics' }, ports: servicePorts }
    }]),
    endpointSlices: list([{
      metadata: {
        name: 'metrics-abc',
        namespace: 'observability',
        labels: { 'kubernetes.io/service-name': 'metrics' }
      },
      ports: endpointPorts,
      endpoints: readyStates.map((ready, index) => ({
        addresses: [`10.0.0.${index + 1}`],
        conditions: { ready },
        targetRef: { kind: 'Pod', namespace: 'observability', name: `metrics-${index}` }
      }))
    }]),
    pods: list([{
      metadata: { name: 'metrics-0', namespace: 'observability', labels: { app: 'metrics' } },
      spec: { containers: [{ name: 'metrics', ports: containerPorts }] }
    }]),
    ingresses: list([]),
    namespaceScope: 'observability',
    fetchedAt: '2026-07-23T00:00:00.000Z',
    issues: [],
    partial: false
  });
}

describe('networking validation runtime', () => {
  test('emits one unavailable Service finding for zero ready endpoints', () => {
    const ports = buildPorts({
      servicePorts: [{ name: 'http', port: 3000, protocol: 'TCP', targetPort: 3000 }],
      endpointPorts: [{ name: 'http', port: 3000, protocol: 'TCP' }],
      readyStates: [false],
      containerPorts: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }]
    });
    const findings = buildPortsValidationItems(ports);

    expect(ports.services.items[0].endpointStatus).toBe('missing');
    expect(findings.filter((item) => item.title === 'Service has no ready endpoints')).toHaveLength(1);
    expect(findings.some((item) => item.title === 'Service endpoints are partially ready')).toBe(false);
  });

  test('aggregates multi-port partial readiness into one finding', () => {
    const ports = buildPorts({
      servicePorts: [
        { name: 'http', port: 8080, protocol: 'TCP', targetPort: 8080 },
        { name: 'metrics', port: 9090, protocol: 'TCP', targetPort: 9090 }
      ],
      endpointPorts: [
        { name: 'http', port: 8080, protocol: 'TCP' },
        { name: 'metrics', port: 9090, protocol: 'TCP' }
      ],
      readyStates: [true, true, false],
      containerPorts: [
        { name: 'http', containerPort: 8080, protocol: 'TCP' },
        { name: 'metrics', containerPort: 9090, protocol: 'TCP' }
      ]
    });
    const findings = buildPortsValidationItems(ports)
      .filter((item) => item.title === 'Service endpoints are partially ready');

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain('Port 8080/TCP');
    expect(findings[0].evidence).toContain('Port 9090/TCP');
  });

  test('accepts numeric targetPort without containerPort when EndpointSlice is ready', () => {
    const ports = buildPorts({
      servicePorts: [{ name: 'http-metrics', port: 8080, protocol: 'TCP', targetPort: 8680 }],
      endpointPorts: [{ name: 'http-metrics', port: 8680, protocol: 'TCP' }],
      readyStates: [true, true, true]
    });

    expect(ports.services.items[0]).toMatchObject({
      resolvedTargetPort: 8680,
      endpointStatus: 'ready',
      targetStatus: 'matched'
    });
    expect(buildPortsValidationItems(ports)
      .some((item) => item.id.includes('target_port_unresolved'))).toBe(false);
  });

  test('keeps unresolved named targetPort diagnostics', () => {
    const ports = buildPorts({
      servicePorts: [{ name: 'metrics', port: 8080, protocol: 'TCP', targetPort: 'metrics-http' }],
      endpointPorts: [],
      readyStates: [true]
    });

    expect(ports.services.items[0].targetStatus).toBe('unresolved-target-port');
  });
});
