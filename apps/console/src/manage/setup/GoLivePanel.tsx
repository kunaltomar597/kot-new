import type { GoLiveView } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Button, useToast } from '@rp/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';

/** While the test runs, look again this often for what has happened. */
const POLL_MS = 5_000;

/**
 * The go-live test (ONB-004 step 11, P7-07c): one test order through every path the restaurant
 * uses, each ticked as the server sees it, then billed. Once all are ticked the step can be
 * confirmed on the set-up page.
 */
export function GoLivePanel({ onChange }: { onChange: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [view, setView] = useState<GoLiveView | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    controller.api.getGoLive().then(setView, () => undefined);
  }, [controller]);
  useEffect(load, [load]);
  const running = (view?.startedAt ?? null) !== null && view?.passed === false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);
  const passed = view?.passed === true;
  useEffect(() => {
    if (passed) onChange();
  }, [passed, onChange]);

  if (view === undefined) return null;
  return (
    <section className="device-group" aria-labelledby="setup-go-live">
      <h3 id="setup-go-live" className="device-group__heading">
        {t('setupPage.goLive.title')}
      </h3>
      <p className="dashboard-section__hint">{t('setupPage.goLive.intro')}</p>
      {view.startedAt === null ? null : (
        <ul className="go-live-paths" aria-label={t('setupPage.goLive.paths')}>
          {view.paths
            .filter((entry) => entry.needed)
            .map((entry) => (
              <li key={entry.path} className="go-live-path">
                {entry.seenAt === null ? (
                  <Badge tone="warning">{t('setupPage.goLive.waiting')}</Badge>
                ) : (
                  <Badge tone="success">
                    {t('setupPage.goLive.seen', {
                      time: displayDateTime(new Date(entry.seenAt)).time,
                    })}
                  </Badge>
                )}{' '}
                {t(`setupPage.goLive.path.${entry.path}`)}
              </li>
            ))}
        </ul>
      )}
      {passed ? (
        <p className="console-notice console-notice--success">{t('setupPage.goLive.passed')}</p>
      ) : null}
      <Button
        variant={view.startedAt === null ? 'primary' : 'secondary'}
        loading={busy}
        onClick={() => {
          setBusy(true);
          controller.api.startGoLive().then(
            (started) => {
              setBusy(false);
              setView(started);
            },
            (failure: unknown) => {
              setBusy(false);
              toast.show({ title: messageOf(failure, t), tone: 'danger' });
            },
          );
        }}
      >
        {view.startedAt === null ? t('setupPage.goLive.start') : t('setupPage.goLive.restart')}
      </Button>
    </section>
  );
}
