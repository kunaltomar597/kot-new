import type { VendorCapability } from '@rp/contracts/control-plane';
import { createContext, type ReactNode, use, useEffect, useSyncExternalStore } from 'react';
import { type CpApi, CpApiError, createCpApi } from './cp-api.js';
import { SessionStore, type SessionState, type TokenStorage } from './session.js';

export interface Services {
  readonly api: CpApi;
  readonly session: SessionStore;
}

/** The API client and the session, wired so that a refused session signs the person out. */
export function createServices(options: {
  readonly baseUrl: string;
  readonly storage: TokenStorage;
  readonly fetch?: typeof fetch;
}): Services {
  const session = new SessionStore(options.storage);
  const api = createCpApi({
    baseUrl: options.baseUrl,
    ...(options.fetch !== undefined && { fetch: options.fetch }),
    token: () => session.token,
    onSessionOver: () => {
      session.cleared(true);
    },
  });
  return { api, session };
}

const ServicesContext = createContext<Services | null>(null);

/** Provides the services and checks a stored session once, on start. */
export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  useEffect(() => {
    const { api, session } = services;
    if (session.snapshot().status !== 'loading') return;
    api.vendorMe().then(
      (me) => {
        session.restored(me);
      },
      (error: unknown) => {
        // A 401 already signed the person out; anything else leaves them to sign in again.
        session.cleared(error instanceof CpApiError && error.status === 401);
      },
    );
  }, [services]);
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

function useServices(): Services {
  const services = use(ServicesContext);
  if (services === null) throw new Error('Wrap the app in <ServicesProvider>.');
  return services;
}

export function useApi(): CpApi {
  return useServices().api;
}

export function useSessionStore(): SessionStore {
  return useServices().session;
}

export function useSession(): SessionState {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.snapshot);
}

/** Whether the signed-in person's role allows something (the server checks it again). */
export function useMay(): (capability: VendorCapability) => boolean {
  const state = useSession();
  return (capability) => state.status === 'signedIn' && state.me.capabilities.includes(capability);
}
