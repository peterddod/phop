import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTicker } from '../core/ticker';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startTicker', () => {
  it('falls back to setInterval when creating the worker throws', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked by CSP');
        }
      }
    );
    const onTick = vi.fn();
    const stop = startTicker(50, onTick);
    vi.advanceTimersByTime(200);
    expect(onTick).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(200);
    expect(onTick).toHaveBeenCalledTimes(4);
  });
});
