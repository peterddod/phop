// server.ts
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

export interface Limits {
  /** Largest accepted frame in bytes; SDP offers are a few KB. */
  maxPayload: number;
  maxConnections: number;
  maxRooms: number;
  maxPeersPerRoom: number;
  maxRoomIdLength: number;
  /** Sockets that haven't joined a room within this window are closed. */
  joinTimeoutMs: number;
  /** Ping interval; a socket that misses a pong for a full interval is dropped. */
  heartbeatMs: number;
  /** Token bucket per socket: burst size and refill per second. */
  rateBurst: number;
  ratePerSecond: number;
  /** A peer whose unsent backlog exceeds this is dropped rather than buffered. */
  maxBufferedBytes: number;
  /** Allowed Origin headers; empty allows any (non-browser clients can't be held to it anyway). */
  allowedOrigins: string[];
}

export const defaultLimits: Limits = {
  maxPayload: 64 * 1024,
  maxConnections: 10_000,
  maxRooms: 5_000,
  maxPeersPerRoom: 32,
  maxRoomIdLength: 128,
  joinTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  rateBurst: 500,
  ratePerSecond: 100,
  maxBufferedBytes: 1024 * 1024,
  allowedOrigins: [],
};

// Close codes (RFC 6455 §7.4.1)
const POLICY_VIOLATION = 1008;
const TRY_AGAIN_LATER = 1013;

interface Client {
  id: string;
  ws: WebSocket;
  roomId: string;
}

export function createSignallingServer(limits: Limits = defaultLimits): Server {
  // Track all joined clients
  const clients = new Map<string, Client>();

  // Track rooms and their members
  const rooms = new Map<string, Set<string>>();

  const alive = new WeakMap<WebSocket, boolean>();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // Bound how long a client may hold a socket open before completing the upgrade request.
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxPayload,
    perMessageDeflate: false,
  });

  function rejectUpgrade(socket: Duplex, status: number, reason: string) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());

    const origin = req.headers.origin;
    if (limits.allowedOrigins.length > 0 && (!origin || !limits.allowedOrigins.includes(origin))) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (wss.clients.size >= limits.maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function send(client: Client, message: Record<string, unknown>) {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    // A peer that stops reading would otherwise make us buffer everything sent to it.
    if (ws.bufferedAmount > limits.maxBufferedBytes) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function broadcast(roomId: string, message: Record<string, unknown>, excludeId?: string) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.forEach((clientId) => {
      if (clientId === excludeId) return;

      const client = clients.get(clientId);
      if (client) send(client, message);
    });
  }

  function getRoomPeers(roomId: string): string[] {
    const room = rooms.get(roomId);
    return room ? Array.from(room) : [];
  }

  wss.on('connection', (ws: WebSocket) => {
    let self: Client | null = null;
    let tokens = limits.rateBurst;
    let lastRefill = Date.now();

    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const joinTimer = setTimeout(() => {
      if (!self) ws.close(POLICY_VIOLATION, 'join timeout');
    }, limits.joinTimeoutMs);

    function takeToken(): boolean {
      const now = Date.now();
      tokens = Math.min(
        limits.rateBurst,
        tokens + ((now - lastRefill) / 1000) * limits.ratePerSecond
      );
      lastRefill = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    }

    function join(roomId: unknown) {
      if (self) return; // one join per socket
      if (typeof roomId !== 'string' || roomId.length === 0) return;
      if (roomId.length > limits.maxRoomIdLength) {
        ws.close(POLICY_VIOLATION, 'room id too long');
        return;
      }

      const room = rooms.get(roomId);
      if (!room && rooms.size >= limits.maxRooms) {
        ws.close(TRY_AGAIN_LATER, 'too many rooms');
        return;
      }
      if (room && room.size >= limits.maxPeersPerRoom) {
        ws.close(TRY_AGAIN_LATER, 'room full');
        return;
      }

      // Unguessable, since a peer id is all that's needed to address a signal.
      const client: Client = { id: randomUUID(), ws, roomId };
      self = client;
      clearTimeout(joinTimer);
      clients.set(client.id, client);
      if (room) room.add(client.id);
      else rooms.set(roomId, new Set([client.id]));

      // Send peer ID and current peer list to joiner
      send(client, { type: 'joined', peerId: client.id, peers: getRoomPeers(roomId) });

      // Notify others in room
      broadcast(
        roomId,
        { type: 'peer-joined', peerId: client.id, peers: getRoomPeers(roomId) },
        client.id
      );

      console.log(`Client ${client.id} joined room ${JSON.stringify(roomId)}`);
    }

    function signal(to: unknown, data: unknown) {
      if (!self || typeof to !== 'string' || to === self.id) return;

      // Forward WebRTC signaling messages, only between peers in the same room
      const target = clients.get(to);
      if (!target || target.roomId !== self.roomId) return;
      send(target, { type: 'signal', from: self.id, data });
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!takeToken()) {
        ws.close(POLICY_VIOLATION, 'rate limit exceeded');
        return;
      }
      if (isBinary) return;

      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof message !== 'object' || message === null) return;
      const { type, roomId, to, data: payload } = message as Record<string, unknown>;

      switch (type) {
        case 'join':
          join(roomId);
          break;
        case 'signal':
          signal(to, payload);
          break;
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (!self) return;
      const { id, roomId } = self;

      clients.delete(id);
      const room = rooms.get(roomId);
      if (room) {
        room.delete(id);

        // Clean up empty room
        if (room.size === 0) {
          rooms.delete(roomId);
        } else {
          broadcast(roomId, { type: 'peer-left', peerId: id, peers: getRoomPeers(roomId) });
        }
      }

      console.log(`Client ${id} left room ${JSON.stringify(roomId)}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });
  });

  // Drop connections that have gone away without a close (half-open TCP).
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!alive.get(ws)) {
        ws.terminate();
        return;
      }
      alive.set(ws, false);
      ws.ping();
    });
  }, limits.heartbeatMs);
  heartbeat.unref();

  return server;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function limitsFromEnv(): Limits {
  const d = defaultLimits;
  return {
    maxPayload: intEnv('MAX_PAYLOAD_BYTES', d.maxPayload),
    maxConnections: intEnv('MAX_CONNECTIONS', d.maxConnections),
    maxRooms: intEnv('MAX_ROOMS', d.maxRooms),
    maxPeersPerRoom: intEnv('MAX_PEERS_PER_ROOM', d.maxPeersPerRoom),
    maxRoomIdLength: intEnv('MAX_ROOM_ID_LENGTH', d.maxRoomIdLength),
    joinTimeoutMs: intEnv('JOIN_TIMEOUT_MS', d.joinTimeoutMs),
    heartbeatMs: intEnv('HEARTBEAT_MS', d.heartbeatMs),
    rateBurst: intEnv('RATE_LIMIT_BURST', d.rateBurst),
    ratePerSecond: intEnv('RATE_LIMIT_PER_SECOND', d.ratePerSecond),
    maxBufferedBytes: intEnv('MAX_BUFFERED_BYTES', d.maxBufferedBytes),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8080;
  createSignallingServer(limitsFromEnv()).listen(PORT, () => {
    console.log(`Signaling server running on ws://localhost:${PORT}`);
  });
}
