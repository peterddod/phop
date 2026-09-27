import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '../context/Room';
import { useChannel } from '../hooks/useChannel';
import { useHost } from '../hooks/useHost';
import { useHostedSimulation } from '../hooks/useHostedSimulation';
import { useLobby } from '../hooks/useLobby';
import { useRoom } from '../hooks/useRoom';
import { createMockNetwork, type MockRoom, toContextValue } from './helpers/mockNetwork';

function peerWrapper(room: MockRoom) {
  // Rebuilt on every render so hooks see membership changes after rerender().
  return ({ children }: PropsWithChildren) => (
    <RoomContext.Provider value={toContextValue(room)}>{children}</RoomContext.Provider>
  );
}

interface Chat {
  text: string;
}
const isChat = (d: unknown): d is Chat =>
  typeof d === 'object' && d !== null && typeof (d as Chat).text === 'string';

describe('useChannel', () => {
  it('delivers typed messages with transport identity and drops invalid ones', () => {
    const net = createMockNetwork();
    const a = net.join('a');
    const b = net.join('b');
    net.setMembers(['a', 'b']);
    const chatA = renderHook(() => useChannel('chat', isChat), { wrapper: peerWrapper(a) });
    const chatB = renderHook(() => useChannel('chat', isChat), { wrapper: peerWrapper(b) });

    const received: [Chat, string][] = [];
    chatB.result.current.subscribe((msg, from) => received.push([msg, from]));

    chatA.result.current.broadcast({ text: 'hi' });
    chatA.result.current.send('b', { text: 'direct' });
    net.inject('a', 'b', { ch: 'chat', d: { text: 5 } });
    net.inject('a', 'b', { ch: 'other', d: { text: 'wrong channel' } });

    expect(received).toEqual([
      [{ text: 'hi' }, 'a'],
      [{ text: 'direct' }, 'a'],
    ]);
  });

  it('returns a stable channel across renders', () => {
    const net = createMockNetwork();
    const a = net.join('a');
    const { result, rerender } = renderHook(() => useChannel('chat', (d): d is Chat => isChat(d)), {
      wrapper: peerWrapper(a),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useRoom', () => {
  it('fills in fields a 1.x-shaped provider leaves out', () => {
    const legacy = {
      roomId: 'r',
      peerId: 'a',
      peers: ['a', 'b'],
      isConnected: true,
      broadcast: () => {},
      sendToPeer: () => {},
      onMessage: () => () => {},
      onPeerConnected: () => () => {},
    };
    const { result } = renderHook(() => useRoom(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <RoomContext.Provider value={legacy}>{children}</RoomContext.Provider>
      ),
    });
    expect(result.current.remotePeers).toEqual(['b']);
    expect(result.current.connectedPeers).toEqual(['b']);
    expect(typeof result.current.onPeerDisconnected(() => {})).toBe('function');
  });
});

describe('useHost', () => {
  it('elects the lowest-sorted present candidate', () => {
    const net = createMockNetwork();
    const b = net.join('b');
    net.setMembers(['c', 'b', 'a']);
    const { result, rerender } = renderHook(() => useHost(), { wrapper: peerWrapper(b) });
    expect(result.current).toEqual({ hostId: 'a', isHost: false });

    b.peers = ['b', 'c'];
    rerender();
    expect(result.current).toEqual({ hostId: 'b', isHost: true });
  });

  it('respects an explicit candidate list', () => {
    const net = createMockNetwork();
    const b = net.join('b');
    net.setMembers(['a', 'b', 'c']);
    const { result } = renderHook(() => useHost({ candidates: ['b', 'c'] }), {
      wrapper: peerWrapper(b),
    });
    expect(result.current).toEqual({ hostId: 'b', isHost: true });
  });
});

describe('useLobby', () => {
  function setupLobby(members: string[]) {
    const net = createMockNetwork();
    const rooms = Object.fromEntries(members.map((m) => [m, net.join(m)]));
    net.setMembers(members);
    const lobbies = Object.fromEntries(
      members.map((m) => [
        m,
        renderHook(() => useLobby<{ seed: string }>(), { wrapper: peerWrapper(rooms[m]) }),
      ])
    );
    return { net, rooms, lobbies };
  }

  it('lets the lowest peer start and freezes the roster everywhere', () => {
    const { lobbies } = setupLobby(['b', 'a', 'a']);
    expect(lobbies.a.result.current.isLobbyHost).toBe(true);
    expect(lobbies.b.result.current.isLobbyHost).toBe(false);
    expect(lobbies.b.result.current.players).toEqual(['a', 'b']);

    act(() => lobbies.b.result.current.start({ seed: 'x' }));
    expect(lobbies.b.result.current.phase).toBe('lobby');

    act(() => lobbies.a.result.current.start({ seed: 'x' }));
    for (const l of [lobbies.a, lobbies.b]) {
      expect(l.result.current.phase).toBe('playing');
      expect(l.result.current.match).toEqual({ players: ['a', 'b'], config: { seed: 'x' } });
    }
  });

  it('tells late joiners a match is in progress', () => {
    const { net, lobbies } = setupLobby(['a', 'b']);
    act(() => lobbies.a.result.current.start({ seed: 'x' }));

    const c = net.join('c');
    net.setMembers(['a', 'b', 'c']);
    lobbies.a.rerender();
    lobbies.b.rerender();
    const late = renderHook(() => useLobby<{ seed: string }>(), { wrapper: peerWrapper(c) });

    act(() => {
      net.connect('a', 'c');
      net.connect('b', 'c');
    });
    expect(late.result.current.phase).toBe('in-progress');
  });

  it('ignores start and in-progress from anyone but the roster host', () => {
    const { net, lobbies } = setupLobby(['a', 'b', 'c']);
    // c (not the lowest) tries to start a match of itself and b.
    act(() => {
      net.inject('c', 'b', { ch: 'lobby', d: { type: 'start', players: ['b', 'c'], config: {} } });
    });
    expect(lobbies.b.result.current.phase).toBe('lobby');
    // c tries to lock b out.
    act(() => {
      net.inject('c', 'b', { ch: 'lobby', d: { type: 'in-progress', players: ['a', 'c'] } });
    });
    expect(lobbies.b.result.current.phase).toBe('lobby');
    // Pre-fix message shape without a roster is rejected outright.
    act(() => {
      net.inject('a', 'b', { ch: 'lobby', d: { type: 'in-progress' } });
    });
    expect(lobbies.b.result.current.phase).toBe('lobby');
  });

  it('dedupes a received roster', () => {
    const { net, lobbies } = setupLobby(['a', 'b']);
    act(() => {
      net.inject('a', 'b', {
        ch: 'lobby',
        d: { type: 'start', players: ['b', 'a', 'b'], config: { seed: 'x' } },
      });
    });
    expect(lobbies.b.result.current.match?.players).toEqual(['a', 'b']);
  });

  it('re-sends the start to a roster member whose channel opened late', () => {
    const { net, rooms, lobbies } = setupLobby(['a', 'b']);
    // b can't hear the start broadcast.
    rooms.a.peers = ['a'];
    act(() => {
      lobbies.a.result.current.start({ seed: 'x' });
    });
    expect(lobbies.b.result.current.phase).toBe('lobby');

    // a still sees b in the roster it froze, so b's late channel gets the start.
    rooms.a.peers = ['a', 'b'];
    lobbies.a.rerender();
    act(() => net.connect('a', 'b'));
    expect(lobbies.b.result.current.phase).toBe('playing');
  });
});

describe('useHostedSimulation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-renders with the host state on every peer', () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'],
    });
    const net = createMockNetwork();
    const a = net.join('a');
    const b = net.join('b');
    net.setMembers(['a', 'b']);
    const opts = {
      players: ['a', 'b'],
      init: () => ({ count: 0 }),
      step: (s: { count: number }) => ({ count: s.count + 1 }),
      validateInput: (d: unknown): d is string => typeof d === 'string',
      migrationGraceMs: 0,
    };
    const simA = renderHook(() => useHostedSimulation('sim', opts), { wrapper: peerWrapper(a) });
    const simB = renderHook(() => useHostedSimulation('sim', opts), { wrapper: peerWrapper(b) });

    expect(simA.result.current.isHost).toBe(true);
    expect(simB.result.current.hostId).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(simA.result.current.tick).toBeGreaterThan(5);
    expect(simB.result.current.tick).toBe(simA.result.current.tick);
    expect(simB.result.current.getState()).toEqual(simA.result.current.getState());
    expect(simB.result.current.version).toBeGreaterThan(0);

    simA.unmount();
    simB.unmount();
  });
});
