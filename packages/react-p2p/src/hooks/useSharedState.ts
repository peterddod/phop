import { useState } from 'react';

/**
 * A hook that allows you to share state between multiple peers.
 * 
 * The current version works hostlessly by:
 * 
 * - Broadcasting the state to all peers in the room
 * - Each state updates it state to the newest timestamped state, either from itself or from the peers
 * 
 * This means that there may be unexpected updates and loss of state.
 * 
 * @param initialState - The initial state of the shared state.
 * @returns A tuple containing the current state and a function to update the state.
 */
export function useSharedState<TState>(
  initialState: TState
): [TState, (next: TState | ((prev: TState) => TState)) => void] {
  const [state, setState] = useState<TState>(initialState);
  return [state, setState];
}
