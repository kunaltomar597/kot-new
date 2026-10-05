import type { ReleaseChannel, VendorReleaseView } from '@rp/contracts/control-plane';
import type { Translator } from '@rp/i18n';

/** Where a release's rollout stands, in a few words: "Active · 10 %", "Halted". */
export function rolloutLabel(release: VendorReleaseView, t: Translator): string {
  if (release.target !== null)
    return t('vendorApp.releases.hotfixFor', { pc: release.target.name });
  const { state, percent, cohort } = release.rollout;
  const share = t('vendorApp.releases.share', { percent, cohort: cohort.length });
  return t(`vendorApp.releases.state.${state}`, { share });
}

/** How installing it went: "4 installed, 1 failed". */
export function installsLabel(release: VendorReleaseView, t: Translator): string {
  const { attempts, installed, failures, errorSpikes } = release.installs;
  if (attempts === 0) return t('vendorApp.releases.noInstalls');
  return t('vendorApp.releases.installs', { installed, failures: failures + errorSpikes });
}

/**
 * The apps a release's server serves (UPD-006): its client API range and, once a release spoke
 * the oldest of it, the oldest app builds that still work. From its version matrix.
 */
export function matrixLabel(release: VendorReleaseView, t: Translator): string {
  const { matrix } = release;
  if (matrix === null) return t('vendorApp.releases.noMatrix');
  const { current, oldest } = matrix.clientApi;
  const api =
    current === oldest
      ? t('vendorApp.releases.apiOnly', { current })
      : t('vendorApp.releases.apiRange', { current, oldest });
  const minimum = matrix.clients.find((client) => client.minimumVersion !== null)?.minimumVersion;
  return minimum === undefined || minimum === null
    ? api
    : t('vendorApp.releases.appsFrom', { api, version: minimum });
}

/** What the release contains, by component: "server 1.6.0, node 24.21.0, …". */
export function matrixParts(release: VendorReleaseView, t: Translator): string | undefined {
  if (release.matrix === null) return undefined;
  const parts = [...release.matrix.components, ...release.matrix.clients]
    .map((part) => `${'name' in part ? part.name : part.kind} ${part.version}`)
    .join(', ');
  return t('vendorApp.releases.matrixParts', { parts });
}

/** A new release starts small on Stable and goes to every Pilot PC (UPD-003). */
export function defaultPercent(channel: ReleaseChannel): number {
  return channel === 'STABLE' ? 10 : 100;
}

/** The share typed in, or undefined when it is not a whole number from 0 to 100. */
export function percentOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= 100 ? value : undefined;
}
