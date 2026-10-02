import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../context/Room';
import type { PlayerInput } from '../core/HostedSimulation';
import { createMemoryNetwork } from '../core/MemoryTransport';
import type { RoomTransport } from '../core/transport';
import { PROTOCOL_VERSION } from '../core/wire';
import { useHostedSimulation } from '../hooks/useHostedSimulation';
import { type UseLobbyResult, useLobby } from '../hooks/useLobby';
import { type RoomApi, useRoom } from '../hooks/useRoom';
import type { JSONSerializable, Message } from '../types';

// Memory-transport events land outside act(); the probes don't need it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface RoomProbe {
  room: RoomApi | null;
  received: Message<JSONSerializable>[];
}

function RoomProbeView({ probe }: { probe: RoomProbe }) {
  const room = useRoom();
  probe.room = room;
  useEffect(() => room.onMessage((m) => void probe.received.push(m)), [room, probe]);
  return null;
}

function joinRooms(transport: RoomTransport, count: number): RoomProbe[] {
  const probes: RoomProbe[] = [];
  for (let i = 0; i < count; i++) {
    const probe: RoomProbe = { room: null, received: [] };
    probes.push(probe);
    render(
      <Room signallingServerUrl="memory" roomId="room" transport={transport}>
        <RoomProbeView probe={probe} />
      </Room>
    );
  }
  return probes;
}

async function waitForMesh(probes: RoomProbe[]) {
  await waitFor(() => {
    for (const p of probes) expect(p.room?.connectedPeers).toHaveLength(probes.length - 1);
  });
}

const send = (room: RoomApi | null, data: JSONSerializable) =>
  room?.broadcast({ senderId: room.peerId, data, timestamp: Date.now() });

