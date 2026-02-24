# phop signalling server

A lightweight WebSocket signalling server that coordinates the initial WebRTC handshake between phop peers. Once browsers are connected, all state sync flows directly between them — the signalling server is only needed to get the connection started.

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
```

Server listens on `ws://localhost:8080` by default.

## Protocol

### Client → Server

#### Join a room
```json
{ "type": "join", "roomId": "room-name", "peerId": "unique-peer-id" }
```

#### Send signal to peer
```json
{ "type": "signal", "to": "target-peer-id", "from": "sender-peer-id", "signal": {} }
```

### Server → Client

#### Peers list (on join)
```json
{ "type": "peers", "peers": ["peer-id-1", "peer-id-2"] }
```

#### Peer joined / left
```json
{ "type": "peer-joined", "peerId": "new-peer-id" }
{ "type": "peer-left", "peerId": "departed-peer-id" }
```

#### Relayed signal
```json
{ "type": "signal", "from": "sender-peer-id", "signal": {} }
```

## License

MIT © [Peter Dodd](https://github.com/peterddod)
