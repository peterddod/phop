import { type Channel, type ChannelRoom, createChannel } from './channel';
import { electHost, isCutOff, presentCandidates, shouldAdoptSnapshot } from './host-election';
import { startTicker } from './ticker';

/** The room surface a hosted simulation needs. `RoomContextValue` satisfies it. */
export interface SimulationRoom extends ChannelRoom {
  peers: string[];
  isConnected: boolean;
}

export interface PlayerInput<TInput> {
  /** Always the transport sender, never taken from the payload. */
  playerId: string;
  input: TInput;
}

export interface HostedSimulationOptions<TState, TInput> {
  /** Frozen match roster, including self. These are the host candidates. */
  players: string[];
  /** Initial state. Must be deterministic: every peer calls it independently. */
  init: () => TState;
  /** Advance the state by `dt` seconds. May mutate `state` or return a new one. */
  // biome-ignore lint/suspicious/noConfusingVoidType: allows in-place steppers that return nothing.
  step: (state: TState, inputs: PlayerInput<TInput>[], dt: number) => TState | void;
  /** Guards inputs arriving from peers. */
  validateInput: (data: unknown) => data is TInput;
  /** Guards snapshot states arriving from peers. */
  validateState?: (data: unknown) => data is TState;
  /** Fixed step in seconds. Default 0.1. */
  dt?: number;
  /** Loop heartbeat in ms. Default half of `dt`. */
  loopIntervalMs?: number;
  /** Largest wall-clock gap counted per frame, in seconds. Default 0.25. */
  maxFrameDelta?: number;
  /** Most sim time caught up at once, in seconds. Default 1. */
  maxCatchUp?: number;
  /** How long a newly promoted host holds before stepping, in ms. Default 1000. */
  migrationGraceMs?: number;
  /**
   * What the host does about a player missing from the room: after
   * `timeoutMs`, `toInput` may return an input (e.g. a resignation) that is
   * applied on that player's behalf.
   */
  absence?: {
    timeoutMs: number;
    toInput: (playerId: string, state: TState) => TInput | null;
  };
  /**
   * Whether a player still counts as playing. Inactive players are ignored
   * by the cut-off guard and absence handling. Default: always active.
   */
  isActive?: (state: TState, playerId: string) => boolean;
}

interface Snapshot<TState> {
  hostId: string;
  tick: number;
  state: TState;
}

const now = () => performance.now();

/**
 * Host-authoritative fixed-step simulation.
 *
 * Every peer builds the same initial state. The elected host (lowest-sorted
 * present player) runs the loop, applies local and remote inputs, and
 * broadcasts a snapshot after each stepping frame. Other peers forward inputs
 * to the host and adopt its snapshots.
 *
 * Host changes are handled without rollback: a promoted host waits for a
 * short grace period and accepts a handover snapshot from the previous host
 * if that is ahead of its own state. A host that looks cut off (signalling
 * lost, or every rival gone at once) holds instead of simulating alone.
 *
 * Framework-agnostic; `useHostedSimulation` binds it to React.
 */
export class HostedSimulation<TState, TInput> {
  private room: SimulationRoom;
  private options: HostedSimulationOptions<TState, TInput>;
  private readonly players: string[];

  private state: TState;
  private tick = 0;
  private lastAppliedTick = -1;
  private localQueue: TInput[] = [];
  private remoteQueue: PlayerInput<TInput>[] = [];
  private graceUntil = 0;
  // While open, a freshly promoted host accepts the previous host's handover.
  private handoverUntil = 0;
  private readonly absentSince = new Map<string, number>();
  private readonly absenceHandled = new Set<string>();
  private hostId: string | null = null;
  private wasHost = false;
  // Host that can't see the room (signalling lost, or every rival gone).
  private cutOff = false;

  private accumulator = 0;
  private lastTime: number | null = null;

  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly inputChannel: Channel<TInput>;
  private readonly snapshotChannel: Channel<Snapshot<TState>>;
  private cleanups: (() => void)[] = [];

