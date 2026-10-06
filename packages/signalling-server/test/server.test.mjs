import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, test } from 'node:test';
import WebSocket from 'ws';
import server from '../dist/index.js';

const { createSignallingServer, defaultLimits } = server;

let cleanup = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function start(overrides = {}) {
  const srv = createSignallingServer({ ...defaultLimits, ...overrides });
  srv.listen(0);
  await once(srv, 'listening');
  cleanup.push(() => new Promise((resolve) => srv.close(resolve)));
  return { srv, port: srv.address().port };
}

/** A ws client that queues every message so tests can await them in order. */
async function client(port, options = {}) {
  const ws = new WebSocket(`ws://localhost:${port}`, options);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.next = (ms = 1000) =>
    inbox.length > 0
      ? Promise.resolve(inbox.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no message')), ms);
          waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        });
  ws.nothing = async (ms = 200) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    assert.deepEqual(inbox, []);
  };
  ws.json = (msg) => ws.send(JSON.stringify(msg));
  cleanup.push(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

async function joined(port, roomId) {
  const ws = await client(port);
  ws.json({ type: 'join', roomId });
  const msg = await ws.next();
  assert.equal(msg.type, 'joined');
  ws.peerId = msg.peerId;
  return ws;
}

async function health(port) {
  const res = await fetch(`http://localhost:${port}/health`);
  return res.json();
}

async function eventually(check, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Raw TCP WebSocket that never answers pings and can stop reading. */
async function rawClient(port) {
  const socket = connect(port, 'localhost');
  await once(socket, 'connect');
  socket.write(
    'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
  const [head] = await once(socket, 'data');
  assert.match(head.toString(), /^HTTP\/1.1 101/);
  cleanup.push(() => socket.destroy());
  socket.gone = new Promise((resolve) => socket.on('close', resolve));
  socket.sendText = (text) => {
    const payload = Buffer.from(text);
    assert.ok(payload.length < 126);
    // FIN + text opcode, masked with an all-zero key
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, 0, 0, 0, 0]), payload]));
  };
  return socket;
}

test('malformed messages are ignored and the server keeps running', async () => {
  const { port } = await start();
  const ws = await client(port);
  for (const frame of ['not json', '{', 'null', '[]', '"join"', '42', '{"type":{}}']) {
    ws.send(frame);
  }
  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  ws.json({ type: 'join', roomId: { nested: true } });
  ws.json({ type: 'signal', to: { toString: 1 }, data: 1 });
  await ws.nothing();

  ws.json({ type: 'join', roomId: 'room' });
  assert.equal((await ws.next()).type, 'joined');
  assert.equal((await health(port)).status, 'ok');
});

test('a second join on the same socket is ignored and leaves no ghost peer', async () => {
  const { port } = await start();
  const a = await joined(port, 'room');
  a.json({ type: 'join', roomId: 'room' });
  a.json({ type: 'join', roomId: 'other' });
  await a.nothing();

  const b = await joined(port, 'room');
  assert.equal((await a.next()).type, 'peer-joined');
  a.close();
  const left = await b.next();
  assert.equal(left.type, 'peer-left');
  assert.deepEqual(left.peers, [b.peerId]);
});

test('frames over maxPayload close the socket with 1009', async () => {
  const { port } = await start({ maxPayload: 1024 });
  const ws = await client(port);
  ws.json({ type: 'join', roomId: 'x'.repeat(2000) });
  assert.equal(await ws.closed, 1009);
  assert.equal((await health(port)).status, 'ok');
});

test('room size, room count and room id length are capped', async () => {
  const { port } = await start({ maxPeersPerRoom: 2, maxRooms: 2, maxRoomIdLength: 8 });
  await joined(port, 'a');
  await joined(port, 'a');

  const third = await client(port);
  third.json({ type: 'join', roomId: 'a' });
  assert.equal(await third.closed, 1013);

  await joined(port, 'b');
  const extraRoom = await client(port);
  extraRoom.json({ type: 'join', roomId: 'c' });
  assert.equal(await extraRoom.closed, 1013);

  const longId = await client(port);
  longId.json({ type: 'join', roomId: '123456789' });
  assert.equal(await longId.closed, 1008);
});

