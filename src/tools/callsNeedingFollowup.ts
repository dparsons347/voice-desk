import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { needsFollowup, FOLLOWUP_KINDS, type FollowupKind } from "../followup.js";
import type { DerivedOutcome } from "../outcomes.js";
import { scanCalls, scanInput, type ScanArgs } from "../scan.js";
import type { ServerDeps } from "../server.js";
import { safely } from "./result.js";

export function registerCallsNeedingFollowup(server: McpServer, { client, config }: ServerDeps): void {
  server.registerTool(
    "calls_needing_followup",
    {
      title: "Calls needing follow-up",
      description:
        "Calls a person should act on, newest first, each with a one-line reason: the summary claims a booking that isn't on the calendar (claimed_booking), the caller asked for a callback and hasn't booked since (callback_owed), or a real conversation ended with nothing (no_action). Booked and abandoned calls are left out. Excludes trial calls and the owner's own numbers by default.",
      inputSchema: scanInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async (args: ScanArgs) => {
      const outcomes = new Map<string, DerivedOutcome>();
      const { items, ...meta } = await scanCalls(client, config, "calls_needing_followup", args, (call, { outcome, later }) => {
        outcomes.set(call.id, outcome);
        const followup = needsFollowup(call, outcome, later, (c) => outcomes.get(c.id)!);
        if (!followup) return undefined;
        return {
          callId: call.id,
          kind: followup.kind,
          reason: followup.reason,
          outcome: outcome.outcome,
          createdAt: call.createdAt ?? null,
          durationSeconds: call.duration ?? null,
          contactId: call.contactId ?? null,
          fromNumber: call.fromNumber ?? null,
          extractedData: call.extractedData ?? null,
          summary: call.summary ?? null,
        };
      });
      const byKind = Object.fromEntries(FOLLOWUP_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<FollowupKind, number>;
      return { ...meta, byKind, calls: items };
    }),
  );
}
