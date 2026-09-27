import { type PropsWithChildren, StrictMode } from 'react';
import { vi } from 'vitest';
import { RoomContext, type RoomContextValue } from '../../context/Room';

export function createMockRoomContext(
  peerId = 'peer-1',
  peers: string[] = ['peer-1']
): {
  value: RoomContextValue;
  wrapper: React.FC<PropsWithChildren>;
} {
  const value: RoomContextValue = {
    roomId: 'test-room',
    peerId,
    peers,
    remotePeers: peers.filter((p) => p !== peerId),
    connectedPeers: peers.filter((p) => p !== peerId),
    isConnected: true,
    broadcast: vi.fn(),
    sendToPeer: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onPeerConnected: vi.fn(() => () => {}),
    onPeerDisconnected: vi.fn(() => () => {}),
    __internalStoreRegistry: new Map(),
  };

  const wrapper: React.FC<PropsWithChildren> = ({ children }) => (
    <RoomContext.Provider value={value}>{children}</RoomContext.Provider>
  );

  return { value, wrapper };
}

export function createStrictMockRoomContext(
  peerId = 'peer-1',
  peers: string[] = ['peer-1']
): {
  value: RoomContextValue;
  wrapper: React.FC<PropsWithChildren>;
} {
  const { value, wrapper: BaseWrapper } = createMockRoomContext(peerId, peers);
  const wrapper: React.FC<PropsWithChildren> = ({ children }) => (
    <StrictMode>
      <BaseWrapper>{children}</BaseWrapper>
    </StrictMode>
  );
  return { value, wrapper };
}
