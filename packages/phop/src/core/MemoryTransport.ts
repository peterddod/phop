import type { SendOptions } from '../types';
import type {
  PeerLink,
  PeerLinkOptions,
  RoomTransport,
  SignalingEvent,
  SignalingEventHandler,
  SignalingSession,
} from './transport';
import {
  type DataChannelLike,
  DEFAULT_MAX_BUFFERED_AMOUNT,
  PROTOCOL_VERSION,
  utf8Length,
  WireLink,
} from './wire';

export interface MemoryNetworkOptions {
  /**
   * Largest frame a link accepts, in UTF-8 bytes; bigger sends throw like a
   * real data channel's. Default: unlimited. Messages above it are chunked.
   */
  maxMessageSize?: number;
  /**
   * Protocol version each peer announces, by join order (1-based), to test
   * a mixed-version room. Default: this build's `PROTOCOL_VERSION`.
   */
  protocolOf?: (joinIndex: number) => number;
}

export interface MemoryNetwork {
  /** Pass to `<Room transport={...}>`. The server URL is ignored. */
  transport: RoomTransport;
  /**
   * Cut a peer off from signalling as if its socket dropped: it gets
   * `disconnected` and everyone else sees it leave.
   */
  dropSignaling(peerId: string): void;
  /** Ids in a room, in join order. */
  members(roomId: string): string[];
}

/**
 * An in-process transport for tests: rooms, membership and data links
 * without a signalling server or WebRTC. Peer ids are `peer-0001`,
 * `peer-0002`, … in join order, so the first to join sorts lowest. Every
 * event and message is delivered asynchronously (as a microtask), in order.
 * Messages go through the same framing as WebRTC links, so chunking and
 * coalescing behave the same.
 */
