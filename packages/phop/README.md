# phop

Peer-to-peer state management for React using WebRTC. Share and sync state across browsers in real time — no backend required.
This README documents usage only; it does not affect runtime behavior.

> ⚠️ **Early Development** — P2P synchronization features are under active development

## Installation

```bash
npm install @peterddod/phop
```

## Usage

Wrap your app in a `<Room>` provider and connect to a signaling server:

```tsx
import { Room, useRoom, useSharedState } from '@peterddod/phop';

function App() {
  return (
    <Room signallingServerUrl="wss://your-signalling-server" roomId="my-room">
      <Counter />
    </Room>
  );
}

function Counter() {
  const [count, setCount] = useSharedState('count', 0);

  return (
    <button onClick={() => setCount((prev) => (prev ?? 0) + 1)}>
      Count: {count}
    </button>
  );
}
```

State updates in `useSharedState` are automatically broadcast to all peers in the room and merged using a configurable conflict resolution strategy.

## API

### `<Room>`

Establishes a WebRTC mesh with all peers in the given room.

| Prop | Type | Description |
|------|------|-------------|
| `signallingServerUrl` | `string` | WebSocket URL of the signaling server |
| `roomId` | `string` | Room identifier — peers sharing a room ID connect to each other |
| `rtcConfig` | `RTCConfiguration?` | WebRTC config, e.g. TURN servers. Defaults to Google STUN |
| `maxBufferedAmount` | `number?` | Bytes queued on a peer's data channel above which coalescable messages (such as `useHostedSimulation` snapshots) are held back, keeping only the newest. Default 256 KiB |
| `transport` | `RoomTransport?` | How peers connect. Defaults to WebRTC with the signalling server; see [Testing without a network](#testing-without-a-network) |
| `metadata` | `PeerMetadata?` | A small JSON object every peer sees in `peerInfo`, e.g. `{ buildId, name }`; see **Peer metadata** below |

**Sending.** A broadcast is serialised once for all peers, and a peer whose send fails is logged and skipped without affecting the rest. Messages of 2 KB or more are compressed (deflate-raw via `CompressionStream`) and sent as binary frames, keeping their order with the messages around them. Messages larger than the data channel's maximum message size (`RTCSctpTransport.maxMessageSize`, 256 KiB if unknown) are split into chunks and reassembled in order on arrival, so a large state never fails to send. A message sent with `{ coalesce: key }` (the optional last argument of `broadcast` and `sendToPeer`) is held while that peer's channel has more than `maxBufferedAmount` bytes queued; a newer message with the same key replaces it, and the newest is sent once the channel drains. Add `supersede: () => text` (a serialised `Message`) for a message that builds on the one before it: a peer for whom it replaces a held message gets that text instead.

**Protocol version.** Each peer's first frame on a data channel names its wire protocol version (`PROTOCOL_VERSION`, exported). A peer on another version, including phop 1.x, is left out of `peers` and listed in `incompatiblePeers` instead, and nothing is exchanged with it. Messages to a peer are held until its hello arrives (the handshake is acknowledged, so a lost hello is recovered), and `connectedPeers`/`onPeerConnected` report a peer only after that. Every player in a room must run a phop release with the same protocol version; show `incompatiblePeers` to tell users who needs to update.

**Peer metadata.** `metadata` travels with the hello, so every peer learns it as soon as the data channel opens, and is sent again whenever its value changes (it is compared by value, so passing a new object each render is fine). `useRoom().peerInfo` maps each peer id (self, and every remote peer whose hello has arrived, incompatible ones included) to `{ protocol, metadata }`: its wire protocol version and its metadata, or `null` if it published none. Metadata must be a JSON object of at most `MAX_METADATA_LENGTH` (1024) characters as JSON; anything else is logged and not published, and a peer's metadata that breaks those rules reads as `null`. It is untrusted: validate it before use (`useLobby` takes a `validateMetadata` guard). The hello's version and metadata fields keep their meaning in every release, so a peer on another protocol version still shows its version and metadata (peers on releases before metadata show none, and a hello too long for this release shows its version without metadata), which lets an app tell its users (or itself) that a newer build is in the room:

```tsx
<Room signallingServerUrl={url} roomId={roomId} metadata={{ buildId: BUILD_ID, name }}>

const { peerInfo } = useRoom();
const newer = Object.values(peerInfo).some((p) => isNewerBuild(p.metadata?.buildId, BUILD_ID));
```

### `useSharedState(key, initialValue, strategy?)`

Shared state hook — works like `useState` but syncs across all peers in the room. Best for simple, single-value state.

```ts
const [value, setValue] = useSharedState<T>(
  key: string,
  initialValue: T,
  strategy?: MergeStrategy
);

setValue(nextValue);
setValue((prev) => deriveNext(prev));
```

### `createSharedStore(key, initializer, options?)`

Define a Zustand-style store that syncs across peers. Define at module scope, use inside a `<Room>`.

```tsx
import { createSharedStore } from '@peterddod/phop';

const useCounterStore = createSharedStore('counter', (set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
}));

function Counter() {
  const count = useCounterStore((s) => s.count);
  const increment = useCounterStore((s) => s.increment);
  return <button onClick={increment}>Count: {count}</button>;
}
```

By default, `createSharedStore` syncs the state returned by `partialize` (or all non-function fields if `partialize` is omitted). You only need `partialize` when you want to explicitly control the synced slice or your state includes non-JSON-serializable values.

```ts
type State = { count: number; increment: () => void };
type Synced = { count: number };

const useStore = createSharedStore<State, Synced>('key', (set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
}), {
  partialize: (s) => ({ count: s.count }),
});
```

A custom `MergeStrategy` can be passed via `options.strategy`. The default is a Lamport logical clock.

#### `useSharedState` vs `createSharedStore`

| | `useSharedState` | `createSharedStore` |
|---|---|---|
| **Mental model** | `useState` | Zustand `create` |
| **Scope** | One value per key | Object with actions |
| **Selectors** | No | Yes — fine-grained re-renders |
| **Best for** | Simple shared values | App-level shared state with logic |

### `useRoom()`

Access room metadata and low-level messaging.

```ts
const {
  peerId,
  peers,          // signalling membership, deduplicated, including self
  remotePeers,    // peers without self
  connectedPeers, // remote peers with an open data channel
  incompatiblePeers, // peers on another protocol version, left out of `peers`
  peerInfo,       // { [peerId]: { protocol, metadata } }, see "Peer metadata"
  isConnected,    // signalling connection is up (see below)
  broadcast,
  sendToPeer,
  onMessage,
  onPeerConnected,
  onPeerDisconnected,
} = useRoom();
```

If the signalling connection drops, `isConnected` becomes `false`, `peers` shrinks to self and every data channel closes. The room does not reconnect by itself: remount `<Room>` (for example by changing its React `key`) to join again, which gives you a new `peerId`.

### `useChannel(name, validate)`

Typed, validated messaging on a named channel. Incoming data is untrusted: messages that fail `validate` are dropped, and the sender id always comes from the transport.

```ts
type Chat = { text: string };
const isChat = (d: unknown): d is Chat =>
  typeof d === 'object' && d !== null && typeof (d as Chat).text === 'string';

const chat = useChannel('chat', isChat);
useEffect(() => chat.subscribe((msg, senderId) => console.log(senderId, msg.text)), [chat]);
chat.broadcast({ text: 'hi' });
chat.send(peerId, { text: 'just you' });
```

`createChannel(room, name, validate, options?)` does the same outside React. With `{ latestOnly: true }` each message supersedes the previous one, so a congested peer is sent only the newest (see **Sending** under `<Room>`); `send` and `broadcast` take an optional last argument, sent instead to a peer for whom the message replaced a held one.

### `useHost(options?)`

Deterministic host election: the lowest-sorted candidate currently in the room. Every peer agrees without exchanging messages, and the host moves on when it leaves.

```ts
const { hostId, isHost } = useHost();                       // anyone in the room
const { hostId, isHost } = useHost({ candidates: roster }); // restricted
```

The pure `electHost`, `presentCandidates` and `isCutOff` helpers are exported too.

### `useLobby(key?, options?)`

A pre-match lobby. The lobby host starts the match, and every peer freezes the same roster.

```tsx
const { phase, players, isLobbyHost, start, match, peerInfo } = useLobby<{ seed: string }>();

if (phase === 'in-progress') return <p>Match already started</p>;
if (phase === 'lobby') return isLobbyHost ? <button onClick={() => start({ seed })}>Start</button> : <p>Waiting…</p>;
return <Game players={match.players} seed={match.config.seed} />;
```

Peers who connect once a match is running land in `in-progress`. Pass `validateConfig` to guard the start config. `peerInfo` is `useRoom().peerInfo` (each peer's protocol version and [metadata](#room)); with `validateMetadata` (the second type parameter, `useLobby<Config, Meta>`; it may be passed inline, and is read when peer info changes), metadata that fails it reads as `null`. Lobby messages are accepted only from the host of the roster they carry, as seen from your own view of the room.

### `useHostedSimulation(key, options)`

A host-authoritative, fixed-step simulation, suited to games. Every peer builds the same initial state. The elected host runs the loop, applies everyone's inputs and broadcasts snapshots, and the other peers forward their inputs and adopt the snapshots.

```ts
const { getState, dispatch, tick, version, isHost, hostId } = useHostedSimulation<State, Command>('match', {
  players: match.players,              // frozen roster, including self
  init: () => createInitialState(seed), // must be deterministic
  step: (state, inputs, dt) => advance(state, inputs, dt), // mutate or return new state
  validateInput: isCommand,
  validateState: isState,               // optional snapshot guard
  absence: { timeoutMs: 10_000, toInput: () => ({ type: 'resign' }) },
  isActive: (state, id) => !state.players[id]?.eliminated,
  isRunning: (state) => state.status === 'running', // stop stepping once over
});
```

- **Host migration.** When the host leaves, the next player takes over after a short grace period (`migrationGraceMs`, default 1000). A demoted host hands its state to the new host, resending until the data channel is open, so a returning host never rolls the match back; its own inputs it hadn't stepped yet follow to the new host, in order, once that channel is open. The new host accepts that handover only from the peer that held authority in between, and only if its tick is plausible.
- **Cut-off guard.** A host that sees every remaining rival vanish at once pauses instead of simulating alone, and resumes if they reappear. A host that loses the signalling server stops for good (see `useRoom`).
- **Snapshot deltas.** A snapshot is a keyframe (the full state) every `keyframeInterval` seconds of sim time (default 1), when a host takes over, and for a peer whose channel opens; in between it is a delta holding only the fields that changed since the previous snapshot. A receiver applies a delta to the snapshot it was based on, checks the result with `validateState`, and asks the host for a keyframe if it is missing that base. Deltas need a plain JSON state (what survives a JSON round trip is what peers get), and an adopted state must not be mutated except by `step`. Arrays of objects with an `id` are matched by it, so removing one element doesn't resend the rest; pass `getId: (item, path) => …` to match by something else (`path` is reused between calls: copy it to keep it), or return `undefined` to match by position. `keyframeInterval: 0` sends full snapshots only.
- **Slow peers.** Snapshots are coalescable: a peer whose data channel is backed up skips stale snapshots and gets the newest once it drains, as a keyframe when it skipped any (a delta needs the snapshot before it), rather than falling further behind. Resync keyframes are coalesced the same way. A failing send never stops the host's own loop.
- **Hidden tabs.** The loop runs on a worker timer, so it keeps going when the host's tab is hidden.
- **Tuning.** `dt` (default 0.1 s), `loopIntervalMs`, `maxFrameDelta`, `maxCatchUp` and `keyframeInterval`.
- **Stepping in a Web Worker.** Pass `worker`, a factory for a module worker that serves the loop with `createHostedSimulationWorker` from `@peterddod/phop/worker` (an entry point without React). While this peer is host, the worker holds the state, steps it on its own timer (including catch-up bursts), and serialises and compresses each snapshot; the main thread only forwards inputs, sends the encoded snapshots and applies the worker's changes to its copy of the state, the way a client applies a delta, as soon as each frame is stepped (the snapshot follows once compressed). That copy is what `getState` returns, and it is never mutated in place. On promotion the worker starts from the main thread's state, a handover the new host adopts restarts it from that state, and on demotion it is stopped and the main thread's copy is handed over once the frames the worker posted before stopping are applied (it confirms the stop at once; one that doesn't within 250 ms, or half `migrationGraceMs`, is given up on, and our inputs in frames never applied go to the new host instead), so an input it stepped just before the demotion is never lost. Off by default; the state must be plain JSON. If the factory throws or the worker fails, the host steps on the main thread with `step` instead, from the last frame it applied and with every input the worker hadn't stepped into that frame, so keep both.

```ts
// sim.worker.ts
import { createHostedSimulationWorker } from '@peterddod/phop/worker';
createHostedSimulationWorker<State, Command>({ step: advance, isRunning }); // same step, isRunning and getId as below

// component
useHostedSimulation<State, Command>('match', {
  ...options, // step, isRunning and getId as before: the fallback
  worker: () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
});
```

`key`, `players` and `init` are read once per mount. Remount to start a new simulation. `HostedSimulation` is the same thing without React.

## Testing without a network

`createMemoryNetwork()` runs rooms in one process, with no signalling server or WebRTC. Pass its transport to every `<Room>`; peers get ids `peer-0001`, `peer-0002`, … in join order, and messages go through the same framing as real data channels.

```tsx
const net = createMemoryNetwork({ maxMessageSize: 16 * 1024 }); // optional: exercise chunking

render(<Room signallingServerUrl="memory" roomId="test" transport={net.transport}><Game /></Room>);
render(<Room signallingServerUrl="memory" roomId="test" transport={net.transport}><Game /></Room>);

net.dropSignaling('peer-0001'); // the first peer loses its connection; the others see it leave
```

`protocolOf: (joinIndex) => version` makes a peer announce another protocol version, to test a mixed-version room. Events are delivered as microtasks, so wait for them (e.g. with Testing Library's `waitFor`). `RoomTransport` is the interface to implement for other transports.

## Signaling Server

phop requires a lightweight signaling server to coordinate the initial WebRTC handshake. Once peers are connected, all state sync happens directly between browsers.

A production-ready server is available as a Docker image:

```bash
docker run -p 8080:8080 ghcr.io/peterddod/phop/signalling-server:latest
```

Source and self-hosting instructions: [`packages/signalling-server`](../signalling-server)

## License

MIT © [Peter Dodd](https://github.com/peterddod)
