import { createHostedSimulationWorker } from '@peterddod/phop/worker';
import { type GameState, stepState } from './gameSim';

createHostedSimulationWorker<GameState, string>({ step: stepState });
