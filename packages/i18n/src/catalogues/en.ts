/**
 * English (India) UI text: the reference catalogue every other language must match key for key
 * (NFR-L02). Messages use the ICU subset in `message-format.ts`. Write plain language that says
 * what to do next (NFR-U04); never put prices here (format money with `@rp/domain`).
 */
export const en = {
  app: {
    name: 'Restaurant Operations Platform',
  },
  roles: {
    OWNER: 'Owner',
    MANAGER: 'Manager',
    CASHIER: 'Cashier',
    WAITER: 'Waiter',
    KITCHEN: 'Kitchen',
  },
  ui: {
    pinPad: {
      label: 'PIN',
      backspace: 'Delete last digit',
      clear: 'Clear',
      submit: 'Enter',
      progress: '{entered} of {length} {length, plural, one {digit} other {digits}} entered',
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
  },
  connection: {
    online: 'Connected to the restaurant server',
    connecting: 'Connecting to the restaurant server…',
    offline: 'Can’t reach the restaurant server. Retrying…',
    restored: 'Connection restored',
  },
  pairing: {
    title: 'Pair this device',
    intro: 'Ask a manager for a pairing code (Manage → Devices → Pair a device) and enter it here.',
    codeLabel: 'Pairing code',
    submit: 'Pair device',
    working: 'Pairing…',
    paired: 'Paired as {name}',
    insecureContext:
      'This browser can only be paired over a secure connection. Open the console on the restaurant PC, or use the secure address.',
    revoked: 'This device was unpaired by a manager. Pair it again to continue.',
  },
  login: {
    title: 'Who is signing in?',
    noStaff: 'No staff are set up yet. The owner adds staff in Manage → Staff.',
    pinFor: 'Enter the PIN for {name}',
    notYou: 'Not you?',
    working: 'Signing in…',
    attemptsLeft: '{count, plural, one {# try} other {# tries}} left before this login is locked.',
    signOut: 'Sign out',
    signedOutInactive: 'You were signed out after a period of inactivity. Sign in again.',
    signedOut: 'You have been signed out. Sign in again.',
  },
  session: {
    inactivityWarning:
      '{seconds, plural, one {Signing out in # second} other {Signing out in # seconds}}. Tap anywhere to stay signed in.',
  },
  modes: {
    pos: 'POS',
    kds: 'Kitchen display',
    manage: 'Manage',
    comingSoon: 'The {mode} screens arrive in a later update.',
    notAllowed: 'Your role cannot open {mode}.',
  },
  states: {
    loading: 'Loading…',
    empty: 'Nothing here yet.',
    error: 'Something went wrong.',
    retry: 'Try again',
  },
  errors: {
    generic: 'Something went wrong. Try again.',
    network: 'Can’t reach the restaurant server. Check the Wi-Fi and try again.',
    timeout: 'The server took too long to answer. Try again.',
  },
} as const;
