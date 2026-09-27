import { useEffect, useState, useSyncExternalStore } from 'react';
import { HostedSimulation, type HostedSimulationOptions } from '../core/HostedSimulation';
import { electHost, presentCandidates } from '../core/host-election';
import { useRoom } from './useRoom';

export interface UseHostedSimulationResult<TState, TInput> {
  /** The current state. Read it in render or in an animation loop. */
  getState: () => TState;
  /** Send an input as the local player. */
  dispatch: (input: TInput) => void;
  /** Current simulation tick. */
  tick: number;
  /**
   * Increments on every state change (each stepping frame, each adopted
   * snapshot). Unlike `tick` it never repeats or goes back, so it suits
   * effect dependencies and throttles.
   */
  version: number;
  isHost: boolean;
  hostId: string | null;
}

/**
 * Run a host-authoritative, fixed-step simulation across the room.
 *
 * `key`, `players` and `init` are read once per mount; remount (e.g. with a
 * React `key`) to start a new simulation. Other options may change freely.
 * The component re-renders whenever the state changes.
 *
 * See `HostedSimulation` for the protocol.
 */
export function useHostedSimulation<TState, TInput>(
  key: string,
  options: HostedSimulationOptions<TState, TInput>
): UseHostedSimulationResult<TState, TInput> {
  const room = useRoom();
  const [sim] = useState(() => new HostedSimulation(key, options, room));
  const [players] = useState(() => options.players);
  sim.setOptions(options);

  useEffect(() => {
    sim.syncRoom(room);
  }, [sim, room]);

  useEffect(() => {
    sim.start();
    return () => sim.stop();
  }, [sim]);

  const version = useSyncExternalStore(sim.subscribe, sim.getVersion, sim.getVersion);

  const hostId = electHost(players, presentCandidates(players, room.peerId, room.peers));
  return {
    getState: sim.getState,
    dispatch: sim.dispatch,
    tick: sim.getTick(),
    version,
    isHost: hostId !== null && hostId === room.peerId,
    hostId,
  };
}
