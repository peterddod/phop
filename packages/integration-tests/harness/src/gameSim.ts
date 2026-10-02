import type { PlayerInput } from '@peterddod/phop/worker';

/** The hosted game's simulation, shared by the page and its worker (`?worker=1`). */

interface Unit {
  id: string;
  q: number;
  r: number;
  hp: number;
}

export interface GameState {
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

export function initState(): GameState {
  const state: GameState = { count: 0, log: [], units: {}, nextId: 0 };
  for (let i = 0; i < 400; i++) addUnit(state);
  return state;
}

/** A tenth of the units move each step; one dies and one spawns every few steps. */
export function stepState(state: GameState, inputs: PlayerInput<string>[]) {
  state.count++;
  const ids = Object.keys(state.units);
  for (let i = state.count % 10; i < ids.length; i += 10) state.units[ids[i]].q++;
  if (state.count % 4 === 0) delete state.units[ids[0]];
  if (state.count % 4 === 2) addUnit(state);
  for (const { playerId, input } of inputs) state.log.push(`${playerId}:${input}`);
}
