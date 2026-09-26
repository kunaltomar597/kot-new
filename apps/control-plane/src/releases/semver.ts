/**
 * Semantic version ordering (semver.org 2.0 precedence) for release channels (UPD-002): numeric
 * major, minor and patch; a pre-release sorts before its release; pre-release identifiers compare
 * numerically when both are numbers, else as ASCII text, numbers first.
 */

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

export function parseVersion(version: string): ParsedVersion | undefined {
  if (version.length > 64) return undefined;
  const match = SEMVER.exec(version);
  if (match === null) return undefined;
  const [, major = '0', minor = '0', patch = '0', prerelease] = match;
  return {
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const [x, y] = [a.core[index] ?? 0n, b.core[index] ?? 0n];
    if (x !== y) return x < y ? -1 : 1;
  }
  // A release is newer than any of its pre-releases.
  const aIsRelease = a.prerelease.length === 0;
  const bIsRelease = b.prerelease.length === 0;
  if (aIsRelease || bIsRelease) return aIsRelease === bIsRelease ? 0 : aIsRelease ? 1 : -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}
