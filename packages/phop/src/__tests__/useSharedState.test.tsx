import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RoomContext, type RoomContextValue } from '../context/Room';
import type { MergeStrategy } from '../core/merge-strategies';
import { useSharedState } from '../hooks/useSharedState';
import { createMockRoomContext, createStrictMockRoomContext } from './helpers/mockRoomContext';

describe('useSharedState', () => {
  it('supports functional updater form like useState', () => {
    const { value, wrapper } = createMockRoomContext();
    const { result } = renderHook(() => useSharedState<number>('counter', 0), { wrapper });

    act(() => {
      result.current[1]((prev) => (prev ?? 0) + 1);
    });

    expect(result.current[0]).toBe(1);
    const broadcastCall = (value.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(broadcastCall.data.state).toBe(1);
    expect(typeof broadcastCall.data.state).toBe('number');
  });

  it('works under StrictMode without duplicating local broadcasts', () => {
    const { value, wrapper } = createStrictMockRoomContext();

    const { result } = renderHook(() => useSharedState<number>('counter', 0), { wrapper });

    act(() => {
      result.current[1](1);
    });

    expect(value.broadcast).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe(1);
  });

  it('uses latest peerId in Lamport metadata after initial empty peerId', () => {
    const { value, wrapper: BaseWrapper } = createMockRoomContext('', ['peer-1']);

    const { result, rerender } = renderHook(() => useSharedState<number>('counter', 0), {
      wrapper: BaseWrapper,
    });

    value.peerId = 'peer-1';
    rerender();

    act(() => {
      result.current[1](1);
    });

    const broadcastCall = (value.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(broadcastCall.data.meta).toEqual(expect.objectContaining({ tiebreaker: 'peer-1' }));
  });

  it('syncs peers in StrictMode without duplicate peer-change side effects', () => {
    const broadcast = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const strategy: MergeStrategy<number, { seen: number }> = {
      initialMeta: { seen: 0 },
      connect(ctx) {
        const unsubLocal = ctx.onLocalWrite((state) => {
          ctx.commit(state, { seen: 0 });
        });
        const unsubPeers = ctx.onPeersChanged((peers) => {
          ctx.broadcast({ type: 'peers-changed', count: peers.length });
        });
        return () => {
          unsubLocal();
          unsubPeers();
        };
      },
    };

    const state = {
      current: {
        roomId: 'test-room',
        peerId: 'peer-1',
        peers: ['peer-1'],
        isConnected: true,
        broadcast,
        sendToPeer: vi.fn(),
        onMessage: vi.fn(() => () => {}),
        onPeerConnected: vi.fn(() => () => {}),
      } as RoomContextValue,
    };

    const wrapper: React.FC<PropsWithChildren> = ({ children }) => (
      <StrictMode>
        <RoomContext.Provider value={state.current}>{children}</RoomContext.Provider>
      </StrictMode>
    );

    try {
      const { rerender } = renderHook(
        () => useSharedState<number, { seen: number }>('counter', 0, strategy),
        {
          wrapper,
        }
      );

      state.current = { ...state.current, peers: ['peer-1', 'peer-2'] };
      rerender();

      const peerChangedCalls = broadcast.mock.calls.filter(
        (c) =>
          c[0]?.data &&
          typeof c[0].data === 'object' &&
          (c[0].data as Record<string, unknown>).type === 'peers-changed'
      );
      expect(peerChangedCalls).toHaveLength(1);

      const renderWarning = errorSpy.mock.calls.some((args) =>
        String(args[0] ?? '').includes('Cannot update a component while rendering')
      );
      expect(renderWarning).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
