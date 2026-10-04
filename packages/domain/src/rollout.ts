import { compareVersions, parseVersion } from './semver.js';

/**
 * Staged rollout of releases (UPD-002, UPD-003, P7-04a): which release a restaurant PC is offered,
 * and when a rollout halts by itself.
 *
 * - Every PC has a bucket from 0 to 99 per release, the same every time, so widening a rollout
 *   from 10 % to 30 % keeps the first 10 % and adds the next 20 %.
 * - A release is offered to the PCs in its cohort and those whose bucket is below its
 *   percentage, while its rollout is active. Paused or halted, it is offered to nobody new.
 * - A hotfix is a release for one PC only; it comes before the channel's releases.
 * - A PC held at a version is offered nothing newer than that version, but is still offered that
 *   version while it runs an older one, whatever the rollout.
 * - Nothing is ever offered that is not newer than what the PC runs (migrations go forward only,
 *   UPD-005).
 */

export type RolloutState = 'ACTIVE' | 'PAUSED' | 'HALTED';

export interface RolloutRelease {
  readonly id: string;
  readonly version: string;
  /** 0 to 100: the share of PCs offered it. */
  readonly percent: number;
  readonly state: RolloutState;
  /** PCs offered it whatever their bucket (the pilot restaurants). */
  readonly cohort: readonly string[];
  /** A hotfix: offered to this PC only. */
  readonly targetInstallationId: string | null;
}

export interface RolloutInstallation {
  readonly id: string;
  /** What it runs. */
  readonly version: string;
  /** Held at this version by the vendor (UPD-002); null when it follows its channel. */
  readonly pinnedVersion: string | null;
}

/** FNV-1a, 32 bits: small, stable and good enough to spread PCs over 100 buckets. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The PC's place in the release's rollout, 0 to 99, the same every time. */
export function rolloutBucket(installationId: string, releaseId: string): number {
  return fnv1a(`${releaseId}:${installationId}`) % 100;
}

/** Negative, zero or positive as `a` is older, the same as or newer than `b`; unparsable is oldest. */
export function compareVersionText(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (x === undefined || y === undefined) {
    return x === undefined && y === undefined ? 0 : x === undefined ? -1 : 1;
  }
  return compareVersions(x, y);
}

/** Whether the rollout reaches this PC now. */
export function inRollout(release: RolloutRelease, installationId: string): boolean {
  if (release.state !== 'ACTIVE') return false;
  if (release.cohort.includes(installationId)) return true;
  return rolloutBucket(installationId, release.id) < release.percent;
}

/**
 * The release to offer the PC, or undefined when it should stay where it is. `releases` are those
 * of its component on its channel, and the hotfixes for it.
 */
export function releaseToOffer<R extends RolloutRelease>(
  installation: RolloutInstallation,
  releases: readonly R[],
): R | undefined {
  if (parseVersion(installation.version) === undefined) return undefined;
  const newer = releases.filter(
    (release) =>
      parseVersion(release.version) !== undefined &&
      compareVersionText(release.version, installation.version) > 0 &&
      (release.targetInstallationId === null || release.targetInstallationId === installation.id) &&
      (installation.pinnedVersion === null ||
        compareVersionText(release.version, installation.pinnedVersion) <= 0),
  );
  const newest = (candidates: readonly R[]) =>
    candidates.reduce<R | undefined>(
      (best, release) =>
        best === undefined || compareVersionText(release.version, best.version) > 0
          ? release
          : best,
      undefined,
    );
  // A hotfix for this PC first, unless it was halted.
  const hotfix = newest(
    newer.filter(
      (release) => release.targetInstallationId === installation.id && release.state !== 'HALTED',
    ),
  );
  if (hotfix !== undefined) return hotfix;
  const channel = newer.filter((release) => release.targetInstallationId === null);
  // Held at a version: that version, whatever the rollout, unless it was halted.
  if (installation.pinnedVersion !== null) {
    const held = channel.find(
      (release) =>
        compareVersionText(release.version, installation.pinnedVersion ?? '') === 0 &&
        release.state !== 'HALTED',
    );
    if (held !== undefined) return held;
  }
  return newest(channel.filter((release) => inRollout(release, installation.id)));
}

export interface RolloutHealth {
  /** PCs that started installing the release, or report running it. */
  readonly attempts: number;
  /** Rolled back, failed, or silent after starting to install. */
  readonly failures: number;
  /** Of the PCs running it, those whose server errors spiked after the update. */
  readonly errorSpikes: number;
}

export interface HaltRule {
  /** Failures needed before a rollout halts, however small the share. */
  readonly minFailures: number;
  /** The share of attempts failing (0 to 1) that halts it. */
  readonly maxFailureShare: number;
}

export const DEFAULT_HALT_RULE: HaltRule = { minFailures: 2, maxFailureShare: 0.2 };

/** Why the rollout should halt, or undefined while it is healthy (UPD-003). */
export function haltReason(
  health: RolloutHealth,
  rule: HaltRule = DEFAULT_HALT_RULE,
): string | undefined {
  const bad = health.failures + health.errorSpikes;
  if (health.attempts === 0 || bad < rule.minFailures) return undefined;
  if (bad / health.attempts < rule.maxFailureShare) return undefined;
  const parts = [
    health.failures > 0 ? `${String(health.failures)} failed or rolled back` : undefined,
    health.errorSpikes > 0 ? `${String(health.errorSpikes)} with an error spike` : undefined,
  ].filter((part) => part !== undefined);
  return `Halted automatically: ${parts.join(' and ')}, of ${String(health.attempts)} PCs that installed it.`;
}
