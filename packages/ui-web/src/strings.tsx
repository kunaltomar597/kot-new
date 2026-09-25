import { createContext, type ReactNode, use } from 'react';

/**
 * The few words the components themselves need (button names for screen readers, progress
 * announcements). Components never hard-code UI text (NFR-L02): the app passes these from its
 * `@rp/i18n` catalogue through `UiStringsProvider`. Every other label is a prop.
 */
export interface UiStrings {
  readonly pinPad: {
    /** Accessible name of the PIN pad when the screen gives none, e.g. "PIN". */
    readonly label: string;
    readonly backspace: string;
    readonly clear: string;
    readonly submit: string;
    /** Announced after each key press, e.g. "2 of 4 digits entered". Never includes the digits. */
    readonly progress: (entered: number, length: number) => string;
  };
  readonly numberPad: {
    readonly backspace: string;
    readonly clear: string;
    readonly decimal: string;
  };
  readonly dialog: {
    readonly close: string;
  };
  readonly toast: {
    /** Landmark name of the notification area, e.g. "Notifications". */
    readonly region: string;
    readonly dismiss: string;
  };
}

const UiStringsContext = createContext<UiStrings | null>(null);

export function UiStringsProvider({
  strings,
  children,
}: {
  strings: UiStrings;
  children: ReactNode;
}) {
  return <UiStringsContext value={strings}>{children}</UiStringsContext>;
}

export function useUiStrings(): UiStrings {
  const strings = use(UiStringsContext);
  if (!strings) {
    throw new Error(
      'UI strings are missing: wrap the app in <UiStringsProvider strings={...}> (from @rp/i18n).',
    );
  }
  return strings;
}
