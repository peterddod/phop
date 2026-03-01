import type { JSONSerializable } from '../../types';
import type { MergeStrategy, StrategyContext } from './types';

export type ConsensusMeta = { index: number };

// ---------------------------------------------------------------------------
// Internal protocol message shapes
// ---------------------------------------------------------------------------

type ProposeMessage = {
  type: 'consensus-propose';
  index: number;
  localState: JSONSerializable | null;
  /** True when the sender originated this round (has a pending write to propose). */
  isInitiator?: boolean;
};

type ReadyMessage = {
  type: 'consensus-ready';
  index: number;
};

type DiffMessage = {
  type: 'consensus-diff';
  index: number;
  /** The full proposed next-state from this peer. */
  state: JSONSerializable | null;
};

type HashMessage = {
  type: 'consensus-hash';
  index: number;
  hash: string;
};

type ConsensusMessage = ProposeMessage | ReadyMessage | DiffMessage | HashMessage;

// Shape forwarded by the hook for standard state pushes (e.g. late-joiner sync).
type StatePush = {
  state: JSONSerializable | null;
  meta: ConsensusMeta;
};

function isConsensusMessage(data: unknown): data is ConsensusMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.type === 'string' && d.type.startsWith('consensus-') && typeof d.index === 'number'
  );
}

function isStatePush(data: unknown): data is StatePush {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    !('type' in d) &&
    'state' in d &&
    typeof d.meta === 'object' &&
    d.meta !== null &&
    typeof (d.meta as Record<string, unknown>).index === 'number'
  );
}

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

function sortKeys(value: JSONSerializable | null): JSONSerializable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, JSONSerializable> = {};
  for (const k of Object.keys(value as Record<string, JSONSerializable>).sort()) {
    sorted[k] = sortKeys((value as Record<string, JSONSerializable>)[k]) as JSONSerializable;
  }
  return sorted;
}

function hashState(state: JSONSerializable | null): string {
  return JSON.stringify(sortKeys(state));
}

// ---------------------------------------------------------------------------
// Co-merge: fold all peer states into a single value
//
// Uses a simple last-write-wins by peer ID ordering (deterministic across all
// peers) when states conflict. Callers can supply a custom mergeFn to override.
// ---------------------------------------------------------------------------

type MergeFn<TState extends JSONSerializable> = (
  states: Array<{ peerId: string; state: TState | null; isInitiator?: boolean }>
) => TState | null;

function defaultMerge<TState extends JSONSerializable>(
  states: Array<{ peerId: string; state: TState | null; isInitiator?: boolean }>
): TState | null {
  // Priority order (descending):
  //  1. Initiators (peers with a new pending write) that have a non-null state.
  //  2. Non-initiators with a non-null state.
  //  3. All peers (including null states).
  // Within each tier, the lexicographically greatest peer ID wins — deterministic
  // and identical across all peers.
  const initiatorNonNull = states.filter((s) => s.isInitiator && s.state !== null);
  const nonNull = states.filter((s) => s.state !== null);
  const candidates =
    initiatorNonNull.length > 0 ? initiatorNonNull : nonNull.length > 0 ? nonNull : states;
  const sorted = [...candidates].sort((a, b) => (a.peerId > b.peerId ? -1 : 1));
  return sorted[0]?.state ?? null;
}

// ---------------------------------------------------------------------------
// Round state machine
// ---------------------------------------------------------------------------

type RoundPhase = 'proposing' | 'ready' | 'diffing' | 'hashing';

