import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../context/Room';
import { useRoom } from '../hooks/useRoom';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  // Test controls
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const wrapper = ({ children }: PropsWithChildren) => (
  <Room signallingServerUrl="ws://test" roomId="room">
    {children}
  </Room>
);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Room', () => {
  it('dedupes peers and derives remotePeers', () => {
    const { result } = renderHook(() => useRoom(), { wrapper });
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive({ type: 'joined', peerId: 'self', peers: ['self', 'self'] });
    });
    expect(result.current.peers).toEqual(['self']);
    expect(result.current.remotePeers).toEqual([]);
    expect(result.current.connectedPeers).toEqual([]);
    expect(result.current.isConnected).toBe(true);
  });

  it('reports isConnected false when the signalling socket drops', () => {
    const { result } = renderHook(() => useRoom(), { wrapper });
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive({ type: 'joined', peerId: 'self', peers: ['self'] });
    });
    expect(result.current.isConnected).toBe(true);
    act(() => ws.drop());
    expect(result.current.isConnected).toBe(false);
  });
});
