import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoom } from '..';
import type { JSONSerializable } from '../context/Room';

export type MergeMeta = Record<string, JSONSerializable>;

export interface MergeStrategy<
  TState extends JSONSerializable = JSONSerializable,
  TMeta extends MergeMeta = MergeMeta,
> {
  /** Initial metadata before any sync or update. */
  initialMeta: TMeta;

  /** Produce meta when this peer sets state (e.g. timestamp, version). */
  createMeta(): TMeta;

  /**
   * Decide how to merge incoming state with current.
   * Return new { state, meta } to apply, or null to keep current.
   */
  merge(
    currentState: TState | null,
    currentMeta: TMeta,
    incomingState: TState | null,
    incomingMeta: TMeta,
    senderId: string
  ): { state: TState | null; meta: TMeta } | null;
}

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

type NewestWinsMeta = { timestamp: number };

const newestWinsStrategy: MergeStrategy<JSONSerializable, NewestWinsMeta> = {
  initialMeta: { timestamp: 0 },
  createMeta(): NewestWinsMeta {
    return { timestamp: Date.now() };
  },
  merge(
    _currentState,
    currentMeta,
    incomingState,
    incomingMeta
  ): { state: JSONSerializable | null; meta: NewestWinsMeta } | null {
    return incomingMeta.timestamp > currentMeta.timestamp
      ? { state: incomingState, meta: incomingMeta }
      : null;
  },
};

/**
 * A hook that allows you to share state between multiple peers.
 *
 * Works hostlessly by:
 *
 * - Broadcasting updates to all peers under the given key; everyone keeps the latest timestamped state.
 * - Late joiners: when a data channel opens to a new peer, both sides push their current state to
 *   each other; the merge strategy (newest-wins by default) keeps the most recent value.
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
  TMeta extends MergeMeta = NewestWinsMeta,
>(
  key: string,
  initialState: TState | null,
  strategy: MergeStrategy<TState, TMeta> = newestWinsStrategy as unknown as MergeStrategy<
    TState,
    TMeta
  >
): [state: TState | null, setState: (next: TState | null) => void] {
  const [rawState, setRawState] = useState<TState | null>(initialState);
  const rawStateRef = useRef<TState | null>(initialState);
  const rawStateMetaRef = useRef<TMeta>(strategy.initialMeta);

  const strategyRef = useRef(strategy);

  const { broadcast, onMessage, onPeerConnected, peerId, sendToPeer } = useRoom();

  rawStateRef.current = rawState;

  useEffect(() => {
    strategyRef.current = strategy;
  }, [strategy]);

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
