import {
  type LobbyPhase,
  type UseHostedSimulationResult,
  useHostedSimulation,
  useLobby,
} from '@peterddod/phop';
import { useEffect, useRef } from 'react';
import { type GameState, initState, stepState } from './gameSim';

// `?worker=1`: the host steps in a Web Worker (`gameWorker.ts`).
const withWorker = new URLSearchParams(window.location.search).get('worker') === '1';
const startWorker = () =>
  new Worker(new URL('./gameWorker.ts', import.meta.url), { type: 'module' });

// The host's state after each tick it stepped, to compare clients against.
const hostHistory = new Map<number, string>();

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
  /** The state as JSON, with its tick. */
  snapshot: () => { tick: number; json: string } | null;
  /** The JSON of the state this peer stepped to `tick` while host (not in worker mode). */
  hostState: (tick: number) => string | null;
  /** The JSON of the state after `tick` steps without inputs. */
  replay: (tick: number) => string;
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
    init: initState,
    step: (state, inputs) => {
      stepState(state, inputs);
      hostHistory.set(state.count, JSON.stringify(state));
      hostHistory.delete(state.count - 200);
    },
    validateInput: isString,
    absence: { timeoutMs: 2000, toInput: () => 'resign' },
    worker: withWorker ? startWorker : undefined,
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
      snapshot: () => {
        const state = simRef.current?.getState();
        return state ? { tick: state.count, json: JSON.stringify(state) } : null;
      },
      hostState: (tick) => hostHistory.get(tick) ?? null,
      replay: (tick) => {
        const state = initState();
        for (let i = 0; i < tick; i++) stepState(state, []);
        return JSON.stringify(state);
      },
      dispatch: (input) => simRef.current?.dispatch(input),
    };
  }, []);

  return lobby.match ? <SimProbe players={lobby.match.players} simRef={simRef} /> : null;
}
