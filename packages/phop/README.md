# phop

Peer-to-peer state management for React using WebRTC. Share and sync state across browsers in real time — no backend required.

> ⚠️ **Early Development** — P2P synchronization features are under active development

## Installation

```bash
npm install phop
```

## Usage

Wrap your app in a `<Room>` provider and connect to a signaling server:

```tsx
import { Room, useRoom, useSharedState } from 'phop';

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
    <button onClick={() => setCount(count + 1)}>
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

### `useSharedState(key, initialValue, options?)`

Shared state hook — works like `useState` but syncs across all peers in the room.

```ts
const [value, setValue] = useSharedState<T>(key: string, initialValue: T, options?: {
  mergeStrategy?: MergeStrategy; // default: lastWriteWins
})
```

### `useRoom()`

Access room metadata and low-level messaging.

```ts
const { peerId, peers, isConnected, broadcast, onMessage } = useRoom();
```

## Signaling Server

phop requires a lightweight signaling server to coordinate the initial WebRTC handshake. Once peers are connected, all state sync happens directly between browsers.

A production-ready server is available as a Docker image:

```bash
docker run -p 8080:8080 ghcr.io/peterddod/react-p2p/signalling-server:latest
```

Source and self-hosting instructions: [`packages/signalling-server`](../signalling-server)

## License

MIT © [Peter Dodd](https://github.com/peterddod)
