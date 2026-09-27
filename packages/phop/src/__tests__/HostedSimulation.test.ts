import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedSimulation, type HostedSimulationOptions } from '../core/HostedSimulation';
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
  overrides: Partial<HostedSimulationOptions<TestState, string>> = {}
) {
  const net = createMockNetwork();
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
    net.inject('c', 'b', { ch: 'sim:snapshot', d: { hostId: 'a', tick: tick + 5, state: forged } });
    // c honestly names itself but isn't host.
    net.inject('c', 'b', { ch: 'sim:snapshot', d: { hostId: 'c', tick: tick + 5, state: forged } });
    // Stale snapshot from the real host.
    net.inject('a', 'b', { ch: 'sim:snapshot', d: { hostId: 'a', tick: 0, state: forged } });
    expect(sims.b.getState().log).not.toContain('forged');
  });

  it('validates snapshot state when validateState is given', () => {
    const { net, sims } = setup(['a', 'b'], {
      validateState: (d): d is TestState =>
        typeof d === 'object' && d !== null && typeof (d as TestState).count === 'number',
    });
    net.inject('a', 'b', { ch: 'sim:snapshot', d: { hostId: 'a', tick: 50, state: { bad: 1 } } });
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
});
