import {
  createLamportStrategy,
  createLastWriteWinsStrategy,
  type JSONSerializable,
  type MergeStrategy,
  useRoom,
  useSharedState,
} from '@peterddod/phop';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SerializedStrategy = 'lamport' | 'lastWriteWins';

interface SliceRegistration {
  key: string;
  strategy: SerializedStrategy;
}

interface PhopApi {
  peerId: string;
  peers: string[];
  isConnected: boolean;
  /** Number of peers with an open data channel (excludes self). */
  connectedPeerCount: number;
  broadcast: (data: JSONSerializable) => void;
  sendToPeer: (peerId: string, data: JSONSerializable) => void;
  onMessage: (
    handler: (msg: { senderId: string; data: JSONSerializable; timestamp: number }) => void
  ) => () => void;
  onPeerConnected: (handler: (remotePeerId: string) => void) => () => void;
  registerSharedState: (key: string, strategy?: SerializedStrategy) => Promise<void>;
  setSharedState: (key: string, value: JSONSerializable) => void;
  getSharedState: (key: string) => JSONSerializable | null;
  __msgQueue: Array<{ senderId: string; data: JSONSerializable; timestamp: number }>;
  __ack: (key: string) => void;
  __pendingAcks: Map<string, Array<() => void>>;
  __stateMap: Map<string, JSONSerializable | null>;
  __setters: Map<string, (value: JSONSerializable | null) => void>;
}

declare global {
  interface Window {
    __phop: PhopApi;
  }
}

function resolveStrategy(
  name: SerializedStrategy,
  getPeerId: () => string
): MergeStrategy<JSONSerializable, never> {
  if (name === 'lastWriteWins') {
    return createLastWriteWinsStrategy(getPeerId) as MergeStrategy<JSONSerializable, never>;
  }
  return createLamportStrategy(getPeerId) as MergeStrategy<JSONSerializable, never>;
}

interface SharedStateSliceProps {
  stateKey: string;
  strategy: SerializedStrategy;
  stateMapRef: React.RefObject<Map<string, JSONSerializable | null>>;
  settersRef: React.RefObject<Map<string, (value: JSONSerializable | null) => void>>;
  onAck: (key: string) => void;
}

function SharedStateSlice({
  stateKey,
  strategy,
  stateMapRef,
  settersRef,
  onAck,
}: SharedStateSliceProps) {
  const { peerId } = useRoom();
  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;

  const resolvedStrategy = useRef(resolveStrategy(strategy, () => peerIdRef.current)).current;

  const [value, setValue] = useSharedState(stateKey, null, resolvedStrategy);

  stateMapRef.current.set(stateKey, value);

  const setterRef = useRef((next: JSONSerializable | null) => setValue(next));
  setterRef.current = (next: JSONSerializable | null) => setValue(next);
  settersRef.current.set(stateKey, (next) => setterRef.current(next));

  useEffect(() => {
    onAck(stateKey);
  }, [stateKey, onAck]);

  return null;
}

interface ExposePhopApiInnerProps {
  registeredSlices: SliceRegistration[];
  onRegister: (key: string, strategy: SerializedStrategy) => void;
}

function ExposePhopApiInner({ registeredSlices, onRegister }: ExposePhopApiInnerProps) {
  const { peerId, peers, isConnected, broadcast, sendToPeer, onMessage, onPeerConnected } =
    useRoom();

  const stateMapRef = useRef<Map<string, JSONSerializable | null>>(new Map());
  const settersRef = useRef<Map<string, (value: JSONSerializable | null) => void>>(new Map());
  // Stable queue ref — never reset across re-renders so messages are never dropped.
  const msgQueueRef = useRef<
    Array<{ senderId: string; data: JSONSerializable; timestamp: number }>
  >([]);
  const pendingAcksRef = useRef<Map<string, Array<() => void>>>(new Map());
  // Tracks peers with an open data channel (incremented by onPeerConnected).
  const connectedPeerCountRef = useRef(0);

  const handleAck = useCallback((key: string) => {
    const callbacks = pendingAcksRef.current.get(key);
    if (callbacks) {
      for (const cb of callbacks) {
        cb();
      }
      pendingAcksRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    const api: PhopApi = {
      peerId,
      peers,
      isConnected,
      connectedPeerCount: connectedPeerCountRef.current,

      broadcast: (data) => {
        broadcast({ senderId: peerId, data, timestamp: Date.now() });
      },

      sendToPeer: (targetPeerId, data) => {
        sendToPeer(targetPeerId, { senderId: peerId, data, timestamp: Date.now() });
      },

      onMessage: (handler) => {
        return onMessage(({ senderId, data, timestamp }) => {
          handler({ senderId, data, timestamp });
        });
      },

      onPeerConnected: (handler) => {
        return onPeerConnected(handler);
      },

      registerSharedState: (key, strategy = 'lamport') => {
        return new Promise<void>((resolve) => {
          const existing = registeredSlices.find((s) => s.key === key);
          if (existing) {
            resolve();
            return;
          }
          const pending = pendingAcksRef.current.get(key) ?? [];
          pending.push(() => {
            // After the hook mounts, broadcast a state-request so any already-connected
            // peers push their current state (handles late-joiner registration).
            broadcast({
              senderId: peerId,
              data: { type: 'state-request', key },
              timestamp: Date.now(),
            });
            resolve();
          });
          pendingAcksRef.current.set(key, pending);
          onRegister(key, strategy);
        });
      },

      setSharedState: (key, value) => {
        const setter = settersRef.current.get(key);
        if (!setter) {
          throw new Error(
            `No shared state registered for key "${key}". Call registerSharedState first.`
          );
        }
        setter(value);
      },

      getSharedState: (key) => {
        return stateMapRef.current.get(key) ?? null;
      },

      __msgQueue: msgQueueRef.current,
      __ack: handleAck,
      __pendingAcks: pendingAcksRef.current,
      __stateMap: stateMapRef.current,
      __setters: settersRef.current,
    };

    window.__phop = api;

    const unsubscribeConnected = onPeerConnected(() => {
      connectedPeerCountRef.current += 1;
      if (window.__phop) {
        window.__phop.connectedPeerCount = connectedPeerCountRef.current;
      }
    });

    const unsubscribe = onMessage(({ senderId, data, timestamp }) => {
      msgQueueRef.current.push({ senderId, data, timestamp });
    });

    return () => {
      unsubscribe();
      unsubscribeConnected();
    };
  }, [
    peerId,
    peers,
    isConnected,
    broadcast,
    sendToPeer,
    onMessage,
    onPeerConnected,
    registeredSlices,
    onRegister,
    handleAck,
  ]);

  return (
    <>
      {registeredSlices.map(({ key, strategy }) => (
        <SharedStateSlice
          key={key}
          stateKey={key}
          strategy={strategy}
          stateMapRef={stateMapRef}
          settersRef={settersRef}
          onAck={handleAck}
        />
      ))}
    </>
  );
}

export function ExposePhopApi() {
  const [registeredSlices, setRegisteredSlices] = useState<SliceRegistration[]>([]);

  const handleRegister = (key: string, strategy: SerializedStrategy) => {
    setRegisteredSlices((prev) => {
      if (prev.find((s) => s.key === key)) return prev;
      return [...prev, { key, strategy }];
    });
  };

  return <ExposePhopApiInner registeredSlices={registeredSlices} onRegister={handleRegister} />;
}
