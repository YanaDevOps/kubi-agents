import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentMetricsState,
  createPrometheusExporter,
  renderPrometheusMetrics
} from '../agent/src/metrics-exporter.js';

function snapshot() {
  return {
    namespaces: 2,
    nodes: { ready: 3, notReady: 0, pressures: { memory: 0, disk: 0, pid: 0, network: 0 } },
    workloads: {
      deployment: { total: 5, unavailable: 0 },
      statefulset: { total: 1, unavailable: 0 },
      daemonset: { total: 2, unavailable: 0 }
    },
    pods: {
      phases: { running: 10, pending: 0, succeeded: 2, failed: 0, unknown: 0 },
      activeReady: 10,
      activeNotReady: 0,
      crashLoop: 0
    },
    failedJobs: 0,
    servicesWithoutReadyEndpoints: 0,
    metrics: {
      available: true,
      nodeCpuUsageCores: 1.5,
      nodeMemoryUsageBytes: 1024,
      podCpuUsageCores: 0.5,
      podMemoryUsageBytes: 512
    },
    details: {
      nodes: [{
        name: 'worker-1',
        ready: true,
        pressures: { memory: false, disk: false, pid: false, network: false },
        cpuAllocatableCores: 4,
        memoryAllocatableBytes: 8589934592,
        cpuUsageCores: 1.5,
        memoryUsageBytes: 1024
      }],
      namespaces: [{
        name: 'default',
        phases: { running: 2, pending: 1, succeeded: 0, failed: 0, unknown: 0 },
        activeReady: 2,
        activeNotReady: 1,
        cpuUsageCores: 0.5,
        memoryUsageBytes: 512,
        cpuRequestsCores: 1,
        cpuLimitsCores: 2,
        memoryRequestsBytes: 536870912,
        memoryLimitsBytes: 1073741824
      }],
      workloads: [{
        namespace: 'default',
        kind: 'deployment',
        name: 'web',
        desired: 3,
        ready: 2,
        available: 2
      }]
    },
    health: 'healthy',
    partial: false
  };
}

function request(port, token = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/metrics',
      headers: token ? { authorization: `Bearer ${token}` } : {}
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Prometheus exporter', () => {
  test('renders bounded aggregate metrics without resource-name labels', () => {
    const output = renderPrometheusMetrics({
      version: '0.1.22',
      runtimeApiVersion: '2',
      platform: 'linux/x64',
      state: createAgentMetricsState(),
      collection: {
        durationSeconds: 0.2,
        lastSuccessTimestampSeconds: 1,
        contexts: [{ context: 'production', up: true, snapshot: snapshot() }]
      }
    });
    expect(output).toContain('kubi_cluster_up{context="production"} 1');
    expect(output).toContain('kubi_cluster_pods{context="production",phase="succeeded"} 2');
    expect(output).not.toContain('pod=');
    expect(output).not.toContain('node=');
  });

  test('renders opt-in balanced node, namespace and workload metrics without pod labels', () => {
    const output = renderPrometheusMetrics({
      version: '0.1.25',
      runtimeApiVersion: '2',
      platform: 'linux/x64',
      state: createAgentMetricsState(),
      collection: {
        detailLevel: 'balanced',
        durationSeconds: 0.2,
        lastSuccessTimestampSeconds: 1,
        contexts: [{ context: 'production', up: true, snapshot: snapshot() }]
      }
    });

    expect(output).toContain('kubi_node_ready{context="production",node="worker-1"} 1');
    expect(output).toContain('kubi_node_cpu_allocatable_cores{context="production",node="worker-1"} 4');
    expect(output).toContain('kubi_namespace_pods{context="production",namespace="default",phase="pending"} 1');
    expect(output).toContain('kubi_namespace_pod_cpu_requests_cores{context="production",namespace="default"} 1');
    expect(output).toContain('kubi_workload_replicas{context="production",kind="deployment",namespace="default",state="ready",workload="web"} 2');
    expect(output).not.toContain('pod=');
    expect(output).not.toContain('container=');
  });

  test('omits usage samples instead of reporting false zeroes when metrics.k8s.io is unavailable', () => {
    const unavailable = snapshot();
    unavailable.metrics = { available: false };
    delete unavailable.details.nodes[0].cpuUsageCores;
    delete unavailable.details.nodes[0].memoryUsageBytes;
    delete unavailable.details.namespaces[0].cpuUsageCores;
    delete unavailable.details.namespaces[0].memoryUsageBytes;

    const output = renderPrometheusMetrics({
      version: '0.1.25',
      runtimeApiVersion: '2',
      platform: 'linux/x64',
      state: createAgentMetricsState(),
      collection: {
        detailLevel: 'balanced',
        durationSeconds: 0.2,
        lastSuccessTimestampSeconds: 1,
        contexts: [{ context: 'production', up: true, snapshot: unavailable }]
      }
    });

    expect(output).toContain('kubi_cluster_metrics_api_available{context="production"} 0');
    expect(output).not.toContain('kubi_cluster_node_cpu_usage_cores{context="production"}');
    expect(output).not.toContain('kubi_node_cpu_usage_cores{context="production",node="worker-1"}');
    expect(output).not.toContain('kubi_namespace_pod_cpu_usage_cores{context="production",namespace="default"}');
    expect(output).toContain('kubi_namespace_pod_cpu_requests_cores{context="production",namespace="default"} 1');
  });

  test('serves cached metrics behind bearer authentication', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubi-agent-metrics-'));
    const tokenPath = path.join(directory, 'token');
    fs.writeFileSync(tokenPath, 'secret\n', { mode: 0o600 });
    let collections = 0;
    const exporter = createPrometheusExporter({
      runtimeConfig: {
        metricsExporter: {
          enabled: true,
          listenAddress: '127.0.0.1',
          port: 0,
          collectionIntervalSeconds: 60,
          detailLevel: 'balanced',
          contexts: [],
          bearerTokenFile: tokenPath,
          tls: { certFile: '', keyFile: '' }
        }
      },
      version: '0.1.22',
      runtimeApiVersion: '2',
      platform: 'linux/x64',
      discoveryProvider: () => ({
        sourceCount: 1,
        candidates: [{ sourceContextName: 'production', clusterFingerprint: 'fp', recommendedMode: 'agent' }]
      }),
      selectorProvider: (runtimeConfig) => runtimeConfig,
      snapshotProvider: async (_runtimeConfig, options) => {
        collections += 1;
        expect(options).toEqual({ detailLevel: 'balanced' });
        return snapshot();
      }
    });
    try {
      await exporter.start();
      await exporter.collect();
      const port = exporter.address().port;
      expect((await request(port)).status).toBe(401);
      const first = await request(port, 'secret');
      const second = await request(port, 'secret');
      expect(first.status).toBe(200);
      expect(second.body).toBe(first.body);
      expect(collections).toBe(1);
    } finally {
      await exporter.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