export function createMemoryNetwork(options: MemoryNetworkOptions = {}): MemoryNetwork {
  const maxMessageSize = options.maxMessageSize ?? Number.POSITIVE_INFINITY;
  const protocolOf = options.protocolOf ?? (() => PROTOCOL_VERSION);
  const joinIndex = new Map<string, number>();
  const rooms = new Map<string, Map<string, MemorySignaling>>();
  const links = new Map<string, MemoryLink>();
  const sessions = new Map<string, MemorySignaling>();
  let joined = 0;
  const linkKey = (from: string, to: string) => `${from}>${to}`;

  class MemorySignaling implements SignalingSession {
    private peerId = '';
    private readonly handlers = new Map<string, Set<SignalingEventHandler>>();

    constructor(private readonly roomId: string) {}

    connect(): Promise<string> {
      return new Promise((resolve) => {
        queueMicrotask(() => {
          joined++;
          this.peerId = `peer-${String(joined).padStart(4, '0')}`;
          joinIndex.set(this.peerId, joined);
          const room = rooms.get(this.roomId) ?? new Map<string, MemorySignaling>();
          rooms.set(this.roomId, room);
          room.set(this.peerId, this);
          sessions.set(this.peerId, this);
          const peers = [...room.keys()];
          this.emit({ type: 'joined', peerId: this.peerId, peers });
          for (const [id, other] of room) {
            if (id !== this.peerId) other.emit({ type: 'peer-joined', peerId: this.peerId, peers });
          }
          resolve(this.peerId);
        });
      });
    }

    disconnect(): void {
      this.leave();
    }

    /** Remove us from the room and tell the others. */
    leave(): void {
      const room = rooms.get(this.roomId);
      if (!room?.delete(this.peerId)) return;
      sessions.delete(this.peerId);
      const peers = [...room.keys()];
      for (const other of room.values()) {
        other.emit({ type: 'peer-left', peerId: this.peerId, peers });
      }
    }

    on(eventType: string, handler: SignalingEventHandler): void {
      const set = this.handlers.get(eventType) ?? new Set<SignalingEventHandler>();
      this.handlers.set(eventType, set);
      set.add(handler);
    }

    getPeerId(): string {
      return this.peerId;
    }

    // Links connect directly; there is nothing to relay.
    send(): void {}

    emit(event: SignalingEvent): void {
      queueMicrotask(() => {
        for (const handler of this.handlers.get(event.type) ?? []) handler(event);
      });
    }
  }

  class MemoryChannel implements DataChannelLike {
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    onbufferedamountlow: ((this: never, event: Event) => unknown) | null = null;

    constructor(private readonly link: MemoryLink) {}

    send(data: string | Uint8Array<ArrayBuffer>): void {
      const remote = this.link.remote;
      if (!this.link.open || !remote) throw new Error('memory link is not open');
      const size = typeof data === 'string' ? utf8Length(data) : data.byteLength;
      if (size > maxMessageSize) {
        throw new TypeError(`message of ${size} bytes exceeds maxMessageSize ${maxMessageSize}`);
      }
      this.bufferedAmount += size;
      queueMicrotask(() => {
        const before = this.bufferedAmount;
        this.bufferedAmount -= size;
        if (
          before > this.bufferedAmountLowThreshold &&
          this.bufferedAmount <= this.bufferedAmountLowThreshold
        ) {
          this.onbufferedamountlow?.call(undefined as never, new Event('bufferedamountlow'));
        }
        if (remote.open) remote.receive(data);
      });
    }
  }

  class MemoryLink implements PeerLink {
    open = false;
    closed = false;
    remote: MemoryLink | null = null;
    private readonly wire: WireLink;
    private readonly channel = new MemoryChannel(this);

    constructor(private readonly options: PeerLinkOptions) {
      const { remotePeerId } = options;
      this.wire = new WireLink({
        channel: this.channel,
        maxBufferedAmount: options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT,
        maxMessageSize: () => maxMessageSize,
        onMessage: (message) => options.onChannelMessage?.(remotePeerId, message),
        onReady: () => options.onChannelOpen?.(remotePeerId),
        onIncompatible: (protocol) => options.onIncompatible?.(remotePeerId, protocol),
        protocol: protocolOf(joinIndex.get(options.localPeerId) ?? 0),
      });
    }

    receive(frame: unknown): void {
      this.wire.receive(frame);
    }

    /** Announce our protocol. phop 1.x had no hello: its first frame was a message. */
    hello(): void {
      if (protocolOf(joinIndex.get(this.options.localPeerId) ?? 0) > 1) this.wire.open();
      else this.channel.send(JSON.stringify({ data: null }));
    }

    handleSignal(): void {}

    send(text: string, options?: SendOptions): void {
      if (this.open) this.wire.send(text, options);
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      const wasOpen = this.open;
      this.open = false;
      const { localPeerId, remotePeerId } = this.options;
      if (links.get(linkKey(localPeerId, remotePeerId)) === this) {
        links.delete(linkKey(localPeerId, remotePeerId));
      }
      if (wasOpen) queueMicrotask(() => this.options.onChannelClose?.(remotePeerId));
      this.remote?.close();
    }

    /** Pair with the other side's link and open both. */
    connect(remote: MemoryLink): void {
      this.remote = remote;
      remote.remote = this;
      queueMicrotask(() => {
        for (const link of [this, remote]) {
          if (!link.closed) link.open = true;
        }
        for (const link of [this, remote]) {
          if (link.open) link.hello();
        }
      });
    }
  }

  const transport: RoomTransport = {
    createSignaling: (_serverUrl, roomId) => new MemorySignaling(roomId),
    createPeer: (linkOptions) => {
      const { localPeerId, remotePeerId } = linkOptions;
      const link = new MemoryLink(linkOptions);
      links.get(linkKey(localPeerId, remotePeerId))?.close();
      links.set(linkKey(localPeerId, remotePeerId), link);
      const remote = links.get(linkKey(remotePeerId, localPeerId));
      if (remote && !remote.closed && !remote.remote) link.connect(remote);
      return link;
    },
  };

  return {
    transport,
    dropSignaling: (peerId) => {
      const session = sessions.get(peerId);
      if (!session) return;
      session.leave();
      session.emit({ type: 'disconnected' });
    },
    members: (roomId) => [...(rooms.get(roomId)?.keys() ?? [])],
  };
}
