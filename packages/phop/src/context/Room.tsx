import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type PeerLink,
  type RoomTransport,
  type SignalingSession,
  webRtcTransport,
} from '../core/transport';
import type { JSONSerializable, Message, MessageHandler, SendOptions } from '../types';

export interface RoomContextValue {
  roomId: string;
  peerId: string;
  /**
   * Deduplicated signalling membership of the room, including self, without
   * `incompatiblePeers`.
   */
  peers: string[];
  /**
   * Peers in the room that speak another wire protocol version
   * (`PROTOCOL_VERSION`), e.g. a different phop release. They are left out
   * of `peers` and nothing is exchanged with them; show them to the user
   * (e.g. "update to play with X"). Optional for custom providers.
   */
  incompatiblePeers?: string[];
  /**
   * `peers` without self. Always set by `<Room>`; optional so custom
   * providers written against 1.x still type-check (`useRoom` fills it in).
   */
  remotePeers?: string[];
  /** Remote peers whose data channel is currently open. See `remotePeers`. */
  connectedPeers?: string[];
  /**
   * Whether the signalling server connection is up. Once it drops the room
   * does not reconnect: `peers` shrinks to self and every channel closes.
   * Remount `<Room>` (e.g. change its React `key`) to join again.
   */
  isConnected: boolean;
  /**
   * Send to every connected peer. The message is serialised once; a peer
   * whose send fails is skipped without affecting the others.
   */
  broadcast: <TData extends JSONSerializable = JSONSerializable>(
    message: Message<TData>,
    options?: SendOptions
  ) => void;
  sendToPeer: <TData extends JSONSerializable = JSONSerializable>(
    peerId: string,
    message: Message<TData>,
    options?: SendOptions
  ) => void;
  onMessage: <TData extends JSONSerializable = JSONSerializable>(
    handler: MessageHandler<TData>
  ) => () => void;
  onPeerConnected: (handler: (remotePeerId: string) => void) => () => void;
  /** Fires when an open data channel to a peer closes or the peer leaves. See `remotePeers`. */
  onPeerDisconnected?: (handler: (remotePeerId: string) => void) => () => void;
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
  /**
   * Bytes queued on a peer's data channel above which coalescable messages
   * (see `SendOptions.coalesce`, e.g. hosted-simulation snapshots) are held
   * back, keeping only the newest. Default 256 KiB.
   */
  maxBufferedAmount?: number;
  /**
   * How peers connect. Defaults to WebRTC with a WebSocket signalling server;
   * pass `createMemoryNetwork().transport` to run peers in one process.
   * Read once per `signallingServerUrl`/`roomId`.
   */
  transport?: RoomTransport;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function logSendFailure(peerId: string, error: unknown) {
  console.error(`phop: send to ${peerId} failed:`, error);
}

export function Room({
  children,
  signallingServerUrl,
  roomId,
  rtcConfig,
  maxBufferedAmount,
  transport = webRtcTransport,
}: RoomProps) {
  const [peerId, setPeerId] = useState<string>('');
  const [peers, setPeers] = useState<string[]>([]);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [incompatible, setIncompatible] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const signalingClientRef = useRef<SignalingSession | null>(null);
  const connectionsRef = useRef<Map<string, PeerLink>>(new Map());
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const peerConnectedHandlersRef = useRef<Set<(remotePeerId: string) => void>>(new Set());
  const peerDisconnectedHandlersRef = useRef<Set<(remotePeerId: string) => void>>(new Set());
  const connectedRef = useRef<Set<string>>(new Set());
  const rtcConfigRef = useRef(rtcConfig);
  rtcConfigRef.current = rtcConfig;
  const maxBufferedAmountRef = useRef(maxBufferedAmount);
  maxBufferedAmountRef.current = maxBufferedAmount;
  const transportRef = useRef(transport);
  transportRef.current = transport;
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
      const client = transportRef.current.createSignaling(signallingServerUrl, roomId);
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
        // Membership is unknown without signalling; don't report stale peers.
        const self = client.getPeerId();
        setPeers(self ? [self] : []);
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
        setIncompatible([]);
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

        const connection = transportRef.current.createPeer({
          localPeerId: peerId,
          remotePeerId,
          signalingClient,
          rtcConfig: rtcConfigRef.current,
          maxBufferedAmount: maxBufferedAmountRef.current,
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
          onIncompatible: (foreignPeerId) => {
            if (connectionsRef.current.get(foreignPeerId) !== connection) return;
            setIncompatible((ids) => (ids.includes(foreignPeerId) ? ids : [...ids, foreignPeerId]));
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
      setIncompatible((ids) => {
        const present = ids.filter((id) => peers.includes(id));
        return present.length === ids.length ? ids : present;
      });
    },
    [peers, peerId, markConnected, markDisconnected]
  );

  const broadcast = useCallback(
    <TData extends JSONSerializable>(message: Message<TData>, options?: SendOptions): void => {
      if (connectionsRef.current.size === 0) return;
      const text = JSON.stringify(message);
      connectionsRef.current.forEach((connection, remotePeerId) => {
        try {
          connection.send(text, options);
        } catch (error) {
          logSendFailure(remotePeerId, error);
        }
      });
    },
    []
  );

  const sendToPeer = useCallback(
    <TData extends JSONSerializable>(
      targetPeerId: string,
      message: Message<TData>,
      options?: SendOptions
    ): void => {
      const connection = connectionsRef.current.get(targetPeerId);
      if (!connection) return;
      const text = JSON.stringify(message);
      try {
        connection.send(text, options);
      } catch (error) {
        logSendFailure(targetPeerId, error);
      }
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

  const compatiblePeers = useMemo(
    () => (incompatible.length === 0 ? peers : peers.filter((p) => !incompatible.includes(p))),
    [peers, incompatible]
  );
  const remotePeers = useMemo(
    () => compatiblePeers.filter((p) => p !== peerId),
    [compatiblePeers, peerId]
  );

  const contextValue: RoomContextValue = {
    roomId,
    peerId,
    peers: compatiblePeers,
    remotePeers,
    incompatiblePeers: incompatible,
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
