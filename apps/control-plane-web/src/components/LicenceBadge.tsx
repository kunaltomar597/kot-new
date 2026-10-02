import type { LicenceState } from '@rp/contracts/control-plane';
import { Badge } from '@rp/ui-web';
import { useT } from '../app/i18n.js';

export const LICENCE_TONE = {
  ACTIVE: 'success',
  PAYMENT_DUE: 'info',
  GRACE: 'warning',
  RESTRICTED: 'danger',
  TERMINATED: 'danger',
} as const;

/** A licence state as a coloured label (never colour alone: the state is written). */
export function LicenceBadge({ state }: { state: LicenceState | null }) {
  const t = useT();
  if (state === null) return <Badge tone="neutral">{t('vendorApp.licence.none')}</Badge>;
  return <Badge tone={LICENCE_TONE[state]}>{t(`vendorApp.licence.state.${state}`)}</Badge>;
}
