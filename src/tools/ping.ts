import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { SERVER_NAME, SERVER_VERSION } from "../meta.js";
import { jsonResult } from "./result.js";

// M0's hard-coded tool: proves the server is wired into Claude without touching HighLevel.
export function registerPing(server: McpServer, { config }: ServerDeps): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check that voice-desk is running and whether its HighLevel credentials are configured. Does not call HighLevel.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      jsonResult({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        configured: { pit: Boolean(config.pit), locationId: Boolean(config.locationId) },
        time: new Date().toISOString(),
      }),
  );
}
