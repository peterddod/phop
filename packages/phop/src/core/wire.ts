import type { SendOptions } from '../types';

/**
 * Framing between a room and a data channel: a protocol handshake, deflate
 * compression of large messages, splitting messages larger than the
 * channel's maximum message size into ordered chunks, reassembling them,
 * and holding back superseded messages while a channel is congested.
 *
 * Each side's first frame is a hello naming its protocol version
 * (`{"phop":2,"deflate":true,"ack":false}`; see `WireLink`); a peer on
 * another version, or one whose first frame to arrive is anything else
 * (phop 1.x had no hello), is incompatible and ignored from then on.
 *
 * A message is sent as its JSON text. One too large for a single send goes
 * as chunk frames: `CHUNK_MARK id,index,count,` followed by part of the text.
 * JSON text never starts with the mark, so the two can't be confused. Once
 * the peer's hello says it can inflate, a message of `COMPRESS_MIN_LENGTH`
 * characters or more goes as a binary frame instead: `BINARY_WHOLE`
 * followed by its deflate-raw bytes, or, if that is still too large,
 * `BINARY_CHUNK` frames carrying `id,index,count` as three little-endian
 * u32s and then part of the bytes. Compression is asynchronous, so later
 * messages wait for it and every message keeps its place. Data channels are
 * ordered and reliable, so a message's chunks arrive in order and back to
 * back.
 */

/**
 * The wire protocol version. Peers only talk to peers on the same version.
 * 1 was phop 1.x, which had no hello; 2 added the hello, compressed binary
 * frames and hosted-simulation snapshot deltas.
 */
export const PROTOCOL_VERSION = 2;

/** SCTP's maximum message size where the transport doesn't report one. */
export const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024;
/** Buffered bytes above which coalescable messages are held back. */
export const DEFAULT_MAX_BUFFERED_AMOUNT = 256 * 1024;

/** Messages at least this long (in UTF-16 units) are compressed. */
export const COMPRESS_MIN_LENGTH = 2048;

const CHUNK_MARK = '\u0001';
const BINARY_WHOLE = 1;
const BINARY_CHUNK = 2;
// Kind byte plus id, index and count as u32s.
const BINARY_CHUNK_HEADER = 13;
// The mark, then `id,index,count,`.
const CHUNK_HEADER = /^.([0-9a-z]+),(\d+),(\d+),/s;
// Room for the chunk header (mark, id, index, count) in each chunk's budget.
const HEADER_BYTES = 64;
// Bounds on what an untrusted peer can make us buffer for one message.
const MAX_CHUNKS = 4096;
const MAX_REASSEMBLED_LENGTH = 64 * 1024 * 1024;

/** The data channel surface the outbox needs. `RTCDataChannel` satisfies it. */
export interface DataChannelLike {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onbufferedamountlow: ((this: never, event: Event) => unknown) | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
}

/** The usable maximum message size, given what the transport reports. */
export function maxMessageSizeOf(reported: number | null | undefined): number {
  return typeof reported === 'number' && reported > 0 ? reported : DEFAULT_MAX_MESSAGE_SIZE;
}

/** The UTF-8 length of `text` in bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

let nextMessageId = 0;
let lastEncoded: { text: string; maxBytes: number; frames: string[] } | null = null;

/**
 * Split `text` into frames of at most `maxBytes` UTF-8 bytes each. A message
 * that fits is its own single frame. Never splits a surrogate pair.
 */
export function encodeFrames(text: string, maxBytes: number): string[] {
  // Fast path: even all three-byte characters would fit.
  if (text.length * 3 <= maxBytes) return [text];
  // A broadcast encodes the same text once per peer.
  if (lastEncoded && lastEncoded.text === text && lastEncoded.maxBytes === maxBytes) {
    return lastEncoded.frames;
  }
  let frames: string[];
  if (utf8Length(text) <= maxBytes) {
    frames = [text];
  } else {
    const budget = Math.max(maxBytes - HEADER_BYTES, 4);
    const parts: string[] = [];
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length;
      const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + size > budget) {
        parts.push(text.slice(start, i));
        start = i;
        bytes = 0;
      }
      bytes += size;
      if (pair) i++;
    }
    parts.push(text.slice(start));
    const id = (nextMessageId++).toString(36);
    frames = parts.map((part, index) => `${CHUNK_MARK}${id},${index},${parts.length},${part}`);
  }
  lastEncoded = { text, maxBytes, frames };
  return frames;
}

/**
 * Reassembles one peer's frames into message texts. Frames that don't fit
 * the sequence (a gap, a different message, a malformed header, an
 * oversized message) are dropped along with the partial message.
 */
export class FrameReassembler {
  private partial: {
    id: string;
    next: number;
    count: number;
    parts: string[];
    length: number;
  } | null = null;

