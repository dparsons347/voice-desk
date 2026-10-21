import type { CallLog } from "./ghl/schemas.js";
import type { DerivedOutcome } from "./outcomes.js";

export const FOLLOWUP_KINDS = ["claimed_booking", "callback_owed", "no_action"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export interface Followup {
  kind: FollowupKind;
  /** One line a person can act on. */
  reason: string;
}

// Words in the AI-written summary that mean the agent told the caller they
// were booked. Matched only to flag a mismatch with the calendar, never to
// decide an outcome. "not booked" / "no booking" style phrases are excluded.
const CLAIMS_BOOKING = /\b(booked|scheduled|appointment (?:was |is )?(?:set|confirmed))\b/i;
const DENIES_BOOKING = /\b(not|never|didn't|did not|without|no)\s+(?:\w+\s+)?(booked|booking|scheduled|appointment)\b/i;

export function summaryClaimsBooking(summary: string | null | undefined): boolean {
  return !!summary && CLAIMS_BOOKING.test(summary) && !DENIES_BOOKING.test(summary);
}

/**
 * Whether a call needs a person to act on it, and why. `later` holds the
 * contact's calls that came after this one (any contact; filtered here).
 *
 * - claimed_booking: the summary says booked but no appointment was found.
 *   The caller believes they have a slot that does not exist.
 * - callback_owed: the caller asked for a callback and has not since booked.
 * - no_action: a real conversation (past the abandon threshold) that ended
 *   with no booking and no callback.
 * Booked and abandoned calls need nothing.
 */
export function needsFollowup(call: CallLog, outcome: DerivedOutcome, later: readonly CallLog[], laterOutcome: (c: CallLog) => DerivedOutcome): Followup | undefined {
  if (outcome.outcome === "booked") return undefined;

  if (summaryClaimsBooking(call.summary)) {
    return {
      kind: "claimed_booking",
      reason: "Summary says the caller was booked, but no appointment was created. They may expect a call that isn't on the calendar.",
    };
  }

  if (outcome.outcome === "abandoned") return undefined;

  const laterBooking = call.contactId
    ? later.find((c) => c.contactId === call.contactId && laterOutcome(c).outcome === "booked")
    : undefined;
  if (laterBooking) return undefined;

  if (outcome.outcome === "callback_requested") {
    return { kind: "callback_owed", reason: `Asked for a callback and hasn't booked since. ${outcome.reason}` };
  }
  return { kind: "no_action", reason: `${outcome.reason} Worth a look: a real conversation that produced nothing.` };
}
