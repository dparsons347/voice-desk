import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallLog } from "../ghl/schemas.js";
import { OUTCOMES, type DerivedOutcome, type Outcome } from "../outcomes.js";
import { scanCalls, scanInput, type ScanArgs } from "../scan.js";
import type { ServerDeps } from "../server.js";
import { safely } from "./result.js";

export const listCallsInput = {
  ...scanInput,
  outcome: z.enum(OUTCOMES).optional().describe("Only calls with this derived outcome"),
};

export function summariseCall(c: CallLog, outcome: DerivedOutcome) {
  return {
    callId: c.id,
    ...outcome,
    createdAt: c.createdAt ?? null,
    agentId: c.agentId ?? null,
    contactId: c.contactId ?? null,
    durationSeconds: c.duration ?? null,
    trialCall: c.trialCall ?? null,
    agentTransferOccurred: c.agentTransferOccurred ?? null,
    actionTypes: (c.executedCallActions ?? []).map((a) => a.actionType ?? "UNKNOWN"),
    summary: c.summary ?? null,
  };
}

export function registerListCalls(server: McpServer, { client, config }: ServerDeps): void {
  server.registerTool(
    "list_calls",
    {
      title: "List calls",
      description:
        "List Voice AI calls in a date range, newest first. Each call has a derived outcome (booked, callback_requested, no_action, abandoned), a one-line reason, and the agent actions it fired. Excludes trial calls and the owner's own numbers by default. Use get_call for the transcript.",
      inputSchema: listCallsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async (args: ScanArgs & { outcome?: Outcome }) => {
      const { items, ...meta } = await scanCalls(client, config, "list_calls", args, (call, { outcome }) =>
        !args.outcome || outcome.outcome === args.outcome ? summariseCall(call, outcome) : undefined,
      );
      return { ...meta, outcome: args.outcome ?? null, calls: items };
    }),
  );
}
