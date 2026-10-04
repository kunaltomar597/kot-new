import { Injectable } from '@nestjs/common';

/**
 * Exit code that asks the Windows service (and the watchdog, NFR-A04) to start the server again:
 * a restart that is meant, e.g. to run a restore before the server starts (P7-05b).
 */
export const RESTART_EXIT_CODE = 75;

/** The message the service host sends the server over IPC to stop it (P0-16b, `main.ts`). */
export const SHUTDOWN_MESSAGE = { type: 'rp:shutdown' } as const;

/** Lets a feature ask for the server to restart; `main.ts` does it after the reply is sent. */
@Injectable()
export class ServerLifecycle {
  private readonly listeners = new Set<() => void>();
  private requested = false;

  /** Called by `main.ts`; tests leave it alone and check `restartRequested`. */
  onRestart(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get restartRequested(): boolean {
    return this.requested;
  }

  /** Restarts shortly, so the reply to the request that asked for it is sent first. */
  requestRestart(delayMs = 1_000): void {
    this.requested = true;
    setTimeout(() => {
      for (const listener of this.listeners) listener();
    }, delayMs).unref();
  }
}
