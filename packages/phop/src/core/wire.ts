import type { SendOptions } from '../types';

/**
 * Framing between a room and a data channel: splitting messages larger than
 * the channel's maximum message size into ordered chunks, reassembling them,
 * and holding back superseded messages while a channel is congested.
 *
 * A message is sent as its JSON text. One too large for a single send goes
 * as chunk frames: `CHUNK_MARK id,index,count,` followed by part of the text.
 * JSON text never starts with the mark, so the two can't be confused. Data
 * channels are ordered and reliable, so a message's chunks arrive in order
 * and back to back.
 */

/** SCTP's maximum message size where the transport doesn't report one. */
export const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024;
/** Buffered bytes above which coalescable messages are held back. */
export const DEFAULT_MAX_BUFFERED_AMOUNT = 256 * 1024;

const CHUNK_MARK = '\u0001';
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
  send(data: string): void;
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

/**
 * One peer's outgoing side: frames each message for the channel's maximum
 * message size and, while more than `maxBufferedAmount` bytes are queued,
 * holds coalescable messages back, keeping only the newest per key. Held
 * messages go out once the channel drains below the threshold.
 */
export class Outbox {
  private readonly held = new Map<string, string>();

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
   * Send `text` (a JSON message). Throws if the channel refuses it. A message
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
    this.write(text);
  }

  private congested(): boolean {
    return this.channel.bufferedAmount > this.maxBufferedAmount;
  }

  private flush(): void {
    if (this.congested()) return;
    const held = [...this.held.values()];
    this.held.clear();
    for (const text of held) this.write(text);
  }

  private write(text: string): void {
    for (const frame of encodeFrames(text, this.maxMessageSize())) this.channel.send(frame);
  }
}

/**
 * One peer's incoming side: reassembles frames and parses them. Malformed
 * data is dropped rather than thrown into the channel's event handler.
 */
export function createInbox(
  onMessage: (message: Record<string, unknown>) => void
): (frame: unknown) => void {
  const reassembler = new FrameReassembler();
  return (frame) => {
    if (typeof frame !== 'string') return;
    const text = reassembler.push(frame);
    if (text === null) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message === 'object' && message !== null) {
      onMessage(message as Record<string, unknown>);
    }
  };
}
