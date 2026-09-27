import type { UiStrings } from '../src/strings.js';

/** English strings for tests only. Apps build these from the `@rp/i18n` `ui.*` catalogue keys. */
export const EN_STRINGS: UiStrings = {
  pinPad: {
    label: 'PIN',
    backspace: 'Delete last digit',
    clear: 'Clear',
    submit: 'Enter',
    progress: (entered, length) =>
      `${String(entered)} of ${String(length)} ${length === 1 ? 'digit' : 'digits'} entered`,
  },
  dialog: { close: 'Close' },
  toast: { dismiss: 'Dismiss notification' },
};
