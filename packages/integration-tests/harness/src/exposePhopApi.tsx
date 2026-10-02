import {
  createConsensusStrategy,
  createLamportStrategy,
  createLastWriteWinsStrategy,
  createSharedStore,
  type JSONSerializable,
  type MergeStrategy,
  type PeerInfo,
  useRoom,
  useSharedState,
} from '@peterddod/phop';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SerializedStrategy = 'lamport' | 'lastWriteWins' | 'consensus';
type SharedSetter = (
  value: JSONSerializable | null | ((prev: JSONSerializable | null) => JSONSerializable | null)
) => void;

interface SliceRegistration {
  key: string;
  strategy: SerializedStrategy;
}

interface LabelState {
  label: string;
  color: string;
  setLabel: (label: string) => void;
  cycleColor: () => void;
}

const LABEL_COLORS = ['#667eea', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];

const useLabelStore = createSharedStore<LabelState>('label', (set, get) => ({
  label: '',
  color: LABEL_COLORS[0],
  setLabel: (label: string) => set({ label }),
  cycleColor: () => {
    const idx = LABEL_COLORS.indexOf(get().color);
    set({ color: LABEL_COLORS[(idx + 1) % LABEL_COLORS.length] });
  },
}));

interface PhopApi {
  peerId: string;
  peers: string[];
  remotePeers: string[];
  connectedPeers: string[];
  /** Each peer's protocol version and metadata. */
  peerInfo: Record<string, PeerInfo>;
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
  incrementSharedState: (key: string, delta?: number) => void;
  getSharedState: (key: string) => JSONSerializable | null;
  enableLabelProbe: () => Promise<void>;
  setLabelText: (value: string) => void;
  typeLabelChar: (char: string) => void;
  getLabelText: () => string;
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
  if (name === 'consensus') {
    return createConsensusStrategy(getPeerId) as MergeStrategy<JSONSerializable, never>;
  }
  return createLamportStrategy(getPeerId) as MergeStrategy<JSONSerializable, never>;
}

interface SharedStateSliceProps {
  stateKey: string;
  strategy: SerializedStrategy;
  stateMapRef: React.RefObject<Map<string, JSONSerializable | null>>;
  settersRef: React.RefObject<Map<string, SharedSetter>>;
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

  const setterRef = useRef<SharedSetter>((next) => setValue(next));
  setterRef.current = (next) => setValue(next);
  settersRef.current.set(stateKey, (next) => setterRef.current(next));

  useEffect(() => {
    onAck(stateKey);
  }, [stateKey, onAck]);

  return null;
}

interface ExposePhopApiInnerProps {
  registeredSlices: SliceRegistration[];
  onRegister: (key: string, strategy: SerializedStrategy) => void;
  labelProbeEnabled: boolean;
  onEnableLabelProbe: () => void;
}

interface LabelProbeProps {
  stateRef: React.RefObject<{ label: string; color: string }>;
  actionsRef: React.RefObject<{ setLabel: (value: string) => void; cycleColor: () => void } | null>;
  onReady: () => void;
}

function LabelProbe({ stateRef, actionsRef, onReady }: LabelProbeProps) {
  // Intentionally mirrors the example usage: multiple selector subscriptions.
  const label = useLabelStore((s) => s.label);
  const color = useLabelStore((s) => s.color);
  const setLabel = useLabelStore((s) => s.setLabel);
  const cycleColor = useLabelStore((s) => s.cycleColor);

  stateRef.current = { label, color };
  actionsRef.current = { setLabel, cycleColor };

  useEffect(() => {
    onReady();
  }, [onReady]);

  return null;
}

