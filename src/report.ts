import type { CallLog } from "./ghl/schemas.js";
import { OUTCOMES, type DerivedOutcome, type Outcome } from "./outcomes.js";

export interface ScoredCall {
  call: CallLog;
  outcome: DerivedOutcome;
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const rate = (part: number, whole: number) => (whole === 0 ? null : round(part / whole));

/**
 * Numbers only; the narrative is the caller's job. Rates are fractions (0.25
 * = 25%) and null when there is nothing to divide by.
 */
export function buildReport(scored: readonly ScoredCall[]) {
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const { outcome } of scored) byOutcome[outcome.outcome]++;

  const calls = scored.length;
  const engaged = calls - byOutcome.abandoned;
  const durations = scored.map(({ call }) => call.duration).filter((d): d is number => typeof d === "number");

  // Counted once per call, however many times an action fired within it.
  // Booking is absent here because HighLevel does not log it; see byOutcome.booked.
  const actionCounts = new Map<string, { actionType: string; actionName: string | null; calls: number }>();
  for (const { call } of scored) {
    const seen = new Set<string>();
    for (const a of call.executedCallActions ?? []) {
      const key = a.actionId ?? `${a.actionType}:${a.actionName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = actionCounts.get(key) ?? { actionType: a.actionType ?? "UNKNOWN", actionName: a.actionName ?? null, calls: 0 };
      entry.calls++;
      actionCounts.set(key, entry);
    }
  }

  const byAgent = new Map<string, { calls: number; booked: number }>();
  for (const { call, outcome } of scored) {
    const id = call.agentId ?? "unknown";
    const entry = byAgent.get(id) ?? { calls: 0, booked: 0 };
    entry.calls++;
    if (outcome.outcome === "booked") entry.booked++;
    byAgent.set(id, entry);
  }

  return {
    calls,
    byOutcome,
    /** booked / all calls */
    bookingRate: rate(byOutcome.booked, calls),
    /** booked / calls that weren't abandoned: the rate among callers who actually talked */
    bookingRateEngaged: rate(byOutcome.booked, engaged),
    /** (booked + callback_requested) / calls that weren't abandoned */
    leadCaptureRateEngaged: rate(byOutcome.booked + byOutcome.callback_requested, engaged),
    medianDurationSeconds: median(durations),
    totalTalkSeconds: durations.reduce((a, b) => a + b, 0),
    actionsFired: [...actionCounts.entries()]
      .map(([actionId, v]) => ({ actionId, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byAgent: [...byAgent.entries()].map(([agentId, v]) => ({ agentId, ...v, bookingRate: rate(v.booked, v.calls) })),
  };
}
