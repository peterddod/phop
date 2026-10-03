import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedSimulation, type HostedSimulationOptions } from '../core/HostedSimulation';
import { type DataChannelLike, Outbox } from '../core/wire';
import { createMockNetwork, type MockRoom } from './helpers/mockNetwork';

interface TestState {
  count: number;
  log: string[];
}

const isString = (d: unknown): d is string => typeof d === 'string';

function options(
  players: string[],
  overrides: Partial<HostedSimulationOptions<TestState, string>> = {}
): HostedSimulationOptions<TestState, string> {
  return {
    players,
    init: () => ({ count: 0, log: [] }),
    step: (state, inputs) => {
      state.count++;
      for (const { playerId, input } of inputs) state.log.push(`${playerId}:${input}`);
    },
    validateInput: isString,
    migrationGraceMs: 100,
    ...overrides,
  };
}

function setup(
  players: string[],
  overrides: Partial<HostedSimulationOptions<TestState, string>> = {},
  network: { requireLinks?: boolean } = {}
) {
  const net = createMockNetwork(network);
  const rooms: Record<string, MockRoom> = {};
  const sims: Record<string, HostedSimulation<TestState, string>> = {};
  for (const p of players) rooms[p] = net.join(p);
  net.setMembers(players);
  for (const p of players) {
    sims[p] = new HostedSimulation('sim', options(players, overrides), rooms[p]);
    sims[p].start();
  }
  const sync = () => {
    for (const p of players) sims[p].syncRoom({ ...rooms[p] });
  };
  return { net, rooms, sims, sync };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HostedSimulation', () => {
  it('solo: steps immediately and applies local inputs', () => {
    const { sims } = setup(['a']);
    sims.a.dispatch('hello');
    vi.advanceTimersByTime(1000);
    expect(sims.a.getTick()).toBeGreaterThanOrEqual(9);
    expect(sims.a.getState().log).toEqual(['a:hello']);
  });

  it('host steps and broadcasts; non-host adopts snapshots', () => {
    const { sims } = setup(['a', 'b']);
    expect(sims.a.getHostId()).toBe('a');
    expect(sims.b.getHostId()).toBe('a');
    vi.advanceTimersByTime(1100);
    expect(sims.a.getTick()).toBeGreaterThan(5);
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    expect(sims.b.getState()).toEqual(sims.a.getState());
  });

  it('holds for the migration grace before stepping', () => {
    const { sims } = setup(['a', 'b'], { migrationGraceMs: 1000 });
    vi.advanceTimersByTime(900);
    expect(sims.a.getTick()).toBe(0);
    vi.advanceTimersByTime(600);
    expect(sims.a.getTick()).toBeGreaterThan(0);
  });

  it('forwards non-host inputs to the host with transport identity', () => {
    const { sims } = setup(['a', 'b']);
    vi.advanceTimersByTime(200);
    sims.b.dispatch('move');
    vi.advanceTimersByTime(200);
    expect(sims.a.getState().log).toEqual(['b:move']);
    expect(sims.b.getState().log).toEqual(['b:move']);
  });

  it('drops invalid inputs and inputs from non-players', () => {
    const { net, sims } = setup(['a', 'b']);
    vi.advanceTimersByTime(200);
    net.inject('b', 'a', { ch: 'sim:input', d: 42 });
    net.join('x');
    net.setMembers(['a', 'b', 'x'], ['a']);
    net.inject('x', 'a', { ch: 'sim:input', d: 'cheat' });
    vi.advanceTimersByTime(200);
    expect(sims.a.getState().log).toEqual([]);
  });

  it('rejects snapshots that are forged, stale or from a non-host', () => {
    const { net, sims } = setup(['a', 'b', 'c']);
    vi.advanceTimersByTime(500);
    const tick = sims.b.getTick();
    const forged = { count: 999, log: ['forged'] };
    // c claims to be the host a.
    net.inject('c', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'a', seq: 1, tick: tick + 5, state: forged },
    });
    // c honestly names itself but isn't host.
    net.inject('c', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'c', seq: 1, tick: tick + 5, state: forged },
    });
    // Stale snapshot from the real host.
    net.inject('a', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'a', seq: 1, tick: 0, state: forged },
    });
    expect(sims.b.getState().log).not.toContain('forged');
  });

  it('validates snapshot state when validateState is given', () => {
    const { net, sims } = setup(['a', 'b'], {
      validateState: (d): d is TestState =>
        typeof d === 'object' && d !== null && typeof (d as TestState).count === 'number',
    });
    net.inject('a', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'a', seq: 1, tick: 50, state: { bad: 1 } },
    });
    expect(sims.b.getTick()).toBe(0);
  });

  it('promotes the next player when the host leaves, without rolling back', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    vi.advanceTimersByTime(1000);
    const before = sims.b.getTick();
    expect(before).toBeGreaterThan(0);

    sims.a.stop();
    net.setMembers(['b', 'c']);
    sync();
    expect(sims.b.getHostId()).toBe('b');
    expect(sims.c.getHostId()).toBe('b');

    vi.advanceTimersByTime(1000);
    expect(sims.b.getTick()).toBeGreaterThan(before);
    expect(sims.c.getTick()).toBe(sims.b.getTick());
  });

  it('a demoted host hands its state to the returning host', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    vi.advanceTimersByTime(500);

    // a drops out of everyone's view; b takes over and runs ahead.
    net.setMembers(['b', 'c'], ['b', 'c']);
    net.setMembers(['a'], ['a']);
    sync();
    vi.advanceTimersByTime(2000);
    const bTick = sims.b.getTick();
    expect(bTick).toBeGreaterThan(sims.a.getTick());

    // a returns and is re-elected; b hands over.
    net.setMembers(['a', 'b', 'c']);
    sync();
    expect(sims.a.getHostId()).toBe('a');
    expect(sims.a.getTick()).toBe(bTick);
  });

  it('rejects a handover from anyone but the previous host, and implausible ticks', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c', 'd']);
    vi.advanceTimersByTime(500);
    const before = sims.b.getTick();

    // a leaves; b is promoted and expects a handover only from a.
    net.setMembers(['b', 'c', 'd']);
    sync();
    const evil = { count: -1, log: ['evil'] };
    net.inject('d', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'd', seq: 1, tick: Number.MAX_SAFE_INTEGER, state: evil },
    });
    net.inject('c', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'c', seq: 1, tick: before + 1, state: evil },
    });
    expect(sims.b.getState().log).not.toContain('evil');
    expect(sims.b.getTick()).toBe(before);

    vi.advanceTimersByTime(1000);
    expect(sims.b.getTick()).toBeGreaterThan(before);
    expect(sims.c.getTick()).toBe(sims.b.getTick());
  });

  it('caps how far ahead a legitimate handover may jump', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    vi.advanceTimersByTime(500);
    net.setMembers(['a'], ['a']);
    net.setMembers(['b', 'c'], ['b', 'c']);
    sync();
    vi.advanceTimersByTime(1000);

    net.setMembers(['a', 'b', 'c'], ['a']);
    sync();
    const aTick = sims.a.getTick();
    net.inject('b', 'a', {
      ch: 'sim:snapshot',
      d: { hostId: 'b', seq: 1, tick: aTick + 10_000, state: { count: 0, log: ['far'] } },
    });
    expect(sims.a.getTick()).toBe(aTick);
  });

  it('resends the handover once the data channel to the new host opens', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c'], {}, { requireLinks: true });
    net.openLink('a', 'b');
    net.openLink('a', 'c');
    net.openLink('b', 'c');
    vi.advanceTimersByTime(500);

    // a vanishes; its channels close. b takes over and runs ahead.
    net.closeLink('a', 'b');
    net.closeLink('a', 'c');
    net.setMembers(['b', 'c'], ['b', 'c']);
    net.setMembers(['a'], ['a']);
    sync();
    vi.advanceTimersByTime(2000);
    const bTick = sims.b.getTick();

    // a reappears in signalling first; the handover can't be delivered yet.
    net.setMembers(['a', 'b', 'c']);
    sync();
    expect(sims.a.getTick()).toBeLessThan(bTick);

    // Channels open 600ms later, still inside the retry window.
    vi.advanceTimersByTime(600);
    net.openLink('a', 'b');
    net.openLink('a', 'c');
    expect(sims.a.getTick()).toBeGreaterThanOrEqual(bTick);
  });

  it("sends the demoted host's queued inputs only once the new host's channel opens", () => {
    const { net, sims, sync } = setup(['a', 'b', 'c'], {}, { requireLinks: true });
    net.openLink('a', 'b');
    net.openLink('a', 'c');
    net.openLink('b', 'c');
    vi.advanceTimersByTime(500);
    net.closeLink('a', 'b');
    net.closeLink('a', 'c');
    net.setMembers(['b', 'c'], ['b', 'c']);
    net.setMembers(['a'], ['a']);
    sync();
    vi.advanceTimersByTime(2000);

    // b queues a command and is demoted before its next step, while its
    // channel to a is still closed.
    sims.b.dispatch('cmd');
    net.setMembers(['a', 'b', 'c']);
    sync();
    vi.advanceTimersByTime(300);
    // Our inputs go once b's channel to a opens, before its room catches up.
    net.openLink('a', 'b');
    net.openLink('a', 'c');
    sync();
    vi.advanceTimersByTime(1000);
    expect(sims.a.getState().log.filter((l) => l === 'b:cmd')).toHaveLength(1);
  });

  it('holds while cut off instead of simulating alone', () => {
    const { net, sims, sync } = setup(['a', 'b', 'c'], {
      absence: { timeoutMs: 100, toInput: () => 'resign' },
    });
    vi.advanceTimersByTime(500);
    net.setMembers(['a'], ['a']);
    sync();
    const tick = sims.a.getTick();
    vi.advanceTimersByTime(1000);
    expect(sims.a.getTick()).toBe(tick);
    expect(sims.a.getState().log).toEqual([]);
  });

  it('holds while the signalling connection is down', () => {
    const { rooms, sims, sync } = setup(['a', 'b']);
    vi.advanceTimersByTime(500);
    rooms.a.isConnected = false;
    sync();
    const tick = sims.a.getTick();
    vi.advanceTimersByTime(1000);
    expect(sims.a.getTick()).toBe(tick);
  });

  it('applies the absence input once a player has been gone long enough', () => {
    const { net, sims, sync } = setup(['a', 'b'], {
      absence: { timeoutMs: 500, toInput: () => 'resign' },
    });
    vi.advanceTimersByTime(300);
    net.setMembers(['a'], ['a']);
    sync();
    vi.advanceTimersByTime(300);
    expect(sims.a.getState().log).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(sims.a.getState().log).toEqual(['b:resign']);
    vi.advanceTimersByTime(1000);
    expect(sims.a.getState().log).toEqual(['b:resign']);
  });

  it('skips absence handling for inactive players', () => {
    const { net, sims, sync } = setup(['a', 'b'], {
      absence: { timeoutMs: 100, toInput: () => 'resign' },
      isActive: (_state, p) => p !== 'b',
    });
    vi.advanceTimersByTime(300);
    net.setMembers(['a'], ['a']);
    sync();
    vi.advanceTimersByTime(1000);
    expect(sims.a.getState().log).toEqual([]);
  });

  it('stops stepping and broadcasting once isRunning is false', () => {
    const { sims } = setup(['a', 'b'], { isRunning: (state) => state.count < 5 });
    vi.advanceTimersByTime(3000);
    expect(sims.a.getState().count).toBe(5);
    const tick = sims.a.getTick();
    const bVersion = sims.b.getVersion();
    vi.advanceTimersByTime(2000);
    expect(sims.a.getTick()).toBe(tick);
    expect(sims.b.getVersion()).toBe(bVersion);
    expect(sims.b.getState().count).toBe(5);
  });

  it('notifies subscribers when the state changes', () => {
    const { sims } = setup(['a']);
    const listener = vi.fn();
    sims.a.subscribe(listener);
    vi.advanceTimersByTime(300);
    expect(listener).toHaveBeenCalled();
  });

  it('stop() halts the loop and start() resumes it', () => {
    const { sims } = setup(['a']);
    vi.advanceTimersByTime(300);
    sims.a.stop();
    const tick = sims.a.getTick();
    vi.advanceTimersByTime(1000);
    expect(sims.a.getTick()).toBe(tick);
    sims.a.start();
    vi.advanceTimersByTime(500);
    expect(sims.a.getTick()).toBeGreaterThan(tick);
  });

  it('sends snapshots as coalescable, so a congested peer only gets the newest', () => {
    const { rooms } = setup(['a', 'b']);
    const broadcast = vi.spyOn(rooms.a, 'broadcast');
    vi.advanceTimersByTime(500);
    expect(broadcast).toHaveBeenCalled();
    for (const [, options] of broadcast.mock.calls) {
      expect(options?.coalesce).toBe('sim:snapshot');
    }
  });

  it('keeps stepping and publishing locally when broadcasting throws', () => {
    const { rooms, sims } = setup(['a', 'b']);
    rooms.a.broadcast = () => {
      throw new Error('channel closed');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    sims.a.subscribe(listener);
    vi.advanceTimersByTime(500);
    expect(sims.a.getTick()).toBeGreaterThan(2);
    expect(listener).toHaveBeenCalled();
    expect(sims.a.getVersion()).toBeGreaterThan(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('HostedSimulation snapshot deltas', () => {
  type Sent = { hostId: string; tick: number; seq: number; base?: number; patch?: unknown[] };

  /** Record a's snapshot broadcasts; `drop` swallows the next n of them. */
  function tap(room: MockRoom) {
    const sent: Sent[] = [];
    const tapState = { drop: 0 };
    const broadcast = room.broadcast;
    room.broadcast = (message, sendOptions) => {
      const data = message.data as { ch: string; d: Sent };
      if (data.ch === 'sim:snapshot') {
        sent.push(data.d);
        if (tapState.drop > 0) {
          tapState.drop--;
          return;
        }
      }
      broadcast(message, sendOptions);
    };
    return { sent, tapState };
  }

  it('sends a keyframe, then deltas, with a keyframe every keyframeInterval', () => {
    const { rooms, sims } = setup(['a', 'b'], { keyframeInterval: 0.5 });
    const { sent } = tap(rooms.a);
    vi.advanceTimersByTime(2000);
    expect(sent.length).toBeGreaterThan(10);
    const keyframes = sent.filter((s) => s.base === undefined);
    // The first snapshot is a keyframe, then one every 5 ticks.
    expect(sent[0].base).toBeUndefined();
    expect(keyframes.length).toBeGreaterThanOrEqual(3);
    expect(keyframes.length).toBeLessThan(sent.length / 2);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].seq).toBe(sent[i - 1].seq + 1);
      if (sent[i].base !== undefined) expect(sent[i].base).toBe(sent[i - 1].seq);
    }
    // Byte for byte what the host has.
    expect(JSON.stringify(sims.b.getState())).toBe(JSON.stringify(sims.a.getState()));
  });

  it('a delta holds only what changed', () => {
    const { rooms, sims } = setup(['a', 'b']);
    const { sent } = tap(rooms.a);
    sims.b.dispatch('x');
    vi.advanceTimersByTime(600);
    const deltas = sent.filter((s) => s.base !== undefined);
    expect(deltas.length).toBeGreaterThan(2);
    expect(deltas[deltas.length - 1].patch).toEqual([[0, ['count'], sims.a.getState().count]]);
    expect(sims.b.getState().log).toEqual(['b:x']);
  });

  it('sends full snapshots only with keyframeInterval 0', () => {
    const { rooms, sims } = setup(['a', 'b'], { keyframeInterval: 0 });
    const { sent } = tap(rooms.a);
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.every((s) => s.base === undefined)).toBe(true);
    expect(sims.b.getState()).toEqual(sims.a.getState());
  });

  it('asks the host for a keyframe after missing a delta, then follows again', () => {
    const { net, rooms, sims } = setup(['a', 'b'], { keyframeInterval: 60 });
    const { tapState } = tap(rooms.a);
    vi.advanceTimersByTime(500);
    const resync = vi.fn();
    rooms.a.onMessage(({ data }) => {
      if ((data as { ch?: string }).ch === 'sim:resync') resync();
    });
    tapState.drop = 1;
    vi.advanceTimersByTime(100);
    const stuck = sims.b.getTick();
    vi.advanceTimersByTime(100);
    expect(resync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(sims.b.getTick()).toBeGreaterThan(stuck);
    expect(JSON.stringify(sims.b.getState())).toBe(JSON.stringify(sims.a.getState()));
    // A delta against a base b doesn't hold changes nothing.
    const tick = sims.b.getTick();
    net.inject('a', 'b', {
      ch: 'sim:snapshot',
      d: { hostId: 'a', tick: tick + 1, seq: 10_000, base: 9_999, patch: [[0, ['count'], -5]] },
    });
    expect(sims.b.getTick()).toBe(tick);
  });

  it('rejects a delta whose result fails validateState, keeping the old state', () => {
    const { net, rooms, sims } = setup(['a', 'b'], {
      keyframeInterval: 60,
      validateState: (d): d is TestState =>
        typeof d === 'object' && d !== null && typeof (d as TestState).count === 'number',
    });
    const { sent } = tap(rooms.a);
    vi.advanceTimersByTime(500);
    const last = sent[sent.length - 1];
    const before = JSON.stringify(sims.b.getState());
    for (const patch of [[[0, ['count'], 'nope']], [[0, ['missing', 'x'], 1]]]) {
      net.inject('a', 'b', {
        ch: 'sim:snapshot',
        d: { hostId: 'a', tick: last.tick + 1, seq: last.seq + 1, base: last.seq, patch },
      });
      expect(JSON.stringify(sims.b.getState())).toBe(before);
    }
  });

  it('matches array elements by getId', () => {
    interface ListState {
      items: { key: number; n: number }[];
    }
    const net = createMockNetwork();
    const rooms = { a: net.join('a'), b: net.join('b') };
    net.setMembers(['a', 'b']);
    const opts: HostedSimulationOptions<ListState, string> = {
      players: ['a', 'b'],
      init: () => ({ items: Array.from({ length: 20 }, (_, key) => ({ key, n: 0 })) }),
      step: (state) => {
        // Drop the first item; bump the last.
        state.items.shift();
        const last = state.items[state.items.length - 1];
        if (last) last.n++;
      },
      validateInput: isString,
      migrationGraceMs: 100,
      getId: (item) => (item as { key: number }).key,
    };
    const { sent } = tap(rooms.a);
    const a = new HostedSimulation('sim', opts, rooms.a);
    const b = new HostedSimulation('sim', { ...opts, getId: undefined }, rooms.b);
    a.start();
    b.start();
    vi.advanceTimersByTime(800);
    const delta = sent.filter((s) => s.base !== undefined).pop();
    expect(delta?.patch).toEqual([
      [2, ['items'], 0, 1, []],
      [0, ['items', a.getState().items.length - 1, 'n'], expect.any(Number)],
    ]);
    expect(JSON.stringify(b.getState())).toBe(JSON.stringify(a.getState()));
  });

  it('sends a keyframe to a peer whose channel opens mid-match', () => {
    const { net, sims } = setup(['a', 'b'], { keyframeInterval: 60 }, { requireLinks: true });
    net.openLink('a', 'b');
    vi.advanceTimersByTime(500);
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    net.closeLink('a', 'b');
    vi.advanceTimersByTime(500);
    expect(sims.b.getTick()).toBeLessThan(sims.a.getTick());
    // Reopened: the keyframe lands at once, before any later delta.
    net.openLink('a', 'b');
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    expect(JSON.stringify(sims.b.getState())).toBe(JSON.stringify(sims.a.getState()));
  });

  it('gives a congested peer a keyframe in place of deltas it would miss the base of', () => {
    const { net, rooms, sims } = setup(['a', 'b'], { keyframeInterval: 60 });
    // a's link to b, through a real Outbox on a channel that congests on demand.
    const channel: DataChannelLike & { bufferedAmount: number } = {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onbufferedamountlow: null,
      send: (frame) => net.inject('a', 'b', JSON.parse(frame as string).data),
    };
    const outbox = new Outbox(channel, 1000, () => 1_000_000);
    rooms.a.broadcast = (message, sendOptions) => outbox.send(JSON.stringify(message), sendOptions);
    rooms.a.sendToPeer = (_, message, sendOptions) =>
      outbox.send(JSON.stringify(message), sendOptions);
    const resync = vi.fn();
    rooms.a.onMessage(({ data }) => {
      if ((data as { ch?: string }).ch === 'sim:resync') resync();
    });
    vi.advanceTimersByTime(500);
    expect(sims.b.getTick()).toBe(sims.a.getTick());

    channel.bufferedAmount = 1_000_000;
    vi.advanceTimersByTime(600);
    const stuck = sims.b.getTick();
    expect(stuck).toBeLessThan(sims.a.getTick());
    channel.bufferedAmount = 0;
    channel.onbufferedamountlow?.call(undefined as never, new Event('bufferedamountlow'));
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    expect(JSON.stringify(sims.b.getState())).toBe(JSON.stringify(sims.a.getState()));
    // Later deltas build on that keyframe.
    vi.advanceTimersByTime(500);
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    expect(resync).not.toHaveBeenCalled();
  });

  it('starts a new host term with a keyframe', () => {
    const { net, rooms, sims, sync } = setup(['a', 'b', 'c'], { keyframeInterval: 60 });
    vi.advanceTimersByTime(500);
    const { sent } = tap(rooms.b);
    sims.a.stop();
    net.setMembers(['b', 'c']);
    sync();
    vi.advanceTimersByTime(1000);
    expect(sent[0].base).toBeUndefined();
    expect(sent.slice(1).every((s) => s.base !== undefined)).toBe(true);
    expect(JSON.stringify(sims.c.getState())).toBe(JSON.stringify(sims.b.getState()));
  });
});