  constructor(key: string, options: HostedSimulationOptions<TState, TInput>, room: SimulationRoom) {
    this.room = room;
    this.options = options;
    this.players = [...options.players];
    this.state = options.init();

    const self = this;
    const liveRoom: ChannelRoom = {
      get peerId() {
        return self.room.peerId;
      },
      broadcast: (message) => this.room.broadcast(message),
      sendToPeer: (peerId, message) => this.room.sendToPeer(peerId, message),
      onMessage: (handler) => this.room.onMessage(handler),
    };
    this.inputChannel = createChannel(liveRoom, `${key}:input`, (data): data is TInput =>
      this.options.validateInput(data)
    );
    this.snapshotChannel = createChannel(liveRoom, `${key}:snapshot`, this.isSnapshot);
    this.hostId = this.electHost();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  getState = (): TState => this.state;

  getTick = (): number => this.tick;

  getHostId = (): string | null => this.hostId;

  /** Changes whenever the state does. For `useSyncExternalStore`. */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Queue an input as the local player. Dropped if no host is present. */
  dispatch = (input: TInput): void => {
    const host = this.hostId;
    if (host === this.room.peerId) {
      this.localQueue.push(input);
    } else if (host !== null) {
      this.inputChannel.send(host, input);
    }
  };

  /** Subscribe to messages and start the loop. Safe to call after `stop()`. */
  start(): void {
    if (this.cleanups.length > 0) return;
    this.lastTime = null;
    this.accumulator = 0;
    this.cleanups.push(
      this.inputChannel.subscribe(this.handleInput),
      this.snapshotChannel.subscribe(this.handleSnapshot),
      startTicker(this.options.loopIntervalMs ?? this.dt * 500, (t) => this.frame(t))
    );
    this.updateHost();
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  /** Push the latest room fields in. Call whenever the room changes. */
  syncRoom(room: SimulationRoom): void {
    this.room = room;
    this.updateHost();
  }

  /** Update callbacks and tuning. `players` and `init` are read only once. */
  setOptions(options: HostedSimulationOptions<TState, TInput>): void {
    this.options = options;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private get dt(): number {
    return this.options.dt ?? 0.1;
  }

  private get isMultiplayer(): boolean {
    return this.players.length > 1;
  }

  private isActive(playerId: string): boolean {
    return this.options.isActive?.(this.state, playerId) ?? true;
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private electHost(): string | null {
    return electHost(
      this.players,
      presentCandidates(this.players, this.room.peerId, this.room.peers)
    );
  }

  /**
   * Recompute the host and act on transitions.
   *
   * Promotion, or a host reconnecting after being cut off: arm the grace (so
   * in-flight snapshots settle) and the handover window, and drop remote
   * inputs queued before, since they were aimed at an earlier authority's
   * tick. A cut-off host never lost host status in its own view, so without
   * the reconnect case it would reject the handover and roll the match back.
   * Demotion: hand our state to the new host, which adopts it if it is ahead.
   * Any host change: reset the snapshot-tick guard, since the new host may be
   * slightly behind the one we last followed.
   */
  private updateHost(): void {
    const self = this.room.peerId;
    const prevHost = this.hostId;
    const host = this.electHost();
    this.hostId = host;
    const isHost = host !== null && host === self;
    const cutOff =
      isHost &&
      this.isMultiplayer &&
      (!this.room.isConnected ||
        isCutOff(
          this.players,
          self,
          this.room.peers,
          new Set(this.players.filter((p) => this.isActive(p)))
        ));
    const reconnected = this.cutOff && !cutOff;
    this.cutOff = cutOff;

    if (isHost && (!this.wasHost || reconnected) && this.isMultiplayer) {
      const until = now() + (this.options.migrationGraceMs ?? 1000);
      this.graceUntil = until;
      this.handoverUntil = until;
      this.remoteQueue = [];
    }
    if (!isHost && host !== prevHost) {
      this.lastAppliedTick = -1;
    }
    if (!isHost && this.wasHost && host !== null && this.isMultiplayer) {
      this.snapshotChannel.send(host, { hostId: self, tick: this.tick, state: this.state });
    }
    this.wasHost = isHost;
  }

  private isSnapshot = (data: unknown): data is Snapshot<TState> => {
    if (typeof data !== 'object' || data === null) return false;
    const snap = data as Partial<Snapshot<unknown>>;
    if (typeof snap.hostId !== 'string') return false;
    if (!Number.isSafeInteger(snap.tick) || (snap.tick as number) < 0) return false;
    if (!('state' in snap)) return false;
    return this.options.validateState?.(snap.state) ?? true;
  };

  private handleInput = (input: TInput, senderId: string): void => {
    if (this.hostId !== this.room.peerId) return;
    if (!this.players.includes(senderId)) return;
    this.remoteQueue.push({ playerId: senderId, input });
  };

  private handleSnapshot = (snap: Snapshot<TState>, senderId: string): void => {
    this.updateHost();
    const adopt = shouldAdoptSnapshot({
      selfId: this.room.peerId,
      senderId,
      hostId: snap.hostId,
      currentHost: this.hostId,
      candidates: this.players,
      tick: snap.tick,
      lastAppliedTick: this.lastAppliedTick,
      ownTick: this.tick,
      handoverOpen: this.cutOff || now() < this.handoverUntil,
    });
    if (!adopt) return;
    this.state = snap.state;
    this.tick = snap.tick;
    this.lastAppliedTick = snap.tick;
    this.bump();
  };

  private hold(t: number): void {
    this.lastTime = t;
    this.accumulator = 0;
  }

  private frame(t: number): void {
    this.updateHost();
    const self = this.room.peerId;

    if (this.hostId !== self) {
      this.hold(t);
      return;
    }

    // Hold rather than simulate alone and time everyone out.
    if (this.cutOff) {
      this.hold(t);
      this.absentSince.clear();
      return;
    }

    if (now() < this.graceUntil) {
      this.hold(t);
      return;
    }

    if (this.lastTime === null) {
      this.lastTime = t;
      return;
    }

    const rawDelta = (t - this.lastTime) / 1000;
    this.lastTime = t;
    this.accumulator = Math.min(
      this.accumulator + Math.min(rawDelta, this.options.maxFrameDelta ?? 0.25),
      this.options.maxCatchUp ?? 1
    );

    if (this.isMultiplayer) this.trackAbsence(t);

    const dt = this.dt;
    let stepped = false;
    while (this.accumulator >= dt) {
      // Inputs land on the first sub-step only.
      const inputs = stepped
        ? []
        : [
            ...this.localQueue.splice(0).map((input) => ({ playerId: self, input })),
            ...this.remoteQueue.splice(0),
          ];
      const next = this.options.step(this.state, inputs, dt);
      if (next !== undefined) this.state = next;
      this.tick++;
      this.lastAppliedTick = this.tick;
      this.accumulator -= dt;
      stepped = true;
    }

    if (stepped) {
      // Once per frame: receivers only keep the newest tick, so a catch-up
      // frame with several sub-steps shouldn't send several snapshots.
      if (this.isMultiplayer) {
        this.snapshotChannel.broadcast({ hostId: self, tick: this.tick, state: this.state });
      }
      this.bump();
    }
  }

  private trackAbsence(t: number): void {
    const absence = this.options.absence;
    if (!absence) return;
    const self = this.room.peerId;
    const present = new Set([self, ...this.room.peers]);

    for (const p of this.players) {
      if (p === self) continue;
      if (present.has(p)) {
        this.absentSince.delete(p);
        this.absenceHandled.delete(p);
        continue;
      }
      const since = this.absentSince.get(p);
      if (since === undefined) {
        this.absentSince.set(p, t);
      } else if (
        t - since >= absence.timeoutMs &&
        !this.absenceHandled.has(p) &&
        this.isActive(p)
      ) {
        const input = absence.toInput(p, this.state);
        if (input !== null) this.remoteQueue.push({ playerId: p, input });
        this.absenceHandled.add(p);
      }
    }
  }
}
