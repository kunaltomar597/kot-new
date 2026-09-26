import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../../src/releases/semver.js';

function compare(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (x === undefined || y === undefined) throw new Error(`not semantic: ${a} or ${b}`);
  return Math.sign(compareVersions(x, y));
}

describe('[UPD-002] release ordering (semantic versions)', () => {
  it('orders by major, minor and patch numerically', () => {
    expect(compare('1.10.0', '1.9.9')).toBe(1);
    expect(compare('2.0.0', '10.0.0')).toBe(-1);
    expect(compare('1.2.3', '1.2.3')).toBe(0);
  });

  it('puts pre-releases before their release, in semver precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compare(ordered[index] ?? '', ordered[index - 1] ?? ''), ordered[index]).toBe(1);
    }
  });

  it('refuses versions that are not semantic', () => {
    for (const bad of [
      '1.2',
      '1.2.3.4',
      'v1.2.3',
      '01.2.3',
      '1.2.3+build',
      '',
      `1.2.${'9'.repeat(70)}`,
    ]) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
    expect(parseVersion('99999999999999999999.0.0')?.core[0]).toBe(99999999999999999999n);
  });
});
