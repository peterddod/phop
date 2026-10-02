import {
  type LobbyPhase,
  type UseHostedSimulationResult,
  useHostedSimulation,
  useLobby,
} from '@peterddod/phop';
import { useEffect, useRef } from 'react';

interface Unit {
  id: string;
  q: number;
  r: number;
  hp: number;
}

interface GameState {
  count: number;
  log: string[];
  /** Bulk, so snapshots are compressed and sent as deltas over real channels. */
  units: Record<string, Unit>;
  nextId: number;
}

function addUnit(state: GameState) {
  const id = `u${state.nextId++}`;
  state.units[id] = { id, q: state.nextId % 31, r: state.nextId % 17, hp: 40 };
}

function initState(): GameState {
  const state: GameState = { count: 0, log: [], units: {}, nextId: 0 };
  for (let i = 0; i < 400; i++) addUnit(state);
  return state;
}

/** A tenth of the units move each step; one dies and one spawns every few steps. */
function stepState(state: GameState) {
  state.count++;
  const ids = Object.keys(state.units);
  for (let i = state.count % 10; i < ids.length; i += 10) state.units[ids[i]].q++;
  if (state.count % 4 === 0) delete state.units[ids[0]];
  if (state.count % 4 === 2) addUnit(state);
}

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
  /** The JSON of the state this peer stepped to `tick` while host. */
  hostState: (tick: number) => string | null;
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
      stepState(state);
      for (const { playerId, input } of inputs) state.log.push(`${playerId}:${input}`);
      hostHistory.set(state.count, JSON.stringify(state));
      hostHistory.delete(state.count - 200);
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
      snapshot: () => {
        const state = simRef.current?.getState();
        return state ? { tick: state.count, json: JSON.stringify(state) } : null;
      },
      hostState: (tick) => hostHistory.get(tick) ?? null,
      dispatch: (input) => simRef.current?.dispatch(input),
    };
  }, []);

  return lobby.match ? <SimProbe players={lobby.match.players} simRef={simRef} /> : null;
}
