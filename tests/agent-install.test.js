import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('agent installer safety', () => {
  test('POSIX installer verifies checksum before pairing', () => {
    const source = readFileSync('agent/install/install.sh', 'utf8');
    expect(source).toContain('curl -fsSL "$DOWNLOAD_BASE_URL/$ARTIFACT"');
    expect(source).toContain('curl -fsSL "$DOWNLOAD_BASE_URL/$ARTIFACT.sha256"');
    expect(source).toContain('Checksum verification failed');
    expect(source.indexOf('if [ "$EXPECTED" != "$ACTUAL" ]')).toBeLessThan(source.indexOf('pair --control-plane-url'));
  });

  test('Windows installer verifies checksum before pairing', () => {
    const source = readFileSync('agent/install/install.ps1', 'utf8');
    expect(source).toContain('Get-FileHash');
    expect(source).toContain('Checksum verification failed');
    expect(source).toContain('New-Service');
    expect(source.indexOf('if ($expected.ToLowerInvariant() -ne $actual)')).toBeLessThan(source.indexOf('pair --control-plane-url'));
  });
});
