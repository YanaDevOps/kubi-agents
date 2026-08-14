import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('customer observability artifacts', () => {
  test('ships an importable Grafana dashboard using only KUBI Prometheus metrics', () => {
    const dashboard = JSON.parse(fs.readFileSync(
      path.join(root, 'observability/grafana/kubi-agent-overview.json'),
      'utf8'
    ));

    expect(dashboard.uid).toBe('kubi-agent-overview');
    expect(dashboard.title).toBe('KUBI Agent Overview');
    expect(dashboard.__inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DS_PROMETHEUS', pluginId: 'prometheus', type: 'datasource' })
    ]));
    const expressions = dashboard.panels.flatMap((panel) =>
      (panel.targets || []).map((target) => target.expr || '')
    );
    expect(expressions.length).toBeGreaterThan(8);
    expect(expressions.every((expression) => !expression || expression.includes('kubi_'))).toBe(true);
    expect(expressions.some((expression) => expression.includes('kubi_namespace_pod_cpu_usage_cores'))).toBe(true);
    expect(expressions.some((expression) => expression.includes('kubi_workload_replicas'))).toBe(true);
    expect(JSON.stringify(dashboard)).not.toContain('kubi_storage');
  });

  test('ships bounded Prometheus alert rules for current cluster state', () => {
    const payload = YAML.parse(fs.readFileSync(
      path.join(root, 'observability/prometheus/kubi-agent-alerts.yaml'),
      'utf8'
    ));
    const rules = payload.groups.flatMap((group) => group.rules);
    const names = rules.map((rule) => rule.alert);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'KubiContextUnavailable',
      'KubiClusterCritical',
      'KubiNodeNotReady',
      'KubiNodePressure',
      'KubiWorkloadUnavailable',
      'KubiCrashLoopPods',
      'KubiFailedJobs',
      'KubiServiceWithoutReadyEndpoints'
    ]));
    expect(rules.every((rule) => rule.expr.includes('kubi_'))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('pod=');
  });

  test('ships separate local and authenticated remote scrape examples', () => {
    const local = YAML.parse(fs.readFileSync(
      path.join(root, 'observability/prometheus/scrape-local.example.yaml'),
      'utf8'
    ));
    const remote = YAML.parse(fs.readFileSync(
      path.join(root, 'observability/prometheus/scrape-remote.example.yaml'),
      'utf8'
    ));

    expect(local.scrape_configs[0].static_configs[0].targets).toEqual(['127.0.0.1:9464']);
    expect(remote.scrape_configs[0]).toMatchObject({
      scheme: 'https',
      bearer_token_file: '/etc/prometheus/kubi-agent.token',
      tls_config: { ca_file: '/etc/prometheus/kubi-agent-ca.crt' }
    });
  });

  test('publishes observability files as signed release assets', () => {
    const workflow = fs.readFileSync(
      path.join(root, '.github/workflows/agent-release.yml'),
      'utf8'
    );

    expect(workflow).toContain('dist/kubi-agent-grafana-dashboard.json');
    expect(workflow).toContain('dist/kubi-agent-alerts.yaml');
    expect(workflow).toContain('dist/kubi-agent-scrape-local.yaml');
    expect(workflow).toContain('dist/kubi-agent-scrape-remote.yaml');
    expect(workflow).toContain('cosign sign-blob');
  });
});
