import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('agent source boundaries', () => {
  test('standalone agent does not import from kubi-saas src/lib paths', () => {
    const kube = readFileSync('agent/src/kube.js', 'utf8');
    expect(kube).not.toContain('../../src/lib/');
    expect(kube).toContain('../../src/shared/provider-detection.js');
    expect(kube).toContain('../../src/shared/runtime-target.js');
    expect(kube).toContain('../../src/cluster-runtime/relationship-runtime.js');
  });

  test('CLI documents supported commands', () => {
    const cli = readFileSync('agent/src/cli.js', 'utf8');
    expect(cli).toContain('pair --control-plane-url <url> --pairing-token <token>');
    expect(cli).toContain('run');
    expect(cli).toContain('rotate');
  });
});
