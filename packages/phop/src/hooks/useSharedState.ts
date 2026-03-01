import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createLamportStrategy,
  type LamportMeta,
  type MergeMeta,
  type MergeStrategy,
} from '../core/merge-strategies';
import type { StrategyContext } from '../core/merge-strategies/types';
import type { JSONSerializable } from '../types';
import { useRoom } from './useRoom';

type StateRequestPayload = {
  type: 'state-request';
  key: string;
};

type SharedStatePayload = {
  key: string;
  state: JSONSerializable | null;
  meta: MergeMeta;
};

function isStateRequest(data: unknown): data is StateRequestPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as StateRequestPayload).type === 'state-request'
  );
}

function isSharedStatePayload(data: unknown): data is SharedStatePayload {
  return (
    typeof data === 'object' && data !== null && 'key' in data && 'state' in data && 'meta' in data
  );
}

/**
 * A hook that allows you to share state between multiple peers.
 *
 * Works hostlessly by:
 *
 * - Broadcasting updates to all peers under the given key; everyone keeps the
 *   causally latest state according to a Lamport logical clock.
 * - Late joiners: when a data channel opens to a new peer, both sides push
 *   their current state to each other; the merge strategy keeps the winner.
 *
 * @param key - A string key that namespaces this shared state slice. Multiple calls with the same key share state; different keys are independent.
 * @param initialState - The initial state of the shared state (used only before any sync or update).
 * @returns A tuple containing the current state and a function to update the state.
 */
export function useSharedState<TState extends JSONSerializable>(
  key: string,
  initialState: TState | null
): [state: TState | null, setState: (next: TState | null) => void];

/**
 * A hook that allows you to share state between multiple peers with a custom merge strategy.
 *
 * @param key - A string key that namespaces this shared state slice.
 * @param initialState - The initial state (used only before any sync or update).
 * @param strategy - A merge strategy controlling how incoming state is reconciled.
 * @returns A tuple containing the current state and a function to update the state.
 */
export function useSharedState<TState extends JSONSerializable, TMeta extends MergeMeta>(
  key: string,
  initialState: TState | null,
  strategy: MergeStrategy<TState, TMeta>
): [state: TState | null, setState: (next: TState | null) => void];

export function useSharedState<
  TState extends JSONSerializable,
  TMeta extends MergeMeta = LamportMeta,
>(
  key: string,
  initialState: TState | null,
  strategy?: MergeStrategy<TState, TMeta>
): [state: TState | null, setState: (next: TState | null) => void] {
  const { broadcast, onMessage, onPeerConnected, peers, peerId, sendToPeer } = useRoom();

  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;

  const peersRef = useRef(peers);
  peersRef.current = peers;

  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;

  const sendToPeerRef = useRef(sendToPeer);
  sendToPeerRef.current = sendToPeer;

  const onPeerConnectedRef = useRef(onPeerConnected);
  onPeerConnectedRef.current = onPeerConnected;

  const lamportStrategyRef = useRef<MergeStrategy<JSONSerializable, LamportMeta>>(
    createLamportStrategy(() => peerIdRef.current)
  );

  const effectiveStrategy: MergeStrategy<TState, TMeta> =
    strategy !== undefined
      ? strategy
      : (lamportStrategyRef.current as unknown as MergeStrategy<TState, TMeta>);

  const [rawState, setRawState] = useState<TState | null>(initialState);
  const rawStateRef = useRef<TState | null>(initialState);
  const rawStateMetaRef = useRef<TMeta>(effectiveStrategy.initialMeta);

  rawStateRef.current = rawState;

  // Handlers registered by the strategy via ctx.onLocalWrite.
  const localWriteHandlersRef = useRef<Set<(state: TState | null) => void>>(new Set());

  // Handlers registered by the strategy via ctx.onMessage (pre-filtered by key).
  const messageHandlersRef = useRef<Set<(data: JSONSerializable, senderId: string) => void>>(
    new Set()
  );

  // Handlers registered by the strategy via ctx.onPeersChanged.
  const peersChangedHandlersRef = useRef<Set<(peers: string[]) => void>>(new Set());

  // Fire onPeersChanged handlers after render when the peers array reference changes.
  const prevPeersRef = useRef<string[]>(peers);
  useEffect(() => {
    if (prevPeersRef.current !== peers) {
      prevPeersRef.current = peers;
      for (const handler of peersChangedHandlersRef.current) {
        handler(peers);
      }
    }
  }, [peers]);

  useEffect(
    function connectStrategy() {
      const ctx: StrategyContext<TState, TMeta> = {
        // Expose a getter so strategies always read the current peer ID, even
        // if the signalling handshake completes after connect() runs.
        get peerId() {
          return peerIdRef.current;
        },

        getPeers: () => peersRef.current,
        getState: () => rawStateRef.current,
        getMeta: () => rawStateMetaRef.current,

        broadcast: (data) => {
          if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            throw new Error('ctx.broadcast: data must be a plain object');
          }
          broadcastRef.current({
            senderId: peerIdRef.current,
            // key is spread last so strategy payloads cannot overwrite the namespace.
            data: { ...(data as Record<string, JSONSerializable>), key },
            timestamp: Date.now(),
          });
        },

        sendToPeer: (targetPeerId, data) => {
          if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            throw new Error('ctx.sendToPeer: data must be a plain object');
          }
          sendToPeerRef.current(targetPeerId, {
            senderId: peerIdRef.current,
            // key is spread last so strategy payloads cannot overwrite the namespace.
            data: { ...(data as Record<string, JSONSerializable>), key },
            timestamp: Date.now(),
          });
        },

        onMessage: (handler) => {
          messageHandlersRef.current.add(handler);
          return () => {
            messageHandlersRef.current.delete(handler);
          };
        },

        onPeersChanged: (handler) => {
          peersChangedHandlersRef.current.add(handler);
          return () => peersChangedHandlersRef.current.delete(handler);
        },

        onPeerConnected: (handler) => {
          return onPeerConnectedRef.current(handler);
        },

        commit: (state, meta) => {
          rawStateRef.current = state;
          rawStateMetaRef.current = meta;
          setRawState(state);
        },

        onLocalWrite: (handler) => {
          localWriteHandlersRef.current.add(handler);
          return () => localWriteHandlersRef.current.delete(handler);
        },
      };

      const cleanup = effectiveStrategy.connect(ctx);
      return cleanup;
    },
    [key, effectiveStrategy]
  );

  useEffect(
    function handleMessage() {
      const unsubscribe = onMessage(({ senderId, data }) => {
        if (senderId === peerId) return;

        if (isStateRequest(data)) {
          if (data.key === key) {
            sendToPeer(senderId, {
              senderId: peerId,
              data: {
                key,
                state: rawStateRef.current,
                meta: rawStateMetaRef.current,
              } as JSONSerializable,
              timestamp: Date.now(),
            });
          }
          return;
        }

        if (!isSharedStatePayload(data) || data.key !== key) return;

        // Strip the key and forward { state, meta } to the strategy's handlers.
        const { state, meta } = data;
        for (const handler of messageHandlersRef.current) {
          handler({ state, meta } as JSONSerializable, senderId);
        }
      });

      return unsubscribe;
    },
    [key, onMessage, peerId, sendToPeer]
  );

  const setState = useCallback((next: TState | null): void => {
    for (const handler of localWriteHandlersRef.current) {
      handler(next);
    }
  }, []);

  return [rawState, setState];
}
