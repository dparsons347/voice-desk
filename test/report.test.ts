import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/ghl/calendar.js";
import type { CallLog } from "../src/ghl/schemas.js";
import { buildReport, median } from "../src/report.js";
import { connect, fixture, parseText, testConfig } from "./helpers.js";

const logs = (name: string) => (fixture(`recorded/${name}`) as { callLogs: CallLog[] }).callLogs;
const [callback1, callback2] = logs("thats-automated-call-logs.sanitized.json");
const booked = fixture("recorded/thats-automated-booked-call.sanitized.json") as CallLog;
const dropped = fixture("recorded/thats-automated-dropped-call.sanitized.json") as CallLog;
const calendar = fixture("recorded/thats-automated-calendar-events.sanitized.json") as { events: CalendarEvent[] };
const [hvacHangup] = logs("hvac-example-call-logs.sanitized.json");

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([310, 6, 180])).toBe(180);
    expect(median([250, 310, 180, 23])).toBe(215);
    expect(median([])).toBeNull();
  });
});

describe("buildReport", () => {
  it("returns nulls rather than dividing by zero", () => {
    expect(buildReport([])).toMatchObject({ calls: 0, bookingRate: null, bookingRateEngaged: null, medianDurationSeconds: null, actionsFired: [] });
  });

  it("counts an action once per call even if it fired twice", () => {
    const action = callback1!.executedCallActions![0]!;
    const twice = { ...callback1!, executedCallActions: [action, action] };
    const r = buildReport([{ call: twice, outcome: { outcome: "callback_requested", reason: "" } }]);
    expect(r.actionsFired).toEqual([{ actionId: action.actionId, actionType: "WORKFLOW_TRIGGER", actionName: "Request a callback from Daniel", calls: 1 }]);
  });
});

describe("call_outcome_report on this month's live calls", () => {
  // Newest first, as the API returns them, plus a 6s hang-up to exercise the engaged rates.
  const hangup = { ...hvacHangup!, id: "hangup00000000000000001", agentId: booked.agentId, createdAt: "2026-10-01T12:00:00.000Z" };
  const page = { callLogs: [booked, dropped, callback1, callback2, hangup], total: 5, page: 1, pageSize: 50 };

  it("reports counts, rates, durations and actions", async () => {
    const { mcp } = await connect([{ body: page }], testConfig, { body: calendar });
    const r = parseText(await mcp.callTool({ name: "call_outcome_report", arguments: { since: "2026-10-01" } }));
    expect(r).toMatchObject({
      calls: 5,
      scanned: 5,
      excluded: 0,
      truncated: false,
      byOutcome: { booked: 1, callback_requested: 2, no_action: 1, abandoned: 1 },
      bookingRate: 0.2,
      bookingRateEngaged: 0.25,
      leadCaptureRateEngaged: 0.75,
      medianDurationSeconds: 180,
      totalTalkSeconds: 180 + 23 + 310 + 250 + 6,
      actionsFired: [{ actionType: "WORKFLOW_TRIGGER", actionName: "Request a callback from Daniel", calls: 2 }],
      byAgent: [{ agentId: booked.agentId, calls: 5, booked: 1, bookingRate: 0.2 }],
    });
    expect(r).not.toHaveProperty("returned");
  });

  it("does not offer a limit, and reads past one page", async () => {
    const { mcp, requests } = await connect(
      [{ body: fixture("synthetic/call-logs-page1.json") }, { body: fixture("synthetic/call-logs-page2.json") }],
      testConfig,
      { body: { events: [] } },
    );
    const { tools } = await mcp.listTools();
    expect(Object.keys(tools.find((t) => t.name === "call_outcome_report")!.inputSchema.properties!)).not.toContain("limit");
    const r = parseText(await mcp.callTool({ name: "call_outcome_report", arguments: { since: "2026-10-01" } }));
    expect(requests).toHaveLength(2);
    expect(r.calls).toBe(73);
  });
});
