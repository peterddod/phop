# integration-tests

End-to-end integration tests for `@peterddod/phop` using Playwright. Tests run real WebRTC connections between multiple browser peers against a real signalling server — no mocks.

## Why integration tests

The most important properties of the library only emerge when real peers connect and exchange messages. A unit test can verify that a merge strategy's `merge()` function returns the correct result for given inputs, but it cannot verify that two peers concurrently calling `setState` converge to the same value over an actual WebRTC data channel. These tests exist to cover that gap.

## Running the tests

Install Playwright's Chromium browser on first use:

```sh
bunx playwright install chromium
```

Then from the repo root:

```sh
bun test:integration
```

This builds the signalling server, starts it alongside the harness app, runs all tests, and tears everything down. Playwright manages the server lifecycle automatically.

To run a single file or test during development:

```sh
cd packages/integration-tests
bunx playwright test tests/scenarios/messaging.test.ts
bunx playwright test --headed   # opens a browser window
bunx playwright test --ui       # opens Playwright's interactive UI
```

## Folder structure

```
packages/integration-tests/
  playwright.config.ts          # Playwright configuration and webServer setup
  harness/                      # Minimal React app used as the test subject
    index.html
    vite.config.ts
    src/
      main.tsx                  # Mounts <Room> from ?roomId= and ?serverUrl= query params
      exposePhopApi.tsx         # Wires the phop API onto window.__phop
  tests/
    helpers/
      PeerHandle.ts             # High-level API for controlling a single peer from a test
      createRoom.ts             # Spawns N peers into a room and waits for a full mesh
      getRoomId.ts              # Reads roomId from a page's URL (used in late-joiner tests)
    scenarios/
      messaging.test.ts         # broadcast, sendToPeer, message ordering
      peerLifecycle.test.ts     # join, disconnect, reconnect, onPeerConnected
      lateJoiner.test.ts        # late-joiner state sync via push-on-connect
    merge-strategies/
      lamport.test.ts           # Concurrent writes converge under Lamport clock
      lastWriteWins.test.ts     # Wall-clock last-write-wins convergence
```

## How the harness works

The harness (`harness/`) is a Vite + React app with no UI. It reads `roomId` and `serverUrl` from the page's query string, mounts `<Room>`, and then exposes the library's full API on `window.__phop` so Playwright can drive it from test code via `page.evaluate()`.

### The shared-state registry

`useSharedState` is a React hook — it cannot be called conditionally or imperatively. To let tests register arbitrary keys at runtime, the harness uses a registry component pattern:

1. `window.__phop.registerSharedState(key, strategy?)` triggers a React state update that mounts a new `<SharedStateSlice>` component for that key.
2. Each `<SharedStateSlice>` calls `useSharedState(key, null, strategy)` unconditionally and writes the current value into a shared ref map.
3. `registerSharedState` returns a `Promise<void>` that resolves only after the slice's `useEffect` fires — guaranteeing the hook is live before the test proceeds. It also broadcasts a `state-request` at that point, so any already-connected peers push their current state (needed for late joiners who register keys after connecting).

### Two connection layers

There is an important distinction between:

- **`peers`** — the list of peer IDs known to the signalling server. Updated immediately when a peer joins or leaves.
- **`connectedPeerCount`** — the number of peers with an open WebRTC data channel. Updated when `onPeerConnected` fires, which happens after ICE negotiation completes.

`peers` updating does not mean messages can be sent yet. `createRoom` waits for both.

## Helpers

### `createRoom`

```ts
createRoom(browser, peerCount, options?)
```

Spawns `peerCount` isolated `BrowserContext`s (one per peer), navigates each to the harness, and waits until:

1. Every peer sees `peerCount` peers in the signalling layer (`peers.length`).
2. Every peer has open data channels to all other peers (`connectedPeerCount`).

Returns a `PeerHandle[]` in join order.

For tests where a peer joins an existing room, pass `expectedTotalPeers` to tell `createRoom` how large the room already is:

```ts
const [a, b] = await createRoom(browser, 2);
const roomId = await getRoomId(a.page);

// c joins after a and b are already connected
const [c] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 3 });
```

### `PeerHandle`

A typed wrapper around a Playwright `Page`. Every method is a thin `page.evaluate()` call — no state lives in the test process.

```ts
// Identity
peer.peerId()
peer.peers()
peer.waitForPeers(count)       // signalling layer — peers known to the server
peer.waitForConnections(count) // transport layer — data channels open

// Shared state (must registerSharedState before using)
peer.registerSharedState(key, strategy?)   // 'lamport' (default) | 'lastWriteWins'
peer.setSharedState(key, value)
peer.getSharedState(key)
peer.waitForSharedState(key, predicate)

// Messaging
peer.broadcast(data)
peer.sendToPeer(peerId, data)
peer.nextMessage()  // resolves with the next queued message; never drops

// Lifecycle
peer.close()  // closes the BrowserContext and releases WebRTC resources
```

## Writing a new test

Most tests follow this pattern:

```ts
import { test, expect } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';

test('describe what the behaviour is', async ({ browser }) => {
  const [a, b] = await createRoom(browser, 2);

  await a.registerSharedState('counter');
  await b.registerSharedState('counter');

  await a.setSharedState('counter', 1);
  await b.waitForSharedState('counter', (v) => v === 1);

  expect(await b.getSharedState('counter')).toBe(1);

  await Promise.all([a.close(), b.close()]);
});
```

A few guidelines:

- **Always close peers** in the test body. There is no automatic teardown — unclosed contexts leak WebRTC connections and can interfere with other tests.
- **Use `waitForSharedState` and `waitForConnections`** rather than fixed `waitForTimeout` delays. The test should express what it is waiting for, not how long.
- **Each test generates a unique `roomId`** via `crypto.randomUUID()` inside `createRoom`, so tests running in parallel never share a room. You do not need to do anything special for isolation.
- **Adding a new merge strategy** — add a file under `tests/merge-strategies/` following the pattern of `lamport.test.ts`. Register the strategy name in `SerializedStrategy` in `exposePhopApi.tsx` and add the mapping in `resolveStrategy`.

## Infrastructure

### `playwright.config.ts`

Declares two `webServer` entries managed automatically by Playwright:

- **Signalling server** — `node ../../packages/signalling-server/dist/index.js`, health-checked at `http://localhost:8080/health`.
- **Harness app** — `bunx vite --config harness/vite.config.ts --port 9000`.

Both are reused if already running locally (`reuseExistingServer: true`), and started fresh in CI.

### CI

The `integration-test` job in `.github/workflows/ci.yml` runs on every push and PR, after `lint` and before `semantic-release`. It builds the library and server, installs Playwright's Chromium binary, and runs the full suite with 2 workers.
