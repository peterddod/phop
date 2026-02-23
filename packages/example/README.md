# phop example

A demo app showing two peers syncing shared state in real time using [phop](../phop).

The app renders two iframes side by side, each acting as an independent peer. Both connect to the same room via a local signaling server and sync a shared counter over a WebRTC data channel.

## Running

From the monorepo root:

```bash
bun install
bun run dev
```

Then open http://localhost:9000.

## How it works

```
App.tsx           # Main container with two peer iframes
└── peer.html     # Peer iframe entry point
    └── Peer.tsx  # Connects to room, renders shared state UI
        └── <Room> from phop
            └── useSharedState() / useRoom()
```

1. Each iframe joins the same room via the signaling server (`ws://localhost:8080`)
2. The signaling server facilitates the WebRTC handshake
3. Once connected, state updates flow directly between peers via a WebRTC data channel

## License

MIT
