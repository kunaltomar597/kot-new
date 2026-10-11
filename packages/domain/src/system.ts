/**
 * The server PC's own health as the System page and the disk alert see it (MGR-010, DATA-006),
 * and when "Install now" may be approved (UPD-004).
 */

/** How full the data drive is: below the warning level, at or above it, at or above critical. */
export const STORAGE_LEVELS = ['OK', 'WARNING', 'CRITICAL'] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];

/** The drive's use in whole percent, as the disk alert and the System page show it. */
export function usedPercentOf(totalBytes: number, freeBytes: number): number {
  if (totalBytes <= 0) return 0;
  const used = Math.min(Math.max(totalBytes - freeBytes, 0), totalBytes);
  return Math.round((used / totalBytes) * 100);
}

/** The level of a drive `usedPercent` full, against the restaurant's two levels (⚙ 80 and 90). */
export function storageLevelOf(
  usedPercent: number,
  levels: { readonly warnPercent: number; readonly criticalPercent: number },
): StorageLevel {
  if (usedPercent >= levels.criticalPercent) return 'CRITICAL';
  if (usedPercent >= levels.warnPercent) return 'WARNING';
  return 'OK';
}

/** Why "Install now" cannot be approved. */
export type InstallNowRefusal = 'UPDATE_NOT_OFFERED' | 'TABLES_OPEN' | 'REASON_REQUIRED';

export interface InstallNowRequestFacts {
  /** The release the Control Plane offers now, or null when there is none. */
  readonly offered: { readonly version: string; readonly securityCritical: boolean } | null;
  /** The version the manager saw and approved. */
  readonly version: string;
  readonly openTables: number;
  readonly reason?: string | undefined;
}

/**
 * UPD-004: an update installs in the maintenance window or when a manager presses "Install now",
 * never while tables are open, unless it is security-critical and a manager approves: then the
 * approval needs a reason (at least 3 characters), which the audit log keeps. The version must be
 * the one offered now, so an approval never applies to a release the manager did not see.
 */
export function installNowRefusal(facts: InstallNowRequestFacts): InstallNowRefusal | null {
  if (facts.offered?.version !== facts.version) return 'UPDATE_NOT_OFFERED';
  if (facts.openTables === 0) return null;
  if (!facts.offered.securityCritical) return 'TABLES_OPEN';
  return (facts.reason?.trim().length ?? 0) >= 3 ? null : 'REASON_REQUIRED';
}