  /** Returns the complete message text, or null while one is incomplete. */
  push(frame: string): string | null {
    if (!frame.startsWith(CHUNK_MARK)) {
      this.partial = null;
      return frame;
    }
    const header = CHUNK_HEADER.exec(frame);
    if (!header) {
      this.partial = null;
      return null;
    }
    const [prefix, id, indexText, countText] = header;
    const index = Number(indexText);
    const count = Number(countText);
    const part = frame.slice(prefix.length);
    if (index === 0) {
      this.partial =
        count > 0 && count <= MAX_CHUNKS ? { id, next: 0, count, parts: [], length: 0 } : null;
    }
    const partial = this.partial;
    if (!partial || partial.id !== id || partial.next !== index || partial.count !== count) {
      this.partial = null;
      return null;
    }
    partial.length += part.length;
    if (partial.length > MAX_REASSEMBLED_LENGTH) {
      this.partial = null;
      return null;
    }
    partial.parts.push(part);
    partial.next++;
    if (partial.next < count) return null;
    this.partial = null;
    return partial.parts.join('');
  }
}

// ---------------------------------------------------------------------
// Compression and binary frames
// ---------------------------------------------------------------------

/** Whether this environment can compress messages it sends. */
export function canDeflate(): boolean {
  return typeof CompressionStream === 'function';
}

/** Whether this environment can decompress messages it receives. */
export function canInflate(): boolean {
  return typeof DecompressionStream === 'function';
}

async function pipeBytes(
  stream: CompressionStream | DecompressionStream,
  input: Uint8Array<ArrayBuffer>,
  maxOutput: number
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  // Failures surface on the reading side too.
  writer.write(input).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxOutput) {
      reader.cancel().catch(() => {});
      throw new RangeError('phop: inflated message is too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

let lastDeflated: { text: string; bytes: Promise<Uint8Array<ArrayBuffer>> } | null = null;

/** `text` as deflate-raw bytes. A broadcast compresses the same text once. */
export function deflateText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  if (lastDeflated?.text === text) return lastDeflated.bytes;
  const bytes = pipeBytes(
    new CompressionStream('deflate-raw'),
    new TextEncoder().encode(text),
    Number.POSITIVE_INFINITY
  );
  lastDeflated = { text, bytes };
  return bytes;
}

/** The text in deflate-raw `bytes`. Rejects on corrupt or oversized data. */
export async function inflateText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const out = await pipeBytes(
    new DecompressionStream('deflate-raw'),
    bytes,
    MAX_REASSEMBLED_LENGTH
  );
  return new TextDecoder().decode(out);
}

/** Split compressed bytes into binary frames of at most `maxBytes` each. */
export function encodeBinaryFrames(
  bytes: Uint8Array<ArrayBuffer>,
  maxBytes: number
): Uint8Array<ArrayBuffer>[] {
  if (bytes.byteLength + 1 <= maxBytes) {
    const frame = new Uint8Array(bytes.byteLength + 1);
    frame[0] = BINARY_WHOLE;
    frame.set(bytes, 1);
    return [frame];
  }
  const budget = Math.max(maxBytes - BINARY_CHUNK_HEADER, 1);
  const count = Math.ceil(bytes.byteLength / budget);
  const id = nextMessageId++ >>> 0;
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index++) {
    const part = bytes.subarray(index * budget, (index + 1) * budget);
    const frame = new Uint8Array(BINARY_CHUNK_HEADER + part.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint8(0, BINARY_CHUNK);
    view.setUint32(1, id, true);
    view.setUint32(5, index, true);
    view.setUint32(9, count, true);
    frame.set(part, BINARY_CHUNK_HEADER);
    frames.push(frame);
  }
  return frames;
}

/** A received binary frame as bytes, or null if it isn't binary. */
function toBytes(frame: unknown): Uint8Array<ArrayBuffer> | null {
  if (Object.prototype.toString.call(frame) === '[object ArrayBuffer]') {
    return new Uint8Array(frame as ArrayBuffer);
  }
  if (ArrayBuffer.isView(frame)) {
    return new Uint8Array(frame.buffer as ArrayBuffer, frame.byteOffset, frame.byteLength);
  }
  return null;
}

/** `FrameReassembler` for binary frames: returns a whole message's compressed bytes. */
export class BinaryReassembler {
  private partial: {
    id: number;
    next: number;
    count: number;
    parts: Uint8Array<ArrayBuffer>[];
    length: number;
  } | null = null;

