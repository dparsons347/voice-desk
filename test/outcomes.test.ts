import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CallLog } from "../src/ghl/schemas.js";
import type { CalendarEvent } from "../src/ghl/calendar.js";
import { deriveOutcome, indexBookings, type OutcomeRules } from "../src/outcomes.js";
import { fixture, testConfig } from "./helpers.js";

const rules = testConfig.outcomeRules;
const recorded = (name: string) => (fixture(`recorded/${name}`) as { callLogs: CallLog[] }).callLogs;
const [salesCallback1, salesCallback2] = recorded("thats-automated-call-logs.sanitized.json");
const [hvacHangup, hvacNoBooking] = recorded("hvac-example-call-logs.sanitized.json");
const BOOKING = { actionId: "6ac7ed14843b9922f420e425", actionType: "APPOINTMENT_BOOKING", actionName: "Book intro call with Daniel" };
const CALLBACK = salesCallback1!.executedCallActions![0]!;

const bookedCall = fixture("recorded/thats-automated-booked-call.sanitized.json") as CallLog;
const [appointment] = (fixture("recorded/thats-automated-calendar-events.sanitized.json") as { events: CalendarEvent[] }).events;
const bookings = indexBookings([appointment!]);

describe("bookings are proven from the calendar", () => {
  it("booked for the live call whose log shows no actions", () => {
    expect(bookedCall.executedCallActions).toEqual([]);
    expect(deriveOutcome(bookedCall, rules, bookings)).toEqual({
      outcome: "booked",
      reason: "Appointment booked for 2026-10-22T09:00:00-05:00 (confirmed).",
    });
  });

  it("without the calendar, the same call would be no_action (why the check exists)", () => {
    expect(deriveOutcome(bookedCall, rules).outcome).toBe("no_action");
  });

  // The call ran 19:04:40.904Z + 180s; the appointment was added 19:07:34Z.
  const at = (dateAdded: string, extra: Partial<CalendarEvent> = {}) => indexBookings([{ ...appointment!, dateAdded, ...extra }]);

  it("counts a booking recorded within the grace period after the call", () => {
    expect(deriveOutcome(bookedCall, rules, at("2026-10-21T19:08:40Z")).outcome).toBe("booked"); // end + 60s
  });

  it("ignores a booking recorded after the grace period", () => {
    expect(deriveOutcome(bookedCall, rules, at("2026-10-21T19:08:42Z")).outcome).toBe("no_action");
  });

  describe("dropped call then redial (live, 2026-10-21)", () => {
    const dropped = fixture("recorded/thats-automated-dropped-call.sanitized.json") as CallLog;
    const both = [bookedCall, dropped];

    it("credits the booking to the redial only", () => {
      expect(deriveOutcome(bookedCall, rules, bookings, both).outcome).toBe("booked");
      expect(deriveOutcome(dropped, rules, bookings, both)).toEqual({ outcome: "no_action", reason: "Ran 23s with no booking or callback." });
    });

    it("the 60s grace alone already keeps the dropped call out", () => {
      expect(deriveOutcome(dropped, rules, bookings).outcome).toBe("no_action");
    });

    it("the redial wins even with a grace period long enough to overlap", () => {
      const generous: OutcomeRules = { ...rules, bookingGraceSeconds: 600 };
      expect(deriveOutcome(dropped, generous, bookings).outcome).toBe("booked"); // no siblings: ambiguous
      expect(deriveOutcome(dropped, generous, bookings, both).outcome).toBe("no_action");
      expect(deriveOutcome(bookedCall, generous, bookings, both).outcome).toBe("booked");
    });
  });

  it("ignores a booking made before the call started", () => {
    expect(deriveOutcome(bookedCall, rules, at("2026-10-21T19:04:00Z")).outcome).toBe("no_action");
  });

  it("ignores appointments for a different contact", () => {
    expect(deriveOutcome(bookedCall, rules, at(appointment!.dateAdded!, { contactId: "someoneElse" })).outcome).toBe("no_action");
  });

  it("ignores appointments not created by the Voice AI", () => {
    expect(deriveOutcome(bookedCall, rules, at(appointment!.dateAdded!, { createdBy: { source: "calendar_page" } })).outcome).toBe("no_action");
  });

  it("says so when no booking calendar is configured", () => {
    const off: OutcomeRules = { ...rules, bookingCalendarIds: [] };
    expect(deriveOutcome(bookedCall, off).reason).toBe("Ran 180s with no booking or callback. Bookings not checked: BOOKING_CALENDAR_IDS is not set.");
  });
});

