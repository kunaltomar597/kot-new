import { calendarDateOf } from '@rp/domain';
import { affectsLicence, licenceNotice } from '@rp/ordering';
import { Button } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { useLive } from '../app/use-live.js';

const DISMISSED_KEY = 'rp.licence.reminderDismissedOn';

function today(): string {
  return calendarDateOf(new Date());
}

function dismissedToday(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === today();
  } catch {
    return false;
  }
}

/**
 * The licence on every staff screen (LIC-005, LIC-008): the polite payment reminder on the POS and
 * the dashboard (put off until tomorrow with one tap), the days left in grace or before a
 * restriction, and the restricted notice. Read again when the licence changes.
 */
export function LicenceBanner({ paymentReminder }: { paymentReminder: boolean }) {
  const t = useT();
  const controller = useConsole();
  const { data } = useLive(() => controller.api.getLicence(), affectsLicence);
  const [dismissed, setDismissed] = useState(dismissedToday);
  if (data.status !== 'ready') return null;
  const notice = licenceNotice(data.value, t, { paymentReminder });
  if (notice === undefined || (notice.dismissible && dismissed)) return null;
  return (
    <div
      className={
        notice.tone === 'info'
          ? 'console-notice licence-banner'
          : `console-notice console-notice--${notice.tone} licence-banner`
      }
      role={notice.tone === 'danger' ? 'alert' : 'status'}
    >
      <span>{notice.message}</span>
      {notice.dismissible ? (
        <Button
          variant="ghost"
          onClick={() => {
            try {
              window.localStorage.setItem(DISMISSED_KEY, today());
            } catch {
              // Not remembered: it shows again on the next screen.
            }
            setDismissed(true);
          }}
        >
          {t('licence.banner.remindTomorrow')}
        </Button>
      ) : null}
    </div>
  );
}
