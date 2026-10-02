import { useContext, useMemo } from 'react';
import { RoomContext, type RoomContextValue } from '../context';

/** What `useRoom` returns: the room context with every optional field filled in. */
export type RoomApi = RoomContextValue &
  Required<
    Pick<
      RoomContextValue,
      'remotePeers' | 'connectedPeers' | 'onPeerDisconnected' | 'incompatiblePeers'
    >
  >;

const noopSubscribe = () => () => {};
const NO_PEERS: string[] = [];

export function useRoom(): RoomApi {
  const context = useContext(RoomContext);
  const room = useMemo((): RoomApi | null => {
    if (!context) return null;
    const { remotePeers, connectedPeers, onPeerDisconnected, incompatiblePeers } = context;
    if (remotePeers && connectedPeers && onPeerDisconnected && incompatiblePeers) {
      return context as RoomApi;
    }
    // A custom provider written against the 1.x shape.
    const remote = remotePeers ?? context.peers.filter((p) => p !== context.peerId);
    return {
      ...context,
      remotePeers: remote,
      connectedPeers: connectedPeers ?? remote,
      onPeerDisconnected: onPeerDisconnected ?? noopSubscribe,
      incompatiblePeers: incompatiblePeers ?? NO_PEERS,
    };
  }, [context]);
  if (!room) {
    throw new Error('useRoom must be used within a Room provider');
  }
  return room;
}
