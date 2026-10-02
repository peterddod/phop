import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedSimulation, type HostedSimulationOptions } from '../core/HostedSimulation';
import {
  createHostedSimulationWorker,
  type FromWorker,
  type HostedSimulationWorkerOptions,
  type SimulationWorker,
  type SimulationWorkerScope,
  type ToWorker,
  type WorkerConfig,
} from '../core/simulation-worker';
import { createMockNetwork, type MockRoom } from './helpers/mockNetwork';

interface Unit {
  id: string;
  x: number;
}

interface ToyState {
  count: number;
  rng: number;
  units: Unit[];
  log: string[];
}

const isString = (d: unknown): d is string => typeof d === 'string';

/** Deterministic: a seeded generator moves, adds and removes units. */
function step(state: ToyState, inputs: { playerId: string; input: string }[]): void {
  state.count++;
  state.rng = (state.rng * 1103515245 + 12345) % 2147483648;
  const pick = state.rng % 7;
  for (const unit of state.units) if (unit.x % 7 === pick) unit.x++;
  if (pick === 0) state.units.shift();
  if (pick === 3) state.units.push({ id: `u${state.count}`, x: state.rng % 100 });
  for (const { playerId, input } of inputs) state.log.push(`${state.count}:${playerId}:${input}`);
}

const init = (): ToyState => ({
  count: 0,
  rng: 42,
  units: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, x: i })),
  log: [],
});

const workerOptions: HostedSimulationWorkerOptions<ToyState, string> = { step };

interface FakeWorker extends SimulationWorker {
  terminated: boolean;
  fail(): void;
}

/**
 * A worker in this thread: messages are structured-cloned and delivered as
 * microtasks, like a real worker's, and its timers are the (fake) globals.
 */
function fakeWorker(options = workerOptions): FakeWorker {
  const toMain = new Set<(event: MessageEvent) => void>();
  const errors = new Set<(event: Event) => void>();
  const toWorker = new Set<(event: MessageEvent) => void>();
  const deliver = (listeners: Set<(event: MessageEvent) => void>, message: unknown) => {
    const data = structuredClone(message);
    queueMicrotask(() => {
      if (worker.terminated) return;
      for (const listener of listeners) listener({ data } as MessageEvent);
    });
  };
  const scope: SimulationWorkerScope = {
    postMessage: (message) => deliver(toMain, message),
    addEventListener: (_type, listener) => toWorker.add(listener),
    removeEventListener: (_type, listener) => toWorker.delete(listener),
  };
  const dispose = createHostedSimulationWorker(options, scope);
  const worker: FakeWorker = {
    terminated: false,
    postMessage: (message) => deliver(toWorker, message),
    addEventListener: (
      type: 'message' | 'error',
      listener: ((event: MessageEvent) => void) | ((event: Event) => void)
    ) => {
      if (type === 'message') toMain.add(listener as (event: MessageEvent) => void);
      else errors.add(listener as (event: Event) => void);
    },
    terminate: () => {
      worker.terminated = true;
      dispose();
    },
    fail: () => {
      for (const listener of errors) listener(new Event('error'));
    },
  };
  return worker;
}

function setup(
  players: string[],
  {
    worker = true,
    ...overrides
  }: Omit<Partial<HostedSimulationOptions<ToyState, string>>, 'worker'> & {
    worker?: boolean | (() => SimulationWorker);
  } = {}
) {
  const net = createMockNetwork();
  const rooms: Record<string, MockRoom> = {};
  const sims: Record<string, HostedSimulation<ToyState, string>> = {};
  const workers: FakeWorker[] = [];
  for (const p of players) rooms[p] = net.join(p);
  net.setMembers(players);
  for (const p of players) {
    sims[p] = new HostedSimulation(
      'sim',
      {
        players,
        init,
        step,
        validateInput: isString,
        migrationGraceMs: 100,
        worker:
          typeof worker === 'function'
            ? worker
            : worker
              ? () => {
                  const w = fakeWorker();
                  workers.push(w);
                  return w;
                }
              : undefined,
        ...overrides,
      },
      rooms[p]
    );
    sims[p].start();
  }
  const sync = () => {
    for (const p of players) sims[p].syncRoom({ ...rooms[p] });
  };
  return { net, rooms, sims, sync, workers };
}

