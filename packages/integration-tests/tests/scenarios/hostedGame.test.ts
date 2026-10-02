import { expect, type Page, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';
import { getRoomId } from '../helpers/getRoomId';
import type { PeerHandle } from '../helpers/PeerHandle';

const TIMEOUT = 15_000;

const game = {
  phase: (p: Page) => p.evaluate(() => window.__game.phase()),
  isLobbyHost: (p: Page) => p.evaluate(() => window.__game.isLobbyHost()),
  start: (p: Page) => p.evaluate(() => window.__game.start()),
  tick: (p: Page) => p.evaluate(() => window.__game.tick()),
  hostId: (p: Page) => p.evaluate(() => window.__game.hostId()),
  log: (p: Page) => p.evaluate(() => window.__game.state()?.log ?? []),
  dispatch: (p: Page, input: string) => p.evaluate((i) => window.__game.dispatch(i), input),
  waitForTick: (p: Page, min: number) =>
    p.waitForFunction((m) => window.__game.tick() >= m, min, { timeout: TIMEOUT }),
  waitForPhase: (p: Page, phase: string) =>
    p.waitForFunction((ph) => window.__game.phase() === ph, phase, { timeout: TIMEOUT }),
};

async function startMatch(peers: PeerHandle[]): Promise<void> {
  for (const peer of peers) {
    await peer.page.waitForFunction(() => typeof window.__game !== 'undefined');
  }
  const hosts = await Promise.all(peers.map((p) => game.isLobbyHost(p.page)));
  expect(hosts.filter(Boolean)).toHaveLength(1);
  await game.start(peers[hosts.indexOf(true)].page);
  await Promise.all(peers.map((p) => game.waitForPhase(p.page, 'playing')));
}

test.describe('hosted game', () => {
  test('lobby host starts; every peer follows the host simulation', async ({ browser }) => {
    const peers = await createRoom(browser, 2, { game: true });
    await startMatch(peers);

    await Promise.all(peers.map((p) => game.waitForTick(p.page, 20)));
    const ids = (await Promise.all(peers.map((p) => p.peerId()))).sort();
    for (const p of peers) {
      expect(await game.hostId(p.page)).toBe(ids[0]);
    }

    await Promise.all(peers.map((p) => p.close()));
  });

  test('non-host input reaches the host and is replicated', async ({ browser }) => {
    const peers = await createRoom(browser, 2, { game: true });
    await startMatch(peers);
    await Promise.all(peers.map((p) => game.waitForTick(p.page, 15)));

    const ids = await Promise.all(peers.map((p) => p.peerId()));
    const hostId = await game.hostId(peers[0].page);
    const follower = peers[ids.indexOf(ids.find((id) => id !== hostId) as string)];
    const followerId = await follower.peerId();

    await game.dispatch(follower.page, 'move');
    for (const p of peers) {
      await p.page.waitForFunction(
        (entry) => window.__game.state()?.log.includes(entry) ?? false,
        `${followerId}:move`,
        { timeout: TIMEOUT }
      );
    }

    await Promise.all(peers.map((p) => p.close()));
  });

  test('clients hold the host state byte for byte (compressed keyframes and deltas)', async ({
    browser,
  }) => {
    const peers = await createRoom(browser, 3, { game: true });
    await startMatch(peers);
    await Promise.all(peers.map((p) => game.waitForTick(p.page, 30)));

    const ids = await Promise.all(peers.map((p) => p.peerId()));
    const hostId = await game.hostId(peers[0].page);
    const host = peers[ids.indexOf(hostId as string)];
    for (const client of peers.filter((p) => p !== host)) {
      // Sample several ticks: keyframes come every 10, deltas in between.
      for (let i = 0; i < 5; i++) {
        const snap = await client.page.evaluate(() => window.__game.snapshot());
        expect(snap).not.toBeNull();
        const { tick, json } = snap as { tick: number; json: string };
        const expected = await host.page.evaluate((t) => window.__game.hostState(t), tick);
        expect(json).toBe(expected);
        await game.waitForTick(client.page, tick + 3);
      }
    }

    await Promise.all(peers.map((p) => p.close()));
  });

  test('late joiner sees the match in progress', async ({ browser }) => {
    const peers = await createRoom(browser, 2, { game: true });
    await startMatch(peers);
    const roomId = await getRoomId(peers[0].page);

    const [late] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 3, game: true });
    await game.waitForPhase(late.page, 'in-progress');

    await Promise.all([...peers, late].map((p) => p.close()));
  });

  test('host leaving promotes the next peer without rolling back', async ({ browser }) => {
    const peers = await createRoom(browser, 3, { game: true });
    await startMatch(peers);
    await Promise.all(peers.map((p) => game.waitForTick(p.page, 20)));

    const ids = await Promise.all(peers.map((p) => p.peerId()));
    const sorted = [...ids].sort();
    const host = peers[ids.indexOf(sorted[0])];
    const rest = peers.filter((p) => p !== host);

    const before = Math.max(...(await Promise.all(rest.map((p) => game.tick(p.page)))));
    await host.close();

    for (const p of rest) {
      await p.page.waitForFunction((next) => window.__game.hostId() === next, sorted[1], {
        timeout: TIMEOUT,
      });
    }
    await Promise.all(rest.map((p) => game.waitForTick(p.page, before + 20)));

    // The departed host is resigned after the absence timeout.
    for (const p of rest) {
      await p.page.waitForFunction(
        (entry) => window.__game.state()?.log.includes(entry) ?? false,
        `${sorted[0]}:resign`,
        { timeout: TIMEOUT }
      );
    }

    await Promise.all(rest.map((p) => p.close()));
  });
});
