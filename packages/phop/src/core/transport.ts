import type { SendOptions } from '../types';
import { PeerConnection, type SignalData } from './PeerConnection';
import { SignalingClient } from './SignalingClient';
import type { PeerInfo, PeerMetadata } from './wire';

export interface SignalingEvent {
  type: 'joined' | 'peer-list' | 'peer-joined' | 'peer-left' | 'signal' | 'disconnected';
  peerId?: string;
  peers?: string[];
  from?: string;
  data?: SignalData;
}

export type SignalingEventHandler = (event: SignalingEvent) => void;

/** Room membership. `SignalingClient` is the WebSocket implementation. */
export interface SignalingSession {
  /** Join the room; resolves with our peer id once `joined` arrives. */
  connect(): Promise<string>;
  /** Leave on purpose. Does not emit `disconnected`. */
  disconnect(): void;
  on(eventType: string, handler: SignalingEventHandler): void;
  getPeerId(): string;
  /** Relay a message (e.g. a WebRTC signal) through the server. */
  send(message: Record<string, unknown>): void;
}

export interface PeerLinkOptions {
  localPeerId: string;
  remotePeerId: string;
  signalingClient: SignalingSession;
  rtcConfig?: RTCConfiguration;
  /** Buffered bytes above which coalescable messages are held back. */
  maxBufferedAmount?: number;
  onChannelMessage?: (peerId: string, message: Record<string, unknown>) => void;
  /** The channel is open and the peer's hello says it speaks our protocol. */
  onChannelOpen?: (remotePeerId: string) => void;
  onChannelClose?: (remotePeerId: string) => void;
  /** The peer speaks another protocol version; the link ignores it from then on. */
  onIncompatible?: (remotePeerId: string, protocol: number) => void;
  /** Our metadata, sent with the hello. */
  metadata?: PeerMetadata | null;
  /** The peer's hello told us its version and metadata (again when they change). */
  onPeerInfo?: (remotePeerId: string, info: PeerInfo) => void;
}

/** A data link to one remote peer. `PeerConnection` is the WebRTC implementation. */
export interface PeerLink {
  handleSignal(data: SignalData): unknown;
  /** Send one serialised message. May throw if the link refuses it. */
  send(text: string, options?: SendOptions): void;
  /** Publish new metadata to the peer. Optional for links without metadata. */
  setMetadata?(metadata: PeerMetadata | null): void;
  close(): void;
}

/**
 * How a `<Room>` reaches other peers. The default is WebRTC data channels
 * with a WebSocket signalling server; `createMemoryNetwork` provides an
 * in-process one for tests.
 */
export interface RoomTransport {
  createSignaling(serverUrl: string, roomId: string): SignalingSession;
  createPeer(options: PeerLinkOptions): PeerLink;
}

export const webRtcTransport: RoomTransport = {
  createSignaling: (serverUrl, roomId) => new SignalingClient(serverUrl, roomId),
  createPeer: (options) => new PeerConnection(options),
};
