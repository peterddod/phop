import { useMemo } from 'react';
import { electHost, presentCandidates } from '../core/host-election';
import { useRoom } from './useRoom';

export interface UseHostOptions {
  /** Who may be host. Defaults to everyone in the room. */
  candidates?: string[];
}

export interface UseHostResult {
  hostId: string | null;
  isHost: boolean;
}

/**
 * The room's host: the lowest-sorted candidate currently in the room. Every
 * peer computes the same answer without coordination, and the host moves to
 * the next candidate when it leaves.
 */
export function useHost(options: UseHostOptions = {}): UseHostResult {
  const { peerId, peers } = useRoom();
  const { candidates } = options;

  return useMemo(() => {
    const pool = candidates ?? (peerId ? [peerId, ...peers] : peers);
    const hostId = electHost(pool, presentCandidates(pool, peerId, peers));
    return { hostId, isHost: hostId !== null && hostId === peerId };
  }, [candidates, peerId, peers]);
}
