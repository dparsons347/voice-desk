import { z } from "zod";
import type { HighLevelClient, Query } from "./client.js";
import { CallLogListSchema, CallLogSchema, type CallLog, type CallLogList } from "./schemas.js";

export const LIST_PATH = "/voice-ai/dashboard/call-logs";
export const MAX_PAGE_SIZE = 50;
/** Upper bound on pages walked when filtering, so a wide range can't scan forever. */
export const MAX_PAGES = 40;

export interface ListCallLogsParams {
  tool: string;
  startMs?: number;
  endMs?: number;
  agentId?: string;
  callType?: "LIVE" | "TRIAL";
  page?: number;
  pageSize?: number;
}

export function listCallLogsPage(client: HighLevelClient, p: ListCallLogsParams): Promise<CallLogList> {
  const query: Query = {
    // Required even with a location-scoped PIT: omitting it returns 400 "LocationId is missing in query" (checked 2026-10-21).
    locationId: client.locationId,
    agentId: p.agentId,
    callType: p.callType,
    page: p.page ?? 1,
    pageSize: p.pageSize ?? MAX_PAGE_SIZE,
  };
  // The API requires startDate and endDate together.
  if (p.startMs !== undefined || p.endMs !== undefined) {
    query.startDate = p.startMs ?? 0;
    query.endDate = p.endMs ?? Date.now();
    query.timezone = client.timezone;
  }
  return client.read({ tool: p.tool, operation: "voice-ai.call-logs.list", path: LIST_PATH, query, schema: CallLogListSchema });
}

export interface ListCallLogsResult {
  calls: CallLog[];
  /** Total calls the API reports for the query, before any `keep` filter. */
  total: number | null;
  /** Calls fetched and examined. */
  scanned: number;
  /** True when calls were left unexamined because `limit` or MAX_PAGES was reached. */
  truncated: boolean;
}

/** Walks pages until `limit` kept calls are collected or the API runs out. */
export async function listCallLogs(
  client: HighLevelClient,
  p: Omit<ListCallLogsParams, "page" | "pageSize">,
  limit: number,
  keep: (call: CallLog) => boolean = () => true,
): Promise<ListCallLogsResult> {
  const calls: CallLog[] = [];
  let total: number | null = null;
  let scanned = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listCallLogsPage(client, { ...p, page, pageSize: MAX_PAGE_SIZE });
    total = res.total ?? total;
    for (const call of res.callLogs) {
      scanned++;
      if (keep(call)) calls.push(call);
      if (calls.length === limit) break;
    }
    const exhausted = res.callLogs.length < MAX_PAGE_SIZE || (total !== null && page * MAX_PAGE_SIZE >= total);
    const pageLeftover = scanned < (page - 1) * MAX_PAGE_SIZE + res.callLogs.length;
    if (calls.length === limit) return { calls, total, scanned, truncated: pageLeftover || !exhausted };
    if (exhausted) return { calls, total, scanned, truncated: false };
  }
  return { calls, total, scanned, truncated: true };
}

export const CallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "callId must be an alphanumeric id");

export function getCallLog(client: HighLevelClient, tool: string, callId: string): Promise<CallLog> {
  return client.read({
    tool,
    operation: "voice-ai.call-logs.get",
    path: `${LIST_PATH}/${encodeURIComponent(CallIdSchema.parse(callId))}`,
    // Also required here; the API returns 400 "LocationId is missing in query" without it.
    query: { locationId: client.locationId },
    schema: CallLogSchema,
  });
}
