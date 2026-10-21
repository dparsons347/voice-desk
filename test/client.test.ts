import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, GhlApiError } from "../src/errors.js";
import { makeClient, testConfig } from "./helpers.js";

const req = { tool: "t", operation: "op", path: "/voice-ai/x", schema: z.object({ ok: z.boolean() }) };

describe("HighLevelClient.read", () => {
  it("sends the PIT and Version headers and the query string", async () => {
    const { client, requests } = makeClient([{ body: { ok: true } }]);
    await client.read({ ...req, query: { a: 1, skip: undefined } });
    expect(requests[0]!.headers).toMatchObject({ Authorization: "Bearer pit-test-token", Version: "2021-07-28" });
    expect(requests[0]!.url.toString()).toBe("https://ghl.test/voice-ai/x?a=1");
  });

  it("retries 429 and 5xx, writing an audit line per attempt", async () => {
    const { client, audit } = makeClient([{ status: 429 }, { status: 503 }, { body: { ok: true } }]);
    await expect(client.read(req)).resolves.toEqual({ ok: true });
    expect(audit.entries.map((e) => [e.attempt, e.status, e.outcome])).toEqual([
      [1, 429, "retrying"],
      [2, 503, "retrying"],
      [3, 200, "ok"],
    ]);
  });

  it("gives up after 3 attempts with safeToRetry true", async () => {
    const { client, audit } = makeClient([{ status: 500 }, { status: 500 }, { status: 500 }, { body: { ok: true } }]);
    const err = await client.read(req).catch((e) => e);
    expect(err).toBeInstanceOf(GhlApiError);
    expect(err).toMatchObject({ status: 500, safeToRetry: true });
    expect(audit.entries).toHaveLength(3);
    expect(audit.entries[2]!.outcome).toBe("failed");
  });

  it("retries network errors", async () => {
    const { client, audit } = makeClient([new TypeError("fetch failed"), { body: { ok: true } }]);
    await expect(client.read(req)).resolves.toEqual({ ok: true });
    expect(audit.entries[0]).toMatchObject({ status: "network_error", outcome: "retrying" });
  });

  it("does not retry 4xx, and explains what to check", async () => {
    const { client, audit } = makeClient([{ status: 403, body: { message: "The token is not authorized for this scope." } }]);
    const err = await client.read({ ...req, operation: "voice-ai.call-logs.list" }).catch((e) => e);
    expect(audit.entries).toHaveLength(1);
    expect(err).toMatchObject({ status: 403, safeToRetry: false, detail: "The token is not authorized for this scope." });
    expect(err.check).toMatch(/missing the voice-ai-dashboard.readonly scope/);
  });

  it("treats a 401 that names a scope as a missing scope, not a bad token", async () => {
    const { client } = makeClient([{ status: 401, body: { message: "The token is not authorized for this scope." } }]);
    const err = await client.read(req).catch((e) => e);
    expect(err.check).toMatch(/missing a scope this request needs/); // "op" is not a known operation
    expect(err.check).not.toMatch(/Regenerate/);
  });

  it("treats any other 401 as a rejected token", async () => {
    const { client } = makeClient([{ status: 401, body: { message: "Invalid JWT" } }]);
    expect((await client.read(req).catch((e) => e)).check).toMatch(/Regenerate/);
  });

  it("rejects a response that fails the schema without retrying", async () => {
    const { client, audit } = makeClient([{ body: { nope: 1 } }]);
    const err = await client.read(req).catch((e) => e);
    expect(err).toMatchObject({ safeToRetry: false });
    expect(err.detail).toMatch(/^ok:/);
    expect(audit.entries).toHaveLength(1);
  });

  it("fails clearly, without calling HighLevel, when the PIT is missing", async () => {
    const { client, requests } = makeClient([], { ...testConfig, pit: undefined });
    await expect(client.read(req)).rejects.toBeInstanceOf(ConfigError);
    expect(requests).toHaveLength(0);
  });
});

describe("OPERATION_SCOPES", () => {
  it("every operation used has a scope", async () => {
    const { OPERATION_SCOPES } = await import("../src/errors.js");
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/ghl/", import.meta.url);
    const ops = readdirSync(dir).flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/operation: "([^"]+)"/g)].map((m) => m[1]!));
    expect(ops.length).toBeGreaterThan(8);
    expect(ops.filter((o) => !OPERATION_SCOPES[o])).toEqual([]);
  });
});
