/**
 * The worker side of `HostedSimulationOptions.worker`, as its own entry
 * point (`@peterddod/phop/worker`) so a worker bundle doesn't pull in React.
 */

export type { PlayerInput } from './core/HostedSimulation';
export {
  createHostedSimulationWorker,
  type HostedSimulationWorkerOptions,
  type SimulationWorkerScope,
} from './core/simulation-worker';
