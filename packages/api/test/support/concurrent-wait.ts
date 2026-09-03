/**
 * Test helper for concurrency tests with bounded waits and immediate rejection
 * on observed concurrent operation failures.
 */
export class ConcurrentWaitHelper {
  private observedError: unknown = null;
  private hasObservedError = false;
  private listeners: Set<() => void> = new Set();

  /**
   * Observe a promise. Attaches a rejection handler to avoid unhandled rejection
   * warnings, records the first observed error, and notifies active waiters.
   * Returns the original promise unmodified.
   */
  observe<T>(promise: Promise<T>): Promise<T> {
    promise.catch((err) => {
      if (!this.hasObservedError) {
        this.hasObservedError = true;
        this.observedError = err;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            // ignore listener callback errors
          }
        }
      }
    });
    return promise;
  }

  /**
   * Wait until the predicate returns true, or reject immediately if an observed
   * promise rejects, or reject on timeout.
   * All timers are cleared upon settling.
   */
  async waitUntil(
    predicate: () => boolean,
    timeoutMs = 5000,
    timeoutMessage = 'Timed out waiting for condition',
  ): Promise<void> {
    if (this.hasObservedError) {
      throw this.observedError;
    }
    if (predicate()) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let intervalTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (intervalTimer !== null) {
          clearInterval(intervalTimer);
          intervalTimer = null;
        }
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.listeners.delete(onFailure);
      };

      const check = () => {
        if (settled) return;
        if (this.hasObservedError) {
          const err = this.observedError;
          cleanup();
          reject(err);
          return;
        }
        try {
          if (predicate()) {
            cleanup();
            resolve();
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const onFailure = () => {
        if (settled) return;
        const err = this.observedError;
        cleanup();
        reject(err);
      };

      this.listeners.add(onFailure);

      intervalTimer = setInterval(check, 1);
      intervalTimer?.unref?.();

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`${timeoutMessage} (waited ${timeoutMs}ms)`));
      }, timeoutMs);
      timeoutTimer?.unref?.();

      // Check immediately
      check();
    });
  }
}
