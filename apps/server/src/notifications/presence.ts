/**
 * Whether a person can be reached on a pager or the waiter app right now (NTF-007). The live
 * connections of the real-time gateway answer for the app; pagers join in P2-04 (MQTT).
 */
export const PRESENCE = Symbol('PRESENCE');

export interface Presence {
  reachable(restaurantId: string, staffId: string): boolean;
}