  push(frame: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
    const kind = frame.byteLength > 0 ? frame[0] : -1;
    if (kind === BINARY_WHOLE) {
      this.partial = null;
      return frame.subarray(1);
    }
    if (kind !== BINARY_CHUNK || frame.byteLength < BINARY_CHUNK_HEADER) {
      this.partial = null;
      return null;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = view.getUint32(1, true);
    const index = view.getUint32(5, true);
    const count = view.getUint32(9, true);
    const part = frame.subarray(BINARY_CHUNK_HEADER);
    if (index === 0) {
      this.partial =
        count > 0 && count <= MAX_CHUNKS ? { id, next: 0, count, parts: [], length: 0 } : null;
    }
    const partial = this.partial;
    if (!partial || partial.id !== id || partial.next !== index || partial.count !== count) {
      this.partial = null;
      return null;
    }
    partial.length += part.byteLength;
    if (partial.length > MAX_REASSEMBLED_LENGTH) {
      this.partial = null;
      return null;
    }
    partial.parts.push(part);
    partial.next++;
    if (partial.next < count) return null;
    this.partial = null;
    const out = new Uint8Array(partial.length);
    let offset = 0;
    for (const p of partial.parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Outgoing and incoming sides
// ---------------------------------------------------------------------

/**
 * One peer's outgoing side: compresses large messages (once `compress` is
 * set), frames each message for the channel's maximum message size and,
 * while more than `maxBufferedAmount` bytes are queued, holds coalescable
 * messages back, keeping only the newest per key. Held messages go out once
 * the channel drains below the threshold.
 */
export class Outbox {
  private readonly held = new Map<string, string>();
  // Messages waiting behind a compression in progress, in send order.
  private readonly queue: string[] = [];
  private pumping = false;
  /** Compress large messages. Set once the peer says it can inflate them. */
  compress = false;

  constructor(
    private readonly channel: DataChannelLike,
    private readonly maxBufferedAmount: number,
    private readonly maxMessageSize: () => number
  ) {
    channel.bufferedAmountLowThreshold = maxBufferedAmount;
    channel.onbufferedamountlow = () => {
      try {
        this.flush();
      } catch (error) {
        console.error('phop: sending held messages failed:', error);
      }
    };
  }

  /**
   * Send `text` (a JSON message). Throws if the channel refuses it, unless
   * it waits behind a compression, which logs failures instead. A message
   * without a key is never held, so it may overtake held ones.
   */
  send(text: string, options?: SendOptions): void {
    const key = options?.coalesce;
    if (key !== undefined) this.held.delete(key);
    if (this.held.size > 0) this.flush();
    if (key !== undefined && this.congested()) {
      this.held.set(key, text);
      return;
    }
    this.enqueue(text);
  }

  private congested(): boolean {
    return this.channel.bufferedAmount > this.maxBufferedAmount;
  }

  private flush(): void {
    if (this.congested()) return;
    const held = [...this.held.values()];
    this.held.clear();
    for (const text of held) this.enqueue(text);
  }

  private compresses(text: string): boolean {
    return this.compress && text.length >= COMPRESS_MIN_LENGTH && canDeflate();
  }

  private enqueue(text: string): void {
    if (this.pumping) {
      this.queue.push(text);
      return;
    }
    if (!this.compresses(text)) {
      this.writeText(text);
      return;
    }
    this.queue.push(text);
    this.pumping = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift() as string;
        try {
          if (this.compresses(text)) {
            const bytes = await deflateText(text);
            for (const frame of encodeBinaryFrames(bytes, this.maxMessageSize())) {
              this.channel.send(frame);
            }
          } else {
            this.writeText(text);
          }
        } catch (error) {
          console.error('phop: sending a message failed:', error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private writeText(text: string): void {
    for (const frame of encodeFrames(text, this.maxMessageSize())) this.channel.send(frame);
  }
}

/**
 * One peer's incoming side: reassembles and inflates frames and parses
 * them, delivering messages in the order they were sent. Malformed data is
 * dropped rather than thrown into the channel's event handler.
 */
export function createInbox(
  onMessage: (message: Record<string, unknown>) => void
): (frame: unknown) => void {
  const texts = new FrameReassembler();
  const binaries = new BinaryReassembler();
  // Messages still inflating; later ones wait behind them.
  let waiting = 0;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (text: string | null) => {
    if (text === null) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    try {
      onMessage(message as Record<string, unknown>);
    } catch (error) {
      console.error('phop: handling a message failed:', error);
    }
  };

  return (frame) => {
    let item: string | Promise<string> | null;
    if (typeof frame === 'string') {
      item = texts.push(frame);
    } else {
      const bytes = toBytes(frame);
      const whole = bytes && binaries.push(bytes);
      item = whole && canInflate() ? inflateText(whole) : null;
    }
    if (item === null) return;
    if (typeof item === 'string' && waiting === 0) {
      deliver(item);
      return;
    }
    waiting++;
    // A message that fails to inflate is dropped; the ones after still arrive.
    const text = Promise.resolve(item).catch(() => null);
    chain = chain
      .then(() => text)
      .then((t) => {
        waiting--;
        deliver(t);
      });
  };
}

interface Hello {
  phop: number;
  deflate?: unknown;
  /** The sender has the receiver's hello. */
  ack?: unknown;
}

const HELLO_PREFIX = '{"phop":';

function parseHello(frame: unknown): Hello | null {
  if (typeof frame !== 'string' || !frame.startsWith(HELLO_PREFIX)) return null;
  try {
    const hello: unknown = JSON.parse(frame);
    if (typeof hello !== 'object' || hello === null) return null;
    const { phop } = hello as { phop?: unknown };
    return Number.isSafeInteger(phop) ? (hello as Hello) : null;
  } catch {
    return null;
  }
}

// Messages kept while waiting for the peer's hello, beyond which the oldest go.
const MAX_PENDING = 1024;

export interface WireLinkOptions {
  channel: DataChannelLike;
  maxBufferedAmount: number;
  maxMessageSize: () => number;
  onMessage: (message: Record<string, unknown>) => void;
  /** The peer's hello arrived and it speaks our protocol. */
  onReady?: () => void;
  /**
   * The peer speaks another protocol version (1 for phop 1.x). Nothing more
   * is sent to it or taken from it.
   */
  onIncompatible?: (protocol: number) => void;
  /** The version we speak. Default `PROTOCOL_VERSION`; others are for tests. */
  protocol?: number;
}

/**
 * Both sides of one peer's channel plus the protocol handshake. Call `open`
 * when the channel opens and pass every received frame to `receive`.
 *
 * A channel's first frames can be lost on the side that didn't create it
 * (they may arrive before its handlers are attached), so the handshake is
 * acknowledged: a hello without `ack` is answered with one that has it, and
 * messages are held until the peer's hello arrives. A v2 peer's first frame
 * to arrive is therefore always a hello; anything else means phop 1.x.
 */
export class WireLink {
  private readonly outbox: Outbox;
  private readonly inbox: (frame: unknown) => void;
  private readonly protocol: number;
  private helloSent = false;
  private peer: 'unknown' | 'compatible' | 'incompatible' = 'unknown';
  // Messages sent before the peer's hello arrived.
  private pending: { text: string; options?: SendOptions }[] = [];

  constructor(private readonly options: WireLinkOptions) {
    this.protocol = options.protocol ?? PROTOCOL_VERSION;
    this.outbox = new Outbox(options.channel, options.maxBufferedAmount, options.maxMessageSize);
    this.inbox = createInbox(options.onMessage);
  }

  /** Send our hello, once. Call when the channel opens. */
  open(): void {
    if (this.helloSent) return;
    this.sendHello(this.peer === 'compatible');
  }

  private sendHello(ack: boolean): void {
    this.helloSent = true;
    const hello: Hello = { phop: this.protocol, deflate: canInflate(), ack };
    this.options.channel.send(JSON.stringify(hello));
  }

  /**
   * Send a serialised message. May throw if the channel refuses it. Held
   * until the peer's hello arrives; dropped if the peer is incompatible.
   */
  send(text: string, options?: SendOptions): void {
    if (this.peer === 'incompatible') return;
    this.open();
    if (this.peer === 'compatible') {
      this.outbox.send(text, options);
      return;
    }
    const key = options?.coalesce;
    if (key !== undefined) this.pending = this.pending.filter((m) => m.options?.coalesce !== key);
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push({ text, options });
  }

  receive = (frame: unknown): void => {
    if (this.peer === 'incompatible') return;
    const hello = parseHello(frame);
    if (this.peer === 'compatible') {
      // A repeated hello (an acknowledgement) is not a message.
      if (hello) {
        if (hello.ack !== true) this.sendHello(true);
        return;
      }
      this.inbox(frame);
      return;
    }
    if (hello?.phop === this.protocol) {
      this.peer = 'compatible';
      this.outbox.compress = hello.deflate === true;
      // Our hello may have been lost (or never sent, if no open event reached
      // us): answer one that doesn't have it yet.
      if (hello.ack !== true || !this.helloSent) this.sendHello(true);
      const pending = this.pending;
      this.pending = [];
      for (const { text, options } of pending) {
        try {
          this.outbox.send(text, options);
        } catch (error) {
          console.error('phop: sending a held message failed:', error);
        }
      }
      this.options.onReady?.();
      return;
    }
    this.peer = 'incompatible';
    this.pending = [];
    const protocol = hello ? hello.phop : 1;
    console.warn(
      `phop: a peer speaks protocol ${protocol}, this build speaks ${this.protocol}; ignoring it`
    );
    this.options.onIncompatible?.(protocol);
  };
}
