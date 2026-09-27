import type { Translator } from '@rp/i18n';
import type { DeviceSession, MenuCache } from '@rp/mobile-core';
import { PairingScreen, ShellProvider, useSessionState } from '@rp/mobile-shell';
import { StatusBar } from 'expo-status-bar';
import { TabletHome } from './TabletHome';

function Screens({ menu }: { menu: MenuCache }) {
  const { phase } = useSessionState();
  if (phase === 'loading') return null;
  if (phase === 'unpaired') return <PairingScreen />;
  return <TabletHome menu={menu} />;
}

/**
 * The table tablet: paired once to its table by a manager, then customer-facing with no staff
 * login (P2-01c; ordering arrives in P3).
 */
export function App({
  session,
  menu,
  translator,
}: {
  session: DeviceSession;
  menu: MenuCache;
  translator: Translator;
}) {
  return (
    <ShellProvider session={session} translator={translator}>
      <StatusBar hidden />
      <Screens menu={menu} />
    </ShellProvider>
  );
}
