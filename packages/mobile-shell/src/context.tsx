import type { Translator } from '@rp/i18n';
import type { DeviceSession, DeviceSessionSnapshot } from '@rp/mobile-core';
import { ThemeProvider, type UiStrings, UiStringsProvider } from '@rp/ui-native';
import { createContext, type ReactNode, use, useMemo, useSyncExternalStore } from 'react';

interface Shell {
  readonly session: DeviceSession;
  readonly t: Translator;
}

const ShellContext = createContext<Shell | null>(null);

/** The words `@rp/ui-native` components need, from the catalogue (NFR-L02). */
export function uiStrings(t: Translator): UiStrings {
  return {
    pinPad: {
      label: t('ui.pinPad.label'),
      backspace: t('ui.pinPad.backspace'),
      clear: t('ui.pinPad.clear'),
      submit: t('ui.pinPad.submit'),
      progress: (entered, length) => t('ui.pinPad.progress', { entered, length }),
    },
    dialog: { close: t('ui.dialog.close') },
    toast: { dismiss: t('ui.toast.dismiss') },
  };
}

/** Gives the screens the device session, the catalogue and the theme. */
export function ShellProvider({
  session,
  translator,
  children,
}: {
  session: DeviceSession;
  translator: Translator;
  children: ReactNode;
}) {
  const shell = useMemo(() => ({ session, t: translator }), [session, translator]);
  const strings = useMemo(() => uiStrings(translator), [translator]);
  return (
    <ShellContext value={shell}>
      <ThemeProvider>
        <UiStringsProvider strings={strings}>{children}</UiStringsProvider>
      </ThemeProvider>
    </ShellContext>
  );
}

function useShell(): Shell {
  const shell = use(ShellContext);
  if (shell === null) throw new Error('Wrap the app in <ShellProvider>.');
  return shell;
}

/** The device session's actions. */
export function useDeviceSession(): DeviceSession {
  return useShell().session;
}

/** The device session's state; re-renders when it changes. */
export function useSessionState(): DeviceSessionSnapshot {
  const { session } = useShell();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

/** The `t()` of the current catalogue. */
export function useT(): Translator {
  return useShell().t;
}
