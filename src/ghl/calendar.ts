import { z } from "zod";
import type { HighLevelClient } from "./client.js";

// Confirmed against a live response on 2026-10-21
// (fixtures/recorded/thats-automated-calendar-events.sanitized.json).
// Appointments the Voice AI agent books carry createdBy.source = "voice_ai".
export const CalendarEventSchema = z.looseObject({
  id: z.string(),
  calendarId: z.string().nullish(),
  contactId: z.string().nullish(),
  dateAdded: z.string().nullish(),
  startTime: z.string().nullish(),
  appointmentStatus: z.string().nullish(),
  deleted: z.boolean().nullish(),
  createdBy: z.looseObject({ source: z.string().nullish() }).nullish(),
});

export const CalendarEventListSchema = z.looseObject({ events: z.array(CalendarEventSchema) });

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/**
 * Events whose appointment start falls in [startMs, endMs]. Note the filter is
 * on when the appointment happens, not when it was booked.
 */
export async function listCalendarEvents(
  client: HighLevelClient,
  tool: string,
  calendarId: string,
  startMs: number,
  endMs: number,
): Promise<CalendarEvent[]> {
  const res = await client.read({
    tool,
    operation: "calendars.events.list",
    path: "/calendars/events",
    query: { locationId: client.locationId, calendarId, startTime: startMs, endTime: endMs },
    schema: CalendarEventListSchema,
  });
  return res.events;
}
