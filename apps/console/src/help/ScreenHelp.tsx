import { Button, Dialog, Icon } from '@rp/ui-web';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { markSeen, seenTopics, topicForPath } from './help-topics.js';

/**
 * The help for the dashboard page being shown (NFR-U07): a "Help" button that opens a short
 * explanation, and, the first time this person visits the page, a tip above it that stays until
 * they dismiss it. The tip is not a dialog, so it never blocks work. Dismissing the tip or closing
 * the help marks the page seen.
 */
export function ScreenHelp() {
  const t = useT();
  const { pathname } = useLocation();
  const { person } = useConsoleState();
  const topic = topicForPath(pathname);
  const personId = person?.id;
  const [open, setOpen] = useState(false);
  // Pages dismissed during this visit; the stored list covers earlier visits.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const showTip =
    topic !== undefined &&
    personId !== undefined &&
    !dismissed.has(topic) &&
    !seenTopics(globalThis.localStorage, personId).has(topic);

  if (topic === undefined) return null;
  const dismiss = () => {
    setDismissed((before) => new Set(before).add(topic));
    if (personId !== undefined) markSeen(globalThis.localStorage, personId, topic);
  };
  const close = () => {
    setOpen(false);
    dismiss();
  };
  return (
    <div className="screen-help">
      {showTip ? (
        <aside className="screen-help__tip" aria-label={t('help.tipLabel')}>
          <Icon name="info" />
          <p>{t(`help.${topic}.tip`)}</p>
          <Button variant="secondary" onClick={dismiss}>
            {t('help.gotIt')}
          </Button>
        </aside>
      ) : null}
      <Button
        variant="ghost"
        startIcon={<Icon name="info" />}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('help.button')}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={t(`help.${topic}.title`)}
        footer={
          <Button onClick={close} data-autofocus>
            {t('help.gotIt')}
          </Button>
        }
      >
        <p>{t(`help.${topic}.body`)}</p>
        <p>
          <strong>{t('help.tryThis')}</strong> {t(`help.${topic}.tip`)}
        </p>
      </Dialog>
    </div>
  );
}
