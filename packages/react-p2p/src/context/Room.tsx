import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { PeerConnection } from '../core/PeerConnection';
import { SignalingClient } from '../core/SignalingClient';

export type JSONSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | JSONSerializable[]
  | { [key: string]: JSONSerializable };

export type MessageHandler<TData extends JSONSerializable = JSONSerializable> = (
  message: Message<TData>
) => void;

export type Message<TData extends JSONSerializable = JSONSerializable> = {
  /** The peer ID of the sender */
  senderId: string;
  /** The data of the message */
  data: TData;
  /** The timestamp of when the message was sent */
  timestamp: number;
};

export interface RoomContextValue {
  roomId: string;
  peerId: string;
  peers: string[];
  isConnected: boolean;
  broadcast: <TData extends JSONSerializable = JSONSerializable>(message: Message<TData>) => void;
  sendToPeer: <TData extends JSONSerializable = JSONSerializable>(
    peerId: string,
    message: Message<TData>
  ) => void;
  onMessage: <TData extends JSONSerializable = JSONSerializable>(
    handler: MessageHandler<TData>
  ) => () => void;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

interface RoomProps extends React.PropsWithChildren {
  signallingServerUrl: string;
  roomId: string;
}

export function Room({ children, signallingServerUrl, roomId }: RoomProps) {
  const [peerId, setPeerId] = useState<string>('');
  const [peers, setPeers] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const signalingClientRef = useRef<SignalingClient | null>(null);
  const connectionsRef = useRef<Map<string, PeerConnection>>(new Map());
  const handlersRef = useRef<Set<MessageHandler>>(new Set());

  useEffect(
    function initializeSignalingClient() {
      const client = new SignalingClient(signallingServerUrl, roomId);
      signalingClientRef.current = client;

      client.on('joined', (event) => {
        if (event.peerId) {
          setPeerId(event.peerId);
          setIsConnected(true);
        }
        if (event.peers) {
          setPeers(event.peers);
        }
      });

      client.on('peer-list', (event) => {
        if (event.peers) {
          setPeers(event.peers);
        }
      });

      client.on('peer-joined', (event) => {
        if (event.peers) {
          setPeers(event.peers);
        }
      });

      client.on('peer-left', (event) => {
        if (event.peerId) {
          const connection = connectionsRef.current.get(event.peerId);
          if (connection) {
            connection.close();
            connectionsRef.current.delete(event.peerId);
          }
        }
        if (event.peers) {
          setPeers(event.peers);
        }
      });

      client.on('signal', (event) => {
        if (event.from && event.data) {
          const connection = connectionsRef.current.get(event.from);
          connection?.handleSignal(event.data);
        }
      });

      client.on('disconnected', () => {
        setIsConnected(false);
        connectionsRef.current.forEach((conn) => {
          conn.close();
        });
        connectionsRef.current.clear();
      });

      client.connect().catch((error) => {
        console.error('Failed to connect to signaling server:', error);
        setIsConnected(false);
      });

      return () => {
        connectionsRef.current.forEach((conn) => {
          conn.close();
        });
        connectionsRef.current.clear();
        client.disconnect();
      };
    },
    [signallingServerUrl, roomId]
  );

  useEffect(
    function createPeerConnections() {
      if (!peerId || !signalingClientRef.current) return;

      const signalingClient = signalingClientRef.current;

      peers.forEach((remotePeerId) => {
        if (remotePeerId === peerId) return;

        if (connectionsRef.current.has(remotePeerId)) return;

        const connection = new PeerConnection(
          peerId,
          remotePeerId,
          signalingClient,
          (fromPeerId, raw) => {
            const message: Message<JSONSerializable> = {
              senderId: fromPeerId,
              data:
                raw && typeof raw === 'object' && 'data' in raw && raw.data !== undefined
                  ? (raw.data as JSONSerializable)
                  : (raw as JSONSerializable),
              timestamp:
                raw &&
                typeof raw === 'object' &&
                'timestamp' in raw &&
                typeof (raw as { timestamp?: number }).timestamp === 'number'
                  ? (raw as { timestamp: number }).timestamp
                  : Date.now(),
            };
            handlersRef.current.forEach((h) => void h(message));
          }
        );

        connectionsRef.current.set(remotePeerId, connection);
      });

      connectionsRef.current.forEach((connection, remotePeerId) => {
        if (!peers.includes(remotePeerId)) {
          connection.close();
          connectionsRef.current.delete(remotePeerId);
        }
      });
    },
    [peers, peerId]
  );

  const broadcast = (message: Record<string, unknown>) => {
    connectionsRef.current.forEach((connection) => {
      connection.send(message);
    });
  };

  const sendToPeer = (targetPeerId: string, message: Record<string, unknown>) => {
    const connection = connectionsRef.current.get(targetPeerId);
    connection?.send(message);
  };

  const onMessage = useCallback(
    <TData extends JSONSerializable = JSONSerializable>(
      handler: MessageHandler<TData>
    ): (() => void) => {
      handlersRef.current.add(handler as MessageHandler);
      return () => {
        handlersRef.current.delete(handler as MessageHandler);
      };
    },
    []
  );

  const contextValue: RoomContextValue = {
    roomId,
    peerId,
    peers,
    isConnected,
    broadcast,
    sendToPeer,
    onMessage,
  };

  return <RoomContext.Provider value={contextValue}>{children}</RoomContext.Provider>;
}
