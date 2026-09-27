/**
 * Deterministic host election.
 *
 * Every peer runs the same election over the same inputs and converges on the
 * same host without exchanging messages. Inputs are never mutated.
 */

/**
 * Elect the host: the lowest-sorted candidate that is currently present.
 * Returns null when no candidate is present.
 */
export function electHost(candidates: string[], present: string[]): string | null {
  const presentSet = new Set(present);
  const eligible = candidates.filter((c) => presentSet.has(c));
  eligible.sort();
  return eligible[0] ?? null;
}

/**
 * The candidates that are currently in the room (self plus `peers`).
 * Feed the result to `electHost`.
 */
export function presentCandidates(candidates: string[], selfId: string, peers: string[]): string[] {
  const membership = new Set([selfId, ...peers]);
  return candidates.filter((c) => membership.has(c));
}

/**
 * True when every other active candidate vanished from our view at once and
 * there were at least two of them. That is far more likely to be our own
 * connection dropping than all of them leaving, so a host in this state
 * should hold rather than carry on alone. With one rival left, their absence
 * is treated as them leaving.
 */
export function isCutOff(
  candidates: string[],
  selfId: string,
  present: string[],
  active: ReadonlySet<string>
): boolean {
  const others = candidates.filter((c) => c !== selfId && active.has(c));
  if (others.length < 2) return false;
  const presentSet = new Set(present);
  return others.every((c) => !presentSet.has(c));
}

export interface SnapshotCheck {
  selfId: string;
  /** Envelope sender, set by the transport (trusted). */
  senderId: string;
  /** hostId written in the snapshot body (untrusted). */
  hostId: string;
  /** Who we currently consider host. */
  currentHost: string | null;
  candidates: string[];
  tick: number;
  /** Newest snapshot tick adopted as a non-host. */
  lastAppliedTick: number;
  /** Our own state's tick. */
  ownTick: number;
  /**
   * While we are a freshly promoted (or reconnected) host: the one peer whose
   * handover we accept. Null when no handover is expected.
   */
  handoverFrom: string | null;
  /** Highest tick a handover may claim, bounding how far ahead it can jump. */
  maxHandoverTick: number;
}

/**
 * Whether to adopt an incoming snapshot.
 *
 * - The body's hostId must be the real sender, who must be a candidate.
 * - As a non-host: only from the current host, and only newer ticks.
 * - As a freshly promoted host: only the expected previous host's handover,
 *   and only if it is ahead of us without jumping implausibly far, so
 *   re-taking authority never rolls its progress back and nobody else can
 *   inject state.
 */
export function shouldAdoptSnapshot(c: SnapshotCheck): boolean {
  if (c.senderId !== c.hostId) return false;
  if (!c.candidates.includes(c.senderId)) return false;
  if (c.currentHost === c.selfId) {
    return c.senderId === c.handoverFrom && c.tick > c.ownTick && c.tick <= c.maxHandoverTick;
  }
  if (c.hostId !== c.currentHost) return false;
  return c.tick > c.lastAppliedTick;
}
