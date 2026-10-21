import { describe, expect, it } from "vitest";
import { connect, fixture, parseText, testConfig } from "./helpers.js";

describe("ping", () => {
  it("reports configuration without calling HighLevel", async () => {
    const { mcp, requests } = await connect([]);
    const out = parseText(await mcp.callTool({ name: "ping", arguments: {} }));
    expect(out).toMatchObject({ server: "voice-desk", configured: { pit: true, locationId: true } });
    expect(requests).toHaveLength(0);
  });
});

describe("tool listing", () => {
  it("marks every tool read-only except execute_confirmed", async () => {
    const { mcp } = await connect([]);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["call_outcome_report", "calls_needing_followup", "execute_confirmed", "get_agent_config", "get_call", "list_calls", "ping", "propose_agent_change", "propose_followup_sms"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(["execute_confirmed"]);
    expect(tools.find((t) => t.name === "execute_confirmed")!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });
});

describe("list_calls", () => {
  it("excludes trial calls by default and sends locationId and the date range", async () => {
    const { mcp, requests } = await connect([{ body: fixture("synthetic/call-logs-page2.json") }]);
    await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", until: "2026-10-08" } });
    const q = requests[0]!.url.searchParams;
    expect(requests[0]!.url.pathname).toBe("/voice-ai/dashboard/call-logs");
    expect(q.get("callType")).toBe("LIVE");
    expect(q.get("locationId")).toBe("loc123");
    expect(q.get("startDate")).toBe(String(Date.parse("2026-10-01")));
    expect(q.get("endDate")).toBe(String(Date.parse("2026-10-08")));
  });

  it("omits the callType filter when includeTrial is true", async () => {
    const { mcp, requests } = await connect([{ body: fixture("synthetic/call-logs-page2.json") }]);
    await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", includeTrial: true } });
    expect(requests[0]!.url.searchParams.has("callType")).toBe(false);
  });

  it("pages through results and reports truncation", async () => {
    const { mcp, requests } = await connect([
      { body: fixture("synthetic/call-logs-page1.json") },
      { body: fixture("synthetic/call-logs-page2.json") },
    ]);
    const all = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", limit: 500 } }));
    expect(requests.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(all).toMatchObject({ returned: 73, total: 73, truncated: false });
    expect(all.calls[0]).toMatchObject({ callId: "synthcall0000000000000001", actionTypes: ["APPOINTMENT_BOOKING"] });
  });

  it("stops at the limit", async () => {
    const { mcp, requests } = await connect([{ body: fixture("synthetic/call-logs-page1.json") }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", limit: 10 } }));
    expect(requests).toHaveLength(1);
    expect(out).toMatchObject({ returned: 10, total: 73, truncated: true });
  });

  it("rejects an inverted range without calling HighLevel", async () => {
    const { mcp, requests } = await connect([]);
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-08", until: "2026-10-01" } });
    expect(res.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("returns a structured error Claude can explain", async () => {
    const { mcp } = await connect([{ status: 401, body: { message: "Invalid JWT" } }]);
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01" } });
    expect(res.isError).toBe(true);
    expect(parseText(res)).toMatchObject({ status: 401, safeToRetry: false, check: expect.stringMatching(/GHL_PIT/) });
  });

  it("explains a missing location id", async () => {
    const { mcp } = await connect([], { ...testConfig, locationId: undefined });
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01" } });
    expect(parseText(res).error).toMatch(/GHL_LOCATION_ID/);
  });
});

describe("recorded responses", () => {
  it("list_calls handles the live response shape", async () => {
    const { mcp } = await connect([{ body: fixture("recorded/hvac-example-call-logs.sanitized.json") }]);
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-09-01" } });
    expect(res.isError).toBeFalsy();
    expect(parseText(res)).toMatchObject({
      returned: 2,
      total: 2,
      truncated: false,
      calls: [
        { callId: "6ab154ebc00ea9294545de89", durationSeconds: 6, agentTransferOccurred: false, actionTypes: [] },
        { callId: "6aa46520964a65662f2af530", durationSeconds: 129, actionTypes: [] },
      ],
    });
  });
});

describe("recorded responses: That's Automated sales line", () => {
  it("list_calls reports the actions each call fired", async () => {
    const { mcp } = await connect([{ body: fixture("recorded/thats-automated-call-logs.sanitized.json") }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01" } }));
    expect(out.calls).toHaveLength(2);
    expect(out.calls.every((c: any) => c.actionTypes.join() === "WORKFLOW_TRIGGER")).toBe(true);
  });

  it("get_call returns executed actions with their names and timings", async () => {
    const page = fixture("recorded/thats-automated-call-logs.sanitized.json") as { callLogs: unknown[] };
    const { mcp } = await connect([{ body: page.callLogs[0] }]);
    const out = parseText(await mcp.callTool({ name: "get_call", arguments: { callId: "6ac91197d82ea79de4599b9c" } }));
    expect(out).toMatchObject({
      outcome: "callback_requested",
      reason: 'Callback action "Request a callback from Daniel" fired.',
      durationSeconds: 310,
      extractedData: { "SMS Consent On Call": "No", "Business Type": "electrical contractor" },
      executedCallActions: [
        { actionType: "WORKFLOW_TRIGGER", actionName: "Request a callback from Daniel", executedAt: "2026-10-09T16:13:01.451Z" },
      ],
    });
  });
});

describe("list_calls outcome filter", () => {
  // Page 1 of 50 synthetic calls, re-labelled: every 5th is a 6s hang-up, every 7th a callback.
  const page = structuredClone(fixture("synthetic/call-logs-page1.json")) as { callLogs: any[]; total: number };
  page.callLogs.forEach((c, i) => {
    if (i % 5 === 0) Object.assign(c, { duration: 6, executedCallActions: [] });
    else if (i % 7 === 0) c.executedCallActions = [{ actionId: "6ac84dd6f73c42f04a103504", actionType: "WORKFLOW_TRIGGER", actionName: "Request a callback from Daniel" }];
  });
  page.total = 50;

  it("adds outcome and reason to every call", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01" } }));
    expect(out.calls[0]).toMatchObject({ outcome: "abandoned", reason: expect.stringContaining("6s") });
    expect(out.calls[1]).toMatchObject({ outcome: "booked" });
  });

  it("returns only matching calls and reports how many it scanned", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", outcome: "abandoned" } }));
    expect(out).toMatchObject({ outcome: "abandoned", returned: 10, scanned: 50, total: 50, truncated: false });
    expect(out.calls.every((c: any) => c.outcome === "abandoned")).toBe(true);
  });

  it("marks the result truncated when the limit cuts the scan short", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", outcome: "callback_requested", limit: 2 } }));
    expect(out).toMatchObject({ returned: 2, truncated: true });
    expect(out.scanned).toBeLessThan(50);
  });

  it("rejects an unknown outcome", async () => {
    const { mcp, requests } = await connect([]);
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", outcome: "transferred" } });
    expect(res.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("booking check against the calendar", () => {
  const bookedCall = fixture("recorded/thats-automated-booked-call.sanitized.json");
  const calendar = { body: fixture("recorded/thats-automated-calendar-events.sanitized.json") };
  const page = { callLogs: [bookedCall], total: 1, page: 1, pageSize: 50 };

  it("list_calls marks the live booked call as booked", async () => {
    const { mcp, calendarRequests } = await connect([{ body: page }], testConfig, calendar);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-21", until: "2026-10-22" } }));
    expect(out.calls[0]).toMatchObject({ outcome: "booked", reason: "Appointment booked for 2026-10-22T09:00:00-05:00 (confirmed)." });
    const q = calendarRequests[0]!.url.searchParams;
    expect([q.get("calendarId"), q.get("locationId")]).toEqual(["cal123", "loc123"]);
    expect(q.get("startTime")).toBe(String(Date.parse("2026-10-21")));
    expect(q.get("endTime")).toBe(String(Date.parse("2026-10-22") + 30 * 86_400_000));
  });

  it("makes one calendar request per list, not per call", async () => {
    const { mcp, calendarRequests } = await connect(
      [{ body: fixture("synthetic/call-logs-page1.json") }, { body: fixture("synthetic/call-logs-page2.json") }],
      testConfig,
      calendar,
    );
    await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", limit: 500 } });
    expect(calendarRequests).toHaveLength(1);
  });

  it("list_calls credits one booking to one call when the caller redialled", async () => {
    const dropped = fixture("recorded/thats-automated-dropped-call.sanitized.json");
    const live = { callLogs: [bookedCall, dropped], total: 2, page: 1, pageSize: 50 };
    const generous = { ...testConfig, outcomeRules: { ...testConfig.outcomeRules, bookingGraceSeconds: 600 } };
    for (const outcome of [undefined, "no_action"]) {
      const { mcp } = await connect([{ body: live }], generous, calendar);
      const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-21", ...(outcome && { outcome }) } }));
      const byId = Object.fromEntries(out.calls.map((c: any) => [c.callId, c.outcome]));
      expect(byId["6ad90ca129516fbe6801ec3e"]).toBe("no_action");
      if (!outcome) expect(byId["6ad90cc853b34a1d70435f69"]).toBe("booked");
    }
  });

  it("the outcome filter finds it", async () => {
    const { mcp } = await connect([{ body: page }], testConfig, calendar);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-21", outcome: "booked" } }));
    expect(out).toMatchObject({ returned: 1, scanned: 1 });
  });

  it("get_call marks it booked", async () => {
    const { mcp } = await connect([{ body: bookedCall }], testConfig, calendar);
    const out = parseText(await mcp.callTool({ name: "get_call", arguments: { callId: "6ad90cc853b34a1d70435f69" } }));
    expect(out).toMatchObject({ outcome: "booked", executedCallActions: [] });
  });

  it("fails loudly with the scope to add when the calendar can't be read", async () => {
    const { mcp } = await connect([{ body: page }], testConfig, { status: 401, body: { message: "The token is not authorized for this scope." } });
    const res = await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-21" } });
    expect(res.isError).toBe(true);
    expect(parseText(res)).toMatchObject({ status: 401, safeToRetry: false, check: expect.stringContaining("missing the calendars/events.readonly scope") });
  });

  it("skips the calendar entirely when no booking calendar is configured", async () => {
    const off = { ...testConfig, outcomeRules: { ...testConfig.outcomeRules, bookingCalendarIds: [] } };
    const { mcp, calendarRequests } = await connect([{ body: page }], off, calendar);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-21" } }));
    expect(calendarRequests).toHaveLength(0);
    expect(out.calls[0].reason).toMatch(/BOOKING_CALENDAR_IDS is not set/);
  });
});

describe("get_call", () => {
  it("fetches one call by id and returns transcript, actions and contact", async () => {
    const { mcp, requests } = await connect([{ body: fixture("synthetic/call-log.json") }]);
    const out = parseText(await mcp.callTool({ name: "get_call", arguments: { callId: "synthcall0000000000000001" } }));
    expect(requests[0]!.url.pathname).toBe("/voice-ai/dashboard/call-logs/synthcall0000000000000001");
    expect(requests[0]!.url.searchParams.get("locationId")).toBe("loc123");
    expect(out).toMatchObject({
      callId: "synthcall0000000000000001",
      contactId: "synthcontact000000000001",
      durationSeconds: 142,
      transcript: "bot:Synthetic transcript.\nhuman:Synthetic reply.\n",
      executedCallActions: [{ actionType: "APPOINTMENT_BOOKING" }],
    });
  });

  it("refuses ids that could alter the request path", async () => {
    const { mcp, requests } = await connect([]);
    const res = await mcp.callTool({ name: "get_call", arguments: { callId: "../agents" } });
    expect(res.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("does not retry a 404", async () => {
    const { mcp, requests } = await connect([{ status: 404, body: { message: "Call log not found" } }]);
    const res = await mcp.callTool({ name: "get_call", arguments: { callId: "abc123" } });
    expect(parseText(res)).toMatchObject({ status: 404, safeToRetry: false });
    expect(requests).toHaveLength(1);
  });
});