test('signals are only relayed between joined peers in the same room, from the real sender', async () => {
  const { port } = await start();
  const a = await joined(port, 'one');
  const b = await joined(port, 'one');
  await a.next(); // peer-joined
  const outsider = await joined(port, 'two');
  const unjoined = await client(port);

  outsider.json({ type: 'signal', to: a.peerId, data: 'cross-room' });
  unjoined.json({ type: 'signal', to: a.peerId, data: 'not joined' });
  a.json({ type: 'signal', to: a.peerId, data: 'self' });
  await a.nothing();

  b.json({ type: 'signal', to: a.peerId, from: outsider.peerId, data: { sdp: 'x' } });
  assert.deepEqual(await a.next(), { type: 'signal', from: b.peerId, data: { sdp: 'x' } });
});

test('peer ids are unguessable UUIDs', async () => {
  const { port } = await start();
  const a = await joined(port, 'room');
  assert.match(a.peerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('sockets that never join are closed', async () => {
  const { port } = await start({ joinTimeoutMs: 100 });
  const ws = await client(port);
  assert.equal(await ws.closed, 1008);
});

test('message floods close the socket', async () => {
  const { port } = await start({ rateBurst: 20, ratePerSecond: 1 });
  const ws = await joined(port, 'room');
  for (let i = 0; i < 50; i++) ws.json({ type: 'signal', to: 'nobody', data: i });
  assert.equal(await ws.closed, 1008);
});

test('connections beyond maxConnections are refused', async () => {
  const { port } = await start({ maxConnections: 1 });
  await client(port);
  const extra = new WebSocket(`ws://localhost:${port}`);
  const [, res] = await once(extra, 'unexpected-response');
  assert.equal(res.statusCode, 503);
});

test('origins are checked when ALLOWED_ORIGINS is set', async () => {
  const { port } = await start({ allowedOrigins: ['https://good.example'] });
  await client(port, { origin: 'https://good.example' });

  for (const origin of ['https://evil.example', undefined]) {
    const ws = new WebSocket(`ws://localhost:${port}`, origin ? { origin } : {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 403);
  }
});

test('unresponsive connections are dropped by the heartbeat and leave the room', async () => {
  const { port } = await start({ heartbeatMs: 100 });
  const watcher = await joined(port, 'room');
  const raw = await rawClient(port);
  raw.sendText(JSON.stringify({ type: 'join', roomId: 'room' }));
  assert.equal((await watcher.next()).type, 'peer-joined');

  await raw.gone;
  const left = await watcher.next();
  assert.equal(left.type, 'peer-left');
  assert.deepEqual(left.peers, [watcher.peerId]);
  await eventually(async () => assert.equal((await health(port)).connections, 1));
});

test('a peer that stops reading is dropped instead of buffered without bound', async () => {
  const { port } = await start({
    maxBufferedBytes: 64 * 1024,
    rateBurst: 100_000,
    ratePerSecond: 100_000,
  });
  const sender = await joined(port, 'room');
  const raw = await rawClient(port);
  raw.sendText(JSON.stringify({ type: 'join', roomId: 'room' }));
  const { peerId: slowId } = await sender.next();
  raw.pause();

  const chunk = 'x'.repeat(32 * 1024);
  let dropped = false;
  raw.gone.then(() => {
    dropped = true;
  });
  for (let i = 0; i < 4000 && !dropped; i++) {
    sender.json({ type: 'signal', to: slowId, data: chunk });
    if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const left = await sender.next(5000);
  assert.equal(left.type, 'peer-left');
  assert.equal(left.peerId, slowId);
});
