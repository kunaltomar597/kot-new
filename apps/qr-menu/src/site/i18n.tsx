'use client';

import { createTranslator, type Translator } from '@rp/i18n';
import { type UiStrings, UiStringsProvider } from '@rp/ui-web';
import { createContext, type ReactNode, use, useMemo } from 'react';

/** The site's words (NFR-L02); English in v1 like every surface (OI-07). */
export const translator: Translator = createTranslator();

const TranslatorContext = createContext<Translator>(translator);

function uiStrings(t: Translator): UiStrings {
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

export function I18nProvider({ children }: { children: ReactNode }) {
  const strings = useMemo(() => uiStrings(translator), []);
  return (
    <TranslatorContext value={translator}>
      <UiStringsProvider strings={strings}>{children}</UiStringsProvider>
    </TranslatorContext>
  );
}

export function useT(): Translator {
  return use(TranslatorContext);
}