describe('memory transport', () => {
  it('connects a room and delivers broadcasts and direct messages', async () => {
    const net = createMemoryNetwork();
    const [a, b, c] = joinRooms(net.transport, 3);
    await waitForMesh([a, b, c]);
    expect(a.room?.peerId).toBe('peer-0001');
    expect(net.members('room')).toEqual(['peer-0001', 'peer-0002', 'peer-0003']);

    send(a.room, { hello: 'world' });
    a.room?.sendToPeer('peer-0003', { senderId: 'peer-0001', data: 'direct', timestamp: 0 });
    await waitFor(() => expect(c.received).toHaveLength(2));
    expect(b.received.map((m) => m.data)).toEqual([{ hello: 'world' }]);
    expect(c.received.map((m) => m.data)).toEqual([{ hello: 'world' }, 'direct']);
    expect(c.received[0].senderId).toBe('peer-0001');
  });

  it('chunks messages larger than the maximum message size', async () => {
    const net = createMemoryNetwork({ maxMessageSize: 1024 });
    const [a, b] = joinRooms(net.transport, 2);
    await waitForMesh([a, b]);
    const big = 'aé😀€'.repeat(5000);
    send(a.room, { big });
    send(a.room, 'after');
    await waitFor(() => expect(b.received).toHaveLength(2));
    expect(b.received.map((m) => m.data)).toEqual([{ big }, 'after']);
  });

  it('serialises a broadcast once, whatever the number of peers', async () => {
    const net = createMemoryNetwork();
    const [a, b, c] = joinRooms(net.transport, 3);
    await waitForMesh([a, b, c]);
    const toJSON = vi.fn(() => 'value');
    send(a.room, { counted: { toJSON } as unknown as JSONSerializable });
    await waitFor(() => expect(c.received).toHaveLength(1));
    expect(b.received[0].data).toEqual({ counted: 'value' });
    expect(toJSON).toHaveBeenCalledTimes(1);
  });

  it('flags peers on another protocol version and leaves them out of the room', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = createMemoryNetwork({
      protocolOf: (joinIndex) => (joinIndex === 3 ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION),
    });
    const [a, b, c] = joinRooms(net.transport, 3);
    await waitFor(() => {
      for (const p of [a, b]) {
        expect(p.room?.incompatiblePeers).toEqual(['peer-0003']);
        expect(p.room?.peers).toEqual(['peer-0001', 'peer-0002']);
        expect(p.room?.connectedPeers).toHaveLength(1);
      }
      expect(c.room?.incompatiblePeers?.slice().sort()).toEqual(['peer-0001', 'peer-0002']);
      expect(c.room?.peers).toEqual(['peer-0003']);
    });
    send(a.room, 'only b');
    send(c.room, 'nobody');
    await waitFor(() => expect(b.received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.received).toHaveLength(0);
    expect(a.received).toHaveLength(0);
  });

  it('keeps sending to the other peers when one peer fails', async () => {
    const net = createMemoryNetwork();
    const failing: RoomTransport = {
      createSignaling: net.transport.createSignaling,
      createPeer: (options) => {
        const link = net.transport.createPeer(options);
        if (options.remotePeerId !== 'peer-0002') return link;
        return {
          handleSignal: (data) => link.handleSignal(data),
          close: () => link.close(),
          send: () => {
            throw new Error('channel closed');
          },
        };
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [a, b, c] = joinRooms(failing, 3);
    await waitForMesh([a, b, c]);
    send(a.room, 'still delivered');
    await waitFor(() => expect(c.received).toHaveLength(1));
    expect(b.received).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('send to peer-0002 failed'),
      expect.any(Error)
    );
  });
});

// ---------------------------------------------------------------------
// Lobby → match → host drop → migration, over the memory transport
// ---------------------------------------------------------------------

interface ToyState {
  tick: number;
  sum: number;
  hash: number;
}

const initToy = (): ToyState => ({ tick: 0, sum: 0, hash: 2166136261 });

/** Deterministic: the state at tick N depends only on the state before and the inputs. */
function stepToy(state: ToyState, inputs: PlayerInput<number>[]): ToyState {
  let sum = state.sum;
  for (const { input } of inputs) sum += input;
  const tick = state.tick + 1;
  let hash = Math.imul(state.hash ^ tick, 16777619) >>> 0;
  hash = Math.imul(hash ^ sum, 16777619) >>> 0;
  return { tick, sum, hash };
}

function replay(state: ToyState, steps: number): ToyState {
  let s = state;
  for (let i = 0; i < steps; i++) s = stepToy(s, []);
  return s;
}

const isNumber = (d: unknown): d is number => typeof d === 'number';
const isToyState = (d: unknown): d is ToyState =>
  typeof d === 'object' && d !== null && isNumber((d as ToyState).hash);

interface PlayerProbe {
  room: RoomApi | null;
  lobby: UseLobbyResult<undefined> | null;
  sim: {
    getState: () => ToyState;
    dispatch: (input: number) => void;
    isHost: boolean;
  } | null;
  /** Every tick this peer rendered, to check it never went back. */
  ticks: number[];
}

function Match({ players, probe }: { players: string[]; probe: PlayerProbe }) {
  const sim = useHostedSimulation<ToyState, number>('toy', {
    players,
    init: initToy,
    step: stepToy,
    validateInput: isNumber,
    validateState: isToyState,
    dt: 0.02,
    migrationGraceMs: 200,
  });
  probe.sim = sim;
  probe.ticks.push(sim.getState().tick);
  return null;
}

function Player({ probe }: { probe: PlayerProbe }) {
  const room = useRoom();
  const lobby = useLobby();
  probe.room = room;
  probe.lobby = lobby;
  return lobby.match ? <Match players={lobby.match.players} probe={probe} /> : null;
}

describe('hosted simulation over the memory transport', () => {
  it('migrates to the next host after the host drops, continuing the same state', async () => {
    const net = createMemoryNetwork({ maxMessageSize: 4096 });
    const probes: PlayerProbe[] = [];
    for (let i = 0; i < 3; i++) {
      const probe: PlayerProbe = { room: null, lobby: null, sim: null, ticks: [] };
      probes.push(probe);
      render(
        <Room signallingServerUrl="memory" roomId="match" transport={net.transport}>
          <Player probe={probe} />
        </Room>
      );
    }
    const [a, b, c] = probes;

    await waitFor(() => {
      for (const p of probes) expect(p.room?.connectedPeers).toHaveLength(2);
    });
    expect(a.lobby?.isLobbyHost).toBe(true);
    act(() => a.lobby?.start());

    // Everyone plays; the first peer hosts.
    await waitFor(() => {
      for (const p of probes) expect(p.sim?.getState().tick).toBeGreaterThan(10);
    });
    expect(a.sim?.isHost).toBe(true);

    // An input from a client reaches every peer through the host.
    c.sim?.dispatch(7);
    await waitFor(() => {
      for (const p of probes) expect(p.sim?.getState().sum).toBe(7);
    });

    // The host's network drops. Capture what the next host last adopted.
    const before = { ...(b.sim as NonNullable<PlayerProbe['sim']>).getState() };
    net.dropSignaling('peer-0001');

    await waitFor(() => {
      expect(b.sim?.isHost).toBe(true);
      expect(b.sim?.getState().tick).toBeGreaterThan(before.tick + 20);
      expect(c.sim?.getState().tick).toBeGreaterThan(before.tick + 20);
    });

    // The new host carried on from the state it had: replaying the toy step
    // from there gives exactly its current state, and the remaining client
    // follows the same history.
    for (const p of [b, c]) {
      const state = (p.sim as NonNullable<PlayerProbe['sim']>).getState();
      expect(state).toEqual(replay(before, state.tick - before.tick));
    }
    // No peer ever rolled back.
    for (const p of [b, c]) {
      for (let i = 1; i < p.ticks.length; i++) {
        expect(p.ticks[i]).toBeGreaterThanOrEqual(p.ticks[i - 1]);
      }
    }
    // The dropped host is cut off and holds instead of simulating alone.
    const frozen = a.sim?.getState().tick;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.room?.isConnected).toBe(false);
    expect(a.sim?.getState().tick).toBe(frozen);
  });
});

