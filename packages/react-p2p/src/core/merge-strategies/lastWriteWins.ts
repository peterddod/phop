import type { JSONSerializable } from '../../types';
import type { MergeStrategy } from './types';

/**
 * Metadata carried by the Last Write Wins strategy.
 * `timestamp` is a wall-clock time in milliseconds; `tiebreaker` is the
 * writing peer's ID, used to deterministically resolve same-millisecond conflicts.
 */
export type LastWriteWinsMeta = { timestamp: number; tiebreaker: string };

/**
 * Creates a Last Write Wins merge strategy.
 *
 * Accepts the incoming state whenever its wall-clock timestamp is strictly
 * greater than the current one. Ties (same millisecond) are broken
 * deterministically by comparing peer ID strings, so every peer converges to
 * the same result independently without coordination.
 *
 * Note: this strategy relies on peers having reasonably synchronised system
 * clocks. It is appropriate for use cases where approximate recency is
 * sufficient (e.g. presence indicators, cursor positions, UI state), but
 * should not be used where causal ordering must be guaranteed — prefer
 * `createLamportStrategy` in that case.
 *
 * @param getPeerId - A function that returns the local peer's ID at call time.
 *   Pass a ref-backed getter so the strategy stays stable even before the
 *   signalling handshake completes.
 */
export function createLastWriteWinsStrategy(
  getPeerId: () => string
): MergeStrategy<JSONSerializable, LastWriteWinsMeta> {
  return {
    initialMeta: { timestamp: 0, tiebreaker: getPeerId() },

    createMeta(): LastWriteWinsMeta {
      return { timestamp: Date.now(), tiebreaker: getPeerId() };
    },

    merge(
      _currentState,
      currentMeta,
      incomingState,
      incomingMeta,
      senderId
    ): { state: JSONSerializable | null; meta: LastWriteWinsMeta } | null {
      const incomingTiebreaker = incomingMeta.tiebreaker || senderId;
      const currentTiebreaker = currentMeta.tiebreaker || getPeerId();

      const timestampWins = incomingMeta.timestamp > currentMeta.timestamp;
      const tiebreakWins =
        incomingMeta.timestamp === currentMeta.timestamp && incomingTiebreaker > currentTiebreaker;

      return timestampWins || tiebreakWins
        ? { state: incomingState, meta: { ...incomingMeta, tiebreaker: incomingTiebreaker } }
        : null;
    },
  };
}
