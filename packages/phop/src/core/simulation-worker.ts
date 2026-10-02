import { channelMessageText } from './channel';
import type { HostedSimulationOptions, PlayerInput } from './HostedSimulation';
import { defaultGetId, diffJson, type JsonPatch, type JsonValue } from './json-diff';
import { COMPRESS_MIN_LENGTH, canDeflate, deflateText } from './wire';

/**
 * Running a hosted simulation's host loop in a Web Worker.
 *
 * While its peer is host, the worker holds the authoritative state: the main
 * thread starts it with the state (on promotion, and again on adopting a
 * handover), forwards every input, and tells it when to run or hold (the
 * migration grace, a cut-off). The worker steps on its own timer (dedicated
 * worker timers keep running in hidden tabs) and, after each stepping frame,
 * posts a frame: the changes since its previous frame, for the main thread
 * to apply to its copy of the state the way a receiver applies a delta, and
 * the snapshot message for peers, serialised and compressed. On demotion the
 * main thread stops the worker and hands over its copy of the state.
 *
 * Frames carry the term they were started in; the main thread ignores those
 * of an earlier term, so a frame still in flight when the worker is stopped
 * or restarted was never published to anyone.
 */

/** The worker side's tuning, from the main thread's options. */
export interface WorkerConfig {
  dt: number;
  loopIntervalMs: number;
  maxFrameDelta: number;
  maxCatchUp: number;
  keyframeInterval: number;
  /** Encode snapshot messages for peers (false in a solo match). */
  broadcast: boolean;
  /** Our peer id: the snapshots' `hostId` and the messages' sender. */
  hostId: string;
  /** The snapshot channel's name. */
  channel: string;
}

/** Main thread to worker. */
export type ToWorker<TState, TInput> =
  /** Take authority with `state` at `tick`, numbering snapshots on from `seq`. Keeps queued inputs. */
  | { type: 'start'; term: number; state: TState; tick: number; seq: number; config: WorkerConfig }
  | { type: 'config'; config: WorkerConfig }
  /** Step (true) or hold (false). Held after `start`. */
  | { type: 'run'; run: boolean }
  | { type: 'input'; input: PlayerInput<TInput> }
  /** Give up authority and drop queued inputs. */
  | { type: 'stop' };

/** Worker to main thread, after each stepping frame. */
export interface WorkerFrame {
  type: 'frame';
  term: number;
  tick: number;
  seq: number;
  /** The state as JSON text, on the first frame of a term. */
  stateText?: string;
  /** Otherwise, the changes since the term's previous frame. */
  patch?: JsonPatch;
  /** The snapshot message for peers, from `channelMessageText`. */
  message?: string;
  /** `message` is a delta (whose base is the previous frame's snapshot). */
  delta?: boolean;
  /** `message` as deflate-raw bytes, when it is long enough to be compressed. */
  deflated?: Uint8Array<ArrayBuffer>;
}

export function isWorkerFrame(data: unknown): data is WorkerFrame {
  return typeof data === 'object' && data !== null && (data as WorkerFrame).type === 'frame';
}

/**
 * The worker as the main thread uses it. A `Worker` satisfies it; tests may
 * pass anything with the same surface.
 */
export interface SimulationWorker {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  terminate(): void;
}

/** The worker's global scope as `createHostedSimulationWorker` uses it. */
export interface SimulationWorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** What the worker module provides: the stepping half of `HostedSimulationOptions`. */
export interface HostedSimulationWorkerOptions<TState, TInput> {
  /** As `HostedSimulationOptions.step`. */
  step: HostedSimulationOptions<TState, TInput>['step'];
  /** As `HostedSimulationOptions.isRunning`. */
  isRunning?: (state: TState) => boolean;
  /** As `HostedSimulationOptions.getId`. */
  getId?: HostedSimulationOptions<TState, TInput>['getId'];
}

/**
 * Serve a hosted simulation's host loop from this worker. Call it once in
 * the worker module that `HostedSimulationOptions.worker` starts:
 *
 * ```ts
 * // sim.worker.ts
 * import { createHostedSimulationWorker } from '@peterddod/phop/worker';
 * createHostedSimulationWorker({ step, isRunning });
 * ```
 *
 * `step`, `isRunning` and `getId` replace the main thread's while the worker
 * runs, so they must behave the same. Returns a function that stops serving.
 */
export function createHostedSimulationWorker<TState, TInput>(
  options: HostedSimulationWorkerOptions<TState, TInput>,
  scope: SimulationWorkerScope = globalThis as unknown as SimulationWorkerScope
): () => void {
  const sim = new WorkerSimulation(options, (frame) => scope.postMessage(frame));
  const onMessage = (event: MessageEvent) => sim.handle(event.data as ToWorker<TState, TInput>);
  scope.addEventListener('message', onMessage);
  return () => {
    scope.removeEventListener('message', onMessage);
    sim.handle({ type: 'stop' });
  };
}

