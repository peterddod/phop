import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';

test.describe('merge strategy: Lamport clock', () => {
  test('two peers converge to the same value after concurrent writes', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'lamport'),
      b.registerSharedState('val', 'lamport'),
    ]);

    // Write concurrently from both peers
    await Promise.all([a.setSharedState('val', 'from-a'), b.setSharedState('val', 'from-b')]);

    // Both must eventually converge to the same value
    await a.waitForSharedState('val', (v) => v === 'from-a' || v === 'from-b');
    await b.waitForSharedState('val', (v) => v === 'from-a' || v === 'from-b');

    const aVal = await a.getSharedState('val');
    const bVal = await b.getSharedState('val');

    expect(aVal).toBe(bVal);

    await Promise.all([a.close(), b.close()]);
  });

  test('causally later write wins regardless of wall-clock arrival order', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('counter', 'lamport'),
      b.registerSharedState('counter', 'lamport'),
    ]);

    // a writes first (clock = 1), then b writes (clock = 2)
    await a.setSharedState('counter', 1);
    await b.waitForSharedState('counter', (v) => v === 1);

    await b.setSharedState('counter', 2);
    await a.waitForSharedState('counter', (v) => v === 2);

    // b's write had a higher Lamport clock, so 2 should win everywhere
    expect(await a.getSharedState('counter')).toBe(2);
    expect(await b.getSharedState('counter')).toBe(2);

    await Promise.all([a.close(), b.close()]);
  });

  test('three peers all converge to the same value', async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    await Promise.all([
      a.registerSharedState('shared', 'lamport'),
      b.registerSharedState('shared', 'lamport'),
      c.registerSharedState('shared', 'lamport'),
    ]);

    await Promise.all([
      a.setSharedState('shared', 'from-a'),
      b.setSharedState('shared', 'from-b'),
      c.setSharedState('shared', 'from-c'),
    ]);

    // Wait for all to stabilise
    await a.waitForSharedState('shared', (v) => v !== null);
    await b.waitForSharedState('shared', (v) => v !== null);
    await c.waitForSharedState('shared', (v) => v !== null);

    // Give enough time for convergence
    await a.page.waitForTimeout(1000);

    const aVal = await a.getSharedState('shared');
    const bVal = await b.getSharedState('shared');
    const cVal = await c.getSharedState('shared');

    expect(aVal).toBe(bVal);
    expect(bVal).toBe(cVal);

    await Promise.all([a.close(), b.close(), c.close()]);
  });
});
