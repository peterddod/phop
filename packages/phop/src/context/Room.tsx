import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type PeerLink,
  type RoomTransport,
  type SignalingSession,
  webRtcTransport,
} from '../core/transport';
import {
  normalizeMetadata,
  type PeerInfo,
  type PeerMetadata,
  PROTOCOL_VERSION,
} from '../core/wire';
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
   * (e.g. "update to play with X"). Always set by `<Room>`; optional for
   * custom providers (`useRoom` fills it in).
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
   * Each peer's protocol version and metadata (see `<Room metadata>`), by
   * peer id: self, and every remote peer in the room whose hello has
   * arrived, incompatible ones included. Always set by `<Room>`; optional
   * for custom providers (`useRoom` fills it in).
   */
  peerInfo?: Record<string, PeerInfo>;
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
  /**
   * `broadcast` for a message already serialised as JSON (e.g. by a Web
   * Worker). Always set by `<Room>`; optional for custom providers.
   */
  broadcastText?: (text: string, options?: SendOptions) => void;
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
  /**
   * Small JSON object every peer in the room sees as `peerInfo[peerId].metadata`,
   * e.g. `{ buildId, name }`; at most `MAX_METADATA_LENGTH` characters as
   * JSON. Changes are sent to peers already connected (compared by value,
   * so a new object each render is fine). Invalid metadata is logged and
   * not published.
   */
  metadata?: PeerMetadata;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/** `metadata` as JSON text, to compare by value; '' for none or unserialisable. */
function metadataText(metadata: unknown): string {
  if (metadata === undefined) return '';
  try {
    return JSON.stringify(metadata) ?? '';
  } catch (error) {
    console.error('phop: metadata is not serialisable:', error);
    return '';
  }
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
  metadata,
}: RoomProps) {
  const [peerId, setPeerId] = useState<string>('');
  const [peers, setPeers] = useState<string[]>([]);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [incompatible, setIncompatible] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<Record<string, PeerInfo>>({});

  const ownMetadataText = metadataText(metadata);
  const ownMetadata = useMemo((): PeerMetadata | null => {
    if (!ownMetadataText) return null;
    try {
      return normalizeMetadata(JSON.parse(ownMetadataText));
    } catch (error) {
      console.error(error);
      return null;
    }
  }, [ownMetadataText]);
  const ownMetadataRef = useRef(ownMetadata);
  ownMetadataRef.current = ownMetadata;

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
        setRemoteInfo({});
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
          metadata: ownMetadataRef.current,
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
          onPeerInfo: (infoPeerId, info) => {
            if (connectionsRef.current.get(infoPeerId) !== connection) return;
            setRemoteInfo((all) => ({ ...all, [infoPeerId]: info }));
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
      setRemoteInfo((all) => {
        const gone = Object.keys(all).filter((id) => !peers.includes(id));
        if (gone.length === 0) return all;
        const kept = { ...all };
        for (const id of gone) delete kept[id];
        return kept;
      });
    },
    [peers, peerId, markConnected, markDisconnected]
  );

  useEffect(
    function publishMetadata() {
      // New links take it from the ref; tell the open ones.
      connectionsRef.current.forEach((connection, remotePeerId) => {
        try {
          connection.setMetadata?.(ownMetadata);
        } catch (error) {
          logSendFailure(remotePeerId, error);
        }
      });
    },
    [ownMetadata]
  );

  const broadcastText = useCallback((text: string, options?: SendOptions): void => {
    connectionsRef.current.forEach((connection, remotePeerId) => {
      try {
        connection.send(text, options);
      } catch (error) {
        logSendFailure(remotePeerId, error);
      }
    });
  }, []);

  const broadcast = useCallback(
    <TData extends JSONSerializable>(message: Message<TData>, options?: SendOptions): void => {
      if (connectionsRef.current.size === 0) return;
      broadcastText(JSON.stringify(message), options);
    },
    [broadcastText]
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

  const peerInfo = useMemo((): Record<string, PeerInfo> => {
    if (!peerId) return remoteInfo;
    return { ...remoteInfo, [peerId]: { protocol: PROTOCOL_VERSION, metadata: ownMetadata } };
  }, [remoteInfo, peerId, ownMetadata]);

  const contextValue: RoomContextValue = {
    roomId,
    peerId,
    peers: compatiblePeers,
    remotePeers,
    incompatiblePeers: incompatible,
    connectedPeers,
    peerInfo,
    isConnected,
    broadcast,
    broadcastText,
    sendToPeer,
    onMessage,
    onPeerConnected,
    onPeerDisconnected,
    __internalStoreRegistry: internalStoreRegistry,
  };

  return <RoomContext.Provider value={contextValue}>{children}</RoomContext.Provider>;
}
