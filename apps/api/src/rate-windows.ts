/**
 * Fixed-window counters for the in-memory rate guards.
 *
 * Limits are PER PROCESS: every API instance (and every guard instance) keeps its
 * own map, so N instances allow N times the configured rate, and a restart clears
 * all windows. A shared store is needed before running more than one instance.
 *
 * When the map is full, the window closest to expiry is evicted instead of
 * refusing every new client. All windows have the same length and a Map keeps
 * insertion order, so the first entry is always the oldest.
 */
export class RateWindows {
  private readonly windows = new Map<string, { count: number; until: number }>();

  constructor(private readonly maxKeys = 10_000, private readonly windowMs = 60_000) {}

  /** Counts one hit for `key` and returns the count in its current window. */
  hit(key: string, now = Date.now()): number {
    for (const [oldest, window] of this.windows) {
      if (window.until > now) break;
      this.windows.delete(oldest);
    }
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
      window = { count: 0, until: now + this.windowMs };
      this.windows.set(key, window);
    }
    return ++window.count;
  }
}
