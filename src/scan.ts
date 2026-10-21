import { z } from "zod";
import { loadBookings } from "./bookings.js";
import type { Config } from "./config.js";
import { listCallLogs } from "./ghl/callLogs.js";
import type { HighLevelClient } from "./ghl/client.js";
import type { CallLog } from "./ghl/schemas.js";
import { deriveOutcome, type DerivedOutcome } from "./outcomes.js";

export const DateInput = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .describe("ISO 8601 date (2026-10-01) or datetime with offset (2026-10-01T09:00:00-05:00)");

/** Inputs every call-scanning tool shares. */
export const scanInput = {
  since: DateInput,
  until: DateInput.optional().describe("Defaults to now"),
  agentId: z.string().optional().describe("Only calls handled by this Voice AI agent"),
  includeTrial: z.boolean().default(false).describe("Include trial/test calls made from the agent builder"),
  includeExcluded: z
    .boolean()
    .default(false)
    .describe("Include calls from numbers in EXCLUDE_FROM_NUMBERS (the owner's own test calls)"),
  limit: z.number().int().min(1).max(500).default(50).describe("Maximum calls to return"),
};

export interface ScanArgs {
  since: string;
  until?: string;
  agentId?: string;
  includeTrial: boolean;
  includeExcluded: boolean;
  limit: number;
}

export interface ScanContext {
  outcome: DerivedOutcome;
  /** Calls already examined. Newer calls come first, so these are all later than the current one. */
  later: readonly CallLog[];
}

/** Digits only, with a leading US 1 added to 10-digit numbers, so +1 (404) 555-0101 matches 4045550101. */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

/**
 * Walks the call log newest first, deriving each call's outcome, and keeps
 * whatever `select` returns for it (undefined skips the call). Trial calls and
 * excluded numbers are dropped before `select` sees them.
 */
export async function scanCalls<T>(
  client: HighLevelClient,
  config: Config,
  tool: string,
  args: ScanArgs,
  select: (call: CallLog, ctx: ScanContext) => T | undefined,
) {
  const startMs = Date.parse(args.since);
  const endMs = args.until ? Date.parse(args.until) : Date.now();
  if (endMs <= startMs) throw new Error("`until` must be after `since`.");

  const rules = config.outcomeRules;
  const excludedNumbers = new Set(config.excludeFromNumbers.map(normalisePhone));
  const bookings = await loadBookings(client, tool, rules, startMs, endMs);

  const seen: CallLog[] = [];
  const items: T[] = [];
  let excluded = 0;
  const { total, scanned, truncated } = await listCallLogs(
    client,
    { tool, startMs, endMs, agentId: args.agentId, callType: args.includeTrial ? undefined : "LIVE" },
    args.limit,
    (call) => {
      if (!args.includeExcluded && call.fromNumber && excludedNumbers.has(normalisePhone(call.fromNumber))) {
        excluded++;
        return false;
      }
      const later = [...seen];
      seen.push(call);
      const item = select(call, { outcome: deriveOutcome(call, rules, bookings, seen), later });
      if (item === undefined) return false;
      items.push(item);
      return true;
    },
  );

  return {
    range: { since: new Date(startMs).toISOString(), until: new Date(endMs).toISOString() },
    includeTrial: args.includeTrial,
    includeExcluded: args.includeExcluded,
    returned: items.length,
    scanned,
    excluded,
    total,
    truncated,
    items,
  };
}
