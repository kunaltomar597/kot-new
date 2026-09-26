import type { Translator } from '@rp/i18n';
import { type UiStrings, UiStringsProvider } from '@rp/ui-web';
import { createContext, type ReactNode, use, useMemo } from 'react';

const TranslatorContext = createContext<Translator | null>(null);

/** The words `@rp/ui-web` components need, from the catalogue (NFR-L02). */
export function uiStrings(t: Translator): UiStrings {
  return {
    pinPad: {
      label: t('ui.pinPad.label'),
      backspace: t('ui.pinPad.backspace'),
      clear: t('ui.pinPad.clear'),
      submit: t('ui.pinPad.submit'),
      progress: (entered, length) => t('ui.pinPad.progress', { entered, length }),
    },
    numberPad: {
      backspace: t('ui.numberPad.backspace'),
      clear: t('ui.numberPad.clear'),
      decimal: t('ui.numberPad.decimal'),
    },
    dialog: { close: t('ui.dialog.close') },
    toast: { region: t('ui.toast.region'), dismiss: t('ui.toast.dismiss') },
  };
}

export function I18nProvider({
  translator,
  children,
}: {
  translator: Translator;
  children: ReactNode;
}) {
  const strings = useMemo(() => uiStrings(translator), [translator]);
  return (
    <TranslatorContext value={translator}>
      <UiStringsProvider strings={strings}>{children}</UiStringsProvider>
    </TranslatorContext>
  );
}

/** The `t()` of the current catalogue. */
export function useT(): Translator {
  const translator = use(TranslatorContext);
  if (translator === null) throw new Error('Wrap the console in <I18nProvider>.');
  return translator;
}
