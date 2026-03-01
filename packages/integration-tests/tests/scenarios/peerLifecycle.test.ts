import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';
import { getRoomId } from '../helpers/getRoomId';

test.describe('peer lifecycle', () => {
  test('peer joining an existing room receives the current peer list', async ({ browser }) => {
    const [a] = await createRoom(browser, 1);
    const roomId = await getRoomId(a.page);

    const [b] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 2 });

    const aPeers = await a.peers();
    const bPeers = await b.peers();

    expect(aPeers).toHaveLength(2);
    expect(bPeers).toHaveLength(2);

    await Promise.all([a.close(), b.close()]);
  });

  test("peer disconnecting updates remaining peers' peer list", async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    // Close c — a and b should notice
    await c.close();

    await a.waitForPeers(2);
    await b.waitForPeers(2);

    expect(await a.peers()).toHaveLength(2);
    expect(await b.peers()).toHaveLength(2);

    await Promise.all([a.close(), b.close()]);
  });

  test('onPeerConnected callback fires when a new peer joins', async ({ browser }) => {
    const [a] = await createRoom(browser, 1);
    const roomId = await getRoomId(a.page);

    // Install a listener that records joined peer IDs on window before b joins
    await a.page.evaluate(() => {
      (window as Window & { __joined: string[] }).__joined = [];
      window.__phop.onPeerConnected((id) => {
        (window as Window & { __joined: string[] }).__joined.push(id);
      });
    });

    const [b] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 2 });
    const bId = await b.peerId();

    const joined = await a.page.evaluate(
      () => (window as Window & { __joined: string[] }).__joined
    );
    expect(joined).toContain(bId);

    await Promise.all([a.close(), b.close()]);
  });

  test('peer can rejoin the same room after disconnecting', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);
    const roomId = await getRoomId(a.page);

    await b.close();
    await a.waitForPeers(1);

    // b rejoins
    const [bNew] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 2 });

    expect(await a.peers()).toHaveLength(2);
    expect(await bNew.peers()).toHaveLength(2);

    await Promise.all([a.close(), bNew.close()]);
  });
});
