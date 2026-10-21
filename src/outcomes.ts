import type { CalendarEvent } from "./ghl/calendar.js";
import type { CallLog } from "./ghl/schemas.js";

export const OUTCOMES = ["booked", "callback_requested", "no_action", "abandoned"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface OutcomeRules {
  /** Calls shorter than this with no booking or callback are `abandoned`. */
  abandonThresholdSeconds: number;
  /**
   * Action ids that mean "the caller asked for a callback". A WORKFLOW_TRIGGER
   * could start any workflow, so it only counts when its id is listed here.
   */
  callbackActionIds: ReadonlySet<string>;
  /** Calendars the agent books into. Empty disables the calendar check. */
  bookingCalendarIds: readonly string[];
  /** How far past the call an appointment may be scheduled and still be found. */
  bookingLookaheadDays: number;
  /** How long after the call ends a booking may be recorded and still count. */
  bookingGraceSeconds: number;
}

export interface DerivedOutcome {
  outcome: Outcome;
  /** One line a person can read without opening the call. */
  reason: string;
}

/** Voice AI appointments grouped by contact, for matching against calls. */
export type BookingIndex = ReadonlyMap<string, readonly CalendarEvent[]>;

export function indexBookings(events: readonly CalendarEvent[]): BookingIndex {
  const index = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (e.createdBy?.source !== "voice_ai" || !e.contactId || !e.dateAdded) continue;
    index.set(e.contactId, [...(index.get(e.contactId) ?? []), e]);
  }
  return index;
}

// HighLevel does not list APPOINTMENT_BOOKING in executedCallActions, even when
// the agent books (live call 2026-10-21: appointment created, actions empty).
// So a booking is proven from the calendar: an appointment the Voice AI created
// for the call's contact while the call was running, or within a short grace
// period after it ended (the agent books as its last step).
//
// One appointment belongs to one call. If the same contact called again and
// that later call had started by the time the appointment was created, the
// later call gets it. Live case 2026-10-21: a 23s dropped call, then a redial
// that booked; without this both were counted as booked.
export function findBooking(
  call: CallLog,
  bookings: BookingIndex,
  rules: OutcomeRules,
  /** Other calls known to the caller, used to hand a booking to the right one. */
  siblings: readonly CallLog[] = [],
): CalendarEvent | undefined {
  if (!call.contactId || !call.createdAt) return undefined;
  const start = Date.parse(call.createdAt);
  // With no duration, allow the longest call the agent permits (600s).
  const end = start + ((call.duration ?? 600) + rules.bookingGraceSeconds) * 1000;
  const laterCallStarts = siblings
    .filter((s) => s.id !== call.id && s.contactId === call.contactId && s.createdAt)
    .map((s) => Date.parse(s.createdAt!))
    .filter((t) => t > start);
  return bookings.get(call.contactId)?.find((e) => {
    const added = Date.parse(e.dateAdded!);
    return added >= start && added <= end && !laterCallStarts.some((t) => t <= added);
  });
}

// Precedence: booked > callback_requested > abandoned > no_action. A short
// call that still booked is a booking, not an abandon.
export function deriveOutcome(
  call: CallLog,
  rules: OutcomeRules,
  bookings: BookingIndex = new Map(),
  siblings: readonly CallLog[] = [],
): DerivedOutcome {
  const actions = call.executedCallActions ?? [];
  const label = (a: (typeof actions)[number]) => `"${a.actionName ?? a.actionId ?? a.actionType}"`;

  const appointment = findBooking(call, bookings, rules, siblings);
  if (appointment) {
    return {
      outcome: "booked",
      reason: `Appointment booked for ${appointment.startTime ?? "an unknown time"} (${appointment.appointmentStatus ?? "status unknown"}).`,
    };
  }
  // Kept in case HighLevel starts logging the booking action.
  const booking = actions.find((a) => a.actionType === "APPOINTMENT_BOOKING");
  if (booking) return { outcome: "booked", reason: `Booking action ${label(booking)} fired.` };

  const callback = actions.find((a) => a.actionId && rules.callbackActionIds.has(a.actionId));
  if (callback) return { outcome: "callback_requested", reason: `Callback action ${label(callback)} fired.` };

  // A workflow fired that isn't mapped to an outcome. Say so, so a missing
  // OUTCOME_CALLBACK_ACTION_IDS entry is visible instead of silently miscounted.
  const unmapped = actions.filter((a) => a.actionType === "WORKFLOW_TRIGGER");
  const unmappedNote = unmapped.length
    ? ` Workflow ${unmapped.map(label).join(", ")} fired but is not mapped to an outcome.`
    : "";
  const noCalendarNote = rules.bookingCalendarIds.length
    ? ""
    : " Bookings not checked: BOOKING_CALENDAR_IDS is not set.";

  const seconds = call.duration;
  if (seconds === null || seconds === undefined) {
    return { outcome: "no_action", reason: `Duration not reported; no booking or callback.${unmappedNote}${noCalendarNote}` };
  }
  if (seconds < rules.abandonThresholdSeconds) {
    return {
      outcome: "abandoned",
      reason: `Ended after ${seconds}s, under the ${rules.abandonThresholdSeconds}s abandon threshold.${unmappedNote}${noCalendarNote}`,
    };
  }
  return { outcome: "no_action", reason: `Ran ${seconds}s with no booking or callback.${unmappedNote}${noCalendarNote}` };
}
