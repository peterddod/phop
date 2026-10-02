import { expect, type Page, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';
import type { PeerHandle } from '../helpers/PeerHandle';

// The hosted game with `useHostedSimulation({ worker })`: the host steps in a Web Worker.

const TIMEOUT = 15_000;

const game = {
  isLobbyHost: (p: Page) => p.evaluate(() => window.__game.isLobbyHost()),
  start: (p: Page) => p.evaluate(() => window.__game.start()),
  tick: (p: Page) => p.evaluate(() => window.__game.tick()),
  hostId: (p: Page) => p.evaluate(() => window.__game.hostId()),
  dispatch: (p: Page, input: string) => p.evaluate((i) => window.__game.dispatch(i), input),
  waitForTick: (p: Page, min: number) =>
    p.waitForFunction((m) => window.__game.tick() >= m, min, { timeout: TIMEOUT }),
  waitForPhase: (p: Page, phase: string) =>
    p.waitForFunction((ph) => window.__game.phase() === ph, phase, { timeout: TIMEOUT }),
  waitForLog: (p: Page, entry: string) =>
    p.waitForFunction((e) => window.__game.state()?.log.includes(e) ?? false, entry, {
      timeout: TIMEOUT,
    }),
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

/** Every peer's state is the deterministic replay of its tick, byte for byte. */
async function expectReplayed(peers: PeerHandle[]): Promise<void> {
  for (const p of peers) {
    for (let i = 0; i < 3; i++) {
      const { tick, json, replay } = await p.page.evaluate(() => {
        const snap = window.__game.snapshot();
        if (!snap) throw new Error('no state');
        return { ...snap, replay: window.__game.replay(snap.tick) };
      });
      expect(json).toBe(replay);
      await game.waitForTick(p.page, tick + 3);
    }
  }
}

async function hostOf(peers: PeerHandle[]) {
  const ids = await Promise.all(peers.map((p) => p.peerId()));
  const hostId = (await game.hostId(peers[0].page)) as string;
  return { host: peers[ids.indexOf(hostId)], hostId, ids };
}

test.describe('hosted game in a worker', () => {
  test('the host steps in its worker; every peer holds the same state', async ({ browser }) => {
    const peers = await createRoom(browser, 3, { game: true, worker: true });
    await startMatch(peers);
    await Promise.all(peers.map((p) => game.waitForTick(p.page, 30)));

    // `step` on the page records the host's history; in the worker it can't.
    const { host } = await hostOf(peers);
    const tick = await game.tick(host.page);
    expect(await host.page.evaluate((t) => window.__game.hostState(t), tick)).toBeNull();

    await expectReplayed(peers);
    await Promise.all(peers.map((p) => p.close()));
  });

  test('non-host input reaches the host worker and is replicated', async ({ browser }) => {
    const peers = await createRoom(browser, 2, { game: true, worker: true });
    await startMatch(peers);
    await Promise.all(peers.map((p) => game.waitForTick(p.page, 15)));

    const { host, ids } = await hostOf(peers);
    const follower = peers.find((p) => p !== host) as PeerHandle;
    const followerId = ids[peers.indexOf(follower)];
    const hostId = ids[peers.indexOf(host)];

    await game.dispatch(follower.page, 'move');
    await game.dispatch(host.page, 'build');
    for (const p of peers) {
      await game.waitForLog(p.page, `${followerId}:move`);
      await game.waitForLog(p.page, `${hostId}:build`);
    }

    await Promise.all(peers.map((p) => p.close()));
  });

  test('host leaving promotes the next peer, whose worker carries on', async ({ browser }) => {
    const peers = await createRoom(browser, 3, { game: true, worker: true });
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

    // The departed host is resigned after the absence timeout, an input the
    // new host's worker applies.
    for (const p of rest) await game.waitForLog(p.page, `${sorted[0]}:resign`);

    const newHost = rest[ids.filter((id) => id !== sorted[0]).indexOf(sorted[1])];
    const tick = await game.tick(newHost.page);
    expect(await newHost.page.evaluate((t) => window.__game.hostState(t), tick)).toBeNull();
    await Promise.all(rest.map((p) => game.waitForTick(p.page, tick + 5)));

    await Promise.all(rest.map((p) => p.close()));
  });
});
