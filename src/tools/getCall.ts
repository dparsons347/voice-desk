import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallIdSchema, getCallLog } from "../ghl/callLogs.js";
import { deriveOutcome } from "../outcomes.js";
import { loadBookings } from "../bookings.js";
import type { ServerDeps } from "../server.js";
import { safely } from "./result.js";

export function registerGetCall(server: McpServer, { client, config }: ServerDeps): void {
  server.registerTool(
    "get_call",
    {
      title: "Get call",
      description: "Get one Voice AI call: derived outcome and reason, transcript, summary, extracted data, the actions the agent fired, contact id and duration.",
      inputSchema: { callId: CallIdSchema.describe("Call id from list_calls") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async ({ callId }: { callId: string }) => {
      const c = await getCallLog(client, "get_call", callId);
      const start = c.createdAt ? Date.parse(c.createdAt) : Date.now();
      const bookings = await loadBookings(client, "get_call", config.outcomeRules, start, start + (c.duration ?? 600) * 1000);
      return {
        callId: c.id,
        ...deriveOutcome(c, config.outcomeRules, bookings),
        createdAt: c.createdAt ?? null,
        agentId: c.agentId ?? null,
        contactId: c.contactId ?? null,
        fromNumber: c.fromNumber ?? null,
        durationSeconds: c.duration ?? null,
        trialCall: c.trialCall ?? null,
        agentTransferOccurred: c.agentTransferOccurred ?? null,
        summary: c.summary ?? null,
        extractedData: c.extractedData ?? null,
        executedCallActions: c.executedCallActions ?? [],
        transcript: c.transcript ?? null,
      };
    }),
  );
}
