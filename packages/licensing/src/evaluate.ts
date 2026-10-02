import type { LicencePayload, LicenceState } from '@rp/contracts/control-plane';
import {
  type BusinessDayConfig,
  DEFAULT_BUSINESS_DAY,
  licenseCapabilities,
  type LicenseCapabilities,
  restrictionEffectiveAt,
} from '@rp/domain';
import { isLicensedPc } from './fingerprint.js';
import type { LicenceFileProblem, VerifiedLicence } from './signing.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Why an installation is restricted (or will be from the next business day). */
export type LicenceProblem =
  | LicenceFileProblem
  /** The file is another installation's. */
  | 'OTHER_INSTALLATION'
  /** Fewer than three of the PC's identifiers match: not the licensed PC (LIC-004). */
  | 'OTHER_PC'
  /** Not renewed before it ran out, e.g. offline too long (LIC-002). */
  | 'EXPIRED'
  | 'GRACE_ENDED'
  /** The vendor restricted or terminated it. */
  | 'VENDOR';

export interface LicenceInput {
  readonly file: VerifiedLicence;
  readonly installationId: string;
  /** The PC's fingerprint now (`fingerprintOf`). */
  readonly fingerprint: readonly (string | null)[];
  /** The time to judge by: the clock, never earlier than the last time seen (`guardedNow`). */
  readonly now: Date;
  /** When a restriction was first decided, as saved; undefined when none is pending. */
  readonly restrictionDecidedAt: Date | undefined;
  /** An offline reactivation code accepted, active until then (LIC-006). */
  readonly reactivatedUntil?: Date | undefined;
  readonly businessDay?: BusinessDayConfig;
}

export interface LicenceStatus {
  /** What the licence says, or RESTRICTED for a problem: what applies once it takes effect. */
  readonly recorded: LicenceState;
  /** What the restaurant experiences now: a restriction waits for the next business day. */
  readonly state: LicenceState;
  readonly problem: LicenceProblem | null;
  /** When a restriction applies, pending or applied; null when none. */
  readonly restrictedFrom: Date | null;
  /** To save: when the restriction was first decided; null clears it. */
  readonly restrictionDecidedAt: Date | null;
  readonly validUntil: Date | null;
  /** Whole days left: of grace, or before a pending restriction applies; else null. */
  readonly daysLeft: number | null;
  /** What the restaurant can do now (LIC-005). */
  readonly capabilities: LicenseCapabilities;
  readonly payload: LicencePayload | null;
}

function graceEndOf(payload: LicencePayload): Date | undefined {
  if (payload.graceStartedAt === null) return undefined;
  return new Date(Date.parse(payload.graceStartedAt) + payload.graceDays * DAY_MS);
}

function problemOf(input: LicenceInput): LicenceProblem | null {
  if (!input.file.ok) return input.file.problem;
  const { payload } = input.file;
  if (payload.installationId !== input.installationId) return 'OTHER_INSTALLATION';
  if (!isLicensedPc(payload.fingerprint, input.fingerprint)) return 'OTHER_PC';
  if (input.now.getTime() > Date.parse(payload.validUntil)) return 'EXPIRED';
  const graceEnd = graceEndOf(payload);
  if (payload.state === 'GRACE' && graceEnd !== undefined && graceEnd <= input.now) {
    return 'GRACE_ENDED';
  }
  if (payload.state === 'RESTRICTED' || payload.state === 'TERMINATED') return 'VENDOR';
  return null;
}

/**
 * The licence state the restaurant experiences (LIC-005), from the verified file, this PC and the
 * time. Anything wrong with the file, another PC, a licence run out offline or a grace period
 * over means RESTRICTED; the vendor may restrict or terminate. A restriction never starts in the
 * middle of service: it applies from the start of the next business day after it was first
 * decided, and until then the restaurant sees a banner. An offline reactivation code makes it
 * active again until its day (LIC-006), except for a terminated contract or a file not trusted.
 */
export function evaluateLicence(input: LicenceInput): LicenceStatus {
  const payload = input.file.ok ? input.file.payload : null;
  const { now } = input;
  let problem = problemOf(input);
  const reactivated =
    input.reactivatedUntil !== undefined &&
    now < input.reactivatedUntil &&
    (problem === 'EXPIRED' ||
      problem === 'GRACE_ENDED' ||
      (problem === 'VENDOR' && payload?.state === 'RESTRICTED'));
  if (reactivated) problem = null;

  let recorded: LicenceState;
  if (reactivated) recorded = 'ACTIVE';
  else if (problem === null) recorded = payload?.state ?? 'RESTRICTED';
  else
    recorded =
      problem === 'VENDOR' && payload?.state === 'TERMINATED' ? 'TERMINATED' : 'RESTRICTED';
  const validUntil = payload === null ? null : new Date(payload.validUntil);

  if (recorded === 'RESTRICTED' || recorded === 'TERMINATED') {
    const decidedAt = input.restrictionDecidedAt ?? now;
    const restrictedFrom = restrictionEffectiveAt(
      decidedAt,
      input.businessDay ?? DEFAULT_BUSINESS_DAY,
    );
    const applied = now >= restrictedFrom;
    // Until it applies, the restaurant works as in grace, with the banner saying when.
    const state: LicenceState = applied ? recorded : 'GRACE';
    return {
      recorded,
      state,
      problem,
      restrictedFrom,
      restrictionDecidedAt: decidedAt,
      validUntil,
      daysLeft: applied
        ? 0
        : Math.max(1, Math.ceil((restrictedFrom.getTime() - now.getTime()) / DAY_MS)),
      capabilities: licenseCapabilities(state),
      payload,
    };
  }
  const graceEnd = payload === null ? undefined : graceEndOf(payload);
  return {
    recorded,
    state: recorded,
    problem: null,
    restrictedFrom: null,
    restrictionDecidedAt: null,
    validUntil,
    daysLeft:
      recorded === 'GRACE' && graceEnd !== undefined
        ? Math.max(0, Math.ceil((graceEnd.getTime() - now.getTime()) / DAY_MS))
        : null,
    capabilities: licenseCapabilities(recorded),
    payload,
  };
}
