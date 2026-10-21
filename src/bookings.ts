import type { HighLevelClient } from "./ghl/client.js";
import { listCalendarEvents } from "./ghl/calendar.js";
import { indexBookings, type BookingIndex, type OutcomeRules } from "./outcomes.js";

const DAY_MS = 86_400_000;

/**
 * Loads Voice AI bookings for calls placed between startMs and endMs. The
 * calendar API filters on appointment time, so the window runs from the first
 * call to the last call plus the lookahead.
 */
export async function loadBookings(
  client: HighLevelClient,
  tool: string,
  rules: OutcomeRules,
  startMs: number,
  endMs: number,
): Promise<BookingIndex> {
  const until = endMs + rules.bookingLookaheadDays * DAY_MS;
  const perCalendar = await Promise.all(
    rules.bookingCalendarIds.map((id) => listCalendarEvents(client, tool, id, startMs, until)),
  );
  return indexBookings(perCalendar.flat());
}