// ---------------------------------------------------------------------
// A large state: compressed keyframes and deltas reproduce the host's state
// ---------------------------------------------------------------------

interface World {
  tick: number;
  nextId: number;
  units: Record<string, { id: string; pos: { q: number; r: number }; hp: number; path?: number[] }>;
}

function initWorld(): World {
  const world: World = { tick: 0, nextId: 0, units: {} };
  for (let i = 0; i < 300; i++) addUnit(world);
  return world;
}

function addUnit(world: World) {
  const id = `u${world.nextId++}`;
  const n = world.nextId;
  world.units[id] = { id, pos: { q: n % 17, r: n % 23 }, hp: 30, path: [n, n + 1, n + 2, n + 3] };
}

/** Mutates in place, like territile's sim: a few units move, one dies, one spawns. */
function stepWorld(world: World) {
  world.tick++;
  const ids = Object.keys(world.units);
  for (let i = world.tick % 7; i < ids.length; i += 7) {
    const unit = world.units[ids[i]];
    unit.pos.q++;
    unit.path?.shift();
    if (unit.path?.length === 0) delete unit.path;
  }
  if (world.tick % 3 === 0) delete world.units[ids[0]];
  if (world.tick % 2 === 0) addUnit(world);
}

describe('snapshot deltas over the memory transport', () => {
  it('a client holds exactly what the host held at that tick', async () => {
    const history = new Map<number, string>();
    const net = createMemoryNetwork({ maxMessageSize: 16 * 1024 });
    const probes: { room: RoomApi | null; getState: (() => World) | null }[] = [];

    function WorldMatch({ players, probe }: { players: string[]; probe: (typeof probes)[0] }) {
      const sim = useHostedSimulation<World, number>('world', {
        players,
        init: initWorld,
        step: (state) => {
          stepWorld(state);
          history.set(state.tick, JSON.stringify(state));
        },
        validateInput: isNumber,
        dt: 0.02,
        keyframeInterval: 0.2,
        migrationGraceMs: 100,
      });
      probe.getState = sim.getState;
      return null;
    }
    function WorldPlayer({ probe }: { probe: (typeof probes)[0] }) {
      const lobby = useLobby();
      probe.room = useRoom();
      if (lobby.isLobbyHost && lobby.phase === 'lobby' && lobby.players.length === 2) {
        queueMicrotask(() => lobby.start());
      }
      return lobby.match ? <WorldMatch players={lobby.match.players} probe={probe} /> : null;
    }

    for (let i = 0; i < 2; i++) {
      const probe = { room: null, getState: null };
      probes.push(probe);
      render(
        <Room signallingServerUrl="memory" roomId="world" transport={net.transport}>
          <WorldPlayer probe={probe} />
        </Room>
      );
    }
    const [, b] = probes;
    await waitFor(() => expect(b.getState?.().tick).toBeGreaterThan(40), { timeout: 4000 });
    const state = (b.getState as () => World)();
    expect(JSON.stringify(state)).toBe(history.get(state.tick));
  });
});
