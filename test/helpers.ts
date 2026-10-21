import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryAuditLog } from "../src/audit.js";
import type { Config } from "../src/config.js";
import { HighLevelClient } from "../src/ghl/client.js";
import { createServer, type ServerDeps } from "../src/server.js";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures", name), "utf8"));
}

export const testConfig: Config = {
  pit: "pit-test-token",
  locationId: "loc123",
  baseUrl: "https://ghl.test",
  apiVersion: "2021-07-28",
  auditLogPath: "/dev/null",
  excludeFromNumbers: ["+1 (555) 555-0199"],
  dryRun: false,
  rateLimitPer10s: 80,
  sms: { consentField: "SMS Consent On Call" },
  outcomeRules: {
    abandonThresholdSeconds: 20,
    callbackActionIds: new Set(["6ac84dd6f73c42f04a103504"]),
    bookingCalendarIds: ["cal123"],
    bookingLookaheadDays: 30,
    bookingGraceSeconds: 60,
  },
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;
type Recorded = { url: URL; method: string; headers: Record<string, string>; body: any };

/**
 * fetch stub that replays `replies` in order and records each request URL.
 * Calendar requests are answered separately with `calendar` (no bookings by
 * default) and recorded in `calendarRequests`, so call-log tests see the same
 * request sequence they always did.
 */
export function fakeFetch(replies: Reply[], calendar: Reply = { body: { events: [] } }) {
  const requests: Recorded[] = [];
  const calendarRequests: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const recorded = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    const isCalendar = recorded.url.pathname === "/calendars/events";
    (isCalendar ? calendarRequests : requests).push(recorded);
    const reply = isCalendar ? calendar : replies.shift();
    if (!reply) throw new Error("fakeFetch: no reply queued");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fn, requests, calendarRequests };
}

export function makeClient(replies: Reply[], config: Config = testConfig, calendar?: Reply) {
  const audit = new MemoryAuditLog();
  const fetch = fakeFetch(replies, calendar);
  const client = new HighLevelClient(config, {
    audit,
    fetch: fetch.fn,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {} },
  });
  return { client, audit, requests: fetch.requests, calendarRequests: fetch.calendarRequests };
}

export async function connect(replies: Reply[], config: Config = testConfig, calendar?: Reply, extra: Partial<ServerDeps> = {}) {
  const made = makeClient(replies, config, calendar);
  const server = createServer({ config, client: made.client, ...extra });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(clientT);
  return { ...made, mcp };
}

export function parseText(result: { content?: unknown }): any {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first!.text);
}
