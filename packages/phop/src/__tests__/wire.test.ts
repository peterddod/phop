import { describe, expect, it, vi } from 'vitest';
import {
  createInbox,
  type DataChannelLike,
  encodeFrames,
  FrameReassembler,
  maxMessageSizeOf,
  Outbox,
  utf8Length,
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

  send(data: string) {
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
