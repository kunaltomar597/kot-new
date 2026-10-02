import type {
  VendorCapability,
  VendorMeView,
  VendorSessionView,
} from '@rp/contracts/control-plane';

/** Where the session token is kept: the tab's session storage, gone when the tab closes. */
export interface TokenStorage {
  read(): string | undefined;
  write(token: string | undefined): void;
}

const KEY = 'rp.vendor.session';

/** `sessionStorage`, tolerating browsers that refuse it (private windows, blocked storage). */
export function browserTokenStorage(): TokenStorage {
  return {
    read() {
      try {
        return globalThis.sessionStorage.getItem(KEY) ?? undefined;
      } catch {
        return undefined;
      }
    },
    write(token) {
      try {
        if (token === undefined) globalThis.sessionStorage.removeItem(KEY);
        else globalThis.sessionStorage.setItem(KEY, token);
      } catch {
        // Not kept: the person signs in again after a reload.
      }
    },
  };
}

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signedOut'; readonly ended: boolean }
  | { readonly status: 'signedIn'; readonly me: VendorMeView };

/**
 * Who is signed in (VCP-001). The token lives in session storage only; the server ends a session
 * after 8 hours or 30 minutes idle, and any call it refuses with 401 signs the person out here.
 */
export class SessionStore {
  private state: SessionState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private tokenValue: string | undefined;

  constructor(private readonly storage: TokenStorage) {
    this.tokenValue = storage.read();
    if (this.tokenValue === undefined) this.state = { status: 'signedOut', ended: false };
  }

  get token(): string | undefined {
    return this.tokenValue;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): SessionState => this.state;

  /** A new session from signing in. */
  started(session: VendorSessionView): void {
    this.tokenValue = session.token;
    this.storage.write(session.token);
    this.set({
      status: 'signedIn',
      me: { user: session.user, capabilities: session.capabilities, expiresAt: session.expiresAt },
    });
  }

  /** The stored session is still good: who it belongs to. */
  restored(me: VendorMeView): void {
    if (this.tokenValue !== undefined) this.set({ status: 'signedIn', me });
  }

  /** Signed out here (`ended: false`), or the server ended the session (`ended: true`). */
  cleared(ended: boolean): void {
    if (this.tokenValue === undefined && this.state.status === 'signedOut') return;
    this.tokenValue = undefined;
    this.storage.write(undefined);
    this.set({ status: 'signedOut', ended });
  }

  may(capability: VendorCapability): boolean {
    return this.state.status === 'signedIn' && this.state.me.capabilities.includes(capability);
  }

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
