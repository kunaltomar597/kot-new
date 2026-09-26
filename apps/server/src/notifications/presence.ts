/**
 * Whether a person can be reached on a pager or the waiter app right now (NTF-007). The live
 * connections of the real-time gateway answer for the app; pagers join in P2-04 (MQTT).
 */
export const PRESENCE = Symbol('PRESENCE');

export interface Presence {
  reachable(restaurantId: string, staffId: string): boolean;
}

/** Where presence comes from: the gateway, and the pager broker (P2-04) when it runs. */
export class PresenceRegistry implements Presence {
  private readonly sources = new Set<(restaurantId: string, staffId: string) => boolean>();

  add(source: (restaurantId: string, staffId: string) => boolean): () => void {
    this.sources.add(source);
    return () => this.sources.delete(source);
  }

  reachable(restaurantId: string, staffId: string): boolean {
    for (const source of this.sources) if (source(restaurantId, staffId)) return true;
    return false;
  }
}
