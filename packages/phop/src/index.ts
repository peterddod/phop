export { Room, RoomContext, type RoomContextValue } from './context';
export { type Channel, type ChannelRoom, createChannel } from './core/channel';
export {
  HostedSimulation,
  type HostedSimulationOptions,
  type PlayerInput,
  type SimulationRoom,
} from './core/HostedSimulation';
export { electHost, isCutOff, presentCandidates } from './core/host-election';
export {
  type ConsensusMeta,
  createConsensusStrategy,
  createLamportStrategy,
  createLastWriteWinsStrategy,
  type LamportMeta,
  type LastWriteWinsMeta,
  type MergeMeta,
  type MergeStrategy,
  type StrategyContext,
} from './core/merge-strategies';
export { type RoomHandle, SharedStateController } from './core/SharedStateController';
export {
  type LobbyPhase,
  type Match,
  type UseHostedSimulationResult,
  type UseHostOptions,
  type UseHostResult,
  type UseLobbyOptions,
  type UseLobbyResult,
  useChannel,
  useHost,
  useHostedSimulation,
  useLobby,
  useRoom,
  useSharedState,
} from './hooks';
export { createSharedStore } from './store';
export type { JSONSerializable, Message, MessageHandler } from './types';
