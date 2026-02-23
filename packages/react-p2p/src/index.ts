export { Room, RoomContext, type RoomContextValue } from './context';
export {
  createLamportStrategy,
  createLastWriteWinsStrategy,
  type LamportMeta,
  type LastWriteWinsMeta,
  type MergeMeta,
  type MergeStrategy,
} from './core/merge-strategies';
export { useRoom, useSharedState } from './hooks';
export type { JSONSerializable, Message, MessageHandler } from './types';
