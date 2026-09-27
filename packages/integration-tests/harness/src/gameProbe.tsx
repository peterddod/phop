import {
  type LobbyPhase,
  type UseHostedSimulationResult,
  useHostedSimulation,
  useLobby,
} from '@peterddod/phop';
import { useEffect, useRef } from 'react';

interface GameState {
  count: number;
  log: string[];
}

interface GameApi {
  phase: () => LobbyPhase;
  players: () => string[];
  isLobbyHost: () => boolean;
  start: () => void;
  matchPlayers: () => string[] | null;
  tick: () => number;
  isHost: () => boolean;
  hostId: () => string | null;
  state: () => GameState | null;
  dispatch: (input: string) => void;
}

declare global {
  interface Window {
    __game: GameApi;
  }
}

type SimHandle = UseHostedSimulationResult<GameState, string>;

const isString = (d: unknown): d is string => typeof d === 'string';

function SimProbe({
  players,
  simRef,
}: {
  players: string[];
  simRef: React.RefObject<SimHandle | null>;
}) {
  const sim = useHostedSimulation<GameState, string>('game', {
    players,
    init: () => ({ count: 0, log: [] }),
    step: (state, inputs) => {
      state.count++;
      for (const { playerId, input } of inputs) state.log.push(`${playerId}:${input}`);
    },
    validateInput: isString,
    absence: { timeoutMs: 2000, toInput: () => 'resign' },
  });
  simRef.current = sim;
  return null;
}

/** Exposes useLobby + useHostedSimulation on window.__game (harness `?game=1`). */
export function GameProbe() {
  const lobby = useLobby();
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;
  const simRef = useRef<SimHandle | null>(null);

  useEffect(() => {
    window.__game = {
      phase: () => lobbyRef.current.phase,
      players: () => lobbyRef.current.players,
      isLobbyHost: () => lobbyRef.current.isLobbyHost,
      start: () => lobbyRef.current.start(),
      matchPlayers: () => lobbyRef.current.match?.players ?? null,
      tick: () => simRef.current?.tick ?? -1,
      isHost: () => simRef.current?.isHost ?? false,
      hostId: () => simRef.current?.hostId ?? null,
      state: () => simRef.current?.getState() ?? null,
      dispatch: (input) => simRef.current?.dispatch(input),
    };
  }, []);

  return lobby.match ? <SimProbe players={lobby.match.players} simRef={simRef} /> : null;
}
