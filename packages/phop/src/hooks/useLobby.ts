import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { electHost, presentCandidates } from '../core/host-election';
import { useChannel } from './useChannel';
import { useRoom } from './useRoom';

/**
 * - `lobby`: waiting for the lobby host to start.
 * - `playing`: a match we are part of is running.
 * - `in-progress`: a match started without us (we arrived late).
 */
export type LobbyPhase = 'lobby' | 'playing' | 'in-progress';

export interface Match<TConfig> {
  /** Frozen, sorted roster. Pass it to `useHostedSimulation` as `players`. */
  players: string[];
  config: TConfig;
}

export interface UseLobbyOptions<TConfig> {
  /** Guards the start config arriving from the lobby host. */
  validateConfig?: (data: unknown) => data is TConfig;
}

export interface UseLobbyResult<TConfig> {
  phase: LobbyPhase;
  /** Everyone in the room right now, deduplicated and sorted, including self. */
  players: string[];
  /** Whether we may start the match (lowest-sorted peer in the room). */
  isLobbyHost: boolean;
  /** Start the match with the current roster. Lobby host only. */
  start: (...args: undefined extends TConfig ? [config?: TConfig] : [config: TConfig]) => void;
  match: Match<TConfig> | null;
}

type LobbyMessage<TConfig> =
  | { type: 'start'; players: string[]; config: TConfig }
  | { type: 'in-progress' };

/**
 * Pre-match lobby and match lifecycle.
 *
 * The lobby host starts the match; every peer then freezes the same roster.
 * Peers that connect once a match is running are told so by the match's
 * current host and land in the `in-progress` phase; roster members whose
 * channel opened too late to see the start are sent it again.
 */
export function useLobby<TConfig = undefined>(
  key = 'lobby',
  options: UseLobbyOptions<TConfig> = {}
): UseLobbyResult<TConfig> {
  const { peerId, peers, onPeerConnected } = useRoom();
  const [phase, setPhase] = useState<LobbyPhase>('lobby');
  const [match, setMatch] = useState<Match<TConfig> | null>(null);

  const players = useMemo(
    () => Array.from(new Set([peerId, ...peers].filter(Boolean))).sort(),
    [peerId, peers]
  );
  const isLobbyHost = peerId !== '' && players[0] === peerId;

  const validateConfigRef = useRef(options.validateConfig);
  validateConfigRef.current = options.validateConfig;
  const isLobbyMessage = useCallback((data: unknown): data is LobbyMessage<TConfig> => {
    if (typeof data !== 'object' || data === null) return false;
    const msg = data as Record<string, unknown>;
    if (msg.type === 'in-progress') return true;
    if (msg.type !== 'start') return false;
    if (!Array.isArray(msg.players) || msg.players.length === 0) return false;
    if (!msg.players.every((p) => typeof p === 'string' && p.length > 0)) return false;
    return validateConfigRef.current?.(msg.config) ?? true;
  }, []);
  const channel = useChannel(key, isLobbyMessage);

  // Mirrored so handlers see current values without resubscribing.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const matchRef = useRef(match);
  matchRef.current = match;
  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;
  const peersRef = useRef(peers);
  peersRef.current = peers;

  const start = useCallback(
    (config?: TConfig) => {
      if (phaseRef.current !== 'lobby' || !isLobbyHost) return;
      const next: Match<TConfig> = { players, config: config as TConfig };
      channel.broadcast({ type: 'start', ...next });
      setMatch(next);
      setPhase('playing');
    },
    [channel, isLobbyHost, players]
  ) as UseLobbyResult<TConfig>['start'];

  useEffect(
    () =>
      channel.subscribe((msg, senderId) => {
        if (phaseRef.current !== 'lobby') return;
        if (msg.type === 'in-progress') {
          setPhase('in-progress');
          return;
        }
        if (!msg.players.includes(senderId)) return;
        if (!msg.players.includes(peerIdRef.current)) {
          setPhase('in-progress');
          return;
        }
        setMatch({ players: [...msg.players].sort(), config: msg.config });
        setPhase('playing');
      }),
    [channel]
  );

  useEffect(
    () =>
      onPeerConnected((newPeer) => {
        const current = matchRef.current;
        if (phaseRef.current !== 'playing' || !current) return;
        const self = peerIdRef.current;
        const host = electHost(
          current.players,
          presentCandidates(current.players, self, peersRef.current)
        );
        if (host !== self) return;
        // A roster member whose channel opened after the start missed it.
        channel.send(
          newPeer,
          current.players.includes(newPeer)
            ? { type: 'start', ...current }
            : { type: 'in-progress' }
        );
      }),
    [onPeerConnected, channel]
  );

  return { phase, players, isLobbyHost, start, match };
}
