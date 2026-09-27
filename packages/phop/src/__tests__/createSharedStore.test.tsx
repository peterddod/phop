import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RoomContext, type RoomContextValue } from '../context/Room';
import { createSharedStore } from '../store';
import { createMockRoomContext, createStrictMockRoomContext } from './helpers/mockRoomContext';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSharedStore', () => {
  it('returns initial state from the initializer (no set usage — type inferred)', () => {
    const { wrapper } = createMockRoomContext();
    const useStore = createSharedStore('counter', () => ({ count: 0 }));

    const { result } = renderHook(() => useStore(), { wrapper });

    expect(result.current).toEqual({ count: 0 });
  });

  it('updates state via set(partial)', () => {
    const { wrapper } = createMockRoomContext();

    interface CounterState {
      count: number;
      increment: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });

  it('supports selectors for fine-grained subscriptions', () => {
    const { wrapper } = createMockRoomContext();

    interface State {
      count: number;
      name: string;
      increment: () => void;
    }

    const useStore = createSharedStore<State>('counter', (set) => ({
      count: 0,
      name: 'test',
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const { result } = renderHook(() => useStore((s) => s.count), { wrapper });

    expect(result.current).toBe(0);
  });

  it('get() returns current state inside set()', () => {
    const { wrapper } = createMockRoomContext();

    interface CounterState {
      count: number;
      doubleIncrement: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set, get) => ({
      count: 0,
      doubleIncrement: () => {
        set({ count: get().count + 1 });
        set({ count: get().count + 1 });
      },
    }));

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.doubleIncrement();
    });

    expect(result.current.count).toBe(2);
  });

  it('broadcasts on local set', () => {
    const { wrapper, value } = createMockRoomContext();

    interface CounterState {
      count: number;
      increment: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.increment();
    });

    expect(value.broadcast).toHaveBeenCalled();
  });

  it('works with explicit partialize option', () => {
    const { wrapper } = createMockRoomContext();

    type State = { count: number; increment: () => void };
    type Synced = { count: number };

    const useStore = createSharedStore<State, Synced>(
      'counter',
      (set) => ({
        count: 0,
        increment: () => set((s) => ({ count: s.count + 1 })),
      }),
      { partialize: (s) => ({ count: s.count }) }
    );

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
    expect(typeof result.current.increment).toBe('function');
  });

  it('auto-strips functions when no partialize is provided', () => {
    const { wrapper, value } = createMockRoomContext();

    interface CounterState {
      count: number;
      increment: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.increment();
    });

    // The broadcast payload should not contain the increment function.
    const broadcastCall = (value.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const syncedData = broadcastCall.data;
    expect(syncedData.state).toEqual({ count: 1 });
    expect(syncedData.state.increment).toBeUndefined();
  });

  it('works under StrictMode without duplicating local broadcasts', () => {
    const { wrapper, value } = createStrictMockRoomContext();

    interface CounterState {
      count: number;
      increment: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const { result } = renderHook(() => useStore(), { wrapper });

    act(() => {
      result.current.increment();
    });

    expect(value.broadcast).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(1);
  });

  it('uses latest peerId in Lamport metadata after initial empty peerId', () => {
    interface CounterState {
      count: number;
      increment: () => void;
    }

    const useStore = createSharedStore<CounterState>('counter', (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    const state = {
      current: {
        roomId: 'test-room',
        peerId: '',
        peers: ['peer-1'],
        isConnected: true,
        broadcast: vi.fn(),
        sendToPeer: vi.fn(),
        onMessage: vi.fn(() => () => {}),
        onPeerConnected: vi.fn(() => () => {}),
        __internalStoreRegistry: new Map(),
      } as RoomContextValue,
    };

    const wrapper: React.FC<PropsWithChildren> = ({ children }) => (
      <RoomContext.Provider value={state.current}>{children}</RoomContext.Provider>
    );

    const { result, rerender } = renderHook(() => useStore(), { wrapper });

    state.current = { ...state.current, peerId: 'peer-1' };
    rerender();

    act(() => {
      result.current.increment();
    });

    const broadcastCall = (state.current.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(broadcastCall.data.meta).toEqual(expect.objectContaining({ tiebreaker: 'peer-1' }));
  });

  it('selector subscriptions avoid unrelated re-renders', () => {
    const { wrapper } = createMockRoomContext();

    interface State {
      count: number;
      name: string;
      increment: () => void;
    }

    const useStore = createSharedStore<State>('counter', (set) => ({
      count: 0,
      name: 'alice',
      increment: () => set((s) => ({ count: s.count + 1 })),
    }));

    let countRenders = 0;
    let nameRenders = 0;

    const countHook = renderHook(
      () => {
        countRenders += 1;
        return useStore((s) => s.count);
      },
      { wrapper }
    );

    const nameHook = renderHook(
      () => {
        nameRenders += 1;
        return useStore((s) => s.name);
      },
      { wrapper }
    );

    const actionHook = renderHook(() => useStore((s) => s.increment), { wrapper });

    const initialNameRenders = nameRenders;

    act(() => {
      actionHook.result.current();
    });

    expect(countHook.result.current).toBe(1);
    expect(nameHook.result.current).toBe('alice');
    expect(countRenders).toBeGreaterThan(1);
    expect(nameRenders).toBe(initialNameRenders);
  });
});
