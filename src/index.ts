#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonlAuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { HighLevelClient } from "./ghl/client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new HighLevelClient(config, { audit: new JsonlAuditLog(config.auditLogPath) });
  const server = createServer({ config, client });
  await server.connect(new StdioServerTransport());
  console.error(`[voice-desk] ready on stdio (PIT ${config.pit ? "set" : "missing"}, location ${config.locationId ? "set" : "missing"})`);
}

main().catch((err) => {
  console.error("[voice-desk] fatal:", err);
  process.exit(1);
});
