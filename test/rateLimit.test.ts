import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryAuditLog } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { HighLevelClient } from "../src/ghl/client.js";
import { TokenBucket } from "../src/rateLimit.js";
import { fakeFetch, testConfig, type Reply } from "./helpers.js";

/** A clock that only moves when the bucket sleeps, so waits are exact and instant. */
function fakeTime() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms), advance: (ms: number) => (now += ms) };
}

describe("TokenBucket", () => {
  it("allows a full burst, then spaces requests at the refill rate", async () => {
    const t = fakeTime();
    const bucket = TokenBucket.perWindow(80, 10_000, t.now, t.sleep);
    const waits = [];
    for (let i = 0; i < 82; i++) waits.push(await bucket.acquire());
    expect(waits.slice(0, 80).every((w) => w === 0)).toBe(true);
    expect(waits.slice(80)).toEqual([125, 125]); // 10s / 80
  });

  /** Most requests that fall in any 10-second window, given each request's send time. */
  const worstWindow = (times: number[]) => Math.max(...times.map((start) => times.filter((x) => x >= start && x < start + 10_000).length));

  async function sendTimes(bucket: TokenBucket, t: ReturnType<typeof fakeTime>, n: number) {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      await bucket.acquire();
      times.push(t.now());
    }
    return times;
  }

  it("a plain bucket can pass twice its size in one window (why capped() exists)", async () => {
    const t = fakeTime();
    expect(worstWindow(await sendTimes(TokenBucket.perWindow(80, 10_000, t.now, t.sleep), t, 400))).toBeGreaterThan(100);
  });

  it.each([80, 100, 10, 1])("capped(%i) never passes more than that in any 10-second window", async (cap) => {
    const t = fakeTime();
    const times = await sendTimes(TokenBucket.capped(cap, 10_000, t.now, t.sleep), t, 400);
    expect(worstWindow(times)).toBeLessThanOrEqual(cap);
  });

  it("capped(80) still sustains close to 80 per window", async () => {
    const t = fakeTime();
    const times = await sendTimes(TokenBucket.capped(80, 10_000, t.now, t.sleep), t, 400);
    // 20 at once, then 60 per 10s: 400 requests take a little over 63 seconds.
    expect(times.at(-1)! / 1000).toBeCloseTo(((400 - 20) / 60) * 10, 0);
  });

  it("serves parallel callers in order", async () => {
    const t = fakeTime();
    const bucket = TokenBucket.perWindow(1, 1_000, t.now, t.sleep);
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => bucket.acquire().then((w) => order.push(i) && w)));
    expect(order).toEqual([0, 1, 2]);
    expect(t.now()).toBe(2_000);
  });

  it("refills while idle but never above capacity", async () => {
    const t = fakeTime();
    const bucket = TokenBucket.perWindow(2, 1_000, t.now, t.sleep);
    await bucket.acquire();
    await bucket.acquire();
    t.advance(60_000);
    expect([await bucket.acquire(), await bucket.acquire(), await bucket.acquire()]).toEqual([0, 0, 500]);
  });

  it("trusts HighLevel's lower remaining count, but never raises its own", async () => {
    const t = fakeTime();
    const bucket = TokenBucket.perWindow(80, 10_000, t.now, t.sleep);
    bucket.observeRemaining(0);
    expect(await bucket.acquire()).toBe(125);
    const fresh = TokenBucket.perWindow(2, 1_000, t.now, t.sleep);
    await fresh.acquire();
    fresh.observeRemaining(99);
    await fresh.acquire();
    expect(await fresh.acquire()).toBe(500);
  });
});

describe("HighLevelClient with a limiter", () => {
  const req = { tool: "t", operation: "voice-ai.call-logs.list", path: "/voice-ai/x", schema: z.object({ ok: z.boolean() }) };
  const ok = (headers?: Record<string, string>): Reply => ({ body: { ok: true }, headers });

  function setup(replies: Reply[], capacity: number, config = testConfig) {
    const t = fakeTime();
    const audit = new MemoryAuditLog();
    const fetch = fakeFetch(replies);
    const client = new HighLevelClient(config, {
      audit,
      fetch: fetch.fn,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {} },
      limiter: TokenBucket.perWindow(capacity, 10_000, t.now, t.sleep),
    });
    return { client, audit, t, requests: fetch.requests };
  }

  it("throttles reads past the limit and records the wait", async () => {
    const { client, audit } = setup([ok(), ok(), ok()], 2);
    for (let i = 0; i < 3; i++) await client.read(req);
    expect(audit.entries.map((e) => e.throttledMs)).toEqual([undefined, undefined, 5_000]);
  });

  it("counts every retry attempt against the limit", async () => {
    const { client, audit } = setup([{ status: 503 }, ok()], 1);
    await client.read(req);
    expect(audit.entries.map((e) => [e.attempt, e.throttledMs])).toEqual([
      [1, undefined],
      [2, 10_000],
    ]);
  });

  it("slows down when HighLevel says the window is nearly used up", async () => {
    const { client, audit } = setup([ok({ "x-ratelimit-remaining": "0" }), ok()], 80);
    await client.read(req);
    await client.read(req);
    expect(audit.entries[1]!.throttledMs).toBe(125);
  });

  it("throttles writes too, but not dry runs", async () => {
    const write = { tool: "t", operation: "conversations.messages.send", method: "POST" as const, path: "/m", body: {} };
    const live = setup([ok(), ok()], 1);
    await live.client.write(write);
    await live.client.write(write);
    expect(live.audit.entries.map((e) => e.throttledMs)).toEqual([undefined, 10_000]);

    const dry = setup([], 1, { ...testConfig, dryRun: true });
    await dry.client.write(write);
    await dry.client.write(write);
    expect(dry.t.now()).toBe(0);
  });
});

describe("RATE_LIMIT_PER_10S", () => {
  it("defaults to 80 and refuses anything above HighLevel's 100", () => {
    expect(loadConfig({}).rateLimitPer10s).toBe(80);
    expect(loadConfig({ RATE_LIMIT_PER_10S: "50" }).rateLimitPer10s).toBe(50);
    expect(() => loadConfig({ RATE_LIMIT_PER_10S: "150" })).toThrow();
  });
});
