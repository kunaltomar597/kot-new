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

/**
 * How the installed PC checks updates (UPD-007, P7-04c): the Authenticode signer every update
 * must carry (`RP_UPDATE_PUBLISHER`, the code-signing certificate's subject), or, for a test build
 * only, unsigned updates (`RP_ALLOW_UNSIGNED_UPDATES=1`). Neither: the PC refuses updates.
 */
export interface UpdateSettings {
  readonly publisher?: string;
  readonly allowUnsigned: boolean;
}

export function updateSettingsFrom(
  env: Readonly<Record<string, string | undefined>>,
): UpdateSettings {
  const publisher = env.RP_UPDATE_PUBLISHER?.trim();
  const allowUnsigned = env.RP_ALLOW_UNSIGNED_UPDATES?.trim() === '1';
  if (publisher !== undefined && publisher !== '') {
    if (allowUnsigned) {
      throw new Error('A build with an update publisher never accepts unsigned updates');
    }
    if (!/^[^\r\n]{3,500}$/.test(publisher)) {
      throw new Error('RP_UPDATE_PUBLISHER is the certificate subject, e.g. CN=..., O=..., C=IN');
    }
    return { publisher, allowUnsigned: false };
  }
  return { allowUnsigned };
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
  readonly updates?: UpdateSettings;
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
  const updates = options.updates;
  if (updates?.publisher !== undefined) {
    lines.push(`!define RP_UPDATE_PUBLISHER "${nsisString(updates.publisher)}"`);
  }
  if (updates?.allowUnsigned === true) lines.push('!define RP_ALLOW_UNSIGNED_UPDATES');
  return `${lines.join('\n')}\n`;
}
