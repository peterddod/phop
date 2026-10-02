import { type Channel, type ChannelRoom, createChannel } from './channel';
import { electHost, isCutOff, presentCandidates, shouldAdoptSnapshot } from './host-election';
import {
  applyJsonPatch,
  defaultGetId,
  diffJson,
  isJsonPatch,
  type JsonPatch,
  type JsonValue,
} from './json-diff';
import { startTicker } from './ticker';

/** The room surface a hosted simulation needs. `RoomContextValue` satisfies it. */
export interface SimulationRoom extends ChannelRoom {
  peers: string[];
  isConnected: boolean;
  /**
   * Peers with an open data channel, and a callback when one opens. They let
   * a host handover wait for the channel; rooms without them skip the wait.
   */
  connectedPeers?: string[];
  onPeerConnected?: (handler: (remotePeerId: string) => void) => () => void;
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
   * Whether the simulation is still advancing. Once false (e.g. the match is
   * over) the host stops stepping and broadcasting, so peers go quiet
   * instead of re-rendering an unchanged state. Default: always running.
   */
  isRunning?: (state: TState) => boolean;
  /**
   * Whether a player still counts as playing. Inactive players are ignored
   * by the cut-off guard and absence handling. Default: always active.
   */
  isActive?: (state: TState, playerId: string) => boolean;
  /**
   * Seconds of sim time between full snapshots (keyframes). In between, the
   * host sends deltas: patches against its previous snapshot, holding only
   * the fields that changed. Default 1. 0 sends a full snapshot every time.
   * Deltas need a plain JSON state (what survives a JSON round trip is
   * what peers get) that is never mutated once adopted, except by `step`.
   */
  keyframeInterval?: number;
  /**
   * Identity of an element of an array in the state, so a delta of an array
   * of entities matches elements by it instead of by position. Return
   * undefined for elements to match by position (an array is matched by
   * identity only if every element has one). `path` is the array's path
   * from the root. Default: an object element's `id`, if it is a string or
   * a number.
   */
  getId?: (item: unknown, path: (string | number)[]) => string | number | undefined;
}

/** A full state. `seq` numbers the host's snapshots, keyframes and deltas alike. */
interface Keyframe<TState> {
  hostId: string;
  tick: number;
  seq: number;
  state: TState;
}

/** The changes since the host's snapshot `base`. */
interface Delta {
  hostId: string;
  tick: number;
  seq: number;
  base: number;
  patch: JsonPatch;
}

type Snapshot<TState> = Keyframe<TState> | Delta;

const now = () => performance.now();

// A demoted host resends its handover at this interval until the new host's
// snapshots arrive, since the data channel may not be open yet.
const HANDOVER_RESEND_MS = 250;
const MIN_HANDOVER_RETRY_MS = 5000;
// A receiver missing a delta's base asks the host for a keyframe at most this often.
const RESYNC_RETRY_MS = 500;
// The host answers a peer's resync requests at most this often.
const RESYNC_ANSWER_MS = 200;

