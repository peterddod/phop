// server.ts
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

interface Client {
  id: string;
  ws: WebSocket;
  roomId: string;
}

const PORT = Number(process.env.PORT) || 8080;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

// Track all connected clients
const clients = new Map<string, Client>();

// Track rooms and their members
const rooms = new Map<string, Set<string>>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function broadcast(roomId: string, message: Record<string, unknown>, excludeId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.forEach((clientId) => {
    if (clientId === excludeId) return;

    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

function getRoomPeers(roomId: string): string[] {
  const room = rooms.get(roomId);
  return room ? Array.from(room) : [];
}

wss.on('connection', (ws: WebSocket) => {
  let clientId: string | null = null;
  let currentRoomId: string | null = null;

  ws.on('message', (data: string) => {
    const message = JSON.parse(data.toString());

    switch (message.type) {
      case 'join':
        // Generate unique peer ID
        clientId = generateId();
        currentRoomId = message.roomId;

        if (!clientId || !currentRoomId) {
          return;
        }

        // Store client
        clients.set(clientId, {
          id: clientId,
          ws: ws,
          roomId: currentRoomId,
        });

        // Add to room
        if (!rooms.has(currentRoomId)) {
          rooms.set(currentRoomId, new Set());
        }
        rooms.get(currentRoomId)?.add(clientId);

        // Send peer ID and current peer list to joiner
        ws.send(
          JSON.stringify({
            type: 'joined',
            peerId: clientId,
            peers: getRoomPeers(currentRoomId),
          })
        );

        // Notify others in room
        broadcast(
          currentRoomId,
          {
            type: 'peer-joined',
            peerId: clientId,
            peers: getRoomPeers(currentRoomId),
          },
          clientId
        );

        console.log(`Client ${clientId} joined room ${currentRoomId}`);
        break;

      case 'signal': {
        // Forward WebRTC signaling messages between peers
        const targetClient = clients.get(message.to);
        if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
          targetClient.ws.send(
            JSON.stringify({
              type: 'signal',
              from: clientId,
              data: message.data,
            })
          );
        }
        break;
      }

      default:
        console.log('Unknown message type:', message.type);
    }
  });

  ws.on('close', () => {
    if (clientId && currentRoomId) {
      // Remove from room
      const room = rooms.get(currentRoomId);
      if (room) {
        room.delete(clientId);

        // Notify others
        broadcast(currentRoomId, {
          type: 'peer-left',
          peerId: clientId,
          peers: getRoomPeers(currentRoomId),
        });

        // Clean up empty room
        if (room.size === 0) {
          rooms.delete(currentRoomId);
        }
      }

      // Remove client
      clients.delete(clientId);

      console.log(`Client ${clientId} left room ${currentRoomId}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on ws://localhost:${PORT}`);
});
