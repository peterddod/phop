import { describe, expect, it, vi } from 'vitest';
import {
  BinaryReassembler,
  createInbox,
  type DataChannelLike,
  deflateText,
  encodeBinaryFrames,
  encodeFrames,
  FrameReassembler,
  maxMessageSizeOf,
  Outbox,
  PROTOCOL_VERSION,
  utf8Length,
  WireLink,
} from '../core/wire';

function reassemble(frames: string[]): (string | null)[] {
  const reassembler = new FrameReassembler();
  return frames.map((frame) => reassembler.push(frame));
}

/** A channel whose queue only drains when the test says so. */
class FakeChannel implements DataChannelLike {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: ((this: never, event: Event) => unknown) | null = null;
  sent: string[] = [];

  send(data: string | Uint8Array<ArrayBuffer>) {
    if (typeof data !== 'string') throw new Error('unexpected binary frame');
    this.sent.push(data);
    this.bufferedAmount += utf8Length(data);
  }

  drain() {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.call(undefined as never, new Event('bufferedamountlow'));
  }
}

describe('wire framing', () => {
  it('sends a message that fits as itself', () => {
    const text = JSON.stringify({ hello: 'world' });
    expect(encodeFrames(text, 1024)).toEqual([text]);
    expect(encodeFrames('x'.repeat(1000), 1000)).toEqual(['x'.repeat(1000)]);
  });

  it('splits a large message into frames within the limit and reassembles it', () => {
    // Multi-byte characters and surrogate pairs straddle the frame boundaries.
    const text = JSON.stringify({ s: 'aé😀€'.repeat(2000) });
    const frames = encodeFrames(text, 500);
    expect(frames.length).toBeGreaterThan(10);
    for (const frame of frames) expect(utf8Length(frame)).toBeLessThanOrEqual(500);
    const out = reassemble(frames);
    expect(out.slice(0, -1).every((m) => m === null)).toBe(true);
    expect(out.at(-1)).toBe(text);
  });

  it('measures UTF-8 lengths', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('defaults the maximum message size to 256 KiB', () => {
    expect(maxMessageSizeOf(undefined)).toBe(256 * 1024);
    expect(maxMessageSizeOf(0)).toBe(256 * 1024);
    expect(maxMessageSizeOf(65536)).toBe(65536);
  });

  it('reassembles consecutive chunked messages and plain ones in between', () => {
    const big = 'x'.repeat(3000);
    const a = encodeFrames(JSON.stringify(`${big}a`), 1000);
    const b = encodeFrames(JSON.stringify(`${big}b`), 1000);
    const out = reassemble([...a, '{"plain":1}', ...b]).filter((m) => m !== null);
    expect(out).toEqual([JSON.stringify(`${big}a`), '{"plain":1}', JSON.stringify(`${big}b`)]);
  });

  it('drops a message with a missing, repeated or foreign chunk', () => {
    const frames = encodeFrames(JSON.stringify('y'.repeat(5000)), 1000);
    const other = encodeFrames(JSON.stringify('z'.repeat(5000)), 1000);
    expect(reassemble([frames[0], frames[2], ...frames.slice(3)]).every((m) => m === null)).toBe(
      true
    );
    expect(reassemble([frames[0], frames[1], ...frames.slice(1)]).every((m) => m === null)).toBe(
      true
    );
    expect(reassemble([frames[0], other[1], ...frames.slice(2)]).every((m) => m === null)).toBe(
      true
    );
    // Recovers on the next whole message.
    const reassembler = new FrameReassembler();
    reassembler.push(frames[0]);
    const out = other.map((f) => reassembler.push(f));
    expect(out.at(-1)).toBe(JSON.stringify('z'.repeat(5000)));
  });

  it('drops malformed and absurdly large chunk headers', () => {
    expect(reassemble(['\u0001garbage'])).toEqual([null]);
    expect(reassemble(['\u0001a,0,99999999,{', '\u0001a,1,99999999,}'])).toEqual([null, null]);
  });

  it('inbox parses messages and ignores malformed data', () => {
    const received: unknown[] = [];
    const receive = createInbox((m) => received.push(m));
    receive('not json');
    receive('42');
    receive(new ArrayBuffer(4));
    for (const frame of encodeFrames(JSON.stringify({ big: 'q'.repeat(3000) }), 1000)) {
      receive(frame);
    }
    receive('{"ok":true}');
    expect(received).toEqual([{ big: 'q'.repeat(3000) }, { ok: true }]);
  });
});

describe('Outbox', () => {
  it('frames sends for the current maximum message size', () => {
    const channel = new FakeChannel();
    const outbox = new Outbox(channel, 1_000_000, () => 1000);
    const text = JSON.stringify('w'.repeat(5000));
    outbox.send(text);
    expect(channel.sent.length).toBeGreaterThan(5);
    expect(reassemble(channel.sent).at(-1)).toBe(text);
  });

  it('holds coalescable messages while congested and sends the newest on drain', () => {
    const channel = new FakeChannel();
    const outbox = new Outbox(channel, 100, () => 1_000_000);
    expect(channel.bufferedAmountLowThreshold).toBe(100);

    outbox.send(JSON.stringify({ tick: 1, pad: 'p'.repeat(200) }), { coalesce: 'snap' });
    expect(channel.sent).toHaveLength(1);
    // Congested: later snapshots are held, each replacing the last.
    outbox.send('{"tick":2}', { coalesce: 'snap' });
    outbox.send('{"tick":3}', { coalesce: 'snap' });
    outbox.send('{"other":1}', { coalesce: 'other' });
    expect(channel.sent).toHaveLength(1);
    // Messages without a key are never held.
    outbox.send('{"input":1}');
    expect(channel.sent).toHaveLength(2);

    channel.drain();
    expect(channel.sent.slice(2)).toEqual(['{"tick":3}', '{"other":1}']);
  });

  it('sends the supersede message in place of one that replaced a held message', () => {
    const channel = new FakeChannel();
    const outbox = new Outbox(channel, 100, () => 1_000_000);
    const supersede = (seq: number) => vi.fn(() => `{"key":${seq}}`);

    outbox.send(JSON.stringify({ key: 1, pad: 'p'.repeat(200) }), { coalesce: 'snap' });
    // Congested: delta 2 is held as itself (its base, 1, went out).
    const s2 = supersede(2);
    outbox.send('{"delta":2,"base":1}', { coalesce: 'snap', supersede: s2 });
    expect(s2).not.toHaveBeenCalled();
    // Delta 3 replaces delta 2, its base: held as a keyframe instead.
    outbox.send('{"delta":3,"base":2}', { coalesce: 'snap', supersede: supersede(3) });
    channel.drain();
    expect(channel.sent.slice(1)).toEqual(['{"key":3}']);

    // Replaced while held, then sent once the channel has drained: still a keyframe.
    channel.bufferedAmount = 1000;
    outbox.send('{"delta":4,"base":3}', { coalesce: 'snap' });
    channel.bufferedAmount = 0;
    outbox.send('{"delta":5,"base":4}', { coalesce: 'snap', supersede: supersede(5) });
    expect(channel.sent.slice(2)).toEqual(['{"key":5}']);
    // Nothing replaced: the delta itself.
    outbox.send('{"delta":6,"base":5}', { coalesce: 'snap', supersede: supersede(6) });
    expect(channel.sent.slice(3)).toEqual(['{"delta":6,"base":5}']);
  });

  it('sends held messages on the next send if the drain event was missed', () => {
    const channel = new FakeChannel();
    const outbox = new Outbox(channel, 10, () => 1_000_000);
    outbox.send('{"tick":1,"pad":"................"}', { coalesce: 'snap' });
    outbox.send('{"tick":2}', { coalesce: 'snap' });
    channel.bufferedAmount = 0;
    outbox.send('{"input":1}');
    expect(channel.sent.slice(1)).toEqual(['{"tick":2}', '{"input":1}']);
  });

  it('does not throw from the drain handler when the channel fails', () => {
    const channel = new FakeChannel();
    const outbox = new Outbox(channel, 10, () => 1_000_000);
    outbox.send('{"tick":1,"pad":"................"}', { coalesce: 'snap' });
    outbox.send('{"tick":2}', { coalesce: 'snap' });
    channel.send = () => {
      throw new Error('closed');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => channel.drain()).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/** Pseudo-random text that deflate can't shrink much, to force binary chunks. */
function noise(length: number): string {
  let x = 1;
  let out = '';
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String.fromCharCode(33 + ((x >>> 16) % 90));
  }
  return out.replace(/["\\]/g, 'x');
}

/** Two wire links joined by channels that deliver asynchronously, in order. */
function linkPair(maxMessageSize = 1_000_000, foreignHello?: string, dropFirstToB = false) {
  const received: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
  const frames: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
  const events: string[] = [];
  const make = (self: 'a' | 'b', other: 'a' | 'b') => {
    const channel: DataChannelLike = {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onbufferedamountlow: null,
      send: (data) => {
        frames[other].push(data);
        // The first frame to b is lost, as on a channel whose handlers attach late.
        if (other === 'b' && dropFirstToB && frames.b.length === 1) return;
        queueMicrotask(() => links[other].receive(data));
      },
    };
    return new WireLink({
      channel,
      maxBufferedAmount: 1_000_000,
      maxMessageSize: () => maxMessageSize,
      onMessage: (m) => received[self].push(m),
      onReady: () => events.push(`${self}:ready`),
      onIncompatible: (protocol) => events.push(`${self}:incompatible:${protocol}`),
    });
  };
  const links: { a: WireLink; b: WireLink } = { a: make('a', 'b'), b: make('b', 'a') };
  if (foreignHello === undefined) links.b.open();
  else queueMicrotask(() => links.a.receive(foreignHello));
  links.a.open();
  return { links, received, frames, events };
}

describe('wire link', () => {
  it('exchanges hellos, then compresses large messages and keeps their order', async () => {
    const { links, received, frames, events } = linkPair();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.sort()).toEqual(['a:ready', 'b:ready']);
    const big = { big: 'abc'.repeat(5000) };
    links.a.send(JSON.stringify(big));
    links.a.send('{"small":1}');
    links.a.send(JSON.stringify({ big2: 'xyz'.repeat(5000) }));
    links.a.send('{"small":2}');
    await vi.waitFor(() => expect(received.b).toHaveLength(4));
    expect(received.b).toEqual([big, { small: 1 }, { big2: 'xyz'.repeat(5000) }, { small: 2 }]);
    const binary = frames.b.filter((f) => typeof f !== 'string') as Uint8Array[];
    expect(binary).toHaveLength(2);
    expect(binary[0].byteLength).toBeLessThan(1000);
    // The hello is the first frame.
    expect(JSON.parse(frames.b[0] as string)).toEqual({
      phop: PROTOCOL_VERSION,
      deflate: true,
      ack: false,
    });
  });

  it('recovers from a lost hello, delivering messages sent before the handshake', async () => {
    const { links, received, events } = linkPair(1_000_000, undefined, true);
    // Sent before b's hello arrives: held, then delivered after the handshake.
    links.a.send('{"early":1}');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    links.a.send('{"late":2}');
    await vi.waitFor(() => expect(received.b).toHaveLength(2));
    expect(received.b).toEqual([{ early: 1 }, { late: 2 }]);
    // The acknowledgements are not delivered as messages.
    expect(received.a).toEqual([]);
  });

  it('sends the supersede message for one replacing a message held before the handshake', async () => {
    const { links, received, events } = linkPair(1_000_000, undefined, true);
    links.a.send('{"key":1}', { coalesce: 'snap' });
    links.a.send('{"delta":2,"base":1}', { coalesce: 'snap', supersede: () => '{"key":2}' });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await vi.waitFor(() => expect(received.b).toHaveLength(1));
    expect(received.b).toEqual([{ key: 2 }]);
  });

  it('chunks compressed messages larger than the maximum message size', async () => {
    const { links, received, frames, events } = linkPair(4096);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const text = noise(50_000);
    links.a.send(JSON.stringify({ text }));
    links.a.send('{"after":1}');
    await vi.waitFor(() => expect(received.b).toHaveLength(2));
    expect(received.b).toEqual([{ text }, { after: 1 }]);
    const binary = frames.b.filter((f) => typeof f !== 'string') as Uint8Array[];
    expect(binary.length).toBeGreaterThan(5);
    for (const frame of binary) expect(frame.byteLength).toBeLessThanOrEqual(4096);
  });

  it('flags a peer on another protocol and ignores it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { links, received, events } = linkPair(1_000_000, JSON.stringify({ phop: 99 }));
    await vi.waitFor(() => expect(events).toContain('a:incompatible:99'));
    links.a.receive('{"data":"ignored"}');
    expect(received.a).toEqual([]);
    vi.restoreAllMocks();
  });

  it('treats a peer whose first frame is not a hello as phop 1.x', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { events } = linkPair(1_000_000, '{"senderId":"x","data":1,"timestamp":0}');
    await vi.waitFor(() => expect(events).toContain('a:incompatible:1'));
    warn.mockRestore();
  });

  it('drops a corrupt compressed message and delivers the next', async () => {
    const received: unknown[] = [];
    const receive = createInbox((m) => received.push(m));
    receive(new Uint8Array([1, 0xff, 0xfe, 0x00, 0x13]));
    const [frame] = encodeBinaryFrames(await deflateText('{"ok":1}'), 1000);
    receive(frame);
    receive('{"plain":2}');
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([{ ok: 1 }, { plain: 2 }]);
  });

  it('drops binary chunks out of sequence', () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    const frames = encodeBinaryFrames(bytes, 1000);
    const reassembler = new BinaryReassembler();
    expect(reassembler.push(frames[0])).toBeNull();
    expect(reassembler.push(frames[2])).toBeNull();
    const out = frames.map((f) => reassembler.push(f));
    expect(Array.from(out[out.length - 1] ?? [])).toEqual(Array.from(bytes));
    expect(reassembler.push(new Uint8Array([2, 0, 0]))).toBeNull();
  });
});
