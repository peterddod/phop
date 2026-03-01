import type { JSONSerializable } from '../../types';
import type { MergeStrategy, StrategyContext } from './types';

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
  // Monotonically increasing local timestamp. Ensures that rapid successive
  // local writes never produce duplicate {timestamp, tiebreaker} pairs, which
  // would cause the second write to silently lose on remote peers.
  let lastTimestamp = 0;

  return {
    initialMeta: { timestamp: 0, tiebreaker: getPeerId() },

    connect(ctx: StrategyContext<JSONSerializable, LastWriteWinsMeta>): () => void {
      // ctx.onMessage receives pre-filtered messages for this state key.
      // data is the { state, meta } payload (key already stripped by the hook).
      const unsubMessage = ctx.onMessage((data, senderId) => {
        const payload = data as { state: JSONSerializable | null; meta: LastWriteWinsMeta };
        const incomingMeta = payload.meta;
        const currentMeta = ctx.getMeta();

        // Advance local monotonic clock to account for clock skew from peers
        // with ahead clocks, so subsequent local writes always order after them.
        lastTimestamp = Math.max(lastTimestamp, incomingMeta.timestamp);

        const incomingTiebreaker = incomingMeta.tiebreaker || senderId;
        const currentTiebreaker = currentMeta.tiebreaker || getPeerId();

        const timestampWins = incomingMeta.timestamp > currentMeta.timestamp;
        const tiebreakWins =
          incomingMeta.timestamp === currentMeta.timestamp &&
          incomingTiebreaker > currentTiebreaker;

        if (timestampWins || tiebreakWins) {
          ctx.commit(payload.state, { ...incomingMeta, tiebreaker: incomingTiebreaker });
        }
      });

      const unsubWrite = ctx.onLocalWrite((state) => {
        let ts = Date.now();
        if (ts <= lastTimestamp) ts = lastTimestamp + 1;
        lastTimestamp = ts;
        const meta: LastWriteWinsMeta = { timestamp: ts, tiebreaker: getPeerId() };
        ctx.commit(state, meta);
        ctx.broadcast({ state, meta });
      });

      const unsubConnected = ctx.onPeerConnected((remotePeerId) => {
        ctx.sendToPeer(remotePeerId, { state: ctx.getState(), meta: ctx.getMeta() });
      });

      return () => {
        unsubMessage();
        unsubWrite();
        unsubConnected();
      };
    },
  };
}
