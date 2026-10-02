import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';
import { getRoomId } from '../helpers/getRoomId';

test.describe('peer metadata', () => {
  test('every peer sees the others’ metadata and protocol, including changes', async ({
    browser,
  }) => {
    const [a, b] = await createRoom(browser, 2, {
      metadata: (i) => ({ buildId: 'build-1', name: `peer ${i}` }),
    });
    const [aId, bId] = await Promise.all([a.peerId(), b.peerId()]);

    await a.waitForMetadata(bId, { buildId: 'build-1', name: 'peer 1' });
    await b.waitForMetadata(aId, { buildId: 'build-1', name: 'peer 0' });
    const info = await a.peerInfo();
    expect(info[aId]).toEqual({
      protocol: info[bId].protocol,
      metadata: { buildId: 'build-1', name: 'peer 0' },
    });
    expect(info[bId].protocol).toBeGreaterThanOrEqual(2);

    // A late joiner learns everyone's, and a change reaches peers already connected.
    const roomId = await getRoomId(a.page);
    const [c] = await createRoom(browser, 1, {
      roomId,
      expectedTotalPeers: 3,
      metadata: () => ({ buildId: 'build-2' }),
    });
    const cId = await c.peerId();
    await a.waitForMetadata(cId, { buildId: 'build-2' });
    await c.waitForMetadata(bId, { buildId: 'build-1', name: 'peer 1' });

    await b.setMetadata({ buildId: 'build-2' });
    await a.waitForMetadata(bId, { buildId: 'build-2' });
    await c.waitForMetadata(bId, { buildId: 'build-2' });

    await c.close();
    await a.page.waitForFunction((id: string) => !(id in window.__phop.peerInfo), cId);

    await Promise.all([a.close(), b.close()]);
  });
});
