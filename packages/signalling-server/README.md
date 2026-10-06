# phop signalling server

A lightweight WebSocket signalling server that coordinates the initial WebRTC handshake between phop peers. Once browsers are connected, all state sync flows directly between them — the signalling server is only needed to get the connection started.
This README is documentation-only and has no effect on server runtime behavior.

## Self-hosting with Docker

```bash
docker run -p 8080:8080 ghcr.io/peterddod/phop/signalling-server:latest
```

Pin to a specific version to match your phop client version:

```bash
docker run -p 8080:8080 ghcr.io/peterddod/phop/signalling-server:1.0.0
```

Set a custom port:

```bash
docker run -e PORT=3000 -p 3000:3000 ghcr.io/peterddod/phop/signalling-server:latest
```

## Running from source

```bash
# Install dependencies from monorepo root
bun install

# Build and start
bun run build:server
bun run start:server

# Or in watch mode during development
bun run dev:server

# Tests
bun --filter=signalling-server run test
```

Server listens on `ws://localhost:8080` by default.

## Configuration

All limits are set through environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated list of allowed `Origin` headers, e.g. `https://app.example.com` |
| `MAX_PAYLOAD_BYTES` | `65536` | Largest accepted message; larger ones close the socket (1009) |
| `MAX_CONNECTIONS` | `10000` | Total open sockets; further upgrades get HTTP 503 |
| `MAX_ROOMS` | `5000` | Total rooms; joining a new room beyond this closes the socket (1013) |
| `MAX_PEERS_PER_ROOM` | `32` | Peers per room; joining a full room closes the socket (1013) |
| `MAX_ROOM_ID_LENGTH` | `128` | Longer room ids close the socket (1008) |
| `JOIN_TIMEOUT_MS` | `10000` | Sockets that haven't joined by then are closed (1008) |
| `HEARTBEAT_MS` | `30000` | Ping interval; sockets that miss a pong are dropped |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SECOND` | `500` / `100` | Per-socket message budget; exceeding it closes the socket (1008) |
| `MAX_BUFFERED_BYTES` | `1048576` | A peer that stops reading is dropped once this much is queued for it |

`ALLOWED_ORIGINS` only stops other websites from using your server from their visitors' browsers; non-browser clients can send any `Origin`.

## Protocol

### Client → Server

#### Join a room
```json
{ "type": "join", "roomId": "room-name" }
```

A socket can join one room, once. The server assigns the peer id.

#### Send signal to peer
```json
{ "type": "signal", "to": "target-peer-id", "data": {} }
```

Signals are only delivered to peers in the sender's room.

### Server → Client

#### Joined
```json
{ "type": "joined", "peerId": "your-peer-id", "peers": ["your-peer-id", "peer-id-2"] }
```

#### Peer joined / left
```json
{ "type": "peer-joined", "peerId": "new-peer-id", "peers": ["..."] }
{ "type": "peer-left", "peerId": "departed-peer-id", "peers": ["..."] }
```

#### Relayed signal
```json
{ "type": "signal", "from": "sender-peer-id", "data": {} }
```

## License

MIT © [Peter Dodd](https://github.com/peterddod)