const isSeq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Host-authoritative fixed-step simulation.
 *
 * Every peer builds the same initial state. The elected host (lowest-sorted
 * present player) runs the loop, applies local and remote inputs, and
 * broadcasts a snapshot after each stepping frame. Other peers forward inputs
 * to the host and adopt its snapshots.
 *
 * Snapshots are numbered. Most are deltas against the previous one; a
 * keyframe (the full state) goes out every `keyframeInterval`, on taking
 * over as host, and to a peer whose channel opens. A receiver applies a
 * delta only on top of the snapshot it names as its base, then validates the
 * result like a keyframe. Missing the base (a dropped or superseded
 * snapshot), it asks the host for a keyframe.
 *
 * Host changes are handled without rollback: a promoted host waits for a
 * short grace period and accepts a handover snapshot from the previous host
 * (and only that peer) if it is ahead of its own state by a plausible amount.
 * The demoted host keeps resending the handover until the channel is up. A host that looks cut off (signalling
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
  // While open, a freshly promoted host accepts `handoverFrom`'s handover.
  private handoverUntil = 0;
  private handoverFrom: string | null = null;
  // Longest we hold waiting for `handoverFrom`'s channel to open.
  private handoverDeadline = 0;
  // Demoted side: the handover still to be delivered.
  private pendingHandover: { to: string; until: number; lastSent: number } | null = null;
  // When our tick last advanced; bounds how far a handover may jump.
  private lastProgressAt = now();
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
  // Keyframes for one peer (joins, resyncs), never superseded by later snapshots.
  private readonly keyframeChannel: Channel<Snapshot<TState>>;
  private readonly resyncChannel: Channel<true>;

  // Host side: our last snapshot number, and what receivers hold after our
  // last broadcast (as JSON gives it to them), the base of the next delta.
  private seq = 0;
  private sent: { seq: number; tick: number; state: JsonValue } | null = null;
  private keyframeTick = 0;
  private needKeyframe = true;
  private readonly keyframeSentAt = new Map<string, number>();
  // Receiver side: whose snapshot `state` is, by number, for applying deltas.
  private chain: { from: string; seq: number } | null = null;
  private resyncAskedAt = -Infinity;
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
      broadcast: (message, sendOptions) => this.room.broadcast(message, sendOptions),
      sendToPeer: (peerId, message, sendOptions) =>
        this.room.sendToPeer(peerId, message, sendOptions),
      onMessage: (handler) => this.room.onMessage(handler),
    };
    this.inputChannel = createChannel(liveRoom, `${key}:input`, (data): data is TInput =>
      this.options.validateInput(data)
    );
    // Only the newest snapshot matters, so a congested peer skips stale ones.
    this.snapshotChannel = createChannel(liveRoom, `${key}:snapshot`, this.isSnapshot, {
      latestOnly: true,
    });
    this.keyframeChannel = createChannel(liveRoom, `${key}:keyframe`, this.isSnapshot);
    this.resyncChannel = createChannel(liveRoom, `${key}:resync`, (d): d is true => d === true);
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
      this.keyframeChannel.subscribe(this.handleSnapshot),
      this.resyncChannel.subscribe(this.handleResync),
      this.room.onPeerConnected?.(this.handlePeerConnected) ?? (() => {}),
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

  private get graceMs(): number {
    return this.options.migrationGraceMs ?? 1000;
  }

  private get handoverRetryMs(): number {
    return Math.max(MIN_HANDOVER_RETRY_MS, 3 * this.graceMs);
  }

  /** The previous host is in the room but its channel isn't open yet. */
  private awaitingHandoverChannel(): boolean {
    const from = this.handoverFrom;
    const connected = this.room.connectedPeers;
    if (!from || !connected || now() >= this.handoverDeadline) return false;
    return this.room.peers.includes(from) && !connected.includes(from);
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
   * tick. The handover is accepted only from the peer that held authority in
   * the meantime: the host we followed, or, after a cut-off, whoever the
   * others elected without us. A cut-off host never lost host status in its
   * own view, so without the reconnect case it would roll the match back.
   * Demotion: hand our state to the new host (resent until it lands).
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
      const until = now() + this.graceMs;
      this.graceUntil = until;
      this.handoverUntil = until;
      this.handoverDeadline = now() + this.handoverRetryMs;
      this.handoverFrom = reconnected
        ? electHost(
            this.players.filter((p) => p !== self),
            presentCandidates(this.players, self, this.room.peers)
          )
        : prevHost !== self
          ? prevHost
          : null;
      this.remoteQueue = [];
      // Nothing from an earlier term is a base for peers: start with a keyframe,
      // and send none to joining peers before our first snapshot of this term.
      this.sent = null;
      this.needKeyframe = true;
    }
    if (isHost) this.chain = null;
    if (!isHost && host !== prevHost) {
      this.lastAppliedTick = -1;
      this.chain = null;
    }
    if (!isHost && this.wasHost && host !== null && this.isMultiplayer) {
      this.pendingHandover = {
        to: host,
        until: now() + this.handoverRetryMs,
        lastSent: -Infinity,
      };
      this.sendHandover();
    }
    if (this.pendingHandover && (isHost || host !== this.pendingHandover.to)) {
      this.pendingHandover = null;
    }
    this.wasHost = isHost;
  }

  private sendHandover(): void {
    const pending = this.pendingHandover;
    if (!pending) return;
    const t = now();
    if (t >= pending.until) {
      this.pendingHandover = null;
      return;
    }
    if (t - pending.lastSent < HANDOVER_RESEND_MS) return;
    pending.lastSent = t;
    try {
      this.snapshotChannel.send(pending.to, {
        hostId: this.room.peerId,
        tick: this.tick,
        seq: ++this.seq,
        state: this.state,
      });
    } catch (error) {
      console.error('phop: sending the handover failed:', error);
    }
  }

  private handlePeerConnected = (remotePeerId: string): void => {
    if (this.hostId === this.room.peerId) this.sendKeyframe(remotePeerId);
    if (this.pendingHandover?.to === remotePeerId) {
      this.pendingHandover.lastSent = -Infinity;
      this.sendHandover();
    }
    // The previous host's channel just opened: give its handover time to land.
    if (remotePeerId === this.handoverFrom && now() < this.handoverDeadline) {
      const until = now() + this.graceMs;
      this.graceUntil = Math.max(this.graceUntil, until);
      this.handoverUntil = Math.max(this.handoverUntil, until);
    }
  };

  /** Envelope checks only: a state is validated once a delta has been applied. */
  private isSnapshot = (data: unknown): data is Snapshot<TState> => {
    if (typeof data !== 'object' || data === null) return false;
    const snap = data as Partial<Keyframe<unknown> & Delta>;
    if (typeof snap.hostId !== 'string') return false;
    if (!isSeq(snap.tick) || !isSeq(snap.seq)) return false;
    if ('state' in snap) return true;
    return isSeq(snap.base) && isJsonPatch(snap.patch);
  };

  private isValidState(state: unknown): state is TState {
    return this.options.validateState?.(state) ?? true;
  }

  private handleInput = (input: TInput, senderId: string): void => {
    if (this.hostId !== this.room.peerId) return;
    if (!this.players.includes(senderId)) return;
    this.remoteQueue.push({ playerId: senderId, input });
  };

  private handleSnapshot = (snap: Snapshot<TState>, senderId: string): void => {
    this.updateHost();
    let state: TState;
    if ('state' in snap) {
      if (!this.isValidState(snap.state)) return;
      state = snap.state;
    } else {
      const chain = this.chain;
      if (!chain || chain.from !== senderId || chain.seq !== snap.base) {
        // Older than what we hold: superseded, not missing.
        if (chain?.from !== senderId || snap.seq > chain.seq) this.requestResync(senderId);
        return;
      }
      let next: unknown;
      try {
        next = applyJsonPatch(this.state as JsonValue, snap.patch);
      } catch {
        next = undefined;
      }
      if (next === undefined || !this.isValidState(next)) {
        this.chain = null;
        this.requestResync(senderId);
        return;
      }
      state = next;
    }
    const adopt = shouldAdoptSnapshot({
      selfId: this.room.peerId,
      senderId,
      hostId: snap.hostId,
      currentHost: this.hostId,
      candidates: this.players,
      tick: snap.tick,
      lastAppliedTick: this.lastAppliedTick,
      ownTick: this.tick,
      handoverFrom: now() < this.handoverUntil ? this.handoverFrom : null,
      maxHandoverTick: this.maxHandoverTick(),
    });
    if (!adopt) return;
    this.state = state;
    this.tick = snap.tick;
    this.lastAppliedTick = snap.tick;
    this.lastProgressAt = now();
    if (this.hostId === this.room.peerId) {
      // A handover: what peers hold is no base for our next snapshot.
      this.chain = null;
      this.needKeyframe = true;
    } else {
      this.chain = { from: senderId, seq: snap.seq };
    }
    // The new host's snapshots have overtaken our handover.
    this.pendingHandover = null;
    this.bump();
  };

  /** Ask the host for a keyframe, at most every `RESYNC_RETRY_MS`. */
  private requestResync(senderId: string): void {
    if (senderId !== this.hostId || senderId === this.room.peerId) return;
    const t = now();
    if (t - this.resyncAskedAt < RESYNC_RETRY_MS) return;
    this.resyncAskedAt = t;
    try {
      this.resyncChannel.send(senderId, true);
    } catch (error) {
      console.error('phop: requesting a keyframe failed:', error);
    }
  }

  private handleResync = (_: true, senderId: string): void => {
    if (this.hostId !== this.room.peerId || !this.players.includes(senderId)) return;
    this.sendKeyframe(senderId);
  };

  /** Send one peer our last snapshot in full, so our next delta applies. */
  private sendKeyframe(peerId: string): void {
    const sent = this.sent;
    if (!sent || !this.players.includes(peerId)) return;
    const t = now();
    if (t - (this.keyframeSentAt.get(peerId) ?? -Infinity) < RESYNC_ANSWER_MS) return;
    this.keyframeSentAt.set(peerId, t);
    try {
      this.keyframeChannel.send(peerId, {
        hostId: this.room.peerId,
        tick: sent.tick,
        seq: sent.seq,
        state: sent.state as TState,
      });
    } catch (error) {
      console.error('phop: sending a keyframe failed:', error);
    }
  }

  /** Broadcast a keyframe or a delta against our previous snapshot. */
  private broadcastSnapshot(): void {
    const hostId = this.room.peerId;
    const tick = this.tick;
    const seq = ++this.seq;
    const interval = this.options.keyframeInterval ?? 1;
    if (interval <= 0) {
      this.sent = null;
      this.snapshotChannel.broadcast({ hostId, tick, seq, state: this.state });
      return;
    }
    // What receivers will hold: the state through a JSON round trip. Also a
    // copy that `step` can't mutate, to diff the next snapshot against.
    const state = JSON.parse(JSON.stringify(this.state)) as JsonValue;
    const prev = this.sent;
    const keyframe =
      this.needKeyframe ||
      prev === null ||
      tick - this.keyframeTick >= Math.max(1, Math.round(interval / this.dt));
    this.sent = { seq, tick, state };
    if (keyframe) {
      this.needKeyframe = false;
      this.keyframeTick = tick;
      this.snapshotChannel.broadcast({ hostId, tick, seq, state: state as TState });
    } else {
      const getId = this.options.getId ?? defaultGetId;
      const patch = diffJson(prev.state, state, getId);
      this.snapshotChannel.broadcast({ hostId, tick, seq, base: prev.seq, patch });
    }
  }

  /** Our tick plus however many steps the other host could have run since ours stalled. */
  private maxHandoverTick = (): number => {
    const elapsed = (now() - this.lastProgressAt) / 1000 + (this.options.maxCatchUp ?? 1);
    return this.tick + Math.ceil(elapsed / this.dt) + 1;
  };

  private hold(t: number): void {
    this.lastTime = t;
    this.accumulator = 0;
  }

  private frame(t: number): void {
    this.updateHost();
    const self = this.room.peerId;

    if (this.hostId !== self) {
      this.sendHandover();
      this.hold(t);
      return;
    }

    // Hold rather than simulate alone and time everyone out.
    if (this.cutOff) {
      this.hold(t);
      this.absentSince.clear();
      return;
    }

    if (now() < this.graceUntil || this.awaitingHandoverChannel()) {
      this.hold(t);
      return;
    }

    if (this.options.isRunning && !this.options.isRunning(this.state)) {
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
      this.lastProgressAt = now();
      this.accumulator -= dt;
      stepped = true;
    }

    if (stepped) {
      // Once per frame: receivers only keep the newest tick, so a catch-up
      // frame with several sub-steps shouldn't send several snapshots.
      // A failed send must not stop the local state from being published.
      if (this.isMultiplayer) {
        try {
          this.broadcastSnapshot();
        } catch (error) {
          console.error('phop: broadcasting the snapshot failed:', error);
        }
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
