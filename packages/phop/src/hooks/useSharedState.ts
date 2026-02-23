import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createLamportStrategy,
  type LamportMeta,
  type MergeMeta,
  type MergeStrategy,
} from '../core/merge-strategies';
import type { JSONSerializable } from '../types';
import { useRoom } from './useRoom';

type SharedStatePayload<TState extends JSONSerializable, TMeta extends MergeMeta = MergeMeta> = {
  key: string;
  state: TState | null;
  meta: TMeta;
};

type StateRequestPayload = {
  type: 'state-request';
  key: string;
};

function isStateRequest(
  data: SharedStatePayload<JSONSerializable> | StateRequestPayload
): data is StateRequestPayload {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === 'state-request'
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
  const { broadcast, onMessage, onPeerConnected, peerId, sendToPeer } = useRoom();

  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;

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

  const strategyRef = useRef(effectiveStrategy);

  rawStateRef.current = rawState;

  useEffect(() => {
    strategyRef.current = effectiveStrategy;
  }, [effectiveStrategy]);

  useEffect(
    function handleMessage() {
      const unsubscribe = onMessage<SharedStatePayload<TState, TMeta> | StateRequestPayload>(
        ({ senderId, data }) => {
          if (senderId === peerId) return;

          if (isStateRequest(data)) {
            if (data.key === key) {
              sendToPeer(senderId, {
                senderId: peerId,
                data: { key, state: rawStateRef.current, meta: rawStateMetaRef.current },
                timestamp: Date.now(),
              });
            }
            return;
          }

          if (data.key !== key) return;

          const result = strategyRef.current.merge(
            rawStateRef.current,
            rawStateMetaRef.current,
            data.state,
            data.meta,
            senderId
          );
          if (result) {
            rawStateRef.current = result.state;
            rawStateMetaRef.current = result.meta;
            setRawState(result.state);
          }
        }
      );
      return unsubscribe;
    },
    [key, onMessage, peerId, sendToPeer]
  );

  useEffect(
    function pushStateOnConnect() {
      const unsubscribe = onPeerConnected((remotePeerId) => {
        sendToPeer(remotePeerId, {
          senderId: peerId,
          data: { key, state: rawStateRef.current, meta: rawStateMetaRef.current },
          timestamp: Date.now(),
        });
      });
      return unsubscribe;
    },
    [key, onPeerConnected, peerId, sendToPeer]
  );

  const setState = useCallback(
    (next: TState | null): void => {
      const meta = strategyRef.current.createMeta();
      rawStateRef.current = next;
      rawStateMetaRef.current = meta;
      setRawState(next);
      broadcast<SharedStatePayload<TState, TMeta>>({
        senderId: peerId,
        data: { key, state: next, meta },
        timestamp: Date.now(),
      });
    },
    [broadcast, key, peerId]
  );

  return [rawState, setState];
}
