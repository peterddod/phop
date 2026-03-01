import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';

// The consensus protocol requires a full round-trip between all peers before
// committing, so tests use generous timeouts.
const CONVERGENCE_TIMEOUT = 15_000;

test.describe('merge strategy: consensus', () => {
  test('sequential write is committed on both peers', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'consensus'),
      b.registerSharedState('val', 'consensus'),
    ]);

    await a.setSharedState('val', 'hello');

    await a.waitForSharedState('val', (v) => v === 'hello', { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('val', (v) => v === 'hello', { timeout: CONVERGENCE_TIMEOUT });

    expect(await a.getSharedState('val')).toBe('hello');
    expect(await b.getSharedState('val')).toBe('hello');

    await Promise.all([a.close(), b.close()]);
  });

  test('concurrent writes from two peers converge to the same value', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'consensus'),
      b.registerSharedState('val', 'consensus'),
    ]);

    // Both peers write at the same time — the protocol must co-merge and commit
    // identically on both sides.
    await Promise.all([a.setSharedState('val', 'from-a'), b.setSharedState('val', 'from-b')]);

    await a.waitForSharedState('val', (v) => v !== null, { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('val', (v) => v !== null, { timeout: CONVERGENCE_TIMEOUT });

    // Allow enough time for the full round to settle.
    await a.page.waitForTimeout(2000);

    const aVal = await a.getSharedState('val');
    const bVal = await b.getSharedState('val');

    // Both peers must have committed the same value regardless of which one won.
    expect(aVal).toBe(bVal);
    expect(aVal === 'from-a' || aVal === 'from-b').toBe(true);

    await Promise.all([a.close(), b.close()]);
  });

  test('sequential writes from different peers each commit correctly', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('counter', 'consensus'),
      b.registerSharedState('counter', 'consensus'),
    ]);

    // Round 1: a is the initiator — its write 1 wins over b's null initial state.
    await a.setSharedState('counter', 1);
    await a.waitForSharedState('counter', (v) => v === 1, { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('counter', (v) => v === 1, { timeout: CONVERGENCE_TIMEOUT });

    // Round 2: b is now the initiator — its write 2 wins over a's current state 1.
    await b.setSharedState('counter', 2);
    await a.waitForSharedState('counter', (v) => v === 2, { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('counter', (v) => v === 2, { timeout: CONVERGENCE_TIMEOUT });

    expect(await a.getSharedState('counter')).toBe(2);
    expect(await b.getSharedState('counter')).toBe(2);

    await Promise.all([a.close(), b.close()]);
  });

  test('write queued during an active round is applied in the next round', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'consensus'),
      b.registerSharedState('val', 'consensus'),
    ]);

    // Fire two writes from a in rapid succession. The second should be queued
    // while round 1 is in flight and then start round 2 automatically.
    await a.setSharedState('val', 'first');
    // Do not wait — intentionally overlap with the in-progress round.
    await a.setSharedState('val', 'second');

    // Round 1: a initiates with 'first', b joins with null → a wins → 'first'.
    // Round 2: a's pending write 'second' starts a new round; b joins with
    // 'first' (its current state). a is the initiator so 'second' wins.
    await a.waitForSharedState('val', (v) => v === 'second', { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('val', (v) => v === 'second', { timeout: CONVERGENCE_TIMEOUT });

    expect(await a.getSharedState('val')).toBe('second');
    expect(await b.getSharedState('val')).toBe('second');

    await Promise.all([a.close(), b.close()]);
  });

  test('three peers all converge to the same value', async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    await Promise.all([
      a.registerSharedState('shared', 'consensus'),
      b.registerSharedState('shared', 'consensus'),
      c.registerSharedState('shared', 'consensus'),
    ]);

    // All three write concurrently.
    await Promise.all([
      a.setSharedState('shared', 'from-a'),
      b.setSharedState('shared', 'from-b'),
      c.setSharedState('shared', 'from-c'),
    ]);

    await a.waitForSharedState('shared', (v) => v !== null, { timeout: CONVERGENCE_TIMEOUT });
    await b.waitForSharedState('shared', (v) => v !== null, { timeout: CONVERGENCE_TIMEOUT });
    await c.waitForSharedState('shared', (v) => v !== null, { timeout: CONVERGENCE_TIMEOUT });

    await a.page.waitForTimeout(3000);

    const aVal = await a.getSharedState('shared');
    const bVal = await b.getSharedState('shared');
    const cVal = await c.getSharedState('shared');

    expect(aVal).toBe(bVal);
    expect(bVal).toBe(cVal);

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('late joiner receives committed state', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('msg', 'consensus'),
      b.registerSharedState('msg', 'consensus'),
    ]);

    await a.setSharedState('msg', 'before-c');
    await b.waitForSharedState('msg', (v) => v === 'before-c', {
      timeout: CONVERGENCE_TIMEOUT,
    });

    const roomId = await a.page.evaluate(
      () => new URLSearchParams(window.location.search).get('roomId') ?? ''
    );

    const [c] = await createRoom(browser, 1, {
      roomId,
      expectedTotalPeers: 3,
    });
    await c.registerSharedState('msg', 'consensus');

    await c.waitForSharedState('msg', (v) => v === 'before-c', { timeout: CONVERGENCE_TIMEOUT });
    expect(await c.getSharedState('msg')).toBe('before-c');

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('sole peer commits immediately without waiting for others', async ({ browser }) => {
    const [a] = await createRoom(browser, 1);

    await a.registerSharedState('solo', 'consensus');

    await a.setSharedState('solo', 42);

    await a.waitForSharedState('solo', (v) => v === 42, { timeout: CONVERGENCE_TIMEOUT });
    expect(await a.getSharedState('solo')).toBe(42);

    await a.close();
  });
});
