import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';
import { getRoomId } from '../helpers/getRoomId';

test.describe('late joiner sync', () => {
  test('late joiner receives current shared state', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);
    await Promise.all([a.registerSharedState('counter'), b.registerSharedState('counter')]);

    await a.setSharedState('counter', 42);
    await b.waitForSharedState('counter', (v) => v === 42);

    const roomId = await getRoomId(a.page);

    // c joins after state is established; expectedTotalPeers=3 waits for full mesh
    const [c] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 3 });
    await c.registerSharedState('counter');

    await c.waitForSharedState('counter', (v) => v === 42);
    expect(await c.getSharedState('counter')).toBe(42);

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('late joiner with multiple active keys receives state for each key', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('x'),
      a.registerSharedState('y'),
      b.registerSharedState('x'),
      b.registerSharedState('y'),
    ]);

    await a.setSharedState('x', 'hello');
    await a.setSharedState('y', 99);

    await b.waitForSharedState('x', (v) => v === 'hello');
    await b.waitForSharedState('y', (v) => v === 99);

    const roomId = await getRoomId(a.page);

    const [c] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 3 });
    await Promise.all([c.registerSharedState('x'), c.registerSharedState('y')]);

    await c.waitForSharedState('x', (v) => v === 'hello');
    await c.waitForSharedState('y', (v) => v === 99);

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('state set after late joiner connects is received normally', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);
    await Promise.all([a.registerSharedState('msg'), b.registerSharedState('msg')]);

    // Establish initial state before c joins
    await a.setSharedState('msg', 'initial');
    await b.waitForSharedState('msg', (v) => v === 'initial');

    const roomId = await getRoomId(a.page);

    const [c] = await createRoom(browser, 1, { roomId, expectedTotalPeers: 3 });
    await c.registerSharedState('msg');
    await c.waitForSharedState('msg', (v) => v === 'initial');

    // Now update state — c should receive it via normal broadcast
    await a.setSharedState('msg', 'updated');
    await c.waitForSharedState('msg', (v) => v === 'updated');
    expect(await c.getSharedState('msg')).toBe('updated');

    await Promise.all([a.close(), b.close(), c.close()]);
  });
});
