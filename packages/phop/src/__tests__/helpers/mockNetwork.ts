import type { RoomContextValue } from '../../context/Room';
import type { SimulationRoom } from '../../core/HostedSimulation';
import type { JSONSerializable, Message, MessageHandler } from '../../types';

export interface MockRoom extends SimulationRoom {
  handlers: Set<MessageHandler>;
  peerConnectedHandlers: Set<(remotePeerId: string) => void>;
}

/**
 * In-memory room mesh. Messages are delivered synchronously as a JSON round
 * trip to peers listed in the sender's `peers`, with `senderId` set by the
 * "transport" like the real Room does.
 */
export function createMockNetwork() {
  const rooms = new Map<string, MockRoom>();

  function deliver(from: string, to: string, message: Message<JSONSerializable>) {
    const target = rooms.get(to);
    if (!target || to === from) return;
    const wire = JSON.parse(JSON.stringify(message)) as Message<JSONSerializable>;
    for (const h of target.handlers) h({ ...wire, senderId: from });
  }

  function join(peerId: string): MockRoom {
    const room: MockRoom = {
      peerId,
      peers: [peerId],
      isConnected: true,
      handlers: new Set(),
      peerConnectedHandlers: new Set(),
      broadcast: (message) => {
        for (const p of room.peers) deliver(peerId, p, message);
      },
      sendToPeer: (to, message) => {
        if (room.peers.includes(to)) deliver(peerId, to, message);
      },
      onMessage: (handler) => {
        room.handlers.add(handler as MessageHandler);
        return () => {
          room.handlers.delete(handler as MessageHandler);
        };
      },
    };
    rooms.set(peerId, room);
    return room;
  }

  /** Set every listed room's view of the membership. */
  function setMembers(members: string[], viewers: string[] = members) {
    for (const v of viewers) {
      const room = rooms.get(v);
      if (room) room.peers = [...members];
    }
  }

  /** Deliver raw data to `to` as if `from` sent it. */
  function inject(from: string, to: string, data: JSONSerializable) {
    deliver(from, to, { senderId: from, data, timestamp: Date.now() });
  }

  /** Fire `onPeerConnected` on `viewer` for `remotePeerId`. */
  function connect(viewer: string, remotePeerId: string) {
    const room = rooms.get(viewer);
    if (room) for (const h of room.peerConnectedHandlers) h(remotePeerId);
  }

  return { join, setMembers, inject, connect, rooms };
}

/** Snapshot a mock room as a Room context value (re-create after changes). */
export function toContextValue(room: MockRoom): RoomContextValue {
  const remote = room.peers.filter((p) => p !== room.peerId);
  return {
    roomId: 'test-room',
    peerId: room.peerId,
    peers: [...room.peers],
    remotePeers: remote,
    connectedPeers: remote,
    isConnected: room.isConnected,
    broadcast: room.broadcast,
    sendToPeer: room.sendToPeer,
    onMessage: room.onMessage,
    onPeerConnected: (handler) => {
      room.peerConnectedHandlers.add(handler);
      return () => {
        room.peerConnectedHandlers.delete(handler);
      };
    },
    onPeerDisconnected: () => () => {},
  };
}
