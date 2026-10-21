import { describe, expect, it } from "vitest";
import { backoffDelay, parseRetryAfter, withRetry } from "../src/retry.js";

const opts = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, sleep: async () => {}, random: () => 1 };

describe("withRetry", () => {
  it("retries retryable failures up to 3 attempts, then throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, () => ({ retryable: true }), opts),
    ).rejects.toThrow("fail 3");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable failures", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("no"); }, () => ({ retryable: false }), opts)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("returns as soon as an attempt succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => { if (++calls < 2) throw new Error("x"); return "ok"; }, () => ({ retryable: true }), opts);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("sleeps with exponential backoff between attempts", async () => {
    const slept: number[] = [];
    await withRetry(async () => { throw new Error("x"); }, () => ({ retryable: true }), { ...opts, sleep: async (ms) => { slept.push(ms); } }).catch(() => {});
    expect(slept).toEqual([100, 200]);
  });
});

describe("backoffDelay", () => {
  it("applies full jitter below the exponential ceiling", () => {
    expect(backoffDelay(3, { ...opts, random: () => 0.5 })).toBe(200);
  });
  it("caps at maxDelayMs", () => {
    expect(backoffDelay(10, opts)).toBe(1000);
  });
  it("treats Retry-After as a floor, still capped", () => {
    expect(backoffDelay(1, { ...opts, random: () => 0 }, 700)).toBe(700);
    expect(backoffDelay(1, opts, 60_000)).toBe(1000);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