interface Round<TState extends JSONSerializable> {
  index: number;
  phase: RoundPhase;
  /** Peers participating in this round (snapshot when round started). */
  peers: Set<string>;
  /** Proposed local states received from each peer (including self). */
  proposals: Map<string, TState | null>;
  /** Peers that originated this round (have a pending write, not just joining). */
  initiators: Set<string>;
  /** Ready signals received (includes self). */
  readyFrom: Set<string>;
  /** Diffs buffered before or during the diffing phase. */
  diffs: Map<string, TState | null>;
  /** Hashes buffered before or during the hashing phase. */
  hashes: Map<string, string>;
  /** The merged next-state computed locally after applying all diffs. */
  mergedState: TState | null;
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export interface ConsensusOptions<TState extends JSONSerializable> {
  /**
   * Maximum number of times the protocol will retry a round after hash
   * mismatches before giving up. Defaults to `Infinity` (retry forever).
   */
  maxRetries?: number;
  /**
   * Called when the retry limit is exceeded. Receives the last merged state
   * that was proposed before the round was aborted.
   */
  onMaxRetriesExceeded?: (lastState: TState | null) => void;
}

/**
 * Creates a consensus merge strategy.
 *
 * All peers in the room must agree on a new state before it is committed.
 * The protocol proceeds in four phases per round:
 *
 * 1. **Propose** — any peer with a pending local write broadcasts its proposed
 *    state together with a monotonically increasing round index. All other
 *    peers join the round with their own current local state.
 * 2. **Ready** — once a peer has received a proposal from every participant it
 *    locks its own proposed state and broadcasts a ready signal.
 * 3. **Diff** — once all ready signals are received every peer broadcasts its
 *    full proposed state so peers can co-merge.
 * 4. **Hash** — each peer applies the co-merge, hashes the result, and
 *    broadcasts the hash. When all hashes match the new state is committed.
 *    If hashes diverge the round is aborted and retried up to `maxRetries`
 *    times (default: unlimited). If the limit is reached, `onMaxRetriesExceeded`
 *    is called and the round is abandoned.
 *
 * If a new local write arrives while a round is in progress it is queued; only
 * the **most recent** queued write is retained — earlier writes in the same
 * round are silently superseded. The retained write becomes the proposal for
 * the next round.
 *
 * If a peer disconnects mid-round its entry is removed from `round.peers`,
 * `round.proposals`, `round.readyFrom`, `round.diffs`, and `round.hashes`.
 * The phase-completion checks are then re-evaluated against the updated peer
 * set so the round can proceed without the departed peer. If the departed peer
 * was the only remaining participant the round is aborted.
 *
 * Late joiners receive the committed state via the normal `onPeerConnected`
 * push and are excluded from any in-progress round.
 *
 * @param getPeerId - A function that returns the local peer's ID at call time.
 * @param mergeFn - Optional co-merge function. Receives all proposed states
 *   with their peer IDs and returns the merged result. Defaults to a
 *   deterministic last-write-wins by peer ID ordering.
 * @param options - Optional configuration (retry limit, abort callback).
 */
export function createConsensusStrategy<TState extends JSONSerializable>(
  getPeerId: () => string,
  mergeFn?: MergeFn<TState>,
  options?: ConsensusOptions<TState>
): MergeStrategy<TState, ConsensusMeta> {
  const merge = mergeFn ?? defaultMerge<TState>;
  const maxRetries = options?.maxRetries ?? Infinity;
  const onMaxRetriesExceeded = options?.onMaxRetriesExceeded;
  let roundIndex = 0;
  let activeRound: Round<TState> | null = null;
  /**
   * Local state written while a round is in progress. Only the most recent
   * write is retained — if the caller writes again before the round ends the
   * earlier value is silently superseded. The retained write becomes the
   * proposal for the next round once the current one commits.
   */
  let pendingWrite: { state: TState | null } | null = null;
  /** Consecutive hash-mismatch retries for the current logical write attempt. */
  let retryCount = 0;
  // Propose messages that arrived for a future round while we were still in an
  // active round. Flushed into handlePropose once the current round commits.
  const bufferedProposes: Array<{ msg: ProposeMessage; senderId: string }> = [];

  // ---------------------------------------------------------------------------
  // Helpers (closed over ctx at connect time)
  // ---------------------------------------------------------------------------

  let ctx: StrategyContext<TState, ConsensusMeta>;

  function remotePeers(): string[] {
    return ctx.getPeers().filter((p) => p !== getPeerId());
  }

  function broadcastMsg(msg: ConsensusMessage): void {
    ctx.broadcast(msg as unknown as Record<string, JSONSerializable>);
  }

  function sendMsg(peerId: string, msg: ConsensusMessage): void {
    ctx.sendToPeer(peerId, msg as unknown as Record<string, JSONSerializable>);
  }

  // ---------------------------------------------------------------------------
  // Round lifecycle
  // ---------------------------------------------------------------------------

  function startRound(index: number, localState: TState | null): Round<TState> {
    const peerId = getPeerId();
    const peers = new Set([peerId, ...remotePeers()]);
    const round: Round<TState> = {
      index,
      phase: 'proposing',
      peers,
      proposals: new Map([[peerId, localState]]),
      initiators: new Set(),
      readyFrom: new Set(),
      diffs: new Map(),
      hashes: new Map(),
      mergedState: null,
    };
    activeRound = round;
    return round;
  }

  function advanceToReady(round: Round<TState>): void {
    round.phase = 'ready';
    // Include self in readyFrom before broadcasting so that if we're the only
    // peer the check below fires immediately.
    round.readyFrom.add(getPeerId());
    broadcastMsg({ type: 'consensus-ready', index: round.index });
    checkAllReady(round);
  }

  function checkAllProposed(round: Round<TState>): void {
    if (round.phase !== 'proposing') return;
    for (const p of round.peers) {
      if (!round.proposals.has(p)) return;
    }
    advanceToReady(round);
  }

  function checkAllReady(round: Round<TState>): void {
    if (round.phase !== 'ready') return;
    for (const p of round.peers) {
      if (!round.readyFrom.has(p)) return;
    }
    // All peers ready — enter diffing phase and send our proposed state.
    round.phase = 'diffing';
    const myState = round.proposals.get(getPeerId()) ?? null;
    round.diffs.set(getPeerId(), myState);
    for (const p of round.peers) {
      if (p !== getPeerId()) {
        sendMsg(p, { type: 'consensus-diff', index: round.index, state: myState });
      }
    }
    // Flush any diffs that arrived before we entered this phase.
    checkAllDiffs(round);
  }

  function checkAllDiffs(round: Round<TState>): void {
    if (round.phase !== 'diffing') return;
    for (const p of round.peers) {
      if (!round.diffs.has(p)) return;
    }
    // Merge all diffs and hash. Initiator diffs take priority in the default
    // merge — if the caller supplied a custom mergeFn, pass all entries as-is.
    round.phase = 'hashing';
    const entries = Array.from(round.diffs.entries()).map(([peerId, state]) => ({
      peerId,
      state,
      isInitiator: round.initiators.has(peerId),
    }));
    round.mergedState = merge(entries);
    const hash = hashState(round.mergedState);
    round.hashes.set(getPeerId(), hash);
    broadcastMsg({ type: 'consensus-hash', index: round.index, hash });
    // Flush any hashes that arrived before we entered this phase.
    checkAllHashes(round);
  }

  function checkAllHashes(round: Round<TState>): void {
    if (round.phase !== 'hashing') return;
    for (const p of round.peers) {
      if (!round.hashes.has(p)) return;
    }
    const hashes = Array.from(round.hashes.values());
    const allMatch = hashes.every((h) => h === hashes[0]);

    if (allMatch) {
      retryCount = 0;
      commitRound(round);
    } else {
      // Diverged — retry with the merged state as the new proposal, up to
      // maxRetries times. If the limit is exceeded the round is abandoned and
      // onMaxRetriesExceeded is invoked so the caller can react.
      retryCount += 1;
      const retryState = round.mergedState;
      activeRound = null;
      if (retryCount > maxRetries) {
        retryCount = 0;
        onMaxRetriesExceeded?.(retryState);
      } else {
        initiateRound(retryState);
      }
    }
  }

  function commitRound(round: Round<TState>): void {
    const newIndex = round.index;
    activeRound = null;
    ctx.commit(round.mergedState, { index: newIndex });

    // Flush any propose messages that arrived for the next round while we were
    // still processing this one — process them before checking pendingWrite so
    // a remote-initiated round takes priority over a locally queued write.
    const queued = bufferedProposes.splice(0);
    for (const { msg, senderId } of queued) {
      handlePropose(msg, senderId);
    }

    // If a local write arrived while the round was in progress and no remote
    // round was started by the flush above, start the next round now.
    if (activeRound === null && pendingWrite !== null) {
      const { state } = pendingWrite;
      pendingWrite = null;
      initiateRound(state);
    }
  }

  function initiateRound(localState: TState | null): void {
    roundIndex += 1;
    const round = startRound(roundIndex, localState);
    // Mark self as the initiator (has a new pending write).
    round.initiators.add(getPeerId());
    broadcastMsg({
      type: 'consensus-propose',
      index: round.index,
      localState,
      isInitiator: true,
    });
    // If we are the only peer, skip straight to ready.
    checkAllProposed(round);
  }

  // ---------------------------------------------------------------------------
  // Peer departure handling
  // ---------------------------------------------------------------------------

  /**
   * Called whenever the peer list changes. If a peer has left while a round is
   * active, remove it from all round bookkeeping and re-evaluate phase
   * completion so the round can proceed (or be aborted if no peers remain).
   */
  function handlePeersChanged(currentPeers: string[]): void {
    if (activeRound === null) return;

    const round = activeRound;
    const currentSet = new Set(currentPeers);

    // Determine which peers in the round are no longer connected.
    const departed: string[] = [];
    for (const p of round.peers) {
      if (!currentSet.has(p)) {
        departed.push(p);
      }
    }

    if (departed.length === 0) return;

    for (const p of departed) {
      round.peers.delete(p);
      round.proposals.delete(p);
      round.readyFrom.delete(p);
      round.diffs.delete(p);
      round.hashes.delete(p);
    }

    // If only the local peer remains (or the set is now empty) there is nobody
    // left to reach consensus with — abort the round.
    const peerId = getPeerId();
    const remainingRemotes = [...round.peers].filter((p) => p !== peerId);
    if (remainingRemotes.length === 0) {
      activeRound = null;
      // If we still have a pending write, start a new solo round so it commits.
      if (pendingWrite !== null) {
        const { state } = pendingWrite;
        pendingWrite = null;
        initiateRound(state);
      }
      return;
    }

    // Re-evaluate phase completion with the updated peer set.
    switch (round.phase) {
      case 'proposing':
        checkAllProposed(round);
        break;
      case 'ready':
        checkAllReady(round);
        break;
      case 'diffing':
        checkAllDiffs(round);
        break;
      case 'hashing':
        checkAllHashes(round);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming message dispatch
  // ---------------------------------------------------------------------------

  function handleMessage(data: JSONSerializable, senderId: string): void {
    // Standard state push from another peer (e.g. late-joiner sync).
    if (isStatePush(data)) {
      handleStatePush(data, senderId);
      return;
    }

    if (!isConsensusMessage(data)) return;

    switch (data.type) {
      case 'consensus-propose':
        handlePropose(data, senderId);
        break;
      case 'consensus-ready':
        handleReady(data, senderId);
        break;
      case 'consensus-diff':
        handleDiff(data, senderId);
        break;
      case 'consensus-hash':
        handleHash(data, senderId);
        break;
    }
  }

  function handleStatePush(msg: StatePush, _senderId: string): void {
    // Only apply if we have no active round and the incoming index is ahead of ours.
    if (activeRound !== null) return;
    const currentMeta = ctx.getMeta();
    if (msg.meta.index > currentMeta.index) {
      ctx.commit(msg.state as TState | null, msg.meta);
    }
  }

  function handlePropose(msg: ProposeMessage, senderId: string): void {
    // If we have no active round, join this one with our current local state.
    if (activeRound === null) {
      roundIndex = Math.max(roundIndex, msg.index);
      const round = startRound(msg.index, ctx.getState());
      if (msg.isInitiator) round.initiators.add(senderId);
      // Broadcast our own proposal so others know we've joined.
      broadcastMsg({
        type: 'consensus-propose',
        index: round.index,
        localState: ctx.getState(),
      });
      round.proposals.set(senderId, msg.localState as TState | null);
      checkAllProposed(round);
      return;
    }

    if (activeRound.index === msg.index) {
      if (msg.isInitiator) activeRound.initiators.add(senderId);
      if (activeRound.proposals.has(senderId)) return;
      activeRound.proposals.set(senderId, msg.localState as TState | null);
      checkAllProposed(activeRound);
      return;
    }

    // Proposal is for a future round — buffer it so it isn't lost while we
    // finish the current round.
    if (msg.index > activeRound.index) {
      bufferedProposes.push({ msg, senderId });
    }
  }

  function handleReady(msg: ReadyMessage, senderId: string): void {
    if (activeRound === null || activeRound.index !== msg.index) return;
    activeRound.readyFrom.add(senderId);
    if (activeRound.phase === 'ready') {
      checkAllReady(activeRound);
    }
  }

  function handleDiff(msg: DiffMessage, senderId: string): void {
    if (activeRound === null || activeRound.index !== msg.index) return;
    activeRound.diffs.set(senderId, msg.state as TState | null);
    if (activeRound.phase === 'diffing') {
      checkAllDiffs(activeRound);
    }
  }

  function handleHash(msg: HashMessage, senderId: string): void {
    if (activeRound === null || activeRound.index !== msg.index) return;
    activeRound.hashes.set(senderId, msg.hash);
    if (activeRound.phase === 'hashing') {
      checkAllHashes(activeRound);
    }
  }

  // ---------------------------------------------------------------------------
  // MergeStrategy implementation
  // ---------------------------------------------------------------------------

  return {
    initialMeta: { index: 0 },

    connect(context: StrategyContext<TState, ConsensusMeta>): () => void {
      ctx = context;

      const unsubMessage = ctx.onMessage(handleMessage);

      const unsubWrite = ctx.onLocalWrite((state) => {
        if (activeRound !== null) {
          // A round is already in progress. Store the write so it becomes the
          // proposal for the next round. Only the most recent write is kept —
          // if the caller writes multiple times before the round ends, all but
          // the last are silently superseded (see pendingWrite declaration).
          pendingWrite = { state };
          return;
        }
        initiateRound(state);
      });

      const unsubConnected = ctx.onPeerConnected((remotePeerId) => {
        // Push current committed state to the late joiner as a standard state
        // payload. The hook wrapper adds the key, so the receiver's hook routes
        // it as a SharedStatePayload and delivers { state, meta } to the
        // strategy's onMessage as a StatePush.
        ctx.sendToPeer(remotePeerId, {
          state: ctx.getState(),
          meta: ctx.getMeta(),
        } as unknown as Record<string, JSONSerializable>);
      });

      const unsubPeers = ctx.onPeersChanged(handlePeersChanged);

      return () => {
        unsubMessage();
        unsubWrite();
        unsubConnected();
        unsubPeers();
      };
    },
  };
}
