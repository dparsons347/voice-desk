import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_PAGES, MAX_PAGE_SIZE } from "../ghl/callLogs.js";
import { buildReport, type ScoredCall } from "../report.js";
import { scanCalls, scanInput, type ScanArgs } from "../scan.js";
import type { ServerDeps } from "../server.js";
import { safely } from "./result.js";

const { limit: _limit, ...reportInput } = scanInput;

export function registerCallOutcomeReport(server: McpServer, { client, config }: ServerDeps): void {
  server.registerTool(
    "call_outcome_report",
    {
      title: "Call outcome report",
      description:
        "Numbers for a date range: calls by outcome, booking rate (overall and among callers who didn't hang up), lead capture rate, median duration, how many calls fired each agent action, and a per-agent split. Returns numbers only; write the narrative yourself. Excludes trial calls and the owner's own numbers by default.",
      inputSchema: reportInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async (args: Omit<ScanArgs, "limit">) => {
      const { items, returned: _returned, ...meta } = await scanCalls(
        client,
        config,
        "call_outcome_report",
        { ...args, limit: MAX_PAGES * MAX_PAGE_SIZE },
        (call, { outcome }): ScoredCall => ({ call, outcome }),
      );
      return { ...meta, ...buildReport(items) };
    }),
  );
}
