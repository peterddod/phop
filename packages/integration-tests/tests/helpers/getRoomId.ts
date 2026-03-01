import type { Page } from '@playwright/test';

/** Reads the roomId query param from the harness page URL. Throws if absent. */
export async function getRoomId(page: Page): Promise<string> {
  const roomId = await page.evaluate(() => new URLSearchParams(location.search).get('roomId'));
  if (!roomId) {
    throw new Error('roomId not found in page URL');
  }
  return roomId;
}
