import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { electHost, presentCandidates } from '../core/host-election';
import type { PeerInfo, PeerMetadata } from '../core/wire';
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

export interface UseLobbyOptions<TConfig, TMeta extends PeerMetadata = PeerMetadata> {
  /** Guards the start config arriving from the lobby host. */
  validateConfig?: (data: unknown) => data is TConfig;
  /**
   * Guards each peer's metadata; metadata that fails it reads as null in
   * `peerInfo`. May be passed inline: it is read when peer info changes.
   */
  validateMetadata?: (data: unknown) => data is TMeta;
}

export interface UseLobbyResult<TConfig, TMeta extends PeerMetadata = PeerMetadata> {
  phase: LobbyPhase;
  /** Everyone in the room right now, deduplicated and sorted, including self. */
  players: string[];
  /** Whether we may start the match (lowest-sorted peer in the room). */
  isLobbyHost: boolean;
  /** Start the match with the current roster. Lobby host only. */
  start: (...args: undefined extends TConfig ? [config?: TConfig] : [config: TConfig]) => void;
  match: Match<TConfig> | null;
  /**
   * Each peer's protocol version and metadata (`<Room metadata>`), by peer
   * id: self and every remote peer whose hello has arrived, including peers
   * on another protocol version (`useRoom().incompatiblePeers`), which are
   * not in `players`.
   */
  peerInfo: Record<string, PeerInfo<TMeta>>;
}

type LobbyMessage<TConfig> =
  | { type: 'start'; players: string[]; config: TConfig }
  | { type: 'in-progress'; players: string[] };

function isRoster(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((p) => typeof p === 'string' && p.length > 0)
  );
}

/**
 * Pre-match lobby and match lifecycle.
 *
 * The lobby host starts the match; every peer then freezes the same roster.
 * Peers that connect once a match is running are told so by the match's
 * current host and land in the `in-progress` phase; roster members whose
 * channel opened too late to see the start are sent it again.
 *
 * Lobby messages are only accepted from the peer that should be sending them:
 * the host of the roster they carry, as elected from our own view of the room.
 */
export function useLobby<TConfig = undefined, TMeta extends PeerMetadata = PeerMetadata>(
  key = 'lobby',
  options: UseLobbyOptions<TConfig, TMeta> = {}
): UseLobbyResult<TConfig, TMeta> {
  const { peerId, peers, onPeerConnected, peerInfo: roomPeerInfo } = useRoom();
  const [phase, setPhase] = useState<LobbyPhase>('lobby');
  const [match, setMatch] = useState<Match<TConfig> | null>(null);

  const players = useMemo(
    () => Array.from(new Set([peerId, ...peers].filter(Boolean))).sort(),
    [peerId, peers]
  );
  const isLobbyHost = peerId !== '' && players[0] === peerId;

  // Read through a ref like validateConfig, so an inline guard doesn't give
  // peerInfo a new identity every render; it is read when peer info changes.
  const validateMetadataRef = useRef(options.validateMetadata);
  validateMetadataRef.current = options.validateMetadata;
  const hasMetadataGuard = options.validateMetadata !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasMetadataGuard recomputes when the guard is added or removed
  const peerInfo = useMemo(() => {
    const validate = validateMetadataRef.current;
    if (!validate) return roomPeerInfo as Record<string, PeerInfo<TMeta>>;
    const checked: Record<string, PeerInfo<TMeta>> = {};
    for (const [id, info] of Object.entries(roomPeerInfo)) {
      checked[id] = {
        protocol: info.protocol,
        metadata: info.metadata !== null && validate(info.metadata) ? info.metadata : null,
      };
    }
    return checked;
  }, [roomPeerInfo, hasMetadataGuard]);

  const validateConfigRef = useRef(options.validateConfig);
  validateConfigRef.current = options.validateConfig;
  const isLobbyMessage = useCallback((data: unknown): data is LobbyMessage<TConfig> => {
    if (typeof data !== 'object' || data === null) return false;
    const msg = data as Record<string, unknown>;
    if (!isRoster(msg.players)) return false;
    if (msg.type === 'in-progress') return true;
    if (msg.type !== 'start') return false;
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
  ) as UseLobbyResult<TConfig, TMeta>['start'];

  useEffect(
    () =>
      channel.subscribe((msg, senderId) => {
        if (phaseRef.current !== 'lobby') return;
        const self = peerIdRef.current;
        const roster = Array.from(new Set(msg.players)).sort();
        // Only the roster's current host, as we see the room, may speak for it.
        const host = electHost(roster, presentCandidates(roster, self, peersRef.current));
        if (senderId !== host) return;
        if (msg.type === 'in-progress' || !roster.includes(self)) {
          setPhase('in-progress');
          return;
        }
        setMatch({ players: roster, config: msg.config });
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
            : { type: 'in-progress', players: current.players }
        );
      }),
    [onPeerConnected, channel]
  );

  return { phase, players, isLobbyHost, start, match, peerInfo };
}