function ExposePhopApiInner({
  registeredSlices,
  onRegister,
  labelProbeEnabled,
  onEnableLabelProbe,
}: ExposePhopApiInnerProps) {
  const {
    peerId,
    peers,
    remotePeers,
    connectedPeers,
    peerInfo,
    isConnected,
    broadcast,
    sendToPeer,
    onMessage,
    onPeerConnected,
  } = useRoom();

  const stateMapRef = useRef<Map<string, JSONSerializable | null>>(new Map());
  const settersRef = useRef<Map<string, SharedSetter>>(new Map());
  // Stable queue ref — never reset across re-renders so messages are never dropped.
  const msgQueueRef = useRef<
    Array<{ senderId: string; data: JSONSerializable; timestamp: number }>
  >([]);
  const pendingAcksRef = useRef<Map<string, Array<() => void>>>(new Map());
  const labelProbeStateRef = useRef<{ label: string; color: string }>({ label: '', color: '' });
  const labelProbeActionsRef = useRef<{
    setLabel: (value: string) => void;
    cycleColor: () => void;
  } | null>(null);
  const labelProbeReadyRef = useRef(false);
  const pendingLabelProbeAcksRef = useRef<Array<() => void>>([]);
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

  const handleLabelProbeReady = useCallback(() => {
    labelProbeReadyRef.current = true;
    const callbacks = pendingLabelProbeAcksRef.current;
    pendingLabelProbeAcksRef.current = [];
    for (const cb of callbacks) {
      cb();
    }
  }, []);

  useEffect(() => {
    const api: PhopApi = {
      peerId,
      peers,
      remotePeers,
      connectedPeers,
      peerInfo,
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

      incrementSharedState: (key, delta = 1) => {
        const setter = settersRef.current.get(key);
        if (!setter) {
          throw new Error(
            `No shared state registered for key "${key}". Call registerSharedState first.`
          );
        }
        setter((prev) => (((prev as number | null) ?? 0) + delta) as JSONSerializable);
      },

      getSharedState: (key) => {
        return stateMapRef.current.get(key) ?? null;
      },

      enableLabelProbe: () => {
        return new Promise<void>((resolve) => {
          if (labelProbeReadyRef.current) {
            resolve();
            return;
          }
          pendingLabelProbeAcksRef.current.push(resolve);
          onEnableLabelProbe();
        });
      },

      setLabelText: (value) => {
        const actions = labelProbeActionsRef.current;
        if (!actions) {
          throw new Error('Label probe is not ready. Call enableLabelProbe first.');
        }
        actions.setLabel(value);
      },

      typeLabelChar: (char) => {
        if (char.length !== 1) {
          throw new Error(`typeLabelChar expects a single character, received "${char}".`);
        }
        const actions = labelProbeActionsRef.current;
        if (!actions) {
          throw new Error('Label probe is not ready. Call enableLabelProbe first.');
        }
        const next = `${labelProbeStateRef.current.label}${char}`;
        actions.setLabel(next);
      },

      getLabelText: () => {
        return labelProbeStateRef.current.label;
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
    remotePeers,
    connectedPeers,
    peerInfo,
    isConnected,
    broadcast,
    sendToPeer,
    onMessage,
    onPeerConnected,
    registeredSlices,
    onRegister,
    handleAck,
    onEnableLabelProbe,
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
      {labelProbeEnabled && (
        <LabelProbe
          stateRef={labelProbeStateRef}
          actionsRef={labelProbeActionsRef}
          onReady={handleLabelProbeReady}
        />
      )}
    </>
  );
}

export function ExposePhopApi() {
  const [registeredSlices, setRegisteredSlices] = useState<SliceRegistration[]>([]);
  const [labelProbeEnabled, setLabelProbeEnabled] = useState(false);

  const handleRegister = (key: string, strategy: SerializedStrategy) => {
    setRegisteredSlices((prev) => {
      if (prev.find((s) => s.key === key)) return prev;
      return [...prev, { key, strategy }];
    });
  };

  const handleEnableLabelProbe = () => {
    setLabelProbeEnabled(true);
  };

  return (
    <ExposePhopApiInner
      registeredSlices={registeredSlices}
      onRegister={handleRegister}
      labelProbeEnabled={labelProbeEnabled}
      onEnableLabelProbe={handleEnableLabelProbe}
    />
  );
}
