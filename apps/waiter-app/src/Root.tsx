import type { DeviceSession } from '@rp/mobile-core';
import { useEffect, useState } from 'react';
import { App } from './App';
import { deviceSession, notifier, translator } from './session';

/**
 * The screen of the waiter app. The device session is not the screen's: it goes on when the screen
 * is taken down, so the phone keeps alerting (P2-06b).
 */
export function Root() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  useEffect(() => {
    let mounted = true;
    void deviceSession().then((current) => {
      if (mounted) setSession(current);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return session === null ? null : (
    <App session={session} translator={translator} notifications={notifier} />
  );
}
