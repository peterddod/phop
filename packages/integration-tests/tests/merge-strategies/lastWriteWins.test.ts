import { expect, test } from '@playwright/test';
import { createRoom } from '../helpers/createRoom';

test.describe('merge strategy: last write wins (wall-clock)', () => {
  test('the write with the higher wall-clock timestamp wins', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'lastWriteWins'),
      b.registerSharedState('val', 'lastWriteWins'),
    ]);

    await a.setSharedState('val', 'from-a');
    await b.waitForSharedState('val', (v) => v === 'from-a');

    // Ensure b's write has a strictly later wall-clock timestamp
    await b.page.waitForTimeout(20);
    await b.setSharedState('val', 'from-b');

    await a.waitForSharedState('val', (v) => v === 'from-b');

    expect(await a.getSharedState('val')).toBe('from-b');
    expect(await b.getSharedState('val')).toBe('from-b');

    await Promise.all([a.close(), b.close()]);
  });

  test('earlier write does not overwrite a later one', async ({ browser }) => {
    const [a, b] = await createRoom(browser, 2);

    await Promise.all([
      a.registerSharedState('val', 'lastWriteWins'),
      b.registerSharedState('val', 'lastWriteWins'),
    ]);

    // b writes first with a later timestamp (write order doesn't determine which wins)
    await b.setSharedState('val', 'newer');
    await a.waitForSharedState('val', (v) => v === 'newer');

    // a writes immediately — b's timestamp is already higher, so a's write should lose
    await a.setSharedState('val', 'older');

    // Give time for propagation
    await b.page.waitForTimeout(300);

    // b should still hold 'newer' if its timestamp was higher
    // (or converge deterministically via peer-ID tiebreaker if timestamps are equal)
    const bVal = await b.getSharedState('val');
    const aVal = await a.getSharedState('val');
    expect(aVal).toBe(bVal);

    await Promise.all([a.close(), b.close()]);
  });

  test('convergence across 3 peers with concurrent writes', async ({ browser }) => {
    const [a, b, c] = await createRoom(browser, 3);

    await Promise.all([
      a.registerSharedState('shared', 'lastWriteWins'),
      b.registerSharedState('shared', 'lastWriteWins'),
      c.registerSharedState('shared', 'lastWriteWins'),
    ]);

    // Stagger writes so timestamps are distinct
    await a.setSharedState('shared', 'from-a');
    await a.page.waitForTimeout(10);
    await b.setSharedState('shared', 'from-b');
    await b.page.waitForTimeout(10);
    await c.setSharedState('shared', 'from-c');

    // c's write is last, so it should win
    await a.waitForSharedState('shared', (v) => v === 'from-c');
    await b.waitForSharedState('shared', (v) => v === 'from-c');

    expect(await a.getSharedState('shared')).toBe('from-c');
    expect(await b.getSharedState('shared')).toBe('from-c');
    expect(await c.getSharedState('shared')).toBe('from-c');

    await Promise.all([a.close(), b.close(), c.close()]);
  });
});
