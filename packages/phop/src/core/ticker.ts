/**
 * Fixed-interval clock that keeps running in hidden tabs.
 *
 * Browsers pause requestAnimationFrame in background tabs and throttle
 * main-thread timers to once per second (or less). Dedicated-worker timers
 * are not throttled, so a tiny worker posts the heartbeat. Falls back to a
 * main-thread interval where Worker is unavailable.
 *
 * Returns a stop function.
 */
export function startTicker(intervalMs: number, onTick: (now: number) => void): () => void {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    const id = setInterval(() => onTick(performance.now()), intervalMs);
    return () => clearInterval(id);
  }

  const source = `setInterval(() => postMessage(0), ${intervalMs});`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = () => onTick(performance.now());
  return () => {
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}