/** The worker side: `HostedSimulation`'s stepping loop and snapshot encoding. */
class WorkerSimulation<TState, TInput> {
  private state: TState | null = null;
  private config: WorkerConfig | null = null;
  private term = 0;
  private tick = 0;
  private seq = 0;
  private queue: PlayerInput<TInput>[] = [];
  private running = false;
  private accumulator = 0;
  private lastTime: number | null = null;
  // Our last frame's state as JSON gives it to receivers: the base of the next.
  private sent: { seq: number; state: JsonValue } | null = null;
  private keyframeTick = 0;
  private timer: { id: ReturnType<typeof setInterval>; intervalMs: number } | null = null;
  // Frames go out in order, each after the compression of the ones before.
  private posting: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: HostedSimulationWorkerOptions<TState, TInput>,
    private readonly post: (frame: WorkerFrame) => void
  ) {}

  handle(message: ToWorker<TState, TInput>): void {
    switch (message.type) {
      case 'start':
        this.state = message.state;
        this.term = message.term;
        this.tick = message.tick;
        this.seq = message.seq;
        this.sent = null;
        this.running = false;
        this.lastTime = null;
        this.accumulator = 0;
        this.configure(message.config);
        break;
      case 'config':
        this.configure(message.config);
        break;
      case 'run':
        this.running = message.run;
        break;
      case 'input':
        if (this.state !== null) this.queue.push(message.input);
        break;
      case 'stop':
        this.state = null;
        this.queue = [];
        this.running = false;
        this.sent = null;
        if (this.timer) clearInterval(this.timer.id);
        this.timer = null;
        break;
    }
  }

  private configure(config: WorkerConfig): void {
    this.config = config;
    if (this.timer?.intervalMs === config.loopIntervalMs) return;
    if (this.timer) clearInterval(this.timer.id);
    this.timer = {
      id: setInterval(() => this.frame(performance.now()), config.loopIntervalMs),
      intervalMs: config.loopIntervalMs,
    };
  }

  /** `HostedSimulation.frame` for a host that is free to step. */
  private frame(t: number): void {
    const config = this.config;
    if (this.state === null || config === null) return;
    let state: TState = this.state;
    if (!this.running || (this.options.isRunning && !this.options.isRunning(state))) {
      this.lastTime = t;
      this.accumulator = 0;
      return;
    }
    if (this.lastTime === null) {
      this.lastTime = t;
      return;
    }
    const rawDelta = (t - this.lastTime) / 1000;
    this.lastTime = t;
    this.accumulator = Math.min(
      this.accumulator + Math.min(rawDelta, config.maxFrameDelta),
      config.maxCatchUp
    );

    const dt = config.dt;
    let stepped = false;
    try {
      while (this.accumulator >= dt) {
        // Inputs land on the first sub-step only.
        const inputs = stepped ? [] : this.queue.splice(0);
        const next = this.options.step(state, inputs, dt);
        if (next !== undefined) {
          state = next;
          this.state = next;
        }
        this.tick++;
        this.accumulator -= dt;
        stepped = true;
      }
    } catch (error) {
      // Like a throw on the main thread: the frame ends, the next one retries.
      console.error('phop: the simulation step failed:', error);
    }
    if (stepped) this.publish(config);
  }

  private publish(config: WorkerConfig): void {
    const text = JSON.stringify(this.state);
    const state = JSON.parse(text) as JsonValue;
    const prev = this.sent;
    const tick = this.tick;
    const seq = ++this.seq;
    const getId = this.options.getId ?? defaultGetId;
    const patch = prev === null ? null : diffJson(prev.state, state, getId);
    this.sent = { seq, state };

    const frame: WorkerFrame = { type: 'frame', term: this.term, tick, seq };
    if (patch === null) frame.stateText = text;
    else frame.patch = patch;

    if (config.broadcast) {
      const { hostId, keyframeInterval } = config;
      let data: string;
      // A term starts with a keyframe: what peers hold is no base for it.
      if (
        prev === null ||
        patch === null ||
        keyframeInterval <= 0 ||
        tick - this.keyframeTick >= Math.max(1, Math.round(keyframeInterval / config.dt))
      ) {
        this.keyframeTick = tick;
        data = `{"hostId":${JSON.stringify(hostId)},"tick":${tick},"seq":${seq},"state":${text}}`;
      } else {
        data = JSON.stringify({ hostId, tick, seq, base: prev.seq, patch });
        frame.delta = true;
      }
      frame.message = channelMessageText(hostId, config.channel, data);
    }

    const message = frame.message;
    this.posting = this.posting.then(async () => {
      if (message !== undefined && message.length >= COMPRESS_MIN_LENGTH && canDeflate()) {
        try {
          frame.deflated = await deflateText(message);
        } catch {
          // The main thread compresses it instead.
        }
      }
      this.post(frame);
    });
  }
}
