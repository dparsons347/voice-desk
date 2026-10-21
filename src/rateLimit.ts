/**
 * Token bucket that keeps voice-desk under HighLevel's burst limit. HighLevel
 * reports 100 requests per 10 seconds per app and location (response headers
 * x-ratelimit-max / x-ratelimit-interval-milliseconds, checked 2026-10-21), so
 * the default cap leaves headroom at 80.
 *
 * In any window a token bucket can pass its capacity plus what it refills
 * during that window. A bucket holding 80 and refilling 80 per 10s can pass
 * 160 in 10s, over HighLevel's limit. capped() splits the cap between the two
 * so their sum is the cap.
 *
 * Callers are served in arrival order: acquire() chains onto a queue, so a
 * burst of parallel requests (e.g. one calendar lookup per booking calendar)
 * is spread out rather than racing for the same token.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    /** Tokens added per millisecond. */
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Capacity `requests`, refilling `requests` per window. Up to twice that can pass in one window. */
  static perWindow(requests: number, windowMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>): TokenBucket {
    return new TokenBucket(requests, requests / windowMs, now, sleep);
  }

  /**
   * At most `maxPerWindow` requests in any window of `windowMs`: a quarter of
   * the cap as an initial burst, the rest as steady refill.
   */
  static capped(maxPerWindow: number, windowMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>): TokenBucket {
    const burst = Math.max(1, Math.floor(maxPerWindow / 4));
    const steady = Math.max(1, maxPerWindow - burst);
    return new TokenBucket(burst, steady / windowMs, now, sleep);
  }

  /** Resolves when a request may go out, with how long it had to wait. */
  acquire(): Promise<number> {
    const turn = this.queue.then(() => this.take());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /**
   * HighLevel's own count of requests left in the current window. If it is
   * lower than ours (another integration sharing the limit, or a restart that
   * forgot recent requests), trust it. It never raises our count.
   */
  observeRemaining(remaining: number): void {
    if (!Number.isFinite(remaining)) return;
    this.refill();
    this.tokens = Math.min(this.tokens, Math.max(0, remaining));
  }

  private async take(): Promise<number> {
    this.refill();
    let waited = 0;
    if (this.tokens < 1) {
      waited = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await this.sleep(waited);
      this.refill();
    }
    this.tokens -= 1;
    return waited;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
  }
}
