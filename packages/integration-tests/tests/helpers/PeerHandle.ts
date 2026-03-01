import type { BrowserContext, Page } from '@playwright/test';
import type { SerializedStrategy } from '../../harness/src/exposePhopApi';

type JSONSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | JSONSerializable[]
  | { [key: string]: JSONSerializable };

export interface ReceivedMessage {
  senderId: string;
  data: JSONSerializable;
  timestamp: number;
}

const DEFAULT_TIMEOUT = 10_000;

/**
 * Typed wrapper around a Playwright Page for controlling a single phop peer.
 *
 * Every method delegates to window.__phop via page.evaluate().
 * All waitFor* methods poll until the condition is met or the timeout expires.
 */
export class PeerHandle {
  readonly page: Page;
  private readonly context: BrowserContext;

  constructor(page: Page, context: BrowserContext) {
    this.page = page;
    this.context = context;
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  peerId(): Promise<string> {
    return this.page.evaluate(() => window.__phop.peerId);
  }

  /** Returns all peers in the room including self. */
  peers(): Promise<string[]> {
    return this.page.evaluate(() => window.__phop.peers);
  }

  /**
   * Waits until peers.length === count (total including self, signalling layer).
   */
  async waitForPeers(count: number, options?: { timeout?: number }): Promise<void> {
    await this.page.waitForFunction(
      (expected: number) => window.__phop.peers.length === expected,
      count,
      { timeout: options?.timeout ?? DEFAULT_TIMEOUT }
    );
  }

  /**
   * Waits until data channels are open to `count` remote peers (excludes self).
   * Use this instead of waitForPeers when you need to send/receive messages —
   * peers.length updates from the signalling server, but data channels open
   * asynchronously via WebRTC negotiation.
   */
  async waitForConnections(count: number, options?: { timeout?: number }): Promise<void> {
    await this.page.waitForFunction(
      (expected: number) => window.__phop.connectedPeerCount >= expected,
      count,
      { timeout: options?.timeout ?? DEFAULT_TIMEOUT }
    );
  }

  // ---------------------------------------------------------------------------
  // Shared state
  // ---------------------------------------------------------------------------

  /**
   * Registers a named shared-state key, optionally with a merge strategy.
   * Must be called before setSharedState / getSharedState / waitForSharedState.
   * Returns a Promise that resolves once the useSharedState hook has mounted.
   */
  registerSharedState(key: string, strategy?: SerializedStrategy): Promise<void> {
    return this.page.evaluate(
      ([k, s]: [string, SerializedStrategy | undefined]) => window.__phop.registerSharedState(k, s),
      [key, strategy] as [string, SerializedStrategy | undefined]
    );
  }

  setSharedState(key: string, value: JSONSerializable): Promise<void> {
    return this.page.evaluate(
      ([k, v]: [string, JSONSerializable]) => window.__phop.setSharedState(k, v),
      [key, value] as [string, JSONSerializable]
    );
  }

  getSharedState(key: string): Promise<JSONSerializable | null> {
    return this.page.evaluate((k: string) => window.__phop.getSharedState(k), key);
  }

  /**
   * Polls until the shared state for `key` satisfies `predicate`.
   */
  async waitForSharedState(
    key: string,
    predicate: (v: JSONSerializable | null) => boolean,
    options?: { timeout?: number }
  ): Promise<void> {
    await this.page.waitForFunction(
      ([k, predicateStr]: [string, string]) => {
        const fn = new Function(`return (${predicateStr})`)() as (
          v: JSONSerializable | null
        ) => boolean;
        return fn(window.__phop.getSharedState(k));
      },
      [key, predicate.toString()] as [string, string],
      { timeout: options?.timeout ?? DEFAULT_TIMEOUT }
    );
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  broadcast(data: JSONSerializable): Promise<void> {
    return this.page.evaluate((d: JSONSerializable) => window.__phop.broadcast(d), data);
  }

  sendToPeer(peerId: string, data: JSONSerializable): Promise<void> {
    return this.page.evaluate(
      ([id, d]: [string, JSONSerializable]) => window.__phop.sendToPeer(id, d),
      [peerId, data] as [string, JSONSerializable]
    );
  }

  /**
   * Resolves with the next message in the incoming queue.
   * Messages are queued from the moment the page loads — none are dropped.
   */
  async nextMessage(options?: { timeout?: number }): Promise<ReceivedMessage> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const start = Date.now();

    while (true) {
      const msg = await this.page.evaluate(() => window.__phop.__msgQueue.shift() ?? null);

      if (msg !== null) {
        return msg as ReceivedMessage;
      }

      if (Date.now() - start > timeout) {
        throw new Error(`nextMessage: timed out after ${timeout}ms`);
      }

      await this.page.waitForTimeout(50);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Closes the page and its BrowserContext, releasing all WebRTC resources. */
  async close(): Promise<void> {
    await this.context.close();
  }
}
