export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const READ_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

export interface RetryDecision {
  retryable: boolean;
  /** Server-requested wait (Retry-After), if any. */
  retryAfterMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, honouring Retry-After as a floor. */
export function backoffDelay(attempt: number, opts: RetryOptions, retryAfterMs?: number): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round((opts.random ?? Math.random)() * ceiling);
  return retryAfterMs === undefined ? jittered : Math.min(opts.maxDelayMs, Math.max(retryAfterMs, jittered));
}

/**
 * Runs `fn` up to `opts.attempts` times. Only for reads: writes must never go
 * through this, because a timed-out write may still have landed.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => RetryDecision,
  opts: RetryOptions = READ_RETRY,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const decision = classify(err);
      if (!decision.retryable || attempt >= opts.attempts) throw err;
      await sleep(backoffDelay(attempt, opts, decision.retryAfterMs));
    }
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