describe("deriveOutcome on recorded calls", () => {
  it("callback_requested when the callback workflow fired (both sales-line test calls)", () => {
    for (const call of [salesCallback1!, salesCallback2!]) {
      expect(deriveOutcome(call, rules)).toEqual({
        outcome: "callback_requested",
        reason: 'Callback action "Request a callback from Daniel" fired.',
      });
    }
  });

  it("abandoned for the 6 second hang-up", () => {
    expect(deriveOutcome(hvacHangup!, rules)).toEqual({
      outcome: "abandoned",
      reason: "Ended after 6s, under the 20s abandon threshold.",
    });
  });

  it("no_action when the agent said it booked but no booking action fired", () => {
    // The agent told this caller "I'll put you down for a morning appointment",
    // and the summary says the appointment was set. The log is the truth.
    expect(hvacNoBooking!.summary).toMatch(/appointment set/);
    expect(deriveOutcome(hvacNoBooking!, rules)).toEqual({
      outcome: "no_action",
      reason: "Ran 129s with no booking or callback.",
    });
  });
});

describe("deriveOutcome rules", () => {
  // Synthetic: HighLevel has not been seen logging APPOINTMENT_BOOKING; this is a fallback.
  const base: CallLog = { ...salesCallback1!, executedCallActions: [] };

  it("booked when a booking action is logged (fallback)", () => {
    expect(deriveOutcome({ ...base, executedCallActions: [BOOKING] }, rules)).toEqual({
      outcome: "booked",
      reason: 'Booking action "Book intro call with Daniel" fired.',
    });
  });

  it("booked beats callback_requested when both fired", () => {
    expect(deriveOutcome({ ...base, executedCallActions: [CALLBACK, BOOKING] }, rules).outcome).toBe("booked");
  });

  it("an action beats the abandon threshold", () => {
    expect(deriveOutcome({ ...base, duration: 12, executedCallActions: [CALLBACK] }, rules).outcome).toBe("callback_requested");
    expect(deriveOutcome({ ...base, duration: 12, executedCallActions: [BOOKING] }, rules).outcome).toBe("booked");
  });

  it("treats exactly the threshold as no_action, one second under as abandoned", () => {
    expect(deriveOutcome({ ...base, duration: 20 }, rules).outcome).toBe("no_action");
    expect(deriveOutcome({ ...base, duration: 19 }, rules).outcome).toBe("abandoned");
  });

  it("honours a configured threshold", () => {
    const strict: OutcomeRules = { ...rules, abandonThresholdSeconds: 45 };
    expect(deriveOutcome({ ...base, duration: 30 }, strict).outcome).toBe("abandoned");
  });

  it("does not guess abandoned when duration is missing", () => {
    expect(deriveOutcome({ ...base, duration: null }, rules)).toEqual({
      outcome: "no_action",
      reason: "Duration not reported; no booking or callback.",
    });
  });

  it("flags a workflow that fired but isn't mapped, instead of counting it as a callback", () => {
    const unmapped: OutcomeRules = { ...rules, callbackActionIds: new Set() };
    expect(deriveOutcome(salesCallback1!, unmapped)).toEqual({
      outcome: "no_action",
      reason: 'Ran 310s with no booking or callback. Workflow "Request a callback from Daniel" fired but is not mapped to an outcome.',
    });
  });

  it("ignores data-extraction and knowledge-base actions", () => {
    const noise = [
      { actionId: "x1", actionType: "DATA_EXTRACTION", actionName: "Save email" },
      { actionId: "x2", actionType: "KNOWLEDGE_BASE", actionName: "Maya Sales KB" },
    ];
    expect(deriveOutcome({ ...base, executedCallActions: noise }, rules).outcome).toBe("no_action");
  });
});

describe("outcome config", () => {
  it("parses ids, thresholds and booking settings from env", () => {
    const cfg = loadConfig({
      OUTCOME_CALLBACK_ACTION_IDS: " a1, b2 ,,",
      ABANDON_THRESHOLD_SECONDS: "30",
      BOOKING_CALENDAR_IDS: "c1,c2",
      BOOKING_LOOKAHEAD_DAYS: "14",
      BOOKING_GRACE_SECONDS: "60",
    });
    expect([...cfg.outcomeRules.callbackActionIds]).toEqual(["a1", "b2"]);
    expect(cfg.outcomeRules).toMatchObject({ abandonThresholdSeconds: 30, bookingCalendarIds: ["c1", "c2"], bookingLookaheadDays: 14, bookingGraceSeconds: 60 });
  });

  it("defaults: 20s threshold, no ids, 30 day lookahead, 60s grace", () => {
    const cfg = loadConfig({});
    expect(cfg.outcomeRules.callbackActionIds.size).toBe(0);
    expect(cfg.outcomeRules).toMatchObject({ abandonThresholdSeconds: 20, bookingCalendarIds: [], bookingLookaheadDays: 30, bookingGraceSeconds: 60 });
  });
});