/** Advance fake time in small slices (letting worker messages through) until `done`. */
async function advanceUntil(done: () => boolean, maxMs = 10_000): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 10) {
    if (done()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error('advanceUntil: timed out');
}

const hash = (state: ToyState) => JSON.stringify(state);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HostedSimulation in a worker', () => {
  /** The same script in either mode: every state the host and a client held, by tick. */
  async function play(worker: boolean) {
    const { sims } = setup(['a', 'b', 'c'], { worker });
    const seen: Record<string, Map<number, string>> = {};
    for (const p of ['a', 'b', 'c']) {
      const map = new Map<number, string>();
      seen[p] = map;
      sims[p].subscribe(() => map.set(sims[p].getTick(), hash(sims[p].getState())));
    }
    await advanceUntil(() => sims.a.getTick() >= 10);
    sims.a.dispatch('x');
    sims.b.dispatch('y');
    await advanceUntil(() => sims.a.getTick() >= 25);
    sims.c.dispatch('z');
    await advanceUntil(() => sims.c.getTick() >= 40);
    for (const p of ['a', 'b', 'c']) sims[p].stop();
    return seen;
  }

  it('gives the same states, tick for tick, as stepping on the main thread', async () => {
    const main = await play(false);
    const worker = await play(true);
    for (const p of ['a', 'b', 'c']) {
      const ticks = [...worker[p].keys()].filter((t) => main[p].has(t));
      expect(ticks.length).toBeGreaterThan(20);
      for (const t of ticks) expect(worker[p].get(t)).toBe(main[p].get(t));
    }
    // Inputs landed, on the same ticks in both modes.
    const last = (seen: Map<number, string>) => JSON.parse([...seen.values()].pop() as string);
    expect(last(worker.c).log).toEqual(last(main.c).log);
    expect(last(worker.c).log).toHaveLength(3);
  });

  it('clients hold exactly the host state', async () => {
    const { sims } = setup(['a', 'b']);
    await advanceUntil(() => sims.b.getTick() >= 30);
    expect(sims.b.getTick()).toBe(sims.a.getTick());
    expect(hash(sims.b.getState())).toBe(hash(sims.a.getState()));
    // And it is the deterministic replay.
    const replay = init();
    for (let i = 0; i < sims.a.getTick(); i++) step(replay, []);
    expect(hash(sims.a.getState())).toBe(hash(replay));
  });

  it('never mutates a published state in place', async () => {
    const { sims } = setup(['a']);
    await advanceUntil(() => sims.a.getTick() >= 5);
    const held = sims.a.getState();
    const text = hash(held);
    await advanceUntil(() => sims.a.getTick() >= 10);
    expect(hash(held)).toBe(text);
    expect(sims.a.getState()).not.toBe(held);
  });

  it('solo: steps in the worker and applies local inputs', async () => {
    const { sims, workers } = setup(['a']);
    sims.a.dispatch('hello');
    await advanceUntil(() => sims.a.getTick() >= 9);
    expect(sims.a.getState().log).toEqual(['1:a:hello']);
    expect(workers).toHaveLength(1);
  });

  it('holds for the migration grace before stepping', async () => {
    const { sims } = setup(['a', 'b'], { migrationGraceMs: 1000 });
    await vi.advanceTimersByTimeAsync(900);
    expect(sims.a.getTick()).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(sims.a.getTick()).toBeGreaterThan(0);
  });

  it('holds the worker while cut off', async () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    await advanceUntil(() => sims.a.getTick() >= 5);
    net.setMembers(['a'], ['a']);
    sync();
    await vi.advanceTimersByTimeAsync(200);
    const held = sims.a.getTick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sims.a.getTick()).toBe(held);
  });

  it('stops stepping once isRunning is false', async () => {
    const isRunning = (s: ToyState) => s.count < 5;
    const net = createMockNetwork();
    const room = net.join('a');
    const sim = new HostedSimulation(
      'sim',
      {
        players: ['a'],
        init,
        step,
        validateInput: isString,
        isRunning,
        worker: () => fakeWorker({ step, isRunning }),
      },
      room
    );
    sim.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sim.getTick()).toBe(5);
    sim.stop();
  });

  it('promotes the next player when the host leaves; its worker takes over', async () => {
    const { net, sims, sync } = setup(['a', 'b', 'c'], {
      absence: { timeoutMs: 500, toInput: () => 'resign' },
    });
    await advanceUntil(() => sims.c.getTick() >= 10);
    const before = sims.b.getTick();

    sims.a.stop();
    net.setMembers(['b', 'c']);
    sync();
    expect(sims.b.getHostId()).toBe('b');

    await advanceUntil(() => sims.c.getState().log.some((l) => l.endsWith('a:resign')));
    expect(sims.b.getTick()).toBeGreaterThan(before);
    await advanceUntil(() => sims.c.getTick() === sims.b.getTick());
    expect(hash(sims.c.getState())).toBe(hash(sims.b.getState()));
  });

  it('a demoted host stops its worker and hands its state to the returning host', async () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    await advanceUntil(() => sims.c.getTick() >= 5);

    // a drops out of everyone's view; b takes over and runs ahead.
    net.setMembers(['b', 'c'], ['b', 'c']);
    net.setMembers(['a'], ['a']);
    sync();
    await vi.advanceTimersByTimeAsync(2000);
    const bTick = sims.b.getTick();
    expect(bTick).toBeGreaterThan(sims.a.getTick());

    // a returns and is re-elected; b's handover (its copy of the worker's
    // state) is adopted and a's worker carries on from it.
    net.setMembers(['a', 'b', 'c']);
    sync();
    expect(sims.a.getHostId()).toBe('a');
    expect(sims.a.getTick()).toBe(bTick);
    const handedOver = hash(sims.b.getState());
    expect(hash(sims.a.getState())).toBe(handedOver);

    await advanceUntil(() => sims.c.getTick() >= bTick + 10);
    // b's worker no longer steps: b follows a.
    await advanceUntil(() => sims.b.getTick() === sims.a.getTick());
    expect(hash(sims.b.getState())).toBe(hash(sims.a.getState()));
    const replay = init();
    for (let i = 0; i < sims.a.getTick(); i++) step(replay, []);
    expect(hash(sims.a.getState())).toBe(hash(replay));
  });

  it('steps on the main thread when the worker factory throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sims } = setup(['a'], {
      worker: () => {
        throw new Error('blocked');
      },
    });
    await advanceUntil(() => sims.a.getTick() >= 5);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('carries on on the main thread from the last frame when the worker fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sims, workers } = setup(['a', 'b']);
    await advanceUntil(() => sims.b.getTick() >= 10);
    const tick = sims.a.getTick();
    workers[0].fail();
    expect(workers[0].terminated).toBe(true);
    await advanceUntil(() => sims.b.getTick() >= tick + 10);
    expect(hash(sims.b.getState())).toBe(hash(sims.a.getState()));
    const replay = init();
    for (let i = 0; i < sims.a.getTick(); i++) step(replay, []);
    expect(hash(sims.a.getState())).toBe(hash(replay));
    error.mockRestore();
  });

  it('sends the worker-encoded snapshot text through broadcastText', async () => {
    const net = createMockNetwork();
    const a = net.join('a');
    const b = net.join('b');
    net.setMembers(['a', 'b']);
    const texts: string[] = [];
    a.broadcastText = (text) => {
      texts.push(text);
      a.broadcast(JSON.parse(text));
    };
    const make = (room: MockRoom) =>
      new HostedSimulation(
        'sim',
        {
          players: ['a', 'b'],
          init,
          step,
          validateInput: isString,
          migrationGraceMs: 100,
          worker: () => fakeWorker(),
        },
        room
      );
    const host = make(a);
    const client = make(b);
    host.start();
    client.start();
    await advanceUntil(() => client.getTick() >= 15);
    expect(texts.length).toBeGreaterThan(10);
    const kinds = texts.map((t) => ('state' in JSON.parse(t).data.d ? 'key' : 'delta'));
    expect(kinds[0]).toBe('key');
    expect(kinds).toContain('delta');
    expect(hash(client.getState())).toBe(hash(host.getState()));
    host.stop();
    client.stop();
  });

  it("keeps the host's own inputs from a cut-off once it reconnects", async () => {
    const { net, sims, sync } = setup(['a', 'b', 'c']);
    await advanceUntil(() => sims.a.getTick() >= 5);
    net.setMembers(['a'], ['a']);
    sync();
    await vi.advanceTimersByTimeAsync(200);
    sims.a.dispatch('held');
    await vi.advanceTimersByTimeAsync(500);
    net.setMembers(['a', 'b', 'c']);
    sync();
    await advanceUntil(() => sims.c.getState().log.some((l) => l.endsWith(':a:held')));
  });

  /** A host whose worker fails right after `trigger` is posted to it, before taking it. */
  function failOnInput(
    trigger: string,
    overrides: Partial<HostedSimulationOptions<ToyState, string>>
  ) {
    const players = Object.keys(overrides).length > 0 ? ['a', 'b', 'c'] : ['a', 'b'];
    return setup(players, {
      ...overrides,
      worker: () => {
        const w = fakeWorker();
        const post = w.postMessage;
        w.postMessage = (message) => {
          post(message);
          const m = message as ToWorker<ToyState, string>;
          if (m.type === 'input' && m.input.input === trigger) w.fail();
        };
        return w;
      },
    });
  }

  it('steps inputs the failed worker never took on the main thread', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sims } = failOnInput('mine', {});
    await advanceUntil(() => sims.b.getTick() >= 10);
    sims.b.dispatch('theirs');
    sims.a.dispatch('mine');
    await advanceUntil(() => sims.b.getState().log.some((l) => l.endsWith(':a:mine')));
    const log = sims.b.getState().log;
    expect(log.filter((l) => l.endsWith(':b:theirs'))).toHaveLength(1);
    expect(log.filter((l) => l.endsWith(':a:mine'))).toHaveLength(1);
    error.mockRestore();
  });

  it('still resigns an absent player whose resignation the failed worker never took', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { net, sims, sync } = failOnInput('resign', {
      absence: { timeoutMs: 300, toInput: () => 'resign' },
    });
    await advanceUntil(() => sims.c.getTick() >= 10);
    sims.b.stop();
    net.setMembers(['a', 'c']);
    sync();
    await advanceUntil(() => sims.c.getState().log.some((l) => l.endsWith(':b:resign')));
    error.mockRestore();
  });

  it("posts the host's state before its snapshot message, transferring the compressed bytes", async () => {
    const posts: { message: FromWorker; transfer?: Transferable[] }[] = [];
    let listener: ((event: MessageEvent) => void) | null = null;
    const scope: SimulationWorkerScope = {
      postMessage: (message, transfer) => posts.push({ message: message as FromWorker, transfer }),
      addEventListener: (_type, l) => {
        listener = l;
      },
      removeEventListener: () => {},
    };
    const dispose = createHostedSimulationWorker(workerOptions, scope);
    const send = (data: ToWorker<ToyState, string>) => listener?.({ data } as MessageEvent);
    const config: WorkerConfig = {
      dt: 0.1,
      loopIntervalMs: 50,
      maxFrameDelta: 0.25,
      maxCatchUp: 1,
      keyframeInterval: 1,
      broadcast: true,
      hostId: 'a',
      channel: 'sim:snapshot',
    };
    // Long enough to be compressed.
    const state = { ...init(), log: Array.from({ length: 200 }, (_, i) => `entry ${i}`) };
    send({ type: 'start', term: 1, state, tick: 0, seq: 0, config });
    send({ type: 'run', run: true });
    vi.advanceTimersByTime(200);
    expect(posts.map((p) => p.message.type)).toEqual(['frame']);
    // Compression takes real time: the message follows.
    await vi.waitFor(() => expect(posts.some((p) => p.message.type === 'message')).toBe(true));
    const post = posts.find((p) => p.message.type === 'message');
    const message = post?.message;
    if (message?.type !== 'message' || !message.deflated) throw new Error('not compressed');
    expect(message.seq).toBe(posts[0].message.seq);
    expect(post?.transfer).toEqual([message.deflated.buffer]);
    dispose();
  });

  it('broadcasts each snapshot message with its own frame, even once a later one applied', () => {
    const net = createMockNetwork();
    const a = net.join('a');
    net.join('b');
    net.setMembers(['a', 'b']);
    const sent: { text: string; full?: string }[] = [];
    a.broadcastText = (text, options) => sent.push({ text, full: options?.supersede?.() });
    const posted: ToWorker<ToyState, string>[] = [];
    let toMain: ((event: MessageEvent) => void) | null = null;
    const worker: SimulationWorker = {
      postMessage: (message) => posted.push(message as ToWorker<ToyState, string>),
      addEventListener: (type: 'message' | 'error', l: (event: MessageEvent) => void) => {
        if (type === 'message') toMain = l;
      },
      terminate: () => {},
    } as SimulationWorker;
    const sim = new HostedSimulation(
      'sim',
      { players: ['a', 'b'], init, step, validateInput: isString, worker: () => worker },
      a
    );
    sim.start();
    const start = posted.find((m) => m.type === 'start');
    if (start?.type !== 'start') throw new Error('not started');
    const send = (data: FromWorker) => toMain?.({ data } as MessageEvent);
    const at = (count: number) => JSON.stringify({ ...init(), count });
    const term = start.term;
    send({ type: 'frame', term, tick: 1, seq: 1, inputs: 0, stateText: at(1) });
    send({ type: 'frame', term, tick: 2, seq: 2, inputs: 0, stateText: at(2) });
    expect(sim.getState().count).toBe(2);
    send({ type: 'message', term, seq: 1, message: 'one', delta: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('one');
    expect(JSON.parse(sent[0].full ?? '').data.d).toMatchObject({
      tick: 1,
      seq: 1,
      state: { count: 1 },
    });
    // Superseded: never sent.
    send({ type: 'message', term, seq: 1, message: 'again' });
    expect(sent).toHaveLength(1);
    send({ type: 'message', term, seq: 2, message: 'two' });
    expect(sent.map((s) => s.text)).toEqual(['one', 'two']);
    sim.stop();
  });
});
