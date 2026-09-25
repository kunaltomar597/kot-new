import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request values that services need without threading them through every call. */
export interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `work` (and everything it awaits) with `context` as the current request context. */
export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

/** The current request's context, or undefined outside a request (startup, jobs, tests). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
