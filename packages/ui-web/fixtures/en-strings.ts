import type { UiStrings } from '../src/strings.js';

/**
 * English strings for tests and the workbench only. Apps get these from the `@rp/i18n` catalogue
 * (P0-14), which should start from these values.
 */
export const EN_STRINGS: UiStrings = {
  pinPad: {
    label: 'PIN',
    backspace: 'Delete last digit',
    clear: 'Clear',
    submit: 'Enter',
    progress: (entered, length) =>
      `${String(entered)} of ${String(length)} ${length === 1 ? 'digit' : 'digits'} entered`,
  },
  numberPad: {
    backspace: 'Delete last digit',
    clear: 'Clear',
    decimal: 'Decimal point',
  },
  dialog: {
    close: 'Close',
  },
  toast: {
    region: 'Notifications',
    dismiss: 'Dismiss notification',
  },
};
