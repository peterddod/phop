import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoom } from '..';
import { JSONSerializable } from '../context/Room';

type SharedStatePayload<TState extends JSONSerializable> = {
  key: string;
  state: TState | null;
};

/**
 * A hook that allows you to share state between multiple peers.
 *
 * The current version works hostlessly by:
 *
 * - Broadcasting the state to all peers in the room under the given key
 * - Each peer updates its state to the newest timestamped state, either from itself or from other peers
 *
 * This means that there may be unexpected updates and loss of state.
 *
 * @param key - A string key that namespaces this shared state slice. Multiple calls with the same key share state; different keys are independent.
 * @param initialState - The initial state of the shared state.
 * @returns A tuple containing the current state and a function to update the state.
 */
export function useSharedState<TState extends JSONSerializable>(
  key: string,
  initialState: TState | null
): [state: TState | null, setState: (next: TState | null) => void] {
  const [rawState, setRawState] = useState<TState | null>(initialState);
  const rawStateTimestamp = useRef<number>(0);

  const { broadcast, onMessage, peerId } = useRoom();

  useEffect(
    function handleMessage() {
      const unsubscribe = onMessage<SharedStatePayload<TState>>(({ senderId, data, timestamp }) => {
        if (senderId !== peerId && data.key === key && timestamp > rawStateTimestamp.current) {
          setRawState(data.state);
          rawStateTimestamp.current = timestamp;
        }
      });
      return unsubscribe;
    },
    [key, onMessage, peerId]
  );

  const setState = useCallback(
    (next: TState | null): void => {
      const timestamp = Date.now();
      rawStateTimestamp.current = timestamp;
      setRawState(next);
      broadcast<SharedStatePayload<TState>>({
        senderId: peerId,
        data: { key, state: next },
        timestamp,
      });
    },
    [broadcast, key, peerId]
  );

  return [rawState, setState];
}
