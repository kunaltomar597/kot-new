/**
 * Keys of the transaction-level advisory locks (`pg_advisory_xact_lock`) the server takes, kept in
 * one place so two features never share a key by accident.
 */
export const ADVISORY_LOCKS = {
  /** Serialises audit-log writers so the hash chain has one order (P0-09). */
  auditChain: 7_261_000_001n,
  /** Lets only one bootstrap pairing code exist while no device is paired (P0-11). */
  pairingBootstrap: 7_261_000_002n,
  /** Serialises the event dispatchers that number committed outbox events (P0-12). */
  outboxSequence: 7_261_000_003n,
} as const;
