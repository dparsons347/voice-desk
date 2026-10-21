import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/ghl/calendar.js";
import type { CallLog } from "../src/ghl/schemas.js";
import { needsFollowup, summaryClaimsBooking } from "../src/followup.js";
import { deriveOutcome, indexBookings } from "../src/outcomes.js";
import { normalisePhone } from "../src/scan.js";
import { connect, fixture, parseText, testConfig } from "./helpers.js";

const rules = testConfig.outcomeRules;
const logs = (name: string) => (fixture(`recorded/${name}`) as { callLogs: CallLog[] }).callLogs;
const [callback1, callback2] = logs("thats-automated-call-logs.sanitized.json");
const [hvacHangup, hvacClaimedBooking] = logs("hvac-example-call-logs.sanitized.json");
const booked = fixture("recorded/thats-automated-booked-call.sanitized.json") as CallLog;
const dropped = fixture("recorded/thats-automated-dropped-call.sanitized.json") as CallLog;
const calendar = fixture("recorded/thats-automated-calendar-events.sanitized.json") as { events: CalendarEvent[] };
const bookings = indexBookings(calendar.events);

/** Runs needsFollowup over calls given newest first, the way the scanner does. */
function followups(calls: CallLog[]) {
  const outcomes = new Map<string, ReturnType<typeof deriveOutcome>>();
  return calls.map((call, i) => {
    const later = calls.slice(0, i);
    const outcome = deriveOutcome(call, rules, bookings, calls.slice(0, i + 1));
    outcomes.set(call.id, outcome);
    return { id: call.id, followup: needsFollowup(call, outcome, later, (c) => outcomes.get(c.id)!) };
  });
}

describe("summaryClaimsBooking", () => {
  it.each([
    ["Booked Sam Rivera for a confirmed 20-minute intro call", true],
    ["scheduled a morning appointment for the next day ... with the appointment set", true],
    ["Caller requested a callback; no appointment was booked.", false],
    ["They did not book a time.", false],
    ["Caller declined texting and requested no further assistance.", false],
    [null, false],
  ])("%s → %s", (summary, expected) => {
    expect(summaryClaimsBooking(summary)).toBe(expected);
  });
});

describe("needsFollowup on recorded calls", () => {
  it("flags the HVAC call where the agent said it booked but nothing was created", () => {
    const [r] = followups([hvacClaimedBooking!]);
    expect(r!.followup).toMatchObject({ kind: "claimed_booking" });
  });

  it("lists both callback requests as owed", () => {
    expect(followups([callback1!, callback2!]).map((r) => r.followup?.kind)).toEqual(["callback_owed", "callback_owed"]);
  });

  it("leaves out booked calls and abandoned hang-ups", () => {
    expect(followups([booked, hvacHangup!]).map((r) => r.followup)).toEqual([undefined, undefined]);
  });

  it("drops the dropped call because the same contact booked on the redial", () => {
    expect(followups([booked, dropped]).map((r) => r.followup)).toEqual([undefined, undefined]);
  });

  it("would flag the dropped call if the redial had not booked", () => {
    const [r] = followups([dropped]);
    expect(r!.followup).toMatchObject({ kind: "no_action" });
  });

  it("a later booking by the same contact clears an owed callback", () => {
    const laterBooked = { ...booked, contactId: callback1!.contactId };
    const index = indexBookings(calendar.events.map((e) => ({ ...e, contactId: callback1!.contactId })));
    const outcomes = new Map([[laterBooked.id, deriveOutcome(laterBooked, rules, index)]]);
    const outcome = deriveOutcome(callback1!, rules, index, [laterBooked, callback1!]);
    expect(needsFollowup(callback1!, outcome, [laterBooked], (c) => outcomes.get(c.id)!)).toBeUndefined();
  });
});

describe("normalisePhone", () => {
  it("matches the same number written different ways", () => {
    expect(new Set(["+1 (404) 555-0101", "404-555-0101", "14045550101", "+14045550101"].map(normalisePhone)).size).toBe(1);
  });
});

describe("excluding the owner's numbers", () => {
  const mine = { ...callback1!, id: "mine0000000000000000001", fromNumber: "+15555550199" };
  const prospect = { ...callback2!, id: "prospect000000000000001", fromNumber: "+15555550123" };
  const page = { callLogs: [mine, prospect], total: 2, page: 1, pageSize: 50 };

  it("leaves them out by default and says how many", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01" } }));
    expect(out).toMatchObject({ returned: 1, excluded: 1, scanned: 2 });
    expect(out.calls[0].callId).toBe("prospect000000000000001");
  });

  it("includes them on request", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "list_calls", arguments: { since: "2026-10-01", includeExcluded: true } }));
    expect(out).toMatchObject({ returned: 2, excluded: 0 });
  });

  it("applies to calls_needing_followup too", async () => {
    const { mcp } = await connect([{ body: page }]);
    const out = parseText(await mcp.callTool({ name: "calls_needing_followup", arguments: { since: "2026-10-01" } }));
    expect(out).toMatchObject({ returned: 1, excluded: 1, byKind: { callback_owed: 1 } });
  });
});

describe("calls_needing_followup tool", () => {
  it("returns this month's live calls with reasons, leaving out what needs nothing", async () => {
    // Newest first, as the API returns them: booked, dropped (redialled), two callbacks.
    const page = { callLogs: [booked, dropped, callback1, callback2], total: 4, page: 1, pageSize: 50 };
    const { mcp } = await connect([{ body: page }], testConfig, { body: calendar });
    const out = parseText(await mcp.callTool({ name: "calls_needing_followup", arguments: { since: "2026-10-01" } }));
    expect(out).toMatchObject({ returned: 2, scanned: 4, byKind: { claimed_booking: 0, callback_owed: 2, no_action: 0 } });
    expect(out.calls[0]).toMatchObject({
      callId: callback1!.id,
      kind: "callback_owed",
      reason: 'Asked for a callback and hasn\'t booked since. Callback action "Request a callback from Daniel" fired.',
      fromNumber: "+15555550101",
      extractedData: { "Business Type": "electrical contractor" },
    });
  });
});
