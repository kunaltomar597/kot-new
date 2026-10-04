/**
 * The build's settings for the installer's NSIS script (P0-16d), written by the stage step to
 * `staging/installer-defines.nsh` and included by `installer/installer.nsh`: where the set-up scripts
 * are, the free space the data drive needs, and the vendor's services this build points at.
 */

/** The settings catalogue's `onboarding.minFreeDiskGb` default: the settings do not exist yet. */
export const MIN_FREE_GB = 20;

/** The vendor's services, from the CI build's variables; unset ones stay off on the PC. */
export interface CloudSettings {
  readonly controlPlaneUrl?: string;
  readonly relayUrl?: string;
  readonly qrSiteUrl?: string;
  readonly errorDsn?: string;
}

/** The variables the packaging reads them from: the same names the server reads (P0-16b). */
export const CLOUD_VARIABLES = {
  controlPlaneUrl: 'RP_CONTROL_PLANE_URL',
  relayUrl: 'RP_RELAY_URL',
  qrSiteUrl: 'RP_QR_SITE_URL',
  errorDsn: 'RP_ERROR_DSN',
} as const satisfies Record<keyof CloudSettings, string>;

export function cloudSettingsFrom(
  env: Readonly<Record<string, string | undefined>>,
): CloudSettings {
  const settings: Record<string, string> = {};
  for (const [key, variable] of Object.entries(CLOUD_VARIABLES)) {
    const value = env[variable]?.trim();
    if (value === undefined || value === '') continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${variable} is not an address: ${value}`);
    }
    if (url.protocol !== 'https:') throw new Error(`${variable} must be an https address`);
    settings[key] = value;
  }
  return settings;
}

/** A value inside an NSIS string in double quotes. */
export function nsisString(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('An NSIS string cannot hold a line break');
  return value.replaceAll('$', '$$$$').replaceAll('"', '$\\"');
}

export interface NsisDefinesOptions {
  /** The staged set-up scripts, which the installer unpacks before anything is copied. */
  readonly setupDir: string;
  /** The settings catalogue's `onboarding.minFreeDiskGb` default (the settings do not exist yet). */
  readonly minFreeGb: number;
  readonly cloud: CloudSettings;
}

export function nsisDefines(options: NsisDefinesOptions): string {
  if (!Number.isInteger(options.minFreeGb) || options.minFreeGb < 1) {
    throw new Error('The free space needed must be a whole number of GB');
  }
  const lines = [
    '; Written by the stage step (apps/desktop/src/packaging); do not edit.',
    `!define RP_SETUP_DIR "${nsisString(options.setupDir.replaceAll('\\', '/'))}"`,
    `!define RP_MIN_FREE_GB ${options.minFreeGb}`,
  ];
  // The script's defines carry the same names as the variables.
  for (const [key, define] of Object.entries(CLOUD_VARIABLES)) {
    const value = options.cloud[key as keyof CloudSettings];
    if (value !== undefined) lines.push(`!define ${define} "${nsisString(value)}"`);
  }
  return `${lines.join('\n')}\n`;
}
