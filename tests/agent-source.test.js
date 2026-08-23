import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('agent source boundaries', () => {
  test('standalone agent does not import from kubi-saas src/lib paths', () => {
    const kube = readFileSync('agent/src/kube.js', 'utf8');
    const server = readFileSync('agent/src/server.js', 'utf8');
    expect(kube).not.toContain('../../src/lib/');
    expect(server).not.toContain('../../src/lib/');
    expect(kube).toContain('../../src/shared/provider-detection.js');
    expect(kube).toContain('../../src/shared/delivery-activity.js');
    expect(kube).toContain('../../src/shared/runtime-target.js');
    expect(kube).toContain('../../src/cluster-runtime/relationship-runtime.js');
    expect(server).toContain('../../src/shared/mcp-catalog.js');
  });

  test('CLI documents supported commands', () => {
    const cli = readFileSync('agent/src/cli.js', 'utf8');
    expect(cli).toContain('pair --control-plane-url <url> --pairing-token <token>');
    expect(cli).toContain('run');
    expect(cli).toContain('rotate');
    expect(cli).toContain("globalArgs['identity-file']");
  });

  test('delivery activity forwards and scopes the selected provider', () => {
    const server = readFileSync('agent/src/server.js', 'utf8');
    const kube = readFileSync('agent/src/kube.js', 'utf8');
    expect(server).toContain("url.searchParams.get('provider')");
    expect(kube).toContain('DELIVERY_PROVIDER_IDS.includes(provider)');
    expect(kube).toContain('gatewayApiDefinitionsFromCrds([record]).length > 0');
  });
});
