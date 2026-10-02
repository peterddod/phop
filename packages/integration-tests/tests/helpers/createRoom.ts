import type { Browser } from '@playwright/test';
import { PeerHandle } from './PeerHandle';

const HARNESS_URL = process.env.HARNESS_URL ?? 'http://localhost:9000';
const DEFAULT_SERVER_URL = 'ws://localhost:8080';

interface CreateRoomOptions {
  /** Provide an existing roomId to join a room that is already running. */
  roomId?: string;
  serverUrl?: string;
  /**
   * Total number of peers expected in the room once all spawned peers have joined.
   * Use this when joining an existing room so waitForPeers waits for the full mesh,
   * not just the peers spawned in this call.
   *
   * Defaults to `peerCount` (i.e. a fresh room with only these peers).
   */
  expectedTotalPeers?: number;
  /** Mount the lobby/simulation probe (`window.__game`). */
  game?: boolean;
  /** `<Room metadata>` for each spawned peer, by spawn index. */
  metadata?: (index: number) => Record<string, unknown>;
}

/**
 * Spawns `peerCount` isolated browser contexts, each navigated to the harness
 * app with the same roomId. Waits until every spawned peer sees the full mesh
 * before resolving.
 *
 * Each peer runs in its own BrowserContext so WebRTC state is fully isolated.
 * Call PeerHandle.close() to tear down each peer.
 *
 * @param browser - Playwright Browser instance (from the `browser` fixture).
 * @param peerCount - Number of peers to spawn.
 * @param options - Optional roomId, serverUrl, and expectedTotalPeers overrides.
 * @returns Array of PeerHandles in join order.
 */
export async function createRoom(
  browser: Browser,
  peerCount: number,
  options: CreateRoomOptions = {}
): Promise<PeerHandle[]> {
  const roomId = options.roomId ?? crypto.randomUUID();
  const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
  const totalPeers = options.expectedTotalPeers ?? peerCount;

  const baseUrl = `${HARNESS_URL}/?roomId=${encodeURIComponent(roomId)}&serverUrl=${encodeURIComponent(serverUrl)}${options.game ? '&game=1' : ''}`;

  const handles: PeerHandle[] = [];

  for (let i = 0; i < peerCount; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const metadata = options.metadata?.(i);
    await page.goto(
      metadata ? `${baseUrl}&meta=${encodeURIComponent(JSON.stringify(metadata))}` : baseUrl
    );

    // Wait for window.__phop to be initialised before handing the handle back.
    await page.waitForFunction(
      () => typeof window.__phop !== 'undefined' && window.__phop.peerId !== ''
    );

    handles.push(new PeerHandle(page, context));
  }

  // Wait for all spawned peers to see the full signalling mesh.
  await Promise.all(handles.map((h) => h.waitForPeers(totalPeers)));

  // Then wait for all data channels to be open (totalPeers - 1 connections per peer).
  if (totalPeers > 1) {
    await Promise.all(handles.map((h) => h.waitForConnections(totalPeers - 1)));
  }

  return handles;
}
