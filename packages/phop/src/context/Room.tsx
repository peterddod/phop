import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PeerConnection } from '../core/PeerConnection';
import { SignalingClient } from '../core/SignalingClient';
import type { JSONSerializable, Message, MessageHandler } from '../types';

export interface RoomContextValue {
  roomId: string;
  peerId: string;
  /** Deduplicated signalling membership of the room, including self. */
  peers: string[];
  /** `peers` without self. */
  remotePeers: string[];
  /** Remote peers whose data channel is currently open. */
  connectedPeers: string[];
  /** Whether the signalling server connection is up. */
  isConnected: boolean;
  broadcast: <TData extends JSONSerializable = JSONSerializable>(message: Message<TData>) => void;
  sendToPeer: <TData extends JSONSerializable = JSONSerializable>(
    peerId: string,
    message: Message<TData>
  ) => void;
  onMessage: <TData extends JSONSerializable = JSONSerializable>(
    handler: MessageHandler<TData>
  ) => () => void;
  onPeerConnected: (handler: (remotePeerId: string) => void) => () => void;
  /** Fires when an open data channel to a peer closes or the peer leaves. */
  onPeerDisconnected: (handler: (remotePeerId: string) => void) => () => void;
  /**
   * Internal registry used by createSharedStore so every hook call in a Room
   * shares one store instance per key.
   */
  __internalStoreRegistry?: Map<string, unknown>;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

interface RoomProps extends React.PropsWithChildren {
  signallingServerUrl: string;
  roomId: string;
  /** WebRTC configuration, e.g. to add TURN servers. Defaults to Google STUN. */
  rtcConfig?: RTCConfiguration;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export function Room({ children, signallingServerUrl, roomId, rtcConfig }: RoomProps) {
  const [peerId, setPeerId] = useState<string>('');
  const [peers, setPeers] = useState<string[]>([]);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const signalingClientRef = useRef<SignalingClient | null>(null);
  const connectionsRef = useRef<Map<string, PeerConnection>>(new Map());
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const peerConnectedHandlersRef = useRef<Set<(remotePeerId: string) => void>>(new Set());
  const peerDisconnectedHandlersRef = useRef<Set<(remotePeerId: string) => void>>(new Set());
  const connectedRef = useRef<Set<string>>(new Set());
  const rtcConfigRef = useRef(rtcConfig);
  rtcConfigRef.current = rtcConfig;
  const internalStoreRegistriesRef = useRef<Map<string, Map<string, unknown>>>(new Map());
  let internalStoreRegistry = internalStoreRegistriesRef.current.get(roomId);
  if (!internalStoreRegistry) {
    internalStoreRegistry = new Map<string, unknown>();
    internalStoreRegistriesRef.current.set(roomId, internalStoreRegistry);
  }

  const markConnected = useCallback((remotePeerId: string) => {
    if (connectedRef.current.has(remotePeerId)) return;
    connectedRef.current.add(remotePeerId);
    setConnectedPeers(Array.from(connectedRef.current));
    peerConnectedHandlersRef.current.forEach((h) => void h(remotePeerId));
  }, []);

  const markDisconnected = useCallback((remotePeerId: string) => {
    if (!connectedRef.current.delete(remotePeerId)) return;
    setConnectedPeers(Array.from(connectedRef.current));
    peerDisconnectedHandlersRef.current.forEach((h) => void h(remotePeerId));
  }, []);

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
          setPeers(dedupe(event.peers));
        }
      });

      client.on('peer-list', (event) => {
        if (event.peers) {
          setPeers(dedupe(event.peers));
        }
      });

      client.on('peer-joined', (event) => {
        if (event.peers) {
          setPeers(dedupe(event.peers));
        }
      });

      client.on('peer-left', (event) => {
        if (event.peerId) {
          const connection = connectionsRef.current.get(event.peerId);
          if (connection) {
            connection.close();
            connectionsRef.current.delete(event.peerId);
          }
          markDisconnected(event.peerId);
        }
        if (event.peers) {
          setPeers(dedupe(event.peers));
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
        connectedRef.current.forEach((id) => {
          markDisconnected(id);
        });
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
        connectedRef.current.clear();
        setConnectedPeers([]);
        client.disconnect();
      };
    },
    [signallingServerUrl, roomId, markDisconnected]
  );

  useEffect(
    function createPeerConnections() {
      if (!peerId || !signalingClientRef.current) return;

      const signalingClient = signalingClientRef.current;

      peers.forEach((remotePeerId) => {
        if (remotePeerId === peerId) return;

        if (connectionsRef.current.has(remotePeerId)) return;

        const connection = new PeerConnection({
          localPeerId: peerId,
          remotePeerId,
          signalingClient,
          rtcConfig: rtcConfigRef.current,
          onChannelMessage: (fromPeerId, raw) => {
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
          },
          onChannelOpen: (connectedRemotePeerId) => {
            if (connectionsRef.current.get(connectedRemotePeerId) !== connection) return;
            markConnected(connectedRemotePeerId);
          },
          onChannelClose: (closedRemotePeerId) => {
            if (connectionsRef.current.get(closedRemotePeerId) !== connection) return;
            markDisconnected(closedRemotePeerId);
          },
        });

        connectionsRef.current.set(remotePeerId, connection);
      });

      connectionsRef.current.forEach((connection, remotePeerId) => {
        if (!peers.includes(remotePeerId)) {
          connection.close();
          connectionsRef.current.delete(remotePeerId);
          markDisconnected(remotePeerId);
        }
      });
    },
    [peers, peerId, markConnected, markDisconnected]
  );

  const broadcast = useCallback(<TData extends JSONSerializable>(message: Message<TData>): void => {
    connectionsRef.current.forEach((connection) => {
      connection.send(message);
    });
  }, []);

  const sendToPeer = useCallback(
    <TData extends JSONSerializable>(targetPeerId: string, message: Message<TData>): void => {
      const connection = connectionsRef.current.get(targetPeerId);
      connection?.send(message);
    },
    []
  );

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

  const onPeerConnected = useCallback((handler: (remotePeerId: string) => void): (() => void) => {
    peerConnectedHandlersRef.current.add(handler);
    return () => {
      peerConnectedHandlersRef.current.delete(handler);
    };
  }, []);

  const onPeerDisconnected = useCallback(
    (handler: (remotePeerId: string) => void): (() => void) => {
      peerDisconnectedHandlersRef.current.add(handler);
      return () => {
        peerDisconnectedHandlersRef.current.delete(handler);
      };
    },
    []
  );

  const remotePeers = useMemo(() => peers.filter((p) => p !== peerId), [peers, peerId]);

  const contextValue: RoomContextValue = {
    roomId,
    peerId,
    peers,
    remotePeers,
    connectedPeers,
    isConnected,
    broadcast,
    sendToPeer,
    onMessage,
    onPeerConnected,
    onPeerDisconnected,
    __internalStoreRegistry: internalStoreRegistry,
  };

  return <RoomContext.Provider value={contextValue}>{children}</RoomContext.Provider>;
}
