import type { DeviceSession, OtaUpdater } from '@rp/mobile-core';
import { useEffect, useState } from 'react';
import { App } from './App';
import { appUpdater, deviceSession, notifier, translator } from './session';

/**
 * The screen of the waiter app. The device session is not the screen's: it goes on when the screen
 * is taken down, so the phone keeps alerting (P2-06b). Over-the-air updates start with the screen
 * (P7-04e1); without them the app still works.
 */
export function Root() {
  const [started, setStarted] = useState<{
    session: DeviceSession;
    updater: OtaUpdater | undefined;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([deviceSession(), appUpdater().catch(() => undefined)]).then(
      ([session, updater]) => {
        if (mounted) setStarted({ session, updater });
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  return started === null ? null : (
    <App
      session={started.session}
      translator={translator}
      notifications={notifier}
      {...(started.updater !== undefined && { updater: started.updater })}
    />
  );
}
