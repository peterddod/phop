import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';

test.describe('messaging', () => {
  test('broadcast delivers to all other peers', async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    await a.broadcast({ hello: 'world' });

    const msgB = await b.nextMessage();
    const msgC = await c.nextMessage();

    expect(msgB.data).toEqual({ hello: 'world' });
    expect(msgC.data).toEqual({ hello: 'world' });

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('broadcast does not deliver to sender', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await a.broadcast('ping');

    const msgB = await b.nextMessage();
    expect(msgB.data).toBe('ping');

    // a's queue should be empty — it should not receive its own broadcast
    const queueA = await a.page.evaluate(() => window.__phop.__msgQueue.length);
    expect(queueA).toBe(0);

    await Promise.all([a.close(), b.close()]);
  });

  test('sendToPeer delivers only to the target peer', async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    const bId = await b.peerId();
    await a.sendToPeer(bId, 'direct-to-b');

    const msgB = await b.nextMessage();
    expect(msgB.data).toBe('direct-to-b');

    // c should not have received anything
    const queueC = await c.page.evaluate(() => window.__phop.__msgQueue.length);
    expect(queueC).toBe(0);

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('sequential broadcasts arrive in order', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await a.broadcast(1);
    await a.broadcast(2);
    await a.broadcast(3);

    const msg1 = await b.nextMessage();
    const msg2 = await b.nextMessage();
    const msg3 = await b.nextMessage();

    expect(msg1.data).toBe(1);
    expect(msg2.data).toBe(2);
    expect(msg3.data).toBe(3);

    await Promise.all([a.close(), b.close()]);
  });

  test('nextMessage queue does not drop messages that arrived before the call', async ({
    browser,
  }) => {
    const [a, b] = await createRoom(browser, 2);

    // Send before any nextMessage call
    await a.broadcast('early-1');
    await a.broadcast('early-2');

    // Small pause to let messages propagate
    await b.page.waitForTimeout(500);

    const msg1 = await b.nextMessage();
    const msg2 = await b.nextMessage();

    expect(msg1.data).toBe('early-1');
    expect(msg2.data).toBe('early-2');

    await Promise.all([a.close(), b.close()]);
  });

  test('a message larger than the SCTP maximum message size arrives intact', async ({
    browser,
  }) => {
    const [a, b, c] = await createRoom(browser, 3);

    // Over Chromium's 256 KiB limit, with multi-byte characters across chunk boundaries.
    await a.page.evaluate(() => window.__phop.broadcast({ big: 'aé😀€'.repeat(100_000) }));
    await a.broadcast('after');

    for (const peer of [b, c]) {
      const big = await peer.nextMessage();
      expect(big.data).toEqual({ big: 'aé😀€'.repeat(100_000) });
      const after = await peer.nextMessage();
      expect(after.data).toBe('after');
    }

    await Promise.all([a.close(), b.close(), c.close()]);
  });
});
